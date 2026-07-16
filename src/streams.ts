import type { WebClient } from "@slack/web-api";
import type { AnyChunk, TaskUpdateChunk } from "@slack/types";
import type { Config } from "./config";
import { Registry, type StreamEntry } from "./registry";
import { log } from "./log";

export type StepStatus = "pending" | "in_progress" | "complete" | "error";

const BOOT_CARD: TaskUpdateChunk = {
  type: "task_update",
  id: "boot",
  title: "Booting worktree job",
  status: "in_progress",
};

/** Cap on replayed prose so a restarted stream never exceeds Slack's message size limits. */
const REPLAY_TEXT_CAP = 8_000;

/**
 * Slack hard-kills a stream ~5:00 after it opens, appends or not (measured; no
 * keepalive can prevent it). Rotate proactively before that: with the 60s
 * keepalive tick, rotation lands at age 3:30–4:30, comfortably before death —
 * so viewers never see a dead "stopped" message.
 */
const ROTATE_MS = 3.5 * 60_000;

/** Slack kills streams after ~5–6 min no matter what we append; appends then fail with this. */
function isStreamDead(err: unknown): boolean {
  const e = err as { data?: { error?: string }; message?: string };
  return (
    e?.data?.error === "message_not_in_streaming_state" ||
    Boolean(e?.message?.includes("message_not_in_streaming_state"))
  );
}

/** All Slack stream mutations, shared by the mention handler, MCP tools and the sweep. */
export class StreamOps {
  constructor(
    private client: WebClient,
    private registry: Registry,
    private config: Config,
  ) {}

  async start(args: {
    channel: string;
    threadTs: string;
    teamId: string;
    userId: string;
    prompt: string;
  }): Promise<StreamEntry> {
    const res = await this.client.chat.startStream({
      channel: args.channel,
      thread_ts: args.threadTs,
      recipient_team_id: args.teamId,
      recipient_user_id: args.userId,
      task_display_mode: this.config.taskDisplayMode,
      chunks: [BOOT_CARD], // checklist appears instantly + gives keepalive a chunk to re-send
    });
    if (!res.ts) throw new Error(`startStream returned no ts: ${JSON.stringify(res)}`);
    const now = Date.now();
    const entry: StreamEntry = {
      threadTs: args.threadTs,
      channel: args.channel,
      streamTs: res.ts,
      teamId: args.teamId,
      userId: args.userId,
      prompt: args.prompt,
      startedAt: now,
      streamStartedAt: now,
      lastActivity: now,
      lastAppendAt: now,
      chunks: [BOOT_CARD],
      bootPending: true,
    };
    this.registry.set(entry);
    return entry;
  }

  /** Throws with a clear message when the job outlived its stream (or passed a bad token). */
  private entry(threadTs: string): StreamEntry {
    const e = this.registry.get(threadTs);
    if (!e) {
      throw new Error(
        `no live stream for threadTs=${threadTs} — it was finished, swept as stale, or the token is wrong`,
      );
    }
    this.registry.touch(threadTs);
    return e;
  }

  /**
   * Append with self-heal: on message_not_in_streaming_state, restart the
   * stream in place (replay + delete, see restart) and retry once.
   */
  private async append(e: StreamEntry, chunks: AnyChunk[]) {
    try {
      await this.client.chat.appendStream({ channel: e.channel, ts: e.streamTs, chunks });
    } catch (err) {
      if (!isStreamDead(err)) throw err;
      log(`append: stream dead for ${e.threadTs}, restarting in place`);
      await this.restartOnce(e);
      await this.client.chat.appendStream({ channel: e.channel, ts: e.streamTs, chunks });
    }
    e.lastAppendAt = Date.now();
    this.record(e, chunks);
  }

  /** Concurrent MCP calls + the keepalive can race into restart — coalesce to one. */
  private restarts = new Map<string, Promise<void>>();
  private restartOnce(e: StreamEntry): Promise<void> {
    let p = this.restarts.get(e.threadTs);
    if (!p) {
      p = this.restart(e).finally(() => this.restarts.delete(e.threadTs));
      this.restarts.set(e.threadTs, p);
    }
    return p;
  }

  /** Fold appended chunks into the replay log: checklist state + bounded prose tail. */
  private record(e: StreamEntry, chunks: AnyChunk[]) {
    for (const c of chunks) {
      if (c.type === "task_update") {
        const i = e.chunks.findIndex((x) => x.type === "task_update" && x.id === c.id);
        if (i >= 0) e.chunks[i] = c;
        else e.chunks.push(c);
      } else if (c.type === "markdown_text") {
        const last = e.chunks[e.chunks.length - 1];
        if (last?.type === "markdown_text") {
          let text = last.text + c.text;
          if (text.length > REPLAY_TEXT_CAP) text = "…" + text.slice(-REPLAY_TEXT_CAP);
          e.chunks[e.chunks.length - 1] = { ...last, text };
        } else {
          e.chunks.push(c);
        }
      } else {
        e.chunks.push(c);
      }
    }
  }

