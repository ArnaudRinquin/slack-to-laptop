import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Config {
  botToken: string;
  appToken: string;
  port: number;
  taskDisplayMode: "timeline" | "plan";
  staleStreamMinutes: number;
  /**
   * Shell command spawned per mention (via /bin/zsh -lc). Receives env:
   * SLACK_THREAD_TS, SLACK_CHANNEL, SLACK_PROMPT, SLACK_EVENT_TS, SLACK_MCP_URL.
   * If null, runs a built-in smoke demo (stream "hi" + a task card, then stop).
   */
  jobCommand: string | null;
  jobCwd: string;
  /** Slack user IDs allowed to trigger jobs. Empty = anyone. Others get a threaded refusal. */
  allowedUserIds: string[];
  /** tmux binary (absolute — the SwiftBar env has a minimal PATH). */
  tmuxBin: string;
}

export const CONFIG_PATH = join(homedir(), ".config", "slack-trigger", "config.json");

export function loadConfig(): Config {
  let raw: string;
  try {
    raw = readFileSync(CONFIG_PATH, "utf8");
  } catch {
    throw new Error(`missing config: ${CONFIG_PATH} — copy config.example.json there and fill tokens`);
  }
  const j = JSON.parse(raw);
  if (!j.botToken?.startsWith("xoxb-")) throw new Error("config.botToken must be an xoxb- bot token");
  if (!j.appToken?.startsWith("xapp-")) throw new Error("config.appToken must be an xapp- app-level token");
  return {
    botToken: j.botToken,
    appToken: j.appToken,
    port: j.port ?? 8365,
    taskDisplayMode: j.taskDisplayMode === "plan" ? "plan" : "timeline",
    staleStreamMinutes: j.staleStreamMinutes ?? 60,
    jobCommand: j.jobCommand ?? null,
    jobCwd: j.jobCwd ?? homedir(),
    allowedUserIds: Array.isArray(j.allowedUserIds)
      ? j.allowedUserIds.filter((x: unknown): x is string => typeof x === "string")
      : [],
    tmuxBin: j.tmuxBin ?? "/opt/homebrew/bin/tmux",
  };
}
