import { describe, expect, it } from "vitest";
import {
  decodeInlineSourceMap,
  isInlineSourceMap,
  originalPositionFor,
  parseSourceMap,
  sourceMappingUrl,
} from "./index.js";

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/**
 * Encode VLQ fields, so the fixture is derived rather than guessed.
 *
 * The first version of this file hand-wrote `UACIC` and asserted it meant
 * "column +10, source +1" — it actually meant source +0, and the test failed
 * for a reason that had nothing to do with the code. A fixture nobody can
 * check is a fixture that tests the fixture.
 */
function vlq(...values: number[]): string {
  let out = "";
  for (const value of values) {
    let encoded = value < 0 ? (-value << 1) | 1 : value << 1;
    do {
      let digit = encoded & 31;
      encoded >>>= 5;
      if (encoded > 0) digit |= 32;
      out += BASE64[digit];
    } while (encoded > 0);
  }
  return out;
}

/**
 * Generated line 0: column 0 maps to src/one.ts:1:1, column 10 to
 * src/two.ts:5:2. Deltas, as the format requires.
 */
const MAP = JSON.stringify({
  version: 3,
  file: "bundle.js",
  sources: ["src/one.ts", "src/two.ts"],
  names: ["load"],
  mappings: [vlq(0, 0, 0, 0), vlq(10, 1, 4, 1)].join(","),
  sourcesContent: ["// the original source, which must not be read", "// nor this"],
});

describe("parsing", () => {
  it("decodes mappings to sources and lines", () => {
    const map = parseSourceMap(MAP);
    expect(map?.sources).toEqual(["src/one.ts", "src/two.ts"]);
    expect(map?.mappings.length).toBeGreaterThan(1);
    expect(map?.mappings[0]).toMatchObject({
      generatedLine: 0,
      generatedColumn: 0,
      source: "src/one.ts",
    });
  });

  it("does not read the embedded original source", () => {
    // The application's private code, often with comments and sometimes
    // secrets. The mapping gives a file and a line, which is all a report
    // needs — not reading it is cheaper than redacting it.
    const map = parseSourceMap(MAP);
    expect(JSON.stringify(map)).not.toContain("must not be read");
    expect(map).not.toHaveProperty("sourcesContent");
  });

  it("returns undefined for anything malformed, rather than throwing", () => {
    // A source map is an optimisation. A broken one costs the line number it
    // would have given, not the analysis it was helping.
    for (const text of ["", "{", "null", "[]", '{"version":2}', '{"version":3}']) {
      expect(parseSourceMap(text), JSON.stringify(text)).toBeUndefined();
    }
  });

  it("refuses a map that decodes only partway", () => {
    // Every field is a delta against running state, so everything after a
    // break would be silently wrong — line numbers pointing at real files,
    // at the wrong places. Better to have none.
    const broken = JSON.stringify({
      version: 3,
      sources: ["a.ts"],
      names: [],
      mappings: "AAAA,!!!!invalid",
    });
    expect(parseSourceMap(broken)).toBeUndefined();
  });
});

describe("looking up a position", () => {
  it("maps a generated position to a file and a 1-based line", () => {
    const map = parseSourceMap(MAP);
    expect(map).toBeDefined();
    if (map === undefined) return;

    const position = originalPositionFor(map, 0, 0);
    expect(position?.source).toBe("src/one.ts");
    // The format counts lines from 0; editors and stack traces count from 1,
    // and so does this codebase's SourceLocation.
    expect(position?.line).toBe(1);
  });

  it("uses the greatest mapping at or before the column", () => {
    // A mapping applies until the next one starts, which is how a single
    // minified line covers a whole module.
    const map = parseSourceMap(MAP);
    if (map === undefined) return;
    expect(originalPositionFor(map, 0, 5)?.source).toBe("src/one.ts");
    expect(originalPositionFor(map, 0, 50)?.source).toBe("src/two.ts");
  });

  it("returns undefined for a line with no mapping", () => {
    const map = parseSourceMap(MAP);
    if (map === undefined) return;
    expect(originalPositionFor(map, 99, 0)).toBeUndefined();
  });

  it("applies sourceRoot", () => {
    const map = parseSourceMap(
      JSON.stringify({
        version: 3,
        sourceRoot: "/app/",
        sources: ["one.ts"],
        names: [],
        mappings: "AAAA",
      }),
    );
    expect(originalPositionFor(map as never, 0, 0)?.source).toBe("/app/one.ts");
  });
});

describe("finding the declared map, without fetching it", () => {
  it("reads the sourceMappingURL comment", () => {
    expect(sourceMappingUrl("var a=1;\n//# sourceMappingURL=bundle.js.map")).toBe(
      "bundle.js.map",
    );
    expect(sourceMappingUrl("var a=1;\n//@ sourceMappingURL=old.map")).toBe("old.map");
  });

  it("takes the last one, because a concatenated bundle has several", () => {
    const source = "//# sourceMappingURL=first.map\nvar a=1;\n//# sourceMappingURL=real.map";
    expect(sourceMappingUrl(source)).toBe("real.map");
  });

  it("returns nothing when there is none", () => {
    expect(sourceMappingUrl("var a = 1;")).toBeUndefined();
  });

  it("returns an absolute URL without fetching or resolving it", () => {
    // §10A.6: only when "inside target policy". The value comes from a file
    // the target controls and can name any URL at all, so the caller checks
    // it — the same rule that stopped a sitemap index pointing discovery at
    // 169.254.169.254.
    const url = sourceMappingUrl("//# sourceMappingURL=https://evil.example.net/x.map");
    expect(url).toBe("https://evil.example.net/x.map");
    expect(isInlineSourceMap(url as string)).toBe(false);
  });

  it("decodes an inline map, which needs no request", () => {
    const inline = `data:application/json;base64,${Buffer.from(MAP).toString("base64")}`;
    expect(isInlineSourceMap(inline)).toBe(true);
    expect(decodeInlineSourceMap(inline)?.sources).toEqual(["src/one.ts", "src/two.ts"]);
  });

  it("returns undefined for an inline map that is not valid", () => {
    expect(decodeInlineSourceMap("data:application/json;base64,bm90IGpzb24=")).toBeUndefined();
    expect(decodeInlineSourceMap("https://example.com/x.map")).toBeUndefined();
  });
});
