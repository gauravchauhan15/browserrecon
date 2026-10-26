/**
 * Assembling the model — build plan §23, §44 (V3); dev plan BR-M3-12.
 *
 * One function from a recorded event log to everything V3 promises: an API
 * model, workflow candidates, a state graph, coverage with a gap queue, and
 * the surface object a scanner consumes.
 *
 * ## Why it lives here rather than in the CLI
 *
 * Because §1.2's load-bearing rule applies to the whole pipeline, not to each
 * piece: everything from correlation rightward must run against a recorded
 * `events.jsonl` with no browser present. Assembled in the CLI, the pipeline
 * would only ever be exercised by a scan — and a scan needs Chrome, a
 * fixture and a minute. Here, the M3 gate can assert the same assembly from a
 * literal array in milliseconds, and a user can re-run it over last week's
 * log with better rules.
 *
 * ## WebMCP is surface, not a footnote
 *
 * §44 lists "WebMCP is integrated into the attack-surface model" as one of
 * the four things V3 means. A page that registers tools is publishing named,
 * schema'd operations to any agent that visits — often wired straight to its
 * own APIs — and it sends no network traffic, so nothing else in this
 * pipeline would ever see it. Left out, the one part of the surface that is
 * invisible to traffic analysis is the one part this tool omits.
 */
import type { EventEnvelope } from "@browserrecon/events";
import {
  buildApiModel,
  buildSequences,
  type ApiModel,
  type SequenceModel,
} from "@browserrecon/api-model";
import {
  buildWorkflowCandidates,
  buildWorkflowGraph,
  type WorkflowGraph,
  type WorkflowModel,
} from "@browserrecon/workflows";
import { buildStateModel, type StateModel } from "@browserrecon/state-model";
import {
  buildCoverage,
  buildGapQueue,
  scoreCoverage,
  type CoverageGap,
  type CoverageItem,
  type CoverageReport,
  type CoverageScore,
  type GapInput,
} from "@browserrecon/coverage";
import { buildDependencyGraph, type DependencyGraph } from "@browserrecon/correlation";
import { buildAttackSurface, type AttackSurface, type SurfaceItem } from "./surface.js";

export interface AssembleInput {
  readonly sessionId: string;
  readonly target: string;
  readonly events: readonly EventEnvelope[];
  readonly firstPartyOrigins?: readonly string[] | undefined;
  /** Candidates found but never reached, for the gap queue. */
  readonly unreached?: readonly GapInput[] | undefined;
}

export interface AssembledModel {
  readonly api: ApiModel;
  readonly sequences: SequenceModel;
  readonly workflows: WorkflowModel;
  readonly workflowGraph: WorkflowGraph;
  readonly dependencies: DependencyGraph;
  readonly state: StateModel;
  readonly coverage: CoverageReport;
  readonly score: CoverageScore;
  readonly gaps: readonly CoverageGap[];
  /** §21: what the page publishes to agents. Invisible to traffic analysis. */
  readonly webmcp: readonly WebMcpToolFound[];
  readonly surface: AttackSurface;
}

interface WebMcpToolPayload {
  readonly name?: string;
  readonly description?: string;
  readonly endpoint?: string;
  readonly origin?: string;
  readonly url?: string;
  readonly inputSchema?: unknown;
  readonly annotations?: Record<string, unknown>;
}

/** One tool the page published to any agent that visits. */
export interface WebMcpToolFound {
  readonly name: string;
  readonly description?: string | undefined;
  readonly endpoint?: string | undefined;
  /**
   * The tool's declared input schema.
   *
   * Harvested and published since the adapter was written, and dropped here
   * — the model carried the name and the endpoint and discarded the one
   * field that says what the tool *takes*. For an attack-surface model the
   * parameters are most of the value: they are the shape of what any
   * visiting agent can pass in.
   */
  readonly inputSchema?: unknown;
  /** MCP tool annotations as the page declared them (§7.2). */
  readonly annotations?: Record<string, unknown> | undefined;
  /**
   * Whether the page says the tool changes state.
   *
   * Three-valued on purpose. `undefined` means the page declared no
   * annotations, which is not the same as declaring the tool safe — and
   * rendering that as "no" is a claim the page never made. The first sample
   * report after this field was added showed a `deleteAccount` tool,
   * described as permanently deleting an account, in a column reading "no".
   */
  readonly destructive?: boolean | undefined;
  readonly eventId: string;
  readonly authContext: string;
}

