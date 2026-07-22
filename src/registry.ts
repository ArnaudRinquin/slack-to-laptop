import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AnyChunk } from "@slack/types";
import { log } from "./log";

export interface StreamEntry {
  threadTs: string;
  channel: string;
  /**
   * "stream": the job's single message is a live native stream (young, full
   * card UI). "update": the stream was stopped before Slack's ~5:00 kill and
   * the SAME message is now edited in place via chat.update — forever.
   */
  mode: "stream" | "update";
  /** ts of the job's single message (returned by chat.startStream). Never leaves this process. */
  streamTs: string;
  /** Needed to open the final-report stream (and reopen on follow-ups). */
  teamId: string;
  userId: string;
  prompt: string;
  startedAt: number;
  /** When the native stream opened — drives the proactive stream→update conversion. */
  streamStartedAt: number;
  /** Last job-originated MCP call — drives the stale sweep. */
  lastActivity: number;
  /** Last successful write (append or edit) to the message. */
  lastAppendAt: number;
  /**
   * Replay log: every chunk ever appended, with task_update chunks collapsed
   * by id to their latest state. In update-mode each edit re-renders this log
   * in full; across bridge restarts it's what makes the message recoverable.
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
   * sweep would kill anyway. StreamOps.adoptRestored() then converts any
   * still-streaming entry to update-mode (its liveness is unknown).
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
      e.chunks ??= [];
      if (e.mode !== "stream") e.mode = "update"; // migrates pre-update-mode snapshots ("idle")
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
