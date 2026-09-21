/**
 * Payload shapes — build plan §14.1, §41, §37.1; dev plan BR-M2-04.
 *
 * What a scanner needs from a request body is its **shape**: which fields
 * exist, of what type, which are required. What it does not need is the
 * values, and the difference is not a nicety — a checkout request body
 * contains a card number, an address and a name, and a report carrying them
 * is a report nobody can attach to a ticket.
 *
 * So this summarises structure and drops content. `{"email":"a@b.com",
 * "qty":2}` becomes `email: string, qty: number`. The raw body is already in
 * the event store, which is local and raw by design (§22.1); what leaves the
 * machine is this.
 *
 * ## Values are dropped, not redacted
 *
 * Redaction is a filter, and a filter has a false-negative rate. A field
 * name nobody wrote a pattern for carries its value straight through. Shape
 * extraction has no such failure mode: there is no code path here that can
 * emit a value, so there is nothing for a missing pattern to leak.
 *
 * The one exception is an enum-shaped field — a handful of distinct short
 * values across many observations, such as `status: "open" | "closed"`. That
 * is genuinely part of the interface, and it is gated on the field name not
 * looking sensitive and the values being short and few.
 */

export type FieldType =
  "string" | "number" | "boolean" | "null" | "array" | "object" | "unknown";

export interface FieldShape {
  /** Dotted path: `user.address.postcode`. Array elements use `[]`. */
  readonly path: string;
  /** Every type seen at this path. More than one is itself informative. */
  readonly types: readonly FieldType[];
  /** Fraction of observations that carried it. 1 means always present. */
  readonly presence: number;
  /**
   * Distinct values, when the field is enum-shaped and not sensitive.
   *
   * Part of the interface when present: knowing `role` takes `user` or
   * `admin` is the kind of thing a security reader acts on.
   */
  readonly values?: readonly string[] | undefined;
}

export interface PayloadShape {
  readonly contentType?: string | undefined;
  readonly fields: readonly FieldShape[];
  /** Observations this shape was built from. */
  readonly samples: number;
  /** Set when a body could not be parsed or was not captured. */
  readonly note?: string | undefined;
}

/** How deep to walk. Beyond this a payload is a document, not an interface. */
const MAX_DEPTH = 6;
/** Distinct paths kept. A pathological payload must not become the report. */
const MAX_FIELDS = 200;
/** At most this many distinct values before a field stops looking enum-like. */
const MAX_ENUM_VALUES = 8;
/** Longer than this and a value is data, not a member of a small set. */
const MAX_ENUM_LENGTH = 32;

const SENSITIVE_FIELD =
  /(?:^|[._-])(?:token|key|secret|password|passwd|pwd|auth|session|jwt|bearer|signature|sig|otp|pin|cvv|cvc|card|pan|iban|ssn|nino|email|phone|mobile|address|dob|birth)(?:$|[._-])|^(?:name|surname|firstname|lastname)$/i;

/**
 * Split camelCase so word boundaries are visible to the pattern.
 *
 * Found by a test: `accessToken` did not match while `access_token` did.
 * camelCase is the dominant convention in JavaScript APIs, so the pattern
 * was missing the majority case — `accessToken`, `apiKey`, `sessionId`,
 * `cardNumber`. Splitting here beats a pattern that tries to express every
 * boundary itself, which is how that one came to be wrong.
 */
function separateWords(segment: string): string {
  return segment
    .replace(/\[\]$/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2");
}

export function isSensitiveFieldName(path: string): boolean {
  return path.split(".").some((segment) => SENSITIVE_FIELD.test(separateWords(segment)));
}

function typeOf(value: unknown): FieldType {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  switch (typeof value) {
    case "string":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "object":
      return "object";
    default:
      return "unknown";
  }
}

interface Accumulator {
  types: Set<FieldType>;
  present: number;
  values: Set<string>;
  tooManyValues: boolean;
}

/**
 * Builds a shape across many observations of one endpoint.
 *
 * Stateful across calls because presence — "this field was in 3 of 40
 * requests" — is the part that distinguishes an optional parameter from a
 * required one, and that cannot be seen in a single body.
 */
export class ShapeBuilder {
  readonly #fields = new Map<string, Accumulator>();
  #samples = 0;
  #contentType: string | undefined;
  #note: string | undefined;

  /** Record one body. Malformed input is noted, never thrown. */
  add(body: string | undefined, contentType?: string): void {
    this.#samples += 1;
    if (contentType !== undefined) this.#contentType = contentType;

    if (body === undefined || body === "") {
      this.#note = "some requests carried no body";
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      // Form encoding is the other common case and is worth handling;
      // anything else is recorded as unparsed rather than dropped, so a
      // reader knows a body existed.
      if (contentType?.includes("x-www-form-urlencoded") === true) {
        this.#addForm(body);
        return;
      }
      this.#note = "some bodies were not JSON";
      return;
    }

    this.#walk(parsed, "", 0);
  }

  #addForm(body: string): void {
    for (const [name, value] of new URLSearchParams(body)) {
      this.#record(name, "string", value);
    }
  }

  #walk(value: unknown, path: string, depth: number): void {
    if (depth > MAX_DEPTH || this.#fields.size >= MAX_FIELDS) return;

    if (Array.isArray(value)) {
      if (path !== "") this.#record(path, "array");
      // Only the first element: an array of 500 orders has one shape, and
      // walking all of them costs time to learn nothing.
      if (value.length > 0) this.#walk(value[0], `${path}[]`, depth + 1);
      return;
    }

    if (value !== null && typeof value === "object") {
      if (path !== "") this.#record(path, "object");
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        this.#walk(child, path === "" ? key : `${path}.${key}`, depth + 1);
      }
      return;
    }

    if (path === "") return;
    this.#record(path, typeOf(value), typeof value === "string" ? value : String(value));
  }

  #record(path: string, type: FieldType, value?: string): void {
    if (this.#fields.size >= MAX_FIELDS && !this.#fields.has(path)) return;

    const existing = this.#fields.get(path) ?? {
      types: new Set<FieldType>(),
      present: 0,
      values: new Set<string>(),
      tooManyValues: false,
    };
    existing.types.add(type);
    existing.present += 1;

    // The only path on which a value survives, and it is gated three ways.
    if (
      value !== undefined &&
      !existing.tooManyValues &&
      !isSensitiveFieldName(path) &&
      value.length <= MAX_ENUM_LENGTH
    ) {
      existing.values.add(value);
      if (existing.values.size > MAX_ENUM_VALUES) {
        // Not an enum. Everything gathered so far is discarded rather than
        // truncated — a "first 8 of many" list reads like a complete set.
        existing.tooManyValues = true;
        existing.values.clear();
      }
    } else if (value !== undefined) {
      existing.tooManyValues = true;
      existing.values.clear();
    }

    this.#fields.set(path, existing);
  }

  snapshot(): PayloadShape {
    const fields = [...this.#fields.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([path, accumulator]): FieldShape => {
        const values = accumulator.tooManyValues ? [] : [...accumulator.values].sort();
        return {
          path,
          types: [...accumulator.types].sort(),
          presence: this.#samples === 0 ? 0 : accumulator.present / this.#samples,
          ...(values.length === 0 ? {} : { values }),
        };
      });

    return {
      ...(this.#contentType === undefined ? {} : { contentType: this.#contentType }),
      fields,
      samples: this.#samples,
      ...(this.#note === undefined ? {} : { note: this.#note }),
    };
  }
}
