/**
 * @browserrecon/authorization — the pre-scan authorized-use gate (§7.4).
 *
 * §7.4 exists because the plan said "authorized target" throughout while
 * enforcing nothing. Authorization was documentation; this makes it a step.
 *
 * The decision logic here is pure, so the rule is auditable in one place and
 * testable without a terminal. Prompting and persistence belong to the CLI.
 *
 * Public API only. Internals stay unexported; consumers may not deep-import
 * (enforced by eslint, dev plan §2.4).
 */

/** Package identity, used by diagnostics and the `doctor` command. */
export const PACKAGE_NAME = "@browserrecon/authorization" as const;

export { evaluateGate, isAffirmative } from "./gate.js";
export type {
  GateAllowed,
  GateDenialReason,
  GateDenied,
  GateOutcome,
  GatePrompt,
  GateRequest,
} from "./gate.js";

export {
  ACKNOWLEDGMENT_METHODS,
  createRecord,
  defaultRecordPath,
  readRecord,
  withConfirmedTarget,
  writeRecord,
} from "./record.js";
export type {
  AcknowledgmentMethod,
  AuthorizationRecord,
  SessionAuthorization,
} from "./record.js";

export { buildSessionAuthorization } from "./session.js";
export type { BuildSessionAuthorizationInput } from "./session.js";

export {
  AUTHORIZED_USE_NOTICE,
  nonInteractiveHelp,
  renderRisks,
  targetNotice,
} from "./notice.js";
