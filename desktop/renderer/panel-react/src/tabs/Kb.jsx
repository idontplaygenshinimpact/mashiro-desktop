// React 版本地知识库（前端三态并行展示工单任务 2 · S1 数据展示型 Tab）
// 同一数据源 /api/knowledge/*（与原 panel-rest.js 的 loadKbStats/kbSearch 同接口）。
// ⚛️ React 特性：useDeferredValue——输入框即时响应，检索与结果渲染走延后值（长列表不卡输入）；
//   命中片段高亮用派生渲染（原生版是 innerHTML 拼串 + esc）。
import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { api } from "../api.js";

const KIND_LABEL = { mianjing: "📄 面经", jiaocheng: "📘 教程", job: "🏢 岗位", doc: "📚 文档", note: "📝 学习", followup: "💬 追问" };

const S = {
  wrap: { display: "flex", flexDirection: "column", gap: 10, fontSize: 13, color: "#e8e6f5" },
  card: { background: "#241f3a", border: "1px solid #4a4568", borderRadius: 10, padding: 12 },
  head: { display: "flex", alignItems: "center", gap: 8, marginBottom: 8 },
  title: { fontSize: 13, fontWeight: 700 },
  muted: { fontSize: 11, color: "#a8a3c8" },
  input: { flex: 1, minWidth: 180, background: "#241f3a", color: "#e8e6f5", border: "1px solid #3a3558", borderRadius: 6, padding: "8px 10px", fontSize: 13, outline: "none" },
  hit: { background: "#1f1a31", border: "1px solid #4a4568", borderRadius: 8, padding: 10, marginTop: 6 },
  hitHead: { display: "flex", alignItems: "center", gap: 6, fontSize: 12, marginBottom: 4 },
  badge: { background: "#2a2540", border: "1px solid #4a4568", borderRadius: 4, padding: "1px 6px", fontSize: 10, color: "#8fc7ff" },
  body: { fontSize: 12, lineHeight: 1.7, color: "#e8e6f5", whiteSpace: "pre-wrap" },
};

/** 命中片段高亮（React 派生渲染——不拼 HTML 字符串，天然免 XSS） */
function Highlight({ text, terms }) {
  const parts = useMemo(() => {
    const q = (terms || []).filter((t) => t.length >= 2);
    if (!q.length) return [text];
    const re = new RegExp(`(${q.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "gi");
    return String(text || "").split(re);
  }, [text, terms]);
  const set = useMemo(() => new Set((terms || []).map((t) => t.toLowerCase())), [terms]);
  return (
    <span style={S.body}>
      {parts.map((p, i) =>
        set.has(String(p).toLowerCase())
          ? <mark key={i} style={{ background: "rgba(143,199,255,.35)", color: "#e8e6f5", borderRadius: 2 }}>{p}</mark>
          : <span key={i}>{p}</span>
      )}
    </span>
  );
}

export function KbPanel() {
  const [q, setQ] = useState("");
  const deferredQ = useDeferredValue(q); // ⚛️ React 特性：输入不等待检索
  const [hits, setHits] = useState([]);
  const [stats, setStats] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [disabled, setDisabled] = useState(false);
  const [searched, setSearched] = useState(false);

  // 库状态（挂载拉一次）
  useEffect(() => {
    api("/api/knowledge/stats")
      .then((j) => setStats(j || null))
      .catch((e) => setErr(String(e?.message || e).slice(0, 80)));
  }, []);

  // 检索：随延后值触发（输入连续变化时中间态可被跳过）
  useEffect(() => {
    const query = deferredQ.trim();
    if (query.length < 2) { setHits([]); setSearched(false); return; }
    let alive = true;
    setBusy(true);
    setErr("");
    api("/api/knowledge/paragraphs/search", { method: "POST", body: { query, topK: 8 } })
      .then((j) => {
        if (!alive) return;
        setDisabled(!!j?.disabled);
        setHits(j?.hits || []);
        setSearched(true);
      })
      .catch((e) => { if (alive) { setErr("检索失败：" + String(e?.message || e).slice(0, 80)); setHits([]); } })
      .finally(() => { if (alive) setBusy(false); });
    return () => { alive = false; }; // 卸载/换词后丢弃过期响应（防结果错位）
  }, [deferredQ]);

  const terms = useMemo(() => deferredQ.trim().split(/\s+/).filter(Boolean), [deferredQ]);
  const pending = q !== deferredQ;
  const fu = hits.filter((h) => h.kind === "followup").length;
  const kinds = (stats?.byKind || []).map((k) => `${KIND_LABEL[k.kind] || k.kind} ${k.n}`).join(" · ");

  return (
    <div style={S.wrap}>
      <div style={S.card}>
        <div style={S.head}>
          <span style={S.title}>🧠 本地知识库 · React 版</span>
          {(busy || pending) && <span style={S.muted}>🔍 检索中…</span>}
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <input
            style={S.input}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜索：事件循环 / React Hooks / 防抖节流 / 某公司面经..."
          />
          <button style={{ ...S.badge, cursor: "pointer", padding: "6px 12px" }} onClick={() => setQ("")}>清空</button>
        </div>
        <div style={{ ...S.muted, marginTop: 6 }}>
          {stats
            ? `📦 ${stats.total ?? 0} 条${kinds ? `（${kinds}）` : ""}${stats.enabled === false ? " · 未启用（设置可开）" : " · 段落级混合检索"}`
            : "⏳ 读取库状态…"}
        </div>
        {err && <div style={{ ...S.muted, color: "#e8c04a", marginTop: 6 }}>⚠️ {err}</div>}
      </div>

      <div style={S.card}>
        {disabled ? (
          <div style={S.muted}>📭 知识库未启用——到「⚙️ 设置」开启后可搜索</div>
        ) : hits.length === 0 ? (
          <div style={S.muted}>
            {searched ? "没有命中——换个说法试试（段落级检索：先切段再召回）" : "输入 ≥2 个字开始检索（结果按段落召回，追问段优先）"}
          </div>
        ) : (
          <>
            <div style={S.muted}>
              命中 {hits.length} 段（{stats?.docs ?? 0} 篇文档 · {stats?.followups ?? 0} 段追问）{fu ? ` · 追问段 ${fu} 段优先` : ""}
            </div>
            {hits.map((h, i) => (
              <div key={`${h.docId}-${i}`} style={S.hit}>
                <div style={S.hitHead}>
                  <span style={S.badge}>{h.kind === "followup" ? "💬 追问" : "📝 讲解"}</span>
                  <b>{h.docId}{h.section ? ` · ${h.section}` : ""}</b>
                </div>
                <Highlight text={h.content?.slice(0, 220)} terms={terms} />
              </div>
            ))}
          </>
        )}
      </div>

      <div style={S.muted}>⚛️ React 特性：useDeferredValue 延后检索（输入即时；结果用派生渲染高亮，不拼 HTML 串）</div>
    </div>
  );
}
