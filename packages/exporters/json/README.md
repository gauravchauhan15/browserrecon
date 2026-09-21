# @browserrecon/exporter-json

The machine-readable export: `attack-surface.json` and the JSONL streams.

## Owns

- The exported document's shape (`ExportedDocument`, `REQUIRED_KEYS`) and its
  own `EXPORT_SCHEMA_VERSION`, versioned independently of the event schema.
- `validateDocument`, which enforces that §23.1's keys are **present even when
  empty**. A consumer that finds no `coverage_gaps` key cannot tell "this scan
  had full coverage" from "this version does not report gaps", and will assume
  the first.
- Streaming writers. §22.2 forbids loading the event log into memory: a
  gigabyte log is the normal case on a large scan, so the document is written
  header-first and then element by element.

## Does not own

- **Redaction rules.** They live in `@browserrecon/core`; this package takes a
  `Redactor` and is required to. The parameter is deliberately not optional —
  §37.2 puts exports on the redacted side of the boundary, and an optional
  redactor is one a caller forgets.
- **The model itself.** Correlation builds it; this package serialises it.
- **Where the file goes.** The orchestrator owns paths and the output
  directory's permissions (`createSecureOutputDir`).

## Boundaries

See the dev plan §1.2 (dependency direction) and §2 (modularity contract).
Consumers import from the package root only — deep imports are an eslint error.
