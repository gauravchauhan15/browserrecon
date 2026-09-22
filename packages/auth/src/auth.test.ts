import { describe, expect, it } from "vitest";
import {
  MFA_TYPES,
  decodeBase32,
  hotp,
  parseAuthProfile,
  resolveSecrets,
  secondsRemaining,
  shouldWaitForNextCode,
  totp,
  type AuthProfile,
} from "./index.js";

const valid = {
  name: "staging-admin",
  login: { url: "https://staging.example.com/login" },
  credentials: {
    username_env: "BROWSERRECON_USERNAME",
    password_env: "BROWSERRECON_PASSWORD",
  },
  success_condition: { url_contains: "/dashboard" },
};

const parsed = (raw: unknown) => parseAuthProfile(raw);

describe("§12.1: a profile has nowhere to put a secret", () => {
  it("accepts a profile that names environment variables", () => {
    const result = parsed(valid);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.profile.credentials.passwordEnv).toBe("BROWSERRECON_PASSWORD");
  });

  it("refuses an inline password", () => {
    // Not a recommendation — a refusal. A documented rule is one a hurried
    // user works around, and a YAML file with a password in it ends up in
    // git.
    const result = parsed({
      ...valid,
      credentials: { ...valid.credentials, password: "hunter2" },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems.some((p) => p.field.endsWith("password"))).toBe(true);
    expect(result.problems[0]?.reason).toContain("_env");
  });

  it("refuses a secret nested anywhere, not just at the top", () => {
    // `login.credentials.password` is the same mistake one level down.
    for (const raw of [
      { ...valid, login: { ...valid.login, password: "x" } },
      { ...valid, mfa: { type: "totp", totp_secret: "JBSWY3DP" } },
      { ...valid, extras: { nested: { token: "abc" } } },
    ]) {
      expect(parsed(raw).ok, JSON.stringify(raw).slice(0, 60)).toBe(false);
    }
  });

  it("never echoes a value it refused", () => {
    // An error message is a place secrets leak into logs.
    const result = parsed({
      ...valid,
      credentials: { ...valid.credentials, password: "hunter2" },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(JSON.stringify(result.problems)).not.toContain("hunter2");
  });

  it("requires the env names to look like env names", () => {
    const result = parsed({
      ...valid,
      credentials: { username_env: "not-an-env-name", password_env: "X" },
    });
    expect(result.ok).toBe(false);
  });

  it("warns when credentials would cross plain HTTP, but allows localhost", () => {
    expect(parsed({ ...valid, login: { url: "http://staging.example.com/login" } }).ok).toBe(
      false,
    );
    expect(parsed({ ...valid, login: { url: "http://localhost:3000/login" } }).ok).toBe(true);
    expect(parsed({ ...valid, login: { url: "http://127.0.0.1:8080/login" } }).ok).toBe(true);
  });
});

describe("a profile that cannot tell success from failure is refused", () => {
  it("requires at least one success condition", () => {
    // Without one, a failed login is recorded as a successful one and every
    // later observation carries an auth context that is not true — worse
    // than not authenticating, because the output looks authoritative.
    const { success_condition: _omitted, ...rest } = valid;
    const result = parsed(rest);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems.some((p) => p.field === "successCondition")).toBe(true);
  });

  it("accepts any of the four signals", () => {
    for (const condition of [
      { url_contains: "/app" },
      { selector_present: "#sign-out" },
      { selector_absent: "form#login" },
      { cookie_set: "session" },
    ]) {
      expect(
        parsed({ ...valid, success_condition: condition }).ok,
        JSON.stringify(condition),
      ).toBe(true);
    }
  });

  it("reports every problem at once, not the first", () => {
    const result = parsed({ login: {}, credentials: {} });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems.length).toBeGreaterThan(2);
  });
});

