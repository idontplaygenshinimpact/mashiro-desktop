# 真白插件化架构方案

> 目标：桌宠「真白」成为宿主应用，秋招助手变成第一个插件，后续功能以插件形式扩展。
> 参考：DeepSeek Harness（DSH）的 profile 分层 + 声明式 manifest + 按 id 增量 patch 模式。

---

## 1. 现状盘点

### 1.1 当前形态：单进程平铺

```
桌面壳（Electron）                widget 服务（Node HTTP :8899）      面板（renderer）
├─ main.mjs：窗口/托盘/Live2D     ├─ widget.mjs：路由注册 + 定时任务    ├─ panel.html：9 个 tab
├─ lib/：widget守护/window-state  ├─ lib/routes/*.mjs（13 域）         ├─ panel-*.js（5 文件）
├─ voice-pack.mjs：语音播放       ├─ lib/*.mjs（interview/study/…）    └─ vad.js
└─ preload.js：IPC 桥             └─ mianshi.db（单库）
```

**好消息**：模块边界已经按域拆好了（13 个 route 域 + 5 个面板文件 + 业务 lib 独立），
差的只是**插件协议层**——没有 manifest、没有注册中心、没有启用/禁用、没有边界声明。

### 1.2 核心 vs 插件候选

| 层 | 内容 | 归属 |
|---|---|---|
| **真白核心** | 窗口/托盘/拖拽/Live2D/气泡、voice-pack 播放、面板宿主框架、widget 守护、token 鉴权、设置框架、**插件加载器** | 核心（保留） |
| **秋招助手** | 面试/学习清单/复习卡/题库/真题/校招/邮件日程/专注/知识库/对话/爬取/自检/巡检 全部业务 | **插件①** |
| 未来插件 | 日语陪练、桌宠养成、番茄钟独立版、刷题打卡… | 插件②③ |

---

## 2. 目标架构

```
真白宿主（core）
├─ desktop/           窗口/托盘/Live2D/voice-pack/面板宿主/preload 桥
├─ widget-host.mjs    服务宿主：router + db + settings + scheduler + 鉴权
├─ plugin-loader.mjs  插件发现/加载/生命周期（核心新增）
└─ plugins/
   ├─ job-hunter/     秋招助手（当前全部业务迁入）
   │   ├─ manifest.json
   │   ├─ server.mjs         （原 lib/routes/*.mjs + 业务 lib）
   │   ├─ panel.js           （原面板功能区块）
   │   └─ assets/
   └─ <future-plugin>/
```

### 2.1 插件协议（manifest.json）

```json
{
  "id": "job-hunter",
  "name": "秋招助手",
  "version": "0.1.0",
  "description": "面经采集 / 模拟面试 / 学习清单 / 复习卡 / 校招投递 / 真题",
  "api": { "min": "0.1.0" },
  "server": "server.mjs",
  "panel": {
    "tabs": [ { "id": "interview", "label": "🎤 面试" }, ... ],
    "settings": [ { "key": "llm_api_key", "type": "password", "group": "AI 模型" }, ... ]
  },
  "schedules": [ { "id": "mail-check", "every": "30m", "fn": "checkMail" } ],
  "enabled": true
}
```

### 2.2 注册点（对齐现有代码，改动面最小）

| 现有写法 | 插件化后 |
|---|---|
| `registerStudyRoutes(router, { getCorsOrigin, laneSubmit })` | 插件 `server.mjs` 导出 `register(api)`，api 含 `{ router, db, settings, scheduler }`——**签名不变，只是调用方变成加载器** |
| widget.mjs 硬编码 `setInterval(checkMail…)` | 插件 manifest `schedules` 声明，宿主统一调度 |
| 面板 HTML 静态 tab | 核心 tab（对话/设置/驾驶舱）静态；插件 tab 由宿主按 manifest 注入 |
| 设置中心手写表单 | 插件声明 settings 描述，宿主自动渲染（核心框架，一次开发） |
| DB 表 | 新插件表建议 `plg_<id>_` 前缀；**存量表保持不动**（渐进迁移） |
| preload kanban 桥 | 按插件分组：`window.kanban.jobHunter.xxx`，宿主统一挂载 |

### 2.3 层与优先级（借鉴 DSH 层栈）

