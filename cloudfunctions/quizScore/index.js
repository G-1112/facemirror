// 题库抽题 · 统一评分：全部答案提交后一次性评分
// 输出：每题得分与点评 + 按科目维度的掌握度（能力图谱）+ 针对性学习建议
//
// 设计要点：
// 1. 单次 LLM 调用（10~15 题问答一次性评完），与 deepAnalyze 同一先例；
//    LLM 未配置/失败 → 规则降级（确定性打分），保证功能永远可用。
// 2. 科目维度汇总由服务端**从每题得分确定性聚合**，不采信 LLM 自报的科目分
//    （LLM 只贡献每题分数与文字点评，防止自造数据）。
// 3. 注入防护：答案先 scanInjection，命中则整卷降级为规则分（guardLlmResult）。
// 4. 持久化到 practices（kind:"quiz"），历史记录页可见；写库失败不阻塞返回报告。
const cloud = require("wx-server-sdk");
const { callLLM } = require("./llm");
const { escapeForPrompt, scanInjection, guardLlmResult } = require("./injection");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const MIN_QUESTIONS = 1;
const MAX_QUESTIONS = 15;
const MAX_ANSWER_LEN = 2000;
const SCORE_MIN = 1;
const SCORE_MAX = 5;
// 每日评分配额（每次评分 = 1 次真实 LLM 调用，防刷）
const QUIZ_DAILY_LIMIT = 20;

function todayKey() {
  const d = new Date(Date.now() + 8 * 3600 * 1000); // 按东八区计日
  return d.toISOString().slice(0, 10);
}

async function reserveQuota(openid) {
  try {
    const date = todayKey();
    const id = `${openid}_${date}_quiz`;
    await db.collection("quota").doc(id).set({
      data: { openid, date, action: "quiz", count: _.inc(1) },
    });
    const after = await db.collection("quota").doc(id).get();
    if ((after.data.count || 0) > QUIZ_DAILY_LIMIT) {
      await db.collection("quota").doc(id).update({ data: { count: _.inc(-1) } });
      return { ok: false, reason: `今日题库抽题评分次数已达上限（${QUIZ_DAILY_LIMIT} 次），明天再来吧` };
    }
    return { ok: true };
  } catch (e) {
    // 配额异常保守放行（与 analyze 同策略），避免主流程被配额表故障卡死
    console.warn("quiz quota check failed:", e.message);
    return { ok: true };
  }
}

/** 数据库错误翻译（与 deepSession 同源模式）：-502005 → 可操作指引 */
function extractCode(err) {
  if (!err) return "";
  const direct = err.errCode != null ? err.errCode : err.errcode;
  if (direct != null && direct !== "") return String(direct).trim();
  const raw = String(err.errMsg || err.message || "");
  const m = raw.match(/-?\d{6}/);
  return m ? m[1] : "";
}

function describeDbError(err, fallback) {
  const code = extractCode(err);
  if (code === "-502005") {
    return "数据库集合 practices 不存在，请先在云开发控制台创建该集合";
  }
  if (code === "-502003") {
    return "数据库权限校验失败，请检查 practices 集合的权限设置";
  }
  console.error("[quizScore] 数据库异常 code=" + (code || "?"), err && (err.errMsg || err.message));
  return fallback;
}

/** 归一输入：题目数组（text/category/difficulty）+ 答案数组 */
function normalizeInput(questions, answers) {
  if (!Array.isArray(questions) || questions.length < MIN_QUESTIONS) {
    return { error: "题目数据缺失，请重新抽题" };
  }
  if (questions.length > MAX_QUESTIONS) {
    return { error: `单次最多 ${MAX_QUESTIONS} 题` };
  }
  const qs = questions.map((q, i) => {
    const text = typeof (q && q.text) === "string" ? q.text.slice(0, MAX_ANSWER_LEN) : "";
    const category = typeof (q && q.category) === "string" ? q.category.slice(0, 20) : "未分类";
    return { index: i, text, category, difficulty: (q && q.difficulty) || "中等" };
  });
  if (qs.some((q) => !q.text)) return { error: "题目数据异常（存在空题干），请重新抽题" };
  const ans = Array.isArray(answers) ? answers : [];
  const as = qs.map((_, i) => {
    const a = typeof ans[i] === "string" ? ans[i].trim() : "";
    return a.length > MAX_ANSWER_LEN ? a.slice(0, MAX_ANSWER_LEN) : a;
  });
  return { qs, as };
}

