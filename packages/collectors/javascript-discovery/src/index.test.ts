import { describe, expect, it } from "vitest";
import { PACKAGE_NAME } from "./index.js";

describe("@browserrecon/collector-javascript-discovery", () => {
  it("exposes its identity", () => {
    expect(PACKAGE_NAME).toBe("@browserrecon/collector-javascript-discovery");
  });
});
