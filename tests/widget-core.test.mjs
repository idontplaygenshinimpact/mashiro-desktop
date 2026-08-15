// widget-core.mjs 单测：覆盖 token 认证 + 爬取互斥等原先只能靠 HTTP 集成测试间接覆盖的核心逻辑
// 全部为纯逻辑 + fake fs/req/res，无网络、无 server、无真实文件副作用
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  scanNewestFiles,
  latestOutputs,
  loadOrCreateToken,
  checkBearerAuth,
  buildHealthPayload,
  readBody,
  createCrawlMutex,
} from "../lib/widget-core.mjs";

// ---------- 工具 ----------
function makeDirents(names) {
  return names.map((name) => ({ name, isDirectory: () => true }));
}

function makeFileFs({ dirs = [], files = {}, stat = {}, exists = true } = {}) {
  const readdirSync = (p, opts) => {
    if (opts && opts.withFileTypes) return dirs;
    // 内层按目录名取文件名列表
    const dirName = p.split(/[\\/]/).pop();
    return files[dirName] || [];
  };
  const statSync = (fp) => {
    const file = fp.split(/[\\/]/).pop();
    if (stat[file] && stat[file] instanceof Error) throw stat[file];
    return { mtime: stat[file] || new Date(0) };
  };
  return { existsSync: () => exists, readdirSync, statSync };
}

function fakeReqRes() {
  const listeners = { data: [], end: [] };
  const req = {
    destroyed: false,
    on: (ev, fn) => { (listeners[ev] || (listeners[ev] = [])).push(fn); },
    destroy: () => { req.destroyed = true; },
    emit: (ev, ...args) => { for (const fn of listeners[ev] || []) fn(...args); },
  };
  const res = {
    status: null,
    headers: null,
    body: null,
    writeHead: (status, headers) => { res.status = status; res.headers = headers; },
    end: (body) => { res.body = body; },
  };
  return { req, res };
}

// ---------- scanNewestFiles ----------
test("scanNewestFiles: 目录不存在 → 返回 []", () => {
  const fs = {
    existsSync: () => false,
    readdirSync: () => { throw new Error("不应被调用"); },
    statSync: () => { throw new Error("不应被调用"); },
  };
  assert.deepEqual(scanNewestFiles(20, "/nope", fs), []);
});

test("scanNewestFiles: 扫描中文件被删除(ENOENT) → 跳过并返回剩余", () => {
  const err = new Error("ENOENT: no such file");
  err.code = "ENOENT";
  const fs = makeFileFs({
    dirs: makeDirents(["2024_discover"]),
    files: { "2024_discover": ["01_公司A_题1.md", "02_公司B_题2.md"] },
    stat: {
      "01_公司A_题1.md": err,
      "02_公司B_题2.md": new Date("2024-01-02T00:00:00Z"),
    },
  });
  const out = scanNewestFiles(20, "/out", fs);
  assert.equal(out.length, 1);
  assert.equal(out[0].file, "02_公司B_题2.md");
});

test("scanNewestFiles: 按 mtime 倒序（最新在前）", () => {
  const fs = makeFileFs({
    dirs: makeDirents(["x_discover"]),
    files: { x_discover: ["new.md", "old.md", "mid.md"] },
    stat: {
      "new.md": new Date("2024-03-01T00:00:00Z"),
      "mid.md": new Date("2024-02-01T00:00:00Z"),
      "old.md": new Date("2024-01-01T00:00:00Z"),
    },
  });
  const out = scanNewestFiles(20, "/out", fs);
  assert.deepEqual(out.map((f) => f.file), ["new.md", "mid.md", "old.md"]);
});

