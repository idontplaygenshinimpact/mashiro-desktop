// 迁移学习清单 grp 到固定大类（可重复执行：幂等）
import { normalizeGroup } from "../lib/study.mjs";
import { db } from "../lib/db.mjs";
const rows = db.prepare("SELECT id, topic, grp, why FROM study_plan_items").all();
let changed = 0;
for (const r of rows) {
  const g = normalizeGroup(String(r.topic || ""), "", String(r.why || ""));
  if (g !== r.grp) {
    db.prepare("UPDATE study_plan_items SET grp=? WHERE id=?").run(g, r.id);
    changed++;
    console.log("  " + String(r.topic).slice(0, 28) + " -> [" + g + "]");
  }
}
console.log("迁移: " + changed + "/" + rows.length);
for (const d of db.prepare("SELECT grp, COUNT(*) n FROM study_plan_items GROUP BY grp ORDER BY n DESC").all()) {
  console.log("  " + d.grp + ": " + d.n);
}
process.exit(0);