/** 规则降级打分：答案长度 + 与题干的关键词重叠，确定性、零成本 */
function ruleScore(question, answer) {
  if (!answer) {
    return { score: SCORE_MIN, comment: "未作答，建议结合概念定义与例子作答" };
  }
  const len = answer.replace(/\s+/g, "").length;
  let base = len >= 150 ? 4 : len >= 60 ? 3 : len >= 20 ? 2 : SCORE_MIN;
  // 关键词重叠：题干中的 2 字以上词在答案中出现 → 加分（上限 5）
  const qWords = (question.match(/[\u4e00-\u9fa5]{2,}/g) || []).filter((w) => w.length <= 6);
  const hit = qWords.filter((w) => answer.includes(w)).length;
  if (hit >= 3 && base < SCORE_MAX) base += 1;
  const comment =
    base >= 4
      ? "回答较完整，可再补充实例或数据"
      : base === 3
      ? "回答基本达意，建议补充依据与结构"
      : base === 2
      ? "回答偏短，展开关键概念后再作答"
      : "回答过简，请围绕题干要点作答";
  return { score: base, comment };
}

/** 科目维度聚合（确定性）：从每题得分算均分 */
function buildSubjectMap(qs, scores, summaries) {
  const byCat = new Map();
  qs.forEach((q, i) => {
    if (!byCat.has(q.category)) byCat.set(q.category, []);
    byCat.get(q.category).push(scores[i]);
  });
  const map = [];
  for (const [category, arr] of byCat) {
    const avg = arr.reduce((a, b) => a + b, 0) / arr.length;
    const rounded = Math.round(avg * 10) / 10;
    map.push({
      category,
      count: arr.length,
      avgScore: rounded,
      percent: Math.round((avg / SCORE_MAX) * 100),
      summary: (summaries && summaries[category]) || "",
    });
  }
  // 按均分升序：弱科排前面，方便先看短板
  map.sort((a, b) => a.avgScore - b.avgScore);
  return map;
}

function buildPrompt(qs, as) {
  const lines = qs.map(
    (q, i) =>
      `【第${i + 1}题】【科目：${q.category}】题目：${escapeForPrompt(q.text)}\n考生回答：${as[i] ? escapeForPrompt(as[i]) : "（未作答）"}`
  );
  const system =
    "你是学科面试练习的评分教练。对每题按 1~5 分评分（1=未作答/完全跑题，3=基本达意，5=准确且有条理），" +
    "点评不超过40字，指出最关键的改进点。严格输出 JSON，不要输出任何多余文本。" +
    'JSON 格式：{"perQuestion":[{"index":0,"score":3,"comment":"..."}],' +
    '"subjectSummary":{"科目名":"该科目掌握情况一句话总结"},' +
    '"suggestions":["针对薄弱科目的学习建议，2~5条，每条不超过50字"],' +
    '"overall":"整体表现一句话评价"}';
  return { system, user: "请评分以下问答：\n\n" + lines.join("\n\n") };
}

