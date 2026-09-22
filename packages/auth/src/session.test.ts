import { describe, expect, it } from "vitest";
import {
  ALWAYS_REFUSED,
  createSessionTracker,
  evaluateAuthState,
  looksLikeLiveSecret,
  parseTestDataProfile,
  valueFor,
  type TestDataProfile,
} from "./index.js";

const signals = { urlContains: "/dashboard", cookieSet: "session" };

describe("§12.3: reading the auth state from evidence", () => {
  it("is authenticated when every stated condition holds", () => {
    const verdict = evaluateAuthState(
      { url: "https://app.example.com/dashboard", cookieNames: ["session", "csrf"] },
      signals,
    );
    expect(verdict.state).toBe("authenticated");
  });

  it("requires every condition, not any", () => {
    // A profile that named two signals meant both. Treating them as
    // alternatives lets a scan stay "authenticated" on a URL while the page
    // shows a login form.
    const verdict = evaluateAuthState(
      { url: "https://app.example.com/dashboard", cookieNames: [] },
      signals,
    );
    expect(verdict.state).toBe("expired");
    expect(verdict.signal).toContain("session");
  });

  it("reads a 401 as an expired session, not a generic error", () => {
    // §12.3 point 2. A 401 on a route reachable a minute ago is the
    // clearest possible statement that the session is gone.
    expect(evaluateAuthState({ status: 401 }, signals).state).toBe("expired");
  });

  it("reads a redirect to a login page as expiry", () => {
    expect(evaluateAuthState({ redirectedToLogin: true }, signals).state).toBe("expired");
    expect(
      evaluateAuthState({ url: "https://app.example.com/login?next=/x" }, signals).state,
    ).toBe("expired");
  });

  it("states the signal that decided it", () => {
    // §12.3 point 2 needs the reason, not a flag: a report saying "session
    // expired" without saying how is one nobody can check.
    expect(evaluateAuthState({ status: 401 }, signals).signal).toContain("401");
  });

  it("declines to guess when there is no condition to check", () => {
    expect(evaluateAuthState({ url: "https://app.example.com/x" }, {}).state).toBe("anonymous");
  });
});

describe("§12.3: the tracker", () => {
  const tracker = () =>
    createSessionTracker({
      profileName: "staging-admin",
      signals,
      maxReauthentications: 2,
      now: () => new Date("2026-01-15T10:00:00.000Z"),
    });

  const signedIn = { url: "https://app.example.com/dashboard", cookieNames: ["session"] };

  it("stamps observations with the profile only while authenticated", () => {
    // §12.3 point 4. An observation made after a session was lost must not
    // carry a label saying it was made as that user.
    const session = tracker();
    expect(session.authContext).toBe("anonymous");

    session.observe(signedIn, 10);
    expect(session.authContext).toBe("staging-admin");

    session.observe({ status: 401 }, 50);
    expect(session.authContext).toBe("anonymous");
  });

  it("records where coverage changed, by envelope sequence", () => {
    const session = tracker();
    session.observe(signedIn, 10);
    const lost = session.observe({ status: 401 }, 137);

    expect(lost?.from).toBe("authenticated");
    expect(lost?.to).toBe("expired");
    expect(lost?.sequence).toBe(137);
  });

  it("reports a transition only when the state actually changed", () => {
    const session = tracker();
    session.observe(signedIn, 1);
    expect(session.observe(signedIn, 2)).toBeUndefined();
    expect(session.transitions).toHaveLength(1);
  });

  it("bounds re-authentication so a broken app cannot cause a loop", () => {
    // §12.3 point 3.
    const session = tracker();
    session.observe(signedIn, 1);
    session.observe({ status: 401 }, 2);

    expect(session.mayReauthenticate()).toBe(true);
    session.recordReauthentication(false, 3);
    expect(session.mayReauthenticate()).toBe(true);
    session.recordReauthentication(false, 4);
    expect(session.mayReauthenticate()).toBe(false);
  });

  it("recovers cleanly when re-authentication works", () => {
    const session = tracker();
    session.observe(signedIn, 1);
    session.observe({ status: 401 }, 2);
    session.recordReauthentication(true, 3);

    expect(session.state).toBe("authenticated");
    expect(session.authContext).toBe("staging-admin");
    expect(session.degradedAt).toBeUndefined();
  });

  it("marks the point past which coverage is unauthenticated", () => {
    // §12.3 point 5: never silently continue as if nothing happened. The
    // failure this prevents is a report saying /admin/users returned 302,
    // read as "properly protected" when it means "we were logged out".
    const session = tracker();
    session.observe(signedIn, 1);
    session.observe({ status: 401 }, 2);
    session.recordReauthentication(false, 3);
    session.recordReauthentication(false, 4);

    expect(session.degradedAt).toBeDefined();
    expect(session.degradedAt?.sequence).toBe(4);
    expect(session.authContext).toBe("anonymous");
  });

  it("does not re-report every later observation as a fresh loss", () => {
    // One transition is the story. Re-reporting each observation would bury
    // the moment that matters under a hundred identical lines.
    const session = tracker();
    session.observe(signedIn, 1);
    session.observe({ status: 401 }, 2);
    session.recordReauthentication(false, 3);
    session.recordReauthentication(false, 4);

    const before = session.transitions.length;
    for (let n = 5; n < 20; n += 1) session.observe({ status: 401 }, n);
    expect(session.transitions).toHaveLength(before);
  });

  it("still notices if the session comes back", () => {
    const session = tracker();
    session.observe(signedIn, 1);
    session.observe({ status: 401 }, 2);
    session.recordReauthentication(false, 3);
    session.recordReauthentication(false, 4);

    session.observe(signedIn, 30);
    expect(session.state).toBe("authenticated");
  });
});

