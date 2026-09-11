import { describe, expect, it } from "vitest";
import { restApi, staticSite, withFixture } from "@browserrecon/fixtures";
import { combine, normalizeText } from "./normalize.js";
import { expectGolden } from "./snapshot.js";
import { goldenEnvironment } from "./index.js";

/**
 * Golden baselines for the fixture apps' own output.
 *
 * BR-M0-13's tests assert *properties* — this page has a form, that endpoint
 * answers 401. This pins the exact bytes. The two catch different things: a
 * property test still passes when someone rewords a page, adds a tracking
 * script, or changes a JSON field name, and every one of those silently moves
 * the ground under the M1 tests that will assert against these pages.
 *
 * It also exercises the text path through the normalizer, which the event-log
 * subject does not touch.
 */

const golden = goldenEnvironment(process.env, new URL("../baselines/", import.meta.url));

const STATIC_PAGES = [
  "/",
  "/about",
  "/products",
  "/products/1",
  "/products/9",
  "/contact",
  "/app.js",
  "/robots.txt",
  "/sitemap.xml",
  "/orphan",
] as const;

const API_CALLS = [
  ["GET", "/api/v1/products"],
  ["GET", "/api/v1/products/2"],
  ["GET", "/api/v1/products/99"],
  ["GET", "/api/v1/cart"],
  ["GET", "/api/v1/admin/users"],
  ["GET", "/api/v1/nope"],
] as const;

describe("fixture output", () => {
  it("serves the static site its baseline describes", async () => {
    await withFixture(staticSite(), async (fixture) => {
      const parts = await Promise.all(
        STATIC_PAGES.map(async (path) => {
          const response = await fetch(`${fixture.origin}${path}`, { redirect: "manual" });
          const body = await response.text();
          return [
            `${path} (${response.status} ${response.headers.get("content-type") ?? "no type"})`,
            normalizeText(body),
          ] as const;
        }),
      );
      expectGolden("static-site", combine(parts), golden);
    });
  });

  it("serves the API its baseline describes", async () => {
    await withFixture(restApi(), async (fixture) => {
      const parts = await Promise.all(
        API_CALLS.map(async ([method, path]) => {
          const response = await fetch(`${fixture.origin}${path}`, { method });
          return [
            `${method} ${path} (${response.status})`,
            normalizeText(await response.text()),
          ] as const;
        }),
      );
      expectGolden("rest-api", combine(parts), golden);
    });
  });

  it("masks nothing in a fixture page, because nothing in one varies", async () => {
    // A useful canary. These pages are fully deterministic by design, so any
    // masking at all here means either a fixture has become nondeterministic
    // or a mask rule has grown too broad.
    await withFixture(staticSite(), async (fixture) => {
      const body = await (await fetch(`${fixture.origin}/products/1`)).text();
      expect(normalizeText(body).report).toEqual({});
    });
  });
});
