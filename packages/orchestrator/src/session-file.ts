/**
 * `session.json` — build plan §22.2, §30, §7.4; dev plan BR-M1-28, BR-M1-29.
 *
 * The file that makes a session directory self-describing. Three audiences,
 * and each one is why a field exists:
 *
 *  - **`resume`** reads the policy digest to decide whether continuing is
 *    honest (§30). A resumed scan under a different scope produces one
 *    report describing two different boundaries, which is worse than no
 *    report — so the digest is compared and a mismatch is refused.
 *  - **The report** reads phase outcomes and completeness, because §10C.6
 *    will not let a run that lost its crawler claim complete coverage.
 *  - **A person, later**, reading a directory they do not remember creating.
 *    The authorization record (§7.4) is there so the question "was this
 *    allowed?" has an answer that does not depend on anyone's memory.
 *
 * Written after every phase rather than once at the end. A scan killed mid-
 * run is the case `resume` exists for, and a `session.json` that only
 * appears on clean exit would be missing exactly then.
 */
import { createHash } from "node:crypto";
import { renameSync, writeFileSync } from "node:fs";
import type { PhaseOutcome } from "./phases.js";

export const SESSION_FILE_VERSION = 1 as const;

/** A budget raise, recorded so a report can say the scan was extended. */
export interface BudgetExtension {
  readonly at: string;
  readonly field: string;
  readonly from: number;
  readonly to: number;
}

export interface SessionSegment {
  readonly startedAt: string;
  readonly finishedAt?: string | undefined;
  /** First and last event sequence this run of the scan produced. */
  readonly firstSequence: number;
  readonly lastSequence: number;
}

export interface SessionFile {
  readonly version: typeof SESSION_FILE_VERSION;
  readonly sessionId: string;
  readonly target: string;
  readonly tool: { readonly name: string; readonly version: string };
  /**
   * Fingerprint of the settings a resume may not change (§30).
   *
   * A digest rather than the settings themselves: the comparison has to be
   * exact and total, and a field-by-field check is a field-by-field chance
   * to forget one.
   */
  readonly policyDigest: string;
  /** The settings the digest covers, for a readable refusal message. */
  readonly policySummary: Readonly<Record<string, string>>;
  /** §7.4: how the operator asserted they were permitted to scan. */
  readonly authorization: unknown;
  readonly phases: readonly PhaseOutcome[];
  readonly completeness: "complete" | "partial";
  readonly stopReason?: string | undefined;
  /** One entry per run: the original scan, then each resume. */
  readonly segments: readonly SessionSegment[];
  readonly budgetExtensions: readonly BudgetExtension[];
}

/**
 * Settings a resume may not change, per §30's semantics table.
 *
 * Scope, methods and identity decide *what the scan was allowed to touch*.
 * Changing one mid-session means the coverage report describes a boundary
 * that never existed. Budget and thoroughness only decide how much of the
 * same boundary was covered, so they may be raised.
 */
export const IMMUTABLE_FOR_RESUME = [
  "target",
  "allowedOrigins",
  "allowedMethods",
  "excludedPaths",
  "authProfile",
  "denyLoopback",
  "denyPrivateRanges",
  "followExternalRedirects",
] as const;

export type ImmutableSetting = (typeof IMMUTABLE_FOR_RESUME)[number];

/**
 * Fingerprint the settings a resume may not change.
 *
 * Keys are sorted and values normalised so that two policies differing only
 * in the order a list was written produce the same digest. A spurious
 * refusal teaches users to reach for `--seed-from` when they did not need
 * it, which costs them the continuity they were trying to keep.
 */
export function digestPolicy(summary: Readonly<Record<string, string>>): string {
  const canonical = [...IMMUTABLE_FOR_RESUME]
    .map((key) => `${key}=${normalizeValue(summary[key] ?? "")}`)
    .join("\n");
  return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}

function normalizeValue(value: string): string {
  // Lists are compared as sets: `GET,HEAD` and `HEAD,GET` are the same
  // boundary, and refusing the second would be pedantry with a cost.
  return value.includes(",")
    ? value
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part !== "")
        .sort()
        .join(",")
    : value.trim();
}

/**
 * Write `session.json` atomically.
 *
 * Through a temporary file and a rename, because the reader is `resume` and
 * the writer is a process that may be killed at any moment — which is the
 * only reason `resume` exists. A half-written `session.json` would turn a
 * recoverable interruption into an unreadable session.
 */
export function writeSessionFile(path: string, session: SessionFile): void {
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

/** Parse without throwing. Returns the problem instead. */
export function parseSessionFile(text: string): SessionFile | { readonly error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { error: `session.json is not valid JSON: ${(error as Error).message}` };
  }

  // `JSON.parse("null")` succeeds, so the type check has to come first
  // rather than riding on an optional chain.
  if (parsed === null || typeof parsed !== "object") {
    return { error: "session.json is not an object" };
  }

  const candidate = parsed as Partial<SessionFile>;
  if (candidate.version !== SESSION_FILE_VERSION) {
    return {
      error: `session.json has version ${String(candidate.version)}, expected ${SESSION_FILE_VERSION}`,
    };
  }
  if (typeof candidate.sessionId !== "string" || typeof candidate.policyDigest !== "string") {
    return { error: "session.json is missing sessionId or policyDigest" };
  }
  return candidate as SessionFile;
}
