import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  NORMALIZATION_RULES,
  REFUSED_NORMALIZATIONS,
  normalizeUrl,
  renderRuleTables,
  sameEndpoint,
} from "./url.js";

describe("what normalizes together", () => {
  it.each([
    ["scheme case", "HTTP://example.com/a", "http://example.com/a"],
    ["host case", "https://EXAMPLE.com/a", "https://example.com/a"],
    ["default port on https", "https://example.com:443/a", "https://example.com/a"],
    ["default port on http", "http://example.com:80/a", "http://example.com/a"],
    ["fragment", "https://example.com/a#section", "https://example.com/a"],
    ["query order", "https://example.com/a?b=2&a=1", "https://example.com/a?a=1&b=2"],
  ])("treats %s as the same endpoint", (_name, left, right) => {
    expect(sameEndpoint(left, right)).toBe(true);
  });

  it("keeps a non-default port, which is a different service", async () => {
    expect(sameEndpoint("https://example.com:8443/a", "https://example.com/a")).toBe(false);
    expect(normalizeUrl("https://example.com:8443/a").port).toBe(8443);
  });

  it("keeps the fragment out of identity but not out of the record", async () => {
    // Never sent to the server, so it cannot be part of a server-side
    // endpoint's identity — but SPA routing lives there (§16), so it is kept.
    const parsed = normalizeUrl("https://example.com/app#/orders/42");
    expect(parsed.identity).toBe("https://example.com/app");
    expect(parsed.fragment).toBe("#/orders/42");
  });
});

describe("what must never normalize together", () => {
  // The whole reason this file is conservative. Each of these is a difference
  // a cache may ignore and a security tool may not.

  it("keeps /Admin and /admin apart", async () => {
    // Paths are case-sensitive on most servers, and one of these may be the
    // one that matters.
    expect(sameEndpoint("https://example.com/Admin", "https://example.com/admin")).toBe(false);
    expect(normalizeUrl("https://example.com/Admin").path).toBe("/Admin");
  });

  it("keeps a trailing slash apart", async () => {
    // `/users` and `/users/` can route to different handlers, and the
    // difference sometimes bypasses a rule that matched only one form.
    expect(sameEndpoint("https://example.com/users", "https://example.com/users/")).toBe(false);
  });

  it("does not decode percent-encoding", async () => {
    // `%2e%2e%2f` and `../` are not the same observation. Decoding makes a
    // traversal attempt look like an ordinary path.
    const encoded = normalizeUrl("https://example.com/files/%2e%2e%2fetc/passwd");
    expect(encoded.path).toContain("%2e%2e%2f");
    expect(sameEndpoint(encoded.raw, "https://example.com/files/../etc/passwd")).toBe(false);
  });

  it("keeps a repeated parameter, because pollution is the finding", async () => {
    const polluted = normalizeUrl("https://example.com/a?id=1&id=2");
    expect(polluted.queryKeys).toEqual(["id", "id"]);
    expect(polluted.identity).toContain("id=1");
    expect(polluted.identity).toContain("id=2");
    expect(sameEndpoint(polluted.raw, "https://example.com/a?id=1")).toBe(false);
  });

  it("keeps different parameter values apart", async () => {
    expect(sameEndpoint("https://example.com/a?id=1", "https://example.com/a?id=2")).toBe(
      false,
    );
  });

  it("keeps http and https apart", async () => {
    expect(sameEndpoint("http://example.com/a", "https://example.com/a")).toBe(false);
  });

  it("does not treat /path/ and /path/index.html as one", async () => {
    // A server convention, not a URL equivalence, and wrong as often as right.
    expect(
      sameEndpoint("https://example.com/docs/", "https://example.com/docs/index.html"),
    ).toBe(false);
  });
});

describe("awkward inputs", () => {
  it("groups a malformed URL only with itself, and says so", async () => {
    const parsed = normalizeUrl("not a url at all");
    expect(parsed.malformed).toBe(true);
    expect(parsed.identity).toBe("not a url at all");
    expect(sameEndpoint("not a url at all", "also not a url")).toBe(false);
  });

  it("does not put every data: URI in one bucket", async () => {
    // There is no authority to group by, so grouping by scheme alone would
    // collapse thousands of unrelated inline resources into one endpoint.
    const a = normalizeUrl("data:text/plain;base64,AAAA");
    const b = normalizeUrl("data:image/png;base64,BBBB");
    expect(a.identity).not.toBe(b.identity);
    expect(a.origin).toBe("data:");
  });

  it("handles a URL with an empty query string", async () => {
    expect(normalizeUrl("https://example.com/a?").identity).toBe("https://example.com/a");
  });

  it("preserves an empty parameter value", async () => {
    const parsed = normalizeUrl("https://example.com/a?token=");
    expect(parsed.identity).toContain("token=");
    expect(parsed.queryKeys).toEqual(["token"]);
  });

  it("records the origin without the default port", async () => {
    expect(normalizeUrl("https://example.com:443/a").origin).toBe("https://example.com");
    expect(normalizeUrl("http://127.0.0.1:8080/a").origin).toBe("http://127.0.0.1:8080");
  });
});

describe("the rule set", () => {
  it("states why each rule is safe", async () => {
    for (const rule of NORMALIZATION_RULES) {
      expect(rule.why.length, rule.name).toBeGreaterThan(30);
    }
  });

  it("writes down what it refuses to do, and why", async () => {
    // The refusals are the part a reviewer needs most: they are the
    // normalizations a cache-oriented library would have done by default.
    expect(REFUSED_NORMALIZATIONS.length).toBeGreaterThanOrEqual(5);
    for (const rule of REFUSED_NORMALIZATIONS) {
      expect(rule.why.length, rule.name).toBeGreaterThan(30);
    }
  });

  it("pins the surface, so a change is a deliberate diff", async () => {
    expect(NORMALIZATION_RULES.map((rule) => rule.name)).toEqual([
      "scheme-case",
      "host-case",
      "default-port",
      "fragment",
      "query-order",
    ]);
  });

  it("is documented in the README without drift", async () => {
    // The refusals are the part a reviewer needs most — they are exactly what
    // a cache-oriented library would have done by default — so a stale table
    // there is worse than none. Cell contents are compared rather than bytes,
    // because prettier reformats markdown alignment.
    const readme = readFileSync(
      fileURLToPath(new URL("../README.md", import.meta.url)),
      "utf8",
    );
    const marker = "<!-- generated from NORMALIZATION_RULES";
    const after = readme.slice(readme.indexOf(marker));
    expect(after, "README lost its generated-table marker").not.toBe(readme);

    const cells = (row: string): string[] =>
      row
        .split(/(?<!\\)\|/)
        .slice(1, -1)
        .map((cell) => cell.trim());
    const rows = (block: string): string[][] =>
      block
        .split("\n")
        .filter((line) => line.startsWith("|"))
        .filter((line) => !/^\|\s*-+/.test(line))
        .slice(1)
        .map(cells);

    const documented = rows(after.split("\n\n").slice(1, 3).join("\n"));
    const generated = rows(renderRuleTables());
    expect(documented).toEqual(generated);
  });

  it("never changes the raw URL", async () => {
    // Normalization is an index, not a replacement (§37.2).
    for (const raw of [
      "https://EXAMPLE.com:443/Admin/?b=2&a=1#x",
      "not a url",
      "data:text/plain,hello",
    ]) {
      expect(normalizeUrl(raw).raw).toBe(raw);
    }
  });
});
