import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir, platform } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { run } from "@browserrecon/cli";
import { resolveChromePath, type ChromeProbes } from "@browserrecon/browser-manager";
import { readAllEvents } from "@browserrecon/event-store";
import { createEnvelope, type EventEnvelope } from "@browserrecon/events";
import {
  MAXIMUM_SCORE,
  SCORE_PROVENANCE,
  COVERAGE_CAVEAT,
  GAP_REASONS,
  REMEDIES,
} from "@browserrecon/coverage";
import { WORKFLOW_RELATIONSHIPS } from "@browserrecon/workflows";
import { inDependencyOrder, prerequisitesOf } from "@browserrecon/correlation";
import {
  PROVENANCES,
  SURFACE_KINDS,
  SURFACE_SCHEMA_VERSION,
  assemble,
  buildAttackSurfaceSchema,
  resolveChain,
  validateSurface,
  type AssembledModel,
} from "@browserrecon/attack-surface";
import {
  BEACON_PATHS,
  dynamicSite,
  noisySite,
  parallelSite,
  webmcpSite,
  startFixture,
  type RunningFixture,
} from "@browserrecon/fixtures";

/**
 * 🚦 The M3 gate — dev plan BR-M3-12; build plan §44 (V3).
 *
 * V3's claim, in the plan's words: deterministic workflow, state and API
 * graphs exist *before any AI does*; §18.1's five false-positive controls
 * hold; coverage reports honestly and never claims completeness; and the
 * attack-surface model is documented, versioned and self-validating —
 * WebMCP included.
 *
 * ## What this file adds over the packages' own tests
 *
 * The V3 packages are tested against literal event logs, which §1.2 requires
 * and which is the only way to test them quickly. What that cannot check is
 * the *assembly*: whether the payload shapes a real browser emits are the
 * ones each stage reads, and whether a stage's output is the shape the next
 * stage expects. Both sides describe the seam independently and a renamed
 * field type-checks on both.
 *
 * That is not theoretical. Building this gate found three defects that every
 * unit test in the repository was green for, all of them at a seam:
 *
 *  1. Six of a six-page fixture's ten "APIs" were the HTML pages themselves,
 *     and a seventh a 404 favicon. §17A's `application_api` signal reads
 *     "first-party request with an application payload" and nothing checked
 *     the payload.
 *  2. No scan had ever classified anything as `polling_heartbeat`. The rule
 *     needs an interval; the model passed a running count and no interval, so
 *     the check returned false on its first line. Its unit tests pass because
 *     they hand the classifier an interval directly.
 *  3. A vendor's `session-replay.js` was reported as the application's own
 *     authentication infrastructure, because `AUTH_PATHS` matches a
 *     substring.
 *
 * Each is fixed with a unit test where it belongs. They are recorded here
 * because the reason this file exists is that nothing else would have found
 * them.
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

interface Scanned {
  readonly model: AssembledModel;
  readonly events: readonly EventEnvelope[];
  readonly sessionDir: string;
  readonly code: number;
}

/** Scan a fixture, then assemble the whole V3 pipeline from its log. */
async function scanAndAssemble(
  fixture: RunningFixture,
  extra: readonly string[] = [],
): Promise<Scanned> {
  const outputRoot = mkdtempSync(join(tmpdir(), "br-m3-"));
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
    io: { out: () => {}, err: (line) => err.push(line), env: {}, version: "0.1.0-gate" },
  });

  const sessionDir = join(outputRoot, readdirSync(outputRoot)[0] ?? "missing");
  const events = await readAllEvents(sessionDir);
  return {
    model: assemble({
      sessionId: "sess_0001",
      target: fixture.origin,
      events,
      firstPartyOrigins: [fixture.origin],
    }),
    events,
    sessionDir,
    code,
  };
}

describe("preconditions", () => {
  it("has a Chrome to drive, which is mandatory in CI", () => {
    if (CI) expect(chrome.found, "no Chrome in CI; the gate must not be skipped").toBe(true);
    expect(true).toBe(true);
  });
});

