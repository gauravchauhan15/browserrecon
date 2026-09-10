/**
 * @browserrecon/policy — Target Policy model and the authoritative enforcement decisions
 *
 * Public API only. Internals stay unexported; consumers may not deep-import
 * (enforced by eslint, dev plan §2.4).
 */

/** Package identity, used by diagnostics and the `doctor` command. */
export const PACKAGE_NAME = "@browserrecon/policy" as const;

export {
  ALL_METHODS,
  DEFAULT_EXCLUDED_PATHS,
  MUTATING_METHODS,
  READ_ONLY_METHODS,
  elevatedRisks,
  isMutating,
} from "./types.js";
export type {
  AgentPolicy,
  ElevatedRisk,
  HttpMethod,
  Limits,
  NetworkRules,
  TargetPolicy,
  Thoroughness,
} from "./types.js";

export {
  DEFAULT_RATE_PROFILE,
  DEFAULT_THOROUGHNESS_LEVEL,
  ESTIMATED_REQUESTS_PER_PAGE,
  RATE_PROFILES,
  THOROUGHNESS_LEVELS,
  computeEffectiveBudget,
} from "./profiles.js";
export type {
  BindingConstraint,
  EffectiveBudget,
  RateProfile,
  ThoroughnessLevel,
} from "./profiles.js";

export { POLICY_SPEC, defaultTargetPolicy, resolveTargetPolicy } from "./resolve.js";
export type { PolicyResolution, PolicyViolation, ResolvePolicyInput } from "./resolve.js";

export { DENIAL_REASONS, PERMITTED_ACTIONS, PolicyEngine } from "./engine.js";
export type {
  Allowed,
  BarrierCategory,
  Decision,
  Denied,
  DenialReason,
  ProposedAction,
} from "./engine.js";

export { classifyAddress, isIpLiteral, isPubliclyRoutable } from "./ip.js";
export type { AddressClass } from "./ip.js";
