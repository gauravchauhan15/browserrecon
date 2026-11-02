import { describe, expect, it } from "vitest";
import { compareCandidates, createQueue, type Candidate, type QueueOptions } from "./queue.js";
import { normalizeIdentity } from "./identity.js";

const allow: QueueOptions = { refuse: () => undefined };
const c = (url: string, overrides: Partial<Candidate> = {}): Candidate => ({
  url,
  source: "dom_link",
  depth: 1,
  ...overrides,
});

describe("visit order is reproducible", () => {
  it("orders by depth, then source, then URL", async () => {
    // §5A.5: the same inputs must produce the same order across runs, or
    // §36.2's golden comparison is comparing two different scans.
    const queue = createQueue(allow);
    for (const candidate of [
      c("https://a.test/z", { depth: 2 }),
      c("https://a.test/b", { depth: 1, source: "imported" }),
      c("https://a.test/a", { depth: 1, source: "dom_link" }),
      c("https://a.test/seed", { depth: 0, source: "seed" }),
    ]) {
      queue.offer(candidate);
    }

    expect(queue.peekAll().map((entry) => entry.url)).toEqual([
      "https://a.test/seed",
      "https://a.test/a",
      "https://a.test/b",
      "https://a.test/z",
    ]);
  });

  it("does not depend on the order candidates arrived in", async () => {
    // The failure this guards against: a queue whose order is a function of
    // which network response happened to land first.
    const candidates = [
      c("https://a.test/d", { depth: 1 }),
      c("https://a.test/c", { depth: 0, source: "seed" }),
      c("https://a.test/b", { depth: 2 }),
      c("https://a.test/a", { depth: 1, source: "js_mining" }),
    ];

    const orderFrom = (input: Candidate[]): string[] => {
      const queue = createQueue(allow);
      for (const candidate of input) queue.offer(candidate);
      return queue.peekAll().map((entry) => entry.url);
    };

    const expected = orderFrom(candidates);
    expect(orderFrom([...candidates].reverse())).toEqual(expected);
    expect(orderFrom([candidates[2]!, candidates[0]!, candidates[3]!, candidates[1]!])).toEqual(
      expected,
    );
  });

  it("breaks ties on the URL, never on insertion", async () => {
    const a = c("https://a.test/alpha");
    const b = c("https://a.test/beta");
    expect(compareCandidates(a, b)).toBeLessThan(0);
    expect(compareCandidates(b, a)).toBeGreaterThan(0);
    expect(compareCandidates(a, a)).toBe(0);
  });

  it("puts a shallow candidate found late ahead of a deep one already queued", async () => {
    const queue = createQueue(allow);
    queue.offer(c("https://a.test/deep", { depth: 5 }));
    queue.offer(c("https://a.test/shallow", { depth: 1 }));
    expect(queue.take()?.url).toBe("https://a.test/shallow");
  });
});

describe("every skip has a reason", () => {
  it("records an out-of-scope refusal with its cause", async () => {
    const queue = createQueue({
      refuse: (url) =>
        url.includes("elsewhere")
          ? { reason: "out_of_scope", detail: "not an allowed origin" }
          : undefined,
    });
    queue.offer(c("https://elsewhere.test/x"));

    expect(queue.skipped).toHaveLength(1);
    expect(queue.skipped[0]).toMatchObject({
      reason: "out_of_scope",
      detail: "not an allowed origin",
    });
  });

  it("refuses anything that is not http, before asking policy", async () => {
    // The cheapest scope check there is, and it stops the Explorer trying to
    // navigate to a phone number.
    const queue = createQueue(allow);
    for (const url of [
      "mailto:a@b.test",
      "tel:+100",
      "javascript:void(0)",
      "data:text/html,x",
    ]) {
      queue.offer(c(url));
    }
    expect(queue.skipped.map((s) => s.reason)).toEqual(Array(4).fill("not_http"));
    expect(queue.pending).toBe(0);
  });

  it("records the source, so coverage can say where a missed URL came from", async () => {
    const queue = createQueue({ refuse: () => ({ reason: "policy_denied", detail: "no" }) });
    queue.offer(c("https://a.test/x", { source: "imported" }));
    expect(queue.skipped[0]?.source).toBe("imported");
  });
});

