import { describe, expect, it } from "vitest";
import {
  reportChecks,
  runChecks,
  systemProbes,
  type CheckResult,
  type Probes,
} from "./doctor.js";
import { CliError, EXIT_CODES } from "../exit-codes.js";

/**
 * A machine where everything is present and working.
 *
 * Tests describe their case as a delta from this, so each one reads as "the
 * same machine, except Katana is missing" rather than as a wall of setup.
 */
function machine(overrides: Partial<Probes> = {}): Probes {
  const present = new Set([
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Users/test",
  ]);

  return {
    runCommand: (command) => {
      if (command.includes("Google Chrome")) return { stdout: "Google Chrome 141.0.7390.55\n" };
      if (command === "katana") return { stdout: "Current Version: v1.2.5\n" };
      if (command === "ollama") return { stdout: "ollama version is 0.30.10\n" };
      return undefined;
    },
    fileExists: (path) => present.has(path),
    httpGetJson: async () => ({ models: [{ name: "qwen3:8b" }] }),
    freeDiskBytes: () => 200 * 1024 ** 3,
    nodeVersion: "v22.11.0",
    platform: "darwin",
    env: {},
    ...overrides,
  };
}

const render = (result: Awaited<ReturnType<typeof runChecks>>): string => {
  const lines: string[] = [];
  reportChecks(result, (line) => lines.push(line));
  return lines.join("\n");
};

const find = (result: { checks: readonly CheckResult[] }, name: string): CheckResult => {
  const check = result.checks.find((candidate) => candidate.name === name);
  if (check === undefined) throw new Error(`no check named ${name}`);
  return check;
};

describe("a fully equipped machine", () => {
  it("reports everything as ok and exits zero", async () => {
    const result = await runChecks(machine(), "/Users/test/.output");
    expect(result.blockers).toBe(0);
    expect(result.limitations).toBe(0);
    expect(render(result)).toContain("Every optional capability is available too");
  });

  it("shows the versions it found, not just a checkmark", async () => {
    // "Chrome: ok" is not actionable when a scan behaves oddly; the version is.
    const report = render(await runChecks(machine(), "/Users/test"));
    expect(report).toContain("141.0.7390.55");
    expect(report).toContain("v1.2.5");
    expect(report).toContain("0.30.10");
  });
});

describe("the report is written for a user, not for us", () => {
  it("never cites a build-plan section number", async () => {
    // The build plan is not shipped with the tool, so "§10D.1" is a dead
    // reference to anyone reading the terminal. Section numbers belong in
    // comments; this is the whole report on a machine missing everything.
    const variants = [
      // Nothing installed at all: every blocker and limitation message.
      machine({
        fileExists: () => false,
        runCommand: () => undefined,
        httpGetJson: async () => undefined,
        nodeVersion: "v18.0.0",
      }),
      // Service up, no usable model: the tier-advice message.
      machine({ httpGetJson: async () => ({ models: [] }), freeDiskBytes: () => 1024 }),
    ];

    for (const probes of variants) {
      const result = await runChecks(probes, "/tmp");
      const lines: string[] = [];
      try {
        reportChecks(result, (line) => lines.push(line));
      } catch {
        // A blocker is expected in the first variant; the report is what
        // matters here, and it is written before the throw.
      }
      expect(lines.join("\n")).not.toContain("§");
    }
  });
});

