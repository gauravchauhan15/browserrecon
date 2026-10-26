/**
 * `browserrecon scan` — build plan §30, §9.3, §7.4; dev plan BR-M1-31.
 *
 * Where everything meets. This file's job is assembly and nothing else: it
 * resolves configuration, clears the authorization gate, builds the ports,
 * hands them to the orchestrator, and writes what comes back. Any logic
 * that belongs to a phase belongs in that phase's package.
 *
 * ## The order is a safety property, not a style
 *
 * Configuration, then policy, then the §7.4 gate, and only then anything
 * that could touch the network. §32.10 is explicit that policy validation
 * precedes browser actions, and the practical reading is stricter than it
 * sounds: a scan that launches Chrome before resolving scope has already
 * made a request the user did not authorize — the browser's own startup
 * traffic — and "we would have refused on the next line" is not a defence.
 *
 * ## No browser handle lives here
 *
 * `@browserrecon/browser-runner` owns it, because eslint forbids this file
 * from importing `launchBrowser` (§32.10). That rule caught the first draft
 * of the runner when it was written inline here.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  buildSessionAuthorization,
  defaultRecordPath,
  evaluateGate,
  readRecord,
  nonInteractiveHelp,
  type AcknowledgmentMethod,
} from "@browserrecon/authorization";
import { createBrowserNativeDiscovery, createRunner } from "@browserrecon/browser-runner";
import { resolveChromePath, type ChromeProbes } from "@browserrecon/browser-manager";
import { CONFIG_SPEC, formatConfigErrors, loadConfig } from "@browserrecon/config";
import { createRedactor, createSecureOutputDir, IdFactory } from "@browserrecon/core";
import { NOT_NAVIGABLE_NOTE, type GapInput, type GapReason } from "@browserrecon/coverage";
import {
  collectNetwork,
  type NetworkModel,
  type NetworkObservation,
} from "@browserrecon/collector-network";
import { createQueue, type SkipReason } from "@browserrecon/deterministic-explorer";
import { EventBus } from "@browserrecon/events";
import { EventStore, LAYOUT } from "@browserrecon/event-store";
import { assemble, validateSurface, type AssembledModel } from "@browserrecon/attack-surface";
import { readAllEvents } from "@browserrecon/event-store";
import { renderReport, type WorkflowReport } from "@browserrecon/exporter-markdown";
import {
  COVERAGE_CAVEAT,
  EXPORT_SCHEMA_VERSION,
  streamDocument,
  validateDocument,
  type ExportedApi,
  type ExportedDocument,
} from "@browserrecon/exporter-json";
import {
  runScan,
  ScanRefused,
  writeSessionFile,
  digestPolicy,
  type PhaseOutcome,
  type ScanResult,
} from "@browserrecon/orchestrator";
import {
  POLICY_SPEC,
  PolicyEngine,
  elevatedRisks,
  type TargetPolicy,
  resolveTargetPolicy,
  type RateProfile,
  type ThoroughnessLevel,
} from "@browserrecon/policy";
import { createTokenBucket } from "@browserrecon/rate-controller";
import { CliError, EXIT_CODES } from "../exit-codes.js";
import { collectCliValues } from "../options.js";
import { policySummaryFor } from "./resume.js";
import { formatSummary, resolveSummaryMode, type ScanSummary } from "./summary.js";

export interface ScanCommandInput {
  readonly target: string;
  readonly parsed: Readonly<Record<string, unknown>>;
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly configFile?: string | undefined;
  readonly quiet?: boolean | undefined;
  readonly json?: boolean | undefined;
  readonly authorized?: boolean | undefined;
  readonly interactive?: boolean | undefined;
  readonly write: (line: string) => void;
  readonly warn: (line: string) => void;
}

const FULL_SPEC = [...CONFIG_SPEC, ...POLICY_SPEC];

/**
 * How non-browser requests identify themselves.
 *
 * Named, with a URL. An operator reading their access log should be able to
 * tell which requests came from this tool and go and read what it does.
 */
export const USER_AGENT = "browserrecon (+https://github.com/gauravchauhan15/browserrecon)";

/** Probes the real machine. Injected into Chrome detection so it is testable. */
export const systemProbes: ChromeProbes = {
  fileExists: (path) => existsSync(path),
  runCommand: (command, args) => {
    const result = spawnSync(command, [...args], { encoding: "utf8", timeout: 5_000 });
    if (result.error !== undefined || result.status !== 0) return undefined;
    return { stdout: `${result.stdout ?? ""}${result.stderr ?? ""}` };
  },
  platform: process.platform,
  env: {},
};

