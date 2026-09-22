/**
 * Test data profiles — build plan §12.5; dev plan BR-M2-17b.
 *
 * Some surface is gated not by authorization but by **input validation**. A
 * five-step checkout will not advance without a card number that passes a
 * Luhn check; a rule-based explorer cannot synthesize one, so it stalls at
 * step two and everything past it is recorded unreachable.
 *
 * The fix is user-supplied data, in the same spirit as an auth profile: the
 * user knows what their application accepts, and safe test values usually
 * already exist for their QA process. The tool types what it was given and
 * nothing else — §12.5's closing line, which matters more from V5 on: *the
 * model never invents data to submit to an application.*
 *
 * ## Four rules, and `never_fill` is the one that must not bend
 *
 * - Sensitive values come from the environment, never inline (§12.1's rule).
 * - Values are deterministic, so golden tests stay stable (§36.2).
 * - **`never_fill` always wins over any match rule.**
 * - Filling a field is not permission to submit. Submission still needs the
 *   form to pass safe-form classification and the method to be allowed.
 *
 * That third rule is checked first and separately in `valueFor`, before any
 * matching runs. A precedence expressed as "the deny list is evaluated after
 * the allow list" is one a later refactor reorders; expressed as an early
 * return, reordering it is visible.
 */

export interface FieldMatch {
  /** Matched against the field's `name`, case-insensitively. */
  readonly namePattern?: string | undefined;
  /** Matched against the input's `type` attribute. */
  readonly inputType?: string | undefined;
  /** Matched against the field's visible label or placeholder. */
  readonly labelPattern?: string | undefined;
}

export interface FieldRule {
  readonly match: FieldMatch;
  /** A literal value. For anything non-sensitive: a postcode, a quantity. */
  readonly value?: string | undefined;
  /** The name of an environment variable. For anything sensitive. */
  readonly valueEnv?: string | undefined;
}

export interface TestDataProfile {
  readonly name: string;
  readonly fields: readonly FieldRule[];
  /** Fields never auto-filled, whatever any rule says. */
  readonly neverFill: readonly FieldMatch[];
}

export interface FieldFacts {
  readonly name: string;
  readonly type?: string | undefined;
  readonly label?: string | undefined;
}

export type FillDecision =
  | {
      readonly fill: true;
      readonly value: string;
      readonly rule: string;
      readonly fromEnv: boolean;
    }
  | { readonly fill: false; readonly reason: string };

export interface ProfileProblem {
  readonly field: string;
  readonly reason: string;
}

const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;

/**
 * Names that must never be auto-filled, whatever a profile says.
 *
 * A floor under the user's own `never_fill`, not a replacement for it. A
 * profile that matched `.*` — which someone will write — must not therefore
 * type a value into a field called `confirm_delete`. These are the fields
 * where filling is itself most of the way to an irreversible action.
 */
export const ALWAYS_REFUSED = [
  /delete/i,
  /destroy/i,
  /confirm[_-]?(?:delete|destroy|removal|cancel)/i,
  /transfer[_-]?amount/i,
  /wipe/i,
  /purge/i,
  /terminate/i,
  /deactivate/i,
] as const;

/**
 * Split a field name into words, so a pattern can see boundaries.
 *
 * Found by a test: `/\bpurge\b/` does not match `purge_data`, because `_` is
 * a word character and there is no boundary between them. Field names are
 * overwhelmingly `snake_case`, `kebab-case` or `camelCase`, so a pattern
 * relying on `\b` misses the majority spelling of every name on the list —
 * which for this list means a destructive field getting filled.
 *
 * The patterns above no longer use `\b` at all; this exists so a future one
 * can, and so `delete` in `deleted_at` is still caught.
 */
function separateWords(name: string): string {
  return name
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
}

function matches(facts: FieldFacts, match: FieldMatch): boolean {
  const test = (
    pattern: string | undefined,
    against: string | undefined,
  ): boolean | undefined => {
    if (pattern === undefined) return undefined;
    if (against === undefined) return false;
    try {
      return new RegExp(pattern, "i").test(against);
    } catch {
      // A profile with a broken pattern must not match everything. Refusing
      // to match is the safe direction: the field is left alone.
      return false;
    }
  };

  const results = [
    test(match.namePattern, facts.name),
    match.inputType === undefined
      ? undefined
      : (facts.type ?? "").toLowerCase() === match.inputType.toLowerCase(),
    test(match.labelPattern, facts.label),
  ].filter((result): result is boolean => result !== undefined);

  // An empty match object matches nothing. A rule with no criteria is
  // almost certainly a mistake, and treating it as "match everything" would
  // type values into every field on the page.
  return results.length > 0 && results.every(Boolean);
}

/**
 * Decide what, if anything, to type into a field.
 *
 * Every path returns a decision with a reason. A caller that has to
 * distinguish "no rule matched" from "refused" gets to, because the two
 * mean different things in a report: one is a gap, the other is a boundary.
 */