```
核心层（真白壳）→ 插件层（按启用顺序叠加）
```
- 同 key 设置冲突：插件声明 `override: true` 才允许覆盖核心默认，否则合并（DSH patch 语义）
- 路由冲突：核心 `/api/core/*` 保留，插件路由前缀自动带插件 id（`/api/plg/job-hunter/*` 或声明式 `prefix`）——避免未来插件互相踩

---

## 3. 迁移路线（分 4 阶段，每阶段可独立交付、可回滚）

### 阶段 0：注册中心收敛（1-2 天，零行为变化）
- widget.mjs 里 13 个 `registerXxxRoutes` 收拢到 `lib/registry.mjs`（按域分组登记）
- 定时任务列表集中声明（`lib/schedules.mjs`）
- **产出**：加载顺序/依赖一目了然，为插件加载器铺路；639 测试护航，全绿即可

### 阶段 1：插件框架 + 秋招助手迁入（3-5 天，核心交付）
- `plugin-loader.mjs`：扫 `plugins/*/manifest.json` → 校验 → 按序 `register(api)` → 挂 schedules
- 新建 `plugins/job-hunter/`：把 lib/routes 13 域 + 业务 lib + 定时任务**原样搬入**（git mv，逻辑零改动）
- widget.mjs 瘦身为：鉴权 + 插件加载 + 核心路由（health/token/plugin-list）
- **产出**：目录结构即插件边界，未来加插件 = 加目录
- **验收**：639 测试全绿 + 手动全功能走查

### 阶段 2：面板扩展点（2-3 天）
- panel.html 的 tab 区改为「核心静态 + 插件动态」：加载器读 manifest 注入 tab 按钮与 section
- 面板脚本按插件拆分：`plugins/job-hunter/panel/`（从 panel-*.js 迁业务区块）
- 设置中心表单动态化（插件声明 → 自动渲染）
- **产出**：UI 层插件化；新增插件的面板无需改宿主代码

### 阶段 3：插件管理（1-2 天）
- 设置中心「插件管理」页：列表/启用/禁用（disabled 不加载）
- 插件健康检查：加载失败 → 明确报错 + 不拖垮宿主（单插件隔离 try-catch）
- 以第二个真实插件（任选小功能）验证扩展性
- **产出**：完整插件生态闭环

---

## 4. 与 DSH 的对照

| DSH 机制 | 借鉴？ | 落地方案 |
|---|---|---|
| 声明式 manifest（`dsh.bundle`） | ✅ | `plugins/<id>/manifest.json`（目录化，不做 npm 包） |
| 层栈合并（核心层 < bundle 层 < 用户层） | ✅ | 核心层 < 插件层，同 key 合并语义 |
| 按 id 的增量 patch（不覆盖继承） | ✅ | 设置/路由冲突：合并优先，显式 override 才覆盖 |
| npm 依赖即插件（安装包自动激活） | ❌ | 桌宠是本地单机应用，目录即插件更简单可控 |
| Cordis 事件总线 / HMR | ❌ | 我们的路由注册模式足够；HMR 收益低，等有需要再说 |

---

## 5. 风险与护航

| 风险 | 对策 |
|---|---|
| 迁移回归 | 639 测试（含 28 个 jsdom 面板交互）作为迁移门禁，阶段验收全绿才进下一阶段 |
| 面板 5 文件拆出的跨文件全局依赖 | 阶段 2 迁移时用 jsdom 测试逐 tab 护航（现有 28 用例已覆盖主路径） |
| DB 表名迁移 | **不动存量表**；仅新插件表加 `plg_` 前缀 |
| 插件加载失败拖垮宿主 | 单插件 try-catch 隔离 + 健康检查 + 明确报错 |
| 过度设计 | 阶段 0/1 只做"注册中心 + 目录边界"，协议字段只留 manifest 里确实用到的 |

---

## 6. 一句话总结

**把已经拆好的模块再往上提一层：从"按域拆文件"升级到"按插件拆目录"，中间只加一个 manifest + 一个加载器。** 现有代码结构（registerXxxRoutes 模式）天然契合，迁移主要是搬目录，不是重写。DSH 的分层 patch 思想给我们提供了冲突合并的语义，但不需要它的包管理复杂度。
