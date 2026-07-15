/** Logs go to stderr only — stdout is reserved for SwiftBar streamable blocks. */
export function log(msg: string) {
  process.stderr.write(`[${new Date().toISOString()}] ${msg}\n`);
}
