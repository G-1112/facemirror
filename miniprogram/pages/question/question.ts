// 出题页：随机抽题 / 自定义出题（上传材料 → AI 生成追问）
import type { IAppOption } from "../../app";
import { genQuestions, getQuestions, showCallError, errorText } from "../../utils/api";
import { createNavGuard, NavGuard } from "../../utils/nav-guard";

// 修复：原先在模块顶层调用 getApp()。
// 小程序页面的 TS 模块在其 JS 被 require 时求值，而此时 App 实例可能尚未完成
// onLaunch 初始化（自定义构建/分包/开发者工具热重载下尤其明显），
// getApp() 会返回 undefined，之后任何 app.globalData 访问都会抛
// "Cannot read property 'globalData' of undefined"。
// 改为在方法内部按需获取。
function getAppInstance(): IAppOption {
  return getApp<IAppOption>();
}

Page({
  data: {
    scene: "interview",
    mode: "random",
    loading: false,
    question: "",
    questions: [] as any[],
    uploading: false,
    materialName: "",
    // 加载失败标记：用于展示「重试」入口，避免用户面对空白页无路可走
    loadFailed: false,
    errorMsg: "",
    // 「去作答」的防重入窗口状态：⚠️ 仅用于视觉反馈，**不作为可点性闸门**
    // （详见 utils/nav-guard.ts 顶部「三条铁律」）。
    navigating: false,
  },

  // 页面是否仍存活：loadRandom / 上传是异步链，用户中途退出后不应再 setData
  alive: true,
  // 加载看门狗定时器句柄：防止请求永不 settle 时页面卡在 loading
  loadWatchdog: null as number | null,
  // 「去作答」防重入守卫（非响应式字段，不进 data）
  _guard: null as NavGuard | null,

  onLoad(query: Record<string, string>) {
    const scene = query.scene || "interview";
    const mode = query.mode || "random";
    this.setData({ scene, mode });
    // 「去作答」防重入守卫：时间戳锁，窗口自动过期，永不永久卡死
    this._guard = createNavGuard({
      onLockChange: (locked) => {
        if (this.alive) this.setData({ navigating: locked });
      },
    });
    if (mode === "retry") {
      // 同题重练（第四轮）：沿用上一次的题目，便于直接对比改进效果，
      // 不再随机抽题。
      const preset = query.question ? decodeURIComponent(query.question) : "";
      if (!preset) {
        // 修复：原先把兜底文案写成「请点击『换一题』重新抽题」，
        // 但 retry 模式下「换一题」按钮不显示（wx:if mode==='random'），
        // 用户会陷入没有出路的死胡同。改为直接回退到随机抽题模式。
        this.setData({ mode: "random" });
        this.loadRandom();
        return;
      }
      this.setData({ question: preset, loading: false });
      return;
    }
    if (mode === "random") this.loadRandom();
    else this.setData({ loading: false });
  },

  onUnload() {
    // 页面已销毁：异步链完成后不再 setData
    this.alive = false;
    // 清理加载看门狗，避免页面销毁后仍触发 setData
    this.clearLoadWatchdog();
    // 清理防重入守卫的看门狗，避免页面销毁后仍触发回调
    if (this._guard) this._guard.dispose();
  },

  /**
   * 页面回到前台 → 强制解锁「去作答」防重入窗口。
   * 兜底：即便 navigateTo 的回调永远不来，用户从录音页返回后也能继续点。
   */
  onShow() {
    if (this._guard) this._guard.unlock();
  },

  async loadRandom() {
    // 防重复请求：连点「换一题」会并发发起多次云函数调用
    if (this.data.loading) return;
    this.setData({ loading: true, loadFailed: false, errorMsg: "" });

    // 看门狗：无论请求以何种方式结束（成功/失败/异常未捕获），
    // 最迟 25 秒后强制结束 loading 态。
    // 背景：云函数未部署 / 环境未关联 / 网络挂起时 Promise 可能永不 settle，
    // 页面会永久停在「题目加载中…」，用户完全没有出路。
    // 25s > api.ts 的 20s 超时，留出余量让正常超时错误先展示。
    this.clearLoadWatchdog();
    this.loadWatchdog = setTimeout(() => {
      this.loadWatchdog = null;
      if (!this.data.loading) return;
      this.setData({
        loading: false,
        loadFailed: true,
        errorMsg: "请求超时，请检查网络或确认云函数已部署",
        question: "",
      });
    }, 25000) as unknown as number;

    try {
      // 云函数已开启鉴权，调用前确保 openid 就绪。
      // 修复：登录失败不再直接中断整个流程——改为记录原因后继续尝试抽题。
      // getQuestions 云函数自己也会校验 OPENID 并返回明确错误，
      // 这样「登录失败」与「抽题失败」的错误信息都能如实呈现给用户。
      const app = getAppInstance();
      if (!app.globalData.openid) {
        try {
          await app.login();
        } catch (loginErr: any) {
          console.warn("登录失败，继续尝试抽题:", loginErr);
        }
      }
      const { questions } = await getQuestions({ scene: this.data.scene, limit: 1 });
      if (!this.alive) return; // 页面已卸载
      if (questions && questions.length) {
        // 回归修复：这里必须显式 loading:false。
        // 原实现靠 finally 里的 setData({loading:false}) 兜底，
        // 上一轮重构把 finally 改成 clearLoadWatchdog() 时漏掉了这一句，
        // 导致抽题成功后 loading 仍为 true → WXML 的 wx:if="{{loading}}"
        // 把「题目加载中…」钉在页面上，真实题目被遮住、且「去作答」按钮
        // 因 disabled="{{!question || loading}}" 永久禁用。
        this.setData({ question: questions[0].text, loadFailed: false, loading: false });
      } else {
        // 题库为空属正常情况（非错误），给可操作的引导而非错误态
        this.setData({
          question: "（题库为空，请先导入题目到 questions 集合）",
          loadFailed: false,
          loading: false,
        });
      }
    } catch (e: any) {
      // 修复：原实现只 toast 且 question 保持为空 →
      // 「去作答」按钮永久禁用，用户既看不到原因也无法重试，只能退出重进。
      // 现在落到错误态：展示原因 + 提供「重试」按钮。
      if (!this.alive) return; // 页面已卸载
      this.setData({
        loading: false,
        loadFailed: true,
        errorMsg: errorText(e, "加载失败"),
        question: "",
      });
      showCallError(e, "加载失败");
    } finally {
      this.clearLoadWatchdog();
      // 兜底：无论走成功分支还是失败分支，loading 必须归位。
      // 页面已卸载时不再 setData（否则控制台报「setData 到已销毁页面」）。
      if (this.alive && this.data.loading) {
        this.setData({ loading: false });
      }
    }
  },

  clearLoadWatchdog() {
    if (this.loadWatchdog !== null) {
      clearTimeout(this.loadWatchdog);
      this.loadWatchdog = null;
    }
  },

  onChange() {
    this.loadRandom();
  },

  // 自定义出题：选择材料文件
  onUploadMaterial() {
    // 防重复提交：上传/生成期间忽略再次点击，否则会并发上传并重复计费
    if (this.data.uploading) return;
    wx.chooseMessageFile({
      count: 1,
      type: "file",
      // 格式白名单（2026-10-27）：服务端 extractText 支持 txt/md/docx/pdf，
      // pdf 由服务端 pdf-parse 提取文字（扫描件会明确报错指引）。
      // 客户端与服务端扩展名白名单保持一致。
      extension: ["txt", "md", "docx", "pdf"],
      success: async (res) => {
        // 防御：极端情况下 tempFiles 可能为空数组，原实现直接取 [0].name 会抛错
        const file = res.tempFiles && res.tempFiles[0];
        if (!file) {
          wx.showToast({ title: "未选择到文件", icon: "none" });
          return;
        }
        this.setData({ uploading: true, materialName: file.name });
        wx.showLoading({ title: "AI 生成追问中" });
        try {
          // openid 写入 cloudPath：云函数据此校验材料归属，
          // 防止他人拿到 fileID 后越权下载简历 / 项目材料
          const app = getAppInstance();
          let openid = app.globalData.openid;
          if (!openid) {
            await app.login();
            openid = app.globalData.openid;
          }
          if (!openid) throw new Error("登录失败，请重启小程序后重试");

          const upload = await wx.cloud.uploadFile({
            cloudPath: `materials/${openid}/${Date.now()}-${file.name}`,
            filePath: file.path,
          });
          const { questions } = await genQuestions({
            fileID: upload.fileID,
            scene: this.data.scene,
          });
          const list = (questions || []).map((q, i) => ({ ...q, index: i }));
          if (!this.alive) return; // 页面已卸载
          this.setData({ questions: list, question: list[0] ? list[0].question : "" });
          // 生成结果为空时给出明确提示，避免用户对着空题目困惑
          if (!list.length) {
            wx.showToast({ title: "未能从材料生成问题，可换份材料试试", icon: "none" });
          }
        } catch (e: any) {
          if (!this.alive) return; // 页面已卸载
          showCallError(e, "出题失败");
        } finally {
          wx.hideLoading();
          if (this.alive) this.setData({ uploading: false });
        }
      },
      // 修复：原先没有 fail 回调，用户取消选择或接口失败时完全无反馈，
      // 看起来像「点击没反应」。
      fail: (err: any) => {
        // 用户主动取消不算错误，不打扰
        const msg = err?.errMsg || "";
        if (msg.includes("cancel")) return;
        wx.showToast({ title: "选择文件失败，请重试", icon: "none" });
      },
    });
  },

  onPickQuestion(e: WechatMiniprogram.TouchEvent) {
    // 修复：原先未校验索引越界，data-index 缺失或非法时 q 为 undefined，
    // 访问 q.question 直接抛 "Cannot read property 'question' of undefined"。
    const idx = Number(e.currentTarget.dataset.index);
    const q = this.data.questions[idx];
    if (!q) return;
    this.setData({ question: q.question });
  },

  onGo() {
    // ── 1. 业务前置条件检查（不是防重入，是真的没题目）──
    // 修复（2026-10-26）：原先 WXML 用 `disabled="{{!question || loading}}"`，
    // 而 loading 只有唯一一条归位路径，一旦卡住按钮就**永久变灰点不动**。
    // 现在按钮永不禁用，改为在 JS 层拦截并**给出明确反馈**：
    //   - 加载中 → 告诉用户正在加载（而不是让按钮变灰）
    //   - 没题目 → 引导用户重试 / 上传材料
    if (this.data.loading) {
      wx.showToast({ title: "题目加载中，请稍候", icon: "none" });
      return;
    }
    if (this.data.loadFailed) {
      wx.showToast({ title: "加载失败，请先点「重新加载」", icon: "none" });
      return;
    }
    if (!this.data.question) {
      wx.showToast({ title: "请先获取题目", icon: "none" });
      return;
    }

    // ── 2. 防重入：连点「去作答」会多次 navigateTo，导致页面栈膨胀 ──
    // 时间戳锁，窗口自动过期 → 永不永久卡死
    if (!this._guard || !this._guard.tryLock()) return;

    wx.navigateTo({
      url: `/pages/record/record?scene=${this.data.scene}&question=${encodeURIComponent(this.data.question)}`,
      success: () => {
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
});
