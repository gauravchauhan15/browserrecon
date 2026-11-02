/**
 * tree-sitter extraction — build plan §10A.2, §10A.4, §10A.5;
 * dev plan BR-M2-06, BR-M2-07.
 *
 * The one file that knows what a parser is. Everything it returns is in
 * `analyzer.ts`'s vocabulary, and the spike behind choosing tree-sitter is in
 * `docs/architecture/js-analysis-spike.md`.
 *
 * ## Walking, not matching
 *
 * The obvious cheap implementation is a regular expression over the source
 * text, and it is wrong in a way that matters: `"/api/orders"` inside a
 * comment, a log message, or a URL in a licence header all match, and the
 * *position* of a string — is it the first argument of `fetch`, or a property
 * called `apiBase`, or free-floating? — is what separates a high-confidence
 * candidate from a guess. That position only exists in a tree.
 *
 * ## Confidence is assigned by position, not by shape
 *
 * `/api/orders` in the URL argument of a `fetch` call is `high`. The same
 * string sitting in an array somewhere is `low`. The string is identical; what
 * differs is what the code does with it, which is the only real evidence
 * static analysis has.
 */
import Parser from "tree-sitter";
import JavaScript from "tree-sitter-javascript";
import type {
  AnalysisResult,
  AnalyzeInput,
  ApiCandidate,
  CandidateConfidence,
  ConfigCandidate,
  JSAnalyzer,
  OriginCandidate,
  OriginKind,
  RequestLibrary,
  RequestPattern,
  RouteCandidate,
  SourceLocation,
  UrlCandidate,
} from "./analyzer.js";

/** Bumped when any rule below changes. Part of the cache key (§10B.8). */
export const TREE_SITTER_RULE_VERSION = "1.0.0";

/** Default per-file budget. §10B.9 wants one; the caller may override. */
export const DEFAULT_TIME_BUDGET_MS = 10_000;

/**
 * Hosts whose purpose is known from the name alone.
 *
 * Deliberately short and specific. A list that guessed from substrings would
 * classify `api.mycompany.com` as third-party analytics because it contains
 * `an`, and a wrong classification is worse than `unknown` — it moves a
 * first-party endpoint out of the surface a reader is looking at.
 */
const ORIGIN_HINTS: readonly {
  readonly pattern: RegExp;
  readonly kind: OriginKind;
  readonly why: string;
}[] = [
  {
    pattern:
      /(?:^|\.)(?:google-analytics|googletagmanager|segment|mixpanel|amplitude|heap|hotjar|fullstory|datadoghq|sentry|bugsnag|newrelic)\.(?:com|io)$/i,
    kind: "analytics",
    why: "known analytics or monitoring host",
  },
  {
    pattern: /(?:^|\.)(?:stripe|braintree|paypal|adyen|checkout|razorpay|squareup)\.com$/i,
    kind: "payment",
    why: "known payment provider",
  },
  {
    pattern:
      /(?:^|\.)(?:auth0|okta|onelogin|duosecurity|cognito-idp\.[a-z0-9-]+\.amazonaws)\.com$/i,
    kind: "auth",
    why: "known identity provider",
  },
  {
    pattern:
      /(?:^|\.)(?:cloudfront\.net|akamaized\.net|fastly\.net|jsdelivr\.net|unpkg\.com|cdnjs\.cloudflare\.com)$/i,
    kind: "cdn",
    why: "known content delivery network",
  },
  { pattern: /^api\.|(?:^|\.)api\./i, kind: "api", why: "host is named for an API" },
];

/** Paths that look like an API rather than a page. */
const API_PATH = /^\/(?:api|v\d+|rest|graphql|gql|rpc|_api|services?)(?:\/|$)/i;
/**
 * The same markers, in any segment rather than only the first.
 *
 * An API is routed under its service as often as under `/api`:
 * `/search-api/v2/plan/` is a real endpoint on a real site, and anchoring the
 * marker to the start of the path classified it as a page. The marker may
 * also be a word inside a segment — `search-api`, `plan_api` — so the
 * delimiter is explicit rather than a bare substring, which is what made an
 * earlier version call `/capital/` an API.
 */
const API_SEGMENT =
  /\/(?:(?:[a-z0-9]+[-_])?(?:api|rest|graphql|gql|rpc)(?:[-_][a-z0-9]+)?|v\d+)(?:\/|$)/i;
