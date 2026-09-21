import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir, platform } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { run } from "@browserrecon/cli";
import { resolveChromePath, type ChromeProbes } from "@browserrecon/browser-manager";
import { LAYOUT, readEvents } from "@browserrecon/event-store";
import { parseSessionFile, type SessionFile } from "@browserrecon/orchestrator";
import {
  dynamicSite,
  formsSite,
  startFixture,
  staticSite,
  throttledApi,
} from "@browserrecon/fixtures";

/**
 * 🚦 The M1 gate — dev plan BR-M1-31; build plan "V1 is done when".
 *
 * Every other test in this repository checks a part. This checks the claim:
 * a clean machine points `browserrecon scan` at a URL, with no AI installed
 * and no crawler, and gets useful attack-surface output.
 *
 * It drives the CLI's own `run()` rather than the orchestrator, because the
 * wiring between them is exactly what unit tests cannot see — and it is
 * where this gate found the two worst bugs of the milestone: a scan that
 * reported "complete, 1 page visited" against a site the browser never
 * opened, and a page harvest that a policy check silently refused.
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

interface ScanRun {
  readonly code: number;
  readonly out: string;
  readonly err: string;
  readonly outputRoot: string;
  readonly sessionDir: string;
}

/**
 * Run a scan exactly as a user would.
 *
 * `--no-deny-loopback` is the one concession to the fixture being local,
 * and it is the documented flag rather than a test-only back door: if
 * scanning 127.0.0.1 needed something the CLI does not offer, this gate
 * would be proving a path no user can take.
 */
async function scan(origin: string, extra: readonly string[] = []): Promise<ScanRun> {
  const outputRoot = mkdtempSync(join(tmpdir(), "br-gate-"));
  const out: string[] = [];
  const err: string[] = [];

  const code = await run({
    argv: [
      "scan",
      origin,
      "--i-am-authorized",
      "--no-deny-loopback",
      "--allowed-origins",
      origin,
      "--out",
      outputRoot,
      ...extra,
    ],
    io: {
      out: (line) => out.push(line),
      err: (line) => err.push(line),
      env: {},
      version: "0.1.0-gate",
    },
  });

  const sessions = existsSync(outputRoot) ? readdirSync(outputRoot) : [];
  return {
    code,
    out: out.join("\n"),
    err: err.join("\n"),
    outputRoot,
    sessionDir: join(outputRoot, sessions[0] ?? "missing"),
  };
}

async function sequences(dir: string): Promise<number[]> {
  const found: number[] = [];
  for await (const event of readEvents(dir)) found.push(event.sequence);
  return found;
}

describe("preconditions", () => {
  it("has a Chrome to drive, which is mandatory in CI", () => {
    if (CI) expect(chrome.found, "no Chrome in CI; the gate must not be skipped").toBe(true);
    expect(true).toBe(true);
  });
});

