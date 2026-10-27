// 深度面试 · 逐题作答
//
// 状态机（page-level）：
//   loading ──拉取会话──> ready ──开始作答──> answering ──提交──> scoring
//                                        ↑                    │
//                                        └────(未答完)────────┘
//   scoring ──最后一题──> completing(生成总结) ──> done(跳 deep-report)
//
// 跨页续答：每次 onShow 都从云端拉一次会话（questions/answers/currentIndex），
// 页面被系统杀掉或用户中途退出后，进度不丢。
import { getDeepSession, submitDeepAnswer, deepAnalyze, showCallError, errorText } from "../../utils/api";
import { createNavGuard, NavGuard } from "../../utils/nav-guard";
import {
  InterviewQuestion,
  AnswerRecord,
  formatDuration,
  dimensionName,
  questionTypeName,
} from "../../utils/interview";

/** 单题最长作答时间（秒）：超时后仍可提交，只做提示 */
const SOFT_LIMIT_SEC = 300;

Page({
  data: {
    loading: true,
    submitting: false,
    completing: false,
    errorMsg: "",
    loadFailed: false,

    interviewId: "",
    questions: [] as InterviewQuestion[],
    currentIndex: 0,
    answeredCount: 0,
    totalCount: 0,
    /** questionId → 已保存的回答文本（回看历史题时恢复输入框内容） */
    lastAnswerMap: {} as Record<string, string>,

    // 当前题扁平视图（模板只渲染字符串，避免深层访问 undefined）
    cur: {
      id: "",
      no: 0,
      question: "",
      typeName: "",
      difficulty: "",
      competencyName: "",
      evidence: "",
      followups: [] as string[],
      keyPoints: [] as string[],
      showFollowups: false,
      showKeyPoints: false,
    },

    answer: "",
    elapsedSec: 0,
    elapsedText: "0:00",
    overLimit: false,

    // 最近一次提交的反馈（hit/missed 预拼成字符串：模板不能 join 数组）
    lastFeedback: "",
    lastScore: 0,
    lastHit: "",
    lastMissed: "",
    showFeedback: false,
  },

  alive: true,
  _guard: null as NavGuard | null,
  /** 计时器：题内计时 */
  _timer: null as number | null,
  /** 本题开始时间戳（毫秒） */
  _startedAt: 0,

  onLoad(query: Record<string, string>) {
    this.alive = true;
    const id = query.interviewId || "";
    if (!id) {
      this.setData({ loading: false, loadFailed: true, errorMsg: "缺少面试记录，请从简历页重新开始" });
      return;
    }
    this.setData({ interviewId: id });
    this._guard = createNavGuard({
      onLockChange: (locked) => {
        if (this.alive) this.setData({ navigating: locked });
      },
    });
    this.loadSession();
  },

  onShow() {
    if (this._guard) this._guard.unlock();
    // 回到前台时重新拉一次会话：若在其他页面/中断处有进度变化，以云端为准
    // ⚠️ 首次 onShow 时 loading 仍为 true（onLoad 的请求未回）→ 不重复拉
    if (this.data.loading) return;
    if (this.data.interviewId && !this.data.submitting && !this.data.completing) {
      this.loadSession(true);
    }
  },

  onUnload() {
    this.alive = false;
    this.clearTimer();
    if (this._guard) this._guard.dispose();
  },

  clearTimer() {
    if (this._timer !== null) {
      clearInterval(this._timer);
      this._timer = null;
    }
  },

  // ------------------------------------------------------------ 加载会话
  /**
   * @param silent    true = 静默刷新（不重置 loading / 不弹错误）
   * @param keepFeedback true = 保留上一题反馈（提交后自动跳下一题时用，
   *                   否则用户提交完立刻看不到「本题得分」）
   */
  async loadSession(silent = false, keepFeedback = false) {
    if (!silent) this.setData({ loading: true, loadFailed: false, errorMsg: "" });
    try {
      const s = await getDeepSession(this.data.interviewId);
      if (!this.alive) return;
      if (!s || !s.questions || !s.questions.length) {
        this.setData({ loading: false, loadFailed: true, errorMsg: "尚未生成题目，请返回简历页生成" });
        return;
      }
      const answers: AnswerRecord[] = s.answers || [];
      // 已答过的题：建立 questionId → 回答文本 的映射（回看历史题时恢复输入框内容）
      const answeredMap: Record<string, string> = {};
      for (const a of answers) answeredMap[a.questionId] = a.answer;

      const idx = Math.min(Math.max(0, s.currentIndex || 0), s.questions.length - 1);

      // ★防「正在输入的回答被覆盖」：
      //   onShow 每次都会 loadSession，若用户已在输入框写了内容但尚未提交，
      //   applyQuestion 会用云端答案（空）覆盖它 → 用户输入丢失。
      //   解决：若当前题与服务端 currentIndex 是同一题，且本地有未提交的内容 → 保留本地。
      const sameQuestion = this.data.cur.id === s.questions[idx].id;
      const localDraft = (this.data.answer || "").trim();
      const hasDraft = sameQuestion && !!localDraft && !answeredMap[s.questions[idx].id];

      this.applyQuestion(s.questions, idx, answeredMap, keepFeedback);
      this.setData({
        loading: false,
        loadFailed: false,
        questions: s.questions,
        currentIndex: idx,
        answeredCount: answers.length,
        totalCount: s.questions.length,
        lastAnswerMap: answeredMap,
      });
      if (hasDraft) {
        this.setData({ answer: localDraft });
      }
      this.startTimer();
    } catch (e: any) {
      if (!this.alive) return;
      this.setData({ loading: false, loadFailed: true, errorMsg: errorText(e, "加载面试失败") });
      if (!silent) showCallError(e, "加载面试失败");
    }
  },

  /**
   * 把第 index 题铺到页面上。
   * @param keepFeedback 保留上一题反馈（提交后自动跳题时为 true）
   */
  applyQuestion(
    questions: InterviewQuestion[],
    index: number,
    answeredMap: Record<string, string>,
    keepFeedback = false
  ) {
    const q = questions[index];
    if (!q) return;
    this.setData({
      cur: {
        id: q.id,
        no: index + 1,
        question: q.question,
        typeName: questionTypeName(q.type),
        difficulty: q.difficulty,
        competencyName: dimensionName(q.competency),
        evidence: q.evidence || "",
        followups: (q.followups || []).slice(0, 3),
        keyPoints: (q.keyPoints || []).slice(0, 5),
        showFollowups: false,
        showKeyPoints: false,
      },
      answer: answeredMap[q.id] || "",
      elapsedSec: 0,
      elapsedText: "0:00",
      overLimit: false,
      // ★提交后自动跳到下一题时保留反馈（否则用户提交完看不到本题得分）
      showFeedback: keepFeedback ? this.data.showFeedback : false,
    });
  },

  // ------------------------------------------------------------ 计时
  startTimer() {
    this.clearTimer();
    this._startedAt = Date.now();
    this._timer = setInterval(() => {
      if (!this.alive) return;
      const sec = Math.floor((Date.now() - this._startedAt) / 1000);
      this.setData({ elapsedSec: sec, elapsedText: formatDuration(sec), overLimit: sec > SOFT_LIMIT_SEC });
    }, 1000) as unknown as number;
  },

  // ------------------------------------------------------------ 交互
  onInput(e: WechatMiniprogram.Input) {
    this.setData({ answer: e.detail.value });
  },

  /** 错误态的「重新加载」出口 —— 加载失败必须给可操作路径，不能只显示一句错 */
  onRetry() {
    this.setData({ loadFailed: false, errorMsg: "" });
    this.loadSession();
  },

  onToggleFollowups() {
    this.setData({ "cur.showFollowups": !this.data.cur.showFollowups });
  },

  onToggleKeyPoints() {
    this.setData({ "cur.showKeyPoints": !this.data.cur.showKeyPoints });
  },

  onPrev() {
    const idx = this.data.currentIndex - 1;
    if (idx < 0) {
      wx.showToast({ title: "已经是第一题", icon: "none" });
      return;
    }
    const prev = this.data.questions[idx];
    if (!prev) return;
    // 回看历史题：答案从已加载的映射里取（不重新拉云端，避免 currentIndex 被服务端覆盖）
    this.applyQuestion(this.data.questions, idx, this.data.lastAnswerMap || {});
    this.setData({ currentIndex: idx });
    this.startTimer();
  },

  onNext() {
    const idx = this.data.currentIndex + 1;
    if (idx >= this.data.questions.length) {
      wx.showToast({ title: "已经是最后一题", icon: "none" });
      return;
    }
    const next = this.data.questions[idx];
    if (!next) return;
    this.applyQuestion(this.data.questions, idx, this.data.lastAnswerMap || {});
    this.setData({ currentIndex: idx });
    this.startTimer();
  },

  // ------------------------------------------------------------ 提交本题
  async onSubmit() {
    // ── 业务前置 ──
    if (this.data.submitting || this.data.completing) {
      wx.showToast({ title: "正在提交中，请稍候", icon: "none" });
      return;
    }
    const answer = (this.data.answer || "").trim();
    if (!answer) {
      wx.showToast({ title: "请先写下你的回答", icon: "none" });
      return;
    }
    if (answer.length < 5) {
      wx.showToast({ title: "回答太短，请补充细节", icon: "none" });
      return;
    }

    this.setData({ submitting: true, errorMsg: "", loadFailed: false });
    const durationSec = this.data.elapsedSec;
    try {
      const res = await submitDeepAnswer({
        interviewId: this.data.interviewId,
        questionId: this.data.cur.id,
        answer,
        durationSec,
      });
      if (!this.alive) return;

      const rec = res && res.record;
      this.setData({
        submitting: false,
        lastFeedback: (rec && rec.feedback) || "已记录。",
        lastScore: (rec && rec.score) || 0,
        // 数组在模板里渲染会变成 "a,b"，显式拼接更可控
        lastHit: ((rec && rec.hit) || []).join("；"),
        lastMissed: ((rec && rec.missed) || []).join("；"),
        showFeedback: true,
        answeredCount: (res && res.answeredCount) || this.data.answeredCount,
        totalCount: (res && res.totalCount) || this.data.totalCount,
      });

      // 最后一题 → 生成总结
      if (res && res.finished) {
        await this.finishInterview();
        return;
      }
      // 下一题
      const nextIdx = Math.min(this.data.currentIndex + 1, this.data.questions.length - 1);
      this.setData({ currentIndex: nextIdx });
      // keepFeedback=true：提交后自动跳题，但要让用户仍能看到「本题得分」
      await this.loadSession(true, true);
    } catch (e: any) {
      if (!this.alive) return;
      this.setData({ submitting: false, errorMsg: errorText(e, "提交失败"), loadFailed: true });
      showCallError(e, "提交失败");
    }
  },

  // ------------------------------------------------------------ 生成总结
  async finishInterview() {
    this.setData({ completing: true, errorMsg: "", loadFailed: false });
    wx.showLoading({ title: "正在生成总结", mask: true });
    try {
      const { report } = await deepAnalyze(this.data.interviewId);
      if (!this.alive) return;
      if (!report) throw new Error("总结生成失败");
      if (!this._guard || !this._guard.tryLock()) return;
      wx.redirectTo({
        url: `/pages/deep-report/deep-report?interviewId=${this.data.interviewId}`,
        success: () => {
          if (this._guard) this._guard.unlock();
        },
        fail: () => {
          if (this._guard) this._guard.unlock();
          wx.showToast({ title: "报告打开失败，请重试", icon: "none" });
        },
      });
    } catch (e: any) {
      if (!this.alive) return;
      this.setData({ completing: false, errorMsg: errorText(e, "总结生成失败"), loadFailed: true });
      showCallError(e, "总结生成失败");
    } finally {
      wx.hideLoading();
      if (this.alive) this.setData({ completing: false });
    }
  },
});
