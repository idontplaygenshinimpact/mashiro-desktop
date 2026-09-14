// IPC 声明一致性护栏（闭环清查）：preload 暴露的每个方法都必须在 kanban-api.d.ts 里声明
// 背景：checkJs 只能校验"已声明的实现是否匹配"，**声明漏写**永远不会被发现——
// 实测 preload 暴露 81 个键、声明只有 72 个（漏了 reviewFeedback/reviewRetry/ttsSynth/ttsPlayFile/
// stopSpeak/openReactPanel/openVuePanel 等后续新增能力），渲染层因此拿不到类型。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const preload = readFileSync(path.join(ROOT, "desktop", "preload.js"), "utf8");
const dts = readFileSync(path.join(ROOT, "desktop", "kanban-api.d.ts"), "utf8");

/** 取 contextBridge.exposeInMainWorld("kanban", { ... }) 里对象字面量的顶层键。
 *  该对象的顶层属性统一 2 空格缩进（嵌套对象/回调体更深），据此即可稳定取键，无需手写花括号配对。 */
function exposedKeys(src) {
  const start = src.indexOf('exposeInMainWorld("kanban"');
  assert.ok(start >= 0, "preload 应通过 contextBridge 暴露 kanban");
  const body = src.slice(start);
  return new Set([...body.matchAll(/^ {2}([A-Za-z_$][\w$]*)\s*[:(]/gm)].map((m) => m[1]));
}

function declaredKeys(src) {
  const i0 = src.indexOf("export interface KanbanApi");
  const seg = src.slice(i0, src.indexOf("\n}", i0));
  return new Set([...seg.matchAll(/^\s{2}([A-Za-z_$][\w$]*)\s*\??\s*[:(]/gm)].map((m) => m[1]));
}

test("preload 暴露的 IPC 方法全部在 kanban-api.d.ts 声明（防声明漂移）", () => {
  const exposed = exposedKeys(preload);
  const declared = declaredKeys(dts);
  assert.ok(exposed.size > 60, `暴露面解析合理（实得 ${exposed.size} 个键）`);
  const missing = [...exposed].filter((k) => !declared.has(k)).sort();
  assert.deepEqual(missing, [], `这些 IPC 暴露了但未声明（渲染层无类型 + checkJs 校验不到）：${missing.join(", ")}`);
});
