#!/bin/bash
# <xbar.title>Slack → Laptop</xbar.title>
# <xbar.desc>Slack streaming MCP bridge — menubar status</xbar.desc>
# <swiftbar.type>streamable</swiftbar.type>
# <swiftbar.hideAbout>true</swiftbar.hideAbout>
# <swiftbar.hideRunInTerminal>true</swiftbar.hideRunInTerminal>
# <swiftbar.hideLastUpdated>true</swiftbar.hideLastUpdated>
# <swiftbar.hideSwiftBar>true</swiftbar.hideSwiftBar>

# GUI env has a minimal PATH — absolute paths only. stdout is reserved for the
# streamable blocks; the server writes its own log file (src/log.ts).
# DO NOT redirect stderr here: SwiftBar monitors the stderr pipe, and closing it
# via `2>>file` makes SwiftBar spin at 100%+ CPU on EOF forever.
exec /Users/arnaud/.bun/bin/bun run /Users/arnaud/projects/slack-to-laptop/server.ts --swiftbar
