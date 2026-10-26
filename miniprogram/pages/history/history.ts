// 历史记录页（FR-12）
import { getHistory, showCallError, errorText } from "../../utils/api";

const SCENE_LABEL: Record<string, string> = {
  interview: "模拟面试",
  defense: "答辩预演",
  presentation: "课堂展示",
};

Page({
  data: {
    list: [] as any[],
    filtered: [] as any[],
    total: 0,
    page: 1,
    loading: false,
    hasMore: true,
    // 加载失败标记（修复：原先 catch 里只 setData，失败完全静默，
    // 用户看到的是「还没有练习记录」的空态，与「加载失败」无法区分）
    loadFailed: false,
    errorMsg: "",
    // 场景筛选（第三轮交互增强）
    sceneFilter: "all" as string,
    sceneTabs: [
      { key: "all", label: "全部" },
      { key: "interview", label: "面试" },
      { key: "defense", label: "答辩" },
      { key: "presentation", label: "展示" },
    ],
    // 练习趋势面板（交互增强）
    stats: {
      count: 0,
      avgScore: 0,
      bestScore: 0,
      trendUp: false,
      trendDelta: 0,
      spark: [] as number[], // 最近若干次分数（旧→新）
      dims: [] as { key: string; label: string; value: number }[],
    },
  },

  // 页面是否仍存活：load() 是异步链，用户中途退出后不应再 setData
  alive: true,

  onLoad() {
    this.load();
  },

  onUnload() {
    // 页面已销毁：异步加载链完成后不再 setData
    this.alive = false;
  },

  async load() {
    if (this.data.loading || !this.data.hasMore) return;
    this.setData({ loading: true });
    try {
      const { list, total } = await getHistory({ page: this.data.page, pageSize: 10 });
      // 防御：云函数异常时 list 可能不是数组，直接 .map 会抛错
      const arr = Array.isArray(list) ? list : [];
      const mapped = arr.map((it) => ({
        ...it,
        sceneLabel: SCENE_LABEL[it.scene] || it.scene,
        dateLabel: this.formatDate(it.createdAt),
        score: it.report ? it.report.totalScore : 0,
      }));
      const merged = this.data.list.concat(mapped);
      if (!this.alive) return; // 页面已卸载
      this.setData({
        list: merged,
        total,
        page: this.data.page + 1,
        hasMore: merged.length < total && mapped.length > 0,
        loading: false,
        loadFailed: false,
        errorMsg: "",
      });
      this.applyFilter(merged);
      this.computeStats(merged);
    } catch (e: any) {
      // 修复：原先这里完全静默（只 setData({loading:false})），
      // 用户既看不到原因也无法重试，只会以为「本来就没有记录」。
      if (!this.alive) return; // 页面已卸载
      this.setData({ loading: false, loadFailed: true, errorMsg: errorText(e, "加载失败") });
      showCallError(e, "加载失败");
    }
  },

  /** 重新加载（修复：失败后无重试入口） */
  onRetry() {
    this.setData({ page: 1, list: [], hasMore: true, loadFailed: false });
    this.load();
  },

  /** 按场景筛选已加载的记录（纯前端，不额外请求） */
  applyFilter(list: any[]) {
    const f = this.data.sceneFilter;
    this.setData({ filtered: f === "all" ? list : list.filter((it) => it.scene === f) });
  },

  onSelectScene(e: WechatMiniprogram.TouchEvent) {
    const key = e.currentTarget.dataset.key as string;
    this.setData({ sceneFilter: key });
    this.applyFilter(this.data.list);
  },

  /** 由已完成记录聚合练习趋势（纯前端，无需后端改动） */
  computeStats(list: any[]) {
    const done = list.filter((it) => it.status === "done" && it.report);
    if (!done.length) {
      this.setData({
        stats: { count: 0, avgScore: 0, bestScore: 0, trendUp: false, trendDelta: 0, spark: [], dims: [] },
      });
      return;
    }
    // 接口按 createdAt desc 返回，反转成时间升序便于看趋势
    const asc = done.slice().reverse();
    const scores = asc.map((it) => Number(it.report.totalScore) || 0);
    const avg = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 0;
    // 不用 Math.max(...scores)：数组很大时展开参数会超出引擎参数上限抛 RangeError
    let best = 0;
    for (const s of scores) if (s > best) best = s;
    // 趋势：最近 3 次均值 vs 之前 3 次均值
    const half = Math.min(3, Math.floor(scores.length / 2));
    let trendUp = false;
    let trendDelta = 0;
    if (half >= 1) {
      const recent = scores.slice(-half);
      const prev = scores.slice(-half * 2, -half);
      if (prev.length) {
        const rAvg = recent.reduce((a, b) => a + b, 0) / recent.length;
        const pAvg = prev.reduce((a, b) => a + b, 0) / prev.length;
        trendDelta = Math.round(rAvg - pAvg);
        trendUp = trendDelta >= 0;
      }
    }
    // 五维平均
    const dimKeys: { key: string; label: string }[] = [
      { key: "relevance", label: "相关性" },
      { key: "structure", label: "结构" },
      { key: "evidence", label: "论据" },
      { key: "professional", label: "专业性" },
      { key: "delivery", label: "表达" },
    ];
    const dims = dimKeys.map((d) => {
      const vals = done
        .map((it) => (it.report.dimensions ? Number(it.report.dimensions[d.key]) : NaN))
        .filter((v) => !isNaN(v));
      return { ...d, value: vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : 0 };
    });
    this.setData({
      stats: {
        count: done.length,
        avgScore: avg,
        bestScore: best,
        trendUp,
        trendDelta,
        spark: scores.slice(-8),
        dims,
      },
    });
  },

  onReachBottom() {
    this.load();
  },

  onTapItem(e: WechatMiniprogram.TouchEvent) {
    const id = e.currentTarget.dataset.id as string;
    wx.navigateTo({ url: `/pages/result/result?recordId=${id}` });
  },

  /**
   * 时间格式化。
   * 修复：原实现只判 `if (!ts) return ""`，但 createdAt 若为字符串日期
   * （云开发不同版本返回类型不一致）或非法值，new Date(ts) 会得到 Invalid Date，
   * 渲染出 "NaN-NaN-NaN NaN:NaN"。这里统一做类型归一与有效性校验。
   */
  formatDate(ts: any): string {
    if (!ts) return "";
    let d: Date;
    if (typeof ts === "number") {
      d = new Date(ts);
    } else if (typeof ts === "string") {
      // 纯数字字符串按时间戳处理，其余按日期字符串解析
      d = /^\d+$/.test(ts) ? new Date(Number(ts)) : new Date(ts);
    } else if (ts instanceof Date) {
      d = ts;
    } else {
      return "";
    }
    if (isNaN(d.getTime())) return "";
    const p = (n: number) => (n < 10 ? "0" + n : String(n));
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  },
});
