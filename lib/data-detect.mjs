// 桌宠数据目录自动探测（Phase MCP 分发：把"连接器"做成接近即插即用）
// 问题：桌宠数据因安装形态落在不同位置（源码版=项目 data/、打包版=Electron userData/data、
// MCP 默认=~/.mashiro/data）——默认目录不一致导致用户必须手动配置。
// 修复：按优先级探测"已存在的桌宠数据目录"（含 mianshi.db 视为有效），命中即用——
// 已有桌宠的用户装包即连零配置；干净用户回落 ~/.mashiro/data（自建）。
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";

/** 候选数据目录（按优先级） */
export function candidateDataDirs(extra = []) {
  const home = os.homedir();
  const appData = process.env.APPDATA || path.join(home, ".config"); // Windows/Linux 兜底
  const candidates = [
    // 1) 显式环境变量（用户/桌宠注入，最高优先）
    ...(process.env.MIANSHI_DATA_DIR ? [process.env.MIANSHI_DATA_DIR] : []),
    // 2) 源码版：当前进程同目录的 data/（npm 包装在项目里、或源码直接跑）
    path.join(import.meta.dirname, "..", "data"),
    // 3) 打包版桌宠（Electron userData）：常见 app 名候选
    path.join(appData, "mashiro-desktop", "data"),
    path.join(appData, "Mashiro", "data"),
    path.join(appData, "mashiro", "data"),
    // macOS userData
    path.join(home, "Library", "Application Support", "mashiro-desktop", "data"),
    path.join(home, "Library", "Application Support", "Mashiro", "data"),
    // 4) MCP 自有默认（兜底：自建空库）
    path.join(home, ".mashiro", "data"),
    ...extra,
  ];
  // 去重保序
  return [...new Set(candidates)];
}

/** 探测有效桌宠数据目录：返回第一个含 mianshi.db 的候选；都没有 → null（调用方建默认） */
export function detectDataDir(extra = []) {
  for (const dir of candidateDataDirs(extra)) {
    try {
      if (existsSync(path.join(dir, "mianshi.db"))) return dir;
    } catch { /* 路径异常跳过 */ }
  }
  return null;
}

/** 解析最终数据目录：探测命中 → 用之；否则回落到显式/默认候选首位（自建） */
export function resolveDataDir(extra = []) {
  const hit = detectDataDir(extra);
  if (hit) return hit;
  // 无现成库：用显式 env 或 MCP 默认（~/.mashiro/data），自建
  const fallback = process.env.MIANSHI_DATA_DIR || path.join(os.homedir(), ".mashiro", "data");
  return fallback;
}
