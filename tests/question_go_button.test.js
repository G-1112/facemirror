// 出题页「去作答」按钮 —— 状态锁回归测试
//
// 背景（2026-10-26 第二次事故）：
//   首页「开始练习」按钮点不动，根因是 `disabled="{{navigating}}"` +
//   `if (navigating) return;` 双重吞掉点击，而 navigating 只靠 navigateTo
//   回调复位 → 回调不来就永久锁死。
//   出题页「去作答」是**同一模式**：`disabled="{{!question || loading}}"`。
//
// ⚠️ 但出题页比首页多一层语义，改造时必须区分两类拦截：
//   A. 业务前置条件（真的没题目 / 加载中 / 加载失败）
//      → 应该在 JS 层拦截，并给用户**可操作的提示**，
//        而不是让按钮默默变灰、点了毫无反应。
//   B. 防重入（连点）
//      → 应该由时间戳锁拦截，锁**自动过期**，永不永久卡死。
//
// 本测试驱动真实 miniprogram/pages/question/question.ts + 真实 nav-guard.ts。
//
// 运行：node tests/question_go_button.test.js
// 注意：本文件在仓库根 tests/，不在 miniprogramRoot 内，不会进小程序包。

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const ts = require("typescript");

const SRC = path.join(__dirname, "..", "miniprogram", "pages", "question", "question.ts");
const GUARD_SRC = path.join(__dirname, "..", "miniprogram", "utils", "nav-guard.ts");
const WXML = path.join(__dirname, "..", "miniprogram", "pages", "question", "question.wxml");

let failed = 0;
const check = (name, cond, detail) => {
  if (cond) {
    console.log("  [PASS] " + name);
  } else {
    console.log("  [FAIL] " + name + (detail ? " -> " + detail : ""));
    failed++;
  }
};

/** 编译真实的 nav-guard.ts（必须用真实现，桩会让"自动过期"语义测不出来） */
function loadGuard() {
  const source = fs.readFileSync(GUARD_SRC, "utf8");
  const js = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
    fileName: "nav-guard.ts",
  }).outputText;
  const sandbox = {
    exports: {},
    module: { exports: {} },
    require: () => {
      throw new Error("nav-guard 不应有依赖");
    },
    console: { log: () => {}, warn: () => {}, error: () => {} },
    setTimeout,
    clearTimeout,
    Date,
  };
  const ctx = vm.createContext(sandbox);
  const wrapped =
    "(function (exports, require, module, __filename, __dirname) {\n" + js + "\n})";
  const factory = vm.runInContext(wrapped, ctx, { filename: "nav-guard.js" });
  const mod = sandbox.module;
  factory.call(mod.exports, mod.exports, sandbox.require, mod, "nav-guard.js", __dirname);
  return mod.exports;
}

/**
 * 编译并实例化真实 question.ts。
 * @param {object} opts
 *   - navigateMode: "success" | "fail" | "silent"（静默：回调都不触发）
 */
function loadPage(opts) {
  const options = opts || { navigateMode: "success" };
  const source = fs.readFileSync(SRC, "utf8");
  const js = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
    fileName: "question.ts",
  }).outputText;

  const navCalls = [];
  const toasts = [];
  let pageConfig = null;

  const wxStub = {
    navigateTo: (o) => {
      navCalls.push(o);
      if (options.navigateMode === "success") setTimeout(() => o.success && o.success({}), 0);
      else if (options.navigateMode === "fail")
        setTimeout(() => o.fail && o.fail({ errMsg: "navigateTo:fail page stack limit" }), 0);
      // silent：两个回调都不触发
    },
    showToast: (o) => toasts.push(o),
    showLoading: () => {},
    hideLoading: () => {},
  };

  const apiStub = {
    getQuestions: async () => ({ questions: [{ text: "请做一个简单的自我介绍。" }] }),
    genQuestions: async () => ({ questions: [] }),
    showCallError: () => {},
    errorText: (e, fallback) => (e && typeof e.message === "string" && e.message.trim()) || fallback,
  };

  const requireStub = (request) => {
    if (request === "../../utils/api") return apiStub;
    if (request === "../../utils/nav-guard") return loadGuard();
    if (request === "../../app") return {};
    throw new Error("测试未预置的模块：" + request);
  };

  const sandbox = {
    Page: (cfg) => {
      pageConfig = cfg;
    },
    getApp: () => ({ globalData: { openid: "openid-test", loginState: "ok" }, login: async () => {} }),
    wx: wxStub,
    console: { log: () => {}, warn: () => {}, error: () => {} },
    setTimeout,
    clearTimeout,
    Promise,
    Date,
  };
  const ctx = vm.createContext(sandbox);
  const wrapped =
    "(function (exports, require, module, __filename, __dirname) {\n" + js + "\n})";
  const factory = vm.runInContext(wrapped, ctx, { filename: "question.js" });
  const mod = { exports: {} };
  factory.call(mod.exports, mod.exports, requireStub, mod, "question.js", __dirname);

  const page = Object.assign({}, pageConfig);
  page.data = JSON.parse(JSON.stringify(pageConfig.data));
  page.setData = function (obj) {
    Object.assign(this.data, obj);
  };
  if (typeof page.onLoad === "function") page.onLoad({ scene: "interview", mode: "random" });

  return { page, navCalls, toasts };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 取 WXML 中某个 class 的 button 标签 */
