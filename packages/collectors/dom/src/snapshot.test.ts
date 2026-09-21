import { describe, expect, it } from "vitest";
import {
  DEFAULT_SNAPSHOT_LIMITS,
  applyLimits,
  hasCredentialField,
  type DomSnapshot,
  type FieldRef,
} from "./snapshot.js";

const raw = (overrides: Partial<Omit<DomSnapshot, "truncated">> = {}) => ({
  url: "https://app.test/",
  links: [],
  forms: [],
  resources: [],
  ...overrides,
});

const link = (n: number) => ({ href: `/p/${n}`, opensNewContext: false });

describe("caps record what they cut", () => {
  it("keeps the cap and says how many were found", async () => {
    // A page whose last forty links vanished must not look like a page with
    // fewer links — the Explorer's queue is built from these.
    const snapshot = applyLimits(
      raw({ links: Array.from({ length: 600 }, (_, i) => link(i)) }),
      { ...DEFAULT_SNAPSHOT_LIMITS, maxLinks: 10 },
    );
    expect(snapshot.links).toHaveLength(10);
    expect(snapshot.truncated.links).toEqual({ kept: 10, found: 600 });
  });

  it("records nothing when nothing was cut", async () => {
    const snapshot = applyLimits(raw({ links: [link(1), link(2)] }));
    expect(snapshot.truncated).toEqual({});
  });

  it("caps fields within a form and marks that form", async () => {
    const fields: FieldRef[] = Array.from({ length: 200 }, (_, i) => ({
      name: `f${i}`,
      type: "text",
      required: false,
    }));
    const snapshot = applyLimits(
      raw({
        forms: [{ method: "post", fields, hasCredentialField: false, fieldsTruncated: false }],
      }),
      { ...DEFAULT_SNAPSHOT_LIMITS, maxFieldsPerForm: 5 },
    );
    expect(snapshot.forms[0]?.fields).toHaveLength(5);
    expect(snapshot.forms[0]?.fieldsTruncated).toBe(true);
  });

  it("caps forms and resources independently", async () => {
    const snapshot = applyLimits(
      raw({
        forms: Array.from({ length: 5 }, () => ({
          method: "get",
          fields: [],
          hasCredentialField: false,
          fieldsTruncated: false,
        })),
        resources: Array.from({ length: 5 }, (_, i) => ({
          kind: "script" as const,
          url: `/s${i}`,
        })),
      }),
      { ...DEFAULT_SNAPSHOT_LIMITS, maxForms: 2, maxResources: 3 },
    );
    expect(snapshot.truncated.forms).toEqual({ kept: 2, found: 5 });
    expect(snapshot.truncated.resources).toEqual({ kept: 3, found: 5 });
  });
});

describe("credential forms", () => {
  // §5A.2 refuses to submit these without an auth profile, so the judgment
  // has to be available before the Explorer decides.
  it("recognises a password input", async () => {
    expect(hasCredentialField([{ type: "password", required: true }])).toBe(true);
  });

  it("recognises a credential-shaped name on a text input", async () => {
    // A site that renders its password field as type=text — for a "show
    // password" toggle, or badly — is still a login form.
    for (const name of ["pwd", "user_password", "apiKey", "otp_code", "mfa", "access_token"]) {
      expect(hasCredentialField([{ name, type: "text", required: false }]), name).toBe(true);
    }
  });

  it("leaves an ordinary form alone", async () => {
    expect(
      hasCredentialField([
        { name: "email", type: "email", required: true },
        { name: "message", type: "textarea", required: false },
      ]),
    ).toBe(false);
  });
});
