/**
 * @browserrecon/collector-javascript-discovery — the asset graph, Tier A.
 *
 * Build plan §10.7, §10B.3, §10C.3; dev plan BR-M1-23.
 *
 * Metadata only. **No parsing** — that is M2, and keeping the boundary here
 * matters because §10B.9 treats a parser failure as an event rather than a
 * scan failure. An inventory that cannot fail is a different thing from an
 * analyser that can, and merging them would make one bad bundle cost the
 * whole picture.
 *
 * ## Deduplication is by content, not by URL
 *
 * The same bundle is served from three CDN paths, or with a cache-busting
 * query, or from both `www` and the apex. Counting it three times inflates
 * every "assets analysed" number and — once M2 arrives — parses it three
 * times. Chrome already computes a hash per script, so the dedup is free and
 * exact rather than heuristic.
 *
 * ## Runtime-loaded chunks are the point
 *
 * §10B.6. A code-split application loads its interesting chunks *after* an
 * interaction: the admin bundle arrives when you open the admin screen. An
 * inventory taken at page load sees the shell and concludes the application
 * is small.
 */
import type { EventBus, EventEnvelope, Unsubscribe } from "@browserrecon/events";

export const PACKAGE_NAME = "@browserrecon/collector-javascript-discovery" as const;

export interface ScriptAsset {
  /** Empty for an inline script, which is exactly the interesting case. */
  readonly url: string;
  readonly origin: string;
  readonly firstParty: boolean;
  /** Chrome's content hash. The dedup key. */
  readonly hash?: string | undefined;
  readonly bytes?: number | undefined;
  readonly mimeType?: string | undefined;
  /** True when it has no URL of its own — inline, eval, or generated. */
  readonly inline: boolean;
  /** True when it arrived after the page had loaded (§10B.6). */
  readonly runtimeLoaded: boolean;
  /** Present when the bundle shipped one — the door to original sources. */
  readonly sourceMapUrl?: string | undefined;
  /** Pages this script was seen on, sorted. */
  readonly seenOn: readonly string[];
  /**
   * Analysis order for M2 (§10C.3).
   *
   * First-party and large first, because that is where application
   * endpoints live; a third-party analytics bundle is big and says nothing.
   */
  readonly priority: number;
}

export interface JavascriptModel {
  /** One entry per distinct script, ordered by priority then URL. */
  readonly assets: readonly ScriptAsset[];
  /** Scripts whose content matched one already seen. */
  readonly deduplicated: number;
  readonly firstParty: number;
  readonly thirdParty: number;
  readonly inline: number;
  readonly runtimeLoaded: number;
}

export interface JavascriptCollector {
  readonly model: JavascriptModel;
  /** Tell the collector the page has loaded, so later scripts are runtime. */
  markLoaded(): void;
  stop(): void;
}

interface ScriptPayload {
  readonly url?: string;
  readonly hash?: string;
  readonly length?: number;
  readonly sourceMapUrl?: string;
  readonly inline?: boolean;
}

interface ResponsePayload {
  readonly url?: string;
  readonly mimeType?: string;
  readonly encodedDataLength?: number;
}

export interface JavascriptOptions {
  readonly firstPartyOrigins: readonly string[];
}

const SCRIPT_TYPES = /javascript|ecmascript/i;

/**
 * Priority for M2's analysis queue.
 *
 * Lower runs first. The ordering is deliberate rather than by size alone:
 * a 2 MB third-party analytics bundle is the largest thing on most pages
 * and contains nothing a recon tool wants.
 */
function priorityOf(firstParty: boolean, inline: boolean, bytes: number | undefined): number {
  if (inline) return 0; // Small, always application code, often the router.
  if (firstParty) return bytes !== undefined && bytes > 50_000 ? 1 : 2;
  return 5;
}

export function collectJavascript(
  bus: EventBus,
  options: JavascriptOptions,
): JavascriptCollector {
  /** Keyed by hash where there is one, else by URL. */
  const assets = new Map<string, ScriptAsset>();
  const urlMeta = new Map<string, { bytes?: number; mimeType?: string }>();
  let deduplicated = 0;
  let loaded = false;
  let stopped = false;

  const originOf = (url: string): string => {
    try {
      return new URL(url).origin;
    } catch {
      return "";
    }
  };

  const unsubscribe: Unsubscribe = bus.subscribe(
    (envelope: EventEnvelope) => {
      // Response metadata arrives on the network domain and the script
      // record on the debugger domain; neither has everything.
      if (envelope.type === "network_response") {
        const payload = envelope.payload as ResponsePayload;
        if (payload.url === undefined) return;
        if (!SCRIPT_TYPES.test(payload.mimeType ?? "")) return;
        urlMeta.set(payload.url, {
          ...(payload.encodedDataLength === undefined
            ? {}
            : { bytes: payload.encodedDataLength }),
          ...(payload.mimeType === undefined ? {} : { mimeType: payload.mimeType }),
        });
        return;
      }

      if (envelope.type !== "script_parsed") return;
      const payload = envelope.payload as ScriptPayload;
      const url = payload.url ?? "";
      const inline = payload.inline === true || url === "";
      const meta = urlMeta.get(url);
      const bytes = payload.length ?? meta?.bytes;

      // Hash first: the same bundle served from three CDN paths is one
      // script, and counting it three times inflates every number and,
      // once M2 arrives, parses it three times.
      const key = payload.hash !== undefined && payload.hash !== "" ? payload.hash : url;
      const existing = assets.get(key);

      if (existing !== undefined) {
        if (!existing.seenOn.includes(url) && url !== "") {
          assets.set(key, { ...existing, seenOn: [...existing.seenOn, url].sort() });
        }
        deduplicated += 1;
        return;
      }

      const origin = originOf(url);
      const firstParty = origin !== "" && options.firstPartyOrigins.includes(origin);

      assets.set(key, {
        url,
        origin,
        firstParty,
        ...(payload.hash === undefined ? {} : { hash: payload.hash }),
        ...(bytes === undefined ? {} : { bytes }),
        ...(meta?.mimeType === undefined ? {} : { mimeType: meta.mimeType }),
        inline,
        // A chunk that arrives after load is the one worth finding (§10B.6):
        // a code-split app loads its admin bundle when you open the admin
        // screen, and an inventory taken at load sees only the shell.
        runtimeLoaded: loaded,
        ...(payload.sourceMapUrl === undefined ? {} : { sourceMapUrl: payload.sourceMapUrl }),
        seenOn: url === "" ? [] : [url],
        priority: priorityOf(firstParty, inline, bytes),
      });
    },
    { name: "javascript-collector" },
  );

  return {
    markLoaded() {
      loaded = true;
    },
    get model(): JavascriptModel {
      const list = [...assets.values()].sort(
        (a, b) => a.priority - b.priority || (a.url < b.url ? -1 : a.url > b.url ? 1 : 0),
      );
      return {
        assets: list,
        deduplicated,
        firstParty: list.filter((asset) => asset.firstParty).length,
        thirdParty: list.filter((asset) => !asset.firstParty && !asset.inline).length,
        inline: list.filter((asset) => asset.inline).length,
        runtimeLoaded: list.filter((asset) => asset.runtimeLoaded).length,
      };
    },
    stop() {
      if (stopped) return;
      stopped = true;
      unsubscribe();
    },
  };
}
