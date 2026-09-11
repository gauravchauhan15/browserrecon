/**
 * Exit codes — dev plan BR-M0-11.
 *
 * A security tool lives in pipelines, and a pipeline can only branch on what
 * the process told it. "Non-zero" is not enough information: a scan that was
 * refused for being out of scope needs a different reaction from one that
 * crashed, and both differ from a target that was simply unreachable.
 *
 * These are a public contract. Adding one is fine; changing what an existing
 * code means is a breaking change for every pipeline depending on it.
 */
export const EXIT_CODES = {
  /** The command did what was asked. A scan may still report partial coverage. */
  success: 0,
  /** An unexpected failure. A bug, not a user error. */
  internal: 1,
  /** Bad arguments or an unknown command. */
  usage: 2,
  /** Configuration could not be loaded or validated. */
  configuration: 3,
  /** Authorization was not given or could not be obtained (§7.4). */
  authorization: 4,
  /** The Target Policy refused the request (§7). */
  policy: 5,
  /** The target could not be reached or behaved unusably. */
  target: 6,
  /** A required external dependency is missing (§25.2, §42). */
  dependency: 7,
} as const;

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

/** Human-readable meanings, rendered by `--help` so the contract is visible. */
export const EXIT_CODE_DESCRIPTIONS: Readonly<Record<number, string>> = {
  0: "success",
  1: "internal error",
  2: "usage error",
  3: "configuration error",
  4: "authorization not given",
  5: "refused by target policy",
  6: "target unreachable or unusable",
  7: "missing external dependency",
};

/**
 * An error carrying the exit code the process should use.
 *
 * Lets a command fail with an accurate code from wherever the failure happens,
 * instead of every layer having to thread one back up by hand.
 */
export class CliError extends Error {
  constructor(
    override readonly message: string,
    readonly code: ExitCode,
    /** Optional next step. Shown under the error, so a failure is actionable. */
    readonly hint?: string,
    /**
     * The message has already been written to stderr by someone else.
     *
     * Commander prints its own parse errors before handing control back, so
     * without this the user sees "unknown command 'nonsense'" twice.
     */
    readonly reported: boolean = false,
  ) {
    super(message);
    this.name = "CliError";
  }
}
