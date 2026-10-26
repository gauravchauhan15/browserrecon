/**
 * Signing in — build plan §12.1, §12.2, §12.3; dev plan BR-M4-auth.
 *
 * `packages/auth` has had profiles, TOTP and session tracking since M2, all
 * thoroughly unit-tested, and nothing called any of it: `auth list` reported
 * "not implemented", `scan` had no flag, and every observation the tool had
 * ever recorded was `anonymous`. This is the missing wire.
 *
 * ## What it will not do (§12.2)
 *
 * There is no bypass here and there will not be one. It types credentials the
 * user supplied for an account the user controls, and generates a TOTP code
 * from a secret the user handed over. A factor we do not hold the key to is
 * not attempted — not guessed, not brute-forced, not worked around. If the
 * login fails, the scan continues unauthenticated and says so.
 *
 * ## Secrets reach this function and go no further
 *
 * They arrive already resolved from the environment (§12.1), are typed into
 * the page, and are never logged, never put in an error message, and never
 * recorded in an event. The only things that leave here are a verdict and the
 * selectors involved.
 */
import {
  MIN_REMAINING_SECONDS,
  shouldWaitForNextCode,
  totp,
  type AuthProfile,
  type Secrets,
} from "@browserrecon/auth";
import { silentLogger, type Logger } from "@browserrecon/core";
import type { BrowserAdapter } from "@browserrecon/browser-adapter";

/**
 * Selectors covering the shapes most login forms take.
 *
 * Tried in order, first match wins. A profile that names its own selector
 * skips this entirely — these exist so the common case needs no configuration,
 * not so an unusual form can be guessed at.
 */
const DEFAULT_USERNAME_SELECTORS = [
  "input[type=email]",
  "input[name=email]",
  "input[name=username]",
  "input[name=user]",
  "input[id*=email i]",
  "input[id*=user i]",
] as const;

const DEFAULT_PASSWORD_SELECTORS = [
  "input[type=password]",
  "input[name=password]",
  "input[id*=pass i]",
] as const;

const DEFAULT_SUBMIT_SELECTORS = [
  "button[type=submit]",
  "input[type=submit]",
  "form button",
  "button#loginButton",
] as const;

export type LoginOutcome =
  /** Signed in, and the success condition was met. */
  | {
      readonly status: "authenticated";
      readonly authContext: string;
      readonly evidence: string;
    }
  /** The form was driven but the application did not accept it. */
  | { readonly status: "rejected"; readonly detail: string }
  /** The form could not be driven — a selector missed, or the page refused. */
  | { readonly status: "failed"; readonly detail: string };

export interface LoginInput {
  readonly adapter: BrowserAdapter;
  readonly profile: AuthProfile;
  /** Already resolved from the environment. Never logged. */
  readonly secrets: Secrets;
  readonly logger?: Logger | undefined;
  /** Milliseconds to let the post-submit navigation settle. */
  readonly settleMs?: number | undefined;
  /** Injected so the TOTP step is testable without waiting on a real clock. */
  readonly now?: (() => number) | undefined;
}

/**
 * What happened when a list of candidate selectors was tried.
 *
 * The reasons are kept, not just the success. "No submit control was found on
 * the login page" is a fine message when that is true and a misleading one
 * when the control was found and the *policy* refused to click it — and a
 * user debugging the second message goes looking at their selectors, which
 * are fine. This is the same class of defect as every other one this project
 * has found: a plausible wrong answer is worse than an absent one.
 */
interface Attempt {
  readonly selector?: string | undefined;
  /** One line per candidate that did not work, in the order tried. */
  readonly reasons: readonly string[];
}

function why(result: { readonly status: string } & Record<string, unknown>): string {
  if (result.status === "denied") return `denied by policy: ${String(result.reason)}`;
  if (result.status === "failed") return `${String(result.kind)}: ${String(result.detail)}`;
  return result.status;
}

/** Type into the first selector that accepts it. */
async function typeInto(
  adapter: BrowserAdapter,
  candidates: readonly string[],
  text: string,
): Promise<Attempt> {
  const reasons: string[] = [];
  for (const selector of candidates) {
    const result = await adapter.type(selector, text);
    if (result.status === "ok") return { selector, reasons };
    reasons.push(`${selector} — ${why(result as never)}`);
  }
  return { reasons };
}

/** Click the first selector that works. */
async function clickOne(
  adapter: BrowserAdapter,
  candidates: readonly string[],
): Promise<Attempt> {
  const reasons: string[] = [];
  for (const selector of candidates) {
    // Declared state-changing, because submitting a login form is. The
    // adapter takes the stricter of this and what it infers, so declaring it
    // can only tighten the check — and a policy that refuses says so in the
    // reason rather than looking like a missing element.
    const result = await adapter.click(selector, { stateChanging: true });
    if (result.status === "ok") return { selector, reasons };
    reasons.push(`${selector} — ${why(result as never)}`);
  }
  return { reasons };
}

/**
 * Whether the application accepted the sign-in.
 *
 * §12.3: the *application's* own signal, never the tool's optimism. A form
 * that submitted without error is not a session — plenty of applications
 * re-render the login page with a message and a 200.
 */
