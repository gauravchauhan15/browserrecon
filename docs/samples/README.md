# Reference outputs

Every file in this directory was written by a real scan, by a real Chrome,
against a fixture application in this repository. Nothing here is illustrative
or hand-written — a sample somebody typed describes what the tool is supposed
to do, and the point of keeping these is to see what it actually does.

Regenerate them with:

```bash
pnpm build && node scripts/make-samples.mjs
```

Two things are normalised, and only two: the fixture's port, which the OS
picks per run, and the session directory in the paths. Durations, counts, ids,
ordering and wording are exactly as the tool wrote them.

## What is here

| Directory       | Fixture                                                         | What it shows                                            |
| --------------- | --------------------------------------------------------------- | -------------------------------------------------------- |
| `dynamic-site/` | A SPA whose orders API lives in a chunk loaded on click         | Workflows, state transitions, JS assets, click discovery |
| `webmcp-site/`  | A shop that registers three tools with a WebMCP-shaped registry | The WebMCP section, including a destructive tool         |

Each directory holds:

| File                  | What it is                                                            |
| --------------------- | --------------------------------------------------------------------- |
| `report.md`           | The report a person reads                                             |
| `surface.json`        | §23's scanner-consumable model — one item per thing on the surface    |
| `attack-surface.json` | The full export: every request observed, with its role and context    |
| `events.head.jsonl`   | The first twenty raw events, so the model can be traced to its source |
| `terminal.txt`        | What the scan printed while it ran                                    |

Only a fixture's `events.jsonl` is ever committed. §22.1 keeps the event store
raw and local by design: on a real target it holds cookies, tokens,
authorization headers and request bodies.

## Reading them

Three things are worth checking in any report, including one from your own
target:

**The API inventory is application APIs.** Not pages, not scripts, not
favicons. `dynamic-site` serves eight routes and two bundles and its inventory
has three entries, because three of the things it fetched were endpoints. The
full record of everything the browser requested is in
`attack-surface.json`, where each entry carries the role §17A gave it.

**Every number reconciles with the one above it.** The coverage table shows
the dimensions the score was computed from, so a score of 0.78 has nine rows
explaining it. The terminal summary, the report and `surface.json` count the
same things.

**Nothing claims completeness.** The score is capped below 1 by construction,
the ratio column says what it is a ratio _of_, and the caveat is the same
sentence in all three places it appears.

## What a live site adds

These fixtures are small and deliberately so — each exists to make one
behaviour testable. A real application differs in ways worth expecting:

- **Coverage gaps will not be empty.** Section 8 is empty here because the
  scans reached everything they found. On any real site the budget runs out,
  paths are excluded, and forms are declined; each gets a typed reason and a
  remedy.
- **Access barriers may not be empty.** A 401, 403, 429, WAF challenge or
  CAPTCHA is recorded there. None of them is ever circumvented (§7.3).
- **Third-party origins appear.** Section 5 has one row here. A real site has
  analytics, fonts, widgets and a CDN, and their classification is what keeps
  them out of the API inventory and out of workflow detection.
- **Workflow confidence should be higher.** The one candidate here scores 0.30
  because three GETs behind one click is not much evidence. A real checkout —
  navigations, dependencies, state transitions — is what the confidence
  weights were written for, and nothing has yet been scanned that produces one.
