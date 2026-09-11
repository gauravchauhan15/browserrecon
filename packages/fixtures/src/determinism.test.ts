import net from "node:net";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { installEgressGuard } from "@browserrecon/test-utils";
import { describe, expect, it } from "vitest";
import { ALL_FIXTURE_APPS, restApi, staticSite } from "./index.js";
import { startFixture, withFixture } from "./harness.js";

/**
 * A raw HTTP/1.1 request, returning the response bytes exactly as they came
 * off the socket — status line, headers and body.
 *
 * `fetch` cannot answer "are two responses byte-identical": it hands back a
 * parsed object with normalized, reordered headers, so a stray `Date` header
 * would survive the comparison. The determinism claim is about the wire, so
 * the test reads the wire.
 */
function rawRequest(port: number, method: string, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const socket = net.connect(port, "127.0.0.1", () => {
      // `Connection: close` makes reading to EOF sufficient. The Host header
      // deliberately carries no port — that is the one value which genuinely
      // differs between runs.
      socket.write(
        `${method} ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`,
      );
    });
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    socket.on("error", reject);
  });
}

/** Paths exercised on every app, chosen to cover each response shape. */
const PROBE_PATHS: Readonly<Record<string, readonly [string, string][]>> = {
  "static-site": [
    ["GET", "/"],
    ["GET", "/about"],
    ["GET", "/products"],
    ["GET", "/products/1"],
    ["GET", "/products/9"],
    ["GET", "/products/404"],
    ["GET", "/contact"],
    ["GET", "/app.js"],
    ["GET", "/robots.txt"],
    ["GET", "/sitemap.xml"],
    ["GET", "/orphan"],
    ["GET", "/gone"],
    ["GET", "/old-home"],
    ["GET", "/nowhere"],
    ["POST", "/contact"],
  ],
  "framed-site": [
    ["GET", "/frames"],
    ["GET", "/frames/panel"],
    ["GET", "/frames/deep"],
    ["GET", "/frames/leaf"],
    ["GET", "/frames/late"],
    ["GET", "/api/panel"],
    ["GET", "/api/leaf"],
    ["GET", "/second"],
  ],
  "realtime-site": [
    ["GET", "/"],
    // /sse is deliberately absent. It is a stream, so its raw bytes include
    // chunked-transfer framing that the runtime is free to arrange
    // differently — comparing them would test Node's chunking, not the
    // fixture. Its content is asserted directly in the telemetry tests.
    ["GET", "/nowhere"],
  ],
  "rest-api": [
    ["GET", "/api/v1/products"],
    ["GET", "/api/v1/products/2"],
    ["GET", "/api/v1/products/99"],
    ["GET", "/api/v1/cart"],
    ["GET", "/api/v1/admin/users"],
    ["GET", "/api/v1/nope"],
    ["POST", "/api/v1/orders"],
  ],
};

describe("the registry", () => {
  it("lists every app in src/apps, so none escapes these guarantees", async () => {
    // The array is what the determinism, no-egress and no-clock guarantees are
    // applied to, so an app missing from it is an app exempt from all of them
    // — silently. That is not hypothetical: realtime-site was written,
    // exported and imported here, and simply never added to the list. Nothing
    // failed, and it would have shipped unguarded.
    const appsDir = fileURLToPath(new URL("./apps/", import.meta.url));
    const files = readdirSync(appsDir).filter(
      (name) => name.endsWith(".ts") && !name.endsWith(".test.ts"),
    );

    const exported = files.flatMap((file) => {
      const source = readFileSync(join(appsDir, file), "utf8");
      return [...source.matchAll(/export function (\w+)\(\): FixtureApp/g)].map(
        (match) => match[1] as string,
      );
    });

    expect(exported.length).toBeGreaterThanOrEqual(4);
    const registered = ALL_FIXTURE_APPS.map((build) => build.name);
    for (const name of exported) {
      expect(registered, `${name} is not in ALL_FIXTURE_APPS`).toContain(name);
    }
  });
});

describe("byte-identical responses across runs", () => {
  it.each(ALL_FIXTURE_APPS.map((build) => [build().name, build] as const))(
    "%s answers identically on a second, separately started instance",
    async (name, build) => {
      // Two independent servers on two different ports — which catches port
      // leakage into a response, state bleeding between instances, and
      // order-dependent output. It does NOT catch a time-derived header: both
      // requests land in the same second, so a `Date` would match. The two
      // tests below cover that.
      const paths = PROBE_PATHS[name];
      expect(paths, `no probe paths declared for ${name}`).toBeDefined();

      const first = await startFixture(build());
      const second = await startFixture(build());
      try {
        expect(first.port).not.toBe(second.port);

        for (const [method, path] of paths ?? []) {
          const a = await rawRequest(first.port, method, path);
          const b = await rawRequest(second.port, method, path);
          expect(b, `${method} ${path} differed between runs`).toBe(a);
        }
      } finally {
        await Promise.all([first.close(), second.close()]);
      }
    },
  );

  it("answers identically more than a second apart, not just back to back", async () => {
    // The one test here that deliberately waits. Golden-output baselines
    // (§36.2) are recorded once and compared weeks later, so "identical across
    // runs" has to mean across *time*, not merely across two sockets opened in
    // the same millisecond. Crossing a second boundary is what exposes a
    // clock-derived header, and Node's own `Date` header has exactly one
    // second of resolution.
    await withFixture(staticSite(), async (fixture) => {
      const before = await rawRequest(fixture.port, "GET", "/products/1");
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      const after = await rawRequest(fixture.port, "GET", "/products/1");
      expect(after).toBe(before);
    });
  });

  it("emits no Date header, which would differ on every response", async () => {
    // The single most likely way determinism breaks here: Node adds this
    // automatically unless it is explicitly switched off.
    await withFixture(staticSite(), async (fixture) => {
      const raw = await rawRequest(fixture.port, "GET", "/");
      expect(raw.toLowerCase()).not.toContain("\r\ndate:");
    });
  });

  it("never puts an ephemeral port in a Location header", async () => {
    // An absolute redirect target would embed the port, which changes per run
    // by design, so the response could not be byte-compared.
    await withFixture(staticSite(), async (fixture) => {
      const response = await fetch(`${fixture.origin}/old-home`, { redirect: "manual" });
      expect(response.status).toBe(301);
      expect(response.headers.get("location")).toBe("/");
    });
  });

  it("contains no absolute URL carrying a port in any response body", async () => {
    // Same trap one level down: a sitemap or a page that hardcoded
    // `http://127.0.0.1:PORT/...` would differ across runs.
    for (const build of ALL_FIXTURE_APPS) {
      const app = build();
      await withFixture(app, async (fixture) => {
        for (const [method, path] of PROBE_PATHS[app.name] ?? []) {
          const raw = await rawRequest(fixture.port, method, path);
          expect(raw, `${app.name} ${method} ${path}`).not.toMatch(/127\.0\.0\.1:\d+/);
        }
      });
    }
  });
});