/** A path segment written as a template parameter — strong API evidence. */
const TEMPLATED_PATH = /\/[:{$]/;
/**
 * A path segment the author actually wrote, rather than a hole.
 *
 * `/{slugLanguage}/{slug}` is a template with two parameters and no name:
 * it is how a site writes *every* content URL, and taking it for an endpoint
 * puts a city page at the top of an API inventory. Something literal has to
 * survive before a shape counts as a candidate on its own evidence — unless
 * it sat in a request position, where the position is the evidence and the
 * shape does not have to carry it.
 */
const LITERAL_SEGMENT = /\/[A-Za-z_][\w.-]*/;
/** Anything that could be a path at all. */
const PATH_SHAPED = /^\/(?!\/)[\w\-./{}$:%~]*$/;
/** Extensions that make a path an asset rather than an endpoint. */
const ASSET_EXTENSION =
  /\.(?:js|mjs|css|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|eot|map|txt|xml|json5)$/i;

const REQUEST_FUNCTIONS: Readonly<Record<string, RequestLibrary>> = {
  fetch: "fetch",
  XMLHttpRequest: "xhr",
  axios: "axios",
  WebSocket: "websocket",
  EventSource: "eventsource",
  sendBeacon: "beacon",
};

/** Axios and friends expose one method per verb. */
const METHOD_MEMBERS: Readonly<Record<string, string>> = {
  get: "GET",
  post: "POST",
  put: "PUT",
  patch: "PATCH",
  delete: "DELETE",
  head: "HEAD",
  options: "OPTIONS",
  request: "",
};

/** Config keys that name a service. */
const CONFIG_KEY =
  /^(?:[A-Z_]*(?:API|SERVICE|BACKEND|GATEWAY|ENDPOINT|BASE)[A-Z_]*|(?:api|service|backend|gateway|endpoint)[A-Za-z]*(?:Url|Uri|Base|Host|Origin|Endpoint)?|baseUrl|baseURL|apiBase|apiUrl|apiRoot|serverUrl|graphqlUri|wsUrl)$/;

interface Ctx {
  readonly script: string;
  readonly source: string;
  readonly pageOrigin: string | undefined;
  readonly deadline: number;
}

interface Walker {
  readonly origins: Map<string, OriginCandidate>;
  readonly urls: Map<string, { candidate: UrlCandidate; sources: SourceLocation[] }>;
  readonly apis: Map<string, { candidate: ApiCandidate; sources: SourceLocation[] }>;
  readonly routes: Map<string, { candidate: RouteCandidate; sources: SourceLocation[] }>;
  readonly requests: RequestPattern[];
  readonly config: ConfigCandidate[];
}

let cachedParser: Parser | undefined;

function parser(): Parser {
  if (cachedParser === undefined) {
    cachedParser = new Parser();
    cachedParser.setLanguage(JavaScript as never);
  }
  return cachedParser;
}

/** Line and column for a byte offset, 1-based line as an editor counts. */
export function locateOffset(source: string, offset: number): { line: number; column: number } {
  const clamped = Math.max(0, Math.min(offset, source.length));
  let line = 1;
  let lastBreak = -1;
  for (let index = 0; index < clamped; index += 1) {
    if (source.charCodeAt(index) === 10) {
      line += 1;
      lastBreak = index;
    }
  }
  return { line, column: clamped - lastBreak };
}

/**
 * A template literal's path, with each interpolation as a parameter.
 *
 * `` `/api/orders/${id}` `` becomes `/api/orders/{id}`, which is §10A.3's own
 * example of a candidate. Without this the commonest way modern code writes
 * an endpoint produced a request pattern and no API candidate at all: the
 * URL was "not a literal", so nothing downstream ever saw the path.
 *
 * The interpolation's own source text names the parameter when it is a plain
 * identifier — `{id}` reads better than `{param}` and is what the developer
 * called it. Anything more complicated becomes `{param}`, because the text of
 * `${a.b ? c : d}` is not a parameter name.
 */
function templatePath(text: string): string | undefined {
  if (text.length < 2 || text[0] !== "`" || text[text.length - 1] !== "`") return undefined;
  const inner = text.slice(1, -1);
  if (!inner.includes("${")) return undefined;

  let out = "";
  let index = 0;
  while (index < inner.length) {
    const open = inner.indexOf("${", index);
    if (open === -1) {
      out += inner.slice(index);
      break;
    }
    out += inner.slice(index, open);

    // Balance braces: `${ {a:1}.a }` closes at the right one.
    let depth = 1;
    let cursor = open + 2;
    while (cursor < inner.length && depth > 0) {
      if (inner[cursor] === "{") depth += 1;
      else if (inner[cursor] === "}") depth -= 1;
      cursor += 1;
    }
    if (depth !== 0) return undefined;

    const expression = inner.slice(open + 2, cursor - 1).trim();
    out += /^[A-Za-z_$][\w$]*$/.test(expression) ? `{${expression}}` : "{param}";
    index = cursor;
  }
  return out === "" ? undefined : out;
}

/** Strip the quotes tree-sitter includes in a string node's text. */
function literalOf(text: string): string | undefined {
  const first = text[0];
  if (first !== '"' && first !== "'" && first !== "`") return undefined;
  if (text.length < 2 || text[text.length - 1] !== first) return undefined;
  const inner = text.slice(1, -1);
  // A template literal with an interpolation is an expression, not a value.
  if (first === "`" && inner.includes("${")) return undefined;
  return inner;
}

/**
 * Classify an origin.
 *
 * §10A.4's list mixes two axes: *whose* an origin is (`first_party`,
 * `same_site`, `third_party`) and *what it does* (`api`, `auth`, `cdn`,
 * `payment`, `analytics`). `api.shop.example.com` is honestly both, and one
 * field can only say one thing.
 *
 * Relationship wins, and the service hint goes into `basis`. The reason is
 * which answer changes behaviour: whether an origin is inside the target is
 * what decides if the scan may visit it, and labelling the application's own
 * API host `api` without saying it is first-party reads as an external
 * dependency — which is the reading that would send someone looking in the
 * wrong place. A host that is nobody's relation keeps its service label,
 * because there the service is all there is to say.
 */
function classifyOrigin(
  origin: string,
  pageOrigin: string | undefined,
): { kind: OriginKind; basis: string } {
  let host: string;
  try {
    host = new URL(origin).hostname;
  } catch {
    return { kind: "unknown", basis: "origin could not be parsed" };
  }

  if (origin.startsWith("ws://") || origin.startsWith("wss://")) {
    return { kind: "websocket", basis: "websocket scheme" };
  }

  const hint = ORIGIN_HINTS.find((candidate) => candidate.pattern.test(host));
  const andHint = hint === undefined ? "" : `; also ${hint.why}`;

  if (pageOrigin !== undefined && origin === pageOrigin) {
    return { kind: "first_party", basis: `same origin as the page${andHint}` };
  }

  if (pageOrigin !== undefined) {
    try {
      const pageHost = new URL(pageOrigin).hostname;
      const registrable = (name: string): string => name.split(".").slice(-2).join(".");
      if (registrable(host) === registrable(pageHost)) {
        return {
          kind: "same_site",
          basis: `shares a registrable domain with the page${andHint}`,
        };
      }
    } catch {
      // A page origin we cannot parse tells us nothing; fall through.
    }
    // Not ours. Here the service label is the whole of what is worth saying.
    if (hint !== undefined) return { kind: hint.kind, basis: hint.why };
    return { kind: "third_party", basis: "different registrable domain from the page" };
  }

  if (hint !== undefined) return { kind: hint.kind, basis: hint.why };
  return { kind: "unknown", basis: "no page origin to compare against" };
}

function addOrigin(walker: Walker, origin: string, location: SourceLocation, ctx: Ctx): void {
  const existing = walker.origins.get(origin);
  if (existing !== undefined) {
    // Cap the source list: a bundle referencing one origin four hundred times
    // makes the record unreadable and says nothing the first few did not.
    if (existing.sources.length < 5) {
      walker.origins.set(origin, { ...existing, sources: [...existing.sources, location] });
    }
    return;
  }
  const { kind, basis } = classifyOrigin(origin, ctx.pageOrigin);
  walker.origins.set(origin, { origin, kind, basis, sources: [location] });
}

function record<T extends { confidence: CandidateConfidence }>(
  into: Map<string, { candidate: T; sources: SourceLocation[] }>,
  key: string,
  candidate: T,
  location: SourceLocation,
): void {
  const existing = into.get(key);
  if (existing === undefined) {
    into.set(key, { candidate, sources: [location] });
    return;
  }
  if (existing.sources.length < 5) existing.sources.push(location);
  // The strongest evidence anywhere wins: one confident sighting is what the
  // candidate is worth, however many weak ones surround it.
  const rank: Record<CandidateConfidence, number> = { high: 0, medium: 1, low: 2 };
  if (rank[candidate.confidence] < rank[existing.candidate.confidence]) {
    into.set(key, { candidate, sources: existing.sources });
  }
}

/** Classify a string literal and file it under every category it fits. */
function considerString(
  walker: Walker,
  value: string,
  location: SourceLocation,
  confidence: CandidateConfidence,
  ctx: Ctx,
): void {
  if (value === "" || value.length > 2048) return;

  if (/^(?:https?|wss?):\/\//i.test(value)) {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      return;
    }
    addOrigin(walker, parsed.origin, location, ctx);
    record(walker.urls, value, { value, absolute: true, confidence, sources: [] }, location);
    if (API_PATH.test(parsed.pathname) || TEMPLATED_PATH.test(parsed.pathname)) {
      record(
        walker.apis,
        `${parsed.origin}${parsed.pathname}`,
        {
          path: `${parsed.origin}${parsed.pathname}`,
          confidence,
          basis: "absolute URL whose path looks like an API",
          sources: [],
        },
        location,
      );
    }
    return;
  }

  if (!PATH_SHAPED.test(value)) return;
  record(walker.urls, value, { value, absolute: false, confidence, sources: [] }, location);

  if (ASSET_EXTENSION.test(value)) return;

  if (API_PATH.test(value)) {
    record(
      walker.apis,
      value,
      { path: value, confidence, basis: "path is under an API prefix", sources: [] },
      location,
    );
    return;
  }
  if (API_SEGMENT.test(value)) {
    record(
      walker.apis,
      value,
      {
        path: value,
        confidence,
        basis: "a path segment names an API or a version",
        sources: [],
      },
      location,
    );
    return;
  }
  if (TEMPLATED_PATH.test(value) && (confidence === "high" || LITERAL_SEGMENT.test(value))) {
    record(
      walker.apis,
      value,
      {
        path: value,
        confidence: confidence === "high" ? "high" : "medium",
        basis: "path contains a route parameter",
        sources: [],
      },
      location,
    );
    return;
  }

  // Everything else path-shaped is a client route candidate: a screen, not an
  // endpoint. Low by default because a bare `/checkout` in a bundle is as
  // likely to be a string as a route.
  record(
    walker.routes,
    value,
    { path: value, confidence: "low", basis: "path-shaped string literal", sources: [] },
    location,
  );
}