describe("optional dependencies", () => {
  it("treats a missing Katana as a limitation, never a failure", async () => {
    // The acceptance criterion for BR-M0-12, and the reason the three-state
    // model exists at all.
    const probes = machine({
      runCommand: (command, args) =>
        command === "katana" ? undefined : machine().runCommand(command, args),
    });
    const result = await runChecks(probes, "/Users/test");

    expect(find(result, "Katana").status).toBe("limitation");
    expect(result.blockers).toBe(0);
    expect(() => render(result)).not.toThrow();
  });

  it("says what is lost without Katana and what replaces it", async () => {
    const probes = machine({
      runCommand: (command, args) =>
        command === "katana" ? undefined : machine().runCommand(command, args),
    });
    const report = render(await runChecks(probes, "/Users/test"));

    // A user told only "Katana: missing" cannot decide whether to care.
    expect(report).toContain("--import-urls");
    expect(report).toMatch(/robots\.txt/);
  });

  it("treats a missing Ollama as a limitation and names what still works", async () => {
    const probes = machine({
      runCommand: (command, args) =>
        command === "ollama" ? undefined : machine().runCommand(command, args),
      httpGetJson: async () => undefined,
    });
    const result = await runChecks(probes, "/Users/test");

    expect(find(result, "Ollama").status).toBe("limitation");
    expect(result.blockers).toBe(0);
    expect(render(result)).toContain("Deterministic scanning");
  });

  it("distinguishes an installed-but-stopped service from a missing one", async () => {
    // Different problems, different fixes: one is `ollama serve`, the other is
    // a download. Reporting both as "Ollama unavailable" would waste the
    // user's time.
    const stopped = await runChecks(
      machine({ httpGetJson: async () => undefined }),
      "/Users/test",
    );
    expect(render(stopped)).toContain("ollama serve");
    expect(render(stopped)).not.toContain("ollama.com/download");

    const absent = await runChecks(
      machine({
        runCommand: (command, args) =>
          command === "ollama" ? undefined : machine().runCommand(command, args),
        httpGetJson: async () => undefined,
      }),
      "/Users/test",
    );
    expect(render(absent)).toContain("ollama.com/download");
  });

  it("reports a running service with no usable model as a model problem", async () => {
    const probes = machine({ httpGetJson: async () => ({ models: [{ name: "llama3:8b" }] }) });
    const result = await runChecks(probes, "/Users/test");

    expect(find(result, "Ollama").status).toBe("ok");
    expect(find(result, "Local model").status).toBe("limitation");
    expect(find(result, "Local model").detail).toContain("1 other model");
  });

  it("assesses which tier the installed models satisfy", async () => {
    const probes = machine({
      httpGetJson: async () => ({ models: [{ name: "qwen3:4b" }, { name: "qwen3:14b" }] }),
    });
    const result = await runChecks(probes, "/Users/test");

    expect(find(result, "Local model").detail).toContain("small tier");
    expect(find(result, "Local model").detail).toContain("large tier");
    expect(find(result, "Local model").detail).not.toContain("standard tier");
  });

  it("prints the model download command rather than running it", async () => {
    // §25.2: doctor must never trigger a multi-GB pull. The probes here can
    // only run commands and fetch JSON, and this asserts it does neither —
    // the pull appears as text for the user to run.
    const commands: string[] = [];
    const fetched: string[] = [];
    const probes = machine({
      runCommand: (command, args) => {
        commands.push(command);
        return machine().runCommand(command, args);
      },
      httpGetJson: async (url) => {
        fetched.push(url);
        return { models: [] };
      },
    });

    const report = render(await runChecks(probes, "/Users/test"));

    expect(report).toContain("ollama pull qwen3:8b");
    expect(commands).not.toContain("ollama pull");
    // Only the local model listing endpoint, which downloads nothing.
    expect(fetched).toEqual(["http://127.0.0.1:11434/api/tags"]);
  });

  it("does not probe a user-configured external AI endpoint", async () => {
    // Doctor is a local inspection. Reaching out to a third-party host just to
    // print a checkmark would make running it a network event.
    const fetched: string[] = [];
    const probes = machine({
      env: { BROWSERRECON_AI_ENDPOINT: "https://ai.internal.example.com/v1" },
      httpGetJson: async (url) => {
        fetched.push(url);
        return { models: [] };
      },
    });

    const result = await runChecks(probes, "/Users/test");
    expect(fetched).toEqual([]);
    expect(find(result, "AI runtime").detail).toContain("not probed");
  });

  it("honours OLLAMA_HOST", async () => {
    const fetched: string[] = [];
    const probes = machine({
      env: { OLLAMA_HOST: "http://gpu-box.lan:11434/" },
      httpGetJson: async (url) => {
        fetched.push(url);
        return { models: [{ name: "qwen3:8b" }] };
      },
    });

    await runChecks(probes, "/Users/test");
    expect(fetched).toEqual(["http://gpu-box.lan:11434/api/tags"]);
  });
});

