// 验收复现：study-review 判分失败仍标记已复盘（study-review.mjs:87-98）
// 场景：LLM 返回乱码（extractJson 解析失败）→ results=[] → 是否仍标记 reviewed？
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(tmpdir(), "verify-review-"));
process.env.MIANSHI_DB_PATH = path.join(dir, "test.db");
process.env.MIANSHI_MCP_CONFIG = path.join(dir, "mcp-empty.json");
process.env.KNOWLEDGE_TREES_FILE = path.join(dir, "knowledge-trees.json");
process.env.MIANSHI_OUTPUT_DIR = path.join(dir, "output");
const { writeFileSync } = await import("node:fs");
writeFileSync(process.env.MIANSHI_MCP_CONFIG, "[]", "utf8");

// mock LLM：返回乱码（非 JSON）——复用项目测试基座
const { mockLLM, setLlmResponses } = await import("../tests/helpers.mjs");
mockLLM();

const { db } = await import("../lib/db.mjs");
const { ensureSchema } = await import("../lib/db.mjs");
ensureSchema();

// 造一条学习清单条目
const { addPlanItems, getPlan } = await import("../lib/study.mjs");
addPlanItems([{ topic: "事件循环", why: "测试", source: "验收", verify_question: "讲讲事件循环" }]);
const item = getPlan().items[0];
console.log("初始 reviewed:", item.reviewed);

// LLM 返回乱码 → 判分解析失败
setLlmResponses("这不是 JSON 乱码回复");
const { answerReview } = await import("../lib/study-review.mjs");
const r = await answerReview([{ id: item.id, answer: "我的回答" }]);
console.log("answerReview 返回:", JSON.stringify(r));

const after = getPlan().items.find((i) => i.id === item.id);
console.log("判分失败后 reviewed:", after.reviewed);
console.log(after.reviewed ? ">>> 结论：确认——判分失败仍标记已复盘（用户答案被静默消费）" : ">>> 结论：未标记（行为正确）");

rmSync(dir, { recursive: true, force: true });
