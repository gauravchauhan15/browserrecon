# @browserrecon/browser-adapter

The control boundary. Every browser action goes through here, and every one is
checked against the Target Policy before it happens. Build plan §5.1, §32.10;
dev plan BR-M1-02.

## Owns

- `BrowserAdapter` — the interface everything above the browser layer uses.
- `PuppeteerBrowserAdapter` — the V1–V4 implementation.
- Deciding whether a click changes application state (`state-changing.ts`).

## Does not own

- Deciding _what_ to do. That is the Deterministic Explorer (BR-M1-12) and,
  from V5, the AI Explorer.
- The browser process and its profile — `@browserrecon/browser-manager`.
- Observing traffic — the CDP telemetry adapter (BR-M1-03), which watches
  regardless of which driver caused the browser to act (§5.1).

## Three guarantees, each enforced mechanically

### 1. Nothing reaches the browser without a policy check

§32.10: _policy validation occurs before browser/agent actions._ Every method
starts with the same check, and the page handle is a genuine `#private` field —
there is no property, cast or structural type that reaches it.

That is worth nothing if a caller can simply get their own browser, so an
eslint rule confines the driver to `packages/browser/**`: importing
`puppeteer-core`, or `launchBrowser`/`withBrowser` from the manager, is an
error anywhere else. `doctor` may still import `resolveChromePath` — knowing
where Chrome lives is not a way to drive it.

The tests prove interception per method by counting what a recording engine was
asked, because an adapter method that forgot to check would still _work_, and
no behavioural assertion would notice.

### 2. The interface names no driver type

§5.1 splits control from telemetry so the thing that makes the browser act can
be replaced — Puppeteer today, Chrome DevTools MCP for the AI Explorer in V5.
That only holds if no Puppeteer type reaches a signature, so a test reads the
**emitted `.d.ts`** rather than the source: a type can leak through an inferred
return type the source never names.

### 3. Denials are typed, never thrown

Every method returns an `ActionResult`: `ok`, `denied`, or `failed`. A scan
spends its life doing things that legitimately do not work, and the three cases
demand different responses — a denial is recorded as a barrier (§8.6) and the
scan continues; a failure means the page changed; an exception would mean the
tool is broken. Collapsing them into `throw` forces every caller into try/catch
to tell them apart.

## State-changing clicks

The Policy Engine refuses state-changing actions unless the policy allows them,
but it cannot tell which clicks those are — that needs the DOM. The obvious
design makes the caller supply the flag, and the problem is the default: a
caller that forgets it on a delete button gets a permissive answer. Defaulting
the other way is no better, because then the read-only policy refuses all
clicking and an explorer that cannot click observes nothing.

So the adapter inspects the element and takes **whichever answer is stricter**.
A caller's `true` is never downgraded; a caller's `false` — or silence — can be
overruled by what the element turns out to be. An element that cannot be read
at all counts as state-changing: refusing costs a recorded barrier, guessing
costs whatever the click did.

The heuristic is deliberately blunt — a submit button, a non-GET form, a
destructive-sounding label, a GET link with an action-shaped query string. It
is allowed to be wrong in the direction of refusing a harmless click.

## Two limits worth knowing

**Redirects are detected, not prevented.** The browser follows them before
control returns, so `navigate` checks the URL first, then checks where it
landed and returns a denial if that left scope. Pre-emptive blocking needs
request interception, which belongs with the telemetry layer (BR-M1-03) where
every request is already being watched.

**The default policy refuses loopback**, so every test here opts in explicitly.
That is the designed behaviour — a tool that will happily be pointed at
localhost is an SSRF primitive — and it is the same step a user scanning their
own dev server has to take. Asserted as a behaviour in its own right rather
than only worked around.

## Boundaries

See the dev plan §1.2 (dependency direction) and §2 (modularity contract).
Consumers import from the package root only — deep imports are an eslint error.
