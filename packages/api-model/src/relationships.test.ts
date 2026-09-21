import { describe, expect, it } from "vitest";
import {
  OBSERVED_KINDS,
  RELATIONSHIP_KINDS,
  RELATIONSHIP_STRENGTH,
  buildInitiatorChain,
  edgeFromInitiator,
  parseFrame,
  reduceRelationships,
  type Relationship,
} from "./index.js";

describe("the relationship taxonomy", () => {
  it("grades every kind", () => {
    // A kind with no strength cannot be compared, so `reduceRelationships`
    // would silently keep whichever arrived last.
    for (const kind of RELATIONSHIP_KINDS) {
      expect(RELATIONSHIP_STRENGTH[kind], kind).toBeTypeOf("number");
    }
  });

  it("treats only `direct` as something the browser reported", () => {
    // The filter the taxonomy exists for: a consumer that wants only what
    // Chrome actually said keeps `direct` and drops the rest.
    expect([...OBSERVED_KINDS]).toEqual(["direct"]);
  });

  it("ranks temporal as the weakest claim", () => {
    // §15: adjacency is the thing most likely to be mistaken for causality,
    // so it must lose to everything else.
    for (const kind of RELATIONSHIP_KINDS) {
      if (kind === "temporal") continue;
      expect(RELATIONSHIP_STRENGTH[kind]).toBeLessThan(RELATIONSHIP_STRENGTH.temporal);
    }
  });
});

describe("reducing edges", () => {
  const edge = (target: string, kind: Relationship["kind"]): Relationship => ({
    target,
    kind,
    basis: "test",
  });

  it("keeps the strongest edge per target", () => {
    // A direct edge and a temporal edge between the same pair is one direct
    // edge. Keeping both lets a consumer counting temporal edges
    // double-report a relationship it already has.
    const reduced = reduceRelationships([
      edge("api_0002", "temporal"),
      edge("api_0002", "direct"),
      edge("api_0002", "inferred"),
    ]);
    expect(reduced).toHaveLength(1);
    expect(reduced[0]?.kind).toBe("direct");
  });

  it("orders strongest first, then by target", () => {
    // Deterministic, because this ends up in a diffable report.
    const reduced = reduceRelationships([
      edge("api_0009", "temporal"),
      edge("api_0003", "direct"),
      edge("api_0001", "temporal"),
    ]);
    expect(reduced.map((r) => r.target)).toEqual(["api_0003", "api_0001", "api_0009"]);
  });

  it("requires every edge to state its basis", () => {
    // An edge nobody can check is not evidence. The type enforces it; this
    // pins the intent against a future `basis?: string`.
    const edges = reduceRelationships([edge("api_0001", "inferred")]);
    expect(edges[0]?.basis).not.toBe("");
  });
});

describe("initiator stack frames", () => {
  it("splits function, script, line and column", () => {
    expect(parseFrame("submitOrder@https://shop.example.com/checkout.js:182:14")).toEqual({
      raw: "submitOrder@https://shop.example.com/checkout.js:182:14",
      functionName: "submitOrder",
      url: "https://shop.example.com/checkout.js",
      line: 182,
      column: 14,
    });
  });

  it("splits from the right, because a URL contains colons", () => {
    // Matching from the left takes `https` as the file and loses everything.
    const frame = parseFrame("f@https://a.example.com:8443/app.js:9:2");
    expect(frame.url).toBe("https://a.example.com:8443/app.js");
    expect(frame.line).toBe(9);
  });

  it("keeps an anonymous frame rather than dropping it", () => {
    const frame = parseFrame("@https://shop.example.com/app.js:4:1");
    expect(frame.functionName).toBeUndefined();
    expect(frame.url).toBe("https://shop.example.com/app.js");
  });

  it("keeps a frame it cannot parse", () => {
    // A frame we cannot split is still evidence of a frame. Dropping it
    // would understate the depth of the chain.
    expect(parseFrame("something unexpected")).toEqual({ raw: "something unexpected" });
  });
});

describe("initiator chains", () => {
  it("names the scripts involved, innermost first", () => {
    const chain = buildInitiatorChain({
      type: "script",
      url: "https://shop.example.com/vendor.js",
      lineNumber: 1,
      stack: [
        "post@https://shop.example.com/api-client.js:12:3",
        "submit@https://shop.example.com/checkout.js:182:14",
        "onClick@https://shop.example.com/checkout.js:40:1",
      ],
    });

    expect(chain.scripts).toEqual([
      "https://shop.example.com/api-client.js",
      "https://shop.example.com/checkout.js",
      "https://shop.example.com/vendor.js",
    ]);
    expect(chain.frames).toHaveLength(3);
    expect(chain.source).toBe("https://shop.example.com/vendor.js");
  });

  it("treats a parser initiator as a fact, not a gap", () => {
    // "The HTML asked for it" is real information about how the resource
    // was reached; an empty stack there is correct rather than missing.
    const chain = buildInitiatorChain({ type: "parser", url: "https://shop.example.com/" });
    expect(chain.type).toBe("parser");
    expect(chain.frames).toEqual([]);
  });

  it("survives an absent initiator", () => {
    expect(buildInitiatorChain(undefined).type).toBe("other");
  });
});

describe("§15: causality is never inferred from timestamps alone", () => {
  it("produces a direct edge only when Chrome named a script", () => {
    const chain = buildInitiatorChain({
      type: "script",
      stack: ["f@https://shop.example.com/checkout.js:1:1"],
    });
    const edge = edgeFromInitiator(chain, (url) => `script:${url}`);

    expect(edge?.kind).toBe("direct");
    expect(edge?.basis).toContain("checkout.js");
  });

  it("produces nothing for a parser-initiated request", () => {
    // The HTML referencing a resource is not one request causing another.
    const chain = buildInitiatorChain({ type: "parser", url: "https://shop.example.com/" });
    expect(edgeFromInitiator(chain, (url) => `script:${url}`)).toBeUndefined();
  });

  it("produces nothing when the script cannot be resolved to an id", () => {
    // An edge pointing at something that does not exist in the model is
    // worse than no edge: it looks like evidence and resolves to nothing.
    const chain = buildInitiatorChain({
      type: "script",
      stack: ["f@https://cdn.example.net/vendor.js:1:1"],
    });
    expect(edgeFromInitiator(chain, () => undefined)).toBeUndefined();
  });
});
