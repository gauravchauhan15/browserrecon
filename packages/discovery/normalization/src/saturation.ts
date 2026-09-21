/**
 * Template saturation with divergence detection — build plan §9.5.3;
 * dev plan BR-M1-17b.
 *
 * A catalogue with 47,218 products has 47,218 URLs and one route. Visiting
 * three of them tells you what the route does; visiting the rest tells you
 * nothing and costs the entire scan.
 *
 * ## Divergence is the part that matters
 *
 * The naive rule — "visit N, skip the rest" — is wrong in the one case worth
 * catching. If `/order/1` and `/order/2` behave identically, the template is
 * uniform and three samples describe it. If `/order/1` returns a summary and
 * `/order/2` fires an admin API, the template is *not* uniform, and the
 * instance that behaves differently is exactly the one a security tool exists
 * to find. Saturating past that is not a saving, it is the bug.
 *
 * So saturation requires the signatures to *match*. Divergence blocks it,
 * records a `template_divergence` observation, and raises the sampling cap —
 * and §28 reads that observation later as authorization-context input, since
 * two instances of one route behaving differently is often an access-control
 * difference.
 *
 * ## Nothing is silently lost
 *
 * §45's rule: a skipped instance is counted and reported. "3 of 47,218
 * visited, 47,215 skipped as template-equivalent" is an honest sentence; a
 * report that simply shows three orders is not.
 */

/**
 * What an instance did, reduced to something comparable.
 *
 * Deliberately coarse. Two product pages differ in their text and their
 * image URLs and that is not divergence; they differ in *which APIs they
 * call* and *what the server let them see*, and that is. Comparing anything
 * finer would make every instance divergent and saturation would never fire.
 */
export interface SignalSignature {
  /** Application API paths the page called, sorted and de-duplicated. */
  readonly apiPaths: readonly string[];
  /** Status codes seen, sorted — a 200 and a 403 are not the same page. */
  readonly statuses: readonly number[];
  /** Coarse DOM shape: form count, link count bucketed, presence of tables. */
  readonly domShape: string;
  /** The auth context the instance was observed under (§12.3). */
  readonly authContext: string;
}

/** Build a comparable signature. Deterministic — golden output reads it. */
export function buildSignature(input: {
  readonly apiPaths: readonly string[];
  readonly statuses: readonly number[];
  readonly formCount: number;
  readonly linkCount: number;
  readonly hasTable: boolean;
  readonly authContext: string;
}): SignalSignature {
  return {
    apiPaths: [...new Set(input.apiPaths)].sort(),
    statuses: [...new Set(input.statuses)].sort((a, b) => a - b),
    // Link counts are bucketed because a catalogue page with 24 links and one
    // with 25 is the same page. Forms are not bucketed: one extra form is a
    // different capability.
    domShape: `forms=${input.formCount};links~${bucket(input.linkCount)};table=${input.hasTable}`,
    authContext: input.authContext,
  };
}

function bucket(count: number): string {
  if (count === 0) return "0";
  if (count <= 5) return "1-5";
  if (count <= 20) return "6-20";
  if (count <= 100) return "21-100";
  return "100+";
}

export function signaturesMatch(a: SignalSignature, b: SignalSignature): boolean {
  return (
    a.domShape === b.domShape &&
    a.authContext === b.authContext &&
    a.apiPaths.length === b.apiPaths.length &&
    a.apiPaths.every((path, index) => path === b.apiPaths[index]) &&
    a.statuses.length === b.statuses.length &&
    a.statuses.every((status, index) => status === b.statuses[index])
  );
}

/** Why two signatures differed, in words a report can print. */
export function describeDivergence(a: SignalSignature, b: SignalSignature): string[] {
  const reasons: string[] = [];
  if (a.authContext !== b.authContext) {
    reasons.push(
      `observed under different auth contexts (${a.authContext} vs ${b.authContext})`,
    );
  }
  if (a.domShape !== b.domShape)
    reasons.push(`different page shape (${a.domShape} vs ${b.domShape})`);

  const onlyInB = b.apiPaths.filter((path) => !a.apiPaths.includes(path));
  const onlyInA = a.apiPaths.filter((path) => !b.apiPaths.includes(path));
  if (onlyInA.length > 0 || onlyInB.length > 0) {
    reasons.push(`different API calls (${[...onlyInA, ...onlyInB].join(", ")})`);
  }

  const statusDiff = [...new Set([...a.statuses, ...b.statuses])].filter(
    (status) => !a.statuses.includes(status) || !b.statuses.includes(status),
  );
  if (statusDiff.length > 0) reasons.push(`different statuses (${statusDiff.join(", ")})`);

  return reasons;
}

