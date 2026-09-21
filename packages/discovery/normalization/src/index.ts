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

export { PARAMETER_RULES, inferTemplate, sameTemplate } from "./template.js";
export type { RouteTemplate } from "./template.js";

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