  /**
   * Slack kills a stream ~5–6 min after it starts, even with appends every 60s
   * (undocumented — measured in server.log). Naively reopening spams the thread
   * with partial messages. Instead, restart invisibly: open a fresh stream
   * seeded with the full replay log, then delete the dead message — the thread
   * keeps exactly one live bot message.
   */
  private async restart(e: StreamEntry) {
    const deadTs = e.streamTs;
    const res = await this.client.chat.startStream({
      channel: e.channel,
      thread_ts: e.threadTs,
      recipient_team_id: e.teamId,
      recipient_user_id: e.userId,
      task_display_mode: this.config.taskDisplayMode,
      chunks: e.chunks,
    });
    if (!res.ts) throw new Error(`restart startStream returned no ts: ${JSON.stringify(res)}`);
    e.streamTs = res.ts;
    e.lastAppendAt = Date.now();
    e.streamStartedAt = Date.now();
    try {
      await this.client.chat.delete({ channel: e.channel, ts: deadTs });
    } catch (err) {
      log(`restart: couldn't delete dead stream message ${deadTs}: ${err}`);
    }
  }

  /** First job-originated call completes the boot card in the same append. */
  private drainBoot(e: StreamEntry): AnyChunk[] {
    if (!e.bootPending) return [];
    e.bootPending = false;
    return [{ ...BOOT_CARD, status: "complete" }];
  }

  async thinkingStep(
    threadTs: string,
    step: { id: string; title: string; status: StepStatus; details?: string; output?: string },
  ) {
    const e = this.entry(threadTs);
    await this.append(e, [...this.drainBoot(e), { type: "task_update", ...step }]);
  }

  async appendText(threadTs: string, markdown: string) {
    const e = this.entry(threadTs);
    await this.append(e, [...this.drainBoot(e), { type: "markdown_text", text: markdown }]);
  }

  async setStatus(threadTs: string, text: string) {
    const e = this.entry(threadTs);
    await this.client.assistant.threads.setStatus({
      channel_id: e.channel,
      thread_ts: e.threadTs,
      status: text,
    });
  }

  async finish(threadTs: string, markdown?: string) {
    const e = this.entry(threadTs);
    const boot = this.drainBoot(e);
    if (boot.length) await this.append(e, boot).catch(() => {});
    try {
      await this.stop(e, markdown);
    } catch (err) {
      if (!isStreamDead(err)) throw err;
      // Stream died since the last append — restart in place so the final
      // markdown still lands in the single live message.
      try {
        await this.restartOnce(e);
        await this.stop(e, markdown);
      } catch (err2) {
        log(`finish: restart+stop failed for ${threadTs} (${err2}), falling back to plain reply`);
        if (markdown) {
          await this.client.chat.postMessage({ channel: e.channel, thread_ts: e.threadTs, text: markdown });
        }
      }
    }
    await this.clearStatus(e);
    this.registry.delete(threadTs);
  }

  private stop(e: StreamEntry, markdown?: string) {
    return this.client.chat.stopStream({
      channel: e.channel,
      ts: e.streamTs,
      ...(markdown ? { markdown_text: markdown } : {}),
    });
  }

  /**
   * Two duties per tick, per stream:
   * 1. Proactive rotation — restart (replay + delete) BEFORE Slack's ~5:00
   *    kill, so viewers never see a dead "stopped" message.
   * 2. Idle probe — re-append the last task card (visually idempotent) as a
   *    fallback detector: if the stream died anyway (laptop slept through the
   *    rotation window), append() self-heals.
   * Deliberately does NOT touch lastActivity — only real job calls defer the
   * stale sweep.
   */
  async keepalive(idleMs = 60_000, rotateMs = ROTATE_MS) {
    for (const e of this.registry.values()) {
      if (Date.now() - e.streamStartedAt >= rotateMs) {
        log(`keepalive: rotating stream for ${e.threadTs} (age ≥ ${Math.round(rotateMs / 1000)}s)`);
        try {
          await this.restartOnce(e);
        } catch (err) {
          log(`keepalive rotation failed for ${e.threadTs}: ${err}`);
        }
        continue;
      }
      if (Date.now() - e.lastAppendAt < idleMs) continue;
      const lastCard = e.chunks.findLast((c): c is TaskUpdateChunk => c.type === "task_update") ?? BOOT_CARD;
      try {
        await this.append(e, [lastCard]);
      } catch (err) {
        log(`keepalive failed for ${e.threadTs}: ${err}`);
      }
    }
  }

  /** Best-effort teardown for crashed jobs (sweep) and shutdown. */
  async kill(e: StreamEntry, note: string) {
    try {
      await this.client.chat.stopStream({ channel: e.channel, ts: e.streamTs, markdown_text: note });
    } catch (err) {
      if (!isStreamDead(err)) log(`kill: stopStream failed for ${e.threadTs}: ${err}`);
    }
    await this.clearStatus(e);
    this.registry.delete(e.threadTs);
  }

  private async clearStatus(e: StreamEntry) {
    try {
      await this.client.assistant.threads.setStatus({
        channel_id: e.channel,
        thread_ts: e.threadTs,
        status: "",
      });
    } catch {
      // setStatus is not supported in every thread type; clearing is best-effort
    }
  }
}
