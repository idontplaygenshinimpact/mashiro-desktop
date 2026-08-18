// desktop/renderer/vad.js —— 简单能量 VAD（浏览器普通 script，挂 window.trimSilenceToVoice）
// 用途：语音输入前裁掉头尾静音——静音/环境噪声直接进 ASR 会被 whisper/paraformer "脑补"成汉字
// 算法：50ms 窗均方能量 → 底噪取能量序列最低 20% 分位 → 阈值 = max(底噪×4, -50dBFS 能量下限)
//       → 找首尾过阈窗口，前后各留一个窗（防切词头/尾）
(function (root) {
  "use strict";
  /**
   * 裁掉 PCM 头尾静音（不修改原数组，返回 subarray；无语音返回 null）
   * @param {Float32Array} pcm 16kHz 单声道采样
   * @param {number} sampleRate 采样率（默认 16000）
   * @returns {Float32Array|null} 有效语音段（含 ±1 窗余量），全程静音返回 null
   */
  function trimSilenceToVoice(pcm, sampleRate) {
    if (!pcm || pcm.length === 0) return null;
    const sr = sampleRate || 16000;
    const win = Math.max(1, Math.floor(sr * 0.05)); // 50ms 窗
    const step = Math.floor(win / 2); // 25ms 步进
    const n = pcm.length;
    // 每窗均方能量
    const energies = [];
    for (let i = 0; i < n; i += step) {
      let sum = 0, cnt = 0;
      const end = Math.min(i + win, n);
      for (let j = i; j < end; j++) { sum += pcm[j] * pcm[j]; cnt++; }
      energies.push(sum / cnt);
    }
    // 底噪 = 最低 20% 分位；真正的静音窗能量 < 1e-4（约 -40dBFS 能量）
    const sorted = energies.slice().sort((a, b) => a - b);
    const floor = sorted[Math.floor(sorted.length * 0.2)] || 0;
    // 全程语音（无静音段）：最低 20% 分位都已达语音能量量级 → 无需裁剪
    if (floor >= 1e-4) return pcm;
    // 阈值：底噪 4 倍，但不低于绝对下限（1e-5 ≈ -50dBFS 能量，防极静环境误判）
    const thr = Math.max(floor * 4, 1e-5);
    let s = 0, e = energies.length - 1;
    while (s <= e && energies[s] < thr) s++;
    while (e >= s && energies[e] < thr) e--;
    if (e < s) return null; // 全程静音
    const start = Math.max(0, s * step - win); // 前留一个窗，防切词头
    const end = Math.min(n, (e + 1) * step + win); // 后留一个窗
    return pcm.subarray(start, end);
  }
  root.trimSilenceToVoice = trimSilenceToVoice;
  if (typeof module !== "undefined" && module.exports) module.exports = { trimSilenceToVoice };
})(typeof window !== "undefined" ? window : globalThis);
