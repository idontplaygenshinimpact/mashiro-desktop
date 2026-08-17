// lib/tools/schemas.mjs —— 工具 schema 定义（纵向拆分：从 lib/agent.mjs 迁出）
// 纯数据模块（零依赖）：DeepSeek function calling 格式的工具清单，供 agent 循环与 MCP server 复用

export const TOOLS = [
  {
    type: "function",
    function: {
      name: "plan_task",
      description: "把用户的复杂请求拆解成多步执行计划。调用后你会看到计划，然后逐步执行（每步调对应工具）。用于：搜索+讲解+归档组合任务、多篇面经整理、学习计划生成等。",
      parameters: {
        type: "object",
        properties: {
          goal: { type: "string", description: "用户请求的目标" },
          steps: { type: "array", items: { type: "string" }, description: "2-5 个具体步骤，每步一个动作" },
        },
        required: ["goal", "steps"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_posts",
      description: "搜索面经/笔试/招聘帖子，返回候选帖子列表（标题+链接+来源站）。支持牛客、掘金、CSDN。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "搜索关键词，如：React 面经 / 前端 笔试 / Agent 面经 / 某公司 招聘" },
          site: { type: "string", enum: ["auto", "nowcoder", "juejin", "csdn"], description: "指定来源站，默认 auto" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_knowledge",
      description: "搜索本地知识库（历史面经讲解、学习清单、复习卡、岗位、官方文档的关键词检索）。回答面试题/知识点问题时可优先查这里——比重新抓网页快且准。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "要检索的问题或关键词，如：事件循环 / React Hooks 闭包陷阱 / 防抖节流实现" },
          topK: { type: "number", description: "返回条数，默认 3" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_search",
      description: "联网搜索（Bing）获取实时信息/最新动态。当用户问时事、新闻、最新版本、最近发生的事、今天/现在的动态，或问题超出本地知识库（search_knowledge 无命中）且需要新鲜信息时调用。返回 title+url+snippet 的搜索结果列表，可据此组织回答。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "搜索关键词，如：React 19 新特性 / 字节 2026 秋招 前端 / DeepSeek V4 发布" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fetch_page",
      description: "抓取一个网页的正文内容（用于查看帖子详情、提取题目）。",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "帖子完整 URL" },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "solve_question",
      description: "完整讲解一道面试/笔试题（前端格式：结论/原理/实现JS/边界）。结果归档到 output 目录。",
      parameters: {
        type: "object",
        properties: {
          question: { type: "string", description: "题目或面经内容" },
          company: { type: "string", description: "公司名（可空）" },
          sourceUrl: { type: "string", description: "来源链接（可空）" },
        },
        required: ["question"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "detect_questions",
      description: "判断页面内容里是否有具体可作答的题目，并提取题目列表。用于从面经/攻略文中筛出真题目。",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "页面标题" },
          text: { type: "string", description: "页面正文" },
        },
        required: ["title", "text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "remember",
      description: "记住用户关注点（话题/公司/方向），用于后续主动推送相关内容。",
      parameters: {
        type: "object",
        properties: {
          topics: { type: "array", items: { type: "string" }, description: "关注点列表，如 ['React', '字节']" },
        },
        required: ["topics"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_weak_points",
      description: "查看用户的学习薄弱点（复盘验证中答错/答不好的知识点）。生成学习计划时应优先覆盖薄弱点。",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "get_memory",
      description: "查看用户画像/关注点/学习进度等记忆信息（含简历摘要与推荐岗位，如已配置个人数据模块）。",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "get_study_plan",
      description: "查看当前学习清单（待学知识点）。面试前调用，优先考清单里的未完成项。",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "get_recent_outputs",
      description: "查看最近爬取整理的面经/题目（output 目录最新产出摘要）。面试出题时参考真实高频考点。",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "start_interview",
      description: "开始一场模拟面试。AI 面试官生成第一个问题（含考察维度、合格标准）。之后用户每回答一轮，调用 submit_answer 推进。",
      parameters: {
        type: "object",
        properties: {
          position: { type: "string", description: "目标岗位，如：前端实习生 / React 前端 / 全栈" },
          role: { type: "string", enum: ["温和引导型", "压力追问型", "技术深挖型"], description: "面试官风格，默认技术深挖型" },
          resume: { type: "string", description: "简历内容（可选，面试官会基于简历追问项目经历）" },
          focus: { type: "string", description: "重点方向（可选），如：React / 事件循环 / 简历项目，面试官优先考这些" },
        },
        required: ["position"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "submit_answer",
      description: "提交当前问题的回答。AI 面试官给本轮评分（技术/表达/深度/边界/复盘意识）+ 下一问或追问。用户说结束/答完了时调用。",
      parameters: {
        type: "object",
        properties: {
          answer: { type: "string", description: "用户的回答内容" },
        },
        required: ["answer"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "end_interview",
      description: "结束模拟面试，生成复盘报告（总体评价/优势/短板/学习方向/可投递性），并把薄弱点写入记忆。",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "record_interview_topics",
      description: "记录真实面试中被问住/不会的知识点：加入学习清单（必会，优先补强）+ 自动建复习卡。用户说'面试被问住了 XX / 面试考了 XX 不会 / 帮我记一下这几个点'时调用。",
      parameters: {
        type: "object",
        properties: {
          topics: { type: "array", items: { type: "string" }, description: "被问住的知识点列表，如 ['React Hooks 原理', 'B+树索引回表查询']" },
          company: { type: "string", description: "面试公司名（可选，会记入来源）" },
        },
        required: ["topics"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "spawn_subagent",
      description: "把子任务拆给独立子执行器处理（适合：多篇面经同时整理、多个知识点分别讲解、多公司情报并行搜集）。返回该子任务的结果文本。一次可调用多个 spawn_subagent 实现并行。",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "子任务名，如：整理React面经" },
          system: { type: "string", description: "子执行器角色指令（可选），如'你是资深前端面试官，只输出考察点清单'" },
          task: { type: "string", description: "要子执行器完成的具体任务" },
          context: { type: "string", description: "参考上下文（可选，如面经原文/题目列表）" },
        },
        required: ["task"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "job_search_platform",
      description: "在招聘平台（BOSS 直聘等，需先在面板启用账号）搜索岗位，结果自动入库岗位库。适合：用户说'帮我看看 BOSS 上有什么前端岗位'/'搜一下 xx 的校招'。",
      parameters: {
        type: "object",
        properties: {
          platform: { type: "string", enum: ["boss"], description: "平台，当前支持 boss" },
          keyword: { type: "string", description: "搜索关键词，如：前端开发、React 工程师" },
          limit: { type: "number", description: "返回条数，默认 15，最大 30" },
        },
        required: ["platform", "keyword"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "job_apply",
      description: "向指定岗位发起投递（BOSS 直聘：打开岗位 → 点击立即沟通 → 发送招呼语）。执行前会请求用户确认。适合：用户说'帮我投这个岗位'/'投递 xx 公司的前端岗'。",
      parameters: {
        type: "object",
        properties: {
          platform: { type: "string", enum: ["boss"], description: "平台，当前支持 boss" },
          url: { type: "string", description: "岗位链接（如 https://www.zhipin.com/job_detail/xxx.html）" },
          jobId: { type: "string", description: "岗位库中的 id（可选，投递成功后自动更新状态）" },
          greeting: { type: "string", description: "招呼语（可选，默认用账号配置）" },
        },
        required: ["platform", "url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ask_user",
      description: "向用户提出一个问题并给出 2-6 个选项（如方向选择/范围确认/方案决策），用户点选后返回选择结果。需要用户拍板、或用户意图有歧义且影响后续动作时使用。不要用普通回复代替——普通文字提问用户只能打字，选项点击更高效。",
      parameters: {
        type: "object",
        properties: {
          question: { type: "string", description: "要问的问题" },
          options: { type: "array", items: { type: "object", properties: { label: { type: "string" }, description: { type: "string" } } }, description: "2-6 个选项，label 简短（如'补强薄弱点'），description 一句说明" },
          multiSelect: { type: "boolean", description: "是否允许多选，默认 false" },
        },
        required: ["question", "options"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "plan_mode",
      description: "把执行计划提交给用户确认（对搜索+讲解+归档、批量投递、多步整理这类有副作用的任务，先出计划再动手）。用户确认后返回 approved；用户可要求修改或取消。",
      parameters: {
        type: "object",
        properties: {
          plan: { type: "string", description: "完整执行计划：目标、步骤（每步做什么/写什么/调什么工具）、预期产出" },
        },
        required: ["plan"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "todo_init",
      description: "为多步任务建立可见任务清单（初始化：传入步骤列表；与已有清单按内容合并去重）。适合：拆解复杂任务后让用户在面板看到进度。",
      parameters: {
        type: "object",
        properties: {
          items: { type: "array", items: { type: "object", properties: { content: { type: "string" } } }, description: "步骤列表，如 [{content:'搜索面经'},{content:'提炼考点'}]" },
        },
        required: ["items"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "todo_done",
      description: "标记任务清单中的一步完成（按序号或内容）。每完成一步调用一次，让面板进度可见。",
      parameters: {
        type: "object",
        properties: {
          index: { type: "number", description: "序号（从 0 开始，可选）" },
          content: { type: "string", description: "或按内容匹配（可选）" },
          done: { type: "boolean", description: "true=完成（默认）/ false=改回未完成" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "skill_inspect",
      description: "查看已加载的技能插件清单（技能名/说明/工具列表/权限级别/hooks 数）。写代码或规划任务前先查可用的技能工具，不要凭记忆猜技能名。",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "loop_status",
      description: "查看学习-求职闭环状态与下一步建议（方向/学习清单/薄弱点/岗位/面试多维汇总，规则引擎给出当前最该做的事）。适合：用户问'我现在该干什么'/'闭环进度'/'下一步'。",
      parameters: { type: "object", properties: {} },
    },
  },
{
      type: "function",
      function: {
        name: "read_tool_result",
        description: "读取之前被落盘保存的完整工具结果（超长结果落盘后回填的是预览和文件路径，需要完整内容时调用此工具读取）。file 参数必须是 data/tool_results/ 下的路径。",
        parameters: {
          type: "object",
          properties: {
            file: { type: "string", description: "落盘文件路径，如 data/tool_results/xxx.json" },
          },
          required: ["file"],
        },
      },
    },
    // ---------- 浏览工具（真实浏览器交互：点击/滚动/输入/截图，逛网能力基础） ----------
    {
      type: "function",
      function: {
        name: "browse_open",
        description: "用真实浏览器打开网页并确认可访问（内置 SSRF 防护，仅允许公网 http/https）。返回页面标题与最终 URL，用于验证链接有效性或作为后续浏览操作的前置检查。",
        parameters: {
          type: "object",
          properties: {
            url: { type: "string", description: "要打开的网页 URL（http/https）" },
          },
          required: ["url"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "browse_click",
        description: "用真实浏览器打开网页并点击元素（CSS 选择器或可见文本），用于翻页/展开评论区/触发加载更多/点击链接。返回点击后的页面标题和 URL。",
        parameters: {
          type: "object",
          properties: {
            url: { type: "string", description: "要打开的网页 URL" },
            target: { type: "string", description: "点击目标：CSS 选择器（如 '.load-more'）或元素可见文本（如 '加载更多'）" },
          },
          required: ["url", "target"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "browse_scroll",
        description: "用真实浏览器打开网页并多次滚动到底部（触发无限滚动列表加载更多内容）。适合翻看牛客/掘金等长列表。返回滚动后的页面标题和 URL。",
        parameters: {
          type: "object",
          properties: {
            url: { type: "string", description: "要打开的网页 URL" },
            times: { type: "number", description: "滚动次数，默认 3，最大 10" },
          },
          required: ["url"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "browse_type",
        description: "用真实浏览器打开网页，在输入框填充文本（如站内搜索框/筛选输入框），可选回车提交。返回操作后的页面标题和 URL。",
        parameters: {
          type: "object",
          properties: {
            url: { type: "string", description: "要打开的网页 URL" },
            selector: { type: "string", description: "输入框的 CSS 选择器（如 '#search-input'）" },
            text: { type: "string", description: "要填入的文本" },
            pressEnter: { type: "boolean", description: "填入后是否按回车提交，默认 true" },
          },
          required: ["url", "selector", "text"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "browse_screenshot",
        description: "用真实浏览器打开网页并截图保存（JPEG），供视觉分析页面布局/验证码/渲染效果/图表。返回截图文件路径和页面标题。",
        parameters: {
          type: "object",
          properties: {
            url: { type: "string", description: "要打开的网页 URL" },
            path: { type: "string", description: "截图保存路径（可选，默认 data/tool_results/shot-<时间戳>.jpg）" },
          },
          required: ["url"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "browse_fetch",
        description: "用真实浏览器打开网页并等待渲染后提取标题+正文+链接（比 fetch_page 多了显式等待参数，适合需要 JS 渲染/懒加载的页面）。返回内容已验证为不可信数据。",
        parameters: {
          type: "object",
          properties: {
            url: { type: "string", description: "要打开的网页 URL" },
            waitMs: { type: "number", description: "打开后额外等待毫秒数，默认 800，最大 10000" },
          },
          required: ["url"],
        },
      },
    },
  ];