/** Tools the page registered, read straight from the log. */
function webMcpTools(events: readonly EventEnvelope[]): readonly WebMcpToolFound[] {
  const found: WebMcpToolFound[] = [];
  const seen = new Set<string>();

  for (const envelope of events) {
    if (envelope.type !== "webmcp_tool_discovered") continue;
    const payload = envelope.payload as WebMcpToolPayload;
    const name = payload.name;
    if (name === undefined || name === "" || seen.has(name)) continue;
    seen.add(name);
    found.push({
      name,
      ...(payload.description === undefined ? {} : { description: payload.description }),
      ...(payload.endpoint === undefined ? {} : { endpoint: payload.endpoint }),
      ...(payload.inputSchema === undefined ? {} : { inputSchema: payload.inputSchema }),
      ...(payload.annotations === undefined ? {} : { annotations: payload.annotations }),
      // Either hint is enough: a page saying `readOnlyHint: false` has said
      // the same thing as one saying `destructiveHint: true`, and a report
      // understanding only one of them would miss half. Absent both, the
      // answer is "the page did not say" rather than "no".
      ...(payload.annotations === undefined
        ? {}
        : {
            destructive:
              payload.annotations.destructiveHint === true ||
              payload.annotations.readOnlyHint === false,
          }),
      eventId: envelope.event_id,
      authContext: envelope.auth_context,
    });
  }
  return found;
}

interface ScriptAsset {
  readonly url: string;
  readonly firstParty: boolean;
  /** A captured body is what static analysis has to work from. */
  readonly bodyCaptured: boolean;
}

/**
 * Scripts the browser fetched, and routes it committed to.
 *
 * Read from the log rather than passed in, so the coverage denominator is
 * the same log everything else is derived from. Both dimensions existed in
 * §10C.1 and were never populated: a scan that fetched and captured two
 * bundles reported `js_asset 0`, `first_party_js 0` and `route 0` while its
 * own report listed the scripts and the pages in the sections below — and
 * the score docked 0.2 for JavaScript it had, in fact, collected.
 */
function pageContext(
  events: readonly EventEnvelope[],
  firstPartyOrigins: readonly string[],
): { readonly scripts: readonly ScriptAsset[]; readonly routes: readonly string[] } {
  const scripts = new Map<string, ScriptAsset>();
  const routes = new Set<string>();
  const pending = new Map<string, { url: string; script: boolean }>();

  const routeOf = (raw: string): string | undefined => {
    try {
      const url = new URL(raw);
      return `${url.origin}${url.pathname}`;
    } catch {
      return undefined;
    }
  };

  for (const envelope of events) {
    if (envelope.type === "navigation_committed" || envelope.type === "page_loaded") {
      const route = routeOf((envelope.payload as { url?: string }).url ?? "");
      if (route !== undefined) routes.add(route);
      continue;
    }

    if (envelope.type === "network_request") {
      const payload = envelope.payload as {
        requestId?: string;
        url?: string;
        resourceType?: string;
      };
      if (payload.requestId === undefined || payload.url === undefined) continue;
      pending.set(payload.requestId, {
        url: payload.url,
        script: payload.resourceType?.toLowerCase() === "script",
      });
      continue;
    }

    if (envelope.type !== "network_response") continue;
    const payload = envelope.payload as {
      requestId?: string;
      body?: { text?: string };
    };
    const request =
      payload.requestId === undefined ? undefined : pending.get(payload.requestId);
    if (request === undefined || !request.script) continue;
    pending.delete(payload.requestId as string);

    const identity = routeOf(request.url) ?? request.url;
    const captured = payload.body?.text !== undefined;
    const existing = scripts.get(identity);
    scripts.set(identity, {
      url: identity,
      firstParty: firstPartyOrigins.some((origin) => identity.startsWith(origin)),
      bodyCaptured: captured || existing?.bodyCaptured === true,
    });
  }

  return {
    scripts: [...scripts.values()].sort((a, b) => a.url.localeCompare(b.url)),
    routes: [...routes].sort(),
  };
}

