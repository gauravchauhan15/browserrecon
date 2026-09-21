import { describe, expect, it } from "vitest";
import type { ElementFacts } from "@browserrecon/browser-adapter";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  GENERATED_ID_RULES,
  buildElementReference,
  isStableId,
  renderGeneratedIdTable,
} from "./element-ref.js";

const facts = (overrides: Partial<ElementFacts> = {}): ElementFacts => ({
  tagName: "button",
  accessibleName: "place order",
  inForm: true,
  nonGetMethod: false,
  classes: ["btn", "btn-primary"],
  ancestors: [
    { tagName: "button", classes: ["btn"], nthOfType: 2, uniqueOfType: false },
    { tagName: "div", classes: ["actions"], nthOfType: 1, uniqueOfType: true },
    { tagName: "form", classes: [], nthOfType: 1, uniqueOfType: true },
    { tagName: "body", classes: [], nthOfType: 1, uniqueOfType: true },
  ],
  ...overrides,
});

describe("ids that are not handles", () => {
  // The trap this whole file exists for: a generated id looks perfectly
  // stable in review and is different on the next render.
  it.each([
    [":r0:", "React 18 useId"],
    [":r1a:", "React 18 useId"],
    ["ember123", "Ember"],
    ["mui-1234", "MUI"],
    ["headlessui-menu-button-4", "Headless UI"],
    ["el-8f3c2a1b", "hand-rolled hash"],
    ["f47ac10b-58cc-4372-a567-0e02b2c3d479", "UUID"],
    ["item-100234", "counter"],
    ["id42917", "counter"],
  ])("rejects %s (%s)", (id) => {
    expect(isStableId(id)).toBe(false);
  });

  it.each(["submit-button", "checkout", "login_form", "nav-primary", "search", "step2"])(
    "accepts %s, which someone chose",
    (id) => {
      expect(isStableId(id)).toBe(true);
    },
  );

  it("rejects an absurdly long id rather than putting it in a selector", async () => {
    expect(isStableId("a".repeat(120))).toBe(false);
  });

  it("is documented in the README without drift", async () => {
    const readme = readFileSync(
      fileURLToPath(new URL("../README.md", import.meta.url)),
      "utf8",
    );
    const marker = "<!-- generated from GENERATED_ID_RULES";
    const after = readme.slice(readme.indexOf(marker));
    expect(after, "README lost its generated-table marker").not.toBe(readme);

    const cells = (row: string): string[] =>
      row
        .split(/(?<!\\)\|/)
        .slice(1, -1)
        .map((cell) => cell.trim());
    // Take the contiguous run of table rows immediately after the marker.
    // Splitting on blank lines picked up the *second* table further down the
    // page, which made the failure look like nine rules instead of six.
    const lines = after.split("\n").slice(1);
    const start = lines.findIndex((line) => line.startsWith("|"));
    const table: string[] = [];
    for (const line of lines.slice(start)) {
      if (!line.startsWith("|")) break;
      table.push(line);
    }
    const documented = table.slice(2).map(cells);
    const generated = renderGeneratedIdTable().split("\n").slice(2).map(cells);
    expect(documented).toEqual(generated);
  });

  it("states why each rule exists", async () => {
    for (const rule of GENERATED_ID_RULES) {
      expect(rule.why.length, rule.name).toBeGreaterThan(30);
    }
  });
});

