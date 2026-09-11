import { describe, expect, it } from "vitest";
import { withFixture } from "../harness.js";
import { restApi } from "./rest-api.js";
import { staticSite } from "./static-site.js";

describe("static site", () => {
  it("serves a home page that links to the rest of the site", async () => {
    await withFixture(staticSite(), async (fixture) => {
      const html = await (await fetch(fixture.origin)).text();
      for (const href of ["/about", "/products", "/contact"]) {
        expect(html, `home page does not link ${href}`).toContain(`href="${href}"`);
      }
    });
  });

  it("offers three sibling instances of one route template", async () => {
    // §9.5.3's saturation logic needs several instances of the same template
    // to have anything to collapse.
    await withFixture(staticSite(), async (fixture) => {
      for (const id of ["1", "2", "3"]) {
        expect((await fetch(`${fixture.origin}/products/${id}`)).status).toBe(200);
      }
      expect((await fetch(`${fixture.origin}/products/77`)).status).toBe(404);
    });
  });

  it("includes one instance that genuinely diverges from its siblings", async () => {
    // Divergence inside a route template blocks saturation and is itself a
    // signal (§9.5.3). If every instance looked alike, that path would be
    // untestable.
    await withFixture(staticSite(), async (fixture) => {
      const sibling = await (await fetch(`${fixture.origin}/products/1`)).text();
      const divergent = await (await fetch(`${fixture.origin}/products/9`)).text();

      expect(sibling).not.toContain("<form");
      expect(divergent).toContain("<form");
      expect(divergent).toContain("/admin/approve");
    });
  });

  it("hides endpoints in JavaScript that appear nowhere in the HTML", async () => {
    // The point of the JS-mining stage (§10A): these are unreachable by
    // reading the markup.
    await withFixture(staticSite(), async (fixture) => {
      const js = await (await fetch(`${fixture.origin}/app.js`)).text();
      for (const endpoint of ["/api/v1/telemetry", "/api/v1/admin/users"]) {
        expect(js, `${endpoint} missing from app.js`).toContain(endpoint);
      }

      const pages = await Promise.all(
        ["/", "/about", "/products", "/products/1", "/contact"].map(async (path) =>
          (await fetch(`${fixture.origin}${path}`)).text(),
        ),
      );
      for (const endpoint of ["/api/v1/cart", "/api/v1/telemetry", "/api/v1/admin/users"]) {
        for (const html of pages) {
          expect(html, `${endpoint} leaked into HTML`).not.toContain(endpoint);
        }
      }
    });
  });

  it("assembles one endpoint by concatenation, so a regex alone cannot find it", async () => {
    // The case that separates a real extractor from a quoted-path regex:
    // `/api/v1/cart` is never written out. It exists only as API_BASE + "/cart"
    // and has to be resolved, not matched. Asserting its *absence* as a
    // literal is what keeps the fixture honest — if someone "fixes" app.js to
    // spell it out, the hard case silently disappears.
    await withFixture(staticSite(), async (fixture) => {
      const js = await (await fetch(`${fixture.origin}/app.js`)).text();

      expect(js).not.toContain('"/api/v1/cart"');
      expect(js).toContain('const API_BASE = "/api/v1"');
      expect(js).toContain('API_BASE + "/cart"');
    });
  });

  it("serves robots.txt with a crawl delay and a disallow", async () => {
    // §8.3 treats Crawl-delay as a rate floor, so there has to be one to read.
    await withFixture(staticSite(), async (fixture) => {
      const robots = await (await fetch(`${fixture.origin}/robots.txt`)).text();
      expect(robots).toContain("Crawl-delay: 1");
      expect(robots).toContain("Disallow: /admin");
    });
  });

  it("lists a page in the sitemap that nothing links to", async () => {
    // Proves a crawler actually read the sitemap rather than arriving at
    // /orphan some other way.
    await withFixture(staticSite(), async (fixture) => {
      const sitemap = await (await fetch(`${fixture.origin}/sitemap.xml`)).text();
      expect(sitemap).toContain("<loc>/orphan</loc>");
      expect((await fetch(`${fixture.origin}/orphan`)).status).toBe(200);

      for (const path of ["/", "/about", "/products", "/contact"]) {
        const html = await (await fetch(`${fixture.origin}${path}`)).text();
        expect(html, `${path} links /orphan, which defeats the point`).not.toContain(
          'href="/orphan"',
        );
      }
    });
  });

  it("has a dead reference that is linked but unreachable", async () => {
    await withFixture(staticSite(), async (fixture) => {
      const html = await (await fetch(fixture.origin)).text();
      expect(html).toContain('href="/gone"');
      expect((await fetch(`${fixture.origin}/gone`)).status).toBe(410);
    });
  });
});

