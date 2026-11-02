/**
 * @browserrecon/exporter-markdown — `report.md`.
 *
 * Build plan §35B (the acceptance spec), §35, §10C.6; dev plan BR-M1-27.
 *
 * ## The section order is fixed, and that is the feature
 *
 * §35B.2 pins the sections in one order so reports are **diffable across
 * runs**. A report whose sections move is one nobody can compare to last
 * week's, and comparing to last week's is most of what a recurring scan is
 * for.
 *
 * ## What is reported and what is filed
 *
 * The report is the readable face of a session, not its complete contents.
 * Four sections were cut — a per-script JavaScript table, access barriers,
 * the coverage-gap table and the artifact index — because on a real target
 * the first ran to 120 rows of bundle hashes and pushed the findings below
 * three screens of scrolling.
 *
 * None of that data was dropped: it is in `attack-surface.json` and
 * `surface.json` beside this file, which is where a machine was always meant
 * to read it from. What the report keeps is the part §10C.6 makes
 * non-negotiable — a reader must not be able to mistake it for a clean bill
 * of health — so the coverage summary now carries one line naming the number
 * of gaps and barriers recorded, and the §7.3 promise that no barrier was
 * circumvented is kept wherever a barrier exists.
 *
 * ## It never claims complete coverage
 *
 * §10C.6. The header carries a standing caveat and the gaps section is
 * rendered whether or not there are gaps, because a report that quietly
 * omits its limitations reads as a clean bill of health. This tool cannot
 * issue one: coverage is bounded by policy, by authentication, and by budget,
 * and all three are the user's choices rather than facts about the target.
 */
import { UNREDACTED_OUTPUT_WARNING, unredactedOutputWarning } from "@browserrecon/core";
import { COVERAGE_CAVEAT } from "@browserrecon/coverage";

export const PACKAGE_NAME = "@browserrecon/exporter-markdown" as const;

/**
 * §35B.2's fixed order. Exported so a test can assert against it.
 *
 * "Agentic tools" is an addition to the sections the plan names, sitting with
 * the API inventory because that is what it is: a list of operations the page
 * publishes, usually wired straight to the endpoints above it. §21 and §44
 * make it part of the surface, and the first sample report produced for
 * review listed three registered tools in `surface.json` and mentioned none
 * of them here.
 *
 * It is "Agentic tools" rather than "WebMCP tools" because WebMCP is one
 * spelling of the thing and not the thing itself. The page-side registries
 * seen in the wild already differ — `navigator.modelContext`, a polyfill's
 * own global, a framework's wrapper — and a report headed with one vendor's
 * protocol name reads as a report about that protocol. What is being
 * reported is the general fact: this page publishes named, schema'd
 * operations that any visiting agent can call. The event type, the schema
 * field and the collector keep their names, because those are a wire format
 * and renaming them would break every log already written.
 */
export const SECTION_ORDER = [
  "Coverage summary",
  "Workflows",
  "API inventory",
  "Agentic tools",
  "Origins",
  "Security hypotheses",
] as const;

export type SectionName = (typeof SECTION_ORDER)[number];

/**
 * A section's heading, numbered from its position in `SECTION_ORDER`.
 *
 * Hand-written numbers next to an array index is a drift waiting to happen,
 * and it happened: inserting a section at position four renumbered five
 * headings, and the JavaScript section came out labelled `## 9. Artifacts`.
 * The report had two section nines and no section six, which is the kind of
 * thing a reader notices before anything else on the page.
 */
function heading(name: SectionName): string {
  return `## ${SECTION_ORDER.indexOf(name) + 1}. ${name}`;
}

/** Sections rendered only when the tier produced them (§35B.2). */
const TIER_GATED: ReadonlySet<SectionName> = new Set(["Security hypotheses"]);

export interface ReportHeader {
  readonly target: string;
  readonly sessionId: string;
  readonly schemaVersion: string;
  readonly durationSeconds: number;
  readonly rateProfile: string;
  readonly allowedMethods: readonly string[];
  readonly discoverySources: readonly string[];
  readonly authState: string;
  readonly aiMode: string;
}

