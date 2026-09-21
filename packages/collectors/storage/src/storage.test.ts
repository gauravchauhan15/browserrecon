import { describe, expect, it } from "vitest";
import { EventBus } from "@browserrecon/events";
import { collectStorage, findWeaknesses, type CookieRecord } from "./index.js";

const cookie = (overrides: Partial<CookieRecord> = {}): CookieRecord => ({
  name: "sessionid",
  domain: "app.test",
  path: "/",
  size: 32,
  httpOnly: true,
  secure: true,
  sameSite: "Lax",
  session: true,
  ...overrides,
});

const observe = async (bus: EventBus, cookies: Partial<CookieRecord>[]): Promise<void> => {
  await bus.publish({
    type: "cookie_observation",
    provenance: "observed",
    auth_context: "anonymous",
    payload: { cookies },
  });
};

describe("values are off by default", () => {
  it("records the cookie without its value", async () => {
    // A cookie jar mid-scan holds session tokens. The metadata answers almost
    // every question a recon tool has; the value carries every risk.
    const bus = new EventBus();
    const collector = collectStorage(bus);
    await observe(bus, [{ name: "sessionid", value: "super-secret-token", size: 18 }]);
    await bus.drain();

    const record = collector.model.cookies[0];
    expect(record?.name).toBe("sessionid");
    expect(record?.value).toBeUndefined();
    // Size survives, because it distinguishes a flag from a token.
    expect(record?.size).toBe(18);
    expect(JSON.stringify(collector.model)).not.toContain("super-secret-token");
  });

  it("keeps values only when explicitly asked", async () => {
    const bus = new EventBus();
    const collector = collectStorage(bus, { captureValues: true });
    await observe(bus, [{ name: "sessionid", value: "kept-on-purpose" }]);
    await bus.drain();

    expect(collector.model.cookies[0]?.value).toBe("kept-on-purpose");
    // Flagged, so the export boundary knows to redact (§37.2).
    expect(collector.model.valuesCaptured).toBe(true);
  });

  it("keeps storage values off by default too", async () => {
    const bus = new EventBus();
    const collector = collectStorage(bus);
    await bus.publish({
      type: "storage_observation",
      provenance: "observed",
      auth_context: "anonymous",
      payload: { area: "local", origin: "https://app.test", key: "jwt", value: "ey.secret" },
    });
    await bus.drain();

    expect(collector.model.storage[0]?.key).toBe("jwt");
    expect(collector.model.storage[0]?.value).toBeUndefined();
    expect(collector.model.storage[0]?.size).toBe("ey.secret".length);
  });
});

describe("security attributes are the finding", () => {
  it("flags a session cookie readable from JavaScript", async () => {
    const found = findWeaknesses([cookie({ httpOnly: false })]);
    expect(found.map((w) => w.issue)).toContain("no_httponly");
  });

  it("does not flag every analytics cookie for HttpOnly", async () => {
    // Almost none of them have it, and reporting all of them buries the one
    // that matters.
    const found = findWeaknesses([cookie({ name: "_ga", httpOnly: false })]);
    expect(found.map((w) => w.issue)).not.toContain("no_httponly");
  });

  it("flags a cookie that travels over plaintext, whatever its name", async () => {
    const found = findWeaknesses([cookie({ name: "_ga", secure: false })]);
    expect(found.map((w) => w.issue)).toContain("no_secure");
  });

  it("distinguishes SameSite=None from SameSite unset", async () => {
    // Different facts: one is a deliberate choice to allow cross-site, the
    // other leaves it to a browser default that differs between browsers.
    expect(findWeaknesses([cookie({ sameSite: "None" })]).map((w) => w.issue)).toContain(
      "samesite_none",
    );
    expect(findWeaknesses([cookie({ sameSite: "unspecified" })]).map((w) => w.issue)).toContain(
      "samesite_unspecified",
    );
  });

  it("says nothing about a properly protected cookie", async () => {
    expect(findWeaknesses([cookie()])).toEqual([]);
  });

  it("names the cookie in a way a reader can find it", async () => {
    const found = findWeaknesses([
      cookie({ secure: false, domain: "api.app.test", path: "/v1" }),
    ]);
    expect(found[0]?.cookie).toBe("sessionid (api.app.test/v1)");
  });
});

describe("the model", () => {
  it("updates rather than duplicates when the jar is re-read", async () => {
    const bus = new EventBus();
    const collector = collectStorage(bus);
    await observe(bus, [{ name: "sessionid", secure: true }]);
    await observe(bus, [{ name: "sessionid", secure: false }]);
    await bus.drain();

    expect(collector.model.cookies).toHaveLength(1);
    expect(collector.model.cookies[0]?.secure).toBe(false);
  });

  it("treats the same name on different paths as different cookies", async () => {
    const bus = new EventBus();
    const collector = collectStorage(bus);
    await observe(bus, [
      { name: "sid", path: "/" },
      { name: "sid", path: "/admin" },
    ]);
    await bus.drain();

    expect(collector.model.cookies).toHaveLength(2);
  });

  it("sorts, so a report reads the same every run", async () => {
    const bus = new EventBus();
    const collector = collectStorage(bus);
    await observe(bus, [{ name: "zeta" }, { name: "alpha" }, { name: "mid" }]);
    await bus.drain();

    expect(collector.model.cookies.map((c) => c.name)).toEqual(["alpha", "mid", "zeta"]);
  });
});
