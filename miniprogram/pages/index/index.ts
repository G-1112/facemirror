// 场景选择页：选场景 + 选模式（随机抽题 / 自定义出题）
import { SCENES } from "../../utils/config";

Page({
  data: {
    scenes: SCENES,
    scene: "interview",
    mode: "random", // random | custom
  },

  onSceneTap(e: WechatMiniprogram.TouchEvent) {
    this.setData({ scene: e.currentTarget.dataset.key as string });
  },

  onModeTap(e: WechatMiniprogram.TouchEvent) {
    this.setData({ mode: e.currentTarget.dataset.mode as string });
  },

  onStart() {
    const { scene, mode } = this.data;
    wx.navigateTo({
      url: `/pages/question/question?scene=${scene}&mode=${mode}`,
    });
  },

  onHistory() {
    wx.navigateTo({ url: "/pages/history/history" });
  },
});
