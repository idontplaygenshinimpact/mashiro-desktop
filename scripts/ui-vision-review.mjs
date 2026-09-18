// UI 视觉复核工具：把 output/ui-practice/*.png 逐张交给视觉模型看，输出问题清单。
// 背景（2026-09-16）：jsdom 不排版、只看 DOM 断言发现不了"编辑器被压成窄条""输入框太矮"这类问题——
// 靠真 Chromium 截图 + 视觉模型才看出来（本轮据此修掉面试手写轮 CM 宽 39px 的塌陷）。
// 视觉路由：默认走 OpenRouter（key 取 DSH 凭据库 OPENROUTER_API_KEY；本机 ollama 中转虽然声明 vision
// 但实测图到不了模型，DeepSeek 官方 API 也没有 vision-exp 这个 id）。
// 用法：node scripts/ui-vision-review.mjs [目录] [模型]
//   node scripts/ui-vision-review.mjs                       # 复核 output/ui-practice 全部截图
//   node scripts/ui-vision-review.mjs output/ui-practice inclusionai/ling-3.0-flash-vl:free
import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const DIR = path.resolve(process.argv[2] || "output/ui-practice");
const MODEL = process.argv[3] || "inclusionai/ling-3.0-flash-vl:free";
const Q = "这是一个应用界面截图。请回答：①画面上有哪些文字（按钮/标签/标题，原样列出）；②有无视觉缺陷：文字截断、元素重叠、布局塌陷（某区域被压得很窄或高度异常）、低对比度看不清、内容缺失。若某项没有就说没有，不要猜。";

const cred = readFileSync(path.join(homedir(), ".dsh", ".credentials.yaml"), "utf8");
const key = (cred.match(/OPENROUTER_API_KEY:\s*"?([^"\r\n]+)"?/) || [])[1]?.trim();
if (!key) { console.error("凭据库里没有 OPENROUTER_API_KEY"); process.exit(1); }

const files = readdirSync(DIR).filter((f) => /\.png$/i.test(f)).sort();
if (!files.length) { console.error(`目录里没有 PNG：${DIR}`); process.exit(1); }
console.log(`视觉复核 ${files.length} 张（模型 ${MODEL}）\n`);
for (const f of files) {
  const b64 = readFileSync(path.join(DIR, f)).toString("base64");
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: [{ type: "text", text: Q }, { type: "image_url", image_url: { url: `data:image/png;base64,${b64}` } }] }] }),
  });
  const t = await res.text();
  if (!res.ok) { console.log(`\n=== ${f} ===\nHTTP ${res.status}: ${t.slice(0, 200)}`); continue; }
  const j = JSON.parse(t);
  console.log(`\n=== ${f} ===\n${j?.choices?.[0]?.message?.content || "(空响应)"}`);
}