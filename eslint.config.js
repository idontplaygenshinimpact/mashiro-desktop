// ESLint flat config（Node ESM 项目）
import js from "@eslint/js";
import globals from "globals";

export default [
  { ignores: ["node_modules/**", "output/**", "data/**", "benchmark/reports/**", "desktop/renderer/app.bundle.js", "desktop/renderer/assets/**", "desktop/renderer/lib/**", "*.bak", "*.log"] },
  {
    files: ["**/*.mjs", "**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...globals.node,
        ...globals.browser, // 面板/渲染层代码
      },
    },
    rules: {
      ...js.configs.recommended.rules,
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-undef": "error",
      "no-empty": ["error", { allowEmptyCatch: true }], // 允许空 catch（有注释说明的场景）
      "no-constant-condition": ["error", { checkLoops: false }],
    },
  },
];
