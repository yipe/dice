// eslint.config.mjs
import tsPlugin from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import { noDiscardedBuilder } from "./config/eslint-no-discarded-builder.mjs";

const typeAwareLanguageOptions = {
  parser: tsParser,
  parserOptions: {
    project: ["./config/tsconfig.json"],
    tsconfigRootDir: new URL(".", import.meta.url).pathname,
  },
};

export default [
  // Global ignores (a config object with only `ignores` applies repo-wide).
  { ignores: ["dist/**", "node_modules/**", ".yarn/**"] },
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: typeAwareLanguageOptions,
    plugins: {
      "@typescript-eslint": tsPlugin,
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": "warn",
    },
  },
  {
    // R24: the hand-written builder chains that need this guard live in
    // src/, tests/ and examples/ — not just src/, unlike the block above.
    files: ["src/**/*.{ts,tsx}", "tests/**/*.{ts,tsx}", "examples/**/*.{ts,tsx}"],
    languageOptions: typeAwareLanguageOptions,
    plugins: {
      local: { rules: { "no-discarded-builder": noDiscardedBuilder } },
    },
    rules: {
      "local/no-discarded-builder": "error",
    },
  },
];
