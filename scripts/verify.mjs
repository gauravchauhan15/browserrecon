#!/usr/bin/env node
/**
 * `pnpm verify` — the one command to run before every push.
 *
 * Mirrors what CI will check (dev plan BR-M0-02), so a green run here means a
 * green run there.
 *
 * Tools are invoked from node_modules/.bin rather than through `pnpm run`, so
 * this works whether pnpm came from a global shim, corepack, or npx — and
 * avoids a package-manager recursion that only shows up on some machines.
 *
 * gitleaks is optional locally but required in CI. A missing scanner is
 * reported loudly rather than silently skipped: "going public exposes all
 * history", which makes one missed secret permanent.
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { existsSync } from "node:fs";

const bin = (tool) => {
  const local = join(process.cwd(), "node_modules", ".bin", tool);
  return existsSync(local) ? local : tool;
};

const steps = [
  { name: "typecheck", cmd: bin("tsc"), args: ["--build", "--force"], required: true },
  { name: "lint", cmd: bin("eslint"), args: ["."], required: true },
  { name: "format", cmd: bin("prettier"), args: ["--check", "."], required: true },
  { name: "test", cmd: bin("vitest"), args: ["run"], required: true },
  {
    name: "licenses",
    cmd: process.execPath,
    args: ["scripts/check-licenses.mjs"],
    required: true,
  },
  {
    name: "secret scan",
    cmd: "gitleaks",
    args: ["detect", "--no-banner", "--redact", "--log-opts=--all"],
    required: false,
    missingHint:
      "gitleaks not installed — git history is UNSCANNED locally.\n" +
      "        Install: brew install gitleaks   (CI enforces this regardless)",
  },
];

let failed = 0;
let skipped = 0;

for (const step of steps) {
  const started = Date.now();
  const result = spawnSync(step.cmd, step.args, { stdio: "inherit", shell: false });
  const secs = ((Date.now() - started) / 1000).toFixed(1);

  if (result.error?.code === "ENOENT") {
    if (step.required) {
      console.error(`\n  FAIL  ${step.name} — ${step.cmd} not found\n`);
      failed++;
    } else {
      console.warn(`\n  SKIP  ${step.name}\n        ${step.missingHint}\n`);
      skipped++;
    }
    continue;
  }

  if (result.status === 0) {
    console.log(`\n  PASS  ${step.name} (${secs}s)\n`);
  } else {
    console.error(`\n  FAIL  ${step.name} (${secs}s)\n`);
    failed++;
  }
}

console.log("─".repeat(60));
if (failed > 0) {
  console.error(`verify: ${failed} step(s) failed. Do not push.`);
  process.exit(1);
}
console.log(
  skipped > 0
    ? `verify: all checks passed, ${skipped} skipped (see hints above).`
    : "verify: all checks passed.",
);
