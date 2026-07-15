import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { Registry } from "./registry";
import type { StreamOps } from "./streams";
import { log } from "./log";

const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });
const fail = (err: unknown) => ({
  isError: true as const,
  content: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }],
});

function buildServer(ops: StreamOps): McpServer {
  const server = new McpServer({ name: "slack-stream", version: "0.1.0" });

  server.registerTool(
    "thinking_step",
    {
      description:
        "Add or update a task card in the Slack thinking checklist. Reuse the same id (or title) to update a step's status.",
      inputSchema: {
        threadTs: z.string().describe("The thread token you were handed at launch (SLACK_THREAD_TS)"),
        title: z.string().describe("Short step title shown on the card"),
        status: z.enum(["pending", "in_progress", "complete", "error"]),
        id: z.string().optional().describe("Stable step id; defaults to a slug of the title"),
        details: z.string().optional().describe("Optional detail line under the title"),
      },
    },
    async ({ threadTs, title, status, id, details }) => {
      try {
        await ops.thinkingStep(threadTs, { id: id ?? slug(title), title, status, details });
        return ok(`step "${title}" → ${status}`);
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "append_text",
    {
      description: "Stream markdown prose into the Slack response message.",
      inputSchema: {
        threadTs: z.string().describe("The thread token you were handed at launch (SLACK_THREAD_TS)"),
        markdown: z.string().describe("Markdown to append"),
      },
    },
    async ({ threadTs, markdown }) => {
      try {
        await ops.appendText(threadTs, markdown);
        return ok("appended");
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "set_status",
    {
      description: 'Set the grey "is …" status line on the thread. Empty string clears it.',
      inputSchema: {
        threadTs: z.string().describe("The thread token you were handed at launch (SLACK_THREAD_TS)"),
        text: z.string().describe('e.g. "running tests" — empty string to clear'),
      },
    },
    async ({ threadTs, text }) => {
      try {
        await ops.setStatus(threadTs, text);
        return ok(text ? `status: ${text}` : "status cleared");
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "finish",
    {
      description:
        "Finalize the Slack stream. Call exactly once, as your last act. Optional markdown is appended as the final block.",
      inputSchema: {
        threadTs: z.string().describe("The thread token you were handed at launch (SLACK_THREAD_TS)"),
        markdown: z.string().optional().describe("Optional final markdown block"),
      },
    },
    async ({ threadTs, markdown }) => {
      try {
        await ops.finish(threadTs, markdown);
        return ok("stream finished");
      } catch (err) {
        return fail(err);
      }
    },
  );

  return server;
}

const slug = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "step";

export function startMcpHttp(port: number, ops: StreamOps, registry: Registry) {
  const app = express();
  app.use(express.json());

  // Stateless transport: fresh server+transport per request, no session bookkeeping.
  // All state lives in the shared registry, keyed by threadTs.
  app.post("/mcp", async (req, res) => {
    const server = buildServer(ops);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      log(`mcp request failed: ${err}`);
      if (!res.headersSent) res.status(500).json({ error: "internal error" });
    }
  });

  const methodNotAllowed = (_req: express.Request, res: express.Response) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed (stateless server)" },
      id: null,
    });
  };
  app.get("/mcp", methodNotAllowed);
  app.delete("/mcp", methodNotAllowed);

  app.get("/healthz", (_req, res) => {
    res.json({
      ok: true,
      activeStreams: registry.values().map((e) => ({
        threadTs: e.threadTs,
        channel: e.channel,
        prompt: e.prompt.slice(0, 80),
        ageSeconds: Math.round((Date.now() - e.startedAt) / 1000),
      })),
    });
  });

  return app.listen(port, "127.0.0.1", () => {
    log(`MCP listening on http://127.0.0.1:${port}/mcp`);
  });
}
