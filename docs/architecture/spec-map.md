# Reading the `§` references

Source comments throughout this repository cite section numbers — `§18.1`,
`§1.2`, `§15`. They point into two design documents written before the code:

- a **build plan**, which specifies what the tool must do, and
- a **dev plan**, which breaks that into numbered stories (`BR-M1-31`,
  `BR-M3-12`) and milestone gates.

**Neither document is published.** They contain planning material that is not
useful outside the project, and republishing them would mean maintaining two
descriptions of the same thing. This file is the reader's key instead: what the
numbering means, and what the most-cited sections actually require, so a
comment saying "§15 forbids this" is legible without them.

Every requirement below is also enforced somewhere in the code or the tests.
Where that is a single obvious place, it is named.

## How to read a citation

| Form           | Means                                                                                    |
| -------------- | ---------------------------------------------------------------------------------------- |
| `§15`          | Build plan, section 15                                                                   |
| `§18.1`        | Build plan, section 18, subsection 1                                                     |
| `§17A`, `§35B` | A section inserted after the original numbering was fixed — `17A` sits between 17 and 18 |
| `BR-M1-31`     | Dev plan story: milestone 1, story 31                                                    |
| `V1`…`V6`      | Version bands. §44 defines what each one means by "done"                                 |

## The sections that carry the most weight

### Architecture and boundaries

**§1.2 — dependency direction.** `core`, `events`, `config` and `policy` are
innermost. `browser/*`, `discovery/*` and `collectors/*` sit in the middle.
Everything from `correlation` rightward — `api-model`, `workflows`,
`state-model`, `coverage`, `attack-surface` — consumes a recorded event log
**with no browser present**, which is why those packages can be tested against
a literal array of events in milliseconds. `apps/cli` may import anything.

**§2, §2.4 — modularity contract.** Packages expose a public entry point;
consumers may not deep-import internals. Enforced by an eslint rule.

**§32.10 — the browser is confined.** `puppeteer-core`, `launchBrowser` and
`withBrowser` may only be imported inside `packages/browser/**`. Enforced by
`no-restricted-imports`.

### Safety

**§7.2 — report, never perform.** Forms are reported and never submitted;
destructive operations, including WebMCP tools like `deleteAccount`, are named
and never invoked.

**§7.3 — barriers are never circumvented.** No code path may attempt to get
past a CAPTCHA, WAF challenge, bot detection or authentication control, and no
remedy string may suggest one. A barrier is reconnaissance data.

**§7.4 — authorization gate.** A scan requires an explicit acknowledgment
before it starts, and records it in the session. With no terminal to ask in,
it refuses rather than assuming.

**§5.1, §5A.2 — every action is checked before it happens.** The Policy
Engine decides, and a click that may change application state is classified
before it is pressed.

**§12.1 — secrets come from the environment only**, never from CLI arguments
or inline in a profile. **§12.2** — MFA bypass is never supported.

**§37.2 — the output directory is unredacted and owner-only.** The session
directory is created `0700` before a byte is written. Redaction applies at the
boundaries that leave the machine — reports, exports, model prompts — not to
the event store.

### Evidence and honesty

**§13.1, §13.2 — the envelope sequence is the ordering authority.** Not
timestamps, which are not monotonic across processes.

**§15 — causality is never inferred from timing.** Two requests that fired
together are not a chain. Relationships are graded: `direct`, `inferred`,
`temporal`, `sequence_candidate`, `dependency_candidate`, and every edge states
a basis a reader can check. `depends_on` is built from observed value flow and
records _which field_ flowed, never what was in it.

**§14 — context on every observation.** A request carries the page,
navigation and interaction it belongs to.

**§12.3 — auth context is never absent.** Every observation records which
identity saw it.

**§35B.5 — everything traces back.** Every derived object carries
`source_event_ids` that resolve in `events.jsonl`. A derived object without
resolvable source IDs is a bug; `validateSurface` refuses a model where the
chain does not resolve.

**§24 — provenance vocabulary.** `observed`, `imported`, `correlated`,
`derived`, `inferred`, `static_context_inferred`, `hypothesis`. Observed fact
and AI inference are never blurred.

**§45 — no silent loss.** Anything dropped, skipped or truncated is counted
and surfaced, in the place a user actually looks.

### Traffic, workflows and state

**§17A — classify, never drop.** Every request gets a role
(`application_api`, `application_asset`, `analytics_telemetry`,
`polling_heartbeat`, …) from deterministic structural signals — **§17A.2** —
and the role decides which consumer sees it — **§17A.3**. Only
`application_api` traffic reaches workflow detection. The raw event stays in
the store whatever its role.

**§18.1 — workflow candidates.** Nine boundary signals in three strengths, six
construction steps, and five named false-positive controls: polling clustered
into a fake workflow, analytics as a workflow step, ID-varying instances as
near-duplicate workflows, one giant SPA workflow, and parallel requests
mistaken for a chain. Each control has a test; see
[m3-gate.md](m3-gate.md).

**§18.2 — naming is a separate job.** AI may rename, group and explain
candidates; it may not create, delete or re-cut them.

**§16 — soft navigation.** A SPA route change is a navigation even though no
document loaded.

**§19 — state model.** State names come from evidence in the log, never
invented.

**§9.5 — route templates.** `/orders/1` and `/orders/2` are one route with one
handler.

### Discovery and analysis

**§8.3 — budget arithmetic is shown, not implied.** Interacting limits cannot
be reasoned about in your head; `config validate` prints the effective budget
and says which limit binds.

**§8.5, §8.6 — discovery rules and barrier handling.** A 429 or 403 is a
recorded barrier and the scan continues.

**§10A, §10A.3 — JS-mined candidates carry provenance** — the script, line
and column they were found at — and stay candidates until runtime confirms
them.

**§10B.9 — analysis is bounded.** A malformed or oversized bundle degrades to
partial findings rather than failing the scan.

**§10C — measurable, explainable coverage**, not a false promise of 100%
discovery. Thirteen dimensions and nine statuses, because "not covered"
conflates conditions that call for different responses. **§10C.6** — never
claim complete coverage; the score is capped below 1 and carries a caveat that
travels with the model. **§10C.7** — every gap has a typed reason and a
response.

**§10D.1 — crawler substitution at three levels**: pipe any crawler's URLs in,
declare one in config, or write an adapter.

### Output and interfaces

**§21 — WebMCP behind an adapter.** The spec is young; its shape stays
isolated so it cannot ripple outward.

**§22.2, §22.3 — session layout and event store growth control.**

**§23 — published JSON Schemas** are a contract. CI regenerates them from the
TypeScript definitions and fails if they diverge.

**§30 — the command surface carries the safety boundary.** `scan` observes and
analyses and can never cause a browser action of its own choosing. `agent`
decides, explores and analyses.

**§33 — a budget-bound stop is a normal outcome**, not a failure.

**§35B.2 — the report's section order is fixed**, so two runs diff cleanly.

**§36.1, §36.2 — deterministic fixtures and golden outputs.** Fixture
applications have no clocks, no randomness and no external calls, so
byte-for-byte comparison means something.

**§41 — payload and body-capture policy.**

**§44 — what each version means by "done."** The milestone gates in
`tests/gate/` are these clauses made executable; what each one proved, and did
not, is in `m1-gate.md`, `m2-gate.md` and `m3-gate.md`.
