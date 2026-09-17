// 题面解析（ACM 笔试题面 → 结构化字段 + 可判题用例）
// 为什么需要：LeetCode 核心代码模式的题面基本一句话就能对上，而 ACM 笔试题面是**长文本**
// （题目描述 / 输入格式 / 输出格式 / 多组样例 / 数据范围 / 提示），
//   · 只拿标题当身份 → 两道题标题只差个括号就会被"相似合并"（实测 isSimilarTopicForArchive
//     对「n 个数求和（单组）」和「n 个数求和」返回 true）→ 讲解/复习卡串题；
//   · 样例是**天然的判题用例**（输入 + 期望输出成对出现），不解析出来就只能靠手填。
// 所以：题面解析负责把"人看的题"变成"机器能判的题"（结构 + ioCases），身份则交给题目 id。
export interface ParsedSample { input: string; expected: string }
export interface ParsedStatement {
  /** 输入格式段（原样文本，可能多行） */
  inputFormat: string;
  /** 输出格式段 */
  outputFormat: string;
  /** 数据范围/提示段（判复杂度用） */
  constraints: string;
  /** 从题面样例解析出的输入输出对（可直接当 ACM 判题用例） */
  samples: ParsedSample[];
  /** 标题候选（首行非空行；调用方给不出标题时用） */
  titleHint: string;
}

/** 段头匹配：中英文与常见变体（输入描述/输入格式/Input…） */
const HEAD_INPUT = /^\s*(?:【\s*)?(?:输入描述|输入格式|输入|input)\s*(?:】)?\s*[:：]?\s*$/i;
const HEAD_OUTPUT = /^\s*(?:【\s*)?(?:输出描述|输出格式|输出|output)\s*(?:】)?\s*[:：]?\s*$/i;
const HEAD_CONSTRAINT = /^\s*(?:【\s*)?(?:数据范围|数据规模|提示|说明|注意|约束|constraints?|hint)\s*(?:】)?\s*[:：]?\s*$/i;
/** 样例段头：样例输入 1 / 示例输入 / 输入示例 / Sample Input 1 … */
const HEAD_SAMPLE_IN = /^\s*(?:【\s*)?(?:样例|示例|sample)\s*(?:输入|input)\s*\d*\s*(?:】)?\s*[:：]?\s*$/i;
const HEAD_SAMPLE_OUT = /^\s*(?:【\s*)?(?:样例|示例|sample)\s*(?:输出|output)\s*\d*\s*(?:】)?\s*[:：]?\s*$/i;

/**
 * 解析题面：按段头切分，提取输入/输出/数据范围，并把"样例输入→样例输出"配对成用例。
 * 纯函数（不碰 DB/LLM），坏输入不抛错——解析不到就返回空，调用方按"没解析出样例"如实提示。
 */
export function parseStatement(text: unknown): ParsedStatement {
  const src = String(text ?? "").replace(/\r\n/g, "\n");
  const lines = src.split("\n");
  const out: ParsedStatement = { inputFormat: "", outputFormat: "", constraints: "", samples: [], titleHint: "" };
  out.titleHint = (lines.find((l) => l.trim()) || "").trim().replace(/^#+\s*/, "").slice(0, 80);

  type Section = "desc" | "input" | "output" | "constraint" | "sampleIn" | "sampleOut";
  const buckets: Record<Section, string[]> = { desc: [], input: [], output: [], constraint: [], sampleIn: [], sampleOut: [] };
  let cur: Section = "desc";
  for (const line of lines) {
    if (HEAD_SAMPLE_IN.test(line)) { cur = "sampleIn"; continue; }
    if (HEAD_SAMPLE_OUT.test(line)) { cur = "sampleOut"; continue; }
    if (HEAD_INPUT.test(line)) { cur = "input"; continue; }
    if (HEAD_OUTPUT.test(line)) { cur = "output"; continue; }
    if (HEAD_CONSTRAINT.test(line)) { cur = "constraint"; continue; }
    buckets[cur].push(line);
  }
  // 样例可能重复出现（样例1/样例2）→ 按**出现顺序**重新扫描一遍，得到有序的 (输入, 输出) 片段序列。
  // 关键：样例段必须在**下一个段头**（样例输入/输出、或输入格式/输出格式/数据范围等）处收尾——
  // 否则「数据范围」的正文会被并进最后一段样例输出里（实测踩到：期望输出变成 "30\n\n数据范围：…"）。
  const sequence: Array<{ kind: "in" | "out" | "end"; lines: string[] }> = [];
  for (const line of lines) {
    if (HEAD_SAMPLE_IN.test(line)) { sequence.push({ kind: "in", lines: [] }); continue; }
    if (HEAD_SAMPLE_OUT.test(line)) { sequence.push({ kind: "out", lines: [] }); continue; }
    if (HEAD_INPUT.test(line) || HEAD_OUTPUT.test(line) || HEAD_CONSTRAINT.test(line)) { sequence.push({ kind: "end", lines: [] }); continue; }
    const top = sequence[sequence.length - 1];
    if (top && top.kind !== "end") top.lines.push(line);
  }
  for (let i = 0; i < sequence.length - 1; i++) {
    const a = sequence[i], b = sequence[i + 1];
    if (a.kind !== "in" || b.kind !== "out") continue;
    const input = trimBlock(a.lines);
    const expected = trimBlock(b.lines);
    if (input || expected) out.samples.push({ input, expected });
  }
  out.inputFormat = trimBlock(buckets.input);
  out.outputFormat = trimBlock(buckets.output);
  out.constraints = trimBlock(buckets.constraint);
  return out;
}

/** 去掉首尾空行与行尾空白（保留行内格式与相对缩进——样例里的缩进有意义） */
function trimBlock(lines: string[]): string {
  const ls = lines.map((l) => l.replace(/[ \t]+$/, ""));
  while (ls.length && !ls[0].trim()) ls.shift();
  while (ls.length && !ls[ls.length - 1].trim()) ls.pop();
  return ls.join("\n");
}

/** 题面是否"看起来是 ACM 形态"（供录入时的自动判断与提示） */
export function looksLikeAcmStatement(text: unknown): boolean {
  const p = parseStatement(text);
  return p.samples.length > 0 || !!p.inputFormat || /多组|EOF|样例输入|输入格式/i.test(String(text ?? ""));
}
