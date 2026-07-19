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

/**
 * Slack hard-kills a stream ~5:00 after it opens, appends or not (measured; no
 * keepalive of any kind prevents it — even changing content). So jobs stream in
 * SEGMENTS: close each streamed message cleanly before the kill (with a soft
 * "…still working" sign-off, no ugly warning), then open a fresh streamed
 * message lazily — only when the job next has content. Every message is a
 * cleanly finished chapter; quiet stretches create nothing.
 * With the 60s keepalive tick, closes land at age 3:30–4:30.
 */
const SEGMENT_MS = 3.5 * 60_000;

/** Appended to a segment that's being closed mid-job. */
const SEGMENT_CLOSER = "\n_⏳ still working — continuing in a new message below…_";

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

  private async startStream(e: Pick<StreamEntry, "channel" | "threadTs" | "teamId" | "userId">, chunks: AnyChunk[]) {
    const res = await this.client.chat.startStream({
      channel: e.channel,
      thread_ts: e.threadTs,
      recipient_team_id: e.teamId,
      recipient_user_id: e.userId,
      task_display_mode: this.config.taskDisplayMode,
      ...(chunks.length ? { chunks } : {}),
    });
    if (!res.ts) throw new Error(`startStream returned no ts: ${JSON.stringify(res)}`);
    return res.ts;
  }

  async start(args: {
    channel: string;
    threadTs: string;
    teamId: string;
    userId: string;
    prompt: string;
  }): Promise<StreamEntry> {
    const ts = await this.startStream(args, [BOOT_CARD]); // checklist appears instantly
    const now = Date.now();
    const entry: StreamEntry = {
      threadTs: args.threadTs,
      channel: args.channel,
      mode: "stream",
      streamTs: ts,
      teamId: args.teamId,
      userId: args.userId,
      prompt: args.prompt,
      startedAt: now,
      streamStartedAt: now,
      lastActivity: now,
      lastAppendAt: now,
      bootPending: true,
    };
    this.registry.set(entry);
    return entry;
  }

  /**
   * Close the live segment cleanly: append the sign-off, then a PLAIN stop.
   * (stopStream with markdown_text only works on chunk-less streams —
   * streaming_mode_mismatch otherwise; measured.)
   */
  private async closeSegment(e: StreamEntry, closer?: string) {
    if (closer) {
      await this.client.chat
        .appendStream({ channel: e.channel, ts: e.streamTs, chunks: [{ type: "markdown_text", text: closer }] })
        .catch(() => {}); // already dead — nothing to sign off
    }
    try {
      await this.client.chat.stopStream({ channel: e.channel, ts: e.streamTs });
    } catch (err) {
      if (!isStreamDead(err)) log(`closeSegment: stop failed for ${e.threadTs}: ${err}`);
    }
    e.mode = "idle";
    this.registry.persistSoon();
  }

  /**
   * Entries restored from disk: the old segment's liveness is unknown — close
   * it cleanly (best-effort) so it never shows Slack's kill warning; the next
   * job call opens a fresh segment.
   */
  async adoptRestored() {
    for (const e of this.registry.values()) {
      if (e.mode === "stream") await this.closeSegment(e, SEGMENT_CLOSER);
    }
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

  /** Concurrent MCP calls can race to open the next segment — coalesce to one. */
  private openings = new Map<string, Promise<void>>();
  private async openSegment(e: StreamEntry, chunks: AnyChunk[]): Promise<boolean> {
    const pending = this.openings.get(e.threadTs);
    if (pending) {
      await pending; // someone else opened it; caller appends normally
      return false;
    }
    const p = (async () => {
      e.streamTs = await this.startStream(e, chunks);
      e.mode = "stream";
      e.streamStartedAt = Date.now();
      e.lastAppendAt = Date.now();
      this.registry.persistSoon();
    })().finally(() => this.openings.delete(e.threadTs));
    this.openings.set(e.threadTs, p);
    await p;
    return true; // chunks were delivered as the new segment's seed
  }

  /**
   * Live segment: appendStream. Idle (segment closed): lazily open the next
   * segment with these chunks. Dead segment (died before the clean close, e.g.
   * laptop slept): mark idle and open the next one.
   */
  private async append(e: StreamEntry, chunks: AnyChunk[]) {
    if (e.mode === "idle") {
      const delivered = await this.openSegment(e, chunks);
      if (delivered) return;
    }
    try {
      await this.client.chat.appendStream({ channel: e.channel, ts: e.streamTs, chunks });
      e.lastAppendAt = Date.now();
      this.registry.persistSoon();
    } catch (err) {
      if (!isStreamDead(err)) throw err;
      log(`append: segment dead for ${e.threadTs}, opening next segment`);
      e.mode = "idle";
      const delivered = await this.openSegment(e, chunks);
      if (!delivered) {
        await this.client.chat.appendStream({ channel: e.channel, ts: e.streamTs, chunks });
        e.lastAppendAt = Date.now();
        this.registry.persistSoon();
      }
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
    try {
      // append() handles every state: live segment, idle (opens the final's own
      // segment), or died-mid-segment (opens a fresh one).
      const chunks: AnyChunk[] = [
        ...this.drainBoot(e),
        ...(markdown ? [{ type: "markdown_text", text: markdown } as AnyChunk] : []),
      ];
      if (chunks.length) await this.append(e, chunks);
      if (e.mode === "stream") {
        try {
          await this.client.chat.stopStream({ channel: e.channel, ts: e.streamTs });
        } catch (err) {
          if (!isStreamDead(err)) throw err;
        }
      }
    } catch (err) {
      log(`finish: delivery failed for ${threadTs} (${err}), falling back to plain reply`);
      if (markdown) {
        await this.client.chat.postMessage({ channel: e.channel, thread_ts: e.threadTs, text: markdown });
      }
    }
    await this.clearStatus(e);
    this.registry.delete(threadTs);
  }

  /**
   * One duty per tick: close live segments BEFORE Slack's ~5:00 kill, with a
   * soft "…still working" sign-off. The next job call opens a fresh segment.
   * Deliberately does NOT touch lastActivity — only real job calls defer the
   * stale sweep.
   */
  async keepalive(segmentMs = SEGMENT_MS) {
    for (const e of this.registry.values()) {
      if (e.mode !== "stream" || Date.now() - e.streamStartedAt < segmentMs) continue;
      log(`keepalive: closing segment for ${e.threadTs} (age ≥ ${Math.round(segmentMs / 1000)}s)`);
      await this.closeSegment(e, SEGMENT_CLOSER);
    }
  }

  /** Best-effort teardown for crashed jobs (sweep). */
  async kill(e: StreamEntry, note: string) {
    try {
      await this.append(e, [{ type: "markdown_text", text: `\n${note}` }]);
      if (e.mode === "stream") await this.closeSegment(e);
    } catch (err) {
      log(`kill: teardown failed for ${e.threadTs} (${err}), plain reply`);
      await this.client.chat
        .postMessage({ channel: e.channel, thread_ts: e.threadTs, text: note })
        .catch(() => {});
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
