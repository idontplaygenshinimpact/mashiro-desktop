// UI 视觉复核工具：把截图逐张交给视觉模型看，输出"一句话描述 + 缺陷清单"（紧凑，便于批量审 27 格）。
// 背景（2026-09-16）：jsdom 不排版、只看 DOM 断言发现不了"编辑器被压成窄条""输入框太矮"这类问题——
// 靠真 Chromium 截图 + 视觉模型才看出来（本轮据此修掉面试手写轮 CM 宽 39px 的塌陷）。
// 视觉路由：走 OpenRouter（key 取 DSH 凭据库 OPENROUTER_API_KEY）。本机 ollama 中转虽然 /api/show
// 声明 vision，但实测两种请求形状图都到不了模型；DeepSeek 官方 API 也没有 vision-exp 这个 id。
// 用法：node scripts/ui-vision-review.mjs [目录] [模型] [并发]
import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const DIR = path.resolve(process.argv[2] || "output/ui-all");
const MODEL = process.argv[3] || "inclusionai/ling-3.0-flash-vl:free";
const CONC = Math.max(1, Math.min(4, Number(process.argv[4]) || 3));
const Q = [
  "这是一个桌面应用界面截图。请用中文按以下格式简洁回答，不要展开：",
  "描述：<一句话说明这一屏是什么、主要内容是否渲染出来了>",
  "缺陷：<逐条列出视觉问题：文字截断/元素重叠/布局塌陷或某区域异常窄/对比度过低看不清/内容缺失或空白过大；每条不超过 20 字；没有问题就写「无」>",
].join("\n");

const cred = readFileSync(path.join(homedir(), ".dsh", ".credentials.yaml"), "utf8");
const key = (cred.match(/OPENROUTER_API_KEY:\s*"?([^"\r\n]+)"?/) || [])[1]?.trim();
if (!key) { console.error("凭据库里没有 OPENROUTER_API_KEY"); process.exit(1); }

const files = readdirSync(DIR).filter((f) => /\.png$/i.test(f)).sort();
if (!files.length) { console.error(`目录里没有 PNG：${DIR}`); process.exit(1); }

async function review(file, attempt = 1) {
  const b64 = readFileSync(path.join(DIR, file)).toString("base64");
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: [{ type: "text", text: Q }, { type: "image_url", image_url: { url: `data:image/png;base64,${b64}` } }] }] }),
  });
  const t = await res.text();
  if (!res.ok) {
    if (attempt < 3 && (res.status === 429 || res.status >= 500)) { await new Promise((r) => setTimeout(r, 4000 * attempt)); return review(file, attempt + 1); }
    return `HTTP ${res.status}: ${t.slice(0, 160)}`;
  }
  try { return JSON.parse(t)?.choices?.[0]?.message?.content || "(空响应)"; } catch { return t.slice(0, 200); }
}

console.log(`视觉复核 ${files.length} 张（模型 ${MODEL}，并发 ${CONC}）\n`);
let i = 0;
const results = [];
await Promise.all(Array.from({ length: CONC }, async () => {
  while (i < files.length) {
    const file = files[i++];
    const out = await review(file);
    results.push({ file, out });
    console.log(`=== ${file} ===\n${out.trim()}\n`);
  }
}));
console.log(`\n合计 ${results.length} 张；失败 ${results.filter((r) => /^HTTP /.test(r.out)).length} 张`);