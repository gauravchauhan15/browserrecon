/**
 * @browserrecon/exporter-markdown — `report.md`.
 *
 * Build plan §35B (the acceptance spec), §35, §10C.6; dev plan BR-M1-27.
 *
 * ## The section order is fixed, and that is the feature
 *
 * §35B.2 pins nine sections in one order so reports are **diffable across
 * runs**. A report whose sections move is one nobody can compare to last
 * week's, and comparing to last week's is most of what a recurring scan is
 * for.
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
 * "WebMCP tools" is an addition to the nine the plan names, sitting with the
 * API inventory because that is what it is: a list of operations the page
 * publishes, usually wired straight to the endpoints above it. §21 and §44
 * make it part of the surface, and the first sample report produced for
 * review listed three registered tools in `surface.json` and mentioned none
 * of them here. Added now rather than later because the cost of renumbering
 * is a pre-release report nobody has archived.
 */
export const SECTION_ORDER = [
  "Coverage summary",
  "Workflows",
  "API inventory",
  "WebMCP tools",
  "Origins",
  "JavaScript",
  "Access barriers",
  "Coverage gaps",
  "Artifacts",
  "Security hypotheses",
] as const;

export type SectionName = (typeof SECTION_ORDER)[number];

/**
 * A section's heading, numbered from its position in `SECTION_ORDER`.
 *
 * Hand-written numbers next to an array index is a drift waiting to happen,
 * and it happened: inserting "WebMCP tools" at position four renumbered five
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
  }[];
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
  }[];
  readonly origins: readonly {
    readonly origin: string;
    readonly requests: number;
    readonly classification: string;
  }[];
  readonly javascript: readonly {
    readonly url: string;
    readonly bytes?: number | undefined;
    readonly firstParty: boolean;
    readonly analysis: string;
  }[];
  readonly barriers: readonly {
    readonly category: string;
    readonly url: string;
    readonly evidence: string;
  }[];
  readonly gaps: readonly CoverageGap[];
  readonly artifacts: readonly {
    readonly path: string;
    readonly contents: string;
    readonly records?: number | undefined;
  }[];
  /** The session directory, so the warning names the path the reader has. */
  readonly outputDir?: string | undefined;
  /** Only present from V6. Absent means the section is omitted entirely. */
  readonly hypotheses?:
    readonly { readonly claim: string; readonly evidence: string }[] | undefined;
}

/** Below this, a workflow is rendered collapsed but never omitted (§18.1). */
const LOW_CONFIDENCE = 0.5;

/**
 * Bytes as something a reader can compare at a glance.
 *
 * `48213` and `481230` look alike in a column; `47 KB` and `470 KB` do not,
 * and "which script is the big one" is most of why the column is there.
 */
function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

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

  out.push(heading("Workflows"), "");
  out.push(
    input.workflows.length === 0
      ? "_No workflows were detected._\n"
      : input.workflows.map(renderWorkflow).join("\n"),
  );

  out.push(heading("API inventory"), "");
  out.push(
    table(
      ["Method", "URL", "Status", "Role"],
      input.apis.map((api) => [
        api.method,
        `\`${api.url}\``,
        String(api.status ?? "—"),
        api.role,
      ]),
    ),
  );

  out.push(heading("WebMCP tools"), "");
  out.push(
    table(
      ["Tool", "Endpoint", "Description"],
      input.webmcpTools.map((tool) => [
        `\`${tool.name}\``,
        tool.endpoint === undefined ? "—" : `\`${tool.endpoint}\``,
        tool.description ?? "—",
      ]),
    ),
  );
  if (input.webmcpTools.length > 0) {
    out.push("_Tools are reported, never invoked (§7.2)._", "");
  }

  out.push(heading("Origins"), "");
  out.push(
    table(
      ["Origin", "Requests", "Classification"],
      input.origins.map((o) => [`\`${o.origin}\``, String(o.requests), o.classification]),
    ),
  );

  out.push(heading("JavaScript"), "");
  out.push(
    table(
      ["Script", "Size", "Party", "Analysis"],
      input.javascript.map((js) => [
        `\`${js.url === "" ? "(inline)" : js.url}\``,
        js.bytes === undefined ? "—" : humanBytes(js.bytes),
        js.firstParty ? "first" : "third",
        js.analysis,
      ]),
    ),
  );

  out.push(heading("Access barriers"), "");
  out.push(
    table(
      ["Category", "URL", "Evidence"],
      input.barriers.map((b) => [b.category, `\`${b.url}\``, b.evidence]),
    ),
  );
  // §35B.2 asks for this explicitly, and §7.3 is why: a reader has to be
  // able to tell that the barriers were recorded rather than defeated.
  out.push("_No barrier was bypassed. Barriers are recorded, never circumvented._", "");

  out.push(heading("Coverage gaps"), "");
  out.push(
    table(
      ["Reason", "Count", "Remedy"],
      input.gaps.map((gap) => [gap.reason, String(gap.count), gap.remedy]),
    ),
  );

  out.push(heading("Artifacts"), "");
  out.push(
    table(
      ["File", "Contents", "Records"],
      input.artifacts.map((a) => [`\`${a.path}\``, a.contents, String(a.records ?? "—")]),
    ),
  );
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
