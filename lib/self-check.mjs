// 系统自检：定期扫描隐患，能自动修的修，不能修的进报告
// 触发：widget 启动后 60s + 每 6 小时；面板「爬取产出」Tab 可手动点「立即检查」
// 覆盖（对应真实踩过的坑）：
//   1. 表无限堆积（trace_llm/seen_urls/chat_history/decision_ledger/trace_tools）→ 自动清理留最近 N
//   2. 产出目录污染（chat_solutions/study_notes 出现 <300B 的"讲解"→ 测试/异常写入特征）→ 报告
//   3. 巡检停摆（patrol_last_run 距今超过 2 倍间隔 → 疑似定时器挂了）→ 报告
//   4. LLM 失败率（最近 100 次调用 ok=0 占比 >30% → 端点/Key 异常）→ 报告
//   5. 错误日志活跃（widget-error.log 最近 24h 有新错误）→ 报告
//   6. DB 体积（>200MB → 需要 VACUUM/归档）→ 报告
//   7. 爬取产出目录堆积（discover 目录 >40 个 → 建议归档旧的）→ 报告
import { db } from "./db.mjs";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

// 各表保留上限（超出自动清理最旧行）；seen_urls 无 id 列，用 seen_at 排序删最旧
export const TABLE_LIMITS = {
  trace_llm: 3000,        // 每次 LLM 调用一行：3000 次调用够诊断，多了没意义
  trace_tools: 3000,
  seen_urls: 1000,        // 内存镜像只留 500，DB 留 1000 防抖动
  chat_history: 200,      // 与 memory.appendChat 的清理口径一致
  decision_ledger: 3000,
};
const CLEAN_SQL = {
  seen_urls: (limit) => `DELETE FROM seen_urls WHERE url IN (SELECT url FROM seen_urls ORDER BY seen_at DESC LIMIT -1 OFFSET ${limit})`,
};
const DEFAULT_CLEAN_SQL = (table, limit) =>
  `DELETE FROM [${table}] WHERE id <= (SELECT MAX(id) FROM [${table}]) - ${limit}`;

