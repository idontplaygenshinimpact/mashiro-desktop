// 题库 test_code 自动生成：从 CodeTop 题目描述解析示例 → 生成沙箱测试用例
// 覆盖范围：函数题（骨架为 function/var fn = function），示例输入可 JSON 解析的字面量
// 跳过：类题（var Xxx = function 构造器）、输入含非 JSON 字面量（如 'abc' 字符串带引号歧义）
// 用法：node scripts/gen-challenge-tests.mjs [--limit N]（默认处理全部可生成的）
import { db } from "../lib/db.mjs";

// 解析描述中的示例块："输入: X 输出: Y" 或 "输入 X 输出 Y"
function parseExamples(description) {
  const out = [];
  const text = String(description || "");
  // 找所有 "输入[:] ... 输出[:] ..." 对（含 示例 N: 前缀）
  const re = /输入\s*[:：]?\s*([\s\S]*?)\s*输出\s*[:：]\s*([^\n]+)/g;
  let m;
  while ((m = re.exec(text)) && out.length < 6) {
    const inputRaw = m[1].trim();
    // 输出值只取到"解释/空格/换行"前（修复：原实现把"2 解释：..."整行吃进期望值）
    const outputRaw = String(m[2]).trim().split(/\s+解释|解释[:：]|^[\s]+/)[0].trim();
    out.push({ inputRaw, outputRaw });
  }
  return out;
}

// 把 "3" / "[1,2,3]" / "[1,2] 和 k = 2" / '"abc"' 解析为 JS 参数
function parseArgs(inputRaw) {
  // 多参数："[3,2,1,5,6,4] 和 k = 2" → 按 "和" 或 "，" 分割再分别解析
  const parts = String(inputRaw).split(/\s*和\s*|\s*，\s*|\s*,\s*(?=[a-zA-Z_])/).filter(Boolean);
  const args = [];
  for (const p of parts) {
    // 去 "xxx = " 前缀（如 "k = 2"）
    const val = String(p).replace(/^[a-zA-Z_]+\s*=\s*/, "").trim();    // 去掉尾部多余描述（如 "输出 5" 之后的解释）
    const cleaned = val.replace(/\s*解释[\s\S]*$/, "").replace(/\s*提示[\s\S]*$/, "").trim();
    if (!cleaned) continue;
    try {
      args.push(JSON.parse(cleaned)); // 数字/数组/对象/带引号字符串
    } catch {
      // 非 JSON：可能是裸字符串（如 s = abcabcbb）→ 按原样字符串
      const bare = cleaned.replace(/^["']|["']$/g, "");
      if (/^[A-Za-z0-9_-]+$/.test(bare)) args.push(bare);
      else return null; // 无法解析 → 跳过此题
    }
  }
  return args.length ? args : null;
}

function parseOutput(outputRaw) {
  const raw = String(outputRaw).trim();
  // LeetCode 示例用 True/False（Python 风格），JS 函数返回 true/false → 归一化
  if (/^True$/.test(raw)) return true;
  if (/^False$/.test(raw)) return false;
  const cleaned = raw.replace(/^["']|["']$/g, "").trim();
  try { return JSON.parse(cleaned); } catch { return cleaned; }
}

// 从骨架提取函数名
function funcName(skeleton) {
  const m = String(skeleton).match(/(?:function\s+(\w+)|var\s+(\w+)\s*=\s*function)/);
  return m ? (m[1] || m[2]) : null;
}

// 生成 __test__ 代码
function buildTestCode(fnName, examples) {
  const lines = [`async function __test__(${fnName}) {`];
  examples.forEach((ex, i) => {
    const args = ex.args;
    const out = ex.output;
    const argText = args.map((a) => JSON.stringify(a)).join(", ");
    // JSON.stringify 两侧一致：fn 返回值序列化 === 期望值序列化（5 vs "5" 等类型不匹配会暴露）
    const expectText = JSON.stringify(out);
    lines.push(`  __assert__(JSON.stringify(${fnName}(${argText})) === ${JSON.stringify(expectText)}, '示例${i + 1}: ${fnName}(${argText.slice(0, 60)}) = ${expectText.slice(0, 40)}');`);
  });
  lines.push("}");
  return lines.join("\n");
}

// 主流程
const LIMIT = Number(process.argv.find((a) => a.startsWith("--limit="))?.split("=")[1] || 0);
const rows = db.prepare("SELECT id, title, description, skeleton, test_code FROM challenges WHERE source='codetop' AND test_code='' AND skeleton NOT LIKE '// 未获取%' ORDER BY frequency DESC").all();
let generated = 0, skipped = 0, skipReasons = {};
const targets = LIMIT > 0 ? rows.slice(0, LIMIT) : rows;
for (const r of targets) {
  const fn = funcName(String(r.skeleton));
  if (!fn) { skipped++; skipReasons["无函数名"] = (skipReasons["无函数名"] || 0) + 1; continue; }
  // 跳过链表/树/图题：示例输入是数组但函数参数是 ListNode/TreeNode 节点——自动测试无法构造
  if (/ListNode|TreeNode|Node\(|head|root/.test(String(r.skeleton))) {
    skipped++; skipReasons["链表/树/图题"] = (skipReasons["链表/树/图题"] || 0) + 1; continue;
  }
  const examples = parseExamples(String(r.description));
  if (!examples.length) { skipped++; skipReasons["无示例"] = (skipReasons["无示例"] || 0) + 1; continue; }
  const built = [];
  let ok = true;
  for (const ex of examples) {
    const args = parseArgs(ex.inputRaw);
    if (!args) { ok = false; break; }
    built.push({ args, output: parseOutput(ex.outputRaw) });
  }
  if (!ok) { skipped++; skipReasons["参数不可解析"] = (skipReasons["参数不可解析"] || 0) + 1; continue; }
  const testCode = buildTestCode(fn, built);
  db.prepare("UPDATE challenges SET test_code=? WHERE id=?").run(testCode, r.id);
  generated++;
}
console.log(`可生成: ${generated}，跳过: ${skipped}`);
for (const [k, v] of Object.entries(skipReasons)) console.log(`  跳过-${k}: ${v}`);
