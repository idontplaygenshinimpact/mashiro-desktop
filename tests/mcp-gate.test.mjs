// 架构 P1-3：MCP 敏感数据门控 + 审计（lib/mcp-gate.mjs）
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { setupTempDb, cleanupTempDb, clearAllTables } from "./helpers.mjs";

const dbDir = setupTempDb("mcp-gate");
const gateMod = await import("../lib/mcp-gate.ts");
const { db } = await import("../lib/db.mjs");
const { ensureTraceSchema } = await import("../lib/trace.mjs");
ensureTraceSchema();

beforeEach(async () => { await clearAllTables(); });
after(() => { cleanupTempDb(dbDir); });

test("P1-3：isSensitiveMcpTool 判定（简历/日程/项目档案敏感，其余不敏感）", () => {
  assert.equal(gateMod.isSensitiveMcpTool("get_personal_profile"), true);
  assert.equal(gateMod.isSensitiveMcpTool("get_schedule_events"), true);
  assert.equal(gateMod.isSensitiveMcpTool("get_project_archives"), true);
  assert.equal(gateMod.isSensitiveMcpTool("get_jobs_status"), false, "岗位数据不敏感（半公开）");
  assert.equal(gateMod.isSensitiveMcpTool("get_study_progress"), false);
  assert.equal(gateMod.isSensitiveMcpTool("search_posts"), false);
  assert.equal(gateMod.isSensitiveMcpTool(""), false);
  assert.equal(gateMod.isSensitiveMcpTool(null), false);
});

test("P1-3：门控默认关闭（零配置可用承诺）→ 敏感工具放行", () => {
  delete process.env.MIANSHI_MCP_GATE;
  assert.equal(gateMod.mcpReadGateEnabled(), false);
  const r = gateMod.checkMcpReadGate("get_personal_profile", {});
  assert.equal(r.allow, true, "默认不拦截（外部 agent 零配置可用）");
});

test("P1-3：门控开启 + 无 confirm → 拒绝（未授权读被拒）", () => {
  process.env.MIANSHI_MCP_GATE = "on";
  try {
    const r = gateMod.checkMcpReadGate("get_personal_profile", {});
    assert.equal(r.allow, false, "无 confirm 拒绝");
    assert.ok(r.error.includes("confirm"), "错误信息提示 confirm 参数");
    const r2 = gateMod.checkMcpReadGate("get_schedule_events", { query: "x" });
    assert.equal(r2.allow, false, "带其他参数但无 confirm 也拒绝");
    // 非敏感工具不受门控影响
    const r3 = gateMod.checkMcpReadGate("get_jobs_status", {});
    assert.equal(r3.allow, true, "非敏感工具放行");
  } finally {
    delete process.env.MIANSHI_MCP_GATE;
  }
});

test("P1-3：门控开启 + confirm 显式确认 → 放行", () => {
  process.env.MIANSHI_MCP_GATE = "on";
  try {
    for (const c of ["yes", "YES", true]) {
      const r = gateMod.checkMcpReadGate("get_personal_profile", { confirm: c });
      assert.equal(r.allow, true, `confirm=${JSON.stringify(c)} 放行`);
    }
    const bad = gateMod.checkMcpReadGate("get_personal_profile", { confirm: "no" });
    assert.equal(bad.allow, false, "confirm 非 yes 拒绝");
  } finally {
    delete process.env.MIANSHI_MCP_GATE;
  }
});

test("P1-3：审计——放行与拒绝都写 trace_tools（脱敏只记键名）", () => {
  process.env.MIANSHI_MCP_GATE = "on";
  try {
    gateMod.recordMcpRead("get_personal_profile", { confirm: "yes" }, true);
    gateMod.recordMcpRead("get_schedule_events", {}, false);
    const rows = db.prepare("SELECT tool_name, args, ok, error FROM trace_tools ORDER BY id").all();
    assert.equal(rows.length, 2, "两条审计记录");
    assert.equal(rows[0].tool_name, "mcp_read:get_personal_profile");
    assert.ok(rows[0].args.includes("_redacted"), "脱敏标记");
    assert.ok(!rows[0].args.includes("yes"), "不落参数值");
    assert.ok(rows[0].args.includes("confirm"), "只记键名");
    assert.equal(rows[0].ok, 1);
    assert.equal(rows[1].ok, 0, "拒绝也记录");
    assert.equal(rows[1].error, "门控拒绝");
  } finally {
    delete process.env.MIANSHI_MCP_GATE;
  }
});