describe("required dependencies", () => {
  it("fails with the dependency exit code when Chrome is absent", async () => {
    const probes = machine({
      fileExists: (path) => path === "/Users/test",
      runCommand: (command) => (command === "katana" ? { stdout: "v1.2.5" } : undefined),
    });
    const result = await runChecks(probes, "/Users/test");

    expect(find(result, "Chrome").status).toBe("blocker");
    try {
      render(result);
      expect.unreachable("a blocker must fail");
    } catch (error) {
      expect(error).toBeInstanceOf(CliError);
      expect((error as CliError).code).toBe(EXIT_CODES.dependency);
    }
  });

  it("prints the whole report before failing", async () => {
    // Exiting at the first blocker would send the user round the loop once per
    // problem.
    const probes = machine({ fileExists: () => false, runCommand: () => undefined });
    const result = await runChecks(probes, "/tmp");
    const lines: string[] = [];

    expect(() => reportChecks(result, (line) => lines.push(line))).toThrow(CliError);
    const report = lines.join("\n");

    expect(report).toContain("Chrome");
    expect(report).toContain("Katana");
    expect(report).toContain("Ollama");
  });

  it("finds Chrome on PATH when no bundle is present", async () => {
    // The normal Linux install.
    const probes = machine({
      platform: "linux",
      fileExists: (path) => path === "/Users/test",
      runCommand: (command) =>
        command === "google-chrome" ? { stdout: "Google Chrome 141.0.7390.55" } : undefined,
    });
    const result = await runChecks(probes, "/Users/test");

    expect(find(result, "Chrome").status).toBe("ok");
    expect(find(result, "Chrome").detail).toContain("on PATH");
  });

  it("refuses to silently substitute a Chrome the user did not choose", async () => {
    // BROWSERRECON_CHROME_PATH is an explicit decision. Falling back to a
    // detected browser would make every observation describe the wrong build.
    const probes = machine({ env: { BROWSERRECON_CHROME_PATH: "/opt/custom/chrome" } });
    const result = await runChecks(probes, "/Users/test");

    expect(find(result, "Chrome").status).toBe("blocker");
    expect(find(result, "Chrome").remedy).toContain("/opt/custom/chrome");
  });

  it("rejects a Node older than the engines field", async () => {
    const result = await runChecks(machine({ nodeVersion: "v20.11.0" }), "/Users/test");
    expect(find(result, "Node.js").status).toBe("blocker");
  });
});

describe("disk space", () => {
  it("warns when there is not enough room for a scan's artifacts", async () => {
    const result = await runChecks(
      machine({ freeDiskBytes: () => 500 * 1024 ** 2 }),
      "/Users/test",
    );

    expect(find(result, "Disk space").status).toBe("limitation");
    expect(find(result, "Disk space").detail).toContain("0.5 GB");
    // Low disk stops a scan finishing but not starting, so it must not block.
    expect(result.blockers).toBe(0);
  });

  it("measures the nearest existing directory when the output dir is new", async () => {
    // `.output` does not exist before the first scan, and statfs on a missing
    // path fails — which would have reported "could not be determined" on
    // every fresh install.
    const measured: string[] = [];
    const probes = machine({
      fileExists: (path) => path === "/Users/test",
      freeDiskBytes: (path) => {
        measured.push(path);
        return 200 * 1024 ** 3;
      },
      runCommand: () => undefined,
    });

    await runChecks(probes, "/Users/test/.output/session-1");
    expect(measured).toEqual(["/Users/test"]);
  });

  it("stays quiet rather than guessing when free space is unknowable", async () => {
    const result = await runChecks(machine({ freeDiskBytes: () => undefined }), "/Users/test");
    expect(find(result, "Disk space").status).toBe("ok");
    expect(find(result, "Disk space").detail).toContain("could not be determined");
  });
});

describe("systemProbes", () => {
  it("reports a command that does not exist as absent rather than throwing", async () => {
    const probes = systemProbes({});
    expect(
      probes.runCommand("browserrecon-definitely-not-installed", ["--version"]),
    ).toBeUndefined();
  });

  it("reports a refused connection as absent rather than throwing", async () => {
    // Port 1 is reserved and never listening.
    await expect(
      systemProbes({}).httpGetJson("http://127.0.0.1:1/api/tags"),
    ).resolves.toBeUndefined();
  });

  it("never runs a probe through a shell", () => {
    // A crafted BROWSERRECON_CHROME_PATH would otherwise be a command
    // injection: doctor executes whatever path it is given.
    const marker = `/tmp/browserrecon-shell-probe-${process.pid}`;
    systemProbes({}).runCommand(`true; touch ${marker}`, ["--version"]);
    expect(systemProbes({}).fileExists(marker)).toBe(false);
  });

  it("captures output whichever stream a tool writes its version to", () => {
    const result = systemProbes({}).runCommand("node", ["--version"]);
    expect(result?.stdout).toContain("v");
  });
});
