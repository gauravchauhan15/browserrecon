/**
 * The application state graph — build plan §19; dev plan BR-M3-04.
 *
 * §19 asks for a *lightweight* state graph and says outright that it "does not
 * need to be perfect in V1. It should be labelled as derived and improve
 * across versions."
 *
 * Both halves of that matter, and the second one more. An imperfect state
 * model is useful: knowing a scan went `cart_empty → cart_has_item →
 * checkout_started` tells a reader what the application does even if a
 * transition is mislabelled. An imperfect state model presented as observed
 * fact is worse than none, because the mistakes are invisible and a reader
 * builds on them.
 *
 * So every transition here carries `provenance: "derived"` and the evidence
 * it was derived from. There is no code path that produces `observed` — the
 * type does not allow it, and a test asserts the type has not grown one.
 *
 * ## States are named from evidence, not invented
 *
 * A state name comes from something in the log: the auth context, a route
 * template, a resource the application created. Nothing here guesses that a
 * page is "the checkout screen" because it looks like one — that is §18.2's
 * job for a model to do, with its own provenance.
 */
import type { EventEnvelope } from "@browserrecon/events";

/** What caused a transition. §19's `trigger` block. */
export interface StateTrigger {
  readonly type: "navigation" | "soft_navigation" | "interaction" | "api_call" | "auth_change";
  readonly interactionId?: string | undefined;
  readonly apiId?: string | undefined;
  readonly detail: string;
}

export interface StateTransition {
  readonly from: string;
  readonly to: string;
  readonly trigger: StateTrigger;
  /** APIs observed across the transition, as §19's example carries them. */
  readonly relatedApis: readonly string[];
  /**
   * Always `derived`. Never `observed`.
   *
   * A literal type rather than a string, so producing an observed transition
   * is a compile error rather than a review comment.
   */
  readonly provenance: "derived";
  /** Event ids this was derived from, so a reader can check it (§35B.5). */
  readonly evidence: readonly string[];
  /** Envelope sequence, for ordering and for the workflow graph. */
  readonly sequence: number;
}

export interface StateModel {
  readonly states: readonly string[];
  readonly transitions: readonly StateTransition[];
  /** How the scan started. `anonymous` unless a profile was in use. */
  readonly initialState: string;
}

/**
 * Resources whose creation names a state.
 *
 * A `POST` that returns 201 with an id has created something, and the
 * application is now in a state where that thing exists. The resource's own
 * name is the state's name — `order_created`, `cart_created` — which is
 * §19's own example vocabulary and comes from the URL rather than a guess.
 */
const CREATED_BY = /^(?:POST|PUT)$/;

/** Path segments that are not resource names. */
const NOT_A_RESOURCE = new Set([
  "api",
  "v1",
  "v2",
  "v3",
  "rest",
  "graphql",
  "public",
  "internal",
]);

/**
 * Name the resource a path acts on.
 *
 * The last segment that is a word rather than an identifier: `/api/v2/orders`
 * is `orders`, and `/api/orders/{id}/receipt` is `receipt`. Returns undefined
 * rather than guessing when nothing qualifies — an unnamed state is better
 * than a state called `{id}`.
 */
export function resourceOf(path: string): string | undefined {
  const segments = path
    .replace(/^https?:\/\/[^/]+/, "")
    .split("/")
    .filter(
      (segment) => segment !== "" && !segment.startsWith("{") && !segment.startsWith(":"),
    );

  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = (segments[index] ?? "").toLowerCase();
    if (NOT_A_RESOURCE.has(segment)) continue;
    if (!/^[a-z][a-z0-9_-]*$/.test(segment)) continue;
    return singular(segment);
  }
  return undefined;
}

/**
 * Strip a trailing plural `s`, and only that.
 *
 * `orders` → `order`, which is §19's own vocabulary. English is not worth
 * guessing at beyond this, so anything ending in a vowel + `s` or a doubled
 * `s` is left alone: `status` is a word, not a plural, and this returned
 * `statu` until a test said so.
 */
function singular(word: string): string {
  if (word.length < 4) return word;
  if (!word.endsWith("s")) return word;
  if (/(?:ss|us|is|os|as|ys)$/.test(word)) return word;
  return word.slice(0, -1);
}

/** What the builder reads about each application_api observation. */
export interface ApiForState {
  readonly sequence: number;
  readonly apiId: string;
  readonly method: string;
  readonly path: string;
  readonly status?: number | undefined;
  readonly authContext: string;
  readonly interactionId?: string | undefined;
  readonly eventId: string;
}

export interface BuildStateInput {
  readonly apiEvents: readonly ApiForState[];
  readonly events: readonly EventEnvelope[];
}

/**
 * Reconstruct the state graph.
 *
 * Four things move the state, in decreasing order of how sure we can be:
 *
 *   an auth change   — the log says so outright
 *   a creation       — a POST returning 201 created something named
 *   a navigation     — the application moved the user somewhere
 *   nothing else     — no transition is invented
 *
 * There is deliberately no rule for "this looks like a checkout page". §19
 * wants a lightweight graph, and a heavyweight guess is not an improvement
 * on a light one.
 */
