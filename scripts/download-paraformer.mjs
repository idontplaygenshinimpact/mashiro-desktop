// scripts/download-paraformer.mjs —— 下载 sherpa-onnx paraformer-zh 离线 ASR 模型
// 用法: node scripts/download-paraformer.mjs
// 模型: csukuangfj/sherpa-onnx-paraformer-zh-2023-09-14（中文 SOTA 级，int8 量化 ~230MB）
// 来源: hf-mirror.com（国内镜像）；如直连失败，设 HTTPS_PROXY 后重跑（curl 原生读代理 env）
// 输出: models/sherpa-onnx-paraformer-zh/{model.int8.onnx,tokens.txt}
import { mkdir, stat } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, "models", "sherpa-onnx-paraformer-zh");
const MIRROR = process.env.HF_ENDPOINT || "https://hf-mirror.com";
const BASE = `${MIRROR}/csukuangfj/sherpa-onnx-paraformer-zh-2023-09-14/resolve/main`;

const FILES = [
  { name: "model.int8.onnx", desc: "模型权重（int8 量化，~230MB）" },
  { name: "tokens.txt", desc: "词表（很小）" },
];

// 用 curl 下载：Windows 自带 curl.exe，且原生读取 HTTPS_PROXY/HTTP_PROXY 环境变量
function download(url, dest) {
  execFileSync("curl.exe", ["-L", "--fail", "--retry", "3", "--connect-timeout", "15", "-o", dest, url], { stdio: "inherit" });
}

await mkdir(OUT_DIR, { recursive: true });
for (const f of FILES) {
  const dest = path.join(OUT_DIR, f.name);
  try {
    const st = await stat(dest);
    if (st.size > 0) { console.log(`✓ 已存在 ${f.name} (${(st.size / 1048576).toFixed(1)}MB)，跳过`); continue; }
  } catch { /* 不存在则下载 */ }
  console.log(`↓ ${f.desc} ${f.name}`);
  await download(`${BASE}/${f.name}`, dest);
}
console.log(`✅ 完成: ${OUT_DIR}`);
