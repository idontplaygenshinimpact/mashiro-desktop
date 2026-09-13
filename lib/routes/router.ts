// 路由注册器：widget.mjs 纵向拆分的核心机制
// 每个业务域模块（lib/routes/*、plugins/*/routes/*）向 router 注册 (pathname, method, handler)；
// widget.mjs 在 server callback 中 resolve 并分发，自身只保留：鉴权/CORS/健康检查/服务生命周期
// 全量 TS 升级工单阶段 3：lib/routes/router.mjs → .ts（widget.mjs 与各路由域按 .mjs 路径加载 → 保留同名一行桶）
import type { ZodType } from "zod";

/** 路由处理函数（req/res/url 形状由宿主决定——路由域按需自行收口） */
export type RouteFn = ((req: unknown, res: unknown, url: unknown) => unknown) & { _contract?: unknown };
/** 契约（Phase 2，可选；缺省行为与旧版完全一致） */
export interface RouteSchema { input?: ZodType; output?: ZodType }
/** 已注册路由条目 */
export interface RouteEntry {
  pathname: string;
  method: string | null;
  fn: RouteFn;
  schema?: RouteSchema;
}
/** 路由表对外面（业务域只用到 route；widget 用 resolve/hasSchema/schemaCount/size） */
export interface Router {
  /**
   * 注册路由
   * @param pathname 路径
   * @param method GET/POST；null=任意方法；传函数则视为 fn
   * @param fn (req, res, url) => void
   * @param schema 契约（可选）
   */
  route(pathname: string, method?: string | null | RouteFn, fn?: RouteFn | RouteSchema, schema?: RouteSchema): void;
  /** 精确匹配（注册顺序优先，与旧版 if-else 顺序语义一致） */
  resolve(pathname: string, method?: string): RouteEntry | null;
  /** 该路径是否挂了契约（供契约覆盖率断言 / 分发判断） */
  hasSchema(pathname: string, method?: string): boolean;
  /** 已挂契约的路由数（契约覆盖率统计） */
  schemaCount(): number;
  size: () => number;
}

export function createRouter(): Router {
  const table: RouteEntry[] = [];
  return {
    route(pathname: string, method?: string | null | RouteFn, fn?: RouteFn | RouteSchema, schema?: RouteSchema): void {
      // 显式分流（不依赖参数收窄）：传函数 = 省略 method 的两参形式
      let m: string | null = null;
      let f: RouteFn | undefined;
      let s: RouteSchema | undefined = schema;
      if (typeof method === "function") { s = fn as RouteSchema | undefined; f = method; }
      else { m = method || null; f = fn as RouteFn | undefined; }
      table.push({ pathname, method: m, fn: f as RouteFn, schema: s });
    },
    resolve(pathname: string, method?: string): RouteEntry | null {
      return table.find((h) => h.pathname === pathname && (!h.method || h.method === method)) || null;
    },
    hasSchema(pathname: string, method?: string): boolean {
      const h = this.resolve(pathname, method);
      // schema 可来自 route() 第 4 参，或 withContract 包装器挂载的 handler._contract
      return !!(h && (h.schema || h.fn?._contract));
    },
    schemaCount(): number {
      return table.filter((h) => h.schema || h.fn?._contract).length;
    },
    size: () => table.length,
  };
}
