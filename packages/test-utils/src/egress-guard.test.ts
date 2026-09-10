/**
 * Meta-tests for the egress guard.
 *
 * BR-M0-02 requires that the network-egress gate be "verified to fail when
 * deliberately broken" — a guard that silently permits everything is worse
 * than no guard, because it manufactures false confidence. These tests prove
 * it fires.
 *
 * Destination addresses are drawn from RFC 5737 TEST-NET-3 (203.0.113.0/24)
 * and RFC 2606 (.invalid), which are reserved and non-routable. If the guard
 * ever failed open, nothing would actually leave the machine.
 */
import net from "node:net";
import dns from "node:dns";
import { afterEach, describe, expect, it } from "vitest";
import { installEgressGuard } from "./egress-guard.js";
import type { EgressGuard } from "./egress-guard.js";

let guard: EgressGuard | undefined;

afterEach(() => {
  guard?.restore();
  guard = undefined;
});

describe("egress guard", () => {
  it("blocks a connection to an unapproved host", () => {
    guard = installEgressGuard();

    expect(() => net.connect({ host: "203.0.113.1", port: 443 })).toThrow(/Egress blocked/);
    expect(guard.violations).toHaveLength(1);
    expect(guard.violations[0]?.host).toBe("203.0.113.1");
    expect(guard.violations[0]?.port).toBe(443);
  });

  it("names the build plan sections in the failure message", () => {
    guard = installEgressGuard();

    // The message is the whole value of this guard: whoever trips it must
    // learn why the rule exists, not just that a test failed.
    expect(() => net.connect({ host: "telemetry.example.invalid", port: 443 })).toThrow(
      /§37\.1, §38/,
    );
  });

  it("blocks DNS resolution of an unapproved host", () => {
    guard = installEgressGuard();

    // Resolution alone leaks what is being scanned to a resolver operator,
    // even when the connection never completes.
    expect(() => dns.lookup("collector.example.invalid", () => {})).toThrow(/Egress blocked/);
    expect(guard.violations[0]?.via).toBe("dns.lookup");
  });

  it("permits localhost without configuration", () => {
    guard = installEgressGuard();

    // A local fixture server and a local Ollama instance are both legitimate.
    const socket = net.connect({ host: "127.0.0.1", port: 1 });
    socket.on("error", () => {});
    socket.destroy();

    expect(guard.violations).toHaveLength(0);
    expect(guard.attempts[0]?.allowed).toBe(true);
  });

  it("permits an explicitly allowed scan target", () => {
    guard = installEgressGuard({ allowHosts: ["shop.example.invalid"] });

    const socket = net.connect({ host: "shop.example.invalid", port: 443 });
    socket.on("error", () => {});
    socket.destroy();

    expect(guard.violations).toHaveLength(0);
  });

  it("still blocks a third party when a target is allowed", () => {
    // The realistic leak: a scan legitimately talks to its target, and
    // something also phones home. Allowing one must not allow the other.
    guard = installEgressGuard({ allowHosts: ["shop.example.invalid"] });

    const socket = net.connect({ host: "shop.example.invalid", port: 443 });
    socket.on("error", () => {});
    socket.destroy();

    expect(() => net.connect({ host: "analytics.example.invalid", port: 443 })).toThrow(
      /Egress blocked/,
    );
    expect(guard.violations).toHaveLength(1);
    expect(guard.violations[0]?.host).toBe("analytics.example.invalid");
  });

  it("records without throwing when asked to", () => {
    guard = installEgressGuard({ throwOnViolation: false });

    const socket = net.connect({ host: "203.0.113.2", port: 80 });
    socket.on("error", () => {});
    socket.destroy();

    expect(guard.violations).toHaveLength(1);
  });

  it("does not treat a unix socket path as egress", () => {
    guard = installEgressGuard();

    const socket = net.connect({ path: "/tmp/browserrecon-test.sock" });
    socket.on("error", () => {});
    socket.destroy();

    expect(guard.violations).toHaveLength(0);
  });

  it("restores the original functions on teardown", () => {
    const before = net.connect;
    const g = installEgressGuard();
    expect(net.connect).not.toBe(before);
    g.restore();
    expect(net.connect).toBe(before);
  });
});
