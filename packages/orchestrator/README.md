# @browserrecon/orchestrator

The scan lifecycle: policy → discovery ‖ browsing → collection → export.

## Owns

- **Sequence and failure handling.** Which phase runs when, what happens when
  one fails, and what the scan reports afterwards. Every phase but `policy` is
  isolated: it records what went wrong, marks the scan `partial`, and the
  pipeline carries on with less (§8.5 rule 3).
- **The overlap and its bound.** Discovery and browsing run concurrently
  around **one** token bucket (§8.5 rule 2) — two phases with two buckets is
  two scans' worth of traffic at a target that agreed to one. The bound is the
  discovery deadline: browsing does not wait for a crawler to finish, and
  joining a crawler that ignores its abort signal is itself time-boxed.
- **`session.json`**, written after every phase so a killed scan is still
  resumable, and the §30 resume gate that reads it back.
- **The interactive barrier assist** (§10C.7): in headed mode a person may be
  asked to clear an authentication challenge. Headless never prompts, because
  a prompt in CI is a hang.

## Does not own

- **Any of the work.** Discovery, browsing, collection and export arrive as
  ports (`ports.ts`). The real implementations are wired in `apps/cli`, which
  is the only place §1.2 allows everything to be imported at once.
- **Policy resolution.** The caller resolves the Target Policy and hands over
  a queue that already refuses out-of-scope URLs; the policy phase asserts
  that it did, before a browser is launched (§32.10).
- **Solving anything.** §7.3 is absolute: the assist waits for a person or
  records the barrier. `tests/meta/no-solver.test.ts` scans the repository to
  keep it that way.

## Deviation from the dev plan

BR-M1-28 names `packages/core` as the home for the orchestrator. It cannot
live there: §1.2 puts `core` in the innermost layer, importing nothing from
`browser/`, `discovery/` or `collectors/`, and an orchestrator imports all
three. This package is a new layer above them and below `apps/cli`.

## Boundaries

See the dev plan §1.2 (dependency direction) and §2 (modularity contract).
Consumers import from the package root only — deep imports are an eslint error.
