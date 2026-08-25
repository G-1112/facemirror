/**
 * 录音封装（FR-04）：wx.getRecorderManager 包装，输出 mp3，支持暂停/重录/限时。
 */

export interface RecorderOptions {
  durationSec: number;
  onTimeUp?: () => void;
  onError?: (err: any) => void;
}

export class Recorder {
  private manager: WechatMiniprogram.RecorderManager;
  private timer: number | null = null;

  constructor() {
    this.manager = wx.getRecorderManager();
  }

  start(opts: RecorderOptions, onStop: (res: { tempFilePath: string; duration: number }) => void) {
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
      this.manager.stop();
    }, opts.durationSec * 1000) as unknown as number;

    this.manager.onStop((res) => {
      this.clearTimer();
      onStop({ tempFilePath: res.tempFilePath, duration: Math.round(res.duration / 1000) });
    });

    this.manager.onError((err) => {
      this.clearTimer();
      opts.onError?.(err);
    });
  }

  pause() {
    this.manager.pause();
  }

  resume() {
    this.manager.resume();
  }

  stop() {
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
