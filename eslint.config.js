import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default [
  {
    ignores: ["coverage/**", "node_modules/**", ".openspec-smoke-*/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts", "**/*.mts", "**/*.js", "**/*.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        console: "readonly",
        crypto: "readonly",
        fetch: "readonly",
        process: "readonly",
        setTimeout: "readonly",
        TextEncoder: "readonly",
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-inferrable-types": "off",
      "no-constant-binary-expression": "error",
      "no-unreachable": "error",
      "no-unused-expressions": "error",
    },
  },
  {
    files: ["tests/**/*.ts"],
    rules: {
      "@typescript-eslint/no-empty-object-type": "off",
    },
  },
];
