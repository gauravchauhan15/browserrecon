/// <reference lib="dom" />
//
// The DOM lib is referenced for this file alone, not project-wide. The bodies
// passed to `page.evaluate` run inside the browser and legitimately use
// `document` and `window`; making those globals available to every file would
// let Node-context code reference them and still compile.

/**
 * The Puppeteer implementation of the control boundary — dev plan BR-M1-02.
 *
 * The only file in the codebase above the manager that names a driver type.
 * Everything else talks to `BrowserAdapter` (types.ts), which is why V5 can
 * drop a Chrome DevTools MCP implementation beside this one without a single
 * caller changing (§5.1).
 *
 * ## Every method starts with the same three lines
 *
 * Check the policy, return a typed denial if refused, only then touch the
 * page. §32.10 — *policy validation occurs before browser/agent actions* — is
 * not a convention here; it is the shape of every method, and the tests assert
 * it by counting how many times a stub engine was consulted.
 *
 * ## The page is private and stays private
 *
 * `#page` is a genuine private field, so there is no property, cast or
 * structural type that reaches it. Combined with the eslint rule confining
 * driver imports to `packages/browser/**`, a caller wanting to bypass policy
 * has to edit two files that say in their comments why they exist.
 */
import type { Page } from "puppeteer-core";
import type { BrowserSession } from "@browserrecon/browser-manager";
import { silentLogger, type Logger } from "@browserrecon/core";
import type { Decision, PolicyEngine } from "@browserrecon/policy";
import type { AncestorStep } from "./state-changing.js";
import {
  inferStateChanging,
  resolveStateChanging,
  type ElementFacts,
} from "./state-changing.js";
import {
  denied,
  failed,
  ok,
  type ActionOptions,
  type ActionResult,
  type AdapterAction,
  type BrowserAdapter,
  type FailureKind,
  type HarvestedControl,
  type HarvestedForm,
  type NavigationOutcome,
  type HarvestedWebMcpTool,
  type PageHarvest,
  type ScrollDirection,
  type SettledOutcome,
} from "./types.js";

const DEFAULT_ACTION_TIMEOUT_MS = 15_000;
const DEFAULT_SETTLE_TIMEOUT_MS = 5_000;

/**
 * Bound a driver call that takes no timeout of its own.
 *
 * `ElementHandle.click` has no timeout parameter, and it is not merely a
 * dispatch: it scrolls the element into view and reads its box model over CDP
 * first. When the click causes a navigation, those commands can be left
 * waiting on an execution context that no longer exists — and the call never
 * settles. Observed as a form-submitting click hanging past a sixty-second
 * test timeout on a loaded machine, while passing in isolation.
 *
 * The adapter promises every action answers within its budget and that nothing
 * opaque escapes. A call that can hang forever breaks both, whatever the
 * driver's excuse, so the budget is enforced here rather than hoped for.
 */
/**
 * Read links and forms from the live document.
 *
 * Runs inside the page, so it must be self-contained. `href` and `action`
 * are read from the DOM properties rather than the attributes, because the
 * properties are already resolved against the document's base URL — an
 * attribute of `../cart` is not comparable with anything.
 *
 * Field *values* are never read. §37.1: the typed content of a form is the
 * user's, and a recon tool has no reason to carry it.
 */
/**
 * Adapter actions whose policy name differs.
 *
 * Only reads appear here. An action that changes state must never be mapped
 * onto a gentler name: the mapping exists to avoid synonyms, not to soften
 * what a call does.
 */
const POLICY_ACTION: Readonly<Partial<Record<AdapterAction, string>>> = {
  harvest: "inspect_page",
};

/**
 * The policy's name for an adapter action.
 *
 * Exported so the boundary tests can check *the mapped name* against
 * `PERMITTED_ACTIONS`. Without it those tests compared the adapter's
 * vocabulary against the policy's directly, and adding a mapping would have
 * turned a working drift guard into a failing one — which is a fine outcome
 * for the person who added it and a bad one for the guard.
 */
