// 并发 lane：全局串行队列（对标 Claude Code 的 lane 概念，简化版）
// 为什么串行是正确 trade-off（单用户桌面场景）：
//   1) memory 是内存镜像单例——并发 agent 任务写同一份镜像会竞态（脏数据）
//   2) LLM 调用是吞吐瓶颈（2-60s/次）——串行不损失吞吐，只消除竞态
//   3) 所有涉及共享状态的任务（对话/面试/讲解/实录）排队执行，顺序确定
// 设计：单 lane 队列 + 顺序 pump；错误隔离（单个任务失败不阻塞队列）

const queue = [];
let running = false;

/** 提交任务到串行 lane，返回 Promise（排队执行，前一个完成后才开始） */
export function submit(task) {
  return new Promise((resolve, reject) => {
    queue.push({ task, resolve, reject });
    pump();
  });
}

async function pump() {
  if (running) return;
  const next = queue.shift();
  if (!next) return;
  running = true;
  try {
    next.resolve(await next.task());
  } catch (e) {
    next.reject(e);
  } finally {
    running = false;
    pump(); // 下一个
  }
}

/** 队列状态（可观测：面板/日志展示） */
export function laneStatus() {
  return { queued: queue.length, running };
}