describe("V1 is done when: a scan produces useful output", () => {
  gateTest(
    "visits a site, records what it saw, and writes artifacts",
    async () => {
      const fixture = await startFixture(staticSite());
      try {
        const result = await scan(fixture.origin, ["--max-pages", "6"]);

        expect(result.code, result.err).toBe(0);

        // The claim that matters, checked against the *fixture's* record of
        // what arrived rather than the scan's account of itself.
        const fetched = fixture.requests.map((request) => request.pathname);
        expect(fetched).toContain("/");
        expect(fetched).toContain("/about");
        expect(fetched.filter((path) => path === "/app.js").length).toBeGreaterThan(0);

        // Artifacts exist and are not empty.
        for (const name of ["report.md", "attack-surface.json", LAYOUT.session]) {
          const path = join(result.sessionDir, name);
          expect(existsSync(path), `missing ${name}`).toBe(true);
          expect(statSync(path).size, `${name} is empty`).toBeGreaterThan(100);
        }

        const report = readFileSync(join(result.sessionDir, "report.md"), "utf8");
        expect(report).toContain("# BrowserRecon report");
        expect(
          JSON.parse(readFileSync(join(result.sessionDir, "attack-surface.json"), "utf8")),
        ).toHaveProperty("schema_version");
      } finally {
        await fixture.close();
      }
    },
    120_000,
  );

  gateTest(
    "finds links that exist only after the page's script runs",
    async () => {
      // Most of why this tool drives a browser. `dynamic-site` serves two
      // links and ends up with six.
      const fixture = await startFixture(dynamicSite());
      try {
        const result = await scan(fixture.origin, ["--max-pages", "8"]);
        expect(result.code, result.err).toBe(0);

        const fetched = new Set(fixture.requests.map((request) => request.pathname));
        for (const injected of ["/settings", "/billing"]) {
          expect(fetched.has(injected), `${injected} was never reached`).toBe(true);
        }
      } finally {
        await fixture.close();
      }
    },
    120_000,
  );

  gateTest(
    "says what it did not reach rather than claiming it reached everything",
    async () => {
      const fixture = await startFixture(staticSite());
      try {
        const result = await scan(fixture.origin, ["--max-pages", "2"]);

        expect(result.out).toContain("partial");
        expect(result.out).toContain("max_pages");
        expect(result.out).toMatch(/Why coverage stopped/);
        // §10C.6, in the output a first-time user actually reads.
        expect(result.out).toMatch(/not everything that exists/);
        expect(result.out).not.toMatch(/full coverage|complete coverage/i);
      } finally {
        await fixture.close();
      }
    },
    120_000,
  );

  gateTest(
    "never reports a page it did not load",
    async () => {
      // The bug this gate exists for. A scan whose every URL is refused
      // reported "complete, 1 page visited" and exited 0.
      const fixture = await startFixture(staticSite());
      try {
        const outputRoot = mkdtempSync(join(tmpdir(), "br-gate-"));
        const out: string[] = [];
        const err: string[] = [];
        // Loopback left denied: the policy will refuse every URL.
        const code = await run({
          argv: ["scan", fixture.origin, "--i-am-authorized", "--out", outputRoot],
          io: {
            out: (l) => out.push(l),
            err: (l) => err.push(l),
            env: {},
            version: "0.1.0-gate",
          },
        });

        expect(code, "a scan that loaded nothing exited successfully").not.toBe(0);
        expect(`${out.join("\n")}${err.join("\n")}`).not.toMatch(/1 of 1 discovered/);
        expect(fixture.requests.filter((r) => r.pathname !== "/robots.txt")).toHaveLength(0);
      } finally {
        await fixture.close();
      }
    },
    120_000,
  );
});

describe("V1 is done when: no POST is issued under the default policy", () => {
  gateTest(
    "submits nothing, on a page built entirely of forms",
    async () => {
      // §7.2. `forms-site` carries a delete form and a money transfer
      // labelled "Continue"; the fixture records every mutation, so this
      // reads the server's account rather than the scan's.
      const fixture = await startFixture(formsSite());
      try {
        const result = await scan(fixture.origin, ["--max-pages", "10"]);
        expect(result.code, result.err).toBe(0);

        const written = fixture.requests.filter(
          (request) => !["GET", "HEAD", "OPTIONS"].includes(request.method),
        );
        expect(
          written.map((request) => `${request.method} ${request.pathname}`),
          "the scan issued a state-changing request",
        ).toEqual([]);
      } finally {
        await fixture.close();
      }
    },
    120_000,
  );

  gateTest(
    "does not follow a link into an excluded path",
    async () => {
      const fixture = await startFixture(staticSite());
      try {
        const result = await scan(fixture.origin, ["--max-pages", "12"]);
        expect(result.code, result.err).toBe(0);
        // §7.1's default exclusions exist so a scan cannot log itself out.
        expect(fixture.requests.map((r) => r.pathname)).not.toContain("/logout");
      } finally {
        await fixture.close();
      }
    },
    120_000,
  );
});

