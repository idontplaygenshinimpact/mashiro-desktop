// tests/plugin-admin.test.mjs —— 插件管理单测（阶段 3：启停/列表/设置/市场安装）
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setupTempDb, cleanupTempDb, clearAllTables } from "./helpers.mjs";

const dbDir = setupTempDb("plugin-admin");
const { db } = await import("../lib/db.mjs");
const {
  isPluginDisabled, setPluginEnabled, loadEnabledPlugins, listPlugins,
  readPluginSettings, writePluginSetting, installPlugin, getPluginMarket,
} = await import("../lib/plugin-admin.mjs");

function tempPluginsDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "plgadmin-"));
  const writePlugin = (id, { manifest = {}, server = "" } = {}) => {
    const d = path.join(dir, id);
    mkdirSync(d, { recursive: true });
    writeFileSync(path.join(d, "manifest.json"), JSON.stringify({
      id, name: id, version: "1.0.0", server: "server.mjs",
      panel: { tabs: [{ id: "t1", label: "Tab1" }], settings: [{ key: "greeting", type: "text", label: "问候语" }, { key: "enabled", type: "toggle", label: "开关" }] },
      ...manifest,
    }));
    if (server) writeFileSync(path.join(d, "server.mjs"), server);
  };
  return { dir, writePlugin };
}

after(async () => { await cleanupTempDb(dbDir); });

test("setPluginEnabled/isPluginDisabled：启停标记读写 + 重新启用清除", () => {
  assert.equal(isPluginDisabled("demo-a"), false, "默认启用");
  const off = setPluginEnabled("demo-a", false);
  assert.equal(off.ok, true);
  assert.equal(isPluginDisabled("demo-a"), true, "停用后标记生效");
  setPluginEnabled("demo-a", true);
  assert.equal(isPluginDisabled("demo-a"), false, "重新启用清除标记");
});

test("loadEnabledPlugins：停用的插件跳过加载（register 不被调用）", async () => {
  await clearAllTables();
  const { dir, writePlugin } = tempPluginsDir();
  writePlugin("active", { server: "export function register(api) { api.calls.push('active'); }" });
  writePlugin("sleeping", { server: "export function register(api) { api.calls.push('sleeping'); }" });
  setPluginEnabled("sleeping", false); // 停用 sleeping
  const state = { calls: [] };
  const results = await loadEnabledPlugins(state, dir);
  assert.equal(results.length, 2);
  const sleep = results.find((r) => r.id === "sleeping");
  assert.equal(sleep.ok, false, "停用插件不加载");
  assert.equal(sleep.disabled, true, "标记 disabled");
  assert.match(sleep.error, /停用/);
  assert.deepEqual(state.calls, ["active"], "只有启用插件执行 register");
  rmSync(dir, { recursive: true, force: true });
});

test("listPlugins：manifest + 加载结果 + 启停标记合并", async () => {
  await clearAllTables();
  const { dir, writePlugin } = tempPluginsDir();
  writePlugin("alpha", { server: "export function register() {}" });
  writePlugin("beta", { server: "export function register() { throw new Error('boom'); }" });
  setPluginEnabled("beta", false);
  await loadEnabledPlugins({ db }, dir);
  const list = listPlugins(dir);
  assert.equal(list.length, 2);
  const a = list.find((p) => p.id === "alpha");
  assert.equal(a.disabled, false);
  assert.equal(a.load.ok, true, "alpha 加载成功");
  assert.equal(a.load.health, null, "未声明 health 检查时为 null（模板插件才有 health）");
  assert.equal(a.panel.tabs[0].label, "Tab1");
  const b = list.find((p) => p.id === "beta");
  assert.equal(b.disabled, true);
  assert.equal(b.load.ok, false);
  rmSync(dir, { recursive: true, force: true });
});

