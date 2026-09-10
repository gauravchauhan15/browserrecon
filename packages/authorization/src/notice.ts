/**
 * What the user is shown — build plan §7.4.
 *
 * §7.4 point 4 requires that enabling a higher-risk setting prints, in plain
 * language, what it permits. That word matters: a jargon label is not a
 * warning. "The scan may permanently delete data on the target" tells someone
 * what to do; `allowedMethods: [DELETE]` does not.
 */
import type { ElevatedRisk } from "@browserrecon/policy";

/**
 * The first-run authorized-use notice.
 *
 * Written to be read rather than skipped: short, specific about what the tool
 * does to a target, and honest that consequences land on the user.
 */
export const AUTHORIZED_USE_NOTICE = `
BrowserRecon drives a real Chrome browser against the application you point it
at. It loads pages, follows links, and submits forms. Given credentials, it
signs in.

Only scan systems you own, or have written permission to test.

Scanning without authorization may be unlawful where you are, and is your
responsibility rather than this tool's. BrowserRecon does not attempt to bypass
authentication, CAPTCHAs, WAF rules or bot detection — it records them and
moves on.
`.trim();

/** Shown before each new target origin. */
export function targetNotice(targetOrigin: string): string {
  return `About to scan: ${targetOrigin}\nConfirm you are authorized to test this target.`;
}

/**
 * Render higher-risk settings.
 *
 * Returns an empty string when there is nothing to report, so a caller can
 * treat "no risks" as "print nothing" without a special case — and so the
 * common path stays quiet rather than training users to dismiss a warning
 * that always appears.
 */
export function renderRisks(risks: readonly ElevatedRisk[]): string {
  if (risks.length === 0) return "";

  const lines = risks.map((risk) => `  - ${risk.setting}\n      ${risk.consequence}`);
  const noun = risks.length === 1 ? "setting" : "settings";

  return [
    `You have enabled ${risks.length} higher-risk ${noun}:`,
    "",
    ...lines,
    "",
    "These go beyond a read-only scan. Only continue on a target you control.",
  ].join("\n");
}

/** Message for a non-interactive run that cannot prompt. */
export function nonInteractiveHelp(targetOrigin: string): string {
  return [
    `Cannot confirm authorization for ${targetOrigin}: no interactive terminal.`,
    "",
    "Pass --i-am-authorized to assert that you are permitted to test this target.",
    "In CI, set it explicitly rather than relying on a stored acknowledgment, so",
    "the assertion is visible in the pipeline definition.",
  ].join("\n");
}
