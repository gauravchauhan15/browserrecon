import { describe, expect, it } from "vitest";
import { EventBus } from "@browserrecon/events";
import { collectNavigation } from "./collector.js";

const bus = (): EventBus => new EventBus();

const committed = async (
  on: EventBus,
  overrides: Partial<{
    navigationId: string;
    frameId: string;
    isMainFrame: boolean;
    url: string;
    targetId: string;
    redirectedFrom: string;
  }> = {},
): Promise<void> => {
  await on.publish({
    type: "navigation_committed",
    provenance: "observed",
    auth_context: "anonymous",
    payload: {
      navigationId: "nav_0001",
      frameId: "F1",
      isMainFrame: true,
      url: "https://app.test/",
      targetId: "page:1",
      ...overrides,
    },
  });
};

const soft = async (
  on: EventBus,
  overrides: Partial<{
    frameId: string;
    isMainFrame: boolean;
    url: string;
    targetId: string;
    historyIndex: number;
    historyLength: number;
    cdpNavigationType: string;
  }> = {},
): Promise<void> => {
  await on.publish({
    type: "soft_navigation",
    provenance: "observed",
    auth_context: "anonymous",
    payload: {
      frameId: "F1",
      isMainFrame: true,
      url: "https://app.test/app/orders",
      targetId: "page:1",
      historyIndex: 1,
      historyLength: 2,
      cdpNavigationType: "historyApi",
      ...overrides,
    },
  });
};

const interaction = async (
  on: EventBus,
  overrides: Partial<{ interactionId: string; frameId: string; targetId: string }> = {},
): Promise<void> => {
  await on.publish({
    type: "interaction",
    provenance: "observed",
    auth_context: "anonymous",
    payload: { interactionId: "int_0001", frameId: "F1", targetId: "page:1", ...overrides },
  });
};

describe("building the navigation object", () => {
  it("records where the frame came from and where it went", async () => {
    // §16.1's from/to. A navigation with only a destination cannot answer the
    // question §16.2 asks — what transition was this?
    const on = bus();
    const collector = collectNavigation(on);

    await committed(on, { url: "https://app.test/" });
    await soft(on, { url: "https://app.test/app/orders" });
    await on.drain();

    const [first, second] = collector.model.navigations;
    expect(first?.from).toBeUndefined();
    expect(first?.to).toBe("https://app.test/");
    expect(second?.from).toBe("https://app.test/");
    expect(second?.to).toBe("https://app.test/app/orders");
  });

  it("calls a document load hard and a route change soft", async () => {
    const on = bus();
    const collector = collectNavigation(on);

    await committed(on);
    await soft(on);
    await on.drain();

    expect(collector.model.hard).toBe(1);
    expect(collector.model.soft).toBe(1);
    expect(collector.model.navigations.map((navigation) => navigation.kind)).toEqual([
      "hard",
      "soft",
    ]);
  });

  it("gives a soft navigation a deterministic id", async () => {
    // Soft navigations have no CDP loader to borrow an id from, and golden
    // output compares these (§36.2), so they cannot be random.
    const on = bus();
    const collector = collectNavigation(on);

    await committed(on);
    await soft(on, { url: "https://app.test/a", historyIndex: 1, historyLength: 2 });
    await soft(on, { url: "https://app.test/b", historyIndex: 2, historyLength: 3 });
    await on.drain();

    expect(
      collector.model.navigations
        .filter((navigation) => navigation.kind === "soft")
        .map((navigation) => navigation.navigationId),
    ).toEqual(["snav_0001", "snav_0002"]);
  });

  it("records a hard navigation that landed somewhere else", async () => {
    const on = bus();
    const collector = collectNavigation(on);
    await committed(on, {
      url: "https://app.test/new",
      redirectedFrom: "https://app.test/old",
    });
    await on.drain();

    expect(collector.model.navigations[0]?.redirectedFrom).toBe("https://app.test/old");
  });
});