export interface CoverageGap {
  readonly reason: string;
  readonly count: number;
  /** §10C.7 requires a remedy column — a gap with no action is just a number. */
  readonly remedy: string;
}

export interface WorkflowStep {
  readonly step: number;
  /** An interaction with no request is still a step (§35B.3). */
  readonly kind: "interaction" | "request" | "navigation";
  readonly detail: string;
  /** Rendered with a `↳ parallel` marker rather than as a sequence. */
  readonly parallel?: boolean | undefined;
  /** IDs that must resolve in events.jsonl (§35B.5). */
  readonly causedBy?: readonly string[] | undefined;
}

export interface WorkflowReport {
  readonly id: string;
  readonly name: string;
  readonly confidence: number;
  readonly steps: readonly WorkflowStep[];
}

export interface ReportInput {
  readonly header: ReportHeader;
  readonly coverage: readonly {
    readonly dimension: string;
    readonly observed: number;
    readonly discovered: number;
  }[];
  /**
   * §10C's capped score, with the sentence that explains it.
   *
   * The per-dimension table alone reads as a completeness claim: "Pages 7 of
   * 7 — 100%" is true of what the scan discovered and says nothing about the
   * application, which is the exact confusion §10C.6 exists to prevent. The
   * score is capped below 1 and carries its own caveat, so it goes above the
   * table rather than under it.
   */
  readonly score?: { readonly value: number; readonly description: string } | undefined;
  readonly workflows: readonly WorkflowReport[];
  readonly apis: readonly {
    readonly method: string;
    readonly url: string;
    readonly status?: number | undefined;
    readonly role: string;
    /**
     * Whose host it is.
     *
     * Reported beside the role because the two answer different questions
     * and a reader needs both. An application's own API gateway usually
     * lives one subdomain over from its pages, so `third-party` here means
     * "a different registrable domain", not "not worth your attention" —
     * and a JSON endpoint on a vendor's host is still surface this page
     * depends on.
     */
    readonly party?: "first-party" | "same-site" | "third-party" | undefined;
    /** The response content type, which is why most of these are here. */
    readonly contentType?: string | undefined;
  }[];
  /**
   * Endpoints the bundles named, settled against what was called (§10A.3).
   *
   * Absent when no parser ran, which the section renders differently from an
   * empty list: "the bundles were not read" and "the bundles named nothing"
   * are different facts and only one of them is about the target.
   */
  readonly staticApis?:
    | {
        readonly endpoints: readonly {
          readonly path: string;
          readonly status: "observed" | "correlated" | "unobserved";
          readonly confidence?: "high" | "medium" | "low" | undefined;
          readonly method?: string | undefined;
          readonly staticSources: readonly {
            readonly script: string;
            readonly line: number;
          }[];
        }[];
        readonly scriptsAnalysed: number;
        readonly scriptsSkipped: number;
        /**
         * Scripts the parser could not finish.
         *
         * §10B.9 keeps a partial result rather than discarding it, so the
         * candidates from one are real. Saying how many were partial is what
         * stops "no candidates found" being read as "there are none".
         */
        readonly scriptsPartial?: number | undefined;
      }
    | undefined;
  /**
   * Tools the page registered — §21, §44.
   *
   * `destructive` is a *report* of what the page exposes. §7.2: an exposed
   * destructive operation is something to name, never something to try, and
   * nothing in this tool invokes one.
   */
  readonly webmcpTools: readonly {
    readonly name: string;
    readonly endpoint?: string | undefined;
    readonly description?: string | undefined;
    /** The page whose registry published it — the diagram's middle rank. */
    readonly page?: string | undefined;
    /** What the page says it does, in MCP's own terms. Absent = unstated. */
    readonly effect?: "read_only" | "writes" | "destructive" | undefined;
  }[];
  /**
   * Pages actually read, which decides what an empty tool list means.
   *
   * A registry is published by script and never appears in traffic, so the
   * only evidence that a page publishes no tools is a page that was read and
   * found to publish none. With no page read there is no such evidence — and
   * the section said "this page published no tools to visiting agents" about
   * a scan whose browsing phase had failed outright, over a site publishing
   * five. Absent when the caller does not know, which reads as "not stated"
   * rather than as either answer.
   */
  readonly pagesRead?: number | undefined;
  readonly origins: readonly {
    readonly origin: string;
    readonly requests: number;
    readonly classification: string;
  }[];
  /**
   * Barriers met, counted into the coverage summary's limits line.
   *
   * No longer a table of its own. Still required input: §7.3's promise that
   * a barrier was recorded rather than circumvented has to be printed
   * wherever one exists, and the report cannot print what it is not given.
   */
  readonly barriers: readonly {
    readonly category: string;
    readonly url: string;
    readonly evidence: string;
  }[];
  /** Counted into the limits line, for the same reason (§10C.6, §10C.7). */
  readonly gaps: readonly CoverageGap[];
  /** The session directory, so the warning names the path the reader has. */
  readonly outputDir?: string | undefined;
  /** Only present from V6. Absent means the section is omitted entirely. */
  readonly hypotheses?:
    readonly { readonly claim: string; readonly evidence: string }[] | undefined;
}

