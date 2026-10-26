import { describe, expect, it } from "vitest";
import { DENIAL_REASONS, PERMITTED_ACTIONS, PolicyEngine } from "./engine.js";
import { resolveTargetPolicy } from "./resolve.js";
import type { TargetPolicy } from "./types.js";

const TARGET = "https://shop.example.com";

function engineWith(config: Record<string, unknown> = {}, origin = TARGET): PolicyEngine {
  const result = resolveTargetPolicy({ targetOrigin: origin, config });
  if (!result.ok) throw new Error(`bad policy: ${JSON.stringify(result.violations)}`);
  return new PolicyEngine(result.policy);
}

/** Assert denied and return the denial, so tests can inspect the reason. */
function denial(decision: ReturnType<PolicyEngine["canRequest"]>) {
  expect(decision.allowed).toBe(false);
  if (decision.allowed) throw new Error("expected a denial");
  return decision;
}

describe("every denial is machine-readable", () => {
  it("carries a declared reason code, a detail and a barrier category", () => {
    // BR-M0-06 acceptance criterion. A refusal has to become reconnaissance
    // data — "22 admin routes returned 403" — rather than a silent gap.
    const engine = engineWith();
    const d = denial(engine.canRequest("https://elsewhere.example.com/", "GET"));

    expect(DENIAL_REASONS).toContain(d.reason);
    expect(d.detail.length).toBeGreaterThan(0);
    expect(d.barrier).toBe("scope_excluded");
  });

  it("marks network denials as private_network_unreachable, not scope_excluded", () => {
    // Different barrier, because the coverage report must distinguish "you
    // told us not to" from "we could not reach it" (§8.6).
    const engine = engineWith({ policy: { allowedOrigins: ["http://127.0.0.1:8080"] } });
    expect(denial(engine.canVisit("http://127.0.0.1:8080/")).barrier).toBe(
      "private_network_unreachable",
    );
  });
});

describe("scope matrix", () => {
  const engine = engineWith({
    policy: { allowedOrigins: ["https://api.shop.example.com"] },
  });

  it("allows the target origin", () => {
    expect(engine.canVisit(`${TARGET}/products`).allowed).toBe(true);
  });

  it("allows a declared additional origin", () => {
    expect(engine.canVisit("https://api.shop.example.com/v1/cart").allowed).toBe(true);
  });

  it("denies an undeclared origin", () => {
    expect(denial(engine.canVisit("https://evil.example.com/")).reason).toBe(
      "origin_not_allowed",
    );
  });

  it("treats a different port as a different origin", () => {
    expect(denial(engine.canVisit("https://shop.example.com:8443/")).reason).toBe(
      "origin_not_allowed",
    );
  });

  it("treats a different scheme as a different origin", () => {
    expect(denial(engine.canVisit("http://shop.example.com/")).reason).toBe(
      "origin_not_allowed",
    );
  });

  it("denies a subdomain that was not declared", () => {
    // No implicit wildcarding: authorising shop.example.com does not
    // authorise everything under example.com.
    expect(denial(engine.canVisit("https://admin.shop.example.com/")).reason).toBe(
      "origin_not_allowed",
    );
  });

  it("denies a non-http scheme", () => {
    for (const url of ["file:///etc/passwd", "ftp://shop.example.com/", "data:text/html,x"]) {
      const d = denial(engine.canVisit(url));
      expect(["scheme_not_allowed", "origin_not_allowed", "malformed_url"]).toContain(d.reason);
    }
  });

  it("denies a malformed URL rather than assuming anything about it", () => {
    expect(denial(engine.canVisit("not a url")).reason).toBe("malformed_url");
  });
});

