// React 版「专项练习」（手写/算法题库 + CodeMirror 6 判题编辑器）
// 前端三态 CodeMirror 6 升级工单：原生 panel（practice-editor.ts 已改）→ 本文件（React 侧）。
// 数据源复用同一后端 HTTP 路由（api.js → api-client 解析基址，不硬编码端口）：
//   /api/challenges（列表，分类/难度走后端，done/搜索前端过滤）→ /api/challenges/detail（题干+骨架）
//   → /api/challenges/run（判题）→ /api/challenges/mark-done / mark-wrong（闭环回流）。
// ⚛️ React 特性：useRef 持有 CodeMirror EditorView（useEffect 创建 + 卸载 destroy，切 tab 不泄漏 DOM），
//   useMemo 派生筛选结果（状态驱动差量渲染，替代原生 innerHTML 全量重建）。
import { useEffect, useMemo, useRef, useState } from "react";
import { EditorView, keymap } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { basicSetup } from "codemirror";
import { javascript } from "@codemirror/lang-javascript";
import { oneDark } from "@codemirror/theme-one-dark";
import { indentWithTab } from "@codemirror/commands";
import { api } from "../api.js";

const DIFF_LABEL = {
  1: ["简单", "#2f7a4a"],
  2: ["中等", "#9a5b00"],
  3: ["困难", "#b91c1c"],
};
// 频率热度用 🔥 星标（与原生 panel-rest.js 同口径：最多 3 个）
const freqStars = (n) => "🔥".repeat(Math.max(0, Math.min(3, Number(n) || 0)));
// 筛选 chip 样式（panel.css 无 .oj-cat-chip 定义——仿原生 activeChip 内联：激活=紫色渐变，非激活=半透明描边）
const chipStyle = (active) => (active
  ? { background: "linear-gradient(135deg,#8a5adc,#6d4fd8)", color: "#fff", borderRadius: 6, padding: "4px 10px", border: "none", cursor: "pointer", fontSize: 12 }
  : { background: "rgba(109,79,216,.08)", color: "#5d48b8", border: "1px solid rgba(109,79,216,.25)", borderRadius: 6, padding: "4px 10px", cursor: "pointer", fontSize: 12 });

/** 判题结果展示（逐条断言 + 耗时 + console + tip + reflow 回流） */
function ResultView({ result }) {
  if (!result) return null;
  const pass = !!(result.ok && result.success);
  const tests = result.tests || [];
  const logs = result.logs || [];
  const rf = result.reflow || {};
  return (
    <div className="rf-card" style={{ borderColor: pass ? "rgba(58,141,90,.35)" : "rgba(185,28,28,.35)" }}>
      <div style={{ fontWeight: 700, color: pass ? "#2f7a4a" : "#b91c1c" }}>
        {pass ? "🎉 全部通过 ✅" : "❌ 有测试未通过"}
        <span style={{ fontWeight: 400, color: "#5a5678", fontSize: 12 }}> ⏱ {result.durationMs || 0} ms · {tests.length} 个测试</span>
      </div>
      {/* 逐条断言：✅/❌ + label（失败必须如实可见，不乐观假成功） */}
      {tests.map((t, i) => (
        <div key={i} style={{ fontSize: 12, lineHeight: 1.6, color: t.passed ? "#2f7a4a" : "#b91c1c" }}>
          {t.passed ? "✅" : "❌"} {t.label}
        </div>
      ))}
      {result.error && <div style={{ fontSize: 12, color: "#b91c1c", marginTop: 4 }}>⚠️ {result.error}</div>}
      {logs.length > 0 && (
        <div style={{ marginTop: 6 }}>
          <div style={{ fontSize: 11, color: "#5a5678" }}>— console 输出 —</div>
          <pre style={{ margin: 4, fontSize: 11, lineHeight: 1.5, whiteSpace: "pre-wrap", wordBreak: "break-all", color: "#8a5adc" }}>{logs.join("\n")}</pre>
        </div>
      )}
      {result.tip && <div style={{ fontSize: 12, color: "#9a5b00", marginTop: 4 }}>💡 {result.tip}</div>}
      {/* reflow：服务端判题已自动回流，面板如实显示去向；回流失败也要报 */}
      {rf.error && <div style={{ fontSize: 12, color: "#b91c1c", marginTop: 4 }}>⚠️ 回流失败：{String(rf.error).slice(0, 80)}</div>}
      {rf.done && <div style={{ fontSize: 12, color: "#2f7a4a", marginTop: 4 }}>♻️ 已自动标记完成（题库进度 + 学习进度回流）</div>}
      {rf.wrong && <div style={{ fontSize: 12, color: "#9a5b00", marginTop: 4 }}>♻️ 已记入错题 + 复习卡（wrong_count + 薄弱点回流，到期会提醒复习）</div>}
    </div>
  );
}

