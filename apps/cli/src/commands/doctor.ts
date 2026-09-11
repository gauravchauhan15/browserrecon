/**
 * `browserrecon doctor` — build plan §25.1, §25.2, §30; dev plan BR-M0-12.
 *
 * Answers "will this work on my machine, and what will I be missing?" before a
 * user finds out halfway through a scan.
 *
 * ## Required versus optional is the whole design
 *
 * Most dependency checkers treat anything missing as a failure. That would be
 * wrong here, because the tool is deliberately built so a bare
 * `browserrecon scan <url>` works with nothing beyond Node and Chrome (§10D.1,
 * §25.4). Katana and Ollama each *add* capability; their absence narrows what
 * a scan can do. Calling that a failure would push users into installing
 * things they may not need, or into concluding the tool is broken.
 *
 * So a check reports one of three outcomes:
 *
 *   ok          present and usable
 *   limitation  absent or degraded; scanning still works, minus something
 *   blocker     nothing will work until this is fixed
 *
 * Only a blocker exits non-zero.
 *
 * ## It never downloads anything
 *
 * §25.2 is explicit. Doctor inspects; it does not install. Listing Ollama's
 * models is a local HTTP request; pulling one is a multi-gigabyte download that
 * stays the user's deliberate act, so the pull command is printed, never run.
 */
