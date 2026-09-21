import { describe, expect, it } from "vitest";
import { startFixture, withFixture } from "../harness.js";
import { dynamicSite } from "./dynamic-site.js";
import { formsSite } from "./forms-site.js";
import { BEACON_PATHS, FIRST_PARTY_API, VENDOR_SCRIPTS, noisySite } from "./noisy-site.js";
import { BURST_ALLOWANCE, throttledApi } from "./throttled-api.js";
import { WEBMCP_TOOLS, webmcpSite } from "./webmcp-site.js";

/**
 * Self-tests for the V1 fixtures (BR-M1-30).
 *
 * A fixture is a measuring instrument, and an instrument nobody calibrated
 * is one that makes every test using it meaningless. These check the
 * behaviour each app exists to produce, without a browser — the browser-side
 * behaviour is covered where the collectors are tested.
 */

describe("throttled-api", () => {
  it("allows a burst, then refuses with Retry-After", async () => {
    await withFixture(throttledApi(), async (fixture) => {
      for (let request = 1; request <= BURST_ALLOWANCE; request += 1) {
        const response = await fetch(`${fixture.origin}/api/burst`);
        expect(response.status, `request ${request}`).toBe(200);
      }

      const refused = await fetch(`${fixture.origin}/api/burst`);
      expect(refused.status).toBe(429);
      // §8.6 wants the scan to honour the header rather than invent a
      // delay, which is only testable against a limiter that sends one.
      expect(refused.headers.get("retry-after")).toBe("2");
    });
  });

  it("lets traffic through again after the throttle window", async () => {
    // The half that matters more: a fixture that only ever 429s cannot tell
    // "backed off and recovered" from "backed off and gave up".
    await withFixture(throttledApi(), async (fixture) => {
      const statuses: number[] = [];
      for (let request = 0; request < 7; request += 1) {
        statuses.push((await fetch(`${fixture.origin}/api/burst`)).status);
      }
      expect(statuses).toEqual([200, 200, 200, 429, 429, 200, 200]);
    });
  });

  it("counts requests rather than reading a clock", async () => {
    // Two instances given the same number of requests must answer
    // identically, however long the test took.
    const first = await startFixture(throttledApi());
    const second = await startFixture(throttledApi());
    try {
      const walk = async (origin: string): Promise<number[]> => {
        const statuses: number[] = [];
        for (let request = 0; request < 6; request += 1) {
          statuses.push((await fetch(`${origin}/api/burst`)).status);
        }
        return statuses;
      };
      expect(await walk(first.origin)).toEqual(await walk(second.origin));
    } finally {
      await first.close();
      await second.close();
    }
  });

  it("serves a WAF-shaped 403 with a vendor header", async () => {
    await withFixture(throttledApi(), async (fixture) => {
      const response = await fetch(`${fixture.origin}/api/protected`);
      expect(response.status).toBe(403);
      expect(response.headers.get("server")).toBe("cloudfront");
      expect((await response.text()).toLowerCase()).toContain("security check");
    });
  });

  it("serves an auth wall with WWW-Authenticate", async () => {
    await withFixture(throttledApi(), async (fixture) => {
      const response = await fetch(`${fixture.origin}/api/login`);
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toContain("Bearer");
    });
  });

  it("finishes a slow response in pieces", async () => {
    await withFixture(throttledApi(), async (fixture) => {
      const body = await (await fetch(`${fixture.origin}/api/slow`)).text();
      expect(JSON.parse(body)).toEqual({ items: [{ id: 1 }, { id: 2 }] });
    });
  });

  it("never finishes /api/never, and shutting down releases the client", async () => {
    // The endpoint that proves a deadline is real. It also has to not hang
    // the suite, so the fixture's own shutdown is what ends it.
    const fixture = await startFixture(throttledApi());
    const controller = new AbortController();
    const pending = fetch(`${fixture.origin}/api/never`, { signal: controller.signal }).then(
      (response) => response.text(),
      (error: Error) => `rejected: ${error.name}`,
    );

    await fixture.close();
    controller.abort();
    await expect(pending).resolves.toBeDefined();
  });
});

describe("forms-site", () => {
  it("offers safe and destructive forms on one page", async () => {
    await withFixture(formsSite(), async (fixture) => {
      const html = await (await fetch(fixture.origin)).text();
      for (const id of ["search", "filter", "subscribe", "delete", "transfer"]) {
        expect(html, `missing form #${id}`).toContain(`id="${id}"`);
      }
    });
  });

  it("includes a destructive form that does not look like one", async () => {
    // A fixture where every dangerous form announced itself would prove
    // nothing: a classifier reading button text would pass.
    await withFixture(formsSite(), async (fixture) => {
      const html = await (await fetch(fixture.origin)).text();
      const transfer = html.slice(
        html.indexOf('id="transfer"'),
        html.indexOf("</form>", html.indexOf('id="transfer"')),
      );

      expect(transfer).toContain(">Continue<");
      expect(transfer).not.toMatch(/delete|remove|destroy|transfer money/i);
      // What a classifier should key on instead.
      expect(transfer).toContain('method="post"');
      expect(transfer).toContain("amount_cents");
    });
  });

  it("records every mutation, so 'nothing was submitted' is checkable", async () => {
    await withFixture(formsSite(), async (fixture) => {
      expect((await fetch(`${fixture.origin}/search?q=x`)).status).toBe(200);
      expect(fixture.requests.filter((r) => r.method === "POST")).toHaveLength(0);

      await fetch(`${fixture.origin}/api/account/delete`, { method: "POST" });
      expect(fixture.requests.some((r) => r.method === "POST" && r.status === 200)).toBe(true);
    });
  });

  it("answers GET forms without changing anything", async () => {
    await withFixture(formsSite(), async (fixture) => {
      const body = await (await fetch(`${fixture.origin}/products?sort=price`)).text();
      expect(body).toContain("sort=price");
    });
  });
});

