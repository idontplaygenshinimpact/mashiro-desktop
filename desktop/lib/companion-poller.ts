// 桌宠伴侣表达轮询器（Phase 事件驱动内核 W1）
// 独立模块（依赖注入）：2s 轻轮询 widget /api/pet-events → petSay(text, scene)
// main.mjs 仅需 1 行接线：startCompanionPoller({ widgetFetch, petSay })
// 设计：
//   - 完全复用"widget HTTP + 主进程拉 + petSay 广播"现有链路，不加反向通道
//   - 仅当队列非空才返回数据（widget 端 drain 语义），空闲零开销
//   - MIANSHI_AUTONOMY=off 时不启动（自主性刹车第 1 层）
//   - 瞬时错误（widget 未就绪等）静默，下个 tick 重试，不崩溃
// 全量 TS 升级工单阶段 4（桌面）：desktop/lib/companion-poller.mjs → .ts
//   调用方 1 处：desktop/main.mjs（`./lib/companion-poller.mjs` 写法）→ 直接改路径，不建桶

/** 待播报表达（widget /api/pet-events 的队列条目） */
interface PetEvent {
  text?: unknown;
  scene?: unknown;
}

/** 轮询器依赖（全部注入，便于单测与主进程接线） */
export interface CompanionPollerDeps {
  /** widget HTTP 客户端（主进程注入，自带 token） */
  widgetFetch: (path: string, opts?: object) => Promise<Response>;
  /** 桌宠表达（气泡/语音） */
  petSay: (text: string, scene?: string) => void;
  /** 轮询间隔（默认 2000ms） */
  intervalMs?: number;
  log?: (msg: string) => void;
}

/** 轮询器句柄 */
export interface CompanionPoller {
  stop: () => void;
  running: boolean;
}

export function startCompanionPoller({ widgetFetch, petSay, intervalMs = 2000, log = console.log }: CompanionPollerDeps): CompanionPoller {
  if (process.env.MIANSHI_AUTONOMY === "off") {
    log("[companion] MIANSHI_AUTONOMY=off，不启动伴侣轮询");
    return { stop: () => {}, running: false };
  }
  if (typeof widgetFetch !== "function" || typeof petSay !== "function") {
    log("[companion] 缺少 widgetFetch/petSay 依赖，轮询未启动");
    return { stop: () => {}, running: false };
  }
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      const res = await widgetFetch("/api/pet-events");
      const j = (await res.json()) as { ok?: boolean; events?: PetEvent[] };
      if (j?.ok && Array.isArray(j.events) && j.events.length) {
        for (const ev of j.events) {
          petSay(String(ev.text || ""), String(ev.scene || "default"));
        }
      }
    } catch { /* widget 未就绪/瞬时错误：下个 tick 重试 */ }
  };

  timer = setInterval(tick, intervalMs);
  tick(); // 启动立即探一次
  return {
    stop() {
      stopped = true;
      if (timer) { clearInterval(timer); timer = null; }
    },
    running: true,
  };
}
