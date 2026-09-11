# @browserrecon/browser-manager

Chrome lifecycle: isolated per-scan profiles, launch, and guaranteed teardown.
Build plan §6, §22.3; dev plan BR-M1-01.

## Owns

- Finding a Chrome to drive (`resolveChromePath`) — the single source of truth,
  which `browserrecon doctor` also consumes.
- Per-scan profile directories, their ownership markers, and the sweep that
  reclaims ones left by processes that died (`profile.ts`).
- The launch flag list and the reason each flag exists (`flags.ts`).
- Launching, and closing on every path this process controls (`manager.ts`).

## Does not own

- What the browser _does_. The control interface is `BrowserAdapter`
  (BR-M1-02), and every action it takes passes the Policy Engine first.
- Observing traffic. That is the Runtime Telemetry adapter over raw CDP
  (BR-M1-03), which is independent of whichever driver caused the browser to
  act (§5.1).

## The driver boundary

This is the one package that knows BrowserRecon drives Chrome through
puppeteer-core, and the one place a `puppeteer` type crosses a package
boundary — `BrowserSession.browser`. §5.1 requires the _control_ interface to
be free of them so the driver can be swapped; that interface is built on top of
this in BR-M1-02, and nothing above it should import this package.

**`puppeteer-core`, not `puppeteer`.** The latter downloads a ~150 MB Chrome
during `pnpm install`. §25.2 says BrowserRecon never pulls a large binary on
the user's behalf, and a security tool that fetches its own browser at install
time is asking for trust it has not earned. We drive the Chrome the user
already chose, or say clearly that we cannot find one.

## Isolation

§22.3 in one line: _never share browser state between scans by default_. Every
scan gets its own `--user-data-dir`, destroyed when the scan ends.

That matters more here than in ordinary automation. A scan logs in and collects
session cookies, tokens and local storage from a target the user is authorized
to test. If any survived, the next scan would visit its target carrying the
previous one's credentials, and the observations would be attributed to an auth
context nobody declared (§12.3).

Two independent mechanisms prevent it — separate directories, and removal on
close — which is why the isolation test only fails when **both** are disabled.

## Teardown

| Case                            | Handled by                                                                                                                       |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Caller finishes                 | `withBrowser` closes in a `finally`                                                                                              |
| Caller throws                   | Same, and the original error is preserved                                                                                        |
| Chrome dies on its own          | The `disconnected` event removes the profile and marks the session closed, so a later `close()` is a no-op rather than a hang    |
| `SIGINT` / `SIGTERM` / `SIGHUP` | Synchronous handler kills Chrome and removes the profile — the process is on its way out, so an awaited cleanup would not finish |
| `SIGKILL`, power loss           | **Not handled in-process, and cannot be.** The next launch sweeps profiles whose owning pid is gone                              |

The sweep checks whether the owning process is alive, not how old the directory
is. An age heuristic either reaps a long scan's live profile or leaves a dead
one lying around, depending on how it is tuned.

## Launch flags

Every flag in `flags.ts` is there for one of three reasons, and the comment
beside it says which: **egress** (Chrome talks to Google on startup — component
updates, Safe Browsing, field trials — and that traffic would land in the same
CDP stream BR-M1-03 subscribes to, recorded as the target's attack surface),
**isolation** (no prompts, no shared credential stores), or **determinism** (no
background throttling that makes page behaviour depend on window focus).

Deliberately absent: `--no-sandbox` (the wrong trade for a tool that drives
untrusted pages; a container needing it must say so explicitly),
`--disable-web-security` (would change the same-origin behaviour being
observed), and `--incognito` (the per-scan profile already isolates, and
incognito changes storage semantics a real user would not have).

`--user-data-dir` is **not** in the list. It is passed as puppeteer's
`userDataDir` option so exactly one place decides where a profile lives, and no
caller-supplied argument can redirect a scan at a shared profile.

## A limit worth knowing

`manager.test.ts` proves a _page_ requests nothing off-origin. It does not
prove Chrome as a whole reaches nothing — `page.on("request")` cannot see
browser-level background traffic. That is guarded by the flag list, asserted in
`flags.test.ts`, and becomes genuinely observable in BR-M1-03 where telemetry
subscribes to CDP at the browser level.

## Boundaries

See the dev plan §1.2 (dependency direction) and §2 (modularity contract).
Consumers import from the package root only — deep imports are an eslint error.