describe("method enforcement", () => {
  it("allows read-only methods under the default policy", () => {
    const engine = engineWith();
    for (const method of ["GET", "HEAD", "OPTIONS"] as const) {
      expect(engine.canRequest(`${TARGET}/`, method).allowed, method).toBe(true);
    }
  });

  it("denies every mutating method under the default policy", () => {
    const engine = engineWith();
    for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
      expect(denial(engine.canRequest(`${TARGET}/`, method)).reason, method).toBe(
        "method_not_allowed",
      );
    }
  });

  it("names what was allowed, so the message is actionable", () => {
    const engine = engineWith();
    expect(denial(engine.canRequest(`${TARGET}/`, "POST")).detail).toContain(
      "GET, HEAD, OPTIONS",
    );
  });

  it("permits a mutating method once configured", () => {
    const engine = engineWith({ policy: { allowedMethods: ["GET", "POST"] } });
    expect(engine.canRequest(`${TARGET}/api/cart`, "POST").allowed).toBe(true);
    expect(denial(engine.canRequest(`${TARGET}/api/cart`, "DELETE")).reason).toBe(
      "method_not_allowed",
    );
  });
});

describe("path rules", () => {
  it("excludes a path and everything beneath it", () => {
    const engine = engineWith();
    expect(denial(engine.canVisit(`${TARGET}/logout`)).reason).toBe("path_excluded");
    expect(denial(engine.canVisit(`${TARGET}/logout/confirm`)).reason).toBe("path_excluded");
  });

  it("does not exclude a different route that merely shares a prefix", () => {
    // `/logout-help` is a different page. A plain startsWith would exclude it
    // and quietly shrink coverage for no reason.
    const engine = engineWith();
    expect(engine.canVisit(`${TARGET}/logout-help`).allowed).toBe(true);
  });

  it("normalizes traversal before matching", () => {
    // /admin/../logout resolves to /logout, and must not slip past.
    const engine = engineWith();
    expect(denial(engine.canVisit(`${TARGET}/admin/../logout`)).reason).toBe("path_excluded");
  });

  it("restricts to allowed paths when a list is given", () => {
    const engine = engineWith({ policy: { allowedPaths: ["/shop", "/api"] } });
    expect(engine.canVisit(`${TARGET}/shop/products`).allowed).toBe(true);
    expect(engine.canVisit(`${TARGET}/api/cart`).allowed).toBe(true);
    expect(denial(engine.canVisit(`${TARGET}/admin`)).reason).toBe("path_not_allowed");
  });

  it("lets exclusion win over allowance", () => {
    // The denylist is the safety mechanism, so it must be the stronger rule.
    const engine = engineWith({
      policy: { allowedPaths: ["/account"], excludedPaths: ["/account/delete"] },
    });
    expect(engine.canVisit(`${TARGET}/account/settings`).allowed).toBe(true);
    expect(denial(engine.canVisit(`${TARGET}/account/delete`)).reason).toBe("path_excluded");
  });
});

describe("IP literals", () => {
  const loopbackAllowedScope = (host: string) => ({
    policy: { allowedOrigins: [`http://${host}:8080`] },
  });

  it("denies loopback even when the origin is in scope", () => {
    // Scope and network rules are independent gates: declaring an origin does
    // not waive the network boundary.
    const engine = engineWith(loopbackAllowedScope("127.0.0.1"));
    expect(denial(engine.canVisit("http://127.0.0.1:8080/")).reason).toBe("loopback_denied");
  });

  it("denies private ranges", () => {
    const engine = engineWith(loopbackAllowedScope("10.0.0.5"));
    expect(denial(engine.canVisit("http://10.0.0.5:8080/")).reason).toBe(
      "private_range_denied",
    );
  });

  it("denies link-local, including the cloud metadata address", () => {
    const engine = engineWith(loopbackAllowedScope("169.254.169.254"));
    expect(denial(engine.canVisit("http://169.254.169.254:8080/")).reason).toBe(
      "link_local_denied",
    );
  });

  it("denies IPv4-mapped IPv6 loopback", () => {
    // ::ffff:127.0.0.1 is loopback in disguise.
    const engine = engineWith({
      policy: { allowedOrigins: ["http://[::ffff:127.0.0.1]:8080"] },
    });
    expect(denial(engine.canVisit("http://[::ffff:127.0.0.1]:8080/")).reason).toBe(
      "loopback_denied",
    );
  });

  it("denies IPv6 loopback and unique-local", () => {
    const v6 = engineWith({ policy: { allowedOrigins: ["http://[::1]:8080"] } });
    expect(denial(v6.canVisit("http://[::1]:8080/")).reason).toBe("loopback_denied");

    const ula = engineWith({ policy: { allowedOrigins: ["http://[fd00::1]:8080"] } });
    expect(denial(ula.canVisit("http://[fd00::1]:8080/")).reason).toBe("private_range_denied");
  });

  it("permits a private literal once the rule is deliberately relaxed", () => {
    const engine = engineWith({
      policy: {
        allowedOrigins: ["http://10.0.0.5:8080"],
        network: { denyPrivateRanges: false },
      },
    });
    expect(engine.canVisit("http://10.0.0.5:8080/").allowed).toBe(true);
  });
});

