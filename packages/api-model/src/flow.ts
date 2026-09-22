/**
 * Value-flow dependencies — build plan §15, §14.1; dev plan BR-M2-03.
 *
 * §15 forbids inferring causality from timestamps. This is the honest
 * alternative: a **structural** link that can be pointed at. When the id in
 * `POST /api/cart`'s response turns up in `GET /api/cart/{id}`'s URL, the
 * second request genuinely could not have been made without the first, and
 * that is a dependency rather than an ordering.
 *
 * The edge is `inferred`, not `direct`. The browser did not say the two are
 * related; we noticed that a value flowed. Those are different claims and
 * §15's taxonomy has a level for each.
 *
 * ## Values are used, never carried
 *
 * The matching needs the actual value — `42`, a UUID, an order number. The
 * *output* records which field flowed, not what was in it: `basis` says
 * "the `order_id` from api_0003's response appears in this path". A report
 * that echoed the value would put the application's data in an artifact for
 * no gain, and §37.1 already draws that line for form input.
 *
 * ## Why only identifier-shaped values
 *
 * A response containing `"status": "ok"` and a later URL containing `ok`
 * would otherwise be a dependency. Matching is restricted to values long
 * enough and distinctive enough to be an identifier, which is also the only
 * kind of value that makes the claim meaningful.
 */
import type { Relationship } from "./relationships.js";

/** Values below this length match by accident. */
const MIN_VALUE_LENGTH = 4;
/** Values above this are documents, not identifiers. */
const MAX_VALUE_LENGTH = 128;
/** Values kept per response. A bound on both memory and nonsense. */
const MAX_VALUES_PER_RESPONSE = 40;
/** How deep into a response body to look for identifiers. */
const MAX_DEPTH = 5;

/** Field names whose values are identifiers worth following. */
const ID_FIELD =
  /(?:^|[._-])(?:id|uuid|guid|ref|reference|number|no|code|slug|key|hash|token)(?:$|[._-])|^(?:id|uuid)$/i;

/** Values that are identifier-shaped whatever the field is called. */
const ID_SHAPED = [
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  /^[0-9a-f]{24}$/i,
  /^[0-9a-f]{32,}$/i,
  /^\d{4,}$/,
] as const;

/**
 * Names whose values must never be extracted, however id-shaped.
 *
 * A session token appearing in a later URL is a finding about the
 * application, not a dependency — and following it would mean holding the
 * token in memory to do string comparisons with. The finding belongs to the
 * barrier and parameter reporting, which already record that a token-named
 * parameter exists without keeping its value.
 */
const NEVER_FOLLOW =
  /(?:^|[._-])(?:password|passwd|secret|auth|session|jwt|bearer|csrf|xsrf|otp|pin|cvv|signature)(?:$|[._-])/i;

function separateWords(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2");
}

/** One identifier seen in a response, and the field it came from. */
export interface FlowedValue {
  readonly field: string;
  readonly value: string;
}

/**
 * Pull identifier-shaped values out of a response body.
 *
 * Returns values as well as field names because matching needs them. The
 * caller keeps them for the duration of one model build and never exports
 * them — see the module note.
 */
export function extractIdentifiers(body: string): readonly FlowedValue[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return [];
  }

  const found: FlowedValue[] = [];
  const seen = new Set<string>();

  const walk = (value: unknown, path: string, depth: number): void => {
    if (depth > MAX_DEPTH || found.length >= MAX_VALUES_PER_RESPONSE) return;

    if (Array.isArray(value)) {
      // Only the first few elements: a list of 500 orders contributes the
      // same shape five hundred times.
      for (const item of value.slice(0, 5)) walk(item, `${path}[]`, depth + 1);
      return;
    }

    if (value !== null && typeof value === "object") {
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        walk(child, path === "" ? key : `${path}.${key}`, depth + 1);
      }
      return;
    }

    if (path === "") return;
    const leaf = path.split(".").pop() ?? "";
    if (NEVER_FOLLOW.test(separateWords(leaf))) return;

    const text =
      typeof value === "string" ? value : typeof value === "number" ? String(value) : undefined;
    if (text === undefined) return;
    if (text.length < MIN_VALUE_LENGTH || text.length > MAX_VALUE_LENGTH) return;

    const looksLikeId =
      ID_FIELD.test(separateWords(leaf)) || ID_SHAPED.some((pattern) => pattern.test(text));
    if (!looksLikeId || seen.has(text)) return;

    seen.add(text);
    found.push({ field: path, value: text });
  };

  walk(parsed, "", 0);
  return found;
}

/** Candidate places a later request could carry a value forward. */
export function valuesIn(url: string, body: string | undefined): readonly string[] {
  const out: string[] = [];
  try {
    const parsed = new URL(url);
    for (const segment of parsed.pathname.split("/")) {
      if (segment !== "") out.push(segment);
    }
    for (const [, value] of parsed.searchParams) out.push(value);
  } catch {
    // Not a URL we can take apart; the body may still carry the value.
  }
  if (body !== undefined && body.length <= 64 * 1024) {
    for (const value of extractIdentifiers(body)) out.push(value.value);
  }
  return out;
}

export interface FlowSource {
  readonly apiId: string;
  readonly sequence: number;
  readonly values: readonly FlowedValue[];
}

/**
 * Build the `depends_on` edges a later request's values justify.
 *
 * Only sources that came *earlier* in the log are considered: a value cannot
 * flow backwards, and allowing it would turn a shared constant into a mutual
 * dependency between two unrelated endpoints.
 */
export function dependenciesFor(
  consumer: {
    readonly apiId: string;
    readonly sequence: number;
    readonly candidates: readonly string[];
  },
  sources: readonly FlowSource[],
): readonly Relationship[] {
  const edges: Relationship[] = [];
  const carried = new Set(consumer.candidates);

  for (const source of sources) {
    if (source.apiId === consumer.apiId) continue;
    if (source.sequence >= consumer.sequence) continue;

    const match = source.values.find((value) => carried.has(value.value));
    if (match === undefined) continue;

    edges.push({
      target: `api:${source.apiId}`,
      kind: "inferred",
      // The field, never the value.
      basis: `the \`${match.field}\` from ${source.apiId}'s response appears in this request`,
    });
  }

  return edges;
}
