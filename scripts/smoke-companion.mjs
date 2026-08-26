// 端到端联调冒烟（Phase 事件驱动内核 W4）：模拟 CC 会话 jsonl → watcher → 总线 → 决策 → 表达队列
// 说明：无真实 claude 环境时用模拟会话文件验证全链（真实 claude 的 jsonl 由 parseCcLine 兼容）
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { installInternalBridge, emitEvent, onEventDecision, drainExpressions, clearExpressions } from "../lib/events.mjs";
import { createAutonomy } from "../lib/autonomy.mjs";
import { createCcWatcher } from "../lib/adapters/cc-watcher.mjs";

const dir = mkdtempSync(path.join(tmpdir(), "cc-e2e-"));
const line = (type, extra = {}) => JSON.stringify({ type, sessionId: "sess-e2e", version: "1.0.52", message: { role: "assistant", content: [], ...extra }, timestamp: new Date().toISOString() });

try {
  // 1) 会话开始（新文件）
  writeFileSync(path.join(dir, "sess-e2e.jsonl"), line("assistant", { content: [{ type: "text", text: "开场回复" }] }) + "\n", "utf8");
  // 2) 接线（与 widget.mjs 同构）
  installInternalBridge();
  const autonomy = createAutonomy();
  const unsubscribe = onEventDecision((ev) => { autonomy.handle(ev); });
  const watcher = createCcWatcher({ ccDir: dir, emit: (ev) => emitEvent(ev) });
  // 3) 首扫（建偏移）
  watcher.tick();
  // 4) CC 干活：追加工具调用 + 回复
  appendFileSync(path.join(dir, "sess-e2e.jsonl"), line("assistant", { content: [], tool_use: { id: "t1", name: "Read" } }) + "\n", "utf8");
  appendFileSync(path.join(dir, "sess-e2e.jsonl"), line("assistant", { content: [{ type: "text", text: "总结完成" }] }) + "\n", "utf8");
  watcher.tick();
  // 决策层回调是异步微任务——等一拍再 drain
  await new Promise((r) => setTimeout(r, 30));
  // 5) 主进程侧：drain 表达队列（companion-poller 会调 petSay）
  const exprs = drainExpressions();
  console.log("=== 端到端联调结果 ===");
  console.log("表达数:", exprs.length);
  for (const e of exprs) console.log(`  [${e.level}] ${e.text} (scene=${e.scene})`);
  const ok = exprs.some((e) => e.text.includes("CC"));
  console.log(ok ? "✅ 链路打通：CC 会话活动 → 桌宠表达" : "❌ 未产生表达");
  unsubscribe();
  process.exit(ok ? 0 : 1);
} finally {
  rmSync(dir, { recursive: true, force: true });
}