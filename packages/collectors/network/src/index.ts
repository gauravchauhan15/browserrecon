/**
 * @browserrecon/collector-network — normalized network observations.
 *
 * Joins the three telemetry events for one request into a single observation,
 * gives every URL a grouping identity that never replaces what was observed,
 * and turns Chrome's error strings into reasons a consumer can branch on.
 * Build plan §13, §14, §33; dev plan BR-M1-06.
 *
 * Public API only. Internals stay unexported; consumers may not deep-import
 * (enforced by eslint, dev plan §2.4).
 */

/** Package identity, used by diagnostics and the `doctor` command. */
export const PACKAGE_NAME = "@browserrecon/collector-network" as const;

export { collectNetwork } from "./collector.js";
export type {
  NetworkCollector,
  NetworkModel,
  NetworkObservation,
  OriginGroup,
} from "./collector.js";

export {
  NORMALIZATION_RULES,
  REFUSED_NORMALIZATIONS,
  normalizeUrl,
  renderRuleTables,
  sameEndpoint,
} from "./url.js";
export type { NormalizationRule, NormalizedUrl } from "./url.js";

export { FAILURE_REASONS, classifyFailure } from "./failures.js";

export { BARRIER_CATEGORIES, classifyBarrier, shouldAbortScan } from "./barriers.js";
export type { Barrier, BarrierCategory, BarrierInput } from "./barriers.js";
export type { ClassifiedFailure, FailureReason } from "./failures.js";
