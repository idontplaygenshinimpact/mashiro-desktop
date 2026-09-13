// 全量 TS 升级工单阶段 3：lib/speech.mjs → .ts 后保留的一行桶（调用方零改动）
// 调用方：lib/speech-worker.ts（worker 线程容器）、widget.mjs（转写入口）、tests/speech-terms.test.mjs
export * from "./speech.ts";
