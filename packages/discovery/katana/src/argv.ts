/**
 * Katana's command line, derived from the Target Policy — build plan §9.1,
 * §8.5 rule 1; dev plan BR-M1-15.
 *
 * ## This is a safety file
 *
 * Katana's own default is 150 requests per second. The `polite` profile is
 * 2. Launching Katana without deriving its flags from the policy means a user
 * who asked for a careful scan gets one seventy-five times heavier than they
 * agreed to — against a target they own but may share with real users.
 *
 * §8.5 rule 1 is therefore that every rate-bearing flag comes from
 * `policy.limits`, never from Katana's defaults and never from a constant
 * here. The test asserts the constructed argv directly, because that is the
 * only thing that actually reaches the process.
 */

export interface KatanaLimits {
  readonly maxRequestsPerSecond: number;
  readonly maxConcurrency: number;
  readonly maxRuntimeMinutes: number;
  readonly maxDepth: number;
}

export interface KatanaArgvInput {
  readonly target: string;
  readonly limits: KatanaLimits;
  /** Origins the policy allows, which become Katana's scope. */
  readonly allowedOrigins: readonly string[];
  /** Where to write JSONL. Katana streams it. */
  readonly outputPath?: string | undefined;
}

/**
 * Build the argv.
 *
 * Exported separately from the process spawn so the flags can be asserted
 * without running anything — a test that had to start Katana could not run
 * in CI, and this is exactly the code that must be tested there.
 */
export function buildKatanaArgv(input: KatanaArgvInput): string[] {
  const { limits } = input;

  const argv = [
    "-u",
    input.target,
    // Headless, because Katana's job here is breadth. Runtime depth comes
    // from our own instrumented Chrome (§5A.3).
    "-jsonl",
    "-silent",
    // --- rate, all from policy (§8.5 rule 1) ---------------------------
    // -rl: requests per second.
    "-rl",
    String(Math.max(1, Math.floor(limits.maxRequestsPerSecond))),
    // -c: concurrent fetchers.
    "-c",
    String(Math.max(1, Math.floor(limits.maxConcurrency))),
    // -p: parallel hosts. Pinned to 1 — the policy's rate is per target, and
    // letting Katana spread across hosts would multiply it.
    "-p",
    "1",
    // -rd: crawl depth.
    "-d",
    String(Math.max(1, Math.floor(limits.maxDepth))),
    // -ct: total crawl duration, so Katana cannot outlive the scan's budget.
    "-ct",
    `${Math.max(1, Math.floor(limits.maxRuntimeMinutes))}m`,
  ];

  // Scope. Katana takes a regex per allowed host; anchoring it stops a
  // crawl of `app.test` wandering onto `notapp.test.evil`.
  for (const origin of input.allowedOrigins) {
    try {
      argv.push("-cs", `^https?://${escapeRegex(new URL(origin).host)}(/|$)`);
    } catch {
      // A malformed origin cannot widen scope, so it is dropped rather than
      // passed through as an unanchored pattern.
    }
  }

  if (input.outputPath !== undefined) argv.push("-o", input.outputPath);
  return argv;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Read the rate a built argv actually carries, for assertions and logs. */
export function rateFromArgv(argv: readonly string[]): number | undefined {
  const index = argv.indexOf("-rl");
  if (index === -1) return undefined;
  const value = Number(argv[index + 1]);
  return Number.isFinite(value) ? value : undefined;
}
