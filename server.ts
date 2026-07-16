// One long-lived process, three hats:
//  1. Slack Socket Mode listener — @mention opens a native stream instantly
//  2. Remote HTTP MCP server at /mcp — worktree Claude drives the stream via threadTs
//  3. SwiftBar streamable plugin — menubar status (when launched by SwiftBar / --swiftbar)
// The Slack stream id lives only in this process's memory; that's why it's one process.
import { WebClient } from "@slack/web-api";
import { loadConfig } from "./src/config";
import { Registry } from "./src/registry";
import { StreamOps } from "./src/streams";
import { createSlackApp } from "./src/slackApp";
import { startMcpHttp } from "./src/mcpServer";
import { isSwiftBar, startSwiftBar } from "./src/swiftbar";
import { log } from "./src/log";

const config = loadConfig();
const registry = new Registry();
const ops = new StreamOps(new WebClient(config.botToken), registry, config);

// Keepalive: Slack kills streams ~5–6 min in no matter what — this probe append
// detects the death so StreamOps can restart invisibly (replay + delete).
setInterval(() => void ops.keepalive(), 60_000).unref();

// Stale sweep: a job that dies without calling finish() leaves the stream dangling
// and the thinking indicator stuck — stop + clear anything quiet for too long.
setInterval(() => {
  for (const e of registry.stale(config.staleStreamMinutes * 60_000)) {
    log(`sweep: killing stale stream thread=${e.threadTs} (idle > ${config.staleStreamMinutes}m)`);
    void ops.kill(e, `⏱️ Timed out — no job activity for ${config.staleStreamMinutes} minutes.`);
  }
}, 60_000).unref();

if (isSwiftBar()) startSwiftBar(registry, config.port);

const httpServer = startMcpHttp(config.port, ops, registry);
const slackApp = createSlackApp(config, registry, ops);
await slackApp.start();
log("Slack socket-mode connection up");

async function shutdown() {
  log("shutting down: stopping live streams…");
  await Promise.allSettled(registry.values().map((e) => ops.kill(e, "🔌 Server shut down.")));
  httpServer.close();
  await slackApp.stop().catch(() => {});
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
