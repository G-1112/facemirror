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
    } catch (e) {
      this.setData({ loading: false });
    }
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
