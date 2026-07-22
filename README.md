# slack-to-laptop

One long-lived local process, three hats: Slack `@mention` listener (Socket Mode),
remote HTTP MCP server that Claude Code worktree jobs call to drive the native
Slack stream, and SwiftBar menubar status.

`threadTs` is the correlation key: the worktree job only ever knows `threadTs`;
this process maps it to the real Slack stream id. The map is snapshotted to
`~/.cache/slack-to-laptop/registry.json`, so restarting the bridge (deploys,
crashes) doesn't interrupt running jobs: on boot, restored streams are
force-rotated by the first keepalive tick — rotation doubles as recovery.

## Slack app (one-time)

1. <https://api.slack.com/apps> → Create New App → From scratch.
2. **Agents & AI Apps** feature → toggle ON (grants `assistant:write`, required for streams + setStatus).
3. **Socket Mode** → ON → create app-level token with scope `connections:write` → that's `appToken` (`xapp-…`).
4. **OAuth & Permissions** → bot scopes: `app_mentions:read`, `chat:write`, `assistant:write`.
5. **Event Subscriptions** → subscribe to bot event `app_mention`.
6. Install to workspace → `botToken` (`xoxb-…`). Invite the bot to your channel: `/invite @YourApp`.

Note: Slack docs say `setStatus` is migrating from `assistant:write` to `chat:write` — both scopes above cover either.

## Run

```sh
mkdir -p ~/.config/slack-trigger
cp config.example.json ~/.config/slack-trigger/config.json
# fill botToken + appToken
bun run server.ts
```

`allowedUserIds` (Slack user IDs): when non-empty, only those users can trigger
jobs — anyone else gets a threaded "only <them> can trigger me" reply. Empty =
anyone in the channel.

With `jobCommand: null`, mentioning the bot runs a smoke demo: instant thinking
checklist, two task cards ticking, "hi", stream closed. That validates the whole
Slack side before wiring any jobs.

## Wire real jobs

Set `jobCommand` in the config — a zsh command run per mention with env:

| var | value |
|---|---|
| `SLACK_THREAD_TS` | correlation token — pass to every MCP tool call |
| `SLACK_CHANNEL` | channel id |
| `SLACK_PROMPT` | mention text, bot mention stripped |
| `SLACK_EVENT_TS` | unique per mention — use for the worktree name |
| `SLACK_MCP_URL` | `http://127.0.0.1:8365/mcp` |

Example: `"jobCommand": "/Users/you/projects/slack-to-laptop/scripts/launch-job.zsh"` —
see `scripts/launch-job.zsh` (machine-specific: tmux session + repo hardcoded).
It spawns a worktree Claude with prompt `/slack-ta [threadTs:$SLACK_THREAD_TS] $SLACK_PROMPT`:
the token travels *inside the prompt*, since the job's Claude only sees what the
skill receives (see "Job-side skill" below).

Connect the worktree's Claude to the MCP (once, user scope):

```sh
claude mcp add --transport http --scope user slack-stream http://127.0.0.1:8365/mcp
```

## MCP tools

All take `threadTs` (from `SLACK_THREAD_TS`):

