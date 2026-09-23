/**
 * The end-of-scan terminal summary — build plan §35A.1, §35A.2;
 * dev plan BR-M1-27b.
 *
 * For most first-time users this printout **is** the product. They will run
 * one scan, read what the terminal says, and decide from that whether the
 * tool is worth another run. A scan that ends with "wrote 4 files" has
 * answered no question they had.
 *
 * ## It states its own limitations
 *
 * §10C.6: never claim complete coverage. The summary names the discovery
 * sources and AI mode that were active — so Tier 0 versus Tier 2 is
 * self-evident without a concept anyone has to learn — and shows the top gap
 * reasons, so what the scan could *not* do is visible without opening a file.
 * A next-step line says what would improve the result, because "install a
 * crawler" is more useful than a number the user cannot move.
 *
 * ## Eighty columns
 *
 * Not nostalgia: a terminal in a split pane, an SSH session, a CI log viewer.
 * Wrapping destroys an aligned table, and an unreadable summary is the same
 * as no summary.
 */

import { COVERAGE_CAVEAT } from "@browserrecon/coverage";

export const TERMINAL_WIDTH = 80;

export interface ScanSummary {
  readonly target: string;
  readonly sessionId: string;
  readonly durationSeconds: number;
  readonly completeness: "complete" | "partial";
  readonly stopReason?: string | undefined;

  readonly pagesVisited: number;
  readonly candidatesDiscovered: number;
  readonly templatesSaturated: number;
  readonly instancesSkipped: number;

  readonly workflows: number;
  readonly apisObserved: number;
  readonly apisUnobserved: number;
  readonly origins: number;
  readonly jsAssets: number;
  readonly barriers: readonly { readonly category: string; readonly count: number }[];

  /** §10C.7's reasons, most common first. */
  readonly topGaps: readonly { readonly reason: string; readonly count: number }[];

  readonly discoverySources: readonly string[];
  readonly aiMode: string;
  readonly rateProfile: string;
  readonly artifacts: readonly string[];
  /** Directory holding unredacted data, warned about explicitly. */
  readonly outputDir: string;
}

function rule(char = "─"): string {
  return char.repeat(TERMINAL_WIDTH);
}

/** Pad, but never past the width — truncation beats wrapping in a table. */
function cell(text: string, width: number): string {
  return text.length > width ? `${text.slice(0, width - 1)}…` : text.padEnd(width);
}

/**
 * Shorten a path from the left, keeping the filename.
 *
 * `…/sess_0001/report.md` still tells you which file. `.output/nested/nes…`
 * tells you nothing, which is the wrong half to keep.
 */
function elidePath(path: string, width: number): string {
  return path.length <= width ? path : `…${path.slice(path.length - (width - 1))}`;
}

/**
 * Wrap prose to the width by hand.
 *
 * Only prose is wrapped; tables are truncated instead, because a wrapped
 * table column stops being a column.
 */
function wrap(text: string, indent: number): string[] {
  const width = TERMINAL_WIDTH - indent;
  const lines: string[] = [];
  let current = "";
  for (const word of text.split(" ")) {
    if (current === "") current = word;
    else if (`${current} ${word}`.length <= width) current = `${current} ${word}`;
    else {
      lines.push(current);
      current = word;
    }
  }
  if (current !== "") lines.push(current);
  return lines.map((entry) => `${" ".repeat(indent)}${entry}`);
}

function line(label: string, value: string): string {
  return `  ${cell(label, 26)}${cell(value, TERMINAL_WIDTH - 30)}`.trimEnd();
}

/**
 * What would most improve the next run.
 *
 * Ordered by how much it changes the result rather than by how easy it is.
 * Only one is shown: a list of four suggestions is a list nobody acts on.
 */
interface NextStep {
  readonly text: string;
  /**
   * Printed on its own line, never wrapped.
   *
   * A command broken across two lines cannot be copy-pasted, which is the
   * only thing a suggested command is for.
   */
  readonly command?: string | undefined;
}

function nextStep(summary: ScanSummary): NextStep | undefined {
  // A scan that was cut short comes first. Every other suggestion is about
  // seeing more of the target; this one is about seeing the rest of what the
  // tool had already found and had to abandon.
  if (summary.completeness === "partial") {
    return {
      text: `Stopped early (${summary.stopReason ?? "limit reached"}). Pick up where it left off:`,
      command: `browserrecon resume ${summary.sessionId}`,
    };
  }
  // Read the gaps before suggesting anything about discovery. A scan that
  // saw one page because everything is behind a login is not short of URLs,
  // and telling its user to install a crawler wastes the one suggestion we
  // get. This ordering exists because the empty-scan baseline showed the
  // wrong advice in exactly that case.
  const dominantGap = summary.topGaps[0];
  if (dominantGap !== undefined && dominantGap.reason === "auth_required") {
    return {
      text:
        `${dominantGap.count} ${dominantGap.count === 1 ? "target" : "targets"} needed ` +
        `authentication. Sign in first to see past ${dominantGap.count === 1 ? "it" : "them"}:`,
      command: "browserrecon auth validate <profile>",
    };
  }
  if (!summary.discoverySources.includes("katana") && summary.candidatesDiscovered < 50) {
    return {
      text: "Install a crawler for broader URL discovery, or pipe your own list in with --import-urls.",
    };
  }
  if (summary.apisUnobserved > 0) {
    return {
      text: `${summary.apisUnobserved} discovered endpoints were never reached — see the coverage gaps in report.md.`,
    };
  }
  if (summary.aiMode === "off" && summary.workflows > 0) {
    return {
      text: "Run with --ai to name workflows and explain the API sequences behind them.",
    };
  }
  return undefined;
}