describe("§12.5: test data profiles", () => {
  const profile: TestDataProfile = {
    name: "staging-test-data",
    fields: [
      { match: { namePattern: "card|cc_number|payment" }, valueEnv: "BROWSERRECON_TEST_CARD" },
      { match: { namePattern: "cvv|cvc" }, value: "123" },
      { match: { namePattern: "zip|postcode" }, value: "SW1A 1AA" },
      { match: { inputType: "email" }, value: "qa@example.com" },
    ],
    neverFill: [{ namePattern: "coupon" }],
  };

  const env = { BROWSERRECON_TEST_CARD: "4242424242424242" };

  it("fills a field a rule matches", () => {
    const decision = valueFor(profile, { name: "cvv" }, env);
    expect(decision).toMatchObject({ fill: true, value: "123", fromEnv: false });
  });

  it("takes a sensitive value from the environment", () => {
    const decision = valueFor(profile, { name: "cc_number" }, env);
    expect(decision).toMatchObject({ fill: true, value: "4242424242424242", fromEnv: true });
  });

  it("matches on input type as well as name", () => {
    expect(valueFor(profile, { name: "contact", type: "email" }, env)).toMatchObject({
      fill: true,
      value: "qa@example.com",
    });
  });

  it("leaves a field empty when its variable is unset, naming the variable", () => {
    const decision = valueFor(profile, { name: "card" }, {});
    expect(decision.fill).toBe(false);
    if (decision.fill) return;
    expect(decision.reason).toContain("BROWSERRECON_TEST_CARD");
  });

  it("says why it filled nothing, so a gap can be told from a boundary", () => {
    const decision = valueFor(profile, { name: "nickname" }, env);
    expect(decision.fill).toBe(false);
    if (decision.fill) return;
    expect(decision.reason).toContain("no rule matched");
  });

  it("honours the profile's never_fill list over any match", () => {
    const withCoupon: TestDataProfile = {
      ...profile,
      fields: [...profile.fields, { match: { namePattern: "coupon" }, value: "FREE" }],
    };
    const decision = valueFor(withCoupon, { name: "coupon_code" }, env);
    expect(decision.fill).toBe(false);
    if (decision.fill) return;
    expect(decision.reason).toContain("never_fill");
  });

  it("refuses a destructive field even when the profile matches everything", () => {
    // The floor under the user's own list. Someone will write `.*`, and that
    // must not type a value into `confirm_delete`.
    const greedy: TestDataProfile = {
      name: "greedy",
      fields: [{ match: { namePattern: ".*" }, value: "yes" }],
      neverFill: [],
    };
    // Every spelling a field name actually uses. Found by a test: a pattern
    // written `/\bpurge\b/` misses `purge_data`, because `_` is a word
    // character — so the majority spelling slipped straight through.
    for (const name of [
      "confirm_delete",
      "delete_account",
      "transfer_amount",
      "purge_data",
      "purgeData",
      "wipe-everything",
      "confirmDestroy",
      "terminateSubscription",
    ]) {
      const decision = valueFor(greedy, { name }, env);
      expect(decision.fill, name).toBe(false);
    }
  });

  it("checks the destructive floor before any matching runs", () => {
    // Precedence as an early return rather than list ordering: a precedence
    // expressed as "the deny list is evaluated second" is one a refactor
    // reorders silently.
    expect(ALWAYS_REFUSED.length).toBeGreaterThan(3);
    const decision = valueFor(profile, { name: "delete_me", label: "Delete" }, env);
    expect(decision.fill).toBe(false);
  });

  it("fills nothing for a rule with no criteria", () => {
    const empty: TestDataProfile = {
      name: "x",
      fields: [{ match: {}, value: "y" }],
      neverFill: [],
    };
    expect(valueFor(empty, { name: "anything" }, env).fill).toBe(false);
  });

  it("does not match everything when a pattern is broken", () => {
    const broken: TestDataProfile = {
      name: "x",
      fields: [{ match: { namePattern: "([unclosed" }, value: "y" }],
      neverFill: [],
    };
    expect(valueFor(broken, { name: "anything" }, env).fill).toBe(false);
  });

  it("is deterministic, so golden tests stay stable", () => {
    // §36.2. A profile that generated values would make every report differ.
    const first = valueFor(profile, { name: "postcode" }, env);
    const second = valueFor(profile, { name: "postcode" }, env);
    expect(first).toEqual(second);
  });
});

