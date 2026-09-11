/**
 * @browserrecon/cli — the browserrecon command.
 *
 * Public API only. Internals stay unexported; consumers may not deep-import
 * (enforced by eslint, dev plan §2.4).
 */

/** Package identity, used by diagnostics and the `doctor` command. */
export const PACKAGE_NAME = "@browserrecon/cli" as const;

export { run } from "./run.js";
export type { RunOptions } from "./run.js";

export { buildProgram } from "./program.js";
export type { ProgramIo } from "./program.js";

export { CliError, EXIT_CODES, EXIT_CODE_DESCRIPTIONS } from "./exit-codes.js";
export type { ExitCode } from "./exit-codes.js";

export { addSpecOptions, collectCliValues } from "./options.js";
