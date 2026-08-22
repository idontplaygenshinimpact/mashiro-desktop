// lib/recommend.mjs —— 今日推荐分类与轮转（纯函数，可单测）
// 背景：旧分类 `f.dir.includes("discover")` 把巡检产出的面经全归为笔试（实测 30/30 错分）；
//       轮转 pick 在目录只有 1 个文件时同一文件重复推荐（堆叠）

/**
 * 产出文件分类：笔试 vs 面经
 * 笔试：文件名含 笔试/笔试题/机试/bishi（真实笔试内容；"一面/二面/面经/分享" 都是面试面经）
 * 面经：其余全部（含 discover 目录——巡检爬的是面经，不是笔试）
 * @param {Array<{file: string, dir: string}>} files
 * @returns {{ bishi: Array, mianshi: Array }}
 */
export function classifyStudyFiles(files) {
  const bishi = files.filter((f) => /笔试|bishi|机试/.test(f.file || ""));
  const mianshi = files.filter((f) => !bishi.includes(f));
  return { bishi, mianshi };
}

/**
 * 从 seed 位置起轮转取 n 个**不重复**项（按 path 去重，防目录只有 1 个文件时堆叠）
 * @param {Array<{path?: string}>} arr
 * @param {number} n
 * @param {number} seed 当天日期数字（同一天内推荐稳定）
 * @returns {Array}
 */
export function pickDistinct(arr, n, seed) {
  if (!arr?.length || n <= 0) return [];
  const out = [];
  const seen = new Set();
  for (let i = 0; i < arr.length && out.length < n; i++) {
    const it = arr[(seed + i) % arr.length];
    const key = it?.path || it?.file || String(it);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}
