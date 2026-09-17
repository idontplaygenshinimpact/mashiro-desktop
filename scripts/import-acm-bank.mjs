// 导入 ACM 模式题库（标准输入输出）到 challenges 表
// 用法：node scripts/import-acm-bank.mjs
// 幂等：importChallengesData 走 ON CONFLICT DO UPDATE 只刷内容列（mode/io_cases/题干等），保留做题进度。
import { importChallengesData } from "../lib/ai-career.mjs";
import { ACM_CHALLENGES } from "../lib/acm-bank.ts";

const list = ACM_CHALLENGES.map((c) => ({
  id: c.id,
  title: c.title,
  category: "algorithm", // ACM 题都是算法类（列表按 category 分组时进"算法"）
  difficulty: c.difficulty,
  frequency: c.frequency,
  timeLimit: c.timeLimit,
  description: c.description,
  skeleton: c.skeleton,
  testCode: "",          // ACM 模式不用 __test__ 断言
  mode: "acm",
  ioCases: c.ioCases,
  source: "acm-bank",
}));

const r = importChallengesData(list);
if (!r.ok) { console.error("❌ 导入失败:", r.error); process.exit(1); }
console.log(`✅ 已导入 ${r.imported} 道 ACM 模式题（source=acm-bank，判题走 readline/print 用例比对）`);
