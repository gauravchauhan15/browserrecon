/**
 * Access barriers — build plan §8.6, §7.3, §33; dev plan BR-M1-21.
 *
 * §8.6's first line: *do not collapse barriers into generic failures*. A 403
 * and a CAPTCHA and a silently-degraded response to automated Chrome are
 * three different facts about a target, and a report that says "3 pages
 * unreachable" has thrown away the only part worth reading.
 *
 * ## Nothing here attempts a bypass
 *
 * §7.3. This file classifies and records; it has no code path that solves a
 * challenge, rotates an identity, or retries with different headers to get
 * around a defence. That is not a limitation to be worked around later — it
 * is the line between a recon tool and an attack tool, and a scan that
 * quietly defeated a WAF would be unusable as evidence in exactly the
 * engagement it was run for.
 *
 * ## `bot_detection` is deliberately not `waf`
 *
 * Many defences fingerprint automated Chrome and answer with degraded
 * content, a silent redirect, or an empty 200 rather than a challenge page.
 * Collapsing that into "unreachable" misreports coverage: the surface exists
 * and it was our automation that was refused. Collapsing it into "waf"
 * misreports the cause, and sends the user to the wrong setting.
 */

/** §8.6's taxonomy. */
export const BARRIER_CATEGORIES = [
  "authentication_required",
  "forbidden",
  "rate_limited",
  "challenge_detected",
  "automation_signature_blocked",
  "auth_state_lost",
  "geo_restricted",
  "network_unreachable",
  "private_network_unreachable",
  "tls_error",
  "robots_excluded",
  "scope_excluded",
] as const;

export type BarrierCategory = (typeof BARRIER_CATEGORIES)[number];

export interface Barrier {
  readonly category: BarrierCategory;
  readonly url: string;
  readonly status?: number | undefined;
  /** What in the response led here — the signal, not a guess. */
  readonly evidence: string;
  readonly retryable: boolean;
  /**
   * What a user could do about it, where anything can be.
   *
   * Never "retry with a different user agent" or similar: §7.3 rules out
   * circumvention, and suggesting it in a report is the same thing as doing
   * it a step removed.
   */
  readonly remedy?: string | undefined;
}

export interface BarrierInput {
  readonly url: string;
  readonly status?: number | undefined;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  /** Response body, where policy captured one. */
  readonly body?: string | undefined;
  readonly mimeType?: string | undefined;
  /** A typed network failure, when the request never completed. */
  readonly failureReason?: string | undefined;
  /**
   * Whether the scan believed it was authenticated at the time.
   *
   * The only way to tell `auth_state_lost` from `authentication_required`:
   * the first means we had auth and lost it mid-scan, the second that we
   * never had it (§12.3).
   */
  readonly hadAuthContext?: boolean | undefined;
  /** Bytes of body. A near-empty 200 is a signal in its own right. */
  readonly bodyBytes?: number | undefined;
}

/** Vendor markers that appear in challenge pages and their headers. */
const CHALLENGE_MARKERS = [
  "cf-chl",
  "cf_chl",
  "just a moment",
  "checking your browser",
  "attention required",
  "captcha",
  "recaptcha",
  "hcaptcha",
  "turnstile",
  "px-captcha",
  "perimeterx",
  "incapsula",
  "imperva",
  "access denied",
  "request unsuccessful",
  "akamai",
  "bot detection",
  "are you a robot",
];

const WAF_HEADERS = ["cf-ray", "x-akamai", "x-iinfo", "x-sucuri-id", "server-timing-waf"];

function looksLikeChallenge(input: BarrierInput): string | undefined {
  const body = (input.body ?? "").slice(0, 4_000).toLowerCase();
  const marker = CHALLENGE_MARKERS.find((candidate) => body.includes(candidate));
  if (marker !== undefined) return `challenge marker "${marker}" in the response body`;

  const headers = input.headers ?? {};
  const header = WAF_HEADERS.find((candidate) => headers[candidate] !== undefined);
  if (header !== undefined && (input.status === 403 || input.status === 503)) {
    return `${header} header on a ${input.status}`;
  }
  return undefined;
}

/**
 * Classify one observation.
 *
 * Order matters. A challenge page is served *with* a 403 more often than
 * not, so the challenge check runs before the status code — otherwise every
 * CAPTCHA is reported as a plain forbidden and the user changes their
 * credentials rather than their approach.
 */
export function classifyBarrier(input: BarrierInput): Barrier | undefined {
  const base = {
    url: input.url,
    ...(input.status === undefined ? {} : { status: input.status }),
  };

  if (input.failureReason !== undefined) {
    switch (input.failureReason) {
      case "certificate_invalid":
      case "tls_failed":
        return {
          ...base,
          category: "tls_error",
          evidence: input.failureReason,
          retryable: false,
          remedy:
            "the certificate must be fixed, or the host explicitly trusted by the operator",
        };
      case "dns_failed":
      case "connection_refused":
      case "connection_reset":
      case "connection_timed_out":
      case "address_unreachable":
        return {
          ...base,
          category: "network_unreachable",
          evidence: input.failureReason,
          retryable: true,
        };
      default:
        return undefined;
    }
  }

  const challenge = looksLikeChallenge(input);
  if (challenge !== undefined) {
    return {
      ...base,
      category: "challenge_detected",
      evidence: challenge,
      // Not retryable, and deliberately no remedy that involves getting
      // past it (§7.3).
      retryable: false,
      remedy: "run from an allow-listed source, or ask the operator to exempt the scan",
    };
  }

  if (input.status === 401) {
    return input.hadAuthContext === true
      ? {
          ...base,
          category: "auth_state_lost",
          evidence: "401 while the scan believed it was authenticated",
          retryable: true,
          remedy: "the session expired mid-scan; re-authenticate and resume",
        }
      : {
          ...base,
          category: "authentication_required",
          evidence: "401 with no authentication configured",
          retryable: false,
          remedy: "configure an authentication profile to reach this",
        };
  }

  if (input.status === 403) {
    return { ...base, category: "forbidden", evidence: "403", retryable: false };
  }

  if (input.status === 429) {
    return {
      ...base,
      category: "rate_limited",
      evidence: "429",
      retryable: true,
      remedy: "the rate controller will back off; a slower profile avoids it",
    };
  }

  if (input.status === 451) {
    return { ...base, category: "geo_restricted", evidence: "451", retryable: false };
  }

  // The quiet one. An empty or near-empty 200 to automated Chrome, where a
  // browser would have received a page. The surface exists; our automation
  // was refused. Reporting it as success would overstate coverage, and as
  // unreachable would understate the target.
  if (
    input.status === 200 &&
    input.bodyBytes !== undefined &&
    input.bodyBytes < 512 &&
    (input.mimeType ?? "").startsWith("text/html")
  ) {
    return {
      ...base,
      category: "automation_signature_blocked",
      evidence: `200 with only ${input.bodyBytes} bytes of HTML`,
      retryable: false,
      remedy: "try a headed run, which is often not fingerprinted the same way",
    };
  }

  return undefined;
}

/**
 * Whether a barrier should stop the scan.
 *
 * Always false. §33: a barrier is reconnaissance data and the remaining
 * scope continues. This function exists so that the answer is written down
 * somewhere a future change has to argue with, rather than being implied by
 * the absence of a check.
 */
export function shouldAbortScan(_barrier: Barrier): boolean {
  return false;
}
