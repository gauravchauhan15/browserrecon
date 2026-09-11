import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/node_modules/**", "**/coverage/**", "**/*.tsbuildinfo"],
  },

  ...tseslint.configs.recommended,

  {
    files: ["**/*.ts"],
    rules: {
      // ---------------------------------------------------------------
      // Module boundary enforcement — dev plan §2.4.
      // Packages talk to each other ONLY through their public index.
      // A deep import reaches past the contract and silently couples
      // internals, which is what makes an agent-edited codebase rot.
      // ---------------------------------------------------------------
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@browserrecon/*/src/*", "@browserrecon/*/dist/*"],
              message:
                "Deep import forbidden (dev plan §2.4). Import from the package root, which re-exports its public API via index.ts.",
            },
            {
              group: ["../../*/src/*"],
              message:
                "Cross-package relative import forbidden (dev plan §2.4). Depend on the workspace package by name instead.",
            },
          ],
        },
      ],

      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-explicit-any": "error",
      eqeqeq: ["error", "always"],
      "no-console": "off",
    },
  },

  // ---------------------------------------------------------------
  // Only packages/config may read process.env — dev plan §2.5.
  // Everything else receives configuration by injection, so there is
  // exactly one place where the environment enters the system.
  // ---------------------------------------------------------------
  {
    files: ["**/*.ts"],
    ignores: ["packages/config/**", "scripts/**", "**/*.test.ts"],
    rules: {
      "no-restricted-properties": [
        "error",
        {
          object: "process",
          property: "env",
          message:
            "Only packages/config may read process.env (dev plan §2.5). Accept configuration as an injected parameter.",
        },
      ],
    },
  },

  // ---------------------------------------------------------------
  // The control boundary is the only way to the browser — §32.10.
  //
  // "Policy validation occurs before browser/agent actions" is only
  // true if there is no second path to the driver. The adapter
  // checks the policy on every method, but that is worth nothing if
  // a caller can import puppeteer, or reach through the manager's
  // BrowserSession, and drive the page directly.
  //
  // So the driver is confined to packages/browser/**: the manager
  // owns the process, the adapter owns the actions, and anything
  // above them talks to the BrowserAdapter interface, which names no
  // driver type at all (asserted separately against the generated
  // .d.ts).
  // ---------------------------------------------------------------
  {
    files: ["**/*.ts"],
    ignores: ["packages/browser/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@browserrecon/*/src/*", "@browserrecon/*/dist/*"],
              message:
                "Deep import forbidden (dev plan §2.4). Import from the package root, which re-exports its public API via index.ts.",
            },
            {
              group: ["../../*/src/*"],
              message:
                "Cross-package relative import forbidden (dev plan §2.4). Depend on the workspace package by name instead.",
            },
            {
              group: ["puppeteer", "puppeteer-core", "puppeteer-core/*"],
              message:
                "Driving the browser directly bypasses the Policy Engine (§32.10). Use @browserrecon/browser-adapter, whose every method validates policy first.",
            },
          ],
          paths: [
            {
              name: "@browserrecon/browser-manager",
              // Named imports rather than the whole module, because the rule
              // is "nothing outside packages/browser/** may hold a browser
              // handle" — not "may not know where Chrome lives". `doctor`
              // legitimately uses resolveChromePath so that it answers the
              // same question a scan will; that is a pure lookup and reaches
              // no driver. These two are the only ways to obtain a session.
              importNames: ["launchBrowser", "withBrowser"],
              message:
                "Holding a BrowserSession is a path around policy validation (§32.10): it exposes the driver directly. Use @browserrecon/browser-adapter, whose every method checks policy first.",
            },
          ],
        },
      ],
    },
  },

  {
    files: ["**/*.test.ts", "scripts/**/*.mjs"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
);