describe("V3: deterministic graphs, built before any AI exists", () => {
  gateTest(
    "assembles an API, state and workflow graph from one real scan",
    async () => {
      const fixture = await startFixture(dynamicSite());
      try {
        const { model, code } = await scanAndAssemble(fixture, ["--max-pages", "6"]);
        expect(code).toBe(0);

        // The API model, with only real endpoints in it.
        expect(model.api.apis.length).toBeGreaterThan(0);
        for (const api of model.api.apis) {
          expect(api.role, `${api.method} ${api.url}`).toBe("application_api");
        }

        // The state graph: §19's states come from evidence in the log.
        expect(model.state.initialState).toBe("anonymous");
        expect(model.state.states.length).toBeGreaterThan(1);
        expect(model.state.transitions.length).toBeGreaterThan(0);
        for (const transition of model.state.transitions) {
          expect(transition.provenance).toBe("derived");
          expect(model.state.states).toContain(transition.to);
        }

        // The workflow graph: candidates with the evidence that scored them.
        expect(model.workflows.candidates.length).toBeGreaterThan(0);
        for (const candidate of model.workflows.candidates) {
          expect(candidate.workflow_id).toMatch(/^wf_\d{4}$/);
          expect(candidate.evidence.length).toBeGreaterThan(0);
          expect(candidate.routes.length).toBeGreaterThan(0);
        }
        for (const edge of model.workflowGraph.edges) {
          expect(WORKFLOW_RELATIONSHIPS).toContain(edge.relationship);
        }

        // And the dependency graph, which must resolve without looping —
        // the traversal is cycle-safe, and a real log is where a cycle
        // would come from.
        expect(inDependencyOrder(model.dependencies).length).toBe(
          model.dependencies.nodes.length,
        );
        for (const api of model.api.apis) {
          expect(() => prerequisitesOf(model.dependencies, api.api_id)).not.toThrow();
        }
      } finally {
        await fixture.close();
      }
    },
    180_000,
  );

  gateTest(
    "claims nothing an AI would have to have said",
    async () => {
      // "Before any AI exists" is the load-bearing half of V3. §24's
      // vocabulary is how a reader tells a measurement from a guess, and at
      // this milestone there is nothing in the output that anything but code
      // produced. M4 will add `inferred`; until then its presence would mean
      // a stage is labelling its own guesses as somebody else's.
      const fixture = await startFixture(dynamicSite());
      try {
        const { model } = await scanAndAssemble(fixture, ["--max-pages", "6"]);

        for (const item of model.surface.items) {
          expect(PROVENANCES).toContain(item.provenance);
          expect(item.provenance, item.identity).toBe("observed");
          // §24: an AI-touched object carries its semantic layer. Absent is
          // not the same as empty, and at Tier 0 it must be absent.
          expect(item.semantic).toBeUndefined();
        }
        expect(SCORE_PROVENANCE).toBe("deterministic");
      } finally {
        await fixture.close();
      }
    },
    180_000,
  );

  gateTest(
    "produces the same model three times from the same fixture",
    async () => {
      // The acceptance criterion. Normalised the way the M2 gate settled on:
      // event ids encode arrival order and Chrome's startup interleaving is
      // not stable, so what must be identical is what the model concluded.
      const fixture = await startFixture(parallelSite());
      try {
        const shapes: string[] = [];
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const { model } = await scanAndAssemble(fixture, ["--max-pages", "3"]);
          shapes.push(
            JSON.stringify({
              apis: model.api.apis
                .map((api) => `${api.method} ${api.url.replace(fixture.origin, "")}`)
                .sort(),
              states: [...model.state.states].sort(),
              workflows: model.workflows.candidates
                .map((c) => `${c.routes.join(">")}@${c.confidence.toFixed(4)}`)
                .sort(),
              discarded: model.workflows.discarded,
              surface: model.surface.items
                .map((item) => `${item.kind} ${item.identity.replace(fixture.origin, "")}`)
                .sort(),
              score: model.score.score,
              coverage: model.coverage.dimensions.map(
                (d) => `${d.dimension}=${d.ratio ?? "-"}`,
              ),
            }),
          );
        }
        expect(shapes[1], "run 2 differed").toBe(shapes[0]);
        expect(shapes[2], "run 3 differed").toBe(shapes[0]);
      } finally {
        await fixture.close();
      }
    },
    300_000,
  );
});

/**
 * §18.1's five named false-positive controls, at the seam.
 *
 * The rules are unit-tested in `packages/workflows`. What is checked here is
 * that they still hold once the input is a real browser's log rather than a
 * literal array — which is where two of them turned out to be unreachable.
 *
 * Three of the five are asserted against a scan. Two need traffic no fixture
 * produces in a browser under a read-only policy — a timer running long
 * enough to establish an interval, and an SPA deep enough to run away — so
 * they are asserted by assembling a log that has it. That is not a weaker
 * test of the pipeline, since §1.2 requires the pipeline to run from a
 * recorded log with no browser present; it is a weaker test of the
 * *telemetry*, and docs/architecture/m3-gate.md says so.
 */
