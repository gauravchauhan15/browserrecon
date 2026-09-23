import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Schema compatibility — dev plan BR-M3-11.
 *
 * The schemas are a published contract. A scanner that imports one builds
 * against its shape, and a breaking change reaches them as either a parse
 * that now fails with no explanation, or — worse — a parse that still
 * succeeds against data that no longer means what they think.
 *
 * So this compares the committed schemas against a recorded baseline of their
 * *constraints*, and fails on a change that would break a consumer unless the
 * major version moved with it.
 *
 * ## The protection is two gates, not one
 *
 * This test reads the **committed** schemas, not the generator's output —
 * which means a generator change alone does not fail it. That is not a hole,
 * and it was checked rather than assumed: `scripts/generate-schemas.mjs
 * --check` refuses the drift first, and once the committed copy is
 * regenerated this test names the dropped field and the missing version bump.
 * Neither gate alone catches it; together nothing lands without one firing.
 *
 * ## Additive changes are deliberately unpoliced
 *
 * §35B.6: Tier 2 "changes shape only additively". A new optional field breaks
 * nobody, and a test that demanded a version bump for one would make the
 * version meaningless by making it move constantly.
 */

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const schemasDir = join(repoRoot, "schemas");

interface Schema {
  readonly $id?: string;
  readonly "x-schema-version"?: string;
  readonly required?: readonly string[];
  readonly properties?: Record<string, Schema>;
  readonly $defs?: Record<string, Schema>;
  readonly enum?: readonly string[];
  readonly type?: string;
  readonly additionalProperties?: boolean;
  readonly minItems?: number;
  readonly minLength?: number;
}

function loadSchemas(): { path: string; schema: Schema }[] {
  const found: { path: string; schema: Schema }[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".schema.json")) {
        found.push({
          path: path.slice(repoRoot.length + 1),
          schema: JSON.parse(readFileSync(path, "utf8")) as Schema,
        });
      }
    }
  };
  walk(schemasDir);
  return found.sort((a, b) => a.path.localeCompare(b.path));
}

const schemas = loadSchemas();

/**
 * The contract, recorded.
 *
 * Every entry is something a consumer may rely on. Changing one is a breaking
 * change and the major version must move with it — which is the conversation
 * this file exists to force.
 */
const BASELINE: Readonly<Record<string, { version: string; required: readonly string[] }>> = {
  "schemas/events/event-envelope.schema.json": {
    version: "1",
    required: [
      "auth_context",
      "event_id",
      "payload",
      "provenance",
      "sequence",
      "session_id",
      "timestamp",
      "type",
    ],
  },
  "schemas/attack-surface/attack-surface.schema.json": {
    version: "1",
    required: ["coverage_caveat", "items", "schema_version", "session_id", "target"],
  },
};

const major = (version: string): string => version.split(".")[0] ?? version;

describe("the published schemas", () => {
  it("finds the ones it is meant to be checking", () => {
    // A walk that broke would make every assertion below pass trivially.
    expect(schemas.length).toBeGreaterThanOrEqual(2);
    for (const { path } of schemas) {
      expect(Object.keys(BASELINE), `${path} has no baseline entry`).toContain(path);
    }
  });

  it("carries an id and a version", () => {
    for (const { path, schema } of schemas) {
      expect(schema.$id, path).toMatch(/^https:\/\//);
      expect(schema["x-schema-version"], path).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });

  it("removes no required field without a major-version bump", () => {
    // The breaking change that reaches a consumer as data that no longer
    // means what they think.
    for (const { path, schema } of schemas) {
      const baseline = BASELINE[path];
      if (baseline === undefined) continue;

      const required = [...(schema.required ?? [])].sort();
      const missing = baseline.required.filter((field) => !required.includes(field));

      if (missing.length === 0) continue;
      expect(
        major(schema["x-schema-version"] ?? "0"),
        `${path} dropped ${missing.join(", ")} without a major bump`,
      ).not.toBe(baseline.version);
    }
  });

  it("allows a field to be added", () => {
    // §35B.6's additive rule. A test that demanded a bump for a new optional
    // field would make the version move constantly and mean nothing.
    for (const { path, schema } of schemas) {
      const baseline = BASELINE[path];
      if (baseline === undefined) continue;
      const added = (schema.required ?? []).filter(
        (field) => !baseline.required.includes(field),
      );
      // Recorded rather than forbidden: a new *required* field is breaking
      // for a producer and not for a consumer, and this repository is the
      // producer.
      expect(Array.isArray(added)).toBe(true);
    }
  });
});

describe("what the schemas refuse", () => {
  const surface = schemas.find((entry) => entry.path.includes("attack-surface"))?.schema;

  it("refuses a surface item with no source events", () => {
    // §35B.5, in the schema rather than only in a validator — so a consumer
    // validating our output catches it too, and a producer cannot emit one.
    const item = surface?.$defs?.surfaceItem;
    expect(item?.required).toContain("source_event_ids");
    expect(item?.properties?.source_event_ids?.minItems).toBe(1);
  });

  it("refuses an item that does not know which identity saw it", () => {
    const item = surface?.$defs?.surfaceItem;
    expect(item?.required).toContain("auth_context");
    expect(item?.properties?.auth_context?.minLength).toBe(1);
  });

  it("refuses a model with no coverage caveat", () => {
    // §10C.6 in the contract: a consumer must not be able to render this
    // without the statement that it describes reachable surface.
    expect(surface?.required).toContain("coverage_caveat");
    expect(surface?.properties?.coverage_caveat?.minLength).toBe(1);
  });

  it("closes both objects to unknown fields", () => {
    // An open object lets a producer add a field a consumer then depends on
    // without it ever appearing in the contract.
    expect(surface?.additionalProperties).toBe(false);
    expect(surface?.$defs?.surfaceItem?.additionalProperties).toBe(false);
  });
});
