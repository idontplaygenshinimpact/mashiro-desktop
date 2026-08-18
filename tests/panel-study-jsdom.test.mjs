// tests/panel-study-jsdom.test.mjs —— 学习清单前端全流程交互 jsdom 测试
// 覆盖用户主路径：清单渲染（状态流分组）→ 勾选完成 → 级别筛选 → 搜索 → 详情弹窗 →
// 追问 → 整理 → 归并 → 复习卡（显示答案/评级）→ 生成清单。
// 背景：主列表渲染后未绑定事件（点学习没反应）——本文件是完整护栏。
import test from "node:test";
import assert from "node:assert/strict";
import { withPanel, tick, SAMPLE_PLAN } from "./panel-helper.mjs";

test("清单渲染：状态流分组 + 学习按钮 + 折叠区", async () => {
  await withPanel(async ({ window }) => {
    await tick(60); // 等顶层 loadStudyPlan
    const list = window.document.getElementById("study-list");
    const items = list.querySelectorAll(".study-item");
    assert.equal(items.length, 3, "主列表 3 项（待学 2 + 学习中 1，已掌握进折叠区）");
    assert.ok(list.textContent.includes("待学习"), "状态组头");
    assert.ok(list.textContent.includes("学习中"), "学习中组头");
    assert.equal(list.querySelectorAll(".s-learn").length, 3, "每项都有学习按钮");
    const doneToggle = window.document.getElementById("study-done-toggle");
    assert.notEqual(doneToggle.style.display, "none", "已掌握折叠区显示（有 done 项）");
  });
});

test("勾选完成 → studyCheck 调用（内容正确）", async () => {
  await withPanel(async ({ window, kanban }) => {
    await tick(60);
    const calls = [];
    kanban.studyCheck = async (id, checked) => { calls.push({ id, checked }); return { ok: true }; };
    const firstCb = window.document.querySelector("#study-list .study-item input");
    firstCb.checked = true;
    firstCb.dispatchEvent(new window.Event("change", { bubbles: true }));
    await tick(60);
    assert.equal(calls.length, 1, "studyCheck 被调用");
    assert.equal(calls[0].checked, true);
    assert.ok(String(calls[0].id).length > 0);
  });
});

test("级别筛选 chips：点「进阶」→ 只显示进阶项", async () => {
  await withPanel(async ({ window }) => {
    await tick(60);
    const chip = window.document.querySelector(".study-lv-chip[data-lv='进阶']");
    assert.ok(chip, "进阶 chip 存在");
    chip.click();
    await tick(30);
    const items = window.document.querySelectorAll("#study-list .study-item");
    assert.equal(items.length, 1, "只剩进阶项");
    assert.ok(items[0].textContent.includes("性能优化实战"));
  });
});

test("搜索框：输入关键词 → 过滤清单", async () => {
  await withPanel(async ({ window }) => {
    await tick(60);
    const search = window.document.getElementById("study-search");
    assert.ok(search, "搜索框存在");
    search.value = "事件循环";
    search.dispatchEvent(new window.Event("input", { bubbles: true }));
    await tick(30);
    const items = window.document.querySelectorAll("#study-list .study-item");
    assert.equal(items.length, 1);
    assert.ok(items[0].textContent.includes("事件循环与微任务"));
  });
});

test("详情弹窗：打开 → 追问 → 整理（闭环交互）", async () => {
  await withPanel(async ({ window, kanban }) => {
    await tick(60);
    const appended = [];
    // 流式回调（与真实契约一致：onDelta 逐段推流）
    kanban.studyDetailAppend = async (id, q, onDelta) => { appended.push({ id, q }); onDelta?.("补充回答：Hooks 规则…"); return { ok: true }; };
    let consolidated = 0;
    kanban.studyConsolidate = async () => { consolidated++; return { ok: true, content: "整理后完整讲解" }; };
    // 打开弹窗
    window.document.querySelector("#study-list .s-learn").click();
    await tick(40);
    const overlay = window.document.getElementById("study-detail-overlay");
    assert.ok(!overlay.classList.contains("hidden"), "弹窗打开");
    // 追问
    window.document.getElementById("sd-ask-input").value = "Hooks 为什么不能写在条件里？";
    window.document.getElementById("sd-ask-btn").click();
    await tick(60);
    assert.equal(appended.length, 1, "追问提交给后端");
    assert.ok(appended[0].q.includes("Hooks"));
    assert.ok(window.document.getElementById("sd-modal-body").textContent.includes("补充回答"), "追问结果上屏");
    // 整理
    window.document.getElementById("sd-consolidate-btn").click();
    await tick(60);
    assert.equal(consolidated, 1, "整理按钮调用后端");
  });
});