export function renderSummary(summary: ScanSummary): string {
  const out: string[] = [];

  out.push("", rule("━"));
  out.push(`  BrowserRecon — ${cell(summary.target, TERMINAL_WIDTH - 20).trimEnd()}`);
  out.push(rule("━"));

  out.push("");
  out.push(
    line(
      "Scan",
      `${summary.completeness}${summary.stopReason === undefined ? "" : ` (${summary.stopReason})`}` +
        ` · ${summary.durationSeconds}s · ${summary.rateProfile}`,
    ),
  );
  // Tier is self-evident from this line rather than a concept to learn.
  out.push(line("Discovery", summary.discoverySources.join(", ") || "browser-native only"));
  out.push(line("AI", summary.aiMode));

  out.push("", "  Observed");
  out.push(
    line(
      "  Pages visited",
      `${summary.pagesVisited} of ${summary.candidatesDiscovered} discovered`,
    ),
  );
  if (summary.templatesSaturated > 0) {
    // §45's no-silent-loss rule, in the place a user actually looks.
    out.push(
      line(
        "  Templates saturated",
        `${summary.templatesSaturated} (${summary.instancesSkipped} instances skipped as equivalent)`,
      ),
    );
  }
  out.push(line("  Workflows", String(summary.workflows)));
  out.push(
    line(
      "  APIs",
      `${summary.apisObserved} observed, ${summary.apisUnobserved} discovered but not reached`,
    ),
  );
  out.push(line("  Origins", String(summary.origins)));
  out.push(line("  JS assets", String(summary.jsAssets)));

  if (summary.barriers.length > 0) {
    out.push("", "  Barriers");
    for (const barrier of summary.barriers) {
      out.push(line(`  ${barrier.category}`, String(barrier.count)));
    }
    out.push("  None was bypassed.");
  }

  if (summary.topGaps.length > 0) {
    out.push("", "  Why coverage stopped where it did");
    for (const gap of summary.topGaps.slice(0, 5)) {
      out.push(line(`  ${gap.reason}`, String(gap.count)));
    }
  }

  out.push("", "  Artifacts");
  for (const artifact of summary.artifacts) {
    out.push(`    ${elidePath(artifact, TERMINAL_WIDTH - 4)}`);
  }
  out.push("");
  out.push(`  ${elidePath(summary.outputDir, 40)} holds UNREDACTED captured data.`);
  out.push("  Do not commit it, attach it to a ticket, or sync it to cloud storage.");

  const next = nextStep(summary);
  if (next !== undefined) {
    out.push("", ...wrap(`Next: ${next.text}`, 2));
    if (next.command !== undefined) out.push("", `      ${next.command}`);
  }

  // §10C.6, last so it is the final thing read — and the coverage package's
  // own sentence, not a fifth paraphrase of it. A user who reads the terminal
  // and then opens report.md should meet one promise, worded once; five
  // wordings across the repository made "do these mean different things?" a
  // question a reader had to answer for themselves.
  out.push("");
  out.push(...wrap(COVERAGE_CAVEAT, 2));
  out.push(rule(), "");

  return out.join("\n");
}

/** The machine-readable form, for `--json`. */
export function summaryAsJson(summary: ScanSummary): string {
  return JSON.stringify(summary, null, 2);
}

export type SummaryMode = "human" | "json" | "quiet";

/**
 * Which form to print.
 *
 * `--quiet` wins over `--json`, because a pipeline that asked for silence
 * and got two kilobytes of JSON on stdout is a broken pipeline — where the
 * reverse is merely a missing convenience.
 */
export function resolveSummaryMode(flags: {
  readonly quiet?: boolean | undefined;
  readonly json?: boolean | undefined;
}): SummaryMode {
  if (flags.quiet === true) return "quiet";
  if (flags.json === true) return "json";
  return "human";
}

/**
 * Render for the chosen mode, or nothing at all.
 *
 * Returns `undefined` rather than an empty string so a caller cannot print a
 * blank line under `--quiet` by accident.
 */
export function formatSummary(summary: ScanSummary, mode: SummaryMode): string | undefined {
  if (mode === "quiet") return undefined;
  return mode === "json" ? summaryAsJson(summary) : renderSummary(summary);
}