export function policyActionFor(action: AdapterAction): string {
  return POLICY_ACTION[action] ?? action;
}

function readHarvest(): Omit<PageHarvest, "url"> {
  const links: string[] = [];
  const seen = new Set<string>();
  for (const anchor of Array.from(document.querySelectorAll("a[href]"))) {
    const href = (anchor as HTMLAnchorElement).href;
    if (href === "" || seen.has(href)) continue;
    seen.add(href);
    links.push(href);
  }

  const describeForm = (element: HTMLFormElement): HarvestedForm => {
    const submit = element.querySelector(
      "button[type=submit], button:not([type]), input[type=submit]",
    );
    const submitText =
      submit?.textContent?.trim() ?? (submit as HTMLInputElement | null)?.value ?? "";
    return {
      ...(element.id === "" ? {} : { id: element.id }),
      method: (element.method === "" ? "get" : element.method).toUpperCase(),
      action: element.action,
      fields: Array.from(element.querySelectorAll("input, select, textarea")).map((field) => ({
        name: (field as HTMLInputElement).name,
        type: String((field as HTMLInputElement).type ?? field.tagName.toLowerCase()),
      })),
      ...(submitText === "" ? {} : { submitText }),
    };
  };

  const forms = Array.from(document.querySelectorAll("form")).map((form) =>
    describeForm(form as HTMLFormElement),
  );

  // Controls, not links. A link is followed by navigating; a control is here
  // because clicking it *does* something, which is the part a workflow is
  // made of.
  const CONTROL_SELECTOR = [
    "button",
    "input[type=submit]",
    "input[type=button]",
    "[role=button]",
    "[onclick]",
    "summary",
    "[role=tab]",
    "[role=menuitem]",
  ].join(",");

  const visible = (element: Element): boolean => {
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    const style = window.getComputedStyle(element);
    return style.visibility !== "hidden" && style.display !== "none";
  };

  const controls: HarvestedControl[] = [];
  for (const [index, element] of Array.from(
    document.querySelectorAll(CONTROL_SELECTOR),
  ).entries()) {
    if (!visible(element)) continue;
    if ((element as HTMLButtonElement).disabled === true) continue;

    const owner = element.closest("form") as HTMLFormElement | null;
    const type = String((element as HTMLButtonElement).type ?? "");
    // A `<button>` with no type inside a form submits it — the default
    // nobody remembers, and the difference between a click and a POST.
    const submits =
      owner !== null &&
      (type === "submit" ||
        (element.tagName.toLowerCase() === "button" && !element.hasAttribute("type")));

    // The element itself first, then its ancestors: a positional selector is
    // built from the chain, and the chain has to start where the element is.
    const ancestors: AncestorStep[] = [];
    let step: Element | null = element;
    for (let depth = 0; depth < 5 && step !== null; depth += 1) {
      const tag = step.tagName.toLowerCase();
      const siblings =
        step.parentElement === null
          ? [step]
          : Array.from(step.parentElement.children).filter(
              (sibling) => sibling.tagName === (step as Element).tagName,
            );
      const stepId = step.id;
      const stepTestId = step.getAttribute("data-testid");

      ancestors.push({
        tagName: tag,
        ...(stepId === "" ? {} : { id: stepId }),
        classes: Array.from(step.classList).slice(0, 8),
        nthOfType: siblings.indexOf(step) + 1,
        uniqueOfType: siblings.length === 1,
        ...(stepTestId === null ? {} : { testId: stepTestId }),
      });
      step = step.parentElement;
    }

    controls.push({
      index,
      facts: {
        tagName: element.tagName.toLowerCase(),
        ...(type === "" ? {} : { type }),
        accessibleName: (
          element.getAttribute("aria-label") ??
          element.textContent ??
          (element as HTMLInputElement).value ??
          ""
        )
          .trim()
          .slice(0, 200)
          .toLowerCase(),
        inForm: owner !== null,
        ...((element as HTMLAnchorElement).href === undefined
          ? {}
          : { href: (element as HTMLAnchorElement).href }),
        nonGetMethod: owner !== null && (owner.method ?? "get").toLowerCase() !== "get",
        ...(element.id === "" ? {} : { id: element.id }),
        classes: Array.from(element.classList).slice(0, 8),
        ...(element.getAttribute("data-testid") === null
          ? {}
          : { testId: element.getAttribute("data-testid") as string }),
        ...((element as HTMLInputElement).name
          ? { name: (element as HTMLInputElement).name }
          : {}),
        ...(element.getAttribute("role") === null
          ? {}
          : { role: element.getAttribute("role") as string }),
        ancestors,
      },
      ...(submits && owner !== null ? { submitsForm: describeForm(owner) } : {}),
    });
  }

  /**
   * WebMCP registries — build plan §21.
   *
   * The spec is young and implementations disagree, so this normalises rather
   * than assuming. The first real site it met got **nothing**: it read
   * `tools` with `Array.isArray`, and a production registry exposes a `Map`
   * keyed by tool name whose values are wrappers — the descriptor lives under
   * `item`. Four tools were there and the scan reported none, silently,
   * because absence is the normal case for WebMCP and nothing distinguished
   * "not present" from "present and unreadable".
   *
   * So: every plausible container, the descriptor either bare or wrapped, the
   * name from the key when the descriptor has none, and the schema whether it
   * arrives as an object or as JSON text.
   *
   * `getTools()` is deliberately not used. It looked like the right thing —
   * a public API ages better than internals — but the one implementation
   * measured returns a Map from it too, so it buys nothing and adds a call
   * into page code. Nothing here ever touches `executeTool` (§7.2).
   *
   * Bounded deliberately. A page controls what is in its registry, and a
   * thousand tools with megabyte schemas would otherwise be serialised
   * straight out of the browser and into the event log.
   */
  const MAX_TOOLS = 100;
  const MAX_SCHEMA_CHARS = 8_000;
  const registries: readonly [string, unknown][] = [
    ["navigator.modelContext", (navigator as unknown as Record<string, unknown>).modelContext],
    ["navigator.mcp", (navigator as unknown as Record<string, unknown>).mcp],
    ["window.agent", (window as unknown as Record<string, unknown>).agent],
  ];

  /** Any container the `tools` property might be, as key/value pairs. */
  const entriesOf = (tools: unknown): [unknown, unknown][] => {
    if (tools instanceof Map) return [...tools.entries()];
    if (Array.isArray(tools)) return tools.map((value, index) => [index, value]);
    if (tools instanceof Set) return [...tools].map((value, index) => [index, value]);
    if (typeof tools === "object" && tools !== null) return Object.entries(tools);
    return [];
  };

  /** The public descriptor, which may be the value or may be wrapped. */
  const descriptorOf = (value: unknown): Record<string, unknown> => {
    const outer = (value ?? {}) as Record<string, unknown>;
    const item = outer.item;
    return typeof item === "object" && item !== null
      ? (item as Record<string, unknown>)
      : outer;
  };

  /** A schema arrives as an object, or as the JSON text of one. */
  const schemaOf = (descriptor: Record<string, unknown>, wrapper: unknown): unknown => {
    const outer = (wrapper ?? {}) as Record<string, unknown>;
    const candidate =
      descriptor.inputSchema ?? outer.inputSchema ?? outer.registeredInputSchema;
    if (candidate === undefined || candidate === null) return undefined;
    try {
      const text = typeof candidate === "string" ? candidate : JSON.stringify(candidate);
      if (text === undefined || text.length > MAX_SCHEMA_CHARS) return undefined;
      return JSON.parse(text);
    } catch {
      // A cycle, a throwing getter, a BigInt, or text that is not JSON. The
      // tool's existence is the finding; its schema is a bonus.
      return undefined;
    }
  };

  const webmcpTools: HarvestedWebMcpTool[] = [];
  const registriesSeen: string[] = [];
  const named = new Set<string>();

  for (const [registry, value] of registries) {
    if (value === undefined || value === null) continue;
    registriesSeen.push(registry);

    for (const [key, raw] of entriesOf((value as { tools?: unknown }).tools).slice(
      0,
      MAX_TOOLS,
    )) {
      const descriptor = descriptorOf(raw);
      // A Map is keyed by tool name, so the key is the name when the
      // descriptor does not carry one of its own.
      const named_ = descriptor.name ?? (typeof key === "string" ? key : undefined);
      const name = typeof named_ === "string" ? named_ : undefined;
      if (name === undefined || name === "" || named.has(name)) continue;
      named.add(name);

      const schema = schemaOf(descriptor, raw);
      // §7.2's reason for reading these at all: `readOnlyHint: false` or
      // `destructiveHint: true` is a destructive operation the page is
      // publishing to any agent that visits. Reported, never invoked.
      const annotations = descriptor.annotations;
      let hints: Record<string, unknown> | undefined;
      try {
        hints =
          typeof annotations === "object" && annotations !== null
            ? (JSON.parse(JSON.stringify(annotations)) as Record<string, unknown>)
            : undefined;
      } catch {
        hints = undefined;
      }

      webmcpTools.push({
        name: name.slice(0, 200),
        ...(typeof descriptor.description === "string"
          ? { description: descriptor.description.slice(0, 500) }
          : {}),
        ...(schema === undefined ? {} : { inputSchema: schema }),
        ...(typeof descriptor.endpoint === "string"
          ? { endpoint: descriptor.endpoint.slice(0, 2_000) }
          : {}),
        ...(hints === undefined ? {} : { annotations: hints }),
        registry,
      });
    }
  }

  return { links, forms, controls, webmcpTools, webmcpRegistriesSeen: registriesSeen };
}

