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

/** Cap on recorded prose so a rendered message never exceeds Slack's size limits. */
const REPLAY_TEXT_CAP = 8_000;

/** Slack's markdown block caps at 12k chars — hard bound for the full render. */
const RENDER_CAP = 11_500;

/**
 * Slack hard-kills a stream ~5:00 after it opens, appends or not (measured; no
 * keepalive of any kind prevents it — even changing content). So: stream
 * natively only while young, then STOP the stream cleanly before the kill and
 * switch to editing the same message in place (chat.update works on stopped
 * streamed messages — measured too). One message per job, zero thread churn.
 * With the 60s keepalive tick, conversion lands at age 3:30–4:30.
 */
const CONVERT_MS = 3.5 * 60_000;

function isStreamDead(err: unknown): boolean {
  const e = err as { data?: { error?: string }; message?: string };
  return (
    e?.data?.error === "message_not_in_streaming_state" ||
    Boolean(e?.message?.includes("message_not_in_streaming_state"))
  );
}

const STATUS_ICON: Record<string, string> = {
  pending: "▫️",
  in_progress: "⏳",
  complete: "✅",
  error: "❌",
};

/** Render the replay log (checklist + prose, in order) as one markdown body. */
export function renderLog(chunks: AnyChunk[]): string {
  const parts: string[] = [];
  for (const c of chunks) {
    if (c.type === "task_update") {
      parts.push(`${STATUS_ICON[c.status ?? "pending"] ?? "▫️"} ${c.title}${c.details ? ` — ${c.details}` : ""}`);
    } else if (c.type === "markdown_text") {
      const t = c.text.trim();
      if (t) parts.push("", t, "");
    }
  }
  const text = parts.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return text.length > RENDER_CAP ? `…${text.slice(-RENDER_CAP)}` : text;
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
      chunks: [BOOT_CARD], // checklist appears instantly
    });
    if (!res.ts) throw new Error(`startStream returned no ts: ${JSON.stringify(res)}`);
    const now = Date.now();
    const entry: StreamEntry = {
      threadTs: args.threadTs,
      channel: args.channel,
      mode: "stream",
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

  /** Entries restored from disk: stream liveness unknown — convert them now. */
  async adoptRestored() {
    for (const e of this.registry.values()) {
      if (e.mode !== "update") {
        await this.convertOnce(e).catch((err) => log(`adopt: convert failed for ${e.threadTs}: ${err}`));
      }
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

  /**
   * Stream-mode: appendStream; if the stream died early, fold the chunks in
   * and convert to update-mode (which renders them). Update-mode: record and
   * re-render the whole message via chat.update.
   */
  private async append(e: StreamEntry, chunks: AnyChunk[]) {
    if (e.mode === "update") {
      this.record(e, chunks);
      await this.update(e);
      return;
    }
    try {
      await this.client.chat.appendStream({ channel: e.channel, ts: e.streamTs, chunks });
      e.lastAppendAt = Date.now();
      this.record(e, chunks);
      this.registry.persistSoon();
    } catch (err) {
      if (!isStreamDead(err)) throw err;
      log(`append: stream dead for ${e.threadTs}, converting to update-mode`);
      this.record(e, chunks);
      await this.convertOnce(e);
    }
  }

  /** Concurrent MCP calls + the keepalive can race into conversion — coalesce. */
  private conversions = new Map<string, Promise<void>>();
  private convertOnce(e: StreamEntry): Promise<void> {
    let p = this.conversions.get(e.threadTs);
    if (!p) {
      p = this.convertToUpdate(e).finally(() => this.conversions.delete(e.threadTs));
      this.conversions.set(e.threadTs, p);
    }
    return p;
  }

  /** Stop the native stream cleanly (best-effort) and take over with chat.update. */
  private async convertToUpdate(e: StreamEntry) {
    if (e.mode === "update") return;
    e.mode = "update";
    try {
      await this.client.chat.stopStream({ channel: e.channel, ts: e.streamTs });
    } catch {
      // already killed by Slack — chat.update works regardless
    }
    await this.update(e);
  }

  /** Full re-render of the single message. Last write wins; every write is full state. */
  private async update(e: StreamEntry) {
    const text = renderLog(e.chunks);
    await this.client.chat.update({
      channel: e.channel,
      ts: e.streamTs,
      text,
      // "markdown" block renders standard markdown (unlike mrkdwn text)
      blocks: [{ type: "markdown", text } as never],
    });
    e.lastAppendAt = Date.now();
    this.registry.persistSoon();
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
      if (e.mode === "update") {
        if (markdown) this.record(e, [{ type: "markdown_text", text: `\n${markdown}` }]);
        await this.update(e);
      } else {
        try {
          await this.client.chat.stopStream({
            channel: e.channel,
            ts: e.streamTs,
            ...(markdown ? { markdown_text: markdown } : {}),
          });
        } catch (err) {
          if (!isStreamDead(err)) throw err;
          // Stream died since the last append — deliver via update-mode instead.
          if (markdown) this.record(e, [{ type: "markdown_text", text: `\n${markdown}` }]);
          await this.convertOnce(e);
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
   * One duty per tick: convert young native streams to update-mode BEFORE
   * Slack's ~5:00 kill. Update-mode entries need nothing — chat.update never
   * expires. Deliberately does NOT touch lastActivity — only real job calls
   * defer the stale sweep.
   */
  async keepalive(convertMs = CONVERT_MS) {
    for (const e of this.registry.values()) {
      if (e.mode !== "stream" || Date.now() - e.streamStartedAt < convertMs) continue;
      log(`keepalive: converting ${e.threadTs} to update-mode (stream age ≥ ${Math.round(convertMs / 1000)}s)`);
      try {
        await this.convertOnce(e);
      } catch (err) {
        log(`keepalive conversion failed for ${e.threadTs}: ${err}`);
      }
    }
  }

  /** Best-effort teardown for crashed jobs (sweep). */
  async kill(e: StreamEntry, note: string) {
    try {
      if (e.mode === "update") {
        this.record(e, [{ type: "markdown_text", text: `\n${note}` }]);
        await this.update(e);
      } else {
        await this.client.chat.stopStream({ channel: e.channel, ts: e.streamTs, markdown_text: note });
      }
    } catch (err) {
      if (!isStreamDead(err)) log(`kill: teardown failed for ${e.threadTs}: ${err}`);
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
