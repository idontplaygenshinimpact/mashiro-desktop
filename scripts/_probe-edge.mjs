// 临时：查 edge profile 的 cookie 过滤状态
import { DatabaseSync } from "node:sqlite";
import { globSync } from "node:fs";
import path from "node:path";

for (const d of ["data/edge-user-profile", "data/nowcoder-edge-profile"]) {
  const cookies = [];
  try { cookies.push(...globSync(path.join(d, "**", "Cookies"))); } catch { /* ignore */ }
  if (!cookies.length) { console.log(`${d}: 无 Cookies 文件`); continue; }
  for (const c of cookies.slice(0, 2)) {
    try {
      const db = new DatabaseSync(c, { readOnly: true });
      const total = db.prepare("SELECT COUNT(*) n FROM cookies").get().n;
      const nowcoder = db.prepare("SELECT COUNT(*) n FROM cookies WHERE host_key LIKE '%nowcoder%'").get().n;
      console.log(`${d}/${path.basename(path.dirname(c))}: 总 ${total} 牛客 ${nowcoder} ${nowcoder === total ? "(仅牛客域 ✓)" : "(未过滤)"}`);
    } catch (e) { console.log(`${d}: 读取失败 ${e.message.slice(0, 50)}`); }
  }
}
