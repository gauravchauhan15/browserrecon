/**
 * `browserrecon resume` — build plan §30; dev plan BR-M1-29.
 *
 * The command is mostly a gate. §30's semantics table says budget and
 * thoroughness may be raised and scope, methods and identity may not, and
 * the reason the refusal matters more than the convenience is in
 * `@browserrecon/orchestrator`'s `resume.ts`: a session produces one
 * coverage report, and a report stitched from two different boundaries is
 * one someone will act on.
 *
 * So this command resolves the new settings, compares them against the
 * session's recorded policy, and either refuses with something the user can
 * act on or reports exactly what continuing would do.
 */
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { CONFIG_SPEC, formatConfigErrors, loadConfig } from "@browserrecon/config";
import {
  POLICY_SPEC,
  resolveTargetPolicy,
  type RateProfile,
  type ThoroughnessLevel,
} from "@browserrecon/policy";
import { LAYOUT } from "@browserrecon/event-store";
import { decideResume, parseSessionFile, type SessionFile } from "@browserrecon/orchestrator";
import { CliError, EXIT_CODES } from "../exit-codes.js";
import { collectCliValues } from "../options.js";

/**
 * The settings the resume digest covers, derived from a resolved policy.
 *
 * Exported and used by *both* the scan that writes `session.json` and the
 * resume that checks it. Two derivations of the same summary is the bug
 * that makes the gate fire on an identical policy — and a gate that refuses
 * legitimate resumes teaches users to reach for `--seed-from` when they did
 * not need to, which costs them the continuity they wanted.
 */
export function policySummaryFor(
  policy: {
    readonly targetOrigin: string;
    readonly allowedOrigins: readonly string[];
    readonly allowedMethods: readonly string[];
    readonly excludedPaths: readonly string[];
    readonly network: {
      readonly denyLoopback: boolean;
      readonly denyPrivateRanges: boolean;
      readonly followExternalRedirects: boolean;
    };
    readonly limits: { readonly maxPages: number; readonly maxRuntimeMinutes: number };
  },
  authProfile: string,
): Record<string, string> {
  return {
    target: policy.targetOrigin,
    allowedOrigins: [...policy.allowedOrigins].join(","),
    allowedMethods: [...policy.allowedMethods].join(","),
    excludedPaths: [...policy.excludedPaths].join(","),
    authProfile,
    denyLoopback: String(policy.network.denyLoopback),
    denyPrivateRanges: String(policy.network.denyPrivateRanges),
    followExternalRedirects: String(policy.network.followExternalRedirects),
    // Not covered by the digest — recorded so a resume knows what to
    // compare a raise against.
    maxPages: String(policy.limits.maxPages),
    maxRuntimeMinutes: String(policy.limits.maxRuntimeMinutes),
  };
}

export interface ResumeInput {
  readonly session: string;
  readonly parsed: Readonly<Record<string, unknown>>;
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly configFile?: string | undefined;
  readonly outputRoot?: string | undefined;
  readonly now?: Date | undefined;
  readonly write: (line: string) => void;
}

const FULL_SPEC = [...CONFIG_SPEC, ...POLICY_SPEC];

/** Accept a directory or a bare session id, because users type both. */
export function resolveSessionDir(session: string, outputRoot: string): string {
  if (session.includes("/") || isAbsolute(session)) return session;
  return join(outputRoot, session);
}

export function readSession(dir: string): SessionFile {
  const path = join(dir, LAYOUT.session);
  if (!existsSync(path)) {
    throw new CliError(
      `No session found at ${dir}.`,
      EXIT_CODES.configuration,
      `Expected ${LAYOUT.session} in that directory. Pass the session directory, or the session id if it is under your output directory.`,
    );
  }

  const parsed = parseSessionFile(readFileSync(path, "utf8"));
  if ("error" in parsed) {
    throw new CliError(
      parsed.error,
      EXIT_CODES.configuration,
      // Deliberately not "delete it and re-run": the directory holds the
      // event log, which is the evidence. A broken session.json is
      // recoverable; a deleted log is not.
      `The event log in ${dir} is unaffected and can still be exported.`,
    );
  }
  return parsed;
}

