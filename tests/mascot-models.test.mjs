// mascot-models 桌宠形象管理单测：扫描/当前/保存（临时目录隔离）
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let tmpDir;
before(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), "mascot-"));
  process.env.MIANSHI_MASCOT_MODEL = path.join(tmpDir, "mascot-model.json");
  // 造两个假模型包
  const zamp = path.join(tmpDir, "live2d-widget-model-mashiro-zamp", "assets", "model", "Sakurasou", "mashiro");
  mkdirSync(zamp, { recursive: true });
  writeFileSync(path.join(zamp, "ryoufuku.model.json"), "{}");
  writeFileSync(path.join(zamp, "seifuku.model.json"), "{}");
  const shizuku = path.join(tmpDir, "live2d-widget-model-shizuku", "assets");
  mkdirSync(shizuku, { recursive: true });
  writeFileSync(path.join(shizuku, "shizuku.model.json"), "{}");
  // 无关目录不匹配
  mkdirSync(path.join(tmpDir, "some-other-pkg"), { recursive: true });
  writeFileSync(path.join(tmpDir, "some-other-pkg", "x.model.json"), "{}");
});
after(() => { delete process.env.MIANSHI_MASCOT_MODEL; rmSync(tmpDir, { recursive: true, force: true }); });

test("scanMascotModels：只扫 live2d-widget-model-* 包，形象名映射（旅行装/水手服）", async () => {
  const { scanMascotModels } = await import("../lib/mascot-models.mjs");
  const list = scanMascotModels(tmpDir);
  assert.equal(list.length, 3, "zamp 2 个 + shizuku 1 个");
  assert.ok(list.some((m) => m.name === "真白·旅行装"), "ryoufuku → 真白·旅行装");
  assert.ok(list.some((m) => m.name === "真白·水手服"), "seifuku → 真白·水手服");
  assert.ok(list.some((m) => m.name === "shizuku"), "shizuku 包名直用");
  for (const m of list) {
    assert.ok(m.path.endsWith(".model.json"), "path 指向 model.json");
    assert.ok(m.path.startsWith(tmpDir), "path 在扫描根内");
  }
});

test("getCurrentModel：无保存 → 返回第一个；有保存 → 返回保存的", async () => {
  const { scanMascotModels, getCurrentModel } = await import("../lib/mascot-models.mjs");
  const list = scanMascotModels(tmpDir);
  // 未保存 → 默认第一个（真白·旅行装排序在前）
  const def = getCurrentModel(list);
  assert.ok(def.endsWith("ryoufuku.model.json"), "默认旅行装");
});

test("saveCurrentModel + getCurrentModel 往返", async () => {
  const { scanMascotModels, getCurrentModel, saveCurrentModel } = await import("../lib/mascot-models.mjs");
  const list = scanMascotModels(tmpDir);
  const seifuku = list.find((m) => m.name === "真白·水手服");
  assert.equal(saveCurrentModel(seifuku.path), true);
  assert.equal(getCurrentModel(list), seifuku.path, "保存后读回水手服");
});
