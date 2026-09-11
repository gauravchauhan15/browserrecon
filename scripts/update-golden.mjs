#!/usr/bin/env node
/**
 * Record golden baselines — dev plan BR-M0-14.
 *
 *   pnpm test:golden:update
 *
 * A separate script rather than `VAR=1 vitest ...` inline in package.json for
 * two reasons: that form does not work in a Windows shell, and recording
 * baselines deserves to say out loud what it is about to do. Rewriting the
 * expectations a test suite checks against is the one operation in this repo
 * that can turn a bug into the documented behaviour, so it should never feel
 * like an ordinary test run.
 *
 * Updating is refused under CI by the harness itself (tests/golden/src/
 * snapshot.ts), not here — a guard that only lives in the script a workflow
 * happens to call is no guard at all.
 */
import { spawnSync } from "node:child_process";

const CI = process.env.CI;
if (CI !== undefined && CI !== "" && CI !== "0" && CI !== "false") {
  console.error(
    "refusing to record baselines under CI. Run this locally and commit the result.",
  );
  process.exit(1);
}

// Build first, and refuse to record if it fails.
//
// Tests import workspace packages by name, which resolves to each package's
// `dist/` — so a source edit that has not been compiled is invisible to the
// suite. Recording baselines from stale build output would write down the
// behaviour of code that no longer exists, which is precisely the silent
// drift this harness exists to prevent. (Verified by probe: changing a fixture
// and re-running without a build left every golden test green.)
const built = spawnSync("node_modules/.bin/tsc", ["--build"], { stdio: "inherit" });
if (built.status !== 0) {
  console.error("build failed — refusing to record baselines from stale output.");
  process.exit(built.status ?? 1);
}

console.log("Recording golden baselines.");
console.log("These files are the expected output of the whole pipeline — review the");
console.log("resulting `git diff` before committing, the same as any other change.\n");

const result = spawnSync(
  "node_modules/.bin/vitest",
  ["run", "tests/golden", "--reporter", "default"],
  {
    stdio: "inherit",
    env: { ...process.env, BROWSERRECON_UPDATE_GOLDEN: "1" },
  },
);

if (result.error !== undefined) {
  console.error(`could not run vitest: ${result.error.message}`);
  process.exit(1);
}

if (result.status !== 0) {
  console.error("\nbaseline run failed — nothing was recorded for the failing subjects.");
  process.exit(result.status ?? 1);
}

// `git status --porcelain`, not `git diff`: a newly recorded baseline is
// untracked, so a diff shows nothing and the script would report "no change"
// on the very run that created a file. That is the run where an accurate
// summary matters most.
const status = spawnSync("git", ["status", "--porcelain", "--", "tests/golden/baselines"], {
  encoding: "utf8",
});
const changed = (status.stdout ?? "")
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line !== "");

if (changed.length === 0) {
  console.log("\nNo baseline changed.");
} else {
  console.log(`\n${changed.length} baseline file(s) recorded or changed:`);
  for (const line of changed) console.log(`  ${line}`);
  console.log("\nReview the diff before committing.");
}
