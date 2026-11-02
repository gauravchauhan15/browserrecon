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
  "third_party_api",
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

/**
 * Content types that carry an application payload.
 *
 * The `application_api` signal has always read "first-party request with an
 * application payload", and for a long time nothing checked the payload. A
 * scan of a six-page fixture reported ten APIs, six of which were the HTML
 * pages themselves and one a 404 favicon — and everything downstream
 * inherited it: the surface listed documents as endpoints, coverage counted
 * them as runtime APIs, and workflow detection admitted page loads as steps.
 */
const DATA_TYPES =
  /^(application\/(json|[\w.+-]*\+json|xml|x-ndjson|x-protobuf|grpc|graphql|x-www-form-urlencoded)|text\/(xml|event-stream)|multipart\/form-data)/i;

/**
 * CDP resource types the browser fetches for itself.
 *
 * A `Document` is a page, not an endpoint; `Other` is what a favicon arrives
 * as. None of them are requests the application code made, which is what an
 * API call is. Script and stylesheet are here too, so a server that returns
 * the wrong content type for its own bundle does not add an endpoint.
 *
 * A type on this list is only decisive when the response is *not* structured
 * data: `Other` carrying `application/json` is an API whatever the browser
 * called the fetch, and an absent resource type changes nothing.
 */
const BROWSER_RESOURCE_TYPES = new Set([
  "document",
  "stylesheet",
  "image",
  "media",
  "font",
  "script",
  "texttrack",
  "manifest",
  "prefetch",
  "other",
]);

/** A page or a subresource the browser went and got, rather than an API. */
function isBrowserResource(observation: ObservationForRole): boolean {
  const type = observation.resourceType?.toLowerCase();
  if (type === undefined || !BROWSER_RESOURCE_TYPES.has(type)) return false;
  return !DATA_TYPES.test(observation.mimeType ?? "");
}

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
 * The registrable domain, approximated as the last two labels.
 *
 * Deliberately not a public-suffix list. A PSL is a data file that has to be
 * shipped, versioned and refreshed, and its only effect here is on
 * multi-label suffixes — `foo.co.uk` and `bar.co.uk` are read as one site.
 * The consequence is bounded: at worst two unrelated hosts under the same
 * public suffix are treated as the application's own, which lands them in
 * the API inventory with a `same-site` basis a reader can disagree with.
 * Getting `apigw.example.com` wrong, by contrast, loses the API gateway.
 */
function registrableDomain(host: string): string {
  return host.split(".").slice(-2).join(".");
}

/**
 * Whether a host is the application's own, one subdomain over.
 *
 * An application's API almost never lives on the origin its pages are served
 * from. the reference application serves its pages from `the reference application` and its search API
 * from `data-search.apigw.example.com`; matching on origin alone filed that
 * gateway as somebody else's property and dropped it from the inventory —
 * which is to say the scan found the API surface and then discarded it.
 *
 * Origin equality still wins where it applies; this is the fallback, and it
 * is recorded in the verdict's signal so the weaker basis is visible.
 */
function isSameSite(url: string, origins: readonly string[]): boolean {
  const host = hostOf(url);
  if (host === "") return false;
  const site = registrableDomain(host);
  if (site === "" || !site.includes(".")) return false;
  return origins.some((origin) => registrableDomain(hostOf(origin)) === site);
}

/**
 * Resource types that mean application code made the request.
 *
 * `fetch()` and `XMLHttpRequest` are how a page calls an API; the browser
 * never issues either on its own behalf. Used only to decide whether a
 * structured response on a *third-party* host is an endpoint the application
 * uses or a document that happens to be JSON.
 */
const DATA_FETCH_TYPES = new Set(["xhr", "fetch", "eventsource", "websocket"]);

/**
 * The shortest gap that can be a poll rather than a burst.
 *
 * One second. Real heartbeats are seconds to minutes apart; nothing polls at
 * 50 Hz, and everything a page loads at once arrives faster than this.
 */
