// 中文关键词匹配统一工具（7 个独立实现的公共层）
// 背景：n-gram 相似度（memory.mjs）/ indexOf 包含（study-topic.mjs）/ kws 子串
// （study-groups.mjs、knowledge.mjs matchKp）/ 正则方向判定（ai.mjs）/ bigram 编辑距离
// （followup-cache.mjs）/ normName includes（study-files.mjs）各自为政——每次修复只补
// 单个调用点，组合词排除/独立成词/特异性门槛/词边界经验没有沉淀，其他调用点继续踩同类坑。
// 本模块统一：组合词表（一处更新全局生效）+ 独立成词 + 词边界 + n-gram + 组合词正则生成器。
// 红线：纯规则零 LLM 判断，零成本。

// ---------- 1) 组合词表（统一维护） ----------
// 单字/双字强语义词（数据结构等）命中时，若文本含已知组合词（该词作为组合词一部分），
// 视为组合词不独立 → 不命中。只排除"非目标语义"的组合——"二叉树"含"树"但二叉树本身
// 就该命中算法组，不在表内。
export const COMPOUND_EXCLUDE = [
  "技术栈", // 栈（数据结构）vs 技术栈（技术组合）
  "堆叠", "堆砌", "堆放", // 堆 vs CSS/普通词
  "消息队列", "任务队列", "微任务队列", "事件队列", // 队列（数据结构）vs 架构/事件循环概念
  "知识树", "树形", "树状", "树结构", "目录树", // 树 vs 分类体系/CSS
  "流程图", "架构图", "图谱", "思维导图", "图表", "图片", // 图 vs 图表
  "栈溢出", "调用栈", // 栈（运行时）vs 栈（数据结构）——调用栈/栈溢出是运行时概念
  "流式输出", "流式返回", "流式响应", // 流 vs 流式（LLM 流式输出不是算法流）
  "状态机", "状态管理", // 状态 vs 状态机/状态管理（前端概念）
  "队列任务", // 队列 vs 任务队列变体
];

// ---------- 2) 独立成词检测 ----------
/** 强语义词命中检测：kw 命中且（kw 为长词 或 文本不含含 kw 的组合词）；大小写不敏感 */
export function kwHit(text, kw) {
  const t = String(text).toLowerCase();
  if (!t.includes(kw)) return false;
  if (kw.length <= 2 && COMPOUND_EXCLUDE.some((c) => c.includes(kw) && t.includes(c))) return false;
  return true;
}

// ---------- 3) 词边界 ----------
/** 短串 ⊂ 长串时要求词边界：短串结尾后的字符不能是字母/数字（否则是词中间拼接）
 * "事件循环"⊂"事件循环微任务"（后一位"微"=中文→边界→相似）✓
 * "css"⊂"css3"（后一位数字→不相似）✓ "react"⊂"reactnative"（后一位 n→不相似）✓ */
export function hasWordBoundary(long, short) {
  const idx = String(long).indexOf(String(short));
  if (idx < 0) return false;
  const next = String(long)[idx + String(short).length];
  return !(next && /[a-z0-9]/.test(next));
}

// ---------- 4) n-gram ----------
/** 提取字符串的 n-gram 集合（中文友好；n=2 双字、n=3 三字） */
export function grams(s, n) {
  const out = new Set();
  const t = String(s || "");
  for (let i = 0; i + n <= t.length; i++) out.add(t.slice(i, i + n));
  return out;
}

// ---------- 5) 组合词正则生成器 ----------
/** 从组合词表生成"排除正则"：文本含任一组合词 → 命中（供正则方向判定排除用）
 * 例：compoundRegex(["技术栈","消息队列"]) → /技术栈|消息队列/ */
export function compoundRegex(words = COMPOUND_EXCLUDE) {
  const esc = (w) => String(w).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(words.map(esc).join("|"), "i");
}

// ---------- 6) 特异性门槛 ----------
/** 关键词命中要求至少一个长词（中文 ≥3 字 / 英文 ≥4 字符）——短泛词（缓存/模板/锁）不可信
 * 背景：只靠短泛词命中的点不可信（"手撕LRU缓存"被"缓存"吸到浏览器原理） */
export function hasSpecificKw(hitKws) {
  return hitKws.some((k) => {
    const s = String(k).toLowerCase();
    return /[\u4e00-\u9fff]/.test(s) ? s.length >= 3 : s.length >= 4;
  });
}