describe("crawl depth", () => {
  const open = { refuse: (): undefined => undefined };

  it("refuses a candidate past the limit", async () => {
    // Depth was tracked from the first commit and used only to *order* the
    // queue. Ordering shapes a crawl without bounding it: a paginated
    // listing could absorb a whole page budget at depth 20 while sections
    // of the application sat unvisited at depth 2.
    const queue = createQueue({ ...open, maxDepth: 3 });
    expect(queue.offer(c("https://a.test/ok", { depth: 3 }))).toBeUndefined();
    expect(queue.offer(c("https://a.test/deep", { depth: 4 }))?.reason).toBe("depth_exceeded");
  });

  it("records the refusal rather than dropping it", async () => {
    // §45: a URL too deep to visit is still a URL the scan found, and
    // coverage accounting has to be able to say why it was not reached.
    const queue = createQueue({ ...open, maxDepth: 1 });
    queue.offer(c("https://a.test/deep", { depth: 9 }));
    expect(queue.skipped).toHaveLength(1);
    expect(queue.skipped[0]?.detail).toContain("9");
    expect(queue.skipped[0]?.detail).toContain("1");
  });

  it("does not spend a policy check on a candidate already refused", async () => {
    // Order matters: asking about scope first would consult the engine for
    // a URL whose fate is decided, and on a deep site that is most of them.
    let asked = 0;
    const queue = createQueue({
      refuse: () => {
        asked += 1;
        return undefined;
      },
      maxDepth: 2,
    });
    queue.offer(c("https://a.test/deep", { depth: 7 }));
    expect(asked).toBe(0);
  });

  it("imposes no limit when none is given", async () => {
    // Absent means unbounded, which is what the queue did before and what
    // `--max-depth 0` asks for.
    const queue = createQueue(open);
    expect(queue.offer(c("https://a.test/deep", { depth: 99 }))).toBeUndefined();
  });
});

describe("nothing is visited twice", () => {
  it("refuses a URL already visited", async () => {
    const queue = createQueue(allow);
    queue.markVisited("https://a.test/x");
    queue.offer(c("https://a.test/x"));

    expect(queue.pending).toBe(0);
    expect(queue.skipped[0]?.reason).toBe("already_visited");
  });

  it("treats two URLs differing only by fragment as the same page", async () => {
    // A fragment never reaches the server. The soft navigation it causes is
    // recorded separately (§16), so nothing is lost by not visiting twice.
    const queue = createQueue(allow);
    queue.offer(c("https://a.test/page"));
    queue.offer(c("https://a.test/page#section"));
    expect(queue.pending).toBe(1);
  });

  it("keeps a query-string difference, which the server does see", async () => {
    const queue = createQueue(allow);
    queue.offer(c("https://a.test/p?id=1"));
    queue.offer(c("https://a.test/p?id=2"));
    expect(queue.pending).toBe(2);
  });

  it("does not count a duplicate as a coverage miss", async () => {
    // Counting it would inflate the "we did not reach this" number that
    // §10C reads.
    const queue = createQueue(allow);
    queue.offer(c("https://a.test/p"));
    queue.offer(c("https://a.test/p"));
    expect(queue.skipped).toHaveLength(0);
  });

  it("empties, and says so", async () => {
    const queue = createQueue(allow);
    queue.offer(c("https://a.test/p"));
    expect(queue.take()?.url).toBe("https://a.test/p");
    expect(queue.take()).toBeUndefined();
  });
});

describe("identity", () => {
  it("errs towards visiting rather than merging", async () => {
    // Opposite trade to the network collector's URL identity: over-merging
    // loses coverage, under-merging wastes a request, and lost coverage is
    // worse.
    expect(normalizeIdentity("https://a.test/Admin")).not.toBe(
      normalizeIdentity("https://a.test/admin"),
    );
    expect(normalizeIdentity("https://a.test/p/")).not.toBe(
      normalizeIdentity("https://a.test/p"),
    );
  });

  it("returns undefined for anything that is not a page", async () => {
    expect(normalizeIdentity("mailto:x@y.test")).toBeUndefined();
    expect(normalizeIdentity("not a url")).toBeUndefined();
  });
});