describe("redirects", () => {
  it("denies a redirect that leaves the allowed origins", () => {
    const engine = engineWith();
    const d = denial(
      engine.canFollowRedirect(`${TARGET}/go`, "https://elsewhere.example.com/"),
    );
    expect(d.reason).toBe("redirect_leaves_scope");
  });

  it("allows an in-scope redirect", () => {
    const engine = engineWith();
    expect(engine.canFollowRedirect(`${TARGET}/go`, `${TARGET}/landed`).allowed).toBe(true);
  });

  it("resolves a relative redirect against the current URL", () => {
    const engine = engineWith();
    expect(engine.canFollowRedirect(`${TARGET}/a/b`, "../c").allowed).toBe(true);
  });

  it("still applies path exclusions to an in-scope redirect", () => {
    // A redirect to /logout must be refused exactly as a link to it would be.
    const engine = engineWith();
    expect(denial(engine.canFollowRedirect(`${TARGET}/go`, `${TARGET}/logout`)).reason).toBe(
      "path_excluded",
    );
  });

  it("allows an external redirect once explicitly permitted", () => {
    const engine = engineWith({
      policy: {
        allowedOrigins: ["https://elsewhere.example.com"],
        network: { followExternalRedirects: true },
      },
    });
    expect(
      engine.canFollowRedirect(`${TARGET}/go`, "https://elsewhere.example.com/").allowed,
    ).toBe(true);
  });
});

describe("explorer actions", () => {
  it("allows each permitted action kind", () => {
    const engine = engineWith();
    for (const kind of PERMITTED_ACTIONS) {
      expect(engine.canAct({ kind }).allowed, kind).toBe(true);
    }
  });

  it("denies an action nobody declared", () => {
    // The AI Explorer proposes actions as structured data; an unrecognised
    // kind is either a malformed proposal or an attempt to reach past the
    // curated surface (§27.2). Both are denials.
    const engine = engineWith();
    for (const kind of ["exec", "readFile", "fetch", "eval", ""]) {
      expect(denial(engine.canAct({ kind })).reason, kind).toBe("action_not_recognised");
    }
  });

  it("denies a state-changing action under the default policy", () => {
    const engine = engineWith();
    expect(denial(engine.canAct({ kind: "submit_form", stateChanging: true })).reason).toBe(
      "action_state_changing_denied",
    );
  });

  it("permits a state-changing action once explicitly enabled", () => {
    const engine = engineWith({ policy: { agent: { stateChangingActions: true } } });
    expect(engine.canAct({ kind: "submit_form", stateChanging: true }).allowed).toBe(true);
  });

  it("applies URL rules to a navigation action", () => {
    const engine = engineWith();
    expect(engine.canAct({ kind: "navigate", url: `${TARGET}/products` }).allowed).toBe(true);
    expect(
      denial(engine.canAct({ kind: "navigate", url: "https://evil.example.com/" })).reason,
    ).toBe("origin_not_allowed");
    expect(denial(engine.canAct({ kind: "navigate", url: `${TARGET}/logout` })).reason).toBe(
      "path_excluded",
    );
  });
});

