import { test, expect, beforeAll, afterAll } from "bun:test";
import type { WebClient } from "@slack/web-api";
import { Registry } from "../src/registry";
import { StreamOps } from "../src/streams";
import { startMcpHttp } from "../src/mcpServer";
import type { Config } from "../src/config";

const calls: { method: string; args: unknown }[] = [];
let streamCounter = 0;
let deadStreams = new Set<string>();
let failStarts = false;
let failUpdates = false;

const slackError = (code: string) =>
  Object.assign(new Error(`An API error occurred: ${code}`), { data: { ok: false, error: code } });

const fakeClient = {
  chat: {
    startStream: async (args: unknown) => {
      if (failStarts) throw slackError("internal_error");
      calls.push({ method: "startStream", args });
      return { ok: true, ts: `999.${++streamCounter}` };
    },
    appendStream: async (args: { ts: string }) => {
      if (deadStreams.has(args.ts)) throw slackError("message_not_in_streaming_state");
      calls.push({ method: "appendStream", args });
      return { ok: true };
    },
    stopStream: async (args: { ts: string }) => {
      if (deadStreams.has(args.ts)) throw slackError("message_not_in_streaming_state");
      calls.push({ method: "stopStream", args });
      return { ok: true };
    },
    postMessage: async (args: unknown) => (calls.push({ method: "postMessage", args }), { ok: true }),
    delete: async (args: unknown) => (calls.push({ method: "delete", args }), { ok: true }),
    update: async (args: unknown) => {
      if (failUpdates) throw slackError("message_not_found");
      calls.push({ method: "update", args });
      return { ok: true };
    },
  },
  assistant: {
    threads: {
      setStatus: async (args: unknown) => (calls.push({ method: "setStatus", args }), { ok: true }),
    },
  },
} as unknown as WebClient;

const config = { taskDisplayMode: "timeline", staleStreamMinutes: 60 } as Config;
const PORT = 18365;
const registry = new Registry();
const ops = new StreamOps(fakeClient, registry, config);
let server: ReturnType<typeof startMcpHttp>;

beforeAll(() => {
  server = startMcpHttp(PORT, ops, registry);
});
afterAll(() => server.close());

