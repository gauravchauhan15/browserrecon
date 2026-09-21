/**
 * The navigation collector — build plan §16, §16.1; dev plan BR-M1-07.
 *
 * §16 asks for navigation to be a first-class object rather than a pair of
 * events, because everything downstream reasons in terms of "the user went
 * from here to there": §16.2's workflow grouping, §18's boundaries, §14's
 * "step 7 of the Checkout workflow".
 *
 * The object it builds is §16.1's: `from`, `to`, `navigation_id`,
 * `interaction_id`, `kind`.
 *
 * ## Why soft navigations are the point
 *
 * A request-oriented scan sees one document load and concludes the
 * application has one page, while the user moved through four screens and the
 * app called three different APIs. Everything after the first load is
 * invisible to it. Soft navigations are where a single-page application keeps
 * its structure, so a tool that cannot see them cannot model the application.
 *
 * ## Attribution is a candidate, not a proof
 *
 * §16.1 wants the interaction that caused a navigation. Chrome does not report
 * one: `Page.navigatedWithinDocument` carries a frame and a URL and nothing
 * else. The link here is therefore made by recency — the last interaction in
 * the same frame, with nothing else between — and §15 is explicit that
 * causality must not be inferred from timing alone.
 *
 * So the link is recorded with its basis and never presented as certainty. A
 * route change that follows no interaction is left unattributed rather than
 * given the nearest one, which is the mistake that makes an attribution field
 * worse than no field: a reader cannot tell a real link from a guess.
 */
import type { EventBus, EventEnvelope, Unsubscribe } from "@browserrecon/events";
import {
  classifySoftNavigation,
  type SoftNavigationSubtype,
  type SubtypeBasis,
} from "./kind.js";

interface CommittedPayload {
  readonly navigationId: string;
  readonly frameId: string;
  readonly isMainFrame: boolean;
  readonly url: string;
  readonly redirectedFrom?: string;
  readonly historyIndex?: number;
  readonly historyLength?: number;
  readonly targetId: string;
}

interface SoftPayload {
  readonly frameId: string;
  readonly isMainFrame: boolean;
  readonly url: string;
  readonly cdpNavigationType?: string;
  readonly historyIndex?: number;
  readonly historyLength?: number;
  readonly targetId: string;
}

interface InteractionPayload {
  readonly interactionId?: string;
  readonly frameId?: string;
  readonly targetId?: string;
}

export type NavigationKind = "hard" | "soft";

/** How an interaction came to be attached to a navigation. */
export type AttributionBasis =
  /** The last interaction in this frame, with no navigation in between. */
  | "most_recent_interaction"
  /** No interaction had been seen in this frame since the last navigation. */
  | "none";

/** §16.1's navigation object. */
export interface Navigation {
  readonly navigationId: string;
  /** Envelope sequence, which is the ordering authority (§13.2). */
  readonly sequence: number;
  readonly kind: NavigationKind;
  /** For a soft navigation: push, replace, hash or traverse. */
  readonly subtype?: SoftNavigationSubtype | undefined;
  /** Which evidence the subtype came from. */
  readonly subtypeBasis?: SubtypeBasis | undefined;
  /** Where the frame was. Absent for the first navigation in a frame. */
  readonly from?: string | undefined;
  readonly to: string;
  readonly frameId: string;
  readonly isMainFrame: boolean;
  readonly targetId: string;
  /**
   * The interaction this followed, where one was seen.
   *
   * A candidate link, not a proof — see the note above and `attributionBasis`.
   */
  readonly interactionId?: string | undefined;
  readonly attributionBasis: AttributionBasis;
  /** Present when a hard navigation landed somewhere other than it aimed. */
  readonly redirectedFrom?: string | undefined;
}

export interface NavigationModel {
  readonly navigations: readonly Navigation[];
  /** Navigations per frame, for a frame-aware view of the application. */
  readonly byFrame: ReadonlyMap<string, readonly Navigation[]>;
  readonly hard: number;
  readonly soft: number;
  /** Soft navigations with no interaction to attribute them to. */
  readonly unattributedSoft: number;
}

export interface NavigationCollector {
  readonly model: NavigationModel;
  stop(): void;
}

/** What is remembered about a frame between navigations. */
interface FrameState {
  url?: string | undefined;
  historyIndex?: number | undefined;
  historyLength?: number | undefined;
  /** Cleared by every navigation, so one interaction cannot claim two. */
  pendingInteractionId?: string | undefined;
}