test("归并模式：进入批量 → 勾选 2 项 → 确认归并（≥2 才触发）", async () => {
  await withPanel(async ({ window }) => {
    await tick(60);
    const clusterBtn = window.document.getElementById("study-cluster-btn");
    assert.ok(clusterBtn, "批量按钮存在");
    // 进入批量模式
    clusterBtn.click();
    await tick(40);
    assert.ok(clusterBtn.textContent.includes("确认归并"), "按钮切到确认归并");
    // 勾选 2 项（clusterMode 下 checkbox 用于归并选择）
    const cbs = [...window.document.querySelectorAll("#study-list .study-item input")];
    assert.ok(cbs.length >= 2);
    for (const cb of cbs.slice(0, 2)) {
      cb.checked = true;
      cb.dispatchEvent(new window.Event("change", { bubbles: true }));
    }
    await tick(20);
    assert.ok(clusterBtn.textContent.includes("(2)"), "计数更新");
    // 确认归并 → 弹窗打开
    clusterBtn.click();
    await tick(60);
    const overlay = window.document.getElementById("study-detail-overlay");
    assert.ok(!overlay.classList.contains("hidden"), "归并结果弹窗打开");
  });
});

test("归并不足 2 项 → 不触发（提示）", async () => {
  await withPanel(async ({ window, kanban }) => {
    await tick(60);
    const clusterBtn = window.document.getElementById("study-cluster-btn");
    clusterBtn.click();
    await tick(30);
    clusterBtn.click(); // 未勾选直接确认
    await tick(30);
    const overlay = window.document.getElementById("study-detail-overlay");
    assert.ok(overlay.classList.contains("hidden"), "弹窗不应打开");
  });
});

test("复习卡：到期卡片显示 → 显示答案 → 评级提交", async () => {
  // override 在 eval 前生效；loadReview 只在切到「复习」Tab 时触发（switchTab 按需加载）
  await withPanel(async ({ window, kanban }) => {
    window.document.querySelector('.tab[data-tab="review"]').click();
    await tick(80);
    const card = window.document.getElementById("review-card");
    assert.ok(!card.classList.contains("hidden"), "复习卡容器显示");
    const topic = window.document.getElementById("rc-topic");
    assert.ok(topic.textContent.includes("事件循环"), "复习卡显示主题");
    // 显示答案
    const show = window.document.getElementById("rc-show");
    show.click();
    await tick(10);
    const answerBox = window.document.getElementById("rc-answer");
    assert.ok(!answerBox.classList.contains("hidden"), "答案区显示");
    assert.ok(answerBox.textContent.includes("宏任务微任务"), "答案内容上屏");
    // 评级（Good=3）
    const ratings = [];
    kanban.reviewSubmit = async (id, rating) => { ratings.push({ id, rating }); return { ok: true, nextDue: "2026-02-01", emotion: "" }; };
    const goodBtn = window.document.querySelector(".rc-btn[data-rating='3']");
    assert.ok(goodBtn, "评级按钮存在");
    goodBtn.click();
    await tick(60);
    assert.equal(ratings.length, 1, "评级提交");
    assert.equal(ratings[0].rating, 3);
    assert.equal(ratings[0].id, "c1");
  }, {
    reviewDue: async () => ({
      ok: true,
      due: [{ id: "c1", topic: "事件循环", question: "讲一下事件循环", answer: "宏任务微任务…", history: [], nextDue: "2026-01-01" }],
      stats: { total: 5, due: 1, todayDone: 0 }, trend: { trend: [], streak: 0 }, todayReviewed: [],
    }),
  });
});

test("生成清单按钮 → studyGenerate 调用", async () => {
  await withPanel(async ({ window, kanban }) => {
    await tick(60);
    let generated = 0;
    kanban.studyGenerate = async () => { generated++; return { ok: true, items: [], note: "" }; };
    window.document.getElementById("study-gen").click();
    await tick(40);
    assert.equal(generated, 1, "生成清单按钮触发后端");
  });
});

test("空清单 → 引导文案显示（不崩）", async () => {
  await withPanel(async ({ window }) => {
    await tick(60);
    const list = window.document.getElementById("study-list");
    assert.ok(list.textContent.includes("未生成"), "空态引导文案");
    assert.ok(list.textContent.includes("生成清单"), "提示点生成");
  }, { studyPlan: { ok: true, plan: { items: [] } } });
});
