/**
 * Coverage dimensions and statuses — build plan §10C.1, §10C.2, §10C.3;
 * dev plan BR-M3-07.
 *
 * §10C opens with the point the whole engine exists for: BrowserRecon
 * optimises for "measurable, explainable coverage, not a false promise of
 * 100% discovery."
 *
 * ## Why thirteen dimensions rather than one number
 *
 * A single percentage hides the thing a reader needs. "72% covered" could
 * mean every page was visited and no JavaScript was parsed, or the reverse,
 * and those are different scans with different conclusions. Tracking them
 * separately is what makes the number explainable, which §10C.4's score then
 * depends on.
 *
 * ## Why nine statuses rather than covered/not
 *
 * §10C.2 lists nine because "not covered" conflates conditions that call for
 * different responses. A candidate that was `blocked` by a WAF, one that is
 * `unreachable_under_current_session`, and one that was `deferred` for being
 * too large are three different facts, and only one of them is a reason to
 * change the scan.
 */

/** §10C.1's thirteen, in the plan's own order. */
export const DIMENSIONS = [
  "url",
  "route",
  "js_asset",
  "js_bytes",
  "first_party_js",
  "runtime_api",
  "static_api_candidate",
  "workflow",
  "api_sequence",
  "state_transition",
  "webmcp",
  "origin",
  "access_barrier",
] as const;

export type Dimension = (typeof DIMENSIONS)[number];

/** §10C.2's nine. */
export const STATUSES = [
  "observed",
  "analyzed",
  "discovered",
  "correlated",
  "unobserved",
  "deferred",
  "blocked",
  "unreachable_under_current_session",
  "unknown",
] as const;

export type CoverageStatus = (typeof STATUSES)[number];

/**
 * Statuses that count as reached.
 *
 * `correlated` is in and `discovered` is not, which is the line §10A.3 draws:
 * a candidate correlated with runtime evidence is surface the scan can speak
 * about, while one merely discovered in a bundle is a string someone wrote.
 */
export const REACHED: ReadonlySet<CoverageStatus> = new Set<CoverageStatus>([
  "observed",
  "analyzed",
  "correlated",
]);

export interface DimensionCoverage {
  readonly dimension: Dimension;
  /** Everything the scan knew about in this dimension. */
  readonly total: number;
  /** Count per status. Always present, so absent ≠ zero. */
  readonly byStatus: Readonly<Record<CoverageStatus, number>>;
  /** Reached over total, or undefined when the dimension found nothing. */
  readonly ratio?: number | undefined;
}

export interface CoverageReport {
  readonly dimensions: readonly DimensionCoverage[];
  /** §10C.3's shape, for a consumer that wants the plan's own layout. */
  readonly summary: {
    readonly javascript: {
      readonly assetsDiscovered: number;
      readonly assetsAnalyzed: number;
      readonly deferredLargeAssets: number;
      readonly partialAssets: number;
      readonly firstPartyAnalysisRatio?: number | undefined;
    };
    readonly api: {
      readonly runtimeObserved: number;
      readonly staticCandidates: number;
      readonly runtimeConfirmedCandidates: number;
      readonly unobservedCandidates: number;
    };
    readonly workflow: {
      readonly candidates: number;
      readonly explored: number;
      readonly unexplored: number;
    };
  };
  /**
   * §10C.6's standing caveat.
   *
   * Carried on the report itself, not left to whoever renders it. A caveat a
   * consumer has to remember to add is one that goes missing exactly when
   * the report is being forwarded.
   */
  readonly caveat: string;
}

export const COVERAGE_CAVEAT =
  "High-confidence coverage of the reachable and analyzable application surface " +
  "under the supplied target policy, authentication state, runtime session, " +
  "exploration budget and analysis limits. This is not a claim of complete " +
  "application coverage, and cannot be.";

/** One thing the scan knew about, in one dimension. */
export interface CoverageItem {
  readonly dimension: Dimension;
  readonly id: string;
  readonly status: CoverageStatus;
}

function emptyCounts(): Record<CoverageStatus, number> {
  const counts = {} as Record<CoverageStatus, number>;
  for (const status of STATUSES) counts[status] = 0;
  return counts;
}

export interface BuildCoverageInput {
  readonly items: readonly CoverageItem[];
  /** Bytes of JavaScript seen and analysed, which items cannot express. */
  readonly jsBytes?: { readonly discovered: number; readonly analyzed: number } | undefined;
}

export function buildCoverage(input: BuildCoverageInput): CoverageReport {
  const byDimension = new Map<Dimension, Record<CoverageStatus, number>>();
  for (const dimension of DIMENSIONS) byDimension.set(dimension, emptyCounts());

  for (const item of input.items) {
    const counts = byDimension.get(item.dimension);
    if (counts === undefined) continue;
    counts[item.status] += 1;
  }

  const dimensions = DIMENSIONS.map((dimension): DimensionCoverage => {
    const byStatus = byDimension.get(dimension) as Record<CoverageStatus, number>;
    const total = Object.values(byStatus).reduce((sum, count) => sum + count, 0);
    const reached = [...REACHED].reduce((sum, status) => sum + byStatus[status], 0);

    return {
      dimension,
      total,
      byStatus,
      // Undefined rather than 0 or 1 when nothing was found. A ratio over an
      // empty set is not 100% covered and it is not 0% covered; it is a
      // question that was not asked, and either number would be a claim.
      ...(total === 0 ? {} : { ratio: reached / total }),
    };
  });

  const at = (dimension: Dimension): Record<CoverageStatus, number> =>
    byDimension.get(dimension) as Record<CoverageStatus, number>;

  const js = at("js_asset");
  const firstPartyJs = at("first_party_js");
  const firstPartyTotal = Object.values(firstPartyJs).reduce((sum, count) => sum + count, 0);
  const api = at("runtime_api");
  const staticApi = at("static_api_candidate");
  const workflow = at("workflow");

  return {
    dimensions,
    summary: {
      javascript: {
        assetsDiscovered: Object.values(js).reduce((sum, count) => sum + count, 0),
        assetsAnalyzed: js.analyzed,
        deferredLargeAssets: js.deferred,
        partialAssets: js.unknown,
        ...(firstPartyTotal === 0
          ? {}
          : { firstPartyAnalysisRatio: firstPartyJs.analyzed / firstPartyTotal }),
      },
      api: {
        runtimeObserved: api.observed,
        staticCandidates: Object.values(staticApi).reduce((sum, count) => sum + count, 0),
        runtimeConfirmedCandidates: staticApi.observed + staticApi.correlated,
        unobservedCandidates: staticApi.unobserved,
      },
      workflow: {
        candidates: Object.values(workflow).reduce((sum, count) => sum + count, 0),
        explored: workflow.observed,
        unexplored: workflow.unobserved,
      },
    },
    caveat: COVERAGE_CAVEAT,
  };
}