function withDeadline<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      const error = new Error(`${what} did not settle within ${ms}ms`);
      error.name = "TimeoutError";
      reject(error);
    }, ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

export interface PuppeteerAdapterOptions {
  readonly session: BrowserSession;
  readonly engine: PolicyEngine;
  readonly logger?: Logger | undefined;
  readonly defaultTimeoutMs?: number | undefined;
}

/** Map a driver exception onto a typed failure, so nothing opaque escapes. */
function classify(error: unknown): { kind: FailureKind; detail: string } {
  const detail = error instanceof Error ? error.message : String(error);
  const name = error instanceof Error ? error.name : "";

  // The error class first, message text second. Puppeteer's timeout for a
  // missing selector reads "Waiting for selector `#x` failed" — no "timeout",
  // no "exceeded" — so matching on wording alone quietly turned every
  // element-not-found into a generic driver error. Class names are stable
  // across versions in a way English sentences are not.
  if (name === "TimeoutError") return { kind: "timeout", detail };
  if (/Timed? ?out|exceeded/i.test(detail)) return { kind: "timeout", detail };
  if (/Session closed|Target closed|Protocol error|detached/i.test(detail)) {
    return { kind: "browser_closed", detail };
  }
  if (/net::|ERR_|NS_ERROR|navigation failed/i.test(detail)) {
    return { kind: "navigation_failed", detail };
  }
  if (/not visible|not clickable|not an Element|intercepted/i.test(detail)) {
    return { kind: "element_not_interactable", detail };
  }
  return { kind: "driver_error", detail };
}

