// 真白固定日语语音包：预先合成的角色台词（wav），运行时零模型、毫秒级播放
// 模式1：中文文本关键词 → 场景 → 随机播放该场景的一句日语台词
// 模式2：playScene(scene) 直接按场景播放（点击/托盘等无文本事件）
// 未命中 → 返回 null，由调用方走实时 TTS 兜底
import { readFileSync, existsSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const VOICE_DIR = path.join(import.meta.dirname, "..", "assets", "voice");
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

/** 中文文本 → 命中场景返回 {file, scene}；未命中返回 ack 通用应答（保证总有日语语音，不做实时合成） */
export function matchVoicePack(text) {
  const t = String(text || "");
  for (const { scene, kws } of SCENE_KEYWORDS) {
    if (!kws.some((k) => t.includes(k))) continue;
    const file = pickSceneFile(scene);
    if (file) return { file, scene };
    return null;
  }
  // 兜底：通用应答（ack 场景）
  const ack = pickSceneFile("ack");
  if (ack) return { file: ack, scene: "ack" };
  return null;
}

/** 直接按场景播放（无文本事件：点击/托盘/学习完成等），播放失败返回 null */
export function playScene(scene) {
  const file = pickSceneFile(scene);
  if (!file) return null;
  return playVoicePack(file);
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

/** 播放语音包音频（ffplay 直接播，最可靠——MediaPlayer/SoundPlayer 后台不可靠） */
export function playVoicePack(file) {
  const ff = resolveFfplay();
  if (!ff) return { ok: false, error: "ffplay 不可用" };
  mkdirSync(TMP_DIR, { recursive: true });
  try {
    const child = spawn(ff, ["-autoexit", "-nodisp", "-loglevel", "quiet", file], { windowsHide: true, detached: true, stdio: "ignore" });
    child.on("error", (err) => console.log(`[voice] ffplay 播放失败: ${err.message}`));
    child.unref();
  } catch { /* ignore */ }
  return { ok: true, engine: "voicepack", file };
}