describe("attribution to an interaction", () => {
  it("links a route change to the click before it", async () => {
    const on = bus();
    const collector = collectNavigation(on);

    await committed(on);
    await interaction(on, { interactionId: "int_0042" });
    await soft(on);
    await on.drain();

    const navigation = collector.model.navigations.at(-1);
    expect(navigation?.interactionId).toBe("int_0042");
    expect(navigation?.attributionBasis).toBe("most_recent_interaction");
  });

  it("leaves a route change with no interaction unattributed", async () => {
    // The mistake that makes an attribution field worse than no field is
    // handing out the nearest interaction regardless. A reader then cannot
    // tell a real link from a guess.
    const on = bus();
    const collector = collectNavigation(on);

    await committed(on);
    await soft(on);
    await on.drain();

    const navigation = collector.model.navigations.at(-1);
    expect(navigation?.interactionId).toBeUndefined();
    expect(navigation?.attributionBasis).toBe("none");
    expect(collector.model.unattributedSoft).toBe(1);
  });

  it("does not let one interaction claim two navigations", async () => {
    const on = bus();
    const collector = collectNavigation(on);

    await committed(on);
    await interaction(on, { interactionId: "int_0001" });
    await soft(on, { url: "https://app.test/a", historyIndex: 1, historyLength: 2 });
    await soft(on, { url: "https://app.test/b", historyIndex: 2, historyLength: 3 });
    await on.drain();

    const soft1 = collector.model.navigations[1];
    const soft2 = collector.model.navigations[2];
    expect(soft1?.interactionId).toBe("int_0001");
    expect(soft2?.interactionId).toBeUndefined();
  });

  it("does not attribute across frames", async () => {
    // A click in one frame did not cause a route change in another, and
    // saying it did would invent a relationship the evidence never had.
    const on = bus();
    const collector = collectNavigation(on);

    await committed(on, { frameId: "F1" });
    await committed(on, { frameId: "F2", isMainFrame: false, navigationId: "nav_0002" });
    await interaction(on, { frameId: "F1", interactionId: "int_0001" });
    await soft(on, { frameId: "F2", isMainFrame: false });
    await on.drain();

    expect(collector.model.navigations.at(-1)?.interactionId).toBeUndefined();
  });

  it("attributes a hard navigation to the click that caused it too", async () => {
    const on = bus();
    const collector = collectNavigation(on);

    await committed(on, { url: "https://app.test/" });
    await interaction(on, { interactionId: "int_0007" });
    await committed(on, { url: "https://app.test/second", navigationId: "nav_0002" });
    await on.drain();

    expect(collector.model.navigations.at(-1)?.interactionId).toBe("int_0007");
  });
});

describe("history bookkeeping across a document load", () => {
  it("does not compare the new document's history index with the old one's", async () => {
    // A hard navigation resets the Navigation API's entry list, so carrying
    // the previous index forward would classify the first route change of the
    // new document against a position that no longer means anything.
    const on = bus();
    const collector = collectNavigation(on);

    await committed(on, { url: "https://app.test/" });
    await soft(on, { url: "https://app.test/a", historyIndex: 3, historyLength: 4 });
    await committed(on, { url: "https://app.test/second", navigationId: "nav_0002" });
    await soft(on, { url: "https://app.test/b", historyIndex: 1, historyLength: 2 });
    await on.drain();

    const afterReload = collector.model.navigations.at(-1);
    // With no comparable previous position, the label is the fallback — and
    // the basis says so rather than claiming the stronger answer.
    expect(afterReload?.subtypeBasis).toBe("cdp_label");
  });
});

describe("the model", () => {
  it("groups navigations by frame", async () => {
    const on = bus();
    const collector = collectNavigation(on);

    await committed(on, { frameId: "F1" });
    await committed(on, { frameId: "F2", isMainFrame: false, navigationId: "nav_0002" });
    await soft(on, { frameId: "F1" });
    await on.drain();

    expect(collector.model.byFrame.get("page:1:F1")).toHaveLength(2);
    expect(collector.model.byFrame.get("page:1:F2")).toHaveLength(1);
  });

  it("keeps navigations in order", async () => {
    const on = bus();
    const collector = collectNavigation(on);

    await committed(on);
    for (let index = 1; index <= 4; index += 1) {
      await soft(on, {
        url: `https://app.test/${index}`,
        historyIndex: index,
        historyLength: index + 1,
      });
    }
    await on.drain();

    const sequences = collector.model.navigations.map((navigation) => navigation.sequence);
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
  });

  it("stops consuming once stopped", async () => {
    const on = bus();
    const collector = collectNavigation(on);

    await committed(on);
    await on.drain();
    collector.stop();

    await soft(on);
    await on.drain();
    expect(collector.model.navigations).toHaveLength(1);
  });

  it("ignores event types it does not own", async () => {
    const on = bus();
    const collector = collectNavigation(on);
    await on.publish({
      type: "network_request",
      provenance: "observed",
      auth_context: "anonymous",
      payload: { requestId: "1", url: "https://app.test/x", method: "GET" },
    });
    await on.drain();

    expect(collector.model.navigations).toHaveLength(0);
  });
});
