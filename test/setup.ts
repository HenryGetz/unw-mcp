/**
 * Test isolation defaults.
 *
 * Never touch the operator's real ~/.config/unw-mcp or ~/.cache/unw-mcp:
 * every worker gets private directories. No browser is launched by unit tests.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.UNW_MCP_CONFIG_DIR ??= mkdtempSync(join(tmpdir(), "unw-mcp-test-config-"));
process.env.UNW_MCP_CACHE_DIR ??= mkdtempSync(join(tmpdir(), "unw-mcp-test-cache-"));
process.env.UNW_MCP_TIMEZONE ??= "America/Chicago";
process.env.UNW_MCP_HEADLESS ??= "1";
