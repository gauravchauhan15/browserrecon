import { describe, expect, it } from "vitest";
import { FAILURE_REASONS, classifyFailure } from "./failures.js";

describe("classifying Chrome's error strings", () => {
  it.each([
    ["net::ERR_NAME_NOT_RESOLVED", "dns_failed"],
    ["net::ERR_CONNECTION_REFUSED", "connection_refused"],
    ["net::ERR_CONNECTION_RESET", "connection_reset"],
    ["net::ERR_CONNECTION_TIMED_OUT", "connection_timed_out"],
    ["net::ERR_ADDRESS_UNREACHABLE", "address_unreachable"],
    ["net::ERR_CERT_AUTHORITY_INVALID", "certificate_invalid"],
    ["net::ERR_CERT_DATE_INVALID", "certificate_invalid"],
    ["net::ERR_SSL_PROTOCOL_ERROR", "tls_failed"],
    ["net::ERR_BLOCKED_BY_CLIENT", "blocked_by_client"],
    ["net::ERR_BLOCKED_BY_CSP", "blocked_by_policy"],
    ["net::ERR_TOO_MANY_REDIRECTS", "too_many_redirects"],
    ["net::ERR_INSUFFICIENT_RESOURCES", "resource_exhausted"],
    ["net::ERR_ABORTED", "cancelled"],
  ])("reads %s as %s", (raw, expected) => {
    expect(classifyFailure(raw).reason).toBe(expected);
  });

  it("checks certificate errors before the general TLS pattern", async () => {
    // Ordering that is easy to get wrong: ERR_CERT_DATE_INVALID also matches
    // nothing in the SSL pattern, but ERR_SSL_PINNED_KEY_NOT_IN_CERT_CHAIN
    // matches both — and reporting an expired certificate as a generic
    // handshake failure loses the actionable half of the message.
    expect(classifyFailure("net::ERR_SSL_PINNED_KEY_NOT_IN_CERT_CHAIN").reason).toBe(
      "certificate_invalid",
    );
  });

  it("keeps Chrome's own string, so classifying loses nothing", async () => {
    const classified = classifyFailure("net::ERR_CONNECTION_REFUSED");
    expect(classified.raw).toBe("net::ERR_CONNECTION_REFUSED");
  });

  it("puts the raw string in the message when it could not classify it", async () => {
    // "unknown" on its own tells a reader nothing, and this is exactly the
    // case where they need the original most.
    const classified = classifyFailure("net::ERR_SOMETHING_NOBODY_HAS_SEEN");
    expect(classified.reason).toBe("unknown");
    expect(classified.detail).toContain("ERR_SOMETHING_NOBODY_HAS_SEEN");
  });
});

describe("a cancellation is not a failure", () => {
  it("does not count ERR_ABORTED as an error", async () => {
    // The most common entry in any real scan's failure list, and almost never
    // a failure: it is what navigating away looks like to the requests still
    // in flight. Counting them buries the handful that are real.
    const classified = classifyFailure("net::ERR_ABORTED");
    expect(classified.reason).toBe("cancelled");
    expect(classified.isError).toBe(false);
  });

  it("trusts CDP's canceled flag over the message text", async () => {
    // Chrome sets the flag for some cancellations whose message says nothing
    // about it, so the flag is the authority.
    const classified = classifyFailure("net::ERR_FAILED", true);
    expect(classified.reason).toBe("cancelled");
    expect(classified.isError).toBe(false);
  });
});

describe("retryability", () => {
  it("says a refused connection may come back but a bad certificate will not", async () => {
    // §33 decides what to do; this only says whether the door is open.
    expect(classifyFailure("net::ERR_CONNECTION_REFUSED").retryable).toBe(true);
    expect(classifyFailure("net::ERR_CERT_AUTHORITY_INVALID").retryable).toBe(false);
    expect(classifyFailure("net::ERR_NAME_NOT_RESOLVED").retryable).toBe(false);
  });

  it("flags resource exhaustion as the scan's own problem", async () => {
    const classified = classifyFailure("net::ERR_INSUFFICIENT_RESOURCES");
    expect(classified.detail).toContain("scan may be going too fast");
    expect(classified.retryable).toBe(true);
  });
});

describe("the reason set", () => {
  it("gives every reason a distinct name", async () => {
    expect(new Set(FAILURE_REASONS).size).toBe(FAILURE_REASONS.length);
  });

  it("returns a reason from the published set, whatever it is given", async () => {
    // A consumer branching on `reason` must never meet a value outside the
    // union, including for input that is not a Chrome error at all.
    for (const raw of ["", "total nonsense", "net::ERR_", "ERR_CERT_"]) {
      expect(FAILURE_REASONS as readonly string[]).toContain(classifyFailure(raw).reason);
    }
  });
});
