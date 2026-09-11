/**
 * `browserrecon config validate` — build plan §30.
 *
 * Answers the question a user actually has before pointing this at anything:
 * *what will it do?* Resolved settings, where each value came from, the
 * boundary the scan would run inside, and the arithmetic on the budgets.
 *
 * The effective-budget line exists because §8.3 requires it: interacting
 * limits cannot be reasoned about in your head, and an earlier draft of the
 * plan shipped a page budget unreachable by ~70x precisely because nobody had
 * multiplied it out.
 */
import { CONFIG_SPEC, formatConfigErrors, loadConfig } from "@browserrecon/config";
import {
  POLICY_SPEC,
  computeEffectiveBudget,
  elevatedRisks,
  resolveTargetPolicy,
  type RateProfile,
  type ThoroughnessLevel,
} from "@browserrecon/policy";
import { CliError, EXIT_CODES } from "../exit-codes.js";
import { collectCliValues } from "../options.js";

export interface ConfigValidateInput {
  readonly parsed: Readonly<Record<string, unknown>>;
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Target given as a positional argument, not a flag. */
  readonly targetOrigin?: string | undefined;
  readonly configFile?: string | undefined;
  readonly write: (line: string) => void;
}

const FULL_SPEC = [...CONFIG_SPEC, ...POLICY_SPEC];

export function configValidate(input: ConfigValidateInput): void {
  const cli = collectCliValues(FULL_SPEC, input.parsed, input.argv);
  if (input.targetOrigin !== undefined) cli.target = input.targetOrigin;

  const resolved = loadConfig({
    spec: FULL_SPEC,
    file: input.configFile,
    env: input.env,
    cli,
  });

  if (!resolved.ok) {
    throw new CliError(
      formatConfigErrors(resolved.errors),
      EXIT_CODES.configuration,
      "Fix the settings above, or run with --help to see accepted values.",
    );
  }

  const { config, origins } = resolved;
  input.write("Configuration is valid.\n");

  // Only non-default values are listed. A dump of every setting buries the
  // three lines that actually differ from the defaults.
  const changed = [...origins.entries()].filter(([, value]) => value.source !== "default");
  if (changed.length === 0) {
    input.write("All settings are at their defaults.");
  } else {
    input.write("Settings that are not at their default:");
    for (const [path, value] of changed) {
      const shown = Array.isArray(value.value) ? value.value.join(",") : String(value.value);
      input.write(`  ${path} = ${shown}   (from ${value.source})`);
    }
  }

  const target = (config.target as { origin?: string } | undefined)?.origin;
  if (target === undefined) {
    input.write("");
    input.write("No target given, so the Target Policy was not resolved.");
    input.write("Pass a URL to see the boundary a scan would run inside.");
    return;
  }

  const policyResult = resolveTargetPolicy({
    targetOrigin: target,
    rateProfile: (config.rate as { profile?: RateProfile } | undefined)?.profile,
    thoroughnessLevel: (config.thoroughness as { level?: ThoroughnessLevel } | undefined)
      ?.level,
    config,
  });

  if (!policyResult.ok) {
    throw new CliError(
      policyResult.violations.map((v) => `  ${v.field}: ${v.reason}`).join("\n"),
      EXIT_CODES.configuration,
    );
  }

  const policy = policyResult.policy;
  const budget = computeEffectiveBudget(policy.limits);

  input.write("");
  input.write(`Target policy for ${policy.targetOrigin}`);
  input.write(`  origins allowed   ${policy.allowedOrigins.join(", ")}`);
  input.write(`  methods allowed   ${policy.allowedMethods.join(", ")}`);
  input.write(`  paths excluded    ${policy.excludedPaths.length} entries`);
  input.write(
    `  network           loopback ${policy.network.denyLoopback ? "denied" : "ALLOWED"}, ` +
      `private ${policy.network.denyPrivateRanges ? "denied" : "ALLOWED"}, ` +
      `external redirects ${policy.network.followExternalRedirects ? "FOLLOWED" : "not followed"}`,
  );

  input.write("");
  input.write("Budget");
  input.write(
    `  rate              ${policy.limits.maxRequestsPerSecond}/s, ` +
      `concurrency ${policy.limits.maxConcurrency}`,
  );
  input.write(
    `  limits            ${policy.limits.maxPages} pages, ` +
      `${policy.limits.maxRuntimeMinutes} minutes`,
  );
  input.write(`  effective         ~${budget.effectivePages} pages (${budget.binding}-bound)`);
  if (budget.maxPagesUnreachable) {
    input.write(
      `  NOTE              max_pages ${policy.limits.maxPages} cannot be reached at this rate; ` +
        `raise the timeout or the rate profile.`,
    );
  }

  const risks = elevatedRisks(policy);
  if (risks.length > 0) {
    input.write("");
    input.write(`${risks.length} higher-risk setting(s) enabled:`);
    for (const risk of risks) {
      input.write(`  ${risk.setting}`);
      input.write(`      ${risk.consequence}`);
    }
  }
}
