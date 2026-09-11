/**
 * @browserrecon/golden — Golden-output normalization, baselines and the
 * deliberate update flow. Build plan §36.2, §23; dev plan BR-M0-14.
 *
 * A golden test runs BrowserRecon against a fixture, normalizes the output,
 * and compares it to a committed baseline. It is the only test that can catch
 * a change nobody thought to assert — a field quietly dropped from an export,
 * a correlation that stops firing, a schema that drifts from what consumers
 * read.
 *
 * Two rules make it worth having, and both are enforced in code rather than
 * remembered:
 *
 *   1. Masking is declared in one file, counted, and the counts are stored in
 *      the baseline (masking.ts). Over-masking becomes a reviewable diff
 *      instead of silent green.
 *   2. A missing baseline fails. Baselines are only ever written when a human
 *      runs `pnpm test:golden:update`, and never under CI (snapshot.ts).
 *
 * Public API only. Internals stay unexported; consumers may not deep-import
 * (enforced by eslint, dev plan §2.4).
 */
import { fileURLToPath } from "node:url";
import type { GoldenEnvironment } from "./snapshot.js";

/** Package identity, used by diagnostics and the `doctor` command. */
export const PACKAGE_NAME = "@browserrecon/golden" as const;

export { MASK_RULES, MASK_RULE_NAMES, renderMaskTable } from "./masking.js";
export type { FieldRule, MaskReport, MaskRule, Placeholder, ValueRule } from "./masking.js";

export { combine, normalizeJson, normalizeJsonl, normalizeText } from "./normalize.js";
export type { NormalizeResult } from "./normalize.js";

export { UPDATE_ENV, compareToBaseline, expectGolden, renderDiff } from "./snapshot.js";
export type { GoldenEnvironment, GoldenOutcome } from "./snapshot.js";

/**
 * Build the environment a golden test runs in.
 *
 * The environment is passed in rather than read here because only
 * `packages/config` may touch `process.env` (dev plan §2.5); test files are
 * exempt from that rule, so each golden test supplies it in one line.
 *
 * `baselines` is a URL rather than a path so a test can write
 * `new URL("../baselines/", import.meta.url)` and get the right directory
 * whether the suite runs from source or from `dist`.
 */
export function goldenEnvironment(
  env: Readonly<Record<string, string | undefined>>,
  baselines: URL,
): GoldenEnvironment {
  return { env, dir: fileURLToPath(baselines) };
}
