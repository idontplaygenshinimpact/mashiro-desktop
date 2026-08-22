// tests/recommend.test.mjs —— 今日推荐分类与轮转去重单测
// 背景：旧分类把 discover 目录（巡检面经）全归为笔试（实测 30/30 错分）；
//       轮转 pick 在目录只有 1 个文件时同一文件重复推荐（堆叠）
import test from "node:test";
import assert from "node:assert/strict";
import { classifyStudyFiles, pickDistinct } from "../lib/recommend.mjs";

test("classifyStudyFiles：笔试 vs 面经（discover 目录是面经不是笔试）", () => {
  const files = [
    { file: "01_快手_快手增长前端二面_牛客网.md", dir: "2026-08-21_discover" },
    { file: "02_字节_字节一面_牛客网.md", dir: "2026-08-21_discover" },
    { file: "03_阿里巴巴_阿里巴巴笔试 8 月 15 日笔试题与解.md", dir: "2026-08-20_discover" },
    { file: "04_笔试真题汇总.md", dir: "2026-08-01" },
    { file: "05_bishi_机试记录.md", dir: "2026-08-01" },
  ];
  const { bishi, mianshi } = classifyStudyFiles(files);
  assert.equal(bishi.length, 3, "含 笔试/bishi 关键词的是笔试（阿里巴巴笔试/笔试真题汇总/bishi_机试）");
  assert.ok(bishi.every((f) => f.file.includes("笔试") || f.file.includes("bishi")), "笔试项含关键词");
  assert.equal(mianshi.length, 2, "面经包含 discover 目录产物（一面/二面/面经）");
  assert.ok(mianshi.some((f) => f.file.includes("快手增长前端二面")), "二面归面经");
});

test("pickDistinct：正常取 n 项且按 seed 稳定", () => {
  const arr = [{ path: "a" }, { path: "b" }, { path: "c" }];
  const r = pickDistinct(arr, 2, 20260821);
  assert.equal(r.length, 2);
  const r2 = pickDistinct(arr, 2, 20260821);
  assert.equal(r2[0].path, r[0].path, "同一天轮转稳定");
});

test("pickDistinct：目录只有 1 个文件 → 不重复堆叠（最多 1 项）", () => {
  const arr = [{ path: "only.md" }];
  const r = pickDistinct(arr, 2, 20260821);
  assert.equal(r.length, 1, "防堆叠：同文件只推荐一次");
});

test("pickDistinct：空数组/0 项 → 空结果", () => {
  assert.deepEqual(pickDistinct([], 2, 1), []);
  assert.deepEqual(pickDistinct([{ path: "a" }], 0, 1), []);
});

test("pickDistinct：n 超过数组长度 → 返回全部不重复项", () => {
  const arr = [{ path: "a" }, { path: "a" }, { path: "b" }]; // 含重复 path
  const r = pickDistinct(arr, 10, 1);
  assert.equal(r.length, 2, "重复 path 去重");
});