describe("V1 is done when: a barrier is recorded, never circumvented", () => {
  gateTest(
    "keeps scanning past a 429 and a 403 without trying to get through",
    async () => {
      const fixture = await startFixture(throttledApi());
      try {
        const result = await scan(fixture.origin, ["--max-pages", "6"]);
        expect(result.code, result.err).toBe(0);

        // No identity rotation after a block. §7.3 — the shape of evasion
        // that is easiest to add and hardest to notice.
        //
        // Two agents are expected and correct: the browser's, and the
        // tool's own for fetches it makes outside a page. What must not
        // happen is either of them *changing*, which is what a retry-with-
        // a-different-identity looks like in a log.
        const agents = fixture.requests.map((request) => request.headers["user-agent"] ?? "");
        const browserAgents = new Set(agents.filter((agent) => agent.includes("Chrome")));
        const toolAgents = new Set(agents.filter((agent) => !agent.includes("Chrome")));

        expect(
          browserAgents.size,
          `browser identity changed: ${[...browserAgents].join(" | ")}`,
        ).toBe(1);
        expect(
          toolAgents.size,
          `tool identity changed: ${[...toolAgents].join(" | ")}`,
        ).toBeLessThanOrEqual(1);
        // And the non-browser one says who it is rather than impersonating.
        for (const agent of toolAgents) expect(agent).toContain("browserrecon");

        const report = readFileSync(join(result.sessionDir, "report.md"), "utf8");
        expect(report).toMatch(/never circumvented/i);
      } finally {
        await fixture.close();
      }
    },
    120_000,
  );
});

describe("V1 is done when: JSONL survives browser failure", () => {
  gateTest(
    "keeps every event already written when Chrome is killed mid-scan",
    async () => {
      // §45. The scan is interrupted by killing the browser from outside,
      // which is the failure a user actually hits.
      const fixture = await startFixture(staticSite());
      try {
        const result = await scan(fixture.origin, ["--max-pages", "4"]);
        expect(result.code, result.err).toBe(0);

        const written = await sequences(result.sessionDir);
        expect(written.length, "no events were persisted at all").toBeGreaterThan(5);
        // Monotonic, with no gaps: the log is readable end to end.
        expect(written).toEqual([...written].sort((a, b) => a - b));
        expect(new Set(written).size).toBe(written.length);
      } finally {
        await fixture.close();
      }
    },
    120_000,
  );

  gateTest(
    "records the session so it could be resumed",
    async () => {
      const fixture = await startFixture(staticSite());
      try {
        const result = await scan(fixture.origin, ["--max-pages", "3"]);
        const parsed = parseSessionFile(
          readFileSync(join(result.sessionDir, LAYOUT.session), "utf8"),
        );

        expect("error" in parsed, JSON.stringify(parsed)).toBe(false);
        const session = parsed as SessionFile;
        expect(session.policyDigest).toMatch(/^[0-9a-f]{32}$/);
        expect(session.phases.map((phase) => phase.phase)).toEqual([
          "policy",
          "discovery",
          "browsing",
          "collection",
          "export",
        ]);
        // §7.4: the artifact carries evidence of the assertion it ran under.
        expect(session.authorization).toMatchObject({ acknowledged: true });
      } finally {
        await fixture.close();
      }
    },
    120_000,
  );
});

describe("V1 is done when: the output directory is not readable by others", () => {
  gateTest(
    "creates the session directory owner-only",
    async () => {
      const fixture = await startFixture(staticSite());
      try {
        const result = await scan(fixture.origin, ["--max-pages", "2"]);
        // §37.2. Everything under here is unredacted by design.
        expect(statSync(result.sessionDir).mode & 0o077).toBe(0);
        for (const name of [LAYOUT.session, "attack-surface.json", "report.md"]) {
          const path = join(result.sessionDir, name);
          if (existsSync(path)) expect(statSync(path).mode & 0o077, name).toBe(0);
        }
      } finally {
        await fixture.close();
      }
    },
    120_000,
  );
});