/**
 * Build everything, in dependency order.
 *
 * Each stage reads the one before it rather than the raw log where it can:
 * the API model settles identity, role and causality once, and a second
 * component deriving any of them again is how two parts of a report come to
 * disagree.
 */
export function assemble(input: AssembleInput): AssembledModel {
  const api = buildApiModel(input.events, {
    ...(input.firstPartyOrigins === undefined
      ? {}
      : { firstPartyOrigins: input.firstPartyOrigins }),
  });

  const sequences = buildSequences(api);

  const apiEvents = api.apis.flatMap((entry) =>
    entry.observations.map((observation) => ({
      sequence: observation.sequence,
      apiId: entry.api_id,
      routeTemplate: `${entry.identity.pathTemplate}`,
      timestampMs: observation.sequence,
      ...(observation.interactionId === undefined
        ? {}
        : { interactionId: observation.interactionId }),
      ...(observation.initiator.scripts[0] === undefined
        ? {}
        : { initiatorScript: observation.initiator.scripts[0] }),
      // The whole stack, not its top frame: §18.1's merge rule compares
      // chains, and an application with a shared fetch wrapper has one top
      // frame for every request it makes.
      ...(observation.initiator.frames.length === 0
        ? {}
        : {
            initiatorChain: observation.initiator.frames.map((frame) => frame.raw).join(" < "),
          }),
      authContext: observation.authContext,
      dependsOn: entry.depends_on.map((edge) => edge.target.replace(/^api:/, "")),
    })),
  );

  const state = buildStateModel({
    events: input.events,
    apiEvents: api.apis.flatMap((entry) =>
      entry.observations.map((observation) => ({
        sequence: observation.sequence,
        apiId: entry.api_id,
        eventId: observation.eventId,
        method: entry.method,
        path: entry.url,
        ...(observation.status === undefined ? {} : { status: observation.status }),
        authContext: observation.authContext,
        ...(observation.interactionId === undefined
          ? {}
          : { interactionId: observation.interactionId }),
      })),
    ),
  });

  const workflows = buildWorkflowCandidates({
    apiEvents,
    events: input.events,
    stateTransitions: state.transitions.map((transition) => transition.sequence),
  });

  const workflowGraph = buildWorkflowGraph({
    candidates: workflows.candidates,
    transitions: state.transitions.map((transition) => ({
      from: transition.from,
      to: transition.to,
      sequence: transition.sequence,
    })),
  });

  const dependencies = buildDependencyGraph(
    api.apis.map((entry) => ({
      api_id: entry.api_id,
      depends_on: entry.depends_on.map((edge) => ({
        from: entry.api_id,
        to: edge.target.replace(/^api:/, ""),
        basis: edge.basis,
      })),
    })),
  );

  const tools = webMcpTools(input.events);
  const { scripts, routes } = pageContext(input.events, input.firstPartyOrigins ?? []);

  // The API model groups by endpoint, not by origin, so the origin list is
  // derived here rather than read — one derivation, in the place that needs
  // it, sorted so the surface stays diffable.
  const origins = [...new Set(api.apis.map((entry) => entry.identity.origin))].sort();

  // Which workflow each API belongs to, so a surface item can carry it.
  const workflowOf = new Map<string, { id: string; step: number }>();
  for (const candidate of workflows.candidates) {
    for (const [index, event] of candidate.events.entries()) {
      if (workflowOf.has(event.apiId)) continue;
      workflowOf.set(event.apiId, { id: candidate.workflow_id, step: index + 1 });
    }
  }

  // State either side of an API, where the state graph saw a transition.
  const stateAround = (sequence: number): { before?: string; after?: string } => {
    let before: string | undefined;
    let after: string | undefined;
    for (const transition of state.transitions) {
      if (transition.sequence <= sequence) before = transition.to;
      else if (after === undefined) after = transition.to;
    }
    return {
      ...(before === undefined ? {} : { before }),
      ...(after === undefined ? {} : { after }),
    };
  };

  const items: Omit<SurfaceItem, "surface_id">[] = [
    ...api.apis.map((entry) => {
      const first = entry.observations[0];
      const workflow = workflowOf.get(entry.api_id);
      const around = first === undefined ? {} : stateAround(first.sequence);

      return {
        kind: "api_endpoint" as const,
        identity: `${entry.method} ${entry.url}`,
        provenance: "observed" as const,
        api_id: entry.api_id,
        ...(workflow === undefined
          ? {}
          : { workflow_id: workflow.id, workflow_step: workflow.step }),
        ...(first?.interactionId === undefined ? {} : { interaction_id: first.interactionId }),
        ...(first?.navigationId === undefined ? {} : { navigation_id: first.navigationId }),
        ...(around.before === undefined ? {} : { state_before: around.before }),
        ...(around.after === undefined ? {} : { state_after: around.after }),
        auth_context: first?.authContext ?? "anonymous",
        source_event_ids: entry.source_event_ids,
      };
    }),

    // §44's fourth clause. Invisible to traffic analysis, so nothing else in
    // this pipeline would ever put it in the surface.
    ...tools.map((tool) => ({
      kind: "webmcp_tool" as const,
      identity: tool.endpoint === undefined ? tool.name : `${tool.name} -> ${tool.endpoint}`,
      provenance: "observed" as const,
      auth_context: tool.authContext,
      source_event_ids: [tool.eventId],
    })),

    ...origins.map((origin) => ({
      kind: "origin" as const,
      identity: origin,
      provenance: "observed" as const,
      auth_context: "anonymous",
      source_event_ids: api.apis
        .filter((entry) => entry.identity.origin === origin)
        .flatMap((entry) => entry.source_event_ids)
        .slice(0, 5),
    })),
  ];

  const coverageItems: CoverageItem[] = [
    ...api.apis.map((entry): CoverageItem => ({
      dimension: "runtime_api",
      id: entry.api_id,
      status: "observed",
    })),
    ...workflows.candidates.map((candidate): CoverageItem => ({
      dimension: "workflow",
      id: candidate.workflow_id,
      // A low-confidence candidate is a candidate, not an exploration.
      status: candidate.lowConfidence ? "unobserved" : "observed",
    })),
    ...state.transitions.map((_transition, index): CoverageItem => ({
      dimension: "state_transition",
      id: `st_${index}`,
      status: "observed",
    })),
    ...sequences.sequences.map((sequence): CoverageItem => ({
      dimension: "api_sequence",
      id: sequence.sequence_id,
      status: "observed",
    })),
    ...tools.map((tool): CoverageItem => ({
      dimension: "webmcp",
      id: tool.name,
      status: "observed",
    })),
    ...routes.map((route): CoverageItem => ({
      dimension: "route",
      id: route,
      status: "observed",
    })),
    ...scripts.map((script): CoverageItem => ({
      dimension: "js_asset",
      id: script.url,
      // `analyzed` only where there is something to analyse. A script the
      // scan saw go past but never captured is observed, not understood, and
      // §10C.2 keeps those apart on purpose.
      status: script.bodyCaptured ? "analyzed" : "observed",
    })),
    ...scripts
      .filter((script) => script.firstParty)
      .map((script): CoverageItem => ({
        dimension: "first_party_js",
        id: script.url,
        status: script.bodyCaptured ? "analyzed" : "observed",
      })),
    ...origins.map((origin): CoverageItem => ({
      dimension: "origin",
      id: origin,
      status: "observed",
    })),
    ...(input.unreached ?? []).map((gap, index): CoverageItem => ({
      dimension: "static_api_candidate",
      id: `${gap.candidate}#${index}`,
      status: "unobserved",
    })),
  ];

  const coverage = buildCoverage({ items: coverageItems });

  return {
    api,
    sequences,
    workflows,
    workflowGraph,
    dependencies,
    state,
    coverage,
    score: scoreCoverage({ coverage }),
    gaps: buildGapQueue(input.unreached ?? []),
    webmcp: tools,
    surface: buildAttackSurface({
      sessionId: input.sessionId,
      target: input.target,
      items,
    }),
  };
}
