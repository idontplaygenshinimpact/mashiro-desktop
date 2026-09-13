// 示例插件 server（协议即文档——新插件照抄本文件）
// 演示 4 个注册点：
//   1) API 路由（router）：GET /api/plg/template/hello
//   2) 设置项（settings）：读写宿主 settings 表（key 自动加 plg_<id>_ 前缀）
//   3) 健康检查（health）：宿主插件管理页展示
//   4) 初始化钩子（init）：宿主加载后调用（可选）
// 注意：register 是唯一必需导出；其余（init/health）可选。
// 全量 TS 升级工单阶段 4（插件）：实现迁至 server.ts，server.mjs 保留同名薄桶
// （插件入口按 manifest.server 路径约定加载 → 协议入口与加载器零改动）
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Router } from "#lib/routes/router.mjs";

/** 设置项注册表条目：{ key, type: text|toggle|password, group, label, default, description }
 * type=password 时宿主面板渲染为密码框；type=toggle 渲染为开关 */
export interface PluginSettingSpec {
  key: string;
  type: "text" | "toggle" | "password";
  group: string;
  label: string;
  default: unknown;
  description: string;
}

/** 宿主注入的设置命名空间（key 自动加 plg_<id>_ 前缀，值走 JSON 序列化） */
export interface PluginSettingsNs {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => unknown;
}

/** 插件入口注入的 API 面（宿主注入 api = { router, db, getCorsOrigin, laneSubmit, settings, log }） */
export interface TemplatePluginApi {
  router: Router;
  settings: PluginSettingsNs;
  db?: unknown;
  getCorsOrigin?: (...args: any[]) => any;
  laneSubmit?: (...args: any[]) => any;
  log?: (...args: unknown[]) => void;
}

/** 错误信息提取（catch 变量在 strict 下是 unknown） */
const eMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** 设置项注册表 */
export const SETTINGS: PluginSettingSpec[] = [
  { key: "template_greeting", type: "text", group: "示例插件", label: "问候语", default: "你好，我是真白！", description: "模板插件的问候语" },
  { key: "template_enabled", type: "toggle", group: "示例插件", label: "启用问候", default: true, description: "关闭后模板接口返回提示" },
];

/**
 * 插件入口：宿主注入 api（见 TemplatePluginApi）
 */
export function register(api: TemplatePluginApi): void {
  const { router, settings, log } = api;
  log?.("[plugin-template] 注册成功（协议演示：路由/设置/健康检查）");

  // 1) API 路由：模板接口（演示读设置项）
  router.route("/api/plg/template/hello", (req: IncomingMessage, res: ServerResponse) => {
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
      res.end(JSON.stringify({ error: eMsg(e) }));
    }
  });

  // 2) 面板数据接口：模板 Tab 展示用
  router.route("/api/plg/template/data", (req: IncomingMessage, res: ServerResponse) => {
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
      res.end(JSON.stringify({ error: eMsg(e) }));
    }
  });
}

/** 可选：健康检查（插件管理页展示状态；返回 { ok, detail }） */
export function health(): { ok: boolean; detail: string } {
  return { ok: true, detail: "示例插件运行正常" };
}

/** 可选：初始化钩子（宿主加载后调用；失败仅记日志不阻断） */
export async function init(api: TemplatePluginApi): Promise<void> {
  // 初始化默认设置（用户改过的不覆盖）
  try {
    for (const s of SETTINGS) {
      if (api.settings.get(s.key) === null) api.settings.set(s.key, s.default);
    }
  } catch (e) {
    api.log?.(`[plugin-template] 初始化设置失败: ${eMsg(e)}`);
  }
}
