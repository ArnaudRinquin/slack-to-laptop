import { App, LogLevel, type Logger } from "@slack/bolt";
import { spawn } from "node:child_process";
import type { Config } from "./config";
import type { Registry } from "./registry";
import type { StreamOps } from "./streams";
import type { JobsIndex } from "./jobs";
import { findPane, injectText, listPanes } from "./inject";
import { log } from "./log";

export function createSlackApp(config: Config, registry: Registry, ops: StreamOps, jobs: JobsIndex): App {
  // Route Bolt/socket-mode logs through log() so they land in the log file
  // (raw console output would be lost to SwiftBar's stderr pipe).
  let boltLevel = LogLevel.INFO;
  const boltLogger: Logger = {
    // custom loggers do their own filtering — Bolt calls debug() regardless of logLevel
    debug: (...msgs) => {
      if (boltLevel === LogLevel.DEBUG) log(`bolt DEBUG ${msgs.join(" ")}`);
    },
    info: (...msgs) => log(`bolt ${msgs.join(" ")}`),
    warn: (...msgs) => log(`bolt WARN ${msgs.join(" ")}`),
    error: (...msgs) => log(`bolt ERROR ${msgs.join(" ")}`),
    setLevel: (level) => (boltLevel = level),
    getLevel: () => boltLevel,
    setName: () => {},
  };

  const app = new App({
    token: config.botToken,
    appToken: config.appToken,
    socketMode: true,
    logger: boltLogger,
    logLevel: LogLevel.INFO,
  });

  // Slack redelivers unacked events after 3s — dedupe so a redelivery can't spawn a second job.
  const seenEvents = new Map<string, number>();
  setInterval(() => {
    const cutoff = Date.now() - 15 * 60_000;
    for (const [id, at] of seenEvents) if (at < cutoff) seenEvents.delete(id);
  }, 60_000).unref();

  app.event("app_mention", async ({ event, body, client }) => {
    // Bolt acks socket-mode events automatically; everything below runs after the ack.
    if ((event as { bot_id?: string }).bot_id) return; // never react to bots (loop guard)

    const eventId = body.event_id ?? `${event.channel}:${event.ts}`;
    if (seenEvents.has(eventId)) {
      log(`dedupe: dropping redelivered event ${eventId}`);
      return;
    }
    seenEvents.set(eventId, Date.now());

    // Stream is keyed to the thread; worktree name uses event.ts (always unique).
    const threadTs = event.thread_ts ?? event.ts;
    const prompt = (event.text ?? "").replace(/<@[A-Z0-9]+>/g, "").trim();
    const userId = event.user;

    if (config.allowedUserIds.length > 0 && (!userId || !config.allowedUserIds.includes(userId))) {
      log(`unauthorized: mention from user=${userId ?? "?"} channel=${event.channel}, refusing`);
      const owners = config.allowedUserIds.map((id) => `<@${id}>`).join(", ");
      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: threadTs,
        text: `⛔ Sorry${userId ? ` <@${userId}>` : ""} — only ${owners} can trigger me. Ask them to re-run this.`,
      });
      return;
    }

    const teamId = body.team_id ?? (event as { team?: string }).team;
    if (!teamId || !userId) {
      log(`mention missing team/user (team=${teamId} user=${userId}), can't start stream`);
      return;
    }

    // Follow-up: this thread already has (or had) a job — route the message
    // into its Claude session instead of spawning a second job.
    const job = jobs.get(threadTs);
    if (job) {
      try {
        const pane = findPane(await listPanes(config.tmuxBin), job);
        if (pane) {
          if (!registry.has(threadTs)) {
            await ops.start({
              channel: event.channel,
              threadTs,
              teamId,
              userId,
              prompt,
              bootTitle: "Reconnecting to session…",
            });
          }
          await injectText(config.tmuxBin, pane.id, `[slack follow-up threadTs:${threadTs}] ${prompt}`);
          await ops.thinkingStep(threadTs, {
            id: `followup-${event.ts}`,
            title: "📨 Follow-up sent to the session",
            status: "complete",
          });
          log(`follow-up: routed to pane ${pane.id} (${job.cwd}) for thread ${threadTs}`);
          return;
        }
        log(`follow-up: no pane found for ${threadTs} (cwd=${job.cwd}), falling back`);
      } catch (err) {
        log(`follow-up routing failed for ${threadTs}: ${err}`);
      }
    }

    if (registry.has(threadTs)) {
      // live stream but session unreachable — don't stack a second job on the thread
      log(`collision: live stream for ${threadTs} but no reachable session`);
      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: threadTs,
        text: "⚠️ A job is already streaming to this thread but its session is unreachable — wait for it to finish (or for the stale sweep) before mentioning me again.",
      });
      return;
    }

    if (job) {
      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: threadTs,
        text: "ℹ️ The previous session for this thread is gone — starting a fresh job.",
      });
    }

    try {
      await ops.start({ channel: event.channel, threadTs, teamId, userId, prompt });
      log(`stream started: thread=${threadTs} channel=${event.channel} prompt="${prompt.slice(0, 60)}"`);
    } catch (err) {
      log(`startStream failed: ${err}`);
      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: threadTs,
        text: `❌ Couldn't start a stream: ${err instanceof Error ? err.message : err}`,
      });
      return;
    }

    if (config.jobCommand) {
      spawnJob(config, { threadTs, channel: event.channel, prompt, eventTs: event.ts });
    } else {
      void smokeDemo(ops, threadTs); // build-order step 1: prove the stream renders
    }
  });

  return app;
}

function spawnJob(
  config: Config,
  job: { threadTs: string; channel: string; prompt: string; eventTs: string },
) {
  const child = spawn("/bin/zsh", ["-lc", config.jobCommand!], {
    cwd: config.jobCwd,
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      SLACK_THREAD_TS: job.threadTs,
      SLACK_CHANNEL: job.channel,
      SLACK_PROMPT: job.prompt,
      SLACK_EVENT_TS: job.eventTs,
      SLACK_MCP_URL: `http://127.0.0.1:${config.port}/mcp`,
    },
  });
  child.on("error", (err) => log(`job spawn failed: ${err}`));
  child.unref();
  log(`job spawned: pid=${child.pid} thread=${job.threadTs}`);
}

/** No jobCommand configured: exercise the full stream lifecycle so setup can be verified. */
async function smokeDemo(ops: StreamOps, threadTs: string) {
  try {
    await ops.setStatus(threadTs, "warming up…").catch(() => {});
    await ops.thinkingStep(threadTs, { id: "boot", title: "Booting worktree", status: "in_progress" });
    await sleep(1500);
    await ops.thinkingStep(threadTs, { id: "boot", title: "Booting worktree", status: "complete" });
    await ops.thinkingStep(threadTs, { id: "work", title: "Doing the work", status: "in_progress" });
    await sleep(1500);
    await ops.thinkingStep(threadTs, { id: "work", title: "Doing the work", status: "complete" });
    await ops.finish(threadTs, "hi — smoke demo. Streaming works; set `jobCommand` in the config to spawn real jobs.");
  } catch (err) {
    log(`smoke demo failed: ${err}`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
