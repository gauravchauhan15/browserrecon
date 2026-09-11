import { describe, expect, it } from "vitest";
import { BASE_FLAGS, buildFlags } from "./flags.js";

describe("launch flags", () => {
  it("stops Chrome's own background networking", async () => {
    // Chrome talks to Google on startup: component updates, Safe Browsing,
    // field trials. That traffic lands in the same CDP Network stream the
    // telemetry adapter subscribes to from V1, so it would be recorded as
    // observations of the target's attack surface — and it contradicts the
    // promise (§38) that nothing leaves the machine.
    const flags = buildFlags({ headless: true });
    for (const flag of [
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-domain-reliability",
      "--no-pings",
      "--disable-sync",
    ]) {
      expect(flags, `missing ${flag}`).toContain(flag);
    }
  });

  it("disables the Safe Browsing lookups that would disclose target URLs", async () => {
    // On a private staging target, sending the URL being visited to a
    // reputation service is a disclosure, not a protection.
    const flags = buildFlags({ headless: true });
    expect(flags).toContain("--safebrowsing-disable-auto-update");
    expect(flags).toContain("--disable-client-side-phishing-detection");
  });

  it("never disables the sandbox or same-origin policy", async () => {
    // --no-sandbox is the wrong trade for a tool that drives untrusted pages,
    // and --disable-web-security would change the very behaviour being
    // observed. A container that needs the former must say so explicitly.
    const flags = buildFlags({ headless: false, extraArgs: [] });
    expect(flags).not.toContain("--no-sandbox");
    expect(flags).not.toContain("--disable-web-security");
    expect(flags).not.toContain("--disable-setuid-sandbox");
  });

  it("never sets the profile directory", async () => {
    // The isolation guarantee is passed as puppeteer's userDataDir so exactly
    // one place decides where a profile lives. A flag here — or in extraArgs —
    // could quietly point a scan at a shared profile.
    const flags = buildFlags({
      headless: true,
      extraArgs: ["--window-size=800,600"],
    });
    expect(flags.some((flag) => flag.startsWith("--user-data-dir"))).toBe(false);
    expect(BASE_FLAGS.some((flag) => flag.startsWith("--user-data-dir"))).toBe(false);
  });

  it("pins a window size only when headed", async () => {
    expect(buildFlags({ headless: false })).toContain("--window-size=1280,900");
    expect(buildFlags({ headless: true })).not.toContain("--window-size=1280,900");
  });

  it("appends caller arguments last, so they can override", async () => {
    const flags = buildFlags({ headless: true, extraArgs: ["--lang=fr-FR"] });
    expect(flags.at(-1)).toBe("--lang=fr-FR");
  });

  it("keeps timers running so page behaviour does not depend on focus", async () => {
    const flags = buildFlags({ headless: true });
    expect(flags).toContain("--disable-background-timer-throttling");
    expect(flags).toContain("--disable-renderer-backgrounding");
  });
});
