/**
 * Source maps — build plan §10A.6; dev plan BR-M2-17.
 *
 * A minified bundle says `t.a("/api/orders")` at line 1, column 48213. A
 * source map says that is `src/orders/orderService.ts` line 92. The second is
 * something a reader can act on; the first is a coordinate.
 *
 * Two things improve with it: initiator chains name a module instead of a
 * bundle, and a candidate's provenance becomes a file someone can open.
 *
 * ## Fetching one is the caller's job
 *
 * §10A.6 says "when an accessible source map exists **and is inside target
 * policy**". This module parses and looks up; it never fetches. A source map
 * URL comes out of a file the target controls — `//# sourceMappingURL=` can
 * name any URL at all — so fetching it unchecked is the same mistake as the
 * nested-sitemap one, and it belongs where the policy engine lives.
 *
 * ## `sourcesContent` is not read
 *
 * A source map often embeds the original source. That is the application's
 * private code, frequently including comments and sometimes secrets, and
 * BrowserRecon has no reason to hold it: the mapping gives a file and a line,
 * which is all a report needs. Not reading it is cheaper than redacting it.
 */

/** A decoded mapping: one position in the bundle, and where it came from. */
export interface Mapping {
  /** 0-based, as the source map format counts. */
  readonly generatedLine: number;
  readonly generatedColumn: number;
  readonly source?: string | undefined;
  readonly originalLine?: number | undefined;
  readonly originalColumn?: number | undefined;
  readonly name?: string | undefined;
}

export interface SourceMap {
  readonly version: number;
  readonly file?: string | undefined;
  readonly sourceRoot?: string | undefined;
  readonly sources: readonly string[];
  readonly names: readonly string[];
  readonly mappings: readonly Mapping[];
}

export interface OriginalPosition {
  readonly source: string;
  /** 1-based, as an editor counts — unlike the format's own 0-based lines. */
  readonly line: number;
  readonly column: number;
  readonly name?: string | undefined;
}

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/**
 * Decode one VLQ-encoded number.
 *
 * Base64 variable-length quantity, continuation bit high, sign in the low
 * bit. Returns the value and how many characters it consumed, because the
 * caller is walking a string of them.
 */
function decodeVlq(segment: string, start: number): { value: number; length: number } {
  let result = 0;
  let shift = 0;
  let index = start;

  for (;;) {
    if (index >= segment.length) throw new Error("truncated VLQ segment");
    const digit = BASE64.indexOf(segment[index] as string);
    if (digit === -1) throw new Error(`"${segment[index] ?? ""}" is not valid VLQ`);
    index += 1;

    const continues = (digit & 32) !== 0;
    result += (digit & 31) << shift;
    shift += 5;
    if (!continues) break;
  }

  const negative = (result & 1) === 1;
  const value = result >>> 1;
  return { value: negative ? -value : value, length: index - start };
}

/**
 * Parse a source map.
 *
 * Returns undefined rather than throwing on anything malformed: a source map
 * is an optimisation, and a broken one must cost the line number it would
 * have given, not the analysis it was helping.
 */
