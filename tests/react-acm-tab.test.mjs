// React 版「专项练习」Tab 的 ACM 模式护栏（源码级，纯静态断言）。
// 断言五件事：① 存在「📐 核心代码 / 🖥️ ACM 模式」切换 chip，且列表请求带 mode 参数（mode=acm 时
// 后端才返回 ACM 题库）；② 列表项在 topic.mode==="acm" 时渲染 🖥️ACM 徽标；③ ACM 题展开时渲染可折叠
// 「📥 测试用例」面板（逐组 输入/期望输出，换行可见）；④ 判题失败时逐用例 diff（输入/期望/实际，换行 ⏎），
// 通过时不显示 diff；⑤ 不硬编码 8899。
// 附带反证基线：请求里必须有 `qs.set("mode", mode)` 这一"把模式写进查询串"的接线——反证时把它一行删掉
// （mode=acm 就发不出去了），本护栏中的参数基线测试与 chip 测试一起红；恢复后全绿（过程记录在最终回答）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const R = (p) => path.join(ROOT, p);
const REACT = "desktop/renderer/panel-react/src";

function src(p) {
  const f = R(path.join(REACT, p));
  assert.ok(existsSync(f), `文件存在：${p}`);
  return readFileSync(f, "utf8");
}
const code = src("tabs/Practice.jsx");

test("① 模式 chip 存在，且列表请求带 mode=acm 参数（两套题库各自成集）", () => {
  assert.ok(code.includes("📐 核心代码"), "含核心代码模式 chip 文案");
  assert.ok(code.includes("🖥️ ACM 模式"), "含 ACM 模式 chip 文案");
  // 请求参数接线：模式进入查询串（mode=core / mode=acm 走后端）
  assert.ok(/qs\.set\(\s*["']mode["'],\s*mode\s*\)/.test(code), "用 qs.set('mode', mode) 把当前模式写进列表请求");
  // 状态声明与切换入口：默认 core，存在 setMode 把模式改掉的动作
  assert.ok(/useState\(\s*["']core["']\s*\)\s*\/\/\s*判题模式/.test(code) || code.includes('useState("core")'), "默认判题模式为 core");
  assert.ok(/setMode\(/.test(code), "存在 setMode（模式切换入口）");
  assert.ok(/\[\s*cat\s*,\s*diff\s*,\s*mode\s*\]/.test(code), "useEffect 依赖含 mode（切模式触发重拉列表）");
});

test("② ACM 题在列表项里渲染 🖥️ACM 徽标", () => {
  assert.ok(/p\.mode\s*===\s*["']acm["']/.test(code), "按 topic.mode==='acm' 判断是否 ACM 题");
  assert.ok(code.includes("🖥️ACM"), "含 🖥️ACM 徽标文案");
  assert.ok(code.includes("秋招笔试卷子形态"), "徽标 title 交代 ACM 形态（自己读输入、自己输出）");
});

test("③ ACM 题展开时渲染可折叠「📥 测试用例」面板（逐组 输入/期望输出，换行可见）", () => {
  assert.ok(/detail\?\.mode\s*===\s*["']acm["']/.test(code), "按 detail.mode==='acm' 决定是否显示用例面板");
  assert.ok(code.includes("ioCases"), "用到 ioCases（ACM 题的用例数组）");
  assert.ok(code.includes("📥 测试用例"), "含可折叠用例面板标题");
  assert.ok(/whiteSpace:\s*["']pre-wrap["']/.test(code), "用 <pre> + pre-wrap 保留换行可见");
  assert.ok(code.includes("t.input") && code.includes("t.expected"), "逐组渲染 t.input / t.expected");
});

test("④ 判题失败时逐用例 diff（输入/期望/实际，换行 ⏎），通过时不显示", () => {
  // 判定 ACM：任一用例带 expected（服务端 ACM 分支字段）
  assert.ok(/t\.expected\s*!==\s*undefined/.test(code), "ACM 判定口径 = 用例带 expected");
  // 失败且为 ACM 才显示 diff
  assert.ok(/isAcm\s*&&\s*!t\.passed/.test(code), "仅失败用例显示 diff（通过时不显示）");
  // 三个字段逐点展示，换行用 ⏎（fmtNL 统一处理）
  assert.ok(code.includes("fmtNL"), "用 fmtNL 处理换行（⏎ 内联替换）");
  assert.ok(/输入：\{fmtNL\(t\.input\)\}/.test(code), "渲染 输入");
  assert.ok(/期望：\{fmtNL\(t\.expected\)\}/.test(code), "渲染 期望");
  assert.ok(/实际：\{fmtNL\(t\.actual\)\}/.test(code), "渲染 实际");
});

test("反证基线：mode=acm 请求参数接线真实存在（删掉则本条与 ① 一起红）", () => {
  // `qs.set("mode", mode)` 是 ACM 参数的发源：删掉它，即使 chip 还在，mode=acm 也发不出去。
  // 用完整的 `qs.set("mode", mode)` 字面量正则（含引号收尾）而不只是裸 includes，避免
  // 反证时改成"前缀相同但语义已坏"（如 qs.set('category', mode)）仍被 includes 命中造成护栏假绿。
  assert.ok(/qs\.set\(\s*["']mode["'],\s*mode\s*\)/.test(code), "qs.set('mode', mode) 真实存在");
});

test("⑤ 不硬编码端口（复用统一 api client）", () => {
  assert.ok(code.includes('from "../api.js"'), "数据入口走统一 api client");
  assert.ok(!code.includes("8899"), "不硬编码 8899");
});