- `register_job({threadTs, cwd, tmuxPane?, pid?, branch?})` — call once at boot; where the session lives, for follow-up routing
- `thinking_step({threadTs, title, status, id?, details?})` — checklist step; `status ∈ pending|in_progress|complete|error`; same `id`/title updates the step
- `append_text({threadTs, markdown})` — prose in the progress message (important mid-course findings only)
- `set_status({threadTs, text})` — grey "is …" line; `""` clears
- `finish({threadTs, markdown?})` — settle the progress message + post `markdown` as its own final-report reply (the user's one notification). Call exactly once, last (again after each follow-up).

## Follow-ups

Mentioning the bot again in a job's thread does NOT spawn a second job: the
bridge looks the thread up in `~/.cache/slack-to-laptop/jobs.json` (written by
`register_job`, survives `finish` for 7 days), verifies the session's tmux pane
still sits in the job's worktree (pane ids get recycled — cwd is ground truth),
and types `[slack follow-up threadTs:…] <text>` into that Claude session via
`tmux send-keys` — mid-work it's a steering message, after finish a new turn
with full context. A stream is reopened first if needed ("Reconnecting to
session…"). If the pane is gone, it falls back to spawning a fresh job with a
note. Only the typing is tmux-specific (`src/inject.ts`); finding the session
is registration-based and generic.

Future idea (deliberately not built): worktree cleanup on job end conflicts
with follow-ups — the kept-alive session is what makes them possible. Cleanest
shape: an explicit "cleanup" follow-up telling the session itself to remove its
worktree and exit.

A job that dies without `finish` gets swept: streams idle > `staleStreamMinutes` are stopped and cleared.

Slack hard-kills a stream ~5:00 after it opens, no matter what is appended
(undocumented; measured — a true keepalive is impossible, even with changing
content), and there is no way to re-stream onto an existing `ts`. Each job
therefore gets ONE progress message: it streams natively while young (full
card UI), is stopped cleanly at age ~3.5–4.5 min, and is edited in place via
`chat.update` from then on (works on stopped streamed messages — measured).
Conversion keeps the NATIVE cards: `task_card` is a real Block Kit block
(changelog 2026-02-11), accepted by `chat.update` even on a stopped stream
(measured) — the message re-renders from the replay log with identical card
UI. No splits, no dup cards, no pings, no visual downgrade. The final report
is the only other message — posted on `finish(markdown)`, one notification,
exactly when you want it.

Block-form quirks vs the chunk form (measured): `task_card` blocks REQUIRE
`status` and reject `"pending"` (enum `in_progress|complete|error`) — pending
steps simply aren't rendered yet; the `plan` block's `title` must be a plain
string, not a `plain_text` object.

API gotchas (measured): `chat.stopStream` with `markdown_text` only works on a
stream with NO chunks appended — `streaming_mode_mismatch` otherwise (the
report is delivered as a chunkless stream + markdown-stop for the native
agent look). Frozen `in_progress` cards render with a ⚠️ — finish completes
them before its plain stop.

## Job-side skill

Don't make each job improvise the streaming protocol — give your agent a skill
(e.g. `~/.claude/skills/slack-ta/`) that owns it. The launch command passes the
correlation token inside the prompt (`/slack-ta [threadTs:…] <task>`); the skill
should: extract `threadTs` and pass it to every `slack-stream` MCP call, open a
`thinking_step` immediately, update the checklist at real milestones only,
`append_text` for the final summary, and ALWAYS `finish` — also on failure. Two
error rules worth copying: if the token is missing, do the work but skip
streaming; if a call errors with "no live stream", the stream was swept —
continue the work, stop streaming.

`GET /healthz` lists active streams.

## Build your own

Want the same thing but different? The architecture is small enough to rebuild
in an afternoon — here's the TL;DR to hand your agent (or read yourself).

**The shape.** One long-lived local process with three roles:

1. **Listener** — Slack Socket Mode (`@slack/bolt`), subscribed to
   `app_mention`. On mention: open the progress message instantly (so the user
   sees life before any job boots), then spawn the job however you like.
2. **Bridge** — a local HTTP MCP server (`@modelcontextprotocol/sdk`,
   stateless transport). The job's agent calls 5 tools: `register_job`,
   `thinking_step`, `append_text`, `set_status`, `finish`.
3. **Status** — optional (here: SwiftBar menubar). Any observer works;
   `GET /healthz` is the hook.

**The one design trick**: the job never holds Slack credentials or message
ids. It only knows `threadTs` — a correlation token passed inside its prompt —
and the bridge maps it to the real channel/message and owns the token. Any
runner (tmux, container, CI, SSH) works as long as the token rides along and
the runner can reach `127.0.0.1:8365`.

**The Slack rendering strategy** (the hard-won part — all measured, none
documented; see the section above for detail):

- Native streams (`chat.startStream`) look great but die ~5:00 in, no
  keepalive possible, no re-stream onto the same ts.
- `chat.update` works on stopped streamed messages, edits never ping.
- `task_card` is a real Block Kit block — `chat.update` can render the SAME
  native card UI forever. Quirks: `status` required, `"pending"` rejected,
  `plan.title` must be a plain string.
- ⇒ one message per job: stream while young, convert to edit-in-place at
  ~3.5 min, keep native cards throughout. Final report = separate message =
  the single notification.

**State**: one JSON map `threadTs → {messageTs, mode, replayLog}` snapshotted
to disk — that's what makes bridge restarts invisible to running jobs (replay
log re-renders the whole message). A second file maps `threadTs → session
location` so re-mentions in a thread route INTO the running session (here:
`tmux send-keys`, cwd-verified) instead of spawning a duplicate.

**Reliability floor**: dedupe redelivered Slack events (3s ack window); a
stale sweep for jobs that die without `finish`; every Slack write has a
fallback chain ending in plain `chat.postMessage`.

**Adaptation points** — each is one file here: how jobs launch
(`scripts/launch-job.zsh` — swap for docker/ssh/whatever), how follow-ups
reach a session (`src/inject.ts` — the only tmux-specific code), what the
agent streams (your job-side skill/prompt: milestones as `thinking_step`,
summary in `finish(markdown)`, ALWAYS finish — also on failure).

## SwiftBar

```sh
cp swiftbar/slack-to-laptop.sh ~/Library/Application\ Support/SwiftBar/Plugins/  # or your plugin dir
chmod +x .../slack-to-laptop.sh
```

Streamable plugin: SwiftBar owns the process lifecycle; menubar shows 🛰️ + active
stream count. Don't also run `bun run server.ts` manually (port collision).
Test from a terminal first: `./swiftbar/slack-to-laptop.sh` — you should see
blocks starting with `~~~`. Logs: `~/.cache/slack-to-laptop/server.log`
(written by the server itself — NEVER add a stderr redirect to the plugin
script: closing SwiftBar's stderr pipe makes it spin at 100%+ CPU).

SwiftBar does NOT respawn the process if it dies. To restart the bridge:
`open -g "swiftbar://refreshplugin?name=slack-to-laptop"` (or SwiftBar menu →
plugin → Refresh). If the 🛰️ icon is missing but the process runs, check
`defaults read com.ameba.SwiftBar` for `"NSStatusItem VisibleCC
slack-to-laptop.sh" = 0` and write it back to `-bool true`.
