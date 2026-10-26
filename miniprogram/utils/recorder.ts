/**
 * 录音封装（FR-04）：wx.getRecorderManager 包装，输出 mp3，支持暂停/重录/限时。
 *
 * 修复（真机实测 2026-09-30）：
 * 1. 暂停状态下直接调用 manager.stop()，在部分真机上不触发 onStop 回调，
 *    导致「暂停 → 结束作答」无响应。修法：暂停态先 resume() 再 stop()
 *    （resume 后立即 stop 不会丢失已录内容）。
 * 2. onStop/onError 原先在每次 start() 里重复注册，回调会叠加导致
 *    一次停止触发多次上传。改为构造时注册一次，回调通过成员字段切换。
 *
 * 修复（开发者工具模拟器「结束作答」点击无响应，2026-10-26）：
 * 3. 微信官方社区长期反馈：`recorderManager.stop()` 有概率不触发 `onStop`
 *    （模拟器上尤其明显，「模拟器上就三四下就不触发了」）。
 *    原实现完全依赖 onStop 回调推进状态机，一旦该回调不来，
 *    页面既不上传也不提示，表现为「点了没反应」。
 *    修法：stop() 增加看门狗超时（STOP_WATCHDOG_MS），超时后主动
 *    走 onStop 兜底回调（tempFilePath 为空），由页面给出明确提示，
 *    保证「一定有反馈」而不是静默卡死。
 * 4. onStop/onError 回调改为「先取用再置空」，避免回调被提前清空导致
 *    页面侧拿不到句柄（此前 onStopCb 与 onErrorCb 都会被置 null）。
 * 5. start() 暴露 onError 的同时，记录当前是否已成功进入录音，
 *    便于 stop 兜底时区分「从未开始」与「已开始但回调丢失」。
 */

export interface RecorderOptions {
  durationSec: number;
  onTimeUp?: () => void;
  onError?: (err: any) => void;
}

/** stop() 后等待 onStop 回调的最长时间（毫秒）。
 *  超时即视为「停止回调丢失」，触发兜底，避免页面永久静默。 */
const STOP_WATCHDOG_MS = 1200;

export type StopPayload = {
  tempFilePath: string;
  duration: number;
  /** true 表示这是看门狗兜底触发：录音实际未正常结束（tempFilePath 为空） */
  timedOut?: boolean;
};

export class Recorder {
  private manager: WechatMiniprogram.RecorderManager;
  private timer: number | null = null;
  private watchdog: number | null = null;
  private paused = false;
  private started = false;
  /** 是否已发起 stop 且尚未收到 onStop —— 用于阻止重复 stop */
  private stopping = false;
  private onStopCb: ((res: StopPayload) => void) | null = null;
  private onErrorCb: ((err: any) => void) | null = null;

  constructor() {
    this.manager = wx.getRecorderManager();
    // 只注册一次，避免 start() 重复注册导致回调叠加
    this.manager.onStop((res) => {
      this.clearTimer();
      this.clearWatchdog();
      this.paused = false;
      this.started = false;
      this.stopping = false;
      // 先取用再置空：保证回调句柄可用
      const cb = this.onStopCb;
      this.onStopCb = null;
      cb?.({
        tempFilePath: res.tempFilePath,
        duration: Math.round((res.duration || 0) / 1000),
      });
    });
    this.manager.onError((err) => {
      this.clearTimer();
      this.clearWatchdog();
      this.paused = false;
      this.started = false;
      this.stopping = false;
      const cb = this.onErrorCb;
      this.onErrorCb = null;
      cb?.(err);
    });
  }

