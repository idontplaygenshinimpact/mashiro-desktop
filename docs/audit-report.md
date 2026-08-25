# 真白 Mashiro UI 与功能闭环审计报告

> 依据 docs/audit-ui-func-prompt.md 九环判定法执行；只读审计（未修改任何代码）。
> 范围：核心闭环（模拟面试/学习清单/复习/对话/学习计划）+ UI 全维度 + 外围闭环（巡检/求职/邮件/备份）。全部合入定稿。
> 主审：核心闭环；UI 部分由子代理完成（已交付）；外围闭环子代理运行中。

## 0. 总览（截至当前合并状态）

- 审计日期：2026-08-24 / 版本 v0.1.1 / 范围见上
- 结论摘要：
  1. **核心业务闭环整体健康**——模拟面试/学习清单/复习/对话四条主链的九环基本贯通（此前多轮修复已堵住主要断环：审批超时否决、字段错位、竞态、会话清理）
  2. **主要缺陷集中在 UI 状态覆盖与长任务可取消性**——P0/P1 共 8 条里 7 条是"按钮无 error 态/长任务无中止/状态文案悬挂"
  3. **数据血缘有两处真实断点**（复盘历史无回看 UI、learning-plan 事件流缺复习/面试埋点），均小改动可修

## 1. 功能闭环矩阵（主审部分）

| 功能 | C1 | C2 | C3 | C4 | C5 | C6 | C7 | C8 | C9 | 判定 |
|---|---|---|---|---|---|---|---|---|---|---|
| 模拟面试 | ✅ | ✅ | ✅ | ✅ | ✅ | ⚠️ | ✅ | ⚠️ | ✅ | 2 弱环 |
| 学习清单 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | 完整 |
| 间隔复习 | ✅ | ✅ | ✅ | ✅ | ✅ | ⚠️ | ✅ | ✅ | ✅ | 1 弱环 |
| 对话 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ⚠️ | ✅ | 1 弱环 |
| 学习计划引擎 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ⚠️ | ✅ | ✅ | 1 断环 |

## 2. 断环问题清单

### P0
1. **`#study-gen` 无 try/catch → 永久卡死"生成中..."**（UI）
   - 位置：desktop/renderer/panel-study.js:1942-1948；叠加 loadStudyPlan 失败静默 return（:1275）
   - 影响：学习清单主生成入口整会话不可用，只能重启面板
   - 修复：包 try/catch/finally，照抄 iv-notes-btn 正确写法（:1983-1988）

### P1
2. **复盘报告历史无回看入口**（C6 断环，核心闭环）
   - 位置：panel-study.js 面试结束 `showIvReport`（:408）；preload 有 `interviewHistory` IPC；interview_history 表数据完整
   - 修复（S）：模拟面试区加"历史复盘"列表，复用 /api/interview/history + showIvReport
3. **爬取任务无取消/停止入口 + "假未启动"反馈**（C3 断环，UI）
   - 位置：panel-chat.js:378-381（fire-and-forget）；:240-243（轮询 else 写"暂无任务"覆盖"已启动"）；无 stop/cancel API
   - 修复：点击即 disabled+loading、轮询接管状态；后端加 cancel + 面板"⏹ 停止"
4. **对话发送无 busy 态/无中断 → 可并发乱序**（C2/C3 弱环，UI）
   - 位置：panel-chat.js:96-158；token 隔离只防串线不防并发
   - 修复：发送期间禁用输入+按钮，加"⏹ 停止"（复用 token abort）
5. **模拟面试"正在生成复盘..."悬挂分支**（C3 弱环，UI）
   - 位置：panel-study.js:296-310——finished 分支无 catch，invEnd 抛错时状态文案永久错误
   - 修复：补 catch 恢复
6. **进行中的面试只能"收尾重开"不能"继续"**（C8 部分断环，核心闭环）
   - 位置：panel-study.js:199-217 自愈逻辑（end 旧会话重开）
   - 修复（S）：启动时检测进行中会话 → "🔄 继续上一场面试"按钮
7. **Live2D idle 定时器泄漏（换肤 +1）**（UI）
   - 位置：app.js:91-96 setInterval 无句柄；:51-54 切换不清
   - 修复：模块级 interval id，loadModel 开头 clear
8. **OJ"⬇️ 全部下载"（5-8 分钟）无取消入口**（C3，UI）
   - 位置：panel.html:469 / panel-rest.js:861
9. **learning-plan 事件流缺复习/面试埋点**（C7 断环，核心闭环）
   - 位置：recordLearningEvent 仅 3 调用点；reviewCard/submitAnswer 未埋
   - 修复（S）：复习提交后记 review_done；面试轮次后记 interview_round（result/quality 归一）