describe("state is per-instance", () => {
  it("gives every server a fresh cart", async () => {
    // The failure this guards against: a handler closing over a module-level
    // variable, so the second test in a file inherits the first one's state
    // and passes or fails depending on ordering.
    const first = await startFixture(restApi());
    try {
      await fetch(`${first.origin}/api/v1/cart/items`, {
        method: "POST",
        body: JSON.stringify({ productId: "1", quantity: 2 }),
      });
      const cart = await (await fetch(`${first.origin}/api/v1/cart`)).json();
      expect(cart).toEqual({ items: [{ productId: "1", quantity: 2 }], total: 19.98 });
    } finally {
      await first.close();
    }

    await withFixture(restApi(), async (second) => {
      expect(await (await fetch(`${second.origin}/api/v1/cart`)).json()).toEqual({
        items: [],
        total: 0,
      });
    });
  });

  it("produces the same order id for the same request sequence", async () => {
    const place = async (): Promise<unknown> =>
      withFixture(restApi(), async (fixture) => {
        await fetch(`${fixture.origin}/api/v1/cart/items`, {
          method: "POST",
          body: JSON.stringify({ productId: "2", quantity: 3 }),
        });
        return (await fetch(`${fixture.origin}/api/v1/orders`, { method: "POST" })).json();
      });

    expect(await place()).toEqual(await place());
  });
});

describe("no clocks, no randomness", () => {
  /**
   * Source-level enforcement rather than a promise in a comment.
   *
   * A determinism guarantee that rests on everyone remembering the rule will
   * not survive the remaining fixtures (BR-M1-30 adds a dozen more, several of
   * them written to model timing behaviour). This makes the rule mechanical:
   * reaching for a clock or a random number in this package fails the build.
   */
  const srcDir = join(fileURLToPath(new URL(".", import.meta.url)));

  const sourceFiles = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return sourceFiles(path);
      return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [path] : [];
    });

  /** Strip comments, so prose *about* these constructs is not a false hit. */
  const stripComments = (code: string): string =>
    code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  // Label first so the test name reads "uses no Date.now() ..." rather than
  // printing the regex source.
  const FORBIDDEN: readonly [string, RegExp][] = [
    ["Date.now()", /\bDate\.now\s*\(/],
    ["new Date()", /\bnew\s+Date\s*\(/],
    ["Math.random()", /\bMath\.random\s*\(/],
    ["randomUUID()", /\brandomUUID\s*\(/],
    ["randomBytes()", /\brandomBytes\s*\(/],
    ["performance.now()", /\bperformance\.now\s*\(/],
    ["process.hrtime", /\bprocess\.hrtime\b/],
  ];

  it("finds the fixture sources it is meant to be checking", () => {
    // Without this the scan below passes trivially if the glob ever breaks.
    const files = sourceFiles(srcDir);
    expect(files.length).toBeGreaterThanOrEqual(5);
    expect(files.some((file) => file.endsWith("static-site.ts"))).toBe(true);
    expect(files.some((file) => file.endsWith("rest-api.ts"))).toBe(true);
  });

  it.each(FORBIDDEN)("uses no %s anywhere in the package", (label, pattern) => {
    const offenders = sourceFiles(srcDir).filter((file) =>
      pattern.test(stripComments(readFileSync(file, "utf8"))),
    );
    expect(offenders, `${label} found in ${offenders.join(", ")}`).toEqual([]);
  });
});

describe("no egress", () => {
  it("reaches nothing but loopback while serving every app", async () => {
    // The guard intercepts at Node's socket and DNS layers, so it catches an
    // outbound call made by any HTTP client, not just the one we expect.
    const guard = installEgressGuard({ throwOnViolation: false });
    try {
      for (const build of ALL_FIXTURE_APPS) {
        const app = build();
        await withFixture(app, async (fixture) => {
          for (const [method, path] of PROBE_PATHS[app.name] ?? []) {
            await fetch(`${fixture.origin}${path}`, { method, redirect: "manual" });
          }
        });
      }
      expect(guard.violations).toEqual([]);
      // And prove the guard was actually watching, rather than silently
      // installed over a code path that made no connections at all.
      expect(guard.attempts.length).toBeGreaterThan(0);
    } finally {
      guard.restore();
    }
  });
});
