# Interview-prep 标杆示例（few-shot——风格/深度参考）

> 来源：D:\ai-career\docs\interview-prep.md（人工/多轮打磨标杆——191KB）。
> 用途：生成/修正 prompt 嵌入——模型模仿标杆的**风格与深度**（不是照搬内容——
> 内容必须基于本项目真实源码——红线）。

## 示例 1：源码要点（实现细节密度——函数名/机制/坑）

### 2.2 src/lib/sandbox.ts —— Web Worker 代码沙箱

**核心职责**：在 Web Worker 里隔离执行用户手写题代码 + 测试代码，防死循环、防超时、监控 CPU/内存，返回测试结果/日志/性能指标。

**关键实现**：
- `WORKER_TEMPLATE` 是**字符串模板**：把用户代码（`__USER_CODE__`）、测试代码（`__TEST_CODE__`）、导出参数（`__EXPORT_ARGS__`）拼接进模板，`new Blob([script])` + `URL.createObjectURL` 创建 Worker——**零额外文件**，纯字符串注入
- 模板内**重写 console**：`console.log/error/warn` 全部收集进 `__logs__` 数组；定义 `__assert__(condition, label)` 收集测试结果，失败即 throw
- **CPU 心跳**：`setInterval` 每 100ms 向主线程 postMessage `{type:"heartbeat", cpuTime}`，**超过 10s（CPU_LIMIT_MS）自己报错并 `self.close()`**——死循环代码在 Worker 里跑不挂主线程
- **双保险超时**：主线程 `window.setTimeout(15s)` 硬超时，到时 `worker.terminate()` + `URL.revokeObjectURL`（清理 Blob URL 防内存泄漏）
- **内存估算**：`performance.memory.usedJSHeapSize`（Chrome 私有 API），超过 50MB 标记 `memoryExceeded`
- `buildExportArgs(skeleton)` 用正则从题目骨架提取 `function 名` 和 `class 名`，生成测试调用的导出参数列表
- 结果统一通过 `Promise<SandboxResult>` 返回（success/tests/logs/error/duration/perf）

**可能的坑**：
- `performance.memory` 只有 Chromium 支持，非 Chrome 环境返回 0（做了 fallback）
- Worker 无法同步中断死循环，只能靠 terminate 兜底（15s 硬超时）
- 模板拼接是字符串替换，用户代码里若包含 `__USER_CODE__` 字样会注入异常（理论边界）
- Worker 里 `console` 被覆盖，用户 `console.dir` 等 API 不可用（只实现了 log/error/warn）


## 示例 2：八股（原理 300-500 字 + 项目用法 + 面试应答 + 追问）

### 3.1 Zustand 状态管理与 selector 优化

**原理**：Zustand 是一个轻量 React 状态库，核心是 `create()` 返回一个**外部 store**（hooks 之外），组件通过 `useStore(selector)` 订阅。与 Redux 相比：无 Provider 包裹、无 action/reducer 样板、用原生 `set/get` 更新。性能关键在于 **selector**：`useStore((s) => s.xxx)` 只在 selector 返回值变化时触发重渲染（内部用 `Object.is` 比较）。如果 selector 返回**新对象**（如 `(s) => ({a: s.a, b: s.b})`），每次 store 更新都产生新引用 → 组件无条件重渲染，此时需要 `useShallow` 做浅比较（逐字段 `Object.is`），字段值没变则引用不变，跳过重渲染。`useStore.getState()` 可以在事件处理里读最新状态而不订阅。

**项目真实用法**：`src/stores/interview-store.ts` 用 `create<InterviewStore>()((set, get) => ({...}))` 创建面试 store，按 Session Config/Progress/Scoring/Review 分 slice；`InterviewTrainer.tsx` 里三种 selector 用法并存：① `useShallow((s) => ({...14 个字段}))` 批量取原始字段；② `useInterviewStore(selectRound)` 单字段纯函数 selector；③ `useShallow` 收集派生输入 + `useMemo` 算 `selectCurrentScore(stateForDerived)`。`setAnswer` 支持函数式更新 `setAnswer((prev) => prev + text)`。`initFromStorage` 用 `useInterviewStore.getState().initFromStorage()` 在 effect 里调用。

**面试应答**（背）："状态管理我用的 Zustand，选它的核心原因是轻量和 selector 性能模型。整个模拟面试的状态很复杂，有面试配置、进度、评分、复盘四块，我用一个 store 按 slice 组织。关键点是 selector 的使用：如果直接 `useStore((s) => ({...}))` 每次返回新对象，store 任何字段变化都会导致组件重渲染，所以我批量取字段时用 `useShallow` 做浅比较，字段值没变引用就不变；单字段就写纯函数 selector，比如 `selectRound`，返回原始值靠引用相等跳过渲染；需要派生值的场景，比如当前得分，我先把输入字段用 useShallow 聚合成稳定引用，再用 useMemo 计算，避免重复计算。还有一个细节：事件处理里读最新状态我用 `getState()` 而不是闭包捕获，避免读到过期值。"