/** 展开的单题判题区：CodeMirror 6 编辑器 + 判题 + 标记完成/记错题 */
function ChallengeEditor({ challenge, onChanged, onNotify }) {
  const [detail, setDetail] = useState(null);
  const [busy, setBusy] = useState(false);
  const [marking, setMarking] = useState(false);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [result, setResult] = useState(null);
  // useRef 持有 CodeMirror 实例（不放进 state，避免无关渲染重建；卸载走 cleanup destroy）
  const hostRef = useRef(null);
  const viewRef = useRef(null);

  // 加载题干（含 skeleton/testCode）
  useEffect(() => {
    let alive = true;
    api(`/api/challenges/detail?id=${encodeURIComponent(challenge.id)}`)
      .then((j) => { if (alive && j?.ok) setDetail(j.detail); })
      .catch((e) => { if (alive) setErr("加载题干失败：" + String(e?.message || e).slice(0, 80)); })
      .finally(() => {});
    return () => { alive = false; };
  }, [challenge.id]);

  // CodeMirror 6 编辑器：挂载（拿到骨架）时 new EditorView，卸载/切 tab 时 destroy()
  useEffect(() => {
    if (!detail?.skeleton || !hostRef.current) return;
    let view = null;
    try {
      view = new EditorView({
        parent: hostRef.current,
        state: EditorState.create({
          doc: detail.skeleton,
          extensions: [
            basicSetup,        // 行号/历史/折叠/括号匹配/自动补全/搜索 一次到位
            javascript(),      // JS 语法高亮（题库是 JS 判题）
            oneDark,           // 深色主题（与判题结果区同色系）
            keymap.of([indentWithTab]), // Tab 缩进（默认 Tab 会跳焦）
            // Ctrl/Cmd+Enter → 运行判题（与原生 practice-editor.ts 一致）
            keymap.of([{ key: "Mod-Enter", preventDefault: true, run: () => { runJudgement(); return true; } }]),
            EditorView.theme({
              "&": { fontSize: "12px", height: "160px", border: "1px solid rgba(109,79,216,.3)", borderRadius: "6px", background: "#1e1e2e" },
              ".cm-scroller": { fontFamily: 'Consolas, Menlo, monospace', lineHeight: "1.55", overflow: "auto" },
              ".cm-content": { caretColor: "#c7a6ff" },
              "&.cm-focused": { outline: "none", borderColor: "rgba(109,79,216,.55)" },
            }),
          ],
        }),
      });
      viewRef.current = view;
    } catch (e) {
      // CodeMirror 在部分环境（如 jsdom 无布局测量）可能失败——如实报，不让编辑器卡死面板
      setErr("编辑器初始化失败：" + String(e?.message || e).slice(0, 80));
    }
    return () => {
      // 卸载清理：destroy() EditorView，防切 tab 泄漏原生 DOM/事件
      if (view) { view.destroy(); viewRef.current = null; }
    };
  }, [detail?.id]);

  // ▶ 运行判题：逐条断言如实渲染（结果区见 ResultView）
  async function runJudgement() {
    const code = viewRef.current?.state.doc.toString() || "";
    if (!code.trim()) { setErr("⚠️ 先写代码再判题"); return; }
    setBusy(true); setErr(""); setMsg("");
    try {
      const j = await api("/api/challenges/run", { method: "POST", body: { id: challenge.id, userCode: code } });
      // 失败必须如实可见：j.success 为 false 也渲染（不依赖 HTTP 是否 200）
      setResult(j);
      if (j?.success && j?.reflow?.error) setMsg("判题通过，但回流失败：" + String(j.reflow.error).slice(0, 60));
    } catch (e) {
      setErr("判题异常：" + String(e?.message || e).slice(0, 80));
    } finally {
      setBusy(false);
    }
  }

  // 标记完成 / 记错题：返回 ok:false（或抛 HTTP 错误）时如实提示，不假装成功
  async function doMark(ep, okText) {
    setMarking(true); setErr("");
    try {
      const j = await api(ep, { method: "POST", body: { id: challenge.id } });
      if (j?.ok) {
        onNotify?.(j.title || challenge.title, okText);
        onChanged(); // 刷新列表（done/wrongCount 徽标）
        setMsg(`${j.message || okText}`);
      } else {
        setErr(String(j?.error || "操作失败").slice(0, 80));
      }
    } catch (e) {
      // api-client 对非 2xx 抛带 status 的 Error——mark-done/mark-wrong 失败（404 ok:false）落这里
      setErr(String(e?.message || e).slice(0, 80));
    } finally {
      setMarking(false);
    }
  }

  const [dl] = DIFF_LABEL[detail?.difficulty] || ["难度" + (detail?.difficulty || "?"), "#5a5678"];
  const catLabel = detail?.category === "handwrite" ? "手写" : "算法";

  return (
    <div className="rf-card">
      <div className="rf-muted" style={{ fontWeight: 700, color: "#5d48b8" }}>
        📖 {detail?.title || challenge.title}
        <span className="rf-muted" style={{ fontWeight: 400 }}> [{catLabel} · {dl} · 建议 {detail?.timeLimit || 10} 分钟内]</span>
      </div>
      <pre className="rf-report" style={{ whiteSpace: "pre-wrap", marginTop: 4 }}>{detail?.description || "（本题暂无题干说明）"}</pre>
      {err && <div className="rf-muted rf-chip-warn">⚠️ {err}</div>}
      <div ref={hostRef} />
      <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap", alignItems: "center" }}>
        <button type="button" className="rf-btn rf-btn-primary" disabled={busy || marking} onClick={runJudgement}>
          {busy ? "⏳ 判题中…" : "▶ 运行判题"}
        </button>
        {/* 标记完成/记错题：经同一路由 + 如实反馈 ok:false / 错误体 */}
        <button type="button" className="rf-btn" disabled={marking || busy || !result?.success}
          title={result?.success ? "所有测试通过，标记完成（计入学习进度）" : "需先判题且全部通过"} onClick={() => doMark("/api/challenges/mark-done", "已标记完成，进度 +1")}>
          ✅ 全部通过，标记完成
        </button>
        <button type="button" className="rf-btn" disabled={marking || busy} title="做错了，记入薄弱点 + 复习卡" onClick={() => doMark("/api/challenges/mark-wrong", "已记入薄弱点，复习阶段优先补")}>
          ❌ 不会
        </button>
        {msg && <span className="rf-muted" style={{ fontSize: 12 }}>{msg}</span>}
        <span className="rf-muted" style={{ fontSize: 11 }}>⌨️ Ctrl/Cmd + Enter 运行判题</span>
      </div>
      <ResultView result={result} />
    </div>
  );
}

