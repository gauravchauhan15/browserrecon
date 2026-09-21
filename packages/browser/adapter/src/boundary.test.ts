import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ADAPTER_ACTIONS } from "./types.js";
import { policyActionFor } from "./puppeteer-adapter.js";
import { PERMITTED_ACTIONS } from "@browserrecon/policy";

/**
 * The two structural guarantees this package exists to provide, asserted
 * mechanically rather than left to review.
 */

const stripComments = (code: string): string =>
  code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("the interface names no driver type", () => {
  it("has puppeteer nowhere in its generated declarations", async () => {
    // §5.1's substitutability requirement. V5 adds a Chrome DevTools MCP
    // implementation beside the Puppeteer one, and that only works if nothing
    // above this package has a Puppeteer type in scope. Checking the emitted
    // .d.ts rather than the source, because a type can leak through an
    // inferred return type that the source never names.
    const declarations = fileURLToPath(new URL("../dist/types.d.ts", import.meta.url));
    expect(
      existsSync(declarations),
      "run `pnpm run build` first — this asserts against emitted declarations",
    ).toBe(true);

    // Comments stripped first. The claim is about types, and the module's own
    // doc comment explains at length why Puppeteer must not appear here —
    // which the first version of this test dutifully flagged as a violation.
    const emitted = stripComments(readFileSync(declarations, "utf8"));
    expect(emitted.toLowerCase()).not.toContain("puppeteer");
    // The driver's own vocabulary, in case it arrives under another import.
    for (const leak of ["ElementHandle", "CDPSession", "HTTPResponse", "Frame"]) {
      expect(emitted, `${leak} leaked into the control interface`).not.toContain(leak);
    }
  });

  it("keeps the driver out of the package's public entry point too", async () => {
    const declarations = fileURLToPath(new URL("../dist/index.d.ts", import.meta.url));
    const emitted = stripComments(readFileSync(declarations, "utf8"));

    // index.d.ts re-exports the concrete adapter, whose *options* legitimately
    // reference a BrowserSession. What must not appear is a puppeteer import:
    // the re-export is by name, so the driver's types stay behind the manager.
    expect(emitted.toLowerCase()).not.toContain("from 'puppeteer");
    expect(emitted.toLowerCase()).not.toContain('from "puppeteer');
  });
});

describe("actions line up with the policy's vocabulary", () => {
  it("proposes only actions the Policy Engine recognises", async () => {
    // An adapter action the engine does not know is denied as
    // `action_not_recognised` — a confusing failure that looks like a policy
    // decision but is a wiring mistake.
    for (const action of ADAPTER_ACTIONS) {
      expect(
        PERMITTED_ACTIONS as readonly string[],
        `the engine does not recognise "${policyActionFor(action)}" (for adapter action "${action}")`,
      ).toContain(policyActionFor(action));
    }
  });
});