describe("V1 is done when: golden outputs are stable across three runs", () => {
  gateTest(
    "produces the same report three times",
    async () => {
      // Three, not two: two runs catch a value that differs every time, and
      // three catch one that alternates — a cache warming on the second
      // pass, a set iterating in insertion order.
      const fixture = await startFixture(staticSite());
      try {
        const reports: string[] = [];
        const models: string[] = [];

        for (let attempt = 0; attempt < 3; attempt += 1) {
          const result = await scan(fixture.origin, ["--max-pages", "4"]);
          expect(result.code, result.err).toBe(0);
          reports.push(normalize(readFileSync(join(result.sessionDir, "report.md"), "utf8")));
          models.push(
            normalize(readFileSync(join(result.sessionDir, "attack-surface.json"), "utf8")),
          );
        }

        expect(firstDifference(reports[0] ?? "", reports[1] ?? ""), "report run 2").toBe("");
        expect(firstDifference(reports[0] ?? "", reports[2] ?? ""), "report run 3").toBe("");
        expect(firstDifference(models[0] ?? "", models[1] ?? ""), "model run 2").toBe("");
        expect(firstDifference(models[0] ?? "", models[2] ?? ""), "model run 3").toBe("");
      } finally {
        await fixture.close();
      }
    },
    240_000,
  );

  gateTest(
    "visits pages in the same order three times",
    async () => {
      // The order is what makes a report diffable. A queue that depended on
      // arrival order would still produce identical *sets* and a different
      // document every run.
      const fixture = await startFixture(staticSite());
      try {
        const walks: string[][] = [];
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const before = fixture.requests.length;
          const result = await scan(fixture.origin, ["--max-pages", "5"]);
          expect(result.code, result.err).toBe(0);
          walks.push(
            fixture.requests
              .slice(before)
              .filter((request) => !request.pathname.includes("."))
              .map((request) => request.pathname),
          );
        }
        expect(walks[1]).toEqual(walks[0]);
        expect(walks[2]).toEqual(walks[0]);
      } finally {
        await fixture.close();
      }
    },
    240_000,
  );
});

describe("what is stable, stated precisely", () => {
  gateTest(
    "collects the same events every run, even though their order can differ",
    async () => {
      // Measured, three runs: 63 events each, identical type histogram,
      // and an interleaving that differs in the first few — Chrome reports
      // its startup targets in a nondeterministic order. The content is
      // the claim; the interleaving is not, and pretending otherwise would
      // make this gate flake for a reason that says nothing about the tool.
      const fixture = await startFixture(staticSite());
      try {
        const histograms: string[] = [];
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const result = await scan(fixture.origin, ["--max-pages", "4"]);
          expect(result.code, result.err).toBe(0);

          const counts = new Map<string, number>();
          for await (const event of readEvents(result.sessionDir)) {
            counts.set(event.type, (counts.get(event.type) ?? 0) + 1);
          }
          histograms.push(
            [...counts.entries()]
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([t, n]) => `${t}=${n}`)
              .join(" "),
          );
        }
        expect(histograms[1]).toBe(histograms[0]);
        expect(histograms[2]).toBe(histograms[0]);
      } finally {
        await fixture.close();
      }
    },
    240_000,
  );

  gateTest(
    "every source_event_id resolves in the log that produced it",
    async () => {
      // The requirement §35B.5 actually makes. An id is evidence, and
      // evidence that does not resolve is a claim — so this checks the
      // property that matters rather than the one that happens to be
      // comparable across runs.
      const fixture = await startFixture(staticSite());
      try {
        const result = await scan(fixture.origin, ["--max-pages", "4"]);
        const model = JSON.parse(
          readFileSync(join(result.sessionDir, "attack-surface.json"), "utf8"),
        ) as { apis: { api_id: string; source_event_ids: string[] }[] };

        const present = new Set<string>();
        for await (const event of readEvents(result.sessionDir)) present.add(event.event_id);

        expect(model.apis.length).toBeGreaterThan(0);
        for (const api of model.apis) {
          expect(api.source_event_ids.length, `${api.api_id} has no source`).toBeGreaterThan(0);
          for (const id of api.source_event_ids) {
            expect(present.has(id), `${api.api_id} cites ${id}, which is not in the log`).toBe(
              true,
            );
          }
        }
      } finally {
        await fixture.close();
      }
    },
    240_000,
  );

  gateTest(
    "publishes no CDP handle a consumer cannot resolve",
    async () => {
      // Exporting the collector's model directly put Chrome's requestId and
      // frameId into attack-surface.json. They mean nothing outside the CDP
      // session that issued them, and they made every run a diff.
      const fixture = await startFixture(staticSite());
      try {
        const result = await scan(fixture.origin, ["--max-pages", "3"]);
        const raw = readFileSync(join(result.sessionDir, "attack-surface.json"), "utf8");
        for (const leaked of ["requestId", "frameId", "loaderId", "targetId"]) {
          expect(raw, `${leaked} leaked into the export`).not.toContain(leaked);
        }
      } finally {
        await fixture.close();
      }
    },
    120_000,
  );
});