### P2
10. **浅灰文字 `#c9c6dd` 残留浅底（对比度不足）**：panel-chat.js:317、panel-jobs.js:28（panel.css:1139-1141 修了一半，漏 JS 内联）
11. **52 处空 catch 静默** → 服务未就绪时 dashboard/patrol/清单永远"加载中…"无错提示（panel-chat.js:229/710/609、panel-rest.js:1422、panel-study.js:1275）
12. **restart 失败后顶栏图标变形**：panel-chat.js:641 finally 写"🔄 一键重启"vs 初始 ♻️（panel.html:15）
13. **`#patrol-run` 假 loading**（固定 2s 与真实状态无关，panel-chat.js:439-440）
14. **`.chat-log` 固定 `calc(100vh-220px)` 在小窗/多 bar 场景溢出嵌套滚动**（panel.css:552）
15. **审批条/ask-bar 遮挡顶栏**（fixed z-index:9999，挂起期间 ⚙️ 不可达，panel.css:626-640）
16. **6 个顶层常驻轮询不分 Tab 启停**（panel-rest.js:1431/1445/1447/1449/1451/1261）；jobs Tab 已有"进 Tab 启/离 Tab 停"先例（panel-core.js:34-35）未推广
17. **长列表无分页/虚拟化**：challenge/oj/jobs/zhenti 全量 innerHTML
18. **todo 与清单完成不联动**（C7，核心闭环）：lib/todo.mjs 独立，checkItem 不回写
19. **Tab 无 ARIA**（role=tablist/aria-selected 缺失）；弹层无 Esc/焦点陷阱；#chat-send 无 title
20. **对话断流无续传**（C8 弱环，可接受）：token 防串线不防丢失，需重发

## 3. 状态机与幽灵状态清单

| 流程 | 状态机 | 幽灵风险 | 证据 |
|---|---|---|---|
| 模拟面试 | 六态 | `isGeneratingReview` 曾泄漏（已修-失败复位）；"正在生成复盘"悬挂（P1-5）；残留会话只能收尾重开（P1-6） | interview.mjs / panel-study.js |
| 学习清单生成 | 单步 | **`#study-gen` 永久"生成中"（P0-1）** | panel-study.js:1942 |
| 爬取 | 无状态机（fire-and-forget） | "已启动"被轮询覆盖回"暂无任务"（假未启动）→ 连点重复 | panel-chat.js:378/240 |
| 巡检 | 有 isRunning | patrol-run 假 loading；可重复触发 | panel-chat.js:439 |
| 对话 | streaming | 并发无 busy 态 → 回复乱序 | panel-chat.js:96-158 |
| 讲解生成 | 流式 120s 超时 + 代际 | 无（已修） | preload.js |
| Live2D | — | **换肤定时器泄漏叠加**（P1-7） | app.js:91 |

## 4. 数据血缘断点清单

- 薄弱点/复习卡/清单/mastery 四方：复习答对清薄弱点+mastery、答错回流、勾选建卡/取消删卡（source=学习清单）——**闭环已在**（前几轮修复）
- **断点 A**：复盘报告只弹窗不落 UI 历史（C6）
- **断点 B**：learning-plan 事件流缺复习/面试动作（C7）
- **断点 C**：todo 与清单/复习不同步（C7）
- 删除语义：会话删除级联干净 ✓；checkItem 取消删卡卡与 card_reviews 外键 CASCADE ✓

## 5. 跨功能旅程（断点标注）

- **旅程 A 面试→清单→复习→掌握→二次命中**：主线完整 ✓；支线断（复盘回看 P1-2）
- **旅程 B 岗位→收藏→投递→提醒→面试**：外围子代理待报
- **旅程 C 今天打开→处理各项**：主线 ✓；todo 幽灵项；dashboard 未就绪无提示

## 6. UI 得分卡

| 界面 | 分 | 理由 |
|---|---|---|
| 桌宠本体 | 3/5 | 手势/穿透细致；idle 定时器泄漏、换肤重载无重试 |
| 面板顶栏 | 4/5 | 四钮有 title + 版本提醒卡；restart 失败文案变形 |
| 对话 Tab | 3/5 | 工具 chips 可视化亮点；无 busy/取消、静默 catch |
| 学习/复习 Tab | 4/5 | FSRS 可视化+键盘评分；study-gen 卡死分支 |
| 求职 Tab | 3/5 | 信息密度高；长列表全量渲染、#c9c6dd 残字 |
| 设置 Tab | 3/5 | 覆盖全；单页堆叠无导航、加载失败静默 |

## 7. 功能走查表（摘要）

面试全流程 ✅ / 清单全流程 ✅ / 复习全流程 ✅ / 对话全流程 ⚠️（busy/中断）/ 爬取 ⚠️（无取消）/ 巡检 ⚠️（假 loading）/ 语音 ✅ / 设置 ⚠️（部分静默）/ 学习计划引擎 ✅（埋点待扩）

