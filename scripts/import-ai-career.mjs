// 导入 ai-career 的手写/算法题库到 mianshi-agent（challenges 表）
// 用法: node scripts/import-ai-career.mjs <ai-career 路径>（必传——不硬编码默认路径）
// 依赖: esbuild（devDependency）转译 TS 数据文件
import { readFileSync, existsSync } from "node:fs";
import { transform } from "esbuild";
import { importChallengesData } from "../lib/ai-career.mjs";

const CAREER_DIR = process.argv[2];
if (!CAREER_DIR) {
  console.error("❌ 缺少参数：请传入 ai-career 项目路径（如 node scripts/import-ai-career.mjs D:/ai-career）");
  process.exit(1);
}
const DATA_FILE = `${CAREER_DIR}/src/data/coding-challenges.ts`;

if (!existsSync(DATA_FILE)) {
  console.error(`❌ 找不到题库文件: ${DATA_FILE}`);
  process.exit(1);
}

// 1) esbuild 转译 TS → ESM
const src = readFileSync(DATA_FILE, "utf8");
const { code } = await transform(src, { loader: "ts", format: "esm" });
// 2) 以 data URL 动态 import（不落盘）
const mod = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
const list = mod.codingChallenges;
if (!Array.isArray(list)) {
  console.error("❌ 未解析到 codingChallenges 数组");
  process.exit(1);
}
console.log(`📦 从 ${DATA_FILE} 解析到 ${list.length} 道题`);
const handwrite = list.filter((c) => c.category === "handwrite").length;
console.log(`   手写 ${handwrite} 道 / 算法 ${list.length - handwrite} 道`);

// 3) 入库（幂等）
const r = importChallengesData(list);
if (!r.ok) { console.error("❌ 导入失败:", r.error); process.exit(1); }
console.log(`✅ 已导入 ${r.imported} 道题（重复导入会覆盖更新）`);
