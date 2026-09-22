/**
 * Auth profiles — build plan §12.1, §12.2; dev plan BR-M2-14.
 *
 * Authenticated scanning uses **explicit, customer-provided, authorized test
 * credentials**. That sentence carries the whole design: the user supplies
 * credentials for an account they control and are permitted to test with,
 * and this package uses them exactly as given.
 *
 * ## Credentials come from the environment. There is no other path.
 *
 * §12.1 says never recommend putting passwords on the command line. This
 * goes further than recommending, because a documented rule is one a hurried
 * user works around: the profile shape has **no field that can hold a
 * secret**. `password_env` names a variable; there is no `password`. A
 * profile with an inline secret does not parse, and the error says why.
 *
 * The reason is specific and boring: a command line ends up in shell
 * history, in `ps` output visible to every user on the machine, in CI logs,
 * and in the crash report of whatever tool reads it. A YAML file with a
 * password in it ends up in git. Neither is a hypothetical.
 *
 * ## There is no bypass, and there is no code path towards one
 *
 * §12.2's table ends with "MFA bypass — Never — Not supported". What exists
 * here is TOTP *generation* from a secret the user provided for their own
 * test account, which is the same thing their authenticator app does. What
 * does not exist, anywhere, is anything that tries to defeat a factor the
 * user did not hand us the key to. `tests/meta/no-solver.test.ts` scans the
 * repository for it.
 */

export const MFA_TYPES = ["none", "totp"] as const;

export type MfaType = (typeof MFA_TYPES)[number];

/**
 * How a login is recognised as having worked.
 *
 * At least one condition is required. A profile that cannot tell success
 * from failure will report a failed login as a successful one and stamp
 * every subsequent observation with an auth context that is not true —
 * which is worse than not authenticating at all, because the output looks
 * authoritative.
 */
export interface SuccessCondition {
  /** The landing URL contains this. The commonest and clearest signal. */
  readonly urlContains?: string | undefined;
  /** A selector that exists only when signed in. */
  readonly selectorPresent?: string | undefined;
  /** A selector that exists only when signed *out* — a login form. */
  readonly selectorAbsent?: string | undefined;
  /** A cookie the application sets on login. Name only; never a value. */
  readonly cookieSet?: string | undefined;
}

export interface AuthProfile {
  readonly name: string;
  readonly login: {
    readonly url: string;
    /** Selectors for the form. Defaults cover the common shapes. */
    readonly usernameSelector?: string | undefined;
    readonly passwordSelector?: string | undefined;
    readonly submitSelector?: string | undefined;
  };
  /**
   * Environment variable *names*. Never values.
   *
   * The type is what enforces §12.1: there is nowhere here to put a secret.
   */
  readonly credentials: {
    readonly usernameEnv: string;
    readonly passwordEnv: string;
  };
  readonly mfa?:
    | {
        readonly type: MfaType;
        readonly secretEnv?: string | undefined;
        readonly codeSelector?: string | undefined;
        readonly submitSelector?: string | undefined;
      }
    | undefined;
  readonly successCondition: SuccessCondition;
  /** How many times a lost session may be re-established (§12.3 point 3). */
  readonly maxReauthentications?: number | undefined;
}

export interface ProfileProblem {
  readonly field: string;
  readonly reason: string;
}

/** Keys that would hold a secret directly. Their presence is a hard error. */
const FORBIDDEN_KEYS = [
  "password",
  "secret",
  "token",
  "totp_secret",
  "totpSecret",
  "apiKey",
  "api_key",
  "credentials.password",
  "credentials.username",
] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Every key path in a parsed profile, so an inline secret cannot hide. */
function keyPaths(value: unknown, prefix = ""): string[] {
  if (!isPlainObject(value)) return [];
  const paths: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    const path = prefix === "" ? key : `${prefix}.${key}`;
    paths.push(path);
    paths.push(...keyPaths(child, path));
  }
  return paths;
}

const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;

/**
 * Parse and validate a profile.
 *
 * Returns problems rather than throwing: a user with three profiles wants to
 * hear about all three, not the first.
 */