describe("the strategy ladder", () => {
  it("prefers a test id, which exists to be stable", async () => {
    const reference = buildElementReference(facts({ testId: "place-order", id: "checkout" }));
    expect(reference).toMatchObject({
      selector: '[data-testid="place-order"]',
      strategy: "test_id",
      stability: "strong",
    });
  });

  it("uses an id a human chose", async () => {
    const reference = buildElementReference(facts({ id: "place-order" }));
    expect(reference).toMatchObject({
      selector: "#place-order",
      strategy: "id",
      stability: "strong",
    });
  });

  it("refuses a generated id and falls through to something reproducible", async () => {
    // The whole point. Building `#:r0:` would look right and break on the
    // next run, which is exactly the failure golden output cannot survive.
    const reference = buildElementReference(facts({ id: ":r0:" }));
    expect(reference.selector).not.toContain(":r0:");
    expect(reference.strategy).not.toBe("id");
  });

  it("uses a form control's name, scoped by tag", async () => {
    // `name` is unique only within a form, and a radio group shares one — so
    // the tag scopes it rather than standing alone.
    const reference = buildElementReference(
      facts({ tagName: "input", name: "email", ancestors: undefined }),
    );
    expect(reference).toMatchObject({
      selector: 'input[name="email"]',
      strategy: "name",
      stability: "moderate",
    });
  });

  it("anchors a path to the nearest stable ancestor", async () => {
    // A path anchored two levels up survives a change three levels up; a path
    // from the document root survives nothing.
    const reference = buildElementReference(
      facts({
        ancestors: [
          { tagName: "button", classes: [], nthOfType: 2, uniqueOfType: false },
          {
            tagName: "div",
            classes: [],
            nthOfType: 1,
            uniqueOfType: true,
            id: "checkout-panel",
          },
          { tagName: "body", classes: [], nthOfType: 1, uniqueOfType: true },
        ],
      }),
    );
    expect(reference).toMatchObject({
      selector: "#checkout-panel > button:nth-of-type(2)",
      strategy: "anchored_path",
      stability: "moderate",
    });
  });

  it("anchors to an ancestor's test id too", async () => {
    const reference = buildElementReference(
      facts({
        ancestors: [
          { tagName: "a", classes: [], nthOfType: 3, uniqueOfType: false },
          { tagName: "nav", classes: [], nthOfType: 1, uniqueOfType: true, testId: "main-nav" },
        ],
      }),
    );
    expect(reference.selector).toBe('[data-testid="main-nav"] > a:nth-of-type(3)');
  });

  it("will not anchor to a generated id on an ancestor either", async () => {
    const reference = buildElementReference(
      facts({
        ancestors: [
          { tagName: "button", classes: [], nthOfType: 1, uniqueOfType: true },
          { tagName: "div", classes: [], nthOfType: 1, uniqueOfType: true, id: "mui-8821" },
          { tagName: "body", classes: [], nthOfType: 1, uniqueOfType: true },
        ],
      }),
    );
    expect(reference.selector).not.toContain("mui-8821");
    expect(reference.strategy).toBe("structural_path");
  });

  it("falls back to a structural path and says it is positional", async () => {
    const reference = buildElementReference(facts());
    expect(reference.strategy).toBe("structural_path");
    expect(reference.stability).toBe("positional");
    expect(reference.selector).toBe("body > form > div > button:nth-of-type(2)");
  });

  it("omits :nth-of-type where the element is the only one of its tag", async () => {
    // A shorter selector is a more readable one, and uniqueness already makes
    // the index redundant.
    const reference = buildElementReference(
      facts({
        ancestors: [
          { tagName: "button", classes: [], nthOfType: 1, uniqueOfType: true },
          { tagName: "body", classes: [], nthOfType: 1, uniqueOfType: true },
        ],
      }),
    );
    expect(reference.selector).toBe("body > button");
  });

  it("has something to say even with no ancestors at all", async () => {
    const reference = buildElementReference(facts({ ancestors: [] }));
    expect(reference).toMatchObject({ strategy: "tag_only", stability: "positional" });
  });
});

describe("reproducibility", () => {
  it("produces the same selector for the same facts, every time", async () => {
    // §36.2 compares two scans of one fixture. A reference that differs
    // between them fails every comparison for a reason unrelated to the
    // application.
    const input = facts({ id: "place-order" });
    const first = buildElementReference(input);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      expect(buildElementReference(input)).toEqual(first);
    }
  });

  it("never embeds anything that varies between runs", async () => {
    const reference = buildElementReference(facts());
    expect(reference.selector).not.toMatch(/\d{5,}/);
    expect(reference.selector).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/i);
  });
});

describe("escaping and labels", () => {
  it("escapes an id that starts with a digit", async () => {
    // A bare `#2fa-code` is not a valid selector, and passing it back to the
    // adapter would throw rather than fail cleanly.
    const reference = buildElementReference(facts({ id: "2fa-code" }));
    expect(reference.selector.startsWith("#\\3")).toBe(true);
  });

  it("escapes a quote inside a test id", async () => {
    const reference = buildElementReference(facts({ testId: 'say "hi"' }));
    expect(reference.selector).toBe('[data-testid="say \\"hi\\""]');
  });

  it("carries a readable label without putting it in the selector", async () => {
    const reference = buildElementReference(facts({ id: "go", accessibleName: "place order" }));
    expect(reference.label).toBe("place order");
    expect(reference.selector).toBe("#go");
  });

  it("truncates a label that is really a paragraph", async () => {
    const reference = buildElementReference(
      facts({ id: "go", accessibleName: "x".repeat(200) }),
    );
    expect((reference.label ?? "").length).toBeLessThanOrEqual(60);
  });
});
