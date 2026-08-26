// 自主决策层（Phase 事件驱动内核 W3 §5）—— 规则决策，LLM 仅精炼
// 遵循 loop.mjs 原则："决策用规则、LLM 只提炼"（快、省、可测、可讲）。
// 三级模式（env + 设置中心可配）：off | notify（默认，只播报外部事件）| full（可 LLM 精炼文案）
// 刹车（与引擎一起交付）：防抖 5s / 寂静期 60s / 每日表达预算 / LLM 精炼日上限 / 审计 decision_ledger
import { enqueueExpression } from "./events.mjs";
import { recordDecision } from "./trace.mjs";

const DEBOUNCE_MS = 5000;   // 同 source 同 type 5s 合并（jsonl 连续写入不刷屏）
const QUIET_MS = 60000;     // 上次表达后 60s 寂静期（不主动打扰）
const TTL_MS = 60000;       // 表达队列 TTL
const MODE = process.env.MIANSHI_AUTONOMY || "notify";
const BUDGET_DAILY = Math.max(1, Number(process.env.MIANSHI_AUTONOMY_BUDGET) || 20);
const REFINE_DAILY = 10;    // LLM 精炼每日次数上限（full 级）

const fmtMin = (sec) => (sec >= 60 ? `${Math.round(sec / 60)} 分钟` : `${sec} 秒`);

/**
 * 规则表（纯函数可测）：事件 → 候选表达（null=不表达）
 * 输出契约：{ text, scene, level: "bubble"|"bubble+voice", ttl }
 */
export function ruleFor(ev) {
  switch (ev?.type) {
    case "cc:session_started":
      return { text: "🎬 Claude Code 开跑了", scene: "agent-start", level: "bubble" };
    case "cc:tool_use":
      return null; // 工具调用静默（防打扰）
    case "cc:assistant_reply":
      return { text: "📝 CC 出结果了，去看看", scene: "agent-reply", level: "bubble" };
    case "cc:session_finished": {
      const sec = Number(ev.payload?.durationSec) || 0;
      const tools = Number(ev.payload?.toolCount) || 0;
      return { text: `✅ CC 完成（${fmtMin(sec)}${tools ? `，用了 ${tools} 个工具` : ""}）`, scene: "agent-done", level: "bubble" };
    }
    case "chat_done":
      return null; // 本地对话保持现状（不走表达队列）
    case "schedule_due":
      return null; // 现有提醒逻辑已播报，防重复
    default:
      return null;
  }
}

/** LLM 精炼（仅 full 级；失败降级模板——不允许 LLM 失败阻塞播报） */
async function refineText(template, ev) {
  try {
    const { llmChat, getReplyText } = await import("./llm.mjs");
    const data = await llmChat([
      { role: "system", content: "你是桌宠真白。把下面的事件信息精炼成一句简短人话（20 字内，俏皮但不过度卖萌），直接输出文本。" },
      { role: "user", content: `事件：${ev.type}（来源 ${ev.source}）\n模板：${template}` },
    ], { maxTokens: 120, temperature: 0.7, tag: "refine" });
    const t = getReplyText(data).trim().slice(0, 40);
    return t || template;
  } catch { return template; }
}

/**
 * 创建自主决策器
 * @param {{ emit?: (e: {text: string, scene: string, level: string, ttl: number}) => void,
 *   log?: (msg: string) => void, mode?: string, budgetDaily?: number, now?: () => number,
 *   refine?: (template: string, ev: object) => Promise<string> }} [opts]
 */
export function createAutonomy({
  emit = (e) => enqueueExpression(/** @type {any} */ (e)),
  log = console.log,
  mode = MODE,
  budgetDaily = BUDGET_DAILY,
  now = () => Date.now(),
  refine = refineText,
} = {}) {
  if (mode === "off") {
    return {
      handle: () => null,
      state: () => ({ mode: "off" }),
    };
  }
  let expressed = 0;
  let dayKey = "";
  let refined = 0;
  let refineDay = "";
  let lastExprAt = 0;
  /** @type {Map<string, number>} */
  const lastByKey = new Map();

  function rollDay() {
    const k = new Date(now()).toISOString().slice(0, 10);
    if (k !== dayKey) { dayKey = k; expressed = 0; }
    if (k !== refineDay) { refineDay = k; refined = 0; }
  }

  /**
   * 处理一条总线事件：规则 → 刹车（防抖/寂静/预算）→ 表达入队 + 审计
   * @param {object} ev {type, source, ts, payload}
   * @returns {Promise<object|null>} 产出的表达（未表达返回 null）
   */
  async function handle(ev) {
    rollDay();
    const candidate = ruleFor(ev);
    if (!candidate) return null;
    // 防抖：同 source 同 type 5s 合并（仅当有历史记录；无记录不误判——修复：`|| 0` 兜底
    // 会让小时间戳（如测试注入的 1970 基准）被误判为"5s 内"）
    const key = `${ev.source}|${ev.type}`;
    const t = now();
    const last = lastByKey.get(key);
    if (last !== undefined && t - last < DEBOUNCE_MS) return null;
    lastByKey.set(key, t);
    // 寂静期（上次表达 60s 内不打扰）
    if (lastExprAt > 0 && t - lastExprAt < QUIET_MS) return null;
    // 预算
    if (expressed >= budgetDaily) {
      log(`[autonomy] 今日表达预算 ${budgetDaily} 已耗尽，事件 ${ev.type} 静默`);
      return null;
    }
    // full 级：可选 LLM 精炼（日上限内）；注入的 refine 抛错也必须降级模板（不允许阻塞播报）
    let text = candidate.text;
    if (mode === "full" && refined < REFINE_DAILY) {
      refined++;
      try {
        text = await refine(candidate.text, ev);
      } catch { /* 精炼失败降级模板 */ }
    }
    expressed++;
    lastExprAt = now();
    emit({ text, scene: candidate.scene, level: candidate.level, ttl: TTL_MS });
    // 审计：谁在什么时候说了什么（decision_ledger，metadata-only）
    // decision 用合法枚举（表 CHECK 约束：allow/deny/auto_allow/timeout/tool_error），
    // 事件类型承载在 tool_name（只记类型不记内容，符合 metadata-only 原则）
    try {
      recordDecision({
        decision: "allow",
        toolName: `autonomy:${ev.type}`,
        reason: `source=${ev.source} mode=${mode}`,
      });
    } catch { /* 审计失败不影响表达 */ }
    return { ...candidate, text };
  }

  return {
    handle,
    state: () => ({ mode, expressed, budgetDaily, dayKey, refined, refineDay }),
  };
}

/** 模块级单例（widget 启动时创建；测试用 createAutonomy 独立实例） */
let autonomyInstance = null;
export function getAutonomy() {
  if (!autonomyInstance) autonomyInstance = createAutonomy();
  return autonomyInstance;
}
