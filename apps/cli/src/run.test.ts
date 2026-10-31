import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { run } from "./run.js";
import { EXIT_CODES, EXIT_CODE_DESCRIPTIONS } from "./exit-codes.js";

function invoke(argv: string[], env: Record<string, string | undefined> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  return run({
    argv,
    io: {
      out: (line) => out.push(line),
      err: (line) => err.push(line),
      env,
      version: "0.1.0-test",
    },
  }).then((code) => ({ code, out: out.join("\n"), err: err.join("\n") }));
}

const tempConfig = (contents: string, name = "browserrecon.yaml"): string => {
  const path = join(mkdtempSync(join(tmpdir(), "br-cli-")), name);
  writeFileSync(path, contents);
  return path;
};

describe("exit codes", () => {
  it("documents every code it can return", () => {
    // A pipeline can only branch on what the process tells it, so these are a
    // public contract: adding one is fine, changing a meaning is breaking.
    for (const code of Object.values(EXIT_CODES)) {
      expect(EXIT_CODE_DESCRIPTIONS[code], `code ${code}`).toBeDefined();
    }
  });

  it("returns success for a command that worked", async () => {
    const { code } = await invoke(["version"]);
    expect(code).toBe(EXIT_CODES.success);
  });

  it("returns a usage error for an unknown command", async () => {
    const { code } = await invoke(["nonsense"]);
    expect(code).toBe(EXIT_CODES.usage);
  });

  it("returns a usage error for a missing required argument", async () => {
    const { code } = await invoke(["scan"]);
    expect(code).toBe(EXIT_CODES.usage);
  });

  it("returns a configuration error for an invalid setting", async () => {
    // Distinct from a usage error: the command was well-formed, the settings
    // were not, and a pipeline may want to react differently.
    const { code, err } = await invoke(["config", "validate", "--rate-profile", "reckless"]);
    expect(code).toBe(EXIT_CODES.configuration);
    expect(err).toContain("polite, normal, aggressive");
  });

  it("returns a configuration error for a target that is not an origin", async () => {
    const { code } = await invoke(["config", "validate", "not-a-url"]);
    expect(code).toBe(EXIT_CODES.configuration);
  });
});

describe("unimplemented commands", () => {
  it.each([
    ["agent", ["agent", "https://shop.example.com"]],
    ["export", ["export", "sess_0001"]],
  ] as const)("%s fails clearly rather than doing nothing", async (_name, argv) => {
    // A pre-release build that accepts `scan` and silently does nothing reads
    // as broken, not unfinished.
    const { code, err } = await invoke([...argv]);
    expect(code).not.toBe(EXIT_CODES.success);
    expect(err).toContain("not implemented");
  });

  it("scan refuses without authorization rather than doing nothing", async () => {
    // `scan` is implemented now. What it must not do is start: with no
    // terminal to ask in and no --i-am-authorized, §7.4 says refuse.
    const { code, err } = await invoke(["scan", "https://shop.example.com"]);
    expect(code).toBe(EXIT_CODES.authorization);
    expect(err).toMatch(/authoriz/i);
  });

  it("resume validates the session before refusing", async () => {
    // `resume` is no longer a stub: the §30 gate is real and runs first, so
    // a missing session is reported as a missing session rather than as an
    // unimplemented command. Only the engine behind the gate is pending.
    // Pointed at an empty directory on purpose. It used to resolve
    // `sess_0001` under the default `.output/`, so the test passed only on a
    // machine that had never run a scan — and failed the moment one had,
    // reporting a boundary mismatch instead of a missing session.
    const { code, err } = await invoke([
      "resume",
      "sess_0001",
      "--out",
      mkdtempSync(join(tmpdir(), "br-empty-")),
    ]);
    expect(code).not.toBe(EXIT_CODES.success);
    expect(err).toContain("No session found");
  });

  it("covers the auth subcommands too", async () => {
    expect((await invoke(["auth", "list"])).code).not.toBe(EXIT_CODES.success);
    expect((await invoke(["auth", "validate", "admin"])).code).not.toBe(EXIT_CODES.success);
  });
});

