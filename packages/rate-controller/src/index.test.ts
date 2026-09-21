import { describe, expect, it } from "vitest";
import { PACKAGE_NAME } from "./index.js";

describe("@browserrecon/rate-controller", () => {
  it("exposes its identity", () => {
    expect(PACKAGE_NAME).toBe("@browserrecon/rate-controller");
  });
});