/** How often to check the clock. Checking per node costs more than it saves. */
const BUDGET_CHECK_INTERVAL = 4096;

/**
 * A method that answers with the root an endpoint hangs off.
 *
 * `getApiBaseUrl`, `getFavoritesApiBaseUrl`, `getRecommenderApiBaseUrl`,
 * `apiBase`, `baseURL`. Named rather than guessed at because this is the one
 * thing that makes a bare `login/email/otp/` legible: on its own it is a
 * string with a slash in it, and in `getApiBaseUrl("4.2") + it` it is an
 * endpoint.
 */
const BASE_URL_NAME = /api.*base|base.*api|base.*url|url.*base/i;

/**
 * A regex matcher reduced to the path shape it matches.
 *
 * A bundle does not always list endpoints as paths. It lists the patterns it
 * matches *against* paths — `plans/trending/[a-zA-Z]+/filters/`,
 * `orders/[0-9]+/tax-documents/`, `vouchers/cart/.+/apply/` — and each one
 * names an endpoint exactly as precisely as a template literal does. This is
 * `templatePath` for the other notation: every variable part becomes a
 * `{param}` hole, and nothing is invented to fill it.
 *
 * Returns `undefined` rather than guessing when the pattern uses anything it
 * cannot reduce. A missed endpoint costs a row; a mangled one is a row that
 * sends somebody looking for a URL that was never there.
 */
