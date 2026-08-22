// 示例插件 server（协议即文档——新插件照抄本文件）
// 演示 4 个注册点：
//   1) API 路由（router）：GET /api/plg/template/hello
//   2) 设置项（settings）：读写宿主 settings 表（key 自动加 plg_<id>_ 前缀）
//   3) 健康检查（health）：宿主插件管理页展示
//   4) 初始化钩子（init）：宿主加载后调用（可选）
// 注意：register 是唯一必需导出；其余（init/health）可选。

/** 设置项注册表：{ key, type: text|toggle|password, group, label, default, description }
 * type=password 时宿主面板渲染为密码框；type=toggle 渲染为开关 */
export const SETTINGS = [
  { key: "template_greeting", type: "text", group: "示例插件", label: "问候语", default: "你好，我是真白！", description: "模板插件的问候语" },
  { key: "template_enabled", type: "toggle", group: "示例插件", label: "启用问候", default: true, description: "关闭后模板接口返回提示" },
];

/**
 * 插件入口：宿主注入 api = { router, db, getCorsOrigin, laneSubmit, settings, log }
 * @param {{ router: any, db: any, settings: { get: Function, set: Function }, log: Function }} api
 */
export function register(api) {
  const { router, settings, log } = api;
  log?.("[plugin-template] 注册成功（协议演示：路由/设置/健康检查）");

  // 1) API 路由：模板接口（演示读设置项）
  router.route("/api/plg/template/hello", (req, res) => {
    try {
      const enabled = settings.get("template_enabled") === true;
      const greeting = String(settings.get("template_greeting") || "你好，我是真白！").slice(0, 100);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({
        ok: true,
        message: enabled ? greeting : "问候已关闭（可在设置中心启用）",
        plugin: "plugin-template",
        manifestVersion: 1,
      }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
  });

  // 2) 面板数据接口：模板 Tab 展示用
  router.route("/api/plg/template/data", (req, res) => {
    try {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({
        ok: true,
        greeting: String(settings.get("template_greeting") || "你好，我是真白！").slice(0, 100),
        enabled: settings.get("template_enabled") === true,
        hint: "这是示例插件的数据——新插件把这里换成自己的业务即可",
        timestamp: Date.now(),
      }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
  });
}

/** 可选：健康检查（插件管理页展示状态；返回 { ok, detail }） */
export function health() {
  return { ok: true, detail: "示例插件运行正常" };
}

/** 可选：初始化钩子（宿主加载后调用；失败仅记日志不阻断） */
export async function init(api) {
  // 初始化默认设置（用户改过的不覆盖）
  try {
    for (const s of SETTINGS) {
      if (api.settings.get(s.key) === null) api.settings.set(s.key, s.default);
    }
  } catch (e) {
    api.log?.(`[plugin-template] 初始化设置失败: ${e.message}`);
  }
}
