// 原子 JSON 存储工具：tmp + rename 防写一半崩溃损坏
// 所有数据文件（memory/study/review/knowledge）统一走这里
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";

/**
 * 原子写入 JSON 文件：先写 <file>.tmp，再 rename 覆盖
 * 崩溃时最多丢失 tmp 文件，原文件不损坏
 */
export function writeJsonAtomic(file, data) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  renameSync(tmp, file); // 同目录 rename 是原子的（NTFS/APFS/ext4）
}

/** 读 JSON（带 .tmp 残留清理） */
export function readJsonSafe(file, fallback) {
  try {
    if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
  } catch { /* ignore */ }
  // 主文件损坏/缺失时尝试 tmp（上次写入的残留，通常更完整）
  try {
    if (existsSync(file + ".tmp")) return JSON.parse(readFileSync(file + ".tmp", "utf8"));
  } catch { /* ignore */ }
  return fallback;
}
