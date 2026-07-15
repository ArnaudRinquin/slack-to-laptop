import { test, expect, beforeAll, afterAll } from "bun:test";
import type { WebClient } from "@slack/web-api";
import { Registry } from "../src/registry";
import { StreamOps } from "../src/streams";
import { startMcpHttp } from "../src/mcpServer";
import type { Config } from "../src/config";

const calls: { method: string; args: unknown }[] = [];
let streamCounter = 0;
let deadStreams = new Set<string>();

const slackError = (code: string) =>
  Object.assign(new Error(`An API error occurred: ${code}`), { data: { ok: false, error: code } });

const fakeClient = {
  chat: {
    startStream: async (args: unknown) => {
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

test("keepalive re-appends last task card on idle streams only", async () => {
  const entry = await startEntry("kal.1");
  entry.lastAppendAt = Date.now() - 120_000; // idle
  const before = calls.length;
  await ops.keepalive(60_000);
  const append = calls.findLast((c) => c.method === "appendStream")!.args as Record<string, unknown>;
  expect(calls.length).toBe(before + 1);
  expect((append.chunks as { id: string }[])[0]?.id).toBe("boot"); // last chunk re-sent unchanged

  // fresh append → not idle → keepalive skips
  const before2 = calls.length;
  await ops.keepalive(60_000);
  expect(calls.length).toBe(before2);
  await ops.finish("kal.1");
});

test("self-heal: dead stream restarts transparently on append", async () => {
  const entry = await startEntry("heal.1");
  const oldTs = entry.streamTs;
  deadStreams.add(oldTs);

  await ops.thinkingStep("heal.1", { id: "s1", title: "Step", status: "in_progress" });
  expect(entry.streamTs).not.toBe(oldTs); // remapped to a fresh stream
  const append = calls.findLast((c) => c.method === "appendStream")!.args as Record<string, unknown>;
  expect(append.ts).toBe(entry.streamTs);
  await ops.finish("heal.1");
  deadStreams.clear();
});

test("finish on dead stream falls back to plain reply, still cleans up", async () => {
  const entry = await startEntry("dead.1");
  entry.bootPending = false;
  deadStreams.add(entry.streamTs);

  await ops.finish("dead.1", "final words");
  expect(registry.has("dead.1")).toBe(false);
  const post = calls.findLast((c) => c.method === "postMessage")!.args as Record<string, unknown>;
  expect(post).toMatchObject({ thread_ts: "dead.1", text: "final words" });
  deadStreams.clear();
});

test("healthz lists active streams", async () => {
  await startEntry("333.444", "C2");
  const res = (await (await fetch(`http://127.0.0.1:${PORT}/healthz`)).json()) as { activeStreams: { threadTs: string }[] };
  expect(res.activeStreams).toHaveLength(1);
  expect(res.activeStreams[0]!.threadTs).toBe("333.444");
  await ops.kill(registry.get("333.444")!, "bye");
  expect(registry.has("333.444")).toBe(false);
});
