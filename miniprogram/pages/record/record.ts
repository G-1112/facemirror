// 录音作答页（FR-04/05/06）：录音 → 上传 → ASR → （人工修正）→ 评估 → 报告
import { getRecorder, Recorder } from "../../utils/recorder";
import { submitPractice } from "../../utils/api";

function callFn(name: string, data: Record<string, any> = {}) {
  return wx.cloud.callFunction({ name, data }).then((r) => r.result as any);
}

Page({
  data: {
    scene: "interview",
    question: "",
    durationOptions: [1, 3, 5],
    duration: 3,
    status: "idle", // idle | recording | paused | uploading | transcribing | editing
    remaining: 0,
    recordId: "",
    transcript: "",
    showEditor: false,
  },

  recorder: null as Recorder | null,
  timer: null as number | null,

  onLoad(query: Record<string, string>) {
    this.setData({
      scene: query.scene || "interview",
      question: decodeURIComponent(query.question || ""),
    });
    this.recorder = getRecorder();
  },

  onUnload() {
    this.clearTimer();
    this.recorder?.stop();
  },

  onPickDuration(e: WechatMiniprogram.TouchEvent) {
    this.setData({ duration: Number(e.currentTarget.dataset.d) });
  },

  // ---- 录音控制 ----
  onStartRecord() {
    if (!this.recorder) return;
    const durationSec = this.data.duration * 60;
    this.setData({ status: "recording", remaining: durationSec });
    this.startTimer();
    this.recorder.start({ durationSec }, (res) => this.onRecordStop(res));
  },

  onPause() {
    this.recorder?.pause();
    this.clearTimer();
    this.setData({ status: "paused" });
  },

  onResume() {
    this.recorder?.resume();
    this.setData({ status: "recording" });
    this.startTimer();
  },

  onStop() {
    this.recorder?.stop();
  },

  onRecordStop(res: { tempFilePath: string; duration: number }) {
    this.clearTimer();
    this.setData({ status: "uploading" });
    this.uploadAndSubmit(res.tempFilePath, res.duration);
  },

  // ---- 上传 + 提交 ----
  async uploadAndSubmit(filePath: string, durationSec: number) {
    wx.showLoading({ title: "上传录音" });
    try {
      const upload = await wx.cloud.uploadFile({
        cloudPath: `audio/${Date.now()}.mp3`,
        filePath,
      });
      const { recordId } = await submitPractice({
        scene: this.data.scene,
        questionText: this.data.question,
        audioFileID: upload.fileID,
        durationSec,
      });
      this.setData({ recordId });
      wx.hideLoading();
      await this.runAsr(recordId);
    } catch (e) {
      wx.hideLoading();
      wx.showToast({ title: "上传失败", icon: "none" });
      this.setData({ status: "idle" });
    }
  },

  // ---- ASR → （人工修正）→ 评估 ----
  //
  // 修复（审计 B-04）：ASR 云函数改为两段式，未识别完时返回 status="asr_running"。
  // 客户端需要续查（服务端复用 TaskId，不会重复计费），并采用指数退避减少无效调用。
  async runAsr(recordId: string) {
    wx.showLoading({ title: "语音识别中" });
    let res: any = null;
    let waitMs = 2000;

    try {
      for (let i = 0; i < 8; i++) {
        res = await callFn("asr", { recordId });
        if (res && res.error) throw new Error(res.error);
        if (res && res.status !== "asr_running") break;
        // 尚未完成：退避后重试（2s → 2.5s → 3.2s … 上限 5s）
        await new Promise((r) => setTimeout(r, waitMs));
        waitMs = Math.min(5000, Math.round(waitMs * 1.25));
      }
    } catch (e: any) {
      wx.hideLoading();
      wx.showToast({ title: e.message || "识别失败，可手动输入", icon: "none" });
      this.setData({ status: "editing", showEditor: true });
      return;
    }

    wx.hideLoading();
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
    await callFn("updateTranscript", {
      recordId: this.data.recordId,
      transcript: this.data.transcript,
    });
    await this.runAnalyze(this.data.recordId);
  },

  async runAnalyze(recordId: string) {
    wx.showLoading({ title: "AI 评估中" });
    try {
      await callFn("analyze", { recordId });
      callFn("finalize", { recordId }).catch(() => {}); // 订阅消息，非阻塞
      wx.hideLoading();
      wx.redirectTo({ url: `/pages/result/result?recordId=${recordId}` });
    } catch (e: any) {
      wx.hideLoading();
      wx.showToast({ title: e.message || "评估失败", icon: "none" });
    }
  },

  // ---- 计时器 ----
  startTimer() {
    this.clearTimer();
    this.timer = setInterval(() => {
      const r = this.data.remaining - 1;
      if (r <= 0) {
        this.clearTimer();
        this.recorder?.stop();
      } else {
        this.setData({ remaining: r });
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
