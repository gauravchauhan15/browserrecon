# @browserrecon/api-model

Context-aware API objects, built from a recorded event log.

## Owns

- **Endpoint identity and dedup** (§14, §23.2). `GET /api/products/1` and
  eighty siblings are one endpoint observed eighty times. Identity is method +
  origin + route template; the query string is deliberately not part of it,
  because `?q=shoes` and `?q=hats` are one endpoint taking a parameter.
- **Initiator chains** (§15). CDP's flattened stack frames parsed back into
  script, line and column, plus the distinct scripts involved.
- **Typed causality** (§15). Five graded kinds — `direct`, `inferred`,
  `temporal`, `sequence_candidate`, `dependency_candidate` — each edge
  carrying the basis that produced it, so a consumer wanting only what the
  browser reported can filter to `direct`.
- **Payload shapes** (§14.1, §37.1). Field names, types and presence. Values
  are _dropped_, not redacted.

## Does not own

- **Workflows and sequences.** BR-M2-13 and M3 build on this; ordering an
  endpoint into a workflow is not identity's job.
- **Semantic meaning.** "This creates an order" is M4's inference, and it may
  not re-cut what determinism found.
- **Collection.** It reads events; something else produced them.

## Two decisions worth knowing

**Values are dropped, not redacted.** Redaction is a filter and a filter has a
false-negative rate: a field name nobody wrote a pattern for carries its value
straight through. Shape extraction has no such failure mode — there is no code
path that emits a value, so a missing pattern cannot leak one. The exception is
an enum-shaped field (few short distinct values, non-sensitive name), because
`role: "user" | "admin"` is part of the interface and is what a security reader
acts on.

**Causality is never inferred from adjacency.** §15 is explicit, and the
failure it prevents is concrete: presenting two consecutive requests as a
dependency invents a requirement, and a reader acting on it will try to exploit
an ordering that was never required. The only edges produced here are the
script Chrome named as initiator and the interaction the request followed.

## Boundaries

§1.2's load-bearing rule: this runs against a recorded `events.jsonl` with **no
browser present**. Its tests build models from literal arrays of envelopes. If
one ever needs Chrome, the boundary has been violated.

Consumers import from the package root only — deep imports are an eslint error.
