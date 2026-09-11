import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Asserts that every test file in the repo is actually type-checked.
 *
 * `tsconfig.test.json` selects test files with glob patterns, and a package
 * laid out in a shape those globs do not anticipate would simply not be
 * checked. That failure is silent — the file still runs, still passes, and
 * nothing reports that its types were never looked at. It is the same bug the
 * test project was created to fix, scoped to one directory instead of all of
 * them, so it deserves a mechanical guard rather than a convention.
 *
 * The check spawns the compiler rather than reimplementing glob matching:
 * asking TypeScript what it reads is the only answer that cannot disagree with
 * TypeScript.
 */

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));

const SEARCH_ROOTS = ["apps", "packages", "tests"];
const SKIP_DIRS = new Set(["node_modules", "dist", "coverage", "baselines"]);

function testFilesOnDisk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return SKIP_DIRS.has(entry.name) ? [] : testFilesOnDisk(path);
    return entry.name.endsWith(".test.ts") ? [relative(repoRoot, path)] : [];
  });
}

describe("test-suite type checking", () => {
  it("covers every test file in the repo", () => {
    const onDisk = SEARCH_ROOTS.flatMap((root) => testFilesOnDisk(join(repoRoot, root))).sort();

    // Sanity floor: if the walk breaks, an empty list would make the
    // comparison below pass while proving nothing.
    expect(onDisk.length).toBeGreaterThan(20);

    const listed = spawnSync(
      join(repoRoot, "node_modules", ".bin", "tsc"),
      ["-p", "tsconfig.test.json", "--listFiles", "--noEmit"],
      { cwd: repoRoot, encoding: "utf8" },
    );

    const checked = (listed.stdout ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.endsWith(".test.ts") && !line.includes("node_modules"))
      .map((line) => relative(repoRoot, line))
      .sort();

    const missing = onDisk.filter((file) => !checked.includes(file));
    expect(
      missing,
      "these test files are not type-checked — widen the include patterns in " +
        "tsconfig.test.json rather than leaving them unchecked",
    ).toEqual([]);
  });
});
