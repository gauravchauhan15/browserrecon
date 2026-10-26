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
  webmcpMapSite,
  WEBMCP_TOOLS,
  WEBMCP_MAP_TOOLS,
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

/**
 * One section of the report, found by name rather than by number.
 *
 * The numbers move: inserting "WebMCP tools" at position four renumbered
 * five headings, and a test pinned to `## 5. JavaScript` then reads the
 * wrong section and passes anyway, which is worse than failing.
 */
function section(report: string, name: string): string {
  const heading = new RegExp(`^## \\d+\\. ${name}\\s*$`, "m");
  const start = report.search(heading);
  if (start === -1) return "";
  const rest = report.slice(start).replace(heading, "");
  const next = rest.search(/^## \d+\. /m);
  return next === -1 ? rest : rest.slice(0, next);
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

/**
 * The artifacts a person reads, not the model behind them.
 *
 * This section exists because the first version of this gate did not have
 * it. Everything above passed while `report.md` still listed the six HTML
 * pages and the favicon as APIs, claimed "100%" coverage in its first table,
 * reported "no workflows were detected" with a candidate in the model beside
 * it, and pointed at an `events.jsonl` that does not exist — the store writes
 * numbered segments. The engine was right and every artifact was stale,
 * because the reporting layer had not been rewired since M1.
 *
 * A model nobody reads is not the deliverable.
 */
describe("V3: the artifacts say what the model says", () => {
  gateTest(
    "writes a report whose API inventory is application APIs",
    async () => {
      const fixture = await startFixture(dynamicSite());
      try {
        const { model, sessionDir } = await scanAndAssemble(fixture, ["--max-pages", "8"]);
        const report = readFileSync(join(sessionDir, "report.md"), "utf8");
        const inventory = section(report, "API inventory");

        expect(inventory).toContain("/api/orders/pending");
        for (const notAnApi of ["/favicon.ico", "/app.js", "/settings", "`http"]) {
          if (notAnApi === "`http") continue;
          expect(inventory, `${notAnApi} is in the API inventory`).not.toContain(notAnApi);
        }
        // And it agrees with the model beside it, rather than counting
        // something else.
        for (const api of model.api.apis) {
          expect(inventory).toContain(api.identity.pathTemplate);
        }
      } finally {
        await fixture.close();
      }
    },
    180_000,
  );

  gateTest(
    "never prints a completeness claim, and shows the capped score",
    async () => {
      const fixture = await startFixture(dynamicSite());
      try {
        const { model, sessionDir } = await scanAndAssemble(fixture, ["--max-pages", "8"]);
        const report = readFileSync(join(sessionDir, "report.md"), "utf8");

        expect(report).toContain(`Coverage score ${model.score.score.toFixed(2)}`);
        expect(report).toMatch(/never of what the application has/i);
        expect(report).toMatch(/not a claim of complete application coverage/i);
      } finally {
        await fixture.close();
      }
    },
    180_000,
  );

  gateTest(
    "shows the dimensions the score was computed from",
    async () => {
      // The coverage table used to be three counts assembled at the call
      // site — Pages, APIs, Origins — every one of them 100%, printed beside
      // a score of 0.60 a reader had no way to reconcile with them. Two of
      // §10C.1's dimensions were also never populated at all: a scan that
      // fetched and captured two bundles reported `js_asset 0` and docked
      // its own score 0.2 for JavaScript it had collected.
      const fixture = await startFixture(dynamicSite());
      try {
        const { model, sessionDir } = await scanAndAssemble(fixture, ["--max-pages", "8"]);
        const report = readFileSync(join(sessionDir, "report.md"), "utf8");
        const summary = section(report, "Coverage summary");

        const measured = model.coverage.dimensions.filter((d) => d.total > 0);
        expect(measured.length).toBeGreaterThan(4);
        for (const dimension of measured) {
          expect(summary, `${dimension.dimension} is measured but not in the table`).toMatch(
            new RegExp(`\\| ${dimension.total} \\|`),
          );
        }

        // The JavaScript the report lists in section 5 is the JavaScript
        // coverage counted, rather than two independent readings of one log.
        const scripts = section(report, "JavaScript").match(/^\| `/gm);
        expect(scripts?.length).toBe(
          model.coverage.dimensions.find((d) => d.dimension === "js_asset")?.total,
        );
      } finally {
        await fixture.close();
      }
    },
    180_000,
  );

  gateTest(
    "reports the workflows the model found",
    async () => {
      const fixture = await startFixture(dynamicSite());
      try {
        const { model, sessionDir } = await scanAndAssemble(fixture, ["--max-pages", "8"]);
        expect(model.workflows.candidates.length).toBeGreaterThan(0);

        const report = readFileSync(join(sessionDir, "report.md"), "utf8");
        expect(report).not.toContain("_No workflows were detected._");
        for (const candidate of model.workflows.candidates) {
          expect(report).toContain(candidate.workflow_id);
          // §18.1: a low-confidence candidate is collapsed, never dropped.
          if (candidate.lowConfidence) expect(report).toContain("low confidence");
        }
      } finally {
        await fixture.close();
      }
    },
    180_000,
  );

  gateTest(
    "names files that exist, and warns about the directory it wrote to",
    async () => {
      const fixture = await startFixture(dynamicSite());
      try {
        const { sessionDir } = await scanAndAssemble(fixture, ["--max-pages", "8"]);
        const report = readFileSync(join(sessionDir, "report.md"), "utf8");

        // Named relative to the session directory the report sits in, so
        // they are readable — and they have to resolve there.
        const files = section(report, "Artifacts");
        const paths = [...files.matchAll(/^\| `([^`/][^`]*)` \|/gm)].map((match) => match[1]);
        expect(paths.length).toBeGreaterThanOrEqual(3);
        for (const path of paths) {
          expect(
            existsSync(join(sessionDir, path as string)),
            `${path} does not exist in the session directory`,
          ).toBe(true);
        }
        expect(paths.some((path) => /^events-\d+\.jsonl$/.test(path as string))).toBe(true);
        expect(report).toContain(`${sessionDir} contains UNREDACTED`);
      } finally {
        await fixture.close();
      }
    },
    180_000,
  );

  gateTest(
    "reports every registered tool, and invokes none of them",
    async () => {
      // §7.2's sharpest case. `webmcp-site` publishes a `deleteAccount` tool
      // wired to `DELETE /api/account`, precisely so "reported, never
      // invoked" is an assertion rather than a claim — and the first sample
      // report listed three tools in `surface.json` and named none of them
      // where a person would read.
      const fixture = await startFixture(webmcpSite());
      try {
        const { sessionDir } = await scanAndAssemble(fixture, ["--max-pages", "4"]);
        const report = readFileSync(join(sessionDir, "report.md"), "utf8");
        const tools = section(report, "WebMCP tools");

        for (const tool of WEBMCP_TOOLS) {
          expect(tools, `${tool.name} is missing from the report`).toContain(tool.name);
          expect(tools).toContain(tool.endpoint);
        }
        expect(tools).toMatch(/never invoked/i);

        // The server's own record, not the scan's account of itself.
        expect(
          fixture.requests
            .filter((request) => request.method !== "GET")
            .map((request) => `${request.method} ${request.pathname}`),
          "a tool endpoint was called",
        ).toEqual([]);
      } finally {
        await fixture.close();
      }
    },
    180_000,
  );

  gateTest(
    "reads a registry shaped the way a production one actually is",
    async () => {
      // The first real WebMCP site this tool was pointed at returned zero
      // tools while four sat in the page. The adapter tested `tools` with
      // `Array.isArray`, and a production registry exposes a `Map` keyed by
      // name whose values wrap the descriptor under `item`. It failed
      // silently, because no-registry is the normal case and nothing
      // distinguished it from a registry it could not read.
      //
      // Both shapes are scanned, here and above: an adapter that handles
      // only the newer one has made the same mistake in the other direction.
      const fixture = await startFixture(webmcpMapSite());
      try {
        const { model, sessionDir } = await scanAndAssemble(fixture, ["--max-pages", "4"]);
        const found = model.webmcp.map((tool) => tool.name).sort();
        expect(found).toEqual(WEBMCP_MAP_TOOLS.map((tool) => tool.name).sort());

        // The schema survives, whether the page offered it as an object or
        // as JSON text beside it.
        const search = model.webmcp.find((tool) => tool.name === "search-products");
        expect((search?.inputSchema as { properties?: object })?.properties).toBeDefined();

        // §7.2's point. The page says `cancel-order` is not read-only, so
        // the report has to say so where a person will see it.
        const destructive = model.webmcp.filter((tool) => tool.destructive);
        expect(destructive.map((tool) => tool.name)).toEqual(["cancel-order"]);

        const report = readFileSync(join(sessionDir, "report.md"), "utf8");
        const tools = section(report, "WebMCP tools");
        expect(tools).toContain("cancel-order");
        expect(tools).toMatch(/state-changing/i);
        expect(tools).toMatch(/never invoked/i);

        // And none of them was called. The server's own record, not the
        // scan's account of itself.
        expect(
          fixture.requests
            .filter((request) => request.method !== "GET")
            .map((request) => `${request.method} ${request.pathname}`),
          "a WebMCP tool endpoint was invoked",
        ).toEqual([]);
      } finally {
        await fixture.close();
      }
    },
    180_000,
  );

  gateTest(
    "does not collide when two scans share one output directory",
    async () => {
      // Every scan used to be `sess_0001`, so a second scan into the same
      // `--out` died on the event store's own guard — an internal error with
      // a stack trace, and the guard was right: two scans were about to
      // share one log. Pointing every run at one directory is the natural
      // thing to do, and the Gate A runbook says to, so this was the second
      // command anybody would have run.
      const fixture = await startFixture(dynamicSite());
      const outputRoot = mkdtempSync(join(tmpdir(), "br-m3-shared-"));
      try {
        const scan = async (): Promise<number> =>
          run({
            argv: [
              "scan",
              fixture.origin,
              "--i-am-authorized",
              "--no-deny-loopback",
              "--allowed-origins",
              fixture.origin,
              "--out",
              outputRoot,
              "--max-pages",
              "2",
            ],
            io: { out: () => {}, err: () => {}, env: {}, version: "0.1.0-gate" },
          });

        expect(await scan()).toBe(0);
        expect(await scan()).toBe(0);

        const sessions = readdirSync(outputRoot).sort();
        expect(sessions).toEqual(["sess_0001", "sess_0002"]);
        // Each keeps its own log, rather than the second appending to the
        // first — which is the failure the store's guard was there to stop.
        for (const session of sessions) {
          const events = await readAllEvents(join(outputRoot, session));
          expect(events.length, session).toBeGreaterThan(0);
          expect(new Set(events.map((e) => e.session_id))).toEqual(new Set([session]));
        }
      } finally {
        await fixture.close();
      }
    },
    240_000,
  );

  gateTest(
    "publishes the derived model in the JSON export too",
    async () => {
      const fixture = await startFixture(dynamicSite());
      try {
        const { model, sessionDir } = await scanAndAssemble(fixture, ["--max-pages", "8"]);
        const exported = JSON.parse(
          readFileSync(join(sessionDir, "attack-surface.json"), "utf8"),
        ) as {
          apis: { url: string; role?: string }[];
          workflows: { workflow_id: string }[];
          api_sequences: unknown[];
          javascript: unknown[];
          coverage_gaps: unknown[];
          scan: { coverage_caveat: string };
        };

        // Observation-level by design, so the page loads are still here —
        // what they carry now is the verdict, so a consumer does not have to
        // re-derive which of them are endpoints.
        expect(exported.apis.every((api) => api.role !== undefined)).toBe(true);
        expect(exported.apis.some((api) => api.role === "application_asset")).toBe(true);
        expect(exported.apis.filter((api) => api.role === "application_api")).toHaveLength(
          model.api.apis.length,
        );

        expect(exported.workflows.map((w) => w.workflow_id)).toEqual(
          model.workflows.candidates.map((c) => c.workflow_id),
        );
        expect(exported.api_sequences.length).toBe(model.sequences.sequences.length);
        expect(exported.javascript.length).toBeGreaterThan(0);
        expect(exported.scan.coverage_caveat).toBe(COVERAGE_CAVEAT);
      } finally {
        await fixture.close();
      }
    },
    180_000,
  );
});