export function parseSourceMap(text: string): SourceMap | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (raw === null || typeof raw !== "object") return undefined;

  const map = raw as Record<string, unknown>;
  if (map.version !== 3) return undefined;
  if (typeof map.mappings !== "string") return undefined;

  const sources = Array.isArray(map.sources)
    ? map.sources.filter((s): s is string => typeof s === "string")
    : [];
  const names = Array.isArray(map.names)
    ? map.names.filter((n): n is string => typeof n === "string")
    : [];

  const mappings: Mapping[] = [];
  let sourceIndex = 0;
  let originalLine = 0;
  let originalColumn = 0;
  let nameIndex = 0;

  try {
    const lines = map.mappings.split(";");
    for (const [generatedLine, line] of lines.entries()) {
      let generatedColumn = 0;
      if (line === "") continue;

      for (const segment of line.split(",")) {
        if (segment === "") continue;
        let cursor = 0;
        const fields: number[] = [];
        while (cursor < segment.length) {
          const { value, length } = decodeVlq(segment, cursor);
          fields.push(value);
          cursor += length;
        }

        // Fields are deltas against the running state, which is why a
        // malformed map cannot be recovered from partway through.
        generatedColumn += fields[0] ?? 0;

        if (fields.length === 1) {
          mappings.push({ generatedLine, generatedColumn });
          continue;
        }

        sourceIndex += fields[1] ?? 0;
        originalLine += fields[2] ?? 0;
        originalColumn += fields[3] ?? 0;
        if (fields.length > 4) nameIndex += fields[4] ?? 0;

        mappings.push({
          generatedLine,
          generatedColumn,
          ...(sources[sourceIndex] === undefined ? {} : { source: sources[sourceIndex] }),
          originalLine,
          originalColumn,
          ...(fields.length > 4 && names[nameIndex] !== undefined
            ? { name: names[nameIndex] }
            : {}),
        });
      }
    }
  } catch {
    // A map that decodes partway is not usable: every field is a delta, so
    // everything after the break would be silently wrong. Better to have no
    // line numbers than wrong ones pointing at real files.
    return undefined;
  }

  return {
    version: 3,
    ...(typeof map.file === "string" ? { file: map.file } : {}),
    ...(typeof map.sourceRoot === "string" ? { sourceRoot: map.sourceRoot } : {}),
    sources,
    names,
    // `sourcesContent` is deliberately not read — see the module note.
    mappings,
  };
}

/**
 * Find the original position for a generated one.
 *
 * The greatest mapping at or before the column, which is how the format
 * works: a mapping applies until the next one starts.
 */
export function originalPositionFor(
  map: SourceMap,
  generatedLine: number,
  generatedColumn: number,
): OriginalPosition | undefined {
  let best: Mapping | undefined;
  for (const mapping of map.mappings) {
    if (mapping.generatedLine !== generatedLine) continue;
    if (mapping.generatedColumn > generatedColumn) continue;
    if (best === undefined || mapping.generatedColumn > best.generatedColumn) best = mapping;
  }

  if (best?.source === undefined || best.originalLine === undefined) return undefined;

  const root = map.sourceRoot ?? "";
  return {
    source:
      root === ""
        ? best.source
        : `${root.replace(/\/+$/, "")}/${best.source.replace(/^\/+/, "")}`,
    // The format counts lines from 0; editors, stack traces and this
    // codebase's `SourceLocation` count from 1.
    line: best.originalLine + 1,
    column: (best.originalColumn ?? 0) + 1,
    ...(best.name === undefined ? {} : { name: best.name }),
  };
}

/**
 * The source map URL a bundle declares, if any.
 *
 * Returned, never fetched. The value comes from a file the target controls
 * and can name any URL at all, so the caller checks it against policy — the
 * same rule that stopped a sitemap index pointing discovery at
 * `169.254.169.254`.
 *
 * A `data:` URL is returned as-is; it carries the map inline and needs no
 * request, which makes it the one case with nothing to check.
 */
export function sourceMappingUrl(source: string): string | undefined {
  // Last occurrence: a bundle that concatenates modules can contain the
  // comment several times, and the real one is at the end.
  const match = [...source.matchAll(/^[/][/*][#@]\s*sourceMappingURL=(\S+)/gm)].pop();
  const value = match?.[1];
  if (value === undefined || value === "") return undefined;
  return value.replace(/\s*\*\/\s*$/, "");
}

/** Whether a declared source map URL is inline rather than a request. */
export function isInlineSourceMap(url: string): boolean {
  return url.startsWith("data:");
}

/** Decode an inline `data:` source map. Returns undefined if it is not one. */
export function decodeInlineSourceMap(url: string): SourceMap | undefined {
  if (!isInlineSourceMap(url)) return undefined;
  const comma = url.indexOf(",");
  if (comma === -1) return undefined;

  const meta = url.slice(0, comma);
  const payload = url.slice(comma + 1);
  try {
    const text = meta.includes(";base64")
      ? Buffer.from(payload, "base64").toString("utf8")
      : decodeURIComponent(payload);
    return parseSourceMap(text);
  } catch {
    return undefined;
  }
}
