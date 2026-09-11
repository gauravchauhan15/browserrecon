import { describe, expect, it } from "vitest";
import { startFixture, withFixture } from "./harness.js";
import type { FixtureApp } from "./types.js";

/** Minimal app for testing the harness itself rather than a real fixture. */
const tinyApp: FixtureApp = {
  name: "tiny",
  routes: [
    { method: "GET", path: "/", handler: () => ({ status: 200, body: "root" }) },
    {
      method: "GET",
      path: "/echo/:word",
      handler: (request) => ({ status: 200, body: `word=${request.params.word ?? ""}` }),
    },
    {
      method: "POST",
      path: "/submit",
      handler: (request) => ({ status: 200, body: `got:${request.body}` }),
    },
    {
      method: "GET",
      path: "/query",
      handler: (request) => ({ status: 200, body: JSON.stringify(request.query) }),
    },
    {
      method: "GET",
      path: "/boom",
      handler: () => {
        throw new Error("deliberate");
      },
    },
  ],
};

describe("lifecycle", () => {
  it("starts on an ephemeral port and reports its own origin", async () => {
    await withFixture(tinyApp, async (fixture) => {
      expect(fixture.port).toBeGreaterThan(0);
      expect(fixture.origin).toBe(`http://127.0.0.1:${fixture.port}`);
      expect(await (await fetch(fixture.origin)).text()).toBe("root");
    });
  });

  it("runs many instances at once without colliding", async () => {
    // Vitest runs test files in parallel workers, so a fixed port would make
    // the suite fail depending on what else happened to be running.
    const fixtures = await Promise.all([
      startFixture(tinyApp),
      startFixture(tinyApp),
      startFixture(tinyApp),
      startFixture(tinyApp),
    ]);
    try {
      const ports = fixtures.map((fixture) => fixture.port);
      expect(new Set(ports).size).toBe(ports.length);
      for (const fixture of fixtures) {
        expect(await (await fetch(fixture.origin)).text()).toBe("root");
      }
    } finally {
      await Promise.all(fixtures.map((fixture) => fixture.close()));
    }
  });

  it("binds loopback only, never every interface", async () => {
    // A fixture on 0.0.0.0 publishes a fake app with fake credentials to
    // whatever network the tester is on.
    await withFixture(tinyApp, async (fixture) => {
      expect(fixture.origin.startsWith("http://127.0.0.1:")).toBe(true);
    });
  });

  it("stops listening once closed", async () => {
    const fixture = await startFixture(tinyApp);
    const { origin } = fixture;
    await fixture.close();
    await expect(fetch(origin)).rejects.toThrow();
  });

  it("survives being closed twice", async () => {
    // Teardown runs in a `finally`, and a test that also closes explicitly
    // should not turn a passing test into an unhandled rejection.
    const fixture = await startFixture(tinyApp);
    await fixture.close();
    await expect(fixture.close()).resolves.toBeUndefined();
  });

  it("closes promptly after a keep-alive request", async () => {
    // An idle keep-alive socket holds the server open. Without
    // closeIdleConnections this hangs for the keep-alive timeout, which shows
    // up as a mystery timeout in some unrelated test file.
    const fixture = await startFixture(tinyApp);
    await (await fetch(fixture.origin)).text();
    await expect(fixture.close()).resolves.toBeUndefined();
  });

  it("accepts a fixed port when something outside the process needs one", async () => {
    // Ephemeral is the default and the right choice; a caller that genuinely
    // needs a known port must still be able to ask.
    const probe = await startFixture(tinyApp);
    const { port } = probe;
    await probe.close();

    const fixed = await startFixture(tinyApp, { port });
    try {
      expect(fixed.port).toBe(port);
    } finally {
      await fixed.close();
    }
  });
});