export interface SaturationConfig {
  /** Instances to visit before a uniform template is considered described. */
  readonly instancesPerTemplate: number;
  /** Hard cap on extra sampling once divergence has been seen. */
  readonly divergenceSampleCap: number;
}

export const DEFAULT_SATURATION: SaturationConfig = {
  instancesPerTemplate: 3,
  divergenceSampleCap: 10,
};

export type TemplateState = "sampling" | "saturated" | "diverged";

export interface TemplateProgress {
  readonly template: string;
  readonly state: TemplateState;
  readonly visited: number;
  /** Instances known but not visited, because the template saturated. */
  readonly skipped: number;
  readonly totalKnown: number;
  /** Set once divergence has been seen, with why. */
  readonly divergenceReasons?: readonly string[] | undefined;
  /** One line for the report, per §45's no-silent-loss rule. */
  readonly summary: string;
}

export interface SaturationTracker {
  /** Register that a template has this many known instances. */
  register(template: string, knownInstances: number): void;
  /** Record a visit. Returns whether the template is now saturated. */
  recordVisit(template: string, signature: SignalSignature): TemplateProgress;
  /** Whether another instance of this template is worth visiting. */
  shouldVisit(template: string): boolean;
  progress(): readonly TemplateProgress[];
}

interface State {
  signatures: SignalSignature[];
  knownInstances: number;
  diverged: boolean;
  reasons: string[];
}

export function createSaturationTracker(
  config: SaturationConfig = DEFAULT_SATURATION,
): SaturationTracker {
  const states = new Map<string, State>();

  const stateOf = (template: string): State => {
    const existing = states.get(template);
    if (existing !== undefined) return existing;
    const created: State = { signatures: [], knownInstances: 0, diverged: false, reasons: [] };
    states.set(template, created);
    return created;
  };

  const progressFor = (template: string, state: State): TemplateProgress => {
    const visited = state.signatures.length;
    const limit = state.diverged ? config.divergenceSampleCap : config.instancesPerTemplate;
    const saturated = visited >= limit;
    const known = Math.max(state.knownInstances, visited);
    const skipped = saturated ? Math.max(0, known - visited) : 0;

    const kind: TemplateState = state.diverged
      ? saturated
        ? "saturated"
        : "diverged"
      : saturated
        ? "saturated"
        : "sampling";

    return {
      template,
      state: kind,
      visited,
      skipped,
      totalKnown: known,
      ...(state.reasons.length === 0 ? {} : { divergenceReasons: [...state.reasons] }),
      // §45: the sentence a report prints. A summary that omits the skipped
      // count lets a reader believe the template had three instances.
      summary:
        skipped > 0
          ? `${visited} of ${known} visited, ${skipped} skipped as template-equivalent`
          : `${visited} of ${known} visited`,
    };
  };

  return {
    register(template, knownInstances) {
      const state = stateOf(template);
      state.knownInstances = Math.max(state.knownInstances, knownInstances);
    },

    recordVisit(template, signature) {
      const state = stateOf(template);

      // Compared against the first instance rather than the previous one, so
      // an alternating A/B/A/B pattern diverges once and stays diverged
      // rather than flapping.
      const first = state.signatures[0];
      if (first !== undefined && !signaturesMatch(first, signature)) {
        state.diverged = true;
        for (const reason of describeDivergence(first, signature)) {
          if (!state.reasons.includes(reason)) state.reasons.push(reason);
        }
      }

      state.signatures.push(signature);
      return progressFor(template, state);
    },

    shouldVisit(template) {
      const state = states.get(template);
      if (state === undefined) return true;
      const limit = state.diverged ? config.divergenceSampleCap : config.instancesPerTemplate;
      return state.signatures.length < limit;
    },

    progress() {
      return [...states.entries()]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([template, state]) => progressFor(template, state));
    },
  };
}
