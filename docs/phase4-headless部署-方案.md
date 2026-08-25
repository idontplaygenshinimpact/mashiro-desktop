# Phase 4 技术方案：Headless 服务化与云部署（部署闭环）

> 目标：把项目从"仅桌面发布"补成"**桌面发布 + 云端 Agent 服务**双闭环"，落地 `独立开发 → 按需构建 → 运维部署` 的完整链路。
> 可行性已证实（台账 §4）：**lib/ 与 plugins/ 对 Electron/koffi 零依赖**，widget（HTTP）+ MCP（stdio）+ agent 核心是纯 Node，无需重写逻辑，只需工程接线。

---

## 1. 现状与目标

**现状（已核实）**：
- 桌面发布闭环**已有**：tag `v*` → CI 质量门禁 → electron-builder（nsis+portable）→ GitHub Release + npm Packages（release.yml）
- widget 服务：纯 Node HTTP，127.0.0.1:8899，Bearer 鉴权，`/api/health` 免认证，可用 `MIANSHI_PORT` 改端口；已在 Electron 主进程 spawn 下跑，**有独立守护器模型（widget-server.mjs）**
- MCP：stdio transport，9 工具，`bin/mashiro-mcp.mjs` 独立入口，数据目录 `~/.mashiro`，**已随 npm 包分发**
- 无 Dockerfile / render.yaml；`node-notifier` 在 widget.mjs:12 静态 import（Linux 容器需静默降级）；`MIANSHI_DISABLE_PATROL/BACKGROUND` 已有，无 `--headless` 开关

**目标形态（双轨）**：

```
轨 A：MCP 分发（已有，本轮善后）
  npm i -g mashiro-mcp → claude mcp add → 本地 stdio 调用  ← 已经能用

轨 B：Headless Agent HTTP 服务（本轮新建，部署到 Render）
  云端 https://xxx.onrender.com
    ├─ GET  /api/health           （免认证，Render 健康检查用）
    ├─ POST /api/chat             （对话/讲解/面试/学习，Bearer+API Key 保护）
    └─ /api/*                     （无浏览器/无语音/无桌面的核心能力）
```

**为什么部署 Agent HTTP 而不是"远程 MCP"**：stdio 是本地协议，Render 没有 stdio 端点；而 widget 的 HTTP 面（chat/solve_question/interview/study/review…）就是完整 Agent API，浏览器/语音/桌宠都是可选附件。部署它 = 把产品核心能力搬到云端。

---

## 2. 容器化改造（最小侵入，目标：不重写 widget）

### 2.1 新增入口：`bin/headless-server.mjs`（部署专用，原 widget.mjs 不动）
职责 = 设置**部署形态环境**后引导 widget：
```js
// bin/headless-server.mjs
process.env.MIANSHI_HOST ??= "0.0.0.0";          // 容器内对外绑定（本机默认仍 127.0.0.1）
process.env.MIANSHI_DISABLE_PATROL ??= "1";       // 关巡检
process.env.MIANSHI_DISABLE_BACKGROUND ??= "1";   // 关后台定时
process.env.MIANSHI_DISABLE_NOTIFY ??= "1";       // 关系统通知（规避 node-notifier 容器问题）
process.env.MIANSHI_DISABLE_BROWSER ??= "1";      // 见 2.3，关爬取/浏览器工具
await import("../widget.mjs");
```
保留直接 `node widget.mjs` 的本地形态（CLI 不加默认值，不污染桌面路径）。

### 2.2 widget.mjs 参数化（3 个小改动，全部有默认值保持现状）
1. **host**：`server.listen(actualPort, process.env.MIANSHI_HOST || "127.0.0.1", ...)`——本地默认回环不变，容器内由 headless 入口设 0.0.0.0。
2. **CORS 白名单可配**（现状 `widget.mjs:381-393` 只放行回环/null）：增加 `MIANSHI_CORS_ORIGINS`（逗号分隔）；为设置时保持现状（仅回环），避免行为漂移。
3. **通知静默**：`notifier.notify` 调用点包装（现状 widget.mjs:197 已有"Windows toast 备用/某些环境 silent"的注释），`MIANSHI_DISABLE_NOTIFY=1` 时直接跳过，防容器里无声失败甚至崩溃。

