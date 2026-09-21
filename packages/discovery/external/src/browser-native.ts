/**
 * Discovery that needs nothing installed — build plan §10D.1, §35A.2;
 * dev plan BR-M1-15b.
 *
 * Always on, never disabled. This is what makes Tier 0 real: a user who
 * installs BrowserRecon and nothing else still gets a scan that finds pages,
 * because the browser is already looking at the markup and the site is
 * already telling us where things are.
 *
 * `robots.txt` in particular is worth more to a recon tool than to a crawler.
 * Its `Disallow` list is a directory of the paths the operator considered
 * worth hiding, which is a discovery source, and its `Crawl-delay` is a rate
 * floor the scan should respect (§8.3).
 */

export interface RobotsFindings {
  /** Paths named in Disallow — a list of what the operator did not want crawled. */
  readonly disallowed: readonly string[];
  /** Paths named in Allow, which sometimes reveal exceptions inside a block. */
  readonly allowed: readonly string[];
  /** Sitemap URLs the file points at. */
  readonly sitemaps: readonly string[];
  /** Seconds, when declared. §8.3 treats this as a floor, not a suggestion. */
  readonly crawlDelaySeconds?: number | undefined;
}

/**
 * Parse robots.txt.
 *
 * Directives are collected across every user-agent group rather than only
 * the one matching us. A path disallowed for Googlebot is still a path that
 * exists, and this is discovery, not obedience — whether to *visit* it is
 * the Target Policy's decision, made separately and with the user's consent.
 */
export function parseRobots(text: string): RobotsFindings {
  const disallowed: string[] = [];
  const allowed: string[] = [];
  const sitemaps: string[] = [];
  let crawlDelaySeconds: number | undefined;

  for (const rawLine of text.split("\n")) {
    const line = rawLine.split("#")[0]?.trim() ?? "";
    if (line === "") continue;

    const separator = line.indexOf(":");
    if (separator === -1) continue;
    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (value === "") continue;

    if (field === "disallow") disallowed.push(value);
    else if (field === "allow") allowed.push(value);
    else if (field === "sitemap") sitemaps.push(value);
    else if (field === "crawl-delay") {
      const seconds = Number(value);
      // The largest declared delay wins: if one group asks for 10 seconds
      // and another for 1, respecting the slower is the conservative read.
      if (Number.isFinite(seconds) && seconds > (crawlDelaySeconds ?? 0)) {
        crawlDelaySeconds = seconds;
      }
    }
  }

  return {
    disallowed: [...new Set(disallowed)].sort(),
    allowed: [...new Set(allowed)].sort(),
    sitemaps: [...new Set(sitemaps)].sort(),
    ...(crawlDelaySeconds === undefined ? {} : { crawlDelaySeconds }),
  };
}

/**
 * Pull locations out of a sitemap.
 *
 * Regex rather than an XML parser, deliberately: adding an XML dependency to
 * read one element from a file that is frequently malformed is a poor trade,
 * and a sitemap that fails to parse strictly should still yield the URLs it
 * plainly contains. Nested sitemap indexes are returned too — the caller
 * decides whether to follow them, since each one is another request against
 * the budget.
 */
export function parseSitemap(text: string): { locations: string[]; nestedSitemaps: string[] } {
  const locations: string[] = [];
  const nestedSitemaps: string[] = [];

  const isIndex = /<sitemapindex[\s>]/i.test(text);
  for (const match of text.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)) {
    const value = match[1];
    if (value === undefined || value === "") continue;
    // Entity-decode the handful that actually appear in URLs.
    const url = value
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'");
    if (isIndex) nestedSitemaps.push(url);
    else locations.push(url);
  }

  return {
    locations: [...new Set(locations)].sort(),
    nestedSitemaps: [...new Set(nestedSitemaps)].sort(),
  };
}
