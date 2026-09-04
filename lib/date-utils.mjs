// 日期工具：统一全库日期分桶口径（修复 M12——UTC/本地时区混用，东八区 0-8 点跨天分桶错位）
// 约定：所有"按天分桶/聚合/日期键"一律用本地时区（用户日历日），不用 toISOString（UTC）

/** 本地时区日期键（YYYY-MM-DD）——与用户日历日一致（东八区 0-8 点不跨天） */
export function localDateKey(ts = Date.now()) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