export function parseAuthProfile(
  raw: unknown,
):
  | { readonly ok: true; readonly profile: AuthProfile }
  | { readonly ok: false; readonly problems: readonly ProfileProblem[] } {
  const problems: ProfileProblem[] = [];

  if (!isPlainObject(raw)) {
    return {
      ok: false,
      problems: [{ field: "", reason: "an auth profile must be a mapping" }],
    };
  }

  // Before anything else: refuse a profile carrying a secret at all. Checked
  // across every nesting level, because `login.credentials.password` is the
  // same mistake one level down.
  const paths = keyPaths(raw);
  for (const path of paths) {
    const leaf = path.split(".").pop() ?? "";
    if ((FORBIDDEN_KEYS as readonly string[]).includes(leaf)) {
      problems.push({
        field: path,
        reason:
          `secrets are never written in a profile. Use \`${leaf}_env\` to name an ` +
          "environment variable instead — a profile with a secret in it ends up in git",
      });
    }
  }

  const name = raw.name;
  if (typeof name !== "string" || name.trim() === "") {
    problems.push({
      field: "name",
      reason: "a profile needs a name, used as its auth_context",
    });
  }

  const login = isPlainObject(raw.login) ? raw.login : undefined;
  if (login === undefined || typeof login.url !== "string") {
    problems.push({ field: "login.url", reason: "the URL of the login page is required" });
  } else {
    try {
      const parsed = new URL(login.url);
      if (
        parsed.protocol !== "https:" &&
        parsed.hostname !== "localhost" &&
        !/^127\./.test(parsed.hostname)
      ) {
        // Not refused: a staging environment on plain HTTP is a real thing.
        // But credentials over HTTP is worth saying out loud once.
        problems.push({
          field: "login.url",
          reason:
            "credentials would be sent over plain HTTP. Allowed for localhost; " +
            "for anything else use https, or accept that the password is on the wire",
        });
      }
    } catch {
      problems.push({ field: "login.url", reason: "not a URL" });
    }
  }

  const credentials = isPlainObject(raw.credentials) ? raw.credentials : undefined;
  for (const field of ["usernameEnv", "passwordEnv"] as const) {
    const value =
      credentials?.[field] ??
      credentials?.[field === "usernameEnv" ? "username_env" : "password_env"];
    if (typeof value !== "string" || !ENV_NAME.test(value)) {
      problems.push({
        field: `credentials.${field}`,
        reason: "must name an environment variable, e.g. BROWSERRECON_PASSWORD",
      });
    }
  }

  const mfa = isPlainObject(raw.mfa) ? raw.mfa : undefined;
  if (mfa !== undefined) {
    const type = mfa.type;
    if (typeof type !== "string" || !(MFA_TYPES as readonly string[]).includes(type)) {
      problems.push({
        field: "mfa.type",
        reason: `supported: ${MFA_TYPES.join(", ")}. MFA bypass is not supported and never will be (§12.2)`,
      });
    }
    if (type === "totp") {
      const secretEnv = mfa.secretEnv ?? mfa.secret_env;
      if (typeof secretEnv !== "string" || !ENV_NAME.test(secretEnv)) {
        problems.push({
          field: "mfa.secretEnv",
          reason: "TOTP needs the name of an environment variable holding the shared secret",
        });
      }
    }
  }

  const condition = isPlainObject(raw.successCondition)
    ? raw.successCondition
    : isPlainObject(raw.success_condition)
      ? raw.success_condition
      : undefined;
  const conditionFields = [
    "urlContains",
    "url_contains",
    "selectorPresent",
    "selector_present",
    "selectorAbsent",
    "selector_absent",
    "cookieSet",
    "cookie_set",
  ];
  const hasCondition =
    condition !== undefined &&
    conditionFields.some((field) => typeof condition[field] === "string");
  if (!hasCondition) {
    problems.push({
      field: "successCondition",
      reason:
        "at least one success condition is required. Without one a failed login is " +
        "recorded as a successful one, and every later observation carries an auth " +
        "context that is not true",
    });
  }

  if (problems.length > 0) return { ok: false, problems };

  const read = (
    source: Record<string, unknown>,
    camel: string,
    snake: string,
  ): string | undefined => {
    const value = source[camel] ?? source[snake];
    return typeof value === "string" ? value : undefined;
  };

  const profile: AuthProfile = {
    name: name as string,
    login: {
      url: (login as Record<string, unknown>).url as string,
      ...(read(login as Record<string, unknown>, "usernameSelector", "username_selector") ===
      undefined
        ? {}
        : {
            usernameSelector: read(
              login as Record<string, unknown>,
              "usernameSelector",
              "username_selector",
            ),
          }),
      ...(read(login as Record<string, unknown>, "passwordSelector", "password_selector") ===
      undefined
        ? {}
        : {
            passwordSelector: read(
              login as Record<string, unknown>,
              "passwordSelector",
              "password_selector",
            ),
          }),
      ...(read(login as Record<string, unknown>, "submitSelector", "submit_selector") ===
      undefined
        ? {}
        : {
            submitSelector: read(
              login as Record<string, unknown>,
              "submitSelector",
              "submit_selector",
            ),
          }),
    },
    credentials: {
      usernameEnv: read(
        credentials as Record<string, unknown>,
        "usernameEnv",
        "username_env",
      ) as string,
      passwordEnv: read(
        credentials as Record<string, unknown>,
        "passwordEnv",
        "password_env",
      ) as string,
    },
    ...(mfa === undefined
      ? {}
      : {
          mfa: {
            type: mfa.type as MfaType,
            ...(read(mfa, "secretEnv", "secret_env") === undefined
              ? {}
              : { secretEnv: read(mfa, "secretEnv", "secret_env") }),
            ...(read(mfa, "codeSelector", "code_selector") === undefined
              ? {}
              : { codeSelector: read(mfa, "codeSelector", "code_selector") }),
            ...(read(mfa, "submitSelector", "submit_selector") === undefined
              ? {}
              : { submitSelector: read(mfa, "submitSelector", "submit_selector") }),
          },
        }),
    successCondition: {
      ...(read(condition as Record<string, unknown>, "urlContains", "url_contains") ===
      undefined
        ? {}
        : {
            urlContains: read(
              condition as Record<string, unknown>,
              "urlContains",
              "url_contains",
            ),
          }),
      ...(read(condition as Record<string, unknown>, "selectorPresent", "selector_present") ===
      undefined
        ? {}
        : {
            selectorPresent: read(
              condition as Record<string, unknown>,
              "selectorPresent",
              "selector_present",
            ),
          }),
      ...(read(condition as Record<string, unknown>, "selectorAbsent", "selector_absent") ===
      undefined
        ? {}
        : {
            selectorAbsent: read(
              condition as Record<string, unknown>,
              "selectorAbsent",
              "selector_absent",
            ),
          }),
      ...(read(condition as Record<string, unknown>, "cookieSet", "cookie_set") === undefined
        ? {}
        : { cookieSet: read(condition as Record<string, unknown>, "cookieSet", "cookie_set") }),
    },
    ...(typeof raw.maxReauthentications === "number"
      ? { maxReauthentications: raw.maxReauthentications }
      : {}),
  };

  return { ok: true, profile };
}