describe("help", () => {
  it("states the scan versus agent distinction", async () => {
    // §30.1's boundary is the safety story, so --help is where a user has to
    // be able to learn it.
    const { out, code } = await invoke(["--help"]);
    expect(code).toBe(EXIT_CODES.success);
    expect(out).toContain("scan  = observe and analyse");
    expect(out).toContain("agent = decide, explore and analyse");
  });

  it("lists every command from §30", async () => {
    const { out } = await invoke(["--help"]);
    for (const command of [
      "scan",
      "agent",
      "resume",
      "export",
      "doctor",
      "auth",
      "config",
      "schema",
      "version",
    ]) {
      expect(out, `missing ${command}`).toContain(command);
    }
  });

  it("documents the exit codes", async () => {
    const { out } = await invoke(["--help"]);
    expect(out).toContain("Exit codes:");
    expect(out).toContain("refused by target policy");
  });

  it("carries the authorized-use statement", async () => {
    const { out } = await invoke(["--help"]);
    expect(out).toMatch(/only scan systems you own/i);
  });

  it("derives scan's flags from the configuration spec", async () => {
    // Flags are generated from CONFIG_SPEC/POLICY_SPEC so the two cannot
    // drift. If this breaks, a declared setting has lost its flag.
    const { out } = await invoke(["scan", "--help"]);
    for (const flag of [
      "--rate-profile",
      "--thoroughness",
      "--import-urls",
      "--max-pages",
      "--allowed-methods",
      "--ai",
      "--model",
    ]) {
      expect(out, `missing ${flag}`).toContain(flag);
    }
  });

  it("offers --no- variants so a default-on setting can be switched off", async () => {
    const { out } = await invoke(["scan", "--help"]);
    expect(out).toContain("--no-katana");
  });

  it("shows allowed values and defaults for enum flags", async () => {
    const { out } = await invoke(["scan", "--help"]);
    expect(out).toMatch(/polite \| normal \| aggressive/);
    expect(out).toContain("[default: normal]");
  });
});

describe("version", () => {
  it("reports the tool and schema versions", async () => {
    const { out, code } = await invoke(["version"]);
    expect(code).toBe(EXIT_CODES.success);
    expect(out).toContain("browserrecon 0.1.0-test");
    expect(out).toContain("event schema");
  });

  it("supports --version as well", async () => {
    const { out, code } = await invoke(["--version"]);
    expect(code).toBe(EXIT_CODES.success);
    expect(out).toContain("0.1.0-test");
  });
});

describe("schema", () => {
  it("prints valid JSON Schema for the event envelope", async () => {
    const { out, code } = await invoke(["schema"]);
    expect(code).toBe(EXIT_CODES.success);

    const schema = JSON.parse(out);
    expect(schema.title).toContain("event envelope");
    expect(schema.required).toContain("auth_context");
  });
});

