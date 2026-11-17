/**
 * `unw_session`: prove whether the portal session is alive and force a
 * re-authentication when it is not.
 *
 * Read-only: re-auth navigates the SAML flow; it never changes portal data.
 */
import { z } from "zod";
import { opOf, textResult, toolError, unknownOp, type ToolModule } from "./shared.js";
import type { AppContext } from "./context.js";

const OPS = ["status", "reauth"] as const;

export function sessionTool(ctx: AppContext): ToolModule {
  return {
    name: "unw_session",
    title: "myUNW session",
    description:
      "Check the myUNW portal session or force re-authentication. status probes the live API and reports cookie lifetimes; reauth reloads the persistent browser profile (silent SAML ~10s, then credentials+TOTP if Entra expired). No portal data is modified.",
    shape: {
      op: z
        .enum(OPS)
        .describe("status: live probe + cookie lifetimes; reauth: restore the session, then report"),
    },
    async handle(args) {
      const op = opOf(args, OPS);
      if (!op) return unknownOp("unw_session", typeof args.op === "string" ? args.op : "", OPS);
      try {
        const status = op === "reauth" ? await ctx.session.reauth() : await ctx.session.status();
        return textResult(status);
      } catch (error) {
        const mapped = toolError(error);
        if (mapped) return mapped;
        throw error;
      }
    },
  };
}
