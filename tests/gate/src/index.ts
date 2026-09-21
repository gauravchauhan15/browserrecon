/**
 * @browserrecon/gate — the milestone gates.
 *
 * A gate is not a unit test. It asserts the properties a *version* claims,
 * end to end, against a real browser and a real fixture: the things that
 * would still be broken with every package's own tests green.
 */
export const PACKAGE_NAME = "@browserrecon/gate" as const;
