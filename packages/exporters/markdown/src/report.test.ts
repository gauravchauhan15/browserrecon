import { UNREDACTED_OUTPUT_WARNING } from "@browserrecon/core";
import { describe, expect, it } from "vitest";
import { COVERAGE_CAVEAT } from "@browserrecon/coverage";
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
    webmcpTools: [],
    origins: [],
    barriers: [],
    gaps: [],
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
  it("renders every section in §35B.2's order", () => {
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
    expect(markdown).toContain(`## 5. ${SECTION_ORDER[4]}`);
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
    expect(markdown).not.toContain("## 10.");
  });

  it("is rendered when the tier ran, even if it found nothing", () => {
    // The distinction that makes the omission meaningful: `[]` means we
    // looked. `undefined` means we did not.
    const markdown = renderReport(report({ hypotheses: [] }));
    expect(markdown).toContain("## 6. Security hypotheses");
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
    // The coverage package's sentence, not a paraphrase of it: this used to
    // be a fourth wording of one promise.
    expect(markdown).toContain(`> ${COVERAGE_CAVEAT}`);
    expect(markdown.indexOf("complete application coverage")).toBeLessThan(
      markdown.indexOf(`## 1. ${SECTION_ORDER[0]}`),
    );
  });

  it("states that a barrier was recorded rather than defeated", () => {
    // §7.3. A reader has to be able to tell that barriers were recorded
    // rather than circumvented. The barrier *table* is gone — it was empty
    // on every scan that ever produced one — but the promise is not: it is
    // printed wherever a barrier exists, which is the case a reader would
    // otherwise read as "the tool simply got through".
    const markdown = renderReport(
      report({
        barriers: [
          { category: "authentication", url: "https://shop.example.com", evidence: "401" },
        ],
      }),
    );
    expect(markdown).toMatch(/not circumvented/i);
    expect(markdown).toContain("1 access barrier(s)");
  });

  it("names its gaps in the coverage summary, with the file that details them", () => {
    // §10C.6: the report must never read as a clean bill of health. The gap
    // table is gone; the count and the reasons are not, and they sit under
    // the coverage score rather than eight sections below it.
    const markdown = renderReport(
      report({
        gaps: [{ reason: "auth_required", count: 14, remedy: "Configure an auth profile" }],
      }),
    );
    expect(markdown).toContain("14 coverage gap(s)");
    expect(markdown).toContain("auth_required");
    expect(markdown).toContain("attack-surface.json");
    expect(markdown.indexOf("coverage gap(s)")).toBeLessThan(markdown.indexOf("## 2."));
  });

  it("says nothing about limits when there are none to report", () => {
    // The other half: a limits line printed with zeros would be noise, and
    // noise is what teaches a reader to skip the line that matters.
    expect(renderReport(report())).not.toContain("Limits on this scan");
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

  it("ends with exactly one trailing newline", () => {
    // Prettier and the golden harness both care, and a drifting trailing
    // newline is a diff on every report for no reason.
    const markdown = renderReport(report());
    expect(markdown.endsWith("\n")).toBe(true);
    expect(markdown.endsWith("\n\n")).toBe(false);
  });
});

describe("Agentic tools", () => {
  it("lists what the page publishes to agents", () => {
    // §21, §44. A tool registration sends no network traffic, so this
    // section is the only place in the report a reader can learn that the
    // page hands any visiting agent a named operation.
    const markdown = renderReport(
      report({
        webmcpTools: [
          {
            name: "deleteAccount",
            endpoint: "/api/account",
            description: "Permanently delete the signed-in account.",
          },
        ],
      }),
    );

    expect(markdown).toContain("deleteAccount");
    expect(markdown).toContain("/api/account");
    // §7.2, in the report rather than only in the code: an exposed
    // destructive operation is something to name, never something to try.
    expect(markdown).toContain("never invoked");
  });

  it("says nothing at all when the page registered none", () => {
    // The normal case. Almost no site has this, and a section that
    // explained its own absence would be noise on every report.
    const markdown = renderReport(report());
    expect(markdown).toContain(`## 4. ${SECTION_ORDER[3]}`);
    expect(markdown).not.toContain("never invoked");
  });
});

