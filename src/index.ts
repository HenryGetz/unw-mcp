#!/usr/bin/env node
/**
 * stdio entrypoint for unw-mcp.
 *
 * stdout carries MCP frames only; every diagnostic goes to stderr.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createAppContext } from "./tools/context.js";
import { registerTools } from "./tools/registry.js";

export const SERVER_NAME = "unw-mcp";
export const SERVER_VERSION = "0.1.0";

function log(message: string): void {
  process.stderr.write(`${message}\n`);
}

export async function main(): Promise<void> {
  const ctx = createAppContext();
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  const tools = registerTools(server, ctx);
  const transport = new StdioServerTransport();
  await server.connect(transport);

  log(
    `${SERVER_NAME} ${SERVER_VERSION} ready — ${tools.length} tools (${tools.join(", ")}); ` +
      `config ${ctx.cfg.configDir}; tz ${ctx.cfg.timezone}; profile ${ctx.cfg.profileDir}`,
  );

  let closing = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (closing) return;
    closing = true;
    log(`${signal} received, closing ${SERVER_NAME}`);
    try {
      await server.close();
    } catch (error) {
      log(`shutdown error: ${(error as Error).message}`);
      process.exitCode = 1;
    }
    try {
      await ctx.session.dispose();
    } catch (error) {
      log(`dispose error: ${(error as Error).message}`);
    }
  };

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void shutdown(signal).finally(() => process.exit(process.exitCode ?? 0));
    });
  }

  process.stdin.once("end", () => {
    void shutdown("stdin end");
  });
}

main().catch((error: unknown) => {
  log(`fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  process.exit(1);
});
