// tests/panel-import-jsdom.test.mjs —— 面板「📥 导入面经」流程 jsdom 测试
// 覆盖：打开弹窗 → 填写 → 提交 → 请求 /api/output/import；空校验；关闭
import test from "node:test";
import assert from "node:assert/strict";
import { withPanel, tick } from "./panel-helper.mjs";

test("导入面经：按钮打开弹窗 → 填写提交 → 请求导入 API", async () => {
  await withPanel(async ({ window, calls }) => {
    const openBtn = window.document.getElementById("crawl-import");
    assert.ok(openBtn, "导入按钮存在");
    openBtn.click();
    await tick(10);
    const overlay = window.document.getElementById("import-overlay");
    assert.ok(!overlay.classList.contains("hidden"), "弹窗打开");
    // 填写
    window.document.getElementById("import-title").value = "字节前端一面面经";
    window.document.getElementById("import-source").value = "https://example.com/post/1";
    window.document.getElementById("import-content").value = "事件循环是 JS 异步的核心，微任务在宏任务结束后清空……";
    window.document.getElementById("import-save").click();
    await tick(60);
    const imp = calls.find((c) => c.url.includes("/api/output/import"));
    assert.ok(imp, "应请求导入 API");
    assert.equal(imp.method, "POST");
  });
});

test("导入校验：标题或内容为空 → 提示不请求", async () => {
  await withPanel(async ({ window, calls }) => {
    window.document.getElementById("crawl-import").click();
    await tick(10);
    window.document.getElementById("import-content").value = "只有内容没有标题";
    window.document.getElementById("import-save").click();
    await tick(30);
    assert.ok(!calls.find((c) => c.url.includes("/api/output/import")), "空标题不请求");
    const status = window.document.getElementById("import-status").textContent;
    assert.ok(status.includes("不能为空"), "提示错误");
  });
});

test("导入弹窗：✕ 关闭", async () => {
  await withPanel(async ({ window }) => {
    window.document.getElementById("crawl-import").click();
    await tick(10);
    window.document.getElementById("import-close").click();
    await tick(10);
    assert.ok(window.document.getElementById("import-overlay").classList.contains("hidden"), "关闭后隐藏");
  });
});