export function valueFor(
  profile: TestDataProfile,
  facts: FieldFacts,
  env: Readonly<Record<string, string | undefined>>,
): FillDecision {
  // First, and before any matching. See the module note.
  const candidates = [facts.name, separateWords(facts.name)];
  if (facts.label !== undefined) candidates.push(facts.label, separateWords(facts.label));

  for (const pattern of ALWAYS_REFUSED) {
    if (candidates.some((candidate) => pattern.test(candidate))) {
      return {
        fill: false,
        reason: `"${facts.name}" is never auto-filled: it names a destructive action`,
      };
    }
  }

  for (const refusal of profile.neverFill) {
    if (matches(facts, refusal)) {
      return { fill: false, reason: `"${facts.name}" is in the profile's never_fill list` };
    }
  }

  for (const [index, rule] of profile.fields.entries()) {
    if (!matches(facts, rule.match)) continue;

    const label = `${profile.name}#${index}`;
    if (rule.valueEnv !== undefined) {
      const value = env[rule.valueEnv];
      if (value === undefined || value === "") {
        return {
          fill: false,
          // Names the variable, never a value.
          reason: `${rule.valueEnv} is not set, so "${facts.name}" was left empty`,
        };
      }
      return { fill: true, value, rule: label, fromEnv: true };
    }

    if (rule.value !== undefined) {
      return { fill: true, value: rule.value, rule: label, fromEnv: false };
    }

    return { fill: false, reason: `rule ${label} matched but supplies no value` };
  }

  return { fill: false, reason: `no rule matched "${facts.name}"` };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseMatch(raw: unknown): FieldMatch {
  if (!isPlainObject(raw)) return {};
  const read = (camel: string, snake: string): string | undefined => {
    const value = raw[camel] ?? raw[snake];
    return typeof value === "string" ? value : undefined;
  };
  const namePattern = read("namePattern", "name_pattern");
  const inputType = read("inputType", "input_type");
  const labelPattern = read("labelPattern", "label_pattern");
  return {
    ...(namePattern === undefined ? {} : { namePattern }),
    ...(inputType === undefined ? {} : { inputType }),
    ...(labelPattern === undefined ? {} : { labelPattern }),
  };
}

/** Parse a profile, refusing an inline secret exactly as an auth profile does. */
export function parseTestDataProfile(
  raw: unknown,
):
  | { readonly ok: true; readonly profile: TestDataProfile }
  | { readonly ok: false; readonly problems: readonly ProfileProblem[] } {
  const problems: ProfileProblem[] = [];
  if (!isPlainObject(raw)) {
    return {
      ok: false,
      problems: [{ field: "", reason: "a test data profile must be a mapping" }],
    };
  }

  const name = typeof raw.name === "string" && raw.name.trim() !== "" ? raw.name : undefined;
  if (name === undefined) problems.push({ field: "name", reason: "a profile needs a name" });

  const fields: FieldRule[] = [];
  const rawFields = Array.isArray(raw.fields) ? raw.fields : [];
  if (rawFields.length === 0) {
    problems.push({ field: "fields", reason: "a profile with no field rules fills nothing" });
  }

  for (const [index, entry] of rawFields.entries()) {
    if (!isPlainObject(entry)) {
      problems.push({ field: `fields[${index}]`, reason: "each field rule must be a mapping" });
      continue;
    }
    const match = parseMatch(entry.match);
    if (Object.keys(match).length === 0) {
      problems.push({
        field: `fields[${index}].match`,
        reason: "a rule with no match criteria would fill every field on the page",
      });
      continue;
    }

    const value = typeof entry.value === "string" ? entry.value : undefined;
    const valueEnv =
      typeof entry.valueEnv === "string"
        ? entry.valueEnv
        : typeof entry.value_env === "string"
          ? entry.value_env
          : undefined;

    if (value === undefined && valueEnv === undefined) {
      problems.push({
        field: `fields[${index}]`,
        reason: "needs either `value` or `value_env`",
      });
      continue;
    }
    if (value !== undefined && valueEnv !== undefined) {
      problems.push({
        field: `fields[${index}]`,
        reason: "has both `value` and `value_env`; which one wins would be a guess",
      });
      continue;
    }
    if (valueEnv !== undefined && !ENV_NAME.test(valueEnv)) {
      problems.push({
        field: `fields[${index}].value_env`,
        reason: "must name an environment variable, e.g. BROWSERRECON_TEST_CARD",
      });
      continue;
    }

    // §12.1's rule, applied here: a value that looks like a live secret has
    // no business inline. Checked on shape rather than on the field's name,
    // because the name is the user's and the shape is the evidence.
    if (value !== undefined && looksLikeLiveSecret(value)) {
      problems.push({
        field: `fields[${index}].value`,
        reason:
          "this looks like a real credential. Use `value_env` — an inline value ends " +
          "up in git, and test data profiles are meant to be committed",
      });
      continue;
    }

    fields.push({
      match,
      ...(value === undefined ? {} : { value }),
      ...(valueEnv === undefined ? {} : { valueEnv }),
    });
  }

  const neverFill = (
    Array.isArray(raw.neverFill)
      ? raw.neverFill
      : Array.isArray(raw.never_fill)
        ? raw.never_fill
        : []
  )
    .map(parseMatch)
    .filter((match) => Object.keys(match).length > 0);

  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, profile: { name: name as string, fields, neverFill } };
}

/**
 * Whether an inline value looks like a live credential.
 *
 * Deliberately narrow: a false positive here blocks a legitimate profile,
 * and the common safe values — `123`, `SW1A 1AA`, `4242424242424242` — must
 * all pass. What it catches is the shape of things that are only ever real.
 */
export function looksLikeLiveSecret(value: string): boolean {
  return (
    /^(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{16,}$/.test(value) ||
    /^gh[pousr]_[A-Za-z0-9]{20,}$/.test(value) ||
    /^eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./.test(value) ||
    /^AKIA[0-9A-Z]{16}$/.test(value) ||
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value)
  );
}
