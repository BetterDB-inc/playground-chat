/**
 * ESLint flat config (ESLint 9 + Next.js 16).
 *
 * `eslint-config-next` ships its core-web-vitals + TypeScript ruleset as
 * flat config arrays. We spread both, then add ignores for build artefacts
 * and the local Claude Code worktree directory.
 */

import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

const config = [
  ...nextCoreWebVitals,
  ...nextTypescript,
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      "out/**",
      "build/**",
      "dist/**",
      "data/**",
      "deploy/**",
      ".claude/**",
      "next-env.d.ts",
    ],
  },
];

export default config;
