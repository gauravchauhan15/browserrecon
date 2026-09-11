/**
 * Baseline storage and the update flow — build plan §36.2, dev plan BR-M0-14.
 *
 * ## Why a missing baseline is a failure
 *
 * The obvious design writes the baseline on first run and compares afterwards.
 * It is also the design that makes golden tests worthless, because the moment
 * a baseline is deleted — by a merge conflict resolved the lazy way, by a
 * `git clean`, by a renamed test — the next run recreates it from whatever the
 * code currently does and passes. The bug gets blessed as the expected answer,
 * and the commit that did it looks like a green test run.
 *
 * So a missing baseline fails and says how to create one. Writing only ever
 * happens when a human asks for it:
 *
 *     pnpm test:golden:update
 *
 * ## Why updating is refused under CI
 *
 * Even with the flag, updating is refused when `CI` is set. Otherwise the
 * whole guarantee rests on nobody ever adding the variable to a workflow
 * file — and a CI job that rewrites its own expectations reports success
 * unconditionally, which is worse than having no test.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { NormalizeResult } from "./normalize.js";

/** Set by `pnpm test:golden:update`. */
export const UPDATE_ENV = "BROWSERRECON_UPDATE_GOLDEN";

export interface GoldenEnvironment {
  /** Injected rather than read, so the refusal-under-CI path is testable. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Directory holding baseline files. */
  readonly dir: string;
}

export type GoldenOutcome =
  | { readonly status: "matched"; readonly path: string }
  | { readonly status: "written"; readonly path: string; readonly created: boolean }
  | { readonly status: "missing"; readonly path: string; readonly message: string }
  | {
      readonly status: "differs";
      readonly path: string;
      readonly message: string;
      readonly diff: string;
    };

/** Baseline text plus the mask report it was recorded with. */
function serialize(result: NormalizeResult): string {
  const report = Object.entries(result.report);
  const header = [
    "# Golden baseline. Regenerate with: pnpm test:golden:update",
    "#",
    "# Masked below. A change in these counts is a change in how much this",
    "# baseline is NOT asserting, and is as reviewable as a change in content.",
    ...(report.length === 0
      ? ["#   (nothing masked)"]
      : report.map(([rule, count]) => `#   ${rule}: ${count}`)),
    "",
  ].join("\n");
  return `${header}${result.text}`;
}

function wantsUpdate(env: Readonly<Record<string, string | undefined>>): boolean {
  const flag = env[UPDATE_ENV];
  return flag !== undefined && flag !== "" && flag !== "0" && flag !== "false";
}

function underCi(env: Readonly<Record<string, string | undefined>>): boolean {
  const ci = env.CI;
  return ci !== undefined && ci !== "" && ci !== "0" && ci !== "false";
}

/**
 * Compare a normalized result against its baseline.
 *
 * Returns an outcome rather than throwing, so the caller — and this package's
 * own meta-tests — can assert on every branch including the failures.
 */
export function compareToBaseline(
  name: string,
  result: NormalizeResult,
  environment: GoldenEnvironment,
): GoldenOutcome {
  const path = join(environment.dir, `${name}.golden.txt`);
  const next = serialize(result);
  const update = wantsUpdate(environment.env);

  if (update && underCi(environment.env)) {
    return {
      status: "differs",
      path,
      message:
        `${UPDATE_ENV} is set, but so is CI. Refusing to rewrite baselines in an ` +
        "automated run — a job that updates its own expectations always passes.",
      diff: "",
    };
  }

  if (!existsSync(path)) {
    if (!update) {
      return {
        status: "missing",
        path,
        message:
          `No baseline for "${name}" at ${path}.\n` +
          "A missing baseline is a failure, not a prompt to create one: auto-creating it " +
          "would bless whatever the code does today as correct.\n" +
          "Inspect the output, then record it deliberately with:\n\n" +
          "    pnpm test:golden:update\n",
      };
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, next, "utf8");
    return { status: "written", path, created: true };
  }

  const previous = readFileSync(path, "utf8");
  if (previous === next) return { status: "matched", path };

  if (update) {
    writeFileSync(path, next, "utf8");
    return { status: "written", path, created: false };
  }

  return {
    status: "differs",
    path,
    message:
      `Golden output for "${name}" changed.\n` +
      "If this change is intended, review the diff below, then record it with:\n\n" +
      "    pnpm test:golden:update\n",
    diff: renderDiff(previous, next),
  };
}

/** Differing line pairs shown before reporting a count instead. */
const MAX_DIFF_LINES = 40;

/**
 * A readable diff between two baselines.
 *
 * Deliberately not a minimal edit script. The two changes that actually happen
 * are "one value changed" and "a field was added to every record", and
 * trimming the common prefix and suffix shows both — where an LCS diff of a
 * thousand-line event log produces a wall of interleaved additions and
 * deletions that nobody reads.
 *
 * Trimming alone is not enough, though. Two changes far apart leave every
 * unchanged line between them inside the trimmed span, and printing those as
 * `-`/`+` pairs of identical text is worse than useless — it buries the two
 * lines that matter. So matching pairs inside the span are collapsed into a
 * count, which is what makes this readable for the realistic case of several
 * small changes in one file.
 */
export function renderDiff(expected: string, actual: string): string {
  const before = expected.split("\n");
  const after = actual.split("\n");

  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) {
    start += 1;
  }

  let end = 0;
  while (
    end < before.length - start &&
    end < after.length - start &&
    before[before.length - 1 - end] === after[after.length - 1 - end]
  ) {
    end += 1;
  }

  const changedBefore = before.slice(start, before.length - end);
  const changedAfter = after.slice(start, after.length - end);
  const span = Math.max(changedBefore.length, changedAfter.length);

  const pairs: { readonly line: number; readonly old?: string; readonly next?: string }[] = [];
  let identical = 0;
  for (let index = 0; index < span; index += 1) {
    const old = changedBefore[index];
    const next = changedAfter[index];
    if (old === next) {
      identical += 1;
      continue;
    }
    pairs.push({
      line: start + index + 1,
      ...(old === undefined ? {} : { old }),
      ...(next === undefined ? {} : { next }),
    });
  }

  const lines: string[] = [
    `${pairs.length} line(s) differ, starting at line ${pairs[0]?.line ?? start + 1}.`,
    "  - expected (baseline)",
    "  + actual (this run)",
    ...(identical > 0 ? [`  (${identical} unchanged line(s) between changes omitted)`] : []),
    "",
  ];

  for (const pair of pairs.slice(0, MAX_DIFF_LINES)) {
    if (pair.old !== undefined) lines.push(`  - ${pair.old}`);
    if (pair.next !== undefined) lines.push(`  + ${pair.next}`);
  }

  if (pairs.length > MAX_DIFF_LINES) {
    lines.push(`  … ${pairs.length - MAX_DIFF_LINES} further differing line(s) not shown.`);
  }

  return lines.join("\n");
}

/**
 * Assert a normalized result matches its baseline, throwing a readable failure.
 *
 * The thin wrapper a golden test actually calls.
 */
export function expectGolden(
  name: string,
  result: NormalizeResult,
  environment: GoldenEnvironment,
): GoldenOutcome {
  const outcome = compareToBaseline(name, result, environment);

  if (outcome.status === "missing") throw new Error(outcome.message);
  if (outcome.status === "differs") {
    throw new Error(`${outcome.message}\n${outcome.diff}`);
  }
  return outcome;
}
