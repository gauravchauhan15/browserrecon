# @browserrecon/exporter-markdown

`report.md` — the human-readable report.

## Owns

- §35B.2's nine sections, in one fixed order. The order is the feature: a
  report whose sections move cannot be diffed against last week's, and
  comparing runs is most of what a recurring scan is for.
- The rendering rules that keep the report honest — a low-confidence workflow
  is collapsed and never dropped (§18.1), a parallel step is marked rather
  than numbered into the chain (§35B.3), and section 9 is omitted entirely
  rather than rendered empty when no tier produced hypotheses.
- The standing coverage caveat (§10C.6), in the header rather than a footnote.

## Does not own

- **Whether a workflow is confident.** Confidence arrives as data; this
  package only decides how to show it.
- **Redaction.** The report is on the redacted side of §37.2's boundary, but
  the values reach this package already redacted.
- **The unredacted-output warning text**, which comes from
  `@browserrecon/core` so the docs, the report and the terminal summary cannot
  drift apart.

## Boundaries

See the dev plan §1.2 (dependency direction) and §2 (modularity contract).
Consumers import from the package root only — deep imports are an eslint error.
