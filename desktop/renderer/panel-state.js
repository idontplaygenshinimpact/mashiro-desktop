// 原生面板状态收敛工单：模块级状态对象 + 事件总线（渲染层状态管理真空区补课）
// 背景：panel-study.js 的 sdGen/sdStreaming/ivRound/ivTimer 等全是全局 let 裸变量——
// 生命周期手动管理、所有路径手动复位（漏一条就出状态残留 bug）。
// 方案：不引入 Redux（薄 UI 过重）——模块级状态对象（按域组织）+ 轻量事件总线（跨模块通信）。
// 范式对比：原生模块单例（本文件）vs React useReducer（panel.jsx）vs Vue ref/computed（panel-vue-review）。
// 先加后改：本文件先落地，旧全局变量逐个域接入后删除（任务 2/3）。
// 注意：面板脚本是普通 <script>（非 module）——本文件挂 window.panelState 供各面板脚本解构使用。

(function (global) {
  // ---------- 轻量事件总线（任务 4：跨模块状态变化走事件，替代直接读全局变量） ----------
  // 与现有 mianshi:tabchange（panel-rest.js）等 CustomEvent 模式对齐——模块内用 emitter，DOM 事件仍走 CustomEvent
  const listeners = new Map(); // event → Set<fn>

  /** 订阅事件（返回取消函数） */
  function onPanelEvent(event, fn) {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(fn);
    return () => listeners.get(event)?.delete(fn);
  }
  /** 发布事件（同步调用所有订阅者；订阅者异常不影响其他订阅者） */
  function emitPanelEvent(event, payload) {
    const set = listeners.get(event);
    if (!set) return;
    for (const fn of [...set]) {
      try { fn(payload); } catch { /* 订阅者异常隔离 */ }
    }
  }

  // ---------- 状态对象（按域组织——结构对齐现有全局变量清单） ----------

  /** 讲解弹窗域（任务 2：sdGen/sdStreaming/sdGeneratingId/sdCurrentId 收敛） */
  const studyDetailState = {
    gen: 0,             // 讲解请求代际：切换条目/关闭弹层时递增，过期流式回调直接丢弃
    streaming: false,   // 流式生成中：遮罩点击不关闭（防误触关掉正在生成的讲解）
    generatingId: null, // 正在生成的条目 id（流式进行中）
    currentId: null,    // 当前弹层打开的条目 id
  };

  /** 面试域（任务 3：ivRound/ivRoundType/ivTimer/ivRoundStart/ivRoundSeconds/ivScoreSum/ivScoreCount 收敛） */
  const interviewState = {
    round: 0,           // 当前轮
    roundType: "",      // 当前轮类型（项目拷打/八股…）
    timer: null,        // 本题计时器
    roundStart: 0,      // 本题开始时间戳
    roundSeconds: 0,    // 本题已用秒
    scoreSum: { tech: 0, expr: 0, depth: 0, edge: 0, reflect: 0, total: 0 }, // 全场累计
    scoreCount: 0,      // 已评分轮数
  };

  /** 讲解弹窗域复位（任务 2：5 处路径收敛为 1 个函数——打开重置/流式置位/finally 复位/关闭复位/代际切换） */
  function resetStudyDetail() {
    studyDetailState.gen += 1;      // 代际递增：过期流式回调直接丢弃
    studyDetailState.streaming = false;
    studyDetailState.generatingId = null;
    studyDetailState.currentId = null;
    emitPanelEvent("studyDetail:reset", { gen: studyDetailState.gen });
  }

  /** 面试计时器生命周期集中管理（任务 3：start/stop/reset 一个函数） */
  function interviewTimer(action) {
    if (action === "stop") {
      if (interviewState.timer) { clearInterval(interviewState.timer); interviewState.timer = null; }
      return;
    }
    if (action === "reset") {
      if (interviewState.timer) { clearInterval(interviewState.timer); interviewState.timer = null; }
      interviewState.roundStart = 0;
      interviewState.roundSeconds = 0;
      return;
    }
    // start：重置计时并启动（回调每秒 +1）
    if (interviewState.timer) clearInterval(interviewState.timer);
    interviewState.roundStart = Date.now();
    interviewState.roundSeconds = 0;
    interviewState.timer = setInterval(() => {
      interviewState.roundSeconds += 1;
      emitPanelEvent("interview:tick", { seconds: interviewState.roundSeconds });
    }, 1000);
  }

  global.panelState = { studyDetailState, interviewState, resetStudyDetail, interviewTimer, onPanelEvent, emitPanelEvent };
})(typeof window !== "undefined" ? window : globalThis);
