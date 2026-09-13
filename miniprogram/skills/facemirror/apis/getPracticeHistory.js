// apis/getPracticeHistory.js — 查询当前用户的练习历史（只读）
//
// 真实入口复刻：pages/history/history.ts load() → getHistory({ page, pageSize: 10 })。
// 云函数只返回本人 status=done 的记录（服务端 OPENID 隔离）。
// [ai-mode:static] 响应字段来源：cloudfunctions/getHistory/index.js（见 analysis-apis.md）。
const { errorResult, successResult, callCloud } = require("../utils/util");

async function getPracticeHistory(params = {}) {
  console.info("[ai-mode] getPracticeHistory 入口, params=", JSON.stringify(params));
  try {
    const page = Math.max(1, Number(params.page) || 1);
    const pageSize = Math.min(20, Math.max(1, Number(params.pageSize) || 10));

    const res = await callCloud("getHistory", { page, pageSize });
    const rawList = (res && res.list) || [];
    const total = (res && res.total) || 0;

    // 响应归一化：report 体积大，列表只保留摘要字段（recordId 供 getPracticeReport 使用）
    const list = rawList.map((it) => ({
      recordId: it._id,
      scene: it.scene,
      questionText: it.questionText,
      status: it.status,
      totalScore: it.report && typeof it.report.totalScore === "number" ? it.report.totalScore : null,
      createdAt: it.createdAt,
    }));

    if (!list.length) {
      return {
        ...successResult("你还没有已完成的练习记录。可以先抽一道题，进小程序开口练一次。", { total: 0, list: [] }),
        handoff: { query: "" },
      };
    }

    const summary = list
      .map((it, i) => `${i + 1}. ${it.questionText}（${it.totalScore === null ? "未出分" : it.totalScore + " 分"}）`)
      .join("；");
    return {
      ...successResult(`你共有 ${total} 次已完成的练习，最近 ${list.length} 次：${summary}`, { total, list }),
      // history 页 onLoad 不读取任何参数
      handoff: { query: "" },
    };
  } catch (err) {
    console.error("[ai-mode] getPracticeHistory 出错:", err.message);
    return errorResult(`查询练习历史失败: ${err.message}`);
  }
}

module.exports = { getPracticeHistory };
