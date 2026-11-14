// Root ESLint config for the TypeScript packages (apps/api, packages/shared, scripts).
// apps/web has its own config (Next.js rules); e2e/ and agent/ are linted by their own tooling.
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.next/**",
      "apps/web/**",
      "e2e/**",
      "agent/**",
      "scripts/pentest-*.mjs", // sandbox helper scripts (plain Node ESM)
      "**/drizzle/**",
      "**/*.tsbuildinfo",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
);