import { spawnSync } from "node:child_process";
import { existsSync, statfsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { platform } from "node:os";
import { CONFIG_SPEC, MODEL_TIERS, loadConfig } from "@browserrecon/config";
import { CliError, EXIT_CODES } from "../exit-codes.js";

export type CheckStatus = "ok" | "limitation" | "blocker";

export interface CheckResult {
  readonly name: string;
  readonly status: CheckStatus;
  /** Version, path, or whatever identifies what was found. */
  readonly detail?: string | undefined;
  /** What is unavailable without it. Only meaningful for a non-ok result. */
  readonly impact?: string | undefined;
  /** How to fix it. Printed for the user to run; never run here. */
  readonly remedy?: string | undefined;
}

/**
 * Everything doctor touches outside its own process.
 *
 * Injected so the detection logic can be tested without installing or
 * uninstalling anything — the interesting cases are the ones this machine
 * happens not to be in.
 */
export interface Probes {
  /** Run a command and capture its output, or undefined if it cannot run. */
  readonly runCommand: (
    command: string,
    args: readonly string[],
  ) => { readonly stdout: string } | undefined;
  readonly fileExists: (path: string) => boolean;
  /** GET a local URL and parse JSON, for the Ollama service check. */
  readonly httpGetJson: (url: string) => Promise<unknown>;
  /** Free bytes on the filesystem holding a path. */
  readonly freeDiskBytes: (path: string) => number | undefined;
  readonly nodeVersion: string;
  readonly platform: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

/** Matches the `engines` field. Below this, nothing is expected to run. */
const MIN_NODE_MAJOR = 22;

/** Below this a scan is likely to die partway rather than finish. */
const MIN_FREE_DISK_BYTES = 2 * 1024 * 1024 * 1024;

const DEFAULT_OLLAMA_HOST = "http://127.0.0.1:11434";

/**
 * Where Chrome usually lives, by platform.
 *
 * Checked before `PATH` because on macOS the app bundle is the normal install
 * and puts nothing on `PATH` — a `which` lookup alone would report "missing"
 * on a machine that plainly has Chrome.
 */
const CHROME_PATHS: Readonly<Record<string, readonly string[]>> = {
  darwin: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ],
  win32: [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ],
  linux: [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
  ],
};

const CHROME_COMMANDS = [
  "google-chrome",
  "google-chrome-stable",
  "chromium",
  "chromium-browser",
];

/** §25.1: tier names are conveniences that resolve to a default model. */
export const TIER_MODELS: Readonly<Record<(typeof MODEL_TIERS)[number], string>> = {
  small: "qwen3:4b",
  standard: "qwen3:8b",
  large: "qwen3:14b",
};

const TIER_SIZES: Readonly<Record<(typeof MODEL_TIERS)[number], string>> = {
  small: "~2.5 GB",
  standard: "~5-6 GB",
  large: "~9.3 GB",
};

function firstLine(text: string): string {
  return text.trim().split("\n")[0]?.trim() ?? "";
}

function checkNode(probes: Probes): CheckResult {
  const major = Number(probes.nodeVersion.replace(/^v/, "").split(".")[0]);

  if (!Number.isFinite(major) || major < MIN_NODE_MAJOR) {
    return {
      name: "Node.js",
      status: "blocker",
      detail: probes.nodeVersion,
      impact: "Nothing will run.",
      remedy: `Install Node ${MIN_NODE_MAJOR} or newer — https://nodejs.org`,
    };
  }
  return { name: "Node.js", status: "ok", detail: probes.nodeVersion };
}

function checkChrome(probes: Probes): CheckResult {
  // `browser.executablePath`, §25: an explicit choice outranks detection.
  const configured = probes.env.BROWSERRECON_CHROME_PATH;

  if (configured !== undefined && configured !== "") {
    if (!probes.fileExists(configured)) {
      return {
        name: "Chrome",
        status: "blocker",
        detail: "configured path does not exist",
        impact:
          "BrowserRecon observes a real browser; without one there is nothing to observe.",
        // Not falling back to a detected Chrome: the user asked for a specific
        // binary, and quietly using a different one would make every
        // observation describe a browser they did not choose.
        remedy: `BROWSERRECON_CHROME_PATH points at ${configured}. Fix it, or unset it to auto-detect.`,
      };
    }
    const version = probes.runCommand(configured, ["--version"]);
    return {
      name: "Chrome",
      status: "ok",
      detail: `${firstLine(version?.stdout ?? "") || "version unknown"} (configured)`,
    };
  }

  for (const path of CHROME_PATHS[probes.platform] ?? []) {
    if (!probes.fileExists(path)) continue;
    const version = probes.runCommand(path, ["--version"]);
    return {
      name: "Chrome",
      status: "ok",
      detail: `${firstLine(version?.stdout ?? "") || "version unknown"} — ${path}`,
    };
  }

  for (const command of CHROME_COMMANDS) {
    const version = probes.runCommand(command, ["--version"]);
    if (version !== undefined) {
      return {
        name: "Chrome",
        status: "ok",
        detail: `${firstLine(version.stdout) || "version unknown"} — on PATH`,
      };
    }
  }

  return {
    name: "Chrome",
    status: "blocker",
    detail: "not found",
    impact: "BrowserRecon observes a real browser; without one there is nothing to observe.",
    remedy:
      "Install Chrome or Chromium, or set BROWSERRECON_CHROME_PATH to an existing binary. " +
      "https://www.google.com/chrome",
  };
}

function checkKatana(probes: Probes): CheckResult {
  const version = probes.runCommand("katana", ["-version"]);
  if (version !== undefined) {
    return {
      name: "Katana",
      status: "ok",
      detail: firstLine(version.stdout) || "installed",
    };
  }

  return {
    name: "Katana",
    status: "limitation",
    detail: "not on PATH",
    impact:
      "Breadth discovery is unavailable. Browser-native discovery — DOM links, JS mining, " +
      "robots.txt, sitemap.xml — is unaffected, and any crawler's URL list can be supplied " +
      "with --import-urls.",
    remedy: "go install github.com/projectdiscovery/katana/cmd/katana@latest",
  };
}

/** Model names Ollama reports. */
function listInstalledModels(tags: unknown): string[] {
  const models = (tags as { models?: unknown }).models;
  if (!Array.isArray(models)) return [];
  return models.flatMap((model: unknown) => {
    const name = (model as { name?: unknown }).name;
    return typeof name === "string" ? [name] : [];
  });
}

/**
 * Ollama and the local model, reported as two checks.
 *
 * They fail independently and are fixed differently: a stopped service is one
 * command away, a missing model is a download. Collapsing them into a single
 * "AI unavailable" line would hide which of the two the user needs to act on.
 */
async function checkAi(probes: Probes): Promise<CheckResult[]> {
  const endpoint = probes.env.BROWSERRECON_AI_ENDPOINT;
  if (endpoint !== undefined && endpoint !== "") {
    return [
      {
        name: "AI runtime",
        status: "ok",
        // Deliberately not probed. It is a remote host the user configured;
        // doctor is a local inspection and should not make an outbound request
        // to a third party just to print a checkmark.
        detail: `external endpoint ${endpoint} (not probed)`,
      },
    ];
  }

  const binary = probes.runCommand("ollama", ["--version"]);
  const host = probes.env.OLLAMA_HOST ?? DEFAULT_OLLAMA_HOST;
  const tags = await probes.httpGetJson(`${host.replace(/\/$/, "")}/api/tags`);

  if (binary === undefined && tags === undefined) {
    return [
      {
        name: "Ollama",
        status: "limitation",
        detail: "not installed",
        impact:
          "AI interpretation (--ai) and AI-guided exploration (agent) are unavailable. " +
          "Deterministic scanning is unaffected.",
        remedy:
          "https://ollama.com/download — or point --ai-endpoint at any OpenAI-compatible server",
      },
    ];
  }

  if (tags === undefined) {
    return [
      {
        name: "Ollama",
        status: "limitation",
        detail: `${firstLine(binary?.stdout ?? "") || "installed"}, not responding at ${host}`,
        impact: "AI features need the local service running.",
        remedy: "ollama serve",
      },
    ];
  }

  const service: CheckResult = {
    name: "Ollama",
    status: "ok",
    detail: `${firstLine(binary?.stdout ?? "") || "service"} responding at ${host}`,
  };

  const installed = listInstalledModels(tags);
  const tiers = MODEL_TIERS.filter((tier) =>
    installed.some(
      (name) => name === TIER_MODELS[tier] || name.startsWith(`${TIER_MODELS[tier]}-`),
    ),
  );

  if (tiers.length > 0) {
    return [
      service,
      {
        name: "Local model",
        status: "ok",
        detail: tiers.map((tier) => `${TIER_MODELS[tier]} (${tier} tier)`).join(", "),
      },
    ];
  }

  return [
    service,
    {
      name: "Local model",
      status: "limitation",
      detail:
        installed.length === 0
          ? "no models installed"
          : `no tier model installed (${installed.length} other model(s) present)`,
      impact:
        `AI features need a model. The default tier is ${TIER_MODELS.standard} ` +
        `(${TIER_SIZES.standard}); ${TIER_MODELS.small} (${TIER_SIZES.small}) suits a modest ` +
        `machine and ${TIER_MODELS.large} (${TIER_SIZES.large}) the best quality. ` +
        "Any other model works via --model.",
      // One copy-pasteable command, printed for the user to run. §25.2 forbids
      // doctor triggering the pull itself.
      remedy: `ollama pull ${TIER_MODELS.standard}`,
    },
  ];
}

/**
 * Nearest existing ancestor of a path.
 *
 * The output directory usually does not exist yet on a first run, and asking
 * for free space on a path that is not there fails — which would report "could
 * not be determined" on every fresh install.
 */
function nearestExisting(probes: Probes, path: string): string | undefined {
  let current = resolve(path);
  for (;;) {
    if (probes.fileExists(current)) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function checkDisk(probes: Probes, outputDir: string): CheckResult {
  const existing = nearestExisting(probes, outputDir);
  const free = existing === undefined ? undefined : probes.freeDiskBytes(existing);

  if (free === undefined) {
    return { name: "Disk space", status: "ok", detail: "could not be determined" };
  }

  const gb = (free / 1024 ** 3).toFixed(1);
  if (free < MIN_FREE_DISK_BYTES) {
    return {
      name: "Disk space",
      status: "limitation",
      detail: `${gb} GB free for ${outputDir}`,
      impact:
        "A scan writes an event log and captured response bodies; running out mid-scan ends " +
        "it early.",
      remedy: "Free some space, or point --out at a larger volume.",
    };
  }
  return { name: "Disk space", status: "ok", detail: `${gb} GB free for ${outputDir}` };
}

export interface DoctorResult {
  readonly checks: readonly CheckResult[];
  readonly blockers: number;
  readonly limitations: number;
}

/** Run every check. Side-effect-free apart from the injected probes. */
export async function runChecks(probes: Probes, outputDir: string): Promise<DoctorResult> {
  const checks: readonly CheckResult[] = [
    checkNode(probes),
    checkChrome(probes),
    checkDisk(probes, outputDir),
    checkKatana(probes),
    ...(await checkAi(probes)),
  ];

  return {
    checks,
    blockers: checks.filter((check) => check.status === "blocker").length,
    limitations: checks.filter((check) => check.status === "limitation").length,
  };
}

const MARKS: Readonly<Record<CheckStatus, string>> = {
  ok: "ok  ",
  limitation: "--  ",
  blocker: "!!  ",
};

/**
 * Render the report, then fail only if something is genuinely blocking.
 *
 * Throwing after printing is deliberate: the user gets the whole picture, not
 * just the first thing that went wrong.
 */
export function reportChecks(result: DoctorResult, write: (line: string) => void): void {
  write("BrowserRecon environment check");
  write("");

  for (const check of result.checks) {
    write(`  ${MARKS[check.status]}${check.name.padEnd(12)}  ${check.detail ?? ""}`.trimEnd());
    if (check.status === "ok") continue;
    if (check.impact !== undefined) write(`        ${check.impact}`);
    if (check.remedy !== undefined) write(`        fix: ${check.remedy}`);
    write("");
  }

  if (result.blockers > 0) {
    throw new CliError(
      `${result.blockers} required dependency issue(s) must be resolved before scanning.`,
      EXIT_CODES.dependency,
      "Lines marked !! are required. Lines marked -- are optional capabilities.",
    );
  }

  const count = result.limitations;
  write(
    count > 0
      ? `Ready to scan. ${count} optional ${count === 1 ? "capability is" : "capabilities are"} ` +
          "unavailable — each line marked -- says what it would add."
      : "Ready to scan. Every optional capability is available too.",
  );
}

export interface DoctorInput {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly configFile?: string | undefined;
  readonly write: (line: string) => void;
  /** Overridden by tests; defaults to inspecting this machine. */
  readonly probes?: Probes | undefined;
}

/**
 * The command entry point.
 *
 * The output directory comes from the resolved configuration rather than a
 * hardcoded `.output`, because checking free space on the wrong filesystem is
 * worse than not checking at all — a user who redirected output to an external
 * volume would be told about the wrong disk. A configuration that does not
 * load is not fatal here: doctor's job is to report the environment, and
 * refusing to do that because a setting is wrong helps nobody.
 */
export async function doctor(input: DoctorInput): Promise<void> {
  const loaded = loadConfig({ spec: CONFIG_SPEC, env: input.env, file: input.configFile });
  const outputDir = loaded.ok
    ? ((loaded.config.output as { dir?: string } | undefined)?.dir ?? ".output")
    : ".output";

  const probes = input.probes ?? systemProbes(input.env);
  reportChecks(await runChecks(probes, outputDir), input.write);
}

/** Probes backed by the real machine. */
export function systemProbes(env: Readonly<Record<string, string | undefined>>): Probes {
  return {
    runCommand: (command, args) => {
      const result = spawnSync(command, [...args], {
        encoding: "utf8",
        timeout: 5_000,
        // Never a shell. The command names are fixed, but a crafted
        // BROWSERRECON_CHROME_PATH would otherwise be executable as a shell
        // fragment — doctor would become an injection point.
        shell: false,
      });
      if (result.error !== undefined || result.status !== 0) return undefined;
      // Chrome and Katana print their banners to different streams depending
      // on the build, so both are treated as output.
      return { stdout: `${result.stdout ?? ""}${result.stderr ?? ""}` };
    },
    fileExists: (path) => existsSync(path),
    httpGetJson: async (url) => {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
        return response.ok ? await response.json() : undefined;
      } catch {
        // A refused connection is the expected answer when the service is not
        // running, not an error worth surfacing as a stack trace.
        return undefined;
      }
    },
    freeDiskBytes: (path) => {
      try {
        const stats = statfsSync(path);
        return Number(stats.bavail) * Number(stats.bsize);
      } catch {
        return undefined;
      }
    },
    nodeVersion: process.version,
    platform: platform(),
    env,
  };
}
