// 录音作答页（FR-04/05/06）：录音 → 上传 → ASR → （人工修正）→ 评估 → 报告
import { getRecorder, Recorder, StopPayload } from "../../utils/recorder";
import { submitPractice, requestSubscribe, call, showCallError, errorText } from "../../utils/api";
import { checkRecordAuth, describeRecorderError, openRecordSetting } from "../../utils/privacy";

/**
 * 调用云函数并检查业务错误。
 * 修复点：
 * 1. 云函数失败时返回 { error: "..." }（而非抛异常），
 *    原实现只 await 不检查返回值，导致 analyze 失败（未登录 / 配额超限 /
 *    无访问权限）后依然跳转到结果页，用户看到的是一张空白的报告页，
 *    真正的错误信息被完全丢弃。
 * 2. 改用 api.ts 的 call()（带 20s 超时 + 空响应校验）。
 *    原先这里裸调 wx.cloud.callFunction，云函数未部署 / 环境未关联 /
 *    网络挂起时 Promise 永不 settle → 页面永久停在「上传录音中…」。
 */
async function callChecked(name: string, data: Record<string, any> = {}): Promise<any> {
  // call() 内部已校验 result 非空并抛出「服务无响应」，此处只需处理业务 error
  const res = await call<any>(name, data);
  if (res && res.error) {
    throw new Error(String(res.error));
  }
  return res;
}

