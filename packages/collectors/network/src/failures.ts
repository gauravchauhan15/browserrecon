/**
 * Typed network failures — build plan §33; dev plan BR-M1-06.
 *
 * Chrome reports a failure as a string: `net::ERR_CONNECTION_REFUSED`,
 * `net::ERR_ABORTED`, `net::ERR_CERT_AUTHORITY_INVALID`. Passing that string
 * downstream makes every consumer write its own string matching, and they will
 * not agree — §33 has to decide retryable from non-retryable, coverage
 * accounting has to tell "we could not reach it" from "you told us not to",
 * and a report has to say something a person can act on.
 *
 * ## `ERR_ABORTED` is not an error
 *
 * The single most common entry in any real scan's failure list, and almost
 * never a failure: it is what a navigation away from a page looks like to the
 * requests that were still in flight. Reporting those as errors buries the
 * handful that are real. It gets its own reason and `isError: false`, so a
 * summary can say "14 requests were cancelled by navigation" rather than
 * "14 requests failed".
 */

/** What went wrong, in terms a consumer can branch on. */
export const FAILURE_REASONS = [
  /** The page navigated away, or script called `abort()`. Usually not an error. */
  "cancelled",
  "dns_failed",
  "connection_refused",
  "connection_reset",
  "connection_timed_out",
  "address_unreachable",
  /** TLS handshake failed for a reason other than the certificate. */
  "tls_failed",
  /** Certificate rejected — expired, wrong name, untrusted issuer. */
  "certificate_invalid",
  /** An extension, an ad blocker, or enterprise policy stopped it. */
  "blocked_by_client",
  /** Content Security Policy, X-Frame-Options, or a similar page-level rule. */
  "blocked_by_policy",
  "blocked_mixed_content",
  "cors_denied",
  "too_many_redirects",
  /** The response was malformed enough that Chrome gave up parsing it. */
  "protocol_error",
  /** Chrome ran out of something — memory, sockets, disk. */
  "resource_exhausted",
  /** Recognised as a failure, but not as one of the above. */
  "unknown",
] as const;

export type FailureReason = (typeof FAILURE_REASONS)[number];

export interface ClassifiedFailure {
  readonly reason: FailureReason;
  /** Chrome's own string, kept so nothing is lost by classifying (§37.2). */
  readonly raw: string;
  /**
   * Whether this represents something going wrong.
   *
   * False for `cancelled`, which is ordinary browser behaviour. A summary that
   * counts those as errors buries the ones that are real.
   */
  readonly isError: boolean;
  /**
   * Whether retrying the same request could plausibly succeed.
   *
   * §33 decides what to do about it; this only says whether the door is open.
   * A refused connection might come back; an invalid certificate will not
   * without someone changing something.
   */
  readonly retryable: boolean;
  /** One line a person can act on. */
  readonly detail: string;
}

interface Rule {
  readonly match: RegExp;
  readonly reason: FailureReason;
  readonly isError: boolean;
  readonly retryable: boolean;
  readonly detail: string;
}

/**
 * Matched in order, first hit wins.
 *
 * Ordering matters in one place that is easy to get wrong: the certificate
 * errors have to be checked before the general TLS/SSL pattern, or every
 * expired certificate is reported as a generic handshake failure and the
 * actionable part of the message is lost.
 */