describe("V3: the five §18.1 false-positive controls", () => {
  let sequence = 0;
  const event = <T>(type: string, payload: T, atMs = 0): EventEnvelope => {
    sequence += 1;
    return createEnvelope({
      sequence,
      event_id: `evt_${String(sequence).padStart(6, "0")}`,
      session_id: "sess_0001",
      timestamp: new Date(atMs).toISOString(),
      type: type as never,
      provenance: "observed",
      auth_context: "anonymous",
      payload,
    });
  };
  const ORIGIN = "https://shop.example.com";
  /**
   * A request, with the stack a real application produces.
   *
   * Two frames: a shared `api.get()` wrapper on top and the screen's own
   * caller beneath it. Most applications look like this, and §18.1's merge
   * rule has to see past the wrapper — a log where every call has one
   * identical frame would quietly test something easier.
   */
  const call = (path: string, atMs: number): EventEnvelope[] => {
    const requestId = `r${sequence + 1}`;
    const caller = path.replace(/[^a-zA-Z0-9]/g, "_");
    return [
      event(
        "network_request",
        {
          requestId,
          url: `${ORIGIN}${path}`,
          method: "GET",
          resourceType: "Fetch",
          initiator: {
            type: "script",
            stack: [`get@${ORIGIN}/api-client.js:42:11`, `${caller}@${ORIGIN}/app.js:900:3`],
          },
        },
        atMs,
      ),
      event(
        "network_response",
        { requestId, url: `${ORIGIN}${path}`, status: 200, mimeType: "application/json" },
        atMs,
      ),
    ];
  };
  const fromLog = (events: EventEnvelope[]): AssembledModel =>
    assemble({
      sessionId: "sess_0001",
      target: ORIGIN,
      events,
      firstPartyOrigins: [ORIGIN],
    });

  gateTest(
    "1. polling is never clustered into a workflow",
    async () => {
      // The control is §17A classification, which has to remove the
      // heartbeat before workflow detection ever sees it. A browser scan
      // cannot establish an interval inside a page visit, so the traffic is
      // in the log rather than on the wire.
      sequence = 0;
      const events = [
        event("navigation_committed", { url: `${ORIGIN}/` }),
        ...[0, 5_000, 10_000, 15_000, 20_000, 25_000].flatMap((ms) =>
          call("/api/heartbeat", ms),
        ),
        event("interaction", { interactionId: "int_0001" }, 26_000),
        ...call("/api/cart", 26_100),
        ...call("/api/cart/items", 26_200),
        ...call("/api/checkout", 26_300),
      ];
      const model = fromLog(events);

      expect(model.api.apis.map((api) => api.identity.pathTemplate)).not.toContain(
        "/api/heartbeat",
      );
      expect(model.api.excluded).toContainEqual({ role: "polling_heartbeat", count: 6 });
      const routes = model.workflows.candidates.flatMap((c) => c.routes);
      expect(routes, "a heartbeat became a workflow step").not.toContain("/api/heartbeat");
      expect(routes.length, "the real flow was lost with it").toBeGreaterThan(0);
    },
    30_000,
  );

  gateTest(
    "2. analytics never becomes a workflow step",
    async () => {
      // On the wire, against the fixture built to be noisy: five beacons,
      // five vendor scripts and two first-party API calls, all from the same
      // page load and indistinguishable by volume.
      const fixture = await startFixture(noisySite());
      try {
        const { model } = await scanAndAssemble(fixture, ["--max-pages", "4"]);
        const surfaced = model.surface.items.map((item) => item.identity).join("\n");

        for (const beacon of BEACON_PATHS) {
          const path = beacon.split("?")[0] as string;
          expect(surfaced, `${path} reached the surface`).not.toContain(path);
        }
        for (const candidate of model.workflows.candidates) {
          for (const route of candidate.routes) {
            expect(route.startsWith("/vendor/"), `${route} became a workflow step`).toBe(false);
          }
        }
        // The counterweight: the two calls that matter survived the filter.
        expect(surfaced).toContain("/api/catalog");
      } finally {
        await fixture.close();
      }
    },
    180_000,
  );

  gateTest(
    "3. ID-varying instances are one route, not forty workflows",
    async () => {
      sequence = 0;
      const events = [
        event("navigation_committed", { url: `${ORIGIN}/` }),
        event("interaction", { interactionId: "int_0001" }, 100),
        ...Array.from({ length: 40 }, (_, index) =>
          call(`/api/orders/${index + 1}`, 200 + index * 7),
        ).flat(),
      ];
      const model = fromLog(events);

      expect(model.api.apis).toHaveLength(1);
      expect(model.api.apis[0]?.identity.pathTemplate).toBe("/api/orders/{id}");
      expect(model.workflows.candidates.length).toBeLessThanOrEqual(1);
      const surfaceIdentities = model.surface.items
        .filter((item) => item.kind === "api_endpoint")
        .map((item) => item.identity);
      expect(surfaceIdentities).toHaveLength(1);
    },
    30_000,
  );

  gateTest(
    "4. a long SPA session is not one giant workflow",
    async () => {
      // §16's soft navigation is a strong boundary signal precisely so a
      // session with no document load does not become a single candidate.
      sequence = 0;
      const events: EventEnvelope[] = [event("navigation_committed", { url: `${ORIGIN}/` })];
      for (let screen = 0; screen < 5; screen += 1) {
        const base = 1_000 + screen * 1_000;
        events.push(
          event("soft_navigation", { to: `/screen-${screen}`, kind: "pushState" }, base),
        );
        events.push(event("interaction", { interactionId: `int_000${screen}` }, base + 10));
        events.push(...call(`/api/screen-${screen}/list`, base + 20));
        events.push(...call(`/api/screen-${screen}/detail`, base + 30));
      }
      const model = fromLog(events);

      expect(model.workflows.candidates.length).toBeGreaterThanOrEqual(3);
      for (const candidate of model.workflows.candidates) {
        expect(candidate.routes.length, "one candidate swallowed the session").toBeLessThan(8);
      }
    },
    30_000,
  );

  gateTest(
    "5. concurrent requests are not turned into a chain",
    async () => {
      // On the wire. §15's worst failure: a reader told that GET /api/user
      // depends on GET /api/cart will try to exploit an ordering that was
      // never required.
      const fixture = await startFixture(parallelSite());
      try {
        const { model } = await scanAndAssemble(fixture, ["--max-pages", "3"]);
        const concurrent = model.api.apis.filter((api) => api.url.includes("/api/"));
        expect(concurrent.length).toBeGreaterThanOrEqual(3);

        for (const api of concurrent) {
          const invented = api.depends_on.filter((edge) =>
            concurrent.some((other) => edge.target === `api:${other.api_id}`),
          );
          expect(
            invented.map((edge) => `${api.api_id} -> ${edge.target}`),
            "invented a dependency between concurrent requests",
          ).toEqual([]);
        }
        for (const candidate of model.workflows.candidates) {
          expect(candidate.evidence.map((entry) => entry.factor)).not.toContain(
            "contains a depends_on edge",
          );
        }
      } finally {
        await fixture.close();
      }
    },
    180_000,
  );
});

