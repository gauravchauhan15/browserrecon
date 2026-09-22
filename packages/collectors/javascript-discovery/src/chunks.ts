/**
 * Dynamic chunk discovery — build plan §10B.6, §10.8; dev plan BR-M2-11.
 *
 * A code-split application loads its interesting code *after* an
 * interaction: the admin bundle arrives when someone opens the admin screen,
 * the checkout chunk when someone reaches checkout. An inventory taken at
 * page load sees the shell and concludes the application is small — which is
 * exactly backwards, because the chunks that load late are the ones behind
 * the features worth looking at.
 *
 * ## Every route is a chunk nobody fetched yet
 *
 * The other half, and the one that is easy to miss: a `modulepreload` or
 * `prefetch` hint names a chunk the application *expects* to need. That is a
 * free list of code paths, including ones this scan never triggered. They
 * are recorded as `hinted` rather than loaded, because the distinction is
 * the difference between "we analysed this" and "we know it exists".
 */
import type { EventEnvelope } from "@browserrecon/events";

/** How a script came to be known. */
export const CHUNK_SOURCES = [
  "document_script",
  "dynamic_import",
  "modulepreload",
  "prefetch",
  "worker",
  "service_worker",
  "runtime_injected",
] as const;

export type ChunkSource = (typeof CHUNK_SOURCES)[number];

export interface DiscoveredChunk {
  readonly url: string;
  readonly source: ChunkSource;
  /** False for a hint — the application named it, nobody fetched it. */
  readonly loaded: boolean;
  /** Envelope sequence it was first seen at, for ordering. */
  readonly firstSeen: number;
  /** The page that was current. Says which screen needs this code. */
  readonly page?: string | undefined;
  /**
   * True when it arrived after the initial document load.
   *
   * The signal that makes a chunk interesting: it means something had to
   * happen before the application wanted this code.
   */
  readonly lazy: boolean;
  /** The interaction that preceded it, where one did. */
  readonly afterInteraction?: string | undefined;
}

interface ScriptPayload {
  readonly url?: string;
  readonly initiator?: { readonly type?: string };
  readonly resourceType?: string;
  readonly isModule?: boolean;
  readonly hasSourceUrl?: boolean;
}

/** Link relations that name a script without fetching it as one. */
const HINT_RELATIONS: Readonly<Record<string, ChunkSource>> = {
  modulepreload: "modulepreload",
  preload: "prefetch",
  prefetch: "prefetch",
};

const SCRIPT_LIKE = /\.(?:m?js|cjs)(?:\?|$)/i;

/**
 * Walk a log and report every script the application knows about.
 *
 * From events, so it runs against a recorded scan with no browser — the same
 * rule the API model follows, and for the same reason: this is the part most
 * worth re-running with better rules against a log someone already has.
 */
export function discoverChunks(events: readonly EventEnvelope[]): readonly DiscoveredChunk[] {
  const found = new Map<string, DiscoveredChunk>();
  let currentPage: string | undefined;
  let lastInteraction: string | undefined;
  let documentLoaded = false;

  const add = (chunk: DiscoveredChunk): void => {
    const existing = found.get(chunk.url);
    // A chunk hinted and then actually loaded is a loaded chunk. The
    // upgrade only goes one way: something fetched is stronger evidence
    // than something named.
    if (existing !== undefined && (existing.loaded || !chunk.loaded)) return;
    found.set(chunk.url, chunk);
  };

  for (const envelope of events) {
    switch (envelope.type) {
      case "navigation_committed": {
        const payload = envelope.payload as { url?: string };
        if (payload.url !== undefined) currentPage = payload.url;
        // Each navigation restarts the question of what is lazy.
        documentLoaded = false;
        lastInteraction = undefined;
        break;
      }

      case "page_loaded":
        documentLoaded = true;
        break;

      case "interaction": {
        // `interactionId`, the key the interaction collector emits. This
        // read `interaction_id` with a fallback to the event id, which meant
        // it never produced a real interaction id while looking as though it
        // had — the same bug the M2 gate found in the API model. No fallback:
        // a plausible wrong value is worse than an absent one.
        const payload = envelope.payload as { interactionId?: string };
        lastInteraction = payload.interactionId;
        break;
      }

      case "script_parsed": {
        // Chrome's own view: every script it compiled, including ones with
        // no URL of their own. Those are handled by the inventory, not here.
        const payload = envelope.payload as ScriptPayload;
        if (payload.url === undefined || payload.url === "") break;
        add({
          url: payload.url,
          source: documentLoaded ? "runtime_injected" : "document_script",
          loaded: true,
          firstSeen: envelope.sequence,
          ...(currentPage === undefined ? {} : { page: currentPage }),
          lazy: documentLoaded,
          ...(lastInteraction === undefined ? {} : { afterInteraction: lastInteraction }),
        });
        break;
      }

      case "network_request": {
        const payload = envelope.payload as ScriptPayload;
        if (payload.url === undefined) break;
        const isScript = payload.resourceType === "Script" || SCRIPT_LIKE.test(payload.url);
        if (!isScript) break;

        // CDP names the initiator of a dynamic import `script`, and a
        // `<script src>` the parser found `parser`. That distinction is the
        // only reliable way to tell a code-split chunk from a tag.
        const initiator = payload.initiator?.type;
        const source: ChunkSource =
          initiator === "script"
            ? "dynamic_import"
            : initiator === "preload"
              ? "modulepreload"
              : documentLoaded
                ? "runtime_injected"
                : "document_script";

        add({
          url: payload.url,
          source,
          loaded: true,
          firstSeen: envelope.sequence,
          ...(currentPage === undefined ? {} : { page: currentPage }),
          lazy: documentLoaded,
          ...(lastInteraction === undefined ? {} : { afterInteraction: lastInteraction }),
        });
        break;
      }

      case "dom_snapshot": {
        // Preload and prefetch hints: chunks the application expects to
        // need, including for screens this scan never reached.
        const payload = envelope.payload as {
          links?: readonly {
            readonly rel?: string;
            readonly href?: string;
            readonly as?: string;
          }[];
        };
        for (const link of payload.links ?? []) {
          const relation = HINT_RELATIONS[(link.rel ?? "").toLowerCase()];
          if (relation === undefined || link.href === undefined) continue;
          if (relation === "prefetch" && link.as !== undefined && link.as !== "script")
            continue;
          if (!SCRIPT_LIKE.test(link.href) && link.as !== "script") continue;

          add({
            url: link.href,
            source: relation,
            // Named, not fetched. The distinction between "we analysed
            // this" and "we know it exists".
            loaded: false,
            firstSeen: envelope.sequence,
            ...(currentPage === undefined ? {} : { page: currentPage }),
            lazy: true,
          });
        }
        break;
      }

      default:
        break;
    }
  }

  return [...found.values()].sort(
    (a, b) => a.firstSeen - b.firstSeen || a.url.localeCompare(b.url),
  );
}

/** Chunks named by the application but never fetched — a free coverage gap. */
export function unfetchedChunks(
  chunks: readonly DiscoveredChunk[],
): readonly DiscoveredChunk[] {
  return chunks.filter((chunk) => !chunk.loaded);
}