  start(opts: RecorderOptions, onStop: (res: StopPayload) => void) {
    // 修复（2026-10-26 状态机核查）：原实现直接覆盖 this.timer，
    // 连点「开始作答」触发两次 start() 时，前一次的时长定时器会泄漏——
    // 旧定时器到点后触发 onTimeUp + this.stop()，导致刚开的录音被提前掐断。
    // 同时清掉看门狗，避免上一轮停止流程的兜底回调打到新一轮录音上。
    this.clearTimer();
    this.clearWatchdog();
    this.onStopCb = onStop;
    this.onErrorCb = opts.onError || null;
    this.paused = false;
    this.started = true;

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

  /**
   * 停止录音。
   *
   * 返回值语义（2026-10-26 状态机核查新增）：
   *   true  = 已发起停止流程（页面可以进入 stopping 态并等待 onStop 回调）
   *   false = **没有**发起停止（从未开始 / 已在停止流程中）→ 页面必须自行归位，
   *           否则会永久卡在「正在结束录音…」。
   *
   * 修复（关键顺序问题）：
   *   原实现是 `this.manager.stop();` 之后才 setTimeout 装看门狗。
   *   而 manager.stop() 在「已停止 / 状态异常」时会**同步抛异常**，
   *   一旦抛出，后面的看门狗代码根本不会执行 → onStop 回调永远不来 →
   *   页面卡死在 stopping 态（用户表现：点了「结束作答」没反应）。
   *   现在改为：先装看门狗，再调 manager.stop()，且整个调用包 try/catch。
   */
  stop(): boolean {
    // ⚠️ 顺序很重要：先判 stopping。
    // 停止流程已在进行中 → onStop 回调**仍会来**（或看门狗会兜底）→ 视为「已发起」，
    // 调用方不应自行归位状态，否则会与随后到达的 onStop 抢状态。
    if (this.stopping) return true;
    // 从未开始录音 → 不会有任何回调 → 调用方必须自行归位，
    // 否则页面会永久卡在「正在结束录音…」。
    if (!this.started) return false;
    // 修复：暂停态直接 stop 在部分真机上不触发 onStop —— 先 resume 再 stop
    if (this.paused) {
      this.paused = false;
      try {
        this.manager.resume();
      } catch (_) {
        // resume 失败不阻断后续 stop
      }
    }
    this.stopping = true;
    // ⚠️ 看门狗必须**先于** manager.stop() 安装：
    // manager.stop() 可能同步抛异常，抛了就永远没有兜底回调。
    this.clearWatchdog();
    this.watchdog = setTimeout(() => {
      this.watchdog = null;
      const cb = this.onStopCb;
      this.onStopCb = null;
      this.started = false;
      this.stopping = false;
      // 兜底后仍要确保物理录音被释放：onStop 回调虽未按时到达，
      // 但录音器多半仍在录音中。若不补一次 stop，麦克风会一直被占用，
      // 且后续因 started=false 守卫也无法再调 stop() 释放。
      try {
        this.manager.stop();
      } catch (_) {
        // 已停止或状态异常时忽略
      }
      cb?.({ tempFilePath: "", duration: 0, timedOut: true });
    }, STOP_WATCHDOG_MS) as unknown as number;

    try {
      this.manager.stop();
    } catch (_) {
      // manager.stop() 同步抛异常（"audio is stop" 等）→ 不再等待 onStop，
      // 直接走兜底：立刻触发一次超时回调，让页面回到可重试状态。
      this.clearWatchdog();
      this.watchdog = null;
      this.started = false;
      this.stopping = false;
      const cb = this.onStopCb;
      this.onStopCb = null;
      cb?.({ tempFilePath: "", duration: 0, timedOut: true });
    }
    return true;
  }

  private clearTimer() {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private clearWatchdog() {
    if (this.watchdog !== null) {
      clearTimeout(this.watchdog);
      this.watchdog = null;
    }
  }

  /** 页面卸载时释放录音器。
   *  1. 先断开回调句柄：Recorder 是模块级单例，页面卸载后若仍留着 onStopCb，
   *     迟到的 onStop 会回调到已销毁的页面（setData 报错 / 误触发上传）。
   *  2. 再停止物理录音释放麦克风；仅在确实处于录音态时才调 stop()，
   *     否则会触发 "audio is stop" 错误。
   *  3. 不断开 manager 上的 onStop/onError 监听——它们在构造时注册一次，
   *     供后续页面复用；断开后本单例将永久失效。 */
  release() {
    const needStop = this.started && !this.stopping;
    this.clearTimer();
    this.clearWatchdog();
    this.onStopCb = null;
    this.onErrorCb = null;
    this.paused = false;
    this.started = false;
    this.stopping = false;
    if (needStop) {
      try {
        this.manager.stop();
      } catch (_) {
        // 停止失败不影响页面卸载
      }
    }
  }
}

let _recorder: Recorder | null = null;
export function getRecorder(): Recorder {
  if (!_recorder) _recorder = new Recorder();
  return _recorder;
}
