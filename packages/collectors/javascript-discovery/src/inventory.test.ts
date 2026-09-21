import { describe, expect, it } from "vitest";
import { EventBus } from "@browserrecon/events";
import { collectJavascript } from "./index.js";

const FIRST_PARTY = ["https://app.test"];

const script = async (
  bus: EventBus,
  overrides: Record<string, unknown> = {},
): Promise<void> => {
  await bus.publish({
    type: "script_parsed",
    provenance: "observed",
    auth_context: "anonymous",
    payload: {
      url: "https://app.test/app.js",
      hash: "h1",
      length: 1000,
      inline: false,
      ...overrides,
    },
  });
};

describe("deduplication is by content, not URL", () => {
  it("counts one bundle served from three paths once", async () => {
    // The same bundle from a CDN path, a cache-busted URL, and the apex.
    // Counting it three times inflates every number and — once M2 arrives —
    // parses it three times.
    const bus = new EventBus();
    const collector = collectJavascript(bus, { firstPartyOrigins: FIRST_PARTY });

    await script(bus, { url: "https://app.test/a.js", hash: "same" });
    await script(bus, { url: "https://app.test/a.js?v=2", hash: "same" });
    await script(bus, { url: "https://app.test/static/a.js", hash: "same" });
    await bus.drain();

    expect(collector.model.assets).toHaveLength(1);
    expect(collector.model.deduplicated).toBe(2);
    expect(collector.model.assets[0]?.seenOn).toHaveLength(3);
  });

  it("keeps two genuinely different scripts apart", async () => {
    const bus = new EventBus();
    const collector = collectJavascript(bus, { firstPartyOrigins: FIRST_PARTY });
    await script(bus, { url: "https://app.test/a.js", hash: "h1" });
    await script(bus, { url: "https://app.test/b.js", hash: "h2" });
    await bus.drain();
    expect(collector.model.assets).toHaveLength(2);
  });

  it("falls back to the URL when Chrome reported no hash", async () => {
    const bus = new EventBus();
    const collector = collectJavascript(bus, { firstPartyOrigins: FIRST_PARTY });
    await script(bus, { url: "https://app.test/a.js", hash: undefined });
    await script(bus, { url: "https://app.test/b.js", hash: undefined });
    await bus.drain();
    expect(collector.model.assets).toHaveLength(2);
  });
});

describe("what the inventory records", () => {
  it("separates first-party from third-party", async () => {
    const bus = new EventBus();
    const collector = collectJavascript(bus, { firstPartyOrigins: FIRST_PARTY });
    await script(bus, { url: "https://app.test/a.js", hash: "h1" });
    await script(bus, { url: "https://cdn.other.test/b.js", hash: "h2" });
    await bus.drain();

    expect(collector.model.firstParty).toBe(1);
    expect(collector.model.thirdParty).toBe(1);
  });

  it("records an inline script, which the network never saw", async () => {
    const bus = new EventBus();
    const collector = collectJavascript(bus, { firstPartyOrigins: FIRST_PARTY });
    await script(bus, { url: "", hash: "h9", inline: true });
    await bus.drain();

    expect(collector.model.inline).toBe(1);
    expect(collector.model.assets[0]?.url).toBe("");
  });

  it("captures a source map pointer", async () => {
    const bus = new EventBus();
    const collector = collectJavascript(bus, { firstPartyOrigins: FIRST_PARTY });
    await script(bus, { sourceMapUrl: "app.js.map" });
    await bus.drain();
    expect(collector.model.assets[0]?.sourceMapUrl).toBe("app.js.map");
  });

  it("takes size and content type from the network response", async () => {
    // Neither event has everything: the script record has the hash, the
    // response has the bytes on the wire.
    const bus = new EventBus();
    const collector = collectJavascript(bus, { firstPartyOrigins: FIRST_PARTY });
    await bus.publish({
      type: "network_response",
      provenance: "observed",
      auth_context: "anonymous",
      payload: {
        url: "https://app.test/a.js",
        mimeType: "text/javascript",
        encodedDataLength: 4242,
      },
    });
    await script(bus, { url: "https://app.test/a.js", hash: "h1", length: undefined });
    await bus.drain();

    expect(collector.model.assets[0]?.bytes).toBe(4242);
    expect(collector.model.assets[0]?.mimeType).toBe("text/javascript");
  });
});

describe("chunks loaded after the page", () => {
  it("marks a chunk that arrived after load as runtime-loaded", async () => {
    // §10B.6: a code-split app loads its admin bundle when you open the
    // admin screen, and an inventory taken at load sees only the shell.
    const bus = new EventBus();
    const collector = collectJavascript(bus, { firstPartyOrigins: FIRST_PARTY });

    await script(bus, { url: "https://app.test/shell.js", hash: "h1" });
    collector.markLoaded();
    await script(bus, { url: "https://app.test/admin.chunk.js", hash: "h2" });
    await bus.drain();

    const admin = collector.model.assets.find((a) => a.url.includes("admin"));
    expect(admin?.runtimeLoaded).toBe(true);
    expect(collector.model.runtimeLoaded).toBe(1);
  });
});

describe("analysis priority", () => {
  it("puts first-party code ahead of a large third-party bundle", async () => {
    // A 2 MB analytics bundle is the biggest thing on most pages and
    // contains nothing a recon tool wants.
    const bus = new EventBus();
    const collector = collectJavascript(bus, { firstPartyOrigins: FIRST_PARTY });
    await script(bus, { url: "https://cdn.other.test/huge.js", hash: "h1", length: 2_000_000 });
    await script(bus, { url: "https://app.test/app.js", hash: "h2", length: 80_000 });
    await bus.drain();

    expect(collector.model.assets[0]?.url).toBe("https://app.test/app.js");
  });

  it("puts inline scripts first of all", async () => {
    const bus = new EventBus();
    const collector = collectJavascript(bus, { firstPartyOrigins: FIRST_PARTY });
    await script(bus, { url: "https://app.test/app.js", hash: "h1", length: 90_000 });
    await script(bus, { url: "", hash: "h2", inline: true });
    await bus.drain();
    expect(collector.model.assets[0]?.inline).toBe(true);
  });
});
