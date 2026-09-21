/**
 * @browserrecon/rate-controller — one shared budget, and two ways of spending
 * it more slowly.
 *
 * §8.5's rules, in one place: one bucket per origin shared by every
 * request-generating component, reactive backoff whose state outlives the
 * phase that triggered it, and proactive latency throttling for the far more
 * common case of a target that never returns an error and simply gets slower.
 */
export const PACKAGE_NAME = "@browserrecon/rate-controller" as const;

export { createBucketRegistry, createTokenBucket } from "./bucket.js";
export type { BucketOptions, BucketRegistry, BucketStats, TokenBucket } from "./bucket.js";

export {
  BACKOFF_TRIGGERS,
  DEFAULT_BACKOFF,
  createBackoffController,
  parseRetryAfter,
} from "./backoff.js";
export type {
  BackoffConfig,
  BackoffController,
  BackoffState,
  BackoffTrigger,
  ControllerOptions,
} from "./backoff.js";

export { RATE_PROFILES, createLatencyThrottle } from "./latency.js";
export type {
  LatencyThrottle,
  ProfileSettings,
  RateProfile,
  ThrottleOptions,
  ThrottleState,
} from "./latency.js";