async function met(
  adapter: BrowserAdapter,
  profile: AuthProfile,
): Promise<{ readonly ok: boolean; readonly evidence: string }> {
  const condition = profile.successCondition;
  const url = adapter.currentUrl;

  if (condition.urlContains !== undefined) {
    const ok = url.includes(condition.urlContains);
    return { ok, evidence: `landed on ${url}, expected to contain "${condition.urlContains}"` };
  }

  if (condition.selectorPresent !== undefined) {
    const found = await adapter.exists(condition.selectorPresent);
    const there = found.status === "ok" && found.value;
    return {
      ok: there,
      evidence: `"${condition.selectorPresent}" ${there ? "is" : "is not"} present`,
    };
  }

  if (condition.selectorAbsent !== undefined) {
    // A login form still on the page is the clearest "no" an application
    // gives, and the one case where absence is the success signal.
    const found = await adapter.exists(condition.selectorAbsent);
    const there = found.status === "ok" && found.value;
    return {
      ok: !there,
      evidence: `"${condition.selectorAbsent}" ${there ? "is still" : "is no longer"} present`,
    };
  }

  // `cookieSet` is checked by the session tracker against observed telemetry,
  // not here: this function can only see the page, and a cookie set on an
  // XHR response is not visible from the DOM.
  return { ok: true, evidence: "no page-visible success condition was declared" };
}

/**
 * Drive a login, and report what the application said.
 *
 * Never throws for an authentication failure — a scan that cannot sign in is
 * a scan with less coverage, not a crashed scan, and §45 wants that recorded
 * rather than fatal.
 */
export async function login(input: LoginInput): Promise<LoginOutcome> {
  const log = input.logger ?? silentLogger();
  const { adapter, profile, secrets } = input;

  const opened = await adapter.navigate(profile.login.url);
  if (opened.status !== "ok") {
    return {
      status: "failed",
      detail:
        opened.status === "denied"
          ? `policy refused the login URL: ${opened.reason}`
          : `could not open the login page: ${opened.kind}`,
    };
  }

  const username = await typeInto(
    adapter,
    profile.login.usernameSelector === undefined
      ? DEFAULT_USERNAME_SELECTORS
      : [profile.login.usernameSelector],
    secrets.username,
  );
  if (username.selector === undefined) {
    return {
      status: "failed",
      detail: `no username field could be filled. Tried: ${username.reasons.join("; ")}`,
    };
  }

  const password = await typeInto(
    adapter,
    profile.login.passwordSelector === undefined
      ? DEFAULT_PASSWORD_SELECTORS
      : [profile.login.passwordSelector],
    secrets.password,
  );
  if (password.selector === undefined) {
    return {
      status: "failed",
      detail: `no password field could be filled. Tried: ${password.reasons.join("; ")}`,
    };
  }

  // Selectors, never values. An error message is a place secrets leak.
  log.info("login form filled", {
    username: username.selector,
    password: password.selector,
  });

  const submitted = await clickOne(
    adapter,
    profile.login.submitSelector === undefined
      ? DEFAULT_SUBMIT_SELECTORS
      : [profile.login.submitSelector],
  );
  if (submitted.selector === undefined) {
    return {
      status: "failed",
      detail: `the login form could not be submitted. Tried: ${submitted.reasons.join("; ")}`,
    };
  }

  await adapter.waitForSettled({ timeoutMs: input.settleMs ?? 5_000 });

  // §12.2: a code generated from a secret the user handed us. Nothing here
  // attempts a factor we do not hold the key to.
  if (profile.mfa?.type === "totp") {
    if (secrets.totpSecret === undefined) {
      return {
        status: "failed",
        detail: "the profile declares TOTP but no secret was resolved from the environment",
      };
    }
    // `shouldWaitForNextCode` exists for exactly this moment: submitting a
    // code with a second left on it fails in a way that looks like wrong
    // credentials, and whoever debugs that finds nothing wrong with them.
    let at = input.now?.() ?? Date.now();
    if (shouldWaitForNextCode(at)) {
      await adapter.waitForSettled({ timeoutMs: MIN_REMAINING_SECONDS * 1_000 });
      at = input.now?.() ?? Date.now();
    }
    const code = totp(secrets.totpSecret, at);
    const code_ = await typeInto(
      adapter,
      profile.mfa.codeSelector === undefined
        ? ["input[name=code]", "input[name=otp]", "input[autocomplete=one-time-code]"]
        : [profile.mfa.codeSelector],
      code,
    );
    if (code_.selector === undefined) {
      return {
        status: "failed",
        detail: `no one-time-code field could be filled. Tried: ${code_.reasons.join("; ")}`,
      };
    }
    const confirmed = await clickOne(
      adapter,
      profile.mfa.submitSelector === undefined
        ? DEFAULT_SUBMIT_SELECTORS
        : [profile.mfa.submitSelector],
    );
    if (confirmed.selector === undefined) {
      return {
        status: "failed",
        detail: `the one-time code could not be submitted. Tried: ${confirmed.reasons.join("; ")}`,
      };
    }
    await adapter.waitForSettled({ timeoutMs: input.settleMs ?? 5_000 });
  } else if (profile.mfa !== undefined) {
    // Every other factor needs something only the user has. §12.2 is explicit
    // that this is never worked around, so it is reported and the scan goes
    // on without a session.
    return {
      status: "failed",
      detail: `the profile declares ${profile.mfa.type} MFA, which cannot be completed without the user present — this is never bypassed (§12.2)`,
    };
  }

  const verdict = await met(adapter, profile);
  if (!verdict.ok) {
    return { status: "rejected", detail: verdict.evidence };
  }

  return { status: "authenticated", authContext: profile.name, evidence: verdict.evidence };
}
