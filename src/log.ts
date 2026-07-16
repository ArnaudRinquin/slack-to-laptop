import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const LOG_PATH = join(homedir(), ".cache", "slack-to-laptop", "server.log");
mkdirSync(join(homedir(), ".cache", "slack-to-laptop"), { recursive: true });

/**
 * Logs go to the file + stderr — NEVER stdout (reserved for SwiftBar blocks).
 * The file write happens here rather than via shell redirect because SwiftBar
 * monitors the plugin's stderr pipe: a `2>>file` redirect closes that pipe and
 * SwiftBar's readability handler then spins at 100%+ CPU on EOF forever.
 */
export function log(msg: string) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try {
    appendFileSync(LOG_PATH, line);
  } catch {
    // file logging is best-effort
  }
  process.stderr.write(line);
}