export function collectNavigation(bus: EventBus): NavigationCollector {
  const navigations: Navigation[] = [];
  const frames = new Map<string, FrameState>();
  let softOrdinal = 0;
  let stopped = false;

  const frameOf = (targetId: string, frameId: string): FrameState => {
    const key = `${targetId}:${frameId}`;
    const existing = frames.get(key);
    if (existing !== undefined) return existing;
    const created: FrameState = {};
    frames.set(key, created);
    return created;
  };

  const unsubscribe: Unsubscribe = bus.subscribe(
    (envelope: EventEnvelope) => {
      if (envelope.type === "interaction") {
        const payload = envelope.payload as InteractionPayload;
        if (payload.frameId === undefined) return;
        // Held until a navigation claims it, or until the next navigation
        // clears it. An interaction that caused nothing simply expires.
        frameOf(payload.targetId ?? "-", payload.frameId).pendingInteractionId =
          payload.interactionId ?? `int_${envelope.sequence}`;
        return;
      }

      if (envelope.type === "navigation_committed") {
        const payload = envelope.payload as CommittedPayload;
        const frame = frameOf(payload.targetId, payload.frameId);

        navigations.push({
          navigationId: payload.navigationId,
          sequence: envelope.sequence,
          kind: "hard",
          ...(frame.url === undefined ? {} : { from: frame.url }),
          to: payload.url,
          frameId: payload.frameId,
          isMainFrame: payload.isMainFrame,
          targetId: payload.targetId,
          ...(frame.pendingInteractionId === undefined
            ? { attributionBasis: "none" as const }
            : {
                interactionId: frame.pendingInteractionId,
                attributionBasis: "most_recent_interaction" as const,
              }),
          ...(payload.redirectedFrom === undefined
            ? {}
            : { redirectedFrom: payload.redirectedFrom }),
        });

        frame.url = payload.url;
        frame.pendingInteractionId = undefined;
        // The position the new document commits at becomes the baseline the
        // first route change is measured against. Clearing it instead would
        // leave that one navigation with nothing to compare to, and it would
        // fall back to Chrome's label — which cannot tell a push from a
        // replace.
        frame.historyIndex = payload.historyIndex;
        frame.historyLength = payload.historyLength;
        return;
      }

      if (envelope.type === "soft_navigation") {
        const payload = envelope.payload as SoftPayload;
        const frame = frameOf(payload.targetId, payload.frameId);

        const verdict = classifySoftNavigation({
          fromUrl: frame.url,
          toUrl: payload.url,
          historyIndex: payload.historyIndex,
          historyLength: payload.historyLength,
          previousIndex: frame.historyIndex,
          previousLength: frame.historyLength,
          cdpNavigationType: payload.cdpNavigationType,
        });

        softOrdinal += 1;
        navigations.push({
          // Soft navigations have no CDP loader to borrow an id from, so one
          // is allocated — deterministically, because golden output compares
          // these (§36.2).
          navigationId: `snav_${String(softOrdinal).padStart(4, "0")}`,
          sequence: envelope.sequence,
          kind: "soft",
          subtype: verdict.subtype,
          subtypeBasis: verdict.basis,
          ...(frame.url === undefined ? {} : { from: frame.url }),
          to: payload.url,
          frameId: payload.frameId,
          isMainFrame: payload.isMainFrame,
          targetId: payload.targetId,
          ...(frame.pendingInteractionId === undefined
            ? { attributionBasis: "none" as const }
            : {
                interactionId: frame.pendingInteractionId,
                attributionBasis: "most_recent_interaction" as const,
              }),
        });

        frame.url = payload.url;
        frame.pendingInteractionId = undefined;
        frame.historyIndex = payload.historyIndex;
        frame.historyLength = payload.historyLength;
      }
    },
    { name: "navigation-collector" },
  );

  const build = (): NavigationModel => {
    const byFrame = new Map<string, Navigation[]>();
    for (const navigation of navigations) {
      const key = `${navigation.targetId}:${navigation.frameId}`;
      const list = byFrame.get(key);
      if (list === undefined) byFrame.set(key, [navigation]);
      else list.push(navigation);
    }

    return {
      navigations: [...navigations],
      byFrame,
      hard: navigations.filter((navigation) => navigation.kind === "hard").length,
      soft: navigations.filter((navigation) => navigation.kind === "soft").length,
      unattributedSoft: navigations.filter(
        (navigation) => navigation.kind === "soft" && navigation.interactionId === undefined,
      ).length,
    };
  };

  return {
    get model(): NavigationModel {
      return build();
    },
    stop: () => {
      if (stopped) return;
      stopped = true;
      unsubscribe();
    },
  };
}
