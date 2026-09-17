/**
 * URL identity — build plan §13, §14; dev plan BR-M1-06.
 *
 * Two requests to "the same endpoint" have to be recognisable as such, or
 * every later stage counts one endpoint as thirty. That is what normalization
 * is for here: **an identity key for grouping**, not a replacement for what was
 * observed.
 *
 * ## The danger, stated plainly
 *
 * Most URL normalizers are written for caches and crawlers, where the goal is
 * to collapse anything a server would treat alike. For a security tool that is
 * exactly the wrong instinct, because the differences a cache may ignore are
 * often the finding:
 *
 *   `/Admin` vs `/admin`        different resources on a case-sensitive server
 *   `/users` vs `/users/`       can route to different handlers
 *   `?id=1&id=2`                parameter pollution, and collapsing it removes
 *                               the only evidence it was attempted
 *   `%2e%2e%2f` vs `../`        one is a traversal attempt, the other is a path
 *
 * So this file normalizes only what RFC 3986 declares equivalent, leaves
 * everything else exactly as observed, and never discards the original. Every
 * rule below is either "the RFC says these are the same URL" or "this part is
 * never sent to the server". Anything that needed a judgment call was left
 * out.
 */

/** One normalization rule, with the reason it is safe. */
export interface NormalizationRule {
  readonly name: string;
  readonly what: string;
  readonly why: string;
}

/** The complete set. Nothing else about a URL is changed. */
export const NORMALIZATION_RULES: readonly NormalizationRule[] = [
  {
    name: "scheme-case",
    what: "Lower-case the scheme",
    why: "RFC 3986 §3.1 declares the scheme case-insensitive.",
  },
  {
    name: "host-case",
    what: "Lower-case the host",
    why: "RFC 3986 §3.2.2 declares the host case-insensitive; DNS is too.",
  },
  {
    name: "default-port",
    what: "Drop :80 on http and :443 on https",
    why: "RFC 3986 §3.2.3 — an explicit default port is the same authority.",
  },
  {
    name: "fragment",
    what: "Move the fragment out of the identity, into its own field",
    why: "A fragment is never sent to the server, so it cannot be part of a server-side endpoint's identity. Kept separately because SPA routing lives there (§16).",
  },
  {
    name: "query-order",
    what: "Sort query parameters by name, keeping duplicates and their order",
    why: "Servers overwhelmingly treat parameter order as insignificant. Duplicates are preserved because repeating a name is parameter pollution, and collapsing it would erase the evidence.",
  },
];

/** Deliberately NOT done, and why — the list that keeps this honest. */
export const REFUSED_NORMALIZATIONS: readonly NormalizationRule[] = [
  {
    name: "path-case",
    what: "Lower-casing the path",
    why: "Paths are case-sensitive on most servers. `/Admin` and `/admin` can be different resources, and one of them may be the one that matters.",
  },
  {
    name: "trailing-slash",
    what: "Adding or removing a trailing slash",
    why: "`/users` and `/users/` can route to different handlers, and the difference sometimes bypasses a rule that matched only one form.",
  },
  {
    name: "percent-decoding",
    what: "Decoding percent-encoded characters",
    why: "`%2e%2e%2f` and `../` are not the same observation. One is a traversal attempt; decoding makes it look like an ordinary path.",
  },
  {
    name: "duplicate-params",
    what: "Collapsing repeated query parameters",
    why: "Parameter pollution is attack surface. Two `id` values is a finding, not noise to tidy away.",
  },
  {
    name: "index-files",
    what: "Treating /path/ and /path/index.html as one",
    why: "That is a server convention, not a URL equivalence, and it is wrong as often as it is right.",
  },
];

