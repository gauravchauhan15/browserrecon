import { normalizeUrl } from "@browserrecon/collector-network";
import { describe, expect, it } from "vitest";
import { ParameterTally, apiIdentity, isSensitiveParameterName } from "./index.js";

const id = (method: string, url: string) => apiIdentity(method, normalizeUrl(url));

describe("endpoint identity", () => {
  it("collapses instances of one route", () => {
    // Eighty product pages are one endpoint observed eighty times. Reporting
    // eighty APIs gives a reader a number about the catalogue, not the app.
    expect(id("GET", "https://shop.example.com/api/products/1").key).toBe(
      id("GET", "https://shop.example.com/api/products/2").key,
    );
  });

  it("keeps different methods apart", () => {
    // GET /orders and POST /orders are one path and two attack surfaces.
    expect(id("GET", "https://shop.example.com/api/orders").key).not.toBe(
      id("POST", "https://shop.example.com/api/orders").key,
    );
  });

  it("keeps different origins apart", () => {
    expect(id("GET", "https://shop.example.com/api/x").key).not.toBe(
      id("GET", "https://cdn.example.net/api/x").key,
    );
  });

  it("does not split an endpoint on its query string", () => {
    // `/search?q=shoes` and `/search?q=hats` are one endpoint taking a
    // parameter. Splitting them reintroduces exactly the inflation path
    // templating removes.
    expect(id("GET", "https://shop.example.com/search?q=shoes").key).toBe(
      id("GET", "https://shop.example.com/search?q=hats").key,
    );
  });

  it("never collapses two distinct words into one route", () => {
    // The dangerous direction. If `/about` became `/{slug}` then `/about`,
    // `/contact` and `/admin` would be one route, the scan would report one,
    // and the other two would vanish with no sign anything was missed.
    const paths = ["/about", "/contact", "/admin", "/login"];
    const keys = new Set(paths.map((path) => id("GET", `https://shop.example.com${path}`).key));
    expect(keys.size).toBe(paths.length);
  });

  it("normalizes the method", () => {
    expect(id("get", "https://shop.example.com/a").method).toBe("GET");
  });

  it("reports whether templating actually happened", () => {
    // `inferTemplate` answers for every http URL, returning the path
    // unchanged when nothing looked like an identifier. Treating "we got an
    // answer" as "it was templated" marks every static path templated.
    expect(id("GET", "https://shop.example.com/api/products/42").templated).toBe(true);
    expect(id("GET", "https://shop.example.com/api/products").templated).toBe(false);
  });

  it("names the rule behind each parameter", () => {
    const uuid = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
    const identity = id("GET", `https://shop.example.com/api/orders/${uuid}`);
    expect(identity.parameters).toEqual(["uuid"]);
    expect(identity.pathTemplate).toBe("/api/orders/{uuid}");
  });

  it("leaves a short hex segment alone", () => {
    // 8 hex characters could be a word. The rules require 16+ before
    // calling a hex run a hash, which errs toward a longer inventory rather
    // than a silently merged one.
    expect(id("GET", "https://shop.example.com/api/orders/8f14e45f").templated).toBe(false);
  });

  it("carries the path without the origin", () => {
    const identity = id("GET", "https://shop.example.com/api/products/1");
    expect(identity.pathTemplate.startsWith("/")).toBe(true);
    expect(identity.pathTemplate).not.toContain("shop.example.com");
  });
});

describe("observed query parameters", () => {
  it("counts occurrences and keeps a few example values", () => {
    const tally = new ParameterTally();
    tally.add({ sort: "price", page: "1" });
    tally.add({ sort: "name", page: "2" });

    const snapshot = tally.snapshot();
    expect(snapshot.map((p) => p.name)).toEqual(["page", "sort"]);
    expect(snapshot.find((p) => p.name === "sort")?.occurrences).toBe(2);
    expect(snapshot.find((p) => p.name === "sort")?.examples).toEqual(["name", "price"]);
  });

  it("never carries the value of a secret-shaped parameter", () => {
    // A query string is one of the commonest places a token ends up. The
    // redactor runs over the document on the way out, but a value dropped
    // here never reaches it — the cheaper guarantee.
    const tally = new ParameterTally();
    tally.add({ access_token: "eyJhbGciOi.secret", api_key: "sk-live-123", q: "shoes" });

    const snapshot = tally.snapshot();
    expect(snapshot.find((p) => p.name === "access_token")?.examples).toBeUndefined();
    expect(snapshot.find((p) => p.name === "api_key")?.examples).toBeUndefined();
    // And the name is still reported: that a token parameter exists is the
    // finding, and hiding the name would hide it.
    expect(snapshot.map((p) => p.name)).toContain("access_token");
    expect(snapshot.find((p) => p.name === "q")?.examples).toEqual(["shoes"]);
  });

  it("recognises the names that carry credentials", () => {
    for (const name of [
      "token",
      "access_token",
      "refresh_token",
      "api_key",
      "apikey",
      "session",
      "sid",
      "jwt",
      "signature",
      "password",
      "auth",
      "otp",
    ]) {
      expect(isSensitiveParameterName(name), name).toBe(true);
    }
  });

  it("does not treat ordinary names as sensitive", () => {
    // Over-matching costs the examples that make a report useful.
    for (const name of ["q", "page", "sort", "brand", "category", "limit", "offset"]) {
      expect(isSensitiveParameterName(name), name).toBe(false);
    }
  });

  it("caps the examples it keeps", () => {
    const tally = new ParameterTally();
    for (let n = 0; n < 50; n += 1) tally.add({ page: String(n) });
    expect(tally.snapshot()[0]?.examples?.length).toBeLessThanOrEqual(3);
  });

  it("sorts, so the same scan produces the same bytes", () => {
    const first = new ParameterTally();
    first.add({ b: "1", a: "2" });
    const second = new ParameterTally();
    second.add({ a: "2", b: "1" });
    expect(first.snapshot()).toEqual(second.snapshot());
  });
});

describe("camelCase names", () => {
  it("protects camelCase as well as snake_case", () => {
    // Found by a payload test: a pattern keyed only on `_`, `-` and `.`
    // missed the dominant JavaScript convention, so `accessToken` was
    // treated as an ordinary parameter and its value kept.
    for (const name of ["accessToken", "apiKey", "sessionId", "refreshToken", "authToken"]) {
      expect(isSensitiveParameterName(name), name).toBe(true);
    }
  });

  it("still does not over-match", () => {
    for (const name of ["pageSize", "sortOrder", "productId", "orderTotal"]) {
      expect(isSensitiveParameterName(name), name).toBe(false);
    }
  });
});
