var SpeechQueue = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
  var speech_queue_exports = {};
  __export(speech_queue_exports, {
    createSpeechQueue: () => createSpeechQueue,
    flushRest: () => flushRest,
    splitSentences: () => splitSentences
  });
  const SENT_END = /[。！？\n]/;
  const URL_LINE = /^\s*(https?:\/\/|www\.)/;
  const MIN_SENT = 8;
  function splitSentences(text) {
    const sentences = [];
    let buf = "";
    let inCode = false;
    for (const line of String(text || "").split("\n")) {
      const trimmed = line.trim();
      if (/^```|^~~~|^`/.test(trimmed)) {
        inCode = !inCode;
        continue;
      }
      if (inCode) continue;
      if (URL_LINE.test(trimmed)) continue;
      let remaining = line;
      while (remaining.length > 0) {
        const idx = remaining.search(SENT_END);
        if (idx < 0) {
          buf += remaining;
          break;
        }
        const seg = remaining.slice(0, idx + 1);
        remaining = remaining.slice(idx + 1);
        if (buf) {
          if (seg.length < MIN_SENT && buf.length + seg.length < 60) {
            buf += seg;
            continue;
          }
          sentences.push((buf + seg).trim());
          buf = "";
        } else {
          sentences.push(seg.trim());
        }
      }
    }
    if (buf.length >= 60) {
      sentences.push(buf.trim());
      buf = "";
    }
    return { sentences: sentences.filter(Boolean), rest: buf };
  }
  function flushRest(rest, minLen = 2) {
    const r = String(rest || "").trim();
    if (!r) return "";
    if (r.length < minLen) return "";
    return r;
  }
  function createSpeechQueue({ prepare, play, budget = 200 }) {
    let queue = [];
    let playing = false;
    let spokenToday = 0;
    let stopped = false;
    let prefetch = null;
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
        if (spokenToday >= budget) break;
        try {
          let audio = null;
          if (prefetch && prefetch.text === text) {
            audio = await prefetch.promise;
            prefetch = null;
          } else {
            prefetch = null;
            audio = prepare ? await prepare(text) : null;
          }
          startPrefetch();
          if (audio) await play(audio, text);
          spokenToday++;
        } catch {
        }
      }
      playing = false;
      stopped = false;
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
        startPrefetch();
        void pump();
      },
      /** 打断：清空队列 + 停止当前句（由 play 实现方配合 abort） */
      stop() {
        stopped = true;
        queue = [];
        playing = false;
        prefetch = null;
      },
      get size() {
        return queue.length;
      },
      get isSpeaking() {
        return playing;
      },
      get remainingBudget() {
        return Math.max(0, budget - spokenToday);
      },
      resetBudget() {
        spokenToday = 0;
      }
    };
  }
  return __toCommonJS(speech_queue_exports);
})();
