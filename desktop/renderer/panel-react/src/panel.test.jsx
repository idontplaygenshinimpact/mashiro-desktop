// React 版模拟面试面板测试（Vitest + Testing Library）
// mock window.kanban IPC 桥——测渲染/交互/数据流，不依赖 Electron
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { InterviewPanel } from "./panel.jsx";

const START_RESP = {
  round: 1, roundType: "技术深挖型", question: "讲讲事件循环？", dimension: "基础", depth: 2,
  basis: "简历提到", criteria: "能说出宏任务微任务", boundary: "不考 Node", totalRounds: 3,
};
const ANSWER_RESP = {
  round: 2, roundType: "技术深挖型", question: "那微任务队列呢？", dimension: "基础", depth: 1,
  scores: { tech: 4, expr: 3, depth: 4, edge: 2, reflect: 3 }, total: 16, comment: "思路清晰，边界完整",
  finished: false,
};
const END_RESP = { ok: true, report: "# 复盘报告\n面试完成", hint: "已结束" };

beforeEach(() => {
  window.kanban = {
    interviewHistory: vi.fn().mockResolvedValue({ history: [{ id: 1, position: "前端", rounds: 2, date: "2026-08-01" }] }),
    invStatus: vi.fn().mockResolvedValue({ ok: true, active: false }),
    invStart: vi.fn().mockResolvedValue(START_RESP),
    invAnswer: vi.fn().mockResolvedValue(ANSWER_RESP),
    invEnd: vi.fn().mockResolvedValue(END_RESP),
  };
});

describe("InterviewPanel（React 版）", () => {
  it("setup 视图：岗位/风格/历史列表渲染", async () => {
    render(<InterviewPanel />);
    expect(screen.getByText(/React 版/)).toBeTruthy();
    expect(screen.getByText("🚀 开始面试")).toBeTruthy();
    await waitFor(() => expect(screen.getByText(/历史复盘/)).toBeTruthy());
  });

  it("开始面试：invStart 调用 → 问题与考察维度显示", async () => {
    render(<InterviewPanel />);
    fireEvent.click(screen.getByText("🚀 开始面试"));
    await waitFor(() => expect(screen.getByText(/讲讲事件循环/)).toBeTruthy());
    expect(screen.getByText(/考察维度：基础/)).toBeTruthy();
    expect(screen.getByText(/^第 1 轮/)).toBeTruthy();
  });

  it("提交回答：invAnswer 调用 → 评分/点评/日志更新", async () => {
    render(<InterviewPanel />);
    fireEvent.click(screen.getByText("🚀 开始面试"));
    await waitFor(() => expect(screen.getByText(/讲讲事件循环/)).toBeTruthy());
    fireEvent.change(screen.getByPlaceholderText(/组织你的回答/), { target: { value: "宏任务微任务顺序…" } });
    fireEvent.click(screen.getByText("📤 提交回答"));
    await waitFor(() => expect(screen.getByText(/面试官点评：思路清晰/)).toBeTruthy());
    expect(screen.getAllByText(/^第 2 轮/).length).toBeGreaterThan(0); // 标题 + 日志均指向第 2 轮
    expect(screen.getByText(/那微任务队列呢/)).toBeTruthy();
  });

  it("面试结束：invEnd → 复盘报告显示", async () => {
    window.kanban.invAnswer = vi.fn().mockResolvedValue({ ...ANSWER_RESP, finished: true });
    render(<InterviewPanel />);
    fireEvent.click(screen.getByText("🚀 开始面试"));
    await waitFor(() => expect(screen.getByText(/讲讲事件循环/)).toBeTruthy());
    fireEvent.change(screen.getByPlaceholderText(/组织你的回答/), { target: { value: "回答内容" } });
    fireEvent.click(screen.getByText("📤 提交回答"));
    await waitFor(() => expect(screen.getByText(/📋 面试复盘/)).toBeTruthy());
    expect(screen.getByText(/复盘报告/)).toBeTruthy();
  });

  it("计时器：进入会话后显示 ⏱ 计时", async () => {
    render(<InterviewPanel />);
    fireEvent.click(screen.getByText("🚀 开始面试"));
    await waitFor(() => expect(screen.getByText(/讲讲事件循环/)).toBeTruthy());
    expect(screen.getByText(/⏱ 0:0\d/)).toBeTruthy();
  });

  it("语音作答按钮存在（MediaRecorder 链路由真实环境验证）", async () => {
    render(<InterviewPanel />);
    fireEvent.click(screen.getByText("🚀 开始面试"));
    await waitFor(() => expect(screen.getByText(/讲讲事件循环/)).toBeTruthy());
    expect(screen.getByText("🎤 语音作答")).toBeTruthy();
  });
});
