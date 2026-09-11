// scripts/_asr-concat.mjs —— 把多段 wav（每句一个文件）用长静音拼接成一段"边想边说"的音频
// 目的：真实面试回答里句子之间有 1.5-3s 思考停顿（TTS 直读没有）——用于验证长停顿是否导致 ASR 丢内容
// 用法：node scripts/_asr-concat.mjs <out.wav> <gapMs> <in1.wav> <in2.wav> ...
import { readFileSync, writeFileSync } from "node:fs";

function readWavPcm(p) {
  const buf = readFileSync(p);
  let off = 12, dataOff = -1, dataLen = 0;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === "data") { dataOff = off + 8; dataLen = size; break; }
    off += 8 + size + (size % 2);
  }
  return buf.subarray(dataOff, dataOff + dataLen);
}

const [out, gapMsStr, ...ins] = process.argv.slice(2);
const gap = Math.floor((Number(gapMsStr) / 1000) * 16000) * 2; // 字节数（16bit）
const silence = Buffer.alloc(gap);
const parts = [];
ins.forEach((f, i) => {
  if (i > 0) parts.push(silence);
  parts.push(readWavPcm(f));
});
const pcm = Buffer.concat(parts);
const header = Buffer.alloc(44);
header.write("RIFF", 0); header.writeUInt32LE(36 + pcm.length, 4); header.write("WAVE", 8);
header.write("fmt ", 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
header.writeUInt32LE(16000, 24); header.writeUInt32LE(32000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
header.write("data", 36); header.writeUInt32LE(pcm.length, 40);
writeFileSync(out, Buffer.concat([header, pcm]));
console.log(`${out}: ${(pcm.length / 2 / 16000).toFixed(1)}s（${ins.length} 句，句间静音 ${gapMsStr}ms）`);
