/**
 * Credentials discovery.
 *
 * Priority:
 *   1. ${UNW_MCP_CONFIG_DIR:-~/.config/unw-mcp}/credentials.json
 *   2. ~/.config/teams-mcp/credentials.json   (shared Microsoft identity; read-only)
 *
 * Secrets never enter the repository. A credentials file that is group/world
 * readable is rejected rather than silently trusted.
 */
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { configDir } from "../config.js";

export interface Credentials {
  username: string;
  password: string;
  totpSecret: string;
}

export class CredentialsError extends Error {
  readonly code = "credentials_missing";
  constructor(
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = "CredentialsError";
  }
}

export function credentialCandidates(): string[] {
  return [
    join(configDir(), "credentials.json"),
    join(homedir(), ".config", "teams-mcp", "credentials.json"),
  ];
}

/** Read and validate the first credentials file that exists. */
export function readCredentials(candidates = credentialCandidates()): Credentials {
  const file = candidates.find((candidate) => {
    try {
      statSync(candidate);
      return true;
    } catch {
      return false;
    }
  });
  if (!file) {
    throw new CredentialsError(
      "no credentials file found for interactive sign-in",
      `looked for ${candidates.join(", ")}; warm-profile re-auth needs none`,
    );
  }
  const mode = statSync(file).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new CredentialsError(
      `${file} is readable by group/others (mode ${mode.toString(8)})`,
      `chmod 600 ${file}`,
    );
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch (error) {
    throw new CredentialsError(`cannot parse ${file}: ${(error as Error).message}`);
  }
  const username = typeof parsed.username === "string" ? parsed.username : undefined;
  const password = typeof parsed.password === "string" ? parsed.password : undefined;
  const totpSecret =
    typeof parsed.totpSecret === "string"
      ? parsed.totpSecret
      : typeof parsed.totp_secret === "string"
        ? parsed.totp_secret
        : undefined;
  if (!username) throw new CredentialsError(`${file} is missing "username"`);
  if (!password) throw new CredentialsError(`${file} is missing "password"`);
  if (!totpSecret) throw new CredentialsError(`${file} is missing "totpSecret"`);
  return { username, password, totpSecret };
}
