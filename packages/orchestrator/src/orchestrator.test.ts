import {
  createQueue,
  type Candidate,
  type VisitQueue,
} from "@browserrecon/deterministic-explorer";
import { createTokenBucket, type TokenBucket } from "@browserrecon/rate-controller";
import { describe, expect, it } from "vitest";
import {
  BrowserCrash,
  ScanRefused,
  runScan,
  type BrowsingPort,
  type Clock,
  type CollectionPort,
  type DiscoveryPort,
  type ExportInput,
  type ExportPort,
  type PhaseName,
  type ScanInput,
} from "./index.js";

/**
 * BR-M1-28's four required paths: happy, discovery failure, browser crash,
 * timeout. Each one is a state a real browser will not enter on demand,
 * which is the whole reason the orchestrator takes ports.
 */

/** A clock the test drives, so a 30-minute timeout takes no time (§36.1). */
function testClock(): Clock & { advance(ms: number): void } {
  let current = 1_700_000_000_000;
  const sleepers: { at: number; resolve: () => void; signal?: AbortSignal | undefined }[] = [];

  const fire = (): void => {
    for (const sleeper of [...sleepers]) {
      if (sleeper.at <= current) {
        sleepers.splice(sleepers.indexOf(sleeper), 1);
        sleeper.resolve();
      }
    }
  };

  return {
    now: () => current,
    sleep(ms, signal) {
      if (signal?.aborted === true) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const entry = { at: current + ms, resolve, signal };
        sleepers.push(entry);
        signal?.addEventListener(
          "abort",
          () => {
            const index = sleepers.indexOf(entry);
            if (index >= 0) sleepers.splice(index, 1);
            resolve();
          },
          { once: true },
        );
      });
    },
    advance(ms) {
      current += ms;
      fire();
    },
  };
}

const page = (url: string, depth = 1): Candidate => ({ url, source: "dom_link", depth });

function openQueue(): VisitQueue {
  return createQueue({ refuse: () => undefined });
}

function fixedDiscovery(name: string, urls: readonly string[]): DiscoveryPort {
  return {
    name,

    async *run() {
      for (const url of urls) yield page(url);
    },
  };
}

function failingDiscovery(name: string, message: string): DiscoveryPort {
  return {
    name,

    async *run() {
      throw new Error(message);
      yield page("unreachable");
    },
  };
}

interface FakeBrowser extends BrowsingPort {
  readonly visited: string[];
  readonly launches: number;
}

function fakeBrowser(
  behaviour: (url: string, visitIndex: number) => readonly Candidate[] | Error = () => [],
): FakeBrowser {
  const visited: string[] = [];
  let launches = 0;

  return {
    visited,
    get launches() {
      return launches;
    },

    async launch() {
      launches += 1;
    },

    async visit({ candidate }) {
      const outcome = behaviour(candidate.url, visited.length);
      visited.push(candidate.url);
      if (outcome instanceof Error) throw outcome;
      return { discovered: outcome, requests: 1 };
    },
    async close() {},
  };
}

function fakeCollection(): CollectionPort & { finalized: boolean } {
  return {
    finalized: false,
    eventsWritten: 0,

    async finalize() {
      this.finalized = true;
    },
  };
}

function fakeExport(): ExportPort & { calls: ExportInput[] } {
  const calls: ExportInput[] = [];
  return {
    calls,

    async write(input) {
      calls.push(input);
      return [".output/report.md"];
    },
  };
}

function scanInput(overrides: Partial<ScanInput> = {}): ScanInput {
  const clock = overrides.clock ?? testClock();
  return {
    target: "https://shop.example.com/",
    limits: {
      maxPages: 100,
      maxRuntimeMinutes: 30,
      maxFailedActions: 5,
      discoveryTimeoutMs: 10_000,
      maxRelaunches: 2,
    },
    bucket: createTokenBucket({
      refillPerSecond: 1000,
      now: () => clock.now(),
      sleep: () => Promise.resolve(),
    }),
    queue: openQueue(),
    discovery: [],
    browsing: fakeBrowser(),
    collection: fakeCollection(),
    export: fakeExport(),
    clock,
    ...overrides,
  };
}

const phaseStatus = (
  result: { phases: readonly { phase: PhaseName; status: string }[] },
  phase: PhaseName,
) => result.phases.find((outcome) => outcome.phase === phase)?.status;

