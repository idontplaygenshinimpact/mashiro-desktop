## 改动摘要

（一句话说明这个 PR 做了什么、为什么。）

## 关联 Issue

Fixes #____

## 改动清单

- [ ] 功能/修复：________
- [ ] 测试：________（新增/修改的测试文件与用例）
- [ ] 文档：________（README / CONTRIBUTING / docs）

## 测试验证

- [ ] `npm test` 全绿（725+ 用例）
- [ ] `npm run lint` 无错误
- [ ] `npm run typecheck` 通过
- [ ] 涉及渲染层：`npm run check:renderer` 通过（改 renderer 源码后需先 `npm run build:renderer`）

## 截图（涉及面板 UI 时）

（可选）

## 数据安全自查

- [ ] 改动不涉及真实数据路径，或已用临时目录隔离（`MIANSHI_DB_PATH` / `MIANSHI_OUTPUT_DIR`）
- [ ] 外部内容进 LLM 上下文已走 `sanitizeExternal().wrapped`（提示注入防护）
- [ ] 新增网络抓取已走 `lib/fetch-page.mjs`（SSRF 防护）
