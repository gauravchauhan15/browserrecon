# @browserrecon/workflows

Deterministic workflow candidates, from a recorded event log.

§18.1 opens by calling this "the highest-risk deterministic component in
BrowserRecon — nothing off-the-shelf does it well, and everything downstream
(state model §19, workflow graph §20, V6 hypotheses §28) inherits its errors."
That is why the plan specifies an algorithm rather than a list of inputs, and
why this implements the six steps in order rather than something equivalent.

## Owns

- **Boundary signals** (§18.1) — nine kinds in three strengths. The strength
  is not a confidence score; it decides what the algorithm _does_: strong cuts
  always, medium cuts only where nothing joins the sides, weak contributes
  doubt.
- **The six construction steps**, named after the plan's own numbering.
- **Confidence scoring** from the evidence actually present, with every factor
  and its weight recorded — a confidence nobody can decompose is a number
  nobody can argue with.

## Does not own

- **Naming.** A candidate is a segment of traffic with evidence attached. §18.2
  lets a model "rename, group and explain candidates; it may not create,
  delete or re-cut them."
- **Filtering out noise.** Step 1 takes application traffic only; §17A decides
  what that is, upstream.
- **What a workflow means.** That is M4.

## Nothing is dropped

Candidates below the confidence floor are exported marked, never removed.
§18.1: "dropped candidates cannot be reviewed, and §10C's coverage accounting
needs to know they existed." Segments discarded at step 5 are counted by
reason for the same purpose.

## The asymmetry between steps 3 and 4

These look like the same question and are not, which is worth stating because
getting it wrong produced §18.1's own named failure mode during development.

**Step 3** decides whether to rejoin two segments a _strong_ signal separated.
Over-merging destroys a real boundary, so the rule is strict: a `depends_on`
edge, or the same **call site** (`script:line`). The obvious reading of §18.1's
"share an initiator chain" — the same script file — is wrong on any real
application: a single-bundle app initiates every request from `app.js`, so
every segment shares an initiator and the whole scan merges into one
candidate. That is the "one giant SPA workflow" failure mode, produced by the
step meant to prevent it.

**Step 4** decides whether to break something nothing has yet separated.
Over-splitting turns one flow into fragments too small to be workflows, which
step 5 then discards — so the coarser signal is enough: the same bundle
driving both sides is reason to leave a medium signal alone.

Erring toward _not_ merging and _not_ splitting are both the cheap direction,
and they point opposite ways.

## Thresholds are configuration

§18.1 requires it "so a golden test can pin them". Every number the algorithm
turns on is in `config.ts` with what it means and why it is that value. A
constant inlined at its use site changes the output of a test that does not
mention it.

## Boundaries

§1.2: this consumes events and must not import `browser/*` or `discovery/*`.
Its tests build candidates from literal arrays — if one ever needs Chrome, the
boundary has been violated.