export function resume(input: ResumeInput): void {
  const cli = collectCliValues(FULL_SPEC, input.parsed, input.argv);

  // Where to look for the session, resolved the same way a scan resolves
  // where to write one — `--out`, then the environment, then the config
  // file, then the default.
  //
  // This used to be `input.outputRoot ?? ".output"`, and nothing ever passed
  // `outputRoot`, so `--out` was accepted and ignored: `resume` looked in
  // `.output` whatever the user said. The settings are resolved below for
  // the boundary digest, but that happens *after* the session has to be
  // found, which is why a first pass is needed. It runs without a target,
  // because the target comes from the session that has not been read yet.
  const forPaths = loadConfig({ spec: FULL_SPEC, file: input.configFile, env: input.env, cli });
  const configuredRoot = forPaths.ok
    ? ((forPaths.config.output as { dir?: string } | undefined)?.dir ?? ".output")
    : ".output";

  const dir = resolveSessionDir(input.session, input.outputRoot ?? configuredRoot);
  const prior = readSession(dir);
  // The target is not a flag on `resume` — it comes from the session, and
  // taking it from anywhere else is how the boundary would change silently.
  cli.target = prior.target;

  const resolved = loadConfig({ spec: FULL_SPEC, file: input.configFile, env: input.env, cli });
  if (!resolved.ok) {
    throw new CliError(
      formatConfigErrors(resolved.errors),
      EXIT_CODES.configuration,
      "Fix the settings above, or run with --help to see accepted values.",
    );
  }

  const policyResult = resolveTargetPolicy({
    targetOrigin: prior.target,
    rateProfile: (resolved.config.rate as { profile?: RateProfile } | undefined)?.profile,
    thoroughnessLevel: (
      resolved.config.thoroughness as { level?: ThoroughnessLevel } | undefined
    )?.level,
    config: resolved.config,
  });
  if (!policyResult.ok) {
    throw new CliError(
      policyResult.violations.map((v) => `  ${v.field}: ${v.reason}`).join("\n"),
      EXIT_CODES.configuration,
    );
  }

  const policy = policyResult.policy;
  const decision = decideResume({
    prior,
    policySummary: policySummaryFor(
      policy,
      (resolved.config.auth as { profile?: string } | undefined)?.profile ?? "",
    ),
    priorBudget: {
      maxPages: Number(prior.policySummary.maxPages ?? policy.limits.maxPages),
      maxRuntimeMinutes: Number(
        prior.policySummary.maxRuntimeMinutes ?? policy.limits.maxRuntimeMinutes,
      ),
    },
    budget: {
      maxPages: policy.limits.maxPages,
      maxRuntimeMinutes: policy.limits.maxRuntimeMinutes,
    },
    now: input.now ?? new Date(),
  });

  if (!decision.allowed) {
    // Policy, not configuration: the settings are individually valid and
    // the scan is being refused on scope grounds, which is what code 5
    // means to a pipeline.
    throw new CliError(decision.message, EXIT_CODES.policy);
  }

  input.write(`Session ${prior.sessionId} (${prior.target})`);
  input.write(
    `  previous run    ${prior.completeness}${prior.stopReason === undefined ? "" : ` (${prior.stopReason})`}`,
  );
  input.write(`  events so far   up to sequence ${prior.segments.at(-1)?.lastSequence ?? 0}`);
  input.write("");

  if (decision.extensions.length > 0) {
    input.write("Budget extended for this run:");
    for (const extension of decision.extensions) {
      input.write(`  ${extension.field}   ${extension.from} -> ${extension.to}`);
    }
    input.write("");
  }

  for (const warning of decision.warnings) {
    input.write(`Warning: ${warning}`);
  }
  if (decision.warnings.length > 0) input.write("");

  // The gate passes; the engine behind it does not exist yet. Saying so is
  // better than printing "resuming…" and doing nothing.
  throw new CliError(
    "`browserrecon resume` cannot continue the scan in this pre-release build.",
    EXIT_CODES.usage,
    "The session was validated and could be resumed safely; the scan engine lands with the V1 fixture gate.",
  );
}
