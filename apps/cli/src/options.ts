/**
 * CLI flags, generated from the configuration specs.
 *
 * Every flag already exists as a declared field with a type, a default and a
 * description (`CONFIG_SPEC`, `POLICY_SPEC`). Hand-writing a second list here
 * would create two sources of truth that drift — a flag that quietly stops
 * mapping to anything, or a setting reachable from a file but not the command
 * line for no reason anyone remembers.
 *
 * So flags are derived. Adding a setting to a spec gives it a flag
 * automatically, with matching help text.
 */
import type { Command } from "commander";
import type { ConfigSpec, FieldSpec } from "@browserrecon/config";

/** Describe a field's accepted values, for `--help`. */
function describe(field: FieldSpec): string {
  const parts = [field.describe];

  if (field.kind === "enum") {
    parts.push(`(${field.values.join(" | ")})`);
  } else if (field.kind === "list" && field.values) {
    parts.push(`(comma-separated: ${field.values.join(", ")})`);
  }

  if (field.default !== undefined && field.default !== "") {
    const shown = Array.isArray(field.default)
      ? field.default.join(",")
      : String(field.default);
    // A numeric 0 means "take the profile's value" (§8.3), which is more
    // useful to show than the literal zero.
    if (field.kind === "number" && field.default === 0) {
      parts.push("[default: from rate profile]");
    } else {
      parts.push(`[default: ${shown}]`);
    }
  }

  return parts.join(" ");
}

/**
 * Add a spec's fields to a command as options.
 *
 * Booleans become `--flag` / `--no-flag` so a setting enabled by default can
 * be switched off from the command line — without it, `--katana` would be
 * meaningless since it is already on.
 */
export function addSpecOptions(command: Command, spec: ConfigSpec): Command {
  for (const field of spec) {
    if (field.cli === undefined) continue;

    if (field.kind === "boolean") {
      command.option(`--${field.cli}`, describe(field));
      command.option(`--no-${field.cli}`, `disable --${field.cli}`);
      continue;
    }

    const placeholder = field.kind === "list" ? "<items>" : `<${field.kind}>`;
    command.option(`--${field.cli} ${placeholder}`, describe(field));
  }
  return command;
}

/**
 * Turn commander's parsed options into the shape `loadConfig` expects.
 *
 * Commander normalizes `--rate-profile` to `rateProfile`, while the spec keys
 * on the flag name, so this maps back. Only flags the user actually passed
 * are forwarded: commander fills booleans with defaults, and treating those as
 * explicit input would make a flag nobody typed outrank the config file.
 */
export function collectCliValues(
  spec: ConfigSpec,
  parsed: Readonly<Record<string, unknown>>,
  argv: readonly string[],
): Record<string, string | boolean> {
  const supplied: Record<string, string | boolean> = {};

  for (const field of spec) {
    if (field.cli === undefined) continue;

    const camel = field.cli.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
    const value = parsed[camel];
    if (value === undefined) continue;

    // Commander cannot distinguish "false by default" from "--no-x was typed",
    // so the argv is the authority on whether the user said anything.
    const mentioned =
      argv.includes(`--${field.cli}`) ||
      argv.includes(`--no-${field.cli}`) ||
      argv.some((arg) => arg.startsWith(`--${field.cli}=`));
    if (!mentioned) continue;

    supplied[field.cli] = typeof value === "boolean" ? value : String(value);
  }

  return supplied;
}