const MINIMUM_POLL_INTERVAL_MS = 1_000;

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
  // A heartbeat has a period. Requests milliseconds apart are a page load
  // firing everything at once, and at that scale relative jitter is
  // meaningless — two gaps of 2ms and 3ms score 0.2, well inside the
  // tolerance below. The M1 gate caught it: three scans of one fixture
  // disagreed about whether an endpoint was a heartbeat, because the answer
  // depended on scheduler noise. §36.2 requires that answer be stable, and a
  // verdict that flips on milliseconds is not a verdict.
  if (repeatIntervalMs < MINIMUM_POLL_INTERVAL_MS) return false;
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

  // Before the polling check: a token refresh repeats on a timer and would
  // otherwise be filed as a heartbeat, which would hide the auth flow from
  // workflow detection that §17A.3 explicitly wants it included in.
  //
  // Not for a script or an image, though. The pattern matches a substring, so
  // a vendor's `session-replay.js` was being reported as the application's
  // own authentication infrastructure — found by the M3 gate, on a fixture
  // built to be noisy. A login *page* is still auth: `text/html` is not an
  // asset type, so only the bundles and pixels are excused here.
  if (AUTH_PATHS.test(observation.url) && !ASSET_TYPES.test(observation.mimeType ?? "")) {
    return { role: "auth_infrastructure", signal: "path matches an authentication endpoint" };
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

  if (isBrowserResource(observation)) {
    return firstParty
      ? {
          role: "application_asset",
          signal: `first-party ${observation.resourceType} carrying no application payload`,
        }
      : {
          role: "third_party_widget",
          signal: "third-party browser resource from a host not on any list",
        };
  }

  // After the asset checks, not before them. A stylesheet fetched once per
  // page repeats at roughly the interval between page visits, with the
  // evenness of a crawler — so on a four-page fixture the same bundle came
  // back `polling_heartbeat` on some runs and `application_asset` on others,
  // and §36.2's three-identical-runs gate caught it. A repeated asset is a
  // repeated asset whatever its rhythm; only something carrying an
  // application payload can be a heartbeat.
  if (looksLikePolling(observation)) {
    return {
      role: "polling_heartbeat",
      signal: `repeated ${observation.repeatCount} times at a stable interval with no interaction`,
    };
  }

  if (firstParty) {
    return {
      role: "application_api",
      signal: "first-party request with an application payload",
    };
  }

  // One subdomain over is still the application. Checked after the asset and
  // polling rules so a CDN subdomain serving bundles stays an asset.
  if (isSameSite(observation.url, observation.firstPartyOrigins)) {
    return {
      role: "application_api",
      signal: `same-site host ${host} carrying an application payload`,
    };
  }

  // A structured body fetched by application code, on a host that is nobody
  // the lists above recognised.
  //
  // This is an endpoint whatever its registrable domain: a JSON API on a
  // vendor's host is still an API the application depends on, still takes
  // parameters, and is still part of what an attacker can reach through this
  // page. It gets its own role rather than `application_api` so the
  // consumers that must not see it — workflow detection, API sequencing,
  // the coverage denominator — can keep excluding it by name while the
  // inventory reports it.
  if (
    DATA_TYPES.test(observation.mimeType ?? "") &&
    DATA_FETCH_TYPES.has(observation.resourceType?.toLowerCase() ?? "")
  ) {
    return {
      role: "third_party_api",
      signal: `third-party ${observation.mimeType} fetched by application code`,
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
  correlation: [
    "application_api",
    "third_party_api",
    "application_asset",
    "auth_infrastructure",
  ],
  // Not `third_party_api`. A vendor's JSON endpoint belongs in the
  // inventory, and a workflow built across the boundary between an
  // application and its analytics provider is a workflow nobody can act on.
  workflow_detection: ["application_api", "auth_infrastructure"],
  api_sequencing: ["application_api"],
  llm_context: ["application_api"],
  /** The inventory reports every endpoint, whoever operates it. */
  api_inventory: ["application_api", "third_party_api", "auth_infrastructure"],
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
