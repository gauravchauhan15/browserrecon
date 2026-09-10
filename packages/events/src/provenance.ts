/**
 * Provenance model — build plan §24.
 *
 * The project's central discipline: observed facts and inference are never
 * blurred, and every derived value records where it came from at the point it
 * is created, not at export.
 */

/** Where a value came from. Ordered weakest-last within the main chain. */
export const PROVENANCE = [
  /** Seen directly in the browser or the network. Ground truth. */
  "observed",
  /** Brought in from another tool (e.g. a crawler). Real, but not our observation. */
  "imported",
  /** Two or more observations linked by deterministic code. */
  "correlated",
  /** Computed from observations by deterministic rules — workflows, state graph. */
  "derived",
  /** A model's interpretation of observed evidence — names, classifications. */
  "inferred",
  /**
   * A model's guess about something **never observed at runtime at all**,
   * grounded only in static context such as co-location or naming (§28).
   *
   * Sits outside the main chain rather than at its end, and is always weaker
   * than `inferred` — which still traces back to something the browser did.
   */
  "static_context_inferred",
  /** A security claim requiring downstream validation. Never a finding (§20.3). */
  "hypothesis",
] as const;

export type Provenance = (typeof PROVENANCE)[number];

const PROVENANCE_SET: ReadonlySet<string> = new Set(PROVENANCE);

/** Narrow an untrusted value to a Provenance. */
export function isProvenance(value: unknown): value is Provenance {
  return typeof value === "string" && PROVENANCE_SET.has(value);
}

/**
 * Whether a value traces back to something the browser actually did.
 *
 * Encodes §24's requirement that a consumer can filter
 * `static_context_inferred` out entirely and still get a fully
 * self-consistent, runtime-grounded picture. Exported as a function so that
 * rule lives in one place instead of being re-derived by every exporter.
 */
export function isRuntimeGrounded(provenance: Provenance): boolean {
  return provenance !== "static_context_inferred";
}

/**
 * Whether a value is a direct observation rather than any form of
 * interpretation. Coverage accounting counts only these (§10C).
 */
export function isFactual(provenance: Provenance): boolean {
  return provenance === "observed" || provenance === "imported";
}

/**
 * Whether a model produced this value. Anything true here must also carry a
 * confidence score (§24), and must be filterable by a consumer that wants
 * deterministic output only.
 */
export function isModelDerived(provenance: Provenance): boolean {
  return (
    provenance === "inferred" ||
    provenance === "static_context_inferred" ||
    provenance === "hypothesis"
  );
}
