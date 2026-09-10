/**
 * BrowserRecon's configuration surface.
 *
 * Scope note: this covers settings that are *not* Target Policy. Policy —
 * allowed origins, methods, limits, agent permissions (build plan §7.2) — is
 * a safety boundary with its own validation and defaults, and is declared by
 * `packages/policy` (BR-M0-05) which appends to this spec. Keeping them apart
 * means a change to a convenience setting can never quietly widen a scope
 * restriction.
 */
import { bool, list, num, oneOf, str, type ConfigSpec } from "./spec.js";

/** Output formats the exporters can produce (build plan §35). */
export const OUTPUT_FORMATS = ["json", "jsonl", "md"] as const;

/** Log verbosity (build plan §33). */
export const LOG_LEVELS = ["silent", "error", "warn", "info", "debug"] as const;

/**
 * Politeness profiles (build plan §8.3). Deliberately separate from
 * thoroughness: fusing them makes "gentle but thorough" — the obvious setting
 * for your own staging environment — inexpressible.
 */
export const RATE_PROFILES = ["polite", "normal", "aggressive"] as const;

/** Exploration depth (build plan §8.3). Independent of rate. */
export const THOROUGHNESS_LEVELS = ["shallow", "normal", "deep"] as const;

/** Local model tiers (build plan §25.1). Resolved to a model name by the AI provider. */
export const MODEL_TIERS = ["small", "standard", "large"] as const;

export const CONFIG_SPEC: ConfigSpec = [
  // --- Target ---------------------------------------------------------------
  str("target.origin", "Origin to scan. Normally given as the command's argument.", {
    cli: "target",
    pattern: /^https?:\/\/[^\s/]+/,
  }),

  // --- Output ---------------------------------------------------------------
  str("output.dir", "Directory for scan artifacts. Contains UNREDACTED data (§37.2).", {
    default: ".output",
    env: "BROWSERRECON_OUTPUT_DIR",
    cli: "out",
  }),
  list("output.formats", "Artifacts to write.", {
    default: ["json", "jsonl", "md"],
    values: OUTPUT_FORMATS,
    cli: "format",
  }),
  bool("output.redact", "Redact secrets in reports and exports. The event store stays raw.", {
    default: true,
    env: "BROWSERRECON_REDACT",
  }),

  // --- Diagnostics ----------------------------------------------------------
  oneOf("log.level", "Diagnostic verbosity. Distinct from the event log.", {
    values: LOG_LEVELS,
    default: "info",
    env: "BROWSERRECON_LOG_LEVEL",
    cli: "log-level",
  }),

  // --- Pace and depth (two independent axes, §8.3) --------------------------
  oneOf("rate.profile", "How hard to hit the target. This is the safety dial.", {
    values: RATE_PROFILES,
    default: "normal",
    env: "BROWSERRECON_RATE_PROFILE",
    cli: "rate-profile",
  }),
  oneOf("thoroughness.level", "How completely to explore. Does not affect request rate.", {
    values: THOROUGHNESS_LEVELS,
    default: "normal",
    cli: "thoroughness",
  }),
  num("thoroughness.instancesPerTemplate", "Instances sampled per route template (§9.5.3).", {
    default: 3,
    min: 1,
    max: 100,
    integer: true,
  }),
  num(
    "thoroughness.divergenceSampleCap",
    "Cap on extra sampling when instances diverge (§9.5.3).",
    {
      default: 10,
      min: 1,
      max: 500,
      integer: true,
    },
  ),

  // --- Browser --------------------------------------------------------------
  bool("browser.headless", "Run Chrome headless. Headed is often less bot-detected (§10C.7).", {
    default: true,
    cli: "headless",
  }),
  str("browser.executablePath", "Chrome/Chromium binary. Auto-detected when unset.", {
    env: "BROWSERRECON_CHROME_PATH",
  }),

  // --- Discovery ------------------------------------------------------------
  bool("discovery.katana", "Use Katana when present on PATH. Never required (§10D.1).", {
    default: true,
    cli: "katana",
  }),
  str("discovery.importUrls", 'URL list from any crawler; "-" reads stdin (§10D.1).', {
    cli: "import-urls",
  }),
  bool("discovery.robots", "Read robots.txt as a discovery source and a rate floor (§8.3).", {
    default: true,
  }),
  bool("discovery.sitemap", "Read sitemap.xml as a discovery source.", { default: true }),
  bool("discovery.probeLiveness", "Probe unobserved candidates with HEAD/OPTIONS (§10C.7).", {
    default: false,
    cli: "probe-liveness",
  }),

  // --- Local AI (all optional; V1-V3 never touch these, §25.4) --------------
  bool("ai.enabled", "Enable local AI interpretation (V4).", { default: false, cli: "ai" }),
  oneOf("ai.tier", "Model tier when no explicit model is given (§25.1).", {
    values: MODEL_TIERS,
    default: "standard",
  }),
  str("ai.model", "Explicit model name. Overrides the tier.", {
    env: "BROWSERRECON_AI_MODEL",
    cli: "model",
  }),
  str("ai.endpoint", "OpenAI-compatible base URL. Unset means local Ollama (§25.1).", {
    env: "BROWSERRECON_AI_ENDPOINT",
    cli: "ai-endpoint",
  }),

  // --- Session --------------------------------------------------------------
  str("session.resumeFrom", "Session id to resume (§30).", { cli: "resume-from" }),
  str("session.seedFrom", "Session id whose candidate registry seeds a new scan (§30).", {
    cli: "seed-from",
  }),
];

/**
 * Render the defaults as a Markdown table.
 *
 * Generated rather than hand-written so the README cannot drift from the
 * declared behaviour — BR-M0-04 requires documented defaults, and a
 * documentation table that is maintained separately is a documentation table
 * that is eventually wrong.
 */
export function renderDefaultsTable(spec: ConfigSpec = CONFIG_SPEC): string {
  const rows = spec.map((field) => {
    const shown =
      field.default === undefined
        ? "_(unset)_"
        : Array.isArray(field.default)
          ? `\`${field.default.join(", ")}\``
          : `\`${String(field.default)}\``;
    const allowed =
      field.kind === "enum"
        ? `\`${field.values.join("\` \`")}\``
        : field.kind === "list" && field.values
          ? `\`${field.values.join("\` \`")}\``
          : "";
    return `| \`${field.path}\` | ${shown} | ${field.env ? `\`${field.env}\`` : ""} | ${
      field.cli ? `\`--${field.cli}\`` : ""
    } | ${allowed} | ${field.describe} |`;
  });

  return [
    "| Setting | Default | Env | Flag | Allowed | Description |",
    "| --- | --- | --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
}
