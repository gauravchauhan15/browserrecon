/**
 * The entry point's error boundary.
 *
 * One place decides what the process exits with, so a failure anywhere maps to
 * an accurate code (see exit-codes.ts) rather than whatever bubbled up. An
 * unexpected throw is reported as an internal error and not disguised as a
 * user mistake — a stack trace the user cannot act on is still better than a
 * misleading "usage error" that sends them to re-read `--help`.
 */
import { CliError, EXIT_CODES, type ExitCode } from "./exit-codes.js";
import { buildProgram, type ProgramIo } from "./program.js";

export interface RunOptions {
  readonly argv: readonly string[];
  readonly io: ProgramIo;
}

export async function run(options: RunOptions): Promise<ExitCode> {
  const program = buildProgram(options.io, options.argv);

  try {
    await program.parseAsync([...options.argv], { from: "user" });
    return EXIT_CODES.success;
  } catch (thrown) {
    // Commander throws for --help and --version, which are successful
    // outcomes rather than failures.
    const code = (thrown as { code?: string }).code;
    if (code === "commander.helpDisplayed" || code === "commander.version") {
      return EXIT_CODES.success;
    }

    if (thrown instanceof CliError) {
      // Commander already wrote its own parse errors; printing again would
      // show the user the same line twice.
      if (!thrown.reported) options.io.err(thrown.message);
      if (thrown.hint !== undefined) {
        options.io.err("");
        options.io.err(thrown.hint);
      }
      return thrown.code;
    }

    const error = thrown instanceof Error ? thrown : new Error(String(thrown));
    options.io.err(`Internal error: ${error.message}`);
    if (error.stack !== undefined) options.io.err(error.stack);
    options.io.err("");
    options.io.err(
      "This is a bug. Please report it at " +
        "https://github.com/gauravchauhan15/browserrecon/issues — and redact any " +
        "target names or credentials before posting.",
    );
    return EXIT_CODES.internal;
  }
}
