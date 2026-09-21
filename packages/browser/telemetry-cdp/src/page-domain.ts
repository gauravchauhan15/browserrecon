/**
 * Page, Runtime and Debugger wiring — build plan §5.1, §16; dev plan BR-M1-04.
 *
 * Network telemetry says *what was requested*. This says *where the browser
 * was, and what was running*, which is what turns a list of requests into
 * something a correlation engine can reason about: a request belongs to a
 * navigation, a navigation belongs to a frame, and a script belongs to an
 * execution context that a later navigation destroys.
 *
 * ## Navigation ids are allocated here, not derived
 *
 * CDP has no single "this navigation" identifier that spans start to commit:
 * `frameRequestedNavigation` names a frame and a URL, `frameNavigated` reports
 * a loader id that only exists once the navigation has committed. So a
 * navigation id is allocated when a frame starts moving and carried through to
 * the commit. That makes the started/committed pair joinable, which is what
 * BR-M1-07's soft-navigation work and §18's workflow boundaries need.
 *
 * ## Execution contexts must not leak
 *
 * Chrome reuses context ids. A stale id left in the map after a navigation
 * would attribute the new page's scripts to the old page's context, and the
 * error is invisible — everything still has *an* id. So destroyed and cleared
 * are both handled, and the map is asserted empty-of-stale-ids by a test that
 * navigates twice.
 */
import type { CDPSession } from "puppeteer-core";
import type { TelemetryContext } from "./context.js";
import type {
  ExecutionContextCreated,
  ExecutionContextDestroyed,
  FrameAttached,
  FrameDetached,
  FrameLoading,
  FrameNavigated,
  FrameRequestedNavigation,
  LifecycleEvent,
  NavigatedWithinDocument,
  ScriptParsed,
} from "./cdp-shapes.js";
import type {
  ExecutionContextPayload,
  NavigationCommittedPayload,
  NavigationStartedPayload,
  PageLoadedPayload,
  ScriptParsedPayload,
  SoftNavigationPayload,
} from "./page-types.js";

/**
 * Where the page sits in its own session history.
 *
 * A read, not a hook. Wrapping `history.pushState` would also work and would
 * report the call directly — but it modifies the page a scan is supposed to be
 * observing, and a site can tell the difference. Reading two properties
 * changes nothing, and the index/length pair is enough to separate a push from
 * a replace from a traversal (BR-M1-07).
 */
async function readHistoryPosition(
  cdp: CDPSession,
): Promise<{ index?: number | undefined; length?: number | undefined }> {
  try {
    const result = (await cdp.send("Runtime.evaluate", {
      expression:
        "typeof navigation === 'object' && navigation !== null" +
        " ? [navigation.currentEntry ? navigation.currentEntry.index : -1, navigation.entries().length]" +
        " : null",
      returnByValue: true,
      // A property read cannot need long, and a page that has wedged its main
      // thread must not wedge telemetry with it.
      timeout: 1000,
    })) as { result?: { value?: [number, number] | null } };

    const value = result.result?.value;
    if (value === null || value === undefined) return {};
    return { index: value[0], length: value[1] };
  } catch {
    // No Navigation API, a detached frame, or a busy main thread. The
    // collector falls back to Chrome's own label, which is worse but present.
    return {};
  }
}

/** What is known about a frame while it exists. */
interface FrameState {
  readonly frameId: string;
  parentFrameId?: string | undefined;
  url?: string | undefined;
  /** The navigation currently in flight, or the last one committed. */
  navigationId?: string | undefined;
  /** Where the frame said it was going, for spotting a redirect on commit. */
  requestedUrl?: string | undefined;
  /** True once `navigation_started` has been emitted for the in-flight one. */
  navigationStarted?: boolean | undefined;
}

export interface PageDomainState {
  /**
   * Frames currently attached, keyed `targetId:frameId`.
   *
   * One state object is shared by every target, so the key has to carry the
   * target. Keyed by frame id alone, two pages' frames collided — and since
   * the initial about:blank tab is also a target, a real page's frames could
   * be overwritten by it.
   */
  readonly frames: Map<string, FrameState>;
  /** Live execution contexts, by CDP context id. */
  readonly contexts: Map<number, { frameId?: string | undefined; origin?: string | undefined }>;
  /** Scripts seen, by CDP script id. */
  readonly scripts: Set<string>;
  /**
   * Each target's main frame, by target id.
   *
   * Was a single value, which was wrong in a way that only showed up with
   * more than one tab open: every attach overwrote it, so whichever target
   * attached last owned "the" main frame and every other page's main-frame
   * navigation was reported as a subframe. It surfaced as an intermittent
   * test failure in the full suite and never when the browser tests ran
   * alone — the signature of shared state, not of timing.
   */
  readonly mainFrameIds: Map<string, string>;
}

