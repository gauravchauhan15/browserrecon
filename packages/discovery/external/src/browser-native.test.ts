import { describe, expect, it } from "vitest";
import { parseRobots, parseSitemap } from "./browser-native.js";

describe("robots.txt as a discovery source", () => {
  it("reads Disallow as a directory of paths worth knowing about", async () => {
    // Worth more to a recon tool than to a crawler: it is a list of the
    // paths the operator considered worth hiding.
    const findings = parseRobots(
      [
        "User-agent: *",
        "Disallow: /admin",
        "Disallow: /internal/",
        "Allow: /internal/public",
      ].join("\n"),
    );
    expect(findings.disallowed).toEqual(["/admin", "/internal/"]);
    expect(findings.allowed).toEqual(["/internal/public"]);
  });

  it("collects across every user-agent group", async () => {
    // A path disallowed for Googlebot is still a path that exists. This is
    // discovery, not obedience — whether to visit it is the policy's call.
    const findings = parseRobots(
      ["User-agent: Googlebot", "Disallow: /g-only", "User-agent: *", "Disallow: /all"].join(
        "\n",
      ),
    );
    expect(findings.disallowed).toEqual(["/all", "/g-only"]);
  });

  it("takes the slowest declared crawl delay", async () => {
    // §8.3 treats this as a floor. If one group asks for 10 seconds and
    // another for 1, respecting the slower is the conservative read.
    const findings = parseRobots(
      ["User-agent: a", "Crawl-delay: 1", "User-agent: b", "Crawl-delay: 10"].join("\n"),
    );
    expect(findings.crawlDelaySeconds).toBe(10);
  });

  it("finds sitemap pointers", async () => {
    const findings = parseRobots("Sitemap: https://a.test/sitemap.xml");
    expect(findings.sitemaps).toEqual(["https://a.test/sitemap.xml"]);
  });

  it("ignores comments and malformed lines", async () => {
    const findings = parseRobots("# hello\nDisallow: /x # trailing\nnonsense\nDisallow:");
    expect(findings.disallowed).toEqual(["/x"]);
  });

  it("copes with an empty file", async () => {
    expect(parseRobots("")).toMatchObject({ disallowed: [], sitemaps: [] });
  });
});

describe("sitemaps", () => {
  it("reads locations", async () => {
    const { locations } = parseSitemap(
      "<urlset><url><loc>https://a.test/a</loc></url><url><loc>https://a.test/b</loc></url></urlset>",
    );
    expect(locations).toEqual(["https://a.test/a", "https://a.test/b"]);
  });

  it("separates a sitemap index from a sitemap", async () => {
    // Each nested sitemap is another request against the budget, so the
    // caller decides whether to follow them.
    const parsed = parseSitemap(
      "<sitemapindex><sitemap><loc>https://a.test/s1.xml</loc></sitemap></sitemapindex>",
    );
    expect(parsed.locations).toEqual([]);
    expect(parsed.nestedSitemaps).toEqual(["https://a.test/s1.xml"]);
  });

  it("decodes the entities that actually appear in URLs", async () => {
    const { locations } = parseSitemap(
      "<urlset><url><loc>https://a.test/?a=1&amp;b=2</loc></url></urlset>",
    );
    expect(locations).toEqual(["https://a.test/?a=1&b=2"]);
  });

  it("still yields URLs from a malformed file", async () => {
    // Adding an XML dependency to read one element from a file that is
    // frequently malformed is a poor trade.
    const { locations } = parseSitemap(
      "<urlset><url><loc>https://a.test/a</loc></url><url><loc>",
    );
    expect(locations).toEqual(["https://a.test/a"]);
  });

  it("copes with an empty file", async () => {
    expect(parseSitemap("")).toEqual({ locations: [], nestedSitemaps: [] });
  });
});
