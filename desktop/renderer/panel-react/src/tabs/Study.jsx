// React 版学习清单（前端三态并行展示工单任务 2 · S2①：列表 + 勾选 + 状态流分组 + 搜索过滤）
// 同一 IPC 桥（window.kanban.studyPlan/studyCheck/studyGenerate——业务层 lib/study-plan.mjs 零改动）。
// ⚛️ React 特性：useDeferredValue 搜索过滤（长清单输入不卡顿）+ useMemo 状态流分组派生
//   （原生版每次 loadStudyPlan 重建整块 innerHTML，React 版按状态差量更新）。
// 讲解入口复用原生讲解弹窗（showStudyDetail 在同一 preload/业务层之上，流式+追问+抽屉不重复实现）：
// 需要时切回原生渲染层再打开——功能等价，不做第二套流式 UI。
import { useDeferredValue, useEffect, useMemo, useState } from "react";

const card = { background: "#241f3a", border: "1px solid #4a4568", borderRadius: 10, padding: 12 };
const muted = { fontSize: 11, color: "#a8a3c8" };
const btn = { background: "#2a2540", color: "#e8e6f5", border: "1px solid #4a4568", borderRadius: 6, padding: "5px 10px", cursor: "pointer", fontSize: 12 };
const btnPrimary = { background: "#8fc7ff", color: "#171322", border: "none", borderRadius: 6, padding: "5px 12px", cursor: "pointer", fontSize: 12, fontWeight: 700 };
const input = { background: "#241f3a", color: "#e8e6f5", border: "1px solid #3a3558", borderRadius: 6, padding: "7px 10px", fontSize: 12, outline: "none" };
const select = { ...input, padding: "6px 8px" };
const row = { display: "flex", alignItems: "flex-start", gap: 8, background: "#1f1a31", border: "1px solid #4a4568", borderRadius: 8, padding: "8px 10px", marginTop: 6 };
const chip = { background: "#2a2540", border: "1px solid #4a4568", borderRadius: 4, padding: "1px 6px", fontSize: 10, color: "#8fc7ff", whiteSpace: "nowrap" };

/** 清单状态流（与原生 loadStudyPlan 的 stateOf 同口径）：待复习 > 已掌握 > 已学 > 学习中 > 待学习 */
function stateOf(it) {
  if (it.reviewDue) return "review";
  if (it.done && it.mastered) return "mastered";
  if (it.done) return "learned";
  if (it.hasFile) return "learning";
  return "todo";
}
const STATE_LABELS = [
  { key: "todo", label: "📥 待学习" },
  { key: "learning", label: "📖 学习中" },
  { key: "learned", label: "✅ 已学（讲解过）" },
  { key: "review", label: "🔁 待复习（复习卡到期）" },
  { key: "mastered", label: "🏆 已掌握" },
];

