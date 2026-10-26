/**
 * 录音隐私协议与麦克风授权（2026-10-26 新增）
 *
 * ── 背景（errno 112 事故复盘）──────────────────────────────────────────
 * 开发者工具里点「开始作答」报：
 *   `start:fail api scope is not declared in the privacy agreement`
 * 官方《小程序隐私协议开发指南 · 五、常见错误说明》原文：
 *   「A:fail api scope is not declared in the privacy agreement, errno: 112
 *     使用到了 A 隐私接口，但是开发者未在『MP后台-设置-服务内容声明-用户隐私保护指引』
 *     中声明收集 A 接口对应的隐私类型。补充的隐私类型声明，将在 5 分钟后生效。」
 * ⇒ 录音（麦克风）属隐私接口，**必须在 mp 后台声明「访问你的麦克风」隐私类型**。
 *   这是**平台配置项，代码改不了**；本模块只负责让用户看得懂、能自救。
 *
 * ── 本模块解决代码侧三件事 ───────────────────────────────────────────
 *   1. 录音前先查 scope.record 授权状态，避免「用户已拒绝 → start() 直接失败」
 *      的死路（系统拒绝过后不再弹窗，用户只能干瞪眼）。
 *   2. 把微信原始英文 errMsg 翻译成中文，并按成因给出**不同的**处置路径。
 *   3. 提供隐私协议状态查询，区分「后台没声明」与「用户没同意」。
 *
 * ── 刻意不做的事：不主动调 wx.authorize ───────────────────────────────
 *   微信要求 wx.authorize 必须在「用户点击行为的同步回调」里调用，
 *   一旦 `await wx.getSetting()` 之后再调用就丢失了手势上下文，iOS 上直接失效。
 *   正确做法：直接调 `recorder.start()`，由系统在未授权时自动弹权限框；
 *   仅当 `authSetting['scope.record'] === false`（用户曾明确拒绝）时才引导
 *   `wx.openSetting()`。
 *
 * ── 刻意不注册 wx.onNeedPrivacyAuthorization ──────────────────────────
 *   官方《小程序隐私协议开发指南 · 六、官方隐私授权弹窗功能》：
 *   「若触发后开发者未进行响应，微信将主动弹出官方弹窗。」
 *   ⇒ 不注册 = 零维护地拿到官方弹窗；注册了反而必须自绘弹窗 UI。
 */

/** 录音失败的成因分类 */
export type RecorderErrorKind =
  /** errno 112：mp 后台未声明「访问你的麦克风」隐私类型 → 接口被直接禁用 */
  | "privacy_not_declared"
  /** 用户未同意隐私保护指引（官方弹窗拒绝，errno 103 / 104） */
  | "privacy_not_agreed"
  /** 用户拒绝/撤销了麦克风授权 → 只能引导去设置页 */
  | "auth_denied"
  /** 手机系统层禁用了麦克风 */
  | "system_forbidden"
  | "unknown";

export type RecorderErrorInfo = {
  kind: RecorderErrorKind;
  /** 弹窗标题 */
  title: string;
  /** 一句话提示（供 toast 用，长度受限） */
  userMessage: string;
  /** 完整说明（供 showModal 用） */
  detail: string;
  /** 是否需要引导用户去设置页重新开启权限 */
  needOpenSetting: boolean;
  /** 原始错误信息，便于排障 */
  raw: string;
};

/** 麦克风授权状态 */
export type RecordAuthState =
  /** 已授权 */
  | "granted"
  /** 从未询问过（start() 时系统会自动弹权限框） */
  | "notAsked"
  /** 用户曾明确拒绝：wx.authorize 不会再弹窗，只能引导去设置页 */
  | "denied";

/** 隐私保护指引的同意状态 */
export type PrivacyState = {
  /** 基础库是否支持 wx.getPrivacySetting（< 2.32.3 不支持） */
  available: boolean;
  /** 微信侧是否还等着用户同意 */
  needAuthorization: boolean;
  /** 后台配置的《用户隐私保护指引》名称 */
  privacyContractName: string;
};

/**
 * 把微信的原始错误翻译成用户看得懂的中文。
 * 注意匹配顺序：先判 errno 112，再判隐私弹窗拒绝，最后才判普通授权拒绝。
 */