Page({
  data: {
    scene: "interview",
    question: "",
    durationOptions: [1, 3, 5],
    duration: 3,
    status: "idle", // idle | recording | paused | stopping | uploading | transcribing | analyzing | editing
    remaining: 0,
    // 倒计时文本：在逻辑层算好再 setData。
    // 原因：模板数据绑定表达式的作用域只能取到 data 与 data 中的函数，
    // 取不到 Page 方法区定义的 formatTime（官方文档《在模板中调用 data 里的函数》：
    // glass-easel 下仅 data 内的函数可在模板中调用）。
    // 原写法 {{formatTime(remaining)}} 求值为空 → 倒计时元素占位但无文字，
    // 实测截图中该区域空白（像素取证：元素间距存在、无任何深色字形）。
    remainingText: "",
    recordId: "",
    transcript: "",
    showEditor: false,
  },

  recorder: null as Recorder | null,
  timer: null as number | null,
  // 页面是否仍存活：上传/ASR/评估是长异步链，用户中途退出页面后
  // 链路仍会继续 setData → 触发「setData 到已销毁页面」的警告。
  alive: true,
  // 是否有 showModal 正在展示（2026-10-26 状态机核查新增）：
  // 录音错误可能来自多个来源，原实现会叠加弹窗。
  _modalOpen: false,
  // 「手动输入」降级路径是否已在执行（2026-10-26 状态机核查新增）：
  // createManualRecord 有三个入口（权限弹窗 / 两处错误弹窗），
  // 连点会创建多条练习记录，浪费配额。
  _manualPending: false,
  // 「确认并生成报告」是否已在提交（2026-10-26 状态机核查新增）：
  // 防重入，连点会并发跑两条 updateTranscript + analyze 链。
  _submitting: false,

  onLoad(query: Record<string, string>) {
    this.setData({
      scene: query.scene || "interview",
      question: decodeURIComponent(query.question || ""),
    });
    this.recorder = getRecorder();
  },

  onUnload() {
    this.alive = false;
    this.clearTimer();
    // 修复：页面卸载时若直接 stop()，会触发 recorder 的 onStop 回调，
    // 进而在页面销毁后 setData / 上传。改为先断开回调句柄、再停止物理录音，
    // 既不误触发页面逻辑，也能释放麦克风。
    this.recorder?.release();
    this.recorder = null;
  },

  onPickDuration(e: WechatMiniprogram.TouchEvent) {
    this.setData({ duration: Number(e.currentTarget.dataset.d) });
  },

  // ---- 录音控制 ----
  /**
   * 录音主按钮的统一入口：按当前 status 分派到 开始/暂停/继续。
   *
   * 修复（2026-10-26 状态机核查）：
   *   原实现用 `default: this.onStartRecord()` 兜底，而 default 会命中
   *   stopping / uploading / transcribing / analyzing / editing 五种状态。
   *   后果：在「上传录音中…」时点主按钮 → 重新走 onStartRecord →
   *   状态被强行改回 recording，而后台的 uploadAndSubmit / runAsr 异步链
   *   **仍在运行**，两者互相打架；更糟的是 runAsr 跑完还会 redirectTo
   *   强制把用户弹去结果页，用户完全失去控制。
   *   ⇒ 改为**白名单分派**：只有 idle 能开始录音，其余状态给出明确提示。
   */
  onRecordTap() {
    switch (this.data.status) {
      case "recording":
        this.onPause();
        break;
      case "paused":
        this.onResume();
        break;
      case "idle":
        this.onStartRecord();
        break;
      default:
        // 长任务进行中（stopping/uploading/transcribing/analyzing/editing）：
        // 只提示，不改变状态，不启动任何新的异步链。
        wx.showToast({ title: "正在处理中，请稍候", icon: "none" });
        break;
    }
  },

  async onStartRecord() {
    // 状态前置校验：只有 idle 允许开始录音。
    // 防止 await 期间用户已经触发了其它状态流转（详见 onRecordTap 注释）。
    if (this.data.status !== "idle") {
      wx.showToast({ title: "正在处理中，请稍候", icon: "none" });
      return;
    }
    if (!this.recorder) {
      wx.showToast({ title: "录音器未就绪，请重进页面", icon: "none" });
      return;
    }
    try {
      // 前置授权检查（详见 utils/privacy.ts 顶部注释）：
      // 用户曾明确拒绝过麦克风时，系统不再弹权限框，start() 会直接失败，
      // 用户只能干瞪眼。此处先拦下来并引导去设置页。
      // 「从未询问过」不拦截 —— 由系统在 start() 时自动弹权限框。
      const auth = await checkRecordAuth();
      if (!this.alive) return; // 页面已卸载
      // ★await 之后必须复查状态：await 期间用户可能已点了「结束作答」
      //   或状态已被别处改变。此时若继续 start()，会同时存在两个录音生命周期。
      if (this.data.status !== "idle") {
        wx.showToast({ title: "状态已变更，请稍候", icon: "none" });
        return;
      }
      if (auth === "denied") {
        this.promptOpenRecordSetting();
        return;
      }

      const durationSec = this.data.duration * 60;
      this.setData({ status: "recording", remaining: durationSec, remainingText: this.formatTime(durationSec) });
      this.startTimer();
      // 修复：必须传 onError —— 否则 recorder 内部把 onErrorCb 置 null，
      // 录音启动失败（如未授权麦克风）会完全静默，页面卡在「录音中」无任何提示。
      this.recorder.start(
        { durationSec, onError: (err: any) => this.onRecordError(err) },
        (res: StopPayload) => this.onRecordStop(res)
      );
    } catch (e: any) {
      if (!this.alive) return;
      // 修复（2026-10-26）：失败时必须把状态归位到 idle，
      // 否则页面停留在「录音中」但实际没有在录，倒计时还在走 —— 用户看到的是
      // 一个「假录音」，点「结束作答」也只会得到空文件。
      this.clearTimer();
      this.setData({ status: "idle", remaining: 0, remainingText: "" });
      wx.showToast({ title: errorText(e, "录音启动失败").slice(0, 20), icon: "none" });
    }
  },

  /** 引导用户去设置页开启麦克风权限 */
  promptOpenRecordSetting() {
    wx.showModal({
      title: "需要麦克风权限",
      content:
        "你之前拒绝了麦克风授权，系统不会再次自动弹窗。\n\n" +
        "可以前往设置页开启「录音」权限，也可以直接手动输入作答内容完成本轮评估。",
      confirmText: "去设置",
      cancelText: "手动输入",
      success: (res) => {
        if (res.cancel) {
          this.createManualRecord();
          return;
        }
        if (!res.confirm) return;
        openRecordSetting().then((state) => {
          if (!this.alive) return;
          if (state === "granted") {
            wx.showToast({ title: "已开启录音权限，请再次点击开始", icon: "none" });
          }
        });
      },
    });
  },

  /**
   * 录音不可用时的降级路径（2026-10-26 新增）。
   *
   * 背景：录音接口在「mp 后台未声明麦克风隐私类型」时会被平台直接禁用（errno 112），
   * 此时用户若没有第二条路，整个「出题 → 作答 → 报告」主链路就断了。
   * README「0 Key 也能跑通主链路（录音 → 人工输入转写 → 规则化评估 → 报告）」
   * 承诺的降级能力，在「麦克风完全不可用」时也必须成立。
   *
   * 实现：复用既有的 submitPractice → updateTranscript → analyze 链路，
   * 只跳过「上传音频」这一步（submitPractice 的 audioFileID 允许为空串）。
   * **不新增云函数、不改变既有业务流程**，成功路径完全不受影响。
   */
  async createManualRecord() {
    // 修复（2026-10-26 状态机核查）：本方法有三个入口
    // （权限弹窗的「手动输入」+ 两处错误弹窗的「手动输入」）。
    // 连点会并发调用 submitPractice → 创建多条练习记录、白白消耗配额。
    if (this._manualPending) return;
    this._manualPending = true;
    try {
      const { recordId } = await submitPractice({
        scene: this.data.scene,
        questionText: this.data.question,
        audioFileID: "",
        durationSec: 0,
      });
      if (!this.alive) return; // 页面已卸载
      this.setData({
        recordId,
        status: "editing",
        showEditor: true,
        remaining: 0,
        remainingText: "",
      });
      wx.showToast({ title: "请输入你的作答内容", icon: "none" });
    } catch (e: any) {
      if (!this.alive) return; // 页面已卸载
      showCallError(e, "创建记录失败");
    } finally {
      this._manualPending = false;
    }
  },

  onPause() {
    if (!this.recorder) return;
    if (this.data.status !== "recording") return;
    // 修复（2026-10-26 状态机核查）：pause() 在真机上偶发抛异常
    // （如录音器已被系统释放）。原实现直接调 → 异常冒泡到事件处理器，
    // 页面状态仍停在 recording，但实际已不再录音 → 倒计时还在走，用户以为在录。
    try {
      this.recorder.pause();
    } catch (e: any) {
      wx.showToast({ title: "暂停失败，请重试", icon: "none" });
      return;
    }
    this.clearTimer();
    this.setData({ status: "paused" });
  },

  onResume() {
    if (!this.recorder) return;
    if (this.data.status !== "paused") return;
    try {
      this.recorder.resume();
    } catch (e: any) {
      wx.showToast({ title: "继续录音失败，请重试", icon: "none" });
      return;
    }
    this.setData({ status: "recording" });
    this.startTimer();
  },

  onStop() {
    // 防重复触发：进入停止流程后立刻置位，避免用户连点导致多次 stop
    if (this.data.status !== "recording" && this.data.status !== "paused") return;
    this.setData({ status: "stopping" });
    if (!this.recorder) {
      // 录音器已被释放（页面正在卸载）：直接回退，避免卡在 stopping
      this.setData({ status: "idle", remaining: 0, remainingText: "" });
      return;
    }
    // 修复（2026-10-26 状态机核查）：
    //   原实现直接调 this.recorder.stop()，既不判返回值也不接异常：
    //   ① recorder.stop() 返回 false（从未开始录音）→ 不会有 onStop 回调
    //      → 页面永久卡在「正在结束录音…」，用户以为程序死了；
    //   ② recorder.stop() 内部抛异常 → 同样没有任何回调，状态永远停在 stopping。
    //   ⇒ 现在：判返回值 + 接异常，两者都把状态归位到 idle 并给出可操作提示。
    let accepted = false;
    try {
      accepted = this.recorder.stop();
    } catch (e: any) {
      accepted = false;
    }
    if (!accepted) {
      this.clearTimer();
      this.setData({ status: "idle", remaining: 0, remainingText: "" });
      wx.showToast({ title: "录音未开始，请重试", icon: "none" });
    }
  },

  /** 录音启动/过程失败：给出可见提示并回到可重录状态，不再静默卡死 */
  onRecordError(err: any) {
    // 修复（2026-10-26 状态机核查）：错误可能来自多个来源
    // （recorder.onError + 停止看门狗 + 权限拒绝后的二次失败），
    // 原实现每次都弹 showModal → 多个 modal 叠加，用户看到的是一串
    // 无法关闭的弹窗，且「手动输入」按钮被点多次会创建多条练习记录。
    // ⇒ 加一个「弹窗占用」闸门：已有弹窗在展示时，后续错误只更新状态、不再弹窗。
    if (this._modalOpen) return;
    this.clearTimer();
    // 修复（2026-10-26 errno 112）：原先直接 toast 原始英文 errMsg 并 slice(0,30)，
    // 用户看到的是「startfail api scope is not de」这种截断的英文，完全不知道
    // 发生了什么、也不知道该做什么。现在按成因翻译成中文并给出对应处置路径：
    //   · 后台未声明麦克风隐私类型（errno 112）→ showModal 给出后台配置路径
    //   · 用户拒绝过麦克风授权 → showModal 引导去设置页
    //   · 未同意隐私协议 → showModal 提示去同意
    const info = describeRecorderError(err);
    if (this.alive) this.setData({ status: "idle", remaining: 0, remainingText: "" });

    if (info.needOpenSetting) {
      this._modalOpen = true;
      wx.showModal({
        title: info.title,
        content: info.detail + "\n\n也可以直接手动输入作答内容，完成本轮评估。",
        confirmText: "去设置",
        cancelText: "手动输入",
        success: (res) => {
          if (res.cancel) {
            this.createManualRecord();
            return;
          }
          if (!res.confirm) return;
          openRecordSetting().then((state) => {
            if (!this.alive) return;
            if (state === "granted") {
              wx.showToast({ title: "已开启录音权限，请再次点击开始", icon: "none" });
            }
          });
        },
        complete: () => {
          this._modalOpen = false;
        },
      });
      return;
    }

    if (
      info.kind === "privacy_not_declared" ||
      info.kind === "privacy_not_agreed" ||
      info.kind === "system_forbidden"
    ) {
      // 平台配置 / 协议 / 系统层问题：toast 放不下完整说明，用 modal。
      // 「手动输入」是唯一的替代出路 —— 必须给，否则用户被彻底卡死。
      this._modalOpen = true;
      wx.showModal({
        title: info.title,
        content: info.detail + "\n\n你也可以直接手动输入作答内容，完成本轮评估。",
        confirmText: "手动输入",
        cancelText: "关闭",
        success: (res) => {
          if (res.confirm) this.createManualRecord();
        },
        complete: () => {
          this._modalOpen = false;
        },
      });
      return;
    }

    wx.showToast({ title: info.userMessage.slice(0, 30), icon: "none" });
  },

  onRecordStop(res: StopPayload) {
    this.clearTimer();
    // 修复（2026-10-26 状态机核查）：原实现没有 alive 检查。
    // 页面卸载后若迟到的 onStop 到达，仍会 setData + 启动整条上传/识别/评估链
    // → 「setData 到已销毁页面」告警 + 后台白白跑一遍云函数。
    if (!this.alive) return;
    // 看门狗兜底：stop() 后 onStop 回调丢失（模拟器高频复现），
    // tempFilePath 为空且 timedOut=true。此时不能继续上传，
    // 必须给出明确提示并允许用户重试，否则表现为「点了没反应」。
    if (res.timedOut || !res.tempFilePath) {
      wx.showToast({ title: "录音未正常结束，请重试", icon: "none" });
      this.setData({ status: "idle", remaining: 0, remainingText: "" });
      return;
    }
    this.setData({ status: "uploading" });
    this.uploadAndSubmit(res.tempFilePath, res.duration);
  },

  // ---- 上传 + 提交 ----
  async uploadAndSubmit(filePath: string, durationSec: number) {
    wx.showLoading({ title: "上传录音" });
    try {
      // 先请求订阅授权（必须在提交前——用户授权在前，finalize 推送在后；
      // 未配置模板 ID 或用户拒绝时静默跳过，不影响主流程）
      await requestSubscribe();
      // cloudPath 加随机后缀防同毫秒并发覆盖（时间戳仅毫秒精度，多用户可碰撞）
      const suffix = Math.random().toString(36).slice(2, 8);
      const upload = await wx.cloud.uploadFile({
        cloudPath: `audio/${Date.now()}-${suffix}.mp3`,
        filePath,
      });
      const { recordId } = await submitPractice({
        scene: this.data.scene,
        questionText: this.data.question,
        audioFileID: upload.fileID,
        durationSec,
      });
      if (!this.alive) return; // 页面已卸载，不再 setData / 推进状态机
      this.setData({ recordId });
      wx.hideLoading();
      await this.runAsr(recordId);
    } catch (e: any) {
      wx.hideLoading();
      if (!this.alive) return; // 页面已卸载，避免向已销毁页面 setData
      // 修复：原先只 setData({status:"idle"})，remaining / remainingText 仍保留
      // 录音结束时的残值，重新开始录音前会短暂显示错误的倒计时。
      // 修复（2026-10-26）：原先 toast 只取 e?.message —— 微信云错误的
      // message 恰好是 "cloud.callFunction"，真正原因（errMsg）被整个丢掉，
      // 用户只看到一句毫无意义的话。改走 showCallError（统一呈现 + 必要时弹指引）。
      showCallError(e, "上传失败");
      this.setData({ status: "idle", remaining: 0, remainingText: "" });
    }
  },

  // ---- ASR → （人工修正）→ 评估 ----
  //
  // 修复（审计 B-04）：ASR 云函数改为两段式，未识别完时返回 status="asr_running"。
  // 客户端需要续查（服务端复用 TaskId，不会重复计费），并采用指数退避减少无效调用。
  async runAsr(recordId: string) {
    // 修复（2026-10-26 状态机核查）：开头补 alive 守卫
    // （页面可能在 uploadAndSubmit 的 await 期间已被销毁）。
    if (!this.alive) return;
    wx.showLoading({ title: "语音识别中" });
    let res: any = null;
    let waitMs = 2000;
    // 修复：原先 ASR 期间 status 一直停留在 "uploading"，
    // 页面文案始终显示「上传录音中…」，与实际阶段不符（transcribing 是死状态）。
    this.setData({ status: "transcribing" });

    try {
      for (let i = 0; i < 8; i++) {
        // 修复（2026-10-26 状态机核查）：循环内原先不查 alive。
        // 页面卸载后循环仍会继续调云函数（最多 8 次）→ 白烧配额，
        // 且每轮都会触发一次 errMsg 报错刷屏。
        if (!this.alive) return;
        // 改用 callChecked：云函数返回 { error } 时立即抛出，
        // 原实现用 callFn + 手工判断，两处判断不一致易漏。
        res = await callChecked("asr", { recordId });
        if (res.status !== "asr_running") break;
        // 尚未完成：退避后重试（2s → 2.5s → 3.2s … 上限 5s）
        await new Promise((r) => setTimeout(r, waitMs));
        waitMs = Math.min(5000, Math.round(waitMs * 1.25));
      }
    } catch (e: any) {
      wx.hideLoading();
      if (!this.alive) return; // 页面已卸载
      showCallError(e, "识别失败，可手动输入");
      this.setData({ status: "editing", showEditor: true });
      return;
    }

    wx.hideLoading();
    if (!this.alive) return; // 页面已卸载
    if (!res || res.status === "asr_running") {
      wx.showToast({ title: "识别超时，可手动输入", icon: "none" });
      this.setData({ status: "editing", transcript: (res && res.transcript) || "", showEditor: true });
      return;
    }
    if (res.needManual || !res.transcript) {
      this.setData({ status: "editing", transcript: res.transcript || "", showEditor: true });
    } else {
      await this.runAnalyze(recordId);
    }
  },

  onTranscriptInput(e: WechatMiniprogram.Input) {
    this.setData({ transcript: e.detail.value });
  },

  async onConfirmTranscript() {
    // 修复：空文本提交会让 updateTranscript 写空串、analyze 报「转写文本为空」，
    // 用户只看到一句服务端错误。客户端先拦一道，给出可理解的提示。
    if (!this.data.transcript || !this.data.transcript.trim()) {
      wx.showToast({ title: "请先输入作答内容", icon: "none" });
      return;
    }
    // 修复（2026-10-26 状态机核查）：状态前置校验。
    // 只有 editing 态允许提交。若在 analyzing / transcribing 时重复触发，
    // 会并发跑两条 updateTranscript + analyze 链，云函数被调两次、
    // 配额双扣，且两次 redirectTo 抢跳。
    if (this.data.status !== "editing") {
      wx.showToast({ title: "正在处理中，请稍候", icon: "none" });
      return;
    }
    // 修复（2026-10-26 状态机核查）：防重入。
    // 原实现没有闸门，连点「确认并生成报告」会并发提交。
    if (this._submitting) return;
    this._submitting = true;
    // 修复：原先没有 try/catch，updateTranscript 失败（如无权限 / 记录不存在）
    // 会产生未捕获的 Promise 拒绝，控制台报错且用户没有任何提示，
    // 页面停留在编辑态无法继续。
    wx.showLoading({ title: "重新评估中" });
    try {
      await callChecked("updateTranscript", {
        recordId: this.data.recordId,
        transcript: this.data.transcript,
      });
      wx.hideLoading();
      await this.runAnalyze(this.data.recordId);
    } catch (e: any) {
      wx.hideLoading();
      if (!this.alive) return; // 页面已卸载
      // 修复（2026-10-26）：原先只取 e?.message → 微信云错误里 message 是
      // "cloud.callFunction"，真实原因（errMsg）被丢弃，用户无从判断是
      // 「云函数没部署」还是「内容安全权限还在 10 分钟缓存期」。
      showCallError(e, "提交失败");
    } finally {
      this._submitting = false;
    }
  },

  async runAnalyze(recordId: string) {
    // 修复（2026-10-26 状态机核查）：开头补 alive 守卫。
    // 原实现直接 setData({status:"analyzing"})，而本方法有两个调用方
    // （runAsr 的成功分支、onConfirmTranscript）——前者在 await 之后才调本方法，
    // 用户可能已退出页面 → setData 到已销毁页面。
    if (!this.alive) return;
    wx.showLoading({ title: "AI 评估中" });
    // 修复：新增 analyzing 状态，让处理中区块能区分「语音识别」与「AI 评估」
    this.setData({ status: "analyzing" });
    try {
      // 修复：原先用 callFn，未检查 { error } 返回 →
      // 评估失败（未登录 / 配额超限 / 无权限）也会跳转结果页，
      // 用户看到空白报告页且不知原因。改用 callChecked 抛出真实错误。
      await callChecked("analyze", { recordId });
      // 订阅消息是**非阻塞的增强功能**：报告此刻已生成完毕，推送失败不影响用户。
      // 用 quiet 模式 → 失败只 warn，不在 Console 打红色 error（避免被误读为功能失败）。
      // 云函数侧也已把「用户拒绝授权」识别为正常分支并返回 ok:true。
      call("finalize", { recordId }, { quiet: true }).catch(() => {});
      wx.hideLoading();
      if (!this.alive) return; // 页面已卸载，不再跳转
      // 修复（2026-10-26 状态机核查）：原实现只传了 url，没有 fail 回调。
      // 跳转失败（页面栈满 / 路由不存在 / 参数非法）时没有任何兜底 →
      // 页面永久停在「AI 评估中…」，而数据其实已经算好了，用户却看不到报告。
      // ⇒ 补 fail：归位到 editing，用户可改文本重试，或直接用小程序返回手势回退。
      wx.redirectTo({
        url: `/pages/result/result?recordId=${recordId}`,
        fail: () => {
          if (!this.alive) return;
          wx.showToast({ title: "结果页打开失败，请重试", icon: "none" });
          this.setData({ status: "editing", showEditor: true });
        },
      });
    } catch (e: any) {
      wx.hideLoading();
      if (!this.alive) return; // 页面已卸载
      // 修复（2026-10-26）：同 onConfirmTranscript —— e?.message 拿不到真实原因。
      showCallError(e, "评估失败");
      // 评估失败时回到可编辑态，让用户能改转写后重试，而不是卡在 transcribing
      this.setData({ status: "editing", showEditor: true });
    }
  },

  // ---- 计时器 ----
  startTimer() {
    this.clearTimer();
    this.timer = setInterval(() => {
      const r = this.data.remaining - 1;
      if (r <= 0) {
        this.clearTimer();
        // 超时自动结束：与手动「结束作答」走同一条路径（置 stopping → stop → onStop），
        // 避免两条路径状态表现不一致。recorder.stop() 内部有 stopping 守卫，
        // 与其内部计时器的自动 stop 不会重复调用。
        if (this.data.status === "recording" || this.data.status === "paused") {
          this.setData({ status: "stopping" });
          // 修复（2026-10-26 状态机核查）：与 onStop 同样要判返回值 + 接异常。
          // 否则 stop() 返回 false（从未开始）或抛异常时，
          // 页面会永久停在「正在结束录音…」，倒计时已归零，用户完全无从下手。
          let accepted = false;
          try {
            accepted = this.recorder ? this.recorder.stop() : false;
          } catch (_) {
            accepted = false;
          }
          if (!accepted) {
            this.setData({ status: "idle", remaining: 0, remainingText: "" });
            wx.showToast({ title: "录音未开始，请重试", icon: "none" });
          }
        }
      } else {
        this.setData({ remaining: r, remainingText: this.formatTime(r) });
      }
    }, 1000) as unknown as number;
  },

  clearTimer() {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  },

  formatTime(sec: number): string {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${s < 10 ? "0" + s : s}`;
  },
});
