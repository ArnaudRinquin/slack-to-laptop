import type { Registry } from "./registry";

export const isSwiftBar = () =>
  Boolean(process.env.SWIFTBAR_VERSION || process.env.SWIFTBAR_PLUGIN_PATH) ||
  process.argv.includes("--swiftbar");

/**
 * Streamable SwiftBar plugin output: blocks on stdout separated by ~~~.
 * process.stdout.write (not console.log) — piped stdout is block-buffered otherwise.
 */
export function startSwiftBar(registry: Registry, port: number): () => void {
  const emit = () => {
    const entries = registry.values();
    const n = entries.length;
    const lines: string[] = [];
    lines.push(n > 0 ? `🛰️ ${n}` : "🛰️");
    lines.push("---");
    lines.push(`Slack→Laptop — ${n} active stream${n === 1 ? "" : "s"}`);
    for (const e of entries) {
      const mins = Math.floor((Date.now() - e.startedAt) / 60_000);
      const label = e.prompt.slice(0, 48) || "(no prompt)";
      lines.push(`${label} · ${mins}m | font=Menlo size=11`);
    }
    lines.push("---");
    lines.push(`MCP http://127.0.0.1:${port}/mcp | color=gray`);
    lines.push("~~~");
    process.stdout.write(lines.join("\n") + "\n");
  };

  emit();
  setInterval(emit, 30_000).unref();
  registry.onChange = emit;
  return emit;
}
