// 题库抽题 · 答题页：一次展示全部题目，逐题作答，最后统一交卷评分
// 状态机：loading → ready → submitting → (成功跳结果页 | 提交失败回 ready)
import type { IAppOption } from "../../app";
import { quizDraw, quizScore, showCallError, errorText } from "../../utils/api";
import { MAX_QUIZ_ANSWER_LEN, clampAnswer } from "../../utils/quiz";
import type { QuizQuestion } from "../../utils/quiz";
import { createNavGuard, NavGuard } from "../../utils/nav-guard";

function getAppInstance(): IAppOption {
  return getApp<IAppOption>();
}

interface QuizItem extends QuizQuestion {
  index: number;
  shortCategory: string;
}

Page({
  data: {
    loading: false,
    loadFailed: false,
    errorMsg: "",
    // 科目标签（设置页带过来，展示用）
    catsLabel: "",
    // 题目 + 答案（下标一一对应）
    items: [] as QuizItem[],
    answers: [] as string[],
    answeredCount: 0,
    submitting: false,
    // 输入长度上限提示用
    maxLen: MAX_QUIZ_ANSWER_LEN,
  },

  alive: true,
  loadWatchdog: null as number | null,
  _guard: null as NavGuard | null,
  _params: { cats: [] as string[], n: 12 },

  onLoad(query: Record<string, string>) {
    this.alive = true;
    this._guard = createNavGuard({});
    // 解析参数：cats=逗号分隔科目；n=题量（10~15，非法回退 12）
    const cats = (query.cats || "").split(",").map((s) => s.trim()).filter(Boolean);
    const nRaw = Number(query.n);
    const n = isFinite(nRaw) ? Math.max(10, Math.min(15, Math.round(nRaw))) : 12;
    this._params = { cats, n };
    this.setData({ catsLabel: cats.join(" · ") });
    this.load();
  },

  onUnload() {
    this.alive = false;
    this.clearLoadWatchdog();
    if (this._guard) this._guard.dispose();
  },

  clearLoadWatchdog() {
    if (this.loadWatchdog !== null) {
      clearTimeout(this.loadWatchdog);
      this.loadWatchdog = null;
    }
  },

  async load() {
    if (this.data.loading) return;
    this.setData({ loading: true, loadFailed: false, errorMsg: "" });
    // 看门狗：25s（> api.ts 20s 超时）强制归位，防永久「抽题中」
    this.clearLoadWatchdog();
    this.loadWatchdog = setTimeout(() => {
      this.loadWatchdog = null;
      if (!this.data.loading) return;
      this.setData({ loading: false, loadFailed: true, errorMsg: "抽题超时，请检查网络后重试" });
    }, 25000) as unknown as number;

    try {
      const app = getAppInstance();
      if (!app.globalData.openid) {
        try {
          await app.login();
        } catch (loginErr) {
          console.warn("登录失败，继续尝试抽题:", loginErr);
        }
      }
      const res = await quizDraw({ categories: this._params.cats, count: this._params.n });
      if (!this.alive) return;
      const list: QuizItem[] = (res.questions || []).map((q, i) => ({
        ...q,
        index: i,
        shortCategory: q.category,
      }));
      if (!list.length) {
        this.setData({ loading: false, loadFailed: true, errorMsg: "未抽到题目，请先在云开发控制台导入题库（questions.import.json）" });
        return;
      }
      this.setData({
        loading: false,
        loadFailed: false,
        items: list,
        answers: list.map(() => ""),
        answeredCount: 0,
      });
    } catch (e: any) {
      if (!this.alive) return;
      this.setData({ loading: false, loadFailed: true, errorMsg: errorText(e, "抽题失败") });
      showCallError(e, "抽题失败");
    } finally {
      this.clearLoadWatchdog();
      if (this.alive && this.data.loading) this.setData({ loading: false });
    }
  },

  onRetry() {
    this.load();
  },

  /** 单题答案输入（data-index 定位） */
  onAnswerInput(e: WechatMiniprogram.TouchEvent) {
    const idx = Number(e.currentTarget.dataset.index);
    const value = typeof e.detail.value === "string" ? e.detail.value : "";
    if (!isFinite(idx) || idx < 0 || idx >= this.data.items.length) return;
    // 长度兜底：超出上限截断（服务端也会再截）
    const v = value.length > MAX_QUIZ_ANSWER_LEN ? value.slice(0, MAX_QUIZ_ANSWER_LEN) : value;
    const next = this.data.answers.slice();
    const wasEmpty = !next[idx];
    next[idx] = v;
    const isEmpty = !v.trim();
    const patch: Record<string, any> = { answers: next };
    if (wasEmpty !== isEmpty) {
      patch.answeredCount = this.data.answeredCount + (isEmpty ? -1 : 1);
    }
    this.setData(patch);
  },

  /** 全部交卷 */
  async onSubmitAll() {
    // ── 1. 业务前置 ──
    if (this.data.submitting) {
      wx.showToast({ title: "正在评分，请稍候", icon: "none" });
      return;
    }
    const { items, answers } = this.data;
    if (!items.length) {
      wx.showToast({ title: "题目尚未加载", icon: "none" });
      return;
    }
    const unanswered = answers.filter((a) => !a || !a.trim()).length;
    if (unanswered > 0) {
      wx.showToast({ title: `还有 ${unanswered} 题未作答，请完成后再交卷`, icon: "none" });
      return;
    }

    // ── 2. 防重入：时间戳锁 ──
    if (!this._guard || !this._guard.tryLock()) return;
    this.setData({ submitting: true });
    try {
      const payload = {
        questions: items.map((q) => ({ text: q.text, category: q.category, difficulty: q.difficulty })),
        answers: answers.map((a) => clampAnswer(a)),
      };
      const { recordId } = await quizScore(payload);
      if (!this.alive) return;
      // 交卷成功：跳结果页（由结果页经 getPractice 拉报告，与历史记录入口共用渲染）
      this._guard && this._guard.unlock();
      wx.redirectTo({
        url: `/pages/quiz-result/quiz-result?recordId=${recordId}`,
        fail: () => {
          // redirectTo 失败（极端：页面栈异常）→ 兜底提示，用户可从历史记录进入
          wx.showToast({ title: "评分完成，但跳转失败，可在历史记录查看", icon: "none", duration: 3000 });
        },
      });
    } catch (e: any) {
      if (!this.alive) return;
      showCallError(e, "评分失败");
      wx.showToast({ title: errorText(e, "评分失败"), icon: "none", duration: 2500 });
    } finally {
      // 评分失败/超时 → submitting 归位，允许重试；成功路径由 redirectTo 离开页面
      if (this.alive) this.setData({ submitting: false });
      if (this._guard) this._guard.unlock();
    }
  },
});
