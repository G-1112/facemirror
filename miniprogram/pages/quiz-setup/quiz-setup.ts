// 题库抽题 · 设置页：自选科目（多选）+ 题量档位 + 难度档位 → 抽题
import {
  QUIZ_SUBJECTS,
  QUIZ_COUNT_OPTIONS,
  QUIZ_DEFAULT_COUNT,
  QUIZ_DIFFICULTIES,
  QUIZ_DEFAULT_DIFFICULTY,
  isValidSubjectSelection,
} from "../../utils/quiz";
import type { QuizDifficulty } from "../../utils/quiz";
import { createNavGuard, NavGuard } from "../../utils/nav-guard";

Page({
  data: {
    subjects: QUIZ_SUBJECTS.map((s) => ({ ...s, checked: false })),
    selected: [] as string[],
    countOptions: QUIZ_COUNT_OPTIONS,
    count: QUIZ_DEFAULT_COUNT,
    difficultyOptions: QUIZ_DIFFICULTIES,
    difficulty: QUIZ_DEFAULT_DIFFICULTY,
    // 防重入的视觉反馈（不是可点性闸门，铁律见 nav-guard.ts 顶部）
    navigating: false,
  },

  _guard: null as NavGuard | null,
  alive: true,

  onLoad() {
    this.alive = true;
    this._guard = createNavGuard({
      onLockChange: (locked) => {
        if (this.alive) this.setData({ navigating: locked });
      },
    });
  },

  onUnload() {
    this.alive = false;
    if (this._guard) this._guard.dispose();
  },

  onShow() {
    // 页面回到前台 → 强制解锁（兜底：navigateTo 回调不来也不卡死）
    if (this._guard) this._guard.unlock();
  },

  onToggleSubject(e: WechatMiniprogram.TouchEvent) {
    const key = e.currentTarget.dataset.key as string;
    const selected = this.data.selected.slice();
    const idx = selected.indexOf(key);
    if (idx >= 0) selected.splice(idx, 1);
    else selected.push(key);
    // subjects 的 checked 仅用于样式，单独映射避免深层 setData 路径
    const subjects = this.data.subjects.map((s) => ({ ...s, checked: selected.indexOf(s.key) >= 0 }));
    this.setData({ selected, subjects });
  },

  onPickCount(e: WechatMiniprogram.TouchEvent) {
    const n = Number(e.currentTarget.dataset.count);
    if (QUIZ_COUNT_OPTIONS.indexOf(n) < 0) return;
    this.setData({ count: n });
  },

  onPickDifficulty(e: WechatMiniprogram.TouchEvent) {
    const d = e.currentTarget.dataset.diff as string;
    if ((QUIZ_DIFFICULTIES as readonly string[]).indexOf(d) < 0) return;
    // indexOf 白名单校验已保证 d 合法，这里窄化类型
    this.setData({ difficulty: d as QuizDifficulty });
  },

  onStart() {
    // ── 1. 业务前置：至少选一个科目（可操作提示，不靠 disabled） ──
    const { selected, count, difficulty } = this.data;
    if (!isValidSubjectSelection(selected)) {
      wx.showToast({ title: "请先选择至少一个科目", icon: "none" });
      return;
    }
    // ── 2. 防重入：时间戳锁 ──
    if (!this._guard || !this._guard.tryLock()) return;
    const cats = encodeURIComponent(selected.join(","));
    const diff = encodeURIComponent(difficulty);
    wx.navigateTo({
      url: `/pages/quiz/quiz?cats=${cats}&n=${count}&diff=${diff}`,
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
