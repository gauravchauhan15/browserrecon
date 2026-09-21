# @browserrecon/fixtures

Local applications a scan can be pointed at without touching the internet.
Build plan §36.1, dev plan BR-M0-13.

## Owns

- The `FixtureApp` contract — an app is a declaration (name + routes), not a
  running server.
- The harness that serves one on an ephemeral loopback port
  (`startFixture`, `withFixture`), including request recording.
- The fixture apps themselves. Every one is listed below with the stories it
  serves, so a fixture that stops being used is visible rather than quietly
  maintained forever.

| App              | What it models                                                                                                                                                                                      | Consumed by                         |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| `staticSite()`   | Multi-page site, a form, endpoints only in JS (one as a concatenation), `robots.txt`, `sitemap.xml`, a relative redirect, a dead reference, four instances of one route template with one diverging | BR-M0-13/14, BR-M1-06/15b/17b       |
| `restApi()`      | Collection, members, a 401-gated admin endpoint, cart → order with a real ordering dependency                                                                                                       | BR-M0-13, BR-M1-04, BR-M1-22        |
| `framedSite()`   | Nested iframes, including one added after load, each making its own requests                                                                                                                        | BR-M1-05                            |
| `realtimeSite()` | WebSocket and SSE, with a fixed message sequence                                                                                                                                                    | BR-M1-08, BR-M1-23                  |
| `spaSite()`      | Client routing: push, replace, hash, traverse, plus one route change with no interaction                                                                                                            | BR-M1-07                            |
| `throttledApi()` | 429 with `Retry-After` on a request counter, a WAF-shaped 403, a 401 auth wall, a chunked slow response, and one endpoint that never answers                                                        | BR-M1-19/20/21, BR-M1-29b, BR-M1-31 |
| `formsSite()`    | Safe GET forms beside destructive POSTs, one of them deliberately mislabelled "Continue"                                                                                                            | BR-M1-13, BR-M1-31                  |
| `dynamicSite()`  | Links injected after load, a genuinely code-split chunk holding two endpoints, "load more"                                                                                                          | BR-M1-11, BR-M1-16, BR-M1-31        |
| `noisySite()`    | Twenty vendor requests around two first-party API calls; vendor origin is injectable                                                                                                                | BR-M1-22, BR-M1-31                  |
| `webmcpSite()`   | A WebMCP tool registry, including one destructive tool, registered without any network traffic                                                                                                      | BR-M1-24, BR-M1-31                  |

Two deliberate holes, stated because a fixture that quietly stands in for
something it does not model is worse than a missing one:

- `noisySite()` serves its vendor assets same-origin unless a
  `thirdPartyOrigin` is passed. Called with no argument it exercises noise
  _volume_ and not cross-origin classification. A test that needs the latter
  starts a second fixture and passes its origin.
- `throttledApi()`'s `/api/slow` uses a real timer. Its bytes are identical
  every run, but its timing is not, so it is excluded from the byte-comparison
  baseline and covered by its own test.

## Does not own

- Normalizing or comparing scan output — that is `tests/golden` (BR-M0-14).
- Driving a browser at a fixture — `packages/browser/*` (M1).
- The §36.1 fixtures V1 does not need yet — authentication flows, MFA, and
  GraphQL. Each arrives with the story that needs it (M2 onward).
- **Circumventing anything.** `throttledApi()` exists so a scan can be shown
  backing off and recording a barrier; §7.3 puts getting past one permanently
  out of scope, and `tests/meta/no-solver.test.ts` enforces it repo-wide.

## The three rules

Every fixture is **deterministic**, **stateless between instances**, and
**offline**. Golden-output comparison (§36.2) is worthless if the fixture can
answer differently on a second run, so these are enforced rather than promised:

| Rule                | How it is enforced                                                                                |
| ------------------- | ------------------------------------------------------------------------------------------------- |
| No clocks or random | `determinism.test.ts` scans this package's sources and fails on `Date.now`, `Math.random`, et al. |
| Byte-identical      | Two separately started instances are compared over raw socket bytes, not parsed responses         |
| Fresh state         | `seedState()` runs per instance; handlers receive state as an argument and never close over it    |
| No egress           | The egress guard from `@browserrecon/test-utils` runs while every app is exercised                |

One field escapes rule two on purpose: a recorded request's `host` header
carries the ephemeral port. It is kept verbatim rather than scrubbed, because a
fixture should not misrepresent what arrived — so anything snapshotting a
recorded request has to mask it. BR-M0-14's normalizer does.

Three traps are easy to fall into and each has a test:

1. Node stamps a `Date` header on every response unless `sendDate` is off.
2. `Keep-Alive: timeout=N` follows the server's keep-alive timeout, whose
   default has changed between Node releases — so it is pinned.
3. Any absolute URL in a redirect, a sitemap or a page body would embed the
   ephemeral port, which differs per run by design. Everything is relative.

## Why not Express

The dev plan said Express. These apps serve fixed strings through about a dozen
routes, and Express would add roughly thirty packages to the tree — each one
vetted by the license gate and trusted by every contributor — to replace forty
lines of routing in `harness.ts`. The later fixtures need hand-written
behaviour, not middleware. `FixtureApp` says nothing about how it is served, so
reversing this costs one file.

## Boundaries

See the dev plan §1.2 (dependency direction) and §2 (modularity contract).
Consumers import from the package root only — deep imports are an eslint error.
