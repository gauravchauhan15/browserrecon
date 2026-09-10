import { describe, expect, it } from "vitest";
import { IdFactory } from "@browserrecon/core";
import { createEnvelope, validateEnvelope } from "./envelope.js";
import { EVENT_TYPES } from "./event-types.js";
import { PROVENANCE } from "./provenance.js";

const ids = () => new IdFactory();

function validInput(overrides: Record<string, unknown> = {}) {
  const factory = ids();
  return {
    event_id: factory.next("event"),
    session_id: factory.sessionId,
    sequence: 1,
    type: "network_request" as const,
    provenance: "observed" as const,
    auth_context: "anonymous",
    timestamp: "2026-09-10T09:15:23.182Z",
    payload: {},
    ...overrides,
  };
}

describe("createEnvelope", () => {
  it("produces every §13.2 field", () => {
    const envelope = createEnvelope(validInput());

    expect(envelope).toMatchObject({
      event_id: "evt_000001",
      session_id: "sess_0001",
      timestamp: "2026-09-10T09:15:23.182Z",
      sequence: 1,
      type: "network_request",
      provenance: "observed",
      auth_context: "anonymous",
      payload: {},
    });
  });

  it("omits absent optional context rather than setting it to undefined", () => {
    // A serialized `"page_id": null` would assert the event had no page,
    // when the truth is only that it had no page *context*.
    const envelope = createEnvelope(validInput());

    expect("page_id" in envelope).toBe(false);
    expect("navigation_id" in envelope).toBe(false);
    expect("workflow_id" in envelope).toBe(false);
    expect(JSON.stringify(envelope)).not.toContain("page_id");
  });

  it("includes optional context when supplied", () => {
    const factory = ids();
    const envelope = createEnvelope(
      validInput({
        page_id: factory.next("page"),
        navigation_id: factory.next("navigation"),
      }),
    );

    expect(envelope.page_id).toBe("page_0001");
    expect(envelope.navigation_id).toBe("nav_0001");
  });

  it("defaults the timestamp but never the ordering", () => {
    const envelope = createEnvelope({ ...validInput(), timestamp: undefined });
    expect(envelope.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(envelope.sequence).toBe(1);
  });
});

describe("validateEnvelope", () => {
  it("accepts a well-formed envelope", () => {
    const result = validateEnvelope(createEnvelope(validInput()));
    expect(result.ok).toBe(true);
  });

  it("accepts every declared event type and provenance value", () => {
    // Guards against the failure that motivated §13.1's authoritative-list
    // rule: a type described elsewhere in the plan but unrepresentable here.
    for (const type of EVENT_TYPES) {
      expect(validateEnvelope(createEnvelope(validInput({ type }))).ok).toBe(true);
    }
    for (const provenance of PROVENANCE) {
      expect(validateEnvelope(createEnvelope(validInput({ provenance }))).ok).toBe(true);
    }
  });

  it("rejects a non-object", () => {
    for (const value of [null, undefined, 42, "evt", []]) {
      expect(validateEnvelope(value).ok).toBe(false);
    }
  });

  it("reports every violation at once, not just the first", () => {
    // A corrupt log line should describe everything wrong with it in one
    // pass, rather than one problem per re-run.
    const result = validateEnvelope({
      event_id: "nope",
      session_id: "nope",
      timestamp: "yesterday",
      sequence: 0,
      type: "not_a_type",
      provenance: "vibes",
      auth_context: "",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    const fields = result.violations.map((v) => v.field);
    expect(fields).toEqual(
      expect.arrayContaining([
        "event_id",
        "session_id",
        "timestamp",
        "sequence",
        "type",
        "provenance",
        "auth_context",
        "payload",
      ]),
    );
  });

  it("rejects an unknown event type", () => {
    const result = validateEnvelope(
      createEnvelope(validInput({ type: "telemetry_ping" as never })),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.violations[0]?.field).toBe("type");
  });

  it("requires auth_context, since coverage correctness depends on it", () => {
    // §12.3: without this, a route hit while logged out is indistinguishable
    // from a genuinely public one — and every coverage number after a silent
    // session expiry would be wrong while looking authoritative.
    const { auth_context: _omitted, ...withoutAuth } = createEnvelope(validInput());
    const result = validateEnvelope(withoutAuth);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.violations.map((v) => v.field)).toContain("auth_context");
  });

  it("requires payload even when empty", () => {
    const { payload: _omitted, ...withoutPayload } = createEnvelope(validInput());
    const result = validateEnvelope(withoutPayload);
    expect(result.ok).toBe(false);
  });

  it("rejects malformed optional context when present", () => {
    const result = validateEnvelope({ ...createEnvelope(validInput()), page_id: "page_x" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.violations[0]?.field).toBe("page_id");
  });

  it("survives a JSONL round-trip", () => {
    // The real read path: a line written to events.jsonl and parsed back.
    const original = createEnvelope(validInput({ payload: { method: "GET", status: 200 } }));
    const line = JSON.stringify(original);
    const result = validateEnvelope(JSON.parse(line));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.envelope).toEqual(original);
  });
});