/** LLM 输出 → 每题分数（服务端口径校验，非法值回退规则分） */
function adoptLlmScores(llm, qs, as) {
  const raw = Array.isArray(llm && llm.perQuestion) ? llm.perQuestion : [];
  const byIndex = new Map();
  for (const item of raw) {
    const idx = Number(item && item.index);
    if (Number.isInteger(idx) && idx >= 0 && idx < qs.length && !byIndex.has(idx)) {
      byIndex.set(idx, item);
    }
  }
  const scores = [];
  const comments = [];
  for (let i = 0; i < qs.length; i++) {
    const item = byIndex.get(i);
    let score = Number(item && item.score);
    if (!isFinite(score)) {
      const fb = ruleScore(qs[i].text, as[i]);
      scores.push(fb.score);
      comments.push(fb.comment);
      continue;
    }
    score = Math.max(SCORE_MIN, Math.min(SCORE_MAX, Math.round(score)));
    scores.push(score);
    const c = item && typeof item.comment === "string" ? item.comment.slice(0, 60) : "";
    comments.push(c || ruleScore(qs[i].text, as[i]).comment);
  }
  const summaries = {};
  const subj = llm && llm.subjectSummary;
  if (subj && typeof subj === "object") {
    for (const [k, v] of Object.entries(subj)) {
      if (typeof v === "string") summaries[k] = v.slice(0, 80);
    }
  }
  const suggestions = Array.isArray(llm.suggestions)
    ? llm.suggestions.filter((s) => typeof s === "string" && s.trim()).map((s) => s.slice(0, 80)).slice(0, 6)
    : [];
  const overall = llm && typeof llm.overall === "string" ? llm.overall.slice(0, 200) : "";
  return { scores, comments, summaries, suggestions, overall };
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { error: "未获取用户身份，请重新进入小程序" };

  const norm = normalizeInput(event.questions, event.answers);
  if (norm.error) return { error: norm.error };
  const { qs, as } = norm;

  const answeredCount = as.filter((a) => a).length;
  if (answeredCount === 0) {
    return { error: "所有题目均未作答，请先完成至少一题" };
  }

  // 配额（真实 LLM 调用前）
  const quota = await reserveQuota(OPENID);
  if (!quota.ok) return { error: quota.reason };

  // 注入防护：任一答案命中注入特征 → 不采信 LLM（整卷规则分）
  const injectionHits = [];
  as.forEach((a, i) => {
    for (const h of scanInjection(a)) injectionHits.push(`第${i + 1}题:${h}`);
  });

  // 1) LLM 评分（失败降级）
  let llm = null;
  let model = "rule";
  if (injectionHits.length === 0) {
    try {
      const { system, user } = buildPrompt(qs, as);
      const raw = await callLLM(system, user, { json: true, temperature: 0.2, maxRetries: 1 });
      llm = JSON.parse(raw);
      model = "llm";
    } catch (e) {
      console.warn("quizScore LLM failed, fallback to rule:", e.message);
      llm = null;
      model = "rule";
    }
  }

  // 2) 汇每题分数：LLM 可用 → 采信（带口径校验）；否则规则分
  let scores, comments, summaries, suggestions, overall;
  if (llm) {
    const adopted = adoptLlmScores(llm, qs, as);
    scores = adopted.scores;
    comments = adopted.comments;
    summaries = adopted.summaries;
    suggestions = adopted.suggestions;
    overall = adopted.overall;
  } else {
    scores = [];
    comments = [];
    for (let i = 0; i < qs.length; i++) {
      const fb = ruleScore(qs[i].text, as[i]);
      scores.push(fb.score);
      comments.push(fb.comment);
    }
    summaries = {};
    suggestions = [];
    overall = "";
  }

  // 3) 科目聚合 + 总分（确定性）
  const subjectMap = buildSubjectMap(qs, scores, summaries);
  const totalScore = Math.round((scores.reduce((a, b) => a + b, 0) / (qs.length * SCORE_MAX)) * 100);
  // 薄弱科目学习建议（规则兜底：LLM 未给出时）
  if (!suggestions.length) {
    for (const s of subjectMap.slice(0, 2)) {
      suggestions.push(`「${s.category}」掌握较弱（均分 ${s.avgScore}/5），建议优先复习该科目的核心概念与经典例题`);
    }
    suggestions.push("作答时采用「定义 → 展开 → 举例」三段结构，可明显提升得分");
  }

  const report = {
    kind: "quiz",
    totalScore,
    perQuestion: qs.map((q, i) => ({
      index: i,
      category: q.category,
      question: q.text,
      score: scores[i],
      comment: comments[i],
      answered: Boolean(as[i]),
    })),
    subjectMap,
    radar: subjectMap.map((s) => Math.max(1, Math.min(5, Math.round(s.avgScore)))),
    labels: subjectMap.map((s) => s.category),
    suggestions,
    overall,
    stats: { answered: answeredCount, total: qs.length },
    model,
  };
  if (injectionHits.length) {
    report.injectionFlagged = true;
    report.model = "rule";
  }

  // 4) 持久化到 practices（kind:"quiz"），历史记录页可见。
  //    写库失败不阻塞返回报告（persisted:false 前端提示）。
  let recordId = "";
  try {
    const cats = [...new Set(qs.map((q) => q.category))];
    const addRes = await db.collection("practices").add({
      data: {
        openid: OPENID,
        kind: "quiz",
        scene: "interview",
        questionText: `【题库抽题】${cats.join("+")} · ${qs.length} 题`,
        audioFileID: "",
        durationSec: 0,
        transcript: qs.map((q, i) => `Q${i + 1}(${q.category})：${q.text}\nA：${as[i] || "（未作答）"}`).join("\n\n"),
        sentences: [],
        status: "done",
        report,
        createdAt: Date.now(),
      },
    });
    recordId = addRes._id;
    report.persisted = true;
  } catch (e) {
    console.error("quiz 保存失败:", e.message);
    report.persisted = false;
    report.persistError = describeDbError(e, "成绩已生成，但写入历史记录失败");
  }

  return { report, recordId };
};
