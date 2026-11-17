/**
 * Shared application context: configuration, session, portal reader and cache.
 *
 * Tools receive this object rather than importing singletons, so every test can
 * substitute a fake portal and a private cache.
 */
import { config, type ResolvedConfig } from "../config.js";
import { PortalSession, type SessionStatus } from "../auth/session.js";
import { PortalClient, type PortalReader } from "../portal/client.js";
import { BannerClient, type BannerReader } from "../banner/client.js";
import type { FetchLike } from "../portal/dining.js";
import { TtlCache } from "../cache.js";

export interface SessionApi {
  status(): Promise<SessionStatus>;
  reauth(): Promise<SessionStatus>;
  dispose(): Promise<void>;
}

export interface AppContext {
  cfg: ResolvedConfig;
  session: SessionApi;
  portal: PortalReader;
  banner: BannerReader;
  cache: TtlCache;
  now: () => Date;
  /** Plain GET transport for public feeds (dining, ICS); no cookies sent. */
  fetch: FetchLike;
}

export interface AppContextOptions {
  cfg?: ResolvedConfig;
  session?: SessionApi;
  portal?: PortalReader;
  banner?: BannerReader;
  cache?: TtlCache;
  now?: () => Date;
  fetch?: FetchLike;
}

export function createAppContext(options: AppContextOptions = {}): AppContext {
  const cfg = options.cfg ?? config();
  const session = options.session ?? new PortalSession({ config: cfg });
  const portal = options.portal ?? new PortalClient(session as PortalSession, cfg);
  const banner = options.banner ?? new BannerClient(session as PortalSession, cfg);
  return {
    cfg,
    session,
    portal,
    banner,
    cache: options.cache ?? new TtlCache(),
    now: options.now ?? (() => new Date()),
    fetch: options.fetch ?? ((input, init) => globalThis.fetch(input, init)),
  };
}