test("scanNewestFiles: 跳过 study_notes / 00_ 索引 / 非 md / 应用 limit", () => {
  const fs = makeFileFs({
    dirs: makeDirents(["a_discover", "study_notes"]),
    files: {
      a_discover: ["00_README.md", "01_real.md", "02_real.md", "notes.txt"],
      study_notes: ["x.md"],
    },
    stat: {
      "01_real.md": new Date("2024-01-02T00:00:00Z"),
      "02_real.md": new Date("2024-01-01T00:00:00Z"),
      "x.md": new Date("2024-02-01T00:00:00Z"),
      "00_README.md": new Date("2024-03-01T00:00:00Z"),
    },
  });
  const out = scanNewestFiles(1, "/out", fs);
  assert.equal(out.length, 1);
  assert.equal(out[0].file, "01_real.md");
});

// ---------- latestOutputs ----------
test("latestOutputs: 目录缺失 → []；存在时按 mtime 倒序取 limit", () => {
  const missingFs = { existsSync: () => false, readdirSync: () => { throw new Error("no"); }, statSync: () => { throw new Error("no"); } };
  assert.deepEqual(latestOutputs(12, "/nope", missingFs), []);

  const fs = makeFileFs({
    dirs: makeDirents(["b", "a"]),
    stat: {
      b: new Date("2024-01-02T00:00:00Z"),
      a: new Date("2024-01-01T00:00:00Z"),
    },
  });
  const out = latestOutputs(1, "/out", fs);
  assert.equal(out.length, 1);
  assert.equal(out[0].dir, "b");
});

// ---------- loadOrCreateToken ----------
test("loadOrCreateToken: 已有有效文件 → 返回其 token", () => {
  let wrote = false;
  const token = loadOrCreateToken("/tmp/w.json", {
    randomUUID: () => "gen",
    existsSync: () => true,
    readFileSync: () => JSON.stringify({ token: "existing-token", ts: 123 }),
    writeFileSync: () => { wrote = true; },
    mkdirSync: () => {},
  });
  assert.equal(token, "existing-token");
  assert.equal(wrote, false, "已有有效 token 不应重写文件");
});

test("loadOrCreateToken: 文件缺失 → 生成 UUID 并写盘", () => {
  let written = null;
  const token = loadOrCreateToken("/tmp/w.json", {
    randomUUID: () => "gen-uuid",
    existsSync: () => false,
    readFileSync: () => { throw new Error("no"); },
    writeFileSync: (file, data) => { written = { file, data }; },
    mkdirSync: () => {},
  });
  assert.equal(token, "gen-uuid");
  assert.equal(written.file, "/tmp/w.json");
  assert.equal(JSON.parse(written.data).token, "gen-uuid");
});

test("loadOrCreateToken: JSON 损坏 → 重新生成", () => {
  const token = loadOrCreateToken("/tmp/w.json", {
    randomUUID: () => "regenerated",
    existsSync: () => true,
    readFileSync: () => "{corrupt json",
    writeFileSync: () => {},
    mkdirSync: () => {},
  });
  assert.equal(token, "regenerated");
});

test("loadOrCreateToken: token 为空字符串 → 重新生成", () => {
  const token = loadOrCreateToken("/tmp/w.json", {
    randomUUID: () => "regenerated2",
    existsSync: () => true,
    readFileSync: () => JSON.stringify({ token: "" }),
    writeFileSync: () => {},
    mkdirSync: () => {},
  });
  assert.equal(token, "regenerated2");
});

// ---------- checkBearerAuth ----------
test("checkBearerAuth: 正确 Bearer → true", () => {
  assert.equal(checkBearerAuth("Bearer my-token", "my-token"), true);
});
test("checkBearerAuth: 缺失 header → false", () => {
  assert.equal(checkBearerAuth(undefined, "my-token"), false);
  assert.equal(checkBearerAuth("", "my-token"), false);
});
test("checkBearerAuth: 错误 token → false", () => {
  assert.equal(checkBearerAuth("Bearer wrong", "my-token"), false);
});
test("checkBearerAuth: 非 Bearer 前缀 → false", () => {
  assert.equal(checkBearerAuth("Basic my-token", "my-token"), false);
});
test("checkBearerAuth: 多余空格 → false（精确匹配）", () => {
  assert.equal(checkBearerAuth("Bearer  my-token", "my-token"), false);
  assert.equal(checkBearerAuth(" Bearer my-token", "my-token"), false);
});