/**
 * Read what the state-change heuristic needs, without leaving the page.
 *
 * A real function, not a string. Puppeteer accepts either, and a string is
 * evaluated as an *expression* — so passing `"(el) => ({...})"` returns the
 * function itself rather than calling it, and the caller silently receives
 * something that is not an ElementFacts at all. That is exactly what happened
 * here, and it surfaced as `accessibleName` being undefined two layers away.
 */
function readFacts(element: Element): ElementFacts {
  const form = element.closest("form");
  const method = (
    element.getAttribute("formmethod") ??
    form?.getAttribute("method") ??
    ""
  ).toLowerCase();

  /** `data-testid` and its common spellings, in the order tools emit them. */
  const testIdOf = (node: Element): string | undefined => {
    for (const attribute of [
      "data-testid",
      "data-test-id",
      "data-test",
      "data-cy",
      "data-qa",
    ]) {
      const value = node.getAttribute(attribute);
      if (value !== null && value !== "") return value;
    }
    return undefined;
  };

  const step = (node: Element): Record<string, unknown> => {
    const siblings =
      node.parentElement === null ? [node] : Array.from(node.parentElement.children);
    const sameTag = siblings.filter((sibling) => sibling.tagName === node.tagName);
    const id = node.getAttribute("id");
    const testId = testIdOf(node);
    return {
      tagName: node.tagName.toLowerCase(),
      ...(id === null || id === "" ? {} : { id }),
      classes: Array.from(node.classList),
      nthOfType: sameTag.indexOf(node) + 1,
      uniqueOfType: sameTag.length === 1,
      ...(testId === undefined ? {} : { testId }),
    };
  };

  // Bounded at eight: deep enough to reach a stable ancestor in any real
  // layout, shallow enough that a deeply nested component does not produce a
  // selector nobody can read.
  const ancestors: Record<string, unknown>[] = [];
  let current: Element | null = element;
  while (current !== null && ancestors.length < 8 && current.tagName !== "HTML") {
    ancestors.push(step(current));
    current = current.parentElement;
  }

  const id = element.getAttribute("id");
  const name = element.getAttribute("name");
  const role = element.getAttribute("role");

  return {
    tagName: element.tagName.toLowerCase(),
    type: element.getAttribute("type") ?? undefined,
    accessibleName: (
      element.getAttribute("aria-label") ??
      element.getAttribute("value") ??
      element.textContent ??
      ""
    )
      .trim()
      .toLowerCase()
      .slice(0, 200),
    inForm: form !== null,
    href: element.getAttribute("href") ?? undefined,
    nonGetMethod: ["post", "put", "delete", "patch"].includes(method),
    ...(id === null || id === "" ? {} : { id }),
    classes: Array.from(element.classList),
    ...(testIdOf(element) === undefined ? {} : { testId: testIdOf(element) }),
    ...(name === null || name === "" ? {} : { name }),
    ...(role === null || role === "" ? {} : { role }),
    ancestors: ancestors as unknown as ElementFacts["ancestors"],
  };
}