**追问 1**：useShallow 的浅比较和默认的 Object.is 比较有什么区别？什么时候必须用 useShallow？
> 默认比较是 Object.is，即引用相等——selector 返回原始值（数字/字符串）时够用；返回对象/数组字面量时每次都是新引用，必然不等。useShallow 会对返回对象的每个字段做一次 Object.is 浅比较，所有字段都没变就认为相等。所以只要 selector 返回"由多个字段拼成的对象字面量"，就必须用 useShallow，否则优化失效。

**追问 2**：Zustand 和 Redux Toolkit 你怎么选？为什么这个项目不用 Redux？
> 项目状态以"一个复杂业务域（面试会话）+ 若干独立小状态"为主，没有多团队协作的全局数据规范需求。Zustand 零 Provider、无样板、selector 粒度自由，心智负担小；Redux 的强约束（action/reducer/中间件）在小项目里是负资产。如果状态要跨模块大量共享、需要时间旅行调试、或团队约定统一模式，Redux Toolkit 更合适。另外 Zustand 可以在组件外（如普通模块）读写 store，做"服务"式状态很方便。

**追问 3**：set 是同步还是异步的？连续多次 set 会怎样？
> Zustand 的 set 是同步的，立即更新 store 并通知订阅者；同一事件里连续 set 会触发多次通知，React 18 的自动批处理会合并渲染。所以项目里"一次性写入多个字段"用 `set({ ...extraPatch, phase: to })` 合并成一次 set，而不是多次调用，减少中间态。

### 3.2 有限状态机（FSM）

**原理**：有限状态机把系统建模为"状态集合 + 事件 + 状态转移"，核心约束是**显式声明合法转移**：每个状态只允许转移到特定状态集合，非法转移被拦截。相比多个 boolean 标志（isLoading/isDone/isError），FSM 从结构上杜绝"不可能态"（比如"既在加载又在完成"）。实现要点：① 状态枚举；② TRANSITIONS 转移表（Record<State, State[]>）；③ 转移函数校验（from + to 查表，非法返回 false/抛错）；④ 进入状态时的副作用（可选）。

**项目真实用法**：`interview-store.ts` 定义 `phase: "idle"|"preparing"|"interviewing"|"advancing"|"reviewing"|"completed"`，`TRANSITIONS` 显式声明（如 `interviewing: ["advancing","reviewing","idle"]`），`transitionTo(from, to)` 非法转换**返回 false + console.warn 而非抛错**（UI 不崩），`advancePhase(to, extraPatch)` 校验通过才 `set({...patch, phase: to})`。`isInPhase(current, ...phases)` 辅助判断。`InterviewStagePanel` 把状态机可视化：每个阶段推导 waiting/active/done/error 并渲染。

**面试应答**（背）："模拟面试的流程控制我用的是有限状态机，而不是一堆 boolean。因为面试有明确的阶段——空闲、准备中、面试中、推进中、复盘生成、完成——用 boolean 会很容易出现不可能的组合状态，比如既在推进又在完成。我的实现是：定义 phase 枚举，再用 TRANSITIONS 转移表显式声明每个状态能去哪些状态，advancePhase 先查转移表，非法转移就 warn 并拒绝，合法才更新状态。这样所有流程流转都受约束，代码里每个 action 只负责'发起转移'，状态是否合法由状态机把关。另外我特意设计成非法转移不抛错，因为 UI 场景里抛错会导致页面崩溃，warn 加拒绝更稳。"

**追问 1**：为什么非法转移用 warn + 返回 false，而不是抛异常？
> 抛异常会把错误上抛到组件渲染或事件处理，React 里未捕获异常会触发错误边界甚至白屏；而状态机的作用本来就是"约束流程"，遇到非法转移说明调用方逻辑有 bug，但用户界面不应该因此崩掉。warn 保留可观测性（控制台能查到），返回 false 让调用方能感知并自行降级。

**追问 2**：如果不用 FSM，用多个 boolean 会有什么具体问题？
> 典型问题是组合爆炸和不可能态：比如 isPreparing、isAdvancing、isCompleted 三个 boolean，理论上 8 种组合，但合法的可能只有 3-4 种；某个 action 忘记置位一个标志，就会出现"isCompleted 和 isAdvancing 同时为 true"的脏状态，UI 判断逻辑也会因为要覆盖所有组合而越来越乱。FSM 把合法组合压缩成"当前状态 + 合法转移表"，不合法组合在结构上写不出来。


## 示例 3：拷打问答（完整答案可背）