describe("the happy path", () => {
  it("runs every phase and completes", async () => {
    const browser = fakeBrowser((url) =>
      url.endsWith("/")
        ? [page("https://shop.example.com/a"), page("https://shop.example.com/b")]
        : [],
    );
    const exporter = fakeExport();
    const collection = fakeCollection();

    const result = await runScan(
      scanInput({
        discovery: [fixedDiscovery("katana", ["https://shop.example.com/c"])],
        browsing: browser,
        collection,
        export: exporter,
      }),
    );

    expect(result.completeness).toBe("complete");
    expect(result.stopReason).toBe("queue_empty");
    for (const phase of ["policy", "discovery", "browsing", "collection", "export"] as const) {
      expect(phaseStatus(result, phase), phase).toBe("ok");
    }
    expect(browser.visited).toHaveLength(4);
    expect(collection.finalized).toBe(true);
    expect(exporter.calls[0]?.completeness).toBe("complete");
  });

  it("visits pages the browser discovered as well as the ones the crawler did", async () => {
    const browser = fakeBrowser((url) =>
      url.endsWith("/") ? [page("https://shop.example.com/from-dom")] : [],
    );
    await runScan(
      scanInput({
        discovery: [fixedDiscovery("katana", ["https://shop.example.com/from-katana"])],
        browsing: browser,
      }),
    );
    expect(browser.visited).toContain("https://shop.example.com/from-dom");
    expect(browser.visited).toContain("https://shop.example.com/from-katana");
  });

  it("closes the browser even though nothing went wrong", async () => {
    let closed = false;
    const browser = fakeBrowser();
    const wrapped: BrowsingPort = {
      ...browser,
      async close() {
        closed = true;
        await browser.close();
      },
    };
    await runScan(scanInput({ browsing: wrapped }));
    expect(closed).toBe(true);
  });
});

describe("policy is settled before anything touches the network", () => {
  it("refuses a target its own policy would skip, without launching a browser", async () => {
    // §32.10. A scan that launches Chrome and then discovers it may visit
    // nothing has already done the thing the policy was meant to prevent.
    const browser = fakeBrowser();
    const queue = createQueue({
      refuse: () => ({ reason: "out_of_scope", detail: "origin not allowed" }),
    });

    await expect(runScan(scanInput({ queue, browsing: browser }))).rejects.toBeInstanceOf(
      ScanRefused,
    );
    expect(browser.launches, "a browser was launched despite the refusal").toBe(0);
  });

  it("explains the refusal in terms of the setting that caused it", async () => {
    const queue = createQueue({
      refuse: () => ({ reason: "out_of_scope", detail: "origin not allowed" }),
    });
    let refusal: ScanRefused | undefined;
    try {
      await runScan(scanInput({ queue }));
    } catch (caught) {
      refusal = caught as ScanRefused;
    }
    expect(refusal?.outcome.remedy).toContain("--allowed-origins");
  });
});

describe("a discovery failure is not a scan failure", () => {
  it("falls through to the next source and still completes", async () => {
    // §8.5 rule 3. A user who waited for a scan does not want "katana
    // exited 1" and nothing else.
    const browser = fakeBrowser();
    const result = await runScan(
      scanInput({
        discovery: [
          failingDiscovery("katana", "spawn katana ENOENT"),
          fixedDiscovery("browser-native", ["https://shop.example.com/sitemap-found"]),
        ],
        browsing: browser,
      }),
    );

    expect(phaseStatus(result, "discovery")).toBe("degraded");
    expect(phaseStatus(result, "browsing")).toBe("ok");
    expect(browser.visited).toContain("https://shop.example.com/sitemap-found");
  });

  it("marks the scan partial, so the report cannot claim full coverage", async () => {
    // §10C.6: a run that lost its crawler found less, and has to say so.
    const result = await runScan(
      scanInput({
        discovery: [
          failingDiscovery("katana", "spawn katana ENOENT"),
          fixedDiscovery("browser-native", []),
        ],
      }),
    );
    expect(result.completeness).toBe("partial");
  });

  it("records what failed and what to do about it", async () => {
    const result = await runScan(
      scanInput({ discovery: [failingDiscovery("katana", "spawn katana ENOENT")] }),
    );
    const discovery = result.phases.find((phase) => phase.phase === "discovery");
    expect(discovery?.status).toBe("failed");
    expect(discovery?.detail).toContain("ENOENT");
    expect(discovery?.remedy).toContain("doctor");
  });

  it("still browses the seed when every discovery source dies", async () => {
    const browser = fakeBrowser();
    const result = await runScan(
      scanInput({
        discovery: [failingDiscovery("katana", "boom"), failingDiscovery("sitemap", "404")],
        browsing: browser,
      }),
    );
    expect(browser.visited).toEqual(["https://shop.example.com/"]);
    expect(phaseStatus(result, "export")).toBe("ok");
  });
});

