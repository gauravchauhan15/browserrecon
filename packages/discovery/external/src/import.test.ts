import { describe, expect, it } from "vitest";
import { importUrls } from "./import.js";

const allowAll = { refuse: (): undefined => undefined };
const onlyAppTest = {
  refuse: (url: string): string | undefined =>
    url.startsWith("https://app.test") ? undefined : "not an allowed origin",
};

describe("an imported list can never widen scope", () => {
  // The safety property. A file is untrusted input: it may carry a URL on
  // another origin, or somewhere the user never authorized.
  it("refuses an off-origin URL even though the file asked for it", async () => {
    const outcome = importUrls(
      ["https://app.test/a", "https://evil.test/steal", "https://app.test/b"].join("\n"),
      onlyAppTest,
    );
    expect(outcome.accepted).toEqual(["https://app.test/a", "https://app.test/b"]);
    expect(outcome.refused).toEqual([
      { url: "https://evil.test/steal", reason: "not an allowed origin" },
    ]);
  });

  it("refuses a non-http scheme before policy is even asked", async () => {
    // Not a scope question — a `file://` path is not a page.
    const outcome = importUrls(
      ["file:///etc/passwd", "javascript:alert(1)", "https://app.test/ok"].join("\n"),
      onlyAppTest,
    );
    expect(outcome.accepted).toEqual(["https://app.test/ok"]);
    expect(outcome.refused).toHaveLength(2);
  });

  it("applies the filter itself rather than trusting the caller to", async () => {
    // A caller that forgot would hand the Explorer a list that quietly
    // escapes the boundary the user agreed to.
    const outcome = importUrls("https://evil.test/x", onlyAppTest);
    expect(outcome.accepted).toHaveLength(0);
  });
});

describe("reading whatever a crawler produced", () => {
  it("reads a plain list", async () => {
    const outcome = importUrls("https://app.test/a\nhttps://app.test/b\n", allowAll);
    expect(outcome.accepted).toHaveLength(2);
  });

  it("reads Katana's JSONL", async () => {
    const outcome = importUrls(
      '{"request":{"endpoint":"https://app.test/from-katana","method":"GET"}}',
      allowAll,
    );
    expect(outcome.accepted).toEqual(["https://app.test/from-katana"]);
  });

  it("reads a generic JSONL with a url field", async () => {
    const outcome = importUrls('{"url":"https://app.test/x","status":200}', allowAll);
    expect(outcome.accepted).toEqual(["https://app.test/x"]);
  });

  it("reads the first column of a CSV", async () => {
    const outcome = importUrls("https://app.test/x,200,text/html", allowAll);
    expect(outcome.accepted).toEqual(["https://app.test/x"]);
  });

  it("skips comments and blank lines without counting them as damage", async () => {
    const outcome = importUrls("# a comment\n\nhttps://app.test/x\n", allowAll);
    expect(outcome.accepted).toHaveLength(1);
    expect(outcome.malformed).toBe(0);
  });

  it("counts lines it could not read", async () => {
    const outcome = importUrls("not a url\nhttps://app.test/x\n{broken", allowAll);
    expect(outcome.accepted).toHaveLength(1);
    expect(outcome.malformed).toBe(2);
  });

  it("de-duplicates", async () => {
    const outcome = importUrls("https://app.test/x\nhttps://app.test/x", allowAll);
    expect(outcome.accepted).toHaveLength(1);
  });

  it("sorts, so a scan seeded from a file visits in the same order", async () => {
    // §5A.5 — however the file was written.
    const outcome = importUrls("https://app.test/z\nhttps://app.test/a", allowAll);
    expect(outcome.accepted).toEqual(["https://app.test/a", "https://app.test/z"]);
  });
});
