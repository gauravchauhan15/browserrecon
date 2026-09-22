import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir, platform } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { run } from "@browserrecon/cli";
import { resolveChromePath, type ChromeProbes } from "@browserrecon/browser-manager";
import { readAllEvents } from "@browserrecon/event-store";
import { buildApiModel, buildSequences, type ApiModel } from "@browserrecon/api-model";
import {
  createTreeSitterAnalyzer,
  createAnalysisPipeline,
} from "@browserrecon/collector-javascript-discovery";
import {
  ORDER_ID,
  PARALLEL_PATHS,
  dynamicSite,
  formsSite,
  noisySite,
  parallelSite,
  startFixture,
  type RunningFixture,
} from "@browserrecon/fixtures";

/**
 * 🚦 The M2 gate — dev plan BR-M2-18; build plan §44 (V2).
 *
 * V2's claim: requests are correlated to interactions and navigation,
 * initiator relationships are represented, `caused_by` and `depends_on`
 * exist, sequences can be reconstructed, and correlation has deterministic
 * tests.
 *
 * The correlation packages are tested from literal event logs, which is what
 * §1.2 requires. What those tests cannot check is that the payload *shapes*
 * telemetry actually emits are the ones the model reads — both sides describe
 * the payload independently and a renamed field type-checks on both. So this
 * scans a real fixture with a real browser and builds the model from the log
 * that came out.
 */

const probes: ChromeProbes = {
  fileExists: (path) => existsSync(path),
  runCommand: (command, args) => {
    const result = spawnSync(command, [...args], { encoding: "utf8", timeout: 5_000 });
    if (result.error !== undefined || result.status !== 0) return undefined;
    return { stdout: `${result.stdout ?? ""}${result.stderr ?? ""}` };
  },
  platform: platform(),
  env: {},
};

const chrome = resolveChromePath(probes);
const CI = process.env.CI !== undefined && process.env.CI !== "" && process.env.CI !== "false";
const gateTest = chrome.found ? it : it.skip;

/** Scan a fixture and return the model built from its event log. */
async function scanAndModel(
  fixture: RunningFixture,
  extra: readonly string[] = [],
): Promise<{ model: ApiModel; sessionDir: string; code: number; out: string }> {
  const outputRoot = mkdtempSync(join(tmpdir(), "br-m2-"));
  const out: string[] = [];
  const err: string[] = [];

  const code = await run({
    argv: [
      "scan",
      fixture.origin,
      "--i-am-authorized",
      "--no-deny-loopback",
      "--allowed-origins",
      fixture.origin,
      "--out",
      outputRoot,
      ...extra,
    ],
    io: { out: (l) => out.push(l), err: (l) => err.push(l), env: {}, version: "0.1.0-gate" },
  });

  const sessionDir = join(outputRoot, readdirSync(outputRoot)[0] ?? "missing");
  const events = await readAllEvents(sessionDir);
  return {
    model: buildApiModel(events, { firstPartyOrigins: [fixture.origin] }),
    sessionDir,
    code,
    out: `${out.join("\n")}${err.join("\n")}`,
  };
}

describe("preconditions", () => {
  it("has a Chrome to drive, which is mandatory in CI", () => {
    if (CI) expect(chrome.found, "no Chrome in CI; the gate must not be skipped").toBe(true);
    expect(true).toBe(true);
  });
});

