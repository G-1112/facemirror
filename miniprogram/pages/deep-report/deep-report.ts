// 深度面试 · 总结报告
// 复用 components/radar-chart 组件（原生 Canvas，6 维能力雷达）
import { getDeepSession, deepAnalyze, showCallError, errorText } from "../../utils/api";
import { createNavGuard, NavGuard } from "../../utils/nav-guard";
import { DeepReport, DEEP_DIMENSIONS, formatDuration } from "../../utils/interview";

/** 报告 → 扁平视图（模板只渲染字符串/数组，禁止深层访问） */
function toReportView(report: DeepReport | null) {
  const r = report;
  if (!r) {
    return {
      hasReport: false,
      totalScore: 0,
      radar: [3, 3, 3, 3, 3, 3],
      labels: DEEP_DIMENSIONS.map((d) => d.name),
      dimList: [] as any[],
      strengths: [] as any[],
      weaknesses: [] as any[],
      knowledgeGaps: [] as any[],
      resumeTips: [] as string[],
      expressionTips: [] as string[],
      practiceSuggestions: [] as string[],
      perQuestion: [] as any[],
      overall: "",
      stats: { answered: 0, total: 0, avgDurationText: "0:00", totalDurationText: "0:00" },
    };
  }
  // 雷达值补齐到 6 个（维度顺序固定），缺项用 3
  const radarRaw = Array.isArray(r.radar) ? r.radar : [];
  const radar = DEEP_DIMENSIONS.map((_, i) => {
    const v = Math.round(Number(radarRaw[i]));
    return isFinite(v) ? Math.max(1, Math.min(5, v)) : 3;
  });
  const dims = r.dimensions || {};
  return {
    hasReport: true,
    totalScore: r.totalScore || 0,
    radar,
    labels: DEEP_DIMENSIONS.map((d) => d.name),
    dimList: DEEP_DIMENSIONS.map((d, i) => ({
      key: d.key,
      name: d.name,
      score: radar[i],
      percent: Math.round((radar[i] / 5) * 100),
    })),
    strengths: (r.strengths || []).map((s) => ({
      dimension: s.dimension || "综合",
      text: s.text || "",
      evidence: s.evidence || "",
    })),
    weaknesses: (r.weaknesses || []).map((s) => ({
      dimension: s.dimension || "综合",
      text: s.text || "",
      evidence: s.evidence || "",
    })),
    knowledgeGaps: (r.knowledgeGaps || []).map((g) => ({
      topic: g.topic || "",
      reason: g.reason || "",
      resource: g.resource || "",
    })),
    resumeTips: r.resumeTips || [],
    expressionTips: r.expressionTips || [],
    practiceSuggestions: r.practiceSuggestions || [],
    perQuestion: (r.perQuestion || []).map((p) => ({
      questionId: p.questionId,
      question: p.question || "",
      score: p.score || 0,
      feedback: p.feedback || "",
      hit: (p.hit || []).join("；"),
      missed: (p.missed || []).join("；"),
    })),
    overall: r.overall || "",
    stats: {
      answered: (r.stats && r.stats.answered) || 0,
      total: (r.stats && r.stats.total) || 0,
      avgDurationText: formatDuration((r.stats && r.stats.avgDurationSec) || 0),
      totalDurationText: formatDuration((r.stats && r.stats.totalDurationSec) || 0),
    },
  };
}

Page({
  data: {
    loading: true,
    analyzing: false,
    loadFailed: false,
    errorMsg: "",
    interviewId: "",
    reportView: toReportView(null),
    navigating: false,
  },

  alive: true,
  _guard: null as NavGuard | null,

  onLoad(query: Record<string, string>) {
    this.alive = true;
    const id = query.interviewId || "";
    if (!id) {
      this.setData({ loading: false, loadFailed: true, errorMsg: "缺少面试记录，请重新开始" });
      return;
    }
    this.setData({ interviewId: id });
    this._guard = createNavGuard({
      onLockChange: (locked) => {
        if (this.alive) this.setData({ navigating: locked });
      },
    });
    this.loadReport();
  },

  onShow() {
    if (this._guard) this._guard.unlock();
  },

  onUnload() {
    this.alive = false;
    if (this._guard) this._guard.dispose();
  },

  async loadReport() {
    this.setData({ loading: true, loadFailed: false, errorMsg: "" });
    try {
      const s = await getDeepSession(this.data.interviewId);
      if (!this.alive) return;
      if (s && s.report) {
        this.setData({ loading: false, reportView: toReportView(s.report) });
        return;
      }
      // 报告还没生成 → 触发一次
      this.setData({ loading: false });
      await this.generateReport();
    } catch (e: any) {
      if (!this.alive) return;
      this.setData({ loading: false, loadFailed: true, errorMsg: errorText(e, "加载报告失败") });
      showCallError(e, "加载报告失败");
    }
  },

  async generateReport() {
    if (this.data.analyzing) {
      wx.showToast({ title: "正在生成中，请稍候", icon: "none" });
      return;
    }
    this.setData({ analyzing: true, errorMsg: "", loadFailed: false });
    wx.showLoading({ title: "正在生成总结", mask: true });
    try {
      const { report } = await deepAnalyze(this.data.interviewId);
      if (!this.alive) return;
      if (!report) throw new Error("总结生成失败");
      this.setData({ analyzing: false, reportView: toReportView(report) });
    } catch (e: any) {
      if (!this.alive) return;
      this.setData({ analyzing: false, loadFailed: true, errorMsg: errorText(e, "总结生成失败") });
      showCallError(e, "总结生成失败");
    } finally {
      wx.hideLoading();
      if (this.alive) this.setData({ analyzing: false });
    }
  },

  onRetry() {
    this.setData({ loadFailed: false, errorMsg: "" });
    this.loadReport();
  },
});
