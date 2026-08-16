// 真白固定日语语音包：预先合成的角色台词（wav），运行时零模型、毫秒级播放
// 模式1：中文文本关键词 → 场景 → 随机播放该场景的一句日语台词
// 模式2：playScene(scene) 直接按场景播放（点击/托盘等无文本事件）
// 未命中 → 返回 null，由调用方走实时 TTS 兜底
import { readFileSync, existsSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const VOICE_DIR = process.env.MIANSHI_TEST_VOICE_DIR || path.join(import.meta.dirname, "..", "assets", "voice");
const TMP_DIR = path.join(os.tmpdir(), "mashiro-tts");

let linesCache = null;
function loadLines() {
  if (linesCache) return linesCache;
  try {
    linesCache = JSON.parse(readFileSync(path.join(VOICE_DIR, "lines.json"), "utf8"));
  } catch {
    linesCache = {};
  }
  return linesCache;
}

// 场景 → 中文关键词（数组顺序 = 优先级，冲突时先命中的胜）
// 全部日语预设：界面显示中文，语音播放日语台词；未命中 → ack 通用应答
const SCENE_KEYWORDS = [
  { scene: "love", kws: ["喜欢你", "爱你", "我爱你", "最喜欢", "喜欢真白", "老婆", "贴贴", "亲亲"] },
  { scene: "interview", kws: ["面试", "面经", "面试官", "面完", "八股", "offer", "hr面", "一面", "二面", "三面", "笔试通知"] },
  { scene: "surprise", kws: ["哇", "天哪", "卧槽", "震惊", "吓死", "不会吧", "离谱", "居然", "竟然", "哇塞"] },
  { scene: "question", kws: ["不懂", "为什么", "什么鬼", "咋办", "搞不懂", "没懂", "怎么回事", "不明白", "求解", "啥意思"] },
  { scene: "done", kws: ["全部完成", "学完", "通关", "毕业", "全做完了", "做完了", "搞定了", "完成了", "收工"] },
  { scene: "start", kws: ["开始学习", "开始吧", "开刷", "开工", "开始刷", "开始做", "开始吧", "走起"] },
  { scene: "praise", kws: ["好棒", "太棒", "厉害", "做得好", "优秀", "答对", "完成", "恭喜", "掌握", "满分", "全对", "完美", "牛", "太强了", "真棒", "厉害啊", "牛逼"] },
  { scene: "comfort", kws: ["没关系", "别灰心", "别担心", "下次", "不要气馁", "没答好", "不理想", "答错", "失败了", "挂科", "被拒", "没面好", "又错了", "好难"] },
  { scene: "encourage", kws: ["加油", "努力", "坚持", "冲刺", "别放弃", "继续", "fighting", "冲鸭", "拼了", "再试一次"] },
  { scene: "review", kws: ["复习", "复刷", "回顾", "复盘", "再看一遍", "重温"] },
  { scene: "remind", kws: ["提醒", "该学习", "打卡", "摸鱼", "学习时间", "催我", "别忘了", "记得"] },
  { scene: "sleep", kws: ["晚安", "睡觉", "休息", "おやすみ", "睡了", "困了", "好累"] },
  { scene: "thanks", kws: ["谢谢", "感谢", "ありがとう", "辛苦了", "谢啦", "多谢", "爱你哦"] },
  { scene: "proud", kws: ["夸我", "真白厉害", "真白可爱", "可爱吧", "厉害吧", "夸夸", "真白好棒"] },
  { scene: "greeting", kws: ["早上好", "你好", "嗨", "哈喽", "hello", "こんにちは", "おはよう", "hi", "中午好", "下午好", "晚上好", "在吗", "在不在"] },
  { scene: "bye", kws: ["再见", "拜拜", "走了", "先下了", "告辞", "さようなら", "回头见"] },
  { scene: "call", kws: ["真白", "喂喂", "诶诶", "过来", "看我"] },
  { scene: "agree", kws: ["好的", "行", "可以", "没问题", "同意", "赞成", "就这么办", "ok", "好呀", "好的呀", "嗯嗯"] },
];

/** 随机取场景台词文件；场景不存在/文件缺失返回 null */
export function pickSceneFile(scene) {
  const lines = loadLines();
  const files = (lines[scene] || {}).files || [];
  if (!files.length) return null;
  const file = path.join(VOICE_DIR, files[Math.floor(Math.random() * files.length)]);
  return existsSync(file) ? file : null;
}

/** 中文文本 → 命中场景返回 {file, scene}；未命中返回 null
 * @param {string} text
 * @param {{ ack?: boolean }} [opts] ack=false 时不返回通用应答（调用方自行兜底，如实时 TTS） */
export function matchVoicePack(text, opts = {}) {
  const t = String(text || "");
  for (const { scene, kws } of SCENE_KEYWORDS) {
    if (!kws.some((k) => t.includes(k))) continue;
    const file = pickSceneFile(scene);
    if (file) return { file, scene };
    return null;
  }
  // 兜底：通用应答（ack 场景）；opts.ack=false 时留给调用方（实时 TTS）
  if (opts.ack !== false) {
    const ack = pickSceneFile("ack");
    if (ack) return { file: ack, scene: "ack" };
  }
  return null;
}

/** 直接按场景播放（无文本事件：点击/托盘/学习完成等），播放失败返回 null */
export function playScene(scene) {
  const file = pickSceneFile(scene);
  if (!file) return null;
  return playVoicePack(file);
}

// ---------- 长句语音（GPT-SoVITS 真白声线合成，assets/voice/long/） ----------
// 长句场景：日常关怀/完成庆祝/面试鼓励等需要"说一段话"的场合；
// 未配置长句 → 回退短句场景（降级不静音）
let longCache = null;
function loadLongLines() {
  if (longCache) return longCache;
  try {
    longCache = JSON.parse(readFileSync(path.join(VOICE_DIR, "long", "long.json"), "utf8"));
  } catch {
    longCache = {};
  }
  return longCache;
}

/** 播放场景长句（优先）；无长句回退短句。返回播放结果或 null */
export function playLongScene(scene) {
  const lines = loadLongLines();
  const entry = lines[scene] || {};
  const files = Array.isArray(entry.files) ? entry.files : [];
  if (!files.length) return playScene(scene); // 回退短句
  const file = path.join(VOICE_DIR, "long", files[Math.floor(Math.random() * files.length)]);
  if (!existsSync(file)) return playScene(scene);
  return playVoicePack(file);
}

// ---------- 单击应答：随机播一条新合成长句（GPT-SoVITS），让点击有新鲜语音 ----------
// 场景池：问候/夸赞/鼓励/安慰/发呆/爱意/完成/面试/音乐（人设一致的日常应答）
const CLICK_LONG_SCENES = ["greeting", "praise", "encourage", "comfort", "idle", "love", "done", "interview", "music"];
export function playClickLong() {
  const lines = loadLongLines();
  const pool = [];
  for (const scene of CLICK_LONG_SCENES) {
    const files = (lines[scene] || {}).files || [];
    for (const f of files) {
      if (existsSync(path.join(VOICE_DIR, "long", f))) pool.push(f);
    }
  }
  if (!pool.length) return playScene("click"); // 无长句回退短句应答
  const file = path.join(VOICE_DIR, "long", pool[Math.floor(Math.random() * pool.length)]);
  return playVoicePack(file);
}

/** 长句文案查询（气泡显示中文翻译用）：{zh, files} 或 null */
export function pickLongLine(scene) {
  const lines = loadLongLines();
  const entry = lines[scene] || {};
  const files = Array.isArray(entry.files) ? entry.files : [];
  if (!files.length) return null;
  const idx = Math.floor(Math.random() * files.length);
  return {
    file: files[idx],
    zh: Array.isArray(entry.zh) ? entry.zh[idx] || "" : "",
  };
}

// ---------- ffplay 路径解析（可配置 + 自动探测 + 硬编码兜底，找不到则不崩溃） ----------
const HARDCODED_FFPLAY = "D:\\hfut\\file\\Videopro\\exp01\\exp01_ffmpeg\\ffmpeg\\ffmpeg\\bin\\ffplay.exe";
let ffplayPath = null; // null=未探测；string=路径；false=不可用

/** 解析 ffplay 可执行路径：FFPLAY_PATH 覆盖 → where 探测（缓存）→ 硬编码兜底 → 不可用 */
export function resolveFfplay() {
  if (ffplayPath !== null) return ffplayPath;
  // 1) 环境变量显式覆盖
  if (process.env.FFPLAY_PATH && existsSync(process.env.FFPLAY_PATH)) {
    ffplayPath = process.env.FFPLAY_PATH;
    return ffplayPath;
  }
  // 2) 自动探测 where ffplay（同步，结果缓存）
  try {
    const r = spawnSync("where", ["ffplay"], { windowsHide: true, timeout: 3000 });
    if (r.status === 0 && r.stdout) {
      const line = String(r.stdout).split(/\r?\n/).map((s) => s.trim()).find((s) => s && existsSync(s));
      if (line) { ffplayPath = line; return ffplayPath; }
    }
  } catch { /* ignore */ }
  // 3) 回退硬编码路径
  if (existsSync(HARDCODED_FFPLAY)) { ffplayPath = HARDCODED_FFPLAY; return ffplayPath; }
  ffplayPath = false; // 不可用
  return ffplayPath;
}

/** 播放语音包音频：ffplay 优先（最可靠）；ffplay 不可用/失败 → PowerShell SoundPlayer 系统 API 兜底（wav） */
// 防抖 + 互斥：同一时间只允许一个语音在播（新播放前杀掉旧的，避免连续点击叠加）；1.5s 内重复触发直接丢弃
let activeVoicePlayer = null; // 当前语音播放进程（互斥）
let lastVoicePlayAt = 0;      // 上次播放时间戳（防抖）
const VOICE_DEBOUNCE_MS = 1500;

export function playVoicePack(file) {
  const now = Date.now();
  if (now - lastVoicePlayAt < VOICE_DEBOUNCE_MS) {
    console.log(`[voice] 防抖：${now - lastVoicePlayAt}ms 前刚播过，跳过 ${file.split(/[\\/]/).pop()}`);
    return { ok: false, debounced: true };
  }
  lastVoicePlayAt = now;
  // 互斥：杀掉上一个语音进程（避免多个 ffplay 同时出声叠加）
  if (activeVoicePlayer) {
    try { activeVoicePlayer.kill(); } catch { /* ignore */ }
    activeVoicePlayer = null;
  }
  const ff = resolveFfplay();
  if (ff) {
    try {
      const child = spawn(ff, ["-autoexit", "-nodisp", "-loglevel", "quiet", file], { windowsHide: true, detached: true, stdio: "ignore" });
      activeVoicePlayer = child;
      child.on("error", (err) => {
        console.log(`[voice] ffplay 播放失败: ${err.message}`);
        if (activeVoicePlayer === child) activeVoicePlayer = null;
        soundPlayerFallback(file);
      });
      child.on("exit", () => { if (activeVoicePlayer === child) activeVoicePlayer = null; });
      child.unref();
      console.log(`[voice] 播放 ${file.split(/[\\/]/).pop()}（ffplay）`);
      return { ok: true, engine: "ffplay", file };
    } catch (e) {
      console.log(`[voice] ffplay spawn 异常: ${e.message}`);
    }
  }
  return soundPlayerFallback(file);
}

/** PowerShell SoundPlayer 兜底（Windows 系统 API，播放 wav；返回结果） */
function soundPlayerFallback(file) {
  try {
    const ps = `(New-Object Media.SoundPlayer -ArgumentList '${String(file).replace(/'/g, "''")}').PlaySync()`;
    const child = spawn("powershell", ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", ps], {
      windowsHide: true, detached: true, stdio: "ignore",
    });
    child.on("error", (err) => console.log(`[voice] SoundPlayer 播放失败: ${err.message}`));
    child.unref();
    console.log(`[voice] 播放 ${file.split(/[\\/]/).pop()}（SoundPlayer 兜底）`);
    return { ok: true, engine: "soundplayer", file };
  } catch (e) {
    console.log(`[voice] SoundPlayer 不可用: ${e.message}`);
    return { ok: false, error: "无可用播放引擎" };
  }
}
