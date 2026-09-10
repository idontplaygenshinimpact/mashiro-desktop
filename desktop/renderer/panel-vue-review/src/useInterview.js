// Vue 版面试状态机（composable 组织：会话/评分/复盘集中一处，组件只做渲染）
// 同一 IPC 桥（invStart/invAnswer/invEnd/invStatus/interviewHistory——业务层 lib/interview*.mjs 零改动）
import { computed, reactive, ref } from "vue";

export const ROLES = ["技术深挖型", "温和引导型", "压力追问型"];

export function useInterview() {
  const st = reactive({ phase: "setup", busy: false, session: null, scores: { tech: 0, expr: 0, depth: 0, edge: 0, reflect: 0, total: 0, rounds: 0 }, report: null, hint: "" });
  const config = reactive({ position: "前端实习生", role: ROLES[0], focus: "", resume: "" });
  const history = ref([]);
  const resumable = ref(null);
  const err = ref("");
  const answer = ref("");

  const avgOf = (r) => Math.round(((r.tech || 0) + (r.expr || 0) + (r.depth || 0) + (r.edge || 0) + (r.reflect || 0)) / 5);

  async function loadMeta() {
    try {
      const h = await window.kanban.interviewHistory();
      history.value = (h?.history || []).slice().reverse();
    } catch { /* 历史加载失败不阻塞 */ }
    try {
      const r = await window.kanban.invStatus();
      if (r?.ok && r.active) resumable.value = r;
    } catch { /* ignore */ }
  }

  function enterActive(r) {
    st.phase = "active"; st.report = null; st.hint = "";
    st.session = { round: r.round, roundType: r.roundType, question: r.question, dimension: r.dimension, basis: r.basis, criteria: r.criteria, boundary: r.boundary, depth: r.depth, totalRounds: r.totalRounds };
    st.scores = { tech: 0, expr: 0, depth: 0, edge: 0, reflect: 0, total: 0, rounds: 0 };
  }

  async function start() {
    st.busy = true; err.value = "";
    try {
      const r = await window.kanban.invStart({ ...config });
      if (r?.error) { err.value = "启动失败：" + String(r.error).slice(0, 80); return; }
      enterActive(r);
      resumable.value = null;
    } catch (e) { err.value = "启动异常：" + String(e?.message || e).slice(0, 80); }
    finally { st.busy = false; }
  }

  async function resume() {
    if (!resumable.value) return;
    st.busy = true;
    try {
      const r = await window.kanban.invResume?.();
      enterActive(r?.session ? { ...resumable.value, ...r.session } : resumable.value);
    } catch (e) { err.value = "恢复失败：" + String(e?.message || e).slice(0, 80); }
    finally { st.busy = false; }
  }

  async function submit() {
    const text = answer.value.trim();
    if (!text || st.busy) return;
    st.busy = true; err.value = "";
    try {
      const r = await window.kanban.invAnswer(text);
      if (r?.scores) {
        const n = st.scores.rounds + 1;
        const merged = {};
        for (const k of ["tech", "expr", "depth", "edge", "reflect"]) merged[k] = Math.round(((st.scores[k] || 0) * st.scores.rounds + (r.scores[k] || 0)) / n);
        merged.total = avgOf(merged); merged.rounds = n;
        st.scores = merged;
      }
      answer.value = "";
      if (r?.finished) await finish();
      else if (r?.question) st.session = { ...st.session, ...r, round: r.round ?? st.session.round + 1 };
    } catch (e) { err.value = "提交异常：" + String(e?.message || e).slice(0, 80); }
    finally { st.busy = false; }
  }

  async function finish() {
    try {
      const r = await window.kanban.invEnd();
      st.report = r?.report || "（无复盘内容）";
      st.hint = r?.hint || "";
      st.phase = "finished";
      await loadMeta();
    } catch (e) { err.value = "复盘生成失败：" + String(e?.message || e).slice(0, 80); }
  }

  const scoreRows = computed(() => [
    ["技术深度", st.scores.tech], ["表达清晰", st.scores.expr], ["追问深度", st.scores.depth],
    ["边界意识", st.scores.edge], ["反思能力", st.scores.reflect],
  ]);

  return { st, config, history, resumable, err, answer, ROLES, start, resume, submit, finish, loadMeta, scoreRows };
}
