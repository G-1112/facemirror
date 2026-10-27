// 题库抽题 · 结果页：总分 + 科目能力图谱（雷达）+ 逐题点评 + 学习建议
// 数据来源：getPractice(recordId)（report.kind === "quiz"）。
// 与历史记录页「点开题库抽题记录」共用同一入口，渲染口径一致。
import { getPractice, showCallError, errorText } from "../../utils/api";
import type { QuizReport, QuizSubjectMastery, QuizPerQuestion } from "../../utils/quiz";

/** report → 扁平视图（模板只渲染字符串/数组，禁止深层访问） */
function toReportView(report: QuizReport | null | undefined) {
  if (!report || report.kind !== "quiz") return null;
  const subjectMap: QuizSubjectMastery[] = Array.isArray(report.subjectMap) ? report.subjectMap : [];
  const perQuestion: QuizPerQuestion[] = Array.isArray(report.perQuestion) ? report.perQuestion : [];
  // 雷达与标签取两者较小长度，值夹到 [1,5]，缺项用 3（与 deep-report 同策略）
  const labels = subjectMap.map((s) => s.category);
  const radarRaw = Array.isArray(report.radar) ? report.radar : [];
  const radar = labels.map((_, i) => {
    const v = Math.round(Number(radarRaw[i]));
    return isFinite(v) ? Math.max(1, Math.min(5, v)) : 3;
  });
  return {
    hasReport: true,
    totalScore: report.totalScore || 0,
    scoreLevel:
      (report.totalScore || 0) >= 80 ? "优秀" : (report.totalScore || 0) >= 60 ? "良好" : "待提升",
    radar,
    labels,
    subjectList: subjectMap.map((s) => ({
      category: s.category,
      count: s.count,
      avgScoreText: s.avgScore.toFixed(1),
      percent: Math.max(0, Math.min(100, Math.round(s.percent))),
      summary: s.summary || "",
    })),
    perQuestion: perQuestion.map((p, i) => ({
      no: i + 1,
      category: p.category,
      question: p.question,
      score: p.score,
      comment: p.comment || "",
      answered: !!p.answered,
    })),
    suggestions: report.suggestions || [],
    overall: report.overall || "",
    stats: {
      answered: (report.stats && report.stats.answered) || 0,
      total: (report.stats && report.stats.total) || 0,
    },
    model: report.model === "llm" ? "AI 评分" : "规则评分（未接入大模型）",
    injected: !!report.injectionFlagged,
    persisted: report.persisted !== false,
    persistError: (report as any).persistError || "",
  };
}

Page({
  data: {
    loading: true,
    loadFailed: false,
    errorMsg: "",
    view: null as ReturnType<typeof toReportView>,
    recordId: "",
  },

  alive: true,

  onLoad(query: Record<string, string>) {
    this.alive = true;
    this.setData({ recordId: query.recordId || "" });
    this.load();
  },

  onUnload() {
    this.alive = false;
  },

  async load() {
    if (!this.data.recordId) {
      this.setData({ loading: false, loadFailed: true, errorMsg: "缺少成绩编号，请从答题页或历史记录进入" });
      return;
    }
    this.setData({ loading: true, loadFailed: false });
    try {
      const detail = await getPractice(this.data.recordId);
      if (!this.alive) return;
      const view = toReportView(detail && (detail.report as any));
      if (!view) {
        this.setData({ loading: false, loadFailed: true, errorMsg: "这不是题库抽题成绩，无法在此页展示" });
        return;
      }
      this.setData({ loading: false, loadFailed: false, view });
    } catch (e: any) {
      if (!this.alive) return;
      this.setData({ loading: false, loadFailed: true, errorMsg: errorText(e, "加载成绩失败") });
      showCallError(e, "加载成绩失败");
    }
  },

  onRetry() {
    this.load();
  },

  /** 回首页再练一轮 */
  onBackHome() {
    wx.reLaunch({ url: "/pages/index/index" });
  },
});
