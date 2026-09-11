import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { MASK_RULES, MASK_RULE_NAMES, renderMaskTable } from "./masking.js";
import { combine, normalizeJson, normalizeJsonl, normalizeText } from "./normalize.js";

describe("what masking hides", () => {
  it("replaces a timestamp but keeps everything around it", async () => {
    const { text, report } = normalizeJson({
      event_id: "evt_000001",
      timestamp: "2026-09-11T08:30:00.000Z",
      type: "network_request",
      payload: { url: "/api/v1/cart", status: 200 },
    });

    expect(text).toContain('"timestamp": "<timestamp>"');
    // The point of the test: the fields that carry the behaviour survive.
    expect(text).toContain('"event_id": "evt_000001"');
    expect(text).toContain('"type": "network_request"');
    expect(text).toContain('"url": "/api/v1/cart"');
    expect(text).toContain('"status": 200');
    expect(report.timestamp).toBe(1);
  });

  it("leaves a field alone when its value is not actually a timestamp", async () => {
    // `at` is a common field name. Blanking it wherever it appears would hide
    // a selector, an index or a label — real content, masked by coincidence.
    const { text, report } = normalizeJson({ at: "button.checkout", timestamp: "not-a-date" });

    expect(text).toContain('"at": "button.checkout"');
    expect(text).toContain('"timestamp": "not-a-date"');
    expect(report.timestamp).toBeUndefined();
  });

  it("masks a low port never, an ephemeral port always", async () => {
    // Port 443 in captured output is information. Port 61234 is noise.
    const { text } = normalizeJson({ target: { port: 443 }, fixture: { port: 61234 } });
    expect(text).toContain('"port": 443');
    expect(text).toContain('"port": "<port>"');
  });

  it("masks a fixture origin wherever it appears, including inside a string", async () => {
    const { text, report } = normalizeText(
      "fetched http://127.0.0.1:54321/products from http://127.0.0.1:54321",
    );
    expect(text.trim()).toBe("fetched <fixture-origin>/products from <fixture-origin>");
    expect(report["loopback-origin"]).toBe(2);
  });

  it("masks a temp session directory but not an ordinary path", async () => {
    const { text } = normalizeText(
      "wrote /tmp/br-store-a1b2c3/events-0001.jsonl and packages/core/src/ids.ts",
    );
    expect(text).toContain("<tmpdir>/events-0001.jsonl");
    expect(text).toContain("packages/core/src/ids.ts");
  });

  it("masks a home directory so a baseline carries no username", async () => {
    const { text } = normalizeText("/Users/someone/Projects/browserrecon/.output");
    expect(text.trim()).toBe("<home>/Projects/browserrecon/.output");
  });
});

describe("what masking must not hide", () => {
  it("keeps deterministic identifiers visible", async () => {
    // IDs are counters precisely so they never need masking. If a rule ever
    // starts eating them, every golden test silently stops asserting identity.
    const { text, report } = normalizeJsonl(
      [
        '{"event_id":"evt_000001","session_id":"sess_0001","sequence":1}',
        '{"event_id":"evt_000002","session_id":"sess_0001","sequence":2}',
      ].join("\n"),
    );

    expect(text).toContain("evt_000001");
    expect(text).toContain("evt_000002");
    expect(text).toContain("sess_0001");
    expect(report).toEqual({});
  });

  it("keeps byte counts and sizes, which are behaviour, not noise", async () => {
    const { text, report } = normalizeJson({ bytes: 4096, events: 12, segments: 1 });
    expect(text).toContain('"bytes": 4096');
    expect(text).toContain('"events": 12');
    expect(report).toEqual({});
  });

  it("masks nothing at all in output that has nothing nondeterministic", async () => {
    const { report } = normalizeJson({ workflow: "checkout", steps: ["cart", "order"] });
    expect(report).toEqual({});
  });
});

