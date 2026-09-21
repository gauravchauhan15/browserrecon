import { describe, expect, it } from "vitest";
import { parseKatanaJsonl } from "./parse.js";

const line = (endpoint: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ request: { endpoint, method: "GET", tag: "href", ...extra } });

describe("parsing a crawl", () => {
  it("reads endpoints, methods and discovery types", async () => {
    const outcome = parseKatanaJsonl(
      [line("https://a.test/"), line("https://a.test/x", { tag: "form" })].join("\n"),
    );
    expect(outcome.results).toHaveLength(2);
    expect(outcome.results[1]).toMatchObject({
      url: "https://a.test/x",
      discoveryType: "form",
    });
  });

  it("keeps a completed crawl when the last line is truncated", async () => {
    // Katana streams while it crawls, so a crash mid-line leaves a partial
    // record. Discarding everything over one byte would throw away the run.
    const outcome = parseKatanaJsonl(`${line("https://a.test/")}\n{"request":{"endp`);
    expect(outcome.results).toHaveLength(1);
    expect(outcome.malformed).toBe(1);
  });

  it("counts a line that parses but carries no URL", async () => {
    // A summary line, or a shape from a Katana version we do not know.
    const outcome = parseKatanaJsonl('{"stats":{"total":4}}');
    expect(outcome.results).toHaveLength(0);
    expect(outcome.malformed).toBe(1);
  });

  it("never throws, whatever it is given", async () => {
    for (const input of ["", "\n\n", "not json", "null", "[]"]) {
      expect(() => parseKatanaJsonl(input)).not.toThrow();
    }
  });
});
