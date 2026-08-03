import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTypescript,
  {
    settings: {
      next: {
        rootDir: "apps/web/",
      },
    },
  },
  globalIgnores([
    "**/.next/**",
    "**/node_modules/**",
    "data/**",
    "coverage/**",
  ]),
]);
