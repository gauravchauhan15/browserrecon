import { createRedactor } from "@browserrecon/core";
import { describe, expect, it } from "vitest";
import {
  COVERAGE_CAVEAT,
  REQUIRED_KEYS,
  validateDocument,
  type ExportedDocument,
} from "./shape.js";
import { streamDocument, streamJsonl, type DocumentInput, type Sink } from "./stream.js";

const redactor = createRedactor();

function collector(): { sink: Sink; chunks: string[]; text: () => string } {
  const chunks: string[] = [];
  return {
    sink: (chunk) => {
      chunks.push(chunk);
    },
    chunks,
    text: () => chunks.join(""),
  };
}

function input(overrides: Partial<DocumentInput> = {}): DocumentInput {
  return {
    scan: {
      session_id: "sess_0001",
      target: "https://shop.example.com",
      started_at: "2026-01-15T10:00:00.000Z",
      completeness: "complete",
      rate_profile: "normal",
      discovery_sources: ["browser"],
      ai_mode: "off",
      coverage_caveat: COVERAGE_CAVEAT,
    },
    origins: [],
    apis: [],
    workflows: [],
    apiSequences: [],
    javascript: [],
    barriers: [],
    coverageGaps: [],
    unreachedCandidateAssociations: [],
    ...overrides,
  };
}

async function exported(overrides: Partial<DocumentInput> = {}): Promise<ExportedDocument> {
  const out = collector();
  await streamDocument(input(overrides), out.sink, { redactor });
  return JSON.parse(out.text()) as ExportedDocument;
}

describe("the streamed document", () => {
  it("is valid JSON with every required key, even when nothing was found", () => {
    return exported().then((document) => {
      expect(validateDocument(document)).toEqual([]);
      for (const key of REQUIRED_KEYS) {
        expect(document, `missing ${key}`).toHaveProperty(key);
      }
    });
  });

  it("emits empty arrays rather than omitting the sections", async () => {
    const document = await exported();
    expect(document.coverage_gaps).toEqual([]);
    expect(document.unreached_candidate_associations).toEqual([]);
  });

  it("carries the coverage caveat without the caller having to add it", async () => {
    // The caveat cannot be something a call site remembers. It is attached
    // here so no export can exist without it.
    const document = await exported();
    expect(document.scan.coverage_caveat).toBe(COVERAGE_CAVEAT);
  });

  it("round-trips elements in order", async () => {
    const document = await exported({
      origins: [
        { origin: "https://shop.example.com", requests: 12, classification: "first_party" },
        { origin: "https://cdn.example.net", requests: 3, classification: "third_party" },
      ],
    });
    expect(document.origins.map((o) => o.origin)).toEqual([
      "https://shop.example.com",
      "https://cdn.example.net",
    ]);
  });

  it("parses the same whether pretty-printed or not", async () => {
    const dense = collector();
    const pretty = collector();
    await streamDocument(input({ apis: [{ api_id: "api_0001" }] }), dense.sink, { redactor });
    await streamDocument(input({ apis: [{ api_id: "api_0001" }] }), pretty.sink, {
      redactor,
      pretty: true,
    });
    expect(JSON.parse(pretty.text())).toEqual(JSON.parse(dense.text()));
    expect(pretty.text().length).toBeGreaterThan(dense.text().length);
  });
});