export function PracticePanel() {
  const [list, setList] = useState([]);
  const [stats, setStats] = useState({ total: 0, done: 0 });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [cat, setCat] = useState("");        // ""全部 / handwrite / algorithm（走后端）
  const [diff, setDiff] = useState(0);       // 0全部 / 1/2/3（走后端）
  const [done, setDone] = useState(0);       // 0全部 / 1未做 / 2已做（前端过滤）
  const [search, setSearch] = useState(""); // 搜索（前端过滤：标题/描述/ID）
  const [expandedId, setExpandedId] = useState(null);

  // 拉题库列表（分类/难度走后端过滤；done/搜索前端过滤）
  async function load() {
    setBusy(true); setErr("");
    try {
      const qs = new URLSearchParams();
      if (cat) qs.set("category", cat);
      if (diff) qs.set("difficulty", String(diff));
      const j = await api("/api/challenges?" + qs.toString());
      if (j?.ok === false) { setErr(String(j?.error || "题库加载失败").slice(0, 80)); return; }
      setList(j.list || []);
      setStats({ total: j.total ?? 0, done: j.done ?? 0 });
    } catch (e) {
      setErr("题库加载异常：" + String(e?.message || e).slice(0, 80));
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => { load(); }, [cat, diff]);

  // 派生筛选（useMemo：done 态 + 关键词，状态驱动差量过滤）
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    let arr = list.filter((p) =>
      (!done || (done === 1 ? !p.done : p.done)) &&
      (!q || `${p.title}\n${p.description || ""}\n${p.id}`.toLowerCase().includes(q))
    );
    // 排序同原生：未做在前 → 频率降序 → 难度升序
    arr = [...arr].sort((a, b) => (Number(a.done) - Number(b.done)) || (Number(b.frequency) - Number(a.frequency)) || (Number(a.difficulty) - Number(b.difficulty)));
    return arr;
  }, [list, done, search]);

  const pct = stats.total ? Math.round((stats.done / stats.total) * 100) : 0;

  return (
    <div className="rf-stack">
      <div className="rf-card">
        <div className="rf-head">
          <span className="rf-title">✍️ 专项练习 · React 版</span>
          <button className="rf-btn" onClick={load} disabled={busy}>{busy ? "刷新中…" : "🔄 刷新"}</button>
        </div>
        <div className="rf-muted">
          📦 共 {stats.total} 道 · 已完成 {stats.done}（{pct}%）· 本地沙箱判题，无需登录
        </div>

        {/* 工具栏：搜索 + 完成状态 + 分类 + 难度（搜索/done 前端过滤，cat/diff 走后端） */}
        <div className="rf-toolbar" style={{ flexWrap: "wrap", gap: 6, marginTop: 8 }}>
          <input className="rf-input" placeholder="🔍 搜索标题/描述/ID…" value={search}
            aria-label="搜索题目" onChange={(e) => setSearch(e.target.value)} style={{ maxWidth: 200 }} />
          {[
            [0, "📋 全部"], [1, "🆕 未做"], [2, "✅ 已做"],
          ].map(([v, lbl]) => (
            <button key={v} type="button" style={chipStyle(done === v)}
              onClick={() => setDone(v)}>{lbl}</button>
          ))}
          <span style={{ width: 1, height: 14, background: "rgba(109,79,216,.18)", alignSelf: "center" }} />
          {[
            ["", "全部"], ["handwrite", "✍️ 手写"], ["algorithm", "🧮 算法"],
          ].map(([v, lbl]) => (
            <button key={v || "all"} type="button" style={chipStyle(cat === v)}
              onClick={() => { setCat(v); setExpandedId(null); }}>{lbl}</button>
          ))}
          {[
            [0, "全部"], [1, "简单"], [2, "中等"], [3, "困难"],
          ].map(([v, lbl]) => (
            <button key={v} type="button" style={chipStyle(diff === v)}
              onClick={() => { setDiff(v); setExpandedId(null); }}>{lbl}</button>
          ))}
        </div>
        {(search || done) && (
          <div className="rf-muted" style={{ fontSize: 11, marginTop: 6 }}>命中 {filtered.length} / {list.length}</div>
        )}
      </div>

      {err && <div className="rf-card"><div className="rf-muted rf-chip-warn">⚠️ {err}</div></div>}

      {filtered.length === 0 ? (
        <div className="rf-card rf-muted">📭 当前筛选下没有题目（可换分类/难度或清掉搜索）</div>
      ) : (
        filtered.map((p) => {
          const [dl, dc] = DIFF_LABEL[p.difficulty] || ["难度" + p.difficulty, "#5a5678"];
          const expanded = expandedId === p.id;
          return (
            <div key={p.id} className="rf-card">
              <div
                role="button" tabIndex={0} aria-label={`展开 ${p.title}`} title="点击展开/收起题干与编辑器"
                onClick={() => setExpandedId(expanded ? null : p.id)}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setExpandedId(expanded ? null : p.id); } }}
                style={{ cursor: "pointer", display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}
              >
                <span className="job-badge" style={{ background: p.category === "handwrite" ? "rgba(58,141,90,.12)" : "rgba(109,79,216,.12)", color: p.category === "handwrite" ? "#2f7d4e" : "#5d48b8" }}>
                  {p.category === "handwrite" ? "✍️手写" : "🧮算法"}
                </span>
                <span style={{ color: dc, fontSize: 11 }}>{dl}</span>
                <span title="面试出现频率" style={{ fontSize: 11 }}>{freqStars(p.frequency)}</span>
                <b style={{ fontSize: 12 }}>{p.title}</b>
                {p.done && <span style={{ color: "#2f7a4a", fontSize: 11 }}>✅ 已做</span>}
                {p.wrongCount > 0 && <span style={{ color: "#b91c1c", fontSize: 11 }}>答错 {p.wrongCount} 次</span>}
              </div>
              {expanded && (
                <ChallengeEditor challenge={p} onChanged={() => { setExpandedId(null); load(); }}
                  onNotify={(title, txt) => {
                    try { window.kanban.notify?.("✍️ 手写题", `「${title}」${txt}`); } catch { /* 通知失败不影响主流程 */ }
                  }} />
              )}
            </div>
          );
        })
      )}

      <div className="rf-muted">⚛️ React 特性：useRef 持有 CodeMirror 6 编辑器（useEffect 创建 / 卸载 destroy）+ useMemo 派生筛选</div>
    </div>
  );
}
