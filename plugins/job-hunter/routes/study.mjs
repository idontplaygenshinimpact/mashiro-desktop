// 学习清单域路由（纵向拆分：/api/study-* 从 widget.mjs 迁出）
// 依赖注入：corsOrigin（SSE 跨域）、laneSubmit（串行锁）
import { readFileSync, existsSync, mkdirSync, writeFileSync, appendFileSync, rmSync, statSync, readdirSync } from "node:fs";
import path from "node:path";
import * as studyApi from "#lib/study.mjs";
import * as reviewApi from "#lib/review.mjs";
import { pick as pickEmotion, EMOTIONS } from "#lib/emotions.mjs";
import { findStudyFile, studyNotesDir, sanitizeFilename, normName } from "#lib/study-files.mjs";
import { isSimilarTopicForArchive } from "#lib/memory.mjs";
import { queryFollowupCache } from "#lib/followup-cache.mjs";
import { readBody } from "#lib/widget-core.mjs";
import { getProjectArchiveContext } from "#lib/personal-projects.mjs";
import { createSSEPush, withContract } from "#lib/routes/contract.mjs";
import { StudyStreamEvent } from "#lib/contracts/sse.mjs";
import { sanitizeExternal } from "#lib/prompt-guard.mjs";
import { config } from "#root/config.mjs";
import { StudyPlanOutput, StudyCheckInput, StudyCheckOutput } from "#lib/contracts/study.mjs";

// 同知识点讲解复用：清单里语义相似的另一条目已有讲解存档 → 直接复用（内容一致 + 省 LLM）
// 背景：同一知识点可能因来源不同（面经产出/面试实录/复习卡恢复）存在多条近似条目
//       （如「版本号比较」「比较版本号」「版本号数组排序」），各自生成讲解质量参差。
// 选择策略：取相似存档中【创建最早】的一份（birthtime）——用户反馈最初生成的
//       （如简单 split 方案）通常最扎实，后续生成的容易跑偏/冗余。追加追问只改 mtime 不改 birthtime。
// 修复：复用判据用 isSimilarTopicForArchive（isSimilarWeakTopic 加 2-gram 重叠率门槛）——
//       isSimilarWeakTopic 是薄弱点去重的宽松 3-gram 判定，直接用于讲解复用会把
//       "数组中第K个最大元素"误配到"1-n数组中未出现数"（共享"数组中"），讲解张冠李戴
function findSimilarArchive(topic, { excludeId, items } = {}) {
  const list = items || (studyApi.getPlan().items || []);
  let best = null;
  for (const other of list) {
    if (!other || other.id === excludeId) continue;
    if (String(other.topic || "").startsWith("项目·")) continue; // 项目条目不参与知识点相似
    if (!isSimilarTopicForArchive(String(topic), String(other.topic))) continue;
    const f = findStudyFile(other);
    if (!f) continue;
    try {
      const content = readFileSync(f, "utf8");
      if (!content || !content.trim()) continue;
      const birth = statSync(f).birthtimeMs || 0;
      if (!best || birth < best.birth) best = { topic: other.topic, id: other.id, filePath: f, content, birth };
    } catch { /* ignore */ }
  }
  return best ? { topic: best.topic, id: best.id, filePath: best.filePath, content: best.content } : null;
}

/** 找相似条目中创建更早的存档（供"有自身存档但相似更早"时提示），返回 null 表示没有更早的 */
function findEarlierArchive(topic, ownBirth, { excludeId, items } = {}) {
  const list = items || (studyApi.getPlan().items || []);
  let best = null;
  for (const other of list) {
    if (!other || other.id === excludeId) continue;
    if (String(other.topic || "").startsWith("项目·")) continue;
    if (!isSimilarTopicForArchive(String(topic), String(other.topic))) continue;
    const f = findStudyFile(other);
    if (!f) continue;
    try {
      const birth = statSync(f).birthtimeMs || 0;
      if (ownBirth > 0 && birth >= ownBirth) continue; // 只找更早的
      if (!best || birth < best.birth) best = { topic: other.topic, id: other.id, birth };
    } catch { /* ignore */ }
  }
  return best ? { topic: best.topic, id: best.id, birth: best.birth } : null;
}

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

