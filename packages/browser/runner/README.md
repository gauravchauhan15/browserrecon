# @browserrecon/browser-runner

Launches a browser, attaches telemetry, and visits pages under policy.

## Owns

- The **browsing phase**: launch, navigate, settle, harvest, drain, relaunch.
  This is the object the orchestrator calls its `BrowsingPort`.
- **Browser-native discovery**: `robots.txt` and `sitemap.xml`, the fallback
  §8.5 rule 3 promises when no crawler is installed.
- Taking a token from the shared bucket **before** telling the browser to go.
  Acquiring afterwards would rate-limit the bookkeeping while the requests
  themselves left at whatever speed Chrome managed.

## Does not own

- **Policy.** It is handed a `TargetPolicy` and builds one `PolicyEngine`; the
  adapter checks every action against it. The runner never decides scope.
- **Sequence or failure handling.** The orchestrator decides what a crash
  means; this reports what happened and throws `RunnerBrowserCrash` when the
  browser itself is gone, as opposed to one page failing.
- **The orchestrator's types.** They are matched structurally, not imported,
  so this layer does not depend on the one above it.

## Why it lives here

Because it holds a `BrowserSession`, and §32.10 confines that to
`packages/browser/**`. The eslint rule caught this code when it was first
drafted in `apps/cli` — a browser handle in the CLI is a path around policy
validation, since every adapter method checks policy and a raw `page.goto`
does not.

## Two things measured rather than assumed

- A visit reports its `outcome` explicitly. Returning an empty success for a
  policy denial made a scan report "complete · 1 of 1 discovered" for a site
  the browser never opened.
- Discovery's `allow` check is **required**. A sitemap index names other
  sitemaps, and those URLs come from the target's response — fetching them
  unchecked is a request the user never authorized, at a URL the target chose.

## Boundaries

See the dev plan §1.2 (dependency direction) and §2 (modularity contract).
Consumers import from the package root only — deep imports are an eslint error.
