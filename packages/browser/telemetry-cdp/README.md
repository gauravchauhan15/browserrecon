# @browserrecon/telemetry-cdp

The observation boundary. Subscribes to raw CDP `Network.*` for every browser
target and normalizes what Chrome reports into envelope events. Build plan
§5.1, §13.1, §41; dev plan BR-M1-03.

## Owns

- Attaching to every target, present and future, without a gap.
- Normalizing `Network.*` into `network_request`, `network_response` and
  `network_failed` payloads.
- Deciding which response bodies to keep (`body-policy.ts`, §41).

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
