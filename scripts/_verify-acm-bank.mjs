// 验证 ACM 题库 + 新判题器：为每道题写参考解，用**新加的 ACM 判题**跑一遍，期望全部 success:true。
// 这一步同时验证两件事：① 题库的期望输出是我手算/推导错的没有；② 判题协议（readline/print/多用例）真能跑。
// 用法：node --experimental-strip-types scripts/_verify-acm-bank.mjs
import { ACM_CHALLENGES } from "../lib/acm-bank.ts";
import { runChallengeCode } from "../lib/ai-career.ts";

const SOLUTIONS = {
  "acm-a-plus-b": `const out = [];
while (true) { const line = readline(); if (line === null) break; if (!line.trim()) continue; const [a, b] = line.trim().split(/\\s+/).map(Number); out.push(a + b); }
print(out.join("\\n"));`,
  "acm-sum-n": `const n = Number(readline()); const arr = readline().trim().split(/\\s+/).map(Number).slice(0, n); print(arr.reduce((a, b) => a + b, 0));`,
  "acm-max-min": `const n = Number(readline()); const a = readline().trim().split(/\\s+/).map(Number).slice(0, n); print(Math.max(...a) - Math.min(...a));`,
  "acm-reverse-words": `const s = readline().trim(); print(s.split(/\\s+/).reverse().join(" "));`,
  "acm-many-a-plus-b": `const T = Number(readline()); const out = []; for (let i = 0; i < T; i++) { const [a, b] = readline().trim().split(/\\s+/).map(Number); out.push(a + b); } print(out.join("\\n"));`,
  "acm-count-words": `let all = []; while (true) { const l = readline(); if (l === null) break; all.push(l); } print(all.join(" ").trim().split(/\\s+/).filter(Boolean).length);`,
  "acm-sort-asc": `const n = Number(readline()); const a = readline().trim().split(/\\s+/).map(Number).slice(0, n); print(a.sort((x, y) => x - y).join(" "));`,
  "acm-prefix-sum": `const [n, q] = readline().trim().split(/\\s+/).map(Number); const a = readline().trim().split(/\\s+/).map(Number); const pre = [0]; for (let i = 0; i < n; i++) pre.push(pre[i] + a[i]); const out = []; for (let i = 0; i < q; i++) { const [l, r] = readline().trim().split(/\\s+/).map(Number); out.push(pre[r] - pre[l - 1]); } print(out.join("\\n"));`,
  "acm-two-sum-sorted": `const [n, target] = readline().trim().split(/\\s+/).map(Number); const a = readline().trim().split(/\\s+/).map(Number); let i = 0, j = n - 1, found = null; while (i < j) { const s = a[i] + a[j]; if (s === target) { found = [i + 1, j + 1]; break; } if (s < target) i++; else j--; } print(found ? "YES " + found.join(" ") : "NO");`,
  "acm-stairs-dp": `const T = Number(readline()); const out = []; for (let t = 0; t < T; t++) { const n = Number(readline()); const dp = [0, 1, 2]; for (let i = 3; i <= n; i++) dp[i] = dp[i - 1] + dp[i - 2]; out.push(n === 1 ? 1 : dp[n]); } print(out.join("\\n"));`,
  "acm-gcd-sum": `const gcd = (a, b) => (b === 0 ? a : gcd(b, a % b)); const out = []; while (true) { const l = readline(); if (l === null) break; if (!l.trim()) continue; const [a, b] = l.trim().split(/\\s+/).map(Number); const g = gcd(a, b); out.push(g + " " + (a / g) * b); } print(out.join("\\n"));`,
  "acm-bracket-match": `const pairs = { ")": "(", "]": "[", "}": "{" }; const out = []; while (true) { const s = readline(); if (s === null) break; if (!s.trim()) continue; const st = []; let ok = true; for (const ch of s.trim()) { if ("([{".includes(ch)) st.push(ch); else if (pairs[ch]) { if (st.pop() !== pairs[ch]) { ok = false; break; } } } if (st.length) ok = false; out.push(ok ? "YES" : "NO"); } print(out.join("\\n"));`,
  "acm-matrix-transpose": `const [m, n] = readline().trim().split(/\\s+/).map(Number); const g = []; for (let i = 0; i < m; i++) g.push(readline().trim().split(/\\s+/).map(Number)); const out = []; for (let j = 0; j < n; j++) { const row = []; for (let i = 0; i < m; i++) row.push(g[i][j]); out.push(row.join(" ")); } print(out.join("\\n"));`,
  "acm-count-char": `const s = readline().trim(); const c = readline().trim(); let n = 0; for (const ch of s) if (ch === c) n++; print(n);`,
  "acm-fib-mod": `const MOD = 1000000007; const T = Number(readline()); const out = []; for (let t = 0; t < T; t++) { const n = Number(readline()); let a = 1, b = 1; for (let i = 3; i <= n; i++) { const c = (a + b) % MOD; a = b; b = c; } out.push(n <= 2 ? 1 : b); } print(out.join("\\n"));`,
};

let pass = 0;
const failed = [];
for (const ch of ACM_CHALLENGES) {
  const code = SOLUTIONS[ch.id];
  if (!code) { failed.push(`${ch.id}: 缺参考解`); continue; }
  const r = await runChallengeCode({ userCode: code, mode: "acm", cases: ch.ioCases });
  if (r.success) { pass++; console.log(`✅ ${ch.id}（${ch.ioCases.length} 用例）`); }
  else {
    failed.push(ch.id);
    console.log(`❌ ${ch.id}`);
    for (const t of r.tests) {
      if (!t.passed) console.log(`   ${t.label}\n   输入: ${JSON.stringify(t.input)}\n   期望: ${JSON.stringify(t.expected)}\n   实际: ${JSON.stringify(t.actual)}`);
    }
    if (r.error) console.log(`   error: ${r.error}`);
  }
}
console.log(`\n通过 ${pass}/${ACM_CHALLENGES.length}`);
if (failed.length) { console.log("失败清单:", failed.join(", ")); process.exitCode = 1; }
