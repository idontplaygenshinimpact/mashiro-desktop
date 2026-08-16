// 樱花庄主题音乐播放系统
// 设计：用户把音乐文件（OP/ED/BGM，mp3/wav/m4a/flac/ogg）放入 assets/music/ 即被识别；
//       music.json 可选配置曲名（缺省用文件名）；ffplay 单实例后台播放（复用语音包引擎解析）
// 版权说明：不内置任何音乐文件，仅做目录扫描与播放控制；曲目来源建议见 assets/music/README.md
// 状态（音量/自动播放）持久化由 main.mjs 负责（data/music-state.json），本模块只管播放
import { readdirSync, existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { resolveFfplay } from "../desktop/voice-pack.mjs";

export const MUSIC_DIR = process.env.MIANSHI_TEST_MUSIC_DIR || path.join(import.meta.dirname, "..", "assets", "music");
const CONFIG_FILE = path.join(MUSIC_DIR, "music.json");
const AUDIO_EXT = [".mp3", ".wav", ".m4a", ".flac", ".ogg", ".aac"];

// 单实例播放：全局持有一个 ffplay 子进程（切歌/停止先杀旧的）
let player = null;
let playlist = [];      // [{file, name}]
let currentIndex = -1;
let volume = 70;        // 0-100（main 启动时注入持久化值）
let autoplayOn = false; // 启动自动播放（main 启动时注入持久化值）

/** 注入持久化状态（main 启动时调用） */
export function setMusicPrefs({ volume: v, autoplay: a } = {}) {
  if (typeof v === "number" && v >= 0 && v <= 100) volume = v;
  autoplayOn = !!a;
}

/** 曲目配置（music.json）：{ tracks: { "文件名.mp3": "曲名" } } */
function loadTrackNames() {
  try {
    const j = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
    return j?.tracks && typeof j.tracks === "object" ? j.tracks : {};
  } catch { /* 无配置用文件名 */ }
  return {};
}

/** 扫描音乐目录：按文件名排序，返回 [{file, name}] */
export function scanMusic() {
  const names = loadTrackNames();
  try {
    if (!existsSync(MUSIC_DIR)) return [];
    return readdirSync(MUSIC_DIR)
      .filter((f) => AUDIO_EXT.includes(path.extname(f).toLowerCase()))
      .map((f) => ({
        file: path.join(MUSIC_DIR, f),
        name: names[f] || f.replace(/\.[^.]+$/, ""),
      }))
      .sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
  } catch { /* ignore */ }
  return [];
}

/** 刷新播放列表（保留当前曲目索引尽量不跳歌） */
function refreshPlaylist() {
  const old = playlist[currentIndex]?.file;
  playlist = scanMusic();
  currentIndex = old ? playlist.findIndex((t) => t.file === old) : -1;
}

/** 播放指定曲目（file 为空 → 第一首/当前曲）；切歌先杀旧进程 */
export function playMusic(file = "", opts = {}) {
  refreshPlaylist();
  if (!playlist.length) return { ok: false, error: "assets/music/ 下没有音乐文件（放入 mp3/wav/m4a 即可，如樱花庄 OP/ED）" };
  let idx = file ? playlist.findIndex((t) => t.file === file) : currentIndex >= 0 ? currentIndex : 0;
  if (idx < 0) idx = 0;
  currentIndex = idx;
  return startPlayer(playlist[idx], opts);
}

/** 播放下一首（循环列表） */
export function nextMusic() {
  refreshPlaylist();
  if (!playlist.length) return { ok: false, error: "没有音乐文件" };
  currentIndex = (currentIndex + 1) % playlist.length;
  return startPlayer(playlist[currentIndex], {});
}

/** 停止播放（杀 ffplay 进程） */
export function stopMusic() {
  if (player) {
    try { player.kill(); } catch { /* ignore */ }
    player = null;
  }
  return { ok: true, playing: false };
}

/** 播放状态 */
export function getMusicState() {
  const playing = !!(player && !player.killed);
  return {
    ok: true,
    playing,
    current: playing && playlist[currentIndex] ? playlist[currentIndex].name : null,
    index: playing ? currentIndex : -1,
    total: playlist.length,
    tracks: playlist.map((t) => t.name),
    volume,
    autoplayOn,
  };
}

/** 音量（0-100，ffplay -volume；播放中即时重启生效） */
export function setMusicVolume(v) {
  const n = Math.max(0, Math.min(100, Number(v) || 0));
  volume = n;
  if (player && !player.killed && currentIndex >= 0 && playlist[currentIndex]) {
    const cur = playlist[currentIndex];
    stopMusic();
    return startPlayer(cur, {});
  }
  return { ok: true, volume };
}

/** 自动播放开关（仅内存；持久化由 main 负责） */
export function setMusicAutoplay(on) {
  autoplayOn = !!on;
  return { ok: true, autoplayOn };
}

// 播放引擎：ffplay 单实例（-volume 音量；播完由 ffplay 自然结束）
function startPlayer(track, opts = {}) {
  const ff = resolveFfplay();
  if (!ff) return { ok: false, error: "ffplay 不可用，无法播放音乐" };
  stopMusic(); // 杀旧进程
  try {
    const args = ["-nodisp", "-loglevel", "quiet", "-volume", String(opts.volume ?? volume)];
    if (opts.loop) args.push("-loop", "0");
    args.push(track.file);
    player = spawn(ff, args, { windowsHide: true, detached: true, stdio: "ignore" });
    player.on("error", (err) => {
      console.log(`[music] 播放失败: ${err.message}`);
      player = null;
    });
    player.on("exit", () => { player = null; });
    player.unref();
    console.log(`[music] 🎵 播放 ${track.name}`);
    return { ok: true, playing: true, name: track.name, file: track.file };
  } catch (e) {
    console.log(`[music] 播放异常: ${e.message}`);
    return { ok: false, error: String(e.message || e).slice(0, 100) };
  }
}
