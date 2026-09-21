/**
 * Reactive backoff — build plan §8.1, §8.2, §8.4, §8.5 rule 5;
 * dev plan BR-M1-19.
 *
 * What to do when the target says stop: 429, repeated 5xx, resets, or a WAF
 * page. Exponential with jitter, concurrency cut, and a recovery that is
 * gradual — a controller that returns to full speed the moment one request
 * succeeds simply re-triggers the limit, which is worse for the target than
 * never having backed off.
 *
 * ## The state outlives the phase
 *
 * §8.5 rule 5. Backoff triggered while Katana was crawling has to still be
 * in effect when the browser starts, because it is the same target and it
 * asked once. A controller scoped to a phase forgets the answer between
 * asking and acting.
 */

/** What the target did that warranted backing off. */
export const BACKOFF_TRIGGERS = [
  "http_429",
  "http_5xx",
  "connection_reset",
  "timeout",
  "waf_challenge",
] as const;

export type BackoffTrigger = (typeof BACKOFF_TRIGGERS)[number];

export interface BackoffState {
  /** Consecutive triggers with no healthy response between. */
  readonly consecutive: number;
  /** Current delay before the next request, in milliseconds. */
  readonly delayMs: number;
  /** Concurrency the controller is allowing now. */
  readonly concurrency: number;
  /** When the current backoff expires, as an epoch millisecond value. */
  readonly until: number;
  readonly lastTrigger?: BackoffTrigger | undefined;
}

export interface BackoffConfig {
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly startingConcurrency: number;
  readonly minConcurrency: number;
  /** Healthy responses needed before easing off. */
  readonly recoveryThreshold: number;
}

export const DEFAULT_BACKOFF: BackoffConfig = {
  baseDelayMs: 1_000,
  // Two minutes. Longer than this and the scan is not backing off, it has
  // stopped — and saying so is more useful than waiting silently.
  maxDelayMs: 120_000,
  startingConcurrency: 4,
  minConcurrency: 1,
  // Deliberately more than one: recovering after a single success is what
  // makes a controller oscillate into the limit it just hit.
  recoveryThreshold: 5,
};

/**
 * Parse `Retry-After`, which comes in two forms and often in neither.
 *
 * Returns undefined for anything it cannot trust. An unparseable value must
 * not become a zero delay — that would turn a malformed header into an
 * instruction to retry immediately, which is the opposite of what the server
 * was asking for.
 */
export function parseRetryAfter(value: string | undefined, now: number): number | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed === "") return undefined;

  // Delta-seconds.
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    // A server asking for a day is telling us to stop, not to sleep for a
    // day. The caller decides; the value is still reported honestly.
    return Number.isFinite(seconds) ? seconds * 1000 : undefined;
  }

  // HTTP-date. Required to contain a letter first, because `Date.parse`
  // accepts things that are plainly not dates — `"-5"` parses to a year and
  // produced a delay of about thirty-one years, which is a malformed header
  // turning into a scan that never resumes.
  if (!/[a-z]/i.test(trimmed)) return undefined;
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return undefined;
  const delta = at - now;
  // A date in the past means "you may retry", not "retry 3000ms ago".
  return delta > 0 ? delta : 0;
}

export interface BackoffController {
  /** Record a trigger. Returns the new state. */
  trigger(kind: BackoffTrigger, retryAfter?: string | undefined): BackoffState;
  /** Record a healthy response; may ease the backoff. */
  healthy(): BackoffState;
  /** Milliseconds to wait before the next request, zero when clear. */
  waitMs(): number;
  readonly state: BackoffState;
}

export interface ControllerOptions {
  readonly config?: Partial<BackoffConfig> | undefined;
  readonly now?: (() => number) | undefined;
  /** Injected so backoff maths is testable without randomness (§36.1). */
  readonly jitter?: (() => number) | undefined;
}

export function createBackoffController(options: ControllerOptions = {}): BackoffController {
  const config = { ...DEFAULT_BACKOFF, ...options.config };
  const now = options.now ?? ((): number => Date.now());
  // Full jitter: a delay uniformly in [0, computed]. Without it, every
  // component that backed off at the same moment retries at the same moment,
  // and the target receives a synchronised wave instead of a trickle.
  const jitter = options.jitter ?? ((): number => Math.random());

  let consecutive = 0;
  let healthyRun = 0;
  let delayMs = 0;
  let concurrency = config.startingConcurrency;
  let until = 0;
  let lastTrigger: BackoffTrigger | undefined;

  const snapshot = (): BackoffState => ({
    consecutive,
    delayMs,
    concurrency,
    until,
    ...(lastTrigger === undefined ? {} : { lastTrigger }),
  });

  return {
    trigger(kind, retryAfter) {
      consecutive += 1;
      healthyRun = 0;
      lastTrigger = kind;

      const explicit = parseRetryAfter(retryAfter, now());
      if (explicit !== undefined) {
        // The server named a number. Honouring it exactly is both correct
        // and the politest thing available — no jitter, no exponent.
        delayMs = Math.min(config.maxDelayMs, explicit);
      } else {
        const exponential = config.baseDelayMs * 2 ** Math.min(consecutive - 1, 10);
        delayMs = Math.min(config.maxDelayMs, Math.ceil(exponential * jitter()));
      }

      // Halved per trigger, floored. Rate alone is not enough: a target
      // struggling under ten concurrent connections is not helped by the
      // same ten arriving more slowly.
      concurrency = Math.max(config.minConcurrency, Math.floor(concurrency / 2));
      until = now() + delayMs;
      return snapshot();
    },

    healthy() {
      healthyRun += 1;
      if (healthyRun < config.recoveryThreshold) return snapshot();

      healthyRun = 0;
      consecutive = Math.max(0, consecutive - 1);
      // Halved, not cleared. Gradual recovery is the requirement: returning
      // to full speed at once re-triggers whatever we just backed off from.
      delayMs = consecutive === 0 ? 0 : Math.floor(delayMs / 2);
      concurrency = Math.min(config.startingConcurrency, concurrency + 1);
      if (consecutive === 0) until = 0;
      return snapshot();
    },

    waitMs() {
      return Math.max(0, until - now());
    },

    get state() {
      return snapshot();
    },
  };
}
