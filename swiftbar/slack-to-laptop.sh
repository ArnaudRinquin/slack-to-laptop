#!/bin/bash
# <xbar.title>Slack → Laptop</xbar.title>
# <xbar.desc>Slack streaming MCP bridge — menubar status</xbar.desc>
# <swiftbar.type>streamable</swiftbar.type>
# <swiftbar.hideAbout>true</swiftbar.hideAbout>
# <swiftbar.hideRunInTerminal>true</swiftbar.hideRunInTerminal>
# <swiftbar.hideLastUpdated>true</swiftbar.hideLastUpdated>
# <swiftbar.hideSwiftBar>true</swiftbar.hideSwiftBar>

# GUI env has a minimal PATH — absolute paths only. Logs (stderr) go to a file;
# stdout is reserved for the streamable blocks.
mkdir -p "$HOME/.cache/slack-to-laptop"
exec /Users/arnaud/.bun/bin/bun run /Users/arnaud/projects/slack-to-laptop/server.ts --swiftbar \
  2>>"$HOME/.cache/slack-to-laptop/server.log"
