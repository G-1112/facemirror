// 场景选择页：选场景 + 选模式（随机抽题 / 自定义出题）
import { SCENES } from "../../utils/config";
import { createNavGuard, NavGuard } from "../../utils/nav-guard";

Page({
  data: {
    scenes: SCENES,
    scene: "interview",
    mode: "random", // random | custom
    // 防重入窗口状态：⚠️ 仅用于**视觉反馈**（按钮显示"跳转中…"），
    // **绝不作为可点性闸门**。真正的闸门是 nav-guard 的时间戳锁。
    // 详见 utils/nav-guard.ts 顶部的「三条铁律」。
    navigating: false,
  },

  /** 防重入守卫（非响应式字段，不进 data） */
  _guard: null as NavGuard | null,

  /** 页面是否仍存活：异步回调里 setData 前必须检查 */
  alive: true,

  onLoad() {
    this.alive = true;
    this._guard = createNavGuard({
      onLockChange: (locked) => {
        if (this.alive) this.setData({ navigating: locked });
      },
    });
  },

  /**
   * 页面回到前台 → 强制解锁。
   * 兜底路径：即便 navigateTo 的回调永远不来，用户回到首页也能继续操作。
   */
  onShow() {
    if (this._guard) this._guard.unlock();
  },

  onUnload() {
    this.alive = false;
    // 必须 dispose：否则看门狗定时器会在页面销毁后触发回调 → setData 到已销毁页面。
    if (this._guard) this._guard.dispose();
  },

  onSceneTap(e: WechatMiniprogram.TouchEvent) {
    this.setData({ scene: e.currentTarget.dataset.key as string });
  },

  onModeTap(e: WechatMiniprogram.TouchEvent) {
    this.setData({ mode: e.currentTarget.dataset.mode as string });
  },

  onStart() {
    // 防重入：窗口内忽略连点（时间戳锁会自动过期，永不永久卡死）
    if (!this._guard || !this._guard.tryLock()) return;
    const { scene, mode } = this.data;
    wx.navigateTo({
      url: `/pages/question/question?scene=${scene}&mode=${mode}`,
      success: () => {
        // 到达目标页后允许再次进入（本页仍在栈底）
        if (this._guard) this._guard.unlock();
      },
      fail: () => {
        // 修复：原先没有 fail 回调，页面栈已满 10 层时静默失败，
        // 用户点击后毫无反应。
        if (this._guard) this._guard.unlock();
        wx.showToast({ title: "页面打开失败，请重试", icon: "none" });
      },
    });
  },

  onHistory() {
    if (!this._guard || !this._guard.tryLock()) return;
    wx.navigateTo({
      url: "/pages/history/history",
      success: () => {
        if (this._guard) this._guard.unlock();
      },
      fail: () => {
        if (this._guard) this._guard.unlock();
        wx.showToast({ title: "页面打开失败，请重试", icon: "none" });
      },
    });
  },

  /**
   * 进入深度面试（简历驱动）链路。
   * 与「开始练习」一样走 nav-guard 时间戳锁：防重入靠 JS 侧，不靠 disabled。
   */
  onDeep() {
    if (!this._guard || !this._guard.tryLock()) return;
    wx.navigateTo({
      url: "/pages/resume/resume",
      success: () => {
        if (this._guard) this._guard.unlock();
      },
      fail: () => {
        if (this._guard) this._guard.unlock();
        wx.showToast({ title: "页面打开失败，请重试", icon: "none" });
      },
    });
  },
});
