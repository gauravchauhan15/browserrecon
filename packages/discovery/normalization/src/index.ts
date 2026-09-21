/**
 * @browserrecon/discovery-normalization — the shared candidate registry.
 *
 * One entry per URL however many sources found it, the route template it
 * belongs to, and the saturation rule that stops 47,218 product pages
 * consuming a scan. Build plan §9.5.1, §9.5.2, §9.5.3.
 */
export const PACKAGE_NAME = "@browserrecon/discovery-normalization" as const;

export { createRegistry } from "./registry.js";
export type {
  CandidateEntry,
  CandidateRegistry,
  CandidateStatus,
  RegistryStats,
  SourceSighting,
} from "./registry.js";

// Route templating moved to @browserrecon/collector-network, which already
// owns "what is this URL, really" (normalization, identity). §1.2 forbids
// the correlation-rightward packages from importing discovery/*, and
// api-model needs the same inference — one home beats a second copy.
export { PARAMETER_RULES, inferTemplate, sameTemplate } from "@browserrecon/collector-network";
export type { RouteTemplate } from "@browserrecon/collector-network";

export {
  DEFAULT_SATURATION,
  buildSignature,
  createSaturationTracker,
  describeDivergence,
  signaturesMatch,
} from "./saturation.js";
export type {
  SaturationConfig,
  SaturationTracker,
  SignalSignature,
  TemplateProgress,
  TemplateState,
} from "./saturation.js";