describe("V3: coverage reports honestly", () => {
  gateTest(
    "never scores a real scan as complete",
    async () => {
      const fixture = await startFixture(dynamicSite());
      try {
        const { model } = await scanAndAssemble(fixture, ["--max-pages", "6"]);

        expect(MAXIMUM_SCORE).toBeLessThan(1);
        expect(model.score.score).toBeLessThanOrEqual(MAXIMUM_SCORE);
        expect(model.score.description).not.toMatch(/\b100%|\bcomplete\b|\bfull\b/i);
        // §10C.6's caveat travels with the model, not with whoever renders it.
        expect(model.surface.coverage_caveat).toBe(COVERAGE_CAVEAT);
        expect(model.surface.coverage_caveat.length).toBeGreaterThan(40);

        // A dimension that found nothing scores nothing, rather than scoring
        // zero — "we did not look" and "we looked and it was not there" are
        // different claims.
        for (const dimension of model.coverage.dimensions) {
          if (dimension.total === 0) expect(dimension.ratio).toBeUndefined();
          else expect(dimension.ratio).toBeGreaterThanOrEqual(0);
        }
      } finally {
        await fixture.close();
      }
    },
    180_000,
  );

  gateTest(
    "says what it did not reach, with a reason and a response",
    async () => {
      // The report the CLI writes, not the model: this is the artifact a
      // person reads. An empty gap queue with a high score would be the
      // dishonest combination §10C exists to prevent.
      const fixture = await startFixture(dynamicSite());
      try {
        const { sessionDir } = await scanAndAssemble(fixture, ["--max-pages", "2"]);
        const report = readFileSync(join(sessionDir, "report.md"), "utf8");

        expect(report).toMatch(/not reach|unreached|gap/i);
        // Every reason in the vocabulary has a response, except the one
        // where §10C.7 says honestly that nothing applies.
        for (const reason of GAP_REASONS) {
          if (reason === "not_navigable") continue;
          expect(REMEDIES[reason], reason).toBeTruthy();
        }
      } finally {
        await fixture.close();
      }
    },
    180_000,
  );
});

