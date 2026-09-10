// 历史记录页（FR-12）
import { getHistory } from "../../utils/api";

const SCENE_LABEL: Record<string, string> = {
  interview: "模拟面试",
  defense: "答辩预演",
  presentation: "课堂展示",
};

Page({
  data: {
    list: [] as any[],
    total: 0,
    page: 1,
    loading: false,
    hasMore: true,
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

  onLoad() {
    this.load();
  },

  async load() {
    if (this.data.loading || !this.data.hasMore) return;
    this.setData({ loading: true });
    try {
      const { list, total } = await getHistory({ page: this.data.page, pageSize: 10 });
      const mapped = list.map((it) => ({
        ...it,
        sceneLabel: SCENE_LABEL[it.scene] || it.scene,
        dateLabel: this.formatDate(it.createdAt),
        score: it.report ? it.report.totalScore : 0,
      }));
      const merged = this.data.list.concat(mapped);
      this.setData({
        list: merged,
        total,
        page: this.data.page + 1,
        hasMore: merged.length < total,
        loading: false,
      });
      this.computeStats(merged);
    } catch (e) {
      this.setData({ loading: false });
    }
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
    const avg = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
    const best = Math.max(...scores);
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

  formatDate(ts: number): string {
    if (!ts) return "";
    const d = new Date(ts);
    const p = (n: number) => (n < 10 ? "0" + n : String(n));
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  },
});