export function newPageDomainState(): PageDomainState {
  return {
    frames: new Map(),
    contexts: new Map(),
    scripts: new Set(),
    mainFrameIds: new Map(),
  };
}

export interface PageDomainOptions {
  /**
   * Inventory scripts via `Debugger.scriptParsed`.
   *
   * On by default because it is the only way to see inline, `eval`-ed and
   * runtime-generated scripts — the network sees files, this sees scripts, and
   * §10A has nothing to mine for the rest. It does mean enabling the Debugger
   * domain, which instruments V8; a scan that only wants network data can
   * switch it off.
   */
  readonly inventoryScripts?: boolean | undefined;
}

export function wirePageDomain(
  cdp: CDPSession,
  targetId: string,
  ctx: TelemetryContext,
  state: PageDomainState,
): void {
  /** Allocate the id that joins a navigation's start to its commit. */
  const nextNavigationId = (): string => {
    ctx.counters.navigations += 1;
    return `nav_${String(ctx.counters.navigations).padStart(4, "0")}`;
  };

  const frameKey = (frameId: string): string => `${targetId}:${frameId}`;

  const frameOf = (frameId: string): FrameState => {
    const existing = state.frames.get(frameKey(frameId));
    if (existing !== undefined) return existing;
    const created: FrameState = { frameId };
    state.frames.set(frameKey(frameId), created);
    return created;
  };

  const isMain = (frameId: string): boolean => state.mainFrameIds.get(targetId) === frameId;

  cdp.on("Page.frameAttached", (raw: unknown) => {
    ctx.touch();
    const event = raw as FrameAttached;
    const frame = frameOf(event.frameId);
    frame.parentFrameId = event.parentFrameId;
    ctx.counters.frames += 1;
    // Tracked, not emitted. §13.1 has no frame-lifecycle event type, and
    // inventing one to carry state that every other payload already reports
    // through `frameId`/`parentFrameId` would widen the published schema for
    // no consumer.
  });

  cdp.on("Page.frameDetached", (raw: unknown) => {
    ctx.touch();
    const event = raw as FrameDetached;
    state.frames.delete(frameKey(event.frameId));

    // Contexts belonging to a detached frame go with it. Chrome usually sends
    // executionContextDestroyed too, but not reliably for a frame swapped out
    // of the tree — and a context left behind would attribute the next page's
    // scripts to a frame that no longer exists.
    for (const [contextId, info] of state.contexts) {
      if (info.frameId === event.frameId) state.contexts.delete(contextId);
    }
  });

  /**
   * Begin a navigation for a frame, at most once per navigation.
   *
   * Chrome announces a navigation through more than one event and does not
   * guarantee which arrives, or that any particular one does:
   * `frameRequestedNavigation` fires early and names the destination,
   * `frameStartedLoading` fires for loads that were never "requested". Keying
   * on either alone made the started/committed pair intermittent — it went
   * missing under load, which is exactly when a log needs to be trustworthy.
   * So the first signal to arrive starts it and the flag stops a second.
   */
  const beginNavigation = (frameId: string): void => {
    const frame = frameOf(frameId);
    if (frame.navigationStarted === true) return;

    const navigationId = nextNavigationId();
    frame.navigationId = navigationId;
    frame.navigationStarted = true;

    const payload: NavigationStartedPayload = {
      navigationId,
      frameId,
      ...(frame.parentFrameId === undefined ? {} : { parentFrameId: frame.parentFrameId }),
      isMainFrame: isMain(frameId),
      ...(frame.requestedUrl === undefined ? {} : { targetUrl: frame.requestedUrl }),
      ...(frame.url === undefined ? {} : { url: frame.url }),
      targetId,
    };
    ctx.enqueue(async () => {
      ctx.emit("navigation_started", payload, { navigation_id: navigationId });
      await Promise.resolve();
    });
  };

  cdp.on("Page.frameRequestedNavigation", (raw: unknown) => {
    ctx.touch();
    const event = raw as FrameRequestedNavigation;
    frameOf(event.frameId).requestedUrl = event.url;
    beginNavigation(event.frameId);
  });

  cdp.on("Page.frameStartedLoading", (raw: unknown) => {
    ctx.touch();
    beginNavigation((raw as FrameLoading).frameId);
  });

  cdp.on("Page.frameNavigated", (raw: unknown) => {
    ctx.touch();
    const event = raw as FrameNavigated;
    const frame = frameOf(event.frame.id);

    // The first frame Chrome reports with no parent is the tab's top document.
    if (event.frame.parentId === undefined) state.mainFrameIds.set(targetId, event.frame.id);
    frame.parentFrameId = event.frame.parentId;

    // A navigation that committed without a start — a redirect chain, or one
    // begun before telemetry attached — still gets an id, so nothing in the
    // log is unattributable.
    const navigationId = frame.navigationId ?? nextNavigationId();
    frame.navigationId = navigationId;

    const requested = frame.requestedUrl;
    frame.requestedUrl = undefined;
    frame.navigationStarted = undefined;
    frame.url = event.frame.url;

    // Read the history position on commit as well as on a soft navigation.
    //
    // Without it the *first* route change of every document has nothing to
    // compare against and falls back to Chrome's label — which cannot tell a
    // push from a replace. Measured: the first pushState after a load came
    // back as `cdp_label` while every later one was `navigation_api`.
    //
    // A fresh document does not reset the entry count either, so the baseline
    // cannot be assumed: navigating from /a to /b leaves two entries, not one.
    const committedHistory = readHistoryPosition(cdp);

    const payload: NavigationCommittedPayload = {
      navigationId,
      frameId: event.frame.id,
      ...(event.frame.parentId === undefined ? {} : { parentFrameId: event.frame.parentId }),
      isMainFrame: event.frame.parentId === undefined,
      url: event.frame.url,
      ...(event.frame.loaderId === undefined ? {} : { loaderId: event.frame.loaderId }),
      ...(event.frame.securityOrigin === undefined
        ? {}
        : { securityOrigin: event.frame.securityOrigin }),
      ...(event.frame.mimeType === undefined ? {} : { mimeType: event.frame.mimeType }),
      // Chrome reports only where it landed, so a server-side redirect is
      // otherwise invisible in the frame tree.
      ...(requested === undefined || requested === event.frame.url
        ? {}
        : { redirectedFrom: requested }),
      targetId,
    };
    ctx.enqueue(async () => {
      const history = await committedHistory;
      ctx.emit(
        "navigation_committed",
        {
          ...payload,
          ...(history.index === undefined ? {} : { historyIndex: history.index }),
          ...(history.length === undefined ? {} : { historyLength: history.length }),
        },
        { navigation_id: navigationId },
      );
    });
  });

  cdp.on("Page.navigatedWithinDocument", (raw: unknown) => {
    ctx.touch();
    const event = raw as NavigatedWithinDocument;
    const frame = frameOf(event.frameId);
    // The previous URL is the collector's `from`; it keeps the frame map, so
    // nothing needs to be carried on the event itself.
    frame.url = event.url;

    ctx.enqueue(async () => {
      // Read the Navigation API inside the queued emission, so the read
      // happens in the same order the events did. Chrome's own
      // `navigationType` cannot be trusted here — a traversal that changes
      // the path is reported as `fragment` — so the index and length are what
      // the collector derives push/replace/traverse from.
      const history = await readHistoryPosition(cdp);

      const payload: SoftNavigationPayload = {
        frameId: event.frameId,
        ...(frame.parentFrameId === undefined ? {} : { parentFrameId: frame.parentFrameId }),
        isMainFrame: isMain(event.frameId),
        url: event.url,

        ...(event.navigationType === undefined
          ? {}
          : { cdpNavigationType: event.navigationType }),
        ...(history.index === undefined ? {} : { historyIndex: history.index }),
        ...(history.length === undefined ? {} : { historyLength: history.length }),
        targetId,
      };
      ctx.emit("soft_navigation", payload, {
        ...(frame.navigationId === undefined ? {} : { navigation_id: frame.navigationId }),
      });
    });
  });

  cdp.on("Page.lifecycleEvent", (raw: unknown) => {
    ctx.touch();
    const event = raw as LifecycleEvent;
    if (event.name !== "load" && event.name !== "DOMContentLoaded") return;

    const frame = state.frames.get(frameKey(event.frameId));
    const payload: PageLoadedPayload = {
      frameId: event.frameId,
      ...(frame?.parentFrameId === undefined ? {} : { parentFrameId: frame.parentFrameId }),
      isMainFrame: isMain(event.frameId),
      ...(frame?.url === undefined ? {} : { url: frame.url }),
      ...(frame?.navigationId === undefined ? {} : { navigationId: frame.navigationId }),
      event: event.name === "load" ? "load" : "domcontentloaded",
      targetId,
    };
    ctx.enqueue(async () => {
      ctx.emit("page_loaded", payload, {
        ...(frame?.navigationId === undefined ? {} : { navigation_id: frame.navigationId }),
      });
      await Promise.resolve();
    });
  });

  cdp.on("Runtime.executionContextCreated", (raw: unknown) => {
    ctx.touch();
    const event = raw as ExecutionContextCreated;
    const frameId = event.context.auxData?.frameId;
    state.contexts.set(event.context.id, {
      ...(frameId === undefined ? {} : { frameId }),
      ...(event.context.origin === undefined ? {} : { origin: event.context.origin }),
    });
    ctx.counters.executionContexts += 1;

    const payload: ExecutionContextPayload = {
      contextId: event.context.id,
      event: "created",
      ...(event.context.origin === undefined ? {} : { origin: event.context.origin }),
      ...(event.context.name === undefined ? {} : { name: event.context.name }),
      ...(frameId === undefined ? {} : { frameId }),
      ...(event.context.auxData?.isDefault === undefined
        ? {}
        : { isDefault: event.context.auxData.isDefault }),
      targetId,
    };
    ctx.enqueue(async () => {
      ctx.emit("js_execution_context", payload);
      await Promise.resolve();
    });
  });

  cdp.on("Runtime.executionContextDestroyed", (raw: unknown) => {
    ctx.touch();
    const event = raw as ExecutionContextDestroyed;
    const info = state.contexts.get(event.executionContextId);
    state.contexts.delete(event.executionContextId);

    const payload: ExecutionContextPayload = {
      contextId: event.executionContextId,
      event: "destroyed",
      ...(info?.frameId === undefined ? {} : { frameId: info.frameId }),
      ...(info?.origin === undefined ? {} : { origin: info.origin }),
      targetId,
    };
    ctx.enqueue(async () => {
      ctx.emit("js_execution_context", payload);
      await Promise.resolve();
    });
  });

  cdp.on("Runtime.executionContextsCleared", () => {
    ctx.touch();
    // Every context at once, which is what a cross-document navigation does.
    // Dropping the whole map is the point: a surviving id would silently
    // attribute the new document's scripts to the old one's context.
    const cleared = state.contexts.size;
    state.contexts.clear();

    const payload: ExecutionContextPayload = { contextId: -1, event: "cleared", targetId };
    ctx.enqueue(async () => {
      if (cleared > 0) ctx.emit("js_execution_context", payload);
      await Promise.resolve();
    });
  });

  cdp.on("Debugger.scriptParsed", (raw: unknown) => {
    ctx.touch();
    const event = raw as ScriptParsed;
    if (state.scripts.has(event.scriptId)) return;
    state.scripts.add(event.scriptId);
    ctx.counters.scripts += 1;

    const payload: ScriptParsedPayload = {
      scriptId: event.scriptId,
      url: event.url,
      ...(event.executionContextId === undefined
        ? {}
        : { executionContextId: event.executionContextId }),
      ...(event.startLine === undefined ? {} : { startLine: event.startLine }),
      ...(event.endLine === undefined ? {} : { endLine: event.endLine }),
      ...(event.length === undefined ? {} : { length: event.length }),
      ...(event.hash === undefined ? {} : { hash: event.hash }),
      ...(event.sourceMapURL === undefined || event.sourceMapURL === ""
        ? {}
        : { sourceMapUrl: event.sourceMapURL }),
      ...(event.isModule === undefined ? {} : { isModule: event.isModule }),
      // The interesting case: a script with no URL exists only in the DOM or
      // in memory, and the network never saw it.
      inline: event.url === "",
      targetId,
    };
    ctx.enqueue(async () => {
      ctx.emit("script_parsed", payload);
      await Promise.resolve();
    });
  });
}

