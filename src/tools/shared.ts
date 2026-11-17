/**
 * Shared plumbing for op-dispatched tools: result envelopes, argument readers
 * and one error mapping. Every unknown op is an error result so an agent can
 * never mistake it for data.
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ZodType } from "zod";
import { errorText, toJsonText } from "../format.js";
import {
  AppSessionExpiredError,
  AuthRequiredError,
  PortalUnavailableError,
} from "../auth/session.js";
import { CredentialsError } from "../auth/credentials.js";
import { LockTimeoutError } from "../auth/lock.js";
import { ConfigError } from "../config.js";
import { redactText } from "../auth/redact.js";

export interface ToolModule {
  name: string;
  title: string;
  description: string;
  /** Flat argument shape shared by every op, keeping schema tokens low. */
  shape: Record<string, ZodType>;
  handle(args: Record<string, unknown>): Promise<CallToolResult>;
}

export function textResult(value: unknown, space = 0): CallToolResult {
  return { content: [{ type: "text", text: toJsonText(value, space) }] };
}

export function errorResult(code: string, message: string, hint?: string): CallToolResult {
  return { content: [{ type: "text", text: errorText(code, message, hint) }], isError: true };
}

export function unknownOp(tool: string, op: string, ops: readonly string[]): CallToolResult {
  return errorResult(
    "invalid_argument",
    op ? `unknown op "${op}" for ${tool}` : `${tool} requires op`,
    `available ops: ${ops.join(", ")}`,
  );
}

export function opOf(args: Record<string, unknown>, ops: readonly string[]): string {
  const op = typeof args.op === "string" ? args.op : "";
  return ops.includes(op) ? op : "";
}

export function stringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

export function numberArg(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function booleanArg(args: Record<string, unknown>, key: string): boolean | undefined {
  const value = args[key];
  return typeof value === "boolean" ? value : undefined;
}

/** A count clamped to [min, max]; schema validation is not the only guard. */
export function pageSize(
  args: Record<string, unknown>,
  key: string,
  fallback: number,
  max: number,
  min = 1,
): number {
  const value = numberArg(args, key);
  return value === undefined ? fallback : Math.min(Math.max(min, Math.trunc(value)), max);
}

/** Map known failures onto tool errors; unknown errors bubble to the runtime. */
export function toolError(error: unknown): CallToolResult | undefined {
  if (error instanceof AuthRequiredError) {
    return errorResult(error.code, redactText(error.message), error.hint);
  }
  if (error instanceof PortalUnavailableError) {
    return errorResult(error.code, redactText(error.message), error.hint);
  }
  if (error instanceof AppSessionExpiredError) {
    return errorResult(
      "auth_required",
      "Banner app session is not authenticated",
      "run unw_session op=reauth, then retry",
    );
  }
  if (error instanceof CredentialsError) {
    return errorResult(error.code, redactText(error.message), error.hint);
  }
  if (error instanceof ConfigError) {
    return errorResult(error.code, redactText(error.message), "check config.yaml / environment overrides");
  }
  if (error instanceof LockTimeoutError) {
    return errorResult(error.code, redactText(error.message), "close the other unw-mcp process or remove a stale lock");
  }
  return undefined;
}
