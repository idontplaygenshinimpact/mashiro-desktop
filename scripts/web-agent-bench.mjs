// 上网能力评测（Web Agent Benchmark）：真实网络 + 真实 LLM
// 验证 agent 的上网链路：搜索 → 抓取 → 提取 → 综合回答
// 每个任务自动判定：工具链是否真实调用 + 输出是否有实质内容
// 用法: node scripts/web-agent-bench.mjs [--skip-network]（--skip-network 只测链路不测真实性）
import { chatWithAgent } from "../lib/agent.mjs";
import { getRecentTools } from "../lib/trace.mjs";

const TASKS = [
  {
    id: "t1",
    name: "搜索能力：找 React 前端面经",
    prompt: "帮我搜索 3 篇 React 前端面经帖子，返回标题和链接。",
    needTool: "search_posts",
    check: (r) => r.reply.length > 50 && /(http|面经|React)/.test(r.reply),
  },
  {
    id: "t2",
    name: "抓取能力：读取指定面经页",
    prompt: "请抓取这个页面看看内容讲了什么：https://www.nowcoder.com/discuss/614151744577818624",
    needTool: "fetch_page",
    check: (r) => r.reply.length > 80,
  },
  {
    id: "t3",
    name: "提取能力：从面经提取面试题目",
    prompt: "搜索一篇最新的字节前端面经，抓取后提取里面问了哪些面试题。",
    needTool: "search_posts",
    check: (r) => r.reply.length > 100 && /(题|面试|问了|考察)/.test(r.reply),
  },
  {
    id: "t4",
    name: "综合链路：搜索→抓取→总结",
    prompt: "搜一下 2026 届前端秋招提前批的信息，抓取一篇相关帖子，总结出 3 个关键信息。",
    needTool: "search_posts",
    check: (r) => r.reply.length > 100 && /(提前批|秋招|校招|笔试|时间)/.test(r.reply),
  },
  {
    id: "t5",
    name: "时效信息：搜索最新笔试信息",
    prompt: "搜索最近的拼多多或字节笔试/面经信息，告诉我有什么新动态。",
    needTool: "search_posts",
    check: (r) => r.reply.length > 50 && /(笔试|面经|拼多多|字节|2026)/.test(r.reply),
  },
];

const SKIP_NETWORK = process.argv.includes("--skip-network");
const results = [];

console.log("========== 上网能力评测（真实网络 + 真实 LLM） ==========");
console.log(`模式: ${SKIP_NETWORK ? "链路模式（不依赖真实网络结果）" : "真实网络"}\n`);

for (const t of TASKS) {
  console.log(`【${t.id}】${t.name}...`);
  const before = Date.now();
  try {
    const r = await chatWithAgent(t.prompt);
    const tools = getRecentTools(30);
    const usedTool = tools.some((x) => x.tool_name === t.needTool);
    const contentOk = SKIP_NETWORK ? r.reply.length > 30 : t.check(r);
    const ok = usedTool && contentOk && r.reply.length > 0;
    results.push({ id: t.id, name: t.name, ok, usedTool, replyLen: r.reply.length, timeMs: Date.now() - before });
    console.log(`  ${ok ? "✅" : "❌"} 调用了${t.needTool}: ${usedTool ? "是" : "否"} | 回复长度: ${r.reply.length} | 耗时: ${((Date.now() - before) / 1000).toFixed(0)}s`);
    console.log(`  回复开头: ${r.reply.slice(0, 90).replace(/\n/g, " ")}`);
  } catch (e) {
    results.push({ id: t.id, name: t.name, ok: false, error: e.message.slice(0, 80) });
    console.log(`  ❌ 异常: ${e.message.slice(0, 80)}`);
  }
  console.log();
}

const pass = results.filter((r) => r.ok).length;
console.log("========== 结果 ==========");
for (const r of results) console.log(`  ${r.ok ? "✅" : "❌"} ${r.id} ${r.name}${r.error ? `（${r.error}）` : ""}`);
console.log(`\n上网能力: ${pass}/${results.length} = ${Math.round((pass / results.length) * 100)}%`);
