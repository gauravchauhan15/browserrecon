import { describe, it } from "vitest";
import { renderSummary, summaryAsJson, type ScanSummary } from "@browserrecon/cli";
import { renderReport, type ReportInput } from "@browserrecon/exporter-markdown";
import { combine, normalizeText } from "./normalize.js";
import { expectGolden } from "./snapshot.js";
import { goldenEnvironment } from "./index.js";

/**
 * What a user actually sees at the end of a scan, pinned to a baseline.
 *
 * BR-M1-27b asks for exactly this: a Tier 0 summary and an empty scan. Unit
 * tests assert individual claims — "never says complete coverage", "fits 80
 * columns" — but they cannot catch the change that keeps every claim true
 * and still makes the output worse. A baseline can, because a reviewer reads
 * the whole thing in the diff.
 *
 * The empty scan is the more valuable of the two. It is the output of a
 * misconfigured run, a blocked target, or a policy that excluded everything
 * — the moment a user most needs the tool to explain itself, and the case
 * least likely to be looked at by hand.
 */

const golden = goldenEnvironment(process.env, new URL("../baselines/", import.meta.url));

const TIER0_SUMMARY: ScanSummary = {
  target: "https://shop.example.com",
  sessionId: "sess_0001",
  durationSeconds: 184,
  completeness: "partial",
  stopReason: "max_pages",
  pagesVisited: 24,
  candidatesDiscovered: 61,
  templatesSaturated: 3,
  instancesSkipped: 118,
  workflows: 4,
  apisObserved: 18,
  apisUnobserved: 7,
  origins: 5,
  jsAssets: 11,
  barriers: [
    { category: "auth_wall", count: 3 },
    { category: "rate_limit", count: 1 },
  ],
  topGaps: [
    { reason: "auth_required", count: 14 },
    { reason: "excluded_by_policy", count: 9 },
    { reason: "budget_exhausted", count: 7 },
  ],
  discoverySources: ["browser"],
  aiMode: "off",
  rateProfile: "normal",
  artifacts: [
    ".output/sess_0001/report.md",
    ".output/sess_0001/attack-surface.json",
    ".output/sess_0001/events.jsonl",
  ],
  outputDir: ".output/sess_0001",
};

/** A scan that found nothing — the case that has to degrade cleanly. */
const EMPTY_SUMMARY: ScanSummary = {
  target: "https://locked.example.com",
  sessionId: "sess_0002",
  durationSeconds: 6,
  completeness: "complete",
  pagesVisited: 1,
  candidatesDiscovered: 1,
  templatesSaturated: 0,
  instancesSkipped: 0,
  workflows: 0,
  apisObserved: 0,
  apisUnobserved: 0,
  origins: 1,
  jsAssets: 0,
  barriers: [{ category: "auth_wall", count: 1 }],
  topGaps: [{ reason: "auth_required", count: 1 }],
  discoverySources: ["browser"],
  aiMode: "off",
  rateProfile: "polite",
  artifacts: [".output/sess_0002/report.md"],
  outputDir: ".output/sess_0002",
};

const TIER0_REPORT: ReportInput = {
  header: {
    target: "https://shop.example.com",
    sessionId: "sess_0001",
    schemaVersion: "1.0.0",
    durationSeconds: 184,
    rateProfile: "normal",
    allowedMethods: ["GET", "HEAD", "OPTIONS"],
    discoverySources: ["browser"],
    authState: "anonymous",
    aiMode: "off",
  },
  coverage: [
    { dimension: "Pages", observed: 24, discovered: 61 },
    { dimension: "APIs", observed: 18, discovered: 25 },
    { dimension: "Origins", observed: 5, discovered: 5 },
  ],
  webmcpTools: [
    {
      name: "searchProducts",
      endpoint: "/api/products/search",
      description: "Search the catalog by keyword.",
    },
  ],
  workflows: [
    {
      id: "wf_0001",
      name: "Add to cart",
      confidence: 0.86,
      steps: [
        {
          step: 1,
          kind: "interaction",
          detail: "click #add-to-cart",
          causedBy: ["evt_000041"],
        },
        { step: 2, kind: "request", detail: "POST /api/cart", causedBy: ["evt_000042"] },
        { step: 3, kind: "request", detail: "GET /api/cart/count", parallel: true },
      ],
    },
    {
      id: "wf_0002",
      name: "Unnamed sequence",
      confidence: 0.34,
      steps: [{ step: 1, kind: "navigation", detail: "pushState /checkout" }],
    },
  ],
  apis: [
    {
      method: "GET",
      url: "https://shop.example.com/api/products",
      status: 200,
      role: "consumer",
    },
    { method: "POST", url: "https://shop.example.com/api/cart", status: 201, role: "consumer" },
    { method: "GET", url: "https://shop.example.com/api/session", status: 401, role: "auth" },
  ],
  origins: [
    { origin: "https://shop.example.com", requests: 84, classification: "first_party" },
    { origin: "https://cdn.example.net", requests: 12, classification: "third_party_cdn" },
  ],
  barriers: [
    { category: "auth_wall", url: "https://shop.example.com/account", evidence: "evt_000103" },
  ],
  gaps: [
    { reason: "auth_required", count: 14, remedy: "Configure an auth profile and re-run." },
    { reason: "excluded_by_policy", count: 9, remedy: "Widen --allowed-paths if intended." },
  ],
};

describe("end-of-scan output", () => {
  it("matches the Tier 0 baseline", () => {
    expectGolden(
      "scan-output-tier0",
      combine([
        ["terminal summary", normalizeText(renderSummary(TIER0_SUMMARY))],
        ["terminal summary (--json)", normalizeText(summaryAsJson(TIER0_SUMMARY))],
        ["report.md", normalizeText(renderReport(TIER0_REPORT))],
      ]),
      golden,
    );
  });

  it("matches the empty-scan baseline", () => {
    // Degrading cleanly is a promise the baseline holds us to: no bare
    // zeroes without context, no "0%" that reads like a failure, and the
    // caveat still present when there is nothing to caveat.
    expectGolden(
      "scan-output-empty",
      combine([
        ["terminal summary", normalizeText(renderSummary(EMPTY_SUMMARY))],
        [
          "report.md",
          normalizeText(
            renderReport({
              header: {
                target: "https://locked.example.com",
                sessionId: "sess_0002",
                schemaVersion: "1.0.0",
                durationSeconds: 6,
                rateProfile: "polite",
                allowedMethods: ["GET", "HEAD", "OPTIONS"],
                discoverySources: ["browser"],
                authState: "anonymous",
                aiMode: "off",
              },
              coverage: [{ dimension: "Pages", observed: 1, discovered: 1 }],
              workflows: [],
              webmcpTools: [],
              apis: [],
              origins: [
                {
                  origin: "https://locked.example.com",
                  requests: 2,
                  classification: "first_party",
                },
              ],
              barriers: [
                {
                  category: "auth_wall",
                  url: "https://locked.example.com/",
                  evidence: "evt_000002",
                },
              ],
              gaps: [
                {
                  reason: "auth_required",
                  count: 1,
                  remedy: "Configure an auth profile and re-run.",
                },
              ],
            }),
          ),
        ],
      ]),
      golden,
    );
  });
});
