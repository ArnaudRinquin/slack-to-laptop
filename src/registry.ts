import type { AnyChunk } from "@slack/types";

export interface StreamEntry {
  threadTs: string;
  channel: string;
  /** ts returned by chat.startStream — the real Slack stream id. Never leaves this process. */
  streamTs: string;
  /** Needed to restart the stream if Slack auto-closes it during a quiet stretch. */
  teamId: string;
  userId: string;
  prompt: string;
  startedAt: number;
  /** Last job-originated MCP call — drives the stale sweep. */
  lastActivity: number;
  /** Last append of any kind (incl. keepalive) — drives the keepalive. */
  lastAppendAt: number;
  /** Re-appended unchanged as keepalive so Slack keeps the stream open. */
  lastChunk: AnyChunk;
  /** Boot card still spinning — completed on the job's first MCP call. */
  bootPending: boolean;
}

/** threadTs -> live stream. The worktree job only ever knows threadTs. */
export class Registry {
  private map = new Map<string, StreamEntry>();
  onChange: () => void = () => {};

  has(threadTs: string) {
    return this.map.has(threadTs);
  }

  get(threadTs: string) {
    return this.map.get(threadTs);
  }

  set(entry: StreamEntry) {
    this.map.set(entry.threadTs, entry);
    this.onChange();
  }

  touch(threadTs: string) {
    const e = this.map.get(threadTs);
    if (e) e.lastActivity = Date.now();
  }

  delete(threadTs: string) {
    const existed = this.map.delete(threadTs);
    if (existed) this.onChange();
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
