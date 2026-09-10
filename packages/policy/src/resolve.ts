/**
 * Building a Target Policy from configuration — build plan §7.
 *
 * Two rules govern everything here:
 *
 *   1. Defaults are safe. A policy nobody configured must be read-only,
 *      scope-restricted and non-destructive, because that is what a user who
 *      typed `browserrecon scan <url>` and nothing else has consented to.
 *
 *   2. Widening is explicit. Every setting that increases risk to the target
 *      is opt-in and reported back (§7.4), so a boundary is never widened by
 *      accident or by a default someone forgot to check.
 */
import { bool, list, num, oneOf, type ConfigSpec } from "@browserrecon/config";
import {
  ALL_METHODS,
  DEFAULT_EXCLUDED_PATHS,
  READ_ONLY_METHODS,
  type HttpMethod,
  type TargetPolicy,
} from "./types.js";
import {
  DEFAULT_RATE_PROFILE,
  DEFAULT_THOROUGHNESS_LEVEL,
  RATE_PROFILES,
  THOROUGHNESS_LEVELS,
  type RateProfile,
  type ThoroughnessLevel,
} from "./profiles.js";

/**
 * Policy configuration fields, appended to the main spec.
 *
 * Separate from `CONFIG_SPEC` so a change to a convenience setting can never
 * sit in the same edit as a change to a scope restriction.
 */
export const POLICY_SPEC: ConfigSpec = [
  list("policy.allowedOrigins", "Origins in scope. The target is always included.", {
    default: [],
    cli: "allowed-origins",
  }),
  list("policy.allowedPaths", "When set, only these path prefixes are in scope.", {
    default: [],
  }),
  list("policy.excludedPaths", "Path prefixes never visited.", {
    default: [...DEFAULT_EXCLUDED_PATHS],
  }),
  list("policy.allowedMethods", "HTTP methods permitted. Mutating methods are opt-in (§7.2).", {
    default: [...READ_ONLY_METHODS],
    values: ALL_METHODS,
    cli: "allowed-methods",
  }),

  bool("policy.network.denyLoopback", "Refuse to reach 127.0.0.0/8 and ::1.", {
    default: true,
  }),
  bool("policy.network.denyPrivateRanges", "Refuse to reach RFC 1918 addresses.", {
    default: true,
  }),
  bool("policy.network.denyLinkLocal", "Refuse to reach 169.254.0.0/16 and fe80::/10.", {
    default: true,
  }),
  bool("policy.network.followExternalRedirects", "Follow redirects off an allowed origin.", {
    default: false,
  }),

  // Limits default to 0, meaning "take the rate profile's value". A literal
  // duplicate of the profile table here would be a second source of truth,
  // and the two would eventually disagree.
  num("policy.limits.maxRequestsPerSecond", "Sustained request rate. 0 uses the profile.", {
    default: 0,
    min: 0,
    max: 200,
    env: "BROWSERRECON_MAX_RPS",
    cli: "rps",
  }),
  num("policy.limits.maxConcurrency", "Concurrent requests. 0 uses the profile.", {
    default: 0,
    min: 0,
    max: 64,
    integer: true,
    cli: "concurrency",
  }),
  num("policy.limits.maxPages", "Page budget. 0 uses the profile.", {
    default: 0,
    min: 0,
    integer: true,
    cli: "max-pages",
  }),
  num("policy.limits.maxRuntimeMinutes", "Wall-clock budget. 0 uses the profile.", {
    default: 0,
    min: 0,
    max: 1440,
    cli: "timeout-minutes",
  }),

  bool("policy.agent.stateChangingActions", "Permit actions that change application state.", {
    default: false,
  }),
  num("policy.agent.maxSteps", "Explorer action budget (§27.3).", {
    default: 100,
    min: 1,
    max: 10_000,
    integer: true,
    cli: "max-steps",
  }),
  num("policy.agent.maxFailedActions", "Consecutive failures before giving up (§27.3).", {
    default: 10,
    min: 1,
    max: 1000,
    integer: true,
  }),

  oneOf("policy.rateProfile", "Politeness profile. Mirrors rate.profile (§8.3).", {
    values: ["polite", "normal", "aggressive"],
    default: DEFAULT_RATE_PROFILE,
  }),
];

/** A policy that could not be built, with the reason. */
export interface PolicyViolation {
  readonly field: string;
  readonly reason: string;
}

export type PolicyResolution =
  | { readonly ok: true; readonly policy: TargetPolicy }
  | { readonly ok: false; readonly violations: readonly PolicyViolation[] };

export interface ResolvePolicyInput {
  /** The origin under test. Required — §7 has no scan without a target. */
  readonly targetOrigin: string;
  readonly rateProfile?: RateProfile | undefined;
  readonly thoroughnessLevel?: ThoroughnessLevel | undefined;
  /** Resolved `policy.*` config, as produced by `loadConfig`. */
  readonly config?: Record<string, unknown> | undefined;
}

