/**
 * Route templates — build plan §9.5.2; dev plan BR-M1-17.
 *
 * `/product/101`, `/product/102` and forty thousand siblings are one route
 * with one handler and one attack surface. Treating them as forty thousand
 * pages spends the entire page budget on a single template and never reaches
 * `/admin`.
 *
 * ## The inference has to be conservative in one specific direction
 *
 * Collapsing too eagerly is the dangerous error. If `/about` becomes
 * `/{slug}` then `/about`, `/contact` and `/admin` are "the same route", the
 * scan visits one of them, and the other two are never seen — a silent
 * coverage hole that looks like a successful scan. Collapsing too little
 * merely wastes budget, which the saturation rule (§9.5.3) then bounds anyway.
 *
 * So a segment becomes a parameter only on positive evidence that it is an
 * identifier: it is numeric, a UUID, a hash, or a slug that *contains* a
 * numeric id. A bare word is never a parameter, however many siblings it has.
 */

/** A segment matcher, with the reason it is safe to treat as an identifier. */
/**
 * Segment matchers, with the reason each is safe to treat as an identifier.
 *
 * **First match wins, so order is by specificity, not by preference.** Two of
 * these were originally in the wrong place and produced correct grouping with
 * the wrong label: a 24-character ObjectId was caught by the generic hex rule,
 * and `2026-01-15` was caught by the slug rule reading it as `2026-01` plus
 * `-15`. Grouping was right either way, which is exactly why it needed a test
 * — the label is what a human reads in the report.
 */
export const PARAMETER_RULES: readonly {
  readonly name: string;
  readonly pattern: RegExp;
  readonly placeholder: string;
  readonly why: string;
}[] = [
  {
    name: "numeric",
    pattern: /^\d+$/,
    placeholder: "{id}",
    why: "A segment that is only digits is an identifier in every routing convention there is.",
  },
  {
    name: "uuid",
    pattern: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    placeholder: "{uuid}",
    why: "A UUID is a generated key and is never a route name someone chose.",
  },
  {
    name: "date",
    // Before the slug rule, which would otherwise read 2026-01-15 as a slug
    // `2026-01` carrying the id `15`.
    pattern: /^\d{4}-\d{2}-\d{2}$/,
    placeholder: "{date}",
    why: "A date segment enumerates; the route behind it does not change with it.",
  },
  {
    name: "object-id",
    // Before the generic hex rule, which also matches 24 hex characters but
    // says less about what they are.
    pattern: /^[0-9a-f]{24}$/i,
    placeholder: "{id}",
    why: "MongoDB's ObjectId shape, common enough in URLs to be worth naming precisely.",
  },
  {
    name: "hash",
    pattern: /^[0-9a-f]{16,}$/i,
    placeholder: "{hash}",
    why: "A long hex run is a content hash or an opaque key, not a word someone chose.",
  },
  {
    name: "slug-with-id",
    // `1234-my-article` or `my-article-1234`: a human-readable slug carrying
    // a numeric id. The id is what varies; the words are decoration.
    pattern: /^(?:\d+-[a-z0-9-]+|[a-z0-9-]+-\d{2,})$/i,
    placeholder: "{slug}",
    why: "A slug with an embedded numeric id varies per record while the route does not.",
  },
];

export interface RouteTemplate {
  /** `https://app.test/product/{id}` — the grouping key. */
  readonly template: string;
  readonly origin: string;
  /** Which rule fired for each parameterised segment, in path order. */
  readonly parameters: readonly string[];
}

/**
 * Infer the template a URL belongs to.
 *
 * The query string is dropped: two requests to the same path with different
 * query parameters are the same route, and §9.5.3's signature comparison is
 * what notices if they behave differently.
 */
export function inferTemplate(url: string): RouteTemplate | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;

  const parameters: string[] = [];
  const segments = parsed.pathname.split("/").map((segment) => {
    if (segment === "") return segment;
    const rule = PARAMETER_RULES.find((candidate) => candidate.pattern.test(segment));
    if (rule === undefined) return segment;
    parameters.push(rule.name);
    return rule.placeholder;
  });

  return {
    template: `${parsed.origin}${segments.join("/")}`,
    origin: parsed.origin,
    parameters,
  };
}

/** Whether two URLs are instances of one route. */
export function sameTemplate(a: string, b: string): boolean {
  const left = inferTemplate(a);
  const right = inferTemplate(b);
  return left !== undefined && right !== undefined && left.template === right.template;
}
