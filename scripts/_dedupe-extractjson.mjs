// L1：删除 4 处 extractJson 重复定义（统一到 llm.mjs 导出）+ 注入 import
// 函数结束 `}` 在行首无缩进（项目格式）→ `\n}` 精确匹配函数体
import { readFileSync, writeFileSync } from "node:fs";

const FILES = ["lib/ai.mjs", "lib/dreaming.mjs", "lib/mail.mjs", "lib/rss.mjs"];
const RE = /function extractJson\(raw\) \{[\s\S]*?\n\}/;

for (const f of FILES) {
  let t = readFileSync(f, "utf8");
  if (!RE.test(t)) { console.log(`SKIP ${f}: 未匹配`); continue; }
  t = t.replace(RE, "");
  // import 注入（llm.mjs；已有 llm import 则并入）
  const m = t.match(/(import \{ [^}]+\} from "\.\/llm\.mjs";)/);
  if (m) {
    t = t.replace(m[1], m[1].replace("} from", ", extractJson } from"));
  } else {
    const first = t.match(/^import .*$/m);
    t = t.slice(0, first.index) + 'import { extractJson } from "./llm.mjs";\n' + t.slice(first.index);
  }
  writeFileSync(f, t);
  console.log(`OK ${f}`);
}
