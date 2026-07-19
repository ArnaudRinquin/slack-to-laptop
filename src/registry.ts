import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { TaskUpdateChunk } from "@slack/types";
import { log } from "./log";

export interface StreamEntry {
  threadTs: string;
  channel: string;
  /**
   * "stream": a native Slack streamed message (segment) is live. "idle": the
   * segment was closed cleanly before Slack's ~5:00 kill; the next job call
   * lazily opens a fresh segment.
   */
  mode: "stream" | "idle";
  /** ts returned by chat.startStream — the real Slack stream id. Never leaves this process. */
  streamTs: string;
  /** Needed to restart the stream if Slack auto-closes it during a quiet stretch. */
  teamId: string;
  userId: string;
  prompt: string;
  startedAt: number;
  /** When the CURRENT Slack stream opened (reset on rotation) — drives proactive rotation. */
  streamStartedAt: number;
  /** Last job-originated MCP call — drives the stale sweep. */
  lastActivity: number;
  /** Last successful append to the current segment. */
  lastAppendAt: number;
  /**
   * Task cards currently in_progress in the LIVE segment. Slack renders frozen
   * in_progress cards with a ⚠️ once the stream stops — so closes mark these
   * complete first (the step visibly continues in the next segment).
   */
  liveCards: TaskUpdateChunk[];
  /** Boot card still spinning — completed on the job's first MCP call. */
  bootPending: boolean;
}

/**
 * threadTs -> live stream. The worktree job only ever knows threadTs.
 * With a persistPath, the map survives bridge restarts: Slack streams are not
 * process-bound (streamTs is just a message ts), so restoring the map is all it
 * takes for running jobs to keep streaming across a redeploy.
 */
export class Registry {
  private map = new Map<string, StreamEntry>();
  onChange: () => void = () => {};
  private saveTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private persistPath?: string) {}

  /**
   * Reload entries persisted by a previous process, dropping anything the
   * sweep would kill anyway. StreamOps.adoptRestored() then closes any live
   * segment cleanly; the next job call opens a fresh one.
   */
  load(maxAgeMs: number): number {
    if (!this.persistPath) return 0;
    let entries: StreamEntry[];
    try {
      entries = JSON.parse(readFileSync(this.persistPath, "utf8"));
    } catch {
      return 0;
    }
    const cutoff = Date.now() - maxAgeMs;
    for (const e of entries) {
      if (!e?.threadTs || e.lastActivity < cutoff) continue;
      e.liveCards ??= [];
      this.map.set(e.threadTs, e);
    }
    if (this.map.size) this.onChange();
    return this.map.size;
  }

  /** Debounced persist — cheap enough to call on every mutation. */
  persistSoon() {
    if (!this.persistPath) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.persistNow(), 500);
    this.saveTimer.unref?.();
  }

  /** Atomic snapshot (tmp + rename). Called directly on shutdown. */
  persistNow() {
    if (!this.persistPath) return;
    clearTimeout(this.saveTimer);
    try {
      mkdirSync(dirname(this.persistPath), { recursive: true });
      const tmp = `${this.persistPath}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.values()));
      renameSync(tmp, this.persistPath);
    } catch (err) {
      log(`registry: persist failed: ${err}`);
    }
  }

  has(threadTs: string) {
    return this.map.has(threadTs);
  }

  get(threadTs: string) {
    return this.map.get(threadTs);
  }

  set(entry: StreamEntry) {
    this.map.set(entry.threadTs, entry);
    this.onChange();
    this.persistSoon();
  }

  touch(threadTs: string) {
    const e = this.map.get(threadTs);
    if (e) e.lastActivity = Date.now();
    this.persistSoon();
  }

  delete(threadTs: string) {
    const existed = this.map.delete(threadTs);
    if (existed) {
      this.onChange();
      this.persistSoon();
    }
    return existed;
  }

  values() {
    return [...this.map.values()];
  }

  stale(maxAgeMs: number) {
    const cutoff = Date.now() - maxAgeMs;
    return this.values().filter((e) => e.lastActivity < cutoff);
  }
}