describe("V2: runtime APIs are tied to interactions and navigation", () => {
  gateTest(
    "attributes observed requests to the page that made them",
    async () => {
      const fixture = await startFixture(dynamicSite());
      try {
        const { model, code } = await scanAndModel(fixture, ["--max-pages", "6"]);
        expect(code).toBe(0);
        expect(model.apis.length).toBeGreaterThan(0);

        // Every observation knows where it came from. Without this the API
        // inventory is a list with no context, which is the thing §14 exists
        // to stop being the output.
        for (const api of model.apis) {
          for (const observation of api.observations) {
            expect(observation.page, `${api.method} ${api.url}`).toBeDefined();
            expect(observation.authContext).toBe("anonymous");
          }
        }
      } finally {
        await fixture.close();
      }
    },
    120_000,
  );

  gateTest(
    "represents the initiator chain telemetry actually emits",
    async () => {
      // The seam unit tests cannot check: both sides describe the payload
      // independently, and a renamed field type-checks on both.
      //
      // `noisy-site` fetches from an inline script at load, which is what
      // produces a script initiator with a stack. `dynamic-site` does not —
      // its calls need a click, and the runner does not click yet. That is
      // recorded in docs/architecture/m2-gate.md rather than hidden here.
      const fixture = await startFixture(noisySite());
      try {
        const { model } = await scanAndModel(fixture, ["--max-pages", "4"]);
        const scripted = model.apis.flatMap((api) =>
          api.observations.filter((o) => o.initiator.type === "script"),
        );

        expect(scripted.length, "no request was attributed to a script").toBeGreaterThan(0);
        // A stack, not just a type: the chain is what §15 asks for, and a
        // type with no frames says only that *some* script did it.
        expect(
          scripted.some((o) => o.initiator.frames.length > 0),
          "no initiator carried a call stack",
        ).toBe(true);
        expect(scripted.some((o) => o.initiator.scripts.length > 0)).toBe(true);
      } finally {
        await fixture.close();
      }
    },
    120_000,
  );

  gateTest(
    "attributes requests to the interaction that caused them",
    async () => {
      // This test used to assert the opposite. The runner navigated and
      // harvested but never clicked, so `interaction_id` was a field nothing
      // ever filled — §14's context was implemented, unit-tested against a
      // literal log, and unreachable in practice. The gate carried an
      // explicit test asserting the limitation was *still* true, which
      // failed the day the interaction phase landed. That is what it was for.
      const fixture = await startFixture(dynamicSite());
      try {
        const { model } = await scanAndModel(fixture, ["--max-pages", "6"]);
        const attributed = model.apis.flatMap((api) =>
          api.observations.filter((o) => o.interactionId !== undefined),
        );

        expect(
          attributed.length,
          "no request was attributed to an interaction",
        ).toBeGreaterThan(0);
        for (const observation of attributed) {
          expect(observation.interactionId).toMatch(/^int_\d{4}$/);
        }
      } finally {
        await fixture.close();
      }
    },
    120_000,
  );

  gateTest(
    "reaches endpoints that only exist behind a click",
    async () => {
      // The reason the phase exists. `dynamic-site` keeps two endpoints in a
      // chunk fetched on click; before this a scan saw the shell and
      // concluded the application was small.
      const fixture = await startFixture(dynamicSite());
      try {
        await scanAndModel(fixture, ["--max-pages", "6"]);
        const reached = new Set(fixture.requests.map((request) => request.pathname));

        expect(reached.has("/chunk-orders.js"), "the code-split chunk was never loaded").toBe(
          true,
        );
        for (const endpoint of ["/api/orders/pending", "/api/orders/archive"]) {
          expect(reached.has(endpoint), `${endpoint} was never reached`).toBe(true);
        }
      } finally {
        await fixture.close();
      }
    },
    120_000,
  );

  gateTest(
    "still issues no state-changing request, now that it clicks",
    async () => {
      // The property clicking most endangers. `forms-site` carries a delete
      // form and a money transfer labelled "Continue"; this reads the
      // server's own record rather than the scan's account of itself.
      const fixture = await startFixture(formsSite());
      try {
        const { code } = await scanAndModel(fixture, ["--max-pages", "10"]);
        expect(code).toBe(0);

        const written = fixture.requests.filter(
          (request) => !["GET", "HEAD", "OPTIONS"].includes(request.method),
        );
        expect(
          written.map((request) => `${request.method} ${request.pathname}`),
          "clicking caused a state-changing request",
        ).toEqual([]);
      } finally {
        await fixture.close();
      }
    },
    120_000,
  );
});