describe("a browser crash is bounded", () => {
  it("relaunches and carries on", async () => {
    let crashed = false;
    const browser = fakeBrowser((url) => {
      if (url.endsWith("/b") && !crashed) {
        crashed = true;
        return new BrowserCrash("target closed");
      }
      return url.endsWith("/")
        ? [page("https://shop.example.com/b"), page("https://shop.example.com/c")]
        : [];
    });

    const result = await runScan(scanInput({ browsing: browser }));

    expect(browser.launches, "the browser was not relaunched").toBe(2);
    expect(browser.visited).toContain("https://shop.example.com/c");
    expect(phaseStatus(result, "browsing")).toBe("degraded");
  });

  it("does not retry the page that killed the browser", async () => {
    // A page that crashed Chrome once will crash it again, and burning
    // every relaunch on one URL costs the rest of the scan.
    const browser = fakeBrowser((url) =>
      url.endsWith("/poison")
        ? new BrowserCrash("target closed")
        : url.endsWith("/")
          ? [page("https://shop.example.com/poison"), page("https://shop.example.com/ok")]
          : [],
    );

    await runScan(scanInput({ browsing: browser }));
    expect(browser.visited.filter((url) => url.endsWith("/poison"))).toHaveLength(1);
    expect(browser.visited).toContain("https://shop.example.com/ok");
  });

  it("exports what it collected once the relaunches run out", async () => {
    // The acceptance criterion: forty pages of report beats an error.
    const browser = fakeBrowser((url) =>
      url.endsWith("/")
        ? [page("https://shop.example.com/x"), page("https://shop.example.com/y")]
        : new BrowserCrash("gone"),
    );
    const exporter = fakeExport();

    const result = await runScan(
      scanInput({
        browsing: browser,
        export: exporter,
        limits: { ...scanInput().limits, maxRelaunches: 1 },
      }),
    );

    expect(result.stopReason).toBe("browser_unrecoverable");
    expect(phaseStatus(result, "export")).toBe("ok");
    expect(exporter.calls[0]?.completeness).toBe("partial");
    expect(exporter.calls[0]?.pagesVisited).toBeGreaterThan(0);
  });

  it("does not relaunch forever", async () => {
    // Enough URLs that an unbounded implementation would keep going: the
    // bound has to come from maxRelaunches, not from running out of pages.
    const queue = openQueue();
    for (let index = 0; index < 20; index += 1) {
      queue.offer(page(`https://shop.example.com/p${index}`));
    }
    const browser = fakeBrowser(() => new BrowserCrash("gone"));
    await runScan(
      scanInput({
        queue,
        browsing: browser,
        limits: { ...scanInput().limits, maxRelaunches: 3 },
      }),
    );
    // One launch plus three relaunches, and no more.
    expect(browser.launches).toBe(4);
    expect(browser.visited.length).toBeLessThan(20);
  });

  it("does not report a scan as clean when the only page killed the browser", async () => {
    // The queue really did empty, so "queue_empty" is true — and on its own
    // it reads as a scan that finished its work. The degradation has to
    // survive to the caller, or the summary says "complete".
    const browser = fakeBrowser(() => new BrowserCrash("gone"));
    const result = await runScan(scanInput({ browsing: browser }));

    expect(result.completeness).toBe("partial");
    expect(result.degradedBy?.phase).toBe("browsing");
    expect(result.degradedBy?.detail).toContain("relaunched");
  });

  it("gives up cleanly when the browser will not start at all", async () => {
    const browser: BrowsingPort = {
      launch: () => Promise.reject(new Error("no chrome at /nowhere")),
      visit: () => Promise.reject(new Error("unreachable")),
      close: () => Promise.resolve(),
    };
    const exporter = fakeExport();
    const result = await runScan(scanInput({ browsing: browser, export: exporter }));

    expect(phaseStatus(result, "browsing")).toBe("failed");
    // Still exports: the session directory and its metadata are worth
    // writing even when no page was ever loaded.
    expect(phaseStatus(result, "export")).toBe("ok");
    expect(result.phases.find((p) => p.phase === "browsing")?.detail).toContain("no chrome");
  });
});

