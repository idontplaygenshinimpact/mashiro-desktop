// tool-policy.mjs 单测：工具策略分层（override > profile > default > builtin）+ 过滤/校验/序列化
import { test } from "node:test";
import assert from "node:assert/strict";
import { createToolPolicy, deserialize, DEFAULT_PROFILES } from "../lib/tool-policy.mjs";

/** 工具定义辅助：统一 OpenAI/DeepSeek function calling 格式 */
const fn = (name) => ({ type: "function", function: { name } });

// 一个便于断言分层的策略：default(base_tool=allow, shared=confirm) + focus(shared=deny, focus_only=allow)
function mkPolicy(overrides = {}) {
  return createToolPolicy({
    profiles: {
      default: { base_tool: "allow", shared: "confirm" },
      focus: { shared: "deny", focus_only: "allow" },
    },
    overrides,
  });
}

// ---------- 1. effectiveLevel 优先级：override > profile > default > builtin ----------
test("effectiveLevel 优先级：override > profile > default > builtin fallback", () => {
  const p = mkPolicy({ shared: "allow" }); // override shared=allow（覆盖 focus=deny / default=confirm）

  const byOverride = p.effectiveLevel("shared", { activeProfile: "focus" });
  assert.equal(byOverride.level, "allow");
  assert.equal(byOverride.source, "override");

  const byProfile = p.effectiveLevel("focus_only", { activeProfile: "focus" });
  assert.equal(byProfile.level, "allow");
  assert.equal(byProfile.source, "profile");

  const byDefault = p.effectiveLevel("base_tool");
  assert.equal(byDefault.level, "allow");
  assert.equal(byDefault.source, "default");

  const byBuiltin = p.effectiveLevel("totally_unknown_tool");
  assert.equal(byBuiltin.level, "confirm");
  assert.equal(byBuiltin.source, "builtin");
});

// ---------- 2. filterTools：deny 剔除 / confirm 保留 / 计数 / 原数组不变 ----------
test("filterTools：deny 剔除、confirm 保留、hiddenCount 正确、原数组不变", () => {
  const p = createToolPolicy({
    profiles: { default: { keep_allow: "allow", keep_confirm: "confirm", drop: "deny" } },
  });
  const tools = [
    fn("keep_allow"),
    { name: "keep_confirm" }, // 纯 { name } 格式也能识别
    fn("drop"),
    fn("unknown_x"), // 未配置 → builtin confirm → 保留
  ];
  const original = JSON.parse(JSON.stringify(tools));

  const r = p.filterTools(tools);
  const names = (arr) => arr.map((t) => t.function?.name ?? t.name);

  assert.deepEqual(names(r.allowed), ["keep_allow", "keep_confirm", "unknown_x"]);
  assert.deepEqual(names(r.hidden), ["drop"]);
  assert.equal(r.hiddenCount, 1);
  assert.equal(r.hiddenCount, r.hidden.length);
  assert.deepEqual(tools, original, "原数组不被修改");
});

// ---------- 3. focus profile 隐藏浏览类工具 ----------
test("focus profile 隐藏 web_search/fetch_page/search_posts", () => {
  const p = createToolPolicy({}); // 用 DEFAULT_PROFILES
  const tools = ["web_search", "fetch_page", "search_posts", "search_knowledge"].map(fn);
  const r = p.filterTools(tools, { activeProfile: "focus" });
  const hiddenNames = r.hidden.map((t) => t.function.name);

  assert.deepEqual(hiddenNames.sort(), ["fetch_page", "search_posts", "web_search"]);
  assert.equal(r.hiddenCount, 3);
  assert.ok(r.allowed.some((t) => t.function.name === "search_knowledge"), "search_knowledge 仍可见（沿用 default）");
});

// ---------- 4. interview profile 只暴露面试相关工具 ----------
test("interview profile 隐藏非面试工具、保留面试工具", () => {
  const p = createToolPolicy({});
  const tools = ["search_knowledge", "start_interview", "submit_answer", "end_interview", "web_search"].map(fn);
  const r = p.filterTools(tools, { activeProfile: "interview" });
  const hiddenNames = r.hidden.map((t) => t.function.name);
  const allowedNames = r.allowed.map((t) => t.function.name);

  assert.ok(hiddenNames.includes("search_knowledge"), "search_knowledge 被隐藏");
  assert.ok(hiddenNames.includes("web_search"), "web_search 被隐藏");
  assert.equal(r.hiddenCount, 2);
  assert.ok(allowedNames.includes("start_interview"), "start_interview 可见");
  assert.deepEqual(allowedNames.sort(), ["end_interview", "start_interview", "submit_answer"]);
});

// ---------- 5. validate：结构非法 → errors；合法 → ok ----------
test("validate：非法结构返回 errors，合法返回 ok", () => {
  const badLevel = createToolPolicy({ profiles: { default: { bad_tool: "sometimes" } } });
  const r1 = badLevel.validate();
  assert.equal(r1.ok, false);
  assert.ok(r1.errors.some((e) => e.includes("bad_tool")));

  const badProfiles = createToolPolicy({ profiles: null });
  assert.equal(badProfiles.validate().ok, false);

  const badOverrides = createToolPolicy({ overrides: { x: "nope" } });
  assert.equal(badOverrides.validate().ok, false);

  const good = createToolPolicy({
    profiles: { default: { a: "allow", b: "deny" }, focus: { "*": "deny", a: "allow" } },
    overrides: { c: "confirm" },
  });
  const r4 = good.validate();
  assert.equal(r4.ok, true);
  assert.deepEqual(r4.errors, []);
});

// ---------- 6. serialize / deserialize 往返等价 ----------
test("serialize/deserialize 往返等价", () => {
  const p = createToolPolicy({
    profiles: { default: { a: "allow" }, focus: { "*": "deny", a: "allow" } },
    overrides: { b: "deny" },
  });
  const s = p.serialize();
  const q = p.deserialize(s);

  assert.equal(q.serialize(), s, "往返后序列化结果一致");
  assert.deepEqual(
    q.effectiveLevel("a", { activeProfile: "focus" }),
    p.effectiveLevel("a", { activeProfile: "focus" }),
    "往返后行为一致"
  );
  // 顶层 deserialize 同样可用
  assert.equal(deserialize(s).serialize(), s);
});

// ---------- 7. 未知工具 → confirm 兜底 + 不隐藏 ----------
test("未知工具 → confirm 兜底且不隐藏", () => {
  const p = createToolPolicy({});
  const lvl = p.effectiveLevel("brand_new_tool");
  assert.equal(lvl.level, "confirm");
  assert.equal(lvl.source, "builtin");

  const r = p.filterTools([fn("brand_new_tool")]);
  assert.equal(r.hiddenCount, 0);
  assert.equal(r.allowed.length, 1);
});

// ---------- 附加：DEFAULT_PROFILES 预置符合规格 ----------
test("DEFAULT_PROFILES 预置：solve_question allow / record_interview_topics confirm / focus 拒绝项 / interview 通配", () => {
  assert.equal(DEFAULT_PROFILES.default.solve_question, "allow");
  assert.equal(DEFAULT_PROFILES.default.record_interview_topics, "confirm");
  const focusDenies = Object.entries(DEFAULT_PROFILES.focus)
    .filter(([, v]) => v === "deny")
    .map(([k]) => k)
    .sort();
  assert.deepEqual(focusDenies, ["fetch_page", "search_posts", "web_search"]);
  assert.equal(DEFAULT_PROFILES.interview["*"], "deny");
});