describe("V2: caused_by and depends_on are consistent", () => {
  gateTest(
    "finds no dependency between requests that were issued together",
    async () => {
      // The acceptance criterion, and §15's worst failure: a reader told
      // that GET /api/user depends on GET /api/cart will try to exploit an
      // ordering that was never required.
      const fixture = await startFixture(parallelSite());
      try {
        const { model, code } = await scanAndModel(fixture, ["--max-pages", "3"]);
        expect(code).toBe(0);

        const parallel = model.apis.filter((api) =>
          PARALLEL_PATHS.some((path) => api.url.endsWith(path)),
        );
        expect(parallel.length, "the parallel fixture produced no APIs").toBeGreaterThanOrEqual(
          3,
        );

        for (const api of parallel) {
          const betweenParallel = api.depends_on.filter((edge) =>
            parallel.some((other) => edge.target === `api:${other.api_id}`),
          );
          expect(
            betweenParallel.map((e) => `${api.api_id} -> ${e.target}`),
            "invented a dependency between concurrent requests",
          ).toEqual([]);
        }
      } finally {
        await fixture.close();
      }
    },
    120_000,
  );

  gateTest(
    "marks concurrent requests as parallel in the sequence",
    async () => {
      // The other half: saying nothing about concurrency is not the same as
      // saying it was concurrent.
      const fixture = await startFixture(parallelSite());
      try {
        const { model } = await scanAndModel(fixture, ["--max-pages", "3"]);
        const sequences = buildSequences(model);
        const positions = sequences.sequences.flatMap((s) => s.positions);
        const concurrent = positions.filter((p) => p.parallel_with.length > 0);

        expect(concurrent.length, "nothing was recognised as concurrent").toBeGreaterThan(0);
      } finally {
        await fixture.close();
      }
    },
    120_000,
  );

  gateTest(
    "states a basis for every edge it does produce",
    async () => {
      // An edge nobody can check is not evidence.
      const fixture = await startFixture(parallelSite());
      try {
        const { model } = await scanAndModel(fixture, ["--max-pages", "3"]);
        for (const api of model.apis) {
          for (const edge of [...api.caused_by, ...api.depends_on]) {
            expect(edge.basis.length, `${api.api_id} -> ${edge.target}`).toBeGreaterThan(10);
            expect([
              "direct",
              "inferred",
              "temporal",
              "sequence_candidate",
              "dependency_candidate",
            ]).toContain(edge.kind);
          }
        }
      } finally {
        await fixture.close();
      }
    },
    120_000,
  );

  gateTest(
    "never puts a captured value into an edge's basis",
    async () => {
      // `depends_on` is built by noticing a value flowed. The output records
      // which field, never what was in it.
      const fixture = await startFixture(parallelSite());
      try {
        const { model } = await scanAndModel(fixture, ["--max-pages", "3"]);
        const bases = model.apis.flatMap((api) => api.depends_on.map((e) => e.basis)).join(" ");
        expect(bases).not.toContain(ORDER_ID);
      } finally {
        await fixture.close();
      }
    },
    120_000,
  );
});

describe("V2: sequences can be reconstructed", () => {
  gateTest(
    "orders a page's calls and keeps their context",
    async () => {
      const fixture = await startFixture(dynamicSite());
      try {
        const { model } = await scanAndModel(fixture, ["--max-pages", "6"]);
        const sequences = buildSequences(model);

        expect(sequences.sequences.length).toBeGreaterThan(0);
        for (const sequence of sequences.sequences) {
          expect(sequence.positions.map((p) => p.step)).toEqual(
            sequence.positions.map((_, index) => index + 1),
          );
          for (const position of sequence.positions) {
            expect(position.authContext).toBe("anonymous");
            expect(position.eventId).toMatch(/^evt_\d{6}$/);
          }
        }
      } finally {
        await fixture.close();
      }
    },
    120_000,
  );
});

