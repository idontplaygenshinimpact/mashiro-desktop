// 安全模块最小用例集（测试与 CI 工单任务 3①）：win-toast 注入 / chrome-cookies 失败可见 / eval-scoring 一致性
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildToastScript } from "../lib/win-toast.mjs";
import { readBrowserCookies } from "../lib/chrome-cookies.mjs";
import { truthScore, truthAdjacent, TRUTH_LABEL_SCORE } from "../lib/eval-scoring.mjs";

// ---------- win-toast：特殊字符/引号不逃逸（base64 编码天然防注入） ----------
test("win-toast：特殊字符（引号/分号/美元括号）不直接进 PowerShell 脚本", () => {
  const evil = `'; $(calc); "quoted" \`backtick\` & cmd`;
  const script = buildToastScript("标题", evil);
  // 脚本只含 base64（原始字符不应出现在脚本里——防 PowerShell 注入）
  assert.ok(!script.includes(evil), "原始恶意字符不直接进脚本");
  assert.ok(!script.includes("calc"), "命令注入内容不出现");
  // base64 编码存在（内容经编码传输）
  const b64 = Buffer.from(evil, "utf8").toString("base64");
  assert.ok(script.includes(b64), "内容以 base64 编码进入脚本");
});

test("win-toast：空标题/消息不崩溃", () => {
  const script = buildToastScript("", "");
  assert.ok(script.includes("FromBase64String"), "脚本结构完整");
});

// ---------- chrome-cookies：失败不静默（返回 null 失败信号，不静默返回空数组） ----------
test("chrome-cookies：非法 browser → 返回 null（失败可见，不静默返回空数组）", async () => {
  const r = await readBrowserCookies("%nonexistent-domain%", "nonexistent-browser");
  assert.equal(r, null, "读取失败返回 null（失败信号——不静默返回空数组）");
});

// ---------- eval-scoring：A/B 评分一致性 ----------
test("eval-scoring：truthScore 映射正确", () => {
  assert.equal(truthScore("correct"), 100);
  assert.equal(truthScore("acceptable"), 75);
  assert.equal(truthScore("missing"), 50);
  assert.equal(truthScore("incorrect"), 0);
  assert.equal(truthScore("unknown"), null, "未知标签 → null（无分数）");
});

test("eval-scoring：truthAdjacent 相邻标签一致（A/B 评分不跳档）", () => {
  assert.equal(truthAdjacent("correct", "acceptable"), true, "correct↔acceptable 相邻");
  assert.equal(truthAdjacent("acceptable", "missing"), true, "acceptable↔missing 相邻");
  assert.equal(truthAdjacent("correct", "missing"), false, "correct↔missing 不相邻（跳档）");
  assert.equal(truthAdjacent("correct", "unknown"), false, "未知标签不相邻");
  assert.equal(truthAdjacent(null, "correct"), false, "空值不相邻");
});

test("eval-scoring：TRUTH_LABEL_SCORE 单调（评分与排序一致）", () => {
  const keys = Object.keys(TRUTH_LABEL_SCORE);
  for (let i = 1; i < keys.length; i++) {
    assert.ok(TRUTH_LABEL_SCORE[keys[i - 1]] >= TRUTH_LABEL_SCORE[keys[i]], "分数单调递减");
  }
});
