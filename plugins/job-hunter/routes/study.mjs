// 学习清单域路由（纵向拆分：/api/study-* 从 widget.mjs 迁出）
// 依赖注入：corsOrigin（SSE 跨域）、laneSubmit（串行锁）
import { readFileSync, existsSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import path from "node:path";
import * as studyApi from "#lib/study.mjs";
import * as reviewApi from "#lib/review.mjs";
import { pick as pickEmotion, EMOTIONS } from "#lib/emotions.mjs";
import { findStudyFile, studyNotesDir, sanitizeFilename } from "#lib/study-files.mjs";
import { queryFollowupCache } from "#lib/followup-cache.mjs";
import { readBody } from "#lib/widget-core.mjs";
import { getProjectArchiveContext } from "#lib/personal-projects.mjs";

// 项目条目特化：topic 剥离"项目·"前缀；讲解引导改为"项目剖析"（面试拷打准备），
// 而非把项目当知识点讲（此前"请完整讲解：项目·网易云音乐" → LLM 凭空编，逻辑奇怪）
function explainPromptFor(item, prof) {
  const isProject = String(item?.topic || "").startsWith("项目·");
  const name = String(item?.topic || "").replace(/^项目·/, "").trim() || item?.topic || "";
  if (isProject) {
    return {
      title: item?.verify_question || `请剖析简历项目「${name}」`,
      text: `请剖析简历项目「${name}」——这是候选人简历中的项目，为面试拷打做准备：\n1) 技术选型 trade-off（为什么选这些技术）\n2) 架构设计（模块划分 / 数据流）\n3) 候选人的个人贡献（职责边界）\n4) 难点与踩坑（怎么解决）\n5) 量化指标（性能 / 规模提升）\n信息不足时围绕项目名给出合理剖析框架，并明确说明需要候选人补充什么。`,
    };
  }
  return {
    title: item?.verify_question || `请完整讲解：${item.topic}`,
    text: `这是一道${prof.scopeNote || "面试"}相关面试题，请完整讲解：${item.topic}\n（若题干信息不足，围绕知识点本身展开：核心概念、原理、代码示例、边界情况）`,
  };
}

export function registerStudyRoutes(router, { getCorsOrigin = () => "*", laneSubmit = (fn) => fn() } = {}) {
  const PORT = Number(process.env.MIANSHI_PORT) || 8899;
  const sseHeaders = (req) => ({
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": getCorsOrigin(req),
  });
  const send = (res) => (obj) => { if (!res.destroyed && !res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`); };

  router.route("/api/study-plan", (req, res) => {
    // 学习清单（读取）——为每条附加讲解文件路径
    try {
      const plan = studyApi.getPlan();
      const items = (plan.items || []).map((it) => {
        const filePath = findStudyFile(it);
        return { ...it, filePath, hasFile: !!filePath };
      });
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, plan: { ...plan, items } }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
  });

  router.route("/api/study-detail-stream", (req, res) => {
    // 学习详情（流式）：SSE 逐段推送讲解；有文件直接返回；无文件边生成边推 + 存档
    const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
    const id = u.searchParams.get("id") || "";
    const item = (studyApi.getPlan().items || []).find((i) => i.id === id);
    if (!item) { res.writeHead(404, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "条目不存在" })); return; }
    const filePath = findStudyFile(item);
    if (filePath) {
      // 有文件：一次性返回（快，无需流式）——不截断，讲解可无限追问累积
      try {
        const content = readFileSync(filePath, "utf8");
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, topic: item.topic, fromFile: true, content, filePath }));
        return;
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "读取讲解失败: " + e.message }));
        return;
      }
    }
    // 无文件：SSE 流式生成
    res.writeHead(200, sseHeaders(req));
    res.on("error", () => {}); // 客户端断开时避免无监听 error 崩溃进程
    const push = send(res);
    push({ type: "start", topic: item.topic });
    let full = "";
    import("#lib/ai.mjs").then(async ({ solveQuestionStream }) => {
      const { getCareerProfile } = await import("#lib/career.mjs");
      const prof = getCareerProfile();
      const projCtx = await getProjectArchiveContext(item.topic, item.source); // 关联项目 → 注入真实代码档案
      const ep = explainPromptFor(item, prof); // 项目条目 → 项目剖析引导
      full = await solveQuestionStream({
        title: ep.title,
        text: `${ep.text}${projCtx}`,
        company: "真白讲解",
        position: prof.positionDefault || "前端",
        sourceUrl: "学习清单",
      }, (delta) => {
        full += delta;
        push({ type: "delta", delta });
      });
      // 存档
      let savedPath = null;
      try {
        const notesDir = studyNotesDir();
        mkdirSync(notesDir, { recursive: true });
        const savePath = path.join(notesDir, `${sanitizeFilename(item.topic)}.md`);
        const header = `# ${item.topic}\n\n> 来源：学习清单 · AI 讲解存档 | 生成于 ${new Date().toLocaleString("zh-CN")}\n\n`;
        writeFileSync(savePath, header + full.slice(0, 50000), "utf8");
        savedPath = savePath;
      } catch { /* ignore */ }
      // 讲解生成完成 → 自动建复习卡（学过的知识点进间隔复习，不必等勾选）
      try {
        reviewApi.review.addCard({
          topic: item.topic,
          question: item.verify_question || `请简述：${item.topic}`,
          answer: full.slice(0, 500),
          source: "学习清单讲解",
        });
      } catch { /* ignore */ }
      push({ type: "done", saved: !!savedPath, filePath: savedPath });
      res.end();
    }).catch((e) => {
      push({ type: "error", error: e.message });
      res.end();
    });
  });

  router.route("/api/study-append-stream", (req, res) => {
    // 讲解追问补充：基于已有讲解内容 + 用户问题，流式生成补充章节并追加存档
    const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
    const id = u.searchParams.get("id") || "";
    const question = u.searchParams.get("question") || "";
    if (!question.trim()) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "question required" })); return; }
    const item = (studyApi.getPlan().items || []).find((i) => i.id === id);
    if (!item) { res.writeHead(404, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "条目不存在" })); return; }
    // 读已有讲解（study_notes 存档优先；没有则用验证题作为上下文）
    let existing = "";
    const filePath = findStudyFile(item);
    if (filePath) {
      try { existing = readFileSync(filePath, "utf8"); } catch { /* ignore */ }
    }
    // 轻量语义缓存：同一知识点历史追问过语义相似的问题 → 直接返回已有回答（零 LLM 请求）
    // （省成本：重复/近似追问不再花钱；命中时前端提示来源，避免用户误以为回答是新的）
    const cached = queryFollowupCache(item.topic, question);
    if (cached) {
      res.writeHead(200, sseHeaders(req));
      res.on("error", () => {});
      const push = send(res);
      push({ type: "start", topic: item.topic });
      push({ type: "delta", delta: cached.answer });
      push({ type: "cache", hit: true, similarity: cached.similarity, cachedQuestion: cached.question });
      push({ type: "done", saved: false, fromCache: true });
      res.end();
      return;
    }
    res.writeHead(200, sseHeaders(req));
    res.on("error", () => {});
    const push = send(res);
    push({ type: "start", topic: item.topic });
    let full = "";
    import("#lib/ai.mjs").then(async ({ solveAppendStream }) => {
      const projCtx = await getProjectArchiveContext(item.topic, item.source); // 关联项目 → 注入真实代码档案（追问也基于真实代码）
      full = await solveAppendStream({
        topic: item.topic,
        existing: (existing || `（暂无已有讲解，围绕知识点直接回答）${item.verify_question || item.topic}`) + projCtx,
        question,
      }, (delta) => {
        full += delta;
        push({ type: "delta", delta });
      });
      // 追加写回讲解文件（持久化：下次打开能看到补充内容）
      // 写回路径固定 study_notes（findStudyFile 可能命中产出目录文件——把追问追加进面经会污染产出）
      try {
        const notesDir = studyNotesDir();
        mkdirSync(notesDir, { recursive: true });
        const inNotes = filePath && filePath.startsWith(notesDir);
        const savePath = inNotes ? filePath : path.join(notesDir, `${sanitizeFilename(item.topic)}.md`);
        const appendBlock = `\n\n---\n\n## 💬 追问：${question}\n\n${full.slice(0, 8000)}\n`;
        // 追加（存档存在则 append，否则新建带头部）
        if (existsSync(savePath)) {
          appendFileSync(savePath, appendBlock, "utf8");
        } else {
          const header = `# ${item.topic}\n\n> 来源：学习清单 · AI 讲解存档 | 生成于 ${new Date().toLocaleString("zh-CN")}\n\n`;
          writeFileSync(savePath, header + full.slice(0, 12000) + appendBlock, "utf8");
        }
        push({ type: "done", saved: true, filePath: savePath });
      } catch {
        push({ type: "done", saved: false, filePath: null });
      }
      res.end();
    }).catch((e) => {
      push({ type: "error", error: e.message });
      res.end();
    });
  });

  router.route("/api/study-consolidate-stream", (req, res) => {
    // 整理讲解全文：把原始讲解 + 多轮追问整合成结构统一的完整讲解，流式生成并写回
    const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
    const id = u.searchParams.get("id") || "";
    const item = (studyApi.getPlan().items || []).find((i) => i.id === id);
    if (!item) { res.writeHead(404, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "条目不存在" })); return; }
    // 读完整讲解素材
    let content = "";
    const filePath = findStudyFile(item);
    if (filePath) {
      try { content = readFileSync(filePath, "utf8"); } catch { /* ignore */ }
    }
    if (!content || content.length < 200) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "还没有讲解内容，先点「💡 讲解」生成" })); return; }
    res.writeHead(200, sseHeaders(req));
    res.on("error", () => {});
    const push = send(res);
    push({ type: "start", topic: item.topic });
    let full = "";
    import("#lib/ai.mjs").then(async ({ consolidateStudyStream }) => {
      full = await consolidateStudyStream({ topic: item.topic, content }, (delta) => {
        full += delta;
        push({ type: "delta", delta });
      });
      // 写回：原文件改名 .orig 备份，写整合版（写回路径固定 study_notes，防覆盖产出目录文件）
      let savedPath = null;
      try {
        const notesDir = studyNotesDir();
        mkdirSync(notesDir, { recursive: true });
        const inNotes = filePath && filePath.startsWith(notesDir);
        const savePath = inNotes ? filePath : path.join(notesDir, `${sanitizeFilename(item.topic)}.md`);
        if (existsSync(savePath)) {
          try { writeFileSync(savePath + ".orig", readFileSync(savePath, "utf8"), "utf8"); } catch { /* ignore */ }
        }
        const header = `# ${item.topic}\n\n> 来源：学习清单 · AI 讲解存档（已整理） | 整理于 ${new Date().toLocaleString("zh-CN")}\n\n`;
        writeFileSync(savePath, header + full.slice(0, 50000), "utf8");
        savedPath = savePath;
      } catch { /* ignore */ }
      push({ type: "done", saved: !!savedPath, filePath: savedPath });
      res.end();
    }).catch((e) => {
      push({ type: "error", error: e.message });
      res.end();
    });
  });

  router.route("/api/study-cluster-stream", (req, res) => {
    // 多条目知识归并：把多个相关条目的讲解整合成主题簇综合讲解，流式生成并存到 study_notes/<簇>/ 目录
    readBody(req, res, (body) => {
      try {
        const { ids } = JSON.parse(body || "{}");
        if (!Array.isArray(ids) || ids.length < 2) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "请至少选择 2 个相关条目归并" })); return; }
        const plan = studyApi.getPlan();
        // 读取每个条目的讲解内容（有文件的读文件；无文件的跳过并提示先生成）
        const topics = [];
        const missing = [];
        for (const id of ids) {
          const item = (plan.items || []).find((i) => i.id === id);
          if (!item) continue;
          const filePath = findStudyFile(item);
          let content = "";
          if (filePath) { try { content = readFileSync(filePath, "utf8"); } catch { /* ignore */ } }
          if (content.length < 200) { missing.push(item.topic); continue; }
          topics.push({ topic: item.topic, content });
        }
        if (topics.length < 2) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: `需要至少 2 个有讲解的条目（${missing.length ? "缺讲解：" + missing.join("、") : ""}）。先点「💡 讲解」生成` }));
          return;
        }
        res.writeHead(200, sseHeaders(req));
        res.on("error", () => {});
        const push = send(res);
        push({ type: "start", topic: topics.map((t) => t.topic).join(" + ") });
        let full = "";
        import("#lib/ai.mjs").then(async ({ clusterStudyStream }) => {
          full = await clusterStudyStream({
            topics,
            onChunk: (delta) => {
              full += delta;
              push({ type: "delta", delta });
            },
          });
          // 存到 study_notes/主题簇/ 目录（按 AI 给的主题簇名）
          let savedPath = null;
          let clusterName = "综合";
          try {
            const cm = full.match(/【cluster】\s*([^\n]+)/);
            if (cm) clusterName = cm[1].trim().slice(0, 40);
            const notesDir = studyNotesDir();
            const clusterDir = path.join(notesDir, sanitizeFilename(clusterName));
            mkdirSync(clusterDir, { recursive: true });
            const savePath2 = path.join(clusterDir, `${sanitizeFilename(clusterName)}.md`);
            const header = `# ${clusterName}\n\n> 来源：多条目归并（${topics.map((t) => t.topic).join("、")}） | 归并于 ${new Date().toLocaleString("zh-CN")}\n\n`;
            writeFileSync(savePath2, header + full.replace(/【cluster】\s*/, "").slice(0, 50000), "utf8");
            savedPath = savePath2;
          } catch { /* ignore */ }
          push({ type: "done", saved: !!savedPath, filePath: savedPath, clusterName });
          res.end();
        }).catch((e) => {
          push({ type: "error", error: e.message });
          res.end();
        });
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
  });

  // 复习"显示答案"空答案回退：按 topic 纯读讲解存档（不调 LLM——复习场景要快；
  // 与 /api/study-detail 的区别：detail 无文件时会现场生成讲解，这里只读）
  router.route("/api/study/note", (req, res) => {
    try {
      const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
      const topic = String(u.searchParams.get("topic") || "").trim();
      if (!topic) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "topic required" })); return; }
      const filePath = findStudyFile({ topic });
      if (filePath) {
        try {
          const content = readFileSync(filePath, "utf8");
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: true, found: true, content, filePath }));
          return;
        } catch { /* 读取失败按未命中处理 */ }
      }
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, found: false, content: "" }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
  });

  router.route("/api/study-detail", (req, res) => {
    // 学习详情：返回条目讲解内容（有文件读文件；无文件现场生成并写入 study_notes 存档）
    const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
    const id = u.searchParams.get("id") || "";
    const item = (studyApi.getPlan().items || []).find((i) => i.id === id);
    if (!item) { res.writeHead(404, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "条目不存在" })); return; }
    const filePath = findStudyFile(item);
    if (filePath) {
      try {
        const content = readFileSync(filePath, "utf8");
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, topic: item.topic, fromFile: true, content, filePath }));
        return;
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "读取讲解失败: " + e.message }));
        return;
      }
    }
    // 无文件：现场生成讲解（格式：结论/原理/实现/边界），并写入 study_notes 存档
    import("#lib/ai.mjs").then(async ({ solveQuestion }) => {
      const { getCareerProfile } = await import("#lib/career.mjs");
      const prof = getCareerProfile();
      const projCtx = await getProjectArchiveContext(item.topic, item.source); // 关联项目 → 注入真实代码档案
      const ep = explainPromptFor(item, prof); // 项目条目 → 项目剖析引导
      const content = String(await solveQuestion({
        title: ep.title,
        text: `${ep.text}${projCtx}`,
        company: "真白讲解",
        position: prof.positionDefault || "前端",
        sourceUrl: "学习清单",
      })).slice(0, 12000);
      // 写入存档（下次直接读文件，不再生成）
      let savedPath = null;
      try {
        const notesDir = studyNotesDir();
        mkdirSync(notesDir, { recursive: true });
        const savePath = path.join(notesDir, `${sanitizeFilename(item.topic)}.md`);
        const header = `# ${item.topic}\n\n> 来源：学习清单 · AI 讲解存档 | 生成于 ${new Date().toLocaleString("zh-CN")}\n\n`;
        writeFileSync(savePath, header + content, "utf8");
        savedPath = savePath;
      } catch { /* 存档失败不影响返回 */ }
      // 讲解生成完成 → 自动建复习卡
      try {
        reviewApi.review.addCard({
          topic: item.topic,
          question: item.verify_question || `请简述：${item.topic}`,
          answer: content.slice(0, 500),
          source: "学习清单讲解",
        });
      } catch { /* ignore */ }
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, topic: item.topic, fromFile: false, content, filePath: savedPath, saved: !!savedPath }));
    }).catch((e) => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "生成讲解失败: " + e.message }));
    });
  });

  router.route("/api/study-generate", (req, res) => {
    // 从产出生成学习清单
    laneSubmit(() => studyApi.generateStudyPlan())
      .then((plan) => {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, plan }));
      })
      .catch((e) => {
        res.writeHead(e?.statusCode || 500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      });
  });

  router.route("/api/study-check", (req, res) => {
    // 勾选完成 → 返回真白情感反馈（庆祝/取消）
    const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
    const done = u.searchParams.get("done") === "1";
    studyApi.checkItem(u.searchParams.get("id"), done).then((r) => {
      let emotion = null;
      let emotionScene = null;
      try {
        if (done) {
          emotion = pickEmotion(EMOTIONS.celebrate);
          emotionScene = "praise"; // 面板播日语预设台词（显示中文、播放日语）
        } else {
          emotion = "……嗯，那先放着。";
          emotionScene = "encourage";
        }
      } catch { /* ignore */ }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ...r, emotion, emotionScene }));
    }).catch((e) => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    });
  });

  router.route("/api/study-review", (req, res) => {
    // 复盘：出验证题
    studyApi
      .startReview()
      .then((r) => {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(r));
      })
      .catch((e) => {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      });
  });

  router.route("/api/study-answer", (req, res) => {
    // 复盘：提交答案判分
    readBody(req, res, async (body) => {
      try {
        const r = await studyApi.answerReview(JSON.parse(body || "{}").answers || []);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(r));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
  });
}

