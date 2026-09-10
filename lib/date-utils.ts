// 日期工具：统一全库日期分桶口径（修复 M12——UTC/本地时区混用，东八区 0-8 点跨天分桶错位）
// 约定：所有"按天分桶/聚合/日期键"一律用本地时区（用户日历日），不用 toISOString（UTC）
// 全量 TS 升级工单阶段 1③：lib/date-utils.ts → .ts（叶子模块；11 个调用方都是读值，签名零变更）

/** 本地时区日期键（YYYY-MM-DD）——与用户日历日一致（东八区 0-8 点不跨天） */
export function localDateKey(ts: number = Date.now()): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** 本地时区日期解析（技术债 L2 收敛：job-reminders/job-match 两处重复定义 → 单点）
 * 修复：new Date("YYYY-MM-DD") 按 UTC 解析 → 东八区 +8h 漂移——纯日期按本地 00:00，带时间按本地精确时间
 * 解析失败返回 NaN（调用方 Number.isNaN 判定——保持既有语义） */
export function parseLocalDate(s: unknown): number {
  const raw = String(s || "").trim();
  const m = raw.match(/^(\d{4})[-/年.](\d{1,2})[-/月.](\d{1,2})日?(?:[ T]+(\d{1,2}):(\d{2}))?/);
  if (!m) return NaN;
  const [, y, mo, d, hh, mm] = m;
  return hh !== undefined
    ? new Date(Number(y), Number(mo) - 1, Number(d), Number(hh), Number(mm || 0), 0, 0).getTime()
    : new Date(Number(y), Number(mo) - 1, Number(d), 0, 0, 0, 0).getTime();
}