### 4.1 开场白（2 分钟项目介绍，背这个）

"面试官好，我介绍一个完整的开源项目：CareerPilot，一个面向前端实习/校招的 AI 能力训练系统。它解决的问题是：求职准备很碎片化，所以我把它拆成六个模块——JD 匹配、简历诊断、项目优化、模拟面试、手写练习、简历版本管理，并且用智能引导把它们串成闭环：JD 匹配发现的缺失项会自动变成模拟面试的追问重点，面试复盘会告诉你回去改简历还是继续练，每个模块产生的数据都沉淀到简历版本系统里做综合复盘。技术上基于 Next.js 15 App Router 和 TypeScript，状态管理用 Zustand，面试流程是一个六态状态机，AI 请求走服务端 API Route 代理、支持用户自带 Key、有超时重试限流，手写题用 Web Worker 沙箱隔离执行防止死循环，CodeMirror 编辑器做了动态加载，首屏体积降了 53%。质量保障方面有 162 个单元测试和 59 个 E2E 测试，GitHub Actions CI 全绿。项目的核心难点是：怎么把'面试官'这个角色用 AI 协议稳定地表达出来——我设计了 plan、round、review 三阶段协议和双保险的追问深度控制，这个我后面详细讲。"

### 4.2 面试模块拷打

**Q1：模拟面试的完整流程是怎么设计的？为什么是 plan/round/review 三阶段？**
"我把一场面试拆成三个阶段。plan：用户上传简历后，AI 基于简历内容和目标岗位生成追问计划——包括简历相关追问点和岗位基础题，返回 topics 和第一轮 openingRound；round：进入逐轮追问，每轮把用户的回答、当前追问深度、已覆盖的主题交给 AI，AI 返回下一轮问题、触发依据、考察维度、合格标准、逻辑边界，还有这一轮的评分；review：面试结束后，AI 基于全部问答流式生成复盘报告。为什么这么拆？因为一次大请求让 AI 生成全部内容，上下文会爆炸而且中途无法干预；三阶段让每步的输入输出都很聚焦，plan 控制'问什么'，round 控制'怎么追问'，review 控制'怎么总结'，任何一个环节出问题都能单独降级或重试。"

**Q2：追问深度是怎么控制的？AI 会不会在一个点上无限深挖？**
"双保险。前端在状态机里设了 AUTO_MODE_MAX_DEPTH 等于 3：auto 模式下同一主题追问深度达到 3 就强制构造一个切题的新一轮，深度归零。同时 AI 的 prompt 里也写了规则：currentDepth 大于等于 2 时，除非回答本身有值得深挖的漏洞，否则必须返回 shouldSwitchFocus 为 true。为什么两层？因为 AI 的输出不可完全信任，prompt 约束是软性的，前端判断是硬性的兜底——单靠哪一层都可能失效。切题时用 getNextTopicIndex 算法保证简历题和基础题穿插，不会连续 5 轮全是简历题或全是基础题。"

**Q3：六态状态机具体是怎么实现的？为什么要状态机？**
"状态是 idle、preparing、interviewing、advancing、reviewing、completed 六个。实现上：TRANSITIONS 是一个 Record，显式声明每个状态能转移到哪些状态，比如 interviewing 只能去 advancing、reviewing 或 idle；advancePhase 做转移前先查表，非法转移就 console.warn 并拒绝，不抛错——抛错会导致页面崩，warn 加拒绝保证 UI 稳定。为什么用状态机：面试流程的阶段是强有序的，用 boolean 标志很容易出现不可能组合，比如'既在推进又在完成'，状态机在结构上就写不出这种状态。面试官视角的收益是：任何交互动作只声明'我想转移到哪'，合法性由状态机把关。"

**Q4：练习模式和连贯追问模式有什么区别？实现上有什么不同？**
"练习模式是'用户主导'：用户可以手动切换追问点，适合打磨 STAR 表达；连贯追问模式是'AI 主导'：AI 面试官控制深挖和切题，模拟真实面试节奏。实现差异在 round 阶段：练习模式切换主题时直接本地用 createOpeningRound 生成新一轮，不调 AI；连贯模式每次提交回答都走 round API 让 AI 生成下一问。另外连贯模式有深度守卫和切题算法，练习模式没有。评分逻辑两者一致，都会走 AI 评分加本地兜底。"

**Q5：AI 返回的评分和本地评分是什么关系？为什么要两套？**
"评分双轨：AI 评分优先，round 接口返回的 answerScore 直接展示为 AI Score；但如果 AI 不可用、超时或返回异常，就用本地 scoreInterviewAnswer 兜底，展示为参考分。本地评分是纯规则的：五个维度——技术准确性、表达结构、项目深度、异常边界、复盘意识，上限 30/25/25/20/15，每个维度用术语分类匹配加分布统计打分，总分封顶 96。为什么封顶 96？给 AI 评分留余量，避免本地规则误判满分。这套本地评分保证无 Key 或 AI 故障时整个面试流程还能跑，是个降级开关。"

