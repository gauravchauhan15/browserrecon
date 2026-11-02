# BrowserRecon report — http://127.0.0.1:8080

| Field             | Value              |
| ----------------- | ------------------ |
| Session           | sess_0001          |
| Schema version    | 1.0.0              |
| Duration          | 9s                 |
| Rate profile      | normal             |
| Allowed methods   | GET, HEAD, OPTIONS |
| Discovery sources | browser            |
| Auth state        | anonymous          |
| AI mode           | off                |

> High-confidence coverage of the reachable and analyzable application surface under the supplied target policy, authentication state, runtime session, exploration budget and analysis limits. This is not a claim of complete application coverage, and cannot be.

## 1. Coverage summary

**Coverage score 0.78** — 78% of the surface this scan could reach was observed or analysed. This is a proportion of what was reachable under the policy, session and budget in force — not of the application. 1 dimension(s) found nothing to measure and are excluded.

| Dimension               | Observed | Discovered | Ratio |
| ----------------------- | -------- | ---------- | ----- |
| Pages                   | 7        | 7          | 100%  |
| Routes                  | 8        | 8          | 100%  |
| JS assets               | 2        | 2          | 100%  |
| First-party JS          | 2        | 2          | 100%  |
| APIs (runtime)          | 3        | 3          | 100%  |
| API candidates (static) | 2        | 2          | 100%  |
| Workflows               | 0        | 1          | 0%    |
| API sequences           | 1        | 1          | 100%  |
| State transitions       | 6        | 6          | 100%  |
| Origins                 | 1        | 1          | 100%  |

_Ratio is of what this scan discovered, never of what the application has._

## 2. Workflows

<details><summary>/api/orders/pending — low confidence (0.30)</summary>

**/api/orders/pending** (`wf_0001`, confidence 0.30)

| Step | Kind    | Detail                         | caused_by |
| ---- | ------- | ------------------------------ | --------- |
| 1    | request | /api/orders/pending (api_0001) | —         |
| 2    | request | /api/orders/archive (api_0002) | —         |

</details>

## 3. API inventory

| Method | URL                                        | Status | Content type     | Party       | Role            |
| ------ | ------------------------------------------ | ------ | ---------------- | ----------- | --------------- |
| GET    | `http://127.0.0.1:8080/api/orders/pending` | 200    | application/json | first-party | application_api |
| GET    | `http://127.0.0.1:8080/api/orders/archive` | 200    | application/json | first-party | application_api |
| GET    | `http://127.0.0.1:8080/api/rows`           | 200    | application/json | first-party | application_api |

**Found via JS files:** 2 script(s) parsed. 2 endpoint candidate(s): 2 the scan called, 0 correlated with a call, 0 never reached.

## 4. Agentic tools

_This page published no tools to visiting agents._

## 5. Origins

| Origin                  | Requests | Classification |
| ----------------------- | -------- | -------------- |
| `http://127.0.0.1:8080` | 13       | first_party    |

> /home/you/.output/sess_0001 contains UNREDACTED captured data — cookies, tokens, authorization headers and request bodies. Do not commit it, attach it to a ticket, or sync it to cloud storage.
