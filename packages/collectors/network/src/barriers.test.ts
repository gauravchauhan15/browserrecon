import { describe, expect, it } from "vitest";
import { BARRIER_CATEGORIES, classifyBarrier, shouldAbortScan } from "./barriers.js";

const at = (
  overrides: Parameters<typeof classifyBarrier>[0] extends never
    ? never
    : Partial<Parameters<typeof classifyBarrier>[0]> = {},
) => classifyBarrier({ url: "https://app.test/x", ...overrides });

describe("the taxonomy", () => {
  it("separates 401 without auth from 401 after losing it", async () => {
    // §12.3: the first means we never had auth, the second that we had it
    // and lost it mid-scan. They need different actions from the user.
    expect(at({ status: 401 })?.category).toBe("authentication_required");
    expect(at({ status: 401, hadAuthContext: true })?.category).toBe("auth_state_lost");
  });

  it("classifies the plain status codes", async () => {
    expect(at({ status: 403 })?.category).toBe("forbidden");
    expect(at({ status: 429 })?.category).toBe("rate_limited");
    expect(at({ status: 451 })?.category).toBe("geo_restricted");
  });

  it("maps typed network failures onto the right barrier", async () => {
    expect(at({ failureReason: "certificate_invalid" })?.category).toBe("tls_error");
    expect(at({ failureReason: "dns_failed" })?.category).toBe("network_unreachable");
  });

  it("says nothing about an ordinary response", async () => {
    expect(at({ status: 200, bodyBytes: 40_000, mimeType: "text/html" })).toBeUndefined();
    expect(at({ status: 404 })).toBeUndefined();
  });
});

describe("a challenge is not a plain forbidden", () => {
  it("reads a challenge page served with a 403 as a challenge", async () => {
    // Order matters: a challenge arrives with a 403 more often than not, and
    // reporting it as forbidden sends the user to change their credentials
    // rather than their approach.
    const barrier = at({
      status: 403,
      body: "<html><title>Just a moment...</title><body>Checking your browser</body></html>",
    });
    expect(barrier?.category).toBe("challenge_detected");
  });

  it("recognises a CAPTCHA", async () => {
    expect(at({ status: 200, body: "please complete the recaptcha" })?.category).toBe(
      "challenge_detected",
    );
  });

  it("recognises a WAF by its header on an error", async () => {
    expect(at({ status: 503, headers: { "cf-ray": "abc" } })?.category).toBe(
      "challenge_detected",
    );
  });

  it("does not call an ordinary Cloudflare-fronted 200 a challenge", async () => {
    // Most of the web sits behind a CDN. The header alone is not a barrier.
    expect(
      at({ status: 200, headers: { "cf-ray": "abc" }, bodyBytes: 50_000 }),
    ).toBeUndefined();
  });
});

describe("bot detection is its own category", () => {
  it("reads a near-empty 200 to automated Chrome as automation blocked", async () => {
    // §8.6: the surface exists and it was our automation that was refused.
    // "Unreachable" understates the target; "success" overstates coverage.
    const barrier = at({ status: 200, bodyBytes: 120, mimeType: "text/html" });
    expect(barrier?.category).toBe("automation_signature_blocked");
    expect(barrier?.evidence).toContain("120 bytes");
  });

  it("is distinct from a challenge, because the remedy differs", async () => {
    const bot = at({ status: 200, bodyBytes: 100, mimeType: "text/html" });
    const challenge = at({ status: 403, body: "captcha" });
    expect(bot?.category).not.toBe(challenge?.category);
    expect(bot?.remedy).toContain("headed");
  });

  it("does not fire on a small non-HTML response", async () => {
    // A 40-byte JSON API response is a normal answer.
    expect(at({ status: 200, bodyBytes: 40, mimeType: "application/json" })).toBeUndefined();
  });
});

describe("no bypass, anywhere", () => {
  it("never suggests getting around a defence", async () => {
    // §7.3. Suggesting circumvention in a report is the same thing as doing
    // it, one step removed.
    const forbidden =
      /bypass|circumvent|evade|rotate|spoof|solve the captcha|different user.?agent/i;
    for (const barrier of [
      at({ status: 403, body: "captcha" }),
      at({ status: 403 }),
      at({ status: 200, bodyBytes: 50, mimeType: "text/html" }),
      at({ status: 429 }),
    ]) {
      expect(barrier?.remedy ?? "", barrier?.category).not.toMatch(forbidden);
    }
  });

  it("never aborts the scan", async () => {
    // §33: a barrier is reconnaissance data and the remaining scope
    // continues.
    for (const category of BARRIER_CATEGORIES) {
      expect(
        shouldAbortScan({
          category,
          url: "https://app.test/x",
          evidence: "x",
          retryable: false,
        }),
      ).toBe(false);
    }
  });
});

describe("retryability", () => {
  it("marks what could plausibly succeed later", async () => {
    expect(at({ status: 429 })?.retryable).toBe(true);
    expect(at({ failureReason: "connection_reset" })?.retryable).toBe(true);
    expect(at({ status: 401 })?.retryable).toBe(false);
    expect(at({ status: 403, body: "captcha" })?.retryable).toBe(false);
  });
});
