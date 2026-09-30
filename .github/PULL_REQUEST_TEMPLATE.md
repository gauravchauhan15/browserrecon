<!--
Pull requests are by prior discussion only — please open an issue first.
See CONTRIBUTING.md for the two honest reasons why.
-->

## What this changes

<!-- And the issue it was agreed in. -->

Closes #

## Checklist

- [ ] `corepack pnpm verify` passes — all eight gates
- [ ] Discussed in an issue first
- [ ] No new dependency, or the dependency was agreed in that issue
- [ ] Imports are from package roots, never deep into another package's `src/`
- [ ] Any new threshold is configuration, not a literal buried in a function
- [ ] Any derived or inferred value sets `provenance` where it is created
- [ ] IDs are deterministic — no random UUIDs
- [ ] No captured data, credentials or target names in the diff or the description

## How you verified it

<!--
Not "tests pass" — what did you do to convince yourself the change is right?
If you broke the guarantee deliberately to check a test catches it, say so:
that is the most valuable line in this box.
-->
