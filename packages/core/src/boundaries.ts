/**
 * Where redaction applies — build plan §37.2's boundary table, as code.
 *
 * dev plan BR-M1-25.
 *
 * The table is in the plan as prose. Written down here it becomes something a
 * caller has to consult rather than remember, and something a test can assert
 * — which matters because the interesting entry is the one that says *do not
 * redact*, and that is exactly the entry a well-meaning change would "fix".
 *
 * ## Why the event store is raw, on purpose
 *
 * §22.1 writes raw observations first by design. The store is the evidence
 * correlation depends on: a redacted `Authorization` header cannot be matched
 * against the session that produced it, and a blanked response body cannot be
 * mined for the endpoint it mentions. The user's disk is the trust boundary,
 * and the tool's job is to say so plainly rather than to decide for them.
 *
 * So `.output/` is created with restrictive permissions, the docs say it
 * holds unredacted material, and `.gitignore` excludes it — three defences
 * around a deliberate decision, rather than one quiet compromise of it.
 */
import { chmodSync, mkdirSync } from "node:fs";

/** Every place scan data can end up. */
export const OUTPUT_BOUNDARIES = [
  "event_store",
  "local_llm_context",
  "report_markdown",
  "attack_surface_json",
  "diagnostic_log",
  "terminal_summary",
  "remote_sink",
] as const;

export type OutputBoundary = (typeof OUTPUT_BOUNDARIES)[number];

export interface BoundaryRule {
  readonly boundary: OutputBoundary;
  readonly redact: boolean;
  /** Whether a user may deliberately turn redaction off for their own pipeline. */
  readonly optOutAllowed: boolean;
  readonly why: string;
}

/** §37.2's table. The order matches the plan so the two can be read together. */
export const BOUNDARY_RULES: readonly BoundaryRule[] = [
  {
    boundary: "event_store",
    redact: false,
    optOutAllowed: false,
    why: "Raw by design (§22.1). It is the evidence correlation depends on and never leaves the machine; redacting here would destroy the data the tool exists to collect.",
  },
  {
    boundary: "local_llm_context",
    redact: true,
    optOutAllowed: false,
    why: "A local model is still a consumer, and prompt and response logs are a real leak path.",
  },
  {
    boundary: "report_markdown",
    redact: true,
    optOutAllowed: false,
    why: "A report is written to be sent to someone.",
  },
  {
    boundary: "attack_surface_json",
    redact: true,
    optOutAllowed: true,
    why: "Redacted by default; a user feeding their own pipeline may opt in to raw values deliberately.",
  },
  {
    boundary: "diagnostic_log",
    redact: true,
    optOutAllowed: false,
    why: "A log line goes to a terminal someone screenshots and an issue someone pastes into.",
  },
  {
    boundary: "terminal_summary",
    redact: true,
    optOutAllowed: false,
    why: "Printed where a colleague can read over a shoulder, and often pasted into chat.",
  },
  {
    boundary: "remote_sink",
    redact: true,
    optOutAllowed: false,
    // There is no such sink today (§38 promises no telemetry). The rule
    // exists so that adding one cannot arrive without this decision already
    // made against it.
    why: "Unconditional, with no opt-out. Anything leaving the machine is redacted.",
  },
];

const BY_BOUNDARY = new Map(BOUNDARY_RULES.map((rule) => [rule.boundary, rule]));

/** Whether output at this boundary must be redacted. */
export function requiresRedaction(boundary: OutputBoundary): boolean {
  return BY_BOUNDARY.get(boundary)?.redact ?? true;
}

/**
 * Whether a user may turn redaction off here.
 *
 * Unknown boundaries answer `false`. A boundary nobody wrote a rule for is
 * one nobody decided about, and defaulting a security question to permissive
 * is how the decision gets made by accident.
 */
export function mayOptOut(boundary: OutputBoundary): boolean {
  return BY_BOUNDARY.get(boundary)?.optOutAllowed ?? false;
}

/** Owner-only: `rwx------` for directories. */
export const OUTPUT_DIR_MODE = 0o700;

/**
 * Create the output directory so only its owner can read it.
 *
 * `.output/` holds unredacted cookies, tokens and request bodies. On a shared
 * machine the default umask can leave it group- or world-readable, which is
 * the one case where the "your disk is the trust boundary" argument stops
 * being true.
 *
 * `mkdir`'s own mode is not enough. A umask can only *remove* permission
 * bits, so `mkdir(0o700)` is always at most 0700 — but `mkdir` with
 * `recursive: true` does nothing at all to a directory that already exists.
 * A `.output/` left behind by an earlier version, or created by hand with
 * `mkdir -p`, keeps whatever mode it had. The `chmod` is what closes that
 * one, which is also the case a long-running project hits most often.
 */
export function createSecureOutputDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: OUTPUT_DIR_MODE });
  try {
    chmodSync(path, OUTPUT_DIR_MODE);
  } catch {
    // Windows, or a filesystem without POSIX modes. The directory exists,
    // which is the part that must not fail; the permission tightening is a
    // best effort the docs also cover.
  }
}

/** The warning the docs and the terminal summary both have to carry. */
export const UNREDACTED_OUTPUT_WARNING =
  ".output/ contains UNREDACTED captured data — cookies, tokens, authorization " +
  "headers and request bodies. Do not commit it, attach it to a ticket, or sync " +
  "it to cloud storage.";
