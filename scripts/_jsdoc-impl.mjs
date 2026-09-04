// 收尾工单任务 2：tools/impl-*.mjs 补 JSDoc（函数名 → JSDoc 块映射，插入到函数行前）
import { readFileSync, writeFileSync } from "node:fs";

const DOCS = {
  toolSearchPosts: `/**
 * 搜索面经帖子（站点过滤 + 关键词）
 * @param {string} query 搜索关键词
 * @param {string} [site] 站点（auto/牛客/CSDN 等）
 * @returns {Promise<Array<{title: string, url: string, snippet: string}>>} 帖子列表
 */`,
  toolFetchPage: `/**
 * 抓取网页正文（SSRF 前置校验 + Node fetch；掘金 SPA 走 API）
 * @param {string} url 目标 URL
 * @returns {Promise<{title: string, text: string, url: string, invalid: boolean}>} 页面内容
 */`,
  toolBrowse: `/**
 * 浏览工具路由（按 name 分发到具体实现）
 * @param {string} name 工具名
 * @param {any} args 工具参数
 * @returns {Promise<any>} 工具结果
 */`,
  toolDetectQuestions: `/**
 * 从面经文本提取面试题
 * @param {{ title: string, text: string }} arg 面经标题 + 正文
 * @returns {Promise<Array<{topic: string, question: string}>>} 提取的题目
 */`,
  toolGetRecentOutputs: `/**
 * 获取最近产出（巡检/搜集的存档列表）
 * @returns {Promise<Array<{date: string, dir: string, files: number}>>} 产出目录列表
 */`,
  toolRecordInterviewTopics: `/**
 * 记录面试涉及的知识点（薄弱点回流）
 * @param {string[]} topics 知识点列表
 * @param {string} company 公司名
 * @returns {Promise<{ok: boolean, added: number}>} 记录结果
 */`,
  toolSolveQuestion: `/**
 * 生成题目讲解（面试官工具——出题后讲解）
 * @param {{ question: string, company: string, sourceUrl?: string }} arg 题目信息
 * @returns {Promise<string>} 讲解全文
 */`,
  toolGetMemoryExpanded: `/**
 * 获取记忆展开（画像/关注点/薄弱点/掌握度全量）
 * @returns {Promise<{profile: string, interests: string[], weakPoints: string[], mastered: string[]}>} 记忆数据
 */`,
  toolRemember: `/**
 * 记录长期记忆（用户显式要求记住的内容）
 * @param {string[]} topics 要记住的知识点
 * @returns {Promise<{ok: boolean, added: number}>} 记录结果
 */`,
  toolReadToolResult: `/**
 * 读取工具结果存档（tool_results 目录）
 * @param {string} file 文件名
 * @returns {Promise<{ok: boolean, content?: string, error?: string}>} 文件内容
 */`,
};

const FILES = {
  "lib/tools/impl-search.mjs": ["toolSearchPosts", "toolFetchPage", "toolBrowse"],
  "lib/tools/impl-interview.mjs": ["toolDetectQuestions", "toolGetRecentOutputs", "toolRecordInterviewTopics", "toolSolveQuestion"],
  "lib/tools/impl-memory.mjs": ["toolGetMemoryExpanded", "toolRemember"],
  "lib/tools/impl-misc.mjs": ["toolReadToolResult"],
};

for (const [f, fns] of Object.entries(FILES)) {
  let t = readFileSync(f, "utf8");
  for (const fn of fns) {
    const re = new RegExp(`(export async function ${fn}\\()`, "g");
    if (!re.test(t)) { console.log(`SKIP ${f}: ${fn} 未找到`); continue; }
    t = t.replace(re, `${DOCS[fn]}\nexport async function ${fn}(`);
  }
  writeFileSync(f, t);
  console.log(`OK ${f}: ${fns.join(", ")}`);
}
