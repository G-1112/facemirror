// 多维评估（FR-07 + FR-08 + FR-09）：LLM 评估 + 规则化表达分析 → report
const cloud = require("wx-server-sdk");
const { callLLM } = require("./llm");
const prompts = require("./prompts");
const { analyzeExpression, paceScore } = require("./expression");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const clamp = (v) => Math.max(1, Math.min(5, Math.round(v)));

/** 合成报告：雷达五维 = 内容/结构/表达/节奏/专业度 */
function buildReport(transcript, durationSec, sentences, llm, expression) {
  const relevance = clamp(llm.relevance || 3);
  const structure = clamp(llm.structure || 3);
  const evidence = clamp(llm.evidence || 3);
  const professional = clamp(llm.professional || 3);
  const delivery = expression.deliveryScore; // 表达（规则）
  const pace = paceScore(expression.speedWpm); // 节奏（规则）

  const content = Math.round((relevance + evidence) / 2); // 内容 = 相关性 + 论据
  const radar = [content, structure, delivery, pace, professional];
  const totalScore = Math.round((radar.reduce((a, b) => a + b, 0) / 5) * 20);

  return {
    totalScore,
    dimensions: { relevance, structure, evidence, professional, delivery },
    radar,
    strengths: llm.strengths || [],
    improvements: llm.improvements || [],
    modelAnswer: llm.modelAnswer || "",
    sentenceNotes: llm.sentenceNotes || [],
    expression,
    overall: llm.overall || "",
  };
}

/** 无 LLM 时的确定性回退，保证离线可跑通 */
function mockEval(transcript) {
  const len = transcript.replace(/\s+/g, "").length;
  return {
    relevance: len > 120 ? 4 : 3,
    structure: 3,
    evidence: 3,
    professional: 3,
    sentenceNotes: [],
    strengths: [{ text: "作答完整度尚可", quote: transcript.slice(0, 30) }],
    improvements: [
      "补充具体事例或数据支撑观点",
      "采用总分总结构先亮结论",
      "控制填充词与语速",
    ],
    modelAnswer: "（未配置 LLM，示范回答需接入大模型后生成）",
    overall: "基于规则的初步评估，接入大模型后可获得更细致的点评。",
  };
}

exports.main = async (event) => {
  const { recordId } = event;
  if (!recordId) return { error: "缺少 recordId" };

  const doc = await db.collection("practices").doc(recordId).get();
  const p = doc.data;
  const transcript = (p.transcript || "").trim();
  if (!transcript) return { error: "转写文本为空，请先完成语音识别或手动输入" };

  // 1) 规则化表达分析（确定性、零成本）
  const expression = analyzeExpression(transcript, p.durationSec, p.sentences || []);

  // 2) LLM 多维评估（失败降级为 mock）
  let llm;
  try {
    const raw = await callLLM(prompts.evalSystem, prompts.evalUser(p.questionText, transcript), {
      json: true,
      temperature: 0.2,
    });
    llm = JSON.parse(raw);
  } catch (e) {
    console.warn("LLM eval failed, fallback to mock:", e.message);
    llm = mockEval(transcript);
  }

  const report = buildReport(transcript, p.durationSec, p.sentences || [], llm, expression);

  await db.collection("practices").doc(recordId).update({
    data: { report, status: "done" },
  });

  return { status: "done", report };
};
