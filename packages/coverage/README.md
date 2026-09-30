# @browserrecon/coverage

Measurable, explainable coverage — §10C's opening line is the brief:
"BrowserRecon must optimize for **measurable, explainable coverage**, not a
false promise of 100% discovery."

## Owns

- **Thirteen dimensions and nine statuses** (§10C.1, §10C.2). One percentage
  hides what a reader needs: "72% covered" could mean every page visited and
  no JavaScript parsed, or the reverse.
- **A deterministic score** (§10C.4) that never reaches 1.
- **The gap queue** (§10C.5, §10C.7) — first-class objects with a typed
  reason and a response.
- **Liveness probing decisions** (§10C.7) — what to probe, and how to read
  the answer.
- **Multi-role differential coverage** (§12.4).

## Does not own

- **Issuing probes.** This plans them and classifies the responses; the
  runner sends them, under policy and against the shared rate budget.
- **Resolving a gap.** V5 tries to reach it; V6 associates what it cannot.
- **Deciding anything is a vulnerability.** See below.

## The score cannot reach 1, and that is the design

Not a flourish. A scan measures the surface it could reach under a policy, an
auth state, a budget and analysis limits. Even a scan that reached everything
it *discovered* has not reached what it never discovered, and there is no way
to know how much that is. A score of 1.0 would be a claim about the unmeasured
part — the one claim this tool cannot make.

So the ceiling is 0.95 and `describe()` says what the number means, because
without it a reader supplies the obvious reading and the obvious reading is
the forbidden one.

A dimension that found nothing is excluded from both sides rather than scored.
Scoring it zero punishes a site with no WebMCP for not having any; scoring it
one rewards it. Both are claims about something never measured.

## Every gap carries a reason, and the reasons differ completely

§10C.7: "'Unobserved' is not one condition. Lumping every unreached candidate
together produces a gap list nobody can act on."

`budget_exhausted` means run it again with more. `requires_role` means scan as
someone else. `policy_excluded` means it is working as intended and needs
nothing. `not_navigable` carries **no remedy at all**, deliberately: a browser
cannot visit `POST /api/refund`, and BrowserRecon will not invoke it — an
unsolicited mutating request is active testing, which is out of scope. It is a
scope boundary, not a coverage failure, and `NOT_NAVIGABLE_NOTE` says so where
a reader will see the empty column.

`blockedBecause` is the field most likely to change what someone does next.
The honest answer is often *"we could reach this, but you told us not to send
POST"* — a user decision, not a tool limitation.

## A gated response is better intelligence than a 200

A `401` or `403` from a liveness probe is *positive confirmation of real,
gated surface*: the endpoint exists and something protects it, for the cost of
one request. Only `404`/`410` deprioritise anything.

Probing is opt-in, because it issues requests the application itself never
made. One per unique candidate, never a method outside policy, capped.

## A reachability difference is evidence, not a finding

§12.4 rule 3. This module emits `flaggedForReview`, never `severity`, and the
vocabulary is the guardrail — a field called `severity` gets filled in by
someone eventually. A test asserts the serialised output contains no
vulnerability, exploit, severity or criticality language.

Two flags, deliberately unequal:

- `lower_privilege_reachable` — the reach/block split **contradicts** the
  privilege order. A genuine inconsistency.
- `sensitive_surface_reached` — the boundary is consistent, but a role below
  the top reached surface whose *name* suggests restriction. §12.4's own
  worked example, and weaker: plenty of applications let a customer export
  their own reports. The note says it rests on the name.

Privilege order is supplied by the user because only they know it. An unranked
role is never treated as low-privilege — that would raise a false flag against
a role nobody described.

## Boundaries

§1.2: consumes events and derived models; imports no `browser/*` or
`discovery/*`.
