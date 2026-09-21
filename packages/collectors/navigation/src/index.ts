/**
 * @browserrecon/collector-navigation — navigation as a first-class object.
 *
 * Turns the events around a URL change into §16.1's navigation: `from`, `to`,
 * `navigation_id`, `interaction_id`, `kind`. Build plan §16, §16.1; dev plan
 * BR-M1-07.
 *
 * Public API only. Internals stay unexported; consumers may not deep-import
 * (enforced by eslint, dev plan §2.4).
 */

/** Package identity, used by diagnostics and the `doctor` command. */
export const PACKAGE_NAME = "@browserrecon/collector-navigation" as const;

export { collectNavigation } from "./collector.js";
export type {
  AttributionBasis,
  Navigation,
  NavigationCollector,
  NavigationKind,
  NavigationModel,
} from "./collector.js";

export { SOFT_NAVIGATION_SUBTYPES, classifySoftNavigation } from "./kind.js";
export type {
  SoftNavigationSubtype,
  SubtypeBasis,
  SubtypeInput,
  SubtypeVerdict,
} from "./kind.js";
