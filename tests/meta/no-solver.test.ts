import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Asserts that no code in this repository attempts to defeat a challenge.
 *
 * Build plan §7.3 puts CAPTCHA and WAF circumvention permanently out of
 * scope, and dev plan BR-M1-29b makes that a safety test rather than a
 * convention. The reason it needs to be mechanical: the interactive barrier
 * assist (`decideAssist`) sits one small step away from being a solver. Both
 * start from "a challenge was detected"; one waits for a person and the
 * other answers it. A future change that slides from the first to the second
 * would look like a natural extension in a diff, and would be a different
 * tool.
 *
 * The scan is deliberately crude — substrings, not semantics. A
 * sophisticated solver written to slip past this check is not something a
 * lint rule can stop, and it is also not something anyone does by accident.
 * What this catches is the accident: a well-meant `solveCaptcha` helper, a
 * `2captcha` API key, a `--rotate-user-agent` flag someone added to get past
 * a block.
 *
 * Allowed everywhere: the *words*, in comments, refusals, remedy text and
 * tests like this one. Refusing to name the thing you are refusing to do
 * makes the refusal impossible to document.
 */

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SEARCH_ROOTS = ["apps", "packages", "scripts", "tests"];
const SKIP_DIRS = new Set(["node_modules", "dist", "coverage", "baselines", ".output"]);

/**
 * Names that only exist in code whose purpose is to defeat a control.
 *
 * `scan` picks how much of the file the rule sees, and getting it wrong is
 * how this test silently stops working. `identifier` rules run against
 * source with comments *and string literals* removed, because their words
 * appear in prose all over this repository — the §7.3 refusals have to be
 * able to say what they refuse. `literal` rules keep the strings, because
 * what they look for only ever appears inside one: a service endpoint, an
 * API key's provider, a property name passed to `defineProperty`. Two
 * probes for exactly those cases passed against an identifier-only scan.
 */
type ScanKind = "identifier" | "literal";

const FORBIDDEN: readonly {
  readonly pattern: RegExp;
  readonly why: string;
  readonly scan: ScanKind;
}[] = [
  {
    pattern:
      /\b(solve|bypass|defeat|crack)(Captcha|Challenge|Recaptcha|Turnstile|Hcaptcha|Waf)\b/i,
    why: "a function that answers a challenge",
    scan: "identifier",
  },
  {
    pattern:
      /\b(rotateUserAgent|randomizeUserAgent|spoofUserAgent|evadeDetection|hideWebdriver)\b/i,
    why: "detection evasion",
    scan: "identifier",
  },
  {
    pattern: /\b(2captcha|anti-?captcha|capsolver|deathbycaptcha|capmonster|captchaai)\b/i,
    why: "a challenge-solving service",
    scan: "literal",
  },
  {
    pattern:
      /\bpuppeteer-extra-plugin-stealth\b|\bplaywright-stealth\b|\bundetected[-_]?chromedriver\b/i,
    why: "a detection-evasion package",
    scan: "literal",
  },
  {
    pattern:
      /navigator\.webdriver\s*=|delete\s+navigator\.webdriver|defineProperty\(\s*navigator\s*,\s*["']webdriver["']/,
    why: "hiding the automation signature Chrome advertises",
    scan: "literal",
  },
];

function sourceFiles(dir: string): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return SKIP_DIRS.has(entry.name) ? [] : sourceFiles(path);
    return /\.(ts|mjs|js|json)$/.test(entry.name) ? [path] : [];
  });
}

/**
 * Remove comments.
 *
 * Both scans do this. Without it the check fires on its own documentation,
 * and the usual fix for that is an allowlist that grows until it covers the
 * real thing too.
 */
function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1 ");
}

/** Also remove string literals, for rules whose words appear in prose. */
function withoutLiterals(text: string): string {
  return withoutComments(text)
    .replace(/`(?:[^`\\]|\\.)*`/g, '""')
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, '""');
}

const files = SEARCH_ROOTS.flatMap((root) => sourceFiles(join(repoRoot, root)));
const thisFile = resolve(fileURLToPath(import.meta.url));

describe("§7.3: no challenge solving exists in the codebase", () => {
  it("scans a plausible number of files", () => {
    // A scan that silently matched nothing because the walk broke would
    // pass every assertion below.
    expect(files.length).toBeGreaterThan(100);
  });

  it.each(FORBIDDEN)("has no $why", ({ pattern, scan }) => {
    const prepare = scan === "identifier" ? withoutLiterals : withoutComments;
    const offenders = files
      .filter((file) => file !== thisFile)
      .flatMap((file) => {
        const match = pattern.exec(prepare(readFileSync(file, "utf8")));
        return match === null ? [] : [`${relative(repoRoot, file)}: ${match[0]}`];
      });

    expect(offenders).toEqual([]);
  });

  it("depends on no solving service or evasion package", () => {
    // The dependency path is the easy one to take and the easy one to miss
    // in review, so it is checked against the manifests directly rather
    // than through the source scan.
    const manifests = files.filter((file) => file.endsWith("package.json"));
    expect(manifests.length).toBeGreaterThan(10);

    for (const manifest of manifests) {
      const parsed = JSON.parse(readFileSync(manifest, "utf8")) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const names = [
        ...Object.keys(parsed.dependencies ?? {}),
        ...Object.keys(parsed.devDependencies ?? {}),
      ];
      for (const name of names) {
        expect(
          /captcha|stealth|undetected|solver/i.test(name),
          `${relative(repoRoot, manifest)} depends on ${name}`,
        ).toBe(false);
      }
    }
  });

  it("still allows the words, so the refusal can be documented", () => {
    // The counterweight: if this test forced the vocabulary out of the
    // repo, the remedy strings and the §7.3 comments would have to stop
    // saying what they refuse to do.
    const barriers = readFileSync(
      join(repoRoot, "packages/collectors/network/src/barriers.ts"),
      "utf8",
    );
    expect(barriers.toLowerCase()).toContain("captcha");
  });
});
