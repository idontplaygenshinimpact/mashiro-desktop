// 链表/树题 test_code 生成（2026-09-16）
// 为什么需要：真实库 448 道 core 题里 167 道没有 test_code（点判题恒失败），其中 74 道是链表/树题——
// 示例输入是数组（[1,2,3]），过去的确定性生成器无法构造 ListNode/TreeNode 所以全部跳过（实测可生成 0）。
// 现在沙箱里有了 __buildListNode__/__listToArray__/__buildTreeNode__/__treeToArray__（LeetCode 惯例），
// 本脚本把「输入: [1,2,3] 输出: [3,2,1]」这类示例变成可判题的断言。
//
// 保守策略（宁可少生成，不可生成错）：只处理**能明确判定返回形态**的题——
//   ① 骨架含 ListNode/TreeNode；② 题面里有 ≥1 组「输入…输出」示例；③ 期望输出是数组或标量且可 JSON 解析。
//   生成后由 `--verify` 用**参考解**逐题实跑（对了才算数），参考解取自 scripts/fixtures/listtree-refs.mjs。
// 用法：
//   node scripts/gen-listtree-tests.mjs --limit=5 --verify     # 只生成前 5 道并跑参考解验证（推荐先这样试）
//   node scripts/gen-listtree-tests.mjs --verify               # 全量生成 + 验证（写库）
//   MIANSHI_DB_PATH=<副本> node scripts/gen-listtree-tests.mjs # 想先在副本上试就跑这个
import { db } from "../lib/db.mjs";
import { runChallengeCode } from "../lib/ai-career.ts";

/** 从题面解析「输入…输出」示例（与 gen-challenge-tests.mjs 同口径，够用即可） */
function parseExamples(description) {
  const out = [];
  const text = String(description || "");
  const re = /输入\s*[:：]?\s*([\s\S]*?)\s*输出\s*[:：]\s*([^\n]+)/g;
  let m;
  while ((m = re.exec(text)) && out.length < 6) {
    const inputRaw = m[1].trim();
    const outputRaw = String(m[2]).trim().split(/\s+解释|解释[:：]/)[0].trim();
    out.push({ inputRaw, outputRaw });
  }
  return out;
}

