// tests/backup.test.mjs —— 数据备份与恢复单测（数据安全：自动备份 + 一键恢复，重启生效）
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, readFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setupTempDb, cleanupTempDb, clearAllTables } from "./helpers.mjs";

const dbDir = setupTempDb("backup");
// 备份测试需要临时 output（study_notes 归档目录）
process.env.MIANSHI_OUTPUT_DIR = path.join(dbDir, "output");
const { db } = await import("../lib/db.mjs");
const { createBackup, listBackups, markRestore, applyPendingRestore, hoursSinceLastBackup, backupConfig } = await import("../lib/backup.mjs");
const { config } = await import("../config.mjs");

const backupsDir = () => path.join(path.dirname(process.env.MIANSHI_DB_PATH), "backups");

beforeEach(async () => {
  await clearAllTables();
  // 清空备份目录（每个用例独立）
  rmSync(backupsDir(), { recursive: true, force: true });
  rmSync(config.outputDir, { recursive: true, force: true });
});

after(() => { cleanupTempDb(dbDir); });

test("createBackup：主库 + study_notes 讲解存档 + manifest 落盘", async () => {
  db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('profile','{\"name\":\"测试\"}',?)").run(Date.now());
  const notesDir = path.join(config.outputDir, "study_notes");
  mkdirSync(notesDir, { recursive: true });
  writeFileSync(path.join(notesDir, "事件循环.md"), "# 讲解", "utf8");
  writeFileSync(path.join(notesDir, "闭包.md"), "# 讲解2", "utf8");

  const r = await createBackup("manual");
  assert.equal(r.ok, true, r.error);
  const dir = path.join(backupsDir(), r.name);
  assert.ok(existsSync(path.join(dir, "mianshi.db")), "主库备份");
  assert.ok(existsSync(path.join(dir, "study_notes", "事件循环.md")), "讲解存档备份");
  const manifest = JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8"));
  assert.equal(manifest.reason, "manual");
  assert.equal(manifest.notes, 2);
  assert.ok(manifest.createdAt > 0);
  // 列表可见
  const list = listBackups();
  assert.equal(list.backups.length, 1);
  assert.equal(list.backups[0].name, r.name);
});

test("createBackup：备份出的库可独立打开且数据完整（WAL checkpoint 后复制）", async () => {
  db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('probe','{\"v\":42}',?)").run(Date.now());
  const r = await createBackup("manual");
  assert.equal(r.ok, true);
  // 用 node:sqlite 直接打开备份文件验证内容（不经被测模块）
  const { DatabaseSync } = await import("node:sqlite");
  const copy = new DatabaseSync(path.join(backupsDir(), r.name, "mianshi.db"), { readOnly: true });
  const row = copy.prepare("SELECT value FROM settings WHERE key='probe'").get();
  assert.equal(JSON.parse(String(row.value)).v, 42, "备份库含最近写入");
  copy.close();
});

test("pruneBackups：超过保留上限清理最旧备份", async () => {
  const dir = backupsDir();
  // 手工造 12 个备份目录：数字前缀（字典序=时间序，且恒小于真实时间戳命名的新备份）
  for (let i = 0; i < 12; i++) {
    const d = path.join(dir, `${String(i).padStart(14, "0")}_manual`);
    mkdirSync(d, { recursive: true });
    writeFileSync(path.join(d, "manifest.json"), JSON.stringify({ createdAt: i, reason: "manual", files: [] }, null, 2), "utf8");
  }
  const r = await createBackup("manual"); // 触发 prune
  assert.equal(r.ok, true);
  const remain = readdirSync(dir).filter((n) => !n.startsWith("."));
  assert.ok(remain.length <= backupConfig.maxBackups, `保留 ${remain.length} 份 ≤ ${backupConfig.maxBackups}`);
  // 最新一份（本次创建的）必须保留
  assert.ok(remain.includes(r.name), "最新备份保留");
});

test("markRestore + applyPendingRestore：pending 替换主库 + pre-restore 安全网（模拟新进程）", async () => {
  // 独立目录模拟"新进程"（主库未打开，文件可自由替换）
  const dir = mkdtempSync(path.join(tmpdir(), "backup-restore-"));
  const dbFile = path.join(dir, "test.db");
  const backupRoot = path.join(dir, "backups");

  // 用 node:sqlite 造两个库文件
  const makeDb = async (file, marker) => {
    const { DatabaseSync } = await import("node:sqlite");
    const d = new DatabaseSync(file);
    d.exec("DROP TABLE IF EXISTS t; CREATE TABLE t (k TEXT PRIMARY KEY, v TEXT)");
    d.prepare("INSERT INTO t VALUES (?,?)").run("marker", marker);
    d.close();
  };
  await makeDb(dbFile, "old-data");
  // 备份 v1（备份目录 = 当前库副本 + manifest）
  const bkName = "2026-09-15T00-00-00_manual";
  const bkDir = path.join(backupRoot, bkName);
  mkdirSync(bkDir, { recursive: true });
  copyFileSync(dbFile, path.join(bkDir, "mianshi.db"));
  writeFileSync(path.join(bkDir, "manifest.json"), JSON.stringify({ createdAt: 1, reason: "manual", files: ["mianshi.db"] }, null, 2), "utf8");
    // 3) 修改当前库为 v2（new-data）
    await makeDb(dbFile, "new-data");
    // 4) 标记恢复 v1 备份
    const mr = markRestore(bkName, dbFile);
    assert.equal(mr.ok, true);
    assert.ok(existsSync(path.join(dir, "restore-pending.db")), "pending 文件已生成");
    // 5) 模拟重启：applyPendingRestore 替换主库
    const applied = applyPendingRestore(dbFile);
    assert.equal(applied, true);
    assert.equal(existsSync(path.join(dir, "restore-pending.db")), false, "pending 一次性消费");
    // 6) 主库现在应是 v1（old-data）
    const { DatabaseSync } = await import("node:sqlite");
    const d = new DatabaseSync(dbFile, { readOnly: true });
    const row = d.prepare("SELECT v FROM t WHERE k='marker'").get();
    assert.equal(String(row.v), "old-data", "主库已被备份内容替换");
    d.close();
    // 7) pre-restore 安全网快照存在（v2 可回滚）
    const snapshots = readdirSync(backupRoot).filter((n) => n.includes("pre-restore"));
    assert.ok(snapshots.length >= 1, "恢复前自动快照");
    const { DatabaseSync: D2 } = await import("node:sqlite");
    const sd = new D2(path.join(backupRoot, snapshots[0], "mianshi.db"), { readOnly: true });
    const srow = sd.prepare("SELECT v FROM t WHERE k='marker'").get();
    assert.equal(String(srow.v), "new-data", "快照保留恢复前的 v2");
    sd.close();
    rmSync(dir, { recursive: true, force: true });
});

