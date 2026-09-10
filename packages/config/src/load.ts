/**
 * Configuration resolution — build plan §7.2, §11.
 *
 * Precedence, highest wins:
 *
 *   CLI flag  >  environment variable  >  config file  >  declared default
 *
 * The rationale is that each level is more specific to *this run* than the one
 * below it: a file describes a project, an environment variable describes a
 * machine or pipeline, and a flag describes one invocation.
 *
 * This module is the single place in the codebase permitted to read
 * `process.env` (dev plan §2.5), and even here it is passed in rather than
 * reached for, so every consumer receives configuration by injection and
 * tests need no environment mutation.
 */
import { readFileSync, existsSync } from "node:fs";
import { extname } from "node:path";
import { parse as parseYaml } from "yaml";
import type { ConfigSpec, FieldSpec, ValueSource } from "./spec.js";

/** A rejected value, naming the field and what would have been acceptable. */
export interface ConfigError {
  readonly path: string;
  readonly source: ValueSource;
  readonly reason: string;
  /** The offending value, stringified for display. Never a secret — see note. */
  readonly received: string;
}

/** How one field's value was arrived at. Surfaced by `config validate`. */
export interface ResolvedValue {
  readonly value: string | number | boolean | readonly string[] | undefined;
  readonly source: ValueSource;
}

export type ConfigResult =
  | {
      readonly ok: true;
      /** Nested object built from the dotted paths. */
      readonly config: Record<string, unknown>;
      /** Per-path provenance, so "why is my rate 5?" is answerable. */
      readonly origins: ReadonlyMap<string, ResolvedValue>;
    }
  | { readonly ok: false; readonly errors: readonly ConfigError[] };

export interface LoadConfigInput {
  readonly spec: ConfigSpec;
  /** Path to a YAML or JSON config file. Missing file is not an error. */
  readonly file?: string | undefined;
  /** Environment, injected rather than read, so tests stay hermetic. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Already-parsed CLI options, keyed by the spec's `cli` name. */
  readonly cli?: Readonly<Record<string, string | boolean | undefined>>;
  /** Pre-parsed file contents, for callers that read the file themselves. */
  readonly fileData?: unknown;
}

// --- File loading ----------------------------------------------------------

/** Parse a config file by extension. YAML is primary; JSON is accepted. */
export function parseConfigFile(text: string, filename: string): unknown {
  const extension = extname(filename).toLowerCase();
  if (extension === ".json") return JSON.parse(text);
  if (extension === ".yaml" || extension === ".yml") return parseYaml(text);
  throw new Error(
    `unsupported config file extension "${extension}" for ${filename}; expected .yaml, .yml or .json`,
  );
}

// --- Path helpers ----------------------------------------------------------

