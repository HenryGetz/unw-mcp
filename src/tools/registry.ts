/**
 * Tool registry: the entire model-facing surface.
 *
 * Seven tools, each op-dispatched so schema tokens stay small:
 *   unw_session    status, reauth
 *   unw_dashboard  overview, announcements, tasks, events, quick_links
 *   unw_academics  profile, today, schedule, grades, gpa, holds, registration, degree_audit
 *   unw_finances   balances, financial_aid, chapel
 *   unw_dining     locations, today, week
 *   unw_calendar   academic, breaks, deadlines, events
 *   unw_pages      search, get
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { sessionTool } from "./session.js";
import { dashboardTool } from "./dashboard.js";
import { academicsTool } from "./academics.js";
import { financesTool } from "./finances.js";
import { diningTool } from "./dining.js";
import { calendarTool } from "./calendar.js";
import { pagesTool } from "./pages.js";
import type { AppContext } from "./context.js";
import type { ToolModule } from "./shared.js";

export type ToolBuilder = (ctx: AppContext) => ToolModule;

export const TOOL_BUILDERS: readonly ToolBuilder[] = [
  sessionTool,
  dashboardTool,
  academicsTool,
  financesTool,
  diningTool,
  calendarTool,
  pagesTool,
];

export function buildTools(ctx: AppContext): ToolModule[] {
  return TOOL_BUILDERS.map((build) => build(ctx));
}

/** Register every tool on a server. Returns the registered names. */
export function registerTools(server: McpServer, ctx: AppContext): string[] {
  const modules = buildTools(ctx);
  for (const module of modules) {
    server.registerTool(
      module.name,
      {
        title: module.title,
        description: module.description,
        inputSchema: module.shape,
      },
      async (args): Promise<CallToolResult> => module.handle(args as Record<string, unknown>),
    );
  }
  return modules.map((module) => module.name);
}
