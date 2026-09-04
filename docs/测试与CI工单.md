# 测试与 CI 工单（评估报告 M1/M8 + L5 + 沙箱测试缺口）

> 背景：项目全面评估报告-2026-09 测试维度 8/10——1021 用例（986 单元 + 35 集成）实测全绿，但 `npm test` 首次运行 flaky（963/964 并发崩溃，`&&` 短路跳过集成阶段 exit 1）、skip pattern 失效、判题沙箱两条逃逸路径零测试（两个真实漏洞因此漏网）、集成测试写真实目录。

---

## 一、问题清单

| # | 问题 | 位置 | 影响 |
|---|---|---|---|
| M1 | `npm test` flaky：`--test-skip-pattern "integration"` 实测**没有**跳过 integration-widget；并发下 `uncaughtException: Unable to deserialize cloned data` 崩溃 | `package.json:35`、`tests/integration-widget.test.mjs` | CI 偶发红，时间黑洞 |
| — | 判题沙箱测试缺口：只测 exit/env 遮蔽，未覆盖 `process.getBuiltinModule` 逃逸和断言伪造 | `tests/sandbox.test.mjs` | S2/S3 两个真实漏洞漏网 |
| M8 | 集成测试写真实 output 目录 | `tests/integration-widget.test.mjs:316-327` | 污染真实产出 |
| L5 | lint 1 error：`no-useless-assignment` | `skills/project-eval/skill.mjs:65` | 门禁红 |
| — | mock 队列静默空响应：`queue.shift() ?? ""` | `tests/helpers.mjs:77` | 队列多/少消费时静默返回空串，可能"假绿" |
| — | 覆盖缺口：`chrome-cookies.mjs`/`win-toast.mjs`/`edge-session.mjs`/`speech-worker.mjs`/`eval-scoring.mjs` 零测试；`mcp-server.mjs` 只有客户端测试 | lib/ | 安全面无护栏 |

## 二、任务

### 任务 1：修 flaky + skip pattern（0.5 天）

```
① 修 skip 机制：--test-skip-pattern 改为文件级 test.skip 或独立 npm script
   （integration-widget 与单元阶段隔离，串行跑）
② 集成测试改临时目录（tests/integration-widget.test.mjs:316-327 用 setupTempDb 同款临时目录）
③ 排查 "Unable to deserialize cloned data"：并发 worker 共享资源隔离
```

### 任务 2：补沙箱逃逸测试（与安全工单任务 2 配套）

```
tests/sandbox.test.mjs 追加：
① getBuiltinModule 逃逸路径：判题代码尝试 process.getBuiltinModule('fs') → 被拒/不可用
② 断言伪造路径：userCode 调用 __mashiroAssert9f3a__(true,"fake") → 不生效（PASS 必须真实通过）
③ 回归：exit/env 遮蔽原有用例保持通过
```

### 任务 3：补安全模块测试 + 修 lint

```
① 补 win-toast（注入用例：特殊字符/引号不逃逸）、chrome-cookies（解密失败不静默）、
   eval-scoring（A/B 评分一致性）最小用例集
② skills/project-eval/skill.mjs:65 修 no-useless-assignment
③ helpers.mjs:77 mock 队列空时抛错（防假绿）——或显式断言队列消费完
```

## 三、验收

```
① npm test 连续 3 次干净运行全绿（986 单元 + 35 集成，无 flaky）
② --test-skip-pattern "integration" 确实跳过 integration-widget
③ 沙箱逃逸两条路径有测试且通过（配合安全工单修复后）
④ npm run lint 0 error
⑤ 集成测试不写真实 output 目录
```