export async function scan(input: ScanCommandInput): Promise<void> {
  // ---- 1. configuration ---------------------------------------------------
  const cli = collectCliValues(FULL_SPEC, input.parsed, input.argv);
  cli.target = input.target;

  const resolved = loadConfig({ spec: FULL_SPEC, file: input.configFile, env: input.env, cli });
  if (!resolved.ok) {
    throw new CliError(
      formatConfigErrors(resolved.errors),
      EXIT_CODES.configuration,
      "Fix the settings above, or run with --help to see accepted values.",
    );
  }

  // ---- 2. policy ----------------------------------------------------------
  const policyResult = resolveTargetPolicy({
    targetOrigin: input.target,
    rateProfile: (resolved.config.rate as { profile?: RateProfile } | undefined)?.profile,
    thoroughnessLevel: (
      resolved.config.thoroughness as { level?: ThoroughnessLevel } | undefined
    )?.level,
    config: resolved.config,
  });
  if (!policyResult.ok) {
    throw new CliError(
      policyResult.violations
        .map((violation) => `  ${violation.field}: ${violation.reason}`)
        .join("\n"),
      EXIT_CODES.policy,
    );
  }
  const policy = policyResult.policy;
  const risks = elevatedRisks(policy);

  // ---- 3. the §7.4 gate, before anything reaches the network --------------
  const gate = evaluateGate({
    targetOrigin: policy.targetOrigin,
    record: readRecord(defaultRecordPath(input.env)),
    flagProvided: input.authorized === true,
    interactive: input.interactive === true,
    risks,
  });
  if (gate.kind !== "allowed") {
    throw new CliError(
      gate.kind === "denied" ? gate.message : gate.question,
      EXIT_CODES.authorization,
      gate.kind === "denied" ? nonInteractiveHelp(policy.targetOrigin) : undefined,
    );
  }
  if (gate.notice !== undefined && gate.notice !== "") input.warn(gate.notice);

  // ---- 4. the session directory -------------------------------------------
  const outputRoot = (resolved.config.output as { dir?: string } | undefined)?.dir ?? ".output";
  // One ordinal, used by everything that stamps a session id. The bus keeps
  // its own IdFactory for event ids, and while both were hardcoded to 1 they
  // agreed by accident; the moment the directory could be `sess_0002` its
  // events still said `sess_0001`, so every `source_event_ids` in the second
  // scan pointed at the first one's session.
  const sessionOrdinal = nextSessionOrdinal(outputRoot);
  const ids = new IdFactory(sessionOrdinal);
  const sessionId = ids.sessionId;
  const sessionDir = join(outputRoot, sessionId);
  // 0700 before a single byte is written: everything below this point is
  // unredacted (§37.2).
  createSecureOutputDir(sessionDir);

  const store = new EventStore({ dir: sessionDir, sessionId });
  const bus = new EventBus({ sessionOrdinal });
  const network = collectNetwork(bus);

  // Persist everything the bus carries. Subscribed before the browser
  // starts, so nothing observed can predate the writer, and `critical` so a
  // failure to persist stops the scan — continuing would mean collecting
  // observations that are already lost and then reporting coverage over
  // data that does not exist.
  const persist = bus.subscribe((envelope) => store.append(envelope), {
    name: "event-store",
    critical: true,
  });

  const startedAt = new Date().toISOString();
  const policySummary = policySummaryFor(policy, "");
  const authorization = buildSessionAuthorization({
    method: gate.method as AcknowledgmentMethod,
    targetOrigin: policy.targetOrigin,
    risks,
  });

  const writeSession = (phases: readonly PhaseOutcome[], result?: ScanResult): void => {
    writeSessionFile(join(sessionDir, LAYOUT.session), {
      version: 1,
      sessionId,
      target: policy.targetOrigin,
      tool: { name: "browserrecon", version: (resolved.config.version as string) ?? "0.1.0" },
      policyDigest: digestPolicy(policySummary),
      policySummary,
      authorization,
      phases,
      completeness: result?.completeness ?? "partial",
      ...(result?.stopReason === undefined ? {} : { stopReason: result.stopReason }),
      segments: [
        {
          startedAt,
          ...(result === undefined ? {} : { finishedAt: new Date().toISOString() }),
          firstSequence: 1,
          lastSequence: store.stats.writtenSequence,
        },
      ],
      budgetExtensions: [],
    });
  };

  // ---- 5. the ports -------------------------------------------------------
  const chrome = resolveChromePath(systemProbes);
  if (!chrome.found) {
    throw new CliError(
      "No Chrome or Chromium was found.",
      EXIT_CODES.dependency,
      "Run `browserrecon doctor` to see where it looked, or set browser.executablePath.",
    );
  }

  const rateProfile =
    (resolved.config.rate as { profile?: string } | undefined)?.profile ?? "normal";
  const bucket = createTokenBucket({ refillPerSecond: policy.limits.maxRequestsPerSecond });
  // The queue and the adapter must not disagree about scope. They did:
  // a hand-rolled check here accepted a loopback URL the adapter then
  // refused, and the scan reported a page visited that was never loaded.
  // One engine, one verdict.
  const engine = new PolicyEngine(policy);
  const queue = createQueue({
    refuse: (url) => {
      const decision = engine.canVisit(url);
      if (decision.allowed) return undefined;
      return { reason: skipReasonFor(decision.reason), detail: decision.detail };
    },
  });

  const runner = createRunner({
    sessionId,
    policy,
    probes: systemProbes,
    bus,
    executablePath: chrome.executablePath,
    headless:
      (resolved.config.browser as { headless?: boolean } | undefined)?.headless !== false,
  });

  const excluded: { url: string; reason: string }[] = [];
  let assembled: AssembledModel | undefined;
  const discovery = [
    createBrowserNativeDiscovery({
      // The same engine the queue and the adapter use. A sitemap index
      // names other sitemaps, and those URLs come from the response.
      allow: (url) => engine.canVisit(url).allowed,
      fetchText: async (url, signal) => {
        try {
          const response = await fetch(url, {
            ...(signal === undefined ? {} : { signal }),
            // Identify honestly. A recon tool that disguises its
            // out-of-browser fetches as a browser is doing a small version
            // of the thing §7.3 rules out, and an operator reading their
            // own access log should be able to tell which requests were
            // ours.
            headers: { "user-agent": USER_AGENT },
          });
          return response.ok ? await response.text() : undefined;
        } catch {
          // A missing robots.txt is the normal case, not a failure.
          return undefined;
        }
      },
      onExcluded: (url, reason) => excluded.push({ url, reason }),
    }),
  ];

  // ---- 6. run -------------------------------------------------------------
  let result: ScanResult;
  try {
    result = await runScan({
      target: policy.targetOrigin,
      limits: {
        maxPages: policy.limits.maxPages,
        maxRuntimeMinutes: policy.limits.maxRuntimeMinutes,
        maxFailedActions: 10,
        discoveryTimeoutMs: 30_000,
        maxRelaunches: 2,
      },
      bucket,
      queue,
      discovery,
      browsing: {
        launch: () => runner.launch(),
        close: () => runner.close(),
        visit: async (context) => {
          const result = await runner.visit(context);
          // §10C.7: a control the scan chose not to press is a coverage gap
          // with a cause, not an absence. Without this the report says a
          // page had no surface when what happened is that the tool declined
          // to touch it — which is a different, better answer.
          for (const control of result.controls) {
            if (control.pressed || control.reason === undefined) continue;
            excluded.push({
              url: `${context.candidate.url}#${control.label}`,
              reason: control.reason,
            });
          }
          return result;
        },
      },
      collection: {
        get eventsWritten() {
          return store.stats.appended;
        },
        finalize: () => {
          store.checkpoint();
          return Promise.resolve();
        },
      },
      export: {
        write: async (exportInput) => {
          // Flushed first: the assembly reads the log back, and an event
          // still in a buffer is an event the model will not see.
          store.checkpoint();

          // The whole V3 pipeline, from the log the scan just wrote. Built
          // here rather than from the in-memory collector so the artifacts
          // and a later `browserrecon export` of the same session cannot
          // disagree — the log is the source of truth (§22.1).
          assembled = assemble({
            sessionId,
            target: policy.targetOrigin,
            events: await readAllEvents(sessionDir),
            firstPartyOrigins: [...policy.allowedOrigins],
            unreached: gapInputs(queue.skipped, excluded, queue.pending),
          });

          return writeArtifacts(
            sessionDir,
            sessionId,
            startedAt,
            policy,
            rateProfile,
            exportInput,
            network.model,
            assembled,
          );
        },
      },
      clock: {
        now: () => Date.now(),
        sleep: (ms, signal) =>
          new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, ms);
            signal?.addEventListener(
              "abort",
              () => {
                clearTimeout(timer);
                resolve();
              },
              { once: true },
            );
          }),
      },
      onPhase: (phases) => writeSession(phases),
    });
  } catch (error) {
    if (error instanceof ScanRefused) {
      throw new CliError(error.message, EXIT_CODES.policy, error.outcome.remedy);
    }
    throw error;
  } finally {
    persist();
    network.stop();
    store.close();
  }

  writeSession(result.phases, result);

  // ---- 7. tell the user ---------------------------------------------------
  const summary: ScanSummary = {
    target: policy.targetOrigin,
    sessionId,
    durationSeconds: Math.round((Date.now() - Date.parse(startedAt)) / 1000),
    completeness: result.completeness,
    ...(result.stopReason === "queue_empty" ? {} : { stopReason: result.stopReason }),
    pagesVisited: result.pagesVisited,
    // Everything the scan knew about, not just what it got to. Reporting
    // "6 of 6" when the budget stopped a queue of 20 is the one number a
    // reader uses to judge whether the scan was worth anything.
    candidatesDiscovered: queue.visited.length + queue.pending,
    templatesSaturated: 0,
    instancesSkipped: 0,
    // From the assembled model, not the raw request count. The summary used
    // to report every request the browser made as an API — thirteen for a
    // six-page fixture with three endpoints — and it disagreed with the
    // surface file written beside it.
    workflows: assembled?.workflows.candidates.length ?? 0,
    apisObserved: assembled?.api.apis.length ?? 0,
    apisUnobserved: assembled === undefined ? 0 : unreachedApiCount(assembled),
    origins: network.model.origins.length,
    jsAssets: new Set(
      network.model.observations
        .filter((o) => o.resourceType === "Script")
        .map((o) => o.url.identity),
    ).size,
    barriers: [],
    topGaps: summarizeGaps(queue.skipped, excluded, queue.pending),
    discoverySources: ["browser"],
    aiMode: "off",
    rateProfile,
    artifacts: result.artifacts,
    outputDir: sessionDir,
  };

  const rendered = formatSummary(
    summary,
    resolveSummaryMode({ quiet: input.quiet, json: input.json }),
  );
  if (rendered !== undefined) input.write(rendered);
}