export function describeRecorderError(err: any): RecorderErrorInfo {
  const raw = String(err?.errMsg || err?.message || err || "");
  const errno = Number(err?.errno || err?.errNo || 0);
  const lower = raw.toLowerCase();

  // errno 112：后台未声明隐私类型 —— 接口被平台直接禁用，用户改设置也救不了
  if (lower.includes("api scope is not declared")) {
    return {
      kind: "privacy_not_declared",
      title: "录音功能未开通",
      userMessage: "后台未声明麦克风隐私类型",
      detail:
        "小程序后台的《用户隐私保护指引》尚未声明「访问你的麦克风」，微信已直接禁用录音接口。\n\n" +
        "请在 mp.weixin.qq.com → 设置 → 服务内容声明 → 用户隐私保护指引 → 更新，" +
        "勾选「访问你的麦克风」并提交审核，审核通过后约 5 分钟生效。\n\n" +
        "这是平台配置项，不是代码 Bug。",
      needOpenSetting: false,
      raw,
    };
  }

  // 官方隐私弹窗被拒（103 = 耦合弹窗拒绝，104 = 未同意隐私协议）
  if (errno === 103 || errno === 104 || lower.includes("privacy permission is not authorized")) {
    return {
      kind: "privacy_not_agreed",
      title: "需要同意隐私协议",
      userMessage: "请先同意隐私保护指引",
      detail:
        "微信要求先阅读并同意《用户隐私保护指引》才能使用麦克风。\n\n" +
        "请在弹出的协议窗口中点击「同意」后重试；若没有弹窗，" +
        "请先在小程序右上角菜单 → 关于本小程序 → 隐私保护指引 中查看并同意。",
      needOpenSetting: false,
      raw,
    };
  }

  // 用户拒绝麦克风授权
  if (
    lower.includes("auth deny") ||
    lower.includes("authorize:fail") ||
    lower.includes("permission denied")
  ) {
    return {
      kind: "auth_denied",
      title: "麦克风权限被拒绝",
      userMessage: "麦克风权限被拒绝",
      detail:
        "你之前拒绝了麦克风授权，系统不会再次自动弹窗。\n\n" +
        "是否前往设置页重新开启「录音」权限？",
      needOpenSetting: true,
      raw,
    };
  }

  // 手机系统层禁用
  if (lower.includes("not allowed") || lower.includes("system") || lower.includes("denied by system")) {
    return {
      kind: "system_forbidden",
      title: "系统禁用了麦克风",
      userMessage: "系统未允许使用麦克风",
      detail: "请在手机系统设置里允许本应用使用麦克风。",
      needOpenSetting: false,
      raw,
    };
  }

  return {
    kind: "unknown",
    title: "录音失败",
    userMessage: (raw || "录音失败").slice(0, 20),
    detail: raw || "录音失败",
    needOpenSetting: false,
    raw,
  };
}

/**
 * 查询 scope.record 授权状态。
 * 失败时按「从未询问」处理 —— 交给系统去弹权限框，不要因为查询失败就阻断录音。
 */
export async function checkRecordAuth(): Promise<RecordAuthState> {
  try {
    const res = await new Promise<any>((resolve, reject) => {
      wx.getSetting({ success: resolve, fail: reject });
    });
    const v = res?.authSetting?.["scope.record"];
    if (v === true) return "granted";
    if (v === false) return "denied";
    return "notAsked";
  } catch (_) {
    return "notAsked";
  }
}

/**
 * 打开设置页让用户手动开启权限，返回开启后的状态。
 * 仅在用户明确拒绝过（authSetting['scope.record'] === false）时才有意义。
 */
export function openRecordSetting(): Promise<RecordAuthState> {
  return new Promise((resolve) => {
    wx.openSetting({
      success: (res: any) => {
        const v = res?.authSetting?.["scope.record"];
        resolve(v === true ? "granted" : v === false ? "denied" : "notAsked");
      },
      fail: () => resolve("notAsked"),
    });
  });
}

/**
 * 查询隐私保护指引的同意状态。
 * 基础库 < 2.32.3 没有这个接口 → available=false（不做任何拦截）。
 */
export async function getPrivacyState(): Promise<PrivacyState> {
  const w = wx as any;
  if (typeof w.getPrivacySetting !== "function") {
    return { available: false, needAuthorization: false, privacyContractName: "" };
  }
  try {
    const res = await new Promise<any>((resolve, reject) => {
      w.getPrivacySetting({ success: resolve, fail: reject });
    });
    return {
      available: true,
      needAuthorization: !!res?.needAuthorization,
      privacyContractName: String(res?.privacyContractName || ""),
    };
  } catch (_) {
    return { available: false, needAuthorization: false, privacyContractName: "" };
  }
}
