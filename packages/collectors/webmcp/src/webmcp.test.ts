import { describe, expect, it } from "vitest";
import { EventBus } from "@browserrecon/events";
import { collectWebMcp } from "./index.js";

describe("tool discovery", () => {
  it("captures name, description, schema and origin", async () => {
    const bus = new EventBus();
    const collector = collectWebMcp(bus);
    await bus.publish({
      type: "webmcp_tool_discovered",
      provenance: "observed",
      auth_context: "anonymous",
      payload: {
        name: "placeOrder",
        description: "Place an order for the current cart",
        inputSchema: { type: "object", properties: { cartId: { type: "string" } } },
        origin: "https://app.test",
        url: "https://app.test/checkout",
      },
    });
    await bus.drain();

    expect(collector.model.tools[0]).toMatchObject({
      name: "placeOrder",
      origin: "https://app.test",
      registeredOn: "https://app.test/checkout",
    });
    expect(collector.model.tools[0]?.inputSchema).toEqual({
      type: "object",
      properties: { cartId: { type: "string" } },
    });
  });

  it("keeps the same tool name from two origins apart", async () => {
    // A third-party widget can register too, and its `search` is not the
    // application's `search`.
    const bus = new EventBus();
    const collector = collectWebMcp(bus);
    for (const origin of ["https://app.test", "https://widget.other.test"]) {
      await bus.publish({
        type: "webmcp_tool_discovered",
        provenance: "observed",
        auth_context: "anonymous",
        payload: { name: "search", origin },
      });
    }
    await bus.drain();
    expect(collector.model.tools).toHaveLength(2);
  });

  it("records invocations against their tool", async () => {
    const bus = new EventBus();
    const collector = collectWebMcp(bus);
    await bus.publish({
      type: "webmcp_tool_invoked",
      provenance: "observed",
      auth_context: "anonymous",
      payload: { tool: "placeOrder" },
    });
    await bus.drain();
    expect(collector.model.invocations[0]?.tool).toBe("placeOrder");
  });
});

describe("absence is normal and silent", () => {
  it("reports absent with no tools and says nothing else", async () => {
    // Almost no site has this today. A collector that warned on every scan
    // would be noise on every scan.
    const bus = new EventBus();
    const collector = collectWebMcp(bus);
    await bus.publish({
      type: "network_request",
      provenance: "observed",
      auth_context: "anonymous",
      payload: { url: "https://app.test/", method: "GET" },
    });
    await bus.drain();

    expect(collector.model.absent).toBe(true);
    expect(collector.model.tools).toEqual([]);
  });
});

describe("the spec stays isolated", () => {
  it("treats the input schema as opaque rather than typing a moving draft", async () => {
    // §21: a type written against today's draft is a compile error the week
    // it changes. Anything the page declared survives unchanged.
    const bus = new EventBus();
    const collector = collectWebMcp(bus);
    const exotic = { $schema: "draft-2020-12", oneOf: [{ const: 1 }], "x-vendor": true };
    await bus.publish({
      type: "webmcp_tool_discovered",
      provenance: "observed",
      auth_context: "anonymous",
      payload: { name: "t", origin: "https://app.test", inputSchema: exotic },
    });
    await bus.drain();
    expect(collector.model.tools[0]?.inputSchema).toEqual(exotic);
  });

  it("ignores a registration with no name rather than inventing one", async () => {
    const bus = new EventBus();
    const collector = collectWebMcp(bus);
    await bus.publish({
      type: "webmcp_tool_discovered",
      provenance: "observed",
      auth_context: "anonymous",
      payload: { origin: "https://app.test" },
    });
    await bus.drain();
    expect(collector.model.absent).toBe(true);
  });
});
