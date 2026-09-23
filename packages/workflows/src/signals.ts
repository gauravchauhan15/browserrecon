/**
 * Boundary signals — build plan §18.1; dev plan BR-M3-01.
 *
 * §18.1 lists nine signals in three strengths. The strength is not a
 * confidence score: it decides *what the algorithm does* with the signal.
 *
 *   **strong** cuts the stream, always
 *   **medium** cuts it only where nothing joins the two sides
 *   **weak**   contributes doubt, and cuts only when nothing else has
 *
 * That ordering is the algorithm's whole defence against its own named
 * failure modes. A hard navigation genuinely ends a workflow; an idle gap
 * might mean the user went for coffee. Treating them alike produces either
 * one giant candidate or a hundred fragments, and §18.1 names both.
 */
import type { EventEnvelope } from "@browserrecon/events";

export const SIGNAL_STRENGTHS = ["strong", "medium", "weak"] as const;
export type SignalStrength = (typeof SIGNAL_STRENGTHS)[number];

/** §18.1's nine, named exactly as the plan names them. */
export const SIGNAL_KINDS = [
  "hard_navigation",
  "soft_navigation",
  "form_submission",
  "auth_transition",
  "state_change",
  "interaction_then_api",
  "burst_after_idle",
  "first_seen_route",
  "idle_period",
  "return_to_route",
  "initiator_changed",
] as const;

export type SignalKind = (typeof SIGNAL_KINDS)[number];

export const SIGNAL_STRENGTH: Readonly<Record<SignalKind, SignalStrength>> = {
  hard_navigation: "strong",
  soft_navigation: "strong",
  form_submission: "strong",
  auth_transition: "strong",
  state_change: "strong",
  interaction_then_api: "medium",
  burst_after_idle: "medium",
  first_seen_route: "medium",
  idle_period: "weak",
  return_to_route: "weak",
  initiator_changed: "weak",
};

export interface BoundarySignal {
  readonly kind: SignalKind;
  readonly strength: SignalStrength;
  /** Envelope sequence the signal occurred at — the ordering authority. */
  readonly sequence: number;
  /** What was observed, for a report and for a reviewer checking the cut. */
  readonly detail: string;
}

/** What the detector needs about each application_api observation. */
export interface ApiEvent {
  readonly sequence: number;
  readonly apiId: string;
  /** Route template, so instances of one route are one thing (§9.5.2). */
  readonly routeTemplate: string;
  readonly timestampMs: number;
  readonly interactionId?: string | undefined;
  /** The script file. Coarse — a single-bundle app has one for everything. */
  readonly initiatorScript?: string | undefined;
  /**
   * The whole call stack, as one comparable string.
   *
   * What "the same initiator chain" has to mean for §18.1's merge rule to
   * say anything. Two weaker readings both fail, and both fail the same way
   * — by merging a whole application into one candidate, which is the
   * failure mode the rule exists to avoid:
   *
   *  - The script *file* merges every segment of a single-bundle app.
   *  - The *top frame* merges every segment of any app with a shared fetch
   *    wrapper, because `get@api-client.js:42` is the top frame of every
   *    request it ever makes. That is most applications, and the M3 gate
   *    found it: five screens of a synthetic SPA, five soft navigations,
   *    one candidate.
   *
   * The frames below the wrapper are what differ, so the comparison is the
   * chain.
   */
  readonly initiatorChain?: string | undefined;
  readonly authContext: string;
  readonly dependsOn: readonly string[];
}

export interface DetectInput {
  /** Application traffic only (§17A.3), in sequence order. */
  readonly apiEvents: readonly ApiEvent[];
  /** Everything else the log carries, for navigation and state signals. */
  readonly events: readonly EventEnvelope[];
  readonly thresholds: {
    readonly interactionWindowMs: number;
    readonly idleGapMs: number;
    readonly burstWindowMs: number;
  };
}

