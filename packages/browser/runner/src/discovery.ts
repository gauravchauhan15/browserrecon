/**
 * Browser-native discovery — build plan §10C.2, §8.5 rule 3;
 * dev plan BR-M1-31.
 *
 * `robots.txt` and `sitemap.xml`: the two things every site publishes for
 * crawlers, needing no tool to be installed. This is the fallback §8.5 rule
 * 3 promises — when katana is missing or dies, the scan still discovers
 * more than the seed page.
 *
 * ## robots.txt is read as a map, and obeyed as a boundary
 *
 * A `Disallow` list is a list of paths the operator did not want crawled,
 * which makes it both the most interesting file on the site and one the
 * scan must not treat as an invitation. Both are true at once, so:
 * disallowed paths are *recorded* as discovered-but-excluded, and are not
 * queued. §7.1 — the tool respects robots by default, and says what it
 * skipped rather than pretending it did not see it.
 */
import type { Candidate } from "@browserrecon/deterministic-explorer";
import { silentLogger, type Logger } from "@browserrecon/core";
import type { TokenBucket } from "@browserrecon/rate-controller";
import { parseRobots, parseSitemap } from "@browserrecon/discovery-external";

export interface BrowserNativeDiscoveryOptions {
  /** Injected so tests need no network and a scan can route through policy. */
  readonly fetchText: (url: string, signal?: AbortSignal) => Promise<string | undefined>;
  /**
   * Policy check applied before *any* fetch this makes.
   *
   * Required, not optional. A sitemap index names other sitemaps, and those
   * URLs come from the response — so a target can point this at anything it
   * likes, including a host on the operator's own network. Fetching them
   * unchecked is a request the user never authorized, made on their machine,
   * at a URL the target chose. `robots.txt` at the validated origin is safe;
   * everything reached from it is not.
   */
  readonly allow: (url: string) => boolean;
  readonly respectRobots?: boolean | undefined;
  readonly logger?: Logger | undefined;
  /** Sitemap URLs that were discovered but not queued, with the reason. */
  readonly onExcluded?: ((url: string, reason: string) => void) | undefined;
}

/** How deep a nested sitemap chain is followed. */
const MAX_SITEMAP_DEPTH = 3;

export function createBrowserNativeDiscovery(options: BrowserNativeDiscoveryOptions): {
  readonly name: string;
  run(context: {
    readonly target: string;
    readonly bucket: TokenBucket;
    readonly signal: AbortSignal;
  }): AsyncIterable<Candidate>;
} {
  const log = options.logger ?? silentLogger();

  return {
    name: "browser-native",
    async *run({ target, bucket, signal }) {
      const origin = new URL(target).origin;
      const seen = new Set<string>();
      const disallowed: string[] = [];

      const emit = function* (url: string, depth: number): Generator<Candidate> {
        if (seen.has(url)) return;
        seen.add(url);

        if (options.respectRobots !== false) {
          const path = new URL(url).pathname;
          // Prefix match, as robots.txt is specified. An operator writing
          // `Disallow: /admin` means everything under it.
          if (disallowed.some((prefix) => path.startsWith(prefix))) {
            options.onExcluded?.(url, "robots_excluded");
            return;
          }
        }
        yield { url, source: "sitemap", depth };
      };

      // robots.txt first — it names the sitemaps and the exclusions, and
      // the exclusions have to be known before anything is yielded.
      const robotsUrl = `${origin}/robots.txt`;
      // Checked too, even though the origin was validated: the check is
      // cheap and an unchecked path is one a later refactor widens.
      if (!options.allow(robotsUrl)) return;

      await bucket.acquire();
      if (signal.aborted) return;
      const robotsText = await options.fetchText(robotsUrl, signal);

      const sitemapQueue: { url: string; depth: number }[] = [];
      if (robotsText !== undefined) {
        const robots = parseRobots(robotsText);
        disallowed.push(...robots.disallowed.filter((path) => path !== "" && path !== "/"));
        for (const sitemap of robots.sitemaps) sitemapQueue.push({ url: sitemap, depth: 0 });
        log.info("read robots.txt", {
          disallowed: robots.disallowed.length,
          sitemaps: robots.sitemaps.length,
        });
      }

      // A site with no robots.txt, or one naming no sitemap, usually still
      // has the conventional location. Appended rather than replacing, so a
      // robots.txt naming only out-of-scope sitemaps still gets this tried.
      sitemapQueue.push({ url: `${origin}/sitemap.xml`, depth: 0 });

      while (sitemapQueue.length > 0) {
        if (signal.aborted) return;
        const next = sitemapQueue.shift();
        if (next === undefined) break;
        if (next.depth > MAX_SITEMAP_DEPTH) continue;

        if (!options.allow(next.url)) {
          options.onExcluded?.(next.url, "out_of_scope");
          continue;
        }

        await bucket.acquire();
        if (signal.aborted) return;
        const text = await options.fetchText(next.url, signal);
        if (text === undefined) continue;

        const { locations, nestedSitemaps } = parseSitemap(text);
        for (const nested of nestedSitemaps) {
          sitemapQueue.push({ url: nested, depth: next.depth + 1 });
        }
        for (const location of locations) {
          yield* emit(location, 1);
        }
      }
    },
  };
}
