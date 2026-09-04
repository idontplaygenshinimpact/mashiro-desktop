/* global AudioWorkletProcessor, registerProcessor */
// 麦克风采集 AudioWorklet 处理器（M10：替换废弃 ScriptProcessor——Electron 43 下可能不可用）
// 16k 单声道 Float32 采集 → 每 buffer postMessage 给主线程（与 SpeechToText 的 16k Float32 输入对齐）
class MashiroMicProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) this.port.postMessage(new Float32Array(ch));
    return true; // 保持处理器存活
  }
}
registerProcessor("mashiro-mic", MashiroMicProcessor);
