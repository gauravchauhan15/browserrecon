/**
 * Policy Engine — build plan §7, coding principle §32.10.
 *
 * The single decision point every request and every explorer action passes
 * through. Nothing reaches the network or the browser without an `allow` from
 * here, and no caller is permitted to form its own opinion about scope.
 *
 * Two properties matter more than the checks themselves:
 *
 *   - **Every denial carries a machine-readable reason**, and a barrier
 *     category from §8.6, so a refusal becomes reconnaissance data ("22 admin
 *     routes returned 403") rather than a silent gap in the coverage report.
 *
 *   - **Denial is the default on anything unrecognised.** A URL that will not
 *     parse, a scheme nobody declared, an address this code cannot classify:
 *     all denied. Failing open here would mean scanning something the user
 *     never authorised.
 */
import { promises as dns } from "node:dns";
import { classifyAddress, isIpLiteral, type AddressClass } from "./ip.js";
import type { HttpMethod, TargetPolicy } from "./types.js";

/** Machine-readable denial reasons. */
export const DENIAL_REASONS = [
  "malformed_url",
  "scheme_not_allowed",
  "origin_not_allowed",
  "path_not_allowed",
  "path_excluded",
  "method_not_allowed",
  "loopback_denied",
  "private_range_denied",
  "link_local_denied",
  "address_not_routable",
  "redirect_leaves_scope",
  "action_not_recognised",
  "action_state_changing_denied",
  "dns_resolution_failed",
] as const;

export type DenialReason = (typeof DENIAL_REASONS)[number];

/**
 * Barrier category for the event log (§8.6).
 *
 * Policy denials are recorded as `scope_excluded`; a coverage report has to be
 * able to say "we did not visit this because you told us not to", which is
 * different from "we could not reach it".
 */
export type BarrierCategory = "scope_excluded" | "private_network_unreachable";

export interface Allowed {
  readonly allowed: true;
}

export interface Denied {
  readonly allowed: false;
  readonly reason: DenialReason;
  /** One line, safe to show a user. */
  readonly detail: string;
  readonly barrier: BarrierCategory;
}

export type Decision = Allowed | Denied;

const ALLOW: Decision = { allowed: true };

function deny(
  reason: DenialReason,
  detail: string,
  barrier: BarrierCategory = "scope_excluded",
): Denied {
  return { allowed: false, reason, detail, barrier };
}

/**
 * Segment-aware path prefix match.
 *
 * `/logout` must match `/logout` and `/logout/confirm` but **not**
 * `/logout-help`, which is a different page. A plain `startsWith` would
 * exclude a legitimate route and quietly shrink coverage.
 */
function pathMatches(pathname: string, prefix: string): boolean {
  const normalizedPrefix = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  if (normalizedPrefix === "" || normalizedPrefix === "/") return true;
  if (pathname === normalizedPrefix) return true;
  return pathname.startsWith(`${normalizedPrefix}/`);
}

/** Which network rule, if any, forbids an address class. */
function addressDenial(
  policy: TargetPolicy,
  hostname: string,
  cls: AddressClass,
): Denied | undefined {
  const { network } = policy;

  if (cls === "loopback" && network.denyLoopback) {
    return deny(
      "loopback_denied",
      `${hostname} is a loopback address`,
      "private_network_unreachable",
    );
  }
  if (cls === "private" && network.denyPrivateRanges) {
    return deny(
      "private_range_denied",
      `${hostname} is a private address`,
      "private_network_unreachable",
    );
  }
  if (cls === "link_local" && network.denyLinkLocal) {
    return deny(
      "link_local_denied",
      `${hostname} is a link-local address`,
      "private_network_unreachable",
    );
  }
  // Everything else non-routable — CGNAT, benchmark, multicast, reserved,
  // unspecified — is refused whenever private ranges are refused. Reaching
  // any of them from a scan of a public site is not a thing a user asked for.
  if (
    cls !== "public" &&
    cls !== "loopback" &&
    cls !== "private" &&
    cls !== "link_local" &&
    network.denyPrivateRanges
  ) {
    return deny(
      "address_not_routable",
      `${hostname} is not publicly routable (${cls})`,
      "private_network_unreachable",
    );
  }
  return undefined;
}