function regexPathShape(value: string): string | undefined {
  // Anchors and a trailing optional query, which are about matching rather
  // than about the path.
  let out = value
    .replace(/^\^/, "")
    .replace(/\(\?:\\\?\.\*\)\?\$?$/, "")
    .replace(/\$$/, "")
    // `vouchers/?` — the slash is optional, the endpoint is not.
    .replace(/\/\?$/, "/");

  // A lookahead excludes a path, it does not name a segment of one:
  // `payment(?!/payment-gateways-per-method)` matches `payment`, and
  // reducing the assertion to a hole invented `payment{param}`.
  out = out.replace(/\(\?[=!][^()]*\)/g, "");

  // Every variable part, in one vocabulary. Order matters: a quantified
  // character class has to go before the bare quantifiers inside it.
  out = out
    .replace(/\(\?:[^()]*\)[*+?]?/g, "{param}")
    .replace(/\([^()]*\)[*+?]?/g, "{param}")
    .replace(/\[[^\]]*\][*+?]?/g, "{param}")
    .replace(/\.[*+]/g, "{param}")
    .replace(/(?<=\/)\*/g, "{param}");

  // Anything left that belongs to a regex and not to a path means this was
  // not reducible, and a half-reduced pattern is worse than none: the caller
  // falls back to the raw literal, which the path-shape tests then reject.
  //
  // Belt and braces, and known to be: those shape tests allow none of these
  // characters except `$`, so a probe that removes this line changes nothing
  // on any pattern short of `/orders/(a)$x/`. It stays because it states the
  // intent at the point the reduction gives up, rather than leaving that to
  // a regex three functions away.
  if (/[\\^$*+?()[\]|]/.test(out)) return undefined;
  // Collapse `{param}{param}` from adjacent groups, and tidy `//`.
  out = out.replace(/(?:\{param\}){2,}/g, "{param}").replace(/\/{2,}/g, "/");
  return out === "" || out === "/" ? undefined : out;
}

/** A relative endpoint path — no leading slash, because a base supplies it. */
const RELATIVE_PATH_SHAPED = /^[\w\-.{}~]+(?:\/[\w\-.{}~]*)*$/;

/**
 * A template literal that begins with the API base and continues as a path.
 *
 *   `${this.#r.getApiBaseUrl(`4.1`)}loyalty/status/`
 *   `${this.#n.getApiBaseUrl(`5.0`)}login/${user.id}/account-email/`
 *
 * This is how the application under test writes nearly every call it makes,
 * and it is a stronger signal than anything else this file reads: the author
 * has said, in the string itself, that what follows hangs off the API base.
 * Nothing had to be inferred and no variable had to be followed.
 *
 * The base's own value is still a runtime value. What is resolvable is the
 * version the getter was called with, and the path after it — which together
 * are the endpoint under whatever origin the application picks (§10A.5: the
 * origin is not invented).
 */
