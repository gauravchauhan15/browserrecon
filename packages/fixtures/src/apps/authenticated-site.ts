/**
 * Fixture: an application you have to sign in to.
 *
 * Build plan §12.1, §12.3; dev plan BR-M4-auth.
 *
 * There was no fixture with a login form, which is why no authenticated scan
 * had ever run, which is why the state model had never seen an auth
 * transition and every observation the tool ever recorded was `anonymous`.
 * Three gaps, one missing fixture.
 *
 * What it models:
 *
 *  - A login form at `/login` with ordinary `email` / `password` fields, so
 *    the adapter's default selectors have to actually work.
 *  - A session cookie, set on success and checked on every protected route.
 *  - Pages and APIs that **404 when signed out and 200 when signed in** —
 *    the difference §12.4's differential exists to measure.
 *  - A wrong password that returns 200 with the form still on the page,
 *    which is how most applications reject a login and the reason
 *    "the form submitted without error" is not evidence of a session.
 */
import type { FixtureApp, FixtureResponse, FixtureRequest, FixtureState } from "../types.js";

const HTML = { "content-type": "text/html; charset=utf-8" } as const;
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" } as const;

/** The only account. Exported so a test does not hard-code it twice. */
export const ACCOUNT = {
  email: "scanner@example.test",
  password: "correct-horse-battery",
} as const;

/** The cookie the application sets. Name only ever matters to a profile. */
export const SESSION_COOKIE = "fixture_session";
const SESSION_VALUE = "signed-in";

/** Routes that exist only for a signed-in caller. */
export const PROTECTED_PATHS = ["/account", "/orders", "/api/account/profile"] as const;

const signedIn = (request: FixtureRequest): boolean =>
  (request.headers["cookie"] ?? "").includes(`${SESSION_COOKIE}=${SESSION_VALUE}`);

const page = (title: string, body: string): FixtureResponse => ({
  status: 200,
  headers: HTML,
  body: `<!doctype html><html lang="en"><head><title>${title}</title></head><body>${body}</body></html>`,
});

function loginPage(message = ""): FixtureResponse {
  return page(
    "Sign in",
    [
      message === "" ? "" : `<p id="error">${message}</p>`,
      '<form id="login" method="POST" action="/login">',
      '  <input type="email" name="email" placeholder="Email">',
      '  <input type="password" name="password" placeholder="Password">',
      '  <button type="submit">Sign in</button>',
      "</form>",
    ].join("\n"),
  );
}

function dashboard(): FixtureResponse {
  // `#signed-in-marker` is what a profile's `selectorPresent` keys on, and
  // the links are what gives an authenticated scan somewhere to go.
  return page(
    "Account",
    [
      '<div id="signed-in-marker">Signed in</div>',
      '<a href="/orders">Orders</a> <a href="/account">Account</a>',
      "<script>fetch('/api/account/profile');</script>",
    ].join("\n"),
  );
}

interface Visits extends FixtureState {
  /** Protected paths that were reached while signed out. Must stay empty. */
  leaked: string[];
}

export function authenticatedSite(): FixtureApp {
  const protect =
    (handler: (request: FixtureRequest) => FixtureResponse) =>
    (request: FixtureRequest, state: FixtureState): FixtureResponse => {
      if (!signedIn(request)) {
        (state as Visits).leaked.push(request.pathname);
        // 404 rather than 401: plenty of applications hide what they have
        // from a caller who should not know it exists, and a scan has to
        // read that as "not reachable as this identity", not "gone".
        return {
          status: 404,
          headers: HTML,
          body: "<!doctype html><html><body>Not found</body></html>",
        };
      }
      return handler(request);
    };

  return {
    name: "authenticated-site",
    seedState: (): Visits => ({ leaked: [] }),
    routes: [
      {
        method: "GET",
        path: "/",
        handler: (request) =>
          signedIn(request)
            ? dashboard()
            : page("Shop", '<h1>Shop</h1><a href="/login">Sign in</a>'),
      },
      { method: "GET", path: "/login", handler: () => loginPage() },
      {
        method: "POST",
        path: "/login",
        handler: (request) => {
          const body = new URLSearchParams(request.body);
          const ok =
            body.get("email") === ACCOUNT.email && body.get("password") === ACCOUNT.password;
          if (!ok) {
            // 200 with the form still there. This is how most applications
            // say no, and why a submitted form is not evidence of a session.
            return loginPage("Those credentials were not recognised.");
          }
          return {
            status: 303,
            headers: {
              ...HTML,
              location: "/account",
              "set-cookie": `${SESSION_COOKIE}=${SESSION_VALUE}; Path=/; HttpOnly; SameSite=Lax`,
            },
            body: "",
          };
        },
      },
      { method: "GET", path: "/account", handler: protect(() => dashboard()) },
      {
        method: "GET",
        path: "/orders",
        handler: protect(() =>
          page("Orders", '<div id="signed-in-marker">Signed in</div><h1>Your orders</h1>'),
        ),
      },
      {
        method: "GET",
        path: "/api/account/profile",
        handler: protect(() => ({
          status: 200,
          headers: JSON_HEADERS,
          body: JSON.stringify({ email: ACCOUNT.email, plan: "standard" }),
        })),
      },
    ],
  };
}
