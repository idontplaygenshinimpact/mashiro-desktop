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
    for (const d of fs.readdirSync(outputDir, { withFileTypes: true }) as Array<{ isDirectory: () => boolean; name: string }>) {
      if (!d.isDirectory()) continue;
      if (SKIP_DIRS.has(d.name)) continue; // 学习讲解存档不展示
      const dirPath = path.join(outputDir, d.name);
      for (const f of fs.readdirSync(dirPath) as string[]) {
        if (!f.endsWith(".md")) continue;
        if (/^00[_-]/.test(f)) continue; // 索引文件跳过
        const fp = path.join(dirPath, f);
        try {
          files.push({ file: f, dir: d.name, mtime: fs.statSync(fp).mtime, path: fp });
        } catch { /* 文件在扫描中被删除（ENOENT 等），跳过该文件继续 */ }
      }
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
  /** 执行 fn 期间置 running；运行中二次 begin 直接返回 false 且不执行 fn */
  begin: <T>(fn: () => Promise<T>) => Promise<T | false>;
}

/** 创建爬取互斥锁：防止并发 discover 子进程（每个都会拉起 Playwright chromium）。 */
export function createCrawlMutex(): CrawlMutex {
  let running = false;
  return {
    isRunning: () => running,
    async begin<T>(fn: () => Promise<T>): Promise<T | false> {
      if (running) return false;
      running = true;
      try {
        return await fn();
      } finally {
        running = false;
      }
    },
  };
}
