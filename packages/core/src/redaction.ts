/**
 * Redaction primitives — build plan §37.2.
 *
 * ## Where redaction applies, and where it deliberately does not
 *
 * The event store is **raw and local-only**: it is the evidence base
 * correlation depends on, and stripping it would destroy the data the whole
 * tool exists to collect. Redaction guards the boundaries that *leave* the
 * machine — diagnostic logs, reports, exports, and model prompts.
 *
 * Logs are squarely on the wrong side of that line. A log line goes to a
 * terminal someone screenshots, a CI job someone links to, an issue someone
 * pastes into. Treating logs as trusted because they are "just diagnostics"
 * is how a bearer token ends up in a public bug report.
 *
 * ## What this can and cannot promise
 *
 * Honestly: pattern matching cannot guarantee that no secret ever appears. A
 * password can be any string, and a value-based rule aggressive enough to
 * catch every one would redact half the legitimate output.
 *
 * What it does guarantee is narrower and actually keepable:
 *
 *   1. A field whose **key** is recognisably sensitive is always redacted,
 *      wherever it appears in a nested structure.
 *   2. A small set of high-confidence **value** shapes — JWTs, `Bearer`
 *      credentials, PEM private keys — are redacted regardless of their key.
 *
 * The stronger defence is structural rather than textual, and lives in the
 * logger: there is no path that logs a raw request or response body to
 * diagnostics. Redaction is the safety net under that, not the plan.
 */

/**
 * Replacement text. Deliberately obvious: a reader should see that something
 * was removed, rather than wonder whether a field was empty.
 */
export const REDACTED = "[redacted]";

/**
 * Keys whose values are always removed.
 *
 * Matched against the key alone, so a value is redacted by virtue of *what it
 * is called* — which is reliable in a way that inspecting the value is not.
 *
 * Two words are deliberately **absent**, both caught by tests after they broke
 * real behaviour here:
 *
 *   `session` — would redact `session_id`, the identifier every log line and
 *   every event is correlated by. Genuinely sensitive session fields are
 *   named `session_cookie` or `session_token`, which `cookie` and `token`
 *   already catch.
 *
 *   `auth` — would redact `auth_context`, which §12.3 makes mandatory on every
 *   event and which holds an auth *profile name*, not a credential. The header
 *   itself is covered by `authorization`.
 *
 * Both illustrate the rule that over-redaction is a real failure and not the
 * safe direction: silently blanking the correlation keys would have made the
 * event log unusable while looking perfectly fine.
 */
const SENSITIVE_KEY_PATTERN =
  /(?:^|[_\-.])(?:password|passwd|pwd|secret|token|authorization|cookie|credential|apikey|api_key|access_key|private_key|signature|otp|totp|mfa|pin|cvv|cvc|card|pan|ssn)(?:$|[_\-.])|^(?:password|passwd|pwd|secret|token|authorization|cookie|credential|apikey|otp|totp|cvv|cvc)s?$/i;

/**
 * Value shapes confident enough to redact wherever they appear.
 *
 * Each is specific enough that a false positive is unlikely. Anything looser —
 * "long random-looking string" — would redact hashes, ids and URLs, which
 * makes output useless and trains people to turn redaction off.
 */
const SENSITIVE_VALUE_PATTERNS: readonly RegExp[] = [
  // JSON Web Token: three base64url segments.
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  // An Authorization header's credential part.
  /\b(Bearer|Basic|Digest)\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  // PEM private key block.
  /-----BEGIN[ A-Z]*PRIVATE KEY-----[\s\S]*?-----END[ A-Z]*PRIVATE KEY-----/g,
  // Common vendor-prefixed key formats.
  /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  // URL userinfo, which carries credentials into every logged URL.
  /\b([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi,
];

export interface RedactorOptions {
  /** Extra key patterns, from user configuration. */
  readonly keyPatterns?: readonly RegExp[] | undefined;
  /** Extra value patterns, from user configuration. */
  readonly valuePatterns?: readonly RegExp[] | undefined;
  /**
   * Longest string kept intact. Longer ones are truncated with a marker.
   *
   * A response body pasted into a log is both a leak risk and unreadable, so
   * length is capped independently of whether anything matched.
   */
  readonly maxStringLength?: number | undefined;
  /** How deep to walk before giving up. Guards against cyclic structures. */
  readonly maxDepth?: number | undefined;
}

const DEFAULT_MAX_STRING_LENGTH = 512;
const DEFAULT_MAX_DEPTH = 8;

export class Redactor {
  readonly #keyPatterns: readonly RegExp[];
  readonly #valuePatterns: readonly RegExp[];
  readonly #maxStringLength: number;
  readonly #maxDepth: number;

  constructor(options: RedactorOptions = {}) {
    this.#keyPatterns = [SENSITIVE_KEY_PATTERN, ...(options.keyPatterns ?? [])];
    this.#valuePatterns = [...SENSITIVE_VALUE_PATTERNS, ...(options.valuePatterns ?? [])];
    this.#maxStringLength = options.maxStringLength ?? DEFAULT_MAX_STRING_LENGTH;
    this.#maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  }

  /** Whether a key marks its value as sensitive. */
  isSensitiveKey(key: string): boolean {
    return this.#keyPatterns.some((pattern) => {
      pattern.lastIndex = 0;
      return pattern.test(key);
    });
  }

  /** Redact secret-shaped substrings and cap length. */
  redactString(value: string): string {
    let result = value;
    for (const pattern of this.#valuePatterns) {
      pattern.lastIndex = 0;
      result = result.replace(pattern, (match, ...groups) => {
        // A URL userinfo pattern captures the scheme so it can be kept —
        // `https://[redacted]@host` is far more useful than `[redacted]`.
        const scheme = typeof groups[0] === "string" ? groups[0] : undefined;
        if (scheme !== undefined && match.startsWith(scheme)) return `${scheme}${REDACTED}@`;
        return REDACTED;
      });
    }

    if (result.length > this.#maxStringLength) {
      return `${result.slice(0, this.#maxStringLength)}… [${result.length} chars truncated]`;
    }
    return result;
  }

  /**
   * Walk a value, redacting as it goes.
   *
   * Returns a new structure; the input is never mutated, because the caller
   * may be logging something the scan still needs intact.
   */
  redact(value: unknown, depth = 0): unknown {
    if (depth > this.#maxDepth) return "[max depth]";

    if (typeof value === "string") return this.redactString(value);
    if (value === null || typeof value !== "object") return value;

    if (Array.isArray(value)) {
      return value.map((item) => this.redact(item, depth + 1));
    }

    if (value instanceof Error) {
      return {
        name: value.name,
        message: this.redactString(value.message),
        // Stack frames carry file paths, not secrets, but a message embedded
        // in the stack would otherwise bypass the message redaction above.
        stack: value.stack === undefined ? undefined : this.redactString(value.stack),
      };
    }

    if (value instanceof Date) return value.toISOString();
    if (value instanceof URL) return this.redactString(value.href);

    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      output[key] = this.isSensitiveKey(key) ? REDACTED : this.redact(item, depth + 1);
    }
    return output;
  }
}

/** A redactor with the built-in ruleset. */
export function createRedactor(options: RedactorOptions = {}): Redactor {
  return new Redactor(options);
}
