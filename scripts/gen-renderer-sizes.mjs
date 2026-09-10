// 生成三态对比卡所需的"实测"包体积数据（前端三态并行展示工单任务 4：对比卡数据必须真实）
// 为什么要生成文件：panel-core.js 是普通 script（非模块），不能 import JSON；Electron file:// 下 fetch 本地 JSON 也不可靠。
// 所以构建/提交时用本脚本量一次 dist 产物 + 原生面板，落到 desktop/renderer/renderer-sizes.js（window.__RENDERER_SIZES）。
// 用法：node scripts/gen-renderer-sizes.mjs   （tests/renderer-sizes.test.mjs 会校验它与磁盘实测一致）
import { readFileSync, writeFileSync, statSync, readdirSync, existsSync } from "node:fs";
import { gzipSync } from "node:zlib";
import path from "node:path";

const ROOT = path.join(import.meta.dirname, "..");
const R = (p) => path.join(ROOT, p);
const OUT = R("desktop/renderer/renderer-sizes.js");

/** 单文件实测：原始字节 + gzip 压缩后字节（与浏览器传输量同口径） */
function measure(file) {
  if (!existsSync(file)) return null;
  const buf = readFileSync(file);
  return { bytes: buf.length, gzip: gzipSync(buf).length };
}

/** 目录内所有匹配文件求和（原生面板是多个 .js 直引，没有打包步骤） */
function measureDir(dir, filter) {
  let bytes = 0, gzip = 0, files = 0;
  for (const f of readdirSync(dir)) {
    if (!filter(f)) continue;
    const m = measure(path.join(dir, f));
    if (!m) continue;
    bytes += m.bytes; gzip += m.gzip; files++;
  }
  return { bytes, gzip, files };
}

const renderer = R("desktop/renderer");
const native = measureDir(renderer, (f) => f.startsWith("panel-") && f.endsWith(".js") && f !== "panel-react.bundle.js");
const react = measure(R("desktop/renderer/panel-react/dist/assets/react-panel.js"));
const vue = measure(R("desktop/renderer/panel-vue-review/dist/assets/vue-review.js"));

const data = {
  measuredAt: new Date().toISOString().slice(0, 10),
  unit: "KB（1KB = 1024 字节；gzip = zlib 压缩后大小，与浏览器传输量同口径）",
  native: { ...native, note: "panel-*.js 直引，无打包无依赖" },
  react: react ? { ...react, note: "Vite 构建的 react-panel.js（含 React 运行时）" } : null,
  vue: vue ? { ...vue, note: "Vite 构建的 vue-review.js（含 Vue 运行时）" } : null,
};

const js = `// 自动生成，请勿手改——node scripts/gen-renderer-sizes.mjs 重新实测
// 前端三态并行展示工单任务 4：三态对比卡的包体积数据（dist 产物实测 + gzip）
window.__RENDERER_SIZES = ${JSON.stringify(data, null, 2)};
`;
writeFileSync(OUT, js, "utf8");
const kb = (n) => (n / 1024).toFixed(1);
console.log(`[sizes] 原生 ${kb(data.native.bytes)}KB（gzip ${kb(data.native.gzip)}KB, ${data.native.files} 文件）`);
console.log(`[sizes] React ${react ? kb(react.bytes) + "KB（gzip " + kb(react.gzip) + "KB）" : "产物缺失（先 npm run build:react-panel）"}`);
console.log(`[sizes] Vue   ${vue ? kb(vue.bytes) + "KB（gzip " + kb(vue.gzip) + "KB）" : "产物缺失（先 npm run build:vue-review）"}`);
console.log(`[sizes] 已写入 ${path.relative(ROOT, OUT)}（${statSync(OUT).size} 字节）`);
