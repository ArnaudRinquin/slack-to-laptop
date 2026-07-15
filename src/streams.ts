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

/** Slack auto-closes streams after a quiet stretch; appends then fail with this. */
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
      lastActivity: now,
      lastAppendAt: now,
      lastChunk: BOOT_CARD,
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
   * Append with self-heal: Slack auto-closes streams left quiet too long — on
   * message_not_in_streaming_state, open a fresh stream in the same thread,
   * remap threadTs to it, and retry once.
   */
  private async append(e: StreamEntry, chunks: AnyChunk[]) {
    try {
      await this.client.chat.appendStream({ channel: e.channel, ts: e.streamTs, chunks });
    } catch (err) {
      if (!isStreamDead(err)) throw err;
      log(`append: stream dead for ${e.threadTs}, restarting`);
      await this.restart(e);
      await this.client.chat.appendStream({ channel: e.channel, ts: e.streamTs, chunks });
    }
    e.lastAppendAt = Date.now();
    const lastTask = chunks.findLast((c) => c.type === "task_update");
    if (lastTask) e.lastChunk = lastTask;
  }

  private async restart(e: StreamEntry) {
    const res = await this.client.chat.startStream({
      channel: e.channel,
      thread_ts: e.threadTs,
      recipient_team_id: e.teamId,
      recipient_user_id: e.userId,
      task_display_mode: this.config.taskDisplayMode,
    });
    if (!res.ts) throw new Error(`restart startStream returned no ts: ${JSON.stringify(res)}`);
    e.streamTs = res.ts;
    e.lastAppendAt = Date.now();
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
      await this.client.chat.stopStream({
        channel: e.channel,
        ts: e.streamTs,
        ...(markdown ? { markdown_text: markdown } : {}),
      });
    } catch (err) {
      if (!isStreamDead(err)) throw err;
      // Slack already closed it; deliver the final markdown as a plain reply so it isn't lost.
      if (markdown) {
        await this.client.chat.postMessage({ channel: e.channel, thread_ts: e.threadTs, text: markdown });
      }
    }
    await this.clearStatus(e);
    this.registry.delete(threadTs);
  }

  /**
   * Re-append the last task card (visually idempotent) on streams quiet for a
   * while so Slack doesn't auto-close them mid-job. Deliberately does NOT touch
   * lastActivity — only real job calls defer the stale sweep.
   */
  async keepalive(idleMs = 60_000) {
    for (const e of this.registry.values()) {
      if (Date.now() - e.lastAppendAt < idleMs) continue;
      try {
        await this.append(e, [e.lastChunk]);
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
