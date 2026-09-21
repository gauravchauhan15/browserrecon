import { createTokenBucket } from "@browserrecon/rate-controller";
import { describe, expect, it } from "vitest";
import { createBrowserNativeDiscovery } from "./discovery.js";

/**
 * Browser-native discovery, without a network.
 *
 * `fetchText` and `allow` are both injected, which is what makes the
 * interesting case testable: a sitemap index naming a host the target does
 * not own.
 */

const ORIGIN = "https://shop.example.com";

function collect(
  pages: Readonly<Record<string, string>>,
  allow: (url: string) => boolean = (url) => url.startsWith(ORIGIN),
) {
  const fetched: string[] = [];
  const excluded: { url: string; reason: string }[] = [];

  const discovery = createBrowserNativeDiscovery({
    allow,
    fetchText: (url) => {
      fetched.push(url);
      return Promise.resolve(pages[url]);
    },
    onExcluded: (url, reason) => excluded.push({ url, reason }),
  });

  const run = async (): Promise<string[]> => {
    const found: string[] = [];
    for await (const candidate of discovery.run({
      target: `${ORIGIN}/`,
      bucket: createTokenBucket({ refillPerSecond: 1000, sleep: () => Promise.resolve() }),
      signal: new AbortController().signal,
    })) {
      found.push(candidate.url);
    }
    return found;
  };

  return { run, fetched, excluded };
}

const sitemap = (...locations: string[]): string =>
  `<?xml version="1.0"?><urlset>${locations.map((loc) => `<loc>${loc}</loc>`).join("")}</urlset>`;

const sitemapIndex = (...sitemaps: string[]): string =>
  `<?xml version="1.0"?><sitemapindex>${sitemaps.map((loc) => `<sitemap><loc>${loc}</loc></sitemap>`).join("")}</sitemapindex>`;

describe("finding URLs without a crawler", () => {
  it("reads the conventional sitemap when there is no robots.txt", async () => {
    const { run } = collect({
      [`${ORIGIN}/sitemap.xml`]: sitemap(`${ORIGIN}/a`, `${ORIGIN}/b`),
    });
    expect(await run()).toEqual([`${ORIGIN}/a`, `${ORIGIN}/b`]);
  });

  it("follows the sitemaps robots.txt names", async () => {
    const { run } = collect({
      [`${ORIGIN}/robots.txt`]: `Sitemap: ${ORIGIN}/custom.xml\n`,
      [`${ORIGIN}/custom.xml`]: sitemap(`${ORIGIN}/from-robots`),
    });
    expect(await run()).toContain(`${ORIGIN}/from-robots`);
  });

  it("still tries the conventional location when robots names one too", async () => {
    // A robots.txt naming only an out-of-scope sitemap used to replace the
    // default rather than add to it, so the site's real sitemap was never
    // read.
    const { run } = collect({
      [`${ORIGIN}/robots.txt`]: `Sitemap: https://cdn.example.net/s.xml\n`,
      [`${ORIGIN}/sitemap.xml`]: sitemap(`${ORIGIN}/conventional`),
    });
    expect(await run()).toContain(`${ORIGIN}/conventional`);
  });
});

describe("robots.txt is read as a map and obeyed as a boundary", () => {
  it("does not queue a path robots disallows", async () => {
    // §7.1. A Disallow list is the most interesting file on the site and
    // must not be treated as an invitation — both at once.
    const { run, excluded } = collect({
      [`${ORIGIN}/robots.txt`]: "User-agent: *\nDisallow: /admin\n",
      [`${ORIGIN}/sitemap.xml`]: sitemap(`${ORIGIN}/admin/users`, `${ORIGIN}/public`),
    });

    expect(await run()).toEqual([`${ORIGIN}/public`]);
    expect(excluded).toContainEqual({
      url: `${ORIGIN}/admin/users`,
      reason: "robots_excluded",
    });
  });

  it("records what it skipped rather than pretending it never saw it", async () => {
    const { run, excluded } = collect({
      [`${ORIGIN}/robots.txt`]: "Disallow: /private\n",
      [`${ORIGIN}/sitemap.xml`]: sitemap(`${ORIGIN}/private/a`, `${ORIGIN}/private/b`),
    });
    await run();
    expect(excluded).toHaveLength(2);
  });

  it("ignores a blanket Disallow: / rather than discovering nothing", async () => {
    // `Disallow: /` excludes everything, and treating it literally here
    // would silently turn discovery off. Whether to honour it at all is the
    // policy's call, not discovery's.
    const { run } = collect({
      [`${ORIGIN}/robots.txt`]: "Disallow: /\n",
      [`${ORIGIN}/sitemap.xml`]: sitemap(`${ORIGIN}/a`),
    });
    expect(await run()).toEqual([`${ORIGIN}/a`]);
  });
});

describe("a sitemap cannot point the tool at someone else's host", () => {
  it("refuses to fetch a nested sitemap outside the policy", async () => {
    // The URLs in a sitemap index come from the *response*. Fetching them
    // unchecked is a request the user never authorized, made from their
    // machine, at a URL the target chose.
    const { run, fetched, excluded } = collect({
      [`${ORIGIN}/sitemap.xml`]: sitemapIndex("http://169.254.169.254/latest/meta-data/"),
    });

    await run();
    expect(fetched).not.toContain("http://169.254.169.254/latest/meta-data/");
    expect(excluded.map((entry) => entry.url)).toContain(
      "http://169.254.169.254/latest/meta-data/",
    );
  });

  it("refuses an internal host named by a nested sitemap", async () => {
    const { run, fetched } = collect({
      [`${ORIGIN}/sitemap.xml`]: sitemapIndex("http://internal.corp/secrets.xml"),
      "http://internal.corp/secrets.xml": sitemap("http://internal.corp/a"),
    });
    await run();
    expect(fetched).not.toContain("http://internal.corp/secrets.xml");
  });

  it("checks robots.txt itself, not only what it leads to", async () => {
    const { run, fetched } = collect({ [`${ORIGIN}/robots.txt`]: "" }, () => false);
    await run();
    expect(fetched).toEqual([]);
  });

  it("follows a nested sitemap that is in scope", async () => {
    const { run } = collect({
      [`${ORIGIN}/sitemap.xml`]: sitemapIndex(`${ORIGIN}/nested.xml`),
      [`${ORIGIN}/nested.xml`]: sitemap(`${ORIGIN}/deep`),
    });
    expect(await run()).toContain(`${ORIGIN}/deep`);
  });

  it("stops following nested sitemaps eventually", async () => {
    // A sitemap index that names itself is a loop a target can set.
    const { run, fetched } = collect({
      [`${ORIGIN}/sitemap.xml`]: sitemapIndex(`${ORIGIN}/sitemap.xml`),
    });
    await run();
    expect(fetched.length).toBeLessThan(10);
  });
});
