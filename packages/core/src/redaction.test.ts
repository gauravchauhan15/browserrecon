import { describe, expect, it } from "vitest";
import { REDACTED, createRedactor } from "./redaction.js";

const redactor = createRedactor();

describe("sensitive keys", () => {
  it.each([
    "password",
    "passwd",
    "pwd",
    "secret",
    "token",
    "authorization",
    "cookie",
    "credential",
    "apikey",
    "api_key",
    "access_key",
    "private_key",
    "totp",
    "cvv",
    "ssn",
    "user_password",
    "auth-token",
    "session.cookie",
    "refresh_token",
    "BROWSERRECON_PASSWORD",
  ])("redacts a value under key %s", (key) => {
    expect(redactor.redact({ [key]: "hunter2" })).toEqual({ [key]: REDACTED });
  });

  it("leaves ordinary keys alone", () => {
    // Over-redaction makes output useless and trains people to turn it off.
    const input = {
      url: "https://shop.example.com/cart",
      method: "GET",
      status: 200,
      duration_ms: 42,
      tokenizer: "not a secret",
      author: "someone",
    };
    expect(redactor.redact(input)).toEqual(input);
  });

  it("never redacts a correlation identifier", () => {
    // These broke for real: `session` and `auth` in the key pattern blanked
    // session_id and auth_context. Losing them makes every log line and every
    // event unattributable — silently, while the output still looks fine.
    // Over-redaction is a failure, not the safe direction.
    const identifiers = {
      session_id: "sess_0001",
      event_id: "evt_000042",
      page_id: "page_0007",
      navigation_id: "nav_0003",
      workflow_id: "wf_0002",
      request_id: "req_000188",
      api_id: "api_0042",
      // §12.3: an auth *profile name*, not a credential.
      auth_context: "staging-admin",
    };
    expect(redactor.redact(identifiers)).toEqual(identifiers);
  });

  it("still redacts genuinely sensitive session and auth fields", () => {
    // Dropping `session` and `auth` from the pattern must not open a hole:
    // the dangerous variants are caught by cookie/token/authorization.
    expect(
      redactor.redact({
        session_cookie: "abc",
        session_token: "def",
        authorization: "Bearer ghi",
      }),
    ).toEqual({
      session_cookie: REDACTED,
      session_token: REDACTED,
      authorization: REDACTED,
    });
  });

  it("redacts at any depth", () => {
    const input = { request: { headers: { authorization: "Bearer abc123def456" } } };
    expect(redactor.redact(input)).toEqual({
      request: { headers: { authorization: REDACTED } },
    });
  });

  it("redacts inside arrays", () => {
    expect(redactor.redact([{ password: "a" }, { password: "b" }])).toEqual([
      { password: REDACTED },
      { password: REDACTED },
    ]);
  });
});

describe("sensitive values", () => {
  it("redacts a JWT wherever it appears", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    // Under an innocuous key, so only value matching can catch it.
    const output = redactor.redact({ note: `the response contained ${jwt}` });
    expect(JSON.stringify(output)).not.toContain("eyJhbGciOi");
    expect(JSON.stringify(output)).toContain(REDACTED);
  });

  it("redacts an Authorization credential in free text", () => {
    const output = redactor.redactString("sent header Bearer sk-abcdefghijklmnop123456");
    expect(output).not.toContain("abcdefghijklmnop");
    expect(output).toContain(REDACTED);
  });

  it("redacts a PEM private key block", () => {
    const pem =
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQ\n-----END RSA PRIVATE KEY-----";
    expect(redactor.redactString(`key: ${pem}`)).not.toContain("MIIEowIBAAKCAQ");
  });

  it.each([
    ["stripe", "sk_live_abcdefghijklmnop1234"],
    ["github", "ghp_abcdefghijklmnopqrstuvwxyz0123456789"],
    ["aws", "AKIAIOSFODNN7EXAMPLE"],
  ])("redacts a %s-style key", (_vendor, key) => {
    expect(redactor.redactString(`found ${key} in bundle.js`)).not.toContain(key);
  });

  it("strips credentials from a URL but keeps the scheme and host", () => {
    // `https://[redacted]@host/path` is far more useful than losing the URL.
    const output = redactor.redactString("fetching https://admin:hunter2@shop.example.com/api");
    expect(output).not.toContain("hunter2");
    expect(output).not.toContain("admin:");
    expect(output).toContain("https://");
    expect(output).toContain("shop.example.com");
  });
});

describe("structural safety", () => {
  it("truncates a very long string rather than logging a whole body", () => {
    const long = "x".repeat(5000);
    const output = redactor.redactString(long);
    expect(output.length).toBeLessThan(700);
    expect(output).toContain("truncated");
  });

  it("never mutates its input", () => {
    // The caller may still need the original: this is a log path, not an
    // owner of the data.
    const input = { password: "hunter2", nested: { token: "abc" } };
    redactor.redact(input);
    expect(input.password).toBe("hunter2");
    expect(input.nested.token).toBe("abc");
  });

  it("stops at a depth limit instead of recursing forever", () => {
    const cyclic: Record<string, unknown> = { name: "root" };
    cyclic.self = cyclic;
    expect(() => redactor.redact(cyclic)).not.toThrow();
    expect(JSON.stringify(redactor.redact(cyclic))).toContain("max depth");
  });

  it("redacts an Error's message and stack", () => {
    const error = new Error("login failed for Bearer sk_live_abcdefghijklmnop1234");
    const output = redactor.redact(error) as { message: string; stack?: string };
    expect(output.message).not.toContain("sk_live");
    expect(output.stack ?? "").not.toContain("sk_live");
  });

  it("passes primitives through untouched", () => {
    expect(redactor.redact(42)).toBe(42);
    expect(redactor.redact(true)).toBe(true);
    expect(redactor.redact(null)).toBe(null);
    expect(redactor.redact(undefined)).toBe(undefined);
  });

  it("renders a Date and a URL as strings rather than walking them", () => {
    expect(redactor.redact(new Date("2026-09-11T00:00:00Z"))).toBe("2026-09-11T00:00:00.000Z");
    expect(redactor.redact(new URL("https://shop.example.com/a"))).toBe(
      "https://shop.example.com/a",
    );
  });
});

describe("configuration", () => {
  it("accepts extra key patterns from user config", () => {
    const custom = createRedactor({ keyPatterns: [/internal_ref/i] });
    expect(custom.redact({ internal_ref: "ABC" })).toEqual({ internal_ref: REDACTED });
    expect(redactor.redact({ internal_ref: "ABC" })).toEqual({ internal_ref: "ABC" });
  });

  it("accepts extra value patterns", () => {
    const custom = createRedactor({ valuePatterns: [/CUST-\d{6}/g] });
    expect(custom.redactString("customer CUST-123456 seen")).not.toContain("CUST-123456");
  });

  it("honours a configured string cap", () => {
    const custom = createRedactor({ maxStringLength: 10 });
    expect(custom.redactString("x".repeat(50))).toContain("truncated");
  });

  it("reuses global regexes safely across calls", () => {
    // A /g regex carries lastIndex between uses; forgetting to reset it makes
    // redaction intermittently miss — the worst possible failure mode here.
    const secret = "Bearer sk_live_abcdefghijklmnop1234";
    for (let i = 0; i < 5; i++) {
      expect(redactor.redactString(secret), `call ${i}`).not.toContain("abcdefghijklmnop");
    }
  });
});
