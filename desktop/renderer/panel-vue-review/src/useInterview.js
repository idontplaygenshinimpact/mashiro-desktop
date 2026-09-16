// Vue 版面试状态机（composable 组织：会话/评分/复盘集中一处，组件只做渲染）
// 同一 IPC 桥（invStart/invAnswer/invEnd/invStatus/interviewHistory——业务层 lib/interview*.mjs 零改动）
import { computed, reactive, ref, onUnmounted } from "vue";
import { api } from "./api.js"; // 与 Dashboard/Jobs/Kb 等 Vue 版 Tab 同一渲染层统一 client（api-client 单一来源基址）

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

  // —— 语音作答：录音状态机（未录音/录音中/转写中 + 停止/取消），与 React 版 panel.jsx 同一 IPC 契约 ——
  // 三态补齐工单第 ⑨ 种样子货：Vue 面试此前没有语音作答（React 有）。这里不另造协议，
  // 照抄 React 版：AudioWorklet 16k 单声道采集 → window.kanban.speechToText(Float32Array) → 回填作答区。
  const micState = ref("idle");   // "idle" | "recording" | "transcribing"
  const micErr = ref("");          // 空转写/权限拒绝/调用失败都写这里，交给模板可见提示，绝不静默
  const micRef = ref(null);        // 录音资源句柄：{stream, ctx, src, node, samples}，卸载/取消时统一释放

  // 语音入口：未录音→开始；录音中→停止并转写；转写中→忽略（防止转写任务并发叠加，跟 React 的 recording 互斥同理）
  async function toggleMic() {
    if (micState.value === "transcribing") return;
    if (micState.value === "recording") { await stopAndTranscribe(); return; }
    await startMic();
  }

  // 开始录音：user 手势（点击）里异步拉起麦克风，必须用 AudioWorklet 而非废弃的 ScriptProcessor
  async function startMic() {
    micErr.value = "";
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, sampleRate: 16000 } });
      const ctx = new AudioContext({ sampleRate: 16000 });
      // 浏览器自动暂停策略：非用户手势起的 AudioContext 会 suspended，必须 resume 才出音频（同 React 版处理）
      if (ctx.state === "suspended") await ctx.resume();
      // worklet 模块路径：同窗内嵌（panel.html）→ panel-vue-review/dist/；独立窗口 → 当前目录
      const base = window.location.href.includes("panel.html") ? "./panel-vue-review/dist/" : "./";
      await ctx.audioWorklet.addModule(base + "mic-worklet.js");
      const src = ctx.createMediaStreamSource(stream);
      const node = new AudioWorkletNode(ctx, "mashiro-mic");
      const samples = [];
      node.port.onmessage = (e) => samples.push(Float32Array.from(e.data));
      src.connect(node);
      micRef.value = { stream, ctx, src, node, samples };
      micState.value = "recording";
    } catch (e) {
      // 权限拒绝（NotAllowedError）或设备不可用：明确提示可排查原因，而不是假装成功
      micState.value = "idle";
      micErr.value = "麦克风不可用：" + String(e?.message || e).slice(0, 60);
    }
  }

  // 停止并转写：先释放麦克风资源再送 ASR，避免持续占着 mic 通道；返回后总是回到 idle
  async function stopAndTranscribe() {
    const rec = micRef.value;
    if (!rec) return;
    const { stream, ctx, src, node, samples } = rec;
    src.disconnect(); node.disconnect();
    stream.getTracks().forEach((t) => t.stop());
    await ctx.close().catch(() => {});
    micRef.value = null;
    micState.value = "transcribing";
    try {
      // 太短的片段 ASR 只会出噪声/空串——本地先拦截，给用户可见的重说提示（同 React 版 8000 采样阈值）
      const total = samples.reduce((n, a) => n + a.length, 0);
      if (total < 8000) { micErr.value = "语音太短，请再说一次"; return; }
      const audio = new Float32Array(total);
      let off = 0;
      for (const a of samples) { audio.set(a, off); off += a.length; }
      const r = await window.kanban.speechToText(audio);
      if (r?.ok && r.text) {
        // 转写结果追加/回填到回答区：已有内容时用换行分隔，保留作答（同 React 版拼接行为）
        answer.value = answer.value ? answer.value + "\n" + r.text : r.text;
      } else {
        // 后端拒绝（r.ok 空/error）或空结果：明确报错，不许静默失败
        micErr.value = r?.error || "识别失败，请重试";
      }
    } catch (e) {
      micErr.value = "识别调用失败：" + String(e?.message || e).slice(0, 60);
    } finally {
      micState.value = "idle";
    }
  }

  // 取消录音：放弃已采样本（不送 ASR），只释放资源回到 idle
  function cancelMic() {
    const rec = micRef.value;
    if (!rec) return;
    try { rec.src.disconnect(); rec.node.disconnect(); } catch { /* 资源可能已断开 */ }
    rec.stream.getTracks().forEach((t) => t.stop());
    rec.ctx.close().catch(() => {});
    micRef.value = null;
    micState.value = "idle";
    micErr.value = "";
  }

  // 卸载清理：组件卸载（切 Tab/关面板）时若还在录音，必须掐断麦克风流，否则 mic 灯会一直亮、资源泄漏
  onUnmounted(() => {
    const rec = micRef.value;
    if (rec) {
      try { rec.src.disconnect(); rec.node.disconnect(); } catch { /* 忽略 */ }
      rec.stream.getTracks().forEach((t) => t.stop());
      rec.ctx.close().catch(() => {});
      micRef.value = null;
    }
    micState.value = "idle";
  });

  const scoreRows = computed(() => [
    ["技术深度", st.scores.tech], ["表达清晰", st.scores.expr], ["追问深度", st.scores.depth],
    ["边界意识", st.scores.edge], ["反思能力", st.scores.reflect],
  ]);

  // 历史复盘删除（三态共用同一 HTTP 路由 /api/interview/history/delete，与原生/React 不各自造）
  // confirm 二次确认（window.prompt 在 Electron 渲染层抛异常，禁用）；按真实结果反馈
  // 经统一 api client（api.js → api-client 解析基址，不硬编码端口）；api() 对 404 等非 2xx 抛带 status 的 Error → catch 如实提示
  async function delHistory(rec) {
    const id = rec?.id;
    if (!id) return;
    if (!window.confirm(`确定删除这场复盘「${String(rec?.position || "模拟面试")}」吗？不可恢复。`)) return;
    try {
      const j = await api("/api/interview/history/delete", { method: "POST", body: { id } });
      if (j?.ok) {
        history.value = history.value.filter((h) => String(h?.id) !== String(id));
        window.kanban?.notify?.("🗑 历史复盘", "已删除该场复盘");
      } else {
        window.kanban?.notify?.("🗑 历史复盘", j?.error || "删除失败");
      }
    } catch (e) {
      // 404（不存在）/ 400（缺参）/ 500（异常）都如实反馈，不假装成功
      window.kanban?.notify?.("🗑 历史复盘", "删除异常: " + String(e?.message || e).slice(0, 60));
    }
  }

  return { st, config, history, resumable, err, answer, micState, micErr, ROLES, start, resume, submit, finish, loadMeta, toggleMic, cancelMic, scoreRows, delHistory };
}
