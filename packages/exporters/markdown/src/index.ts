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
import { UNREDACTED_OUTPUT_WARNING } from "@browserrecon/core";

export const PACKAGE_NAME = "@browserrecon/exporter-markdown" as const;

/** §35B.2's fixed order. Exported so a test can assert against it. */
export const SECTION_ORDER = [
  "Coverage summary",
  "Workflows",
  "API inventory",
  "Origins",
  "JavaScript",
  "Access barriers",
  "Coverage gaps",
  "Artifacts",
  "Security hypotheses",
] as const;

export type SectionName = (typeof SECTION_ORDER)[number];

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
  readonly workflows: readonly WorkflowReport[];
  readonly apis: readonly {
    readonly method: string;
    readonly url: string;
    readonly status?: number | undefined;
    readonly role: string;
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
  out.push(
    "> Coverage below is scoped by the Target Policy, the authentication state and",
    "> the scan budget. It describes what was reachable and observed — not",
    "> everything that exists.",
    "",
  );

  out.push(`## 1. ${SECTION_ORDER[0]}`, "");
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

  out.push(`## 2. ${SECTION_ORDER[1]}`, "");
  out.push(
    input.workflows.length === 0
      ? "_No workflows were detected._\n"
      : input.workflows.map(renderWorkflow).join("\n"),
  );

  out.push(`## 3. ${SECTION_ORDER[2]}`, "");
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

  out.push(`## 4. ${SECTION_ORDER[3]}`, "");
  out.push(
    table(
      ["Origin", "Requests", "Classification"],
      input.origins.map((o) => [`\`${o.origin}\``, String(o.requests), o.classification]),
    ),
  );

  out.push(`## 5. ${SECTION_ORDER[4]}`, "");
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

  out.push(`## 6. ${SECTION_ORDER[5]}`, "");
  out.push(
    table(
      ["Category", "URL", "Evidence"],
      input.barriers.map((b) => [b.category, `\`${b.url}\``, b.evidence]),
    ),
  );
  // §35B.2 asks for this explicitly, and §7.3 is why: a reader has to be
  // able to tell that the barriers were recorded rather than defeated.
  out.push("_No barrier was bypassed. Barriers are recorded, never circumvented._", "");

  out.push(`## 7. ${SECTION_ORDER[6]}`, "");
  out.push(
    table(
      ["Reason", "Count", "Remedy"],
      input.gaps.map((gap) => [gap.reason, String(gap.count), gap.remedy]),
    ),
  );

  out.push(`## 8. ${SECTION_ORDER[7]}`, "");
  out.push(
    table(
      ["File", "Contents", "Records"],
      input.artifacts.map((a) => [`\`${a.path}\``, a.contents, String(a.records ?? "—")]),
    ),
  );
  out.push(`> ${UNREDACTED_OUTPUT_WARNING}`, "");

  // §35B.2: omitted entirely at Tier 0/1 rather than rendered empty. An
  // empty "Security hypotheses" heading reads as "we looked and found
  // nothing", which is a stronger claim than "we did not look".
  if (input.hypotheses !== undefined) {
    out.push(`## 9. ${SECTION_ORDER[8]}`, "");
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