function readPath(source: unknown, path: string): unknown {
  let current: unknown = source;
  for (const segment of path.split(".")) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** Origin form only — no path, query or fragment. */
function normalizeOrigin(raw: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  return url.origin;
}

/**
 * Build a Target Policy.
 *
 * A number configured as 0 means "use the profile's value" rather than
 * "unlimited" — an unlimited budget is not something a default should ever
 * express, and 0 is unambiguous where an absent key would collide with the
 * config layer's own defaulting.
 */
export function resolveTargetPolicy(input: ResolvePolicyInput): PolicyResolution {
  const violations: PolicyViolation[] = [];
  const config = input.config ?? {};

  const targetOrigin = normalizeOrigin(input.targetOrigin);
  if (targetOrigin === undefined) {
    violations.push({
      field: "target.origin",
      reason: `not an http(s) origin: ${JSON.stringify(input.targetOrigin)}`,
    });
  }

  const profileName =
    input.rateProfile ??
    (readPath(config, "policy.rateProfile") as RateProfile | undefined) ??
    DEFAULT_RATE_PROFILE;
  const profile = RATE_PROFILES[profileName];
  if (profile === undefined) {
    violations.push({ field: "policy.rateProfile", reason: `unknown profile: ${profileName}` });
  }

  const thoroughnessName = input.thoroughnessLevel ?? DEFAULT_THOROUGHNESS_LEVEL;
  const thoroughnessDefaults = THOROUGHNESS_LEVELS[thoroughnessName];
  if (thoroughnessDefaults === undefined) {
    violations.push({
      field: "thoroughness.level",
      reason: `unknown level: ${thoroughnessName}`,
    });
  }

  // Extra origins must be well-formed; a typo silently narrowing scope is
  // better than a typo silently widening it, so reject rather than skip.
  const extraOriginsRaw = (readPath(config, "policy.allowedOrigins") as string[]) ?? [];
  const extraOrigins: string[] = [];
  for (const candidate of extraOriginsRaw) {
    const normalized = normalizeOrigin(candidate);
    if (normalized === undefined) {
      violations.push({
        field: "policy.allowedOrigins",
        reason: `not an http(s) origin: ${JSON.stringify(candidate)}`,
      });
      continue;
    }
    extraOrigins.push(normalized);
  }

  const methodsRaw = (readPath(config, "policy.allowedMethods") as string[]) ?? [
    ...READ_ONLY_METHODS,
  ];
  const methods: HttpMethod[] = [];
  for (const candidate of methodsRaw) {
    const upper = candidate.toUpperCase();
    if (!(ALL_METHODS as readonly string[]).includes(upper)) {
      violations.push({
        field: "policy.allowedMethods",
        reason: `unknown method ${JSON.stringify(candidate)}; allowed: ${ALL_METHODS.join(", ")}`,
      });
      continue;
    }
    methods.push(upper as HttpMethod);
  }
  if (methods.length === 0) {
    violations.push({
      field: "policy.allowedMethods",
      reason:
        "at least one method is required; a scan that may issue nothing cannot observe anything",
    });
  }

  if (violations.length > 0 || targetOrigin === undefined || profile === undefined) {
    return { ok: false, violations };
  }

  const pick = (path: string, fallback: number): number => {
    const value = readPath(config, path);
    return typeof value === "number" && value > 0 ? value : fallback;
  };

  const paths = (path: string): readonly string[] => {
    const value = readPath(config, path);
    return Array.isArray(value) ? (value as string[]) : [];
  };

  const excluded = readPath(config, "policy.excludedPaths");

  return {
    ok: true,
    policy: {
      targetOrigin,
      // Deduplicated, target first, so the in-scope set is stable and
      // inspectable rather than order-dependent.
      allowedOrigins: [...new Set([targetOrigin, ...extraOrigins])],
      allowedPaths: paths("policy.allowedPaths"),
      excludedPaths: Array.isArray(excluded)
        ? (excluded as string[])
        : [...DEFAULT_EXCLUDED_PATHS],
      allowedMethods: [...new Set(methods)],
      network: {
        denyLoopback: readPath(config, "policy.network.denyLoopback") !== false,
        denyPrivateRanges: readPath(config, "policy.network.denyPrivateRanges") !== false,
        denyLinkLocal: readPath(config, "policy.network.denyLinkLocal") !== false,
        followExternalRedirects:
          readPath(config, "policy.network.followExternalRedirects") === true,
      },
      limits: {
        maxRequestsPerSecond: pick(
          "policy.limits.maxRequestsPerSecond",
          profile.maxRequestsPerSecond,
        ),
        maxConcurrency: pick("policy.limits.maxConcurrency", profile.maxConcurrency),
        maxPages: pick("policy.limits.maxPages", profile.maxPages),
        maxRuntimeMinutes: pick("policy.limits.maxRuntimeMinutes", profile.maxRuntimeMinutes),
      },
      thoroughness: {
        instancesPerTemplate: pick(
          "policy.thoroughness.instancesPerTemplate",
          thoroughnessDefaults?.instancesPerTemplate ?? 3,
        ),
        divergenceSampleCap: pick(
          "policy.thoroughness.divergenceSampleCap",
          thoroughnessDefaults?.divergenceSampleCap ?? 10,
        ),
      },
      agent: {
        stateChangingActions: readPath(config, "policy.agent.stateChangingActions") === true,
        maxSteps: pick("policy.agent.maxSteps", 100),
        maxFailedActions: pick("policy.agent.maxFailedActions", 10),
      },
    },
  };
}

/**
 * The policy a bare `browserrecon scan <url>` runs under.
 *
 * Exported so the safety posture can be asserted directly in tests, and so
 * `config validate` can show a user what they get without configuring
 * anything.
 */
export function defaultTargetPolicy(targetOrigin: string): PolicyResolution {
  return resolveTargetPolicy({ targetOrigin });
}
