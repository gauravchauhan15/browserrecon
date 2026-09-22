/**
 * Session state during a scan — build plan §12.3; dev plan BR-M2-16.
 *
 * The failure this exists to prevent, stated exactly as §12.3 does: a
 * 30-minute scan against an application with a 15-minute idle timeout
 * silently falls back to unauthenticated crawling halfway through, **and
 * every coverage number, workflow and state transition produced after that
 * point is wrong while still looking authoritative**.
 *
 * That last clause is why this is not a nicety. A scan that fails loudly
 * wastes an afternoon. A scan that quietly stops being logged in produces a
 * report saying `/admin/users` returned 302, which a reader interprets as
 * "properly protected" when it means "we were logged out".
 *
 * ## Five behaviours, and the fifth is the one to hold on to
 *
 * 1. verify continuously, not once at login
 * 2. classify the loss as `session_expired`, not a generic 401
 * 3. re-authenticate, bounded, so a broken app cannot cause a login loop
 * 4. stamp every observation with the auth state that produced it
 * 5. **never silently continue as if nothing happened**
 */

export type AuthState = "anonymous" | "authenticated" | "expired" | "failed";

export interface SessionEvidence {
  /** The URL currently loaded. */
  readonly url?: string | undefined;
  readonly status?: number | undefined;
  /** Cookie names present. Names only — §37.1, values are never needed here. */
  readonly cookieNames?: readonly string[] | undefined;
  /** Whether the profile's `selectorPresent` was found. */
  readonly selectorPresent?: boolean | undefined;
  /** Whether the profile's `selectorAbsent` was found. */
  readonly selectorAbsent?: boolean | undefined;
  /** True when the response was a redirect to something login-shaped. */
  readonly redirectedToLogin?: boolean | undefined;
}

export interface SuccessSignals {
  readonly urlContains?: string | undefined;
  readonly selectorPresent?: string | undefined;
  readonly selectorAbsent?: string | undefined;
  readonly cookieSet?: string | undefined;
}

export interface StateVerdict {
  readonly state: AuthState;
  /** The signal that decided it. §12.3 point 2 needs the reason, not a flag. */
  readonly signal: string;
}

/** Paths that are a login page whatever else is true. */
const LOGIN_PATH =
  /\/(?:login|signin|sign-in|auth|sso|session\/new|account\/login)(?:\/|$|\?)/i;

/**
 * Read the evidence against the profile's success conditions.
 *
 * Every condition the profile stated must hold. A profile that named two
 * signals meant both: treating them as alternatives would let a scan stay
 * "authenticated" on the strength of a URL while the page shows a login
 * form.
 */
export function evaluateAuthState(
  evidence: SessionEvidence,
  signals: SuccessSignals,
): StateVerdict {
  // The unambiguous negatives first. A 401 on a route that was reachable a
  // minute ago is the clearest possible statement that the session is gone.
  if (evidence.status === 401) {
    return { state: "expired", signal: "the application answered 401" };
  }
  if (evidence.redirectedToLogin === true) {
    return { state: "expired", signal: "the request was redirected to a login page" };
  }
  if (evidence.url !== undefined && LOGIN_PATH.test(evidence.url)) {
    return { state: "expired", signal: `landed on a login page (${evidence.url})` };
  }

  const checks: { readonly held: boolean; readonly signal: string }[] = [];

  if (signals.urlContains !== undefined) {
    checks.push({
      held: (evidence.url ?? "").includes(signals.urlContains),
      signal: `url contains "${signals.urlContains}"`,
    });
  }
  if (signals.cookieSet !== undefined) {
    checks.push({
      held: (evidence.cookieNames ?? []).includes(signals.cookieSet),
      signal: `cookie "${signals.cookieSet}" is set`,
    });
  }
  if (signals.selectorPresent !== undefined) {
    checks.push({
      held: evidence.selectorPresent === true,
      signal: `"${signals.selectorPresent}" is present`,
    });
  }
  if (signals.selectorAbsent !== undefined) {
    checks.push({
      held: evidence.selectorAbsent === false,
      signal: `"${signals.selectorAbsent}" is absent`,
    });
  }

  if (checks.length === 0) {
    // A profile with no conditions cannot tell success from failure, and
    // `parseAuthProfile` refuses one. Reaching here means a caller built a
    // profile by hand; saying "authenticated" would be a guess.
    return { state: "anonymous", signal: "no success condition to check" };
  }

  const failed = checks.find((check) => !check.held);
  if (failed !== undefined) {
    return { state: "expired", signal: `${failed.signal} — no longer true` };
  }

  return {
    state: "authenticated",
    signal: checks.map((check) => check.signal).join(" and "),
  };
}

