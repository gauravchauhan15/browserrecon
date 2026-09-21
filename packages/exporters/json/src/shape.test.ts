import { describe, expect, it } from "vitest";
import {
  COVERAGE_CAVEAT,
  EXPORT_SCHEMA_VERSION,
  REQUIRED_KEYS,
  validateDocument,
  type ExportedApi,
  type ExportedDocument,
} from "./shape.js";

function soundDocument(): ExportedDocument {
  return {
    schema_version: EXPORT_SCHEMA_VERSION,
    scan: {
      session_id: "sess_0001",
      target: "https://shop.example.com",
      started_at: "2026-01-15T10:00:00.000Z",
      completeness: "partial",
      stop_reason: "max_pages",
      rate_profile: "normal",
      discovery_sources: ["browser"],
      ai_mode: "off",
      coverage_caveat: COVERAGE_CAVEAT,
    },
    origins: [],
    apis: [],
    workflows: [],
    api_sequences: [],
    javascript: [],
    barriers: [],
    coverage_gaps: [],
    unreached_candidate_associations: [],
  };
}

const api = (overrides: Partial<ExportedApi> = {}): ExportedApi => ({
  api_id: "api_0001",
  method: "GET",
  url: "https://shop.example.com/api/cart",
  observed: { status: 200 },
  source_event_ids: ["evt_000001"],
  provenance: "observed",
  ...overrides,
});

describe("required keys", () => {
  it("accepts a document whose arrays are all empty", () => {
    // The point of the rule: empty is a valid, meaningful answer.
    expect(validateDocument(soundDocument())).toEqual([]);
  });

  it("rejects a document missing any required key", () => {
    for (const key of REQUIRED_KEYS) {
      const document: Partial<ExportedDocument> = { ...soundDocument() };
      delete document[key];
      expect(validateDocument(document), `${key} was allowed to be absent`).toContain(
        `missing required key: ${key}`,
      );
    }
  });

  it("requires the two keys a consumer would otherwise misread", () => {
    // §23.1 singles these out. A consumer that finds no `coverage_gaps` key
    // cannot tell "this scan had full coverage" from "this version does not
    // report gaps" — and will assume the first.
    expect(REQUIRED_KEYS).toContain("coverage_gaps");
    expect(REQUIRED_KEYS).toContain("unreached_candidate_associations");
  });

  it("covers every key of the document type", () => {
    // Drift guard: a key added to ExportedDocument without being added here
    // is a key the validator silently stops checking.
    expect([...REQUIRED_KEYS].sort()).toEqual(Object.keys(soundDocument()).sort());
  });
});

describe("the coverage caveat", () => {
  it("is required, and an empty one is not good enough", () => {
    const document = soundDocument();
    const problems = validateDocument({
      ...document,
      scan: { ...document.scan, coverage_caveat: "" },
    });
    expect(problems.join("\n")).toContain("coverage_caveat");
  });

  it("says coverage is bounded rather than complete", () => {
    expect(COVERAGE_CAVEAT).toMatch(/not everything that exists/i);
    expect(COVERAGE_CAVEAT).toMatch(/policy/i);
  });
});

describe("provenance", () => {
  it("rejects a derived object with no source events", () => {
    // §35B.5: a model nobody can trace back to observations is a claim, not
    // an observation. This is the check that keeps `provenance: "inferred"`
    // from quietly becoming "made up".
    const document = soundDocument();
    const problems = validateDocument({
      ...document,
      apis: [api({ api_id: "api_0009", source_event_ids: [] })],
    });
    expect(problems).toContain("api api_0009 has no source_event_ids");
  });

  it("accepts one that carries them", () => {
    const document = soundDocument();
    expect(validateDocument({ ...document, apis: [api()] })).toEqual([]);
  });
});

describe("the schema version", () => {
  it("is present and non-empty", () => {
    expect(EXPORT_SCHEMA_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(validateDocument({ ...soundDocument(), schema_version: "" })).toContain(
      "schema_version is present but empty",
    );
  });
});
