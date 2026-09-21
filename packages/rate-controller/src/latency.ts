/**
 * Proactive latency throttling — build plan §8.1, §8.2, §8.3;
 * dev plan BR-M1-20.
 *
 * ## The case hard failures miss entirely
 *
 * §8.1 is explicit: hard signals — 429, 5xx, timeouts — are necessary and
 * not sufficient. Most ordinary websites have no rate limiting configured at
 * all. Under load they do not return an error; they simply get slower, and
 * slower, until they fall over. By the time a 5xx arrives the damage is
 * done.
 *
 * So the controller watches latency *trend* and slows down on rising
 * response times with a completely clean error record. That is the core
 * requirement of this file, and the test for it uses a synthetic series with
 * zero non-2xx responses.
 *
 * ## Only healthy responses may lower the delay
 *
 * Borrowed from Scrapy's AutoThrottle, and for the same reason: a 500 often
 * comes back *fast*, because the server gave up early. Letting it inform the
 * delay downwards means the scan speeds up precisely as the target starts
 * failing.
 */

export type RateProfile = "polite" | "normal" | "aggressive";

export interface ProfileSettings {
  readonly requestsPerSecond: number;
  readonly targetConcurrency: number;
  readonly minDelayMs: number;
  readonly maxDelayMs: number;
  /** Fraction of the target rate to start at, before ramping. */
  readonly slowStartFraction: number;
}

/**
 * The three profiles.
 *
 * Coherent by construction (§7.2): each one's rate, concurrency and delay
 * floor agree with each other, so no combination produces the arithmetic the
 * build plan shipped once — a page budget unreachable by seventy times.
 */
export const RATE_PROFILES: Readonly<Record<RateProfile, ProfileSettings>> = {
  polite: {
    requestsPerSecond: 2,
    targetConcurrency: 1,
    minDelayMs: 500,
    maxDelayMs: 30_000,
    slowStartFraction: 0.25,
  },
  normal: {
    requestsPerSecond: 5,
    targetConcurrency: 2,
    minDelayMs: 100,
    maxDelayMs: 20_000,
    slowStartFraction: 0.5,
  },
  aggressive: {
    // Requires explicit acknowledgment at the authorization gate (BR-M0-07).
    // A tool that lets someone hammer a production site by typing one word
    // has made that their accident rather than their decision.
    requestsPerSecond: 20,
    targetConcurrency: 8,
    minDelayMs: 0,
    maxDelayMs: 10_000,
    slowStartFraction: 0.5,
  },
};

export interface ThrottleState {
  /** Delay the controller currently wants between requests. */
  readonly delayMs: number;
  /** Exponentially smoothed latency for this origin. */
  readonly smoothedLatencyMs: number;
  /** Whether the slow-start ramp is still in effect. */
  readonly slowStarting: boolean;
  readonly samples: number;
  /** Effective requests per second implied by the current delay. */
  readonly effectiveRate: number;
}

export interface ThrottleOptions {
  readonly profile?: RateProfile | undefined;
  /**
   * `robots.txt` Crawl-delay, in seconds.
   *
   * Raises the floor and never lowers it: a site asking for 10 seconds gets
   * 10 even under `aggressive`, because that request is the operator's and
   * the profile is only ours.
   */
  readonly crawlDelaySeconds?: number | undefined;
  /** Smoothing factor. Lower reacts slower and is less jumpy. */
  readonly smoothing?: number | undefined;
  /** Requests at reduced rate before the ramp completes. */
  readonly slowStartRequests?: number | undefined;
}

export interface LatencyThrottle {
  /** Feed one response. `ok` means a 2xx or 3xx. */
  observe(latencyMs: number, ok: boolean): ThrottleState;
  readonly state: ThrottleState;
  readonly floorMs: number;
}

export function createLatencyThrottle(options: ThrottleOptions = {}): LatencyThrottle {
  const profile = RATE_PROFILES[options.profile ?? "normal"];
  const smoothing = options.smoothing ?? 0.3;
  const slowStartRequests = options.slowStartRequests ?? 10;

  // Crawl-delay raises the floor, never lowers it.
  const floorMs = Math.max(profile.minDelayMs, (options.crawlDelaySeconds ?? 0) * 1000);
  const baseDelay = Math.max(floorMs, 1000 / profile.requestsPerSecond);

  let smoothed = 0;
  let samples = 0;
  // Starts slow and ramps only while healthy (§8.2). A scan that opens at
  // full rate has already delivered its worst burst before it has any
  // evidence about how the target copes.
  let delay = Math.min(
    profile.maxDelayMs,
    baseDelay / Math.max(0.01, profile.slowStartFraction),
  );

  const snapshot = (): ThrottleState => ({
    delayMs: delay,
    smoothedLatencyMs: smoothed,
    slowStarting: samples < slowStartRequests,
    samples,
    effectiveRate: delay === 0 ? profile.requestsPerSecond : 1000 / delay,
  });

  return {
    floorMs,
    get state() {
      return snapshot();
    },

    observe(latencyMs, ok) {
      samples += 1;
      smoothed = samples === 1 ? latencyMs : smoothing * latencyMs + (1 - smoothing) * smoothed;

      // AutoThrottle's rule: the delay that would keep `targetConcurrency`
      // requests in flight against the observed latency.
      const target = smoothed / Math.max(1, profile.targetConcurrency);

      if (!ok) {
        // A non-2xx may only ever raise the delay. A 500 often returns
        // fast because the server gave up early, and letting that lower the
        // delay speeds the scan up exactly as the target starts failing.
        delay = Math.min(profile.maxDelayMs, Math.max(delay, target));
        return snapshot();
      }

      // Healthy: converge halfway towards the target, so one quick response
      // cannot undo a considered slowdown.
      const next = (delay + target) / 2;

      if (samples < slowStartRequests) {
        // While ramping, only allow the delay to fall — and no further than
        // the profile's base. The ramp is a floor coming down, not a rate
        // going up past what was configured.
        delay = Math.max(baseDelay, Math.min(delay, next));
      } else {
        delay = next;
      }

      delay = Math.min(profile.maxDelayMs, Math.max(floorMs, delay));
      return snapshot();
    },
  };
}
