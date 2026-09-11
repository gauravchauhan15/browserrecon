import { describe, expect, it } from "vitest";
import { PACKAGE_NAME } from "./index.js";

describe("@browserrecon/browser-manager", () => {
  it("exposes its identity", () => {
    expect(PACKAGE_NAME).toBe("@browserrecon/browser-manager");
  });
});