describe("§12.2: MFA bypass is not a supported option", () => {
  it("supports exactly none and totp", () => {
    expect([...MFA_TYPES]).toEqual(["none", "totp"]);
  });

  it("refuses an unknown mfa type, naming what is supported", () => {
    const result = parsed({ ...valid, mfa: { type: "bypass" } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems[0]?.reason).toContain("bypass is not supported");
  });

  it("requires a secret variable for totp", () => {
    expect(parsed({ ...valid, mfa: { type: "totp" } }).ok).toBe(false);
    expect(
      parsed({ ...valid, mfa: { type: "totp", secret_env: "BROWSERRECON_TOTP" } }).ok,
    ).toBe(true);
  });
});

describe("reading credentials from the environment", () => {
  const profile = (parsed(valid) as { profile: AuthProfile }).profile;

  it("resolves what the profile named", () => {
    const result = resolveSecrets(profile, {
      BROWSERRECON_USERNAME: "tester",
      BROWSERRECON_PASSWORD: "s3cret",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.secrets.username).toBe("tester");
  });

  it("names the missing variable without hinting at a value", () => {
    const result = resolveSecrets(profile, {});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems.map((p) => p.variable)).toEqual([
      "BROWSERRECON_USERNAME",
      "BROWSERRECON_PASSWORD",
    ]);
    expect(result.problems[0]?.reason).toContain("staging-admin");
  });

  it("treats an empty variable as unset", () => {
    // `export BROWSERRECON_PASSWORD=` is a mistake, not a password.
    const result = resolveSecrets(profile, {
      BROWSERRECON_USERNAME: "t",
      BROWSERRECON_PASSWORD: "",
    });
    expect(result.ok).toBe(false);
  });

  it("reads the environment it is given, never the process", () => {
    // §2 rule 5. Also what makes the absent-variable path testable without
    // setting a real variable.
    const result = resolveSecrets(profile, {
      BROWSERRECON_USERNAME: "a",
      BROWSERRECON_PASSWORD: "b",
    });
    expect(result.ok).toBe(true);
  });
});

describe("TOTP (RFC 6238)", () => {
  // Appendix B's secret, base32-encoded: the ASCII "12345678901234567890".
  const SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

  it("matches the published test vectors", () => {
    // The whole point of taking the time as a parameter rather than reading
    // a clock: an implementation that cannot be checked against the RFC is
    // one nobody can check at all.
    for (const [seconds, expected] of [
      [59, "287082"],
      [1_111_111_109, "081804"],
      [1_111_111_111, "050471"],
      [1_234_567_890, "005924"],
      [2_000_000_000, "279037"],
    ] as const) {
      expect(totp(SECRET, seconds * 1000), String(seconds)).toBe(expected);
    }
  });

  it("produces the same code throughout one step and a different one after", () => {
    const inStep = totp(SECRET, 60_000);
    expect(totp(SECRET, 89_000)).toBe(inStep);
    expect(totp(SECRET, 90_000)).not.toBe(inStep);
  });

  it("decodes base32 as people actually write it", () => {
    const canonical = decodeBase32(SECRET);
    for (const written of [
      SECRET.toLowerCase(),
      "GEZD GNBV GY3T QOJQ GEZD GNBV GY3T QOJQ",
      `${SECRET}======`,
    ]) {
      expect(decodeBase32(written), written.slice(0, 20)).toEqual(canonical);
    }
  });

  it("refuses a secret that is not base32, rather than producing wrong digits", () => {
    // Silently decoding to the wrong bytes gives six plausible digits that
    // are always wrong, and the user concludes their credentials are bad.
    expect(() => decodeBase32("not!base32")).toThrow(/not base32/);
    expect(() => decodeBase32("")).toThrow(/empty/);
  });

  it("names the offending character but never the secret", () => {
    try {
      decodeBase32("JBSWY3DP1EHPK3PXP");
      expect.unreachable("should have thrown");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('"1"');
      expect(message).not.toContain("JBSWY3DP");
    }
  });

  it("counts down within a step", () => {
    expect(secondsRemaining(0)).toBe(30);
    expect(secondsRemaining(29_000)).toBe(1);
    expect(secondsRemaining(30_000)).toBe(30);
  });

  it("waits rather than submitting a code about to expire", () => {
    // A code with half a second left fails for a reason that looks like
    // wrong credentials, and a user debugging that finds nothing wrong.
    expect(shouldWaitForNextCode(28_500)).toBe(true);
    expect(shouldWaitForNextCode(10_000)).toBe(false);
  });

  it("supports the longer digests some applications use", () => {
    const six = hotp(decodeBase32(SECRET), 1, { algorithm: "sha1" });
    const sha256 = hotp(decodeBase32(SECRET), 1, { algorithm: "sha256" });
    expect(six).toHaveLength(6);
    expect(sha256).toHaveLength(6);
    expect(sha256).not.toBe(six);
  });

  it("is a generator, not a guesser", () => {
    // Stated as a test because the distinction is the whole of §12.2: this
    // module produces one code for one counter. There is no search, no
    // window scan, no retry across candidates — the shapes a bypass would
    // need.
    const source = hotp.toString() + totp.toString();
    expect(source).not.toMatch(/for\s*\(.*(?:candidate|guess|attempt|window)/i);
  });
});
