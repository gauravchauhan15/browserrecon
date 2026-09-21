/**
 * Static ↔ runtime reconciliation — build plan §10A.3, §10.3;
 * dev plan BR-M2-12.
 *
 * §10A.3 draws the line this module enforces: **a JavaScript candidate is not
 * an invoked API.** A string in a bundle that looks like an endpoint might be
 * one, or a routing table entry for a feature shipped disabled, or dead code
 * from three years ago. Only the runtime can settle it.
 *
 * So each candidate gets a status:
 *
 *   `observed`   the scan actually called it
 *   `correlated` the scan called something this candidate clearly refers to —
 *                the templated form of an instance, or the same path on a
 *                base the config named
 *   `unobserved` found in code, never reached. Not a failure: it is the most
 *                valuable thing this produces, because it is the surface the
 *                scan could not get to
 *
 * ## Sources merge; they do not replace
 *
 * §10.3: a candidate confirmed at runtime has `sources: [static, runtime]`,
 * not `sources: [runtime]`. The static sighting is what says *where in the
 * code* an endpoint is built, and a report that dropped it on confirmation
 * would lose the file and line exactly for the endpoints that matter most.
 *
 * ## No parser type, no analyzer dependency
 *
 * The inputs are described structurally rather than imported. TypeScript
 * checks it either way, and it keeps this module — which is about the
 * *meeting* of two models — from depending on the machinery of either.
 */

/** What a static candidate has to carry. Satisfied by `ApiCandidate`. */
export interface StaticCandidate {
  readonly path: string;
  readonly confidence: "high" | "medium" | "low";
  readonly sources: readonly { readonly script: string; readonly line: number }[];
  readonly method?: string | undefined;
}

/** What a runtime observation has to carry. Satisfied by `ApiObject`. */
export interface RuntimeEndpoint {
  readonly api_id: string;
  readonly method: string;
  /** Origin + templated path, as the API model builds it. */
  readonly url: string;
  readonly identity: { readonly origin: string; readonly pathTemplate: string };
}

export const RECONCILED_STATUSES = ["observed", "correlated", "unobserved"] as const;
export type ReconciledStatus = (typeof RECONCILED_STATUSES)[number];

export interface ReconciledEndpoint {
  readonly path: string;
  readonly status: ReconciledStatus;
  /** §10.3's merged list, always in this order so a diff is stable. */
  readonly provenance: readonly ("javascript_static_analysis" | "runtime_network")[];
  /** Where in the code it was found. Kept even once observed. */
  readonly staticSources: readonly { readonly script: string; readonly line: number }[];
  /** The runtime object, when there is one. */
  readonly apiId?: string | undefined;
  readonly method?: string | undefined;
  readonly confidence?: StaticCandidate["confidence"] | undefined;
  /** Why this was matched to that observation, when it was correlated. */
  readonly correlationBasis?: string | undefined;
}

export interface ReconcileResult {
  readonly endpoints: readonly ReconciledEndpoint[];
  readonly counts: Readonly<Record<ReconciledStatus, number>>;
  /** Observed endpoints no static candidate predicted. */
  readonly runtimeOnly: number;
}

/**
 * Reduce a path to what two spellings of the same endpoint share.
 *
 * `/api/orders/{id}`, `/api/orders/:id` and `/api/orders/42` are one
 * endpoint written three ways — by the framework, by the developer, and by
 * the browser. Without this, a scan that observed `/api/orders/42` reports
 * `/api/orders/{id}` as unreached, which is the single most misleading thing
 * a coverage number can do: it invents a gap that was covered.
 */
function shape(path: string): string {
  let out = path;
  try {
    // Absolute URLs compare on their path; the origin is handled separately.
    out = new URL(path).pathname;
  } catch {
    // Already a path.
  }
  return out
    .replace(/\?.*$/, "")
    .replace(/\{[^}]*\}/g, "*")
    .replace(/:[A-Za-z_][\w]*/g, "*")
    .replace(/\/\d+(?=\/|$)/g, "/*")
    .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?=\/|$)/gi, "/*")
    .replace(/\/[0-9a-f]{16,}(?=\/|$)/gi, "/*")
    .replace(/\/+$/, "")
    .toLowerCase();
}

export interface ReconcileOptions {
  /**
   * Base paths from configuration, tried as prefixes.
   *
   * A candidate written `/orders` in code reaches `/api/v2/orders` at
   * runtime because `apiBase` said so. Without the base, the candidate looks
   * unreached and the observation looks unpredicted — two wrong answers from
   * one missing fact.
   */
  readonly basePaths?: readonly string[] | undefined;
}

export function reconcile(
  candidates: readonly StaticCandidate[],
  observed: readonly RuntimeEndpoint[],
  options: ReconcileOptions = {},
): ReconcileResult {
  const byShape = new Map<string, RuntimeEndpoint>();
  for (const endpoint of observed) {
    const key = shape(endpoint.identity.pathTemplate);
    if (!byShape.has(key)) byShape.set(key, endpoint);
  }

  const matched = new Set<string>();
  const endpoints: ReconciledEndpoint[] = [];

  for (const candidate of candidates) {
    const exact = byShape.get(shape(candidate.path));
    if (exact !== undefined) {
      matched.add(exact.api_id);
      endpoints.push({
        path: candidate.path,
        status: "observed",
        provenance: ["javascript_static_analysis", "runtime_network"],
        staticSources: candidate.sources,
        apiId: exact.api_id,
        method: exact.method,
        confidence: candidate.confidence,
      });
      continue;
    }

    // Try the configured bases before giving up.
    let correlated: { endpoint: RuntimeEndpoint; basis: string } | undefined;
    for (const base of options.basePaths ?? []) {
      const joined = `${base.replace(/\/+$/, "")}/${candidate.path.replace(/^\/+/, "")}`;
      const found = byShape.get(shape(joined));
      if (found !== undefined) {
        correlated = { endpoint: found, basis: `matched under the configured base ${base}` };
        break;
      }
    }

    if (correlated !== undefined) {
      matched.add(correlated.endpoint.api_id);
      endpoints.push({
        path: candidate.path,
        status: "correlated",
        provenance: ["javascript_static_analysis", "runtime_network"],
        staticSources: candidate.sources,
        apiId: correlated.endpoint.api_id,
        method: correlated.endpoint.method,
        confidence: candidate.confidence,
        correlationBasis: correlated.basis,
      });
      continue;
    }

    endpoints.push({
      path: candidate.path,
      status: "unobserved",
      provenance: ["javascript_static_analysis"],
      staticSources: candidate.sources,
      confidence: candidate.confidence,
    });
  }

  const counts: Record<ReconciledStatus, number> = {
    observed: 0,
    correlated: 0,
    unobserved: 0,
  };
  for (const endpoint of endpoints) counts[endpoint.status] += 1;

  return {
    // Sorted, because this feeds a report that has to diff across runs.
    endpoints: endpoints.sort((a, b) => a.path.localeCompare(b.path)),
    counts,
    runtimeOnly: observed.filter((endpoint) => !matched.has(endpoint.api_id)).length,
  };
}