export interface SessionTransition {
  readonly at: string;
  readonly from: AuthState;
  readonly to: AuthState;
  readonly signal: string;
  /** Envelope sequence, so the report can say exactly where coverage changed. */
  readonly sequence: number;
}

export interface SessionTracker {
  /** Fold in one observation. Returns a transition when the state changed. */
  observe(evidence: SessionEvidence, sequence: number): SessionTransition | undefined;
  /** Record that a re-authentication was attempted, and whether it worked. */
  recordReauthentication(succeeded: boolean, sequence: number): void;
  /** Whether another re-authentication is permitted (§12.3 point 3). */
  mayReauthenticate(): boolean;
  /** What every event should be stamped with right now (§12.3 point 4). */
  readonly authContext: string;
  readonly state: AuthState;
  readonly transitions: readonly SessionTransition[];
  readonly reauthentications: number;
  /**
   * The line §12.3 point 5 forbids crossing silently.
   *
   * Set once a session has been lost and not re-established. Everything
   * observed afterwards is unauthenticated, and the report has to say so
   * rather than presenting it alongside authenticated coverage.
   */
  readonly degradedAt?: SessionTransition | undefined;
}

export interface TrackerOptions {
  readonly profileName: string;
  readonly signals: SuccessSignals;
  /** Default 3. A broken app must not cause an endless login loop. */
  readonly maxReauthentications?: number | undefined;
  readonly now?: (() => Date) | undefined;
}

export const DEFAULT_MAX_REAUTHENTICATIONS = 3;

export function createSessionTracker(options: TrackerOptions): SessionTracker {
  const now = options.now ?? ((): Date => new Date());
  const limit = options.maxReauthentications ?? DEFAULT_MAX_REAUTHENTICATIONS;

  let state: AuthState = "anonymous";
  let reauthentications = 0;
  let degradedAt: SessionTransition | undefined;
  const transitions: SessionTransition[] = [];

  const transition = (to: AuthState, signal: string, sequence: number): SessionTransition => {
    const record: SessionTransition = {
      at: now().toISOString(),
      from: state,
      to,
      signal,
      sequence,
    };
    transitions.push(record);
    state = to;
    return record;
  };

  return {
    observe(evidence, sequence) {
      const verdict = evaluateAuthState(evidence, options.signals);

      // Once a session is gone and cannot be re-established, further
      // evidence does not change the story: the scan is unauthenticated from
      // the degradation point on, and re-reporting each observation as a new
      // loss would bury the one transition that matters.
      if (degradedAt !== undefined && verdict.state !== "authenticated") return undefined;
      if (verdict.state === state) return undefined;

      const record = transition(verdict.state, verdict.signal, sequence);
      if (verdict.state === "expired" && reauthentications >= limit) {
        degradedAt = record;
      }
      return record;
    },

    recordReauthentication(succeeded, sequence) {
      reauthentications += 1;
      if (succeeded) {
        transition(
          "authenticated",
          `re-authenticated (attempt ${reauthentications})`,
          sequence,
        );
        degradedAt = undefined;
        return;
      }
      const record = transition(
        "failed",
        `re-authentication failed (attempt ${reauthentications} of ${limit})`,
        sequence,
      );
      if (reauthentications >= limit) degradedAt = record;
    },

    mayReauthenticate() {
      return reauthentications < limit;
    },

    get authContext() {
      // §12.3 point 4. `anonymous` when not authenticated, never the profile
      // name — an observation made after a session was lost must not carry a
      // label saying it was made as that user.
      return state === "authenticated" ? options.profileName : "anonymous";
    },
    get state() {
      return state;
    },
    get transitions() {
      return transitions;
    },
    get reauthentications() {
      return reauthentications;
    },
    get degradedAt() {
      return degradedAt;
    },
  };
}