function readPath(source: unknown, path: string): unknown {
  let current: unknown = source;
  for (const segment of path.split(".")) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function writePath(target: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split(".");
  const last = segments.pop();
  if (last === undefined) return;

  let cursor = target;
  for (const segment of segments) {
    const existing = cursor[segment];
    if (typeof existing !== "object" || existing === null || Array.isArray(existing)) {
      cursor[segment] = {};
    }
    cursor = cursor[segment] as Record<string, unknown>;
  }
  cursor[last] = value;
}

// --- Coercion --------------------------------------------------------------

type Coerced =
  | { ok: true; value: string | number | boolean | readonly string[] }
  | { ok: false; reason: string };

/**
 * Convert a raw value to the field's type.
 *
 * Environment variables and CLI flags arrive as strings, so coercion is
 * unavoidable — but it is deliberately strict. `"yes"` is not a boolean and
 * `"2 "` is not silently trimmed into a number: a typo in a rate limit should
 * fail loudly, not resolve to something plausible.
 */
function coerce(field: FieldSpec, raw: unknown): Coerced {
  switch (field.kind) {
    case "string": {
      if (typeof raw !== "string") return { ok: false, reason: "expected a string" };
      if (field.pattern && !field.pattern.test(raw)) {
        return { ok: false, reason: `must match ${String(field.pattern)}` };
      }
      return { ok: true, value: raw };
    }

    case "number": {
      const value = typeof raw === "number" ? raw : Number(raw);
      if (typeof raw === "string" && raw.trim() !== raw) {
        return { ok: false, reason: "expected a number without surrounding whitespace" };
      }
      if (typeof raw === "boolean" || raw === "" || !Number.isFinite(value)) {
        return { ok: false, reason: "expected a finite number" };
      }
      if (field.integer && !Number.isInteger(value)) {
        return { ok: false, reason: "expected an integer" };
      }
      if (field.min !== undefined && value < field.min) {
        return { ok: false, reason: `must be >= ${field.min}` };
      }
      if (field.max !== undefined && value > field.max) {
        return { ok: false, reason: `must be <= ${field.max}` };
      }
      return { ok: true, value };
    }

    case "boolean": {
      if (typeof raw === "boolean") return { ok: true, value: raw };
      if (raw === "true") return { ok: true, value: true };
      if (raw === "false") return { ok: true, value: false };
      return { ok: false, reason: 'expected true or false (exactly, not "yes"/"1"/"on")' };
    }

    case "list": {
      const items = Array.isArray(raw)
        ? raw
        : typeof raw === "string"
          ? raw.split(",").map((part) => part.trim())
          : undefined;
      if (items === undefined) {
        return { ok: false, reason: "expected a list, or a comma-separated string" };
      }
      if (!items.every((item): item is string => typeof item === "string")) {
        return { ok: false, reason: "expected every item to be a string" };
      }
      if (items.some((item) => item === "")) {
        return { ok: false, reason: "list contains an empty item" };
      }
      if (field.values) {
        const invalid = items.filter((item) => !field.values?.includes(item));
        if (invalid.length > 0) {
          return {
            ok: false,
            reason: `unknown value(s) ${invalid.join(", ")}; allowed: ${field.values.join(", ")}`,
          };
        }
      }
      return { ok: true, value: items };
    }

    case "enum": {
      if (typeof raw !== "string" || !field.values.includes(raw)) {
        return { ok: false, reason: `allowed values: ${field.values.join(", ")}` };
      }
      return { ok: true, value: raw };
    }
  }
}

/**
 * Stringify a rejected value for an error message without leaking a secret.
 *
 * A field whose env var name looks credential-bearing is redacted: a
 * malformed password should produce a useful error, not print the password
 * into a terminal or CI log (build plan §37.2).
 */
function describeReceived(field: FieldSpec, raw: unknown): string {
  const sensitive = /password|secret|token|credential|key/i;
  if (field.env !== undefined && sensitive.test(field.env)) return "(redacted)";
  if (sensitive.test(field.path)) return "(redacted)";
  if (typeof raw === "string") return JSON.stringify(raw);
  if (Array.isArray(raw)) return JSON.stringify(raw);
  return String(raw);
}

// --- Resolution ------------------------------------------------------------

/**
 * Resolve configuration from all sources.
 *
 * Collects every error rather than failing on the first, so a user fixes one
 * config file once instead of running the command repeatedly to discover the
 * next problem.
 */
export function loadConfig(input: LoadConfigInput): ConfigResult {
  const env = input.env ?? {};
  const cli = input.cli ?? {};

  let fileData = input.fileData;
  if (fileData === undefined && input.file !== undefined) {
    if (!existsSync(input.file)) {
      return {
        ok: false,
        errors: [
          {
            path: "(file)",
            source: "file",
            reason: `config file not found: ${input.file}`,
            received: input.file,
          },
        ],
      };
    }
    try {
      fileData = parseConfigFile(readFileSync(input.file, "utf8"), input.file);
    } catch (error) {
      return {
        ok: false,
        errors: [
          {
            path: "(file)",
            source: "file",
            reason: error instanceof Error ? error.message : "could not parse config file",
            received: input.file,
          },
        ],
      };
    }
  }

  const errors: ConfigError[] = [];
  const config: Record<string, unknown> = {};
  const origins = new Map<string, ResolvedValue>();

  for (const field of input.spec) {
    // Highest precedence first; the first candidate present wins.
    const candidates: readonly { source: ValueSource; raw: unknown }[] = [
      { source: "cli", raw: field.cli === undefined ? undefined : cli[field.cli] },
      { source: "env", raw: field.env === undefined ? undefined : env[field.env] },
      {
        source: "file",
        raw: fileData === undefined ? undefined : readPath(fileData, field.path),
      },
    ];

    const supplied = candidates.find((candidate) => candidate.raw !== undefined);

    if (supplied === undefined) {
      if (field.default !== undefined) {
        writePath(config, field.path, field.default);
      }
      origins.set(field.path, { value: field.default, source: "default" });
      continue;
    }

    const coerced = coerce(field, supplied.raw);
    if (!coerced.ok) {
      errors.push({
        path: field.path,
        source: supplied.source,
        reason: coerced.reason,
        received: describeReceived(field, supplied.raw),
      });
      continue;
    }

    writePath(config, field.path, coerced.value);
    origins.set(field.path, { value: coerced.value, source: supplied.source });
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, config, origins };
}

/** Human-readable rendering of a failed resolution, for the CLI. */
export function formatConfigErrors(errors: readonly ConfigError[]): string {
  const lines = errors.map(
    (error) =>
      `  ${error.path}\n      from ${error.source}: ${error.received}\n      ${error.reason}`,
  );
  const noun = errors.length === 1 ? "problem" : "problems";
  return `${errors.length} configuration ${noun}:\n\n${lines.join("\n\n")}\n`;
}