const ROOT = path.join(import.meta.dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const OUTPUT_DIR = process.env.MIANSHI_OUTPUT_DIR || path.join(ROOT, "output");

/**
 * 跑一次完整自检：自动清理超限表 + 逐项检查
 * @param {{ now?: number, outputDir?: string }} [opts]
 * @returns {{ ok: boolean, at: number, issues: Array<{level: "warn"|"error", name: string, detail: string, fixed?: boolean}>, checks: Array<{name: string, status: "ok"|"warn"|"error", detail: string}> }}
 */
export function runSelfCheck({ now = Date.now(), outputDir = OUTPUT_DIR } = {}) {
  const issues = [];
  const checks = [];
  const addCheck = (name, status, detail) => checks.push({ name, status, detail });
  const warn = (name, detail, fixed = false) => {
    issues.push({ level: "warn", name, detail, ...(fixed ? { fixed } : {}) });
    addCheck(name, "warn", detail);
  };
  const okc = (name, detail) => addCheck(name, "ok", detail);

  // ---------- 1) 表堆积：超限自动清理 ----------
  for (const [table, limit] of Object.entries(TABLE_LIMITS)) {
    try {
      const n = Number(db.prepare(`SELECT COUNT(*) n FROM [${table}]`).get().n || 0);
      if (n > limit) {
        const sql = CLEAN_SQL[table] ? CLEAN_SQL[table](limit) : DEFAULT_CLEAN_SQL(table, limit);
        const del = Number(db.prepare(sql).run().changes || 0);
        warn("数据表堆积", `${table} 有 ${n} 行（上限 ${limit}），已自动清理最旧 ${del} 行`, true);
      } else {
        okc("数据表堆积", `${table} ${n}/${limit}`);
      }
    } catch (e) {
      warn("数据表堆积", `${table} 检查失败: ${String(e.message || e).slice(0, 60)}`);
    }
  }

  // ---------- 2) 产出目录污染（异常小文件 = 测试/占位写入特征） ----------
  try {
    const tiny = [];
    for (const sub of ["chat_solutions", "study_notes"]) {
      const dir = path.join(outputDir, sub);
      if (!existsSync(dir)) continue;
      for (const f of readdirSync(dir)) {
        if (!f.endsWith(".md")) continue;
        try {
          const size = statSync(path.join(dir, f)).size;
          if (size > 0 && size < 300) tiny.push(`${sub}/${f}（${size}B）`);
        } catch { /* ignore */ }
      }
    }
    if (tiny.length) {
      warn("产出目录异常", `发现 ${tiny.length} 个异常小文件（<300B，疑似测试/占位写入）：${tiny.slice(0, 3).join("、")}${tiny.length > 3 ? ` 等 ${tiny.length} 个` : ""}`, false);
    } else {
      okc("产出目录", "无异常小文件");
    }
  } catch (e) {
    warn("产出目录", `检查失败: ${String(e.message || e).slice(0, 60)}`);
  }

  // ---------- 3) 巡检停摆 ----------
  try {
    const lastRun = Number(db.prepare("SELECT value FROM settings WHERE key='patrol_last_run'").get()?.value || 0);
    const intervalMin = Math.max(15, Number(db.prepare("SELECT value FROM settings WHERE key='patrol_interval_min'").get()?.value || 60) || 60);
    if (lastRun > 0) {
      const ageMin = (now - lastRun) / 60000;
      if (ageMin > intervalMin * 2 + 30) {
        warn("自动巡检疑似停摆", `上次巡检在 ${Math.round(ageMin)} 分钟前（间隔 ${intervalMin} 分钟），超过 2 倍间隔，检查 widget 进程/定时器`);
      } else {
        okc("自动巡检", `${Math.round(ageMin)} 分钟前跑过（间隔 ${intervalMin} 分钟）`);
      }
    } else {
      okc("自动巡检", "尚未运行过（正常：首次启动后按间隔触发）");
    }
  } catch { okc("自动巡检", "配置不可读"); }

  // ---------- 4) LLM 失败率 ----------
  try {
    const rows = db.prepare("SELECT ok FROM trace_llm ORDER BY id DESC LIMIT 100").all();
    if (rows.length >= 10) {
      const fails = rows.filter((r) => !r.ok).length;
      const rate = fails / rows.length;
      if (rate > 0.3) {
        warn("LLM 调用失败率高", `最近 ${rows.length} 次调用失败 ${fails} 次（${Math.round(rate * 100)}% > 30%），检查 API Key/网络/端点`);
      } else {
        okc("LLM 调用", `最近 ${rows.length} 次失败 ${fails} 次（${Math.round(rate * 100)}%）`);
      }
    } else {
      okc("LLM 调用", `样本不足（${rows.length} 次）`);
    }
  } catch { okc("LLM 调用", "trace 表不可用"); }

  // ---------- 5) 错误日志活跃 ----------
  try {
    const logFile = path.join(DATA_DIR, "widget-error.log");
    if (existsSync(logFile)) {
      const stat = statSync(logFile);
      if (now - stat.mtimeMs < 24 * 3600 * 1000) {
        const tail = readFileSync(logFile, "utf8").split("\n").filter(Boolean);
        const recent = tail.filter((l) => /^\d{4}-\d{2}-\d{2}T/.test(l)).slice(-20);
        const in24h = recent.filter((l) => {
          const m = l.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/);
          return m && now - new Date(m[1]).getTime() < 24 * 3600 * 1000;
        }).length;
        if (in24h > 0) {
          warn("错误日志活跃", `widget-error.log 最近 24h 新增 ${in24h} 条错误（最近：${recent[recent.length - 1].slice(0, 100)}）`);
        } else {
          okc("错误日志", "最近 24h 无新增错误");
        }
      } else {
        okc("错误日志", "最近 24h 无新增错误");
      }
    } else {
      okc("错误日志", "无错误日志文件");
    }
  } catch { okc("错误日志", "不可读"); }

  // ---------- 6) DB 体积 ----------
  try {
    const dbFile = path.join(DATA_DIR, "mianshi.db");
    if (existsSync(dbFile)) {
      const mb = statSync(dbFile).size / 1024 / 1024;
      if (mb > 200) {
        warn("数据库体积", `mianshi.db 已达 ${mb.toFixed(1)}MB（>200MB），建议备份后 VACUUM`);
      } else {
        okc("数据库体积", `${mb.toFixed(1)}MB`);
      }
    }
  } catch { okc("数据库体积", "不可读"); }

  // ---------- 7) 爬取产出目录堆积 ----------
  try {
    if (existsSync(outputDir)) {
      const dirs = readdirSync(outputDir).filter((d) => /^\d{4}-\d{2}-\d{2}_discover$/.test(d));
      if (dirs.length > 40) {
        warn("产出目录堆积", `已有 ${dirs.length} 个 discover 目录（>40），建议归档旧的（如 output/archive/）`);
      } else {
        okc("产出目录", `${dirs.length} 个 discover 目录`);
      }
    }
  } catch { okc("产出目录", "不可读"); }

  return {
    ok: issues.length === 0,
    at: now,
    issues,
    checks,
  };
}

/** 读取最近一次自检报告（settings 持久化；无则 null） */
export function getLastSelfCheck() {
  try {
    const r = db.prepare("SELECT value FROM settings WHERE key='self_check_report'").get();
    return r && r.value ? JSON.parse(String(r.value)) : null;
  } catch { return null; }
}

/** 保存报告（供面板展示 + 通知去重） */
export function saveSelfCheck(report) {
  try {
    db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('self_check_report', ?, ?)")
      .run(JSON.stringify(report), Date.now());
  } catch { /* ignore */ }
}