describe("config validate", () => {
  it("reports a valid default configuration", async () => {
    const { out, code } = await invoke(["config", "validate"]);
    expect(code).toBe(EXIT_CODES.success);
    expect(out).toContain("Configuration is valid");
    expect(out).toContain("All settings are at their defaults");
  });

  it("resolves the Target Policy when given a URL", async () => {
    const { out } = await invoke(["config", "validate", "https://shop.example.com"]);
    expect(out).toContain("Target policy for https://shop.example.com");
    expect(out).toContain("GET, HEAD, OPTIONS");
  });

  it("shows the effective budget, not just the configured limits", async () => {
    // §8.3: interacting limits cannot be reasoned about in your head, which is
    // how a page budget unreachable by ~70x shipped in an earlier draft.
    const { out } = await invoke(["config", "validate", "https://shop.example.com"]);
    expect(out).toContain("effective");
    expect(out).toMatch(/\(time-bound\)|\(pages-bound\)/);
  });

  it("warns when a page budget cannot be reached at the configured rate", async () => {
    const { out } = await invoke([
      "config",
      "validate",
      "https://shop.example.com",
      "--rate-profile",
      "polite",
      "--max-pages",
      "50000",
    ]);
    expect(out).toContain("cannot be reached at this rate");
  });

  it("names where each non-default value came from", async () => {
    const { out } = await invoke(
      ["config", "validate", "https://shop.example.com", "--rate-profile", "polite"],
      { BROWSERRECON_OUTPUT_DIR: "/tmp/from-env" },
    );
    expect(out).toContain("(from cli)");
    expect(out).toContain("(from env)");
  });

  it("reads a config file when given one", async () => {
    const file = tempConfig("output:\n  dir: from-yaml\n");
    const { out } = await invoke(["--config", file, "config", "validate"]);
    expect(out).toContain("from-yaml");
    expect(out).toContain("(from file)");
  });

  it("surfaces higher-risk settings in plain language", async () => {
    // §7.4: a user must be told what a setting permits in words they can act
    // on, not shown a jargon label.
    const { out } = await invoke([
      "config",
      "validate",
      "https://shop.example.com",
      "--allowed-methods",
      "GET,DELETE",
    ]);
    expect(out).toContain("higher-risk");
    expect(out).toMatch(/permanently delete/i);
  });

  it("reports no risks for the default read-only policy", async () => {
    // The common path must stay quiet, or users learn to ignore the warning.
    const { out } = await invoke(["config", "validate", "https://shop.example.com"]);
    expect(out).not.toContain("higher-risk");
  });
});

describe("doctor", () => {
  it("reports every dependency on the real machine", async () => {
    // The end-to-end path, so a wiring mistake between commander and the
    // checks cannot hide behind unit tests that inject their own probes.
    // What this machine happens to have installed is covered in doctor.test.ts,
    // where the probes are controlled.
    const { out } = await invoke(["doctor"]);
    for (const name of ["Node.js", "Chrome", "Disk space", "Katana"]) {
      expect(out, `missing ${name}`).toContain(name);
    }
  });

  it("exits zero, or with the dependency code when something is blocking", async () => {
    const { out, code } = await invoke(["doctor"]);
    if (code === EXIT_CODES.success) {
      expect(out).toContain("Ready to scan");
    } else {
      // The only legitimate failure. Anything else — a crash, a usage error —
      // means the command is broken rather than the machine.
      expect(code).toBe(EXIT_CODES.dependency);
      expect(out).toContain("!!");
    }
  });

  it("writes the report to stdout even when it fails", async () => {
    // A diagnostic that prints nothing on failure is useless; the whole point
    // is seeing the other checks alongside the one that blocked.
    const { out } = await invoke(["doctor"]);
    expect(out).toContain("BrowserRecon environment check");
  });
});

describe("output discipline", () => {
  it("prints an unknown-command error only once", async () => {
    // Commander reports parse errors itself; re-printing showed the user the
    // same line twice.
    const { err } = await invoke(["nonsense"]);
    expect(err.match(/unknown command/g) ?? []).toHaveLength(1);
  });

  it("sends errors to stderr and results to stdout", async () => {
    const failure = await invoke(["scan", "https://shop.example.com"]);
    expect(failure.err).not.toBe("");
    expect(failure.out).toBe("");

    const success = await invoke(["version"]);
    expect(success.out).not.toBe("");
    expect(success.err).toBe("");
  });
});