describe("V2: JS mining yields candidates with provenance", () => {
  gateTest(
    "finds endpoints that exist only in a lazily-loaded chunk",
    async () => {
      // `dynamic-site` keeps two endpoints only in a chunk fetched on click.
      // Static analysis of the entry bundle alone cannot see them.
      const fixture = await startFixture(dynamicSite());
      try {
        const chunk = await (await fetch(`${fixture.origin}/chunk-orders.js`)).text();
        const result = createTreeSitterAnalyzer().analyze({
          script: `${fixture.origin}/chunk-orders.js`,
          source: chunk,
          pageOrigin: fixture.origin,
        });

        expect(result.status).toBe("complete");
        expect(result.apis.map((a) => a.path)).toEqual(
          expect.arrayContaining(["/api/orders/pending", "/api/orders/archive"]),
        );

        // §10A.3: every candidate carries where in the code it was found.
        for (const api of result.apis) {
          expect(api.sources.length, api.path).toBeGreaterThan(0);
          expect(api.sources[0]?.script).toContain("chunk-orders.js");
          expect(api.sources[0]?.line).toBeGreaterThan(0);
        }
      } finally {
        await fixture.close();
      }
    },
    60_000,
  );
});

describe("V2: a malformed 5 MB bundle degrades without failing the scan", () => {
  gateTest(
    "returns partial findings rather than an error",
    async () => {
      // §10B.9's requirement, at the size the acceptance criterion names.
      // The bundle is valid for its first megabytes and truncated at the
      // end, which is exactly what a body-capture limit produces.
      const valid = 'fetch("/api/found/' + "x".repeat(20) + '");\n';
      const truncated = 'function broken() { fetch("/api/cut';
      const source = valid.repeat(Math.ceil((5 * 1024 * 1024) / valid.length)) + truncated;
      expect(source.length).toBeGreaterThan(5 * 1024 * 1024);

      const pipeline = createAnalysisPipeline({
        analyzer: createTreeSitterAnalyzer(),
        bounds: { maxAssetBytes: 16 * 1024 * 1024, timeBudgetMs: 60_000 },
      });

      const { result } = await pipeline.analyze({ script: "huge-broken.js", source });

      expect(result.status).toBe("partial");
      expect(result.limitReason).toBeTruthy();
      // The point: everything before the break survived.
      expect(result.apis.length).toBeGreaterThan(0);
      expect(pipeline.refused).toEqual({});
    },
    180_000,
  );
});

describe("V2: golden outputs are stable", () => {
  gateTest(
    "produces the same model from three scans of the same fixture",
    async () => {
      const fixture = await startFixture(parallelSite());
      try {
        const shapes: string[] = [];
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const { model } = await scanAndModel(fixture, ["--max-pages", "3"]);
          // The findings, not the measurements: event ids encode arrival
          // order, and M1 measured that Chrome's startup interleaving is not
          // stable. What must be stable is what the model concluded.
          // Sorted before comparing. `model.apis` is in first-appearance
          // order, and for four requests fired in one `Promise.all` the
          // order responses come back in is the browser's business — this
          // test was observed failing on it. What the product actually
          // guarantees is a sorted export (`toExportedApis`), which the M1
          // gate already compares byte for byte; asserting arrival order
          // here would be a stricter claim than anything downstream makes.
          //
          // What must be stable is the *set* and its contents.
          shapes.push(
            JSON.stringify(
              model.apis
                .map((api) => ({
                  method: api.method,
                  url: api.url.replace(fixture.origin, ""),
                  role: api.role,
                  statuses: api.statuses,
                  parameters: api.parameters,
                  depends_on: api.depends_on.map((e) => e.kind),
                }))
                .sort((a, b) => `${a.method} ${a.url}`.localeCompare(`${b.method} ${b.url}`)),
            ),
          );
        }
        const diff = (a: string, b: string): string => {
          const left = JSON.parse(a) as unknown[];
          const right = JSON.parse(b) as unknown[];
          for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
            const l = JSON.stringify(left[index]);
            const r = JSON.stringify(right[index]);
            if (l !== r) return `index ${index}:\n  A: ${l}\n  B: ${r}`;
          }
          return "";
        };
        expect(diff(shapes[0] ?? "[]", shapes[1] ?? "[]"), "run 2").toBe("");
        expect(diff(shapes[0] ?? "[]", shapes[2] ?? "[]"), "run 3").toBe("");
      } finally {
        await fixture.close();
      }
    },
    300_000,
  );
});