/**
 * Reasons that are bookkeeping rather than coverage gaps.
 *
 * A URL skipped because it was already visited is not a URL the scan failed
 * to reach — it is the queue doing its job. Listing it under "why coverage
 * stopped where it did" pushed the real reasons off a five-line list and
 * made a clean scan look like it had lost five pages.
 */
const NOT_A_GAP: ReadonlySet<string> = new Set(["already_visited", "duplicate_in_queue"]);

/**
 * Turn what the scan could not reach into §10C.7's gap vocabulary.
 *
 * The queue's own skip reasons and the coverage engine's are different
 * taxonomies for different readers — one is about why a URL was not queued,
 * the other about what a user could do next — so the mapping is explicit
 * rather than a cast, and anything unrecognised becomes `budget_exhausted`
 * rather than being dropped.
 */
function gapInputs(
  skipped: readonly { readonly url: string; readonly reason: string }[],
  excludedControls: readonly { readonly url: string; readonly reason: string }[],
  stillQueued: number,
): GapInput[] {
  const toReason = (reason: string): GapReason => {
    if (
      reason === "out_of_scope" ||
      reason === "policy_denied" ||
      reason === "robots_excluded"
    ) {
      return "policy_excluded";
    }
    if (reason === "not_http") return "not_navigable";
    if (reason.includes("destructive") || reason.includes("state_changing"))
      return "requires_state";
    if (reason === "authentication_form") return "requires_role";
    if (reason === "method_not_allowed") return "policy_excluded";
    return "budget_exhausted";
  };

  const gaps: GapInput[] = [];
  for (const entry of [...skipped, ...excludedControls]) {
    if (NOT_A_GAP.has(entry.reason)) continue;
    gaps.push({
      type: "unobserved_route",
      candidate: entry.url,
      reason: toReason(entry.reason),
      ...(entry.reason === "method_not_allowed"
        ? { blockedBecause: "policy.allowed_methods excludes the form's method" }
        : {}),
    });
  }

  if (stillQueued > 0) {
    gaps.push({
      type: "unobserved_route",
      candidate: `${stillQueued} URL(s) still queued when the budget ran out`,
      reason: "budget_exhausted",
    });
  }
  return gaps;
}

