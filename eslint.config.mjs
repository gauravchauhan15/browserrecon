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

  {
    files: ["**/*.test.ts", "scripts/**/*.mjs"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
);
