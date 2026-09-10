/**
 * The authorization block written into `session.json` — build plan §7.4 point 3.
 *
 * An exported scan has to carry evidence of the assertion it ran under.
 * Without this, the acknowledgment exists only on the machine that produced
 * the scan, and an artifact handed to someone else says nothing about the
 * authority it was collected under.
 *
 * Deliberately narrower than the stored record: this run's assertion, not the
 * user's history of every other target they have confirmed. A scan artifact
 * that leaked an operator's whole target list would be a privacy problem in
 * its own right.
 */
import type { ElevatedRisk } from "@browserrecon/policy";
import type { AcknowledgmentMethod, SessionAuthorization } from "./record.js";

export interface BuildSessionAuthorizationInput {
  readonly method: AcknowledgmentMethod;
  readonly targetOrigin: string;
  /** Higher-risk settings the user was shown and accepted. */
  readonly risks: readonly ElevatedRisk[];
  readonly now?: (() => Date) | undefined;
}

/** Build the block for `session.json`. */
export function buildSessionAuthorization(
  input: BuildSessionAuthorizationInput,
): SessionAuthorization {
  const now = input.now ?? ((): Date => new Date());
  return {
    acknowledged: true,
    method: input.method,
    at: now().toISOString(),
    targetOrigin: input.targetOrigin,
    // Setting names only. The consequence text is guidance for a human at the
    // prompt, not a fact about the scan, so recording it would bloat every
    // artifact with prose that adds nothing to the evidence.
    acceptedRisks: input.risks.map((risk) => risk.setting),
  };
}
