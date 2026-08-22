// tests/output-import.test.mjs —— 手动导入面经落盘单测（临时目录隔离）
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { saveImportedPost } from "../lib/output-import.mjs";

function tempOutput() {
  const dir = mkdtempSync(path.join(tmpdir(), "import-out-"));
  return dir;
}

test("正常导入：日期目录 + NN_标题_来源.md + 内容完整", () => {
  const out = tempOutput();
  const r = saveImportedPost({ title: "字节前端一面面经", content: "事件循环、防抖节流、手写 Promise……", source: "https://www.nowcoder.com/discuss/123" }, out);
  assert.equal(r.ok, true);
  assert.ok(r.file.includes(new Date().toISOString().slice(0, 10)), "日期目录");
  assert.match(r.file, /01_字节前端一面面经_www\.nowcoder\.com\.md$/, "文件名 NN_标题_来源");
  const full = path.join(out, r.file);
  const text = readFileSync(full, "utf8");
  assert.ok(text.startsWith("# 字节前端一面面经"), "标题行");
  assert.ok(text.includes("> 来源: https://www.nowcoder.com"), "来源引用");
  assert.ok(text.includes("事件循环"), "正文完整");
  rmSync(out, { recursive: true, force: true });
});

test("无来源 → 标记手动导入；多条导入序号递增", () => {
  const out = tempOutput();
  saveImportedPost({ title: "第一条", content: "内容一内容一内容一内容一内容一内容一内容一内容一内容一内容一", }, out);
  const r2 = saveImportedPost({ title: "第二条", content: "内容二内容二内容二内容二内容二内容二内容二内容二内容二内容二" }, out);
  assert.equal(r2.ok, true);
  assert.match(r2.file, /02_/, "序号递增到 02");
  const text = readFileSync(path.join(out, r2.file), "utf8");
  assert.ok(text.includes("> 来源: 手动导入"), "无来源标记手动导入");
  rmSync(out, { recursive: true, force: true });
});

test("标题/内容为空 → 报错；内容过短 → 报错", () => {
  const out = tempOutput();
  const r1 = saveImportedPost({ title: "", content: "xxxx" }, out);
  assert.equal(r1.ok, false);
  assert.match(r1.error, /标题和内容/);
  const r2 = saveImportedPost({ title: "题", content: "太短了" }, out);
  assert.equal(r2.ok, false);
  assert.match(r2.error, /太短/);
  rmSync(out, { recursive: true, force: true });
});

test("标题含非法字符 → 文件名安全化（不崩不落非法文件）", () => {
  const out = tempOutput();
  const r = saveImportedPost({ title: 'A/B:C*D?E"F<G>H|I', content: "内容内容内容内容内容内容内容内容内容内容内容内容内容内容内容内容" }, out);
  assert.equal(r.ok, true);
  // file 是 path.relative 结果：Windows 用 \ 分隔、Linux 用 /——按 path.sep 取 basename 后断言文件名无非法字符
  const base = path.basename(r.file);
  assert.ok(!/[\\/:*?"<>|]/.test(base), "文件名无非法字符");
  assert.ok(!base.includes("A/B:C*D?E\"F<G>H|I"), "原始非法标题未直接用作文件名");
  rmSync(out, { recursive: true, force: true });
});