/** Group skip reasons into §10C.7's counts, commonest first. */
function summarizeGaps(
  skipped: readonly { readonly reason: string }[],
  excluded: readonly { readonly reason: string }[],
  stillQueued: number,
): { reason: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const { reason } of [...skipped, ...excluded]) {
    if (NOT_A_GAP.has(reason)) continue;
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  // Pages the scan had found and ran out of budget for. The commonest real
  // gap on any site large enough to matter, and invisible without this —
  // the queue never records them, because nothing skipped them.
  if (stillQueued > 0) counts.set("budget_exhausted", stillQueued);
  return (
    [...counts.entries()]
      .map(([reason, count]) => ({ reason, count }))
      // Count descending, then name, so equal counts do not reorder between
      // runs and make every report a diff.
      .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason))
  );
}

/**
 * Map a policy denial onto the queue's vocabulary.
 *
 * The two taxonomies exist for different readers — the engine's reasons are
 * precise, the queue's are what a coverage report groups by — so the
 * mapping is explicit rather than a cast, and an unrecognised reason falls
 * through to `policy_denied` rather than being dropped.
 */
function skipReasonFor(reason: string): SkipReason {
  if (reason === "origin_not_allowed") return "out_of_scope";
  if (reason === "scheme_not_allowed" || reason === "malformed_url") return "not_http";
  return "policy_denied";
}