test("readPluginSettings/writePluginSetting：只允许 manifest 声明的 key + 类型收敛", async () => {
  await clearAllTables();
  const { dir, writePlugin } = tempPluginsDir();
  writePlugin("cfg", { server: "export function register() {}" });
  await loadEnabledPlugins({ db }, dir);
  // 未声明 key 拒绝
  const bad = writePluginSetting("cfg", "hack_key", "x", dir);
  assert.equal(bad.ok, false);
  assert.match(bad.error, /未声明/);
  // 声明 key 写入 + 类型收敛（toggle 收成布尔）
  const w1 = writePluginSetting("cfg", "enabled", "yes", dir);
  assert.equal(w1.ok, true);
  assert.equal(w1.value, true, "toggle 类型收敛为布尔");
  const w2 = writePluginSetting("cfg", "greeting", 42, dir);
  assert.equal(w2.value, "42", "text 类型收敛为字符串");
  // 读回（只返回声明的 key，且带前缀存储）
  const r = readPluginSettings("cfg", dir);
  assert.equal(r.ok, true);
  assert.deepEqual(r.settings, { greeting: "42", enabled: true });
  const row = db.prepare("SELECT value FROM settings WHERE key='plg_cfg_greeting'").get();
  assert.ok(row, "设置带 plg_<id>_ 前缀存储");
  // 未知插件
  assert.equal(readPluginSettings("nope", dir).ok, false);
  rmSync(dir, { recursive: true, force: true });
});

test("installPlugin：未知 id / 非法 id / 目录穿越 拒绝", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "plginstall-"));
  const market = [{
    id: "evil", name: "evil", version: "1.0.0",
    files: [{ path: "../evil.js", url: "https://x/evil.js" }, { path: "manifest.json", url: "https://x/m.json" }],
  }];
  // 未知 id
  assert.equal((await installPlugin("ghost", { pluginsDir: dir, market, fetcher: async () => ({ ok: true, text: async () => "" }) })).ok, false);
  // 非法 id
  assert.equal((await installPlugin("Bad_ID!", { pluginsDir: dir, market, fetcher: async () => ({ ok: true, text: async () => "" }) })).ok, false);
  // 目录穿越：第一个文件 ../evil.js 即拒绝，且不落盘
  const r = await installPlugin("evil", { pluginsDir: dir, market, fetcher: async () => ({ ok: true, text: async () => "x" }) });
  assert.equal(r.ok, false);
  assert.match(r.error, /非法文件路径|路径越界/);
  assert.equal(existsSync(path.join(dir, "..", "evil.js")), false, "穿越文件未写入");
  assert.equal(existsSync(path.join(dir, "evil")), false, "目标目录未创建");
  rmSync(dir, { recursive: true, force: true });
});

test("installPlugin：正常安装（假 fetcher）→ 文件落盘 + manifest.id 校验", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "plginstall-"));
  const market = [{
    id: "hello", name: "Hello 插件", version: "2.0.0",
    files: [
      { path: "manifest.json", url: "https://x/manifest.json" },
      { path: "server.mjs", url: "https://x/server.mjs" },
    ],
  }];
  const contents = {
    "https://x/manifest.json": JSON.stringify({ id: "hello", name: "Hello 插件", version: "2.0.0", server: "server.mjs" }),
    "https://x/server.mjs": "export function register() {}",
  };
  const fetcher = async (url) => ({ ok: true, status: 200, text: async () => contents[url] });
  const r = await installPlugin("hello", { pluginsDir: dir, market, fetcher });
  assert.equal(r.ok, true);
  assert.equal(r.version, "2.0.0");
  assert.match(r.note, /重启后生效/);
  const manifest = JSON.parse(readFileSync(path.join(dir, "hello", "manifest.json"), "utf8"));
  assert.equal(manifest.id, "hello");
  assert.ok(existsSync(path.join(dir, "hello", "server.mjs")), "server 文件落盘");
  // manifest.id 与安装目标不一致 → 拒绝
  contents["https://x/manifest.json"] = JSON.stringify({ id: "other", name: "x", version: "1", server: "server.mjs" });
  const r2 = await installPlugin("hello", { pluginsDir: dir, market, fetcher });
  assert.equal(r2.ok, false);
  assert.match(r2.error, /不一致/);
  rmSync(dir, { recursive: true, force: true });
});

test("getPluginMarket：真实市场文件可读且条目结构合法", () => {
  const r = getPluginMarket();
  assert.equal(r.ok, true);
  assert.ok(Array.isArray(r.plugins));
  for (const p of r.plugins) {
    assert.match(p.id, /^[a-z0-9-]+$/, "市场 id 白名单格式");
    assert.ok(Array.isArray(p.files) && p.files.length >= 1, "条目带文件清单");
    for (const f of p.files) {
      assert.ok(!f.path.includes(".."), "市场文件路径无穿越");
      assert.match(f.url, /^https?:\/\//, "下载 URL 是 http(s)");
    }
  }
});
