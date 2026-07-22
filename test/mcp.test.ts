import { test, expect, beforeAll, afterAll } from "bun:test";
import type { WebClient } from "@slack/web-api";
import { Registry } from "../src/registry";
import { StreamOps } from "../src/streams";
import { startMcpHttp } from "../src/mcpServer";
import { JobsIndex } from "../src/jobs";
import { findPane } from "../src/inject";
import type { Config } from "../src/config";

const calls: { method: string; args: unknown }[] = [];
let streamCounter = 0;
let deadStreams = new Set<string>();
const streamsWithChunks = new Set<string>(); // mirrors Slack: md-stop only allowed on chunk-less streams
let failStarts = false;

const slackError = (code: string) =>
  Object.assign(new Error(`An API error occurred: ${code}`), { data: { ok: false, error: code } });

const fakeClient = {
  chat: {
    startStream: async (args: { chunks?: unknown[] }) => {
      if (failStarts) throw slackError("internal_error");
      calls.push({ method: "startStream", args });
      const ts = `999.${++streamCounter}`;
      if (args.chunks?.length) streamsWithChunks.add(ts);
      return { ok: true, ts };
    },
    appendStream: async (args: { ts: string }) => {
      if (deadStreams.has(args.ts)) throw slackError("message_not_in_streaming_state");
      calls.push({ method: "appendStream", args });
      streamsWithChunks.add(args.ts);
      return { ok: true };
    },
    stopStream: async (args: { ts: string; markdown_text?: string }) => {
      if (deadStreams.has(args.ts)) throw slackError("message_not_in_streaming_state");
      // real Slack behavior (measured): markdown_text finalizer + any prior chunk → error
      if (args.markdown_text && streamsWithChunks.has(args.ts)) throw slackError("streaming_mode_mismatch");
      calls.push({ method: "stopStream", args });
      return { ok: true };
    },
    postMessage: async (args: unknown) => (calls.push({ method: "postMessage", args }), { ok: true }),
    delete: async (args: unknown) => (calls.push({ method: "delete", args }), { ok: true }),
    // chat.update works on stopped/dead streamed messages (measured) — never gated on deadStreams
    update: async (args: unknown) => (calls.push({ method: "update", args }), { ok: true }),
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
const jobs = new JobsIndex();
const ops = new StreamOps(fakeClient, registry, config);
let server: ReturnType<typeof startMcpHttp>;

beforeAll(() => {
  server = startMcpHttp(PORT, ops, registry, jobs);
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

test("register_job stores the session location for follow-up routing", async () => {
  const res = await callTool("register_job", {
    threadTs: "job.1",
    cwd: "/tmp/worktrees/monorepo.slack-1",
    tmuxPane: "%7",
    pid: 4242,
  });
  expect(res.result.isError).toBeUndefined();
  expect(jobs.get("job.1")).toMatchObject({ cwd: "/tmp/worktrees/monorepo.slack-1", tmuxPane: "%7" });
});

test("findPane: verifies by cwd, prefers registered pane, survives pane-id recycling", async () => {
  const job = { threadTs: "t", cwd: "/wt/a", tmuxPane: "%3", registeredAt: Date.now() };
  const claude = { id: "%9", path: "/wt/a", command: "2.1.211" };
  const shell = { id: "%4", path: "/wt/a", command: "zsh" };

  // registered pane id wins when it's still in the right cwd
  expect(findPane([shell, { id: "%3", path: "/wt/a", command: "zsh" }, claude], job)?.id).toBe("%3");
  // recycled pane id (now in another cwd) is ignored → claude-looking pane wins
  expect(findPane([{ id: "%3", path: "/wt/OTHER", command: "zsh" }, shell, claude], job)?.id).toBe("%9");
  // no pane in the worktree → undefined (fallback: fresh spawn)
  expect(findPane([{ id: "%3", path: "/wt/OTHER", command: "zsh" }], job)).toBeUndefined();
});

test("initialize + tools/list exposes the 5 tools", async () => {
  const init = await rpc({
    jsonrpc: "2.0",
    id: 0,
    method: "initialize",
    params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } },
  });
  expect(init.result.serverInfo.name).toBe("slack-stream");

  const list = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
  const names = list.result.tools.map((t: { name: string }) => t.name).sort();
  expect(names).toEqual(["append_text", "finish", "register_job", "set_status", "thinking_step"]);
});

test("unknown threadTs returns clear error, not a throw", async () => {
  const res = await callTool("append_text", { threadTs: "nope", markdown: "x" });
  expect(res.result.isError).toBe(true);
  expect(res.result.content[0].text).toContain("no live stream for threadTs=nope");
});

test("full lifecycle: start (boot card) → thinking_step → append_text → finish + separate report", async () => {
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
  // still young at finish → the progress message keeps its native cards: the
  // lingering in_progress card is completed (no frozen ⚠️), then a PLAIN stop
  const appends = calls.filter((c) => c.method === "appendStream").map((c) => c.args as Record<string, unknown>);
  const closing = appends[appends.length - 1]!.chunks as { id?: string; status?: string }[];
  expect(closing.some((c) => c.id === "run-tests" && c.status === "complete")).toBe(true);
  const stops = calls.filter((c) => c.method === "stopStream").map((c) => c.args as Record<string, unknown>);
  expect(stops.find((s) => s.ts === entry.streamTs)!.markdown_text).toBeUndefined();
  // the report is its own message: fresh stream seeded with the markdown, plain stop
  const reportStart = calls.findLast((c) => c.method === "startStream")!.args as Record<string, unknown>;
  expect((reportStart.chunks as { text?: string }[]).some((c) => c.text === "done")).toBe(true);
  const reportStop = stops[stops.length - 1]!;
  expect(reportStop.ts).not.toBe(entry.streamTs);
  expect(reportStop.markdown_text).toBeUndefined();
  // status cleared on finish
  expect(calls.findLast((c) => c.method === "setStatus")!.args).toMatchObject({ status: "" });

  // second finish → clear error
  const again = await callTool("finish", { threadTs: "111.222" });
  expect(again.result.isError).toBe(true);
});

test("keepalive converts aging streams to update-mode: same message, edited from then on", async () => {
  const entry = await startEntry("upd.1");
  const msgTs = entry.streamTs;
  entry.streamStartedAt = Date.now() - 4 * 60_000; // past the conversion window

  await ops.keepalive(210_000);
  expect(entry.mode).toBe("update");
  // plain stop of the native stream, then a full chat.update render of the SAME message
  const stop = calls.findLast((c) => c.method === "stopStream")!.args as Record<string, unknown>;
  expect(stop).toMatchObject({ ts: msgTs });
  expect(stop.markdown_text).toBeUndefined();
  const upd = calls.findLast((c) => c.method === "update")!.args as Record<string, unknown>;
  expect(upd.ts).toBe(msgTs);
  expect(upd.text as string).toContain("Booting worktree job");
  // NATIVE cards survive conversion: task_update chunks render as task_card blocks
  const updBlocks = upd.blocks as { type: string; task_id?: string; status?: string }[];
  expect(updBlocks.some((b) => b.type === "task_card" && b.task_id === "boot")).toBe(true);
  expect(updBlocks[updBlocks.length - 1]!.type).toBe("context"); // live footer while unfinished
  expect(JSON.stringify(updBlocks)).toContain("still working");

  // converted entries need nothing further from the keepalive
  const before = calls.length;
  await ops.keepalive(210_000);
  expect(calls.length).toBe(before);

  // subsequent steps EDIT the same message — never a new one
  const starts = calls.filter((c) => c.method === "startStream").length;
  await ops.thinkingStep("upd.1", { id: "s1", title: "Next step", status: "in_progress" });
  expect(calls.filter((c) => c.method === "startStream").length).toBe(starts);
  const upd2 = calls.findLast((c) => c.method === "update")!.args as Record<string, unknown>;
  expect(upd2.ts).toBe(msgTs);
  expect(upd2.text as string).toContain("⏳ Next step");

  // finish: final render has no live footer, settles the spinner to ✅
  await ops.finish("upd.1");
  const final = calls.findLast((c) => c.method === "update")!.args as Record<string, unknown>;
  expect(final.ts).toBe(msgTs);
  expect(final.text as string).toContain("✅ Next step");
  const finalBlocks = final.blocks as { type: string; task_id?: string; status?: string }[];
  expect(finalBlocks.find((b) => b.task_id === "s1")!.status).toBe("complete");
  expect(finalBlocks.every((b) => b.type !== "context")).toBe(true); // no footer
  // block-form quirk: pending is rejected — renderBlocks must never emit it
  expect(finalBlocks.every((b) => b.status !== "pending")).toBe(true);
});

test("self-heal: stream died before conversion — chunks fold into the edited message", async () => {
  const entry = await startEntry("heal.1");
  await ops.appendText("heal.1", "progress so far");
  deadStreams.add(entry.streamTs);

  await ops.thinkingStep("heal.1", { id: "s1", title: "Step", status: "in_progress" });
  expect(entry.mode).toBe("update");
  const upd = calls.findLast((c) => c.method === "update")!.args as Record<string, unknown>;
  expect(upd.ts).toBe(entry.streamTs); // same message, taken over by chat.update
  expect(upd.text as string).toContain("progress so far");
  expect(upd.text as string).toContain("⏳ Step");
  await ops.finish("heal.1");
  deadStreams.clear();
});

test("finish on dead stream still settles via chat.update and posts the report", async () => {
  const entry = await startEntry("dead.1");
  entry.bootPending = false;
  deadStreams.add(entry.streamTs);

  await ops.finish("dead.1", "final words");
  expect(registry.has("dead.1")).toBe(false);
  const upd = calls.findLast((c) => c.method === "update")!.args as Record<string, unknown>;
  expect(upd.ts).toBe(entry.streamTs);
  const start = calls.findLast((c) => c.method === "startStream")!.args as Record<string, unknown>;
  expect((start.chunks as { text?: string }[]).some((c) => c.text === "final words")).toBe(true);
  const stop = calls.findLast((c) => c.method === "stopStream")!.args as Record<string, unknown>;
  expect(stop.ts).not.toBe(entry.streamTs); // report went out on its own fresh stream
  expect(stop.markdown_text).toBeUndefined();
  deadStreams.clear();
});

test("report falls back to plain reply when its stream can't start", async () => {
  const entry = await startEntry("dead.2");
  entry.bootPending = false;
  entry.mode = "update";
  failStarts = true;

  await ops.finish("dead.2", "final words");
  expect(registry.has("dead.2")).toBe(false);
  const post = calls.findLast((c) => c.method === "postMessage")!.args as Record<string, unknown>;
  expect(post).toMatchObject({ thread_ts: "dead.2", text: "final words" });
  failStarts = false;
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
