import { describe, expect, it } from "vitest";
import { CHROME_PATH_ENV, resolveChromePath, type ChromeProbes } from "./chrome-path.js";

function machine(overrides: Partial<ChromeProbes> = {}): ChromeProbes {
  const bundle = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  return {
    fileExists: (path) => path === bundle,
    runCommand: (command) =>
      command === bundle ? { stdout: "Google Chrome 152.0.7977.83\n" } : undefined,
    platform: "darwin",
    env: {},
    ...overrides,
  };
}

describe("finding Chrome", () => {
  it("prefers the macOS app bundle, which is not on PATH", async () => {
    // A `which` lookup alone reports "not installed" on every normal Mac.
    const found = resolveChromePath(machine());
    expect(found).toMatchObject({ found: true, source: "bundle" });
    expect(found.found && found.version).toBe("Google Chrome 152.0.7977.83");
  });

  it("falls back to PATH, which is the normal Linux install", async () => {
    const probes = machine({
      platform: "linux",
      fileExists: () => false,
      runCommand: (command) => {
        if (command === "google-chrome") return { stdout: "Google Chrome 141.0\n" };
        if (command === "which") return { stdout: "/usr/local/bin/google-chrome\n" };
        return undefined;
      },
    });

    const found = resolveChromePath(probes);
    expect(found).toMatchObject({ found: true, source: "path" });
    // Resolved to an absolute path, so a log or an error can say which binary
    // actually ran.
    expect(found.found && found.executablePath).toBe("/usr/local/bin/google-chrome");
  });

  it("uses `where` rather than `which` on Windows", async () => {
    const asked: string[] = [];
    const probes = machine({
      platform: "win32",
      fileExists: () => false,
      runCommand: (command) => {
        asked.push(command);
        if (command === "chromium") return { stdout: "Chromium 141\n" };
        if (command === "where") return { stdout: "C:\\tools\\chromium.exe\n" };
        return undefined;
      },
    });

    expect(resolveChromePath(probes)).toMatchObject({ found: true, source: "path" });
    expect(asked).toContain("where");
    expect(asked).not.toContain("which");
  });

  it("never spawns a shell builtin, since probes run without a shell", async () => {
    // `command -v` would be the obvious locator and would silently never work.
    const asked: string[] = [];
    const probes = machine({
      platform: "linux",
      fileExists: () => false,
      runCommand: (command) => {
        asked.push(command);
        return command === "google-chrome" ? { stdout: "Google Chrome 141.0\n" } : undefined;
      },
    });

    resolveChromePath(probes);
    expect(asked).not.toContain("command");
  });

  it("honours an explicit path over anything detected", async () => {
    const probes = machine({ fileExists: () => true, env: {} });
    const found = resolveChromePath(probes, "/opt/chrome-for-testing/chrome");
    expect(found).toMatchObject({
      found: true,
      source: "configured",
      executablePath: "/opt/chrome-for-testing/chrome",
    });
  });

  it("reads the same environment variable doctor documents", async () => {
    const probes = machine({
      fileExists: () => true,
      env: { [CHROME_PATH_ENV]: "/opt/custom/chrome" },
    });
    expect(resolveChromePath(probes)).toMatchObject({
      executablePath: "/opt/custom/chrome",
      source: "configured",
    });
  });

  it("refuses to substitute a Chrome the user did not choose", async () => {
    // The configured binary is missing but a bundle exists. Falling back would
    // make every observation describe a browser the user did not select.
    const probes = machine({
      fileExists: (path) => path.startsWith("/Applications"),
      env: { [CHROME_PATH_ENV]: "/opt/missing/chrome" },
    });

    const found = resolveChromePath(probes);
    expect(found.found).toBe(false);
    expect(found.found === false && found.reason).toContain("/opt/missing/chrome");
    expect(found.found === false && found.remedy).toContain(CHROME_PATH_ENV);
  });

  it("reports a fixable reason when there is no Chrome at all", async () => {
    const probes = machine({ fileExists: () => false, runCommand: () => undefined });
    const found = resolveChromePath(probes);

    expect(found.found).toBe(false);
    expect(found.found === false && found.remedy).toContain(CHROME_PATH_ENV);
  });

  it("still reports a binary that cannot state its version", async () => {
    // A Chrome that fails `--version` may still drive fine; refusing to use it
    // would be stricter than the evidence warrants.
    const bundle = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    const probes = machine({ runCommand: () => undefined });
    const found = resolveChromePath(probes);

    expect(found).toMatchObject({ found: true, executablePath: bundle });
    expect(found.found && found.version).toBeUndefined();
  });
});
