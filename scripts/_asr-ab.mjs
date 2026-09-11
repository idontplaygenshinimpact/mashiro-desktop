// scripts/_asr-ab.mjs —— 临时对照实验：同一段中文面试长答案，「整段送 ASR」 vs 「按能量谷分段送 ASR」
// 目的：量化验证"长音频（>30s）单次识别导致同音错 + 尾句截断"的假设，并给出修复后的基线数字。
// 用法：node --experimental-strip-types scripts/_asr-ab.mjs <wav> <ground-truth.txt> [maxSegSec]
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const wav = process.argv[2];
const gtFile = process.argv[3];
const MAX_SEG_SEC = Number(process.argv[4] || 15);
const GAIN = Number(process.argv[5] || 1);

/** 读 16k mono 16-bit PCM wav → Float32Array（-1..1） */
function readWav16k(p) {
  const buf = readFileSync(p);
  // 找 data chunk（SAPI 可能带 LIST 等额外块）
  let off = 12;
  let dataOff = -1, dataLen = 0, sampleRate = 0, channels = 0, bits = 0;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === "fmt ") {
      channels = buf.readUInt16LE(off + 10);
      sampleRate = buf.readUInt32LE(off + 12);
      bits = buf.readUInt16LE(off + 22);
    } else if (id === "data") {
      dataOff = off + 8;
      dataLen = size;
      break;
    }
    off += 8 + size + (size % 2);
  }
  if (dataOff < 0) throw new Error("wav 无 data chunk");
  if (sampleRate !== 16000 || channels !== 1 || bits !== 16) {
    throw new Error(`期望 16k/mono/16bit，实际 ${sampleRate}/${channels}/${bits}`);
  }
  const n = Math.floor(Math.min(dataLen, buf.length - dataOff) / 2);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(dataOff + i * 2) / 32768;
  return out;
}

/** 50ms 窗/25ms 步进能量（与 desktop/renderer/vad.js 同口径） */
function windowEnergies(pcm, sr = 16000, winMs = 50, stepMs = 25) {
  const win = Math.floor(sr * winMs / 1000);
  const step = Math.floor(sr * stepMs / 1000);
  const out = [];
  for (let i = 0; i + win <= pcm.length; i += step) {
    let sum = 0;
    for (let j = i; j < i + win; j++) sum += pcm[j] * pcm[j];
    out.push({ start: i, end: i + win, e: sum / win });
  }
  return out;
}

/** 按能量谷切分长音频：每段 ≤ maxSegSec，切点取"段内尾部最静的一窗"（避免切在词中） */
function segmentByEnergy(pcm, sr = 16000, maxSegSec = 15) {
  const wins = windowEnergies(pcm, sr);
  if (!wins.length) return [];
  const sorted = wins.map((w) => w.e).sort((a, b) => a - b);
  const floor = sorted[Math.floor(sorted.length * 0.2)] || 0;
  const thr = Math.max(floor * 4, 1e-5);
  // 先裁头尾静音（与 vad.js 一致）
  let s = 0, e = wins.length - 1;
  while (s <= e && wins[s].e < thr) s++;
  while (e >= s && wins[e].e < thr) e--;
  if (e < s) return [{ start: 0, end: pcm.length }];
  const voiceStart = Math.max(0, wins[s].start - sr * 0.05);
  const voiceEnd = Math.min(pcm.length, wins[e].end + sr * 0.05);

  const segs = [];
  const maxSamples = Math.floor(sr * maxSegSec);
  let cur = voiceStart;
  const lookBackWins = Math.floor(4000 / 25); // 回看 4s 找谷
  while (voiceEnd - cur > maxSamples) {
    const target = cur + maxSamples;
    // 在 [target-4s, target] 内找最小能量窗作为切点
    let bestIdx = -1, bestE = Infinity;
    for (let i = 0; i < wins.length; i++) {
      const w = wins[i];
      if (w.start < target - lookBackWins * (sr * 0.025)) break;
      if (w.start < target - 4000 || w.start > target) continue;
      if (w.e < bestE) { bestE = w.e; bestIdx = i; }
    }
    const cut = bestIdx >= 0 ? wins[bestIdx].end : target;
    segs.push({ start: cur, end: cut });
    cur = cut;
  }
  segs.push({ start: cur, end: voiceEnd });
  return segs;
}

/** 中文字符级 CER（去标点/空白后 Levenshtein） */
function lev(a, b) {
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}
const norm = (s) => String(s || "").replace(/[\s，。、；：？！,.;:?!（）()「」【】"'’‘“”—-]/g, "");
function cer(gt, hyp) {
  const a = norm(gt), b = norm(hyp);
  return { cer: a.length ? lev(a, b) / a.length : 0, gtLen: a.length, hypLen: b.length };
}

async function main() {
  let pcm = readWav16k(wav);
  if (GAIN !== 1) {
    const scaled = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) scaled[i] = Math.max(-1, Math.min(1, pcm[i] * GAIN));
    pcm = scaled;
  }
  const peak = pcm.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  const gt = readFileSync(gtFile, "utf8");
  const { transcribeAudio } = await import(pathToFileURL(path.resolve("lib/speech.mjs")).href);
  console.log(`音频 ${(pcm.length / 16000).toFixed(1)}s | 基准 ${norm(gt).length} 字 | 增益 ×${GAIN} | 峰值 ${peak.toFixed(3)}（${(20 * Math.log10(peak || 1e-6)).toFixed(1)}dBFS）\n`);

  // A：整段送 ASR（现状）
  let t0 = Date.now();
  const whole = await transcribeAudio(pcm);
  const tWhole = Date.now() - t0;
  const mw = cer(gt, whole.text || "");
  console.log(`【A 现状·整段】耗时 ${tWhole}ms | CER ${(mw.cer * 100).toFixed(1)}% | 输出 ${mw.hypLen} 字`);
  console.log(`  ${whole.text || `(失败: ${whole.error})`}\n`);

  // B：按能量谷分段（每段 ≤ maxSegSec）→ 逐段识别 → 拼接
  const segs = segmentByEnergy(pcm, 16000, MAX_SEG_SEC);
  t0 = Date.now();
  const parts = [];
  for (const sg of segs) {
    const r = await transcribeAudio(pcm.subarray(sg.start, sg.end));
    parts.push(r.ok ? r.text : "");
  }
  const joined = parts.filter(Boolean).join("，");
  const tSeg = Date.now() - t0;
  const ms = cer(gt, joined);
  console.log(`【B 分段·每段≤${MAX_SEG_SEC}s】${segs.length} 段 耗时 ${tSeg}ms | CER ${(ms.cer * 100).toFixed(1)}% | 输出 ${ms.hypLen} 字`);
  console.log(`  ${joined}`);
  console.log(`\n分段明细：${segs.map((s, i) => `#${i + 1} ${((s.end - s.start) / 16000).toFixed(1)}s`).join(" ")}`);
}

main().catch((e) => { console.error("实验失败:", e); process.exit(1); });
