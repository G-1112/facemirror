// 首页「开始练习」按钮可点性 —— 回归测试
//
// 背景（2026-10-26 实测事故）：用户反馈"连开始练习按钮都点不了了"。
//
// 根因链：
//   1. index.wxml 的按钮写成 `disabled="{{navigating}}"`；
//   2. index.ts 的 onStart() 第一行 `if (this.data.navigating) return;`
//      —— 也就是**只要 navigating 还是 true，点击被完全吞掉**；
//   3. 而 navigating 置 true 之后，**只有 navigateTo 的 success/fail 回调
//      才会把它置回 false**。一旦这两个回调都没触发
//      （例如页面栈已满、目标页正在加载、路由被拦截、setData 抛错），
//      navigating 就**永久卡在 true**；
//   4. 结果：按钮变灰 + 点击被 return 吞掉 → 页面彻底死掉，
//      **用户只能重启小程序才能恢复**。
//
// ⚠️ 这跟之前"题目无法加载"是同一类错误的镜像版：
//   那次是 finally 里把状态归位语句换掉了；这次是**归位语句本身只有
//   一条路径能到达**。凡是"置 true 的 flag"，必须保证**任何分支都能置回 false**。
//
// 本测试驱动真实 miniprogram/pages/index/index.ts，验证：
//   ① 初始 navigating === false（按钮可点）
//   ② 正常点击 → 发起 navigateTo
//   ③ **navigateTo 静默失败（success/fail 都不回调）→ 必须能自愈**
//   ④ 页面回到前台（onShow）时必须复位 navigating
//
// 运行：node tests/index_start_button.test.js
// 注意：本文件在仓库根 tests/，不在 miniprogramRoot 内，不会进小程序包。

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const ts = require("typescript");

const SRC = path.join(__dirname, "..", "miniprogram", "pages", "index", "index.ts");
const GUARD_SRC = path.join(__dirname, "..", "miniprogram", "utils", "nav-guard.ts");

let failed = 0;
const check = (name, cond, detail) => {
  if (cond) {
    console.log("  [PASS] " + name);
  } else {
    console.log("  [FAIL] " + name + (detail ? " -> " + detail : ""));
    failed++;
  }
};

/**
 * 编译真实的 nav-guard.ts 并返回其导出。
 * ⚠️ 必须用**真实实现**而不是桩：防重入锁的「自动过期」语义正是本次要测的，
 * 写成桩就等于没测。
 */
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
 * 编译真实 index.ts 并返回 { page, calls, toasts }。
 * @param {object} opts navigateTo 的行为配置
 *   - mode: "success" | "fail" | "silent"（静默：不回调 success 也不回调 fail）
 */
