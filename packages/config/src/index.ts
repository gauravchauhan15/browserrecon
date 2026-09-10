/**
 * @browserrecon/config — Configuration loading and validation — the only reader of process.env
 *
 * Public API only. Internals stay unexported; consumers may not deep-import
 * (enforced by eslint, dev plan §2.4).
 */

/** Package identity, used by diagnostics and the `doctor` command. */
export const PACKAGE_NAME = "@browserrecon/config" as const;

export { formatConfigErrors, loadConfig, parseConfigFile } from "./load.js";
export type { ConfigError, ConfigResult, LoadConfigInput, ResolvedValue } from "./load.js";

export { bool, list, num, oneOf, str, VALUE_SOURCES } from "./spec.js";
export type {
  BooleanField,
  ConfigSpec,
  EnumField,
  FieldSpec,
  ListField,
  NumberField,
  StringField,
  ValueSource,
} from "./spec.js";

export {
  CONFIG_SPEC,
  LOG_LEVELS,
  MODEL_TIERS,
  OUTPUT_FORMATS,
  RATE_PROFILES,
  THOROUGHNESS_LEVELS,
  renderDefaultsTable,
} from "./schema.js";
