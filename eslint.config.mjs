// eslint.config.mjs
import tsPlugin from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import importPlugin from "eslint-plugin-import";

export default [
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["dist/**", "node_modules/**"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        // If you want type-aware linting, point at your tsconfig:
        project: ["./config/tsconfig.json"], // or your actual tsconfig
        tsconfigRootDir: new URL(".", import.meta.url).pathname,
      },
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
      import: importPlugin,
    },
    rules: {
      // Helps detect side-effect-only imports
      "import/no-unassigned-import": "warn",

      // Useful TS rules
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": "warn",
    },
  },
];
