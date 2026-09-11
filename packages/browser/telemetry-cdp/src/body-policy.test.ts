import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  BODY_CAPTURE_RULES,
  renderCaptureTable,
  DEFAULT_BODY_LIMITS,
  shouldCaptureBody,
  type BodyCaptureLimits,
} from "./body-policy.js";

const limits = (overrides: Partial<BodyCaptureLimits> = {}): BodyCaptureLimits => ({
  ...DEFAULT_BODY_LIMITS,
  ...overrides,
});

const ask = (
  mimeType: string | undefined,
  overrides: Partial<Parameters<typeof shouldCaptureBody>[0]> = {},
) =>
  shouldCaptureBody({
    mimeType,
    encodedDataLength: undefined,
    bytesSoFar: 0,
    limits: limits(),
    ...overrides,
  });

describe("what is worth keeping", () => {
  it("keeps API responses, which are the surface being modelled", async () => {
    for (const type of [
      "application/json",
      "application/vnd.api+json",
      "application/json; charset=utf-8",
    ]) {
      expect(ask(type).capture, type).toBe(true);
    }
  });

  it("keeps JavaScript, because endpoints hide there and nowhere else", async () => {
    // §10A: a URL only ever written inside a bundle is invisible without the
    // source.
    for (const type of ["text/javascript", "application/javascript"]) {
      expect(ask(type).capture, type).toBe(true);
    }
  });

  it("keeps HTML, where the forms and links are", async () => {
    expect(ask("text/html").capture).toBe(true);
  });

  it("keeps images, fonts and media out — §41's metadata-only rule", async () => {
    // The bulk is the entire problem: keeping it makes the event log unusable
    // and adds nothing a scanner reads.
    for (const type of ["image/png", "font/woff2", "video/mp4", "audio/mpeg"]) {
      const decision = ask(type);
      expect(decision.capture, type).toBe(false);
      expect(decision.capture === false && decision.reason).toBe("policy");
    }
  });

  it("keeps opaque binary out", async () => {
    expect(ask("application/octet-stream").capture).toBe(false);
    expect(ask("application/pdf").capture).toBe(false);
  });

  it("skips a response that declares no content type", async () => {
    // Conservative: an unknown type is more often a download than an API.
    expect(ask(undefined).capture).toBe(false);
    expect(ask("").capture).toBe(false);
  });

  it("skips an unknown content type rather than guessing", async () => {
    const decision = ask("application/x-custom-thing");
    expect(decision.capture).toBe(false);
    expect(decision.capture === false && decision.detail).toContain("x-custom-thing");
  });
});

describe("the two limits", () => {
  it("refuses an oversized body before fetching it", async () => {
    // Checked against Chrome's reported length so a 40 MB bundle is never
    // pulled into memory just to be discarded.
    const decision = ask("application/json", {
      encodedDataLength: 2 * 1024 * 1024,
      limits: limits({ maxBodyBytes: 1024 }),
    });
    expect(decision.capture).toBe(false);
    expect(decision.capture === false && decision.reason).toBe("too_large");
  });

  it("stops when the scan's total budget is spent", async () => {
    // The per-body cap does not stop ten thousand small bodies. This does.
    const decision = ask("application/json", {
      bytesSoFar: 1_000,
      limits: limits({ maxTotalBytes: 1_000 }),
    });
    expect(decision.capture).toBe(false);
    expect(decision.capture === false && decision.reason).toBe("budget_exhausted");
  });

  it("distinguishes the two, because they mean different things to a reader", async () => {
    // "too_large" says this response was big; "budget_exhausted" says the log
    // is complete but thinner from here on. Collapsing them loses that.
    const tooLarge = ask("application/json", {
      encodedDataLength: 10_000,
      limits: limits({ maxBodyBytes: 100 }),
    });
    const spent = ask("application/json", {
      bytesSoFar: 999_999,
      limits: limits({ maxTotalBytes: 1_000 }),
    });
    expect(tooLarge.capture === false && tooLarge.reason).not.toBe(
      spent.capture === false && spent.reason,
    );
  });

  it("can be switched off entirely", async () => {
    const decision = ask("application/json", { limits: limits({ enabled: false }) });
    expect(decision.capture).toBe(false);
    expect(decision.capture === false && decision.reason).toBe("disabled");
  });
});

describe("the rule set", () => {
  it("states a reason for every rule", async () => {
    for (const rule of BODY_CAPTURE_RULES) {
      expect(rule.why.length, rule.pattern.source).toBeGreaterThan(20);
    }
  });

  it("is documented in the README without drift", async () => {
    // The README is where someone decides whether the rule set is reasonable,
    // so a stale table there is worse than none. Cell contents are compared
    // rather than bytes, because prettier reformats markdown alignment and a
    // byte comparison would fail on whitespace nobody chose.
    const readme = readFileSync(
      fileURLToPath(new URL("../README.md", import.meta.url)),
      "utf8",
    );
    const marker = "<!-- generated from BODY_CAPTURE_RULES";
    const after = readme.slice(readme.indexOf(marker));
    expect(after, "README lost its generated-table marker").not.toBe(readme);

    // Split on unescaped pipes only: a regex alternation contains one.
    const cells = (row: string): string[] =>
      row
        .split(/(?<!\\)\|/)
        .slice(1, -1)
        .map((cell) => cell.trim());

    const documented = after.split("\n\n")[1]?.split("\n").slice(2).map(cells);
    const generated = renderCaptureTable().split("\n").slice(2).map(cells);
    expect(documented).toEqual(generated);
  });

  it("pins the capture surface, so a change is a deliberate diff", async () => {
    // Widening what is kept has a cost measured in gigabytes; narrowing it
    // silently removes evidence a later stage depends on.
    expect(BODY_CAPTURE_RULES.filter((rule) => rule.capture).length).toBe(4);
    expect(BODY_CAPTURE_RULES.filter((rule) => !rule.capture).length).toBe(2);
  });
});