function timeOf(envelope: EventEnvelope): number {
  const parsed = Date.parse(envelope.timestamp);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Find every boundary signal in a log.
 *
 * Returns them in sequence order with duplicates kept: two signals at the
 * same point are two pieces of evidence, and collapsing them would lose the
 * stronger one's identity. The caller reduces.
 */
export function detectSignals(input: DetectInput): readonly BoundarySignal[] {
  const signals: BoundarySignal[] = [];
  const seenRoutes = new Set<string>();
  let lastAuthContext: string | undefined;

  for (const envelope of input.events) {
    switch (envelope.type) {
      case "navigation_committed":
      case "page_loaded": {
        const payload = envelope.payload as { url?: string };
        // A hard navigation to a different route ends whatever was running.
        signals.push({
          kind: "hard_navigation",
          strength: "strong",
          sequence: envelope.sequence,
          detail: `document load${payload.url === undefined ? "" : ` of ${payload.url}`}`,
        });
        break;
      }

      case "soft_navigation": {
        const payload = envelope.payload as { to?: string; kind?: string };
        // §16. A single-page application's route change is a navigation even
        // though no document loaded — and without this an SPA session is one
        // giant candidate, which §18.1 names as a failure mode.
        signals.push({
          kind: "soft_navigation",
          strength: "strong",
          sequence: envelope.sequence,
          detail: `${payload.kind ?? "route change"} to ${payload.to ?? "an unknown route"}`,
        });
        break;
      }

      case "auth_state_changed": {
        const payload = envelope.payload as { to?: string };
        signals.push({
          kind: "auth_transition",
          strength: "strong",
          sequence: envelope.sequence,
          detail: `auth state became ${payload.to ?? "unknown"}`,
        });
        break;
      }

      case "state_change": {
        const payload = envelope.payload as { to?: string };
        signals.push({
          kind: "state_change",
          strength: "strong",
          sequence: envelope.sequence,
          detail: `application state became ${payload.to ?? "unknown"}`,
        });
        break;
      }

      case "interaction": {
        const payload = envelope.payload as { kind?: string; element?: { selector?: string } };
        // A form submission is a strong boundary; an ordinary click is not.
        // The difference is what the click did, not that it happened.
        if (
          payload.kind === "click" &&
          /submit|\[type=.?submit/i.test(payload.element?.selector ?? "")
        ) {
          signals.push({
            kind: "form_submission",
            strength: "strong",
            sequence: envelope.sequence,
            detail: `submitted ${payload.element?.selector ?? "a form"}`,
          });
        }
        break;
      }

      default:
        break;
    }
  }

  // Signals that need the API stream rather than the raw log.
  let previous: ApiEvent | undefined;
  for (const event of input.apiEvents) {
    if (event.authContext !== lastAuthContext) {
      if (lastAuthContext !== undefined) {
        signals.push({
          kind: "auth_transition",
          strength: "strong",
          sequence: event.sequence,
          detail: `observations changed from ${lastAuthContext} to ${event.authContext}`,
        });
      }
      lastAuthContext = event.authContext;
    }

    if (!seenRoutes.has(event.routeTemplate)) {
      seenRoutes.add(event.routeTemplate);
      signals.push({
        kind: "first_seen_route",
        strength: "medium",
        sequence: event.sequence,
        detail: `first request to ${event.routeTemplate}`,
      });
    } else if (previous !== undefined && previous.routeTemplate !== event.routeTemplate) {
      // Returning to a template already seen. Weak: normal navigation does
      // this constantly, and on its own it means very little.
      signals.push({
        kind: "return_to_route",
        strength: "weak",
        sequence: event.sequence,
        detail: `returned to ${event.routeTemplate}`,
      });
    }

    if (previous !== undefined) {
      const gap = event.timestampMs - previous.timestampMs;

      if (gap >= input.thresholds.idleGapMs) {
        signals.push({
          kind: "idle_period",
          strength: "weak",
          sequence: event.sequence,
          detail: `${gap} ms of silence`,
        });
        // A burst opening right after a gap is the medium half of the same
        // observation: the silence is weak evidence, traffic resuming is
        // stronger.
        signals.push({
          kind: "burst_after_idle",
          strength: "medium",
          sequence: event.sequence,
          detail: `traffic resumed after ${gap} ms`,
        });
      }

      if (
        previous.initiatorScript !== undefined &&
        event.initiatorScript !== undefined &&
        previous.initiatorScript !== event.initiatorScript
      ) {
        signals.push({
          kind: "initiator_changed",
          strength: "weak",
          sequence: event.sequence,
          detail: `initiator changed to ${event.initiatorScript}`,
        });
      }
    }

    if (event.interactionId !== undefined) {
      signals.push({
        kind: "interaction_then_api",
        strength: "medium",
        sequence: event.sequence,
        detail: `${event.interactionId} was followed by a request`,
      });
    }

    previous = event;
  }

  return signals.sort(
    (a, b) =>
      a.sequence - b.sequence ||
      SIGNAL_STRENGTHS.indexOf(a.strength) - SIGNAL_STRENGTHS.indexOf(b.strength) ||
      a.kind.localeCompare(b.kind),
  );
}

/** The strongest signal at each point, for deciding where to cut. */
export function strongestAt(
  signals: readonly BoundarySignal[],
): ReadonlyMap<number, BoundarySignal> {
  const byPoint = new Map<number, BoundarySignal>();
  for (const signal of signals) {
    const existing = byPoint.get(signal.sequence);
    if (
      existing === undefined ||
      SIGNAL_STRENGTHS.indexOf(signal.strength) < SIGNAL_STRENGTHS.indexOf(existing.strength)
    ) {
      byPoint.set(signal.sequence, signal);
    }
  }
  return byPoint;
}

export { timeOf };
