/**
 * Declarative configuration field descriptors.
 *
 * Every setting is declared once, here, with its type, default, environment
 * variable and CLI flag. Three things fall out of that which are painful to
 * retrofit:
 *
 *   - Precedence logic (CLI > env > file > default) exists once, not per field.
 *   - The defaults table in the package README can be generated rather than
 *     hand-maintained, so documentation cannot drift from behaviour.
 *   - Validation errors can name the offending field *and* its allowed values,
 *     because the descriptor already knows them.
 *
 * It also enforces the build plan's rule that thresholds are configuration
 * rather than literals buried in code (dev plan §2.8) — a threshold that is
 * not declared here has nowhere legitimate to live.
 */

/** Where a resolved value came from. Precedence order, lowest first. */
export const VALUE_SOURCES = ["default", "file", "env", "cli"] as const;
export type ValueSource = (typeof VALUE_SOURCES)[number];

interface FieldBase {
  /** Dotted path in the config object, e.g. `output.dir`. */
  readonly path: string;
  /** Environment variable that overrides the file value. */
  readonly env?: string;
  /** CLI flag that overrides everything. Written without dashes, e.g. `out`. */
  readonly cli?: string;
  /** One line, used in error messages and the generated defaults table. */
  readonly describe: string;
}

export interface StringField extends FieldBase {
  readonly kind: "string";
  readonly default: string | undefined;
  readonly pattern?: RegExp;
}

export interface NumberField extends FieldBase {
  readonly kind: "number";
  readonly default: number;
  readonly min?: number;
  readonly max?: number;
  readonly integer?: boolean;
}

export interface BooleanField extends FieldBase {
  readonly kind: "boolean";
  readonly default: boolean;
}

export interface ListField extends FieldBase {
  readonly kind: "list";
  readonly default: readonly string[];
  /** When set, every item must be one of these. */
  readonly values?: readonly string[];
}

export interface EnumField extends FieldBase {
  readonly kind: "enum";
  readonly default: string;
  readonly values: readonly string[];
}

export type FieldSpec = StringField | NumberField | BooleanField | ListField | EnumField;

/** A complete configuration surface. */
export type ConfigSpec = readonly FieldSpec[];

// --- Descriptor constructors -----------------------------------------------
// Small helpers so a spec reads as a table rather than as object literals.

export function str(
  path: string,
  describe: string,
  options: {
    default?: string;
    env?: string;
    cli?: string;
    pattern?: RegExp;
  } = {},
): StringField {
  return {
    kind: "string",
    path,
    describe,
    default: options.default,
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.cli === undefined ? {} : { cli: options.cli }),
    ...(options.pattern === undefined ? {} : { pattern: options.pattern }),
  };
}

export function num(
  path: string,
  describe: string,
  options: {
    default: number;
    env?: string;
    cli?: string;
    min?: number;
    max?: number;
    integer?: boolean;
  },
): NumberField {
  return {
    kind: "number",
    path,
    describe,
    default: options.default,
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.cli === undefined ? {} : { cli: options.cli }),
    ...(options.min === undefined ? {} : { min: options.min }),
    ...(options.max === undefined ? {} : { max: options.max }),
    ...(options.integer === undefined ? {} : { integer: options.integer }),
  };
}

export function bool(
  path: string,
  describe: string,
  options: { default: boolean; env?: string; cli?: string },
): BooleanField {
  return {
    kind: "boolean",
    path,
    describe,
    default: options.default,
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.cli === undefined ? {} : { cli: options.cli }),
  };
}

export function list(
  path: string,
  describe: string,
  options: {
    default: readonly string[];
    env?: string;
    cli?: string;
    values?: readonly string[];
  },
): ListField {
  return {
    kind: "list",
    path,
    describe,
    default: options.default,
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.cli === undefined ? {} : { cli: options.cli }),
    ...(options.values === undefined ? {} : { values: options.values }),
  };
}

export function oneOf(
  path: string,
  describe: string,
  options: {
    values: readonly string[];
    default: string;
    env?: string;
    cli?: string;
  },
): EnumField {
  return {
    kind: "enum",
    path,
    describe,
    values: options.values,
    default: options.default,
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.cli === undefined ? {} : { cli: options.cli }),
  };
}