describe("streaming, not buffering", () => {
  it("writes the header before it pulls the first element", async () => {
    // §22.2: a gigabyte event log is the normal case on a large scan. If the
    // exporter builds the document in memory first, it fails on exactly the
    // scans whose results matter most. Asserting the write order is how that
    // guarantee stops being an aspiration — an implementation that collected
    // sections into an array would reach the generator with nothing written.
    const out = collector();
    let bytesWhenFirstPulled = -1;

    async function* origins(): AsyncGenerator<unknown> {
      bytesWhenFirstPulled = out.text().length;
      yield { origin: "https://shop.example.com", requests: 1, classification: "first_party" };
    }

    await streamDocument(input({ origins: origins() }), out.sink, { redactor });
    expect(bytesWhenFirstPulled).toBeGreaterThan(0);
    expect(out.text().slice(0, bytesWhenFirstPulled)).toContain("schema_version");
  });

  it("writes each element as it arrives rather than once at the end", async () => {
    const out = collector();
    const writesAtYield: number[] = [];

    async function* apis(): AsyncGenerator<unknown> {
      for (let index = 0; index < 5; index += 1) {
        writesAtYield.push(out.chunks.length);
        yield { api_id: `api_000${index}` };
      }
    }

    await streamDocument(input({ apis: apis() }), out.sink, { redactor });
    // Strictly increasing: something was written between consecutive
    // elements, so no element waited for the ones after it.
    for (let index = 1; index < writesAtYield.length; index += 1) {
      expect(writesAtYield[index]).toBeGreaterThan(writesAtYield[index - 1] as number);
    }
  });

  it("accepts a plain array as readily as an async source", async () => {
    // The common case must not need a generator, or call sites will build
    // the array first and defeat the point.
    const document = await exported({ barriers: [{ category: "auth_wall" }] });
    expect(document.barriers).toHaveLength(1);
  });
});

describe("redaction at the export boundary", () => {
  it("redacts a value under a sensitive key", async () => {
    const document = await exported({
      apis: [
        {
          api_id: "api_0001",
          request_headers: { authorization: "Bearer eyJhbGciOi.secret.value" },
        },
      ],
    });
    expect(JSON.stringify(document)).not.toContain("eyJhbGciOi");
    expect(JSON.stringify(document)).toContain("[redacted]");
  });

  it("redacts a secret-shaped value that is not under a telling key", async () => {
    const document = await exported({
      javascript: [
        {
          url: "https://shop.example.com/app.js?token=ghp_0123456789abcdefghij0123456789abcdef",
        },
      ],
    });
    expect(JSON.stringify(document)).not.toContain("ghp_0123456789abcdefghij");
  });

  it("redacts the scan header too, not only the sections", async () => {
    // The header is the easiest place to forget: it is written by a
    // different code path from the arrays.
    const out = collector();
    await streamDocument(
      input({
        scan: {
          ...input().scan,
          target: "https://admin:hunter2@shop.example.com",
        },
      }),
      out.sink,
      { redactor },
    );
    expect(out.text()).not.toContain("hunter2");
  });

  it("cannot be skipped by omitting the option", () => {
    // A compile-time guarantee, asserted here so the intent survives a
    // refactor that makes `redactor` optional "for convenience".
    // @ts-expect-error redactor is required — an optional one is one a caller forgets
    const call = () => streamDocument(input(), collector().sink, {});
    expect(typeof call).toBe("function");
  });
});

describe("JSONL", () => {
  it("writes one valid JSON object per line and reports the count", async () => {
    const out = collector();
    const written = await streamJsonl(
      [{ event_id: "evt_000001" }, { event_id: "evt_000002" }],
      out.sink,
      { redactor },
    );

    expect(written).toBe(2);
    const lines = out.text().trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines.map((line) => JSON.parse(line).event_id)).toEqual([
      "evt_000001",
      "evt_000002",
    ]);
  });

  it("leaves a truncated file usable up to the cut", async () => {
    // The reason for the format. An export interrupted by ^C or a full disk
    // still gives a pipeline every record before the break, where a
    // truncated JSON array gives it nothing.
    const out = collector();
    await streamJsonl([{ n: 1 }, { n: 2 }, { n: 3 }], out.sink, { redactor });

    const truncated = out.text().slice(0, out.text().length - 8);
    const complete = truncated.split("\n").filter((line) => line.endsWith("}"));
    expect(complete.length).toBeGreaterThanOrEqual(2);
    for (const line of complete) expect(() => JSON.parse(line)).not.toThrow();
  });

  it("redacts each record", async () => {
    const out = collector();
    await streamJsonl([{ cookie: "session=abc123" }], out.sink, { redactor });
    expect(out.text()).not.toContain("abc123");
  });

  it("writes nothing for an empty source", async () => {
    const out = collector();
    expect(await streamJsonl([], out.sink, { redactor })).toBe(0);
    expect(out.text()).toBe("");
  });
});
