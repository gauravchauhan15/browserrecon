/**
 * The shared token bucket — build plan §8.3, §8.5 rules 2 and 4;
 * dev plan BR-M1-18.
 *
 * ## One bucket, or the limit is a fiction
 *
 * §8.5 rule 2 exists because the obvious design is wrong. Katana has its own
 * rate flag, the Explorer paces its own navigations, and JS mining fetches
 * bundles — three components each politely staying under 5 requests per
 * second, and a target receiving 15. The user asked for 5.
 *
 * So there is one bucket per origin, shared by every request-generating
 * component, and a component that does not take a token is a bug rather than
 * a fast path. `acquire` is async precisely so that nothing can proceed
 * without waiting its turn.
 *
 * ## Burst is deliberate, and bounded
 *
 * A single page load is a burst: the document, then twenty subresources, all
 * at once. Forcing those through at a steady 5/s would make every page take
 * four seconds and would not resemble a browser. So the bucket has capacity
 * above its refill rate — the burst is absorbed, and the *sustained* average
 * still converges on the configured rate, which is what a target actually
 * feels.
 */

export interface BucketOptions {
  /** Sustained rate. The number the user configured. */
  readonly refillPerSecond: number;
  /**
   * Tokens available at once.
   *
   * Defaults to one second's worth plus a page's typical subresource count,
   * which absorbs a page load without letting the sustained average drift.
   */
  readonly capacity?: number | undefined;
  /** Injected so the tests are not real-time. */
  readonly now?: (() => number) | undefined;
  /** Injected for the same reason; must resolve after roughly `ms`. */
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
}

export interface BucketStats {
  readonly granted: number;
  /** Total milliseconds callers spent waiting. A cost worth surfacing. */
  readonly waitedMs: number;
  readonly available: number;
  readonly refillPerSecond: number;
}

export interface TokenBucket {
  /** Wait until a token is available, then take it. */
  acquire(): Promise<void>;
  /** Change the sustained rate. Used by the adaptive controller. */
  setRate(perSecond: number): void;
  readonly stats: BucketStats;
}

const DEFAULT_BURST_ALLOWANCE = 20;

export function createTokenBucket(options: BucketOptions): TokenBucket {
  const now = options.now ?? ((): number => Date.now());
  const sleep =
    options.sleep ?? ((ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms)));

  let rate = Math.max(0.01, options.refillPerSecond);
  let capacity = options.capacity ?? Math.max(1, rate + DEFAULT_BURST_ALLOWANCE);
  let tokens = capacity;
  let last = now();
  let granted = 0;
  let waitedMs = 0;

  /**
   * A promise chain, so concurrent callers queue instead of racing.
   *
   * Without it, ten callers all see the same token count, all decide there
   * is room, and all proceed — which is exactly the failure the whole file
   * exists to prevent, and it only appears under concurrency.
   */
  let queue: Promise<void> = Promise.resolve();

  const refill = (): void => {
    const current = now();
    const elapsed = Math.max(0, current - last);
    last = current;
    tokens = Math.min(capacity, tokens + (elapsed / 1000) * rate);
  };

  const take = async (): Promise<void> => {
    refill();
    if (tokens >= 1) {
      tokens -= 1;
      granted += 1;
      return;
    }

    const deficit = 1 - tokens;
    const waitMs = Math.ceil((deficit / rate) * 1000);
    waitedMs += waitMs;
    await sleep(waitMs);
    refill();
    // Taken unconditionally after the wait: the sleep was calculated to
    // cover the deficit, and re-checking could spin forever if the clock
    // moved less than expected.
    tokens = Math.max(0, tokens - 1);
    granted += 1;
  };

  return {
    acquire() {
      const turn = queue.then(take);
      // The chain must not break on a rejected acquire, or every later
      // caller inherits the rejection and the scan stops being rate-limited
      // at all — it stops entirely.
      queue = turn.then(
        () => undefined,
        () => undefined,
      );
      return turn;
    },

    setRate(perSecond) {
      refill();
      rate = Math.max(0.01, perSecond);
      capacity = options.capacity ?? Math.max(1, rate + DEFAULT_BURST_ALLOWANCE);
      tokens = Math.min(tokens, capacity);
    },

    get stats(): BucketStats {
      return { granted, waitedMs, available: tokens, refillPerSecond: rate };
    },
  };
}

/**
 * One bucket per origin, for the whole scan.
 *
 * §8.5 rule 4: the budget is scan-wide, so every component asks the same
 * registry rather than making its own. A component holding a private bucket
 * is the bug this type exists to make awkward.
 */
export interface BucketRegistry {
  /** The bucket for an origin, created on first use. */
  for(origin: string): TokenBucket;
  /** Every origin seen, with its stats. Sorted for reproducible output. */
  snapshot(): readonly (BucketStats & { readonly origin: string })[];
  /** Apply a rate to every origin — used when backoff is global. */
  setRateEverywhere(perSecond: number): void;
}

export function createBucketRegistry(
  defaults: Omit<BucketOptions, "refillPerSecond"> & { readonly refillPerSecond: number },
): BucketRegistry {
  const buckets = new Map<string, TokenBucket>();

  return {
    for(origin) {
      const existing = buckets.get(origin);
      if (existing !== undefined) return existing;
      const created = createTokenBucket(defaults);
      buckets.set(origin, created);
      return created;
    },
    snapshot() {
      return [...buckets.entries()]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([origin, bucket]) => ({ origin, ...bucket.stats }));
    },
    setRateEverywhere(perSecond) {
      for (const bucket of buckets.values()) bucket.setRate(perSecond);
    },
  };
}
