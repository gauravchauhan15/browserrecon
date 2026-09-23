# @browserrecon/attack-surface

The unified, scanner-consumable model.

## Owns

- **The surface model** (§23) — one object a downstream scanner consumes,
  assembled from everything the earlier packages built.
- **The traceability chain** (§35B.5) and the validator that enforces it.
- **The published JSON Schema**, committed rather than generated at install
  time, because a consumer must be able to read the contract without running
  anything.

## Does not own

- **Producing any of the pieces.** APIs, workflows, states and coverage are
  built elsewhere and assembled here.
- **Deciding anything is a vulnerability.** The model is structure; V6 reasons
  over it with hypotheses that carry `executed: false`.

## The chain is the product

§35B.5: "any claim in `report.md` can be walked back to the raw observations
that produced it. **A derived object without resolvable source IDs is a
bug.**"

That is stronger than it reads. A surface item carries the workflow it belongs
to, which carries the API events, which carry the request/response envelopes,
which carry the interaction and navigation that caused them. Break the chain
anywhere and the item becomes an assertion — indistinguishable, to a reader,
from something the tool made up.

So `resolveChain` returns every link including the broken ones, and
`validateSurface` refuses a model whose ids resolve to nothing. A traceability
requirement nobody checks is a convention.

The schema enforces the same thing independently: `source_event_ids` has
`minItems: 1`, so a consumer validating our output catches an untraceable item
even if our own validator were to stop running.

## Ids are stable across runs

`srf_0001` means the same thing this week as last, which is what lets a
consumer diff two scans. Items are sorted before ids are assigned — arrival
order varies with what the browser did first, and M1 measured that it is not
stable.

## How a breaking schema change is caught

Two gates, in sequence, and neither alone is enough:

1. `generate-schemas.mjs --check` refuses a generator that has drifted from
   the committed copy.
2. Once regenerated, `tests/meta/schema-compatibility.test.ts` compares the
   committed schema against a recorded baseline and names any required field
   that was dropped without a major-version bump.

Additive changes are unpoliced on purpose. §35B.6 says Tier 2 "changes shape
only additively", and a test demanding a version bump for a new optional field
would make the version move constantly and mean nothing.

## Boundaries

§1.2: consumes derived models; imports no `browser/*` or `discovery/*`.
