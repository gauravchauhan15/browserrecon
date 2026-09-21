/**
 * Parsing Katana's JSONL — build plan §9.4; dev plan BR-M1-15.
 *
 * A malformed line is not a reason to lose the run. Katana streams while it
 * crawls, and a crash mid-line leaves a truncated last record — discarding
 * everything because of it would throw away a completed crawl over one byte.
 * So bad lines are counted and skipped, and the count is reported so nobody
 * mistakes a partial parse for a small site.
 */

export interface KatanaResult {
  readonly url: string;
  readonly method?: string | undefined;
  /** Katana's own tag: `href`, `script`, `form`, `xhr`, … */
  readonly discoveryType?: string | undefined;
  /** The page it was found on. */
  readonly source?: string | undefined;
  readonly statusCode?: number | undefined;
}

export interface ParseOutcome {
  readonly results: readonly KatanaResult[];
  /** Lines that were not usable. Non-zero means the import is incomplete. */
  readonly malformed: number;
}

interface RawKatana {
  readonly request?: {
    readonly endpoint?: string;
    readonly method?: string;
    readonly source?: string;
    readonly tag?: string;
  };
  readonly response?: { readonly status_code?: number };
  readonly timestamp?: string;
}

/** Parse a JSONL stream. Never throws — a bad crawl is still a result. */
export function parseKatanaJsonl(text: string): ParseOutcome {
  const results: KatanaResult[] = [];
  let malformed = 0;

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      malformed += 1;
      continue;
    }

    // `JSON.parse` succeeds for `null`, `[]` and bare numbers, and the first
    // of those made the optional chain below throw — which broke the "never
    // throws" promise this file is written around. Valid JSON is not the
    // same as a record.
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      malformed += 1;
      continue;
    }
    const raw = parsed as RawKatana;

    const endpoint = raw.request?.endpoint;
    if (typeof endpoint !== "string" || endpoint === "") {
      // Parsed as JSON but carries no URL — a summary line, or a shape from
      // a Katana version we do not know. Counted, not guessed at.
      malformed += 1;
      continue;
    }

    results.push({
      url: endpoint,
      ...(raw.request?.method === undefined ? {} : { method: raw.request.method }),
      ...(raw.request?.tag === undefined ? {} : { discoveryType: raw.request.tag }),
      ...(raw.request?.source === undefined ? {} : { source: raw.request.source }),
      ...(raw.response?.status_code === undefined
        ? {}
        : { statusCode: raw.response.status_code }),
    });
  }

  return { results, malformed };
}
