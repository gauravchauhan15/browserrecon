# 🚦 M3 gate — V3: deterministic intelligence

Dev plan BR-M3-12; build plan §44 (V3).

Executable at `tests/gate/src/m3.gate.test.ts`. As with M1 and M2, this
records what was proven and — at more length — what was not, and what the
gate found on the way.

## The claim

Deterministic workflow, state and API graphs exist **before any AI does**;
§18.1's five false-positive controls hold; coverage reports honestly and never
claims completeness; the attack-surface model is documented, versioned and
self-validating, with WebMCP integrated into it.

## Proven

| Criterion                                        | How                                                                                                                                                            |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deterministic workflow/state/API graphs          | One real scan of `dynamic-site` assembles all four graphs; every state transition is `derived`, every workflow candidate carries the evidence that scored it   |
| …before any AI exists                            | Every surface item is `observed`, no item carries a semantic layer, and the coverage score's provenance is `deterministic`                                     |
| **Control 1** — polling is not a workflow        | Six heartbeats at a five-second interval are classified `polling_heartbeat` and never reach the API model or a candidate's routes                              |
| **Control 2** — analytics is not a workflow step | A live scan of `noisy-site`: five beacons and five vendor scripts are absent from the surface and from every candidate, while `/api/catalog` survives          |
| **Control 3** — ID-varying instances             | Forty calls to `/api/orders/{n}` become one API, one route, one surface item                                                                                   |
| **Control 4** — one giant SPA workflow           | Five soft navigations cut a session into at least three candidates, none of them large                                                                         |
| **Control 5** — parallel is not a chain          | A live scan of `parallel-site`: no dependency edge between concurrent requests, and no candidate credits one                                                   |
| Coverage never claims completeness               | Score capped below 1 on a real scan, no "100%" or "complete" in its description, the §10C.6 caveat travels on the model, and an empty dimension scores nothing |
| Attack-surface documented, versioned, validating | `surface.json` on disk matches the published schema version; `validateSurface` returns clean for it and rejects it with an empty known-id set                  |
| §35B.5 chains resolve                            | Every link of every surface item's chain resolves against the log that scan wrote — walked, not asserted                                                       |
| WebMCP integrated                                | A live scan of `webmcp-site` puts all three registered tools in the surface and in the report, each with source event ids, and none is invoked                 |
| The artifacts say what the model says            | `report.md`'s inventory, coverage table, workflows, WebMCP tools and file list are read back and checked against the model that produced them                  |
| Three runs byte-identical after normalisation    | Three consecutive scans of `parallel-site` produce identical APIs, states, workflows, surface, score and coverage                                              |

## What the gate found

Building it found **defects that all 1721 existing tests were green for** —
five in the model, and then, once the gate started reading the files a person
opens rather than the model behind them, a further six in the reporting layer
(below). Every one was at a seam: two components each describing the same
payload, both self-consistent, disagreeing with each other. That is the only
thing this file exists to catch, and it is worth recording that it caught five.

**1. A page is not an endpoint.** A scan of the six-page `dynamic-site`
reported ten APIs. Six were the HTML pages the crawler had navigated to, and a
seventh was a 404 favicon. §17A's `application_api` verdict has always carried
the signal string "first-party request with an application payload" — and
nothing checked the payload. Everything downstream inherited it: the surface
listed documents as endpoints, coverage counted them as runtime APIs, and
workflow segments were padded with page loads, which is what lifted one
fixture's candidate above the confidence threshold.

Fixed by reading the CDP resource type: a `Document`, `Script`, `Image` or
`Other` is a browser resource unless the response carries structured data, in
which case it is an API whatever the browser called the fetch. An absent
resource type changes nothing, so telemetry that never recorded one loses no
real endpoint. `dynamic-site`'s inventory went from ten to three, all real.

**2. Nothing has ever been classified as polling.** §17A.2's heartbeat rule
needs an interval and its jitter. The model passed a running repeat count and
no interval, and `looksLikePolling` returns false on its first line when the
interval is absent — so no scan in the project's history has filed a single
request as `polling_heartbeat`. Its own unit tests pass because they hand the
classifier an interval directly.