describe("V3: the attack-surface model is documented, versioned and self-validating", () => {
  gateTest(
    "writes a surface that passes its own contract and its own schema",
    async () => {
      const fixture = await startFixture(dynamicSite());
      try {
        const { model, events, sessionDir } = await scanAndAssemble(fixture, [
          "--max-pages",
          "6",
        ]);

        const onDisk = JSON.parse(readFileSync(join(sessionDir, "surface.json"), "utf8")) as {
          schema_version: string;
          items: { surface_id: string; kind: string }[];
          coverage_caveat: string;
        };
        expect(onDisk.schema_version).toBe(SURFACE_SCHEMA_VERSION);
        expect(onDisk.coverage_caveat).toBeTruthy();
        for (const item of onDisk.items) expect(SURFACE_KINDS).toContain(item.kind);

        // Self-validating: the model refuses itself when the chain is broken,
        // and the scan wrote this one, so it must be clean.
        const known = {
          knownWorkflows: new Set(model.workflows.candidates.map((c) => c.workflow_id)),
          knownApis: new Set(model.api.apis.map((api) => api.api_id)),
          knownEvents: new Set(events.map((envelope) => envelope.event_id)),
          knownInteractions: new Set(
            events
              .filter((envelope) => envelope.type === "interaction")
              .map((envelope) => (envelope.payload as { interactionId?: string }).interactionId)
              .filter((id): id is string => id !== undefined),
          ),
          knownNavigations: new Set(
            events
              .map((envelope) => envelope.navigation_id)
              .filter((id): id is string => id !== undefined),
          ),
        };
        expect(validateSurface(model.surface, known)).toEqual([]);

        // §35B.5, walked rather than asserted: every item resolves all the
        // way back to events that are in the log this scan wrote.
        expect(model.surface.items.length).toBeGreaterThan(0);
        for (const item of model.surface.items) {
          const chain = resolveChain(item, known);
          for (const link of chain) {
            expect(link.resolved, `${item.identity}: ${link.level} ${link.id}`).toBe(true);
          }
        }

        // Documented and versioned: the published schema describes it.
        const schema = buildAttackSurfaceSchema();
        expect(schema.$id).toBeTruthy();
        expect(schema.description).toBeTruthy();
      } finally {
        await fixture.close();
      }
    },
    180_000,
  );

  gateTest(
    "refuses a surface whose chain does not resolve",
    async () => {
      // The counterweight. A validator nobody has seen reject anything is a
      // function that returns an empty array.
      const fixture = await startFixture(dynamicSite());
      try {
        const { model } = await scanAndAssemble(fixture, ["--max-pages", "6"]);
        const problems = validateSurface(model.surface, {
          knownWorkflows: new Set(),
          knownApis: new Set(),
          knownEvents: new Set(),
          knownInteractions: new Set(),
          knownNavigations: new Set(),
        });
        expect(problems.length).toBeGreaterThan(0);
      } finally {
        await fixture.close();
      }
    },
    180_000,
  );

  gateTest(
    "puts the page's WebMCP tools in the surface",
    async () => {
      // §44's fourth clause for V3. A page that registers tools publishes
      // named operations to any agent that visits, and it sends no network
      // traffic doing it — so nothing else in this pipeline would see it,
      // and the one part of the surface invisible to traffic analysis would
      // be the one part this tool omits.
      const fixture = await startFixture(webmcpSite());
      try {
        const { model } = await scanAndAssemble(fixture, ["--max-pages", "4"]);
        const tools = model.surface.items.filter((item) => item.kind === "webmcp_tool");

        expect(tools.length, "no WebMCP tool reached the surface").toBeGreaterThan(0);
        for (const tool of tools) {
          expect(tool.source_event_ids.length).toBeGreaterThan(0);
          expect(tool.auth_context).toBeTruthy();
        }
        expect(
          model.coverage.dimensions.find((d) => d.dimension === "webmcp")?.total,
        ).toBeGreaterThan(0);
      } finally {
        await fixture.close();
      }
    },
    180_000,
  );
});
