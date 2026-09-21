# @browserrecon/collector-navigation

Navigation as a first-class object: `from`, `to`, `navigation_id`,
`interaction_id`, `kind`. Build plan §16, §16.1; dev plan BR-M1-07.

## Owns

- Joining the events around a URL change into §16.1's navigation object.
- Telling a document load from a route change, and one kind of route change
  from another (`kind.ts`).
- Attributing a navigation to the interaction it followed, where one exists.

## Does not own

- Observing the change. Telemetry emits `navigation_committed` and
  `soft_navigation`; this derives from them.
- Workflow boundaries — BR-M3-01.
- Producing interactions — BR-M1-08. This consumes the `interaction` event,
  so the two can be built in either order.

## Why soft navigations are the point

A request-oriented scan sees one document load and concludes the application
has one page, while the user moved through four screens and the app called
three different APIs. Everything after the first load is invisible to it.
Soft navigations are where a single-page application keeps its structure, so a
tool that cannot see them cannot model the application.

## Chrome's own label cannot be used

`Page.navigatedWithinDocument` carries a `navigationType`, and the obvious
implementation reads it. Measured against a real SPA, it does not say what it
appears to:

| Action          | Chrome's label | Actually                                  |
| --------------- | -------------- | ----------------------------------------- |
| `pushState`     | `historyApi`   | push                                      |
| `replaceState`  | `historyApi`   | replace — **indistinguishable**           |
| `location.hash` | `fragment`     | hash                                      |
| back / forward  | `fragment`     | traverse — **even when the path changes** |

So a back button moving from `/app/orders` to `/app/auto` is reported as a
fragment change. Believing it would put a traversal in the log as a hash edit,
and §18's workflow boundaries would draw the wrong line.

## What is used instead

The Navigation API's position in session history, read at the moment of the
change. The index and entry count separate all four cases:

| Change          | index | entries | Meaning                                              |
| --------------- | ----- | ------- | ---------------------------------------------------- |
| `pushState`     | +1    | +1      | push                                                 |
| `replaceState`  | same  | same    | replace                                              |
| `location.hash` | +1    | +1      | hash — a push whose URL differs only in its fragment |
| back / forward  | moves | same    | traverse                                             |

It is a **read, not a hook**. Wrapping `history.pushState` would report the
call directly, but it modifies the page a scan is supposed to be observing and
a site can tell the difference. Reading two properties changes nothing.

The position is also read when a document _commits_, because a fresh document
does not reset the entry count — navigating from `/a` to `/b` leaves two
entries, not one — so the baseline cannot be assumed. Without that read the
first route change of every document fell back to the weaker label, which was
exactly what happened before it was added.

Where the Navigation API is unavailable — a sandboxed frame, an older Chrome —
`subtypeBasis` says `cdp_label`, so a consumer knows it has the weaker answer.

## Attribution is a candidate, not a proof

§16.1 wants the interaction that caused a navigation. Chrome does not report
one: `Page.navigatedWithinDocument` carries a frame and a URL and nothing else.
The link is therefore made by recency — the last interaction **in the same
frame**, cleared by every navigation so one click cannot claim two — and §15
is explicit that causality must not be inferred from timing alone.

So it is recorded with `attributionBasis` and never presented as certainty, and
a navigation that followed no interaction is left **unattributed** rather than
given the nearest one. Handing out the nearest interaction regardless is the
mistake that makes an attribution field worse than no field: a reader cannot
then tell a real link from a guess.

## Boundaries

See the dev plan §1.2 (dependency direction) and §2 (modularity contract).
Consumers import from the package root only — deep imports are an eslint error.
