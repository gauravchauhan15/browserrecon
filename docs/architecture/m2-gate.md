# 🚦 M2 gate — V2: API context and JS intelligence

Dev plan BR-M2-18; build plan §44 (V2).

Executable at `tests/gate/src/m2.gate.test.ts`. As with M1, this records what
was proven and — at more length — what was not.

## The claim

Requests are correlated to interactions and navigation; initiator
relationships are represented; `caused_by` and `depends_on` exist; API
sequences can be reconstructed; correlation has deterministic tests.

## Proven

| Criterion                                        | How                                                                                                                                           |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime APIs tied to interactions and navigation | Every observation in a live scan carries its page and auth context; the model is built from the log that scan produced, not from literals     |
| Initiator relationships represented              | Script-initiated requests carry a call stack, parsed back into script, line and column                                                        |
| `caused_by` / `depends_on` consistent            | Every edge states a basis and a graded kind; `depends_on` is built from value flow, not adjacency                                             |
| **No false dependency on the parallel fixture**  | `parallel-site` fires four requests in one `Promise.all`; no dependency edge appears between any of them, and they are marked `parallel_with` |
| JS mining yields candidates with provenance      | Endpoints found only in a lazily-loaded chunk, each carrying script and line                                                                  |
| 5 MB+ malformed bundle degrades to partial       | A 5 MB bundle truncated mid-expression returns `partial` with findings from everything before the break                                       |
| Golden outputs stable                            | Three consecutive scans produce an identical model                                                                                            |

## The fixture that makes the dependency criterion mean something

`parallel-site` does both halves deliberately:

- `/parallel` fires four requests in one `Promise.all`. No ordering exists and
  any dependency edge between them is false.
- `/chain` is a genuine chain: `POST /api/orders` returns an id the next
  request cannot be built without.

A fixture with only the first rewards a tool that never infers anything; one
with only the second rewards a tool that infers everything.

## How `depends_on` is derived

Not from adjacency — §15 forbids that, and the failure it prevents is
concrete: a reader told that `GET /api/user` depends on `GET /api/cart` will
try to exploit an ordering that was never required.

Instead, **value flow**: when an identifier in one response turns up in a
later request's URL or body, the second genuinely could not have been built
without the first. The edge is `inferred`, not `direct` — the browser did not
say the two are related; we noticed a value moved.

The output records **which field flowed, never what was in it**. A gate test
asserts the fixture's order id never appears in any basis string.

## What "stable" means here, precisely

The gate compares the model's contents after sorting, not its array order.
`model.apis` is in first-appearance order, and for four requests fired in one
`Promise.all` the order the responses come back in is the browser's business —
this test was observed failing on exactly that, under load, after ten other
scans in the same process.

Arrival order is not something the product promises. What it promises is a
deterministically sorted export, which `toExportedApis` produces and the M1
gate already compares byte for byte. Asserting arrival order here would have
been a stricter claim than anything downstream makes, and the failure it
produced said nothing about the tool.

## Not proven, and worth stating

- **No interaction has ever been attributed end to end.** §14's
  `interaction_id` context is implemented and unit-tested against a literal
  log, but the deterministic explorer's interaction phase is not wired into
  the runner — the scan navigates and harvests; it does not click. So every
  request a real scan sees is load-initiated. There is a gate test asserting
  this is _still_ true, which fails the day it changes.
- **Only `application_api` traffic reaches the model by default.** That is
  §17A.3 and deliberate, but it means the gate says nothing about how well
  the classifier handles an unusual application.
- **`depends_on` sees only identifier-shaped values.** A dependency carried by
  a short or unusual token is missed. Missing an edge is the safe direction —
  the alternative is matching `"ok"` in a response against `ok` in a later URL
  — but it is a miss, not an absence of dependencies.
- **Sequences are not workflows.** They group by page and navigation, which is
  mechanical. Deciding a group is "the checkout workflow" is §18's job in M3.
- **Auth is unexercised against a real login.** Profiles, TOTP and session
  tracking are unit-tested thoroughly; no fixture presents a login form, so
  nothing has logged into anything. BR-M3 adds the fixture.
- **Source maps are parsed but never fetched by a scan.** The lookup works;
  nothing wires it into the runner yet.
- **Fixtures only.** Gate A, after V3, is still the first contact with a real
  site.

## What the gate found

**The initiator test picked a fixture that cannot produce initiators.** It
used `dynamic-site` and failed: no request was attributed to a script. The
code was right — that fixture's calls need a click, and at the time the
runner did not click. The test moved to a fixture that genuinely produces
script initiators with stacks, and the click gap became a recorded limitation
with a gate test asserting it was _still_ true.

That test then failed, on purpose, the day the interaction phase landed —
which is what it was for. It is now the positive assertion it always
anticipated.

**`interactionId` had never once been read correctly.** The API model looked
for `interaction_id` and fell back to the envelope's event id when it was
absent — which it always was, because the interaction collector emits
`interactionId`. The field looked populated on every observation, so nothing
noticed, and every unit test passed because they built events with the
invented key. The gate caught it the first time a real scan produced an
interaction, and the same bug was then found in `chunks.ts`.

The fallback is gone from both. A plausible wrong value is worse than an
absent one, because only one of them gets investigated.

**A `depends_on` test passed for the wrong reason.** It asserted that a
session token is never followed as a dependency, using `/api/login` as the
source — which the traffic classifier excludes as `auth_infrastructure`
_before_ the model is built. The endpoint never reached the code under test,
so the test would have passed with the token rule deleted. Confirmed by
probe, then rewritten with two ordinary application endpoints and a
precondition asserting both are in the model.

That is the second test in this milestone found to be satisfied by something
other than the behaviour it named. Both were caught the same way — by
deleting the code the test claimed to cover and checking the test noticed.

**The secret scanner caught its own test fixtures**, as it did in M0. The
fixtures were rewritten to use the existing sequential-alphabet filler where
possible; two already-committed values and RFC 6238's published TOTP vector
are allowlisted **by value**, never by file, and a probe confirms a realistic
`sk_live_` key planted in those same files is still detected.