There was a second half to it. A bucket takes the role of its first
observation and never revises it, so even a correct running count could not
have promoted anything: by the third call, where a heartbeat first becomes
recognisable, the endpoint is already an `application_api` with two
observations recorded. Fixed by measuring repeat statistics over the whole log
in a pass of its own, so the verdict is a property of the endpoint and every
observation of it classifies identically.

**3. A vendor's `session-replay.js` was the application's auth
infrastructure.** `AUTH_PATHS` matches a substring, and `session` is in
`session-replay.js`. The check runs before the asset check, deliberately — a
token refresh repeats on a timer and would otherwise be filed as a heartbeat.
Fixed by skipping it for asset content types only: `text/html` is not an asset
type, so a login page is still auth infrastructure, which is what §17A.3 wants
visible to workflow detection.

**4. One caveat, said twice, differently.** `COVERAGE_CAVEAT` and
`SURFACE_CAVEAT` were two sentences making the same §10C.6 promise in
different words, and a report can print both. Now one constant, defined with
the score that needs it.

**5. A shared fetch wrapper defeats §18.1's SPA control.** `shouldMerge` had
already been narrowed once — from the script _file_ to the top _frame_ —
because a single-bundle application initiates every request from `app.js`, so
matching on the file merges a whole scan into one candidate. That is §18.1's
own "one giant SPA workflow" failure mode, produced by the step meant to
prevent it.

It shares a top frame too, as soon as it has an `api.get()`. That is most
applications. The gate's SPA log — five screens, five soft navigations — came
back as one candidate. Fixed by comparing the whole chain, which is what
"share an initiator chain" says. Probed: top frame alone gives 1 candidate,
the chain gives 5.

The gate's own synthetic log now uses a two-frame stack — a shared wrapper on
top, the screen's caller beneath — because a log where every call has one
identical frame quietly tests something easier than reality.

## The model was right and every artifact was stale

The gate above passed in full while `report.md` was still, in the same run:

- listing the six HTML pages and the 404 favicon as APIs,
- printing "Pages 7 of 7 — 100%" as its coverage summary,
- saying "_No workflows were detected._" with a candidate in the model
  beside it,
- carrying empty `workflows`, `api_sequences`, `javascript` and
  `coverage_gaps` arrays in `attack-surface.json`, after two milestones of
  building all four,
- pointing at an `events.jsonl` that does not exist, because the store writes
  numbered segments,
- and warning that `.output/` holds unredacted data while the session it had
  just written sat somewhere else entirely.

None of it was wrong about the engine. The reporting layer had not been
rewired since M1, and every gate test until now read the model rather than
the file a person opens. A model nobody reads is not the deliverable, so the
gate has a section that reads the artifacts — and it is the section that
found all of the above.

Three further defects came out of producing one sample report and reading it:

**Four wordings of one promise.** §10C.6's caveat existed as its own sentence
in the coverage package, the JSON exporter, the surface model and the
terminal summary. A single run printed two of them, which reads as the tool
hedging twice about different things. One constant now, in the module that
owns the score it qualifies.

**A score nobody could reconcile with the table above it.** The coverage
table was three counts assembled at the call site — Pages, APIs, Origins —
each showing 100%, printed directly beneath "Coverage score 0.60". The score
is computed from §10C.1's dimensions, so the dimensions are what the table
shows.

Two of those dimensions were never populated at all: a scan that fetched and
captured two bundles reported `js_asset 0` and `first_party_js 0`, and the
score docked itself 0.2 for JavaScript it had collected. The same for
`route`, with seven pages visited. The fixture's honest score moved from 0.60
to 0.78 once the model could see what the scan had actually done.

**Two section nines and no section six.** Inserting the WebMCP section at
position four renumbered five headings, and the renumbering was done by hand
and half-done: the JavaScript table shipped under a heading reading `## 9.
Artifacts`. Headings are now numbered from their index in `SECTION_ORDER`,
and the gate finds sections by name — a test pinned to `## 5. JavaScript`
reads the wrong section after an insertion and passes anyway, which is worse
than failing.

