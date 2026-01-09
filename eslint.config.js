import js from "@eslint/js";
import globals from "globals";
import { defineConfig } from "eslint/config";
import { configs } from "typescript-eslint";

export default defineConfig([
  { ignores: ["**/dist", "**/dist-examples", "**/node_modules"] },
  js.configs.recommended,
  ...configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.node,
    },
    rules: {
      "@typescript-eslint/no-explicit-any": 0,
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          args: "none",
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      "no-console": ["error"],
    },
  },
]);
