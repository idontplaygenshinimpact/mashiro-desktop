// 后端启动路径回归护栏（性能）：**启动即加载 playwright/jsdom** 是"后端比前端慢"的根因
// 实测（隔离环境 + 真实规模库副本，2026-09-16）：
//   修前：spawn → /api/health 可响应 2190ms；修后 834ms（-1.36s）
//   其中 agent.ts 导入 1483ms、fetch-page.ts 1290ms（playwright 397ms + jsdom）——
//   全花在"启动就加载一个只有聊天/抓取才用得到的浏览器栈"上。
// 本护栏不看时间（CI 机器速度不可控），而是看**模块图**：启动路径导入后，playwright/jsdom
// 绝不能出现在 CJS 模块缓存里（它们都是 CJS 包，进了缓存说明真被求值了）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { setupTempDb, mockLLM } from "./helpers.mjs";

setupTempDb("boot-lazy-graph");
mockLLM();

const require_ = createRequire(import.meta.url);
/** 已求值的重模块（playwright / playwright-core / jsdom 任一）——按包目录判定，避免误伤同名文件 */
const heavyLoaded = () =>
  Object.keys(require_.cache).filter((p) => /[\\/]node_modules[\\/](playwright|playwright-core|jsdom)[\\/]/.test(p));

test("启动路径（core 路由 + 插件入口 + oj）不得求值 playwright/jsdom", async () => {
  assert.deepEqual(heavyLoaded(), [], "前置不成立：测试进程一开始就加载了重模块（护栏会失去意义）");

  await import("../lib/routes/core.mjs");        // widget.mjs 的启动依赖（含 chat 路由）
  await import("../plugins/job-hunter/server.ts"); // 插件入口（启动时 loadEnabledPlugins 会跑）
  await import("../lib/oj.ts");                    // 题库抓取（被插件路由静态导入）
  assert.deepEqual(
    heavyLoaded(), [],
    `启动路径不得拉起浏览器栈（实测会让进程从 spawn 到可响应多花 ~1.4s）；实际加载了：\n${heavyLoaded().join("\n")}`
  );

  // 正对照：证明探测方法确实能看到它们（否则上面的断言可能只是因为方法失效而"永远绿"）
  await import("../lib/fetch-page.ts");
  assert.ok(heavyLoaded().length > 0, "正对照失败：加载 fetch-page 后仍看不到 playwright/jsdom → 探测方法失效");
}, { timeout: 120000 });

test("懒加载写法在源码层面固化（防手滑改回静态 import）", async () => {
  const core = await readFile(new URL("../lib/routes/core.ts", import.meta.url), "utf8");
  assert.doesNotMatch(core, /^import\s*\{[^}]*chatWithAgent[^}]*\}\s*from\s*"\.\.\/agent\.mjs"/m, "core.ts 不得静态导入 agent.mjs");
  assert.match(core, /loadAgent\s*=/, "core.ts 应有 memo 化的 loadAgent()");
  assert.match(core, /import\("\.\.\/agent\.mjs"\)/, "core.ts 应动态导入 agent.mjs");
  const oj = await readFile(new URL("../lib/oj.ts", import.meta.url), "utf8");
  assert.doesNotMatch(oj, /^import\s*\{[^}]*assertPublicUrl[^}]*\}\s*from\s*"\.\/fetch-page\.mjs"/m, "oj.ts 不得静态导入 fetch-page.mjs");
  assert.match(oj, /await import\("\.\/fetch-page\.mjs"\)/, "oj.ts 应在使用处动态导入 fetch-page.mjs");
  const widget = await readFile(new URL("../widget.mjs", import.meta.url), "utf8");
  assert.match(widget, /import\("\.\/lib\/agent\.mjs"\)/, "widget.mjs 应在 listen 后后台预热 agent 图（首次聊天不必补付加载成本）");
});
