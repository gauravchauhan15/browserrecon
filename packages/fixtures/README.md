# @browserrecon/fixtures

Local applications a scan can be pointed at without touching the internet.
Build plan §36.1, dev plan BR-M0-13.

## Owns

- The `FixtureApp` contract — an app is a declaration (name + routes), not a
  running server.
- The harness that serves one on an ephemeral loopback port
  (`startFixture`, `withFixture`), including request recording.
- The fixture apps themselves. Two so far:
  - `staticSite()` — a multi-page site with links, a form, a JS file carrying
    endpoints that appear nowhere in the HTML (one only as a concatenation),
    `robots.txt`, `sitemap.xml`, a
    relative redirect, a dead reference, and four instances of one route
    template of which one deliberately diverges.
  - `restApi()` — a collection, members, a 401-gated admin endpoint, and a
    cart → order sequence with a real ordering dependency.

## Does not own

- Normalizing or comparing scan output — that is `tests/golden` (BR-M0-14).
- Driving a browser at a fixture — `packages/browser/*` (M1).
- The remaining §36.1 fixtures (auth, MFA, SPA routing, GraphQL, WebMCP,
  throttling, WAF barriers, slow APIs). Each arrives with the story that needs
  it, per BR-M1-30.

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