describe("the agentic-tool diagram", () => {
  const tools = [
    { name: "search_items", page: "https://shop.example.com/en", effect: "read_only" as const },
    {
      name: "toggle_favorite",
      page: "https://shop.example.com/en",
      effect: "writes" as const,
    },
    {
      name: "cancel_order",
      page: "https://shop.example.com/account",
      effect: "destructive" as const,
    },
    { name: "legacy_helper", page: "https://shop.example.com/account" },
  ];

  it("draws the registry as target → page → tool", () => {
    // A registry is per page, so the page is the middle rank. A flat list
    // of names answers "what is published" and not "what does an agent have
    // to be looking at to call this" — which is the question that decides
    // whether a destructive tool is one navigation away.
    const markdown = renderReport(report({ webmcpTools: tools }));
    expect(markdown).toContain("```mermaid");
    expect(markdown).toContain("graph LR");
    expect(markdown).toContain('root["https://shop.example.com"]');
    expect(markdown).toContain('["/en (2)"]');
    expect(markdown).toContain('["/account (2)"]');
    expect(markdown).toContain('["cancel_order"]');
  });

  it("colours each tool by the effect the page declared", () => {
    const markdown = renderReport(report({ webmcpTools: tools }));
    expect(markdown).toContain("classDef destructive");
    expect(markdown).toContain("classDef writes");
    expect(markdown).toContain("classDef readonly");
    // Silence is its own class, never folded into read-only.
    expect(markdown).toContain("classDef unstated");
  });

  it("defines only the classes it used", () => {
    // A legend that lists a colour the picture does not contain is a legend
    // that disagrees with the picture.
    const markdown = renderReport(
      report({ webmcpTools: [{ name: "search", effect: "read_only" }] }),
    );
    expect(markdown).toContain("classDef readonly");
    expect(markdown).not.toContain("classDef destructive");
  });

  it("counts the tools by effect above the picture", () => {
    const markdown = renderReport(report({ webmcpTools: tools }));
    expect(markdown).toContain("**4 tool(s)**");
    expect(markdown).toContain("destructive 1");
    expect(markdown).toContain("unstated 1");
  });

  it("falls back to the target when a tool names no page", () => {
    // A log written before the page was carried still has to render.
    const markdown = renderReport(
      report({ webmcpTools: [{ name: "search", effect: "read_only" }] }),
    );
    expect(markdown).toContain("```mermaid");
    expect(markdown).not.toContain("undefined");
  });

  it("does not let a tool name break the diagram", () => {
    // Tool names come from the page. A quote in one would close the label
    // early and produce a syntax error where a diagram should be.
    const markdown = renderReport(
      report({ webmcpTools: [{ name: 'we"ird\nname', effect: "writes" }] }),
    );
    const diagram = markdown.slice(markdown.indexOf("```mermaid"));
    const label = diagram.slice(diagram.indexOf("t0["), diagram.indexOf("t0[") + 40);
    expect(label).not.toContain('"we"ird');
    expect(diagram).not.toMatch(/\[\s*"[^"]*"[^\]]*"/);
  });

  it("says so plainly when the page published nothing", () => {
    expect(renderReport(report({ pagesRead: 1 }))).toContain("published no tools");
    expect(renderReport(report({ pagesRead: 1 }))).not.toContain("```mermaid");
  });

  it("does not claim a page published nothing when no page was read", () => {
    // A registry never appears in traffic, so the only evidence that a page
    // publishes no tools is a page that was read. A scan of the reference
    // application whose browsing phase failed outright printed "this page
    // published no
    // tools to visiting agents" — about a site publishing five. Reporting
    // the unobserved as the absent, in the one section where nothing else
    // in the log could contradict it.
    const markdown = renderReport(report({ pagesRead: 0 }));
    expect(markdown).not.toContain("published no tools");
    expect(markdown).toMatch(/unknown/i);
  });
});

describe("endpoints the bundles named", () => {
  const found = {
    endpoints: [
      {
        path: "/api/v2/orders/{id}",
        status: "unobserved" as const,
        confidence: "high" as const,
        staticSources: [{ script: "https://shop.example.com/_ng/main.js", line: 412 }],
      },
      { path: "/api/cart", status: "observed" as const, staticSources: [] },
    ],
    scriptsAnalysed: 110,
    scriptsSkipped: 2,
  };

  it("lists what the code names and the scan never called", () => {
    // §10A.3's whole value: the surface an application's own code describes
    // and this run did not reach.
    const markdown = renderReport(report({ staticApis: found }));
    expect(markdown).toContain("110 script(s) parsed");
    expect(markdown).toContain("2 skipped by a bound");
    expect(markdown).toContain("/api/v2/orders/{id}");
    expect(markdown).toContain("main.js:412");
  });

  it("does not repeat a candidate the inventory already lists", () => {
    const markdown = renderReport(report({ staticApis: found }));
    expect(markdown).toContain("1 the scan called");
    // `/api/cart` was observed, so it belongs in the table above, once.
    expect(markdown.split("/api/cart").length - 1).toBe(0);
  });

  it("keeps a candidate a candidate", () => {
    // A string in a bundle is not an endpoint, and the report must not let
    // a reader read it as one.
    expect(renderReport(report({ staticApis: found }))).toMatch(/not an endpoint that exists/i);
  });

  it("distinguishes 'nothing was parsed' from 'nothing was found'", () => {
    // Two different facts: one about this scan, one about the target.
    // Collapsing them turns a missing capability into a clean result.
    expect(renderReport(report())).toContain("No JavaScript was parsed");
    expect(
      renderReport(
        report({ staticApis: { endpoints: [], scriptsAnalysed: 40, scriptsSkipped: 0 } }),
      ),
    ).toContain("No endpoint candidates were found");
  });
});

describe("the API inventory says whose host it is", () => {
  it("reports the party and the content type beside the role", () => {
    // The content type is why most rows are there at all, and the party is
    // what stops a reader dismissing the application's own API gateway as
    // somebody else's property.
    const markdown = renderReport(
      report({
        apis: [
          {
            method: "GET",
            url: "https://data-search.shop.example.com/v1/cities",
            status: 200,
            contentType: "application/json",
            party: "same-site",
            role: "application_api",
          },
        ],
      }),
    );
    expect(markdown).toContain("application/json");
    expect(markdown).toContain("same-site");
  });
});
