// apis/getPracticeReport.js — 查看某次练习的评估报告摘要（只读）
//
// 真实入口复刻：pages/result/result.ts load() → getPractice(recordId)。
// 云函数做 OPENID 归属校验，只能读本人记录。
// [ai-mode:static] 响应字段来源：cloudfunctions/getPractice/index.js（见 analysis-apis.md）。
const { errorResult, successResult, callCloud } = require("../utils/util");

async function getPracticeReport(params = {}) {
  console.info("[ai-mode] getPracticeReport 入口, params=", JSON.stringify(params));
  try {
    const recordId = params.recordId;
    if (!recordId || typeof recordId !== "string") {
      return errorResult("缺少 recordId：请先调用 getPracticeHistory 获取练习记录 ID");
    }

    const p = await callCloud("getPractice", { recordId });
    const report = p.report || null;
    const detail = {
      recordId,
      status: p.status,
      scene: p.scene,
      questionText: p.questionText || "",
      durationSec: p.durationSec || 0,
      totalScore: report && typeof report.totalScore === "number" ? report.totalScore : null,
      overall: (report && report.overall) || "",
    };

    let text;
    if (p.status === "done" && report) {
      text = `这次练习得分 ${detail.totalScore} 分。总评：${detail.overall || "（无）"}。点下方卡片可查看完整雷达图与逐句批注。`;
    } else {
      text = `这次练习当前状态为 ${p.status}，评估报告尚未生成，进小程序可继续完成评估流程。`;
    }

    return {
      ...successResult(text, detail),
      // result 页 onLoad 读取 query.recordId
      handoff: { query: `recordId=${encodeURIComponent(recordId)}` },
    };
  } catch (err) {
    console.error("[ai-mode] getPracticeReport 出错:", err.message);
    return errorResult(`查询评估报告失败: ${err.message}`);
  }
}

module.exports = { getPracticeReport };
