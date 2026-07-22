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

/** Slack's markdown block (and stopStream markdown_text) cap at 12k chars. */
const RENDER_CAP = 11_500;

/**
 * Slack hard-kills a stream ~5:00 after it opens, appends or not (measured; no
 * keepalive of any kind prevents it — even changing content), and there is no
 * way to re-stream onto an existing ts. So each job gets ONE progress message:
 * stream natively while young (full native card UI), then STOP cleanly before
 * the kill and edit the same message in place via chat.update from then on
 * (works on stopped streamed messages — measured). The cards become a markdown
 * checklist at conversion — the price of a single message with zero pings.
 * The final report is the only other message: posted on finish, one ping.
 * With the 60s keepalive tick, conversion lands at age 3:30–4:30.
 */
const CONVERT_MS = 3.5 * 60_000;

/** Footer on the edited message while the job runs — edits don't bump the ts, so show freshness. */
const LIVE_FOOTER = (time: string) => `⏳ still working — updated ${time}`;

/** Slack rejects messages with more than 50 blocks. */
const MAX_BLOCKS = 50;

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

/** Render the replay log (checklist + prose, in order) as one markdown body — chat.update text fallback. */
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

/**
 * Render the replay log as NATIVE blocks: task_update chunks → task_card
 * blocks, prose → markdown blocks. task_card/plan are real Block Kit blocks
 * (changelog 2026-02-11) accepted by chat.update — even on a stopped stream
 * (measured) — so conversion keeps the exact card UI the stream had.
 * Block-form quirks vs the chunk form (measured): status is REQUIRED and
 * "pending" is rejected (enum in_progress|complete|error) — pending steps are
 * simply not shown yet, matching how jobs reveal steps as they start.
 */
