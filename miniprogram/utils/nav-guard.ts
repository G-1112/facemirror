/**
 * 导航防重入守卫（Navigation Guard）。
 *
 * ## 为什么需要它
 *
 * 2026-10-26 连续两次线上事故，同一个根因家族：
 *   ① 出题页「题目永远加载中…」—— `loading` 置 true 后只有唯一一条路径能置回 false；
 *   ② 首页「开始练习按钮点不动」—— `navigating` 置 true 后只靠 `wx.navigateTo`
 *      的 success/fail 回调复位，回调不来就**永久锁死**：
 *      WXML 的 `disabled="{{navigating}}"` 让按钮变灰，
 *      JS 的 `if (this.data.navigating) return;` 把点击吞掉。
 *
 * ## 三条铁律
 *
 * 1. **锁用时间戳判定有效期，天然自动过期** —— 无论外部回调是否回来，
 *    窗口到期后锁自动失效，**永不永久卡死**。
 * 2. **不用 `disabled` 属性做闸门** —— `disabled` 会同时禁用控件**并**阻断
 *    `bindtap`，把任何状态异常放大成「永久不可用」。
 *    正确做法：按钮**永不禁用**，防重入由本守卫在 JS 层拦截，
 *    并对用户给出**明确反馈**（toast / modal），而不是让按钮默默变灰。
 * 3. **锁状态只驱动视觉态**（半透明 / 文案变化），**绝不驱动可点性**。
 *
 * @example
 *   // Page 生命周期里创建一次
 *   this._guard = createNavGuard({
 *     onLockChange: (locked) => { if (this.alive) this.setData({ navigating: locked }); },
 *   });
 *   // 业务入口
 *   if (!this._guard.tryLock()) return;   // 窗口内 → 忽略连点
 *   wx.navigateTo({ url, success: () => this._guard.unlock(), fail: () => this._guard.unlock() });
 *   // onUnload 里
 *   this._guard.dispose();
 */

/** 防重入窗口默认时长（毫秒）。超过即自动失效。 */
export const NAV_GUARD_WINDOW_MS = 3000;

export interface NavGuard {
  /**
   * 尝试进入防重入窗口。
   * @returns true = 本次调用应当继续执行；false = 窗口内，应忽略本次连点。
   */
  tryLock(): boolean;
  /** 立即退出防重入窗口（跳转成功/失败、页面回到前台时调用）。 */
  unlock(): void;
  /** 清理内部定时器。**页面卸载时必须调用**，否则看门狗会在页面销毁后触发回调。 */
  dispose(): void;
}

export interface NavGuardOptions {
  /** 防重入窗口时长（毫秒），默认 3000。 */
  windowMs?: number;
  /** 锁状态变化回调，用于驱动 UI 视觉态。 */
  onLockChange?: (locked: boolean) => void;
  /** 时钟源（默认 `Date.now`）。注入可控时钟是为了让回归测试无需真实等待。 */
  now?: () => number;
}

export function createNavGuard(options?: NavGuardOptions): NavGuard {
  const windowMs = options?.windowMs ?? NAV_GUARD_WINDOW_MS;
  const onLockChange = options?.onLockChange;
  const now = options?.now ?? (() => Date.now());

  /** 进入窗口的时刻；0 = 当前未加锁。 */
  let lockedAt = 0;
  /** 看门狗句柄：即使外部回调不来，窗口到期也会自动解锁。 */
  let timer: any = null;

  const clearTimer = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const unlock = () => {
    lockedAt = 0;
    clearTimer();
    if (onLockChange) onLockChange(false);
  };

  const tryLock = (): boolean => {
    const t = now();
    // 窗口内 → 拒绝（连点保护）
    if (lockedAt !== 0 && t - lockedAt < windowMs) return false;
    // 窗口已过期（或从未加锁）→ 进入新窗口
    lockedAt = t;
    clearTimer();
    // 看门狗兜底：外部回调不来时，窗口到期自动解锁
    timer = setTimeout(() => {
      timer = null;
      unlock();
    }, windowMs);
    if (onLockChange) onLockChange(true);
    return true;
  };

  return {
    tryLock,
    unlock,
    dispose() {
      // 只清定时器，不动 lockedAt / 不回调 onLockChange：
      // 页面已销毁，再 setData 会触发「setData 到已销毁页面」告警。
      clearTimer();
    },
  };
}
