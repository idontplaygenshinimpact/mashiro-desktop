// 分类判定相似度引擎工单任务 2：存量重分类——"其他"组条目用 similarity 引擎重分类
// 规则层（similarityGroupRule）先判（零成本）；未命中的 → LLM 语义层（normalizeGroupAsync，低频）
// 用法：node scripts/reclassify-others.mjs [--llm]（--llm 才触发 LLM 语义层；默认仅规则层）
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const useLlm = process.argv.includes("--llm");

// 读清单（study_plan.json——与 lib/study.mjs 同路径）
const planFile = path.join(root, "data", "study_plan.json");
if (!existsSync(planFile)) {
  console.log("未找到清单文件（data/study_plan.json）——跳过");
  process.exit(0);
}
const plan = JSON.parse(readFileSync(planFile, "utf8"));
const items = plan.items || [];
const others = items.filter((i) => (i.grp || "其他") === "其他");
if (!others.length) {
  console.log("「其他」组无条目——无需重分类");
  process.exit(0);
}

const { similarityGroupRule, normalizeGroupAsync } = await import("../lib/study-groups.ts");
let ruleHit = 0, llmHit = 0, remain = 0;
const moved = [];
for (const it of others) {
  const g = similarityGroupRule(it.topic);
  if (g) {
    it.grp = g;
    ruleHit++;
    moved.push(`  ${it.topic} → ${g}（规则层）`);
  } else if (useLlm) {
    const g2 = await normalizeGroupAsync(it.topic, "", it.why || "");
    if (g2 !== "其他") {
      it.grp = g2;
      llmHit++;
      moved.push(`  ${it.topic} → ${g2}（LLM 语义层）`);
    } else remain++;
  } else remain++;
}
if (moved.length) {
  writeFileSync(planFile, JSON.stringify(plan, null, 2), "utf8");
  console.log(`已重分类 ${moved.length} 条（规则层 ${ruleHit} / LLM ${llmHit}）：\n${moved.join("\n")}`);
} else {
  console.log("规则层无命中（可加 --llm 触发 LLM 语义层）");
}
console.log(`「其他」组剩余 ${remain} 条`);
