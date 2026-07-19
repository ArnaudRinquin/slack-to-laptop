// One long-lived process, three hats:
//  1. Slack Socket Mode listener — @mention opens a native stream instantly
//  2. Remote HTTP MCP server at /mcp — worktree Claude drives the stream via threadTs
//  3. SwiftBar streamable plugin — menubar status (when launched by SwiftBar / --swiftbar)
// The threadTs → stream map is in-memory, snapshotted to ~/.cache/slack-to-laptop/
// registry.json so bridge restarts don't interrupt running jobs.
import { homedir } from "node:os";
import { join } from "node:path";
import { WebClient } from "@slack/web-api";
import { loadConfig } from "./src/config";
import { Registry } from "./src/registry";
import { JobsIndex } from "./src/jobs";
import { StreamOps } from "./src/streams";
import { createSlackApp } from "./src/slackApp";
import { startMcpHttp } from "./src/mcpServer";
import { isSwiftBar, startSwiftBar } from "./src/swiftbar";
import { log } from "./src/log";

const config = loadConfig();
const registry = new Registry(join(homedir(), ".cache", "slack-to-laptop", "registry.json"));
const jobs = new JobsIndex(join(homedir(), ".cache", "slack-to-laptop", "jobs.json"));
const ops = new StreamOps(new WebClient(config.botToken), registry, config);

// Jobs survive bridge restarts: restore the map, close any live segment
// cleanly — the job's next call opens a fresh one.
const restored = registry.load(config.staleStreamMinutes * 60_000);
if (restored) log(`restored ${restored} stream(s) from previous run`);
await ops.adoptRestored();

// Slack hard-kills native streams at ~5:00 — close each segment cleanly before
// that ("…still working"); the job's next call opens a fresh segment.
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

const httpServer = startMcpHttp(config.port, ops, registry, jobs);
const slackApp = createSlackApp(config, registry, ops, jobs);
await slackApp.start();
log("Slack socket-mode connection up");

async function shutdown() {
  // Streams are deliberately left open: the registry file lets the next
  // process pick them up, so a redeploy doesn't interrupt running jobs.
  log(`shutting down: persisting ${registry.values().length} live stream(s)…`);
  registry.persistNow();
  httpServer.close();
  await slackApp.stop().catch(() => {});
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
