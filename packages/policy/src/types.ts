/**
 * Target Policy — build plan §7.
 *
 * BrowserRecon is a browser with network access pointed at someone's
 * application. The policy is the safety boundary around it, and around any
 * later AI agent. §7 is explicit that this is mandatory rather than an
 * advanced option: there is no code path that scans without one.
 *
 * This module defines the *shape* and the *defaults*. Enforcement — deciding
 * whether a specific request or action is permitted — is `PolicyEngine`
 * (BR-M0-06), kept separate so the decision logic has one home and the model
 * has no behaviour to disagree with.
 */

/**
 * HTTP methods the policy can permit.
 *
 * Split by effect, because the safety story is entirely about that
 * distinction: reading someone's application is materially different from
 * writing to it.
 */
export const READ_ONLY_METHODS = ["GET", "HEAD", "OPTIONS"] as const;

/**
 * Methods that change server state. Opt-in only (§7.2).
 *
 * BrowserRecon drives a real browser that clicks real buttons. A recon run
 * that submits "Place Order" twice has real-world consequences, so these are
 * commented out of every default and example profile rather than merely
 * discouraged.
 */
export const MUTATING_METHODS = ["POST", "PUT", "PATCH", "DELETE"] as const;

export const ALL_METHODS = [...READ_ONLY_METHODS, ...MUTATING_METHODS] as const;

export type HttpMethod = (typeof ALL_METHODS)[number];

/** Whether a method can change server state. */
export function isMutating(method: HttpMethod): boolean {
  return (MUTATING_METHODS as readonly string[]).includes(method);
}

/**
 * Network boundaries — build plan §7.1.
 *
 * All three denials default true. Loopback and private-range access from a
 * tool the user points at a public URL is almost always either a mistake or
 * SSRF-shaped, so reaching them requires saying so explicitly.
 */
export interface NetworkRules {
  readonly denyLoopback: boolean;
  readonly denyPrivateRanges: boolean;
  readonly denyLinkLocal: boolean;
  /** Following a redirect off an allowed origin silently widens scope. */
  readonly followExternalRedirects: boolean;
}

/** Resource budgets — build plan §7.2, §8.3. */
export interface Limits {
  readonly maxRequestsPerSecond: number;
  readonly maxConcurrency: number;
  readonly maxPages: number;
  readonly maxRuntimeMinutes: number;
}

/** Exploration depth. Independent of rate (§8.3). */
export interface Thoroughness {
  readonly instancesPerTemplate: number;
  readonly divergenceSampleCap: number;
}

/**
 * What an explorer may do — build plan §7.2, §27.3.
 *
 * Shared by the Deterministic Explorer (§5A) and the V5 AI Explorer rather
 * than duplicated, so switching `--ai` on cannot bring a different and looser
 * set of permissions with it.
 */
export interface AgentPolicy {
  /** Permit actions that change application state. Default false. */
  readonly stateChangingActions: boolean;
  readonly maxSteps: number;
  readonly maxFailedActions: number;
}

/** The complete boundary a scan runs inside. */
export interface TargetPolicy {
  /** The origin under test. */
  readonly targetOrigin: string;
  /** Origins in scope. Always includes the target. */
  readonly allowedOrigins: readonly string[];
  /** When non-empty, only these path prefixes are in scope. */
  readonly allowedPaths: readonly string[];
  /** Path prefixes never visited, whatever else permits them. */
  readonly excludedPaths: readonly string[];
  readonly allowedMethods: readonly HttpMethod[];
  readonly network: NetworkRules;
  readonly limits: Limits;
  readonly thoroughness: Thoroughness;
  readonly agent: AgentPolicy;
}

/**
 * Paths excluded by default.
 *
 * These are the actions that end a session or destroy data — exactly what an
 * automated explorer stumbles into first, because they are prominent links.
 * Being logged out mid-scan also silently corrupts coverage (§12.3).
 */
export const DEFAULT_EXCLUDED_PATHS = [
  "/logout",
  "/signout",
  "/sign-out",
  "/log-out",
  "/delete-account",
  "/account/delete",
  "/unsubscribe",
] as const;

/**
 * A policy setting whose value increases risk to the target, and which §7.4
 * therefore requires the user to acknowledge explicitly.
 */
export interface ElevatedRisk {
  readonly setting: string;
  /** Plain language, shown to the user. Not jargon. */
  readonly consequence: string;
}

/**
 * Which parts of a policy carry elevated risk.
 *
 * §7.4 requires that enabling one of these prints, in plain language, what it
 * permits — so this returns the wording rather than a boolean, and the CLI
 * renders it. Silence here would be the failure mode: a user who widened the
 * boundary without noticing.
 */
export function elevatedRisks(policy: TargetPolicy): readonly ElevatedRisk[] {
  const risks: ElevatedRisk[] = [];

  const mutating = policy.allowedMethods.filter(isMutating);
  if (mutating.length > 0) {
    risks.push({
      setting: `allowedMethods: ${mutating.join(", ")}`,
      consequence:
        "The scan may change data on the target — submitting forms, creating records, " +
        "or triggering emails and payments. Only use this on a target you control.",
    });
  }

  if (policy.allowedMethods.includes("DELETE")) {
    risks.push({
      setting: "allowedMethods: DELETE",
      consequence: "The scan may permanently delete data on the target.",
    });
  }

  if (policy.agent.stateChangingActions) {
    risks.push({
      setting: "agent.stateChangingActions: true",
      consequence:
        "An explorer may deliberately complete state-changing workflows, such as placing " +
        "an order, to reach pages that only exist afterwards.",
    });
  }

  if (!policy.network.denyLoopback) {
    risks.push({
      setting: "network.denyLoopback: false",
      consequence: "The scan may reach services on this machine that are not exposed publicly.",
    });
  }

  if (!policy.network.denyPrivateRanges) {
    risks.push({
      setting: "network.denyPrivateRanges: false",
      consequence: "The scan may reach internal network addresses reachable from this machine.",
    });
  }

  if (policy.network.followExternalRedirects) {
    risks.push({
      setting: "network.followExternalRedirects: true",
      consequence: "A redirect may take the scan to an origin you did not list as in scope.",
    });
  }

  if (policy.limits.maxRequestsPerSecond > 10) {
    risks.push({
      setting: `limits.maxRequestsPerSecond: ${policy.limits.maxRequestsPerSecond}`,
      consequence:
        "This rate can degrade or overwhelm a modest site. Only use it on a target you " +
        "control and have load-tested.",
    });
  }

  return risks;
}