export function renderBlocks(chunks: AnyChunk[]): object[] {
  const blocks: object[] = [];
  for (const c of chunks) {
    if (c.type === "task_update") {
      if ((c.status ?? "pending") === "pending") continue;
      blocks.push({
        type: "task_card",
        task_id: c.id,
        title: c.title,
        status: c.status,
        ...(c.details
          ? {
              details: {
                type: "rich_text",
                elements: [{ type: "rich_text_section", elements: [{ type: "text", text: c.details }] }],
              },
            }
          : {}),
      });
    } else if (c.type === "markdown_text") {
      const t = c.text.trim();
      if (t) blocks.push({ type: "markdown", text: t.length > RENDER_CAP ? `…${t.slice(-RENDER_CAP)}` : t });
    }
  }
  if (!blocks.length) blocks.push({ type: "markdown", text: "⏳ working…" });
  if (blocks.length > MAX_BLOCKS - 1) {
    return [
      { type: "context", elements: [{ type: "mrkdwn", text: "_…earlier steps truncated_" }] },
      ...blocks.slice(-(MAX_BLOCKS - 2)),
    ];
  }
  return blocks;
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
    /** Boot card title — follow-ups use "Reconnecting to session…". */
    bootTitle?: string;
  }): Promise<StreamEntry> {
    const boot = args.bootTitle ? { ...BOOT_CARD, title: args.bootTitle } : BOOT_CARD;
    const ts = await this.startStream(args, [boot]); // checklist appears instantly
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
      chunks: [boot],
      bootPending: true,
    };
    this.registry.set(entry);
    return entry;
  }

  /** Entries restored from disk: stream liveness unknown — convert them now (replay log re-renders everything). */
  async adoptRestored() {
    for (const e of this.registry.values()) {
      if (e.mode !== "stream") continue;
      await this.convertOnce(e).catch((err) => log(`adopt: convert failed for ${e.threadTs}: ${err}`));
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
   * Stream-mode: appendStream; if the stream died early (laptop slept past the
   * 5:00 kill), fold the chunks in and convert — the edit re-renders them.
   * Update-mode: record and re-render the whole message via chat.update.
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

  /**
   * Full re-render of the single message. Serialized per entry so a slow older
   * render can never land on top of a newer one; every write is full state.
   */
  private edits = new Map<string, Promise<void>>();
  private update(e: StreamEntry, opts: { final?: boolean } = {}): Promise<void> {
    const prev = this.edits.get(e.threadTs) ?? Promise.resolve();
    const p = prev
      .catch(() => {}) // a failed earlier edit must not poison the chain
      .then(async () => {
        const time = new Date().toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
        const blocks = renderBlocks(e.chunks);
        if (!opts.final) {
          blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: `_${LIVE_FOOTER(time)}_` }] });
        }
        await this.client.chat.update({
          channel: e.channel,
          ts: e.streamTs,
          text: renderLog(e.chunks) || "⏳ working…", // notification/accessibility fallback
          blocks: blocks as never,
        });
        e.lastAppendAt = Date.now();
        this.registry.persistSoon();
      });
    this.edits.set(e.threadTs, p);
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

  /** First job-originated call completes the boot card in the same append. */
  private drainBoot(e: StreamEntry): AnyChunk[] {
    if (!e.bootPending) return [];
    e.bootPending = false;
    const boot =
      e.chunks.find((c): c is TaskUpdateChunk => c.type === "task_update" && c.id === "boot") ?? BOOT_CARD;
    return [{ ...boot, status: "complete" }];
  }

  /** Steps still spinning at the end, restated with a terminal status. */
  private settleSteps(e: StreamEntry, status: "complete" | "error"): AnyChunk[] {
    e.bootPending = false;
    return e.chunks
      .filter((c): c is TaskUpdateChunk => c.type === "task_update" && c.status === "in_progress")
      .map((c) => ({ ...c, status }));
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

  /**
   * Settle the progress message (no lingering ⏳/⚠️, no live footer) and post
   * the report — a separate message, deliberately: it's the job's ONE ping.
   * Still streaming at finish (short job): plain stop keeps the native cards
   * frozen in their full glory.
   */
  async finish(threadTs: string, markdown?: string) {
    const e = this.entry(threadTs);
    try {
      const closing = this.settleSteps(e, "complete");
      if (e.mode === "update") {
        this.record(e, closing);
        await this.update(e, { final: true });
      } else {
        try {
          if (closing.length) {
            await this.client.chat.appendStream({ channel: e.channel, ts: e.streamTs, chunks: closing });
          }
          await this.client.chat.stopStream({ channel: e.channel, ts: e.streamTs });
          this.record(e, closing);
        } catch (err) {
          if (!isStreamDead(err)) throw err;
          this.record(e, closing);
          await this.convertOnce(e);
          await this.update(e, { final: true });
        }
      }
    } catch (err) {
      // progress message is best-effort from here — the report must still go out
      log(`finish: settling progress message failed for ${threadTs}: ${err}`);
    }
    if (markdown) await this.postReport(e, markdown);
    await this.clearStatus(e);
    this.edits.delete(threadTs);
    this.registry.delete(threadTs);
  }

  /**
   * Native-looking report: its own immediately-closed stream, seeded with the
   * markdown as a chunk + a PLAIN stop — the shape segment-mode finals shipped
   * with (md-stop on a chunked stream → streaming_mode_mismatch, measured).
   */
  private async postReport(e: StreamEntry, markdown: string) {
    const text = markdown.length > RENDER_CAP ? `${markdown.slice(0, RENDER_CAP)}…` : markdown;
    try {
      const ts = await this.startStream(e, [{ type: "markdown_text", text }]);
      await this.client.chat.stopStream({ channel: e.channel, ts });
    } catch (err) {
      log(`report: native delivery failed for ${e.threadTs} (${err}), plain reply`);
      await this.client.chat.postMessage({ channel: e.channel, thread_ts: e.threadTs, text });
    }
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

  /** Best-effort teardown for crashed jobs (sweep): spinning steps → ❌, note folded into the message. */
  async kill(e: StreamEntry, note: string) {
    try {
      const chunks: AnyChunk[] = [...this.settleSteps(e, "error"), { type: "markdown_text", text: `\n${note}` }];
      if (e.mode === "update") {
        this.record(e, chunks);
        await this.update(e, { final: true });
      } else {
        try {
          await this.client.chat.appendStream({ channel: e.channel, ts: e.streamTs, chunks });
          await this.client.chat.stopStream({ channel: e.channel, ts: e.streamTs });
        } catch (err) {
          if (!isStreamDead(err)) throw err;
          this.record(e, chunks);
          await this.convertOnce(e);
          await this.update(e, { final: true });
        }
      }
    } catch (err) {
      log(`kill: teardown failed for ${e.threadTs} (${err}), plain reply`);
      await this.client.chat
        .postMessage({ channel: e.channel, thread_ts: e.threadTs, text: note })
        .catch(() => {});
    }
    await this.clearStatus(e);
    this.edits.delete(e.threadTs);
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