export class PuppeteerBrowserAdapter implements BrowserAdapter {
  readonly #page: Page;
  readonly #engine: PolicyEngine;
  readonly #log: Logger;
  readonly #timeout: number;

  private constructor(page: Page, options: PuppeteerAdapterOptions) {
    this.#page = page;
    this.#engine = options.engine;
    this.#log = options.logger ?? silentLogger();
    this.#timeout = options.defaultTimeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS;
  }

  /** Open a page in the session's browser and wrap it. */
  static async create(options: PuppeteerAdapterOptions): Promise<PuppeteerBrowserAdapter> {
    const page = await options.session.browser.newPage();
    // The adapter's budget becomes the page's, so any driver call that takes a
    // timeout and is not given one still answers within it.
    page.setDefaultTimeout(options.defaultTimeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS);
    return new PuppeteerBrowserAdapter(page, options);
  }

  get currentUrl(): string {
    return this.#page.url();
  }

  /**
   * Ask the policy, and return a denial the caller can record.
   *
   * Every action funnels through here. Keeping it one method means a new
   * action cannot be added without a policy check, because there is no other
   * path to the page.
   */
  #check(
    action: AdapterAction,
    proposal: { url?: string | undefined; stateChanging?: boolean | undefined },
  ): ActionResult<never> | undefined {
    const decision: Decision = this.#engine.canAct({
      // The policy has its own vocabulary and this one is the adapter's;
      // where they differ the adapter maps rather than the policy grows a
      // synonym. `harvest` reads the page, which the policy already calls
      // `inspect_page` — adding "harvest" to PERMITTED_ACTIONS would give
      // one capability two names, and the next reader would have to work
      // out whether they mean different things.
      kind: policyActionFor(action),
      ...(proposal.url === undefined ? {} : { url: proposal.url }),
      ...(proposal.stateChanging === undefined
        ? {}
        : { stateChanging: proposal.stateChanging }),
    });

    if (decision.allowed) return undefined;

    this.#log.info("action denied by policy", {
      action,
      reason: decision.reason,
      ...(proposal.url === undefined ? {} : { url: proposal.url }),
    });
    return denied(action, decision);
  }

  async navigate(
    url: string,
    options: ActionOptions = {},
  ): Promise<ActionResult<NavigationOutcome>> {
    const refusal = this.#check("navigate", { url, ...options });
    if (refusal) return refusal;

    try {
      const response = await this.#page.goto(url, {
        timeout: options.timeoutMs ?? this.#timeout,
        waitUntil: "domcontentloaded",
      });

      const landed = this.#page.url();

      // Redirects are followed by the browser before we get control back, so
      // this detects rather than prevents. A redirect that left scope has
      // already been requested; what we can still do is refuse to keep
      // exploring from there, and say so. Pre-emptive blocking needs request
      // interception at the telemetry layer (BR-M1-03), where every request is
      // already being watched.
      if (landed !== url) {
        const afterRedirect = this.#engine.canVisit(landed);
        if (!afterRedirect.allowed) {
          await this.#page.goto("about:blank").catch(() => undefined);
          return denied("navigate", afterRedirect);
        }
      }

      return ok({
        url: landed,
        httpStatus: response?.status(),
        redirected: landed !== url,
      });
    } catch (error) {
      const { kind, detail } = classify(error);
      return failed("navigate", kind, detail);
    }
  }

  async click(
    selector: string,
    options: ActionOptions = {},
  ): Promise<ActionResult<ElementFacts>> {
    const timeout = options.timeoutMs ?? this.#timeout;

    // The element is found once and then acted on directly. The obvious
    // `page.click(selector)` would look the element up a second time, and it
    // takes no timeout in this driver — so a caller asking for 500ms got
    // puppeteer's 30s page default instead. That surfaced as a test hanging
    // for a minute rather than failing, and in a scan it would be a budget
    // nobody honours.
    let element: Awaited<ReturnType<Page["waitForSelector"]>>;
    let facts: ElementFacts;
    try {
      element = await this.#page.waitForSelector(selector, { timeout });
      if (element === null) {
        return failed("click", "element_not_found", `no element matches ${selector}`);
      }
      // Bounded like the click itself. `evaluate` takes no timeout, and a
      // page that is navigating — or a machine that is thrashing — can leave
      // it waiting on an execution context that is going away.
      facts = await withDeadline(element.evaluate(readFacts), timeout, `inspect ${selector}`);
    } catch (error) {
      const { kind, detail } = classify(error);
      // A selector that never appears is the ordinary case, not an error worth
      // a stack trace — it is how a scan learns the page changed.
      return failed("click", kind === "timeout" ? "element_not_found" : kind, detail);
    }

    // Inspect first, ask second. The policy question depends on what the
    // element turns out to be, so the DOM read has to come before the check —
    // it is a read, and reading is not an action the policy governs.
    const verdict = resolveStateChanging(options.stateChanging, inferStateChanging(facts));
    const refusal = this.#check("click", { stateChanging: verdict.stateChanging });
    if (refusal) {
      this.#log.info("click refused", { selector, because: verdict.because });
      await withDeadline(element.dispose(), timeout, "dispose").catch(() => undefined);
      return refusal;
    }

    try {
      await withDeadline(element.click(), timeout, `click on ${selector}`);
      return ok(facts);
    } catch (error) {
      const { kind, detail } = classify(error);
      return failed("click", kind, detail);
    } finally {
      await withDeadline(element.dispose(), timeout, "dispose").catch(() => undefined);
    }
  }

  async type(
    selector: string,
    text: string,
    options: ActionOptions = {},
  ): Promise<ActionResult<void>> {
    // Typing fills a field; it does not submit one. Treated as non-state-
    // changing unless the caller says otherwise, because refusing to type
    // would make every form unobservable while changing nothing on the server.
    const refusal = this.#check("type", { ...options });
    if (refusal) return refusal;

    try {
      await this.#page.waitForSelector(selector, {
        timeout: options.timeoutMs ?? this.#timeout,
      });
      await this.#page.type(selector, text, { delay: 0 });
      return ok(undefined);
    } catch (error) {
      const { kind, detail } = classify(error);
      return failed("type", kind === "timeout" ? "element_not_found" : kind, detail);
    }
  }

  async scroll(
    direction: ScrollDirection,
    options: ActionOptions = {},
  ): Promise<ActionResult<void>> {
    const refusal = this.#check("scroll", { ...options });
    if (refusal) return refusal;

    try {
      await this.#page.evaluate((where: string) => {
        const amount = window.innerHeight * 0.9;
        if (where === "top") window.scrollTo({ top: 0 });
        else if (where === "bottom") window.scrollTo({ top: document.body.scrollHeight });
        else window.scrollBy({ top: where === "up" ? -amount : amount });
      }, direction);
      return ok(undefined);
    } catch (error) {
      const { kind, detail } = classify(error);
      return failed("scroll", kind, detail);
    }
  }

  async back(options: ActionOptions = {}): Promise<ActionResult<NavigationOutcome>> {
    const refusal = this.#check("back", { ...options });
    if (refusal) return refusal;

    try {
      const response = await this.#page.goBack({
        timeout: options.timeoutMs ?? this.#timeout,
        waitUntil: "domcontentloaded",
      });

      const landed = this.#page.url();
      if (response === null) {
        // Nothing in the history. Not a failure of the tool — the scan simply
        // cannot go back — so it is reported as an outcome, not an error.
        return ok({ url: landed, redirected: false });
      }

      return ok({ url: landed, httpStatus: response.status(), redirected: false });
    } catch (error) {
      const { kind, detail } = classify(error);
      return failed("back", kind, detail);
    }
  }

  async harvest(options: ActionOptions = {}): Promise<ActionResult<PageHarvest>> {
    const refusal = this.#check("harvest", { ...options });
    if (refusal) return refusal;

    const timeout = options.timeoutMs ?? this.#timeout;
    try {
      // `evaluate` is given a function, never a string. Puppeteer evaluates
      // a string as an *expression*, which silently returns the function
      // itself rather than calling it — a mistake that surfaces two layers
      // away as an empty result.
      const harvested = await withDeadline(
        this.#page.evaluate(readHarvest),
        timeout,
        "harvest",
      );
      return ok({ ...harvested, url: this.#page.url() });
    } catch (error) {
      const { kind, detail } = classify(error);
      return failed("harvest", kind, detail);
    }
  }

  async waitForSettled(options: ActionOptions = {}): Promise<ActionResult<SettledOutcome>> {
    const refusal = this.#check("wait", { ...options });
    if (refusal) return refusal;

    const budget = options.timeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS;
    const started = Date.now();
    try {
      await this.#page.waitForNetworkIdle({ idleTime: 500, timeout: budget });
      return ok({ waitedMs: Date.now() - started, settled: true });
    } catch (error) {
      const { kind, detail } = classify(error);
      // A page that never goes quiet — polling, a websocket, an animation — is
      // normal on real applications. The scan continues against whatever state
      // it has, and records that it did not settle.
      if (kind === "timeout") {
        return ok({ waitedMs: Date.now() - started, settled: false });
      }
      return failed("wait", kind, detail);
    }
  }

  async close(): Promise<void> {
    try {
      // Bounded too. Teardown that hangs turns one slow test into a suite that
      // never finishes, and the symptom points nowhere near the cause.
      if (!this.#page.isClosed()) {
        await withDeadline(this.#page.close(), this.#timeout, "close page");
      }
    } catch {
      // The browser may already be gone; the manager owns that lifetime and
      // will have cleaned up regardless.
    }
  }
}

/** Convenience factory matching the interface, for callers that want the type. */
export async function createBrowserAdapter(
  options: PuppeteerAdapterOptions,
): Promise<BrowserAdapter> {
  return PuppeteerBrowserAdapter.create(options);
}
