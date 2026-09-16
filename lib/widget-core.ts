// widget.mjs 的可测核心逻辑（纯逻辑：无 HTTP server / 定时器 / 通知等副作用）
// 从 widget.mjs 抽出，供单元测试直接覆盖。这些函数原本只在模块 import 时随 server
// 启动一起执行，导致只能靠 HTTP 集成测试间接覆盖（token 认证 + 爬取互斥曾因此形成测试盲区）。
// fs 依赖均可注入，便于测试模拟目录缺失/文件扫描中被删除等竞态。
// 全量 TS 升级工单阶段 3：lib/widget-core.mjs → .ts（调用方多处：widget.mjs / lib/routes/*.mjs / 测试 → 桶化零改动）
import path from "node:path";
import { existsSync, readdirSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * 可注入 fs 依赖。**刻意保持宽松（Function）**：原 JSDoc 即为 Function，测试会注入只实现部分方法的
 * 假 fs（模拟目录缺失/扫描中被删除等竞态），收窄类型会把假实现挡在门外（checkJs 下连 .mjs 测试一起报错）。
 */
export interface FsLike {
  existsSync: Function;
  readdirSync: Function;
  statSync: Function;
}

/** token 持久化依赖（同上：可注入，测试用假实现） */
export interface TokenDeps {
  randomUUID: () => string;
  existsSync: Function;
  readFileSync: Function;
  writeFileSync: Function;
  mkdirSync: Function;
}

/** 产出目录条目（按 mtime 倒序） */
export interface OutputDirEntry {
  dir: string;
  mtime: Date;
}

/** 最新产出的 md 文件条目 */
export interface OutputFileEntry {
  file: string;
  dir: string;
  mtime: Date;
  path: string;
}

/** 健康检查响应体 */
export interface HealthPayload {
  ok: boolean;
  db: boolean;
  uptime: number;
  port: number;
  version?: string;
}

// ============ 数据读取 ============

/** 最新产出目录列表（按 mtime 倒序，取前 limit 个） */
export function latestOutputs(limit = 12, outputDir: string, fs: FsLike = { existsSync, readdirSync, statSync }): OutputDirEntry[] {
  try {
    if (!fs.existsSync(outputDir)) return [];
    return fs.readdirSync(outputDir, { withFileTypes: true })
      .filter((d: { isDirectory: () => boolean }) => d.isDirectory())
      .map((d: { name: string }) => ({ dir: d.name, mtime: fs.statSync(path.join(outputDir, d.name)).mtime }))
      .sort((a: OutputDirEntry, b: OutputDirEntry) => b.mtime.getTime() - a.mtime.getTime())
      .slice(0, limit);
  } catch (e) {
    console.log(`[widget] latestOutputs 扫描失败: ${(e as Error).message}`);
    return [];
  }
}

/**
 * 扫最新产出目录里的 md 文件（按 mtime 倒序，取前 limit 个）。
 * 排除 00_ 开头的索引/README + study_notes（学习讲解存档，不算产出）。
 * 单文件 stat 失败（如扫描中被删除，ENOENT）只跳过该文件，不中断整体扫描。
 */
export function scanNewestFiles(limit = 20, outputDir: string, fs: FsLike = { existsSync, readdirSync, statSync }): OutputFileEntry[] {
  try {
    if (!fs.existsSync(outputDir)) return [];
    const files: OutputFileEntry[] = [];
    const SKIP_DIRS = new Set(["study_notes", "chat_solutions"]); // 学习存档/对话答疑产物不混入爬取产出
    // 闭环清查修复：原来只扫一层（output/<日期>/*.md），而爬取产出会把讲解写在
    // output/<日期>_discover/讲解/**.md → 这些文件**永远进不了「最新产出/今日推荐」**（写完没人读）。
    // 改为递归扫描（跳过学习存档目录与 00_ 索引），dir 保留相对子路径便于面板展示与打开。
    const walk = (absDir: string, relDir: string, depth: number): void => {
      if (depth > 3) return; // 防深目录异常（产出约定最多两层）
      let names: string[];
      try { names = fs.readdirSync(absDir) as string[]; } catch { return; }
      for (const name of names) {
        const abs = path.join(absDir, name);
        // 目录判定走 statSync（真实 fs 的 Stats 有 isDirectory；注入的假 fs 只有 mtime → 视为文件）
        let isDir = false;
        try { isDir = typeof (fs.statSync(abs) as { isDirectory?: () => boolean }).isDirectory === "function" && (fs.statSync(abs) as { isDirectory: () => boolean }).isDirectory(); } catch { /* 见下：交给文件分支再判一次 */ }
        if (isDir) {
          if (SKIP_DIRS.has(name)) continue;
          walk(abs, `${relDir}/${name}`, depth + 1);
          continue;
        }
        if (!name.endsWith(".md")) continue;
        if (/^00[_-]/.test(name)) continue; // 索引文件跳过
        try {
          files.push({ file: name, dir: relDir, mtime: fs.statSync(abs).mtime, path: abs });
        } catch { /* 文件在扫描中被删除（ENOENT 等），跳过该文件继续 */ }
      }
    };
    for (const d of fs.readdirSync(outputDir, { withFileTypes: true }) as Array<{ isDirectory: () => boolean; name: string }>) {
      if (!d.isDirectory()) continue;
      if (SKIP_DIRS.has(d.name)) continue; // 学习讲解存档不展示
      walk(path.join(outputDir, d.name), d.name, 1);
    }
    return files.sort((a, b) => b.mtime.getTime() - a.mtime.getTime()).slice(0, limit);
  } catch (e) {
    console.log(`[widget] scanNewestFiles 扫描失败: ${(e as Error).message}`);
    return [];
  }
}

// ============ Bearer Token 持久化 ============

/**
 * 读取或生成 Bearer token：已有有效文件 → 返回其 token；缺失/损坏 → 生成 UUID 并落盘。
 * 环境变量 MIANSHI_TOKEN 的优先级由调用方（widget.mjs）处理，这里只做文件级逻辑。
 */
export function loadOrCreateToken(tokenFile: string, { randomUUID, existsSync, readFileSync, writeFileSync, mkdirSync }: TokenDeps): string {
  try {
    if (existsSync(tokenFile)) {
      const j = JSON.parse(readFileSync(tokenFile, "utf8"));
      if (j && typeof j.token === "string" && j.token) return j.token;
    }
  } catch { /* ignore */ }
  const token = randomUUID();
  try {
    mkdirSync(path.dirname(tokenFile), { recursive: true });
    writeFileSync(tokenFile, JSON.stringify({ token, ts: Date.now() }), "utf8");
  } catch (e) {
    console.log(`[widget] 写入 token 文件失败: ${(e as Error).message}`);
  }
  return token;
}

// ============ 认证门禁 ============

/** 校验 Authorization 头是否为 `Bearer <token>`（精确匹配）。 */
export function checkBearerAuth(authHeader: string | undefined, token: string): boolean {
  return (authHeader || "") === `Bearer ${token}`;
}

// ============ 健康检查 ============

/** 构建 /api/health 响应体（version 可选——面板据此检测旧进程）。 */
export function buildHealthPayload(dbOk: boolean, uptime: number, port: number, version?: string): HealthPayload {
  const base: HealthPayload = { ok: true, db: dbOk, uptime, port };
  if (version) base.version = version;
  return base;
}

// ============ 请求体读取 ============

// 请求体大小上限（1MB）：防无界内存占用（超大 POST 直接 413）
export const MAX_BODY = 1024 * 1024;

/**
 * 读取请求体：限流 maxBytes（默认 1MB），超出返回 413 并销毁连接；成功则回调 body。
 * 仅操作 req/res 的 EventEmitter 接口，可用 fake emitter 单测。
 */
export function readBody(req: IncomingMessage, res: ServerResponse, cb: (body: string) => void, maxBytes = MAX_BODY): void {
  let body = "";
  let overflow = false;
  req.on("data", (c) => {
    if (overflow) return;
    body += c;
    if (body.length > maxBytes) {
      overflow = true;
      res.writeHead(413, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "请求体过大（>1MB）" }));
      req.destroy();
    }
  });
  req.on("end", () => {
    if (!overflow) cb(body);
  });
}

