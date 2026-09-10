import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { formatConfigErrors, loadConfig, parseConfigFile } from "./load.js";
import { bool, list, num, oneOf, str, type ConfigSpec } from "./spec.js";

const SPEC: ConfigSpec = [
  str("output.dir", "Artifact directory", {
    default: ".output",
    env: "BROWSERRECON_OUTPUT_DIR",
    cli: "out",
  }),
  num("limits.maxRequestsPerSecond", "Sustained request rate", {
    default: 2,
    min: 0.1,
    max: 100,
    env: "BROWSERRECON_RPS",
    cli: "rps",
  }),
  num("limits.maxPages", "Page budget", {
    default: 60,
    min: 1,
    integer: true,
    cli: "max-pages",
  }),
  bool("browser.headless", "Run headless", { default: true, cli: "headless" }),
  oneOf("rate.profile", "Politeness", {
    values: ["polite", "normal", "aggressive"],
    default: "normal",
    env: "BROWSERRECON_RATE_PROFILE",
    cli: "rate-profile",
  }),
  list("output.formats", "Artifacts", {
    default: ["json", "md"],
    values: ["json", "jsonl", "md"],
    cli: "format",
  }),
  str("auth.passwordEnv", "Env var holding the password", { env: "BROWSERRECON_PASSWORD" }),
];

const tempFile = (name: string, contents: string): string => {
  const dir = mkdtempSync(join(tmpdir(), "browserrecon-config-"));
  const path = join(dir, name);
  writeFileSync(path, contents);
  return path;
};