export function buildStateModel(input: BuildStateInput): StateModel {
  const ordered = [...input.apiEvents].sort((a, b) => a.sequence - b.sequence);
  const initialState = ordered[0]?.authContext ?? "anonymous";

  const transitions: StateTransition[] = [];
  const states = new Set<string>([initialState]);
  let current = initialState;

  /** Interleave the log's own navigation and auth events with the API stream. */
  const navigations = input.events
    .filter(
      (envelope) =>
        envelope.type === "soft_navigation" ||
        envelope.type === "navigation_committed" ||
        envelope.type === "auth_state_changed",
    )
    .sort((a, b) => a.sequence - b.sequence);

  const move = (
    to: string,
    trigger: StateTrigger,
    evidence: string[],
    sequence: number,
    apis: string[],
  ): void => {
    if (to === current) return;
    states.add(to);
    transitions.push({
      from: current,
      to,
      trigger,
      relatedApis: apis,
      provenance: "derived",
      evidence,
      sequence,
    });
    current = to;
  };

  const recentApis: string[] = [];

  /**
   * Handle one log event that can move the state.
   *
   * Separated from the loop because it has to run for events *after* the
   * last API call too. The first version merged the two streams with a
   * nested while inside the API loop, which silently dropped every event
   * past the final request — including a logout, which is the one most worth
   * recording.
   */
  const applyLogEvent = (envelope: EventEnvelope): void => {
    if (envelope.type === "auth_state_changed") {
      const payload = envelope.payload as { to?: string };
      // The strongest kind: the log says the state changed.
      move(
        payload.to ?? "anonymous",
        { type: "auth_change", detail: `auth state became ${payload.to ?? "anonymous"}` },
        [envelope.event_id],
        envelope.sequence,
        [...recentApis],
      );
      recentApis.length = 0;
      return;
    }

    const payload = envelope.payload as { to?: string; url?: string };
    const target = payload.to ?? payload.url;
    const named = target === undefined ? undefined : resourceOf(target);
    if (named === undefined) return;

    move(
      `viewing_${named}`,
      {
        type: envelope.type === "soft_navigation" ? "soft_navigation" : "navigation",
        detail: `moved to ${target ?? "an unknown route"}`,
      },
      [envelope.event_id],
      envelope.sequence,
      [...recentApis],
    );
    recentApis.length = 0;
  };

  // One merged pass over both streams in sequence order. A single ordering,
  // so nothing can be processed out of order or left unprocessed.
  const merged: (
    | { readonly kind: "api"; readonly sequence: number; readonly event: ApiForState }
    | { readonly kind: "log"; readonly sequence: number; readonly envelope: EventEnvelope }
  )[] = [
    ...ordered.map((event) => ({ kind: "api" as const, sequence: event.sequence, event })),
    ...navigations.map((envelope) => ({
      kind: "log" as const,
      sequence: envelope.sequence,
      envelope,
    })),
  ].sort((a, b) => a.sequence - b.sequence);

  for (const entry of merged) {
    if (entry.kind === "log") {
      applyLogEvent(entry.envelope);
      continue;
    }

    const event = entry.event;
    recentApis.push(event.apiId);

    // A creation names a state. §19's `order_created` comes from exactly
    // this: a POST that returned 201 against `/api/orders`.
    if (event.status === 201 && CREATED_BY.test(event.method.toUpperCase())) {
      const resource = resourceOf(event.path);
      if (resource !== undefined) {
        move(
          `${resource}_created`,
          {
            type: "api_call",
            apiId: event.apiId,
            ...(event.interactionId === undefined
              ? {}
              : { interactionId: event.interactionId }),
            detail: `${event.method} ${event.path} returned 201`,
          },
          [event.eventId],
          event.sequence,
          [...recentApis],
        );
        recentApis.length = 0;
      }
    }

    // The auth context on an observation disagreeing with the current state
    // means a transition the log did not announce — §12.3's silent-logout
    // case, which must not go unrecorded. Checked against the current state
    // rather than against a set of known ones: a logout back to `anonymous`
    // is exactly the case a "have we seen this state?" guard would miss on a
    // scan that never announced the login either.
    if (event.authContext !== current) {
      move(
        event.authContext,
        { type: "auth_change", detail: `observations began carrying ${event.authContext}` },
        [event.eventId],
        event.sequence,
        [...recentApis],
      );
      recentApis.length = 0;
    }
  }

  return {
    states: [...states],
    transitions,
    initialState,
  };
}

/** States reachable from one, following transitions. Cycle-safe. */
export function reachableFrom(model: StateModel, start: string): readonly string[] {
  const seen = new Set<string>([start]);
  const queue = [start];

  while (queue.length > 0) {
    const state = queue.shift() as string;
    for (const transition of model.transitions) {
      if (transition.from !== state || seen.has(transition.to)) continue;
      seen.add(transition.to);
      queue.push(transition.to);
    }
  }

  seen.delete(start);
  return [...seen].sort();
}
