// 报告页（FR-09/10/11）：总分 + 雷达 + 维度 + 逐句批注 + 改进建议 + 分享海报
import { getPractice } from "../../utils/api";

// 薄弱项诊断（第三轮交互增强）：把最低分维度转成「一句诊断 + 一条可执行建议 + 推荐练习场景」，
// 让用户看完分数后知道「下一步具体练什么」，而不是停在分数上。
const WEAKNESS_ADVICE: Record<string, { title: string; tip: string; scene: string; sceneLabel: string }> = {
  relevance: {
    title: "答非所问",
    tip: "先复述问题再作答，用「这个问题的核心是……」开场，确保每个例子都回扣问题。",
    scene: "interview",
    sceneLabel: "模拟面试",
  },
  structure: {
    title: "缺少框架",
    tip: "用「总—分—总」或 STAR 结构：先给结论，再列 2-3 个要点，最后收束回结论。",
    scene: "defense",
    sceneLabel: "答辩预演",
  },
  evidence: {
    title: "论据单薄",
    tip: "每个观点配一个具体例证：数据、项目经历或案例，避免只有形容词没有事实。",
    scene: "interview",
    sceneLabel: "模拟面试",
  },
  professional: {
    title: "专业度不足",
    tip: "补充领域术语与原理性解释，展示「为什么这么做」而不只是「做了什么」。",
    scene: "presentation",
    sceneLabel: "课堂展示",
  },
  delivery: {
    title: "表达欠流畅",
    tip: "控制语速（约 200 字/分），减少「呃、就是」等口头禅，句间留 0.5 秒换气停顿。",
    scene: "presentation",
    sceneLabel: "课堂展示",
  },
};

Page({
  data: {
    recordId: "",
    loading: true,
    report: null as any,
    transcript: "",
    showPoster: false,
    weakness: null as any,
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
      this.setData({
        report: p.report,
        transcript: p.transcript,
        loading: false,
        weakness: this.diagnose(p.report),
      });
    } catch (e) {
      wx.showToast({ title: "加载失败", icon: "none" });
      this.setData({ loading: false });
    }
  },

  /** 找出最低分维度并给出可执行建议（无报告或数据缺失时返回 null） */
  diagnose(report: any) {
    const dims = report && report.dimensions;
    if (!dims) return null;
    let worstKey = "";
    let worstVal = Infinity;
    this.data.dimensionList.forEach((d) => {
      const v = Number(dims[d.key]);
      if (!isNaN(v) && v < worstVal) {
        worstVal = v;
        worstKey = d.key;
      }
    });
    if (!worstKey) return null;
    const label = (this.data.dimensionList.find((d) => d.key === worstKey) || {}).label || worstKey;
    const advice = WEAKNESS_ADVICE[worstKey] || {
      title: "待提升",
      tip: "多练习并回看逐句批注，针对性改进。",
      scene: "interview",
      sceneLabel: "模拟面试",
    };
    return { key: worstKey, label, value: Math.round(worstVal), ...advice };
  },

  /** 一键去练最薄弱的场景 */
  onPracticeWeakness() {
    const w = this.data.weakness;
    if (!w) return;
    wx.navigateTo({ url: `/pages/question/question?scene=${w.scene}&mode=random` });
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
