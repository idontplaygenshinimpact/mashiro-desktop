// 平台账号配置：data/platform-accounts.json 管理（登录态/投递设置/频率限制）
// 设计：JSON 单文件（含敏感 cookie，提示用户本机私有）；atomic-json 原子写；
// 频率限制：每日投递上限 + 最小间隔（防平台风控/误操作）
import path from "node:path";
import { writeJsonAtomic, readJsonSafe } from "./atomic-json.ts";

// 测试隔离：MIANSHI_PLATFORM_ACCOUNTS 指向临时文件（生产不设置则用默认路径）
const ACCOUNTS_FILE = process.env.MIANSHI_PLATFORM_ACCOUNTS
  || path.join(process.env.MIANSHI_DATA_DIR || path.join(import.meta.dirname, "..", "data"), "platform-accounts.json");

/** 平台账号配置（登录态/投递设置/频率限制；运行时注入计数与时间戳；平台扩展字段宽松） */
export interface PlatformAccount {
  enabled?: boolean;
  authMethod?: string;
  cookie?: string;
  greeting?: string;
  applyDailyLimit?: number;
  applyMinIntervalSec?: number;
  applyCountToday?: number;
  applyDate?: string;
  lastApplyAt?: number;
  updatedAt?: number;
  [k: string]: unknown;
}

// 平台默认配置（注册平台时提供 defaults 合并；此处为内置兜底）
const PLATFORM_DEFAULTS: Record<string, PlatformAccount> = {
  boss: {
    enabled: false,
    authMethod: "none",           // none | cookie | edge
    cookie: "",                    // 用户粘贴的 Cookie 头（登录态）
    greeting: "您好，我是 2026 届前端方向应届生，对贵司该岗位非常感兴趣。这是我的简历，期待进一步沟通：",
    applyDailyLimit: 10,           // 每日投递上限
    applyMinIntervalSec: 30,       // 两次投递最小间隔（秒）
  },
};

/** 读配置（不存在/损坏 → 默认模板）；merge 平台默认值 */
export function loadAccounts(): Record<string, PlatformAccount> {
  const base: Record<string, PlatformAccount> = {};
  for (const [k, v] of Object.entries(PLATFORM_DEFAULTS)) {
    base[k] = { ...v, applyCountToday: 0, applyDate: "", lastApplyAt: 0 };
  }
  const file: unknown = readJsonSafe(ACCOUNTS_FILE, null);
  if (file && typeof file === "object" && !Array.isArray(file)) {
    for (const [k, v] of Object.entries(file as Record<string, unknown>)) {
      if (v && typeof v === "object") {
        const rec = v as Record<string, unknown>;
        base[k] = base[k] ? { ...base[k], ...rec } : (rec as unknown as PlatformAccount);
      }
    }
  }
  return base;
}

/** 持久化（原子写） */
export function saveAccounts(accounts: Record<string, PlatformAccount>): boolean {
  writeJsonAtomic(ACCOUNTS_FILE, accounts);
  return true;
}

/** 单平台读取 */
export function getAccount(name: string): PlatformAccount | null {
  return loadAccounts()[name] || null;
}

/** 单平台配置更新（部分 patch 合并），返回更新后的账号 */
export function saveAccount(name: string, patch: Record<string, unknown> | null | undefined): PlatformAccount | null {
  if (!PLATFORM_DEFAULTS[name] && !patch) return null;
  const accounts = loadAccounts();
  accounts[name] = { ...(accounts[name] || {}), ...(patch || {}), updatedAt: Date.now() };
  saveAccounts(accounts);
  return accounts[name];
}

/** 平台是否启用 */
export function isPlatformEnabled(name: string): boolean {
  const a = getAccount(name);
  return !!(a && a.enabled);
}

/** 本地时区日期键 YYYY-MM-DD（修复：toISOString 是 UTC 日界，东八区 0-8 点会算到前一天，导致日限额/跨天重置错位） */
function localDateKey(now: number): string {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** 频率限制检查结果（remaining 剩余额度；nextAt 建议下次时间） */
export interface RateLimitResult {
  ok: boolean;
  reason?: string;
  remaining?: number;
  nextAt?: number;
}

/**
 * 投递频率限制检查：每日上限 + 最小间隔
 */
export function checkApplyRateLimit(name: string, now = Date.now()): RateLimitResult {
  const accounts = loadAccounts();
  const a = accounts[name];
  if (!a) return { ok: false, reason: `平台 ${name} 未配置` };
  const limit = Number(a.applyDailyLimit) || 10;
  const minIntervalMs = (Number(a.applyMinIntervalSec) || 30) * 1000;
  const today = localDateKey(now);
  // 跨天重置计数
  let count = a.applyDate === today ? Number(a.applyCountToday) || 0 : 0;
  if (count >= limit) {
    return { ok: false, reason: `今日投递已达上限（${limit}/${limit}），明天再来或调高上限` };
  }
  const last = Number(a.lastApplyAt) || 0;
  if (last && now - last < minIntervalMs) {
    return { ok: false, reason: `投递过于频繁，请 ${Math.ceil((minIntervalMs - (now - last)) / 1000)} 秒后再试`, nextAt: last + minIntervalMs };
  }
  return { ok: true, remaining: limit - count };
}

/** 记录一次投递（更新计数/时间；调用方应只在投递成功或已发起后调用） */
export function recordApply(name: string, now = Date.now()): boolean {
  const accounts = loadAccounts();
  const a = accounts[name];
  if (!a) return false;
  const today = localDateKey(now);
  a.applyCountToday = a.applyDate === today ? (Number(a.applyCountToday) || 0) + 1 : 1;
  a.applyDate = today;
  a.lastApplyAt = now;
  saveAccounts(accounts);
  return true;
}

/** 导出（测试/面板展示） */
export const platformAccountsFile: string = ACCOUNTS_FILE;
