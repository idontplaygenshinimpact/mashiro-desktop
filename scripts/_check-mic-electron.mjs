// scripts/_check-mic-electron.mjs —— 验证 Electron 内 getUserMedia 设备与能量
// 用法: npx electron scripts/_check-mic-electron.mjs
// 对比：默认设备采集 vs 显式 Realtek 设备采集，输出能量与非零采样率
import { app, BrowserWindow } from "electron";

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: false } });
  await win.loadFile("D:/mianshi-agent/scripts/_mic-probe.html");
  const js = `
    (async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const devs = await navigator.mediaDevices.enumerateDevices().catch((e) => ({ err: String(e) }));
      const list = Array.isArray(devs) ? devs.filter((d) => d.kind === "audioinput").map((d) => ({ id: d.deviceId.slice(0, 20), label: d.label })) : devs;
      // 能量统计：默认设备录 2s
      async function capture(tag, constraints) {
        try {
          const stream = await navigator.mediaDevices.getUserMedia(constraints);
          const ctx = new AudioContext({ sampleRate: 16000 });
          if (ctx.state === "suspended") await ctx.resume();
          await ctx.audioWorklet.addModule("file:///D:/mianshi-agent/desktop/renderer/pcm-worklet.js");
          const src = ctx.createMediaStreamSource(stream);
          const node = new AudioWorkletNode(ctx, "pcm-capture");
          let total = 0, nonZero = 0, maxAmp = 0;
          node.port.onmessage = (e) => { for (const v of e.data) { total++; if (Math.abs(v) > 1e-6) nonZero++; if (Math.abs(v) > maxAmp) maxAmp = Math.abs(v); } };
          src.connect(node);
          await sleep(2000);
          stream.getTracks().forEach((t) => t.stop());
          await ctx.close();
          return { tag, total, nonZero, maxAmp: Number(maxAmp.toFixed(5)) };
        } catch (e) { return { tag, err: String(e?.name || e?.message || e) }; }
      }
      const base = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 };
      const r1 = await capture("默认设备", { audio: base });
      const realtek = Array.isArray(devs) ? devs.find((d) => d.kind === "audioinput" && /realtek|麦克风/i.test(d.label)) : null;
      const r2 = realtek ? await capture("Realtek 显式", { audio: { ...base, deviceId: { exact: realtek.deviceId } } }) : { tag: "Realtek 显式", err: "未找到 Realtek 设备" };
      return JSON.stringify({ list, r1, r2 });
    })()
  `;
  const out = await win.webContents.executeJavaScript(js, true).catch((e) => "FAIL: " + String(e));
  console.log("=== 设备列表与采集对比 ===");
  console.log(out);
  app.exit(0);
});