describe("checkResolvedHost", () => {
  it("denies a hostname whose address is private, which string matching misses", async () => {
    // The hole this closes: internal.example.com looks fine as a string and
    // resolves somewhere it must not go.
    const engine = engineWith();
    const decision = await engine.checkResolvedHost("localhost");
    expect(decision.allowed).toBe(false);
    if (decision.allowed) return;
    expect(["loopback_denied", "dns_resolution_failed"]).toContain(decision.reason);
  });

  it("classifies an IP literal without touching DNS", async () => {
    const engine = engineWith();
    const decision = await engine.checkResolvedHost("10.0.0.5");
    expect(decision.allowed).toBe(false);
    if (decision.allowed) return;
    expect(decision.reason).toBe("private_range_denied");
  });

  it("reports an unresolvable host as a failure, not an allowance", async () => {
    // Fail-closed: an unresolvable name must not read as permission.
    const engine = engineWith();
    const decision = await engine.checkResolvedHost("nx.invalid.browserrecon-test");
    expect(decision.allowed).toBe(false);
    if (decision.allowed) return;
    expect(decision.reason).toBe("dns_resolution_failed");
  });

  it("skips resolution entirely when every network rule is relaxed", async () => {
    const engine = engineWith({
      policy: {
        network: { denyLoopback: false, denyPrivateRanges: false, denyLinkLocal: false },
      },
    });
    expect((await engine.checkResolvedHost("localhost")).allowed).toBe(true);
  });
});

describe("isInScope", () => {
  it("compares origins exactly", () => {
    const engine = engineWith();
    expect(engine.isInScope("https://shop.example.com")).toBe(true);
    expect(engine.isInScope("https://shop.example.com/")).toBe(false);
    expect(engine.isInScope("https://other.example.com")).toBe(false);
  });
});

describe("engine construction", () => {
  it("exposes the policy it enforces, for the session record", () => {
    // §7.4 records the boundary a scan ran under, so it has to be readable.
    const engine = engineWith();
    const policy: TargetPolicy = engine.policy;
    expect(policy.targetOrigin).toBe(TARGET);
  });
});

describe("the authentication window", () => {
  /**
   * §12.1's one exemption. Narrow by construction, so the test is mostly
   * about what it does *not* permit.
   */
  // The default policy is read-only, which is the case that matters.
  const readOnly = (): PolicyEngine => engineWith();

  const submit = (engine: PolicyEngine, url: string) =>
    engine.canAct({ kind: "click", url, stateChanging: true });

  it("refuses a state-changing click when no login is in progress", () => {
    expect(submit(readOnly(), "https://shop.example.com/login").allowed).toBe(false);
  });

  it("permits one on the login origin while a login is in progress", () => {
    // Without this the whole authentication feature is dead: submitting a
    // login form changes state, so a read-only policy forbids it. That is
    // exactly what kept `packages/auth` unreachable for two milestones.
    const engine = readOnly();
    engine.beginAuthentication("https://shop.example.com/login");
    expect(submit(engine, "https://shop.example.com/login").allowed).toBe(true);
  });

  it("still refuses one on any other origin", () => {
    // The exemption is for the form the user named, not for the scan.
    const engine = readOnly();
    engine.beginAuthentication("https://shop.example.com/login");
    expect(submit(engine, "https://evil.example.com/login").allowed).toBe(false);
  });

  it("refuses again once the login is over", () => {
    const engine = readOnly();
    engine.beginAuthentication("https://shop.example.com/login");
    engine.endAuthentication();
    expect(submit(engine, "https://shop.example.com/login").allowed).toBe(false);
  });

  it("does not open the window for a scan that never asked to sign in", () => {
    // The default. A profile is the user pointing at a form and saying
    // "submit this one"; without one, nothing is submitted anywhere.
    const engine = readOnly();
    for (const url of ["https://shop.example.com/", "https://shop.example.com/login"]) {
      expect(submit(engine, url).allowed, url).toBe(false);
    }
  });
});