/** An explorer action, as proposed by the Deterministic or AI Explorer. */
export interface ProposedAction {
  readonly kind: string;
  /** Destination, for navigations. */
  readonly url?: string | undefined;
  /**
   * Whether the caller determined this changes application state.
   *
   * Supplied by the explorer rather than inferred here: deciding that a click
   * submits a destructive form needs DOM knowledge (§5A.2), which lives in the
   * browser layer. The engine's job is to enforce the policy on that verdict,
   * not to second-guess it.
   */
  readonly stateChanging?: boolean | undefined;
}

/** Actions an explorer may take (§27.2). Anything absent here is denied. */
export const PERMITTED_ACTIONS = [
  "navigate",
  "click",
  "type",
  "scroll",
  "back",
  "wait",
  "submit_form",
  "inspect_page",
  "inspect_network",
  "screenshot",
] as const;

const PERMITTED_ACTION_SET: ReadonlySet<string> = new Set(PERMITTED_ACTIONS);

/**
 * Enforces a Target Policy.
 *
 * Synchronous methods perform every check that needs no I/O, which covers IP
 * literals. `checkResolvedHost` adds the DNS layer and is therefore async —
 * see the note on its limits.
 */
/** Same origin, with an unparseable URL counting as "no". */
function sameOrigin(url: string | undefined, other: string): boolean {
  if (url === undefined) return false;
  try {
    return new URL(url).origin === new URL(other).origin;
  } catch {
    return false;
  }
}

export class PolicyEngine {
  /** The login origin, while a sign-in is in progress. See below. */
  #authenticatingAt: string | undefined;

  constructor(readonly policy: TargetPolicy) {}

  /** Whether an origin is in scope. */
  isInScope(origin: string): boolean {
    return this.policy.allowedOrigins.includes(origin);
  }

