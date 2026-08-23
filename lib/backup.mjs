// lib/backup.mjs —— 数据备份与恢复（数据安全：自动备份 + 一键恢复，重启生效）
// 备份内容：SQLite 主库（WAL checkpoint 后复制，保证完整）+ output/study_notes 讲解存档 + progress.json
// 备份位置：<DB 同目录>/backups/<时间戳>_<原因>/（MIANSHI_DB_PATH 指向临时库时自动隔离，测试安全）
// 恢复流程：markRestore 把备份的主库复制为 restore-pending.db → 进程重启时 db.mjs 打开数据库
//           之前调用 applyPendingRestore() 自动替换（SQLite 文件被进程占用无法热替换，重启生效）；
//           替换前自动把当前库快照为 pre-restore 备份（安全网：恢复出的库有问题可再回滚）
import { readFileSync, writeFileSync, readdirSync, copyFileSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { config } from "../config.mjs";
import { readJsonSafe } from "./atomic-json.mjs";

const DATA_DIR = path.join(import.meta.dirname, "..", "data");
// 与 db.mjs 相同的路径推导（不能 import db.mjs——db.mjs 顶层依赖本模块的 applyPendingRestore）
const DB_FILE = process.env.MIANSHI_DB_PATH || path.join(DATA_DIR, "mianshi.db");
const BACKUP_DIR = () => path.join(path.dirname(DB_FILE), "backups");

/** 保留份数 / 自动备份最小间隔（env 可覆盖：MIANSHI_BACKUP_KEEP / MIANSHI_BACKUP_MIN_INTERVAL_H） */
export const backupConfig = {
  maxBackups: Math.max(1, Number(process.env.MIANSHI_BACKUP_KEEP) || 10),
  minIntervalHours: Math.max(0.5, Number(process.env.MIANSHI_BACKUP_MIN_INTERVAL_H) || 24),
};

function appVersion() {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    return String(pkg.version || "dev");
  } catch { return "dev"; }
}

/** 创建备份（reason 用于命名目录与溯源：manual/auto/pre-restore） */
export async function createBackup(reason = "manual") {
  try {
    // WAL checkpoint：把 -wal 合并进主库再复制——否则复制的主库文件缺最近写入
    try {
      const { checkpoint } = await import("./db.mjs");
      checkpoint();
    } catch { /* db 未初始化（备份钩子先于 db 的场景）时跳过 */ }

    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19); // 2026-09-15T10-30-00
    const safeReason = String(reason || "manual").replace(/[^a-z0-9_-]/gi, "").slice(0, 20) || "manual";
    const dir = path.join(BACKUP_DIR(), `${ts}_${safeReason}`);
    mkdirSync(dir, { recursive: true });

    const files = [];
    let dbBytes = 0, notes = 0;
    // 1) 主库（核心：简历/清单/复习卡/题库/岗位/面试记录全在库里）
    if (existsSync(DB_FILE)) {
      copyFileSync(DB_FILE, path.join(dir, "mianshi.db"));
      dbBytes = statSync(DB_FILE).size;
      files.push(`mianshi.db (${(dbBytes / 1024).toFixed(0)} KB)`);
    }
    // 2) AI 讲解存档（用户最在意的产出；之前出过覆盖事故）
    const notesDir = path.join(config.outputDir, "study_notes");
    if (existsSync(notesDir)) {
      const dest = path.join(dir, "study_notes");
      mkdirSync(dest, { recursive: true });
      for (const f of readdirSync(notesDir)) {
        if (!f.endsWith(".md")) continue;
        copyFileSync(path.join(notesDir, f), path.join(dest, f));
        notes++;
      }
      if (notes) files.push(`study_notes/ (${notes} 篇讲解)`);
    }
    // 3) 爬取进度（小文件，丢了会显示"运行中"假状态）
    const prog = path.join(config.outputDir, "..", "progress.json");
    if (existsSync(prog)) {
      copyFileSync(prog, path.join(dir, "progress.json"));
      files.push("progress.json");
    }

    writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({
      createdAt: Date.now(),
      reason: safeReason,
      files,
      dbBytes,
      notes,
      appVersion: appVersion(),
    }, null, 2), "utf8");

    pruneBackups();
    return { ok: true, name: path.basename(dir), files, note: `备份完成（${files.length} 项）` };
  } catch (e) {
    return { ok: false, error: `备份失败: ${String(e?.message || e).slice(0, 200)}` };
  }
}

/** 清理超量备份（保留最近 maxBackups 份） */
export function pruneBackups() {
  try {
    const dir = BACKUP_DIR();
    if (!existsSync(dir)) return 0;
    const dirs = readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort(); // 时间戳前缀字典序 = 时间序
    let removed = 0;
    for (const name of dirs.slice(0, Math.max(0, dirs.length - backupConfig.maxBackups))) {
      rmSync(path.join(dir, name), { recursive: true, force: true });
      removed++;
    }
    return removed;
  } catch { return 0; }
}

