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

- `thinking_step({threadTs, title, status, id?, details?})` — task card; `status ∈ pending|in_progress|complete|error`; same `id`/title updates the card
- `append_text({threadTs, markdown})` — stream prose
- `set_status({threadTs, text})` — grey "is …" line; `""` clears
- `finish({threadTs, markdown?})` — final block + close stream. Call exactly once, last.

A job that dies without `finish` gets swept: streams idle > `staleStreamMinutes` are stopped and cleared.

Slack hard-kills a stream ~5:00 after it opens, no matter what is appended
(undocumented; measured — a true keepalive is impossible, even with changing
content). Jobs therefore stream in *segments*: each streamed message is closed
cleanly at age ~3.5–4.5 min with a "_⏳ still working…_" sign-off (no kill
warning), and the next segment is opened lazily — only when the job next has
content. Every message is a finished chapter; quiet stretches create nothing;
nothing is ever deleted or edited away. The final summary gets its own
immediately-closed native segment when needed.

API gotcha (measured): `chat.stopStream` with `markdown_text` only works on a
stream with NO chunks appended — `streaming_mode_mismatch` otherwise. Closers
and finals must go through `chat.appendStream`, then a plain stop.

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
