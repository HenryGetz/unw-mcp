/**
 * Advisory cross-process profile lock.
 *
 * A Chromium persistent profile cannot be opened by two processes. A second MCP
 * instance must fail with a clear message instead of corrupting the first
 * instance's profile or waiting forever. Locks older than `staleMs` are
 * presumed abandoned.
 */
import { mkdir, open, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export const LOCK_WAIT_MS = 15_000;
export const LOCK_STALE_MS = 300_000;

export class LockTimeoutError extends Error {
  readonly code = "profile_locked";
  constructor(
    readonly path: string,
    readonly ageMs: number,
  ) {
    super(
      `browser profile is in use by another unw-mcp process (lock ${path}, ${Math.round(ageMs / 1000)}s old)`,
    );
    this.name = "LockTimeoutError";
  }
}

/** Take an exclusive lock file; returns an idempotent release function. */
export async function acquireFileLock(
  path: string,
  options: { waitMs?: number; staleMs?: number } = {},
): Promise<() => Promise<void>> {
  const waitMs = options.waitMs ?? LOCK_WAIT_MS;
  const staleMs = options.staleMs ?? LOCK_STALE_MS;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      const handle = await open(path, "wx", 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
      await handle.close();
      return async () => {
        await unlink(path).catch(() => undefined);
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const age = await stat(path)
        .then((s) => Date.now() - s.mtimeMs)
        .catch(() => 0);
      if (age > staleMs) {
        await unlink(path).catch(() => undefined);
        continue;
      }
      if (Date.now() > deadline) throw new LockTimeoutError(path, age);
      await delay(200);
    }
  }
}
