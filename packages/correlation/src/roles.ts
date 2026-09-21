/**
 * Traffic roles — build plan §17A; dev plan BR-M1-22.
 *
 * A real application makes hundreds of requests that have nothing to do with
 * its workflows: analytics beacons, ad pixels, error-reporting SDKs,
 * heartbeats, font loads, third-party widget chatter. Unfiltered, they
 * pollute workflow detection, invent `caused_by` edges between unrelated
 * events, and spend scarce local-LLM context describing a Google Analytics
 * beacon instead of the checkout flow.
 *
 * ## Classify, never drop (§17A.1)
 *
 * The raw event stays in the store whatever its role. "This application
 * talks to fourteen third-party trackers" is itself attack surface and
 * privacy-relevant intelligence, and §10A.4's origin classification depends
 * on having seen it. What the role does is decide which *consumer* looks at
 * it (§17A.3) — so a scan can be re-exported under a different filter
 * without touching the browser again.
 *
 * ## Deterministic signals only (§17A.2)
 *
 * This is not an LLM task. Every rule below is a structural property of the
 * observation: the origin relationship, the shape of a repeating request,
 * whether an interaction preceded it, the content type. A domain list is
 * used, and deliberately is not relied on alone — a curated list is out of
 * date the day it ships, so the structural fallback carries the cases it
 * misses.
 */

export const TRAFFIC_ROLES = [
  "application_api",
  "application_asset",
  "auth_infrastructure",
  "analytics_telemetry",
  "advertising_marketing",
  "third_party_widget",
  "polling_heartbeat",
  "keepalive",
  "cache_revalidation",
  "unknown",
] as const;

export type TrafficRole = (typeof TRAFFIC_ROLES)[number];

export interface RoleVerdict {
  readonly role: TrafficRole;
  /** The signal that produced it — §17A requires this be recorded. */
  readonly signal: string;
}

/**
 * Hosts that are unambiguously analytics or advertising.
 *
 * Short on purpose. A long list feels thorough and rots; these are the ones
 * whose presence is never anything else, and everything they miss is caught
 * structurally below.
 */
const TRACKER_HOSTS = [
  "google-analytics.com",
  "googletagmanager.com",
  "doubleclick.net",
  "facebook.net",
  "connect.facebook.com",
  "segment.io",
  "segment.com",
  "mixpanel.com",
  "amplitude.com",
  "hotjar.com",
  "fullstory.com",
  "sentry.io",
  "bugsnag.com",
  "datadoghq.com",
  "newrelic.com",
  "clarity.ms",
];

const AD_HOSTS = [
  "doubleclick.net",
  "googlesyndication.com",
  "adservice.google.com",
  "adnxs.com",
  "criteo.com",
];

const WIDGET_HOSTS = [
  "intercom.io",
  "zendesk.com",
  "drift.com",
  "hubspot.com",
  "youtube.com",
  "vimeo.com",
  "stripe.com",
];

/** Paths that mean authentication infrastructure rather than application API. */
const AUTH_PATHS =
  /\/(oauth|openid|auth|login|logout|token|refresh|session|sso|saml|\.well-known\/openid)/i;

const ASSET_TYPES =
  /^(text\/css|font\/|image\/|video\/|audio\/|text\/javascript|application\/javascript)/i;

