import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CONFIG_SPEC, renderDefaultsTable } from "./schema.js";
import { loadConfig } from "./load.js";

const README = join(process.cwd(), "packages/config/README.md");

const MARKER_START = "<!-- BEGIN GENERATED DEFAULTS -->";
const MARKER_END = "<!-- END GENERATED DEFAULTS -->";

describe("CONFIG_SPEC", () => {
  it("resolves cleanly with no input at all", () => {
    // The whole spec must be internally consistent: every declared default
    // has to satisfy its own declared constraints, or a plain
    // `browserrecon scan <url>` would fail before it started.
    const result = loadConfig({ spec: CONFIG_SPEC });
    expect(result.ok).toBe(true);
  });

  it("has no duplicate paths", () => {
    const paths = CONFIG_SPEC.map((field) => field.path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("has no duplicate env vars or CLI flags", () => {
    // Two fields sharing a flag means one silently shadows the other.
    const envs = CONFIG_SPEC.map((f) => f.env).filter((e): e is string => e !== undefined);
    const flags = CONFIG_SPEC.map((f) => f.cli).filter((c): c is string => c !== undefined);
    expect(new Set(envs).size).toBe(envs.length);
    expect(new Set(flags).size).toBe(flags.length);
  });

  it("namespaces every env var under BROWSERRECON_", () => {
    for (const field of CONFIG_SPEC) {
      if (field.env === undefined) continue;
      expect(field.env, field.path).toMatch(/^BROWSERRECON_/);
    }
  });

  it("describes every field", () => {
    // The description is not decoration: it appears in validation errors and
    // in the generated defaults table.
    for (const field of CONFIG_SPEC) {
      expect(field.describe.length, field.path).toBeGreaterThan(10);
    }
  });

  it("defaults AI off, so V1-V3 never require a model (§25.4)", () => {
    const result = loadConfig({ spec: CONFIG_SPEC });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config).toMatchObject({ ai: { enabled: false } });
  });

  it("defaults the rate profile to normal, never aggressive (§8.3)", () => {
    const result = loadConfig({ spec: CONFIG_SPEC });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config).toMatchObject({ rate: { profile: "normal" } });
  });

  it("defaults redaction on and liveness probing off", () => {
    // Redaction protects exports by default; probing issues requests the
    // application never made, so it stays opt-in (§10C.7).
    const result = loadConfig({ spec: CONFIG_SPEC });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config).toMatchObject({
      output: { redact: true },
      discovery: { probeLiveness: false },
    });
  });

  it("rejects a target that is not an http(s) origin", () => {
    for (const bad of ["example.com", "ftp://example.com", "javascript:alert(1)"]) {
      expect(loadConfig({ spec: CONFIG_SPEC, cli: { target: bad } }).ok, bad).toBe(false);
    }
    expect(loadConfig({ spec: CONFIG_SPEC, cli: { target: "https://example.com" } }).ok).toBe(
      true,
    );
  });
});

describe("generated defaults table", () => {
  it("matches the table committed in the package README", () => {
    // BR-M0-04 requires documented defaults. A hand-maintained table is a
    // table that eventually lies, so it is generated and drift fails here —
    // same discipline as the JSON Schema check.
    const readme = readFileSync(README, "utf8");
    const start = readme.indexOf(MARKER_START);
    const end = readme.indexOf(MARKER_END);

    expect(start, `${MARKER_START} missing from packages/config/README.md`).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    const committed = readme.slice(start + MARKER_START.length, end);

    // Compare cell contents, not whitespace. Prettier reformats markdown
    // tables to align their columns, so a byte-for-byte comparison would pit
    // the formatter against this test and fail on presentation rather than on
    // the thing that actually matters: whether the README documents the
    // settings the code declares.
    const cells = (table: string): string[][] =>
      table
        .trim()
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .filter((line) => !/^\|[\s|:-]+\|$/.test(line.trim()))
        .map((line) =>
          line
            .trim()
            .replace(/^\|/, "")
            .replace(/\|$/, "")
            .split("|")
            .map((cell) => cell.trim()),
        );

    expect(cells(committed)).toEqual(cells(renderDefaultsTable()));
  });
});