describe("a slow crawler does not stall the scan", () => {
  it("finalizes prioritization at the discovery deadline", async () => {
    // The failure this prevents: a scan that produces nothing because a
    // subprocess never exited.
    const clock = testClock();
    const browser = fakeBrowser();
    const hanging: DiscoveryPort = {
      name: "katana",
      async *run({ signal }) {
        yield page("https://shop.example.com/early");
        // Never returns on its own — only the deadline ends this.
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      },
    };

    const scan = runScan(
      scanInput({
        clock,
        browsing: browser,
        discovery: [hanging],
        limits: { ...scanInput().limits, discoveryTimeoutMs: 5_000 },
      }),
    );

    // Let the seed and the early candidate drain, then trip the deadline.
    await Promise.resolve();
    clock.advance(5_000);

    const result = await scan;
    expect(browser.visited).toContain("https://shop.example.com/early");
    expect(result.artifacts).toHaveLength(1);
  });

  it("waits for a slow crawler rather than declaring the queue empty", async () => {
    // The opposite mistake: browsing finishes the seed, finds the queue
    // empty, and stops while the crawler is still producing URLs.
    const clock = testClock();
    const browser = fakeBrowser();
    const slow: DiscoveryPort = {
      name: "katana",
      async *run() {
        await clock.sleep(1_000);
        yield page("https://shop.example.com/late");
      },
    };

    const scan = runScan(scanInput({ clock, browsing: browser, discovery: [slow] }));
    await Promise.resolve();
    clock.advance(1_000);

    await scan;
    expect(browser.visited, "the crawler's URL was never visited").toContain(
      "https://shop.example.com/late",
    );
  });
});

describe("budgets stop the scan", () => {
  it("stops at max_pages and reports partial", async () => {
    const browser = fakeBrowser((url) =>
      url.endsWith("/")
        ? Array.from({ length: 20 }, (_, index) => page(`https://shop.example.com/p${index}`))
        : [],
    );
    const result = await runScan(
      scanInput({ browsing: browser, limits: { ...scanInput().limits, maxPages: 5 } }),
    );

    expect(result.stopReason).toBe("max_pages");
    expect(result.completeness).toBe("partial");
    expect(result.pagesVisited).toBe(5);
  });

  it("stops at max_runtime without visiting the rest of the queue", async () => {
    const clock = testClock();
    const browser = fakeBrowser((url) => {
      clock.advance(60_000);
      return url.endsWith("/")
        ? Array.from({ length: 20 }, (_, index) => page(`https://shop.example.com/p${index}`))
        : [];
    });

    const result = await runScan(
      scanInput({
        clock,
        browsing: browser,
        limits: { ...scanInput().limits, maxRuntimeMinutes: 3 },
      }),
    );

    expect(result.stopReason).toBe("max_runtime");
    expect(browser.visited.length).toBeLessThan(20);
  });

  it("gives up after too many consecutive failures", async () => {
    const browser = fakeBrowser((url) =>
      url.endsWith("/")
        ? Array.from({ length: 20 }, (_, index) => page(`https://shop.example.com/p${index}`))
        : new Error("navigation failed"),
    );
    const result = await runScan(
      scanInput({ browsing: browser, limits: { ...scanInput().limits, maxFailedActions: 3 } }),
    );
    expect(result.stopReason).toBe("max_failed_actions");
  });

  it("treats an ordinary page failure as one page, not as the scan", async () => {
    const browser = fakeBrowser((url) =>
      url.endsWith("/bad")
        ? new Error("navigation failed")
        : url.endsWith("/")
          ? [page("https://shop.example.com/bad"), page("https://shop.example.com/good")]
          : [],
    );
    const result = await runScan(scanInput({ browsing: browser }));
    expect(browser.visited).toContain("https://shop.example.com/good");
    expect(result.stopReason).toBe("queue_empty");
  });
});

describe("one shared rate budget", () => {
  it("hands discovery and browsing the same bucket", async () => {
    // §8.5 rule 2. Two phases with two buckets is two scans' worth of
    // traffic arriving at a target that agreed to one.
    const seen = new Set<TokenBucket>();
    const bucket = createTokenBucket({ refillPerSecond: 1000, sleep: () => Promise.resolve() });

    const watcher: DiscoveryPort = {
      name: "katana",

      async *run(context) {
        seen.add(context.bucket);
        yield page("https://shop.example.com/a");
      },
    };
    const browser: BrowsingPort = {
      launch: () => Promise.resolve(),
      visit: (context) => {
        seen.add(context.bucket);
        return Promise.resolve({ discovered: [], requests: 1 });
      },
      close: () => Promise.resolve(),
    };

    await runScan(scanInput({ bucket, discovery: [watcher], browsing: browser }));
    expect(seen.size, "discovery and browsing used different buckets").toBe(1);
    expect(seen.has(bucket)).toBe(true);
  });
});