// ---------- buildHealthPayload ----------
test("buildHealthPayload: db 正常/异常 → 形状 {ok, db, uptime, port}", () => {
  assert.deepEqual(buildHealthPayload(true, 42, 8899), { ok: true, db: true, uptime: 42, port: 8899 });
  assert.deepEqual(buildHealthPayload(false, 0, 8899), { ok: true, db: false, uptime: 0, port: 8899 });
});

// ---------- readBody ----------
test("readBody: 小于上限 → cb 收到完整 body，且不写响应", () => {
  const { req, res } = fakeReqRes();
  let got = null;
  readBody(req, res, (b) => { got = b; });
  req.emit("data", Buffer.from('{"a":1}'));
  req.emit("end");
  assert.equal(got, '{"a":1}');
  assert.equal(res.status, null, "正常路径不应写响应");
});

test("readBody: 超限 → 413 + destroy + 不调 cb", () => {
  const { req, res } = fakeReqRes();
  let called = false;
  readBody(req, res, () => { called = true; }, 10);
  req.emit("data", Buffer.from("12345678901")); // 11 bytes > 10
  req.emit("end");
  assert.equal(res.status, 413);
  assert.equal(res.headers["Content-Type"], "application/json");
  assert.ok(req.destroyed, "超限应销毁连接");
  assert.equal(called, false, "超限不应回调 cb");
});

test("readBody: 恰好等于上限 → 正常 cb（不 413）", () => {
  const { req, res } = fakeReqRes();
  let got = null;
  readBody(req, res, (b) => { got = b; }, 10);
  req.emit("data", Buffer.from("1234567890")); // 恰好 10
  req.emit("end");
  assert.equal(got, "1234567890");
  assert.equal(res.status, null);
});

test("readBody: 分块累计超限 → 只 413 一次，后续 data 忽略", () => {
  const { req, res } = fakeReqRes();
  let calls = 0;
  readBody(req, res, () => { calls++; }, 10);
  req.emit("data", Buffer.from("12345"));
  req.emit("data", Buffer.from("67890")); // 累计 10，未超
  req.emit("data", Buffer.from("1"));     // 累计 11 → 超限
  req.emit("data", Buffer.from("999"));   // 已 overflow，忽略
  req.emit("end");
  assert.equal(res.status, 413);
  assert.ok(req.destroyed);
  assert.equal(calls, 0);
});

// ---------- createCrawlMutex ----------
test("createCrawlMutex: begin 期间 isRunning=true，结束后清除", async () => {
  const m = createCrawlMutex();
  let inside = false;
  const r = await m.begin(async () => {
    inside = m.isRunning();
    await new Promise((resolve) => setTimeout(resolve, 10));
    return "done";
  });
  assert.equal(inside, true);
  assert.equal(r, "done");
  assert.equal(m.isRunning(), false);
});

test("createCrawlMutex: 运行中二次 begin → false 且不执行 fn", async () => {
  const m = createCrawlMutex();
  let secondRan = false;
  let release;
  const first = m.begin(async () => { await new Promise((r) => { release = r; }); return true; });
  // 等 first 真正进入运行态（置 running=true）
  await new Promise((r) => setTimeout(r, 0));
  const second = await m.begin(async () => { secondRan = true; return true; });
  assert.equal(second, false);
  assert.equal(secondRan, false, "运行中不应执行第二个 fn");
  release();
  assert.equal(await first, true);
  assert.equal(m.isRunning(), false);
});

test("createCrawlMutex: fn 抛错 → 仍清除 running（可重入）", async () => {
  const m = createCrawlMutex();
  await assert.rejects(() => m.begin(async () => { throw new Error("boom"); }));
  assert.equal(m.isRunning(), false);
  // 抛错后可再次 begin 正常执行
  const r = await m.begin(async () => "ok");
  assert.equal(r, "ok");
  assert.equal(m.isRunning(), false);
});
