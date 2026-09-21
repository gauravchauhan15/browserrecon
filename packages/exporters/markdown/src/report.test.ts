import { UNREDACTED_OUTPUT_WARNING } from "@browserrecon/core";
import { describe, expect, it } from "vitest";
import { SECTION_ORDER, isTierGated, renderReport, type ReportInput } from "./index.js";

function report(overrides: Partial<ReportInput> = {}): ReportInput {
  return {
    header: {
      target: "https://shop.example.com",
      sessionId: "sess_0001",
      schemaVersion: "1.0.0",
      durationSeconds: 184,
      rateProfile: "normal",
      allowedMethods: ["GET", "HEAD", "OPTIONS"],
      discoverySources: ["browser", "katana"],
      authState: "anonymous",
      aiMode: "off",
    },
    coverage: [{ dimension: "Pages", observed: 24, discovered: 61 }],
    workflows: [],
    apis: [],
    origins: [],
    javascript: [],
    barriers: [],
    gaps: [],
    artifacts: [{ path: ".output/events.jsonl", contents: "raw observations", records: 1420 }],
    ...overrides,
  };
}

const workflow = (confidence: number, id = "wf_0001") => ({
  id,
  name: "Add to cart",
  confidence,
  steps: [
    { step: 1, kind: "interaction" as const, detail: "click #add", causedBy: ["evt_000004"] },
    { step: 2, kind: "request" as const, detail: "POST /api/cart" },
  ],
});

