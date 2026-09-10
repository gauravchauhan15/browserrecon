#!/usr/bin/env node
/**
 * Scaffold a workspace package.
 *
 *   node scripts/new-package.mjs packages/policy "Target policy and enforcement decisions"
 *   node scripts/new-package.mjs packages/ai/ollama "Ollama provider" --deps core,config
 *
 * The build plan's §31 tree is the full intended layout. Packages are created
 * as their dev-plan story arrives rather than all at once, so the repo never
 * carries directories that do nothing.
 */
import { mkdir, writeFile, readFile, access } from "node:fs/promises";
import { join, basename } from "node:path";

const [, , relPath, description, ...rest] = process.argv;

if (!relPath || !description) {
  console.error("usage: node scripts/new-package.mjs <path> <description> [--deps a,b]");
  process.exit(1);
}

const depFlag = rest.indexOf("--deps");
const deps = depFlag === -1 ? [] : (rest[depFlag + 1] ?? "").split(",").filter(Boolean);

const name = basename(relPath);
const pkgName = `@browserrecon/${name}`;
const root = process.cwd();
const dir = join(root, relPath);

const exists = await access(dir).then(
  () => true,
  () => false,
);
if (exists) {
  console.error(`refusing to overwrite existing ${relPath}`);
  process.exit(1);
}

const depth = relPath.split("/").length;
const up = "../".repeat(depth);

await mkdir(join(dir, "src"), { recursive: true });

await writeFile(
  join(dir, "package.json"),
  JSON.stringify(
    {
      name: pkgName,
      version: "0.0.0",
      private: true,
      description,
      license: "Apache-2.0",
      type: "module",
      main: "./dist/index.js",
      types: "./dist/index.d.ts",
      exports: { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" } },
      scripts: { build: "tsc --build", clean: "rm -rf dist *.tsbuildinfo" },
      dependencies: Object.fromEntries(deps.map((d) => [`@browserrecon/${d}`, "workspace:*"])),
    },
    null,
    2,
  ) + "\n",
);

await writeFile(
  join(dir, "tsconfig.json"),
  JSON.stringify(
    {
      extends: `${up}tsconfig.base.json`,
      compilerOptions: { outDir: "dist", rootDir: "src" },
      include: ["src/**/*"],
      exclude: ["src/**/*.test.ts"],
      references: deps.map((d) => ({ path: `${up}packages/${d}` })),
    },
    null,
    2,
  ) + "\n",
);

await writeFile(
  join(dir, "src", "index.ts"),
  `/**
 * ${pkgName} — ${description}
 *
 * Public API only. Internals stay unexported; consumers may not deep-import
 * (enforced by eslint, dev plan §2.4).
 */

/** Package identity, used by diagnostics and the \`doctor\` command. */
export const PACKAGE_NAME = ${JSON.stringify(pkgName)} as const;
`,
);

await writeFile(
  join(dir, "src", "index.test.ts"),
  `import { describe, expect, it } from "vitest";
import { PACKAGE_NAME } from "./index.js";

describe(${JSON.stringify(pkgName)}, () => {
  it("exposes its identity", () => {
    expect(PACKAGE_NAME).toBe(${JSON.stringify(pkgName)});
  });
});
`,
);

await writeFile(
  join(dir, "README.md"),
  `# ${pkgName}

${description}

## Owns

_To be filled in by the story that implements this package._

## Does not own

_List what belongs to a neighbouring package, so the boundary stays explicit._

## Boundaries

See the dev plan §1.2 (dependency direction) and §2 (modularity contract).
Consumers import from the package root only — deep imports are an eslint error.
`,
);

// Register in the root solution tsconfig so `tsc --build` picks it up.
const solutionPath = join(root, "tsconfig.json");
const solution = JSON.parse(await readFile(solutionPath, "utf8"));
solution.references.push({ path: `./${relPath}` });
solution.references.sort((a, b) => a.path.localeCompare(b.path));
await writeFile(solutionPath, JSON.stringify(solution, null, 2) + "\n");

console.log(`created ${relPath} (${pkgName})`);
if (deps.length) console.log(`  depends on: ${deps.join(", ")}`);
console.log(`  next: fill in src/index.ts and the README's Owns/Does not own sections`);
