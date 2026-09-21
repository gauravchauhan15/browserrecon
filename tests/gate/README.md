# @browserrecon/gate

Milestone gates: the properties a _version_ claims, checked end to end.

## What a gate is

Not a unit test. Every other test in this repository checks a part; a gate
checks the claim. It drives the CLI's own `run()` against a real Chrome and a
real fixture, and asserts against **what the fixture received** rather than
what the scan says it did.

That distinction is the whole value. The M1 gate found two defects that every
package's own tests were green through:

- a scan that reported `complete · 1 of 1 discovered`, wrote artifacts and
  exited 0, against a site the browser never opened;
- a page harvest silently refused by a policy check, so a four-page site
  looked like a one-page site with no links.

## Running one

```bash
corepack pnpm exec vitest run tests/gate --testTimeout=300000
```

Gates need a Chrome. They skip without one and **must not skip in CI** — a
precondition test asserts that.

## What M1 asserts

§44's "V1 is done when", one test per clause: a scan produces useful output;
links that exist only after the page's script runs are found; coverage
limits are stated rather than hidden; no POST is issued under the default
policy; a barrier is recorded and never circumvented; the event log survives
and stays ordered; the session is resumable; and `.output/` is owner-only.

Plus what BR-M1-31 adds: stable output across three consecutive runs, and one
rate budget shared by discovery and browsing.

## On "stable"

Measured, not assumed. Across three runs the event _count_ and type histogram
are identical and the exported model is byte-identical — but the interleaving
of Chrome's first few startup events is not, so a given request can land on a
different envelope sequence. The gate therefore asserts the two things that
are true (the log's content is stable; every cited event id resolves in its
own log) instead of masking the ids and calling the result deterministic.
See `docs/architecture/decisions.md`.