describe("parsing a test data profile", () => {
  const base = {
    name: "staging-test-data",
    fields: [{ match: { name_pattern: "cvv" }, value: "123" }],
    never_fill: [{ name_pattern: "delete" }],
  };

  it("accepts the shape §12.5 documents", () => {
    const result = parseTestDataProfile(base);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.profile.fields[0]?.match.namePattern).toBe("cvv");
    expect(result.profile.neverFill).toHaveLength(1);
  });

  it("refuses a rule with both a value and a variable", () => {
    const result = parseTestDataProfile({
      ...base,
      fields: [{ match: { name_pattern: "x" }, value: "a", value_env: "B" }],
    });
    expect(result.ok).toBe(false);
  });

  it("refuses a rule that matches everything", () => {
    const result = parseTestDataProfile({ ...base, fields: [{ match: {}, value: "a" }] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems[0]?.reason).toContain("every field");
  });

  it("refuses an inline value that looks like a live credential", () => {
    // Test data profiles are meant to be committed, which is exactly why an
    // inline secret in one is worse than in an auth profile.
    const result = parseTestDataProfile({
      ...base,
      fields: [{ match: { name_pattern: "key" }, value: "sk_live_abcdefghijklmnopqrstuvwxyz" }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems[0]?.reason).toContain("value_env");
  });

  it("lets the safe test values through", () => {
    // A false positive here blocks a legitimate profile. Stripe's own test
    // card, a postcode and a CVV all have to pass.
    for (const value of [
      "4242424242424242",
      "123",
      "SW1A 1AA",
      "+15555550100",
      "qa@example.com",
    ]) {
      expect(looksLikeLiveSecret(value), value).toBe(false);
    }
  });

  it("recognises the shapes that are only ever real", () => {
    for (const value of [
      "sk_live_abcdefghijklmnopqrstuvwxyz",
      "ghp_abcdefghijABCDEFGHIJabcdefghijABCD",
      "AKIAIOSFODNN7EXAMPLE",
      "-----BEGIN RSA PRIVATE KEY-----",
    ]) {
      expect(looksLikeLiveSecret(value), value).toBe(true);
    }
  });
});