**Q6：本地评分是怎么算的？它准吗？**
"每个维度是规则打分器。准确性：六类技术术语分类，命中分类数和术语数加权，加密度分（术语数除以句数）和长度因子，防止只提一个词就得分；结构：中文连接词分六组（递进/因果/转折/举例/条件/总结），看连接词多样性、在句间的分布（把句子分成三桶，术语集中在开头不得高分）、句长方差、有没有 bullet；深度：看是否出现原理/对比/实现/验证四类表达；风险处理：看异常/降级/边界/条件句；复盘意识：看复盘/优化/量化/计划词，而且越靠后的轮次权重越高。坦白说它只是关键词统计，不是语义理解，堆术语能骗过它——所以它只做兜底，正式评分以 AI 为准。"

**Q7：复盘报告是怎么流式输出的？断网了怎么办？**
"review 接口支持 stream，服务端把 AI 的流式响应原样包成 chunked Response 返回，前端 reader.read() 循环读，每块解码后累加进 streamingReviewText，store set 一次，ReviewPanel 直接渲染，末尾一个闪烁光标就是打字机效果。断流处理：store 里做了重试，最多重试 2 次，每次退避递增（1 秒、2 秒），重试前在界面上追加'网络中断，N 秒后重试'的提示，重试成功后继续从新的流累加。这是长文本生成的稳定性保障——复盘报告可能几千字，生成时间长，一次网络抖动就全丢的话体验很差。"

**Q8：三种面试官角色怎么实现的？**
"数据层定义了 interviewerProfiles：温和、压力、深挖三种，每种有 systemPromptPrefix 描述风格和 temperature。请求时把角色前缀拼进 system prompt，AI 就按这个人设来追问。说一个我知道的实现瑕疵：角色数据里的 temperature 实际没有生效，因为 ai-client 调用时硬编码了 0.35，生效的只有 prompt 前缀——这个我后来才注意到，是数据与实现不一致的典型例子。"

**Q9：代码作答是怎么嵌入面试流程的？**
"面试追问里如果 AI 命中手写/算法题，前端会做一次关键词匹配：把当前问题文本和本地题库的标题分词比对，命中就自动切到代码作答模式，注入题目骨架代码，用户写完后点运行，跑在 Web Worker 沙箱里，运行结果和代码会拼进 answer 写回本轮回答，再进入 AI 评分链路。这样手写题不是孤立的练习，而是面试的一部分，运行结果会参与后面的评分和复盘。"

**Q10：面试历史是怎么存的？答过的题会再考吗？**
"每次面试结束自动保存一条记录到 localStorage，最多 20 条，包含日期、岗位、模式、平均分、五维分数和复盘 Markdown，可以展开查看、下载 Markdown、删除。进步追踪页读取历史画 SVG 趋势折线图和五维变化对比，两次以上面试才显示。答过的题不会主动排除，因为题库和追问是 AI 动态生成的，但本地题库的 coveredFocuses 会传给 round 接口，AI 会参考已覆盖的主题避免重复。"

**Q11：selectAverageScore 是怎么算的？有没有口径问题？**
"有 AI 分就取 AI 分均值；没有 AI 分就本地算：面试已结束时用 history 里的答案逐个评分取均值，进行中则把当前 answer 也算进去。这里有个口径细节：已结束和进行中的计算基准不同，如果 phase 因为异常回退，history 已包含答案，口径会变——这是我知道的边界情况，实际因为 AI 分通常存在，影响很小。"

**Q12：为什么非法状态转移不抛错而是 warn？**

## 示例 4：怎么讲（讲述脚本——照着讲）

### 5.1 讲述的总体框架：三层讲述法

**第一层 · 一句话定位（30 秒）**——面试官问"介绍下你的项目"时：
> "这是一个面向前端校招的 AI 训练系统，把求职准备拆成诊断、训练、复盘、迭代的闭环，核心是模拟面试模块——我用 plan/round/review 三阶段协议让 AI 扮演面试官，用状态机保证流程稳定，用 Web Worker 沙箱做手写题隔离执行。"

**第二层 · 核心链路讲述（2-3 分钟）**——主动挑 1-2 个模块讲透（推荐：模拟面试 + 手写沙箱），按 5.2 的结构讲。

**第三层 · 按追问展开（5-15 分钟）**——面试官追问到哪，就从文档对应章节调出"原理 + 项目用法 + 坑"来讲。**这一层的关键是 5.4 的埋点技巧**：你在第二层主动抛出的钩子，决定了第三层问什么。