/** 按 source 文件名找产出文件（output/<日期目录>/<文件名>.md，normName 精确匹配）——讲解生成时注入面经原文 */
function findSourceFile(source) {
  const outDir = config.outputDir;
  if (!source || !existsSync(outDir)) return null;
  const sn = normName(String(source).replace(/\.md$/, ""));
  if (!sn) return null;
  for (const d of readdirSync(outDir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const dirPath = path.join(outDir, d.name);
    for (const f of readdirSync(dirPath)) {
      if (!f.endsWith(".md")) continue;
      if (normName(f.replace(/\.md$/, "")) === sn) return path.join(dirPath, f);
    }
  }
  return null;
}

/** 讲解存档头部（来源标注诚实：有面经 source 标注面经文件名，否则学习清单——修复：此前写死"学习清单"，
 * 实际生成注入了面经原文，来源标注与内容不符） */
function archiveHeader(item, note = "") {
  const src = String(item?.source || "").trim();
  const srcLabel = src ? `面经产出（${src}）` : "学习清单";
  const verb = note === "已整理" ? "整理于" : "生成于";
  return `# ${item.topic}\n\n> 来源：${srcLabel} · AI 讲解存档${note ? `（${note}）` : ""} | ${verb} ${new Date().toLocaleString("zh-CN")}\n\n`;
}

export function registerStudyRoutes(router, { getCorsOrigin = () => "*", laneSubmit = (fn) => fn() } = {}) {
  const PORT = Number(process.env.MIANSHI_PORT) || 8899;
  const sseHeaders = (req) => ({
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": getCorsOrigin(req),
  });
  // 统一 SSE push（Phase 2 §3.4：StudyStreamEvent 契约；开发期 MIANSHI_SSE_STRICT=1 校验漂移）
  const makePush = (res) => createSSEPush(res, { eventSchema: StudyStreamEvent }).push;

  router.route("/api/study-plan", "GET", withContract(
    // 学习清单（读取）——为每条附加讲解文件路径
    () => {
      const plan = studyApi.getPlan();
      const items = (plan.items || []).map((it) => {
        const filePath = findStudyFile(it);
        return { ...it, filePath, hasFile: !!filePath };
      });
      return { ok: true, plan: { ...plan, items } };
    },
    { output: StudyPlanOutput }
  ));

  router.route("/api/study-note/reset", "POST", (req, res) => {
    // 讲解重置：删除该条目的本地讲解存档（study_notes/{topic}.md）
    // 用户诉求：生成错误/内容不满意时无法处理 → 提供"重新生成"入口（删除后前端重新流式生成）
    readBody(req, res, (body) => {
      try {
        const { id } = JSON.parse(body || "{}");
        if (!id) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "id required" })); return; }
        const item = (studyApi.getPlan().items || []).find((i) => i.id === String(id));
        if (!item) { res.writeHead(404, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "条目不存在" })); return; }
        const f = path.join(studyNotesDir(), `${sanitizeFilename(item.topic)}.md`);
        let deleted = false;
        if (existsSync(f)) { rmSync(f, { force: true }); deleted = true; }
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, deleted, topic: item.topic }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
  });

  router.route("/api/study-detail-stream", (req, res) => {
    // 学习详情（流式）：SSE 逐段推送讲解；有文件直接返回；无文件边生成边推 + 存档
    const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
    const id = u.searchParams.get("id") || "";
    // 强制生成本条自己的讲解（跳过相似条目存档复用）——"重新生成"入口用：
    // 修复：原流程重置后仍复用同一相似错档 → 用户永远拿不到自己的讲解（重新生成不生效）
    const noSimilar = u.searchParams.get("noSimilar") === "1";
    const item = (studyApi.getPlan().items || []).find((i) => i.id === id);
    if (!item) { res.writeHead(404, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "条目不存在" })); return; }
    // noSimilar=1（重新生成）时 findStudyFile 只查 study_notes 精确匹配（notesOnly）——
    // 产出目录 source 模糊匹配可能命中相似文件，导致 reset 删了本条存档后仍返回旧文件（重新生成不生效）
    const filePath = findStudyFile(item, { notesOnly: noSimilar });
    if (filePath) {
      // 有文件：一次性返回（快，无需流式）——不截断，讲解可无限追问累积
      try {
        const content = readFileSync(filePath, "utf8");
        // 同知识点有更早生成的存档（如简单 split 方案的初始讲解）→ 附带提示，前端展示"查看最早版"
        let earlierArchive = null;
        try {
          const ownBirth = statSync(filePath).birthtimeMs || 0;
          earlierArchive = findEarlierArchive(item.topic, ownBirth, { excludeId: item.id });
        } catch { /* ignore */ }
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, topic: item.topic, fromFile: true, content, filePath, earlierArchive }));
        return;
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "读取讲解失败: " + e.message }));
        return;
      }
    }
    // 无自身存档 → 复用语义相似条目的已有讲解（同知识点不重复生成，内容一致）
    // noSimilar=1（重新生成）时跳过——用户要求生成本条自己的讲解，不接受复用错档
    const similar = noSimilar ? null : findSimilarArchive(item.topic, { excludeId: item.id });
    if (similar) {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({
        ok: true, topic: item.topic, fromFile: true, content: similar.content,
        filePath: similar.filePath, similarFrom: { topic: similar.topic },
      }));
      return;
    }
    // 无文件：SSE 流式生成
    res.writeHead(200, sseHeaders(req));
    res.on("error", () => {}); // 客户端断开时避免无监听 error 崩溃进程
    const push = makePush(res);
    push({ type: "start", topic: item.topic });
    let full = "";
    import("#lib/ai.mjs").then(async ({ solveQuestionStream }) => {
      const { getCareerProfile } = await import("#lib/career.mjs");
      const prof = getCareerProfile();
      const projCtx = await getProjectArchiveContext(item.topic, item.source); // 关联项目 → 注入真实代码档案
      const ep = explainPromptFor(item, prof); // 项目条目 → 项目剖析引导
      // 读 source 面经原文注入（修复：explainPromptFor 只构造 topic+通用引导，不读 source 文件，
      // 导致重新生成（noSimilar=1）后讲解与原始面经脱节——"从面经来的题重新生成反而没关系了"）
      let sourceText = "";
      try {
        const srcFile = findSourceFile(item.source);
        if (srcFile) sourceText = readFileSync(srcFile, "utf8").slice(0, 4000);
      } catch { /* ignore */ }
      const sourceBlock = sourceText
        ? `\n\n【原始面经内容（来自 ${item.source}，仅作讲解对象）】\n${sanitizeExternal(sourceText).wrapped}`
        : "";
      full = await solveQuestionStream({
        title: ep.title,
        text: `${ep.text}${projCtx}${sourceBlock}`,
        company: "真白讲解",
        position: prof.positionDefault || "前端",
        sourceUrl: "学习清单",
      }, (delta) => {
        full += delta;
        push({ type: "delta", delta });
      });
      // 存档（修复：生成失败/中断（full 过短）不写档——此前无条件写"header + 空"伪讲解，
      // 用户重新生成失败后文件存在但内容空，追问 append 到空文件 → 追问回答成了主体）
      let savedPath = null;
      try {
        if (full.trim().length < 200) {
          push({ type: "error", error: "讲解生成失败（内容过短），请重试" });
          res.end();
          return;
        }
        const notesDir = studyNotesDir();
        mkdirSync(notesDir, { recursive: true });
        const savePath = path.join(notesDir, `${sanitizeFilename(item.topic)}.md`);
        const header = archiveHeader(item);
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
      const push = makePush(res);
      push({ type: "start", topic: item.topic });
      push({ type: "delta", delta: cached.answer });
      push({ type: "cache", hit: true, similarity: cached.similarity, cachedQuestion: cached.question });
      push({ type: "done", saved: false, fromCache: true });
      res.end();
      return;
    }
    res.writeHead(200, sseHeaders(req));
    res.on("error", () => {});
    const push = makePush(res);
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
        // 追加（存档存在则 append；**不存在则拒绝**——修复：此前"新建"分支把追问回答写成讲解主体
        // （header + full + appendBlock），原始讲解丢失时追问会生成"伪讲解"（只剩追问回答）。
        // 追问语义是"基于已有讲解深入"——没有讲解就没有追问基础，提示先点「💡 讲解」生成）
        if (existsSync(savePath)) {
          appendFileSync(savePath, appendBlock, "utf8");
        } else {
          push({ type: "done", saved: false, filePath: null, error: "还没有讲解内容，先点「💡 讲解」生成，再追问补充" });
          res.end();
          return;
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
    const push = makePush(res);
    push({ type: "start", topic: item.topic });
    let full = "";
    import("#lib/ai.mjs").then(async ({ consolidateStudyStream }) => {
      // 读 source 面经原文注入（与重新生成同款修复——整理不丢失来源：
      // 素材只有讲解文件内容，不含原始面经，整理后可能与面经脱节）
      let sourceText = "";
      try {
        const srcFile = findSourceFile(item.source);
        if (srcFile) sourceText = readFileSync(srcFile, "utf8").slice(0, 4000);
      } catch { /* ignore */ }
      const sourceBlock = sourceText
        ? `\n\n【原始面经内容（来自 ${item.source}，仅作整理对照）】\n${sanitizeExternal(sourceText).wrapped}`
        : "";
      full = await consolidateStudyStream({ topic: item.topic, content: `${content}${sourceBlock}` }, (delta) => {
        full += delta;
        push({ type: "delta", delta });
      });
      // 写回校验（修复：整理结果过短不写回——防"header+空"伪讲解覆盖原档；与 study-detail 同款守卫）
      if (full.trim().length < 200) {
        push({ type: "error", error: "整理失败（内容过短），原讲解未改动，请重试" });
        res.end();
        return;
      }
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
        const header = archiveHeader(item, "已整理");
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
        const push = makePush(res);
        push({ type: "start", topic: topics.map((t) => t.topic).join(" + ") });
        let full = "";
        import("#lib/ai.mjs").then(async ({ clusterStudyStream }) => {
          // 每个条目注入自己的 source 面经原文（与 consolidate 同款修复——归并不丢失来源；
          // 每个 source 截断 2000 字符控制总量）
          const topicsWithSource = await Promise.all(topics.map(async (t) => {
            const item = (plan.items || []).find((i) => i.topic === t.topic);
            let sourceText = "";
            if (item) {
              try {
                const srcFile = findSourceFile(item.source);
                if (srcFile) sourceText = readFileSync(srcFile, "utf8").slice(0, 2000);
              } catch { /* ignore */ }
            }
            return sourceText
              ? { ...t, content: `${t.content}\n\n【原始面经内容（来自 ${item?.source || "?"}，仅作归并对照）】\n${sanitizeExternal(sourceText).wrapped}` }
              : t;
          }));
          full = await clusterStudyStream({
            topics: topicsWithSource,
            onChunk: (delta) => {
              full += delta;
              push({ type: "delta", delta });
            },
          });
          // 存到 study_notes/主题簇/ 目录（按 AI 给的主题簇名）
          // 素材校验（修复：归并结果过短不存档——防"header+空"伪讲解；与 study-detail 同款守卫）
          if (full.trim().length < 200) {
            push({ type: "error", error: "归并失败（内容过短），未存档，请重试" });
            res.end();
            return;
          }
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
      // 素材校验（修复：生成结果过短不写档——防"header+空"伪讲解；与流式路径同款守卫）
      let savedPath = null;
      if (String(content || "").trim().length >= 200) {
        try {
          const notesDir = studyNotesDir();
          mkdirSync(notesDir, { recursive: true });
          const savePath = path.join(notesDir, `${sanitizeFilename(item.topic)}.md`);
          const header = archiveHeader(item);
          writeFileSync(savePath, header + content, "utf8");
          savedPath = savePath;
        } catch { /* 存档失败不影响返回 */ }
      }
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

  router.route("/api/study-check", withContract(
    // 勾选完成 → 返回真白情感反馈（庆祝/取消）；入参来自 query（src=query）
    async (input) => {
      const done = input.done === "1";
      const r = await studyApi.checkItem(input.id, done);
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
      return { ...r, emotion, emotionScene };
    },
    { src: "query", input: StudyCheckInput, output: StudyCheckOutput }
  ));

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

