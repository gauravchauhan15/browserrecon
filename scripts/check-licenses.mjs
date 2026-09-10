#!/usr/bin/env node
/**
 * License allowlist gate — dev plan BR-M0-02.
 *
 * BrowserRecon ships under Apache-2.0. A single GPL/AGPL dependency arriving
 * transitively would silently impose copyleft obligations on distribution, so
 * this runs from M0 rather than at release: catching it in the PR that
 * introduces it costs nothing, catching it at BR-M7-04 could mean
 * rearchitecting.
 *
 *   node scripts/check-licenses.mjs
 */
import { spawnSync } from "node:child_process";

/** Permissive licenses compatible with Apache-2.0 redistribution. */
const ALLOWED = new Set([
  "MIT",
  "MIT-0",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "0BSD",
  "Unlicense",
  "CC0-1.0",
  "BlueOak-1.0.0",
  "Python-2.0",
]);

/**
 * Packages allowed past the gate despite an unrecognised license field, each
 * with a reason. Never add an entry without checking the actual license file.
 */
const EXCEPTIONS = new Map([
  // e.g. ["some-pkg", "dual MIT/X11, license field malformed upstream"],
]);

/**
 * Resolve an SPDX-ish expression against the allowlist.
 * `A OR B` passes if either side is allowed; `A AND B` needs both.
 */
function isAllowed(expression) {
  const expr = String(expression ?? "").trim();
  if (!expr) return false;
  if (ALLOWED.has(expr)) return true;

  const cleaned = expr.replace(/[()]/g, " ").trim();

  if (/\sOR\s/i.test(cleaned)) {
    return cleaned.split(/\sOR\s/i).some((part) => isAllowed(part.trim()));
  }
  if (/\sAND\s/i.test(cleaned)) {
    return cleaned.split(/\sAND\s/i).every((part) => isAllowed(part.trim()));
  }
  return ALLOWED.has(cleaned);
}

/**
 * Resolve pnpm however it happens to be available: invoked through pnpm
 * itself, via a global shim, or via corepack (which is how this repo ships
 * it — see docs/architecture/decisions.md). Trying each in turn keeps the
 * script runnable identically on a laptop and on a CI runner.
 */
function runPnpm(args) {
  const execPath = process.env.npm_execpath;
  const candidates = [];

  if (execPath && /\.(c?js)$/.test(execPath)) {
    candidates.push({ cmd: process.execPath, argv: [execPath, ...args] });
  }
  candidates.push({ cmd: "pnpm", argv: args });
  candidates.push({ cmd: "corepack", argv: ["pnpm", ...args] });

  let last;
  for (const { cmd, argv } of candidates) {
    last = spawnSync(cmd, argv, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (last.error?.code === "ENOENT") continue;
    if (last.stdout?.trim()) return last;
  }
  return last;
}

// No --prod/--dev flags: passing both together makes pnpm return `{}`, which
// would make this gate report a pass having inspected nothing. Bare `licenses
// list` covers the whole installed tree.
const result = runPnpm(["licenses", "list", "--json"]);

if (!result?.stdout?.trim()) {
  console.error("could not enumerate licenses — is pnpm available?");
  console.error(result?.stderr || result?.error?.message || "(no output)");
  process.exit(1);
}

let byLicense;
try {
  byLicense = JSON.parse(result.stdout);
} catch {
  console.error("could not parse `pnpm licenses list --json` output");
  process.exit(1);
}

const violations = [];
let checked = 0;
const seenLicenses = new Set();

for (const [license, packages] of Object.entries(byLicense)) {
  seenLicenses.add(license);
  for (const pkg of packages) {
    checked++;
    if (isAllowed(license)) continue;
    if (EXCEPTIONS.has(pkg.name)) continue;
    violations.push({
      name: pkg.name,
      versions: (pkg.versions ?? []).join(", "),
      license,
    });
  }
}

console.log(`license gate: ${checked} package(s) checked`);
console.log(`  licenses present: ${[...seenLicenses].sort().join(", ")}`);

// Fail closed. A gate that reports success having inspected nothing is worse
// than no gate at all — it manufactures confidence. An empty result means the
// enumeration broke (wrong flags, no install, changed output format), not
// that the tree is clean.
if (checked === 0) {
  console.error(
    "\n  FAIL  license enumeration returned no packages.\n\n" +
      "  This is a broken gate, not a clean tree. Check that dependencies are\n" +
      "  installed and that `pnpm licenses list --json` still returns a map of\n" +
      "  license -> packages.\n",
  );
  process.exit(1);
}

if (violations.length > 0) {
  console.error(`\n  FAIL  ${violations.length} package(s) outside the allowlist:\n`);
  for (const v of violations) {
    console.error(`    ${v.name}@${v.versions}  ->  ${v.license}`);
  }
  console.error(
    `\n  Allowed: ${[...ALLOWED].join(", ")}\n\n` +
      "  A copyleft (GPL/AGPL/LGPL) or unknown license here changes BrowserRecon's\n" +
      "  own distribution obligations. Either drop the dependency, or — if the\n" +
      "  license field is simply wrong upstream — verify the actual LICENSE file\n" +
      "  and add a documented entry to EXCEPTIONS in this script.\n",
  );
  process.exit(1);
}

console.log("\n  PASS  all dependencies are permissively licensed\n");
