/**
 * Command surface — build plan §30, §30.1.
 *
 * The command model carries the safety boundary, so `--help` is where a user
 * learns it:
 *
 *   `scan`  observes and analyses. It can never cause a browser action of its
 *           own choosing.
 *   `agent` decides, explores and analyses. It runs its own V1-V4 foundation
 *           first, then V5 exploration, then V6 reasoning.
 *
 * Commands that do not work yet say so and exit non-zero. A pre-release build
 * that accepts `scan` and silently does nothing is worse than one that refuses
 * — the user would conclude the tool is broken rather than unfinished.
 */
import { Command } from "commander";
import { CONFIG_SPEC } from "@browserrecon/config";
import { POLICY_SPEC } from "@browserrecon/policy";
import { EVENT_SCHEMA_VERSION, buildEventEnvelopeSchema } from "@browserrecon/events";
import { CliError, EXIT_CODES, EXIT_CODE_DESCRIPTIONS } from "./exit-codes.js";
import { addSpecOptions } from "./options.js";
import { configValidate } from "./commands/config.js";
import { doctor } from "./commands/doctor.js";
import { resume as resumeSession } from "./commands/resume.js";
import { scan as runScanCommand } from "./commands/scan.js";

/** Injected so tests capture output instead of writing to the terminal. */
export interface ProgramIo {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly version: string;
  /**
   * Ask a question and return the answer. Defaults to the terminal.
   *
   * Injected for the same reason `out` and `err` are: the §7.4 gate is the
   * one path in this tool that must not be testable only by hand, and it was
   * — which is how it shipped printing the question and exiting without
   * waiting for an answer.
   */
  readonly ask?: ((question: string) => Promise<string>) | undefined;
  /** Override the TTY check. Tests set this; nothing else should. */
  readonly interactive?: boolean | undefined;
}

/**
 * Ask a question on the terminal and wait for the answer.
 *
 * The §7.4 gate has always returned "ask the user this", and the CLI threw
 * the question as an error message instead — so the prompt appeared, the
 * process exited, and there was no way to answer it. The interactive path
 * described in the README, SECURITY.md and the runbook had never worked.
 *
 * Written against `node:readline/promises` rather than a dependency: one
 * question, once, on a path that must not acquire supply-chain surface.
 */
async function askOnTerminal(question: string): Promise<string> {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } catch {
    // Ctrl+D closes stdin, and `readline` reports that by rejecting. It is a
    // normal thing to type at a prompt and it plainly means no, so it is
    // answered as an empty line rather than crashing — which it did, with a
    // stack trace and "This is a bug", on a question about authorization.
    //
    // Anything else that fails here is answered the same way, and for the
    // same reason: the safe reading of "we could not get an answer" is that
    // we do not have one.
    return "";
  } finally {
    // Closing matters: an open readline keeps the event loop alive, and the
    // scan would finish and then hang with no output explaining why.
    rl.close();
  }
}

/** Milestone that delivers each unfinished command, for an honest message. */
const NOT_YET: Readonly<Record<string, string>> = {
  scan: "runtime collection is still being built",
  agent: "AI-guided exploration arrives after the deterministic scan works",
  resume: "resuming needs a scan to resume from",
  export: "exporting needs collected sessions to export",
  "auth list": "authentication profiles are not implemented yet",
  "auth validate": "authentication profiles are not implemented yet",
};

function notImplemented(name: string): never {
  throw new CliError(
    `\`browserrecon ${name}\` is not implemented in this pre-release build.`,
    EXIT_CODES.usage,
    `${NOT_YET[name] ?? "not implemented yet"}. Run \`browserrecon config validate\` to check your setup in the meantime.`,
  );
}

const EXIT_CODE_HELP = [
  "Exit codes:",
  ...Object.entries(EXIT_CODE_DESCRIPTIONS).map(([code, meaning]) => `  ${code}  ${meaning}`),
].join("\n");

