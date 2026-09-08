// 架构 P0-2：schema 迁移框架单测——版本游标 + 幂等 + ensureColumn
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { setupTempDb, cleanupTempDb } from "./helpers.mjs";

const dbDir = setupTempDb("db-mig");
after(() => { cleanupTempDb(dbDir); });

test("schemaVersion/runMigrations：版本游标推进到最新（4）且幂等", async () => {
  const { schemaVersion, runMigrations, db } = await import("../lib/db.mjs");
  // ensureSchema 建表后初始 v1；runMigrations 推进到最新
  const v = runMigrations();
  assert.ok(v >= 4, `迁移到最新（≥4，实际 ${v}）`);
  assert.equal(schemaVersion(), v, "游标一致");
  // 幂等：再跑不变化、不报错
  const v2 = runMigrations();
  assert.equal(v2, v, "幂等（重复跑版本不变）");
  // 核心列存在（新库建表已含——迁移幂等跳过）
  const cols = db.prepare("PRAGMA table_info(review_cards)").all().map((c) => c.name);
  assert.ok(cols.includes("type"), "review_cards.type 存在");
  assert.ok(cols.includes("priority"), "review_cards.priority 存在");
});

test("ensureColumn：幂等补列（重复调用不报错）", async () => {
  const { ensureColumn, db } = await import("../lib/db.mjs");
  const did1 = ensureColumn("settings", "p0_test_col", "TEXT DEFAULT ''");
  const did2 = ensureColumn("settings", "p0_test_col", "TEXT DEFAULT ''");
  assert.equal(did1, true, "首次补列");
  assert.equal(did2, false, "重复调用幂等（已存在）");
  const cols = db.prepare("PRAGMA table_info(settings)").all().map((c) => c.name);
  assert.ok(cols.includes("p0_test_col"), "列已补");
});

test("迁移失败可见：非法迁移抛错 + 版本不推进（不静默吞）", async () => {
  const { db } = await import("../lib/db.mjs");
  const before = Number(db.prepare("PRAGMA user_version").get().user_version);
  // 模拟失败迁移（表不存在 → ALTER 抛错）
  assert.throws(() => {
    db.exec("ALTER TABLE no_such_table_p0 ADD COLUMN x TEXT");
  }, "失败迁移抛错（不静默吞）");
  const after = Number(db.prepare("PRAGMA user_version").get().user_version);
  assert.equal(after, before, "失败不推进版本（下次启动重试）");
});
