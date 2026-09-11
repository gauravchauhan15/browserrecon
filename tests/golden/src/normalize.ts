/**
 * Normalization — build plan §36.2, dev plan BR-M0-14.
 *
 * Turns a run's output into the stable text a baseline is compared against,
 * and reports exactly how much it had to hide to get there.
 *
 * The report is the important half. Masking is a lie told to make comparison
 * possible, and the only way to keep an honest golden test is to make the size
 * of the lie visible: every rule's hit count goes into the baseline, so a rule
 * that starts matching five hundred things instead of three shows up as a diff
 * rather than as continued green.
 */
import { MASK_RULES, type MaskReport, type MaskRule } from "./masking.js";

export interface NormalizeResult {
  /** The normalized text, ready to compare or store. */
  readonly text: string;
  /** Hit count per rule name. Rules that never fired are omitted. */
  readonly report: MaskReport;
}

class Counter {
  readonly #counts = new Map<string, number>();

  hit(name: string): void {
    this.#counts.set(name, (this.#counts.get(name) ?? 0) + 1);
  }

  /** Sorted, so the report's key order cannot vary between runs. */
  freeze(): MaskReport {
    return Object.fromEntries([...this.#counts].sort(([a], [b]) => a.localeCompare(b)));
  }
}

const fieldRules = MASK_RULES.filter(
  (rule): rule is Extract<MaskRule, { kind: "field" }> => rule.kind === "field",
);
const valueRules = MASK_RULES.filter(
  (rule): rule is Extract<MaskRule, { kind: "value" }> => rule.kind === "value",
);

/** Apply every value rule to one string, counting each substitution. */
function maskString(input: string, counter: Counter): string {
  let output = input;
  for (const rule of valueRules) {
    output = output.replace(rule.pattern, () => {
      counter.hit(rule.name);
      return rule.placeholder;
    });
  }
  return output;
}

/**
 * Walk a parsed JSON value, masking fields by name and strings by pattern.
 *
 * Object keys are emitted in sorted order. Two runs that build the same object
 * by different code paths can otherwise serialize its keys differently, which
 * would fail a comparison for no reason a reviewer could act on.
 */
function maskValue(value: unknown, counter: Counter): unknown {
  if (typeof value === "string") return maskString(value, counter);
  if (value === null || typeof value !== "object") return value;

  if (Array.isArray(value)) {
    return value.map((item) => maskValue(item, counter));
  }

  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const child = (value as Record<string, unknown>)[key];
    const rule = fieldRules.find((candidate) => candidate.fields.includes(key));

    if (rule !== undefined && (rule.matches?.(child) ?? true)) {
      counter.hit(rule.name);
      out[key] = rule.placeholder;
      continue;
    }
    out[key] = maskValue(child, counter);
  }
  return out;
}

/** Normalize a parsed JSON value. */
export function normalizeJson(value: unknown): NormalizeResult {
  const counter = new Counter();
  const masked = maskValue(value, counter);
  return { text: `${JSON.stringify(masked, null, 2)}\n`, report: counter.freeze() };
}

/**
 * Normalize a JSONL event log.
 *
 * Line-oriented rather than parsed as a whole, because that is how the file is
 * actually consumed — one event per line, streamable — and because a diff of
 * one changed event should touch one line.
 */
export function normalizeJsonl(text: string): NormalizeResult {
  const counter = new Counter();
  const lines = text.split("\n").filter((line) => line.trim() !== "");

  const masked = lines.map((line, index) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // A malformed line is a real finding, not something to hide. Keeping it
      // verbatim puts it in the diff where a reviewer will see it.
      return `<<unparseable line ${index + 1}>> ${maskString(line, counter)}`;
    }
    return JSON.stringify(maskValue(parsed, counter));
  });

  return { text: `${masked.join("\n")}\n`, report: counter.freeze() };
}

/**
 * Normalize plain text — an HTML page, a CLI transcript, a report.
 *
 * Only value rules apply; there are no fields to key on.
 */
export function normalizeText(text: string): NormalizeResult {
  const counter = new Counter();
  return { text: ensureTrailingNewline(maskString(text, counter)), report: counter.freeze() };
}

function ensureTrailingNewline(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`;
}

/**
 * Combine several normalized parts into one baseline.
 *
 * A scan produces a directory, not a file — an event log, a manifest, a
 * checkpoint. Comparing them as one document means a reviewer sees a single
 * diff for one behavioural change, instead of three unrelated-looking ones.
 */
export function combine(
  parts: readonly (readonly [string, NormalizeResult])[],
): NormalizeResult {
  const sections: string[] = [];
  const totals = new Map<string, number>();

  for (const [name, part] of parts) {
    sections.push(`===== ${name} =====`, part.text.replace(/\n$/, ""));
    for (const [rule, count] of Object.entries(part.report)) {
      totals.set(rule, (totals.get(rule) ?? 0) + count);
    }
  }

  return {
    text: `${sections.join("\n")}\n`,
    report: Object.fromEntries([...totals].sort(([a], [b]) => a.localeCompare(b))),
  };
}
