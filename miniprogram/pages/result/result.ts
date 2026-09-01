// 报告页（FR-09/10/11）：总分 + 雷达 + 维度 + 逐句批注 + 改进建议 + 分享海报
import { getPractice } from "../../utils/api";

Page({
  data: {
    recordId: "",
    loading: true,
    report: null as any,
    transcript: "",
    showPoster: false,
    radarLabels: ["内容", "结构", "表达", "节奏", "专业度"],
    dimensionList: [
      { key: "relevance", label: "相关性" },
      { key: "structure", label: "结构" },
      { key: "evidence", label: "论据" },
      { key: "professional", label: "专业度" },
      { key: "delivery", label: "表达" },
    ],
  },

  onLoad(query: Record<string, string>) {
    this.setData({ recordId: query.recordId || "" });
    this.load();
  },

  async load() {
    try {
      const p = await getPractice(this.data.recordId);
      this.setData({ report: p.report, transcript: p.transcript, loading: false });
    } catch (e) {
      wx.showToast({ title: "加载失败", icon: "none" });
      this.setData({ loading: false });
    }
  },

  onShowPoster() {
    this.setData({ showPoster: true });
  },

  onHidePoster() {
    this.setData({ showPoster: false });
  },

  onShareAppMessage() {
    const score = this.data.report ? this.data.report.totalScore : 0;
    return {
      title: `面镜 · 我的表达能力评估 ${score} 分`,
      path: "/pages/index/index",
    };
  },
});
