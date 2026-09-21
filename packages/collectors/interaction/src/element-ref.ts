/**
 * Stable element references — dev plan BR-M1-08.
 *
 * Every interaction has to name the element it touched, and that name has to
 * mean the same thing on the next run. §36.2's golden output compares two
 * scans of one fixture; a reference that changes between them makes every
 * comparison fail for a reason that has nothing to do with the application.
 *
 * ## The trap: ids are not automatically stable
 *
 * `#submit-button` is the obvious answer and usually the right one. But
 * modern frameworks generate ids, and a generated id is different on every
 * render:
 *
 *   React 18 `useId()`   `:r0:`, `:r1:`
 *   Ember                `ember123`
 *   MUI                  `mui-1234`
 *   Radix / Headless UI  `radix-:r3:`, `headlessui-menu-button-4`
 *   Hand-rolled          `el-8f3c2a1b`, a UUID, a timestamp
 *
 * A selector built on one of those looks perfectly stable in review and is
 * different on the next page load. So an id is used **only if it survives the
 * generated-id rules below**, and the strategy that was used is recorded so a
 * consumer can see how much weight the reference carries.
 *
 * ## Derived here, not in the browser
 *
 * The adapter reads the DOM facts; this turns them into a selector. Keeping
 * the derivation out of the browser layer is what makes "reproducible across
 * runs" testable without a browser — it is a property of this function, and
 * a table of inputs proves it far better than a page ever could.
 */
import type { AncestorStep, ElementFacts } from "@browserrecon/browser-adapter";

/** How the reference was arrived at, strongest first. */
export const REFERENCE_STRATEGIES = [
  /** A `data-testid` and friends — attributes that exist to be stable. */
  "test_id",
  /** An `id` that passed the generated-id rules. */
  "id",
  /** A form control's `name`, which the server addresses it by. */
  "name",
  /** A stable ancestor plus a structural path down to the element. */
  "anchored_path",
  /** A structural path from as far up as was captured. */
  "structural_path",
  /** Nothing better than the tag name was available. */
  "tag_only",
] as const;

export type ReferenceStrategy = (typeof REFERENCE_STRATEGIES)[number];

/**
 * How much the reference can be trusted to mean the same element next time.
 *
 * Recorded rather than assumed, because the difference matters to whoever
 * reads a report: `strong` will re-find the element after a redesign,
 * `positional` will not survive a sibling being inserted.
 */
export type ReferenceStability = "strong" | "moderate" | "positional";

export interface ElementReference {
  /** A CSS selector. Valid to pass back to the adapter. */
  readonly selector: string;
  readonly strategy: ReferenceStrategy;
  readonly stability: ReferenceStability;
  /** Human-readable, for a report. Never part of the selector. */
  readonly label?: string | undefined;
  readonly tagName: string;
}

