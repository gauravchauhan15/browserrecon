/**
 * The pre-scan authorization gate — build plan §7.4.
 *
 * Pure decision logic: given what is stored, what was passed, whether a
 * terminal exists, and which settings carry elevated risk, decide whether the
 * scan may start. Prompting and persistence are the caller's job, which keeps
 * this testable without a TTY and keeps the rule in one auditable place.
 *
 * Two invariants:
 *
 *   - **No acknowledgment, no scan.** There is no code path that reaches the
 *     browser without passing through here.
 *   - **Never block waiting for input that cannot arrive.** A pipeline with no
 *     terminal gets a clear failure, never a hang. A gate that deadlocks CI is
 *     a gate people rip out.
 */
import type { ElevatedRisk } from "@browserrecon/policy";
import {
  nonInteractiveHelp,
  renderRisks,
  targetNotice,
  AUTHORIZED_USE_NOTICE,
} from "./notice.js";
import type { AcknowledgmentMethod, AuthorizationRecord } from "./record.js";

export interface GateRequest {
  readonly targetOrigin: string;
  /** Stored record, or undefined on a machine that has never acknowledged. */
  readonly record: AuthorizationRecord | undefined;
  /** `--i-am-authorized` was passed. */
  readonly flagProvided: boolean;
  /** A terminal is attached, so the user can be asked. */
  readonly interactive: boolean;
  /** Higher-risk settings, from `elevatedRisks(policy)`. */
  readonly risks: readonly ElevatedRisk[];
}

export type GateDenialReason =
  | "not_acknowledged_non_interactive"
  | "target_not_confirmed_non_interactive"
  | "risks_not_accepted_non_interactive";

/** Proceed. */
export interface GateAllowed {
  readonly kind: "allowed";
  readonly method: AcknowledgmentMethod;
  /** True when the stored record needs creating or updating afterwards. */
  readonly recordNeedsUpdate: boolean;
  /** Risk text to print anyway, so an elevated setting is never silent. */
  readonly notice: string;
}

/** Ask the user, then call `confirm()` on a yes. */
export interface GatePrompt {
  readonly kind: "prompt";
  /** Everything to show before asking. Already formatted. */
  readonly notice: string;
  /** The question itself. */
  readonly question: string;
}

/** Refuse, with something actionable. */
export interface GateDenied {
  readonly kind: "denied";
  readonly reason: GateDenialReason;
  readonly message: string;
}

export type GateOutcome = GateAllowed | GatePrompt | GateDenied;

const CONFIRM_QUESTION = "Are you authorized to test this target? [y/N] ";

/**
 * Decide whether a scan may start.
 *
 * Three questions, in order of severity: has this machine ever acknowledged
 * the terms; has this target been confirmed; and have elevated risks been
 * accepted for this run. Elevated risks are re-shown every time rather than
 * remembered, because "I once agreed that DELETE was fine" should not carry
 * silently into a different scan a month later.
 */
export function evaluateGate(request: GateRequest): GateOutcome {
  const { targetOrigin, record, flagProvided, interactive, risks } = request;
  const riskText = renderRisks(risks);
  const hasRisks = risks.length > 0;

  // The flag asserts authorization for this run outright. It is the documented
  // CI path, and in CI the assertion lives visibly in the pipeline definition
  // rather than in a file on a runner.
  if (flagProvided) {
    return {
      kind: "allowed",
      method: "flag",
      recordNeedsUpdate:
        record === undefined || !record.confirmedTargets.includes(targetOrigin),
      notice: riskText,
    };
  }

  const firstRun = record === undefined;
  const newTarget = !firstRun && !record.confirmedTargets.includes(targetOrigin);

  if (!interactive) {
    if (firstRun) {
      return {
        kind: "denied",
        reason: "not_acknowledged_non_interactive",
        message: `${AUTHORIZED_USE_NOTICE}\n\n${nonInteractiveHelp(targetOrigin)}`,
      };
    }
    if (newTarget) {
      return {
        kind: "denied",
        reason: "target_not_confirmed_non_interactive",
        message: nonInteractiveHelp(targetOrigin),
      };
    }
    if (hasRisks) {
      // A previously-confirmed target does not carry consent for newly
      // enabled destructive settings, and there is no terminal in which to
      // ask, so this needs the explicit flag.
      return {
        kind: "denied",
        reason: "risks_not_accepted_non_interactive",
        message: `${riskText}\n\n${nonInteractiveHelp(targetOrigin)}`,
      };
    }
    return { kind: "allowed", method: "config", recordNeedsUpdate: false, notice: "" };
  }

  if (firstRun) {
    return {
      kind: "prompt",
      notice: [AUTHORIZED_USE_NOTICE, "", targetNotice(targetOrigin), riskText]
        .filter((part) => part !== "")
        .join("\n"),
      question: CONFIRM_QUESTION,
    };
  }

  if (newTarget || hasRisks) {
    return {
      kind: "prompt",
      notice: [targetNotice(targetOrigin), riskText].filter((part) => part !== "").join("\n\n"),
      question: CONFIRM_QUESTION,
    };
  }

  return { kind: "allowed", method: "config", recordNeedsUpdate: false, notice: "" };
}

/** Whether a typed answer counts as consent. Anything else does not. */
export function isAffirmative(answer: string): boolean {
  const normalized = answer.trim().toLowerCase();
  // Deliberately narrow, and empty input is a "no": the prompt shows [y/N],
  // so someone pressing Enter to get past it must not be taken as agreement.
  return normalized === "y" || normalized === "yes";
}
