// edge-tts 测试（单独文件，便于看错误）
import { tts, getVoices } from "edge-tts";

try {
  console.log("开始获取语音列表...");
  const voices = await getVoices();
  const zh = voices.filter((v) => v.Locale === "zh-CN").slice(0, 10);
  console.log("中文语音:", zh.map((v) => v.ShortName).join(", "));
  console.log("开始合成...");
  const buf = await tts("嘿嘿，我是真白，今天也要一起加油学习哦～", {
    voice: "zh-CN-XiaoxiaoNeural",
    rate: "+10%",
    pitch: "+10Hz",
  });
  console.log("合成成功, buffer:", buf.length, "bytes");
  const { writeFileSync } = await import("node:fs");
  writeFileSync("D:/mianshi-agent/test-tts.mp3", buf);
  console.log("已保存 test-tts.mp3");
  process.exit(0);
} catch (e) {
  console.error("ERROR:", e.message);
  console.error(e.stack?.split("\n").slice(0, 4).join("\n"));
  process.exit(1);
}
