/**
 * @browserrecon/collector-webmcp — WebMCP tool discovery.
 *
 * Build plan §21; dev plan BR-M1-24.
 *
 * A page that registers WebMCP tools is publishing an action surface to any
 * agent that visits — named operations with input schemas, often wired
 * straight to application APIs. For a recon tool that is close to a free
 * specification of the attack surface, and it is invisible to everything
 * that looks only at network traffic.
 *
 * ## Isolated on purpose
 *
 * The spec is young and moving. §21 asks for this behind an adapter so an
 * evolving spec cannot ripple outward, and the practical expression of that
 * is here: the payload types are ours, not the spec's, and nothing from a
 * draft shape reaches the published event schema (§23). When the spec
 * changes, one mapping function changes.
 *
 * ## Absence is normal and silent
 *
 * Almost no site has this today. A collector that warned, or reported a
 * gap, or explained itself on every scan would be noise on every scan.
 */
import type { EventBus, EventEnvelope, Unsubscribe } from "@browserrecon/events";

export const PACKAGE_NAME = "@browserrecon/collector-webmcp" as const;

export interface WebMcpTool {
  readonly name: string;
  readonly description?: string | undefined;
  /**
   * The declared input schema, as JSON.
   *
   * Kept as an opaque value rather than typed against a draft: §21 wants
   * the spec's shape isolated, and a type written against today's draft
   * would be a compile error the week it changes.
   */
  readonly inputSchema?: unknown;
  /** The origin that registered it — a third-party widget can register too. */
  readonly origin: string;
  readonly registeredOn?: string | undefined;
}

export interface WebMcpInvocation {
  readonly tool: string;
  readonly sequence: number;
  /** Whether the call reported success, where the page said. */
  readonly ok?: boolean | undefined;
}

export interface WebMcpModel {
  readonly tools: readonly WebMcpTool[];
  readonly invocations: readonly WebMcpInvocation[];
  /** True when the page never registered anything — the normal case. */
  readonly absent: boolean;
}

export interface WebMcpCollector {
  readonly model: WebMcpModel;
  stop(): void;
}

interface ToolPayload {
  readonly name?: string;
  readonly description?: string;
  readonly inputSchema?: unknown;
  readonly origin?: string;
  readonly url?: string;
}

interface InvocationPayload {
  readonly name?: string;
  readonly tool?: string;
  readonly ok?: boolean;
}

export function collectWebMcp(bus: EventBus): WebMcpCollector {
  const tools = new Map<string, WebMcpTool>();
  const invocations: WebMcpInvocation[] = [];
  let stopped = false;

  const unsubscribe: Unsubscribe = bus.subscribe(
    (envelope: EventEnvelope) => {
      if (envelope.type === "webmcp_tool_discovered") {
        const payload = envelope.payload as ToolPayload;
        if (payload.name === undefined || payload.name === "") return;
        // Keyed by origin and name: two frames can register the same tool
        // name, and they are not the same capability.
        const origin = payload.origin ?? "";
        tools.set(`${origin}:${payload.name}`, {
          name: payload.name,
          ...(payload.description === undefined ? {} : { description: payload.description }),
          ...(payload.inputSchema === undefined ? {} : { inputSchema: payload.inputSchema }),
          origin,
          ...(payload.url === undefined ? {} : { registeredOn: payload.url }),
        });
        return;
      }

      if (envelope.type === "webmcp_tool_invoked" || envelope.type === "webmcp_tool_result") {
        const payload = envelope.payload as InvocationPayload;
        const name = payload.tool ?? payload.name;
        if (name === undefined || name === "") return;
        invocations.push({
          tool: name,
          sequence: envelope.sequence,
          ...(payload.ok === undefined ? {} : { ok: payload.ok }),
        });
      }
    },
    { name: "webmcp-collector" },
  );

  return {
    get model(): WebMcpModel {
      const list = [...tools.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
      return { tools: list, invocations: [...invocations], absent: list.length === 0 };
    },
    stop() {
      if (stopped) return;
      stopped = true;
      unsubscribe();
    },
  };
}