const RULES: readonly Rule[] = [
  {
    match: /ERR_ABORTED|ERR_BLOCKED_BY_ORB$/,
    reason: "cancelled",
    isError: false,
    retryable: true,
    detail: "cancelled — usually the page navigating away while the request was in flight",
  },
  {
    match: /ERR_NAME_NOT_RESOLVED|ERR_NAME_RESOLUTION_FAILED|ERR_DNS_/,
    reason: "dns_failed",
    isError: true,
    retryable: false,
    detail: "the hostname did not resolve",
  },
  {
    match: /ERR_CONNECTION_REFUSED/,
    reason: "connection_refused",
    isError: true,
    retryable: true,
    detail: "nothing was listening on that port",
  },
  {
    match: /ERR_CONNECTION_RESET|ERR_EMPTY_RESPONSE|ERR_CONNECTION_CLOSED/,
    reason: "connection_reset",
    isError: true,
    retryable: true,
    detail: "the connection was closed before a response arrived",
  },
  {
    match: /ERR_CONNECTION_TIMED_OUT|ERR_TIMED_OUT/,
    reason: "connection_timed_out",
    isError: true,
    retryable: true,
    detail: "the host did not answer in time",
  },
  {
    match: /ERR_ADDRESS_UNREACHABLE|ERR_NETWORK_CHANGED|ERR_INTERNET_DISCONNECTED/,
    reason: "address_unreachable",
    isError: true,
    retryable: true,
    detail: "the address could not be reached from this machine",
  },
  {
    match: /ERR_CERT_|ERR_SSL_PINNED_KEY_NOT_IN_CERT_CHAIN|ERR_BAD_SSL_CLIENT_AUTH_CERT/,
    reason: "certificate_invalid",
    isError: true,
    retryable: false,
    detail: "the TLS certificate was rejected",
  },
  {
    match: /ERR_SSL_|ERR_TLS_/,
    reason: "tls_failed",
    isError: true,
    retryable: false,
    detail: "the TLS handshake failed",
  },
  {
    match: /ERR_BLOCKED_BY_CLIENT|ERR_BLOCKED_BY_ADMINISTRATOR/,
    reason: "blocked_by_client",
    isError: true,
    retryable: false,
    detail: "blocked before it left the browser — an extension, ad blocker or policy",
  },
  {
    match: /ERR_BLOCKED_BY_CSP|ERR_BLOCKED_BY_RESPONSE|ERR_UNSAFE_REDIRECT|ERR_UNSAFE_PORT/,
    reason: "blocked_by_policy",
    isError: true,
    retryable: false,
    detail: "refused by a page-level or browser policy",
  },
  {
    match: /ERR_INSECURE_RESPONSE|MIXED_CONTENT/i,
    reason: "blocked_mixed_content",
    isError: true,
    retryable: false,
    detail: "an insecure resource was refused on a secure page",
  },
  {
    match: /ERR_FAILED.*CORS|CORS|ERR_BLOCKED_BY_XSS_AUDITOR/i,
    reason: "cors_denied",
    isError: true,
    retryable: false,
    detail: "refused by the cross-origin rules",
  },
  {
    match: /ERR_TOO_MANY_REDIRECTS/,
    reason: "too_many_redirects",
    isError: true,
    retryable: false,
    detail: "the redirect chain did not terminate",
  },
  {
    match:
      /ERR_INVALID_|ERR_RESPONSE_HEADERS|ERR_CONTENT_DECODING|ERR_HTTP2_|ERR_QUIC_|ERR_SPDY_/,
    reason: "protocol_error",
    isError: true,
    retryable: true,
    detail: "the response could not be parsed",
  },
  {
    match: /ERR_INSUFFICIENT_RESOURCES|ERR_OUT_OF_MEMORY|ERR_FILE_NO_SPACE/,
    reason: "resource_exhausted",
    isError: true,
    retryable: true,
    // Worth surfacing loudly: this one usually means the scan itself is the
    // problem, not the target.
    detail: "the browser ran out of resources — the scan may be going too fast",
  },
];

/**
 * Turn Chrome's error string into something a consumer can branch on.
 *
 * `canceled` is taken from CDP rather than inferred from the text, because
 * Chrome sets the flag for some cancellations whose message says nothing
 * about it.
 */
export function classifyFailure(errorText: string, canceled = false): ClassifiedFailure {
  const raw = errorText;

  if (canceled) {
    return {
      reason: "cancelled",
      raw,
      isError: false,
      retryable: true,
      detail: "cancelled — usually the page navigating away while the request was in flight",
    };
  }

  const rule = RULES.find((candidate) => candidate.match.test(raw));
  if (rule === undefined) {
    return {
      reason: "unknown",
      raw,
      isError: true,
      retryable: false,
      // The raw string is in `detail` precisely because "unknown" on its own
      // tells a reader nothing, and this is the case where they need it most.
      detail: `unrecognised network error: ${raw}`,
    };
  }

  return {
    reason: rule.reason,
    raw,
    isError: rule.isError,
    retryable: rule.retryable,
    detail: rule.detail,
  };
}
