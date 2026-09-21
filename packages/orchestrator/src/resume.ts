/**
 * Resume semantics — build plan §30 (resume semantics table, `--seed-from`),
 * §22.1, §9.5.3; dev plan BR-M1-29.
 *
 * ## The refusal is the feature
 *
 * Resuming looks like a convenience and is actually a correctness boundary.
 * A session produces one coverage report, and a coverage report is a claim
 * about *what was reachable inside a stated boundary*. Resume the same
 * session with a different scope, a different method set or a different
 * identity and the report describes a boundary that never existed — half the
 * pages were seen as an anonymous visitor under one origin list, half as an
 * administrator under another, and nothing in the output says so.
 *
 * That is worse than no report, because it is a report someone will act on.
 * So a changed boundary is refused, and the refusal points at `--seed-from`,
 * which does the thing the user actually wanted: a **new** session, with the
 * new policy, that keeps the URLs the old one found.
 *
 * Budget and thoroughness are different in kind. They decide how much of the
 * same boundary was covered, not what the boundary was, so raising them is
 * allowed and recorded.
 */
import type { BudgetExtension, SessionFile } from "./session-file.js";
import { IMMUTABLE_FOR_RESUME, digestPolicy } from "./session-file.js";

/**
 * How long a gap makes a resumed session worth warning about.
 *
 * A day, because a deploy is the thing that invalidates the assumption a
 * resume rests on — that the two halves describe the same application — and
 * a day is roughly the granularity at which that stops being safe to
 * assume. It is a warning rather than a refusal: the user knows whether
 * their target shipped anything, and the tool does not.
 */
export const STALENESS_THRESHOLD_MS = 24 * 60 * 60 * 1000;

/** Settings a resume may raise. */
export interface ResumeBudget {
  readonly maxPages: number;
  readonly maxRuntimeMinutes: number;
}

export interface ResumeRequest {
  readonly prior: SessionFile;
  /** The new run's values for the settings the digest covers. */
  readonly policySummary: Readonly<Record<string, string>>;
  readonly priorBudget: ResumeBudget;
  readonly budget: ResumeBudget;
  readonly now: Date;
  readonly stalenessThresholdMs?: number | undefined;
}

export interface ResumeAllowed {
  readonly allowed: true;
  /** Raises to record in `session.json`, original → new. */
  readonly extensions: readonly BudgetExtension[];
  readonly warnings: readonly string[];
}

export interface ResumeRefused {
  readonly allowed: false;
  /** Which immutable settings differ, named so the message is actionable. */
  readonly changed: readonly string[];
  readonly message: string;
}

export type ResumeDecision = ResumeAllowed | ResumeRefused;

export function decideResume(request: ResumeRequest): ResumeDecision {
  const changed = [...IMMUTABLE_FOR_RESUME].filter(
    (key) =>
      digestPolicy({
        ...request.prior.policySummary,
        [key]: request.policySummary[key] ?? "",
      }) !== request.prior.policyDigest,
  );

  if (changed.length > 0) {
    return {
      allowed: false,
      changed,
      message: [
        `This session was scanned with a different boundary, so it cannot be resumed:`,
        ...changed.map(
          (key) =>
            `  ${key}: was ${describe(request.prior.policySummary[key])}, now ${describe(request.policySummary[key])}`,
        ),
        "",
        "Resuming would produce one coverage report describing two different",
        "boundaries, and nothing in it would say so.",
        "",
        `Use --seed-from ${request.prior.sessionId} to start a new session with the new`,
        "settings, seeded with the URLs this one already found.",
      ].join("\n"),
    };
  }

  const extensions: BudgetExtension[] = [];
  const warnings: string[] = [];
  const at = request.now.toISOString();

  for (const field of ["maxPages", "maxRuntimeMinutes"] as const) {
    const from = request.priorBudget[field];
    const to = request.budget[field];
    if (to === from) continue;
    if (to > from) {
      extensions.push({ at, field, from, to });
      continue;
    }
    // Lowering is not a boundary change, so it is allowed — but a budget
    // already spent means the resumed scan stops immediately, and silently
    // doing nothing looks like a broken command.
    warnings.push(
      `${field} was lowered from ${from} to ${to}; the resumed scan may stop straight away.`,
    );
  }

  const last = request.prior.segments.at(-1);
  const since = last?.finishedAt ?? last?.startedAt;
  const threshold = request.stalenessThresholdMs ?? STALENESS_THRESHOLD_MS;
  if (since !== undefined) {
    const elapsed = request.now.getTime() - Date.parse(since);
    if (Number.isFinite(elapsed) && elapsed > threshold) {
      warnings.push(
        `The previous segment ended ${formatGap(elapsed)} ago. If the target has been ` +
          `deployed since, this session's report will describe two different versions of it.`,
      );
    }
  }

  return { allowed: true, extensions, warnings };
}

function describe(value: string | undefined): string {
  return value === undefined || value === "" ? "(unset)" : value;
}

function formatGap(ms: number): string {
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"}`;
  return `${Math.floor(hours / 24)} days`;
}

/**
 * What a resumed scan must not visit again.
 *
 * Visited URLs are obvious. Saturated templates are the subtle half
 * (§9.5.3): a resume that re-walks `/product/{id}` because the *instances*
 * are new URLs would spend its whole budget re-confirming a template the
 * first run already decided it had seen enough of. The saturation verdict is
 * part of the session's state, not of one run's memory.
 */
export interface PriorCoverage {
  readonly visited: readonly string[];
  readonly saturatedTemplates: readonly string[];
}

export interface SeedPlan {
  /** Offered to the new queue. */
  readonly candidates: readonly string[];
  /** Skipped, with the reason, so the report can say why. */
  readonly skipped: readonly { readonly url: string; readonly reason: string }[];
}

/**
 * Decide what to re-offer when resuming.
 *
 * `templateOf` is injected rather than imported so this stays testable
 * without the discovery package, and so the caller controls which
 * normalisation is in force.
 */
export function planResume(
  registry: readonly string[],
  prior: PriorCoverage,
  templateOf: (url: string) => string,
): SeedPlan {
  const visited = new Set(prior.visited);
  const saturated = new Set(prior.saturatedTemplates);
  const candidates: string[] = [];
  const skipped: { url: string; reason: string }[] = [];

  for (const url of registry) {
    if (visited.has(url)) {
      skipped.push({ url, reason: "already_visited" });
      continue;
    }
    if (saturated.has(templateOf(url))) {
      skipped.push({ url, reason: "template_saturated" });
      continue;
    }
    candidates.push(url);
  }

  return { candidates, skipped };
}

/**
 * Seeding a *new* session from an old one's findings (§30, `--seed-from`).
 *
 * The prior registry comes across; the prior policy does not. That asymmetry
 * is the entire point — the user is changing the boundary on purpose, and
 * inheriting the old one silently would undo the change they asked for.
 *
 * The new session filters the inherited URLs through its own policy, so a
 * URL the old scope allowed and the new one does not is dropped here rather
 * than at the browser. An imported list can never widen scope.
 */
export function seedFrom(
  registry: readonly string[],
  allowedByNewPolicy: (url: string) => boolean,
): SeedPlan {
  const candidates: string[] = [];
  const skipped: { url: string; reason: string }[] = [];

  for (const url of registry) {
    if (allowedByNewPolicy(url)) candidates.push(url);
    else skipped.push({ url, reason: "out_of_scope_for_new_policy" });
  }

  return { candidates, skipped };
}
