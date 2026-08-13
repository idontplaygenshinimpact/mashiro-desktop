// VoiceVox 台词合成：lines-text.mjs 的 40 句 → assets/voice/*.wav
// 用法: node scripts/synthesize-voice.mjs
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const LINES_MOD = pathToFileURL(path.join(process.cwd(), "assets", "voice", "lines-text.mjs")).href;
const { LINES } = await import(LINES_MOD);
const VOICE_DIR = path.join(process.cwd(), "assets", "voice");
const SPEAKER = Number(process.env.VOICEVOX_SPEAKER || 0);
const VV = process.env.VOICEVOX_URL || "http://127.0.0.1:50021";

mkdirSync(VOICE_DIR, { recursive: true });
let done = 0, failed = 0;
for (const [file, text] of Object.entries(LINES)) {
  try {
    const qRes = await fetch(`${VV}/audio_query?speaker=${SPEAKER}&text=${encodeURIComponent(text)}`, {
      method: "POST",
      signal: AbortSignal.timeout(30000),
    });
    if (!qRes.ok) throw new Error(`audio_query ${qRes.status}`);
    const query = await qRes.json();
    const wRes = await fetch(`${VV}/synthesis?speaker=${SPEAKER}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(query),
      signal: AbortSignal.timeout(60000),
    });
    if (!wRes.ok) throw new Error(`synthesis ${wRes.status}`);
    const buf = Buffer.from(await wRes.arrayBuffer());
    if (buf.length < 1024) throw new Error("输出过短");
    writeFileSync(path.join(VOICE_DIR, file), buf);
    done++;
    console.log(`✅ ${file} (${(buf.length / 1024).toFixed(0)}KB) ${text}`);
  } catch (e) {
    failed++;
    console.log(`❌ ${file}: ${e.message.slice(0, 80)}`);
  }
}
console.log(`\n合成完成: ${done} 成功 / ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
