import { describe, expect, it } from "vitest";
import { COVERAGE_CAVEAT } from "@browserrecon/coverage";
import {
  PROVENANCES,
  SURFACE_CAVEAT,
  SURFACE_KINDS,
  buildAttackSurface,
  buildAttackSurfaceSchema,
  resolveChain,
  validateSurface,
  type ResolveInput,
  type SurfaceItem,
} from "./index.js";

const known: ResolveInput = {
  knownWorkflows: new Set(["wf_0001"]),
  knownApis: new Set(["api_0001"]),
  knownEvents: new Set(["evt_000001", "evt_000002"]),
  knownInteractions: new Set(["int_0001"]),
  knownNavigations: new Set(["nav_0001"]),
};

const item = (over: Partial<Omit<SurfaceItem, "surface_id">> = {}) => ({
  kind: "api_endpoint" as const,
  identity: "GET https://shop.example.com/api/orders",
  provenance: "observed" as const,
  auth_context: "anonymous",
  source_event_ids: ["evt_000001"],
  ...over,
});

const surface = (items: ReturnType<typeof item>[]) =>
  buildAttackSurface({ sessionId: "sess_0001", target: "https://shop.example.com", items });

describe("§35B.5: the traceability chain", () => {
  it("walks a surface item back to its observations", () => {
    // "any claim in report.md can be walked back to the raw observations
    // that produced it."
    const chain = resolveChain(
      {
        surface_id: "srf_0001",
        ...item({
          workflow_id: "wf_0001",
          api_id: "api_0001",
          interaction_id: "int_0001",
          navigation_id: "nav_0001",
        }),
      },
      known,
    );

    expect(chain.map((link) => link.level)).toEqual([
      "surface",
      "workflow",
      "api",
      "event",
      "interaction",
      "navigation",
    ]);
    expect(chain.every((link) => link.resolved)).toBe(true);
  });

  it("reports every broken link, not the first", () => {
    // A reader debugging a broken chain wants to see where it broke; a
    // caller validating a model wants every problem at once.
    const chain = resolveChain(
      { surface_id: "srf_0001", ...item({ workflow_id: "wf_9999", api_id: "api_9999" }) },
      known,
    );
    expect(chain.filter((link) => !link.resolved)).toHaveLength(2);
  });

  it("calls an item with no source events a bug, by name", () => {
    // §35B.5: "A derived object without resolvable source IDs is a bug."
    const problems = validateSurface(surface([item({ source_event_ids: [] })]), known);
    expect(problems[0]?.problem).toContain("§35B.5");
  });

  it("refuses an id that resolves to nothing", () => {
    const problems = validateSurface(surface([item({ workflow_id: "wf_9999" })]), known);
    expect(problems.map((p) => p.problem)).toContain("workflow wf_9999 does not resolve");
  });

  it("refuses an item that does not know which identity saw it", () => {
    const problems = validateSurface(surface([item({ auth_context: "" })]), known);
    expect(problems[0]?.problem).toContain("auth_context");
  });

  it("passes a sound model", () => {
    expect(
      validateSurface(surface([item(), item({ identity: "GET /api/cart" })]), known),
    ).toEqual([]);
  });

  it("catches a duplicate id", () => {
    const built = surface([item()]);
    const doubled = { ...built, items: [...built.items, built.items[0] as SurfaceItem] };
    expect(validateSurface(doubled, known).map((p) => p.problem)).toContain(
      "duplicate surface_id",
    );
  });
});

describe("stable ids", () => {
  it("assigns ids in a deterministic order, not discovery order", () => {
    // `srf_0001` means the same thing across two runs, which is what lets a
    // consumer diff this week against last. Arrival order varies with what
    // the browser did first — M1 measured that it is not stable.
    const first = surface([item({ identity: "GET /zebra" }), item({ identity: "GET /alpha" })]);
    const second = surface([
      item({ identity: "GET /alpha" }),
      item({ identity: "GET /zebra" }),
    ]);

    expect(first.items.map((i) => i.identity)).toEqual(second.items.map((i) => i.identity));
    expect(first.items[0]?.surface_id).toBe("srf_0001");
  });

  it("groups by kind before identity", () => {
    const built = surface([
      item({ kind: "route", identity: "/aaa" }),
      item({ kind: "api_endpoint", identity: "GET /zzz" }),
    ]);
    expect(built.items[0]?.kind).toBe("api_endpoint");
  });

  it("is byte-identical for identical input", () => {
    const build = () =>
      JSON.stringify(surface([item({ identity: "GET /b" }), item({ identity: "GET /a" })]));
    expect(build()).toBe(build());
  });
});

describe("the caveat travels with the model", () => {
  it("is on the object, not left to the renderer", () => {
    // A caveat a consumer has to remember to add goes missing exactly when
    // the model is forwarded.
    expect(surface([item()]).coverage_caveat).toBe(SURFACE_CAVEAT);
    // The same sentence the coverage summary prints. One caveat, so a
    // report cannot hedge twice in two different ways about one scan.
    expect(SURFACE_CAVEAT).toBe(COVERAGE_CAVEAT);
    expect(SURFACE_CAVEAT).toMatch(/not a claim of complete application coverage/i);
  });
});

describe("the published schema", () => {
  const schema = buildAttackSurfaceSchema() as Record<string, any>;

  it("enumerates the kinds and provenances the code uses", () => {
    // Drift between the schema and the types is how a consumer validates
    // successfully against data the producer can no longer emit.
    expect(schema.$defs.surfaceItem.properties.kind.enum).toEqual([...SURFACE_KINDS]);
    expect(schema.$defs.surfaceItem.properties.provenance.enum).toEqual([...PROVENANCES]);
  });

  it("requires at least one source event", () => {
    expect(schema.$defs.surfaceItem.properties.source_event_ids.minItems).toBe(1);
  });

  it("accepts the ids this package produces", () => {
    const built = surface([item()]);
    const pattern = new RegExp(schema.$defs.surfaceItem.properties.surface_id.pattern);
    expect(pattern.test(built.items[0]?.surface_id ?? "")).toBe(true);
  });

  it("describes Tier 0's absent semantic block rather than requiring it", () => {
    // §35B.6: the deterministic content is byte-identical between tiers, so
    // an absent `semantic` must not be the same as an empty one.
    expect(schema.$defs.surfaceItem.required).not.toContain("semantic");
  });
});
