/**
 * Bounded DOM snapshots — build plan §13.1, §41; dev plan BR-M1-09.
 *
 * Taken at navigation boundaries, not on every mutation. A snapshot per
 * mutation on a React application produces thousands per page and tells you
 * nothing a snapshot per screen does not.
 *
 * ## Truncation is recorded, never silent
 *
 * §41 caps snapshot size, and a cap that quietly drops the tail is worse than
 * no cap: the Explorer's queue (BR-M1-12) is built from these links, and a
 * page whose last forty links vanished looks like a page with fewer links
 * rather than a page that was cut short. Every cap here reports what it left
 * out.
 */

/** A link the Explorer could follow. */
export interface LinkRef {
  /** `href` exactly as written, which may be relative. */
  readonly href: string;
  /** Resolved against the document, for the queue. */
  readonly resolved?: string | undefined;
  readonly text?: string | undefined;
  readonly rel?: string | undefined;
  /** True when the anchor opens a new context — `target=_blank`. */
  readonly opensNewContext: boolean;
}

/** One control inside a form. */
export interface FieldRef {
  readonly name?: string | undefined;
  /** `text`, `password`, `hidden`, `checkbox`, … */
  readonly type: string;
  readonly required: boolean;
  /** Present for select elements, capped. */
  readonly options?: readonly string[] | undefined;
}

export interface FormRef {
  readonly action?: string | undefined;
  readonly resolvedAction?: string | undefined;
  readonly method: string;
  readonly fields: readonly FieldRef[];
  /**
   * True when any field is a password or a recognised credential name.
   *
   * §5A.2 refuses to submit these without an auth profile, so the Explorer
   * needs to know before it decides, and the judgment needs the field list
   * that only exists here.
   */
  readonly hasCredentialField: boolean;
  readonly fieldsTruncated: boolean;
}

/** A resource the document references — script, stylesheet, image, iframe. */
export interface ResourceRef {
  readonly kind: "script" | "stylesheet" | "image" | "iframe" | "media";
  readonly url: string;
}

export interface DomSnapshot {
  readonly url: string;
  readonly title?: string | undefined;
  readonly frameId?: string | undefined;
  readonly links: readonly LinkRef[];
  readonly forms: readonly FormRef[];
  readonly resources: readonly ResourceRef[];
  /** What was cut, and by which cap. Empty when nothing was. */
  readonly truncated: Readonly<Record<string, { kept: number; found: number }>>;
  /** Approximate serialized size of the document, for §41 accounting. */
  readonly documentBytes?: number | undefined;
}

export interface SnapshotLimits {
  readonly maxLinks: number;
  readonly maxForms: number;
  readonly maxFieldsPerForm: number;
  readonly maxResources: number;
  readonly maxOptionsPerField: number;
}

export const DEFAULT_SNAPSHOT_LIMITS: SnapshotLimits = {
  // Generous enough for a real navigation page, small enough that a
  // pathological listing cannot dominate the event log.
  maxLinks: 500,
  maxForms: 50,
  maxFieldsPerForm: 100,
  maxResources: 300,
  maxOptionsPerField: 50,
};

/** Field names that mean a form carries credentials, whatever its input type. */
const CREDENTIAL_NAMES = /pass|pwd|secret|token|otp|mfa|2fa|credential|api[-_]?key/i;

/** Whether a form's fields make it a credential form (§5A.2). */
export function hasCredentialField(fields: readonly FieldRef[]): boolean {
  return fields.some(
    (field) =>
      field.type === "password" ||
      (field.name !== undefined && CREDENTIAL_NAMES.test(field.name)),
  );
}

/**
 * Apply the caps to a raw snapshot, recording what was left out.
 *
 * Separate from the DOM read so the capping is testable without a browser —
 * and so the numbers a report shows come from one place rather than from
 * whatever each caller happened to slice.
 */
export function applyLimits(
  raw: Omit<DomSnapshot, "truncated">,
  limits: SnapshotLimits = DEFAULT_SNAPSHOT_LIMITS,
): DomSnapshot {
  const truncated: Record<string, { kept: number; found: number }> = {};

  const cap = <T>(items: readonly T[], max: number, name: string): readonly T[] => {
    if (items.length <= max) return items;
    truncated[name] = { kept: max, found: items.length };
    return items.slice(0, max);
  };

  const forms = cap(raw.forms, limits.maxForms, "forms").map((form) => {
    if (form.fields.length <= limits.maxFieldsPerForm) return form;
    return {
      ...form,
      fields: form.fields.slice(0, limits.maxFieldsPerForm),
      fieldsTruncated: true,
    };
  });

  return {
    ...raw,
    links: cap(raw.links, limits.maxLinks, "links"),
    forms,
    resources: cap(raw.resources, limits.maxResources, "resources"),
    truncated,
  };
}