### 2.3 浏览器能力的"可选后端"策略（关键风险点）
- playwright 是**动态 import**（fetch-page/oj/zhenti/edge-session），不调用就不加载 chromium → 镜像不必带浏览器。
- 但 MCP 的 `search_posts` / `solve_question` 内部可能触发爬取。方案：
  - 新增 `MIANSHI_DISABLE_BROWSER=1`（headless 默认开）：让工具层把浏览器类工具标记为"不可用"，agent 收到提示继续用非浏览器能力（改 `lib/tool-policy.mjs` 或工具注册处的可用性判断，做法参考现有 `check_tts_availability` 模式）。
  - 部署文档明确："云端第一版不含爬取/刷题/巡检"；形态 B（带浏览器）作为后续选项（Render 上装 chromium 冷启动差，暂缓）。

### 2.4 新增文件
- `Dockerfile`（多阶段，node:22-slim）
  - 阶段 1：`npm ci --omit=dev`（devDeps 含 electron/electron-builder，**不得进生产镜像**）
  - 阶段 2：仅拷贝 `package.json`、`lib/**`、`plugins/**`、`widget.mjs`、`config.mjs`、`bin/**`、`mcp-server.mjs`、`data/*.json`（静态资产：knowledge-trees/learning-sites/career-sites/plugin-market）——**排除 desktop/ models/ assets/ skills/ release/ tests/ benchmark/**（镜像显著瘦身）
  - 非 root 用户 + `EXPOSE 8899` + `CMD ["node","bin/headless-server.mjs"]`
- `.dockerignore`（排除相同集合 + .git/node_modules）
- `render.yaml`（Render Blueprint，一次性建立服务 + 磁盘 + env）

### 2.5 镜像内容清单（对照 package.json `files`，仅取纯 Node 运行时所需）

| 必须 | 排除 |
|---|---|
| lib/ plugins/ widget.mjs mcp-server.mjs bin/ | desktop/（Electron、Live2D、koffi） |
| config.mjs data/*.json（静态资产） | models/ assets/ skills/（桌面/语音资源） |
| package.json | release/ tests/ benchmark/ scripts/ *.log |

---

## 3. 数据持久化与密钥

- **持久化**：SQLite `mianshi.db` + output 目录 + data/*.json。Render 文件系统非持久 → 挂 **Render Disk**（磁盘挂载路径 = `MIANSHI_DATA_DIR` + `MIANSHI_OUTPUT_DIR`，env 已支持，见台账 §3.3/config.mjs）。
- **备份**：复用 `lib/backup.mjs`（WAL checkpoint + 快照），云端由外部调用方按 24h 间隔触发（现状就是"调用方触发"，可加一个 cron 或文档说明手动作业）。
- **密钥**：`DEEPSEEK_API_KEY` / `MIANSHI_PROVIDERS` / `MIANSHI_TOKEN` 全走 Render Secret Env，不入镜像、不入库。
- **鉴权**：`/api/*`（除 health）已有 Bearer 校验 = 现成的 API Key 防线；`MIANSHI_TOKEN` 在部署时生成强随机值注入。CORS 按 `MIANSHI_CORS_ORIGINS` 收窄（默认仍回环 + 我们自己的网页域名）。

---

## 4. 健康检查与进程模型

- Render Web Service health check 直接打 **`/api/health`**（已有免认证端点，完美复用）。
- widget 已是"单进程常驻 HTTP"，无 root 特权需求；容器以非 root 运行。
- 内存：Node 22 + zod（Phase 2 后）压力可忽略；Render free/standard 单实例够用。后台定时（巡检/RAG/每日搜索）由 `MIANSHI_DISABLE_*` 关掉，避免单进程堆积。

---

## 5. CI/CD（两个候选，推荐 A）

**方案 A（推荐）：Render Blueprint 直连 GitHub**
- 首次：提交 `render.yaml` → Render 里 Import 仓库 → 一键生成 Web Service + Disk + env
- 之后：**push main 自动重建部署**（Render 内置 webhook），零额外 workflow
- 优点：最简、无需 Docker Hub/GHCR 凭证；缺点：依赖 Render 平台内置

**方案 B：自建镜像流水线**
- `.github/workflows/deploy-headless.yml`：push tag `v*` 或 main → buildx 构建镜像 → 推 GHCR → curl Render deploy hook
- 用在没有蓝图自动化的场景；与现有 release.yml 的 tag 触发自然衔接

**CI 门禁对齐**：部署触发前必须 `npm test` + `smoke --skip-llm` 全绿（复用现有测试，不新增门禁）。

---

## 6. MCP 远程化（Phase 4b，可选/暂缓）

- 现状 stdio 无远程端点；若需云端 MCP 接入 Claude Code：新增 `SSEServerTransport`/`StreamableHTTPServerTransport` 入口（`@modelcontextprotocol/sdk` 已支持），把 `mcp-server.mjs` 挂到 widget 的某个 `/mcp` 路径下。
- **暂缓理由**：方案 A 已给出"HTTP Agent API"承担云端价值；远程 MCP 的鉴权/会话模型更复杂，且对我们目标用户（本地秋招助手）价值低。列为后续可选项，不进入本轮范围。

---

## 7. 风险与缓解

| 风险 | 缓解 |
|---|---|
| widget.mjs:12 静态 import node-notifier 在容器异常 | `MIANSHI_DISABLE_NOTIFY` 静默 + 调用点 try/catch（2.2 第 3 点）；不改依赖只包调用 |
| headless 下 agent 走到浏览器工具 | `MIANSHI_DISABLE_BROWSER` 把浏览器工具标"不可用"（2.3），agent 降级用非浏览器能力；文档声明边界 |
| 数据丢失（Render 非持久 FS） | Render Disk 挂 MIANSHI_DATA_DIR/OUTPUT_DIR；backup.mjs 复用；文档写清磁盘依赖 |
| CORS 放开引入跨域攻击 | Bearer（MIANSHI_TOKEN）是主防线；CORS 白名单默认收窄、显式配置才开外域 |
| 镜像过大/冷启动慢 | 排除 desktop/models/assets（2.4 清单）；不装 chromium；目标镜像 < 250MB |
| 双入口（widget.mjs vs headless）漂移 | headless 只是设 env + 引导，逻辑仍单源在 widget.mjs；文档注明两者关系 |

---

## 8. 验收标准（可测）

1. 本地 `docker build` 成功；`docker images` 镜像 < 250MB（不含 electron/chromium）
2. `docker run -e DEEPSEEK_API_KEY=... -e MIANSHI_TOKEN=... -p 8899:8899` 后：
   - `GET /api/health` → 200（免认证）
   - `POST /api/chat` 带 Bearer → 正常回复（可选 --skip-llm 环境验证链路）
   - 不带 Bearer → 401
3. 容器内**不加载** playwright chromium（进程清单/ldd 检查）、无 node-notifier 报错
4. Render 部署后：https 端点可访问、健康检查绿、Disk 挂载、**重启后对话历史/学习数据不丢**
5. 推送 main → 自动重建成功；`render.yaml` 幂等（再次 import 不破坏）
6. 桌面端 `npm run dist` 不受影响（本方案完全不碰 Electron 构建）

---

## 9. 产出物清单

- 新增：`bin/headless-server.mjs`、`Dockerfile`、`.dockerignore`、`render.yaml`、`docs/deploy-headless.md`（部署手册：Render 配置步骤、env 表、Disk 挂载、健康检查、开销估算、升级/回滚）
- 修改：`widget.mjs`（host/CORS 可配 + notify 静默，均有默认值）、`lib/tool-policy.mjs` 或工具注册处（浏览器能力可用性标志）
- 不改：Electron/desktop、MCP stdio 模式、现有 CI 门禁

---

## 10. 完成后"能讲什么"（对应简历承诺）

- **前后端一体化部署闭环**：桌面安装包（已有发布）+ 云端 Agent 服务（新），同一代码库双形态交付
- **Headless 化**：一套核心（lib/plugins）同时支撑 Electron 桌宠 / MCP / 云服务三种形态，零 Electron 依赖是讲得出 file:line 的点（`grep electron lib` 为空）
- **运维面**：健康检查端点、环境注入、磁盘持久化、自动部署、可回滚——都对应真实文件
- **与 Phase 2 协同**：云端暴露的 API 恰好是契约层（lib/contracts）约束的那些；未来 MCP 远程化（4b）直接复用契约与 Bearer
- **业界置信度**：与"Electron 壳 + 纯 Node 核心"分离的成熟架构（VS Code/很多桌面 AI 工具同思路）一致，经得起追问

---

## 11. 依赖

- 零新增运行时依赖（不改 widget 依赖）；仅新增部署配置文件。
- Phase 4 与 Phase 2（契约）/ Phase 3（PKCE）正交；若先做 Phase 2，云端 API 天然带契约校验，更稳。
