// tests/panel-study-jsdom.test.mjs —— 学习清单前端全流程交互 jsdom 测试
// 覆盖用户主路径：清单渲染（状态流分组）→ 勾选完成 → 级别筛选 → 搜索 → 详情弹窗 →
// 追问 → 整理 → 归并 → 复习卡（显示答案/评级）→ 生成清单。
// 背景：主列表渲染后未绑定事件（点学习没反应）——本文件是完整护栏。
import test from "node:test";
import assert from "node:assert/strict";
import { withPanel, tick } from "./panel-helper.mjs";

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

test("竞态防护：快速切换讲解条目，旧流内容不得渲染进新弹窗/污染新缓存", async () => {
  await withPanel(async ({ window, kanban }) => {
    await tick(60);
    // 手动控制每个流的 onChunk（先不推内容，模拟 LLM 慢生成）
    const streams = {}; // itemId -> onChunk
    kanban.studyDetailStream = async (id, onChunk) => {
      streams[id] = onChunk;
      return new Promise(() => {}); // 永不 resolve：由测试手动触发
    };
    const items = [...window.document.querySelectorAll("#study-list .s-learn")];
    assert.ok(items.length >= 2, "至少 2 个可讲解条目");
    const idA = items[0].closest(".study-item").dataset.id;
    const idB = items[1].closest(".study-item").dataset.id;
    // 打开 A → 立刻切到 B（模拟快速点击两个讲解）
    items[0].click();
    await tick(30);
    items[1].click();
    await tick(30);
    // 旧流 A 此刻才到达内容 → 必须被代际丢弃
    streams[idA]("【A 的讲解内容：比较版本号】");
    await tick(30);
    const body = window.document.getElementById("sd-modal-body");
    assert.ok(!body.textContent.includes("A 的讲解内容"), "过期流 A 不得渲染进当前弹窗（曾串成'比较版本号'内容）");
    // 新流 B 到达 → 正常渲染
    streams[idB]("【B 的讲解内容：第K大元素】");
    await tick(30);
    assert.ok(body.textContent.includes("B 的讲解内容"), "当前流 B 正常渲染");
    assert.ok(!body.textContent.includes("A 的讲解内容"), "弹窗不得混入 A 内容");
    // 关闭弹窗后，残留流也不得渲染（代际再次推进）
    window.document.getElementById("sd-modal-close").click();
    streams[idB]("【B 的迟到内容】");
    await tick(30);
    assert.ok(!body.textContent.includes("B 的迟到内容"), "关闭后到达的流内容不得上屏");
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
  await withPanel(async ({ window, kanban: _kanban }) => {
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

test("复习卡空答案：显示答案回退讲解存档（fetch /api/study/note，不触发 LLM）", async () => {
  await withPanel(async ({ window }) => {
    window.document.querySelector('.tab[data-tab="review"]').click();
    await tick(80);
    // answer 为空的卡 + mock /api/study/note 返回讲解存档
    window.fetch = async () => ({ ok: true, json: async () => ({ ok: true, found: true, content: "讲解存档：事件循环结论/原理/实现/边界" }) });
    window.document.getElementById("rc-show").click();
    await tick(30);
    const answerBox = window.document.getElementById("rc-answer");
    assert.ok(!answerBox.classList.contains("hidden"), "答案区显示");
    assert.ok(answerBox.textContent.includes("讲解存档"), "回退显示讲解存档内容");
    assert.ok(answerBox.textContent.includes("来自讲解存档"), "标注来源");
  }, {
    reviewDue: async () => ({
      ok: true,
      due: [{ id: "c2", topic: "事件循环", question: "讲一下事件循环", answer: "", history: [], nextDue: "2026-01-01" }],
      stats: { total: 5, due: 1, todayDone: 0 }, trend: { trend: [], streak: 0 }, todayReviewed: [],
    }),
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
    // 默答引导说明（简答题干的定位）
    assert.ok(window.document.getElementById("rc-question").innerHTML.includes("先默答"), "默答引导文案存在");
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

test("复习卡「⏭ 跳过」：不评分、放回队尾、切换到下一张", async () => {
  await withPanel(async ({ window, kanban }) => {
    window.document.querySelector('.tab[data-tab="review"]').click();
    await tick(80);
    const ratings = [];
    kanban.reviewSubmit = async (id, rating) => { ratings.push({ id, rating }); return { ok: true }; };
    const skip = window.document.getElementById("rc-skip");
    assert.ok(skip, "跳过按钮存在");
    assert.doesNotThrow(() => skip.click());
    await tick(30);
    assert.equal(ratings.length, 0, "跳过不触发评级");
    // 单卡场景：跳过放回队尾 → 仍是同一张（无其他卡）
    const topic = window.document.getElementById("rc-topic");
    assert.ok(topic.textContent.includes("事件循环"), "跳过仍显示卡（队列尾部）");
  }, {
    reviewDue: async () => ({
      ok: true,
      due: [{ id: "c1", topic: "事件循环", question: "讲一下事件循环", answer: "宏任务微任务…", history: [], nextDue: "2026-01-01" }],
      stats: { total: 5, due: 1, todayDone: 0 }, trend: { trend: [], streak: 0 }, todayReviewed: [],
    }),
  });
});

test("选择题已选状态：切 Tab 回来不丢失（loadCardQuiz 同卡跳过重载）", async () => {
  await withPanel(async ({ window }) => {
    // 提供复习选择题数据（loadCardQuiz 走 fetch /api/review/quiz）
    const origFetch = window.fetch;
    window.fetch = async (url, opts) => {
      const u = String(url);
      if (u.includes("/api/review/quiz?id=")) {
        return { ok: true, json: async () => ({ ok: true, questions: [{ id: "q1", cardId: "c1", question: "事件循环先执行宏任务还是微任务？", options: ["宏任务", "微任务", "都不对", "看情况"], rightIndex: 1 }] }) };
      }
      return origFetch(url, opts);
    };
    window.document.querySelector('.tab[data-tab="review"]').click();
    await tick(80);
    // 等选择题渲染并选一个选项
    await tick(60);
    const opt = window.document.querySelector("#rc-quiz .quiz-opt");
    assert.ok(opt, "选择题选项存在");
    opt.click();
    await tick(10);
    assert.ok(opt.classList.contains("picked"), "选项已选中");
    // 切到别的 Tab 再切回 → 复习卡重载 → 选择题不应重置（同卡跳过重载）
    window.document.querySelector('.tab[data-tab="chat"]').click();
    await tick(30);
    window.document.querySelector('.tab[data-tab="review"]').click();
    await tick(80);
    const picked = window.document.querySelector("#rc-quiz .quiz-opt.picked");
    assert.ok(picked, "切页后已选状态保留（此前重载清空）");
    assert.equal(picked.textContent, opt.textContent, "同一选项仍选中");
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
