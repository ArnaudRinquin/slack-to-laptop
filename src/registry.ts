import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AnyChunk } from "@slack/types";
import { log } from "./log";

export interface StreamEntry {
  threadTs: string;
  channel: string;
  /**
   * "stream": native Slack stream, first ~3.5 min only (Slack hard-kills
   * streams at ~5:00). "update": stream stopped cleanly; the same message is
   * edited in place via chat.update from then on — no new thread messages.
   */
  mode: "stream" | "update";
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
  /** Last append of any kind (incl. keepalive) — drives the keepalive. */
  lastAppendAt: number;
  /**
   * Replay log: current checklist state (task cards deduped by id, in first-seen
   * order) + prose tail. Seeds the fresh stream when Slack kills the old one, so
   * a restart is invisible.
   */
  chunks: AnyChunk[];
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
   * sweep would kill anyway. Restored entries are forced to update-mode: their
   * stream (if any) is of unknown liveness and likely past Slack's ~5:00 kill;
   * StreamOps.adoptRestored() stops it best-effort and edits from there.
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
