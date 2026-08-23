# Changelog

本项目遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。当前为开发版（`0.1.0`），未发布正式 release；`main` 分支持续演进。

## [Unreleased]

### 分发与接入（v0.1.0 之后）

- 📦 **npm 发布**：`mashiro-mcp@0.1.0`（npmjs）——秋招助手能力层打包为独立 MCP Server，`npm i -g` 一行配置接入 Claude Code/Cline 等任意 MCP 客户端；数据默认 `~/.mashiro`
- 🔌 **DSH 接入**：`cordis.patch.yml` 注册 `dsh-mcp-client` 实例 → DSH agent 获得 `mcp__mashiro__*` 9 工具（借鉴 DSH 思路的项目反过来接入 DSH）
- 📦 **打包版可用性修复**（发布阻塞级）：asar 只读环境 → 数据/产出/插件/MCP 配置全部重定向可写目录（`MIANSHI_DATA_DIR`/`ELECTRON_RUN_AS_NODE`/`asarUnpack plugins`），打包产物实测：服务启动/插件加载/MCP 自环 9 工具连接全通过
- 🎯 **v0.1.0 Release**：CI/Release 双流水线全绿，NSIS + portable 安装包自动发布

### 复习与薄弱点完善

- 💡 **「显示答案」空答案回退**：手写题库/薄弱点/清单来源的卡 answer 为空 → 回退纯读 `study_notes` 讲解存档（`/api/study/note`，不调 LLM），无存档给出引导文案
- 🧹 **薄弱点表述漂移合并**：面试提问措辞每次不同导致同一知识点分裂多条（实测状态机族 5 条）→ `isSimilarWeakTopic`（中文 3-gram 共享）+ 写入时合并 + `mergeSimilarWeakPoints()` 历史整理（widget 启动自愈，13 条 → 7 条）

### 全量代码审计（11 域并行审计，100+ 项发现全部处理）

- 🛡️ **判题沙箱安全重构**：vm 不是安全边界（宿主对象注入可达宿主进程权限）→ 判题迁移到 `worker_threads` 隔离（`lib/sandbox-runner.mjs` + `sandbox-worker.mjs`）：独立线程 + resourceLimits + 超时 `worker.terminate()` 真正终止（async 挂起/定时器随 worker 回收）；断言闭包 worker 侧定义 + 测试代码独立作用域（防遮蔽）
- 🔐 **审批链加固**：会话级 auto-approve 按会话边界重置（新对话重置）；拒绝记入会话级 deny（防变参重试无限弹审批）；`job_apply` 禁 session 放行；审计账本区分用户批准 vs 会话延续；skill 权限缓存缺失 fail-closed
- 📐 **提示注入面清零**：MCP 工具结果/描述、subagent context/结果、简历原文、linkHints、知识库出题素材、示例 skill 外部内容——全部统一 `sanitizeExternal().wrapped` 不可信包裹
- 🐛 **核心功能修复**：复习 rating=0（忘了）被吞成 Good（薄弱点错误清除）；选择题洗牌判分坐标系错位（75% 答对判错）；死循环检测 80 字符截断误杀合法流水线；回传 history 非法消息序列（多轮对话断链）
- 🏗️ **模块拆分**：`jobs.mjs`（777 行 God Object）→ 岗位数据层 + `job-match.mjs`（画像/匹配/推荐）+ `job-reminders.mjs`（截止/笔试提醒）——职责分离，引用方全部直连新模块
- 🔁 **健壮性**：MCP 子进程生命周期（失败回收/优雅关闭/重试）；IMAP 连接超时销毁 + 互斥；RSS 摘要失败不再锁死当天；恢复链路清理 WAL 残留；薄弱点计数不再被镜像裁剪丢失；`/api/output/import` JSON 解析修复；插件路由宿主优先；VAD 实际采样率 + 噪声裁剪；语音开关全覆盖；面板 XSS 注入面转义

### 数据安全（新增）

- 💾 **自动备份**：`lib/backup.mjs`——SQLite 主库（WAL checkpoint 后复制，保证完整）+ AI 讲解存档（`output/study_notes/`）+ 爬取进度，每天自动备份一次，保留最近 10 份（`MIANSHI_BACKUP_KEEP` 可配）
- ↩️ **一键恢复**：面板设置→数据维护可见备份列表（原因/时间/内容），恢复走"标记 → 重启自动替换 → 恢复前自动快照（`pre-restore`）"链路——恢复出错可回滚；恢复标记防路径穿越
- 备份接口：`POST /api/backup` / `GET /api/backups` / `POST /api/backups/restore`

### 插件体系（阶段 3 完成）

- 🧩 **插件管理**：`lib/plugin-admin.mjs` + 面板设置→插件管理——已装插件列表（加载状态/健康检查/错误详情）+ 启停开关（`plg_disabled_<id>` 标记，重启生效）+ 加载结果缓存
- 🛒 **插件市场**：`data/plugin-market.json` 注册表 + 一键安装（`POST /api/plugins/install`，id 白名单 + 路径穿越拒绝 + manifest.id 一致性校验）
- 🎛 **面板动态渲染**：插件 `manifest.panel.tabs/settings` 声明 → 真实 tab 按钮 + 设置表单（读写走 `/api/plugins/settings`，只允许声明的 key，类型收敛）
- 修复：宿主注入 `api.log`（此前模板插件在真实 widget 加载失败）；`package.json` 打包清单补 `plugins/**`（此前发布包不含任何插件）