/** Below this, a workflow is rendered collapsed but never omitted (§18.1). */
const LOW_CONFIDENCE = 0.5;

function table(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  if (rows.length === 0) return "_None._\n";
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
    "",
  ].join("\n");
}

function renderWorkflow(workflow: WorkflowReport): string {
  const low = workflow.confidence < LOW_CONFIDENCE;
  const rows = workflow.steps.map((step) => [
    // §35B.3: a parallel step is marked rather than shown as the next link
    // in a chain — presenting concurrency as sequence invents a dependency.
    step.parallel === true ? `↳ parallel` : String(step.step),
    step.kind,
    step.detail,
    step.causedBy === undefined ? "—" : step.causedBy.join(", "),
  ]);

  const body = [
    `**${workflow.name}** (\`${workflow.id}\`, confidence ${workflow.confidence.toFixed(2)})`,
    "",
    table(["Step", "Kind", "Detail", "caused_by"], rows),
  ].join("\n");

  // §18.1: a low-confidence workflow is collapsed, never dropped. Dropping
  // it would hide the thing a reader is most likely to want to check.
  return low
    ? `<details><summary>${workflow.name} — low confidence (${workflow.confidence.toFixed(2)})</summary>\n\n${body}\n</details>\n`
    : body;
}

/**
 * What the bundles named, and whether the scan ever called it.
 *
 * §10A.3's line, rendered: a string in a bundle is a candidate, never an
 * endpoint, and the status column is the only thing that promotes one. The
 * `unobserved` rows are the point of the whole static pass — surface the
 * application's own code names and this scan did not reach — so they are
 * listed and the ones already in the table above are counted rather than
 * repeated.
 *
 * `undefined` renders differently from an empty list on purpose. "No parser
 * ran" is a fact about the scan; "the bundles named nothing" is a fact about
 * the target, and conflating them turns a missing capability into a clean
 * result.
 */
function renderStaticApis(staticApis: ReportInput["staticApis"]): string {
  if (staticApis === undefined) {
    return "_No JavaScript was parsed, so no static endpoint candidates were produced._\n";
  }

  const { endpoints, scriptsAnalysed, scriptsSkipped } = staticApis;
  const partial = staticApis.scriptsPartial ?? 0;
  const read =
    `**Found via JS files:** ${scriptsAnalysed} script(s) parsed` +
    (scriptsSkipped === 0 ? "" : `, ${scriptsSkipped} skipped by a bound`) +
    (partial === 0 ? "" : `, ${partial} parsed only in part`) +
    `.`;

  if (endpoints.length === 0) {
    return `${read} No endpoint candidates were found in them.\n`;
  }

  const counted = (status: string): number =>
    endpoints.filter((endpoint) => endpoint.status === status).length;
  const unobserved = endpoints.filter((endpoint) => endpoint.status === "unobserved");

  const summary =
    `${read} ${endpoints.length} endpoint candidate(s): ` +
    `${counted("observed")} the scan called, ${counted("correlated")} correlated with a call, ` +
    `${unobserved.length} never reached.`;

  if (unobserved.length === 0) {
    return `${summary}\n`;
  }

  return [
    summary,
    "",
    "Endpoints named in the JavaScript, which this scan never called:",
    "",
    table(
      ["Candidate", "Method", "Confidence", "Found in"],
      unobserved.map((endpoint) => [
        `\`${endpoint.path}\``,
        endpoint.method ?? "—",
        endpoint.confidence ?? "—",
        endpoint.staticSources
          .slice(0, 2)
          .map(
            (source) => `\`${source.script.split("/").pop() ?? source.script}:${source.line}\``,
          )
          .join(", ") || "—",
      ]),
    ),
    "_A candidate is a string found in code, not an endpoint that exists (§10A.3)._",
  ].join("\n");
}