describe("dynamic-site", () => {
  it("serves markup with far fewer links than the page ends up having", async () => {
    // The reason this tool drives a browser: a crawler parsing HTML finds
    // two links here and a browser finds six.
    await withFixture(dynamicSite(), async (fixture) => {
      const html = await (await fetch(fixture.origin)).text();
      const inMarkup = [...html.matchAll(/href="([^"]+)"/g)].map((match) => match[1]);
      expect(inMarkup).toEqual(["/about", "/help"]);

      const script = await (await fetch(`${fixture.origin}/app.js`)).text();
      for (const href of ["/settings", "/billing", "/team", "/audit"]) {
        expect(script, `${href} is not injected`).toContain(href);
      }
    });
  });

  it("keeps two endpoints only in the lazily-imported chunk", async () => {
    // JS discovery that reads only the entry bundle misses these.
    await withFixture(dynamicSite(), async (fixture) => {
      const entry = await (await fetch(`${fixture.origin}/app.js`)).text();
      const chunk = await (await fetch(`${fixture.origin}/chunk-orders.js`)).text();

      for (const endpoint of ["/api/orders/pending", "/api/orders/archive"]) {
        expect(chunk).toContain(endpoint);
        expect(entry, `${endpoint} leaked into the entry bundle`).not.toContain(endpoint);
      }
    });
  });

  it("paginates by page number, not by clock, and ends", async () => {
    await withFixture(dynamicSite(), async (fixture) => {
      const page = async (n: number) =>
        (await (await fetch(`${fixture.origin}/api/rows?page=${n}`)).json()) as {
          rows: unknown[];
          has_more: boolean;
        };

      expect((await page(1)).rows).toHaveLength(2);
      expect((await page(3)).has_more).toBe(false);
      expect((await page(4)).rows).toHaveLength(0);
    });
  });
});

describe("noisy-site", () => {
  it("buries two first-party calls in vendor traffic", async () => {
    await withFixture(noisySite(), async (fixture) => {
      const html = await (await fetch(fixture.origin)).text();
      for (const path of [...VENDOR_SCRIPTS, ...BEACON_PATHS, ...FIRST_PARTY_API]) {
        expect(html, `page never requests ${path}`).toContain(path);
      }
      // The ratio is the point: if the noise ever stopped outnumbering the
      // signal, this fixture would stop testing what it is for.
      expect(VENDOR_SCRIPTS.length + BEACON_PATHS.length).toBeGreaterThan(
        FIRST_PARTY_API.length * 4,
      );
    });
  });

  it("points vendor assets at a genuinely different origin when given one", async () => {
    // Origin classification cannot be tested against a path prefix. Two
    // fixtures on two ports are two real origins.
    const cdn = await startFixture(noisySite());
    try {
      await withFixture(noisySite({ thirdPartyOrigin: cdn.origin }), async (site) => {
        const html = await (await fetch(site.origin)).text();
        expect(html).toContain(`${cdn.origin}/vendor/analytics.js`);
        expect(html).toContain("/api/session");
        expect(html).not.toContain(`${cdn.origin}/api/session`);
        expect(new URL(cdn.origin).port).not.toBe(new URL(site.origin).port);
      });
    } finally {
      await cdn.close();
    }
  });

  it("serves a byte-identical tracking pixel", async () => {
    await withFixture(noisySite(), async (fixture) => {
      const response = await fetch(`${fixture.origin}/vendor/px.gif`);
      expect(response.headers.get("content-type")).toBe("image/gif");
      const bytes = new Uint8Array(await response.arrayBuffer());
      expect(String.fromCharCode(...bytes.slice(0, 6))).toBe("GIF89a");
    });
  });
});

describe("webmcp-site", () => {
  it("registers tools with names, descriptions and input schemas", async () => {
    await withFixture(webmcpSite(), async (fixture) => {
      const html = await (await fetch(fixture.origin)).text();
      for (const tool of WEBMCP_TOOLS) {
        expect(html, `${tool.name} is not registered`).toContain(tool.name);
        expect(html).toContain(tool.endpoint);
      }
      expect(html).toContain("inputSchema");
    });
  });

  it("advertises a destructive tool", async () => {
    // §7.2: an exposed destructive operation is something to report, never
    // something to try. A registry of only-safe tools would never test that.
    const destructive = WEBMCP_TOOLS.filter((tool) => tool.destructive);
    expect(destructive.map((tool) => tool.name)).toEqual(["deleteAccount"]);
  });

  it("makes the destructive endpoint genuinely reachable", async () => {
    // Which is what makes "the scan never called it" an assertion rather
    // than a statement about a route that does not exist.
    await withFixture(webmcpSite(), async (fixture) => {
      const response = await fetch(`${fixture.origin}/api/account`, { method: "DELETE" });
      expect(response.status).toBe(200);
      expect(fixture.requests.some((r) => r.method === "DELETE")).toBe(true);
    });
  });

  it("registers tools without sending a single request", async () => {
    // The property that makes WebMCP invisible to traffic analysis, and the
    // reason the collector cannot be built on network observation.
    await withFixture(webmcpSite(), async (fixture) => {
      await fetch(fixture.origin);
      expect(fixture.requests.map((request) => request.pathname)).toEqual(["/"]);
    });
  });
});
