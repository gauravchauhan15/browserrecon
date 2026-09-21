/**
 * @browserrecon/discovery-external — discovery that is not Katana.
 *
 * §10D.1's three levels: import any crawler's output, declare an external
 * command, or use the browser-native sources that are always on. Together
 * they are why Katana is *suggested* rather than required.
 */
export const PACKAGE_NAME = "@browserrecon/discovery-external" as const;

export { importUrls } from "./import.js";
export type { ImportOptions, ImportOutcome } from "./import.js";

export { parseRobots, parseSitemap } from "./browser-native.js";
export type { RobotsFindings } from "./browser-native.js";