/**
 * How a tool's declared effect is drawn and described.
 *
 * One table, used by the diagram, the summary line and the detail table, so
 * the three cannot drift apart. The colours are explicit rather than
 * Mermaid's defaults because the default palette is unreadable on a dark
 * background, and a security report that renders as light grey on grey is
 * one nobody reads twice.
 */
const EFFECTS = [
  {
    key: "destructive",
    label: "destructive",
    className: "destructive",
    style: "fill:#f9d6d5,stroke:#b03a2e,stroke-width:2px,color:#1a1a1a",
  },
  {
    key: "writes",
    label: "writes",
    className: "writes",
    style: "fill:#fdebd0,stroke:#b9770e,stroke-width:2px,color:#1a1a1a",
  },
  {
    key: "read_only",
    label: "read-only",
    className: "readonly",
    style: "fill:#d4efdf,stroke:#1e8449,stroke-width:2px,color:#1a1a1a",
  },
  {
    key: "unstated",
    label: "unstated",
    className: "unstated",
    style: "fill:#eaecee,stroke:#707b7c,stroke-width:2px,color:#1a1a1a",
  },
] as const;

type EffectKey = (typeof EFFECTS)[number]["key"];

function effectKey(effect: ReportInput["webmcpTools"][number]["effect"]): EffectKey {
  return effect === undefined ? "unstated" : effect;
}