export interface NormalizedUrl {
  /** Exactly as observed. The evidence, never rewritten (§37.2). */
  readonly raw: string;
  /**
   * The grouping key: scheme, authority, path and sorted query.
   *
   * Two requests with the same key are the same endpoint for counting
   * purposes. They may still differ in ways that matter, which is why `raw`
   * is always there to go back to.
   */
  readonly identity: string;
  readonly origin: string;
  readonly scheme: string;
  readonly host: string;
  /** Present only when the URL carried a non-default one. */
  readonly port?: number | undefined;
  /** Byte-for-byte as observed — not decoded, not case-folded. */
  readonly path: string;
  /** Parameter names in the order they appeared, duplicates included. */
  readonly queryKeys: readonly string[];
  /** Present when the URL had one. Never part of `identity`. */
  readonly fragment?: string | undefined;
  /** Set when the URL could not be parsed; `identity` then falls back to `raw`. */
  readonly malformed?: boolean | undefined;
}

const DEFAULT_PORTS: Readonly<Record<string, string>> = { "http:": "80", "https:": "443" };

/**
 * Build an identity key for a URL.
 *
 * Non-http(s) URLs — `data:`, `blob:`, `chrome-extension:` — are returned with
 * `malformed` unset but an identity of their own scheme and nothing else:
 * there is no authority to group by, and pretending otherwise would put every
 * data URI in one bucket.
 */
export function normalizeUrl(raw: string): NormalizedUrl {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    // A URL the platform cannot parse is still an observation. It groups only
    // with itself, which is the honest answer.
    return {
      raw,
      identity: raw,
      origin: "",
      scheme: "",
      host: "",
      path: "",
      queryKeys: [],
      malformed: true,
    };
  }

  const scheme = parsed.protocol.toLowerCase();
  const host = parsed.hostname.toLowerCase();
  const explicitPort = parsed.port === "" ? undefined : parsed.port;
  const isDefaultPort = explicitPort !== undefined && DEFAULT_PORTS[scheme] === explicitPort;
  const port = explicitPort === undefined || isDefaultPort ? undefined : Number(explicitPort);

  if (scheme !== "http:" && scheme !== "https:") {
    // No authority to group by. `data:` and `blob:` URLs are observations
    // about a page, not about an endpoint.
    return {
      raw,
      identity: `${scheme}${parsed.pathname.slice(0, 64)}`,
      origin: scheme,
      scheme,
      host: "",
      path: parsed.pathname,
      queryKeys: [],
    };
  }

  const authority = port === undefined ? host : `${host}:${port}`;
  const origin = `${scheme}//${authority}`;

  // Sorted by name, stable within a name, duplicates kept. `sort` on the pairs
  // is stable in every engine this runs on, so two identical-but-reordered
  // query strings produce one key while `?id=1&id=2` stays distinct from
  // `?id=2&id=1` only in `raw` — which is where the evidence belongs.
  const pairs = [...parsed.searchParams.entries()];
  const sorted = [...pairs].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const query = sorted.map(([key, value]) => `${key}=${value}`).join("&");

  // `parsed.pathname` is the browser's own normalization of dot segments,
  // which is what actually went on the wire. Case and percent-encoding are
  // left exactly as they arrived.
  const path = parsed.pathname;

  return {
    raw,
    identity: query === "" ? `${origin}${path}` : `${origin}${path}?${query}`,
    origin,
    scheme,
    host,
    ...(port === undefined ? {} : { port }),
    path,
    queryKeys: pairs.map(([key]) => key),
    ...(parsed.hash === "" ? {} : { fragment: parsed.hash }),
  };
}

/** Whether two observed URLs are the same endpoint for grouping purposes. */
export function sameEndpoint(a: string, b: string): boolean {
  return normalizeUrl(a).identity === normalizeUrl(b).identity;
}

/** Render both rule tables, so the README cannot drift from the code. */
export function renderRuleTables(): string {
  const row = (rule: NormalizationRule): string =>
    `| \`${rule.name}\` | ${rule.what} | ${rule.why} |`;
  return [
    "| Rule | What it does | Why it is safe |",
    "| ---- | ------------ | -------------- |",
    ...NORMALIZATION_RULES.map(row),
    "",
    "| Refused | What it would do | Why it is refused |",
    "| ------- | ---------------- | ----------------- |",
    ...REFUSED_NORMALIZATIONS.map(row),
  ].join("\n");
}