async function rpc(body: object) {
  const res = await fetch(`http://127.0.0.1:${PORT}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  // stateless transport replies as SSE; extract the data line
  const data = text.split("\n").find((l) => l.startsWith("data: "));
  return JSON.parse(data ? data.slice(6) : text);
}

const callTool = (name: string, args: object) =>
  rpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });

const startEntry = (threadTs: string, channel = "C1") =>
  ops.start({ channel, threadTs, teamId: "T1", userId: "U1", prompt: "do the thing" });

test("initialize + tools/list exposes the 4 tools", async () => {
  const init = await rpc({
    jsonrpc: "2.0",
    id: 0,
    method: "initialize",
    params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } },
  });
  expect(init.result.serverInfo.name).toBe("slack-stream");

  const list = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
  const names = list.result.tools.map((t: { name: string }) => t.name).sort();
  expect(names).toEqual(["append_text", "finish", "set_status", "thinking_step"]);
});

test("unknown threadTs returns clear error, not a throw", async () => {
  const res = await callTool("append_text", { threadTs: "nope", markdown: "x" });
  expect(res.result.isError).toBe(true);
  expect(res.result.content[0].text).toContain("no live stream for threadTs=nope");
});

test("full lifecycle: start (boot card) → thinking_step → append_text → finish", async () => {
  const entry = await startEntry("111.222");
  expect(registry.has("111.222")).toBe(true);
  const start = calls.findLast((c) => c.method === "startStream")!.args as Record<string, unknown>;
  expect((start.chunks as { id: string }[])[0]?.id).toBe("boot");

  const step = await callTool("thinking_step", { threadTs: "111.222", title: "Run tests", status: "in_progress" });
  expect(step.result.isError).toBeUndefined();
  const append = calls.findLast((c) => c.method === "appendStream")!.args as Record<string, unknown>;
  expect(append.ts).toBe(entry.streamTs);
  // first job call completes the boot card in the same append
  const chunks = append.chunks as { type: string; id?: string; status?: string }[];
  expect(chunks[0]!).toMatchObject({ id: "boot", status: "complete" });
  expect(chunks[1]!).toMatchObject({ type: "task_update", id: "run-tests", status: "in_progress" });

  await callTool("append_text", { threadTs: "111.222", markdown: "hello **world**" });

  const fin = await callTool("finish", { threadTs: "111.222", markdown: "done" });
  expect(fin.result.content[0].text).toBe("stream finished");
  expect(registry.has("111.222")).toBe(false);
  const stop = calls.findLast((c) => c.method === "stopStream")!.args as Record<string, unknown>;
  expect(stop).toMatchObject({ channel: "C1", ts: entry.streamTs, markdown_text: "done" });
  // status cleared on finish
  expect(calls.findLast((c) => c.method === "setStatus")!.args).toMatchObject({ status: "" });

  // second finish → clear error
  const again = await callTool("finish", { threadTs: "111.222" });
  expect(again.result.isError).toBe(true);
});

test("keepalive converts aging streams to update-mode — same message, no new stream, no delete", async () => {
  const entry = await startEntry("cnv.1");
  const oldTs = entry.streamTs;
  const startsBefore = calls.filter((c) => c.method === "startStream").length;
  const deletesBefore = calls.filter((c) => c.method === "delete").length;
  entry.streamStartedAt = Date.now() - 4 * 60_000; // past the conversion threshold

  await ops.keepalive(210_000);
  expect(entry.mode).toBe("update");
  expect(entry.streamTs).toBe(oldTs); // SAME message forever
  expect(calls.filter((c) => c.method === "startStream").length).toBe(startsBefore); // no new stream
  expect(calls.filter((c) => c.method === "delete").length).toBe(deletesBefore); // no delete
  expect(calls.findLast((c) => c.method === "stopStream")!.args).toMatchObject({ ts: oldTs });
  expect(calls.findLast((c) => c.method === "update")!.args).toMatchObject({ ts: oldTs });

  // subsequent appends edit the same message in place, re-rendering full state
  await ops.thinkingStep("cnv.1", { id: "s1", title: "Later step", status: "in_progress" });
  const upd = calls.findLast((c) => c.method === "update")!.args as { ts: string; text: string };
  expect(upd.ts).toBe(oldTs);
  expect(upd.text).toContain("⏳ Later step");
  expect(upd.text).toContain("✅ Booting worktree job");

  // next tick: already converted → nothing to do
  const before = calls.length;
  await ops.keepalive(210_000);
  expect(calls.length).toBe(before);
  await ops.finish("cnv.1");
});

test("self-heal: stream dead before conversion — chunks folded in, converted, same message", async () => {
  const entry = await startEntry("heal.1");
  await ops.appendText("heal.1", "progress so far");
  const oldTs = entry.streamTs;
  deadStreams.add(oldTs);

  await ops.thinkingStep("heal.1", { id: "s1", title: "Step", status: "in_progress" });
  expect(entry.mode).toBe("update");
  expect(entry.streamTs).toBe(oldTs); // no new message, ever
  const upd = calls.findLast((c) => c.method === "update")!.args as { ts: string; text: string };
  expect(upd.ts).toBe(oldTs);
  expect(upd.text).toContain("progress so far");
  expect(upd.text).toContain("⏳ Step");
  await ops.finish("heal.1");
  deadStreams.clear();
});

test("finish on dead stream delivers final markdown via chat.update on the same message", async () => {
  const entry = await startEntry("dead.1");
  entry.bootPending = false;
  const oldTs = entry.streamTs;
  deadStreams.add(oldTs);

  await ops.finish("dead.1", "final words");
  expect(registry.has("dead.1")).toBe(false);
  const upd = calls.findLast((c) => c.method === "update")!.args as { ts: string; text: string };
  expect(upd.ts).toBe(oldTs);
  expect(upd.text).toContain("final words");
  deadStreams.clear();
});

test("finish falls back to plain reply when even chat.update fails", async () => {
  const entry = await startEntry("dead.2");
  entry.bootPending = false;
  deadStreams.add(entry.streamTs);
  failUpdates = true;

  await ops.finish("dead.2", "final words");
  expect(registry.has("dead.2")).toBe(false);
  const post = calls.findLast((c) => c.method === "postMessage")!.args as Record<string, unknown>;
  expect(post).toMatchObject({ thread_ts: "dead.2", text: "final words" });
  failUpdates = false;
  deadStreams.clear();
});

test("registry persists and restores across processes; stale entries dropped", async () => {
  const path = `${import.meta.dir}/.tmp-registry-${Date.now()}.json`;
  const r1 = new Registry(path);
  const live = { ...(await startEntry("per.1")), lastActivity: Date.now() };
  const stale = { ...live, threadTs: "per.2", lastActivity: Date.now() - 2 * 60 * 60_000 };
  r1.set(live);
  r1.set(stale);
  r1.persistNow();
  registry.delete("per.1"); // startEntry used the shared registry; clean up

  const r2 = new Registry(path);
  expect(r2.load(60 * 60_000)).toBe(1); // stale one dropped
  const restored = r2.get("per.1")!;
  expect(restored.streamTs).toBe(live.streamTs);
  expect(restored.chunks[0]).toMatchObject({ id: "boot" }); // replay log survives
  expect(restored.mode).toBe("stream"); // adoptRestored() converts these on boot
  const { unlinkSync } = await import("node:fs");
  unlinkSync(path);
});

test("healthz lists active streams", async () => {
  await startEntry("333.444", "C2");
  const res = (await (await fetch(`http://127.0.0.1:${PORT}/healthz`)).json()) as { activeStreams: { threadTs: string }[] };
  expect(res.activeStreams).toHaveLength(1);
  expect(res.activeStreams[0]!.threadTs).toBe("333.444");
  await ops.kill(registry.get("333.444")!, "bye");
  expect(registry.has("333.444")).toBe(false);
});