function loadIndex(opts) {
  const options = opts || { mode: "success" };
  const calls = [];
  const toasts = [];

  const source = fs.readFileSync(SRC, "utf8");
  const js = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
    fileName: "index.ts",
  }).outputText;

  const wxStub = {
    navigateTo: (o) => {
      calls.push(o);
      if (options.mode === "success") {
        setTimeout(() => o.success && o.success({}), 0);
      } else if (options.mode === "fail") {
        setTimeout(() => o.fail && o.fail({ errMsg: "navigateTo:fail page stack limit" }), 0);
      }
      // mode === "silent"：两个回调都不触发（模拟真实世界的静默失败）
    },
    showToast: (o) => toasts.push(o),
  };

  let pageObj = null;
  const sandbox = {
    exports: {},
    module: { exports: {} },
    require: (r) => {
      if (r === "../../utils/config") {
        return { SCENES: [{ key: "interview", label: "模拟面试", icon: "🎤", desc: "求职面试" }] };
      }
      if (r === "../../utils/nav-guard") {
        return loadGuard();
      }
      throw new Error("测试未预置的模块：" + r);
    },
    console: { log: () => {}, warn: () => {}, error: () => {} },
    wx: wxStub,
    Page: (cfg) => {
      pageObj = cfg;
    },
    Promise,
    setTimeout,
    clearTimeout,
  };
  const ctx = vm.createContext(sandbox);
  const wrapped =
    "(function (exports, require, module, __filename, __dirname) {\n" + js + "\n})";
  const factory = vm.runInContext(wrapped, ctx, { filename: "index.js" });
  const mod = sandbox.module;
  factory.call(mod.exports, mod.exports, sandbox.require, mod, "index.js", __dirname);

  // 造一个最小 Page 实例（模拟微信运行时的 Page 对象）
  const data = JSON.parse(JSON.stringify(pageObj.data));
  const inst = {
    data,
    setData(patch) {
      Object.assign(inst.data, patch);
    },
  };
  Object.keys(pageObj).forEach((k) => {
    if (typeof pageObj[k] === "function") inst[k] = pageObj[k].bind(inst);
  });
  if (typeof inst.onLoad === "function") inst.onLoad();
  return { inst, calls, toasts };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log("=== 首页「开始练习」按钮可点性回归测试（驱动真实 index.ts）===");

  // ── 场景 1：初始状态可点 ───────────────────────────────────────────
  console.log("\n场景 1：初始状态");
  {
    const { inst } = loadIndex({ mode: "success" });
    check("navigating 初始为 false", inst.data.navigating === false, String(inst.data.navigating));
    check("初始 data 里存在 navigating 字段", "navigating" in inst.data);
  }

  // ── 场景 2：正常点击能发起跳转 ─────────────────────────────────────
  console.log("\n场景 2：正常点击");
  {
    const { inst, calls } = loadIndex({ mode: "success" });
    inst.onStart();
    check("发起了 navigateTo", calls.length === 1, String(calls.length));
    check(
      "跳转 URL 带上 scene 与 mode",
      calls[0] && calls[0].url.includes("scene=interview") && calls[0].url.includes("mode=random"),
      calls[0] && calls[0].url
    );
    await sleep(10);
    check("跳转成功后 navigating 已复位", inst.data.navigating === false, String(inst.data.navigating));
  }

  // ── 场景 3：★navigateTo 静默失败（success/fail 都不回调）────────────
  console.log("\n场景 3：★navigateTo 静默失败（两个回调都不触发）");
  {
    const { inst, calls } = loadIndex({ mode: "silent" });
    inst.onStart();
    check("确实发起了 navigateTo", calls.length === 1, String(calls.length));
    check("点击后 navigating 被置为 true", inst.data.navigating === true, String(inst.data.navigating));

    // 模拟「用户过一会儿回到首页」→ onShow 触发
    if (typeof inst.onShow === "function") inst.onShow();
    check("onShow 后 navigating 已复位（页面可恢复）", inst.data.navigating === false, String(inst.data.navigating));

    // 复位后必须能再次点击
    inst.onStart();
    check("复位后可再次发起跳转", calls.length === 2, String(calls.length));
  }

  // ── 场景 4：★防重复跳转不能只依赖 navigateTo 回调解锁（时间戳锁）────
  console.log("\n场景 4：★防重入用时间戳锁，回调不来也会自动过期");
  {
    const { inst, calls } = loadIndex({ mode: "silent" });
    inst.onStart();
    // 再点一次：应当被防重复逻辑拦住（锁未过期）
    inst.onStart();
    check("锁有效期内重复点击被拦住", calls.length === 1, String(calls.length));

    // ⚠️ 关键：锁必须**自动过期**，不能永久卡死。
    // 等过窗口时长（3s）→ 看门狗应自动解锁 → 再点一次必须被放行
    await sleep(3200);
    check("锁过期后 navigating 自动复位", inst.data.navigating === false, String(inst.data.navigating));
    inst.onStart();
    check("锁过期后可再次点击", calls.length === 2, String(calls.length));
  }

  // ── 场景 5：navigateTo 明确失败也要复位并提示 ───────────────────────
  console.log("\n场景 5：navigateTo 明确失败");
  {
    const { inst, toasts } = loadIndex({ mode: "fail" });
    inst.onStart();
    await sleep(10);
    check("失败后 navigating 已复位", inst.data.navigating === false, String(inst.data.navigating));
    check("给了用户可见的失败提示", toasts.length === 1, JSON.stringify(toasts));
  }

  // ── 场景 6：★按钮永远不得用 disabled 属性做防重入 ────────────────
  console.log("\n场景 6：★WXML 层铁律——按钮不得用 disabled 做防重入");
  {
    const wxml = fs.readFileSync(
      path.join(__dirname, "..", "miniprogram", "pages", "index", "index.wxml"),
      "utf8"
    );
    // 取出「开始练习」按钮所在的那一行（含可能的换行，用正则跨行匹配按钮标签）
    const btnTag = (wxml.match(/<button[^>]*start-btn[\s\S]*?>/) || [])[0] || "";
    check("找到了开始按钮标签", btnTag.length > 0, btnTag);
    check(
      "按钮**不得**有 disabled 属性（否则锁卡住就永久点不动）",
      !/disabled\s*=/.test(btnTag),
      btnTag
    );
    check("按钮仍绑定了 bindtap=onStart", /bindtap\s*=\s*"onStart"/.test(btnTag), btnTag);

    // 幂等性：即便锁状态真的卡在 true，点击也必须能走到 onStart 的解锁路径
    const { inst, calls } = loadIndex({ mode: "silent" });
    inst.onStart(); // navigating -> true
    inst.onStart(); // 被防重入拦住
    check("锁生效时重复点击被拦住（防重入仍有效）", calls.length === 1, String(calls.length));
    // 看门狗兜底：等待 NAV_UNLOCK_MS 后必须自动解锁
    await sleep(3200);
    check("看门狗兜底自动解锁", inst.data.navigating === false, String(inst.data.navigating));
    inst.onStart();
    check("看门狗解锁后可再次点击", calls.length === 2, String(calls.length));
  }

  console.log("\n" + "=".repeat(52));
  if (failed === 0) {
    console.log("全部通过：6 个场景均符合预期");
  } else {
    console.log("失败 " + failed + " 项");
  }
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("测试运行异常：", e);
  process.exit(1);
});
