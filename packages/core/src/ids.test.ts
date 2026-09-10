import { describe, expect, it } from "vitest";
import { ID_KINDS, IdFactory, idKindOf, isId } from "./ids.js";

describe("IdFactory", () => {
  it("produces identical IDs for identical request sequences across runs", () => {
    // The whole reason IDs are not UUIDs (dev plan §1): golden-output tests
    // compare normalized scan output between runs, and any randomness here
    // makes every one of those comparisons fail.
    const run = (): string[] => {
      const ids = new IdFactory();
      return [
        ids.next("event"),
        ids.next("page"),
        ids.next("event"),
        ids.next("navigation"),
        ids.next("event"),
      ];
    };

    expect(run()).toEqual(run());
    expect(run()).toEqual(["evt_000001", "page_0001", "evt_000002", "nav_0001", "evt_000003"]);
  });

  it("numbers each kind independently", () => {
    const ids = new IdFactory();
    ids.next("event");
    ids.next("event");
    expect(ids.next("page")).toBe("page_0001");
    expect(ids.next("event")).toBe("evt_000003");
  });

  it("zero-pads so lexicographic order matches numeric order", () => {
    const ids = new IdFactory();
    const generated = Array.from({ length: 11 }, () => ids.next("event"));
    expect([...generated].sort()).toEqual(generated);
  });

  it("exposes a stable session id", () => {
    expect(new IdFactory(1).sessionId).toBe("sess_0001");
    expect(new IdFactory(42).sessionId).toBe("sess_0042");
  });

  it("does not let the session ordinal shift other counters", () => {
    // A user's second scan of the day must not renumber its events, or two
    // sessions of the same fixture would produce different golden output.
    expect(new IdFactory(7).next("event")).toBe(new IdFactory(1).next("event"));
  });

  it("rejects a non-positive session ordinal", () => {
    expect(() => new IdFactory(0)).toThrow(RangeError);
    expect(() => new IdFactory(1.5)).toThrow(RangeError);
  });

  it("counts allocations per kind", () => {
    const ids = new IdFactory();
    ids.next("event");
    ids.next("event");
    expect(ids.count("event")).toBe(2);
    expect(ids.count("workflow")).toBe(0);
  });

  describe("checkpoint and restore", () => {
    it("continues numbering rather than restarting", () => {
      // A resumed scan (build plan §30) appends to an existing event log.
      // Restarting the counters would emit IDs that collide with events
      // already persisted — silent corruption of the evidence base.
      const first = new IdFactory();
      first.next("event");
      first.next("event");
      first.next("page");

      const resumed = IdFactory.restore(1, first.snapshot());
      expect(resumed.next("event")).toBe("evt_000003");
      expect(resumed.next("page")).toBe("page_0002");
    });

    it("round-trips through JSON, as a real checkpoint would", () => {
      const original = new IdFactory();
      original.next("workflow");
      const restored = IdFactory.restore(1, JSON.parse(JSON.stringify(original.snapshot())));
      expect(restored.next("workflow")).toBe("wf_0002");
    });

    it("rejects an unknown kind in a checkpoint", () => {
      expect(() => IdFactory.restore(1, { nonsense: 4 } as never)).toThrow(TypeError);
    });

    it("rejects a corrupt counter value", () => {
      expect(() => IdFactory.restore(1, { event: -1 })).toThrow(RangeError);
      expect(() => IdFactory.restore(1, { event: 1.5 })).toThrow(RangeError);
    });
  });
});

describe("isId", () => {
  it("accepts a well-formed id", () => {
    expect(isId("evt_000001", "event")).toBe(true);
    expect(isId("wf_0003", "workflow")).toBe(true);
  });

  it("rejects the wrong kind, bad padding, and non-strings", () => {
    expect(isId("evt_000001", "workflow")).toBe(false);
    expect(isId("evt_1", "event")).toBe(false);
    expect(isId("evt_abcdef", "event")).toBe(false);
    expect(isId(undefined, "event")).toBe(false);
    expect(isId(12, "event")).toBe(false);
  });
});

describe("idKindOf", () => {
  it("recovers the kind from an id", () => {
    expect(idKindOf("evt_000001")).toBe("event");
    expect(idKindOf("tool_0007")).toBe("webmcpTool");
  });

  it("returns undefined for anything unrecognisable", () => {
    expect(idKindOf("unknown_0001")).toBeUndefined();
    expect(idKindOf("evt")).toBeUndefined();
    expect(idKindOf("evt_notanumber")).toBeUndefined();
    expect(idKindOf("")).toBeUndefined();
  });

  it("round-trips every declared kind", () => {
    const ids = new IdFactory();
    for (const kind of Object.keys(ID_KINDS) as (keyof typeof ID_KINDS)[]) {
      if (kind === "session") continue;
      expect(idKindOf(ids.next(kind))).toBe(kind);
    }
  });

  it("has no duplicate prefixes", () => {
    // Two kinds sharing a prefix would make idKindOf ambiguous and silently
    // misattribute IDs during correlation.
    const prefixes = Object.values(ID_KINDS).map((k) => k.prefix);
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });
});
