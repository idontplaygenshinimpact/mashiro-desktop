// 模拟面试域路由（纵向拆分：/api/interview/* 从 widget.mjs 迁出）
import * as interviewApi from "#lib/interview.mjs";
import * as studyApi from "#lib/study.mjs";
import * as reviewApi from "#lib/review.mjs";
import { memory } from "#lib/memory.mjs";
import { readBody } from "#lib/widget-core.mjs";
import { withContract } from "#lib/routes/contract.mjs";
import { InterviewStartInput, InterviewAnswerInput, InterviewResult, InterviewStatusOutput } from "#lib/contracts/interview.mjs";
import { InterviewHistoryOutput, InterviewHistoryDeleteInput, InterviewHistoryDeleteOutput } from "#lib/contracts/misc.mjs";

// 全量 TS 升级工单阶段 4（插件）：实现迁至 interview.ts，interview.mjs 保留同名薄桶（插件按路径加载 → 入口与调用方零改动）
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Router } from "#lib/routes/router.mjs";

/** 错误信息提取（catch 变量在 strict 下是 unknown；message 为空/非 Error 抛出退回 String(e)） */
const eMsg = (e: unknown): string => {
  const m = (e as { message?: unknown } | null | undefined)?.message;
  return m ? String(m) : String(e);
};

export function registerInterviewRoutes(router: Router, { laneSubmit = (fn: () => any) => fn() }: { laneSubmit?: (fn: () => any) => any } = {}): void {
  router.route("/api/interview/start", "POST", withContract(
    async (input) => laneSubmit(() => interviewApi.startInterview(input)),
    { input: InterviewStartInput, output: InterviewResult }
  ));

  router.route("/api/interview/answer", "POST", withContract(
    async (input) => laneSubmit(() => interviewApi.submitAnswer(input.answer)),
    { input: InterviewAnswerInput, output: InterviewResult }
  ));

  router.route("/api/interview/end", "POST", withContract(
    () => laneSubmit(() => interviewApi.endInterview()),
    { output: InterviewResult }
  ));

  router.route("/api/interview/history", "GET", withContract(
    // 面试历史（复盘报告）
    () => ({ ok: true, history: memory.getInterviewHistory() }),
    { output: InterviewHistoryOutput }
  ));

  router.route("/api/interview/history/delete", "POST", withContract(
    // 历史复盘删除终态（闭环清查 ⑦：读得到、删不掉的"状态机无终态"样子货 → 真删）。
    // 三态渲染层共用这一条 HTTP 路由，不各自造删除逻辑。
    (input, { res }) => {
      const r = memory.deleteInterviewHistory(input.id);
      // 目标不存在/删除失败 → 如实 404 + ok:false（不恒报成功）；UI 据此显示真实结果。
      if (!r.ok) {
        if (!res.destroyed && !res.writableEnded) {
          res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, error: r.error || "删除面试历史失败" }));
        }
        // 回传给 output 契约校验；res 已被上面 404 收尾（writableEnded），withContract 的 200 不会再写入
        return { ok: false, error: r.error || "删除面试历史失败" };
      }
      return { ok: true };
    },
    { input: InterviewHistoryDeleteInput, output: InterviewHistoryDeleteOutput }
  ));

  router.route("/api/interview/status", "GET", withContract(
    () => interviewApi.getInterviewStatus(),
    { output: InterviewStatusOutput }
  ));

  router.route("/api/interview-notes", (req: IncomingMessage, res: ServerResponse) => {
    // 面试实录：把真实面试被问住的知识点加入学习清单（必会）+ 建复习卡
    readBody(req, res, (body: string) => {
      try {
        const input = JSON.parse(body || "{}");
        // topics 支持数组或字符串（逗号/顿号/换行/分号分隔）
        let raw = input.topics || [];
        if (typeof raw === "string") raw = raw.split(/[,，、;\n；]+/).map((s) => s.trim()).filter(Boolean);
        if (!Array.isArray(raw) || !raw.length) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "topics required" })); return; }
        const added = [], existing = [], skipped = [];
        for (const t of raw.slice(0, 8)) {
          const rawTopic = String(t).trim().slice(0, 40);
          if (!rawTopic) continue;
          // 伪知识点过滤 + 规范化（返回清洗后的 topic，保证与薄弱点口径一致）
          const topic = memory._cleanTopic ? memory._cleanTopic(rawTopic) : rawTopic;
          if (!topic) { skipped.push({ topic: rawTopic, reason: "非具体知识点" }); continue; }
          const r = studyApi.addPlanItems([{
            topic,
            why: "真实面试中被问住，需优先补强",
            source: "面试实录",
            verify_question: `请完整回答并讲清原理：${topic}`,
            level: "必会",
            fromInterview: true, // 真实面试实录 → 面板"面试"徽标
          }]);
          if (r.added > 0) {
            added.push(topic);
            // 自动建复习卡（进入间隔复习）
            try {
              reviewApi.review.addCard({ topic, question: `请完整回答并讲清原理：${topic}`, answer: "", source: "面试实录" });
            } catch { /* ignore */ }
          } else {
            existing.push(topic);
          }
        }
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, added, existing, skipped, hint: `新增 ${added.length} 个知识点（已在清单 ${existing.length} 个${skipped.length ? `，跳过 ${skipped.length} 个非知识点` : ""}），可在「📋 学习清单」查看，点「💡 讲解」生成详细讲解` }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: eMsg(e) }));
      }
    });
  });
}
