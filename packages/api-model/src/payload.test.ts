import { describe, expect, it } from "vitest";
import { ShapeBuilder, isSensitiveFieldName } from "./index.js";

const shapeOf = (...bodies: string[]) => {
  const builder = new ShapeBuilder();
  for (const body of bodies) builder.add(body, "application/json");
  return builder.snapshot();
};

describe("what a shape describes", () => {
  it("reports field names and types", () => {
    const shape = shapeOf('{"email":"a@b.com","quantity":2,"express":true}');
    expect(shape.fields.map((f) => f.path)).toEqual(["email", "express", "quantity"]);
    expect(shape.fields.find((f) => f.path === "quantity")?.types).toEqual(["number"]);
  });

  it("walks nested objects with dotted paths", () => {
    const shape = shapeOf('{"user":{"address":{"postcode":"SW1A 1AA"}}}');
    expect(shape.fields.map((f) => f.path)).toContain("user.address.postcode");
  });

  it("describes an array by its first element", () => {
    // An array of 500 orders has one shape; walking all of them costs time
    // to learn nothing.
    const items = Array.from({ length: 500 }, (_, n) => ({ sku: `s${n}`, qty: n }));
    const shape = shapeOf(JSON.stringify({ items }));
    expect(shape.fields.map((f) => f.path)).toContain("items[].sku");
    // Three: the array element itself, plus its two fields. Recording the
    // element is what tells a reader the array holds objects rather than
    // scalars.
    expect(shape.fields.filter((f) => f.path.startsWith("items[]"))).toHaveLength(3);
  });

  it("records every type seen at one path", () => {
    // A field that is sometimes a string and sometimes null is informative
    // in itself — it is where a client breaks.
    const shape = shapeOf('{"discount":null}', '{"discount":"SAVE10"}');
    expect(shape.fields[0]?.types).toEqual(["null", "string"]);
  });

  it("reports presence, which is what separates optional from required", () => {
    const shape = shapeOf('{"a":1,"b":2}', '{"a":1}', '{"a":1}');
    expect(shape.fields.find((f) => f.path === "a")?.presence).toBe(1);
    expect(shape.fields.find((f) => f.path === "b")?.presence).toBeCloseTo(1 / 3);
  });

  it("reads form-encoded bodies too", () => {
    const builder = new ShapeBuilder();
    builder.add("email=a%40b.com&quantity=2", "application/x-www-form-urlencoded");
    expect(builder.snapshot().fields.map((f) => f.path)).toEqual(["email", "quantity"]);
  });
});

describe("values are dropped, not redacted", () => {
  it("carries no value from a sensitive field", () => {
    // Redaction is a filter and a filter has a false-negative rate. There
    // is no code path here that emits a value for these, so a missing
    // pattern cannot leak one.
    const shape = shapeOf(
      '{"password":"hunter2","card":{"pan":"4111111111111111"},"email":"a@b.com"}',
    );
    const serialized = JSON.stringify(shape);
    expect(serialized).not.toContain("hunter2");
    expect(serialized).not.toContain("4111111111111111");
    expect(serialized).not.toContain("a@b.com");
    // The names survive: that a `pan` field exists is the finding.
    expect(shape.fields.map((f) => f.path)).toContain("card.pan");
  });

  it("carries no free-text value either", () => {
    // The general rule, not just the sensitive names: a field with many
    // distinct values is data, and data does not belong in a shape.
    const builder = new ShapeBuilder();
    for (let n = 0; n < 20; n += 1) {
      builder.add(JSON.stringify({ comment: `a unique comment number ${n}` }));
    }
    const serialized = JSON.stringify(builder.snapshot());
    expect(serialized).not.toContain("unique comment");
  });

  it("keeps an enum, because it is part of the interface", () => {
    // Knowing `role` takes `user` or `admin` is exactly what a security
    // reader acts on.
    const shape = shapeOf(
      '{"role":"user"}',
      '{"role":"admin"}',
      '{"role":"user"}',
      '{"role":"guest"}',
    );
    expect(shape.fields[0]?.values).toEqual(["admin", "guest", "user"]);
  });

  it("discards a partial list rather than truncating it", () => {
    // A "first 8 of many" list reads like a complete set, which is a
    // stronger claim than the data supports.
    const builder = new ShapeBuilder();
    for (let n = 0; n < 40; n += 1) builder.add(JSON.stringify({ status: `s${n}` }));
    expect(builder.snapshot().fields[0]?.values).toBeUndefined();
  });

  it("keeps no enum for a sensitive name however few the values", () => {
    const shape = shapeOf('{"otp":"111111"}', '{"otp":"222222"}');
    expect(shape.fields[0]?.values).toBeUndefined();
  });

  it("recognises the field names worth protecting", () => {
    for (const name of [
      "password",
      "api_key",
      "accessToken",
      "apiKey",
      "sessionId",
      "cardNumber",
      "card.pan",
      "user.email",
      "cvv",
      "ssn",
      "dob",
      "phone",
      "user.address.line1",
      "name",
    ]) {
      expect(isSensitiveFieldName(name), name).toBe(true);
    }
  });

  it("does not over-match ordinary names", () => {
    for (const name of ["quantity", "status", "role", "currency", "sku", "page", "total"]) {
      expect(isSensitiveFieldName(name), name).toBe(false);
    }
  });
});

describe("bounds", () => {
  it("stops at a depth beyond which a payload is a document", () => {
    let nested: unknown = "leaf";
    for (let depth = 0; depth < 30; depth += 1) nested = { down: nested };
    const shape = shapeOf(JSON.stringify(nested));
    expect(shape.fields.length).toBeLessThan(12);
  });

  it("caps the number of fields, so one payload cannot become the report", () => {
    const wide: Record<string, number> = {};
    for (let n = 0; n < 1000; n += 1) wide[`field_${n}`] = n;
    expect(shapeOf(JSON.stringify(wide)).fields.length).toBeLessThanOrEqual(200);
  });

  it("survives a deeply nested structure without hanging", () => {
    const deep = JSON.stringify({ a: { b: { c: { d: { e: { f: { g: 1 } } } } } } });
    expect(() => shapeOf(deep)).not.toThrow();
  });
});

describe("bodies it cannot read", () => {
  it("notes unparseable JSON rather than dropping the observation", () => {
    const builder = new ShapeBuilder();
    builder.add("<html>not json</html>", "text/html");
    const shape = builder.snapshot();
    expect(shape.samples).toBe(1);
    expect(shape.note).toContain("not JSON");
  });

  it("notes an absent body", () => {
    const builder = new ShapeBuilder();
    builder.add(undefined);
    expect(builder.snapshot().note).toContain("no body");
  });

  it("never throws on hostile input", () => {
    const builder = new ShapeBuilder();
    const nul = String.fromCharCode(0);
    for (const body of ["", "null", "[]", "0", '"a string"', "{", "[[[[[", nul]) {
      expect(() => builder.add(body), JSON.stringify(body)).not.toThrow();
    }
  });
});
