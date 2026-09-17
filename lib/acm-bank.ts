// ACM 模式题库（标准输入输出判题）：秋招笔试真题形态——自己读输入、自己输出、多组用例。
// 为什么单独一份：本地题库原先只有 LeetCode 核心代码模式（骨架函数 + __test__ 断言），
// 而牛客/赛码等笔试平台绝大多数是 ACM 模式，"读入解析 / 输出格式 / 多组用例 / EOF 处理"是独立考点。
// 约定（与国内 OJ 的 JS 环境一致）：readline() 逐行取输入（耗尽返回 null）；print(...) 输出。
// 数据来源：本人手写（经典题型），非抓取；用例均为手工构造并验证过期望输出。
export interface AcmChallenge {
  id: string;
  title: string;
  difficulty: number;
  frequency: number;
  timeLimit: number;
  description: string;
  skeleton: string;
  ioCases: Array<{ input: string; expected: string }>;
}

/** ACM 骨架统一提示（学员照着写 main 流程） */
const SK = `// ACM 模式：自己读输入、自己输出（readline() 逐行读，耗尽返回 null；print(...) 输出）
// 注意多组输入/EOF 处理，输出格式要与样例完全一致（行尾空格会被忽略，行内空格不会）
`;

export const ACM_CHALLENGES: AcmChallenge[] = [
  {
    id: "acm-a-plus-b",
    title: "A+B（多组输入直到 EOF）",
    difficulty: 1, frequency: 3, timeLimit: 5,
    description: "输入格式：多行，每行两个整数 a b，直到文件结束（EOF）。\n输出格式：每行一个整数，表示 a+b。\n\n样例输入：\n1 2\n3 4\n\n样例输出：\n3\n7",
    skeleton: SK,
    ioCases: [
      { input: "1 2\n3 4", expected: "3\n7" },
      { input: "0 0\n-5 5\n1000000 2000000", expected: "0\n0\n3000000" },
    ],
  },
  {
    id: "acm-sum-n",
    title: "n 个数求和（单组）",
    difficulty: 1, frequency: 3, timeLimit: 5,
    description: "输入格式：第一行一个整数 n（1 ≤ n ≤ 1000），第二行 n 个整数。\n输出格式：一行，n 个数的和。\n\n样例输入：\n3\n1 2 3\n\n样例输出：\n6",
    skeleton: SK,
    ioCases: [
      { input: "3\n1 2 3", expected: "6" },
      { input: "1\n-7", expected: "-7" },
      { input: "5\n1000000000 1000000000 1000000000 1000000000 1000000000", expected: "5000000000" },
    ],
  },
  {
    id: "acm-max-min",
    title: "最大值与最小值之差",
    difficulty: 1, frequency: 2, timeLimit: 5,
    description: "输入格式：第一行 n，第二行 n 个整数（n ≥ 1）。\n输出格式：一行，最大值减最小值。\n\n样例输入：\n5\n3 1 4 1 5\n\n样例输出：\n4",
    skeleton: SK,
    ioCases: [
      { input: "5\n3 1 4 1 5", expected: "4" },
      { input: "1\n42", expected: "0" },
      { input: "6\n-1 -9 0 8 -3 2", expected: "17" },
    ],
  },
  {
    id: "acm-reverse-words",
    title: "反转字符串中的单词",
    difficulty: 2, frequency: 2, timeLimit: 8,
    description: "输入格式：一行字符串（单词之间用单个空格分隔，无前导/尾随空格，长度 ≤ 1000）。\n输出格式：一行，单词顺序反转（单词内部字符不反转），仍用单个空格分隔。\n\n样例输入：\nhello world foo\n\n样例输出：\nfoo world hello",
    skeleton: SK,
    ioCases: [
      { input: "hello world foo", expected: "foo world hello" },
      { input: "a", expected: "a" },
      { input: "I love writing code", expected: "code writing love I" },
    ],
  },
  {
    id: "acm-many-a-plus-b",
    title: "A+B（先给组数 T）",
    difficulty: 1, frequency: 3, timeLimit: 5,
    description: "输入格式：第一行整数 T（1 ≤ T ≤ 100），随后 T 行每行两个整数 a b。\n输出格式：T 行，每行 a+b。\n\n样例输入：\n2\n1 2\n10 20\n\n样例输出：\n3\n30",
    skeleton: SK,
    ioCases: [
      { input: "2\n1 2\n10 20", expected: "3\n30" },
      { input: "3\n0 0\n-1 1\n999999999 1", expected: "0\n0\n1000000000" },
    ],
  },
  {
    id: "acm-count-words",
    title: "统计单词个数",
    difficulty: 2, frequency: 2, timeLimit: 8,
    description: "输入格式：多行文本，直到 EOF（单词之间由空白字符分隔）。\n输出格式：一行，单词总数（不含空行与多余空白）。\n\n样例输入：\nhello   world\nfoo bar\n\n样例输出：\n4",
    skeleton: SK,
    ioCases: [
      { input: "hello   world\nfoo bar", expected: "4" },
      { input: "single", expected: "1" },
      { input: "a b c\nd", expected: "4" },
    ],
  },
  {
    id: "acm-sort-asc",
    title: "整数升序排序（单组）",
    difficulty: 2, frequency: 3, timeLimit: 8,
    description: "输入格式：第一行 n（1 ≤ n ≤ 100000），第二行 n 个整数。\n输出格式：一行，升序排列的 n 个整数，用单个空格分隔。\n\n样例输入：\n5\n3 1 4 1 5\n\n样例输出：\n1 1 3 4 5",
    skeleton: SK,
    ioCases: [
      { input: "5\n3 1 4 1 5", expected: "1 1 3 4 5" },
      { input: "1\n0", expected: "0" },
      { input: "4\n-3 -1 -2 -4", expected: "-4 -3 -2 -1" },
    ],
  },
  {
    id: "acm-prefix-sum",
    title: "区间和（多组询问）",
    difficulty: 2, frequency: 2, timeLimit: 10,
    description: "输入格式：第一行 n 与 q（1 ≤ n,q ≤ 100000），第二行 n 个整数 a[i]，随后 q 行每行两个整数 l r（1 ≤ l ≤ r ≤ n，下标从 1 开始）。\n输出格式：q 行，每行区间 a[l..r] 的和。\n\n提示：用前缀和，单次询问 O(1)。\n\n样例输入：\n5 2\n1 2 3 4 5\n1 3\n2 5\n\n样例输出：\n6\n14",
    skeleton: SK,
    ioCases: [
      { input: "5 2\n1 2 3 4 5\n1 3\n2 5", expected: "6\n14" },
      { input: "3 1\n10 20 30\n3 3", expected: "30" },
    ],
  },
  {
    id: "acm-two-sum-sorted",
    title: "有序数组中的两数之和（存在性判定）",
    difficulty: 2, frequency: 2, timeLimit: 8,
    description: "输入格式：第一行 n 与 target，第二行 n 个**严格递增**的整数。\n输出格式：若存在两个数之和等于 target，输出 「YES」与这两个数的下标（从 1 开始，用空格分隔，取最靠前的一对）；否则输出「NO」。\n\n样例输入：\n5 9\n1 2 4 5 8\n\n样例输出：\nYES 1 5\n\n样例说明：1+8=9，下标 1 与 5。",
    skeleton: SK,
    ioCases: [
      { input: "5 9\n1 2 4 5 8", expected: "YES 1 5" },
      { input: "3 100\n1 2 3", expected: "NO" },
      { input: "4 6\n1 2 3 4", expected: "YES 2 4" },
    ],
  },
  {
    id: "acm-stairs-dp",
    title: "爬楼梯（DP 入门）",
    difficulty: 2, frequency: 2, timeLimit: 8,
    description: "输入格式：第一行 T（1 ≤ T ≤ 20），随后 T 行每行一个整数 n（1 ≤ n ≤ 45）：每次可走 1 级或 2 级，求走到第 n 级的方案数。\n输出格式：T 行，每行一个整数。\n\n样例输入：\n3\n1\n2\n3\n\n样例输出：\n1\n2\n3",
    skeleton: SK,
    ioCases: [
      { input: "3\n1\n2\n3", expected: "1\n2\n3" },
      { input: "2\n10\n45", expected: "89\n1836311903" },
    ],
  },
  {
    id: "acm-gcd-sum",
    title: "最大公约数与最小公倍数",
    difficulty: 2, frequency: 2, timeLimit: 8,
    description: "输入格式：多行，每行两个正整数 a b（≤ 10^9），直到 EOF。\n输出格式：每行两个整数：gcd(a,b) 与 lcm(a,b)，用空格分隔。\n\n提示：lcm 可能较大，注意 JS 数值范围（本题数据保证 lcm < 2^53，可用 Number 精确表示）。\n\n样例输入：\n12 18\n7 5\n\n样例输出：\n6 36\n1 35",
    skeleton: SK,
    ioCases: [
      { input: "12 18\n7 5", expected: "6 36\n1 35" },
      { input: "1000000 999999", expected: "1 999999000000" },
    ],
  },
  {
    id: "acm-bracket-match",
    title: "括号匹配判定",
    difficulty: 3, frequency: 2, timeLimit: 10,
    description: "输入格式：多行，每行一个只含 ()[]{} 的字符串（长度 ≤ 1000），直到 EOF。\n输出格式：每行输出「YES」（合法）或「NO」。\n\n样例输入：\n()[]{}\n([)]\n\n样例输出：\nYES\nNO",
    skeleton: SK,
    ioCases: [
      { input: "()[]{}\n([)]", expected: "YES\nNO" },
      { input: "((()))", expected: "YES" },
      { input: "(]", expected: "NO" },
    ],
  },
  {
    id: "acm-matrix-transpose",
    title: "矩阵转置",
    difficulty: 2, frequency: 2, timeLimit: 10,
    description: "输入格式：第一行 m n（1 ≤ m,n ≤ 100），随后 m 行每行 n 个整数。\n输出格式：n 行 m 列，转置后的矩阵（同行用单个空格分隔）。\n\n样例输入：\n2 3\n1 2 3\n4 5 6\n\n样例输出：\n1 4\n2 5\n3 6",
    skeleton: SK,
    ioCases: [
      { input: "2 3\n1 2 3\n4 5 6", expected: "1 4\n2 5\n3 6" },
      { input: "1 1\n7", expected: "7" },
    ],
  },
  {
    id: "acm-count-char",
    title: "统计字符出现次数",
    difficulty: 2, frequency: 2, timeLimit: 8,
    description: "输入格式：第一行一个字符串 s（长度 ≤ 100000，只含小写字母），第二行一个字符 c。\n输出格式：一行，c 在 s 中出现的次数。\n\n样例输入：\nabcabc\na\n\n样例输出：\n2",
    skeleton: SK,
    ioCases: [
      { input: "abcabc\na", expected: "2" },
      { input: "zzzz\nz", expected: "4" },
      { input: "abc\nd", expected: "0" },
    ],
  },
  {
    id: "acm-fib-mod",
    title: "斐波那契数列（取模）",
    difficulty: 2, frequency: 2, timeLimit: 8,
    description: "输入格式：第一行 T，随后 T 行每行一个 n（1 ≤ n ≤ 100000），求 F(n) mod 1000000007，其中 F(1)=F(2)=1。\n输出格式：T 行，每行一个整数。\n\n提示：n 很大时用取模递推，注意别用递归。\n\n样例输入：\n3\n1\n2\n10\n\n样例输出：\n1\n1\n55",
    skeleton: SK,
    ioCases: [
      { input: "3\n1\n2\n10", expected: "1\n1\n55" },
      { input: "1\n100", expected: "687995182" },
    ],
  },
];
