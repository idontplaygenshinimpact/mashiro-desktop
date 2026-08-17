// 按模块跑测试：升级某模块只跑它及其依赖的测试，不用全量
// 用法：
//   node scripts/test-module.mjs study          # 跑 study 模块相关测试
//   node scripts/test-module.mjs study jobs rag # 多模块
//   node scripts/test-module.mjs --list         # 列出可用模块
// 模块 → 测试文件前缀映射（新增测试文件时在这里补充）
const MODULES = {
  study: ["study", "study-llm", "study-files"],
  agent: ["agent", "tool-policy", "subagent", "lane", "pipeline"],
  ai: ["ai", "discover"],
  jobs: ["jobs", "job-platforms", "platform-boss", "platform-accounts", "preset-skills", "skills"],
  interview: ["interview", "interview-notes"],
  knowledge: ["knowledge", "preset-skills"],
  career: ["career"],
  quiz: ["quiz"],
  review: ["review"],
  loop: ["loop"],
  rag: ["rag", "rag-pipeline"],
  greeting: ["greeting"],
  memory: ["memory"],
  rss: ["rss"],
  zhenti: ["zhenti", "oj"],
  focus: ["focus"],
  mail: ["mail"],
  schedule: ["scheduler"],
  music: ["music"],
  voice: ["voice-pack"],
  mascot: ["mascot-models", "emotions"],
  mcp: ["mcp-client"],
  widget: ["widget-core", "widget-auth", "path-all", "integration-widget"],
  routes: ["routes-registry"],
  desktop: ["desktop-utils"],
  llm: ["llm-retry", "llm-utils"],
  misc: ["ask-user", "atomic-json", "permission", "prompt-guard", "self-check", "todo-context", "trace", "web-search", "fetch-page", "learning", "dreaming", "hooks"],
};

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const testsDir = path.join(root, "tests");

const args = process.argv.slice(2);
if (args.includes("--list")) {
  console.log("可用模块（模块名 → 测试文件前缀）:");
  for (const [name, files] of Object.entries(MODULES)) console.log(`  ${name}: ${files.join(", ")}`);
  process.exit(0);
}

const wanted = args.filter((a) => !a.startsWith("-"));
if (!wanted.length) {
  console.error("用法: node scripts/test-module.mjs <模块名...>  或  --list");
  process.exit(1);
}

// 解析模块 → 实际测试文件（存在才加）
const allTests = readdirSync(testsDir).filter((f) => f.endsWith(".test.mjs"));
const files = new Set();
for (const m of wanted) {
  const prefixes = MODULES[m];
  if (!prefixes) {
    console.error(`⚠️ 未知模块: ${m}（--list 查看可用模块）`);
    continue;
  }
  for (const p of prefixes) {
    for (const t of allTests) {
      if (t === `${p}.test.mjs` || t.startsWith(`${p}.`)) files.add(t);
    }
  }
}
if (!files.size) {
  console.error("没有匹配到测试文件");
  process.exit(1);
}

const list = [...files].sort().map((f) => path.join(testsDir, f));
console.log(`▶ 运行 ${list.length} 个测试文件（模块: ${wanted.join(", ")}）`);
for (const f of list) console.log(`  ${path.basename(f)}`);

const r = spawnSync(
  process.execPath,
  ["--experimental-test-module-mocks", "--test", ...list],
  { stdio: "inherit", cwd: root }
);
process.exit(r.status ?? 1);
