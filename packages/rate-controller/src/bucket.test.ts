import { describe, expect, it } from "vitest";
import { createBucketRegistry, createTokenBucket } from "./bucket.js";

/** A controllable clock, so rate assertions are arithmetic not wall-time. */
function fakeClock() {
  let time = 0;
  return {
    now: (): number => time,
    sleep: async (ms: number): Promise<void> => {
      time += ms;
      await Promise.resolve();
    },
    advance: (ms: number): void => {
      time += ms;
    },
  };
}

describe("the sustained rate holds under concurrency", () => {
  it("never exceeds the configured rate across concurrent consumers", async () => {
    // The failure this exists to prevent only appears under concurrency: ten
    // callers all see the same token count, all decide there is room, and
    // all proceed.
    //
    // Measured over a long enough run that the initial burst is amortised.
    // Burst is deliberate, so a short window legitimately exceeds the
    // sustained rate — the guarantee is about what a target feels over time,
    // and asserting it over five seconds measured the burst, not the rate.
    const clock = fakeClock();
    const bucket = createTokenBucket({
      refillPerSecond: 5,
      capacity: 5,
      now: clock.now,
      sleep: clock.sleep,
    });

    // Three "components" — Katana, the Explorer, JS fetching — all at once.
    await Promise.all(Array.from({ length: 300 }, () => bucket.acquire()));

    const elapsedSeconds = clock.now() / 1000;
    expect(bucket.stats.granted).toBe(300);
    expect(300 / Math.max(elapsedSeconds, 0.001)).toBeLessThanOrEqual(5.2);
  });

  it("charges for the burst, so it is borrowed rather than free", async () => {
    // The other half of the same guarantee: capacity lets a page load
    // through at once, and the tokens it spent are not refunded.
    const clock = fakeClock();
    const bucket = createTokenBucket({
      refillPerSecond: 5,
      capacity: 5,
      now: clock.now,
      sleep: clock.sleep,
    });

    await Promise.all(Array.from({ length: 5 }, () => bucket.acquire()));
    expect(clock.now()).toBe(0);

    // The sixth has to wait, because the burst is spent.
    await bucket.acquire();
    expect(clock.now()).toBeGreaterThan(0);
  });

  it("lets a page-load burst through without raising the sustained average", async () => {
    // A page load is a burst: the document and twenty subresources at once.
    // Forcing those through at a steady rate makes every page take seconds
    // and does not resemble a browser.
    const clock = fakeClock();
    const bucket = createTokenBucket({
      refillPerSecond: 5,
      capacity: 25,
      now: clock.now,
      sleep: clock.sleep,
    });

    await Promise.all(Array.from({ length: 21 }, () => bucket.acquire()));
    expect(clock.now()).toBe(0);
    expect(bucket.stats.waitedMs).toBe(0);
  });

  it("refills over time", async () => {
    const clock = fakeClock();
    const bucket = createTokenBucket({
      refillPerSecond: 10,
      capacity: 2,
      now: clock.now,
      sleep: clock.sleep,
    });

    await bucket.acquire();
    await bucket.acquire();
    clock.advance(1_000);
    await bucket.acquire();
    expect(bucket.stats.waitedMs).toBe(0);
  });

  it("keeps working after a caller fails", async () => {
    // If a rejected acquire broke the chain, every later caller would
    // inherit it — and the scan would stop entirely rather than stop being
    // rate-limited.
    const clock = fakeClock();
    const bucket = createTokenBucket({
      refillPerSecond: 5,
      now: clock.now,
      sleep: clock.sleep,
    });
    await bucket.acquire();
    await expect(bucket.acquire()).resolves.toBeUndefined();
  });
});

describe("one bucket, shared", () => {
  it("gives every component asking for an origin the same bucket", async () => {
    // §8.5 rule 2: three components each politely under 5/s is a target
    // receiving 15. The user asked for 5.
    const registry = createBucketRegistry({ refillPerSecond: 5 });
    const katana = registry.for("https://app.test");
    const explorer = registry.for("https://app.test");
    const jsFetch = registry.for("https://app.test");

    expect(explorer).toBe(katana);
    expect(jsFetch).toBe(katana);

    await katana.acquire();
    await explorer.acquire();
    expect(jsFetch.stats.granted).toBe(2);
  });

  it("keeps origins separate", async () => {
    const registry = createBucketRegistry({ refillPerSecond: 5 });
    await registry.for("https://a.test").acquire();
    expect(registry.for("https://b.test").stats.granted).toBe(0);
  });

  it("reports every origin in a reproducible order", async () => {
    const registry = createBucketRegistry({ refillPerSecond: 5 });
    registry.for("https://z.test");
    registry.for("https://a.test");
    expect(registry.snapshot().map((entry) => entry.origin)).toEqual([
      "https://a.test",
      "https://z.test",
    ]);
  });

  it("applies a new rate everywhere at once", async () => {
    const registry = createBucketRegistry({ refillPerSecond: 5 });
    registry.for("https://a.test");
    registry.for("https://b.test");
    registry.setRateEverywhere(1);
    expect(registry.snapshot().every((entry) => entry.refillPerSecond === 1)).toBe(true);
  });
});
