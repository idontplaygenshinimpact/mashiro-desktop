// 轻量 Markdown 渲染（React 版复盘报告用；对齐原生 renderMd 的核心子集）
// 安全性：先 esc 全部 HTML 再转格式标记——链接 href 二次净化（防属性逃逸）

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function inlineMd(s) {
  const escaped = esc(s);
  const cleanHref = (u) => u.replace(/&quot;|&#34;|&#x22;|&#39;|&apos;|&lt;|&gt;|&#60;|&#62;/gi, "").slice(0, 2048);
  return escaped
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_m, t, u) => `<a href="${cleanHref(u)}" target="_blank" rel="noopener">${t}</a>`);
}

/** Markdown → HTML 字符串（dangerouslySetInnerHTML 用） */
export function renderMarkdown(md) {
  const lines = String(md || "").split(/\r?\n/);
  let html = "";
  let inCode = false;
  let codeBuf = [];
  const flushCode = () => {
    if (!codeBuf.length) return;
    html += `<pre><code>${esc(codeBuf.join("\n"))}</code></pre>`;
    codeBuf = [];
  };
  for (const raw of lines) {
    const t = raw.trim();
    if (t.startsWith("```")) {
      if (inCode) { inCode = false; flushCode(); } else { flushCode(); inCode = true; }
      continue;
    }
    if (inCode) { codeBuf.push(raw); continue; }
    if (!t) { html += "<div style='height:8px'></div>"; continue; }
    const h = t.match(/^(#{1,4})\s+(.*)$/);
    if (h) { html += `<h${Math.min(h[1].length + 2, 5)}>${inlineMd(h[2])}</h${Math.min(h[1].length + 2, 5)}>`; continue; }
    if (/^[-*•]\s/.test(t)) { html += `<div style="padding-left:14px">• ${inlineMd(t.replace(/^[-*•]\s/, ""))}</div>`; continue; }
    if (/^\d+\.\s/.test(t)) { html += `<div style="padding-left:14px">${inlineMd(t)}</div>`; continue; }
    html += `<p>${inlineMd(t)}</p>`;
  }
  flushCode();
  return html;
}
