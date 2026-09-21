/**
 * The interaction collector — build plan §13.1, §14; dev plan BR-M1-08.
 *
 * Records every action the explorer performs, so the requests that follow can
 * be attributed to it. §14's whole promise — "POST /api/orders was observed as
 * step 7 of the Checkout workflow, after the Place Order interaction" — rests
 * on there being an interaction to point at.
 *
 * ## A wrapper, not a change to the adapter
 *
 * This implements `BrowserAdapter` and delegates to a real one. The control
 * boundary stays exactly what §5.1 defined — the adapter still does nothing
 * but drive the browser under policy — and recording becomes something laid
 * over it rather than mixed into it. Callers hold the wrapper and cannot tell
 * the difference, which also means every action is recorded by construction
 * rather than by each call site remembering to.
 *
 * ## What it does not do
 *
 * It does not decide that an interaction *caused* a request. That is §15's
 * correlation, and §32.2 keeps it separate from collection. All this does is
 * make the interaction exist, with an id, at a point in the event sequence —
 * which is the evidence correlation needs and cannot reconstruct afterwards.
 */
import type {
  ActionOptions,
  ActionResult,
  BrowserAdapter,
  NavigationOutcome,
  ScrollDirection,
  SettledOutcome,
} from "@browserrecon/browser-adapter";
import type { EventBus } from "@browserrecon/events";
import { buildElementReference, type ElementReference } from "./element-ref.js";

/** The actions worth recording as interactions. */
export type InteractionKind = "navigate" | "click" | "type" | "scroll" | "back";

export interface InteractionPayload {
  readonly interactionId: string;
  readonly kind: InteractionKind;
  /** What the action did, in the adapter's own terms. */
  readonly outcome: "ok" | "denied" | "failed";
  /** Present for element actions. */
  readonly element?: ElementReference | undefined;
  /** Present for navigate and back. */
  readonly url?: string | undefined;
  /**
   * The selector the caller asked for, as asked.
   *
   * Kept beside the derived reference because they can differ — the caller's
   * selector is what was attempted, the reference is what was found — and a
   * scan that cannot reproduce a step needs to see both.
   */
  readonly requestedSelector?: string | undefined;
  /** Why a denied action was refused, so a barrier is explainable (§8.6). */
  readonly denialReason?: string | undefined;
  readonly failureKind?: string | undefined;
}

export interface Interaction extends InteractionPayload {
  /** Envelope sequence — the ordering authority (§13.2). */
  readonly sequence: number;
}

export interface InteractionModel {
  readonly interactions: readonly Interaction[];
  /** The most recent interaction, which is what a later event attributes to. */
  readonly latest?: Interaction | undefined;
  readonly byKind: ReadonlyMap<InteractionKind, number>;
}

export interface RecordingAdapter extends BrowserAdapter {
  readonly model: InteractionModel;
  /**
   * The id of the interaction in progress, or the last one.
   *
   * Exposed so a caller correlating a request can ask rather than guess.
   */
  readonly currentInteractionId?: string | undefined;
}

export interface RecordOptions {
  readonly adapter: BrowserAdapter;
  readonly bus: EventBus;
  readonly authContext?: string | undefined;
  /** Frame the explorer is driving, recorded so attribution can be scoped. */
  readonly frameId?: string | undefined;
  readonly targetId?: string | undefined;
}

