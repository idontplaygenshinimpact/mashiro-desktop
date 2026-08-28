// 学习清单：topic 归一化/相似判定（零依赖纯函数——拆出后无需 mockLLM 即可直测）
// 纵向拆分第 4 刀第一步：纯函数域先拆（原在 study.mjs 被 LLM 生成函数同文件绑架）

/**
 * topic 归一化：去括号/标点，去常见词尾（原理/机制/优化等），小写
 * 用于生成清单时的相似去重（防表述漂移导致重复条目 + 层级降级）
 */
export function normalizeTopic(t) {
  return String(t || "")
    .toLowerCase()
    .replace(/[（(].*?[)）]/g, "")        // 去括号内容
    .replace(/[^\p{L}\p{N}]/gu, "")       // 只留中英文/数字
    .replace(/[与和及之的]/g, "")         // 连词/助词全局删（"与/和/及/之/的"）
    .replace(/(机制|原理|详解|深入|介绍|优化|方案|实践|面试|题)/g, "") // 高频修饰后缀词全局删（"机制/原理/优化"等）
    .slice(0, 20);
}

/** 归一化后是否视为同一知识点（相等或词边界包含）
 * 修复：原实现 `a.includes(b)` 无词边界 → "React" ⊂ "ReactNative"、"CSS" ⊂ "CSS3"、
 * "HTTP" ⊂ "HTTPS" 均误判相似 → 全新知识点（React Native 性能优化）被生成去重跳过。
 * 规则：短串 ⊂ 长串时，要求长串中短串的"结尾后一位"不是字母数字（词边界）——
 * "事件循环"⊂"事件循环微任务"（后一位是"微"=中文，算边界→相似）✓
 * "css"⊂"css3"（后一位是数字=字母数字，不算边界→不相似）✓
 * "react"⊂"reactnative"（后一位是 n，不算边界→不相似）✓ */
export function isSimilarTopic(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  const idx = long.indexOf(short);
  if (idx < 0) return false;
  // 词边界：短串结尾后的字符不能是字母/数字（否则是词中间拼接，如 css3/https/reactnative）
  const next = long[idx + short.length];
  if (next && /[a-z0-9]/.test(next)) return false;
  return true;
}