  /**
   * Whether a URL may be requested with a method.
   *
   * Checks scheme, origin, path allow/deny lists, method, and — for IP
   * literals — the network rules. A hostname needing DNS is *not* resolved
   * here; call `checkResolvedHost` before connecting.
   */
  canRequest(url: string, method: HttpMethod): Decision {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return deny("malformed_url", `not a URL: ${url}`);
    }

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return deny("scheme_not_allowed", `scheme ${parsed.protocol} is not http(s)`);
    }

    if (!this.isInScope(parsed.origin)) {
      return deny("origin_not_allowed", `${parsed.origin} is not an allowed origin`);
    }

    if (!this.policy.allowedMethods.includes(method)) {
      return deny(
        "method_not_allowed",
        `${method} is not permitted; allowed: ${this.policy.allowedMethods.join(", ")}`,
      );
    }

    // Exclusions win over allowances, always. A path that is both allowed and
    // excluded is excluded — the denylist is the safety mechanism.
    for (const excluded of this.policy.excludedPaths) {
      if (pathMatches(parsed.pathname, excluded)) {
        return deny("path_excluded", `${parsed.pathname} matches excluded path ${excluded}`);
      }
    }

    if (this.policy.allowedPaths.length > 0) {
      const permitted = this.policy.allowedPaths.some((allowed) =>
        pathMatches(parsed.pathname, allowed),
      );
      if (!permitted) {
        return deny("path_not_allowed", `${parsed.pathname} is outside the allowed paths`);
      }
    }

    if (isIpLiteral(parsed.hostname)) {
      const denial = addressDenial(
        this.policy,
        parsed.hostname,
        classifyAddress(parsed.hostname),
      );
      if (denial) return denial;
    }

    return ALLOW;
  }

  /** Whether a page may be visited. Navigation is a GET. */
  canVisit(url: string): Decision {
    return this.canRequest(url, "GET");
  }

  /**
   * Whether a redirect may be followed.
   *
   * A redirect off an allowed origin silently widens scope, which is exactly
   * the failure this prevents: the user authorised one application, not
   * wherever it chooses to point.
   */
  canFollowRedirect(from: string, to: string): Decision {
    let target: URL;
    try {
      target = new URL(to, from);
    } catch {
      return deny("malformed_url", `redirect target is not a URL: ${to}`);
    }

    if (!this.isInScope(target.origin) && !this.policy.network.followExternalRedirects) {
      return deny(
        "redirect_leaves_scope",
        `redirect to ${target.origin} leaves the allowed origins`,
      );
    }

    // In-scope redirects still face every other check — a redirect to
    // /logout must be refused just as a link to it would be.
    return this.canVisit(target.href);
  }

  /** Whether an explorer may take an action. */
  /**
   * Permit the state-changing actions a sign-in needs, on one origin only.
   *
   * Opened and closed by the runner around `login()`. Not a policy setting:
   * a user can turn `stateChangingActions` on in their configuration and
   * accept what that means everywhere, but this is a narrower thing — the
   * single form they explicitly named.
   */
  beginAuthentication(loginUrl: string): void {
    this.#authenticatingAt = loginUrl;
  }

  /** Close the window. Called in a `finally`, including when login throws. */
  endAuthentication(): void {
    this.#authenticatingAt = undefined;
  }

  canAct(action: ProposedAction): Decision {
    if (!PERMITTED_ACTION_SET.has(action.kind)) {
      return deny(
        "action_not_recognised",
        `${action.kind} is not a permitted action; allowed: ${PERMITTED_ACTIONS.join(", ")}`,
      );
    }

    if (action.stateChanging === true && !this.policy.agent.stateChangingActions) {
      // §12.1's one exception, and it is deliberately narrow. Submitting a
      // login form changes state, so a read-only policy forbids it and the
      // whole authentication feature is dead — which is exactly what
      // happened: `packages/auth` was complete and untouched for two
      // milestones, and every observation the tool ever made was anonymous.
      //
      // The exemption is bounded three ways rather than one:
      //
      //  1. **In time.** The window is opened immediately before the login
      //     and closed immediately after, by the runner, in a `finally`.
      //     Nothing else drives the browser while it is open.
      //  2. **By origin.** Only the origin of the login URL the user named.
      //  3. **By intent.** It only opens when the user supplied a profile,
      //     which is them pointing at a form and saying "submit this one".
      //
      // §7.2 is unchanged for everything else: forms are still reported and
      // never submitted, including on this origin once the window closes.
      if (!this.#authenticatingAt || !sameOrigin(action.url, this.#authenticatingAt)) {
        return deny(
          "action_state_changing_denied",
          `${action.kind} changes application state, which this policy does not permit`,
        );
      }
    }

    if (action.url !== undefined) {
      return this.canVisit(action.url);
    }

    return ALLOW;
  }

  /**
   * Resolve a hostname and check the addresses it points at.
   *
   * Closes the hole a string comparison leaves open: `internal.example.com`
   * may resolve to `10.0.0.5`, and no amount of hostname matching would
   * notice.
   *
   * **What this does not do.** A determined DNS-rebinding attack can return a
   * public address here and a private one when the browser connects moments
   * later. Defeating that needs the resolved address pinned at connect time,
   * and Chrome — not this process — does the connecting. The durable mitigation
   * is post-hoc: CDP telemetry records the address actually contacted
   * (BR-M1-03), so a mismatch is detectable after the fact even when it cannot
   * be prevented beforehand. This check stops misconfiguration and
   * straightforward SSRF, which is most of the real risk, and the limitation
   * is stated rather than papered over.
   */
  async checkResolvedHost(hostname: string): Promise<Decision> {
    if (isIpLiteral(hostname)) {
      const denial = addressDenial(this.policy, hostname, classifyAddress(hostname));
      return denial ?? ALLOW;
    }

    const { denyLoopback, denyPrivateRanges, denyLinkLocal } = this.policy.network;
    if (!denyLoopback && !denyPrivateRanges && !denyLinkLocal) return ALLOW;

    let addresses: readonly { address: string }[];
    try {
      addresses = await dns.lookup(hostname, { all: true, verbatim: true });
    } catch {
      // Unresolvable is not a policy denial, but it must not read as an
      // allowance either — the caller needs to record it and move on.
      return deny(
        "dns_resolution_failed",
        `could not resolve ${hostname}`,
        "private_network_unreachable",
      );
    }

    // Every address must pass. A hostname with one public and one private A
    // record is a rebinding setup, and picking the convenient answer would
    // defeat the check entirely.
    for (const { address } of addresses) {
      const denial = addressDenial(
        this.policy,
        `${hostname} (${address})`,
        classifyAddress(address),
      );
      if (denial) return denial;
    }

    return ALLOW;
  }
}