## 8. 未覆盖风险路径（建议 e2e）

- 面试中断恢复（关面板后"继续"而不是"重开"）——现状无入口
- 爬取进行中重启/取消
- 对话并发发送乱序
- 换肤 N 次后 motion 泄漏
- 小窗口（420×560）布局

## 9. 快速修复清单（按优先级，S/M/L）

| # | 缺陷 | 工作量 |
|---|---|---|
| P0-1 | study-gen try/catch/finally | S |
| P1-2 | 复盘历史回看 UI | S |
| P1-A | 导入题库清零进度（INSERT OR REPLACE → 保留状态列） | S |
| P1-5 | 面试生成复盘悬挂 catch | S |
| P1-6 | 面试"继续上一场" | S |
| P1-9 | learning-plan 复习/面试埋点 | S |
| P1-B | 邮件标记已读 + 日程删除接口 | M |
| P1-C | job done 联动作废日程 | M |
| P1-D | 端口回退死链 | M |
| P1-4 | 对话 busy 态 + 停止按钮 | M |
| P1-3 | 爬取取消（后端 cancel + UI） | M |
| P2 | #c9c6dd 统一替换 / restart 图标恢复 | S |
| P2 | deleteChatSession 内存镜像清理 | S |
| P2 | progress.json 僵尸清理 | S |
| P2 | chat-log 布局 + 审批条遮挡 / 轮询按 Tab 启停 / todo 联动 | M |

## 10. 外围闭环审计（子代理交付 + 主审核实）

### 九环矩阵（外围 4 链）

| 功能 | C1 | C2 | C3 | C4 | C5 | C6 | C7 | C8 | C9 | 判定 |
|---|---|---|---|---|---|---|---|---|---|---|
| 巡检/定时 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ⚠️ | ✅ | 1 弱环 |
| 求职 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ⚠️ | ✅ | ⚠️ | 2 断环 |
| 邮件/日程 | ✅ | ✅ | ✅ | ✅ | ✅ | ⚠️ | ✅ | ✅ | ❌ | C9 断 |
| 备份 | ⚠️ | ✅ | ✅ | ✅(恢复路径完整) | ✅ | ✅ | ❌ | ✅ | ✅ | 1 断环 |

### 外围断环清单（P0/P1/P2）

**P1**
- **导入题库清零做题进度（数据血缘 C7 断）**：`lib/ai-career.mjs:19` `importChallengesData` 用 `INSERT OR REPLACE`，INSERT 列不含 `done/done_at/wrong_count` → REPLACE 重建行时这些状态列重置为默认。用户跑一次 import 脚本，全部做题进度（448 题 done/wrongCount）清空。
  - 修复（S）：改 `INSERT OR IGNORE` + 内容列 `UPDATE`（保留状态列），或 INSERT 列补 `done/wrong_count` 用原值
- **邮件无终态（C9 断）**：邮件读到后永不标记"已读"，日程事件无删除接口——已处理/未处理无法区分，重复提醒。
  - 修复（M）：mail 列表加"标记已读" + schedule 事件删除接口
- **求职终态残尸（C7/C9 断）**：岗位 done（拿到 offer/结束）后关联的笔试/面试日程仍继续提醒（job done 不回写 schedule）。
  - 修复（M）：`setJobStatus("done")` 时联动作废该岗位的未完成日程
- **端口回退后 UI 不可达（C8 断）**：widget 8899 被占用回退 8900/8901 后，主进程/面板仍写死请求 8899 → 死恢复链（守护探测 health 失败 → 反复拉起冲突实例）。
  - 修复（M）：widget 端口回退时更新 widget-port.json 并让主进程读取（或禁止回退直接报错）

**P2**
- **progress.json 永久 running 幽灵**：爬取进度文件写 running 后崩溃未清理 → 面板永远显示"爬取中"。
  - 修复（S）：widget 启动扫描 output/progress.json，running 超过 N 分钟视为僵尸清掉
- **scheduler 子系统入口缺失**：lib/scheduler.mjs（若存在）或 schedule 管理无面板入口（定时任务列表/手动触发/暂停）。
- **deleteChatSession 内存镜像复活**：`memory.mjs deleteChatSession` 只删 DB，`mem.chatHistory` 内存残留 → agent 无 history 对话仍能读到已删消息。
  - 修复（S）：deleteChatSession 同步清内存镜像

### 幽灵状态清单（外围）

| 位置 | 现象 |
|---|---|
| output/progress.json | 崩溃残留 running → 面板永久"爬取中" |
| 端口回退 | 8899 死链，UI 不可达且守护误判拉起 |
| job done 后 | 日程残尸继续提醒 |
| deleteChatSession | 已删会话消息在内存"复活" |