function buttonTagByClass(className) {
  const wxml = fs.readFileSync(WXML, "utf8");
  const re = new RegExp("<button[^>]*" + className + "[\\s\\S]*?>");
  return (wxml.match(re) || [])[0] || "";
}

async function main() {
  console.log("=== 出题页「去作答」按钮状态锁回归测试（驱动真实 question.ts）===");

  // ── 场景 1：WXML 层铁律——按钮不得用 disabled 做闸门 ────────────────
  console.log("\n场景 1：★WXML 层铁律——按钮不得用 disabled 属性");
  {
    const go = buttonTagByClass("start-btn");
    check("找到了「去作答」按钮标签", go.length > 0, go);
    check(
      "「去作答」按钮**不得**有 disabled 属性",
      !/disabled\s*=/.test(go),
      go
    );
    check("「去作答」仍绑定 bindtap=onGo", /bindtap\s*=\s*"onGo"/.test(go), go);

    const change = buttonTagByClass("change-btn");
    check("找到了「换一题」按钮标签", change.length > 0, change);
    check(
      "「换一题」按钮**不得**有 disabled 属性",
      !/disabled\s*=/.test(change),
      change
    );
    check("「换一题」仍绑定 bindtap=onChange", /bindtap\s*=\s*"onChange"/.test(change), change);
  }

  // ── 场景 2：正常路径——有题目时点「去作答」能跳转 ────────────────────
  console.log("\n场景 2：有题目时正常跳转");
  {
    const { page, navCalls } = loadPage({ navigateMode: "success" });
    page.setData({ question: "请做一个简单的自我介绍。", loading: false });
    page.onGo();
    check("发起了 navigateTo", navCalls.length === 1, String(navCalls.length));
    check(
      "跳转 URL 带上了题目",
      navCalls[0] && navCalls[0].url.includes(encodeURIComponent("请做一个简单的自我介绍。")),
      navCalls[0] && navCalls[0].url
    );
    await sleep(10);
    check("跳转成功后 navigating 已复位", page.data.navigating === false, String(page.data.navigating));
  }

  // ── 场景 3：★业务前置条件——没题目时给可操作提示，而不是变灰 ─────────
  console.log("\n场景 3：★业务前置条件——没题目/加载中/加载失败");
  {
    // 3a. 没题目
    const a = loadPage({ navigateMode: "success" });
    a.page.setData({ question: "", loading: false, loadFailed: false });
    a.page.onGo();
    check("没题目时不发起跳转", a.navCalls.length === 0, String(a.navCalls.length));
    check("给出了可操作提示", a.toasts.length === 1, JSON.stringify(a.toasts));
    check(
      "提示文案是「请先获取题目」",
      a.toasts[0] && a.toasts[0].title.includes("请先获取题目"),
      a.toasts[0] && a.toasts[0].title
    );

    // 3b. 加载中
    const b = loadPage({ navigateMode: "success" });
    b.page.setData({ question: "", loading: true, loadFailed: false });
    b.page.onGo();
    check("加载中时不发起跳转", b.navCalls.length === 0, String(b.navCalls.length));
    check(
      "提示文案是「题目加载中，请稍候」",
      b.toasts[0] && b.toasts[0].title.includes("题目加载中"),
      b.toasts[0] && b.toasts[0].title
    );

    // 3c. 加载失败 → 应引导重试
    const c = loadPage({ navigateMode: "success" });
    c.page.setData({ question: "", loading: false, loadFailed: true });
    c.page.onGo();
    check("加载失败时不发起跳转", c.navCalls.length === 0, String(c.navCalls.length));
    check(
      "提示引导用户点「重新加载」",
      c.toasts[0] && c.toasts[0].title.includes("重新加载"),
      c.toasts[0] && c.toasts[0].title
    );
  }

  // ── 场景 4：★防重入——连点只跳一次，锁自动过期后恢复 ─────────────────
  console.log("\n场景 4：★防重入——连点只跳一次，锁自动过期后恢复");
  {
    const { page, navCalls } = loadPage({ navigateMode: "silent" });
    page.setData({ question: "题目A", loading: false });
    page.onGo();
    page.onGo();
    page.onGo();
    check("连点 3 次只发起 1 次跳转", navCalls.length === 1, String(navCalls.length));
    check("navigating 视觉态为 true", page.data.navigating === true, String(page.data.navigating));

    // ⚠️ 关键：navigateTo 回调永远不来时，锁必须**自动过期**
    await sleep(3200);
    check("锁过期后 navigating 自动复位", page.data.navigating === false, String(page.data.navigating));
    page.onGo();
    check("锁过期后可再次跳转", navCalls.length === 2, String(navCalls.length));
  }

  // ── 场景 5：onShow 兜底解锁 ─────────────────────────────────────────
  console.log("\n场景 5：onShow 兜底解锁");
  {
    const { page, navCalls } = loadPage({ navigateMode: "silent" });
    page.setData({ question: "题目B", loading: false });
    page.onGo();
    check("已发起跳转", navCalls.length === 1, String(navCalls.length));
    // 模拟用户从录音页返回
    page.onShow();
    check("onShow 后 navigating 已复位", page.data.navigating === false, String(page.data.navigating));
    page.onGo();
    check("复位后可再次跳转", navCalls.length === 2, String(navCalls.length));
  }

  // ── 场景 6：navigateTo 明确失败 → 复位 + 提示 ───────────────────────
  console.log("\n场景 6：navigateTo 明确失败");
  {
    const { page, navCalls, toasts } = loadPage({ navigateMode: "fail" });
    page.setData({ question: "题目C", loading: false });
    page.onGo();
    await sleep(10);
    check("失败后 navigating 已复位", page.data.navigating === false, String(page.data.navigating));
    check("给了用户可见的失败提示", toasts.length === 1, JSON.stringify(toasts));
    check(
      "失败提示是「页面打开失败，请重试」",
      toasts[0] && toasts[0].title.includes("页面打开失败"),
      toasts[0] && toasts[0].title
    );
    // 复位后必须能再点
    page.onGo();
    check("失败后可再次跳转", navCalls.length === 2, String(navCalls.length));
  }

  // ── 场景 7：★页面卸载后不得再 setData ───────────────────────────────
  console.log("\n场景 7：页面卸载后不得再 setData");
  {
    const { page } = loadPage({ navigateMode: "silent" });
    page.setData({ question: "题目D", loading: false });
    page.onGo();

    // 记录卸载后是否还有 setData 调用（用计数器捕获）
    let setDataAfterUnload = 0;
    const originalSetData = page.setData;
    page.setData = function (obj) {
      setDataAfterUnload++;
      return originalSetData.call(this, obj);
    };

    page.onUnload(); // 页面销毁
    const callsAtUnload = setDataAfterUnload;

    // 看门狗到期时会触发 onLockChange → 必须被 alive 拦住
    await sleep(3200);
    check("alive 已置为 false", page.alive === false, String(page.alive));
    check(
      "卸载后**没有**任何 setData 调用（否则控制台会报「setData 到已销毁页面」）",
      setDataAfterUnload === callsAtUnload,
      "卸载后又发生了 " + (setDataAfterUnload - callsAtUnload) + " 次 setData"
    );
  }

  console.log("\n" + "=".repeat(52));
  if (failed === 0) {
    console.log("全部通过：7 个场景均符合预期");
  } else {
    console.log("失败 " + failed + " 项");
  }
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("测试运行异常：", e);
  process.exit(1);
});
