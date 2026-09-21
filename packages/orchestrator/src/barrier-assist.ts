/**
 * Interactive barrier assist — build plan §10C.7, §7.3; dev plan BR-M1-29b.
 *
 * Some barriers only a person can clear: an SSO redirect to a corporate IdP,
 * an MFA prompt, a CAPTCHA. In **headed** mode the operator is sitting in
 * front of a visible browser, so the useful thing is to stop, let them do
 * it, and carry on.
 *
 * ## What this is not
 *
 * It is not a solver, and the distinction is absolute rather than a matter
 * of degree. §7.3 puts circumvention permanently out of scope, so there is
 * no code path anywhere in this repository that attempts to answer a
 * challenge, and `no-solver.test.ts` scans the source to keep it that way.
 * The tool waits for a person, or it records the barrier and moves on.
 *
 * The line is worth stating precisely, because "pause for a human" and
 * "solve it" can be made to look adjacent. They are not: one is a person
 * deciding to authenticate to a system they are authorized to test, and the
 * other is software defeating a control that system chose to apply.
 *
 * ## Why headless never prompts
 *
 * A prompt in CI is a hang, and a hung pipeline is worse than a partial
 * scan — nobody sees it for an hour, and the fix is to kill the job and
 * lose the data. So headless records the barrier and continues, always, and
 * the report says a barrier was hit rather than pretending coverage.
 */
import type { BarrierCategory } from "@browserrecon/collector-network";

/**
 * Barriers a person at the keyboard could plausibly clear.
 *
 * Deliberately narrow. A `forbidden` or `robots_excluded` barrier is the
 * target saying no, and prompting an operator to "handle" it would be
 * inviting them to override a decision the target made — which is the same
 * circumvention §7.3 rules out, one human step removed.
 */
export const HUMAN_CLEARABLE: ReadonlySet<BarrierCategory> = new Set<BarrierCategory>([
  "authentication_required",
  "challenge_detected",
  "auth_state_lost",
]);

export type AssistDecision =
  | { readonly action: "prompt"; readonly reason: string }
  | { readonly action: "record"; readonly reason: string };

export interface AssistContext {
  readonly category: BarrierCategory;
  readonly headless: boolean;
  /** True in CI. A terminal may exist and still have nobody watching it. */
  readonly nonInteractive: boolean;
  /** Set when the operator has already said "stop asking". */
  readonly assistDisabled?: boolean | undefined;
}

/**
 * Whether to pause for the operator.
 *
 * Every path that is not `prompt` records the barrier and continues. There
 * is no third outcome in which the scan stops or the challenge is answered.
 */
export function decideAssist(context: AssistContext): AssistDecision {
  if (context.assistDisabled === true) {
    return { action: "record", reason: "assist disabled by --no-barrier-assist" };
  }
  if (context.headless) {
    // The load-bearing case. Checked before anything else so that no later
    // condition can accidentally make a headless run prompt.
    return { action: "record", reason: "headless: there is no visible browser to act in" };
  }
  if (context.nonInteractive) {
    return { action: "record", reason: "non-interactive: no operator to ask" };
  }
  if (!HUMAN_CLEARABLE.has(context.category)) {
    return {
      action: "record",
      reason: `${context.category} is the target refusing, not a challenge for a person to clear`,
    };
  }
  return { action: "prompt", reason: "headed and interactive: the operator can clear this" };
}

export type AssistOutcome = "cleared" | "skipped" | "timed_out" | "not_offered";

/** Recorded in the session so the report can say a human intervened. */
export interface AssistRecord {
  readonly at: string;
  readonly url: string;
  readonly category: BarrierCategory;
  readonly outcome: AssistOutcome;
  /** How long the operator was given, for the report's timeline. */
  readonly waitedMs: number;
}

/** Default wait. Long enough for an MFA push, short enough not to look hung. */
export const ASSIST_TIMEOUT_MS = 120_000;

export interface AssistPrompt {
  /**
   * Ask the operator to clear the barrier in the visible browser.
   *
   * Resolves `cleared` when they say they are done, `skipped` when they
   * decline. Never resolves with anything the tool did itself.
   */
  ask(input: {
    readonly url: string;
    readonly category: BarrierCategory;
    readonly timeoutMs: number;
  }): Promise<"cleared" | "skipped">;
}

export interface RunAssistInput {
  readonly context: AssistContext;
  readonly url: string;
  readonly prompt: AssistPrompt;
  readonly timeoutMs?: number | undefined;
  readonly now: () => number;
  /** Injected so the timeout is testable without waiting (§36.1). */
  readonly sleep: (ms: number) => Promise<void>;
}

/**
 * Offer the assist, and always produce a record.
 *
 * A timeout falls back to recording the barrier rather than retrying or
 * waiting longer: an operator who has not answered in two minutes has walked
 * away, and the scan finishing with a recorded barrier is more useful than
 * one still sitting at a prompt.
 */
export async function runAssist(input: RunAssistInput): Promise<AssistRecord> {
  const started = input.now();
  const decision = decideAssist(input.context);
  const at = new Date(started).toISOString();

  if (decision.action === "record") {
    return {
      at,
      url: input.url,
      category: input.context.category,
      outcome: "not_offered",
      waitedMs: 0,
    };
  }

  const timeoutMs = input.timeoutMs ?? ASSIST_TIMEOUT_MS;
  const outcome = await Promise.race([
    input.prompt.ask({ url: input.url, category: input.context.category, timeoutMs }),
    input.sleep(timeoutMs).then((): AssistOutcome => "timed_out"),
  ]);

  return {
    at,
    url: input.url,
    category: input.context.category,
    outcome,
    waitedMs: input.now() - started,
  };
}