/** A resolved credential. Never logged, never serialised, never exported. */
export interface Secrets {
  readonly username: string;
  readonly password: string;
  readonly totpSecret?: string | undefined;
}

export interface ResolveProblem {
  readonly variable: string;
  readonly reason: string;
}

/**
 * Read the credentials a profile names out of the environment.
 *
 * The environment is passed in rather than read from `process.env`: §2 rule 5
 * says only `packages/config` touches globals, and it means a test can prove
 * the absent-variable path without setting a real one.
 */
export function resolveSecrets(
  profile: AuthProfile,
  env: Readonly<Record<string, string | undefined>>,
):
  | { readonly ok: true; readonly secrets: Secrets }
  | { readonly ok: false; readonly problems: readonly ResolveProblem[] } {
  const problems: ResolveProblem[] = [];

  const require_ = (variable: string): string | undefined => {
    const value = env[variable];
    if (value === undefined || value === "") {
      problems.push({
        variable,
        // Names the variable, never hints at a value. An error message is a
        // place secrets leak into logs.
        reason: `is not set. Export it before scanning with profile "${profile.name}"`,
      });
      return undefined;
    }
    return value;
  };

  const username = require_(profile.credentials.usernameEnv);
  const password = require_(profile.credentials.passwordEnv);

  let totpSecret: string | undefined;
  if (profile.mfa?.type === "totp" && profile.mfa.secretEnv !== undefined) {
    totpSecret = require_(profile.mfa.secretEnv);
  }

  if (problems.length > 0) return { ok: false, problems };

  return {
    ok: true,
    secrets: {
      username: username as string,
      password: password as string,
      ...(totpSecret === undefined ? {} : { totpSecret }),
    },
  };
}