describe("precedence", () => {
  it("applies CLI > env > file > default", () => {
    // Each level is more specific to this run than the one below it: a file
    // describes a project, an env var a machine, a flag one invocation.
    const base = { spec: SPEC, fileData: { output: { dir: "from-file" } } };

    expect(loadConfig({ spec: SPEC })).toMatchObject({
      ok: true,
      config: { output: { dir: ".output" } },
    });

    expect(loadConfig(base)).toMatchObject({
      ok: true,
      config: { output: { dir: "from-file" } },
    });

    expect(loadConfig({ ...base, env: { BROWSERRECON_OUTPUT_DIR: "from-env" } })).toMatchObject(
      { ok: true, config: { output: { dir: "from-env" } } },
    );

    expect(
      loadConfig({
        ...base,
        env: { BROWSERRECON_OUTPUT_DIR: "from-env" },
        cli: { out: "from-cli" },
      }),
    ).toMatchObject({ ok: true, config: { output: { dir: "from-cli" } } });
  });

  it("records where every value came from", () => {
    // So "why is my rate 5?" is answerable without bisecting config files.
    const result = loadConfig({
      spec: SPEC,
      fileData: { limits: { maxPages: 500 } },
      env: { BROWSERRECON_RPS: "5" },
      cli: { headless: false },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.origins.get("limits.maxRequestsPerSecond")).toEqual({
      value: 5,
      source: "env",
    });
    expect(result.origins.get("limits.maxPages")).toEqual({ value: 500, source: "file" });
    expect(result.origins.get("browser.headless")).toEqual({ value: false, source: "cli" });
    expect(result.origins.get("rate.profile")).toEqual({ value: "normal", source: "default" });
  });

  it("ignores an env var that is set but empty rather than treating it as a value", () => {
    // An unset variable in CI often materializes as "". Treating that as an
    // override would silently blank a configured directory.
    const result = loadConfig({
      spec: SPEC,
      fileData: { output: { dir: "from-file" } },
      env: { BROWSERRECON_OUTPUT_DIR: "" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config).toMatchObject({ output: { dir: "" } });
  });
});

describe("validation", () => {
  it("names the field, the source, and what was allowed", () => {
    const result = loadConfig({ spec: SPEC, cli: { "rate-profile": "reckless" } });

    expect(result.ok).toBe(false);
    if (result.ok) return;

    const [error] = result.errors;
    expect(error?.path).toBe("rate.profile");
    expect(error?.source).toBe("cli");
    expect(error?.reason).toContain("polite, normal, aggressive");
    expect(error?.received).toBe('"reckless"');
  });

  it("collects every problem in one pass", () => {
    // A user should fix one config file once, not re-run to find each
    // successive error.
    const result = loadConfig({
      spec: SPEC,
      fileData: {
        limits: { maxRequestsPerSecond: 500, maxPages: 0.5 },
        rate: { profile: "nope" },
        output: { formats: ["json", "pdf"] },
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((e) => e.path).sort()).toEqual([
      "limits.maxPages",
      "limits.maxRequestsPerSecond",
      "output.formats",
      "rate.profile",
    ]);
  });

  it("enforces numeric bounds", () => {
    expect(loadConfig({ spec: SPEC, cli: { rps: "0" } }).ok).toBe(false);
    expect(loadConfig({ spec: SPEC, cli: { rps: "1000" } }).ok).toBe(false);
    expect(loadConfig({ spec: SPEC, cli: { rps: "2.5" } }).ok).toBe(true);
  });

  it("requires integers where declared", () => {
    expect(loadConfig({ spec: SPEC, cli: { "max-pages": "10.5" } }).ok).toBe(false);
    expect(loadConfig({ spec: SPEC, cli: { "max-pages": "10" } }).ok).toBe(true);
  });

  it("is strict about booleans", () => {
    // A rate limit or a policy switch mistyped as "yes" must fail rather than
    // resolve to something plausible.
    expect(loadConfig({ spec: SPEC, cli: { headless: "true" } }).ok).toBe(true);
    expect(loadConfig({ spec: SPEC, cli: { headless: "false" } }).ok).toBe(true);
    for (const bad of ["yes", "1", "on", "TRUE"]) {
      expect(loadConfig({ spec: SPEC, cli: { headless: bad } }).ok, bad).toBe(false);
    }
  });

  it("rejects a number with stray whitespace instead of trimming it", () => {
    expect(loadConfig({ spec: SPEC, env: { BROWSERRECON_RPS: " 2" } }).ok).toBe(false);
  });

  it("accepts a comma-separated list from the command line", () => {
    const result = loadConfig({ spec: SPEC, cli: { format: "json,jsonl" } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config).toMatchObject({ output: { formats: ["json", "jsonl"] } });
  });

  it("rejects an unknown list item and says which", () => {
    const result = loadConfig({ spec: SPEC, cli: { format: "json,pdf" } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.reason).toContain("pdf");
  });

  it("redacts a credential-shaped value from the error message", () => {
    // A malformed password must produce a useful error, not print the
    // password into a terminal or CI log (build plan §37.2).
    const spec: ConfigSpec = [
      num("auth.password", "wrong type on purpose", {
        default: 1,
        env: "BROWSERRECON_PASSWORD",
      }),
    ];
    const result = loadConfig({ spec, env: { BROWSERRECON_PASSWORD: "hunter2" } });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.received).toBe("(redacted)");
    expect(JSON.stringify(result.errors)).not.toContain("hunter2");
  });
});

describe("config files", () => {
  it("reads YAML", () => {
    const file = tempFile(
      "browserrecon.yaml",
      "output:\n  dir: from-yaml\nlimits:\n  maxPages: 120\n",
    );
    const result = loadConfig({ spec: SPEC, file });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config).toMatchObject({
      output: { dir: "from-yaml" },
      limits: { maxPages: 120 },
    });
  });

  it("reads JSON", () => {
    const file = tempFile(
      "browserrecon.json",
      JSON.stringify({ output: { dir: "from-json" } }),
    );
    expect(loadConfig({ spec: SPEC, file })).toMatchObject({
      ok: true,
      config: { output: { dir: "from-json" } },
    });
  });

  it("reports a missing file rather than silently using defaults", () => {
    const result = loadConfig({ spec: SPEC, file: "/nonexistent/browserrecon.yaml" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.reason).toContain("not found");
  });

  it("reports malformed YAML with the parser's message", () => {
    const file = tempFile("browserrecon.yaml", "output:\n  dir: [unclosed\n");
    const result = loadConfig({ spec: SPEC, file });
    expect(result.ok).toBe(false);
  });

  it("rejects an unsupported extension", () => {
    expect(() => parseConfigFile("x=1", "browserrecon.toml")).toThrow(/unsupported/);
  });
});

describe("formatConfigErrors", () => {
  it("renders each problem with its field, source and reason", () => {
    const result = loadConfig({ spec: SPEC, cli: { "rate-profile": "reckless" } });
    expect(result.ok).toBe(false);
    if (result.ok) return;

    const text = formatConfigErrors(result.errors);
    expect(text).toContain("1 configuration problem");
    expect(text).toContain("rate.profile");
    expect(text).toContain("polite, normal, aggressive");
  });

  it("pluralises correctly", () => {
    const result = loadConfig({
      spec: SPEC,
      cli: { "rate-profile": "reckless", rps: "-1" },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(formatConfigErrors(result.errors)).toContain("2 configuration problems");
  });
});
