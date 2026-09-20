// 链表/树题参考解（用于验证 scripts/gen-listtree-tests.mjs 生成的 test_code 是否**判得对**）
// 只放能在沙箱里独立跑通、语义无歧义的题：链表反转/合并/删除/相交判定、树的深度/翻转/对称/层序。
// 键是 challenges.id；值是完整可运行的用户代码（骨架函数名与题目一致）。
export const REFERENCES = {
  // 反转链表（LeetCode 206）
  "codetop-0206": `function reverseList(head) { let prev = null; while (head) { const nx = head.next; head.next = prev; prev = head; head = nx; } return prev; }`,
  // 合并两个有序链表（21）
  "codetop-0021": `function mergeTwoLists(l1, l2) { const dummy = { val: 0, next: null }; let cur = dummy; while (l1 && l2) { if (l1.val <= l2.val) { cur.next = l1; l1 = l1.next; } else { cur.next = l2; l2 = l2.next; } cur = cur.next; } cur.next = l1 || l2; return dummy.next; }`,
  // 删除排序链表中的重复元素（83）
  "codetop-0083": `function deleteDuplicates(head) { let cur = head; while (cur && cur.next) { if (cur.val === cur.next.val) cur.next = cur.next.next; else cur = cur.next; } return head; }`,
  // 相交链表（160）：判"有无交点"用标量返回不好断言，这里只做遍历长度不匹配的经典解，返回节点由序列化比较兜底
  "codetop-0160": `function getIntersectionNode(headA, headB) { let a = headA, b = headB; while (a !== b) { a = a ? a.next : headB; b = b ? b.next : headA; } return a; }`,
  // 二叉树的最大深度（104）
  "codetop-0104": `function maxDepth(root) { if (!root) return 0; return 1 + Math.max(maxDepth(root.left), maxDepth(root.right)); }`,
  // 翻转二叉树（226）
  "codetop-0226": `function invertTree(root) { if (!root) return null; const t = root.left; root.left = invertTree(root.right); root.right = invertTree(t); return root; }`,
  // 对称二叉树（101）
  "codetop-0101": `function isSymmetric(root) { const eq = (a, b) => (!a && !b) || (!!a && !!b && a.val === b.val && eq(a.left, b.right) && eq(a.right, b.left)); return !root || eq(root.left, root.right); }`,
  // 二叉树的中序遍历（94）
  "codetop-0094": `function inorderTraversal(root) { const out = []; const go = (n) => { if (!n) return; go(n.left); out.push(n.val); go(n.right); }; go(root); return out; }`,
  // 二叉树的最小深度（111）
  "codetop-0111": `function minDepth(root) { if (!root) return 0; if (!root.left) return 1 + minDepth(root.right); if (!root.right) return 1 + minDepth(root.left); return 1 + Math.min(minDepth(root.left), minDepth(root.right)); }`,
};
