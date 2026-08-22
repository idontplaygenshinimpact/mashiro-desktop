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
     */
    route(pathname, method, fn) {
      if (typeof method === "function") { fn = method; method = null; }
      table.push({ pathname, method: method || null, fn });
    },
    /** 精确匹配（注册顺序优先，与旧版 if-else 顺序语义一致） */
    resolve(pathname, method) {
      return table.find((h) => h.pathname === pathname && (!h.method || h.method === method)) || null;
    },
    size: () => table.length,
  };
}
