#!/usr/bin/env node
/**
 * Write the committed JSON Schemas from the TypeScript definitions.
 *
 *   node scripts/generate-schemas.mjs           # write
 *   node scripts/generate-schemas.mjs --check   # verify committed copies match
 *
 * The schemas are a public API (build plan §23), so they are committed and
 * published rather than generated at install time — a downstream consumer must
 * be able to read the contract from the repository. Generating them from the
 * same constants the types come from is what keeps a single source of truth;
 * `--check` in CI is what stops the committed copy drifting from it.
 *
 * Requires a build first, since it imports the compiled output.
 */
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";

const check = process.argv.includes("--check");
const root = process.cwd();

const built = join(root, "packages/events/dist/index.js");
if (!existsSync(built)) {
  console.error("packages/events is not built. Run `pnpm run build` first.");
  process.exit(1);
}

const { buildEventEnvelopeSchema } = await import(built);

const outputs = [
  {
    path: join(root, "schemas/events/event-envelope.schema.json"),
    schema: buildEventEnvelopeSchema(),
  },
];

let drifted = 0;

for (const { path, schema } of outputs) {
  const serialized = JSON.stringify(schema, null, 2) + "\n";
  const relative = path.slice(root.length + 1);

  if (check) {
    const existing = existsSync(path) ? await readFile(path, "utf8") : null;
    if (existing === serialized) {
      console.log(`  ok    ${relative}`);
    } else {
      console.error(`  DRIFT ${relative}`);
      drifted++;
    }
    continue;
  }

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, serialized);
  console.log(`  wrote ${relative}`);
}

if (check && drifted > 0) {
  console.error(
    `\n${drifted} schema(s) differ from the TypeScript definitions.\n` +
      "Run `node scripts/generate-schemas.mjs` and commit the result.\n",
  );
  process.exit(1);
}
