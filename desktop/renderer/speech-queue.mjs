// 实时语音调度核心：句子切分 + 串行播放队列 + 打断 + 预算（渲染层，esbuild 打包）
// 播放动作由注入的 play(text) 实现（预设命中/实时合成/TTS 由调用方组合）
// 与 desktop/tts-edge.mjs（主进程预设播放）配合：预设命中零延迟，未命中走实时合成

// ---------- 句子切分（规则，零 LLM 成本） ----------
const SENT_END = /[。！？\n]/;
const CODE_LINE = /^\s*(```|~~~|`)/;          // 代码块行
const URL_LINE = /^\s*(https?:\/\/|www\.)/;   // URL 行
const MIN_SENT = 8;                            // 小于 8 字符并入前句（防碎片）

/**
 * 流式切句：输入累积文本，输出完整句列表 + 未完成残句。
 * 只有遇到终止符（。！？\n）才切出完整句；代码块/URL 行不播。
 * @param {string} text
 * @returns {{ sentences: string[], rest: string }}
 */
export function splitSentences(text) {
  const sentences = [];
  let buf = "";
  let inCode = false; // 代码块内状态（``` 行切换，内容行跳过）
  for (const line of String(text || "").split("\n")) {
    const trimmed = line.trim();
    if (/^```|^~~~|^`/.test(trimmed)) { inCode = !inCode; continue; } // 代码块边界
    if (inCode) continue;                                             // 代码块内容不播
    if (URL_LINE.test(trimmed)) continue; // 不播行直接跳过
    let remaining = line;
    while (remaining.length > 0) {
      const idx = remaining.search(SENT_END);
      if (idx < 0) { buf += remaining; break; } // 尾部残句入 buf（无需清空 remaining，break 即出循环）
      const seg = remaining.slice(0, idx + 1); // 含终止符
      remaining = remaining.slice(idx + 1);
      if (buf) {
        // 短残句并入当前段，避免碎片
        if (seg.length < MIN_SENT && buf.length + seg.length < 60) { buf += seg; continue; }
        sentences.push((buf + seg).trim());
        buf = "";
      } else {
        sentences.push(seg.trim());
      }
    }
  }
  // 残句过长也切出（防无限累积；流式场景下由调用方在 done 时 flush）
  if (buf.length >= 60) { sentences.push(buf.trim()); buf = ""; }
  return { sentences: sentences.filter(Boolean), rest: buf };
}

/** flush：流结束时把残句也切出（若长度足够） */
export function flushRest(rest, minLen = 2) {
  const r = String(rest || "").trim();
  if (!r) return "";
  if (r.length < minLen) return ""; // 只丢极短碎片（≥2 字就播，避免"话没说完"感）
  return r;
}

// ---------- 串行播放队列（prepare/play 两阶段 + 预取流水线） ----------
/**
 * @param {{ prepare: (text: string) => Promise<any|null>, play: (audio: any, text: string) => Promise<void>, budget?: number }} opts
 *  prepare：准备音频（预设命中/实时合成），返回 audio 句柄（如 {path}）；返回 null = 跳过本句
 *  play：播放 audio，resolve 表示播完（队列才推下一句）
 *  预取：播放当前句期间，后台 prepare 下一句（合成与播放流水线重叠，掩盖合成延迟）
 */
export function createSpeechQueue({ prepare, play, budget = 200 }) {
  let queue = [];
  let playing = false;
  let spokenToday = 0;
  let stopped = false;
  let prefetch = null; // {text, promise}

  function startPrefetch() {
    if (prefetch || queue.length === 0 || !prepare) return;
    const text = queue[0];
    prefetch = { text, promise: prepare(text).catch(() => null) };
  }

  async function pump() {
    if (playing || queue.length === 0) return;
    playing = true;
    while (queue.length > 0 && !stopped) {
      const text = queue.shift();
      if (spokenToday >= budget) break; // 预算耗尽：静默跳过，不阻塞对话
      try {
        let audio = null;
        if (prefetch && prefetch.text === text) {
          audio = await prefetch.promise; // 预取结果（合成已并行完成）
          prefetch = null;
        } else {
          prefetch = null;
          audio = prepare ? await prepare(text) : null;
        }
        startPrefetch(); // 播放前启动下一句预取（后台合成，与播放并行）
        if (audio) await play(audio, text);
        spokenToday++;
      } catch { /* play/prepare 失败由调用方内部降级；队列继续 */ }
    }
    playing = false;
    stopped = false; // 队列清空后复位（下次 push 可播）
  }

  return {
    /** 入队一句（或一句数组）；正在播放时排队，队列空时立即开始 */
    push(text) {
      if (stopped) return;
      const list = Array.isArray(text) ? text : [text];
      for (const t of list) {
        const s = String(t || "").trim();
        if (s) queue.push(s);
      }
      startPrefetch(); // 入队即预取（队列首句后台合成）
      void pump();
    },
    /** 打断：清空队列 + 停止当前句（由 play 实现方配合 abort） */
    stop() {
      stopped = true;
      queue = [];
      playing = false;
      prefetch = null;
    },
    get size() { return queue.length; },
    get isSpeaking() { return playing; },
    get remainingBudget() { return Math.max(0, budget - spokenToday); },
    resetBudget() { spokenToday = 0; },
  };
}