### 走查修复（爬取/知识库双链路端到端审计）

- 🔍 **知识库检索**：2 字中文词（缓存/闭包/防抖）LIKE 兜底（trigram 无法匹配短词）；拉丁缩写（HTTP）不再被文档卡片 `https://` URL 噪声淹没（标题命中 +0.5 提权）；跨文件重复切片全局去重
- 🔁 **知识库增量**：全量重建重灌个人项目档案（`project:*` 不再丢失）；重建补写 DB 快照 hash（重建后首轮增量零 churn）；md 变更检测升级为 mtime+size（兜底同 mtime 内容变化）
- 📋 **产出→清单提炼**：修复 `sanitizeExternal(x)` 未取 `.wrapped` 导致 prompt 注入 `[object Object]`（清单提炼/面试素材此前在生产环境静默失效）；`findStudyFile` 长 topic 截断失配（讲解+追问不再被重复生成覆盖）；空 source 不再误命中任意产出文件；collect 排除 `study_notes`/`chat_solutions` 自产目录

### 面试与学习闭环（阶段 2 收尾）

- 🎯 面试优先考察多源聚合：薄弱点/复习错题本/题库错题/到期卡/今日复习/清单未完成 6 源合并（同主题取最高分、考过不重复），面板手动选配 chips 展示来源
- 🧮 题库 `test_code` 生成：189 道 codetop 题自动生成 `__test__` 判题码（337 道可判题）；判题沙箱支持 `var X = function` LeetCode 骨架
- 💰 LLM 成本面板：obs 行成本估算（DeepSeek 官方价目）+ 角色分布（role/calls/token/耗时）
- 📝 对话反哺：`add_study_items`（写清单 + 挂 todo）、`create_review_card`（建 FSRS 卡），confirm 权限面板审批
- 🎯 `target_direction` 手动优先：简历自动设置不覆盖手动选择（清除后简历可重设）
- 🔗 todo 联动：清单条目 ↔ 桌面 todo

### 插件体系（阶段 2）

- 示例插件模板 `plugins/plugin-template/`（协议即文档）：`manifest.panel.tabs/settings` 声明 + init 默认设置 + health 检查 + settings 命名空间 `plg_<id>_` 前缀
- 加载器扩展：`loadPlugin` 返回 `{ok, panel, schedules, health}`；`validateManifest` 校验 panel 结构

### 工程与文档

- CI 增强：依赖缓存 / 覆盖率 lcov artifact / renderer bundle 一致性检查
- 贡献指南 `CONTRIBUTING.md`、Issue/PR 模板、`SECURITY.md`（数据安全/SSRF/提示注入/鉴权边界）
- README 同步：插件化路线（阶段 1-3 完成）、结构树、功能表

---

## 早期里程碑（v0.1.0 开发期沉淀）

### 核心能力

- 🐻 **桌宠宿主**：Live2D 真白（多皮肤/待机动作/点击穿透）、语音包（112 句/26 场景，自训练 GPT-SoVITS 流程随仓库发布）、本地语音输入（sherpa-onnx + VAD）、音乐系统
- 🎤 **模拟面试**：混合编排（项目拷打主线 + 八股穿插 + 手写收尾）、优先考察自动聚合、面试实录（被问住的知识点一键入清单+复习卡）、追问补充、FSRS 复习卡
- 📋 **学习闭环**：产出 → 清单提炼（LLM）→ 讲解（流式 SSE + 追问）→ 复习选择题（FSRS + 方向画像）→ 掌握度知识树
- 🏢 **求职闭环**：岗位搜集（官网优先 20+ 家 + 牛客真题/TOP101）、简历驱动匹配、投递状态、邮箱面试邀约识别（IMAP → LLM → 日程 → 提前提醒）、笔试/截止提醒
- 🧠 **本地知识库**：RAG 评估后定为纯 FTS5 关键词检索（零模型零内存秒级构建，设置开关）、个人项目源码档案（面试官基于真实代码拷打）
- 💬 **对话 agent**：工具循环 + 权限门禁（confirm 审批/会话级 auto-approve）+ 死循环检测 + 工具结果落盘 + MCP 客户端/服务端 + 记忆整合（Dreaming）+ 持久化调度 + 提示注入防护
- 🔍 **爬取引擎**：discover 管线化（列表 → AI 挑帖 → 正文 → 分类 → 题目检测 → 归档）、SSRF 全拦截（IPv4/IPv6/映射/NAT64/域名重绑定）、多站源（牛客/掘金/CSDN/Bing 兜底）、巡检定时

### 工程质量

- 纵向拆分收官：widget 路由 13 域、agent 工具分层、面板 5 文件、main → desktop/lib，全部可独立测试
- 测试体系：725+ 用例（单元 + jsdom 交互 + 集成）、mock LLM 基座、两层评测（Layer A 模型基线 / Layer B agent 能力）、覆盖率
- 数据层：node:sqlite WAL + 原子写入 + 事务 + 迁移；信任边界收敛（外部内容统一 untrusted 包裹）
- 可观测性：LLM 调用/token/耗时/工具链入库 + 面板运行监控 + 成本估算
