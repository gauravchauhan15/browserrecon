/**
 * Importing URLs from anywhere — build plan §10D.1 level 1; dev plan BR-M1-15b.
 *
 * `katana ... | browserrecon scan <url> --import-urls -`, or a text file, or
 * a JSONL file from a crawler nobody here has heard of. This is what makes
 * Katana substitutable without writing code, which §10D.1 requires and which
 * the licensing posture depends on — a tool that *needs* Katana has a
 * dependency, one that *accepts* its output does not.
 *
 * ## An imported list can never widen scope
 *
 * The safety property. A file is untrusted input: it may contain a URL on
 * another origin, a `file://` path, or a link to somewhere the user never
 * authorized. Imports are therefore filtered through the Target Policy
 * exactly like anything else, and the filter runs *after* parsing rather than
 * being left to the caller. A caller that forgot would hand the Explorer a
 * list that quietly escapes the boundary the user agreed to.
 */

export interface ImportOutcome {
  /** URLs that parsed and passed policy. */
  readonly accepted: readonly string[];
  /** URLs that parsed but the policy refused, with the reason. */
  readonly refused: readonly { readonly url: string; readonly reason: string }[];
  /** Lines that were not a URL at all. */
  readonly malformed: number;
  readonly totalLines: number;
}

export interface ImportOptions {
  /** Returns a refusal reason, or undefined to accept. Never optional. */
  readonly refuse: (url: string) => string | undefined;
}

/** Whether a line is deliberately not a URL — blank, or a comment. */
function isSkippable(line: string): boolean {
  const trimmed = line.trim();
  return trimmed === "" || trimmed.startsWith("#");
}

/** Pull a URL out of a line of text, JSONL, or a CSV-ish first column. */
function urlFromLine(line: string): string | undefined {
  const trimmed = line.trim();

  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      // The field names crawlers actually use, in order of how common they
      // are. Katana nests its own under `request.endpoint`.
      const request = parsed.request as Record<string, unknown> | undefined;
      for (const value of [parsed.url, parsed.endpoint, parsed.loc, request?.endpoint]) {
        if (typeof value === "string" && value !== "") return value;
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  // A plain line, or the first field of a comma/tab separated one.
  const first = trimmed.split(/[,\t]/)[0]?.trim() ?? "";
  return first === "" ? undefined : first;
}

/**
 * Parse and filter an imported list.
 *
 * The policy check is not optional and not the caller's job — see the note
 * above.
 */
export function importUrls(text: string, options: ImportOptions): ImportOutcome {
  const accepted: string[] = [];
  const refused: { url: string; reason: string }[] = [];
  const seen = new Set<string>();
  let malformed = 0;
  let totalLines = 0;

  for (const line of text.split("\n")) {
    // A comment or a blank is not damage. Counting it as malformed made a
    // file with a header comment report as partially unreadable, which
    // would send a user hunting for a problem that is not there.
    if (isSkippable(line)) continue;
    totalLines += 1;

    const candidate = urlFromLine(line);
    if (candidate === undefined) {
      malformed += 1;
      continue;
    }

    let parsed: URL;
    try {
      parsed = new URL(candidate);
    } catch {
      malformed += 1;
      continue;
    }

    // Before the policy even looks: a scheme the browser should not be
    // pointed at is not a scope question, it is not a page.
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      refused.push({ url: candidate, reason: `scheme ${parsed.protocol} is not http(s)` });
      continue;
    }

    if (seen.has(parsed.href)) continue;
    seen.add(parsed.href);

    const reason = options.refuse(parsed.href);
    if (reason !== undefined) {
      refused.push({ url: parsed.href, reason });
      continue;
    }
    accepted.push(parsed.href);
  }

  // Sorted, so a scan seeded from a file visits in the same order however
  // the file was written (§5A.5).
  return { accepted: accepted.sort(), refused, malformed, totalLines };
}