describe("routing", () => {
  it("captures :name segments", async () => {
    await withFixture(tinyApp, async (fixture) => {
      expect(await (await fetch(`${fixture.origin}/echo/hello`)).text()).toBe("word=hello");
    });
  });

  it("decodes a percent-encoded segment", async () => {
    await withFixture(tinyApp, async (fixture) => {
      expect(await (await fetch(`${fixture.origin}/echo/a%20b`)).text()).toBe("word=a b");
    });
  });

  it("does not let an empty segment satisfy a parameter", async () => {
    // `/echo/` matching `/echo/:word` would hand the handler an empty id and
    // look like a real request for an unnamed thing.
    await withFixture(tinyApp, async (fixture) => {
      expect((await fetch(`${fixture.origin}/echo/`)).status).toBe(404);
    });
  });

  it("parses the query string and ignores it when matching", async () => {
    await withFixture(tinyApp, async (fixture) => {
      const response = await fetch(`${fixture.origin}/query?a=1&b=two`);
      expect(await response.json()).toEqual({ a: "1", b: "two" });
    });
  });

  it("answers 405 when the path exists under another method", async () => {
    // The distinction matters to a recon tool: 405 proves the endpoint is
    // there, 404 says nothing is.
    await withFixture(tinyApp, async (fixture) => {
      const response = await fetch(`${fixture.origin}/submit`);
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("POST");
    });
  });

  it("answers 404 for a path no route claims", async () => {
    await withFixture(tinyApp, async (fixture) => {
      expect((await fetch(`${fixture.origin}/nowhere`)).status).toBe(404);
    });
  });

  it("prefers the route declared first when two patterns overlap", async () => {
    // How `/products/9` wins over `/products/:id` in the static-site fixture.
    // Declaration order is the rule, so it has to be asserted.
    const app: FixtureApp = {
      name: "overlap",
      routes: [
        {
          method: "GET",
          path: "/thing/special",
          handler: () => ({ status: 200, body: "exact" }),
        },
        { method: "GET", path: "/thing/:id", handler: () => ({ status: 200, body: "param" }) },
      ],
    };
    await withFixture(app, async (fixture) => {
      expect(await (await fetch(`${fixture.origin}/thing/special`)).text()).toBe("exact");
      expect(await (await fetch(`${fixture.origin}/thing/other`)).text()).toBe("param");
    });
  });

  it("passes a request body to the handler", async () => {
    await withFixture(tinyApp, async (fixture) => {
      const response = await fetch(`${fixture.origin}/submit`, {
        method: "POST",
        body: "payload",
      });
      expect(await response.text()).toBe("got:payload");
    });
  });

  it("turns a throwing handler into a 500 that names the fixture", async () => {
    // A fixture bug that appears as a hung socket is far worse to diagnose
    // than one that says which app and which error.
    await withFixture(tinyApp, async (fixture) => {
      const response = await fetch(`${fixture.origin}/boom`);
      expect(response.status).toBe(500);
      expect(await response.text()).toContain('fixture "tiny" handler threw: deliberate');
    });
  });

  it("computes content-length rather than trusting a handler", async () => {
    await withFixture(tinyApp, async (fixture) => {
      const response = await fetch(`${fixture.origin}/echo/abc`);
      expect(response.headers.get("content-length")).toBe("8");
    });
  });
});

describe("request recording", () => {
  it("records each request in arrival order with its status", async () => {
    await withFixture(tinyApp, async (fixture) => {
      await (await fetch(fixture.origin)).text();
      await (await fetch(`${fixture.origin}/nowhere`)).text();

      expect(fixture.requests.map((r) => [r.sequence, r.pathname, r.status])).toEqual([
        [1, "/", 200],
        [2, "/nowhere", 404],
      ]);
    });
  });

  it("numbers requests instead of timestamping them", async () => {
    // A timestamp would make every assertion over the recording unstable, and
    // the recording has to be as reproducible as the responses.
    await withFixture(tinyApp, async (fixture) => {
      await (await fetch(fixture.origin)).text();
      const [recorded] = fixture.requests;
      expect(recorded).toBeDefined();
      expect(Object.keys(recorded ?? {})).not.toContain("time");
      expect(Object.keys(recorded ?? {})).not.toContain("timestamp");
    });
  });

  it("records the host header verbatim, port and all", async () => {
    // The one non-reproducible field in the package. Recorded rather than
    // scrubbed so the fixture does not misrepresent what arrived, and pinned
    // here so BR-M0-14's normalizer has a documented reason to mask it rather
    // than discovering it as an intermittent golden-test diff.
    await withFixture(tinyApp, async (fixture) => {
      await (await fetch(fixture.origin)).text();
      expect(fixture.requests[0]?.headers.host).toBe(`127.0.0.1:${fixture.port}`);
    });
  });

  it("clears the log on request without restarting the server", async () => {
    await withFixture(tinyApp, async (fixture) => {
      await (await fetch(fixture.origin)).text();
      fixture.resetRequests();
      expect(fixture.requests).toHaveLength(0);

      await (await fetch(fixture.origin)).text();
      expect(fixture.requests[0]?.sequence).toBe(1);
    });
  });
});