describe("the rule set itself", () => {
  it("declares a reason for every rule", async () => {
    // A rule without a stated reason is one nobody can evaluate later.
    for (const rule of MASK_RULES) {
      expect(rule.why.length, `${rule.name} has no why`).toBeGreaterThan(20);
    }
  });

  it("uses a unique name per rule, since names key the report", async () => {
    expect(new Set(MASK_RULE_NAMES).size).toBe(MASK_RULE_NAMES.length);
  });

  it("pins the masking surface, so a new rule is a deliberate diff", async () => {
    // This test exists to fail when someone adds a rule. Widening what is
    // hidden is exactly the change that should not pass unnoticed.
    expect([...MASK_RULE_NAMES].sort()).toEqual([
      "duration",
      "ephemeral-port",
      "home-path",
      "loopback-origin",
      "timestamp",
      "tmpdir-path",
    ]);
  });

  it("is documented in the README without drift", async () => {
    // The README is where someone decides whether a rule is reasonable, so a
    // stale table there is worse than none. Cell *contents* are compared
    // rather than bytes: prettier reformats markdown table alignment, and a
    // byte comparison would fail on whitespace nobody chose.
    const readme = readFileSync(
      fileURLToPath(new URL("../README.md", import.meta.url)),
      "utf8",
    );

    // Split on unescaped pipes only: a regex alternation contains a `|`, and
    // splitting on it naively would tear one cell into two.
    const cells = (row: string): string[] =>
      row
        .split(/(?<!\\)\|/)
        .slice(1, -1)
        .map((cell) => cell.trim());

    // Anchored on the generated marker, not on "any table row" — the README
    // has a second table, and a loose selector would compare the wrong one.
    const marker = "<!-- generated from MASK_RULES";
    const after = readme.slice(readme.indexOf(marker));
    expect(after, "README lost its generated-table marker").not.toBe(readme);

    const documented = after.split("\n\n")[1]?.split("\n").slice(2).map(cells);
    const generated = renderMaskTable().split("\n").slice(2).map(cells);

    expect(documented).toEqual(generated);
  });

  it("uses global value patterns, or only the first match would be masked", async () => {
    for (const rule of MASK_RULES) {
      if (rule.kind !== "value") continue;
      expect(rule.pattern.flags, `${rule.name} is not global`).toContain("g");
    }
  });
});

describe("normalization shape", () => {
  it("sorts object keys so two builders of one object agree", async () => {
    const a = normalizeJson({ zebra: 1, alpha: 2 }).text;
    const b = normalizeJson({ alpha: 2, zebra: 1 }).text;
    expect(a).toBe(b);
  });

  it("keeps array order, which is meaningful", async () => {
    // Sequence is the whole point of an event log; sorting it would destroy
    // the property golden tests are there to protect.
    const { text } = normalizeJson({ steps: ["c", "a", "b"] });
    expect(text).toContain('"c",');
    expect(JSON.parse(text.replace(/\n$/, "")) as { steps: string[] }).toEqual({
      steps: ["c", "a", "b"],
    });
  });

  it("keeps an unparseable JSONL line visible instead of swallowing it", async () => {
    // A corrupt line is a finding. Hiding it would be the worst possible
    // behaviour for a durability-critical file.
    const { text } = normalizeJsonl('{"ok":1}\nnot json at all\n{"ok":2}');
    expect(text).toContain("<<unparseable line 2>> not json at all");
    expect(text).toContain('{"ok":1}');
    expect(text).toContain('{"ok":2}');
  });

  it("sums mask counts across combined parts", async () => {
    const combined = combine([
      ["events", normalizeJson({ timestamp: "2026-09-11T08:30:00.000Z" })],
      ["checkpoint", normalizeJson({ at: "2026-09-11T08:31:00.000Z" })],
    ]);

    expect(combined.report.timestamp).toBe(2);
    expect(combined.text).toContain("===== events =====");
    expect(combined.text).toContain("===== checkpoint =====");
  });
});
