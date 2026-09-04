// 批量替换：UTC 日期分桶 → localDateKey（M12 修复）
import { readFileSync, writeFileSync } from "node:fs";

const REPLACES = [
  // [file, old, new]
  ["lib/learning-plan.mjs", 'new Date(Number(r.ts)).toISOString().slice(0, 10)', 'localDateKey(Number(r.ts))'],
  ["lib/learning-plan.mjs", 'new Date(now).toISOString().slice(0, 10)', 'localDateKey(now)'],
  ["lib/review.mjs", 'new Date(Number(r.reviewed_at)).toISOString().slice(0, 10)', 'localDateKey(Number(r.reviewed_at))'],
  ["lib/review.mjs", 'new Date(Date.now() - i * 86400000).toISOString().slice(0, 10)', 'localDateKey(Date.now() - i * 86400000)'],
  ["lib/autonomy.mjs", 'new Date(now()).toISOString().slice(0, 10)', 'localDateKey(now())'],
  ["lib/dreaming.mjs", 'new Date(now).toISOString().slice(0, 10)', 'localDateKey(now)'],
  ["lib/patrol.mjs", 'new Date().toISOString().slice(0, 10)', 'localDateKey()'],
  ["lib/study-plan.mjs", 'new Date().toISOString().slice(0, 10)', 'localDateKey()'],
];

for (const [file, old, neu] of REPLACES) {
  let t = readFileSync(file, "utf8");
  if (!t.includes(old)) { console.log(`SKIP ${file}: ${old.slice(0, 40)}`); continue; }
  t = t.split(old).join(neu);
  // import 注入（幂等）
  if (!t.includes('from "./date-utils.mjs"')) {
    const m = t.match(/^import .*$/m);
    if (m) t = t.slice(0, m.index) + 'import { localDateKey } from "./date-utils.mjs";\n' + t.slice(m.index);
  }
  writeFileSync(file, t);
  console.log(`OK ${file}: ${old.slice(0, 50)}`);
}
