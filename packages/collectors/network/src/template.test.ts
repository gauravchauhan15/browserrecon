import { describe, expect, it } from "vitest";
import { PARAMETER_RULES, inferTemplate, sameTemplate } from "./template.js";

const t = (url: string): string | undefined => inferTemplate(url)?.template;

describe("segments that are identifiers", () => {
  it.each([
    ["https://a.test/product/101", "https://a.test/product/{id}"],
    ["https://a.test/u/f47ac10b-58cc-4372-a567-0e02b2c3d479", "https://a.test/u/{uuid}"],
    ["https://a.test/o/507f1f77bcf86cd799439011", "https://a.test/o/{id}"],
    ["https://a.test/f/a1b2c3d4e5f60718", "https://a.test/f/{hash}"],
    ["https://a.test/post/1234-my-article", "https://a.test/post/{slug}"],
    ["https://a.test/post/my-article-1234", "https://a.test/post/{slug}"],
    ["https://a.test/logs/2026-01-15", "https://a.test/logs/{date}"],
  ])("collapses %s", (url, expected) => {
    expect(t(url)).toBe(expected);
  });

  it("collapses several segments in one path", async () => {
    expect(t("https://a.test/users/42/orders/7")).toBe("https://a.test/users/{id}/orders/{id}");
  });
});

describe("segments that must never collapse", () => {
  // Collapsing too eagerly is the dangerous error: if /about becomes /{slug}
  // then /about, /contact and /admin are "the same route", one is visited,
  // and the other two are never seen — a silent coverage hole that looks
  // like a successful scan.
  it.each([
    "https://a.test/about",
    "https://a.test/contact",
    "https://a.test/admin",
    "https://a.test/api/v1/users",
    "https://a.test/settings/security",
    "https://a.test/sign-in",
    "https://a.test/my-account",
  ])("leaves %s alone", (url) => {
    expect(t(url)).toBe(url);
  });

  it("keeps three word-only routes distinct", async () => {
    expect(sameTemplate("https://a.test/about", "https://a.test/admin")).toBe(false);
    expect(sameTemplate("https://a.test/about", "https://a.test/contact")).toBe(false);
  });

  it("does not treat a short hex-looking word as a hash", async () => {
    // `/facade` and `/decade` are words; the hash rule needs 16+ characters
    // precisely so they survive.
    expect(t("https://a.test/facade")).toBe("https://a.test/facade");
    expect(t("https://a.test/decade")).toBe("https://a.test/decade");
  });

  it("does not collapse a version segment", async () => {
    // `/api/v1` and `/api/v2` are different APIs, not two instances of one.
    expect(sameTemplate("https://a.test/api/v1/x", "https://a.test/api/v2/x")).toBe(false);
  });
});

describe("grouping", () => {
  it("groups instances of one route and separates different ones", async () => {
    expect(sameTemplate("https://a.test/p/1", "https://a.test/p/99999")).toBe(true);
    expect(sameTemplate("https://a.test/p/1", "https://a.test/q/1")).toBe(false);
  });

  it("separates origins", async () => {
    expect(sameTemplate("https://a.test/p/1", "https://b.test/p/1")).toBe(false);
  });

  it("ignores the query string, which §9.5.3 compares separately", async () => {
    expect(sameTemplate("https://a.test/p/1?x=1", "https://a.test/p/2?y=2")).toBe(true);
  });

  it("returns nothing for a URL that is not a page", async () => {
    expect(inferTemplate("mailto:a@b.test")).toBeUndefined();
    expect(inferTemplate("nonsense")).toBeUndefined();
  });

  it("states why every rule is safe", async () => {
    for (const rule of PARAMETER_RULES) {
      expect(rule.why.length, rule.name).toBeGreaterThan(30);
    }
  });
});
