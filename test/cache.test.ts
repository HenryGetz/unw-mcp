import { describe, expect, it } from "vitest";
import { TtlCache } from "../src/cache.js";

describe("TtlCache", () => {
  it("loads once inside the TTL and again after it expires", async () => {
    let now = 0;
    let calls = 0;
    const cache = new TtlCache(() => now);
    const loader = async (): Promise<string> => {
      calls += 1;
      return `v${calls}`;
    };
    expect(await cache.get("k", 10, loader)).toBe("v1");
    now = 5_000;
    expect(await cache.get("k", 10, loader)).toBe("v1");
    now = 10_001;
    expect(await cache.get("k", 10, loader)).toBe("v2");
    expect(calls).toBe(2);
  });

  it("single-flights concurrent misses", async () => {
    let calls = 0;
    let release!: (value: string) => void;
    const cache = new TtlCache();
    const pending = cache.get("k", 10, () => {
      calls += 1;
      return new Promise<string>((resolve) => {
        release = resolve;
      });
    });
    const second = cache.get("k", 10, async () => {
      calls += 1;
      return "other";
    });
    release("first");
    expect(await pending).toBe("first");
    expect(await second).toBe("first");
    expect(calls).toBe(1);
  });

  it("does not cache a rejected load", async () => {
    let calls = 0;
    const cache = new TtlCache();
    const loader = async (): Promise<string> => {
      calls += 1;
      if (calls === 1) throw new Error("boom");
      return "ok";
    };
    await expect(cache.get("k", 10, loader)).rejects.toThrow("boom");
    expect(await cache.get("k", 10, loader)).toBe("ok");
    expect(calls).toBe(2);
  });

  it("invalidates by exact key or prefix", async () => {
    const cache = new TtlCache();
    let calls = 0;
    const loader = async (): Promise<number> => {
      calls += 1;
      return calls;
    };
    await cache.get("events:1", 60, loader);
    await cache.get("events:2", 60, loader);
    await cache.get("profile", 60, loader);
    cache.invalidate("events:");
    expect(cache.stats().entries).toBe(1);
    await cache.get("events:1", 60, loader);
    expect(calls).toBe(4);
    cache.invalidate();
    expect(cache.stats().entries).toBe(0);
  });
});
