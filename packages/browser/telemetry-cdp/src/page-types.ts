/**
 * Page, Runtime and Debugger payloads — build plan §13.1, §16; dev plan BR-M1-04.
 *
 * ## Frames are not a detail
 *
 * Every payload here carries the frame it belongs to. A scan that merges an
 * iframe's activity into the top document reports an attack surface that does
 * not exist — a third-party widget's endpoints presented as the target's own —
 * and one that drops frames misses the surface that does. Neither error is
 * recoverable later, because the evidence for the distinction was never
 * written down (§32.1).
 */

/** A frame in the tree, as Chrome describes it. */
export interface FrameRef {
  readonly frameId: string;
  readonly parentFrameId?: string | undefined;
  /** True for the tab's top document. */
  readonly isMainFrame: boolean;
  readonly url?: string | undefined;
}

export interface NavigationStartedPayload extends FrameRef {
  /** Groups the started/committed pair, and every event in between. */
  readonly navigationId: string;
  /** Where the navigation is heading, when Chrome says before committing. */
  readonly targetUrl?: string | undefined;
  readonly targetId: string;
}

export interface NavigationCommittedPayload extends FrameRef {
  readonly navigationId: string;
  readonly url: string;
  /** Chrome's loader id — the join key between a navigation and its requests. */
  readonly loaderId?: string | undefined;
  readonly securityOrigin?: string | undefined;
  readonly mimeType?: string | undefined;
  /**
   * Set when the committed URL is not the one requested.
   *
   * A server-side redirect is invisible in the frame tree alone: Chrome
   * reports only where it landed. Recording the difference is what lets a
   * later stage notice that a navigation left the origin it was aimed at.
   */
  readonly redirectedFrom?: string | undefined;
  readonly targetId: string;
}

export interface PageLoadedPayload extends FrameRef {
  readonly navigationId?: string | undefined;
  /** `load` or `domcontentloaded`. */
  readonly event: "load" | "domcontentloaded";
  readonly targetId: string;
}

export interface ExecutionContextPayload {
  /** Chrome's numeric context id. Unique only while the context lives. */
  readonly contextId: number;
  readonly event: "created" | "destroyed" | "cleared";
  readonly origin?: string | undefined;
  readonly name?: string | undefined;
  readonly frameId?: string | undefined;
  /** True for the page's own context, false for an isolated world. */
  readonly isDefault?: boolean | undefined;
  readonly targetId: string;
}

/**
 * A script the page parsed.
 *
 * From `Debugger.scriptParsed`, not from network events, because the two see
 * different things. The network sees files; this sees *scripts* — including
 * inline blocks, `eval`, `new Function`, and anything a bundler injected at
 * runtime. §10A's mining has nothing to read for those unless they are
 * inventoried here.
 */
export interface ScriptParsedPayload {
  readonly scriptId: string;
  /** Empty for an inline script, which is exactly the interesting case. */
  readonly url: string;
  readonly executionContextId?: number | undefined;
  readonly startLine?: number | undefined;
  readonly endLine?: number | undefined;
  readonly length?: number | undefined;
  /** Chrome's hash, for deduplicating a script served on many pages. */
  readonly hash?: string | undefined;
  /** Present when the bundle shipped one — the door to original sources. */
  readonly sourceMapUrl?: string | undefined;
  readonly isModule?: boolean | undefined;
  /** True when the script has no URL of its own. */
  readonly inline: boolean;
  readonly targetId: string;
}
