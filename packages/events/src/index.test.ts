import { describe, expect, it } from "vitest";
import { PACKAGE_NAME } from "./index.js";

describe("@browserrecon/events", () => {
  it("exposes its identity", () => {
    expect(PACKAGE_NAME).toBe("@browserrecon/events");
  });
});