/**
 * Turn the collector's model into the published shape.
 *
 * Not a pass-through, and the reason is measured: exporting
 * `NetworkObservation` directly put Chrome's own `requestId` and `frameId`
 * into `attack-surface.json`, so three runs of the same scan produced three
 * different documents. Those handles mean nothing outside the CDP session
 * that issued them — a consumer cannot resolve one and a reviewer cannot
 * diff one.
 *
 * What replaces them is `api_0001`, allocated in a deterministic order, and
 * `source_event_ids`, which §35B.5 requires and which *can* be resolved:
 * they point into `events.jsonl`.
 */
function toExportedApis(observations: readonly NetworkObservation[]): {
  apis: ExportedApi[];
  sorted: NetworkObservation[];
} {
  // Sorted by identity so the inventory diffs cleanly. Arrival order still
  // exists, in the event log, where it is the ordering authority (§13.2) —
  // an inventory sorted by when a request happened would reshuffle on every
  // run for reasons that say nothing about the target.
  const sorted = [...observations].sort(
    (a, b) =>
      a.method.localeCompare(b.method) ||
      a.url.identity.localeCompare(b.url.identity) ||
      a.sequence - b.sequence,
  );

  const apis = sorted.map((observation, index): ExportedApi => ({
    api_id: `api_${String(index + 1).padStart(4, "0")}`,
    method: observation.method,
    url: observation.url.identity,
    observed: {
      ...(observation.status === undefined ? {} : { status: observation.status }),
      ...(observation.mimeType === undefined ? {} : { content_type: observation.mimeType }),
      ...(observation.resourceType === undefined
        ? {}
        : { resource_type: observation.resourceType }),
    },
    ...(observation.initiatorType === undefined
      ? {}
      : {
          initiator: {
            type: observation.initiatorType,
            ...(observation.initiatorUrl === undefined
              ? {}
              : { source: observation.initiatorUrl }),
          },
        }),
    // The envelope sequence resolves in events.jsonl, which is what makes
    // this traceable rather than decorative.
    source_event_ids: [`evt_${String(observation.sequence).padStart(6, "0")}`],
    provenance: "observed",
  }));

  return { apis, sorted };
}