function baseRelativeTemplate(
  text: string,
): { readonly path: string; readonly getter: string; readonly argument?: string } | undefined {
  if (text.length < 2 || text[0] !== "`" || text[text.length - 1] !== "`") return undefined;
  const inner = text.slice(1, -1);
  // The base has to be the whole start of the string. `/foo/${base}` is a
  // path with something interpolated into it, not a path hanging off a base.
  if (!inner.startsWith("${")) return undefined;

  let depth = 1;
  let cursor = 2;
  while (cursor < inner.length && depth > 0) {
    if (inner[cursor] === "{") depth += 1;
    else if (inner[cursor] === "}") depth -= 1;
    cursor += 1;
  }
  if (depth !== 0) return undefined;

  const expression = inner.slice(2, cursor - 1).trim();
  const call = /([A-Za-z_$][\w$]*)\s*\(\s*(?:[`'"]([^`'"]*)[`'"])?\s*\)$/.exec(expression);
  if (call === null) return undefined;
  const getter = call[1] as string;
  if (!BASE_URL_NAME.test(getter)) return undefined;

  const remainder = inner.slice(cursor);
  if (remainder === "") return undefined;
  // The rest of the template, with its own interpolations reduced to holes
  // the same way every other path is.
  const rest = remainder.includes("${") ? templatePath(`\`${remainder}\``) : remainder;
  if (rest === undefined) return undefined;
  if (!RELATIVE_PATH_SHAPED.test(rest) && !PATH_SHAPED.test(rest)) return undefined;

  const argument = call[2];
  const prefix = argument === undefined || argument === "" ? "" : `/${argument}`;
  const path = rest.startsWith("/") ? `${prefix}${rest}` : `${prefix}/${rest}`;
  // `${base}${path}` names no endpoint: the base is known to be an API root
  // and the rest is a variable. Reporting `/{path}` as a candidate is a row
  // that tells a reader nothing and costs them a line to read.
  if (!LITERAL_SEGMENT.test(path)) return undefined;
  return argument === undefined || argument === ""
    ? { path, getter }
    : { path, getter, argument };
}

/**
 * The base an array of paths is concatenated with, where the code says.
 *
 * The shape this reads is the one real bundles use:
 *
 *   const o = [`login/email/otp/`, `orders/.+/`];
 *   return o.map(p => new RegExp(getApiBaseUrl(`4.2`) + p));
 *
 * The array and the base are two statements apart, so the link is made by
 * name: find `<name>.map(` in the enclosing function and read the base call
 * out of the callback. Local to one function and one variable — anything
 * wider would be a dataflow engine, and anything narrower would miss the
 * only form this appears in.
 *
 * Returns the getter's name and its literal argument, which is usually an API
 * version. The host is a runtime value and stays one: §10A.5 forbids
 * inventing what cannot be resolved statically, and a fabricated origin is
 * the worst possible thing to put in an endpoint inventory.
 */
function baseUrlFor(
  array: Parser.SyntaxNode,
): { readonly getter: string; readonly argument?: string } | undefined {
  const declarator = array.parent;
  if (declarator?.type !== "variable_declarator") return undefined;
  const name = declarator.childForFieldName("name")?.text;
  if (name === undefined || name === "") return undefined;

  // The enclosing function, as a bound on how far the name is trusted.
  let scope: Parser.SyntaxNode | null = declarator;
  while (scope !== null && !/function|method_definition|arrow_function/.test(scope.type)) {
    scope = scope.parent;
  }
  if (scope === null) return undefined;

  // `name.map(` ... `someBaseUrl(` ... `)` within the same call.
  const uses = new RegExp(
    `\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\.\\s*map\\s*\\(`,
    "g",
  );
  for (let match = uses.exec(scope.text); match !== null; match = uses.exec(scope.text)) {
    const tail = scope.text.slice(match.index, match.index + 300);
    const call = /([A-Za-z_$][\w$]*)\s*\(\s*(?:[`'"]([^`'"]*)[`'"])?\s*\)/g;
    for (let found = call.exec(tail); found !== null; found = call.exec(tail)) {
      const getter = found[1] as string;
      if (!BASE_URL_NAME.test(getter)) continue;
      const argument = found[2];
      return argument === undefined || argument === "" ? { getter } : { getter, argument };
    }
  }
  return undefined;
}

/**
 * An array of path literals where at least one is plainly an API.
 *
 * The signal §10A.3 was missing on real input. A bundle lists its endpoints
 * together — an interceptor's match list, a route table, a cache key set —
 * and most entries carry no marker at all:
 *
 *   [`/custom_main_plans_for_user/`, `/onboarding/answers/`,
 *    `/category/skeleton/`, `/v2/plan/`, `/search-api/v2/plan/`]
 *
 * Read one string at a time, `/v2/plan/` is an endpoint and
 * `/category/skeleton/` is a page, and nothing about either string says
 * otherwise. Read as a list, they are one table: the array is the evidence,
 * and it is as structural as a call site.
 *
 * Deliberately narrow, because the cost of being wrong is a page in the API
 * inventory:
 *
 *   - at least two path-shaped literals, so a lone string in an array is not
 *     a table;
 *   - at least one of them an API by its own path, so an array of routes
 *     stays an array of routes;
 *   - `low` confidence on the promoted entries, because the evidence is the
 *     company a string keeps rather than anything about the string.
 */
function visitPathTable(node: Parser.SyntaxNode, walker: Walker, ctx: Ctx): void {
  // The base first: it decides whether a relative entry counts at all.
  const base = baseUrlFor(node);
  const paths: { value: string; node: Parser.SyntaxNode }[] = [];

  for (const child of node.namedChildren) {
    if (child.type !== "string" && child.type !== "template_string") continue;
    const literal = literalOf(child.text) ?? templatePath(child.text);
    if (literal === undefined) continue;
    const value = regexPathShape(literal) ?? literal;
    if (ASSET_EXTENSION.test(value)) continue;

    // A relative path is admitted only on the base's evidence. Without it,
    // "a string containing a slash" is `text/html`, `utf-8`, every MIME type
    // and half the minified noise in a bundle.
    const shaped =
      PATH_SHAPED.test(value) || (base !== undefined && RELATIVE_PATH_SHAPED.test(value));
    if (!shaped) continue;
    paths.push({ value, node: child });
  }

  // The minimum is about the *basis*, so it only applies where the basis is
  // the siblings. A lone API path reported as "listed alongside API paths"
  // describes company it does not keep — but one reported as relative to a
  // base it is demonstrably concatenated with is simply true, and an array
  // where only one entry reduced cleanly should not lose that entry too.
  if (base === undefined) {
    if (paths.length < 2) return;
    if (!paths.some((entry) => API_PATH.test(entry.value) || API_SEGMENT.test(entry.value))) {
      return;
    }
  }

  for (const entry of paths) {
    // The version the getter was called with, where it named one. The host
    // is a runtime value and is not invented (§10A.5) — what this produces
    // is the path an endpoint hangs at under whatever base the application
    // resolves, which is also the form the runtime reconciler matches on.
    const prefix = base?.argument === undefined ? "" : `/${base.argument}`;
    const path = entry.value.startsWith("/")
      ? `${prefix}${entry.value}`
      : `${prefix}/${entry.value}`;

    record(
      walker.apis,
      path,
      {
        path,
        confidence: "low",
        basis:
          base === undefined
            ? "listed in an array alongside API paths"
            : `relative to ${base.getter}(${base.argument === undefined ? "" : `"${base.argument}"`})`,
        sources: [],
      },
      locationOf(entry.node, ctx),
    );
  }
}

/**
 * Walk the tree once, filing everything interesting.
 *
 * One pass rather than one per category: the tree is the expensive thing, and
 * the spike measured a full walk of 7.29 MiB at 727 ms — six walks would be
 * four seconds for the same information.
 *
 * Returns whether the time budget stopped it.
 */
function walk(root: Parser.SyntaxNode, walker: Walker, ctx: Ctx): boolean {
  const cursor = root.walk();
  let visited = 0;
  let depth = 0;

  for (;;) {
    visited += 1;
    if (visited % BUDGET_CHECK_INTERVAL === 0 && Date.now() > ctx.deadline) return true;

    const node = cursor.currentNode;
    switch (node.type) {
      case "call_expression":
      case "new_expression":
        visitCall(node, walker, ctx);
        break;
      case "array":
        visitPathTable(node, walker, ctx);
        break;
      case "string":
      case "template_string": {
        if (claimed.has(node.id)) break;
        // A string not already claimed by a call site. Low confidence by
        // construction: position is the evidence, and this one has none.
        //
        // The template branch is not a refinement — it is most of what this
        // case finds on real input. `literalOf` returns nothing for a
        // template with an interpolation, which is correct for a *value* and
        // was being applied to candidate extraction too: a scan of 110
        // minified first-party bundles produced zero API candidates, because
        // the only way those bundles name an endpoint is
        // `` `/api/v2/orders/${id}` ``, and every one of them was discarded
        // one step before anything looked at it.
        //
        // Minification is why this is the last signal standing. The call-site
        // rules need a callee named like a request — `fetch`, or a verb on
        // something called `api`/`http`/`client` — and a bundler renames the
        // wrapper to `r`. The literal is all that survives.
        // Before anything else: a template that *starts* with the API base
        // has said what it is. `medium`, not `low` — the evidence is the
        // author's own concatenation rather than the shape of a string.
        const relative = baseRelativeTemplate(node.text);
        if (relative !== undefined) {
          record(
            walker.apis,
            relative.path,
            {
              path: relative.path,
              confidence: "medium",
              basis: `relative to ${relative.getter}(${relative.argument === undefined ? "" : `"${relative.argument}"`})`,
              sources: [],
            },
            locationOf(node, ctx),
          );
          break;
        }

        const value = literalOf(node.text) ?? templatePath(node.text);
        if (value !== undefined) {
          considerString(walker, value, locationOf(node, ctx), "low", ctx);
        }
        break;
      }
      case "pair":
      case "variable_declarator":
      case "assignment_expression":
        visitAssignment(node, walker, ctx);
        break;
      default:
        break;
    }

    if (cursor.gotoFirstChild()) {
      depth += 1;
      continue;
    }
    while (!cursor.gotoNextSibling()) {
      if (depth === 0) return false;
      cursor.gotoParent();
      depth -= 1;
    }
  }
}

/**
 * Strings already attributed to a call site.
 *
 * Module-scoped and cleared per analysis: a string that is the URL argument of
 * `fetch` must not also be filed as a stray low-confidence literal, or every
 * confident candidate acquires a weak duplicate that outvotes nothing but
 * clutters the record.
 */
const claimed = new Set<number>();

function locationOf(node: Parser.SyntaxNode, ctx: Ctx): SourceLocation {
  return {
    script: ctx.script,
    // tree-sitter counts rows from 0; editors and stack traces count from 1.
    line: node.startPosition.row + 1,
    column: node.startPosition.column + 1,
  };
}

/** The callee's name, and the object it hung off, where there was one. */
function calleeOf(node: Parser.SyntaxNode): { name: string; object?: string } {
  const callee = node.childForFieldName("function") ?? node.childForFieldName("constructor");
  if (callee === null) return { name: "" };
  if (callee.type === "identifier") return { name: callee.text };
  if (callee.type === "member_expression") {
    const property = callee.childForFieldName("property");
    const object = callee.childForFieldName("object");
    return {
      name: property?.text ?? "",
      ...(object === null ? {} : { object: object.text }),
    };
  }
  return { name: callee.text };
}

/** Named arguments of a call, skipping punctuation. */
function argumentsOf(node: Parser.SyntaxNode): Parser.SyntaxNode[] {
  const list = node.childForFieldName("arguments");
  if (list === null) return [];
  return list.namedChildren;
}

/**
 * A request-building call site.
 *
 * This is where confidence comes from: the URL argument of `fetch` is a URL
 * because of where it sits, not because it looks like one.
 */
function visitCall(node: Parser.SyntaxNode, walker: Walker, ctx: Ctx): void {
  const { name, object } = calleeOf(node);

  let library: RequestLibrary | undefined = REQUEST_FUNCTIONS[name];
  let method: string | undefined;

  // `axios.post(...)`, `api.get(...)`, `http.delete(...)` — a verb method on
  // something. The object's name is not checked: a wrapper called `api` or
  // `client` is the common case, and demanding `axios` literally would miss
  // almost every real codebase.
  if (library === undefined && object !== undefined && name in METHOD_MEMBERS) {
    const verb = METHOD_MEMBERS[name];
    if (
      verb !== undefined &&
      verb !== "" &&
      /^(?:axios|api|http|client|request|rest|fetcher)/i.test(object)
    ) {
      library = "axios";
      method = verb;
    }
  }

  // `xhr.open("POST", "/api/x")`
  if (library === undefined && name === "open" && object !== undefined) {
    const args = argumentsOf(node);
    const verb = args[0] === undefined ? undefined : literalOf(args[0].text);
    if (verb !== undefined && /^(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/i.test(verb)) {
      library = "xhr";
      method = verb.toUpperCase();
    }
  }

  // A GraphQL document is a request even though the call names no URL.
  if (library === undefined && /^(?:gql|graphql)$/i.test(name)) library = "graphql";

  if (library === undefined) return;

  const args = argumentsOf(node);
  // xhr.open puts the URL second; everything else puts it first.
  const urlIndex = library === "xhr" && method !== undefined ? 1 : 0;
  const urlArg = args[urlIndex];
  if (urlArg === undefined) return;

  const literal = literalOf(urlArg.text);
  if (literal !== undefined) {
    claimed.add(urlArg.id);
    // High: a literal in a request position is the strongest static evidence
    // there is.
    considerString(walker, literal, locationOf(urlArg, ctx), "high", ctx);
  } else {
    // A template literal in a request position. Still high confidence —
    // the position is the evidence, and interpolation does not weaken it.
    const path = templatePath(urlArg.text);
    if (path !== undefined) {
      claimed.add(urlArg.id);
      considerString(walker, path, locationOf(urlArg, ctx), "high", ctx);
    }
  }

  // `fetch(url, { method: "POST", body: ... })`
  let bodyExpression: string | undefined;
  const options = args[urlIndex + 1];
  if (options !== undefined && options.type === "object") {
    for (const pair of options.namedChildren) {
      if (pair.type !== "pair") continue;
      const key =
        literalOf(pair.childForFieldName("key")?.text ?? "") ??
        pair.childForFieldName("key")?.text;
      const value = pair.childForFieldName("value");
      if (key === "method" && value !== null && value !== undefined) {
        method = literalOf(value.text)?.toUpperCase() ?? method;
      }
      if (key === "body" && value !== null && value !== undefined) {
        bodyExpression = value.text.slice(0, 200);
      }
    }
  }

  walker.requests.push({
    library,
    ...(method === undefined || method === "" ? {} : { method }),
    // §10A.5: the source text, never a guess at what it resolves to.
    urlExpression: urlArg.text.slice(0, 500),
    ...(literal === undefined ? {} : { urlLiteral: literal }),
    ...(bodyExpression === undefined ? {} : { bodyExpression }),
    source: locationOf(urlArg, ctx),
  });
}

/** A named thing holding a URL — `apiBase`, `API_URL`, `{ baseURL: ... }`. */
function visitAssignment(node: Parser.SyntaxNode, walker: Walker, ctx: Ctx): void {
  const keyNode =
    node.childForFieldName("key") ??
    node.childForFieldName("name") ??
    node.childForFieldName("left");
  const valueNode = node.childForFieldName("value") ?? node.childForFieldName("right");
  if (
    keyNode === null ||
    keyNode === undefined ||
    valueNode === null ||
    valueNode === undefined
  )
    return;

  const key = literalOf(keyNode.text) ?? keyNode.text;
  if (!CONFIG_KEY.test(key)) return;

  const literal = literalOf(valueNode.text);
  if (literal !== undefined) {
    claimed.add(valueNode.id);
    // Medium, not high: a config key names a service, but the value may be a
    // placeholder replaced at build time.
    considerString(walker, literal, locationOf(valueNode, ctx), "medium", ctx);
  }

  walker.config.push({
    key,
    ...(literal === undefined ? {} : { value: literal }),
    ...(literal === undefined ? { expression: valueNode.text.slice(0, 200) } : {}),
    source: locationOf(valueNode, ctx),
  });
}

export interface TreeSitterAnalyzerOptions {
  readonly timeBudgetMs?: number | undefined;
}

export function createTreeSitterAnalyzer(options: TreeSitterAnalyzerOptions = {}): JSAnalyzer {
  const analyze = (input: AnalyzeInput): AnalysisResult => {
    const started = Date.now();
    const budget = input.timeBudgetMs ?? options.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS;
    const ctx: Ctx = {
      script: input.script,
      source: input.source,
      pageOrigin: input.pageOrigin,
      deadline: started + budget,
    };

    const walker: Walker = {
      origins: new Map(),
      urls: new Map(),
      apis: new Map(),
      routes: new Map(),
      requests: [],
      config: [],
    };

    // Cleared per analysis: it is a within-one-walk detail, and leaking it
    // between files would let one script's call site silence another's.
    claimed.clear();

    let status: AnalysisResult["status"] = "complete";
    let limitReason: string | undefined;

    try {
      const tree = parser().parse(input.source);
      if (tree.rootNode.hasError) {
        // Not a failure. §10B.9 and the spike: a truncated or partly
        // unparseable bundle still names every endpoint before the break,
        // and discarding that to report cleanly helps nobody.
        status = "partial";
        limitReason = "the source did not parse completely; results cover what did";
      }
      const hitBudget = walk(tree.rootNode, walker, ctx);
      if (hitBudget) {
        status = "partial";
        limitReason = `analysis stopped at the ${budget} ms budget`;
      }
    } catch (error) {
      status = "failed";
      limitReason = error instanceof Error ? error.message : String(error);
    }

    const sorted = <T>(map: Map<string, { candidate: T; sources: SourceLocation[] }>): T[] =>
      [...map.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([, entry]) => ({ ...entry.candidate, sources: entry.sources }) as T);

    // A path promoted by its siblings was filed as a route first, by the
    // string visit that ran before the array's. One answer per path: a
    // report listing `/category/skeleton/` as both a screen and an endpoint
    // is a report disagreeing with itself.
    for (const path of walker.apis.keys()) walker.routes.delete(path);

    return {
      script: input.script,
      origins: [...walker.origins.values()].sort((a, b) => a.origin.localeCompare(b.origin)),
      urls: sorted(walker.urls),
      apis: sorted(walker.apis),
      routes: sorted(walker.routes),
      requests: walker.requests,
      config: walker.config,
      status,
      ...(limitReason === undefined ? {} : { limitReason }),
      durationMs: Date.now() - started,
      bytes: Buffer.byteLength(input.source),
    };
  };

  return {
    name: "tree-sitter",
    ruleVersion: TREE_SITTER_RULE_VERSION,
    analyze,
    extractOrigins: (input) => analyze(input).origins,
    extractUrls: (input) => analyze(input).urls,
    extractApiCandidates: (input) => analyze(input).apis,
    extractRouteCandidates: (input) => analyze(input).routes,
    extractRequestPatterns: (input) => analyze(input).requests,
    extractConfigCandidates: (input) => analyze(input).config,
    locateSource: (source, offset) => locateOffset(source, offset),
  };
}