describe("the §7.4 authorization prompt", () => {
  /**
   * This whole block is the test that did not exist.
   *
   * The gate has always returned "ask the user this question", and the CLI
   * threw the question as an error message instead — so the terminal printed
   * `Are you authorized to test this target? [y/N]` and exited, with no way
   * to answer. Every document describing the interactive path was wrong, for
   * every release.
   */
  const promptRun = (
    answer: string | (() => Promise<string>),
    argv: string[] = [
      "scan",
      "https://shop.example.com",
      "--max-pages",
      "1",
      "--out",
      mkdtempSync(join(tmpdir(), "br-out-")),
    ],
    env: Record<string, string | undefined> = {},
  ): Promise<{ code: number; out: string; err: string; asked: string[] }> => {
    // An isolated config home, always. `defaultRecordPath({})` falls back to
    // the real `homedir()`, so these tests wrote authorization for
    // `shop.example.com` into the developer's own record — and then the
    // prompt tests stopped seeing a prompt, because the machine now
    // remembered agreeing. A test that changes the state it is testing
    // passes once.
    const configHome = mkdtempSync(join(tmpdir(), "br-authrec-"));
    const out: string[] = [];
    const err: string[] = [];
    const asked: string[] = [];
    return run({
      argv,
      io: {
        out: (line) => out.push(line),
        err: (line) => err.push(line),
        env: { ...env, XDG_CONFIG_HOME: configHome },
        version: "0.1.0-test",
        interactive: true,
        ask: async (question) => {
          asked.push(question);
          return typeof answer === "string" ? answer : answer();
        },
      },
    }).then((code) => ({ code, out: out.join("\n"), err: err.join("\n"), asked }));
  };

  it("actually asks, rather than printing the question and leaving", async () => {
    const { asked } = await promptRun("n");
    expect(asked, "the gate never asked anything").toHaveLength(1);
    expect(asked[0]).toMatch(/authorized/i);
  });

  it("refuses on no, and says nothing was scanned", async () => {
    const { code, err } = await promptRun("n");
    expect(code).toBe(EXIT_CODES.authorization);
    expect(err).toMatch(/nothing was scanned/i);
  });

  it("treats an empty answer as a refusal", async () => {
    // The prompt shows [y/N]. Someone pressing Enter to get past it has not
    // agreed to anything, and Ctrl+D arrives here as an empty line too.
    const { code } = await promptRun("");
    expect(code).toBe(EXIT_CODES.authorization);
  });

  it("lets a yes through, and remembers it", async () => {
    // One case, not three. Which spellings count as consent is
    // `isAffirmative`'s business and is tested there; what this needs to
    // show is that a yes gets past the gate and is persisted.
    //
    // It is slow because consent is followed by a real scan attempt —
    // Chrome launches, the target does not resolve, the scan fails. That
    // is the honest cost of testing the gate end to end, and the earlier
    // version of this test hid it behind a 5-second default and then
    // timed out.
    const configHome = mkdtempSync(join(tmpdir(), "br-authrec-"));
    const asked: string[] = [];
    await run({
      argv: [
        "scan",
        "https://shop.example.com",
        "--max-pages",
        "1",
        "--out",
        mkdtempSync(join(tmpdir(), "br-out-")),
      ],
      io: {
        out: () => {},
        err: () => {},
        env: { XDG_CONFIG_HOME: configHome },
        version: "0.1.0-test",
        interactive: true,
        ask: async (question) => {
          asked.push(question);
          return "yes";
        },
      },
    });

    expect(asked).toHaveLength(1);
    // Consent is remembered, so the target is not re-confirmed next time.
    const record = join(configHome, "browserrecon", "authorization.json");
    expect(existsSync(record), "the answer was not persisted").toBe(true);
    expect(JSON.parse(readFileSync(record, "utf8")).confirmedTargets).toContain(
      "https://shop.example.com",
    );
  }, 60_000);

  it("does not ask at all when --i-am-authorized was passed", async () => {
    // Slow for the same reason the consent test is: getting past the gate
    // means a real scan attempt follows, and Chrome takes seconds to
    // start. The default five-second timeout was a bet that it would not.
    const { asked } = await promptRun("n", [
      "scan",
      "https://shop.example.com",
      "--i-am-authorized",
      "--max-pages",
      "1",
      "--out",
      mkdtempSync(join(tmpdir(), "br-out-")),
    ]);
    expect(asked).toEqual([]);
  }, 60_000);
});