async function writeArtifacts(
  sessionDir: string,
  sessionId: string,
  startedAt: string,
  policy: TargetPolicy,
  rateProfile: string,
  exportInput: {
    readonly completeness: "complete" | "partial";
    readonly stopReason?: string | undefined;
    readonly pagesVisited: number;
    readonly candidatesDiscovered: number;
  },
  model: NetworkModel,
  assembled: AssembledModel,
): Promise<readonly string[]> {
  const redactor = createRedactor();
  const jsonPath = join(sessionDir, "attack-surface.json");
  const reportPath = join(sessionDir, "report.md");
  const { apis } = toExportedApis(model.observations);

  const origins = [...model.origins]
    .map((group) => ({
      origin: group.origin,
      requests: group.requests,
      classification: group.origin === policy.targetOrigin ? "first_party" : "third_party",
    }))
    .sort((a, b) => a.origin.localeCompare(b.origin));

  const scan = {
    session_id: sessionId,
    target: policy.targetOrigin,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    completeness: exportInput.completeness,
    ...(exportInput.stopReason === undefined ? {} : { stop_reason: exportInput.stopReason }),
    rate_profile: rateProfile,
    discovery_sources: ["browser"],
    ai_mode: "off",
    coverage_caveat: COVERAGE_CAVEAT,
  };

  const chunks: string[] = [];
  await streamDocument(
    {
      scan,
      origins,
      apis: withModelContext(apis, assembled),
      // Everything V2 and V3 derive. These were empty arrays until the M3
      // gate produced a sample report: the pipeline had been building
      // workflows, sequences and a gap queue for two milestones and no
      // artifact carried any of it.
      workflows: exportedWorkflows(assembled),
      apiSequences: assembled.sequences.sequences,
      javascript: exportedJavascript(model),
      barriers: [],
      coverageGaps: assembled.gaps,
      unreachedCandidateAssociations: [],
    },
    (chunk) => {
      chunks.push(chunk);
    },
    { redactor, pretty: true },
  );

  const serialized = chunks.join("");
  // Validated before it is written, not after. An export that fails its own
  // schema is one a consumer discovers at parse time, on their machine.
  const problems = validateDocument(JSON.parse(serialized) as Partial<ExportedDocument>);
  if (problems.length > 0) {
    throw new Error(`the export does not satisfy its own schema:\n  ${problems.join("\n  ")}`);
  }
  writeFileSync(jsonPath, serialized, { mode: 0o600 });

  // §23's scanner-consumable model, validated against its own contract
  // before it is written. §35B.5 calls an unresolvable source id a bug, and
  // a bug is better caught here than by whoever imports the file.
  const surfacePath = join(sessionDir, "surface.json");
  const surfaceProblems = validateSurface(assembled.surface, {
    knownWorkflows: new Set(assembled.workflows.candidates.map((c) => c.workflow_id)),
    knownApis: new Set(assembled.api.apis.map((entry) => entry.api_id)),
    knownEvents: new Set(assembled.surface.items.flatMap((item) => item.source_event_ids)),
    knownInteractions: new Set(
      assembled.api.apis.flatMap((entry) =>
        entry.observations
          .map((observation) => observation.interactionId)
          .filter((id): id is string => id !== undefined),
      ),
    ),
    knownNavigations: new Set(
      assembled.api.apis.flatMap((entry) =>
        entry.observations
          .map((observation) => observation.navigationId)
          .filter((id): id is string => id !== undefined),
      ),
    ),
  });
  if (surfaceProblems.length > 0) {
    throw new Error(
      `the attack surface does not satisfy its own contract:\n  ${surfaceProblems
        .map((entry) => `${entry.surface_id}: ${entry.problem}`)
        .join("\n  ")}`,
    );
  }
  writeFileSync(surfacePath, `${JSON.stringify(assembled.surface, null, 2)}\n`, {
    mode: 0o600,
  });

  writeFileSync(
    reportPath,
    renderReport({
      header: {
        target: policy.targetOrigin,
        sessionId,
        schemaVersion: EXPORT_SCHEMA_VERSION,
        durationSeconds: Math.round((Date.now() - Date.parse(startedAt)) / 1000),
        rateProfile,
        allowedMethods: [...policy.allowedMethods],
        discoverySources: ["browser"],
        authState: "anonymous",
        aiMode: "off",
      },
      score: { value: assembled.score.score, description: assembled.score.description },
      coverage: coverageRows(assembled, exportInput),
      // §21, §44. Registering a tool sends nothing, so this is the one part
      // of the surface that never appears in traffic — and the report is
      // where a person finds out the page hands agents a `deleteAccount`.
      webmcpTools: assembled.webmcp.map((tool) => ({
        name: tool.name,
        ...(tool.endpoint === undefined ? {} : { endpoint: tool.endpoint }),
        ...(tool.description === undefined ? {} : { description: tool.description }),
        destructive: tool.destructive,
      })),
      workflows: reportWorkflows(assembled),
      apis: assembled.api.apis.map((api) => ({
        method: api.method,
        url: api.url,
        ...(api.statuses[0] === undefined ? {} : { status: api.statuses[0] }),
        role: api.role,
      })),
      origins,
      javascript: exportedJavascript(model).map((asset) => ({
        url: asset.url,
        ...(asset.bytes === undefined ? {} : { bytes: asset.bytes }),
        firstParty: asset.first_party,
        analysis: asset.analysis,
      })),
      barriers: [],
      // The typed queue, with §10C.7's own responses — not a second remedy
      // table that can drift from it.
      gaps: gapRows(assembled),
      outputDir: sessionDir,
      // Named relative to the session directory, which is where the report
      // itself sits and is named just above. The absolute paths were
      // correct and unreadable — three wrapped lines of temp directory to
      // say `events-0001.jsonl`.
      //
      // The filenames are read from disk. `events.jsonl` was a guess, and
      // the store writes numbered segments, so every report before this
      // pointed at a file that does not exist.
      artifacts: [
        ...readdirSync(sessionDir)
          .filter((name) => name.startsWith("events-") && name.endsWith(".jsonl"))
          .sort()
          .map((name) => ({ path: name, contents: "raw observations" })),
        {
          path: basename(jsonPath),
          contents: "derived model",
          records: assembled.api.apis.length,
        },
        {
          path: basename(surfacePath),
          contents: "scanner-consumable surface",
          records: assembled.surface.items.length,
        },
      ],
    }),
    { mode: 0o600 },
  );

  return [reportPath, jsonPath, surfacePath];
}