export function buildProgram(io: ProgramIo, argv: readonly string[] = []): Command {
  const program = new Command();

  program
    .name("browserrecon")
    .description(
      "Browser runtime recon — captures how an application actually behaves in a real\n" +
        "browser and turns it into a structured attack-surface model.\n\n" +
        "scan  = observe and analyse; never causes a browser action of its own choosing.\n" +
        "agent = decide, explore and analyse; runs its own scan foundation first.",
    )
    .version(io.version, "-v, --version", "print the version and exit")
    .option("-c, --config <path>", "configuration file (YAML or JSON)")
    .option("-q, --quiet", "suppress the end-of-scan summary")
    .option("--json", "print the end-of-scan summary as JSON instead of text")
    .option(
      "--i-am-authorized",
      "assert you are permitted to test the target; required in CI, where there is no terminal to ask in",
    )
    .addHelpText("after", `\n${EXIT_CODE_HELP}\n`)
    .addHelpText(
      "after",
      "\nAuthorized use only. Only scan systems you own or have written permission to test.\n",
    )
    .showHelpAfterError("(run `browserrecon --help` for usage)")
    // Route commander's own output through the injected io, so tests capture
    // it and a caller can redirect it.
    .configureOutput({
      writeOut: (text) => io.out(text.replace(/\n$/, "")),
      writeErr: (text) => io.err(text.replace(/\n$/, "")),
    })
    // Commander exits 1 on a parse error; usage problems are code 2 here.
    // It has already written the message, hence `reported: true`.
    .exitOverride((error) => {
      if (error.code === "commander.helpDisplayed" || error.code === "commander.version") {
        throw error;
      }
      throw new CliError(error.message, EXIT_CODES.usage, undefined, true);
    });

  const scan = program
    .command("scan")
    .description("deterministic runtime reconnaissance (observe and analyse only)")
    .argument("<url>", "target origin to scan")
    .action(async (url: string, _options: unknown, command: Command) => {
      const top = program.opts();
      await runScanCommand({
        target: url,
        parsed: command.opts(),
        argv,
        env: io.env,
        configFile: top.config as string | undefined,
        quiet: top.quiet === true,
        json: top.json === true,
        authorized: top.iAmAuthorized === true,
        // A terminal the user is actually at. `isTTY` is the only honest
        // signal available, and getting it wrong in the permissive
        // direction means a CI job hangs on a prompt nobody sees.
        interactive:
          io.interactive ?? (process.stdin.isTTY === true && process.stdout.isTTY === true),
        ask: io.ask ?? askOnTerminal,
        write: io.out,
        warn: io.err,
      });
    });
  addSpecOptions(scan, CONFIG_SPEC);
  addSpecOptions(scan, POLICY_SPEC);

  const agent = program
    .command("agent")
    .description("AI-guided exploration and cross-workflow reasoning (runs its own scan first)")
    .argument("<url>", "target origin to scan")
    .action(() => notImplemented("agent"));
  addSpecOptions(agent, CONFIG_SPEC);
  addSpecOptions(agent, POLICY_SPEC);

  const resume = program
    .command("resume")
    .description("continue an interrupted or budget-exhausted scan")
    .argument("<session>", "session directory or id")
    .action((session: string, _options: unknown, command: Command) => {
      resumeSession({
        session,
        parsed: command.opts(),
        argv,
        env: io.env,
        configFile: program.opts().config as string | undefined,
        write: io.out,
      });
    });
  addSpecOptions(resume, CONFIG_SPEC);
  addSpecOptions(resume, POLICY_SPEC);

  program
    .command("export")
    .description("re-export a completed session in another format")
    .argument("<session>", "session directory or id")
    .action(() => notImplemented("export"));

  program
    .command("doctor")
    .description("check Chrome, crawler and local AI availability")
    .action(async () => {
      await doctor({
        env: io.env,
        configFile: program.opts().config as string | undefined,
        write: io.out,
      });
    });

  const auth = program.command("auth").description("manage authentication profiles");
  auth
    .command("list")
    .description("list configured profiles")
    .action(() => notImplemented("auth list"));
  auth
    .command("validate")
    .description("verify a profile can sign in")
    .argument("<profile>", "profile name")
    .action(() => notImplemented("auth validate"));

  const config = program.command("config").description("inspect configuration");
  const validate = config
    .command("validate")
    .description("resolve settings and show the boundary a scan would run inside")
    .argument("[url]", "target origin, to also resolve the Target Policy")
    .action((url: string | undefined, _options: unknown, command: Command) => {
      configValidate({
        parsed: command.opts(),
        argv,
        env: io.env,
        // The target arrives as a positional, so it is passed explicitly
        // rather than through the flag path — which only forwards flags the
        // user actually typed, and would drop it.
        targetOrigin: url,
        configFile: program.opts().config as string | undefined,
        write: io.out,
      });
    });
  addSpecOptions(validate, CONFIG_SPEC);
  addSpecOptions(validate, POLICY_SPEC);

  program
    .command("schema")
    .description("print the published JSON Schema for the event envelope")
    .action(() => {
      io.out(JSON.stringify(buildEventEnvelopeSchema(), null, 2));
    });

  program
    .command("version")
    .description("print version details")
    .action(() => {
      io.out(`browserrecon ${io.version}`);
      io.out(`event schema  ${EVENT_SCHEMA_VERSION}`);
      io.out(`node          ${process.version}`);
    });

  return program;
}