test("markRestore：路径穿越拒绝 + 不存在的备份拒绝", async () => {
  const r1 = markRestore("../../evil", process.env.MIANSHI_DB_PATH);
  assert.equal(r1.ok, false, "穿越路径拒绝");
  const r2 = markRestore("not-exist", process.env.MIANSHI_DB_PATH);
  assert.equal(r2.ok, false, "不存在的备份拒绝");
});

test("applyPendingRestore：无 pending → false 且不动主库", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "backup-nopend-"));
  const dbFile = path.join(dir, "test.db");
  writeFileSync(dbFile, "keep", "utf8");
  const applied = applyPendingRestore(dbFile);
  assert.equal(applied, false);
  assert.equal(readFileSync(dbFile, "utf8"), "keep", "主库未动");
  rmSync(dir, { recursive: true, force: true });
});

test("applyPendingRestore：替换后清除旧会话残留的 -wal/-shm（防旧 WAL 回放损坏新库）", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "backup-wal-"));
  const dbFile = path.join(dir, "test.db");
  const backupRoot = path.join(dir, "backups");

  // 造当前库 + 上一会话崩溃残留的 -wal/-shm 侧车文件（delete 模式下 SQLite 忽略 -wal，
  // 纯测 applyPendingRestore 的 rmSync 清理逻辑；生产主库为 WAL 模式，残留 WAL 会被回放）
  const makeDb = async (file, marker) => {
    const { DatabaseSync } = await import("node:sqlite");
    const d = new DatabaseSync(file);
    d.exec("DROP TABLE IF EXISTS t; CREATE TABLE t (k TEXT PRIMARY KEY, v TEXT)");
    d.prepare("INSERT INTO t VALUES (?,?)").run("marker", marker);
    d.close();
  };
  await makeDb(dbFile, "old-data");
  const walPath = dbFile + "-wal";
  const shmPath = dbFile + "-shm";
  writeFileSync(walPath, "stale-wal", "utf8");
  writeFileSync(shmPath, "stale-shm", "utf8");
  assert.ok(existsSync(walPath) && existsSync(shmPath), "残留文件就位");

  // 备份 v1（独立库文件）
  const bkName = "2026-09-16T00-00-00_manual";
  const bkDir = path.join(backupRoot, bkName);
  mkdirSync(bkDir, { recursive: true });
  await makeDb(path.join(bkDir, "mianshi.db"), "restored-data");
  writeFileSync(path.join(bkDir, "manifest.json"), JSON.stringify({ createdAt: 1, reason: "manual", files: ["mianshi.db"] }, null, 2), "utf8");

  markRestore(bkName, dbFile);
  const applied = applyPendingRestore(dbFile);
  assert.equal(applied, true);
  assert.equal(existsSync(walPath), false, "-wal 已清除（否则旧 WAL 帧会回放到新库）");
  assert.equal(existsSync(shmPath), false, "-shm 已清除");
  // 新库内容 = 备份内容（未被旧 WAL 污染）
  const { DatabaseSync } = await import("node:sqlite");
  const d2 = new DatabaseSync(dbFile, { readOnly: true });
  const row = d2.prepare("SELECT v FROM t WHERE k='marker'").get();
  assert.equal(String(row.v), "restored-data", "新库内容来自备份");
  d2.close();
  rmSync(dir, { recursive: true, force: true });
});

test("hoursSinceLastBackup：无备份 → Infinity；有备份 → 小时数", async () => {
  assert.equal(hoursSinceLastBackup(), Infinity, "无备份返回 Infinity（触发自动备份）");
  await createBackup("manual");
  const h = hoursSinceLastBackup();
  assert.ok(h >= 0 && h < 1, `刚备份完间隔应接近 0，实际 ${h}`);
});

test("hoursSinceLastBackup：pre-restore 快照不算备份（否则自动备份被永久满足）", async () => {
  // 只造一个 pre-restore 快照（时间戳恒最新）：它只是恢复前安全网，不是"备份"
  const dir = path.join(backupsDir(), "2026-09-17T00-00-00_pre-restore");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ createdAt: Date.now(), reason: "pre-restore", files: [] }, null, 2), "utf8");
  assert.equal(hoursSinceLastBackup(), Infinity, "仅 pre-restore 快照 → 仍视为无真实备份（触发自动备份）");
  // 有真实备份后恢复正常
  await createBackup("manual");
  const h = hoursSinceLastBackup();
  assert.ok(h >= 0 && h < 1, `有真实备份后间隔正常，实际 ${h}`);
});