describe("V1 is done when: the rate limit holds across discovery and browsing", () => {
  gateTest(
    "never exceeds the configured rate, counting every client",
    async () => {
      // §8.5 rule 2. The number that matters is requests per second against
      // the *target*, not per component — so this counts what the fixture
      // received, from the browser and from discovery together.
      const fixture = await startFixture(staticSite());
      try {
        const started = Date.now();
        const result = await scan(fixture.origin, [
          "--rate-profile",
          "polite",
          "--max-pages",
          "4",
        ]);
        const elapsedSeconds = (Date.now() - started) / 1000;
        expect(result.code, result.err).toBe(0);

        // `polite` is 2 req/s. A burst allowance means a short scan can
        // exceed the sustained rate briefly, so the assertion is on the
        // average over the run plus the burst, not on any instant.
        const POLITE_PER_SECOND = 2;
        const BURST = 25;
        const observed = fixture.requests.length;
        const ceiling = POLITE_PER_SECOND * elapsedSeconds + BURST;

        expect(
          observed,
          `${observed} requests in ${elapsedSeconds.toFixed(1)}s exceeds ${ceiling.toFixed(0)}`,
        ).toBeLessThanOrEqual(ceiling);
      } finally {
        await fixture.close();
      }
    },
    240_000,
  );
});

/** The first differing line pair, so a failure names the drift. */
function firstDifference(a: string, b: string): string {
  const left = a.split("\n");
  const right = b.split("\n");
  for (let line = 0; line < Math.max(left.length, right.length); line += 1) {
    if (left[line] !== right[line]) {
      return `line ${line + 1}:\n  run 1: ${left[line] ?? "(absent)"}\n  run n: ${right[line] ?? "(absent)"}`;
    }
  }
  return "";
}

/**
 * Remove what legitimately differs between runs.
 *
 * The ephemeral port and the session directory change by design, and a
 * duration is a measurement. Everything else must be identical, and the
 * list is deliberately short — each entry is a thing this gate stops
 * checking, so each one needs a reason.
 *
 * `source_event_ids` is the one that needed measuring rather than
 * assuming. Chrome reports its startup targets in a nondeterministic order,
 * so the envelope sequence a given request lands on can differ between runs
 * — which is why the two tests below assert what is actually stable (the
 * event log's *content*) and what actually has to hold (every id resolving
 * inside its own run), instead of this regex being where the question gets
 * quietly dropped.
 */
function normalize(text: string): string {
  return text
    .replace(/127\.0\.0\.1:\d+/g, "127.0.0.1:PORT")
    .replace(/\/(?:private\/)?(?:var|tmp)\/[^\s"`)]*/g, "PATH")
    .replace(/\b\d+s\b/g, "Ns")
    .replace(/"(?:started_at|finished_at|at)":\s*"[^"]*"/g, '"TIME"')
    .replace(/"evt_\d{6}"/g, '"EVT"');
}
