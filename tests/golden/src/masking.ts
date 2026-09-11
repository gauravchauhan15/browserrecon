/**
 * Masking rules — build plan §36.2, dev plan BR-M0-14.
 *
 * A golden test compares a whole scan's output byte for byte. Some of that
 * output legitimately differs between runs — a clock moved, the OS handed out
 * a different port — and masking those fields is what makes the comparison
 * possible at all.
 *
 * The danger is the opposite of the obvious one. An under-masked baseline
 * fails loudly and gets fixed within minutes. An **over-masked** baseline
 * passes forever while asserting nothing, and nobody notices, because a green
 * test looks the same either way. Every rule here is therefore:
 *
 *   - **declared in this one file**, so the full masking surface can be read
 *     in a single sitting rather than discovered across a codebase;
 *   - **as narrow as it can be** — keyed on a field name where the field is
 *     known, and only falling back to a value pattern where the value can turn
 *     up anywhere (inside an error message, a file path, a URL);
 *   - **counted**. `normalize()` reports how many times each rule fired, and
 *     that report is stored in the baseline. Masking more than before is
 *     itself a reviewable diff, which is the only mechanical defence against a
 *     rule quietly widening.
 *
 * Adding a rule is a deliberate act with a cost. Before adding one, check that
 * the field is genuinely nondeterministic rather than a bug: a value that
 * "changes every run" is often a missing injected clock or a random ID that
 * should have been a counter (see `IdFactory` — IDs are deterministic by
 * design precisely so they never need masking).
 */

/** What a rule replaces a value with. Readable in a baseline, and unique. */
export type Placeholder = `<${string}>`;

/**
 * A rule keyed on the JSON field name.
 *
 * Preferred over a value pattern: it cannot match something that merely looks
 * like a timestamp somewhere in a response body the scan captured.
 */
export interface FieldRule {
  readonly kind: "field";
  readonly name: string;
  /** Exact field names this applies to. */
  readonly fields: readonly string[];
  readonly placeholder: Placeholder;
  /** Why this field is legitimately nondeterministic. */
  readonly why: string;
  /**
   * Restricts the rule to values that actually look wrong, so a field that
   * happens to share a name but holds a stable value is left alone.
   */
  readonly matches?: ((value: unknown) => boolean) | undefined;
}

/**
 * A rule applied to any string, anywhere.
 *
 * Only for values that cannot be located by field name — a temp directory
 * inside an error message, a port inside a URL. Each one is a blunt
 * instrument, so the pattern has to be tight.
 */
export interface ValueRule {
  readonly kind: "value";
  readonly name: string;
  readonly pattern: RegExp;
  readonly placeholder: Placeholder;
  readonly why: string;
}

export type MaskRule = FieldRule | ValueRule;

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * The complete masking surface. Nothing else is masked anywhere.
 *
 * Order matters for value rules: they run top to bottom, so a broader pattern
 * placed first would swallow the narrower ones below it.
 */
export const MASK_RULES: readonly MaskRule[] = [
  {
    kind: "field",
    name: "timestamp",
    fields: ["timestamp", "at", "startedAt", "finishedAt", "observedAt"],
    placeholder: "<timestamp>",
    why: "Wall-clock time of the run. The only field on every event that cannot be reproduced.",
    // Guarded so a field named `at` holding something else — an index, a
    // selector — is not silently blanked.
    matches: (value) => typeof value === "string" && ISO_TIMESTAMP.test(value),
  },
  {
    kind: "field",
    name: "duration",
    fields: ["durationMs", "elapsedMs", "ttfbMs", "latencyMs"],
    placeholder: "<duration-ms>",
    why: "How long something took. Varies with machine load, not with behaviour.",
    matches: (value) => typeof value === "number",
  },
  {
    kind: "field",
    name: "ephemeral-port",
    fields: ["port"],
    placeholder: "<port>",
    why: "Fixtures listen on an OS-assigned port so parallel tests cannot collide.",
    matches: (value) => typeof value === "number" && value > 1024,
  },
  {
    kind: "value",
    name: "tmpdir-path",
    // macOS (/var/folders/…/T/…), Linux (/tmp/…) and the private-prefixed form
    // macOS resolves to. Anchored on the session prefix the code actually
    // uses, so unrelated paths are left visible.
    pattern: /(?:\/private)?(?:\/var\/folders\/[^\s"]*?\/T|\/tmp)\/[A-Za-z0-9._-]+/g,
    placeholder: "<tmpdir>",
    why: "Session directories are created under the OS temp dir with a random suffix.",
  },
  {
    kind: "value",
    name: "loopback-origin",
    pattern: /http:\/\/127\.0\.0\.1:\d+/g,
    placeholder: "<fixture-origin>",
    why: "A fixture's origin embeds its ephemeral port. Reaches URLs, Host headers and bodies.",
  },
  {
    kind: "value",
    name: "home-path",
    pattern: /\/(?:Users|home)\/[A-Za-z0-9._-]+/g,
    placeholder: "<home>",
    why: "Absolute paths differ per developer and would leak a username into a committed baseline.",
  },
];

/** How many times each rule fired. Stored in the baseline — see the note above. */
export type MaskReport = Readonly<Record<string, number>>;

/** Every rule name, for tests that assert the surface has not grown unnoticed. */
export const MASK_RULE_NAMES: readonly string[] = MASK_RULES.map((rule) => rule.name);

/**
 * Render the rules as a table, so the README cannot drift from the code.
 *
 * Pipes are escaped because a regex alternation contains one, and an
 * unescaped `|` silently splits a markdown cell in two — producing a table
 * that renders as nonsense on GitHub while looking correct in the source.
 * Found by the drift test, which is the only reason anyone would notice.
 */
const escapePipes = (text: string): string => text.replace(/\|/g, "\\|");

export function renderMaskTable(): string {
  const rows = MASK_RULES.map((rule) => {
    const applies =
      rule.kind === "field"
        ? `fields: \`${rule.fields.join("\`, \`")}\``
        : `pattern: \`${escapePipes(rule.pattern.source)}\``;
    return `| \`${rule.name}\` | ${applies} | \`${rule.placeholder}\` | ${escapePipes(rule.why)} |`;
  });
  return [
    "| Rule | Applies to | Placeholder | Why it is masked |",
    "| ---- | ---------- | ----------- | ---------------- |",
    ...rows,
  ].join("\n");
}
