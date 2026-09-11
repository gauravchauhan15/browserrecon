# @browserrecon/telemetry-cdp

The observation boundary. Subscribes to raw CDP `Network.*`, `Page.*`,
`Runtime.*` and `Debugger.*` for every browser target and normalizes what
Chrome reports into envelope events. Build plan §5.1, §13.1, §16, §41; dev plan
BR-M1-03, BR-M1-04.

## Owns

- Attaching to every target, present and future, without a gap.
- `Network.*` → `network_request`, `network_response`, `network_failed`.
- `Page.*` → `navigation_started`, `navigation_committed`, `page_loaded`, and
  the frame tree every payload is attributed against.
- `Runtime.*` → `js_execution_context`, and the live-context map.
- `Debugger.scriptParsed` → `script_parsed`, the JS inventory.
- Deciding which response bodies to keep (`body-policy.ts`, §41).

All four domains share **one** attachment. Two `Target.setAutoAttach` calls on
the same browser would fight: the second replaces the first's settings, and
only one would ever hear about a new target.

## Does not own

- Causing the browser to do anything — that is `@browserrecon/browser-adapter`.
- Classifying what a request _is_ (§32.1: observation is separate from
  interpretation). Polling, beacons and API sequences are BR-M1-22 and BR-M2-01.
- Persistence. Events go to the bus; the event store is subscribed elsewhere.

## Why raw CDP rather than the MCP network tools

§5.1's central decision, and the reason this package exists at all. Chrome
DevTools MCP's network tools answer "what happened recently" — pollable,
window-bounded, scoped to the last navigation. That is the right shape for a
model glancing at a page and the wrong shape for an event store whose
`caused_by` graph is only sound if nothing was missed.

The test that justifies it fires **150 concurrent requests** and asserts each
appears exactly once, with a response matched by CDP request id.

## Attaching without a gap

The obvious approach — listen for puppeteer's `targetcreated`, create a
session, enable `Network` — has a race, and it is not theoretical. Measured
during this story: a page created and navigated in the same tick lost its
document, its script and its favicon, because those steps are all async and the
page was already fetching.

`Target.setAutoAttach` with `waitForDebuggerOnStart` closes it at the protocol
level: Chrome pauses each new target until we release it, so `Network.enable`
is in place before the target runs a line. Attaching to the browser rather than
to a page also means telemetry is never handed anything by the control layer —
§5.1 requires switching drivers to change nothing about what is captured, and a
tab the _site_ opens for itself is observed the same as one the explorer
opened.

## Frames are not a detail

Every Page payload carries `frameId`, `parentFrameId` and `isMainFrame`, and
network requests carry the frame that issued them. The error this prevents is
not cosmetic: a scan that merges an iframe's activity into the top document
reports a third-party widget's endpoints as the target's own attack surface,
and one that drops frames misses the surface that exists. Neither is
recoverable later, because the evidence for the distinction was never written
down (§32.1).

The main frame's identity is read from `Page.getFrameTree` **at attach**, not
inferred from the first `frameNavigated`. Inferring it is too late: a fresh
target starts loading before anything has said which frame is the top document,
so every main-frame navigation was being reported as a subframe until this was
fixed.

## Navigation ids are allocated, not derived

CDP has no single identifier spanning a navigation's start and its commit —
`frameRequestedNavigation` names a frame and a URL, and the loader id only
exists once the navigation has committed. So an id is allocated when a frame
starts moving and carried through, which is what makes the pair joinable for
BR-M1-07's soft-navigation work and §18's workflow boundaries.

## Execution contexts must not leak

Chrome reuses context ids. A stale id left in the map after a navigation
attributes the new page's scripts to the old page's context, and the error is
invisible — everything still has _an_ id. So `executionContextDestroyed`,
`executionContextsCleared` and frame detachment all prune the map, and
`stats.liveExecutionContexts` is the signal: a count that only grows across
navigations means ids are leaking.

## Scripts, not files

`Debugger.scriptParsed` exists in this package because the network and the
debugger see different things. The network sees _files_; this sees _scripts_ —
inline blocks, `eval`, `new Function`, anything a bundler injects at runtime.
§10A's mining has nothing to read for those unless they are inventoried here.
It does mean enabling the Debugger domain, which instruments V8, so
`inventoryScripts: false` turns it off for a scan that only wants network data.

## What every event carries

Three fields exist for reasons that are easy to lose in a refactor:

**`remoteIpAddress`** — the address Chrome actually connected to. The Policy
Engine cannot prevent DNS rebinding: it resolves a hostname, and Chrome
connects separately moments later. Its own comment says the durable mitigation
is post-hoc detection _here_, so this field is the only evidence such a
mismatch ever leaves.

**`requestHeadersSent`** — what went on the wire, from
`requestWillBeSentExtraInfo`, as opposed to what the page asked for. For a
recon tool the difference — cookies, headers the network stack adds — is the
point.

**`initiator`** — type, script URL, line, column and a flattened stack, taken
from Chrome. §15 forbids inferring causality from timing, so this is the only
sound basis for a dependency edge.

## Body capture (§41)

<!-- generated from BODY_CAPTURE_RULES; a test fails if this drifts -->

| Content type                                                                                 | Body          | Why                                                                             |
| -------------------------------------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------- |
| `^application\/(json\|.*\+json)`                                                             | captured      | API responses are the attack surface this tool exists to model (§15).           |
| `^(text\/javascript\|application\/(javascript\|x-javascript\|ecmascript))`                   | captured      | Endpoints reachable only by parsing JS (§10A) are invisible without the source. |
| `^text\/html`                                                                                | captured      | Forms, links and inline script are read from the markup.                        |
| `^(text\/plain\|text\/css\|application\/xml\|text\/xml\|application\/x-www-form-urlencoded)` | captured      | Small, occasionally carries endpoints or configuration.                         |
| `^(image\|font\|audio\|video)\/`                                                             | metadata only | §41: metadata only. Bulk with no recon value, and the bulk is the problem.      |
| `^application\/(octet-stream\|pdf\|zip\|gzip\|wasm)`                                         | metadata only | Opaque binary. Nothing downstream reads it, and it is usually large.            |

Two independent limits, because they fail differently: a **per-body cap** stops
one 40 MB bundle dominating the log, and a **per-scan budget** stops ten
thousand small bodies doing it slowly. Hitting either is recorded on the event —
`skipped: "too_large"` and `skipped: "budget_exhausted"` are different facts,
and both differ from a response that genuinely had no body.

## Limits worth knowing

**`drain()` is a settle, not a guarantee.** It waits for a quiet period with no
new CDP event before flushing, because draining the internal queue alone would
promise more than it delivers — Chrome may still be about to report a
`loadingFinished` for a request that completed a millisecond ago. Nothing can
promise the browser is finished.

**`orphanEvents` is a completeness signal, not noise.** A response for a
request never seen starting means observation began late. A non-zero count at
the end of a scan means the log is not the complete record it claims to be, so
it is counted rather than dropped.

**Browser-process traffic is still invisible.** Every target is watched, which
covers pages, iframes and workers — but Chrome's own background networking
belongs to no target and cannot be seen from here. That remains guarded by the
launch flags in `@browserrecon/browser-manager`, not by observation. The claim
was overstated once in BR-M1-01 and is stated plainly here instead.

## Boundaries

See the dev plan §1.2 (dependency direction) and §2 (modularity contract).
Consumers import from the package root only — deep imports are an eslint error.
