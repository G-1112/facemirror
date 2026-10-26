// 报告页（FR-09/10/11）：总分 + 雷达 + 维度 + 逐句批注 + 改进建议 + 分享海报
import { getPractice, showCallError, errorText } from "../../utils/api";

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
    // 加载失败标记：修复「失败后页面永久空白、无重试入口」
    loadFailed: false,
    errorMsg: "",
    report: null as any,
    transcript: "",
    questionText: "",
    scene: "interview",
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
    // 维度分数预计算：修复「模板中 report.dimensions[item.key] 索引缺失维度时
    // 渲染 undefined，且乘 20 得到 NaN 导致进度条宽度异常」
    dimRows: [] as { key: string; label: string; value: number; percent: number }[],
    // 列表数据预计算：修复「模板中 report.strengths.length 等深层访问，
    // 字段缺失时渲染层直接抛错导致整页白屏」
    strengths: [] as any[],
    improvements: [] as string[],
    sentenceNotes: [] as any[],
    // 雷达图数据兜底：缺失时给中性值 [3,3,3,3,3]，避免组件拿到空数组不渲染
    radarData: [3, 3, 3, 3, 3] as number[],
    // 表达指标预计算：同上，避免模板直接深层访问 report.expression.*
    expressionView: {
      speedWpm: 0,
      fillerRate: 0,
      longPauseCount: 0,
      fillerTop3: [] as string[],
      opening: 0,
      body: 0,
      closing: 0,
    },
  },

  // 页面是否仍存活：load() 是异步链，用户中途退出后不应再 setData
  alive: true,

  onLoad(query: Record<string, string>) {
    this.setData({ recordId: query.recordId || "" });
    this.load();
  },

  onUnload() {
    // 页面已销毁：异步加载链完成后不再 setData，避免控制台告警
    this.alive = false;
  },

  async load() {
    this.setData({ loading: true, loadFailed: false, errorMsg: "" });
    try {
      if (!this.data.recordId) {
        throw new Error("缺少记录 ID");
      }
      const p = await getPractice(this.data.recordId);
      if (!this.alive) return; // 页面已卸载，避免向已销毁页面 setData
      // 报告可能尚未生成（status 仍为 pending/asr_done），
      // 此时 report 为 null，属正常中间态而非错误
      this.setData({
        report: p.report,
        transcript: p.transcript,
        questionText: p.questionText || "",
        scene: p.scene || "interview",
        loading: false,
        loadFailed: !p.report,
        errorMsg: p.report ? "" : "报告还在生成中，请稍后重试",
        weakness: this.diagnose(p.report),
      });
      this.setData({
        dimRows: this.buildDimRows(p.report),
        expressionView: this.buildExpressionView(p.report),
        strengths: Array.isArray(p.report?.strengths) ? p.report.strengths : [],
        improvements: Array.isArray(p.report?.improvements) ? p.report.improvements : [],
        sentenceNotes: Array.isArray(p.report?.sentenceNotes) ? p.report.sentenceNotes : [],
        radarData: this.buildRadar(p.report),
      });
    } catch (e: any) {
      // 修复：原先只 toast 后 loading=false，report 仍为 null →
      // 整个页面只剩一个「加载中…」消失后的空白，用户无法判断发生了什么，
      // 也没有重试入口。
      if (!this.alive) return; // 页面已卸载，避免向已销毁页面 setData
      this.setData({
        loading: false,
        loadFailed: true,
        errorMsg: errorText(e, "加载失败"),
      });
      showCallError(e, "加载失败");
    }
  },

  /** 重试加载（新增） */
  onRetry() {
    this.load();
  },

  /** 把 report.dimensions 摊平成渲染用的行数组（缺失维度按 0 处理） */
  buildDimRows(report: any) {
    const dims = report?.dimensions || {};
    return this.data.dimensionList.map((d: any) => {
      const raw = Number(dims[d.key]);
      const value = isNaN(raw) ? 0 : Math.max(0, Math.min(5, raw));
      return { key: d.key, label: d.label, value, percent: value * 20 };
    });
  },

  /** 把 report.expression 摊平成渲染用的视图对象（缺失字段按 0 处理） */
  buildExpressionView(report: any) {
    const ex = report?.expression || {};
    const split = ex.timeSplit || {};
    return {
      speedWpm: Number(ex.speedWpm) || 0,
      fillerRate: Number(ex.fillerRate) || 0,
      longPauseCount: Number(ex.longPauseCount) || 0,
      fillerTop3: Array.isArray(ex.fillerTop3) ? ex.fillerTop3 : [],
      opening: Number(split.opening) || 0,
      body: Number(split.body) || 0,
      closing: Number(split.closing) || 0,
    };
  },

  /** 同题重练（第四轮）：沿用原题再练一次，便于直接对比改进效果 */
  onRetrySameQuestion() {
    const q = this.data.questionText;
    if (!q) {
      wx.showToast({ title: "原题缺失，请重新抽题", icon: "none" });
      return;
    }
    wx.navigateTo({
      url: `/pages/question/question?scene=${this.data.scene}&mode=retry&question=${encodeURIComponent(q)}`,
    });
  },

  /** 雷达图数据兜底：长度不足或含非法值时补齐为中性 3 分 */
  buildRadar(report: any) {
    const src = Array.isArray(report?.radar) ? report.radar : [];
    const out: number[] = [];
    for (let i = 0; i < 5; i++) {
      const v = Number(src[i]);
      out.push(isNaN(v) ? 3 : Math.max(0, Math.min(5, v)));
    }
    return out;
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
    // 防御：report 为空时打开海报弹层，模板访问 report.totalScore 会渲染 undefined
    if (!this.data.report) {
      wx.showToast({ title: "报告尚未生成", icon: "none" });
      return;
    }
    this.setData({ showPoster: true });
  },

  onHidePoster() {
    this.setData({ showPoster: false });
  },

  /** 空实现：用于 catchtap="noop"，阻止海报弹层内部点击冒泡到遮罩。
   *  必须真实存在——官方《事件绑定》说明处理函数未定义时控制台会报错。 */
  noop() {
    // 故意留空
  },

  onShareAppMessage() {
    const score = this.data.report ? this.data.report.totalScore : 0;
    return {
      title: `面镜 · 我的表达能力评估 ${score} 分`,
      path: "/pages/index/index",
    };
  },
});