## Every scan was session one

Writing the Gate A runbook meant running the commands in it, which is how
this was found: the session ordinal was hardcoded, so every scan was
`sess_0001`, and a second scan into the same `--out` died on the event
store's own guard — "already holds session sess_0001" — as an internal error
with a stack trace. The guard was right; two scans were about to share one
log.

Pointing every run at one output directory is the natural thing to do, and
the runbook says to, so this was the second command anybody would have run.

Under it was a second one. `EventBus` keeps its own `IdFactory` for event
ids, and it was hardcoded to ordinal 1 as well. While both were, they agreed
by accident. The moment the directory could be `sess_0002`, its events still
said `sess_0001` — so every `source_event_ids` in the second scan resolved
against the first scan's session, which is §35B.5 broken in the quietest
possible way. One ordinal now, passed to both.

The gate runs two scans into one directory and checks that each keeps its own
log with its own session id.

## A benchmark that measured the machine

`spike.bench.test.ts` bounds tree-sitter at ten seconds for a 7.3 MiB bundle,
against a measurement of ~730 ms. It failed at 50.5 s in the full suite and
passed at 3.6 s alone, on the same laptop and the same commit: the suite runs
several headless Chrome instances alongside it, and a wall-clock bound
measures how busy the machine is.

Its own module note predicted this — "a tight bound would fail on a loaded CI
runner and teach everyone to ignore it" — and then the test was written with
one anyway. It measures CPU time now, which is the parser's cost and is what
§10B.9 is about. Time spent waiting for a core is not the parser's.

## WebMCP was built and never run

`@browserrecon/collector-webmcp` has existed since BR-M1-24 and is thoroughly
unit-tested. It is a bus consumer: it reads `webmcp_tool_discovered` events.

**Nothing emitted them.** There was no browser-side read of the page's
registry anywhere in the runner, so the collector had never seen an event
outside its own tests, and §44's "WebMCP is integrated into the attack-surface
model" could not have held at any point.

The harvest now reads the registry — `navigator.modelContext`, `navigator.mcp`
and `window.agent`, whichever answers — and the runner publishes one
`webmcp_tool_discovered` per tool, deduplicated by origin and name because an
SPA re-registers on every screen. It is bounded (100 tools, 8 KB per schema):
a page controls what is in its registry, and the alternative is serialising
whatever it likes straight into the event log.

Absence stays silent. Almost no site has this, and a collector that explained
itself on every scan would be noise on every scan.

## The report was two milestones behind the model

Found after the gate passed, while producing a reference report for review —
which is why `docs/samples/` exists now and is regenerated from real scans.

Every criterion above was green while `report.md` still listed the six HTML
pages and the 404 favicon as APIs, printed "100%" in its first table, said
"no workflows were detected" with a candidate sitting in the model beside it,
showed no JavaScript, and pointed at an `events.jsonl` that does not exist —
the store writes numbered segments. The terminal summary reported thirteen
APIs for a fixture with three.

The reporting layer had not been rewired since M1. The engine was right and
every artifact a person reads was stale, because the gate asserted the model
and never opened the files.

Fixed, and now asserted: the report's inventory is the classified API model,
its coverage table is the dimensions the score was computed from, its
workflows are the candidates, its gap table uses §10C.7's own remedies, and
its artifact list is read from disk. `attack-surface.json` carries each
request's role and the derived workflows, sequences, JavaScript and gaps.

Two more things fell out of it:

- **A fourth and fifth wording of §10C.6's caveat.** The coverage package, the
  JSON exporter, the Markdown header and the terminal summary each had their
  own sentence. One constant now, in the package that owns the score.
- **A WebMCP section in the report.** §35B.2 pins nine sections; this is a
  tenth, sitting with the API inventory. `surface.json` listed three
  registered tools including `deleteAccount`, and the report a person reads
  mentioned none of them.

## The polling fix had to be made deterministic twice

Classifying a heartbeat needs an interval, and an interval comes from
wall-clock timestamps — so the first version made the verdict depend on how
fast the machine was that day, and §36.2's three-identical-runs gate caught
it: the same fixture came back `polling_heartbeat` on one run and
`application_asset` on the next.