/** Mermaid labels are quoted, so a quote in a tool name has to go. */
function mermaidLabel(text: string): string {
  return text
    .replace(/["\\]/g, "'")
    .replace(/[\r\n]+/g, " ")
    .trim();
}

/** The path a reader recognises, falling back to the whole URL. */
function pageLabel(page: string): string {
  try {
    const url = new URL(page);
    return url.pathname === "" ? "/" : url.pathname;
  } catch {
    return page;
  }
}

/**
 * The registry as a picture: target → page → tool.
 *
 * A flat table answers "what is published"; it does not answer "what does an
 * agent have to be looking at to call this", which is the question that
 * decides whether a destructive tool is one navigation away or behind a
 * checkout flow. A registry is per page, so the page is the middle rank —
 * and when an application publishes one set of tools on its home page and
 * another in its account area, the shape of that is visible at a glance and
 * invisible in a list of names.
 *
 * Mermaid rather than an image: it is text, so it diffs across runs like
 * every other section, and GitHub, GitLab and most Markdown viewers render
 * it without a build step.
 */
function renderToolDiagram(target: string, tools: ReportInput["webmcpTools"]): string {
  const byPage = new Map<string, ReportInput["webmcpTools"][number][]>();
  for (const tool of tools) {
    const page = tool.page ?? target;
    byPage.set(page, [...(byPage.get(page) ?? []), tool]);
  }

  const lines = ["```mermaid", "graph LR", `  root["${mermaidLabel(target)}"]`];
  const used = new Set<EffectKey>();
  let pageIndex = 0;
  let toolIndex = 0;

  for (const [page, published] of [...byPage.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const pageId = `p${pageIndex}`;
    pageIndex += 1;
    lines.push(`  ${pageId}["${mermaidLabel(pageLabel(page))} (${published.length})"]`);
    lines.push(`  root --> ${pageId}`);

    for (const tool of published) {
      const id = `t${toolIndex}`;
      toolIndex += 1;
      const key = effectKey(tool.effect);
      used.add(key);
      lines.push(`  ${id}["${mermaidLabel(tool.name)}"]`);
      lines.push(`  ${pageId} --> ${id}`);
      lines.push(
        `  class ${id} ${EFFECTS.find((e) => e.key === key)?.className ?? "unstated"}`,
      );
    }
  }

  // Only the classes in use. An unused classDef is harmless but it makes the
  // legend below disagree with the picture above it.
  for (const effect of EFFECTS) {
    if (!used.has(effect.key)) continue;
    lines.push(`  classDef ${effect.className} ${effect.style}`);
  }
  lines.push("```");
  return lines.join("\n");
}

export function renderReport(input: ReportInput): string {
  const { header } = input;
  const out: string[] = [];

  out.push(`# BrowserRecon report — ${header.target}`, "");
  out.push(
    table(
      ["Field", "Value"],
      [
        ["Session", header.sessionId],
        ["Schema version", header.schemaVersion],
        ["Duration", `${header.durationSeconds}s`],
        ["Rate profile", header.rateProfile],
        ["Allowed methods", header.allowedMethods.join(", ")],
        ["Discovery sources", header.discoverySources.join(", ")],
        ["Auth state", header.authState],
        ["AI mode", header.aiMode],
      ],
    ),
  );
  // §10C.6, in the header rather than a footnote: a caveat nobody scrolls to
  // is a caveat nobody reads.
  //
  // The sentence itself is the coverage package's. This used to be a
  // paraphrase of it, which made four wordings of one promise across the
  // repository — and a reader comparing two of them has to work out whether
  // they mean different things.
  out.push(`> ${COVERAGE_CAVEAT}`, "");

  out.push(heading("Coverage summary"), "");
  if (input.score !== undefined) {
    out.push(
      `**Coverage score ${input.score.value.toFixed(2)}** — ${input.score.description}`,
      "",
    );
  }
  out.push(
    table(
      ["Dimension", "Observed", "Discovered", "Ratio"],
      input.coverage.map((row) => [
        row.dimension,
        String(row.observed),
        String(row.discovered),
        row.discovered === 0 ? "—" : `${Math.round((row.observed / row.discovered) * 100)}%`,
      ]),
    ),
  );

  out.push("_Ratio is of what this scan discovered, never of what the application has._", "");

  // §10C.6, kept after the gap table was cut. A report that stops mentioning
  // its own limits reads as a clean bill of health, and that is the one
  // reading this tool must never permit. One line, naming the counts and the
  // file that holds the detail, rather than a table nobody read.
  const limits: string[] = [];
  if (input.gaps.length > 0) {
    const total = input.gaps.reduce((sum, gap) => sum + gap.count, 0);
    limits.push(
      `${total} coverage gap(s) across ${input.gaps.length} reason(s) — ` +
        `${input.gaps.map((gap) => `\`${gap.reason}\``).join(", ")}`,
    );
  }
  if (input.barriers.length > 0) {
    // §7.3: a reader has to be able to tell the barriers were recorded
    // rather than defeated. Said wherever a barrier exists.
    limits.push(`${input.barriers.length} access barrier(s) recorded and not circumvented`);
  }
  if (limits.length > 0) {
    out.push(
      `**Limits on this scan:** ${limits.join("; ")}. Detail in \`attack-surface.json\`.`,
      "",
    );
  }

  out.push(heading("Workflows"), "");
  out.push(
    input.workflows.length === 0
      ? "_No workflows were detected._\n"
      : input.workflows.map(renderWorkflow).join("\n"),
  );

  out.push(heading("API inventory"), "");
  out.push(
    table(
      ["Method", "URL", "Status", "Content type", "Party", "Role"],
      input.apis.map((api) => [
        api.method,
        `\`${api.url}\``,
        // Every endpoint built from a response carries a status, so an
        // absent one means exactly one thing: the application called this
        // and the scan ended before the answer arrived. "—" read as "not
        // recorded", which is a different and less useful fact.
        api.status === undefined ? "no response" : String(api.status),
        api.contentType ?? "—",
        api.party ?? "—",
        api.role,
      ]),
    ),
  );
  out.push(renderStaticApis(input.staticApis), "");

  out.push(heading("Agentic tools"), "");
  if (input.webmcpTools.length === 0) {
    out.push(
      input.pagesRead === 0
        ? "_No page was read, so whether this site publishes tools to visiting agents is unknown._\n"
        : "_This page published no tools to visiting agents._\n",
    );
  } else {
    // The picture first. What a reader needs from this section is "how much
    // can an agent do here, and from where" — which is a shape, and a shape
    // read off a thirty-row table is a shape read slowly.
    const counts = EFFECTS.map((effect) => ({
      ...effect,
      n: input.webmcpTools.filter((tool) => effectKey(tool.effect) === effect.key).length,
    })).filter((effect) => effect.n > 0);

    out.push(
      `**${input.webmcpTools.length} tool(s)** — ` +
        counts.map((effect) => `${effect.label} ${effect.n}`).join(" · "),
      "",
    );
    out.push(renderToolDiagram(header.target, input.webmcpTools), "");

    out.push(
      table(
        ["Tool", "Effect", "Page", "Endpoint", "Description"],
        input.webmcpTools.map((tool) => [
          `\`${tool.name}\``,
          // The page's own claim, in its own terms. "unstated" is the honest
          // rendering of silence — not "read-only".
          tool.effect === "destructive"
            ? "**destructive**"
            : tool.effect === "writes"
              ? "writes"
              : tool.effect === "read_only"
                ? "read-only"
                : "unstated",
          tool.page === undefined ? "—" : `\`${pageLabel(tool.page)}\``,
          tool.endpoint === undefined ? "—" : `\`${tool.endpoint}\``,
          tool.description ?? "—",
        ]),
      ),
    );

    // §7.2, and the reason this section exists at all. A page publishing a
    // state-changing operation to any agent that visits is the finding; the
    // catalogue of read-only ones around it is context.
    const destructive = input.webmcpTools.filter((tool) => tool.effect === "destructive");
    const writes = input.webmcpTools.filter((tool) => tool.effect === "writes");
    if (destructive.length > 0) {
      out.push(
        `**${destructive.length} tool(s) the page declares destructive**: ` +
          destructive.map((tool) => `\`${tool.name}\``).join(", ") +
          ". Any agent that visits this page can call them.",
        "",
      );
    }
    if (writes.length > 0) {
      // Listed separately and more quietly. MCP's `readOnlyHint: false` means
      // "may modify its environment", which covers a navigation helper as
      // well as a write — reporting both as destructive is the false alarm
      // that teaches a reader to discount the real ones.
      out.push(
        `${writes.length} tool(s) are declared as modifying state, without a ` +
          `destructive hint: ` +
          writes.map((tool) => `\`${tool.name}\``).join(", ") +
          ".",
        "",
      );
    }
    out.push("_Tools are reported, never invoked (§7.2)._", "");
  }

  out.push(heading("Origins"), "");
  out.push(
    table(
      ["Origin", "Requests", "Classification"],
      input.origins.map((o) => [`\`${o.origin}\``, String(o.requests), o.classification]),
    ),
  );

  // The per-script table, the barrier table, the gap table and the artifact
  // index used to sit here. They are written to `attack-surface.json` and
  // `surface.json` instead: on a real target the script table alone ran to
  // 120 rows of cache-busted bundle names, which is reference data for a
  // machine and three screens of scrolling for a reader. What those sections
  // carried that a reader still needs is in the coverage summary's limits
  // line, above.

  // Not a section, and it stays whatever else is cut: the directory beside
  // this file holds unredacted cookies, tokens and request bodies, and
  // nothing else in the report says so.
  out.push(
    `> ${
      input.outputDir === undefined
        ? UNREDACTED_OUTPUT_WARNING
        : unredactedOutputWarning(input.outputDir)
    }`,
    "",
  );

  // §35B.2: omitted entirely at Tier 0/1 rather than rendered empty. An
  // empty "Security hypotheses" heading reads as "we looked and found
  // nothing", which is a stronger claim than "we did not look".
  if (input.hypotheses !== undefined) {
    out.push(heading("Security hypotheses"), "");
    out.push(
      table(
        ["Claim", "Evidence"],
        input.hypotheses.map((h) => [h.claim, h.evidence]),
      ),
    );
    out.push("_Hypotheses require downstream validation and are never findings (§20.3)._", "");
  }

  return `${out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd()}\n`;
}

/** Whether a section is rendered only when its tier produced data. */
export function isTierGated(section: SectionName): boolean {
  return TIER_GATED.has(section);
}
