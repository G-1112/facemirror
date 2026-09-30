/**
 * 录音封装（FR-04）：wx.getRecorderManager 包装，输出 mp3，支持暂停/重录/限时。
 *
 * 修复（真机实测 2026-09-30）：
 * 1. 暂停状态下直接调用 manager.stop()，在部分真机上不触发 onStop 回调，
 *    导致「暂停 → 结束作答」无响应。修法：暂停态先 resume() 再 stop()
 *    （resume 后立即 stop 不会丢失已录内容）。
 * 2. onStop/onError 原先在每次 start() 里重复注册，回调会叠加导致
 *    一次停止触发多次上传。改为构造时注册一次，回调通过成员字段切换。
 */

export interface RecorderOptions {
  durationSec: number;
  onTimeUp?: () => void;
  onError?: (err: any) => void;
}

type StopPayload = { tempFilePath: string; duration: number };

export class Recorder {
  private manager: WechatMiniprogram.RecorderManager;
  private timer: number | null = null;
  private paused = false;
  private onStopCb: ((res: StopPayload) => void) | null = null;
  private onErrorCb: ((err: any) => void) | null = null;

  constructor() {
    this.manager = wx.getRecorderManager();
    // 只注册一次，避免 start() 重复注册导致回调叠加
    this.manager.onStop((res) => {
      this.clearTimer();
      this.paused = false;
      const cb = this.onStopCb;
      this.onStopCb = null;
      cb?.({
        tempFilePath: res.tempFilePath,
        duration: Math.round((res.duration || 0) / 1000),
      });
    });
    this.manager.onError((err) => {
      this.clearTimer();
      this.paused = false;
      const cb = this.onErrorCb;
      this.onErrorCb = null;
      cb?.(err);
    });
  }

  start(opts: RecorderOptions, onStop: (res: StopPayload) => void) {
    this.onStopCb = onStop;
    this.onErrorCb = opts.onError || null;
    this.paused = false;

    this.manager.start({
      duration: opts.durationSec * 1000, // 最长录音时长
      format: "mp3",
      sampleRate: 16000,
      numberOfChannels: 1,
      encodeBitRate: 48000,
    });

    // 计时器 + 到达时限自动停止
    this.timer = setTimeout(() => {
      opts.onTimeUp?.();
      this.stop();
    }, opts.durationSec * 1000) as unknown as number;
  }

  pause() {
    this.paused = true;
    this.manager.pause();
  }

  resume() {
    this.paused = false;
    this.manager.resume();
  }

  stop() {
    // 修复：暂停态直接 stop 在部分真机上不触发 onStop —— 先 resume 再 stop
    if (this.paused) {
      this.paused = false;
      this.manager.resume();
    }
    this.manager.stop();
  }

  private clearTimer() {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

let _recorder: Recorder | null = null;
export function getRecorder(): Recorder {
  if (!_recorder) _recorder = new Recorder();
  return _recorder;
}
