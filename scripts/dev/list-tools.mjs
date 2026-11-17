#!/usr/bin/env node
/**
 * Smoke test: spawn the built server over stdio, initialize, and print the tool
 * and operation inventory. Fails loudly if the handshake or tools/list breaks.
 *
 *   npm run build && npm run smoke
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/index.js"],
  env: { ...process.env },
  stderr: "inherit",
});

const client = new Client({ name: "unw-mcp-smoke", version: "0.1.0" });

try {
  await client.connect(transport);
  const info = client.getServerVersion();
  console.log(`initialized: ${info?.name} ${info?.version}`);

  const { tools } = await client.listTools();
  console.log(`tools: ${tools.length}`);
  for (const tool of tools) {
    const ops = tool.inputSchema?.properties?.op?.enum ?? [];
    console.log(`  - ${tool.name}: op=[${ops.join(", ")}]`);
  }

  // Schema rejection proves the server validates before any browser starts.
  for (const name of [
    "unw_dashboard",
    "unw_academics",
    "unw_finances",
    "unw_dining",
    "unw_calendar",
    "unw_pages",
  ]) {
    const missingOp = await client.callTool({ name, arguments: {} });
    console.log(`${name} without op -> isError=${missingOp.isError ?? false}`);
  }

  const badOp = await client.callTool({ name: "unw_dashboard", arguments: { op: "nope" } });
  console.log(`unw_dashboard unknown op -> isError=${badOp.isError ?? false}`);
} finally {
  await client.close();
}