/** Enable the domains this wiring listens to, and learn the frame tree. */
export async function enablePageDomains(
  cdp: CDPSession,
  options: PageDomainOptions,
  state: PageDomainState,
  targetId: string,
): Promise<void> {
  // The frame tree is read BEFORE Page.enable, not after.
  //
  // `Page.getFrameTree` does not need the domain enabled, and ordering it
  // first closes a race: with enable first, events could arrive while the
  // tree request was still in flight, and a navigation that started in that
  // window was attributed to a frame nobody had yet identified as the main
  // one. It showed up as an intermittently failing assertion under load —
  // rare enough to look like flakiness and real enough to mislabel a
  // navigation in a scan.
  try {
    const tree = (await cdp.send("Page.getFrameTree")) as {
      frameTree: { frame: { id: string; parentId?: string; url?: string } };
    };
    const root = tree.frameTree.frame;
    state.mainFrameIds.set(targetId, root.id);
    state.frames.set(`${targetId}:${root.id}`, {
      frameId: root.id,
      ...(root.parentId === undefined ? {} : { parentFrameId: root.parentId }),
      ...(root.url === undefined ? {} : { url: root.url }),
    });
  } catch {
    // A target without a frame tree — a worker — simply has no main frame.
  }

  await cdp.send("Page.enable");

  // Lifecycle events are opt-in and are the only reliable source for load and
  // DOMContentLoaded in subframes.
  await cdp.send("Page.setLifecycleEventsEnabled", { enabled: true });
  await cdp.send("Runtime.enable");
  if (options.inventoryScripts !== false) {
    await cdp.send("Debugger.enable");
  }
}
