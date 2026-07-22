#!/bin/zsh
# Launched by slack-to-laptop per @mention with SLACK_THREAD_TS / SLACK_CHANNEL /
# SLACK_PROMPT / SLACK_EVENT_TS / SLACK_MCP_URL in env.
#
# Opens a throwaway window in the existing tmux session and runs `wt switch -c`
# from INSIDE it: the monorepo's setup-tmux hook exits silently when $TMUX is
# unset, so the worktree's real window (with claude preloaded via
# WT_EXTRA) only appears if wt runs within tmux. The temp window closes itself
# on success and stays open showing the error on failure.
set -euo pipefail

TMUX_BIN=/opt/homebrew/bin/tmux
SESSION=teetsh
REPO=$HOME/projects/teetsh/monorepo

BRANCH="slack-${SLACK_EVENT_TS//./-}"
PROMPT="/slack-ta [threadTs:${SLACK_THREAD_TS}] ${SLACK_PROMPT}"

# Laptop just rebooted / tmux not running: start the session detached.
$TMUX_BIN has-session -t "$SESSION" 2>/dev/null ||
  $TMUX_BIN new-session -d -s "$SESSION" -c "$REPO"

WIN=$($TMUX_BIN new-window -d -P -F '#{window_id}' -t "$SESSION:" -n "🛰️ launching" -c "$REPO")

# ${(q)…} quotes for the receiving interactive shell — Slack text can contain
# quotes/newlines/backticks. -l sends the string literally (no key-name lookup).
# Interactive shell = wt function + full PATH, same as spawning by hand.
# sleep before exit keeps the layout's background trust-prompt watcher alive.
#
# `wt spawn` is the shared alias in ~/.config/worktrunk/config.toml — a fetch plus
# `wt switch -c --base origin/<default> --no-cd`. Basing on the REMOTE default
# matters: worktrunk defaults to the local one, which goes stale between pulls, so
# slack jobs used to start N commits behind. (Monorepo PR #2176 fixed only the old
# `g wtc` alias, which this script never called.)
CMD="wt spawn --name=${(q)BRANCH} --prompt=${(q)PROMPT} && { sleep 30; exit }"
$TMUX_BIN send-keys -t "$WIN" -l -- "$CMD"
$TMUX_BIN send-keys -t "$WIN" Enter