export function StudyPanel() {
  const [plan, setPlan] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [q, setQ] = useState("");
  const deferredQ = useDeferredValue(q); // ⚛️ React 特性：输入不等待过滤
  const [lv, setLv] = useState("");
  const [st, setSt] = useState("");
  const [showMastered, setShowMastered] = useState(false);

  async function load() {
    try {
      const r = await window.kanban.studyPlan();
      if (r?.ok) setPlan(r.plan || { date: "", items: [] });
      else setErr("清单读取失败——后端未就绪");
    } catch (e) {
      setErr("清单读取异常：" + String(e?.message || e).slice(0, 80));
    }
  }
  useEffect(() => { load(); }, []);

  async function generate() {
    setBusy(true);
    setErr("");
    try {
      const r = await window.kanban.studyGenerate();
      if (r?.ok === false) setErr("生成失败：" + String(r.error || r.hint || "未知原因").slice(0, 80));
      else if (r?.addedCount === 0 && r?.note) setErr(r.note); // 无新知识点是正常情况，如实提示
      await load();
    } catch (e) {
      setErr("生成异常：" + String(e?.message || e).slice(0, 80));
    } finally {
      setBusy(false);
    }
  }

  /** 勾选/取消：同一 IPC（studyCheck）→ 薄弱点清除时给正反馈（与原生同款 toast 语义） */
  async function toggle(it, checked) {
    try {
      const r = await window.kanban.studyCheck(it.id, checked);
      if (r?.ok === false) { setErr("勾选失败：" + String(r.error || "").slice(0, 60)); return; }
      if (r?.clearedWeak) window.kanban?.notify?.("✨ 薄弱点消灭", `「${r.clearedWeak}」已消灭（清单勾选回流）`);
      await load();
    } catch (e) {
      setErr("勾选异常：" + String(e?.message || e).slice(0, 80));
    }
  }

  /** 讲解：切回原生渲染层 + 打开原生讲解弹窗（流式/追问/抽屉复用同一实现，不做第二套） */
  function explain(id) {
    try {
      window.switchRenderer?.("study", "native");
      window.showStudyDetail?.(id);
    } catch (e) {
      window.kanban?.notify?.("🎨 渲染层", "打开讲解失败：" + String(e?.message || e).slice(0, 60));
    }
  }

  const items = plan?.items || [];
  const doneN = items.filter((i) => i.done).length;
  const pct = items.length ? Math.round((doneN / items.length) * 100) : 0;

  // ⚛️ React 特性：过滤 + 分组都是派生值（依赖 deferredQ/lv/st/items——无关状态变化不重算）
  const { groups, matched } = useMemo(() => {
    const query = deferredQ.trim().toLowerCase();
    const pass = (it) => {
      if (lv && it.level !== lv) return false;
      if (st && stateOf(it) !== st) return false;
      if (query && !`${it.topic || ""} ${it.why || ""}`.toLowerCase().includes(query)) return false;
      return true;
    };
    const filtered = items.filter(pass);
    const g = { todo: [], learning: [], learned: [], review: [], mastered: [] };
    for (const it of filtered) g[stateOf(it)].push(it);
    return { groups: g, matched: filtered.length };
  }, [items, deferredQ, lv, st]);

  const filtering = Boolean(q.trim() || lv || st);
  // 主状态流不含"已掌握"——已掌握是折叠区（与原生同款：独立的 doneToggle 行，控制项不能被自己折叠掉）
  const mainStates = STATE_LABELS.filter((s) => s.key !== "mastered");
  const mastered = groups.mastered || [];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, fontSize: 13, color: "#e8e6f5" }}>
      <div style={card}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 8 }}>
          <b style={{ fontSize: 13 }}>📋 学习清单 · React 版</b>
          <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
            {plan?.date && <span style={muted}>{plan.date}</span>}
            <button style={btnPrimary} onClick={generate} disabled={busy}>{busy ? "生成中…" : "✨ 从产出生成清单"}</button>
          </span>
        </div>
        {/* 进度（总进度，不受筛选影响——与原生同口径） */}
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={muted}>📋 学习进度</span>
          <span style={{ flex: 1, height: 6, background: "#1f1a31", borderRadius: 3, overflow: "hidden" }}>
            <i style={{ display: "block", height: "100%", width: `${pct}%`, background: "#8fc7ff", borderRadius: 3 }} />
          </span>
          <b style={{ fontSize: 11 }}>{doneN}/{items.length}（{pct}%）</b>
        </div>
        {/* 搜索 + 筛选（useDeferredValue：输入即时，过滤延后） */}
        <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
          <input
            style={{ ...input, flex: 1, minWidth: 160 }}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜索知识点 / 学习理由…"
          />
          <select style={select} value={lv} onChange={(e) => setLv(e.target.value)}>
            <option value="">全部级别</option>
            <option value="必会">必会</option>
            <option value="进阶">进阶</option>
            <option value="拓展">拓展</option>
          </select>
          <select style={select} value={st} onChange={(e) => setSt(e.target.value)}>
            <option value="">全部状态</option>
            {STATE_LABELS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
          </select>
          {filtering && <span style={muted}>匹配 {matched}/{items.length}</span>}
        </div>
        {err && <div style={{ ...muted, color: "#e8c04a", marginTop: 6 }}>⚠️ {err}</div>}
      </div>

      {items.length === 0 ? (
        <div style={{ ...card, ...muted }}>未生成，点「✨ 从产出生成清单」</div>
      ) : (
        mainStates.map((s) => {
          const list = groups[s.key] || [];
          if (!list.length) return null;
          return (
            <div key={s.key} style={card}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                <b style={{ fontSize: 12 }}>{s.label}</b>
                <span style={chip}>{list.length}</span>
              </div>
              {list.map((it) => (
                <div key={it.id} style={row}>
                  <input
                    type="checkbox"
                    checked={!!it.done}
                    onChange={(e) => toggle(it, e.target.checked)}
                    title={it.done ? "取消勾选（同时删除自动建的复习卡）" : "勾选完成（学习进度回流 + 自动建复习卡）"}
                    style={{ marginTop: 2 }}
                  />
                  <span style={{ flex: 1 }}>
                    <span style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                      <b style={{ fontSize: 12, textDecoration: it.done ? "line-through" : "none", opacity: it.done ? 0.75 : 1 }}>{it.topic}</b>
                      {it.level && <span style={chip}>{it.level}</span>}
                      {it.grp && <span style={{ ...chip, color: "#a8a3c8" }}>{it.grp}</span>}
                      {it.fromInterview && <span style={{ ...chip, color: "#e8c04a" }}>面试</span>}
                      {it.reviewDue && <span style={{ ...chip, color: "#3a8a5a" }}>待复习</span>}
                    </span>
                    {it.why && <div style={{ ...muted, marginTop: 3 }}>{it.why}</div>}
                  </span>
                  <button style={btn} onClick={() => explain(it.id)} title="打开讲解（复用原生弹窗：流式 + 追问）">💡 讲解</button>
                </div>
              ))}
            </div>
          );
        })
      )}

      {/* 已掌握折叠区：控制行独立于被折叠内容（否则按钮在折叠块里 → 永远点不开） */}
      {mastered.length > 0 && (
        <div style={card}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <b style={{ fontSize: 12 }}>🏆 已掌握</b>
            <span style={chip}>{mastered.length}</span>
            <button style={{ ...btn, padding: "1px 8px" }} onClick={() => setShowMastered((v) => !v)}>
              {showMastered ? "收起" : "展开"}
            </button>
          </div>
          {showMastered && mastered.map((it) => (
            <div key={it.id} style={row}>
              <input type="checkbox" checked readOnly title="已达成（取消勾选可退回学习中）" style={{ marginTop: 2 }} />
              <span style={{ flex: 1 }}>
                <span style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                  <b style={{ fontSize: 12 }}>{it.topic}</b>
                  {it.level && <span style={chip}>{it.level}</span>}
                  {it.grp && <span style={{ ...chip, color: "#a8a3c8" }}>{it.grp}</span>}
                </span>
                {it.why && <div style={{ ...muted, marginTop: 3 }}>{it.why}</div>}
              </span>
              <button style={btn} onClick={() => explain(it.id)}>💡 讲解</button>
            </div>
          ))}
        </div>
      )}

      <div style={muted}>
        ⚛️ React 特性：useDeferredValue 搜索过滤 + useMemo 状态流分组（状态驱动差量更新）；讲解/追问复用同一实现
      </div>
    </div>
  );
}
