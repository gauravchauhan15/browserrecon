/**
 * @browserrecon/auth — authentication profiles, TOTP, session state and test
 * data profiles.
 *
 * Distinct from `@browserrecon/authorization`, which answers "am I permitted
 * to scan this target" (§7.4). This answers "log in as this user", with
 * credentials the user supplied for an account they control.
 *
 * Two rules run through everything here:
 *
 *   **Secrets come from the environment.** Not by convention — the types have
 *   nowhere to put one. A profile with an inline password does not parse.
 *
 *   **There is no bypass.** TOTP generation from a user-supplied secret is
 *   the tool holding a key it was handed. Nothing here attempts a factor we
 *   do not have the key to, and `tests/meta/no-solver.test.ts` scans for it.
 */
export const PACKAGE_NAME = "@browserrecon/auth" as const;

export { MFA_TYPES, parseAuthProfile, resolveSecrets } from "./profile.js";
export type {
  AuthProfile,
  MfaType,
  ProfileProblem,
  ResolveProblem,
  Secrets,
  SuccessCondition,
} from "./profile.js";

export {
  DEFAULT_TOTP,
  MIN_REMAINING_SECONDS,
  decodeBase32,
  hotp,
  secondsRemaining,
  shouldWaitForNextCode,
  totp,
} from "./totp.js";
export type { TotpOptions } from "./totp.js";

export {
  DEFAULT_MAX_REAUTHENTICATIONS,
  createSessionTracker,
  evaluateAuthState,
} from "./session.js";
export type {
  AuthState,
  SessionEvidence,
  SessionTracker,
  SessionTransition,
  StateVerdict,
  SuccessSignals,
  TrackerOptions,
} from "./session.js";

export {
  ALWAYS_REFUSED,
  looksLikeLiveSecret,
  parseTestDataProfile,
  valueFor,
} from "./test-data.js";
export type {
  FieldFacts,
  FieldMatch,
  FieldRule,
  FillDecision,
  TestDataProfile,
} from "./test-data.js";
