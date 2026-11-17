/**
 * In-process TTL cache with single-flight loading.
 *
 * Personalized responses live for minutes; public feeds for hours. Everything
 * stays in memory — no personalized payload is ever written to disk. A failed
 * load is evicted so the next call retries instead of caching the failure.
 */
export interface CacheStats {
  entries: number;
}

export class TtlCache {
  private readonly entries = new Map<string, { expiresAt: number; value: Promise<unknown> }>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  get<T>(key: string, ttlSeconds: number, loader: () => Promise<T>): Promise<T> {
    const now = this.now();
    const existing = this.entries.get(key);
    if (existing && existing.expiresAt > now) return existing.value as Promise<T>;

    let value: Promise<T>;
    try {
      value = loader();
    } catch (error) {
      return Promise.reject(error);
    }
    this.entries.set(key, { expiresAt: now + Math.max(1, ttlSeconds) * 1000, value });
    value.catch(() => {
      if (this.entries.get(key)?.value === value) this.entries.delete(key);
    });
    return value;
  }

  /** Drop one key, or every key starting with `prefix`. */
  invalidate(prefix?: string): void {
    if (prefix === undefined) {
      this.entries.clear();
      return;
    }
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) this.entries.delete(key);
    }
  }

  stats(): CacheStats {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= this.now()) this.entries.delete(key);
    }
    return { entries: this.entries.size };
  }
}