describe("cancellation", () => {
  it("stops promptly and still exports", async () => {
    const controller = new AbortController();
    const browser = fakeBrowser((url, index) => {
      if (index === 2) controller.abort();
      return url.endsWith("/")
        ? Array.from({ length: 20 }, (_, i) => page(`https://shop.example.com/p${i}`))
        : [];
    });

    const result = await runScan(scanInput({ browsing: browser, signal: controller.signal }));
    expect(result.stopReason).toBe("cancelled");
    expect(result.completeness).toBe("partial");
    expect(result.artifacts).toHaveLength(1);
  });
});

describe("phase outcomes are persisted as they happen", () => {
  it("writes after every phase, not once at the end", async () => {
    // A scan killed mid-run is the case `resume` exists for; a session.json
    // that only appears on clean exit would be missing exactly then.
    const snapshots: number[] = [];
    await runScan(scanInput({ onPhase: (outcomes) => snapshots.push(outcomes.length) }));
    expect(snapshots).toEqual([1, 2, 3, 4, 5]);
  });

  it("names the earliest problem, not the last symptom", async () => {
    // A discovery failure that caused a thin browsing phase should be
    // reported as the discovery failure.
    const result = await runScan(
      scanInput({
        discovery: [failingDiscovery("katana", "spawn katana ENOENT")],
        browsing: fakeBrowser(() => new BrowserCrash("gone")),
        limits: { ...scanInput().limits, maxRelaunches: 0 },
      }),
    );
    expect(result.degradedBy?.phase).toBe("discovery");
  });
});

describe("a failing export does not lose the scan", () => {
  it("records the failure and points at the intact log", async () => {
    const exporter: ExportPort = { write: () => Promise.reject(new Error("disk full")) };
    const result = await runScan(scanInput({ export: exporter }));

    expect(phaseStatus(result, "export")).toBe("failed");
    expect(result.phases.find((p) => p.phase === "export")?.remedy).toContain(
      "browserrecon export",
    );
    expect(result.completeness).toBe("partial");
  });

  it("records a collection failure without skipping the export", async () => {
    const collection: CollectionPort = {
      eventsWritten: 0,
      finalize: () => Promise.reject(new Error("fsync failed")),
    };
    const result = await runScan(scanInput({ collection }));
    expect(phaseStatus(result, "collection")).toBe("failed");
    expect(phaseStatus(result, "export")).toBe("ok");
  });
});

/** Let every pending microtask and real timer callback run. */
const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 10; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

describe("a discovery source that ignores its signal", () => {
  it("does not hang the browsing loop when the queue empties first", async () => {
    // The interleaving the deadline in the browsing loop exists for:
    // browsing drains the queue *before* the discovery deadline passes, so
    // it waits for discovery — and the source never returns. Without the
    // race the scan stops here, having visited one page and written
    // nothing, with no error and no timeout.
    const clock = testClock();
    const browser = fakeBrowser();
    const deaf: DiscoveryPort = {
      name: "katana",

      async *run() {
        await new Promise<never>(() => {});
      },
    };

    const scan = runScan(
      scanInput({
        clock,
        browsing: browser,
        discovery: [deaf],
        limits: {
          ...scanInput().limits,
          discoveryTimeoutMs: 10_000,
          discoveryStopGraceMs: 500,
        },
      }),
    );

    // The seed is visited and the queue empties while the deadline is still
    // far away.
    await settle();
    expect(browser.visited, "the seed was not visited before the deadline").toHaveLength(1);

    clock.advance(10_000);
    await settle();
    clock.advance(500);

    const result = await scan;
    expect(result.artifacts).toHaveLength(1);
    expect(result.pagesVisited).toBe(1);
  });

  it("does not hang the scan at the join", async () => {
    // Found by probing: removing the deadline from the browsing loop left
    // every test green, because the sources in those tests all honour their
    // abort signal. One that does not — a subprocess wrapper that never
    // wired it through — would hang here instead, after every page had been
    // visited and with every artifact still unwritten.
    const clock = testClock();
    const browser = fakeBrowser();
    const deaf: DiscoveryPort = {
      name: "katana",

      async *run() {
        yield page("https://shop.example.com/a");
        await new Promise<never>(() => {});
      },
    };

    const scan = runScan(
      scanInput({
        clock,
        browsing: browser,
        discovery: [deaf],
        limits: { ...scanInput().limits, discoveryTimeoutMs: 1_000, discoveryStopGraceMs: 500 },
      }),
    );

    // Trip the deadline, then the grace period.
    for (let tick = 0; tick < 6; tick += 1) {
      await Promise.resolve();
      clock.advance(1_000);
    }

    const result = await scan;
    expect(result.artifacts).toHaveLength(1);
    expect(phaseStatus(result, "discovery")).toBe("degraded");
    expect(result.phases.find((p) => p.phase === "discovery")?.detail).toContain(
      "did not stop",
    );
  });
});
