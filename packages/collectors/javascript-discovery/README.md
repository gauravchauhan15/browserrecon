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

## Does not own

- **Deciding whether a candidate is real.** §10A.3: a JavaScript candidate is
  not an invoked API. Status is settled by runtime observation (BR-M2-12),
  not here.
- **Worker isolation and caching.** BR-M2-09 and BR-M2-10 wrap this; the
  analyzer is a pure function of its input.
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

## Dependency note

`tree-sitter` and `tree-sitter-javascript` are native addons, allowed to run
install scripts in `pnpm-workspace.yaml`. They compile nothing: `node-gyp-build`
selects a prebuilt binary from the package's own `prebuilds/` for this
platform, and all six platforms this tool targets are prebuilt. Both MIT,
10.7 MB installed.

## Boundaries

See the dev plan §1.2 (dependency direction) and §2 (modularity contract).
Consumers import from the package root only — deep imports are an eslint error.