/**
 * §10C.7's queue, grouped for the report.
 *
 * The remedies come from `@browserrecon/coverage`, which owns the gap
 * vocabulary. A second table here said roughly the same things about a
 * different set of reasons, and only one of the two was ever updated.
 */
function gapRows(
  assembled: AssembledModel,
): readonly { reason: string; count: number; remedy: string }[] {
  const counts = new Map<string, { count: number; remedy: string }>();
  for (const gap of assembled.gaps) {
    const existing = counts.get(gap.reason);
    counts.set(gap.reason, {
      count: (existing?.count ?? 0) + 1,
      remedy:
        gap.remedy ??
        existing?.remedy ??
        // §10C.7 says so for `not_navigable`: there is nothing to do, and
        // inventing an action would be worse than saying so.
        NOT_NAVIGABLE_NOTE,
    });
  }
  return [...counts.entries()]
    .map(([reason, entry]) => ({ reason, count: entry.count, remedy: entry.remedy }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
}

/**
 * The next free session number in an output directory.
 *
 * Every scan used to be `sess_0001`. A second scan into the same `--out`
 * crashed on the event store's own guard — "already holds session sess_0001"
 * — as an internal error with a stack trace, and the guard was right: two
 * scans were about to share one log. Since the natural thing to do is point
 * every run at the same directory, and the Gate A runbook says to, the
 * second command anybody ran would have hit it.
 *
 * Highest existing plus one, rather than a count: a directory the user
 * deleted must not hand its number to a different scan.
 */
function nextSessionOrdinal(outputRoot: string): number {
  let highest = 0;
  try {
    for (const name of readdirSync(outputRoot)) {
      const match = /^sess_(\d+)$/.exec(name);
      if (match === null) continue;
      highest = Math.max(highest, Number(match[1]));
    }
  } catch {
    // No output directory yet, which is the first scan on this machine.
  }
  return highest + 1;
}

/** §10C.1's dimension names, as a reader would say them. */
const DIMENSION_LABELS: Readonly<Record<string, string>> = {
  url: "URLs",
  route: "Routes",
  js_asset: "JS assets",
  js_bytes: "JS bytes",
  first_party_js: "First-party JS",
  runtime_api: "APIs (runtime)",
  static_api_candidate: "API candidates (static)",
  workflow: "Workflows",
  api_sequence: "API sequences",
  state_transition: "State transitions",
  webmcp: "WebMCP tools",
  origin: "Origins",
  access_barrier: "Access barriers",
};

/**
 * The coverage table — §10C.1's dimensions, not three hand-picked counts.
 *
 * The three that used to be here (Pages, APIs, Origins) were assembled at
 * this call site and every one of them showed 100%, beside a score of 0.60
 * the reader had no way to reconcile with them. The score is computed from
 * the dimensions, so the dimensions are what the table has to show.
 *
 * A dimension that found nothing is left out rather than printed as zero:
 * §10C.2 keeps "we did not look" and "we looked and it was not there" apart,
 * and a row of zeros reads as the second.
 */
function coverageRows(
  assembled: AssembledModel,
  exportInput: { readonly pagesVisited: number; readonly candidatesDiscovered: number },
): readonly { dimension: string; observed: number; discovered: number }[] {
  const rows = [
    // Pages is not a §10C dimension — it is the budget the user set, and
    // the first thing they look for.
    {
      dimension: "Pages",
      observed: exportInput.pagesVisited,
      discovered: exportInput.candidatesDiscovered,
    },
  ];

  for (const dimension of assembled.coverage.dimensions) {
    if (dimension.total === 0) continue;
    const reached =
      dimension.byStatus.observed + dimension.byStatus.analyzed + dimension.byStatus.correlated;
    rows.push({
      dimension: DIMENSION_LABELS[dimension.dimension] ?? dimension.dimension,
      observed: reached,
      discovered: dimension.total,
    });
  }
  return rows;
}

/** Static candidates the scan never reached, for the coverage denominator. */
function unreachedApiCount(assembled: AssembledModel): number {
  return (
    assembled.coverage.dimensions.find(
      (dimension) => dimension.dimension === "static_api_candidate",
    )?.total ?? 0
  );
}

/** Workflow candidates as §35B.3's steps. */
function reportWorkflows(assembled: AssembledModel): readonly WorkflowReport[] {
  return assembled.workflows.candidates.map((candidate) => ({
    id: candidate.workflow_id,
    // Naming is §18.2's job and needs V4. Until then the routes are the
    // honest name: a label this layer invented would read like a finding.
    name: candidate.routes[0] ?? candidate.workflow_id,
    confidence: candidate.confidence,
    steps: candidate.events.map((event, index) => ({
      step: index + 1,
      kind: "request" as const,
      detail: `${event.routeTemplate} (${event.apiId})`,
      ...(event.dependsOn.length === 0 ? {} : { causedBy: event.dependsOn }),
    })),
  }));
}

/** Scripts the browser fetched, for §35B.2's JavaScript section. */
function exportedJavascript(model: NetworkModel): readonly {
  url: string;
  bytes?: number | undefined;
  first_party: boolean;
  analysis: string;
}[] {
  const seen = new Set<string>();
  const assets: {
    url: string;
    bytes?: number | undefined;
    first_party: boolean;
    analysis: string;
  }[] = [];

  for (const observation of model.observations) {
    if (observation.resourceType !== "Script") continue;
    const url = observation.url.identity;
    if (seen.has(url)) continue;
    seen.add(url);
    assets.push({
      url,
      ...(observation.responseBytes === undefined ? {} : { bytes: observation.responseBytes }),
      first_party: model.origins.some(
        (group) => group.origin === originOf(url) && group.requests > 0,
      ),
      // Static analysis runs on demand rather than in the scan loop, so the
      // honest answer here is what was collected, not what was parsed.
      analysis: observation.bodyCaptured === true ? "body captured" : "not analysed",
    });
  }
  return assets.sort((a, b) => a.url.localeCompare(b.url));
}

/** Workflow candidates in the published document's shape. */
function exportedWorkflows(assembled: AssembledModel): readonly unknown[] {
  return assembled.workflows.candidates.map((candidate) => ({
    workflow_id: candidate.workflow_id,
    confidence: candidate.confidence,
    low_confidence: candidate.lowConfidence,
    auth_context: candidate.authContext,
    routes: candidate.routes,
    interactions: candidate.interactions,
    evidence: candidate.evidence,
    ...(candidate.startedBy === undefined ? {} : { started_by: candidate.startedBy }),
    ...(candidate.endedBy === undefined ? {} : { ended_by: candidate.endedBy }),
    ...(candidate.truncatedBy === undefined ? {} : { truncated_by: candidate.truncatedBy }),
    provenance: "derived",
  }));
}

/**
 * Attach what the model knows to the observations the document exports.
 *
 * The document is observation-level by design — one entry per request the
 * browser made, which is what makes it a record rather than an
 * interpretation. What it was missing is the interpretation *alongside* it:
 * which of those requests the classifier called an application API, which
 * workflow it belongs to, and what it depends on.
 */
function withModelContext(
  apis: readonly ExportedApi[],
  assembled: AssembledModel,
): readonly ExportedApi[] {
  const byIdentity = new Map<string, (typeof assembled.api.apis)[number]>();
  for (const entry of assembled.api.apis) {
    for (const observation of entry.observations) {
      byIdentity.set(`${entry.method} ${observation.url}`, entry);
    }
  }

  // §17A.1 classifies and never drops, so every request has a verdict — not
  // only the ones the model kept. Read from the model rather than
  // re-classified here: a second opinion built from different inputs is how
  // one file comes to disagree with itself.
  const roleOf = new Map(
    assembled.api.classified.map((entry) => [`${entry.method} ${entry.identity}`, entry.role]),
  );

  const surfaceByApi = new Map(
    assembled.surface.items
      .filter((item) => item.api_id !== undefined)
      .map((item) => [item.api_id as string, item]),
  );

  return apis.map((api): ExportedApi => {
    const key = `${api.method} ${api.url}`;
    const role = roleOf.get(key);
    const entry = byIdentity.get(key);
    if (entry === undefined) return role === undefined ? api : { ...api, role };
    const surface = surfaceByApi.get(entry.api_id);
    const first = entry.observations[0];

    return {
      ...api,
      role: entry.role,
      ...(surface?.workflow_id === undefined && first?.interactionId === undefined
        ? {}
        : {
            context: {
              ...(api.context ?? {}),
              ...(surface?.workflow_id === undefined
                ? {}
                : { workflow_id: surface.workflow_id, workflow_step: surface.workflow_step }),
              ...(first?.interactionId === undefined
                ? {}
                : { interaction_id: first.interactionId }),
              ...(first?.navigationId === undefined
                ? {}
                : { navigation_id: first.navigationId }),
            },
          }),
      ...(entry.depends_on.length === 0
        ? {}
        : { depends_on: entry.depends_on.map((edge) => edge.target) }),
      ...(entry.caused_by.length === 0
        ? {}
        : { caused_by: entry.caused_by.map((edge) => edge.target) }),
    };
  });
}

/** The origin of a URL, or the URL itself when it will not parse. */
function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}
