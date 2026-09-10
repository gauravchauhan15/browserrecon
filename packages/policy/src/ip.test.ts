import { describe, expect, it } from "vitest";
import { classifyAddress, isIpLiteral, isPubliclyRoutable } from "./ip.js";

describe("IPv4 classification", () => {
  it.each([
    ["127.0.0.1", "loopback"],
    ["127.1.2.3", "loopback"],
    ["10.0.0.5", "private"],
    ["172.16.0.1", "private"],
    ["172.31.255.254", "private"],
    ["192.168.1.1", "private"],
    ["169.254.169.254", "link_local"],
    ["0.0.0.0", "unspecified"],
    ["100.64.0.1", "shared_cgnat"],
    ["198.18.0.1", "benchmark"],
    ["224.0.0.1", "multicast"],
    ["255.255.255.255", "reserved"],
    ["8.8.8.8", "public"],
    ["93.184.216.34", "public"],
    ["172.32.0.1", "public"],
    ["172.15.0.1", "public"],
  ])("%s is %s", (address, expected) => {
    expect(classifyAddress(address)).toBe(expected);
  });

  it("treats 169.254.169.254 as non-routable", () => {
    // The cloud metadata endpoint. Reaching it from a scan of someone's web
    // app is the canonical SSRF payoff.
    expect(isPubliclyRoutable("169.254.169.254")).toBe(false);
  });

  it("gets the 172.16/12 boundaries right in both directions", () => {
    expect(classifyAddress("172.15.255.255")).toBe("public");
    expect(classifyAddress("172.16.0.0")).toBe("private");
    expect(classifyAddress("172.31.255.255")).toBe("private");
    expect(classifyAddress("172.32.0.0")).toBe("public");
  });
});

describe("IPv6 classification", () => {
  it.each([
    ["::1", "loopback"],
    ["0:0:0:0:0:0:0:1", "loopback"],
    ["::", "unspecified"],
    ["fe80::1", "link_local"],
    ["fe80::abcd:1234:5678:9abc", "link_local"],
    ["febf::1", "link_local"],
    ["fc00::1", "private"],
    ["fd12:3456::1", "private"],
    ["ff02::1", "multicast"],
    ["2001:db8::1", "reserved"],
    ["2606:4700:4700::1111", "public"],
  ])("%s is %s", (address, expected) => {
    expect(classifyAddress(address)).toBe(expected);
  });

  it("unwraps IPv4-mapped addresses instead of treating them as IPv6", () => {
    // The classic bypass: ::ffff:127.0.0.1 is loopback, and any check that
    // classifies it as "some IPv6 address" lets it straight through.
    expect(classifyAddress("::ffff:127.0.0.1")).toBe("loopback");
    expect(classifyAddress("::ffff:10.0.0.1")).toBe("private");
    expect(classifyAddress("::ffff:169.254.169.254")).toBe("link_local");
    expect(classifyAddress("::ffff:8.8.8.8")).toBe("public");
  });

  it("unwraps IPv4-compatible addresses too", () => {
    expect(classifyAddress("::127.0.0.1")).toBe("loopback");
  });

  it("strips brackets from URL-form addresses", () => {
    expect(classifyAddress("[::1]")).toBe("loopback");
  });

  it("ignores a zone index", () => {
    expect(classifyAddress("fe80::1%eth0")).toBe("link_local");
  });
});

describe("fail-closed behaviour", () => {
  it("treats anything unparseable as reserved, never public", () => {
    // An address this code does not understand must not be assumed safe.
    for (const bad of ["", "not-an-ip", "999.999.999.999", "::gggg", "1.2.3", "1.2.3.4.5"]) {
      expect(classifyAddress(bad), bad).toBe("reserved");
      expect(isPubliclyRoutable(bad), bad).toBe(false);
    }
  });
});

describe("isIpLiteral", () => {
  it("distinguishes literals from names needing DNS", () => {
    expect(isIpLiteral("127.0.0.1")).toBe(true);
    expect(isIpLiteral("::1")).toBe(true);
    expect(isIpLiteral("[::1]")).toBe(true);
    expect(isIpLiteral("example.com")).toBe(false);
    expect(isIpLiteral("localhost")).toBe(false);
  });
});
