import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildEventEnvelopeSchema } from "./schema.js";
import { EVENT_TYPES } from "./event-types.js";
import { PROVENANCE } from "./provenance.js";

const COMMITTED = join(process.cwd(), "schemas/events/event-envelope.schema.json");

describe("event envelope schema", () => {
  it("derives its enums from the TypeScript constants", () => {
    // Single source of truth: the enums exist once, and the schema is built
    // from them rather than hand-maintained alongside them.
    const schema = buildEventEnvelopeSchema();
    const properties = schema.properties as Record<string, { enum?: string[] }>;

    expect(properties.type?.enum).toEqual([...EVENT_TYPES]);
    expect(properties.provenance?.enum).toEqual([...PROVENANCE]);
  });

  it("requires the fields §13.2 declares mandatory", () => {
    const schema = buildEventEnvelopeSchema();
    expect(schema.required).toEqual([
      "event_id",
      "session_id",
      "timestamp",
      "sequence",
      "type",
      "provenance",
      "auth_context",
      "payload",
    ]);
  });

  it("forbids unknown properties", () => {
    // An envelope with extra fields is a version mismatch, not a valid
    // envelope — better to reject it loudly than to silently ignore data.
    expect(buildEventEnvelopeSchema().additionalProperties).toBe(false);
  });

  it("constrains ids by pattern so a random UUID cannot validate", () => {
    const properties = buildEventEnvelopeSchema().properties as Record<
      string,
      { pattern?: string }
    >;
    const pattern = properties.event_id?.pattern;
    expect(pattern).toBeDefined();

    const regex = new RegExp(pattern as string);
    expect(regex.test("evt_000001")).toBe(true);
    expect(regex.test("f47ac10b-58cc-4372-a567-0e02b2c3d479")).toBe(false);
  });

  it("matches the committed copy under schemas/", () => {
    // Drift check. The committed schema is what downstream consumers read
    // (§23), so it failing here is the point: regenerate and commit rather
    // than letting the published contract diverge from the code.
    expect(
      existsSync(COMMITTED),
      "schemas/events/event-envelope.schema.json is missing — run `node scripts/generate-schemas.mjs`",
    ).toBe(true);

    const committed = JSON.parse(readFileSync(COMMITTED, "utf8"));
    expect(committed).toEqual(buildEventEnvelopeSchema());
  });
});
