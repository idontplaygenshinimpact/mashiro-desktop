// 学习清单模块：从产出提炼优先学习内容 + 勾选完成 + 复盘验证
// 纵向拆分第 4 刀：本文件降为桶 re-export（引用方 import 路径不变，零改动）
// - 纯函数域：lib/study-topic.mjs（normalizeTopic/isSimilarTopic，零依赖）
// - 大类归一化：lib/study-groups.mjs（normalizeGroup/EXTRA_GROUP_RULES/ALGO_HANDWRITE_STRONG）
// - 存储层：lib/study-store.mjs（loadPlan/savePlan/newPlanId，只依赖 db）
// - 生成/勾选/同步/回填：lib/study-plan.mjs
// - 复盘：lib/study-review.mjs（startReview/answerReview）
export { normalizeGroup, EXTRA_GROUP_RULES, ALGO_HANDWRITE_STRONG } from "./study-groups.mjs";
export { normalizeTopic, isSimilarTopic } from "./study-topic.mjs";
export { generateStudyPlan, getPlan, addPlanItems, syncResumeProjectItems, backfillPlanGroups, checkItem } from "./study-plan.mjs";
export { startReview, answerReview } from "./study-review.mjs";