/** Wrap an adapter so every action it performs becomes an event. */
export function recordInteractions(options: RecordOptions): RecordingAdapter {
  const interactions: Interaction[] = [];
  let ordinal = 0;
  let current: string | undefined;

  const nextId = (): string => {
    ordinal += 1;
    // Deterministic, like every other id in the system (§1): golden output
    // compares these across runs, and a random one makes that impossible.
    return `int_${String(ordinal).padStart(4, "0")}`;
  };

  const outcomeOf = (result: ActionResult<unknown>): InteractionPayload["outcome"] =>
    result.status === "ok" ? "ok" : result.status;

  /**
   * Publish the interaction, and wait for it.
   *
   * After the action, not before, because the outcome is part of what makes
   * it useful: an attempted click that the policy refused is a different
   * event from one that happened, and §8.6 wants the refusal recorded as a
   * barrier rather than lost.
   *
   * Awaited rather than fired off, for two reasons. §32.9 asks that an event
   * be durable before it is considered processed, and the bus has delivered
   * to the store by the time this resolves. And a caller that reads
   * `model.latest` immediately after an action must see that action — the
   * first version pushed in a `.then`, so the model was empty for a tick and
   * a test reading it straight after a click got `undefined`. It then
   * compared two `undefined`s and passed, which is the worse half of the bug.
   */
  const record = async (payload: InteractionPayload): Promise<void> => {
    current = payload.interactionId;
    try {
      const envelope = await options.bus.publish({
        type: "interaction",
        provenance: "observed",
        auth_context: options.authContext ?? "anonymous",
        payload: {
          ...payload,
          ...(options.frameId === undefined ? {} : { frameId: options.frameId }),
          ...(options.targetId === undefined ? {} : { targetId: options.targetId }),
        },
      });
      interactions.push({ ...payload, sequence: envelope.sequence });
    } catch {
      // A recording failure must not take down a scan that is otherwise
      // collecting good data (§22). The action already happened.
    }
  };

  const failureDetail = (
    result: ActionResult<unknown>,
  ): { denialReason?: string; failureKind?: string } => {
    if (result.status === "denied") return { denialReason: result.reason };
    if (result.status === "failed") return { failureKind: result.kind };
    return {};
  };

  return {
    get currentUrl(): string {
      return options.adapter.currentUrl;
    },

    get model(): InteractionModel {
      const byKind = new Map<InteractionKind, number>();
      for (const interaction of interactions) {
        byKind.set(interaction.kind, (byKind.get(interaction.kind) ?? 0) + 1);
      }
      return { interactions: [...interactions], latest: interactions.at(-1), byKind };
    },

    get currentInteractionId(): string | undefined {
      return current;
    },

    navigate: async (url, actionOptions) => {
      const result = await options.adapter.navigate(url, actionOptions);
      await record({
        interactionId: nextId(),
        kind: "navigate",
        outcome: outcomeOf(result),
        url: result.status === "ok" ? result.value.url : url,
        ...failureDetail(result),
      });
      return result;
    },

    click: async (selector, actionOptions) => {
      const result = await options.adapter.click(selector, actionOptions);
      await record({
        interactionId: nextId(),
        kind: "click",
        outcome: outcomeOf(result),
        requestedSelector: selector,
        ...(result.status === "ok" && result.value !== undefined
          ? { element: buildElementReference(result.value) }
          : {}),
        ...failureDetail(result),
      });
      return result;
    },

    type: async (selector, text, actionOptions) => {
      const result = await options.adapter.type(selector, text, actionOptions);
      await record({
        interactionId: nextId(),
        kind: "type",
        outcome: outcomeOf(result),
        requestedSelector: selector,
        // The text itself is deliberately absent. A scan types credentials
        // into login forms, and the event log is raw and local but the
        // exports are not (§37.2) — recording the selector is enough to
        // reproduce the step without carrying the secret through every
        // downstream stage.
        ...failureDetail(result),
      });
      return result;
    },

    scroll: async (direction: ScrollDirection, actionOptions?: ActionOptions) => {
      const result = await options.adapter.scroll(direction, actionOptions);
      await record({
        interactionId: nextId(),
        kind: "scroll",
        outcome: outcomeOf(result),
        ...failureDetail(result),
      });
      return result;
    },

    back: async (actionOptions?: ActionOptions): Promise<ActionResult<NavigationOutcome>> => {
      const result = await options.adapter.back(actionOptions);
      await record({
        interactionId: nextId(),
        kind: "back",
        outcome: outcomeOf(result),
        ...(result.status === "ok" ? { url: result.value.url } : {}),
        ...failureDetail(result),
      });
      return result;
    },

    // Waiting is not an interaction: it changes nothing, and recording it
    // would put an event between a click and the requests it caused, which is
    // precisely the sequence §15 reads.
    waitForSettled: async (
      actionOptions?: ActionOptions,
    ): Promise<ActionResult<SettledOutcome>> => options.adapter.waitForSettled(actionOptions),

    close: async () => options.adapter.close(),
  };
}
