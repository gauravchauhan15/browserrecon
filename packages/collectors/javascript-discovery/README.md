# @browserrecon/collector-javascript-discovery

The JavaScript asset graph (Tier A) and static analysis (Tier B).

## Owns

- **The asset inventory** — every script the page loaded, deduplicated by
  Chrome's content hash rather than by URL, including chunks that arrive after
  an interaction (§10B.6). An inventory taken at page load sees the shell and
  concludes the application is small.
- **The `JSAnalyzer` interface** (§10A.1) — BrowserRecon's own vocabulary for
  origins, URLs, API candidates, routes, request patterns and config. No
  parser type appears in any exported signature, and a test asserts it.
- **A tree-sitter implementation** of that interface.

- **Asset triage** (§10B.3, §10B.7) — P0–P4, with runtime evidence overriding
  naming. A vendor-looking file that drives the application's API outranks a
  first-party file that did nothing.
- **Content dedup and the analysis cache** (§10B.5, §10B.8), keyed on content
  hash _and_ parser and rule versions, so a better rule invalidates its own
  cache.
- **Dynamic chunk discovery** (§10B.6), including preload hints — chunks the
  application named for screens this scan never reached.
- **Static ↔ runtime reconciliation** (§10A.3) — `observed`, `correlated`,
  `unobserved`, with the static source kept after confirmation.
- **The analysis bounds** (§10B.9): size, time, and a parser that does not
  throw.

## Does not own

- **Deciding whether a candidate is real.** §10A.3: a JavaScript candidate is
  not an invoked API. Only the runtime settles it, and `reconcile` is where
  the two meet.
- **Semantics.** "This creates an order" is M4's inference.

## Two things the design turns on

**Position decides confidence, not shape.** `/api/orders` in the URL argument
of a `fetch` call is `high`; the identical string sitting in an array is
`low`. A regular expression over the source text cannot tell them apart, and
also matches paths in comments and licence headers — which is why this walks
a tree.

**A partial result is kept.** §41's body limits mean a large bundle may be
captured only in part, and a parser that throws on truncated input extracts
_nothing_ from it. tree-sitter returns a tree for what parsed, the result is
labelled `partial` with a reason, and every endpoint before the break
survives. That row is what decided the parser — see
`docs/architecture/js-analysis-spike.md`, which records the measurement on
7.29 MiB of real minified production JavaScript.

**The size gate is the memory bound, and a worker is not.** §10B.9 suggests
bounded workers. One was built and removed: a worker with a 16 MB V8 heap
ceiling parsed a 4.8 MB bundle to completion while resident memory grew
342 MB, because tree-sitter allocates natively. Capping input caps memory —
RSS tracks source size at roughly 28x — and that is what `maxAssetBytes` does.
See `docs/architecture/js-analysis-spike.md`.

## Dependency note

`tree-sitter` and `tree-sitter-javascript` are native addons, allowed to run
install scripts in `pnpm-workspace.yaml`. They compile nothing: `node-gyp-build`
selects a prebuilt binary from the package's own `prebuilds/` for this
platform, and all six platforms this tool targets are prebuilt. Both MIT,
10.7 MB installed.

## Boundaries

See the dev plan §1.2 (dependency direction) and §2 (modularity contract).
Consumers import from the package root only — deep imports are an eslint error.