Two structural fixes, neither of them a tolerance:

- **A heartbeat has a period.** Requests milliseconds apart are a page load
  firing everything at once, and at that scale relative jitter is scheduler
  noise — gaps of 2ms and 3ms score 0.2, well inside the tolerance. One
  second is the floor.
- **A repeated asset is an asset.** A stylesheet fetched once per page repeats
  at the interval between page visits with the evenness of a crawler. The
  asset checks now run before the polling check, so only something carrying
  an application payload can be a heartbeat.

## Where the five controls are tested, and why it differs

Three are asserted against a live browser scan — analytics, parallel requests,
and (through the fixtures' own page loads) documents. Two are asserted by
assembling a constructed event log: a timer running long enough to establish
an interval, and an SPA deep enough to run away, are not things a fixture
produces in a browser under a read-only policy within a page visit.

That is not a weaker test of the pipeline. §1.2 requires everything from
correlation rightward to run against a recorded `events.jsonl` with no browser
present, and `assemble` does exactly that in both cases. It is a weaker test of
the **telemetry**: nothing here proves Chrome reports a `pushState` the way the
constructed log says it does. `soft_navigation` emission is covered in
`packages/browser/telemetry-cdp`; the join between the two is not covered by a
live scan anywhere.

## Not proven, and worth stating

- **No live site has been scanned.** Gate A, which is next, is the first
  contact with anything that is not a fixture. Everything above is true of
  eleven deterministic local applications.
- **Coverage's denominator is what the scan found.** A score of 0.6 means 60%
  of what this scan could see was observed. It says nothing about the
  application, which is exactly what §10C.6's caveat says — but a reader who
  skips the caveat will read it as a percentage of the app.
- **Workflow confidence dropped when the inventory got honest.** Removing
  documents from `dynamic-site`'s API model took its one candidate from 0.55
  to 0.30, below the threshold, so it is now exported as low-confidence. That
  is the truthful answer for three GETs behind one click; it also means the
  fixtures no longer produce a high-confidence workflow, and the confidence
  weights have not been exercised against one that should score well.
- **The workflow graph has no edges on any fixture.** No fixture produces two
  candidates that relate to each other, so `buildWorkflowGraph`'s six
  relationships are unit-tested only. The gate asserts the vocabulary of what
  edges exist, not that any were produced.
- **State names come from route segments.** `/settings` becomes
  `viewing_setting` — the singulariser at work, and it is not wrong so much as
  slightly ugly. Nothing depends on the name's prose.
- **No authenticated scan.** Still no fixture with a login form, so the state
  model has never seen an auth transition on the wire and every observation in
  every gate scan is `anonymous`.
- **Seven flags parse and are then ignored.** `scan --help` is generated from
  the configuration schema, so it advertises settings the engine has not been
  wired to: `--import-urls`, `--seed-from`, `--probe-liveness`, `--max-steps`,
  `--ai`, `--model`, `--ai-endpoint`. Three of them have implementations that
  nothing calls; the AI ones are V4. Found by running the Gate A runbook's own
  commands, which is also the only reason the generated help had ever been
  read against the engine. `docs/testing.md` names them.
- **`resume` validates and then refuses.** The §30 boundary check is real and
  reports exactly which setting changed; the engine behind it is not built.
- **Liveness probes and the differential are unexercised end to end.** Both are
  opt-in, both are unit-tested, and no scan has run either.
- **`assemble` is not the CLI's only path to these numbers.** The scan command
  calls it, and the gate calls it directly; a future `export` command that
  reimplements any part of it would not be caught here.
- **The report's prose is not checked, only its facts.** The gate asserts what
  the tables contain and that they agree with the model. Whether the sentences
  around them are the right sentences is a judgement no test makes.
- **Workflow names are route templates.** `reportWorkflows` names a candidate
  after its first route because naming is §18.2's job and needs V4. A reader
  sees `/api/orders/pending` where they will later see "order review", and a
  label invented by the reporting layer would read like a finding.
