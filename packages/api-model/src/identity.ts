/**
 * What makes two requests the same API — build plan §14, §23.2;
 * dev plan BR-M2-01.
 *
 * A scan of a shop sees `GET /api/products/1`, `/api/products/2` and eighty
 * more. Those are one endpoint with one handler and one attack surface,
 * observed eighty times. Reporting eighty APIs is not a longer report, it is
 * a wrong one: a reader counting endpoints gets a number that says more
 * about the catalogue's size than about the application.
 *
 * ## Identity is method + origin + route template
 *
 * The query string is deliberately **not** part of it. `/search?q=shoes` and
 * `/search?q=hats` are one endpoint taking a parameter, and splitting them
 * would reintroduce the same inflation the path templating removes. Which
 * parameters were seen is recorded on the API object instead, because *that*
 * is the interesting part — a `role=admin` parameter observed once is a fact
 * about the surface.
 *
 * ## Why templating is conservative in one direction only
 *
 * Collapsing too eagerly is the dangerous error: if `/about` became
 * `/{slug}` then `/about`, `/contact` and `/admin` would be "one route", the
 * scan would report one, and the other two would vanish silently. Collapsing
 * too little merely produces a longer inventory. `inferTemplate` only
 * parameterises a segment on positive evidence that it is an identifier.
 */
import { inferTemplate, type NormalizedUrl } from "@browserrecon/collector-network";

export interface ApiIdentity {
  /** `GET https://shop.example.com/api/products/{id}` */
  readonly key: string;
  readonly method: string;
  readonly origin: string;
  /** Path with identifier segments replaced, or the literal path. */
  readonly pathTemplate: string;
  /**
   * True when at least one segment was parameterised.
   *
   * Derived from the parameter list rather than from whether inference
   * returned anything: `inferTemplate` answers for every http(s) URL, and a
   * path with no identifier segments comes back unchanged. Treating "we got
   * an answer" as "it was templated" would mark every static path templated.
   */
  readonly templated: boolean;
  /** Which rule matched each parameter, in path order, so a reader can check the label. */
  readonly parameters: readonly string[];
}

/**
 * Derive the identity of one observation.
 *
 * Takes the normalized URL rather than a raw string: normalization has
 * already settled case, default ports and the ordering of query keys, and
 * doing it twice in two places is how two components come to disagree about
 * whether two requests are the same.
 */
export function apiIdentity(method: string, url: NormalizedUrl): ApiIdentity {
  const template = inferTemplate(url.raw);
  // `inferTemplate` returns `origin + path`; the path alone is what belongs
  // on the object, with the origin carried separately.
  const pathTemplate =
    template === undefined ? url.path : template.template.slice(template.origin.length);

  return {
    key: `${method.toUpperCase()} ${url.origin}${pathTemplate}`,
    method: method.toUpperCase(),
    origin: url.origin,
    pathTemplate,
    templated: (template?.parameters.length ?? 0) > 0,
    parameters: template?.parameters ?? [],
  };
}

/**
 * Query parameter names seen against an endpoint, with an example value.
 *
 * Names always; values only when they are not secret-shaped. §37.2 puts
 * exports on the redacted side of the boundary, and a query string is one of
 * the commonest places a token ends up — so the example is a convenience
 * that must never become a leak. The redactor runs over the whole document
 * on the way out, but a value dropped here never reaches it at all, which is
 * the cheaper guarantee.
 */
export interface ObservedParameter {
  readonly name: string;
  readonly occurrences: number;
  /** Distinct values seen, capped. Absent when the name looks sensitive. */
  readonly examples?: readonly string[] | undefined;
}

/** Names whose values are never carried, whatever the redactor would do. */
const SENSITIVE_PARAMETER =
  /(?:^|_|-)(?:token|key|secret|password|passwd|pwd|auth|session|sid|jwt|bearer|signature|sig|code|otp|access|refresh|api[_-]?key)(?:$|_|-)/i;

/** Distinct example values kept per parameter. Enough to see a shape. */
const MAX_EXAMPLES = 3;

/**
 * Whether a parameter's value must never be carried.
 *
 * camelCase is separated first: `accessToken` is as common in a query
 * string as `access_token`, and a pattern that only knew about underscores
 * matched half of them. Found by a test on the payload side and applied
 * here too, because the two lists protect the same things.
 */
export function isSensitiveParameterName(name: string): boolean {
  const separated = name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2");
  return SENSITIVE_PARAMETER.test(separated);
}

/** Accumulates parameters across every observation of one endpoint. */
export class ParameterTally {
  readonly #byName = new Map<string, { occurrences: number; examples: Set<string> }>();

  add(query: Readonly<Record<string, string>>): void {
    for (const [name, value] of Object.entries(query)) {
      const existing = this.#byName.get(name) ?? {
        occurrences: 0,
        examples: new Set<string>(),
      };
      existing.occurrences += 1;
      if (!isSensitiveParameterName(name) && existing.examples.size < MAX_EXAMPLES) {
        existing.examples.add(value);
      }
      this.#byName.set(name, existing);
    }
  }

  /** Sorted by name, so the same scan produces the same bytes. */
  snapshot(): readonly ObservedParameter[] {
    return [...this.#byName.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, tally]) => ({
        name,
        occurrences: tally.occurrences,
        ...(isSensitiveParameterName(name)
          ? {}
          : { examples: [...tally.examples].sort((a, b) => a.localeCompare(b)) }),
      }));
  }
}
