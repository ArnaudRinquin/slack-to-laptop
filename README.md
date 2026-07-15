# slack-to-laptop

One long-lived local process, three hats: Slack `@mention` listener (Socket Mode),
remote HTTP MCP server that Claude Code worktree jobs call to drive the native
Slack stream, and SwiftBar menubar status.

`threadTs` is the correlation key: the worktree job only ever knows `threadTs`;
this process maps it to the real Slack stream id in memory.

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

Example: `"jobCommand": "cd ~/projects/teetsh && g wtc \"slack-$SLACK_EVENT_TS\" --no-linear \"/go slack-ta $SLACK_PROMPT\""`

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

`GET /healthz` lists active streams.

## SwiftBar

```sh
cp swiftbar/slack-to-laptop.sh ~/Library/Application\ Support/SwiftBar/Plugins/  # or your plugin dir
chmod +x .../slack-to-laptop.sh
```

Streamable plugin: SwiftBar owns the process lifecycle; menubar shows 🛰️ + active
stream count. Don't also run `bun run server.ts` manually (port collision).
Test from a terminal first: `./swiftbar/slack-to-laptop.sh` — you should see
blocks separated by `~~~`. Logs: `~/.cache/slack-to-laptop/server.log`.