export interface ObservationForRole {
  readonly url: string;
  readonly method: string;
  readonly mimeType?: string | undefined;
  readonly status?: number | undefined;
  readonly resourceType?: string | undefined;
  /** Origins the scan considers first-party — the target and its allowed set. */
  readonly firstPartyOrigins: readonly string[];
  /** CDP's initiator type: `parser`, `script`, `preload`, `other`. */
  readonly initiatorType?: string | undefined;
  /**
   * Whether an interaction preceded this request in the same frame.
   *
   * §17A.2's strongest structural signal: traffic fired autonomously on a
   * timer behaves differently from traffic a person caused.
   */
  readonly followedInteraction?: boolean | undefined;
  /** How many times this exact method+path has been seen. */
  readonly repeatCount?: number | undefined;
  /** Milliseconds between repeats, where a stable interval was measured. */
  readonly repeatIntervalMs?: number | undefined;
  /** Standard deviation of those intervals, as a fraction of the mean. */
  readonly repeatJitter?: number | undefined;
  /** True when the response was a 304 or came from a conditional request. */
  readonly conditional?: boolean | undefined;
  /** For a WebSocket frame: a protocol control frame (§17A's `keepalive`). */
  readonly isControlFrame?: boolean | undefined;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function matchesHost(host: string, list: readonly string[]): string | undefined {
  return list.find((entry) => host === entry || host.endsWith(`.${entry}`));
}

function isFirstParty(url: string, origins: readonly string[]): boolean {
  try {
    const origin = new URL(url).origin;
    return origins.includes(origin);
  } catch {
    return false;
  }
}

/**
 * Whether a request looks like a heartbeat.
 *
 * Structural, not by domain: the same method and path, repeating at a stable
 * interval, with no interaction causing it. §17A.2 asks for exactly this,
 * because polling to a first-party API is invisible to any tracker list —
 * and it is the noise most likely to be mistaken for a workflow.
 */
function looksLikePolling(observation: ObservationForRole): boolean {
  const { repeatCount, repeatIntervalMs, repeatJitter } = observation;
  if (repeatCount === undefined || repeatCount < 3) return false;
  if (repeatIntervalMs === undefined) return false;
  // A human clicking repeatedly produces wildly uneven gaps; a timer does
  // not. Twenty-five per cent is loose enough for network variance and
  // tight enough to exclude a person.
  if (repeatJitter !== undefined && repeatJitter > 0.25) return false;
  return observation.followedInteraction !== true;
}

/** Assign a role. Deterministic, and never drops anything. */
export function classifyTraffic(observation: ObservationForRole): RoleVerdict {
  if (observation.isControlFrame === true) {
    return { role: "keepalive", signal: "WebSocket control frame (RFC 6455 opcode >= 0x8)" };
  }

  const host = hostOf(observation.url);
  const firstParty = isFirstParty(observation.url, observation.firstPartyOrigins);

  // Conditional requests first: a 304 to a first-party asset is cache
  // revalidation whatever else it looks like, and counting it as an API call
  // inflates every coverage number.
  if (observation.conditional === true || observation.status === 304) {
    return { role: "cache_revalidation", signal: "conditional request or 304 response" };
  }

  if (!firstParty) {
    const ad = matchesHost(host, AD_HOSTS);
    if (ad !== undefined)
      return { role: "advertising_marketing", signal: `known ad host ${ad}` };

    const tracker = matchesHost(host, TRACKER_HOSTS);
    if (tracker !== undefined) {
      return { role: "analytics_telemetry", signal: `known analytics host ${tracker}` };
    }

    const widget = matchesHost(host, WIDGET_HOSTS);
    if (widget !== undefined) {
      return { role: "third_party_widget", signal: `known widget host ${widget}` };
    }
  }

  if (AUTH_PATHS.test(observation.url)) {
    // Before the polling check: a token refresh repeats on a timer and would
    // otherwise be filed as a heartbeat, which would hide the auth flow from
    // workflow detection that §17A.3 explicitly wants it included in.
    return { role: "auth_infrastructure", signal: "path matches an authentication endpoint" };
  }

  if (looksLikePolling(observation)) {
    return {
      role: "polling_heartbeat",
      signal: `repeated ${observation.repeatCount} times at a stable interval with no interaction`,
    };
  }

  if (ASSET_TYPES.test(observation.mimeType ?? "")) {
    return firstParty
      ? { role: "application_asset", signal: `first-party ${observation.mimeType}` }
      : {
          // The structural fallback the curated list exists to not need.
          // A third-party script that is on no list is still third party.
          role: "third_party_widget",
          signal: "third-party asset from a host not on any list",
        };
  }

  if (firstParty) {
    return {
      role: "application_api",
      signal: "first-party request with an application payload",
    };
  }

  // §17A.2's fallback: matches no first-party origin and carries no
  // application response payload.
  return { role: "unknown", signal: "third-party request that matches no rule" };
}

/**
 * Which roles each consumer sees — §17A.3's table, in code.
 *
 * Written here rather than at each call site so the answer is one thing. A
 * consumer that filtered differently would produce coverage numbers nobody
 * could reconcile with the report beside them.
 */
export const CONSUMER_FILTERS: Readonly<Record<string, readonly TrafficRole[]>> = {
  /** Everything, unfiltered. The source of truth (§22). */
  event_store: TRAFFIC_ROLES,
  correlation: ["application_api", "application_asset", "auth_infrastructure"],
  workflow_detection: ["application_api", "auth_infrastructure"],
  api_sequencing: ["application_api"],
  llm_context: ["application_api"],
  /** Everything, grouped by role rather than filtered. */
  attack_surface_export: TRAFFIC_ROLES,
  /** So a tracker-heavy site does not report inflated coverage. */
  coverage: ["application_api"],
};

export function passesFilter(
  role: TrafficRole,
  consumer: keyof typeof CONSUMER_FILTERS,
): boolean {
  return (CONSUMER_FILTERS[consumer] ?? TRAFFIC_ROLES).includes(role);
}