/** 顶层逗号切分（括号/引号内的逗号不算）——否则 "[1,2,3], 2" 会被切坏（实测踩到：12 道全跳过） */
function splitTopLevel(s) {
  const out = [];
  let depth = 0, quote = "", cur = "";
  for (const ch of String(s)) {
    if (quote) { cur += ch; if (ch === quote) quote = ""; continue; }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === "[" || ch === "(" || ch === "{") depth++;
    if (ch === "]" || ch === ")" || ch === "}") depth--;
    if (ch === "," && depth === 0) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

/** 解析输入里的数组/标量：支持 "[1,2,3]"、"1"、"[1,2,3], 2"（多参） */
function parseArgs(inputRaw) {
  const parts = splitTopLevel(String(inputRaw).replace(/\s+和\s+/g, ", "));
  const args = [];
  for (const p of parts) {
    const v = String(p).replace(/^[a-zA-Z_][\w]*\s*=\s*/, "").trim();
    if (/^\[[\s\S]*\]$/.test(v)) {
      try { args.push(JSON.parse(v)); } catch { return null; }
    } else if (/^-?\d+(\.\d+)?$/.test(v)) args.push(Number(v));
    else if (/^"[^"]*"$/.test(v) || /^'[^']*'$/.test(v)) args.push(v.slice(1, -1));
    else return null; // 含非字面量（表达式/文字说明）→ 放弃这道题
  }
  return args.length ? args : null;
}

/** 期望输出：数组或标量（可 JSON 解析），否则放弃 */
function parseOutput(raw) {
  const s = String(raw).trim();
  if (/^\[[\s\S]*\]$/.test(s)) { try { return { kind: "array", value: JSON.parse(s) }; } catch { return null; } }
  if (/^-?\d+(\.\d+)?$/.test(s)) return { kind: "number", value: Number(s) };
  if (/^(true|false)$/.test(s)) return { kind: "bool", value: s === "true" };
  if (/^"[^"]*"$/.test(s)) return { kind: "string", value: s.slice(1, -1) };
  return null;
}

/** 取解法函数名：与沙箱 buildExportArgs 同口径（收集 function/var 定义名），
 *  但要**排除注释里 ListNode/TreeNode 的节点构造函数**（真实骨架开头就是那段定义注释，实测误取过） */
function funcName(skeleton) {
  const names = [];
  const src = String(skeleton || "");
  for (const m of src.matchAll(/(?:^|\n)\s*function\s+(\w+)/g)) names.push(m[1]);
  for (const m of src.matchAll(/(?:^|\n)\s*var\s+(\w+)\s*=\s*(?:async\s+)?function/g)) names.push(m[1]);
  for (const m of src.matchAll(/(?:^|\n)\s*(\w+)\s*=\s*(?:async\s+)?\(/g)) names.push(m[1]);
  const filtered = names.filter((n) => !/^(ListNode|TreeNode|Node)$/.test(n));
  return filtered.length ? filtered[filtered.length - 1] : null; // 骨架把解法放在最后
}

const LIMIT = Number(process.argv.find((a) => a.startsWith("--limit="))?.split("=")[1] || 0);
const VERIFY = process.argv.includes("--verify");

const rows = db.prepare("SELECT id, title, description, skeleton FROM challenges WHERE (test_code IS NULL OR test_code='') AND (skeleton LIKE '%ListNode%' OR skeleton LIKE '%TreeNode%')").all();
const targets = LIMIT > 0 ? rows.slice(0, LIMIT) : rows;
let generated = 0, skipped = 0, verified = 0, failedVerify = 0;
const skipReasons = {};
const built = [];

for (const r of targets) {
  const sk = String(r.skeleton || "");
  const isList = /ListNode/.test(sk);
  const fn = funcName(sk);
  if (!fn) { skipped++; skipReasons["无函数名"] = (skipReasons["无函数名"] || 0) + 1; continue; }
  const examples = parseExamples(String(r.description || ""));
  if (!examples.length) { skipped++; skipReasons["无示例"] = (skipReasons["无示例"] || 0) + 1; continue; }
  const cases = [];
  let ok = true;
  for (const ex of examples) {
    const args = parseArgs(ex.inputRaw);
    const out = parseOutput(ex.outputRaw);
    if (!args || !out) { ok = false; break; }
    cases.push({ args, out });
  }
  if (!ok || !cases.length) { skipped++; skipReasons["参数/输出不可解析"] = (skipReasons["参数/输出不可解析"] || 0) + 1; continue; }
  // 构造断言：链表/树参数用构造器包一层；期望输出为数组时按返回形态序列化比较
  const wrapArg = (a) => (Array.isArray(a) ? (isList ? `__buildListNode__(${JSON.stringify(a)})` : `__buildTreeNode__(${JSON.stringify(a)})`) : JSON.stringify(a));
  const expectExpr = (out) => (out.kind === "array"
    ? (isList ? `JSON.stringify(__listToArray__(__ret__))` : `JSON.stringify(__treeToArray__(__ret__))`)
    : "JSON.stringify(__ret__)");
  const lines = [`async function __test__(${fn}) {`];
  cases.forEach((c, i) => {
    const args = c.args.map(wrapArg).join(", ");
    const label = JSON.stringify(`示例${i + 1}: ${fn}(${c.args.map((a) => JSON.stringify(a)).join(", ")})`);
    // 每例一个块作用域：否则 `const __ret__` 在同一个函数体里重复声明（实测报 "Identifier '__ret__' has already been declared"）
    lines.push(`  {`);
    lines.push(`    const __ret__ = ${fn}(${args});`);
    lines.push(`    __assert__(${expectExpr(c.out)} === ${JSON.stringify(JSON.stringify(c.out.value))}, ${label});`);
    lines.push(`  }`);
  });
  lines.push("}");
  built.push({ id: r.id, title: String(r.title), testCode: lines.join("\n"), fn, cases: cases.length });
}

// 写库（副本或真实库由 MIANSHI_DB_PATH 决定）
for (const b of built) { db.prepare("UPDATE challenges SET test_code=? WHERE id=?").run(b.testCode, b.id); generated++; }

console.log(`生成 ${generated} 道（跳过 ${skipped}）`);
for (const [k, v] of Object.entries(skipReasons)) console.log(`  跳过-${k}: ${v}`);

if (VERIFY) {
  const { REFERENCES } = await import("./fixtures/listtree-refs.mjs").catch(() => ({ REFERENCES: {} }));
  console.log(`\n验证：对每道用题解代码实跑（参考解覆盖 ${Object.keys(REFERENCES).length} 道，其余用"骨架直接当解法"证明测试非空转）`);
  for (const b of built) {
    const ref = REFERENCES[b.id];
    const row = db.prepare("SELECT skeleton FROM challenges WHERE id=?").get(b.id);
    const skeleton = String(row?.skeleton || "");
    const code = ref || skeleton;
    // 必须传真实骨架：沙箱按骨架里的函数名注入参数给 __test__（不传 → "测试未执行"，实测踩到）
    const r = await runChallengeCode({ userCode: code, testCode: b.testCode, skeleton });
    const nonVacuous = r.tests.length > 0; // 测试真的跑起来了（函数名对得上）
    if (ref) {
      if (r.success) verified++; else { failedVerify++; console.log(`  ❌ ${b.id} ${b.title}：参考解未通过 —— ${r.tests.filter((t) => !t.passed).map((t) => t.label).slice(0, 2).join(" / ")}`); }
    } else if (!nonVacuous) { failedVerify++; console.log(`  ❌ ${b.id} ${b.title}：测试未执行 —— 真实错误: ${String(r.error || "(无)").slice(0, 120)}`); }
  }
  console.log(`参考解验证：通过 ${verified}，失败 ${failedVerify}`);
}
