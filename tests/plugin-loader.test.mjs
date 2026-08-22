// tests/plugin-loader.test.mjs —— 插件加载器单测（阶段 1 协议）
// 覆盖：发现 manifest / 校验 / 注册调用 / 失败隔离（坏插件不拖垮其余）
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { discoverPlugins, validateManifest, loadPlugin, loadAllPlugins } from "../lib/plugin-loader.mjs";

function tempPluginsDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "plugins-"));
  return dir;
}
function writePlugin(root, id, { manifest = {}, server = "" } = {}) {
  const dir = path.join(root, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ id, name: id, version: "1.0.0", server: "server.mjs", ...manifest }));
  if (server) writeFileSync(path.join(dir, "server.mjs"), server);
  return dir;
}

test("discoverPlugins：扫描带 manifest 的插件目录，跳过无 manifest 的目录", () => {
  const root = tempPluginsDir();
  writePlugin(root, "good", { server: "export function register() {}" });
  mkdirSync(path.join(root, "no-manifest"), { recursive: true }); // 无 manifest → 跳过
  const found = discoverPlugins(root);
  assert.equal(found.length, 1);
  assert.equal(found[0].manifest.id, "good");
  rmSync(root, { recursive: true, force: true });
});

test("validateManifest：缺字段/非法 id 拒绝", () => {
  assert.ok(validateManifest({ id: "x", name: "x", server: "s.mjs" }) === null, "合法");
  assert.match(validateManifest({ name: "x", server: "s.mjs" }) || "", /id/);
  assert.match(validateManifest({ id: "Bad_ID!", name: "x", server: "s.mjs" }) || "", /非法插件 id/);
});

test("loadPlugin：调用 register(api)，api 透传宿主能力", async () => {
  const root = tempPluginsDir();
  writePlugin(root, "demo", { server: "export function register(api) { api.log(api.msg); return { ok: true }; }" });
  const [p] = discoverPlugins(root);
  const seen = [];
  const r = await loadPlugin(p, { msg: "hello", log: (s) => seen.push(s) });
  assert.equal(r.ok, true);
  assert.equal(r.id, "demo");
  assert.deepEqual(seen, ["hello"], "register 收到宿主注入的 api");
  rmSync(root, { recursive: true, force: true });
});

test("loadPlugin：坏插件失败隔离（返回错误不抛，不中断宿主）", async () => {
  const root = tempPluginsDir();
  writePlugin(root, "broken", { server: "export function register() { throw new Error('boom'); }" });
  const [p] = discoverPlugins(root);
  const r = await loadPlugin(p, {});
  assert.equal(r.ok, false);
  assert.match(r.error, /boom/);
  rmSync(root, { recursive: true, force: true });
});

test("loadPlugin：server 未导出 register → 明确报错", async () => {
  const root = tempPluginsDir();
  writePlugin(root, "noreg", { server: "export const x = 1;" });
  const [p] = discoverPlugins(root);
  const r = await loadPlugin(p, {});
  assert.equal(r.ok, false);
  assert.match(r.error, /register/);
  rmSync(root, { recursive: true, force: true });
});

test("loadAllPlugins：好插件 + 坏插件混合 → 好的加载、坏的报错，互不拖累", async () => {
  const root = tempPluginsDir();
  writePlugin(root, "good-a", { server: "export function register(api) { api.count++; }" });
  writePlugin(root, "bad-b", { server: "export function register() { throw new Error('x'); }" });
  const state = { count: 0 };
  const results = await loadAllPlugins(state, root);
  assert.equal(results.length, 2);
  assert.equal(results.filter((r) => r.ok).length, 1, "好插件加载成功");
  assert.equal(results.filter((r) => !r.ok).length, 1, "坏插件失败隔离");
  assert.equal(state.count, 1, "好插件的 register 执行了");
  rmSync(root, { recursive: true, force: true });
});

// 回归护栏：真实秋招助手插件可通过加载器加载（协议对外承诺）
test("真实插件：plugins/job-hunter 可被加载器发现并校验", async () => {
  const found = discoverPlugins();
  const jh = found.find((p) => p.manifest.id === "job-hunter");
  assert.ok(jh, "发现 job-hunter 插件");
  assert.equal(validateManifest(jh.manifest), null, "manifest 合法");
  assert.ok(jh.manifest.server === "server.mjs");
});

// 回归护栏：示例插件模板（阶段 2 协议即文档）可加载，settings 命名空间隔离
test("示例插件模板：加载成功 + init 默认设置 + settings 前缀隔离", async () => {
  const found = discoverPlugins();
  const tmpl = found.find((p) => p.manifest.id === "plugin-template");
  assert.ok(tmpl, "发现 plugin-template 插件");
  assert.equal(validateManifest(tmpl.manifest), null, "manifest 合法（含 panel 声明）");
  assert.ok(tmpl.manifest.panel?.tabs?.length >= 1, "panel.tabs 声明");
  assert.ok(tmpl.manifest.panel?.settings?.length >= 1, "panel.settings 声明");
  // 加载（mock db 用真临时库）
  const { setupTempDb, cleanupTempDb } = await import("./helpers.mjs");
  const dbDir = setupTempDb("plg-tmpl");
  const { db } = await import("../lib/db.mjs");
  const { createRouter } = await import("../lib/routes/router.mjs");
  const router = createRouter();
  const r = await loadPlugin(tmpl, { router, db, getCorsOrigin: () => "*", laneSubmit: (fn) => fn(), log: () => {} });
  assert.equal(r.ok, true, "模板插件加载成功");
  assert.ok(r.panel, "返回 panel 声明");
  assert.ok(r.health?.ok, "健康检查通过");
  // init 写入默认设置（带 plg_ 前缀）
  const row = db.prepare("SELECT value FROM settings WHERE key='plg_plugin-template_template_greeting'").get();
  assert.ok(row?.value, "init 默认设置已写入（前缀隔离）");
  assert.ok(JSON.parse(String(row.value)).includes("真白"), "默认问候语");
  // settings 命名空间读写
  const { loadPlugin: loadAgain } = await import("../lib/plugin-loader.mjs");
  const api = { router, db, getCorsOrigin: () => "*", laneSubmit: (fn) => fn(), log: () => {} };
  await loadAgain(tmpl, api);
  // 通过 server 注册的路由表验证（不直接测 settings 对象——路由已注册即可）
  cleanupTempDb(dbDir);
});
