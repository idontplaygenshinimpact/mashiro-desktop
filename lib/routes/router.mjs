// 路由注册器：widget.mjs 纵向拆分的核心机制
// 每个业务域模块（lib/routes/*.mjs）向 router 注册 (pathname, method, handler)；
// widget.mjs 在 server callback 中 resolve 并分发，自身只保留：鉴权/CORS/健康检查/服务生命周期
export function createRouter() {
  const table = [];
  return {
    /**
     * 注册路由
     * @param {string} pathname 路径
     * @param {string|null|Function} [method] GET/POST；null=任意方法；传函数则视为 fn
     * @param {Function} [fn] (req, res, url) => void
     * @param {{ input?: import("zod").ZodType, output?: import("zod").ZodType }} [schema] 契约（Phase 2，可选；缺省行为与旧版完全一致）
     */
    route(pathname, method, fn, schema) {
      if (typeof method === "function") { schema = /** @type {any} */ (fn); fn = method; method = null; }
      table.push({ pathname, method: method || null, fn, schema });
    },
    /** 精确匹配（注册顺序优先，与旧版 if-else 顺序语义一致） */
    resolve(pathname, method) {
      return table.find((h) => h.pathname === pathname && (!h.method || h.method === method)) || null;
    },
    /** 该路径是否挂了契约（供契约覆盖率断言 / 分发判断） */
    hasSchema(pathname, method) {
      const h = this.resolve(pathname, method);
      return !!(h && h.schema);
    },
    /** 已挂契约的路由数（契约覆盖率统计） */
    schemaCount() {
      return table.filter((h) => h.schema).length;
    },
    size: () => table.length,
  };
}