describe("section order", () => {
  it("renders the nine sections in §35B.2's order", () => {
    const markdown = renderReport(report({ hypotheses: [] }));
    const positions = SECTION_ORDER.map((section) => markdown.indexOf(section));

    expect(
      positions.some((p) => p === -1),
      "a section is missing",
    ).toBe(false);
    for (let index = 1; index < positions.length; index += 1) {
      expect(
        positions[index],
        `${SECTION_ORDER[index]} came before ${SECTION_ORDER[index - 1]}`,
      ).toBeGreaterThan(positions[index - 1] as number);
    }
  });

  it("numbers the headings so a reader can cite one", () => {
    const markdown = renderReport(report());
    expect(markdown).toContain(`## 1. ${SECTION_ORDER[0]}`);
    expect(markdown).toContain(`## 7. ${SECTION_ORDER[6]}`);
  });

  it("keeps the section order stable when the content changes", () => {
    // §35B.2's actual purpose: two runs of the same target must diff
    // cleanly. If sections moved with the data, every diff would be noise.
    const empty = renderReport(report());
    const full = renderReport(
      report({
        apis: [
          {
            method: "GET",
            url: "https://shop.example.com/api/cart",
            status: 200,
            role: "consumer",
          },
        ],
        origins: [
          { origin: "https://cdn.example.net", requests: 4, classification: "third_party" },
        ],
      }),
    );
    const headings = (markdown: string) => markdown.match(/^## .*$/gm);
    expect(headings(full)).toEqual(headings(empty));
  });

  it("is deterministic for identical input", () => {
    expect(renderReport(report())).toBe(renderReport(report()));
  });
});

describe("the tier-gated section", () => {
  it("is omitted entirely when the tier produced no hypotheses", () => {
    // §35B.2. An empty "Security hypotheses" heading reads as "we looked and
    // found nothing", which is a stronger claim than "we did not look".
    const markdown = renderReport(report());
    expect(markdown).not.toContain("Security hypotheses");
    expect(markdown).not.toContain("## 9.");
  });

  it("is rendered when the tier ran, even if it found nothing", () => {
    // The distinction that makes the omission meaningful: `[]` means we
    // looked. `undefined` means we did not.
    const markdown = renderReport(report({ hypotheses: [] }));
    expect(markdown).toContain("## 9. Security hypotheses");
  });

  it("says hypotheses are not findings", () => {
    // §20.3. Left implicit, a "hypothesis" column in a security report gets
    // read as a vulnerability list and forwarded as one.
    const markdown = renderReport(
      report({
        hypotheses: [{ claim: "cart accepts a negative quantity", evidence: "evt_000091" }],
      }),
    );
    expect(markdown).toMatch(/never findings/i);
  });

  it("is the only gated section", () => {
    for (const section of SECTION_ORDER) {
      expect(isTierGated(section), section).toBe(section === "Security hypotheses");
    }
  });
});

describe("workflows", () => {
  it("collapses a low-confidence workflow instead of dropping it", () => {
    // §18.1: the uncertain one is the one a reader most wants to check.
    const markdown = renderReport(report({ workflows: [workflow(0.3)] }));
    expect(markdown).toContain("<details>");
    expect(markdown).toContain("low confidence");
    expect(markdown).toContain("POST /api/cart");
  });

  it("shows a confident workflow inline", () => {
    const markdown = renderReport(report({ workflows: [workflow(0.9)] }));
    expect(markdown).not.toContain("<details>");
    expect(markdown).toContain("Add to cart");
  });

  it("marks a parallel step rather than numbering it into the chain", () => {
    // §35B.3. Rendering concurrent requests as consecutive steps invents a
    // dependency that the data does not support.
    const markdown = renderReport(
      report({
        workflows: [
          {
            id: "wf_0002",
            name: "Checkout",
            confidence: 0.8,
            steps: [
              { step: 1, kind: "request", detail: "GET /api/cart" },
              { step: 2, kind: "request", detail: "GET /api/user", parallel: true },
            ],
          },
        ],
      }),
    );
    expect(markdown).toContain("↳ parallel");
  });

  it("keeps an interaction that produced no request", () => {
    // §35B.3: a click that changed the DOM and fired nothing is still
    // evidence about the workflow.
    const markdown = renderReport(
      report({
        workflows: [
          {
            id: "wf_0003",
            name: "Open menu",
            confidence: 0.9,
            steps: [{ step: 1, kind: "interaction", detail: "click #menu (no request)" }],
          },
        ],
      }),
    );
    expect(markdown).toContain("no request");
  });

  it("says so plainly when there are none", () => {
    expect(renderReport(report())).toMatch(/No workflows were detected/i);
  });
});

describe("what the report refuses to claim", () => {
  it("carries the coverage caveat in the header, not a footnote", () => {
    // §10C.6. A caveat nobody scrolls to is a caveat nobody reads, so it is
    // asserted to appear before the first section.
    const markdown = renderReport(report());
    expect(markdown).toMatch(/not\n?> everything that exists/);
    expect(markdown.indexOf("everything that exists")).toBeLessThan(
      markdown.indexOf(`## 1. ${SECTION_ORDER[0]}`),
    );
  });

  it("states that no barrier was bypassed, even with no barriers to report", () => {
    // §7.3. A reader has to be able to tell that barriers were recorded
    // rather than defeated — and the empty case is where a reader would
    // otherwise assume the tool simply got through.
    const markdown = renderReport(report());
    expect(markdown).toMatch(/never circumvented/i);
  });

  it("renders the gaps section whether or not there are gaps", () => {
    expect(renderReport(report())).toContain("## 7. Coverage gaps");
  });

  it("gives every gap a remedy", () => {
    // §10C.7: a gap with no action is a number a user cannot move.
    const markdown = renderReport(
      report({
        gaps: [{ reason: "auth_required", count: 14, remedy: "Configure an auth profile" }],
      }),
    );
    expect(markdown).toContain("Remedy");
    expect(markdown).toContain("Configure an auth profile");
  });

  it("warns that the artifacts directory is unredacted", () => {
    // The report is the thing people send to each other; it is the right
    // place to say the raw data must not follow it.
    expect(renderReport(report())).toContain(UNREDACTED_OUTPUT_WARNING);
  });
});

describe("rendering", () => {
  it("shows a ratio only where one is meaningful", () => {
    const markdown = renderReport(
      report({ coverage: [{ dimension: "APIs", observed: 0, discovered: 0 }] }),
    );
    expect(markdown).not.toContain("NaN");
    expect(markdown).not.toContain("Infinity");
  });

  it("labels an inline script rather than showing an empty cell", () => {
    const markdown = renderReport(
      report({ javascript: [{ url: "", firstParty: true, analysis: "endpoints: 3" }] }),
    );
    expect(markdown).toContain("(inline)");
  });

  it("ends with exactly one trailing newline", () => {
    // Prettier and the golden harness both care, and a drifting trailing
    // newline is a diff on every report for no reason.
    const markdown = renderReport(report());
    expect(markdown.endsWith("\n")).toBe(true);
    expect(markdown.endsWith("\n\n")).toBe(false);
  });
});

describe("sizes", () => {
  it("shows a size a reader can compare at a glance", () => {
    // 48213 and 481230 look alike in a column; 47 KB and 470 KB do not.
    const markdown = renderReport(
      report({
        javascript: [
          {
            url: "https://shop.example.com/app.js",
            bytes: 48213,
            firstParty: true,
            analysis: "3 endpoints",
          },
          {
            url: "https://shop.example.com/tiny.js",
            bytes: 412,
            firstParty: true,
            analysis: "—",
          },
          {
            url: "https://cdn.example.net/big.js",
            bytes: 3_500_000,
            firstParty: false,
            analysis: "—",
          },
        ],
      }),
    );
    expect(markdown).toContain("47 KB");
    expect(markdown).toContain("412 B");
    expect(markdown).toContain("3.3 MB");
  });
});
