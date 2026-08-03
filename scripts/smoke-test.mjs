// 冒烟测试：widget API 全路由 + 核心模块导入检查
// 用法: node scripts/smoke-test.mjs [--skip-llm]
// 退出码: 0=全过 1=有失败
import { readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE = "http://127.0.0.1:8899";
const SKIP_LLM = process.argv.includes("--skip-llm");
const toUrl = (p) => `file:///${p.replace(/\\/g, "/")}`;

let pass = 0, fail = 0;
const results = [];

function check(name, ok, detail = "") {
  if (ok) { pass++; console.log(`  ✅ ${name} ${detail}`); }
  else { fail++; console.log(`  ❌ ${name} ${detail}`); }
  results.push({ name, ok, detail });
}

// 0. widget 服务可用性
console.log("== 0. widget 服务 ==");
try {
  const r = await fetch(`${BASE}/api/widget-data`, { signal: AbortSignal.timeout(8000) });
  check("GET /api/widget-data", r.ok, `status=${r.status}`);
} catch (e) {
  check("GET /api/widget-data", false, e.message);
  // 服务都没起，后续无意义
  console.log(`\n❌ widget 服务不可达（${BASE}），请先启动 widget.mjs`);
  process.exit(1);
}

// 1. 学习清单
console.log("== 1. 学习清单 ==");
{
  const r = await (await fetch(`${BASE}/api/study-plan`)).json();
  check("study-plan 返回 ok", r.ok === true);
  check("study-plan 有 items", Array.isArray(r.plan?.items), `count=${r.plan?.items?.length ?? "?"}`);
  const item = r.plan?.items?.[0];
  if (item) {
    check("条目字段完整", ["id", "topic", "why", "level"].every((k) => k in item), `topic=${String(item.topic).slice(0, 15)}`);
  }
}
// 2. 学习详情（有文件条目走 JSON；无文件条目走 LLM——跳过 LLM 时只测有文件的）
console.log("== 2. 学习详情 ==");
{
  const plan = await (await fetch(`${BASE}/api/study-plan`)).json();
  const withFile = (plan.plan?.items || []).find((i) => i.filePath);
  if (withFile) {
    const r = await (await fetch(`${BASE}/api/study-detail?id=${withFile.id}`)).json();
    check("study-detail(有文件) 返回内容", r.ok && r.content?.length > 100, `len=${r.content?.length}`);
  } else {
    console.log("  ⏭️ 无文件条目存在性检查跳过（没有 filePath 条目）");
  }
}
// 3. 复习
console.log("== 3. 复习 ==");
{
  const r = await (await fetch(`${BASE}/api/review/due`)).json();
  check("review/due 返回 ok", r.ok === true);
  check("review/due 有 stats", r.stats && typeof r.stats.total === "number", `total=${r.stats?.total}`);
}
// 4. 模拟面试（只测 start 的校验路径，不真正开 LLM 面试）
console.log("== 4. 模拟面试 ==");
{
  // 如果已有进行中的面试，先结束（避免污染）
  const end = await (await fetch(`${BASE}/api/interview/end`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json();
  check("interview/end 可调用", end && (end.ok === true || end.error), `err=${end.error || "none"}`);
}
// 5. 数据文件完整性
console.log("== 5. 数据库 ==");
{
  // 主存储已迁移到 SQLite（mianshi.db），JSON 为 .bak 备份
  const dbFile = path.join(ROOT, "data", "mianshi.db");
  if (!existsSync(dbFile)) {
    check("data/mianshi.db 存在", false);
  } else {
    check("data/mianshi.db 存在", true);
    try {
      const { db } = await import(toUrl(path.join(ROOT, "lib/db.mjs")));
      const tables = db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table'").get().n;
      check("db 表数量", tables >= 10, `${tables} 张表`);
      for (const [t, min] of [["study_plan_items", 1], ["review_cards", 1], ["weak_points", 1], ["kp_mastery", 1]]) {
        const n = db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;
        check(`表 ${t} 有数据`, n >= min, `${n} 行`);
      }
    } catch (e) {
      check("db 可查询", false, e.message);
    }
  }
}
// 6. 核心模块可导入
console.log("== 6. 模块导入 ==");
{
    for (const m of ["lib/db.mjs", "lib/memory.mjs", "lib/study.mjs", "lib/review.mjs", "lib/knowledge.mjs", "lib/interview.mjs", "lib/ai.mjs", "lib/llm.mjs"]) {
    try {
      await import(toUrl(path.join(ROOT, m)));
      check(`import ${m}`, true);
    } catch (e) {
      check(`import ${m}`, false, e.message);
    }
  }
}
// 7. LLM 连通（可选跳过）
if (!SKIP_LLM) {
  console.log("== 7. LLM 连通 ==");
  try {
    const { llmChat, getReplyText } = await import(toUrl(path.join(ROOT, "lib/llm.mjs")));
    const d = await llmChat([{ role: "user", content: "回复: ok" }], { maxTokens: 20, timeout: 30000 });
    check("llmChat 调用", getReplyText(d).length > 0, `reply=${getReplyText(d).slice(0, 10)}`);
  } catch (e) {
    check("llmChat 调用", false, e.message);
  }
} else {
  console.log("== 7. LLM 连通 ==");
  console.log("  ⏭️ 跳过（--skip-llm）");
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
