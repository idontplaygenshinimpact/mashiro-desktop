// 拆分 panel.js（4624 行）→ 5 个普通 script 文件（保持全局作用域，按依赖顺序加载）
// core（工具/Tab）→ study（简历/面试/复习/学习）→ chat（对话/产出/杂项）→ jobs（求职/设置）→ rest（个人/题库/专注/初始化）
import { readFileSync, writeFileSync } from "node:fs";

const lines = readFileSync("desktop/renderer/panel.js", "utf8").split("\n");
const total = lines.length;
console.log(`panel.js 总行数: ${total}`);

// 边界（1-based 起止行，含）：必须落在区块注释行
const PARTS = [
  { name: "panel-core.js", start: 1, end: 64, desc: "全局错误捕获 / Tab 切换 / 公共工具（$ safeUrl）" },
  { name: "panel-study.js", start: 65, end: 1822, desc: "简历解析/项目拷打 / 模拟面试+录音 / 复习 FSRS/自测/即学/检验 / 错题本 / 批量 / 学习详情 / 面试实录" },
  { name: "panel-chat.js", start: 1823, end: 2323, desc: "对话 / 爬取产出 / 巡检设置 / 系统自检 / 语音开关 / 权限审批 / 提问条 / 一键重启 / 服务版本 / 桌宠形象 / 任务清单" },
  { name: "panel-jobs.js", start: 2324, end: 3448, desc: "校招匹配/投递 / 学习-求职闭环 / 平台账号 / 官方文档 / 驾驶舱 / 设置中心（方向/知识树/LLM/画像/RSS/巡检）" },
  { name: "panel-rest.js", start: 3449, end: total, desc: "个人主页 / 知识库 / 笔试真题 / 专项练习 / 手写题库 / 语音输入 / 专注监督 / 日程 / 对话历史 / 初始化" },
];

const HEADERS = {
  "panel-core.js": `// 真白面板 · 核心（纵向拆分：desktop/renderer/panel.js → 5 个文件，普通 script 按序加载共享全局作用域）
// 加载顺序：panel-core.js → panel-study.js → panel-chat.js → panel-jobs.js → panel-rest.js
`,
  "panel-study.js": `// 真白面板 · 学习/复习/面试域（纵向拆分）
`,
  "panel-chat.js": `// 真白面板 · 对话/产出/杂项域（纵向拆分）
`,
  "panel-jobs.js": `// 真白面板 · 求职/设置域（纵向拆分）
`,
  "panel-rest.js": `// 真白面板 · 个人/题库/专注/初始化域（纵向拆分）
`,
};

for (const p of PARTS) {
  const seg = lines.slice(p.start - 1, p.end);
  // 边界校验：起止行应为注释或空行（避免切在语句中间）
  const first = seg[0].trim();
  const last = seg[seg.length - 1].trim();
  if (first && !first.startsWith("//") && !first.startsWith("/*")) throw new Error(`${p.name} 起始行非注释: ${p.start}: ${first.slice(0, 50)}`);
  if (last && !last.startsWith("//") && last !== "}" && last !== ")") console.log(`⚠ ${p.name} 末行: ${p.end}: ${last.slice(0, 50)}`);
  const head = HEADERS[p.name] || "";
  writeFileSync(`desktop/renderer/${p.name}`, head + seg.join("\n") + "\n", "utf8");
  console.log(`${p.name}: ${seg.length} 行（${p.start}-${p.end}）`);
}
