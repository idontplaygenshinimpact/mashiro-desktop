// 批量实测 opencode-go 便宜模型是否支持图片输入
import { readFileSync } from "node:fs";

const KEY = "sk-UW7xGKLNAaPD0LQYS79x7ZhbjiJW3YKAftEl7koIzkJQIFxR8XiqwgH9JdZf0xJy";
const BASE = "https://opencode.ai/zen/go/v1";
const img = readFileSync("data/panel-shot.png").toString("base64");
const dataUrl = `data:image/png;base64,${img}`;
const models = ["kimi-k3", "kimi-k2.6", "hy3", "glm-5.2", "glm-5.1", "mimo-v2.5-pro", "minimax-m3", "qwen3.7-plus"];

for (const model of models) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 45000);
    const r = await fetch(`${BASE}/chat/completions`, {
      method: "POST",
      signal: ctrl.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
      body: JSON.stringify({
        model,
        max_tokens: 200,
        messages: [
          { role: "user", content: [
            { type: "image_url", image_url: { url: dataUrl } },
            { type: "text", text: "一句话描述这张截图" },
          ]},
        ],
      }),
    });
    clearTimeout(t);
    const j = await r.json();
    if (r.ok) {
      const text = j.choices?.[0]?.message?.content || "";
      console.log(`✅ ${model}: 支持 → ${String(text).slice(0, 60)}`);
    } else {
      console.log(`❌ ${model}: HTTP ${r.status} ${String(j?.error?.message || JSON.stringify(j)).slice(0, 90)}`);
    }
  } catch (e) {
    console.log(`❌ ${model}: ${e.message.slice(0, 80)}`);
  }
}
