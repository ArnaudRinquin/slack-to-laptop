import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { log } from "./log";
import type { JobRecord } from "./jobs";

const exec = promisify(execFile);

export interface Pane {
  id: string;
  path: string;
  command: string;
}

/**
 * Pick the pane hosting the job's Claude session. Registration gives us the
 * pane id, but ids get recycled after close — so a pane only counts if its
 * current path is the job's worktree. Among path matches, prefer the
 * registered id, then a pane that looks like a Claude process (the claude CLI
 * shows up as its version number, e.g. "2.1.211", or as node/claude).
 */
export function findPane(panes: Pane[], job: JobRecord): Pane | undefined {
  const inWorktree = panes.filter((p) => p.path === job.cwd);
  if (!inWorktree.length) return undefined;
  return (
    inWorktree.find((p) => p.id === job.tmuxPane) ??
    inWorktree.find((p) => /^(\d+\.\d+|claude|node)/.test(p.command)) ??
    inWorktree[0]
  );
}

export async function listPanes(tmuxBin: string): Promise<Pane[]> {
  const { stdout } = await exec(tmuxBin, [
    "list-panes",
    "-a",
    "-F",
    "#{pane_id}\t#{pane_current_path}\t#{pane_current_command}",
  ]);
  return stdout
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [id = "", path = "", command = ""] = l.split("\t");
      return { id, path, command };
    });
}

/**
 * Type text into the pane's Claude session, exactly like a human would.
 * Newlines are collapsed (a raw newline would submit prematurely).
 */
export async function injectText(tmuxBin: string, paneId: string, text: string) {
  const oneLine = text.replace(/\s*\n+\s*/g, " ").trim();
  await exec(tmuxBin, ["send-keys", "-t", paneId, "-l", "--", oneLine]);
  await exec(tmuxBin, ["send-keys", "-t", paneId, "Enter"]);
  log(`inject: sent ${oneLine.length} chars to pane ${paneId}`);
}
