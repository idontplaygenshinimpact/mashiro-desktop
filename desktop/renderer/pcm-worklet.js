// desktop/renderer/pcm-worklet.js —— AudioWorklet 处理器：采集麦克风 PCM 到主线程
// 背景：ScriptProcessorNode 是废弃 API，在 Electron 43（新 Chromium）的音频处理图下
//       inputBuffer 全零（实测 6.66s 音频 0/106496 非零采样）→ 语音永远录不上。
//       AudioWorklet 是替代标准：process() 每帧回调，经 port.postMessage 传 Float32Array。
class PCMCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (input && input[0]) {
      const ch = input[0];
      // 必须拷贝：AudioWorklet 的输入 buffer 会被复用
      const data = new Float32Array(ch.length);
      data.set(ch);
      this.port.postMessage(data);
    }
    return true; // 持续处理
  }
}
registerProcessor("pcm-capture", PCMCaptureProcessor);