describe("rest api", () => {
  it("serves a collection and its members", async () => {
    await withFixture(restApi(), async (fixture) => {
      const list = (await (await fetch(`${fixture.origin}/api/v1/products`)).json()) as {
        total: number;
      };
      expect(list.total).toBe(3);

      const member = await (await fetch(`${fixture.origin}/api/v1/products/2`)).json();
      expect(member).toEqual({ id: "2", name: "Red widget", price: 12.5 });
    });
  });

  it("answers JSON, not HTML, for an unknown path", async () => {
    // A JSON API that 404s with an HTML page surprises every client that
    // parses the body, for reasons unrelated to what is being tested.
    await withFixture(restApi(), async (fixture) => {
      const response = await fetch(`${fixture.origin}/api/v1/nope`);
      expect(response.status).toBe(404);
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(await response.json()).toEqual({ error: "not_found" });
    });
  });

  it("enforces a real ordering dependency between cart and orders", async () => {
    // §15 correlates API dependencies from observed traffic. The fixture has
    // to actually enforce the dependency, or there is nothing to discover.
    await withFixture(restApi(), async (fixture) => {
      const early = await fetch(`${fixture.origin}/api/v1/orders`, { method: "POST" });
      expect(early.status).toBe(409);
      expect(await early.json()).toEqual({ error: "cart_empty" });

      await fetch(`${fixture.origin}/api/v1/cart/items`, {
        method: "POST",
        body: JSON.stringify({ productId: "3", quantity: 1 }),
      });

      const placed = await fetch(`${fixture.origin}/api/v1/orders`, { method: "POST" });
      expect(placed.status).toBe(201);
      expect(await placed.json()).toEqual({ id: "ord_3x1", status: "placed" });
    });
  });

  it("empties the cart once an order is placed", async () => {
    await withFixture(restApi(), async (fixture) => {
      await fetch(`${fixture.origin}/api/v1/cart/items`, {
        method: "POST",
        body: JSON.stringify({ productId: "1", quantity: 1 }),
      });
      await fetch(`${fixture.origin}/api/v1/orders`, { method: "POST" });

      expect(await (await fetch(`${fixture.origin}/api/v1/cart`)).json()).toEqual({
        items: [],
        total: 0,
      });
    });
  });

  it("rejects a malformed or unknown cart addition", async () => {
    await withFixture(restApi(), async (fixture) => {
      const post = async (body: string): Promise<Response> =>
        fetch(`${fixture.origin}/api/v1/cart/items`, { method: "POST", body });

      expect((await post("not json")).status).toBe(400);
      expect((await post(JSON.stringify({}))).status).toBe(400);
      expect((await post(JSON.stringify({ productId: "999" }))).status).toBe(404);
    });
  });

  it("gates an admin endpoint behind a 401 with a challenge", async () => {
    // A role-gated endpoint (§9.5): discoverable, but not reachable, which is
    // exactly the case coverage accounting has to represent honestly.
    await withFixture(restApi(), async (fixture) => {
      const response = await fetch(`${fixture.origin}/api/v1/admin/users`);
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toContain("Bearer");
    });
  });

  it("totals a cart without floating-point drift", async () => {
    await withFixture(restApi(), async (fixture) => {
      for (const productId of ["1", "2", "3"]) {
        await fetch(`${fixture.origin}/api/v1/cart/items`, {
          method: "POST",
          body: JSON.stringify({ productId, quantity: 1 }),
        });
      }
      const cart = (await (await fetch(`${fixture.origin}/api/v1/cart`)).json()) as {
        total: number;
      };
      // 9.99 + 12.5 + 11 — which in raw floating point is 33.489999999999995.
      expect(cart.total).toBe(33.49);
    });
  });
});
