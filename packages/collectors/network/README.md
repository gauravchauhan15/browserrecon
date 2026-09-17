# @browserrecon/collector-network

Joins the three telemetry events for one request into a single observation,
gives every URL a grouping identity, and turns Chrome's error strings into
reasons a consumer can branch on. Build plan §13, §14, §33; dev plan BR-M1-06.

## Owns

- `normalizeUrl` — the identity key two requests to the same endpoint share.
- `classifyFailure` — typed reasons in place of `net::ERR_*` strings.
- `collectNetwork` — the bus subscriber that builds the model.

## Does not own

- Deciding that one request _caused_ another. §32.2 keeps correlation separate
  from collection; joining a response to its own request by CDP id is not
  correlation, it is reassembling one thing that arrived in pieces.
- What an endpoint _means_ — API semantics are BR-M2-01.
- Classifying traffic as analytics, keepalive or application (§17A) —
  BR-M1-22.

## URL normalization is an index, not a replacement

Most URL normalizers are written for caches and crawlers, where the goal is to
collapse anything a server would treat alike. For a security tool that is
exactly the wrong instinct, because the differences a cache may ignore are
often the finding.

Every rule below is either "RFC 3986 says these are the same URL" or "this part
is never sent to the server". Anything needing a judgment call was left out,
and the **raw URL is always kept** — the moment a consumer needs to know
whether the path was `/Admin` or `/admin`, the answer has to still be there
(§37.2).

<!-- generated from NORMALIZATION_RULES; a test fails if this drifts -->

| Rule           | What it does                                                      | Why it is safe                                                                                                                                                                       |
| -------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `scheme-case`  | Lower-case the scheme                                             | RFC 3986 §3.1 declares the scheme case-insensitive.                                                                                                                                  |
| `host-case`    | Lower-case the host                                               | RFC 3986 §3.2.2 declares the host case-insensitive; DNS is too.                                                                                                                      |
| `default-port` | Drop :80 on http and :443 on https                                | RFC 3986 §3.2.3 — an explicit default port is the same authority.                                                                                                                    |
| `fragment`     | Move the fragment out of the identity, into its own field         | A fragment is never sent to the server, so it cannot be part of a server-side endpoint's identity. Kept separately because SPA routing lives there (§16).                            |
| `query-order`  | Sort query parameters by name, keeping duplicates and their order | Servers overwhelmingly treat parameter order as insignificant. Duplicates are preserved because repeating a name is parameter pollution, and collapsing it would erase the evidence. |

| Refused            | What it would do                            | Why it is refused                                                                                                                        |
| ------------------ | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `path-case`        | Lower-casing the path                       | Paths are case-sensitive on most servers. `/Admin` and `/admin` can be different resources, and one of them may be the one that matters. |
| `trailing-slash`   | Adding or removing a trailing slash         | `/users` and `/users/` can route to different handlers, and the difference sometimes bypasses a rule that matched only one form.         |
| `percent-decoding` | Decoding percent-encoded characters         | `%2e%2e%2f` and `../` are not the same observation. One is a traversal attempt; decoding makes it look like an ordinary path.            |
| `duplicate-params` | Collapsing repeated query parameters        | Parameter pollution is attack surface. Two `id` values is a finding, not noise to tidy away.                                             |
| `index-files`      | Treating /path/ and /path/index.html as one | That is a server convention, not a URL equivalence, and it is wrong as often as it is right.                                             |

## Failures are typed, and a cancellation is not a failure

`net::ERR_ABORTED` is the single most common entry in any real scan's failure
list, and almost never a failure: it is what navigating away looks like to the
requests still in flight. Reporting those as errors buries the handful that are
real, so it gets `isError: false` and a summary can say "14 requests were
cancelled by navigation" instead of "14 requests failed".

Each reason also carries `retryable`. §33 decides what to _do_; this only says
whether the door is open — a refused connection might come back, an invalid
certificate will not without someone changing something. Chrome's own string is
kept on every classification, so classifying loses nothing, and an unrecognised
error puts that string in the message because "unknown" alone tells a reader
nothing.

One ordering detail that is easy to get wrong: certificate errors are matched
**before** the general TLS pattern. Otherwise an expired certificate is
reported as a generic handshake failure and the actionable half of the message
is gone.

## The model

`collectNetwork(bus)` subscribes rather than being handed events, which is what
lets it run against a live scan, a replayed event log, or a fixture publishing
by hand — so §36.2's golden tests need no browser.

Request ids are keyed by target as well: CDP ids are unique only _within_ a
target, so two pages can collide, and a model that merged them would attribute
one page's response to another page's request. A response for a request never
seen starting is dropped rather than turned into a half-observation; telemetry
already counts those as `orphanEvents`.

Origins and their endpoints are sorted, so a summary, a report and a golden
baseline all read the same way on every run.

## Boundaries

See the dev plan §1.2 (dependency direction) and §2 (modularity contract).
Consumers import from the package root only — deep imports are an eslint error.
