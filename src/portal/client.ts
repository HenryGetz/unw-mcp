/**
 * Typed portal client.
 *
 * All authenticated reads go through one PortalSession, which owns the mutex,
 * re-auth and profile lifecycle. Origins are fixed: the model never supplies a
 * URL, and a relative path cannot escape the two API origins.
 */
import type { ResolvedConfig } from "../config.js";
import { PortalSession } from "../auth/session.js";

export interface PortalReader {
  getPortalJson<T>(pathOrUrl: string): Promise<T>;
  getFlowJson<T>(pathOrUrl: string): Promise<T>;
}

export class PortalClient implements PortalReader {
  constructor(
    private readonly session: PortalSession,
    private readonly cfg: ResolvedConfig,
  ) {}

  getPortalJson<T>(pathOrUrl: string): Promise<T> {
    return this.session.getJson<T>(this.resolve(pathOrUrl, this.cfg.portalOrigin));
  }

  getFlowJson<T>(pathOrUrl: string): Promise<T> {
    return this.session.getJson<T>(this.resolve(pathOrUrl, this.cfg.flowOrigin));
  }

  private resolve(pathOrUrl: string, base: string): string {
    let url: URL;
    try {
      url = new URL(pathOrUrl, base);
    } catch {
      throw new Error(`invalid portal path: ${pathOrUrl}`);
    }
    if (url.origin !== new URL(base).origin) {
      throw new Error(`refusing cross-origin portal request to ${url.origin}`);
    }
    return url.toString();
  }
}