/** Patterns that mark an id as generated, and therefore useless as a handle. */
export const GENERATED_ID_RULES: readonly { name: string; pattern: RegExp; why: string }[] = [
  {
    name: "react-useid",
    pattern: /^:[a-z0-9]*:$|:r[0-9a-z]+:/i,
    why: "React 18's useId() emits `:r0:`-style ids that change with render order.",
  },
  {
    name: "framework-counter",
    // The middle may contain hyphens — `headlessui-menu-button-4` is one
    // token to a human and four to a naive character class.
    pattern: /^(ember|mui|radix|headlessui|chakra|mantine|ant|v-)[-_:]?[-_a-z0-9:]*\d/i,
    why: "Component libraries append a per-instance counter that shifts as the tree changes.",
  },
  {
    name: "hex-or-uuid",
    pattern: /[0-9a-f]{8}-?[0-9a-f]{4}|^[0-9a-f]{12,}$/i,
    why: "A hash or UUID is regenerated per render or per session.",
  },
  {
    name: "hex-token",
    // A 6+ character token that is all hex AND mixes digits with letters.
    // Both conditions matter: without the digit, ordinary words made of
    // a-f letters ("decade", "facade") would be rejected; without the
    // letter, it is just a number and the digit-run rule already has it.
    //
    // A false positive here costs a weaker selector; a false negative costs
    // a selector that silently breaks on the next render. The asymmetry is
    // the reason this leans towards rejecting.
    pattern: /(^|[-_])(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{6,}($|[-_])/i,
    why: "A short hash embedded in an id — `el-8f3c2a1b` — is regenerated whenever the thing is.",
  },
  {
    name: "long-digit-run",
    pattern: /\d{5,}/,
    why: "Five or more consecutive digits is a counter or a timestamp, not a name someone chose.",
  },
  {
    name: "generic-prefix-number",
    pattern: /^(id|el|elem|item|node|comp|c|x)[-_]?\d+$/i,
    why: "A generic word plus a number is a generated handle; a human-chosen id says what the thing is.",
  },
];

/** Whether an id is worth building a selector on. */
export function isStableId(id: string): boolean {
  if (id === "" || id.length > 100) return false;
  return !GENERATED_ID_RULES.some((rule) => rule.pattern.test(id));
}

/** CSS-escape an attribute value for use inside `[attr="…"]`. */
function quote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** One structural step: `tag` when unique among siblings, else `tag:nth-of-type(n)`. */
function structuralStep(step: AncestorStep): string {
  return step.uniqueOfType ? step.tagName : `${step.tagName}:nth-of-type(${step.nthOfType})`;
}

/** A test id or stable id on an ancestor, which a path can hang from. */
function stableAnchor(step: AncestorStep): string | undefined {
  if (step.testId !== undefined) return `[data-testid=${quote(step.testId)}]`;
  if (step.id !== undefined && isStableId(step.id)) return `#${CSS_escape(step.id)}`;
  return undefined;
}

/**
 * Escape an id for use in a `#` selector.
 *
 * `CSS.escape` is a browser API and this runs in Node, so the small subset
 * that matters is handled here: an id starting with a digit, and the
 * punctuation CSS treats as a combinator.
 */
function CSS_escape(value: string): string {
  return value
    .replace(/^(\d)/, "\\3$1 ")
    .replace(/([ !"#$%&'()*+,./:;<=>?@[\]^`{|}~])/g, "\\$1");
}

function labelOf(facts: ElementFacts): string | undefined {
  const text = facts.accessibleName.trim();
  if (text === "") return undefined;
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

/**
 * Build the most stable reference the facts allow.
 *
 * The ladder is ordered by how well each survives a change to the page, and
 * the first rung that applies wins. Recording which one was used is as
 * important as the selector: a `positional` reference that silently became
 * the wrong element is worse than one a reader knew to distrust.
 */
export function buildElementReference(facts: ElementFacts): ElementReference {
  const label = labelOf(facts);
  const base = { tagName: facts.tagName, ...(label === undefined ? {} : { label }) };

  if (facts.testId !== undefined && facts.testId !== "") {
    return {
      ...base,
      selector: `[data-testid=${quote(facts.testId)}]`,
      strategy: "test_id",
      stability: "strong",
    };
  }

  if (facts.id !== undefined && isStableId(facts.id)) {
    return {
      ...base,
      selector: `#${CSS_escape(facts.id)}`,
      strategy: "id",
      stability: "strong",
    };
  }

  if (facts.name !== undefined && facts.name !== "") {
    // Scoped by tag, because `name` is only unique within a form and two
    // controls can share one — a radio group, most obviously.
    return {
      ...base,
      selector: `${facts.tagName}[name=${quote(facts.name)}]`,
      strategy: "name",
      stability: "moderate",
    };
  }

  const ancestors = facts.ancestors ?? [];
  if (ancestors.length === 0) {
    return { ...base, selector: facts.tagName, strategy: "tag_only", stability: "positional" };
  }

  // Walk outward for something stable to hang a short path from. A path
  // anchored two levels up survives a change three levels up; a path from the
  // document root survives nothing.
  for (let depth = 1; depth < ancestors.length; depth += 1) {
    const step = ancestors[depth];
    if (step === undefined) continue;
    const anchor = stableAnchor(step);
    if (anchor === undefined) continue;

    const path = ancestors.slice(0, depth).reverse().map(structuralStep).join(" > ");
    return {
      ...base,
      selector: `${anchor} > ${path}`,
      strategy: "anchored_path",
      stability: "moderate",
    };
  }

  return {
    ...base,
    selector: [...ancestors].reverse().map(structuralStep).join(" > "),
    strategy: "structural_path",
    stability: "positional",
  };
}

/** Render the generated-id rules, so the README cannot drift from the code. */
export function renderGeneratedIdTable(): string {
  return [
    "| Rule | Pattern | Why an id matching it is not a handle |",
    "| ---- | ------- | ------------------------------------- |",
    ...GENERATED_ID_RULES.map(
      (rule) =>
        `| \`${rule.name}\` | \`${rule.pattern.source.replace(/\|/g, "\\|")}\` | ${rule.why} |`,
    ),
  ].join("\n");
}