/** 备份列表（按时间倒序；含原因/文件清单/大小） */
export function listBackups() {
  try {
    const dir = BACKUP_DIR();
    if (!existsSync(dir)) return { ok: true, backups: [] };
    const backups = readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => {
        const m = readJsonSafe(path.join(dir, d.name, "manifest.json"), null);
        let mtime = 0;
        try { mtime = statSync(path.join(dir, d.name)).mtimeMs; } catch { /* ignore */ }
        return {
          name: d.name,
          createdAt: m?.createdAt || mtime,
          reason: m?.reason || "?",
          files: m?.files || [],
          dbBytes: m?.dbBytes || 0,
          notes: m?.notes || 0,
        };
      })
      .sort((a, b) => b.createdAt - a.createdAt);
    return { ok: true, backups };
  } catch (e) {
    return { ok: false, error: String(e?.message || e).slice(0, 120) };
  }
}

/**
 * 标记恢复：把备份的主库复制为 restore-pending.db（不碰被占用的主库文件）
 * 下次进程启动 db.mjs 打开库前由 applyPendingRestore() 完成替换
 * @param {string} name 备份目录名
 * @param {string} [dbFile] 目标主库路径（测试注入独立目录模拟"新进程"；默认生产路径）
 */
export function markRestore(name, dbFile = DB_FILE) {
  try {
    const safe = String(name || "").replace(/[\\/]/g, ""); // 防路径穿越
    const src = path.join(path.dirname(dbFile), "backups", safe, "mianshi.db");
    if (!existsSync(src)) return { ok: false, error: `备份不存在或缺少主库文件: ${name}` };
    copyFileSync(src, path.join(path.dirname(dbFile), "restore-pending.db"));
    return { ok: true, name: safe, note: "已标记恢复——重启桌宠后自动替换数据（替换前会自动备份当前状态）" };
  } catch (e) {
    return { ok: false, error: `标记恢复失败: ${String(e?.message || e).slice(0, 200)}` };
  }
}

/**
 * 应用待恢复（进程启动、打开数据库之前调用；纯文件操作，无 db 依赖）
 * 1) 当前库先快照为 pre-restore 备份（安全网）
 * 2) pending 覆盖主库文件
 * 3) 删除 pending（一次性）
 * @param {string} [dbFile] 目标主库路径（测试注入独立目录模拟"新进程"；默认生产路径）
 * @returns {boolean} 是否执行了恢复
 */
export function applyPendingRestore(dbFile = DB_FILE) {
  const pending = path.join(path.dirname(dbFile), "restore-pending.db");
  if (!existsSync(pending)) return false;
  try {
    if (existsSync(dbFile)) {
      // 恢复前先对当前库做 wal_checkpoint（临时连接把 -wal 合并回主库再快照，保证快照完整；
      // 失败忽略——最坏情况快照缺最近未 checkpoint 的写入，不影响恢复本身）
      try {
        const tmp = new DatabaseSync(dbFile);
        tmp.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        tmp.close();
      } catch { /* ignore */ }
      // 安全网：恢复前备份当前状态（reason=pre-restore，用户可回滚）
      const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const dir = path.join(path.dirname(dbFile), "backups", `${ts}_pre-restore`);
      mkdirSync(dir, { recursive: true });
      copyFileSync(dbFile, path.join(dir, "mianshi.db"));
      writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({
        createdAt: Date.now(), reason: "pre-restore", files: ["mianshi.db（恢复前快照）"],
        dbBytes: statSync(dbFile).size, notes: 0, appVersion: appVersion(),
      }, null, 2), "utf8");
    }
    copyFileSync(pending, dbFile);
    // 关键修复：替换主库后必须清除上一会话残留的 -wal/-shm——否则崩溃重启场景下旧 WAL 帧
    // 会被 SQLite 回放到刚恢复出的新库（静默损坏恢复结果）；新库以干净文件启动
    rmSync(dbFile + "-wal", { force: true });
    rmSync(dbFile + "-shm", { force: true });
    rmSync(pending, { force: true });
    return true;
  } catch (e) {
    console.error(`[backup] 应用待恢复失败（保留原库）: ${String(e?.message || e).slice(0, 120)}`);
    return false;
  }
}

/** 距上次备份的间隔（小时）；无备份返回 Infinity（用于自动备份判断） */
export function hoursSinceLastBackup() {
  const { backups } = listBackups();
  // 过滤 pre-restore 快照：它不是"备份"（恢复前安全网，时间戳恒为最新），
  // 否则自动备份判断会被它永久"满足"，真实备份永远不再触发
  const real = backups.filter((b) => b.reason !== "pre-restore");
  if (!real.length) return Infinity;
  return (Date.now() - real[0].createdAt) / 3600000;
}