// ============ 爬取互斥 ============

/** 爬取互斥锁（并发 discover 会各自拉起 Playwright chromium，必须串行） */
export interface CrawlMutex {
  isRunning: () => boolean;
  /** 当前在跑的爬取子进程（无则 null）——供状态查询与「停止爬取」入口取句柄 */
  current: () => CrawlChild | null;
  /** 执行 fn 期间置 running；运行中二次 begin 直接返回 false 且不执行 fn */
  begin: <T>(fn: () => Promise<T>) => Promise<T | false>;
  /**
   * 接管一个已 spawn 的子进程：其存活期间 isRunning() 恒 true，exit/error 时自动释放。
   * 闭环清查修复：原实现只有 begin 的临界区语义——`begin(async () => spawn(...))` 在 spawn 返回的
   * 那一刻就置回 running=false，而 discover 子进程要跑几分钟 → `isRunning()` 几乎恒 false，
   * 于是 /api/run-discover 的 409「已有爬取任务运行中」与巡检的「爬取中则跳过」两道闸门全部失效
   * （实测可并发拉起多个 chromium）。现在把运行的判定绑到子进程真实存活期。
   * @returns false 表示已有子进程在跑——调用方应把刚 spawn 的进程杀掉（防御性，避免双跑）
   */
  track: (child: CrawlChild) => boolean;
  /** 显式释放（停止路径兜底）：kill 没让子进程在超时内退出时调用，避免「锁死后再也跑不了爬取」 */
  release: () => void;
}

/** 可接管的子进程句柄（child_process.ChildProcess 的最小子集——单测可注入假句柄） */
export interface CrawlChild {
  pid?: number;
  kill: (signal?: NodeJS.Signals) => boolean;
  once: (event: string, listener: () => void) => unknown;
}

/** 创建爬取互斥锁：防止并发 discover 子进程（每个都会拉起 Playwright chromium）。 */
export function createCrawlMutex(): CrawlMutex {
  let running = false;
  let active: CrawlChild | null = null;
  return {
    isRunning: () => running,
    current: () => active,
    async begin<T>(fn: () => Promise<T>): Promise<T | false> {
      if (running) return false;
      running = true;
      try {
        return await fn();
      } finally {
        // track() 已接管存活期时不能在这里释放（否则又退回"只护 spawn 一瞬"）
        if (!active) running = false;
      }
    },
    track(child: CrawlChild): boolean {
      if (active) return false;
      active = child;
      running = true;
      const release = () => {
        if (active === child) { active = null; running = false; }
      };
      try {
        child.once("exit", release);
        child.once("error", release);
      } catch { /* 假句柄/异常：退化为不自动释放（由 stop 路径显式释放） */ }
      return true;
    },
    release() {
      active = null;
      running = false;
    },
  };
}
