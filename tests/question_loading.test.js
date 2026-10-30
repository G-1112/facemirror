// 出题页「题目加载中…」卡死 —— 回归测试
//
// 为什么要测真实源码而不是复制一份逻辑：
//   2026-10-26 本轮 bug 正是「重构时把 finally 里的 loading:false 删掉」导致的，
//   而当时的静态检查（tsc / WXML 自检）全部通过 —— 因为它不是类型错误，
//   是状态机漏了一条归位语句。只有真正执行真实源码才能抓住这类回归。
//
// 做法：用已安装的 typescript 把 miniprogram/pages/question/question.ts
//       转成 CommonJS，在 node 的 vm 里注入 Page / getApp / wx / setTimeout 等
//       宿主桩，然后驱动真实的 loadRandom()。
//
// 运行：node tests/question_loading.test.js
// 注意：本文件位于仓库根 tests/，不在 miniprogramRoot（miniprogram/）内，
//       不会被打进小程序包。

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const ts = require("typescript");

const SRC = path.join(__dirname, "..", "miniprogram", "pages", "question", "question.ts");
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 编译真实的 nav-guard.ts 并返回其导出。
 * ⚠️ 用真实实现而非桩：它是本项目唯一的防重入实现，桩会让"自动过期"语义测不出来。
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
 * 编译并加载真实的 question.ts，返回可驱动的 page 实例。
 * @param {object} opts
 * @param {function} opts.getQuestions  getQuestions 云函数的替身
 * @param {function} [opts.login]       app.login 的替身（默认成功）
 * @param {number}  [opts.watchdogCapMs] 看门狗倒计时的压缩上限（测试加速用）
 */
function loadPage(opts) {
  const source = fs.readFileSync(SRC, "utf8");
  return instantiate(source, opts);
}

function instantiate(source, opts) {
  const { getQuestions, login, watchdogCapMs } = opts;

  const js = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
    fileName: "question.ts",
  }).outputText;

  // ---- 宿主桩 ----
  let pageConfig = null;
  const appInstance = {
    globalData: { openid: "", loginState: "" },
    login:
      login ||
      (async function () {
        this.globalData.openid = "openid-test";
        this.globalData.loginState = "ok";
      }),
  };

  const toasts = [];
  const wxStub = {
    showToast: (o) => toasts.push(o),
    showLoading: () => {},
    hideLoading: () => {},
  };

  // 看门狗压缩：把长延时（>=1s）压到 watchdogCapMs，模拟真实 25s 超时路径
  const setTimeoutStub = watchdogCapMs
    ? (fn, ms) => setTimeout(fn, ms >= 1000 ? watchdogCapMs : ms)
    : setTimeout;

  // api.ts 的真实语义：call() 会把云函数返回的 { error } 转成抛异常，
  // 并校验 result 非空。测试替身必须复刻这两条，否则测的就不是真实链路。
  const wrapCloudResult = async (raw) => {
    if (!raw || typeof raw !== "object") throw new Error("服务无响应，请稍后重试");
    if (raw.error) throw new Error(String(raw.error));
    return raw;
  };
  // showCallError / errorText 是 2026-10-26 新增的错误呈现出口，
  // 页面 catch 分支全部改走它们（原先只取 e?.message，而微信云错误的
  // message 恰好是 "cloud.callFunction"，真实原因被丢弃）。
  const shownErrors = [];
  const apiStub = {
    getQuestions: async (params) => wrapCloudResult(await getQuestions(params)),
    genQuestions: async () => ({ questions: [] }),
    showCallError: (e, fallback) => {
      shownErrors.push({ err: e, fallback });
    },
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
    getApp: () => appInstance,
    wx: wxStub,
    console: console,
    setTimeout: setTimeoutStub,
    clearTimeout: clearTimeout,
  };
  const ctx = vm.createContext(sandbox);
  const wrapped =
    "(function (exports, require, module, __filename, __dirname) {\n" + js + "\n})";
  const factory = vm.runInContext(wrapped, ctx, { filename: "question.js" });
  const mod = { exports: {} };
  factory.call(mod.exports, mod.exports, requireStub, mod, "question.js", __dirname);

  // ---- 实例化 Page 配置（模拟小程序框架）----
  const page = Object.assign({}, pageConfig);
  page.data = JSON.parse(JSON.stringify(pageConfig.data));
  page.setData = function (obj) {
    Object.assign(this.data, obj);
  };

  return { page, appInstance, toasts, shownErrors };
}

/** 构造一份「有缺陷的源码」：模拟本轮回归（成功分支 + finally 都不归位 loading） */
function legacySource() {
  // ★行尾归一化（2026-10-30 修复）：question.ts 实际是 CRLF，这里用 \n 精确
  //   匹配会静默失配（String.replace 找不到就不动、不报错）→ 哨兵放行"带看门狗
  //   兜底的缺陷版"，自检必失败。先归一化再替换，并对**每一处**替换断言生效。
  const src = fs.readFileSync(SRC, "utf8").replace(/\r\n/g, "\n");
  const step1 = src.replace(
    "this.setData({ question: questions[0].text, loadFailed: false, loading: false });",
    "this.setData({ question: questions[0].text, loadFailed: false });"
  );
  if (step1 === src) {
    throw new Error("未能构造缺陷源码（第 1 处：正常路径的 loading 归位）：question.ts 结构已变，请同步更新本测试");
  }
  const patched = step1.replace(
    "      if (this.alive && this.data.loading) {\n" +
      "        this.setData({ loading: false });\n" +
      "      }",
    ""
  );
  if (patched === step1) {
    throw new Error("未能构造缺陷源码（第 2 处：finally 看门狗兜底）：question.ts 结构已变，请同步更新本测试");
  }
  return patched;
}

async function main() {
  console.log("=== 出题页 loading 状态机回归测试（直接驱动真实 question.ts）===");

  // 场景 1：云函数正常返回 → 题目出现，loading 必须归位
  console.log("\n场景 1：云函数正常返回");
  {
    const { page } = loadPage({
      getQuestions: async () => ({ questions: [{ text: "请做一个简单的自我介绍。" }] }),
    });
    await page.loadRandom();
    check("loading 已归位", page.data.loading === false, JSON.stringify(page.data));
    check("题目已填充", page.data.question === "请做一个简单的自我介绍。", page.data.question);
    check("非错误态", page.data.loadFailed === false);
    check(
      "「去作答」按钮可点（disabled 条件 !question || loading 为假）",
      !(!page.data.question || page.data.loading)
    );
  }

  // 场景 2：云函数返回业务错误 → 错误态 + 可重试，不得卡在 loading
  console.log("\n场景 2：云函数返回 { error }");
  {
    const { page, shownErrors } = loadPage({
      getQuestions: async () => ({ error: "未获取用户身份，请重新登录" }),
    });
    await page.loadRandom();
    check("loading 已归位", page.data.loading === false, JSON.stringify(page.data));
    check("进入错误态", page.data.loadFailed === true);
    check("错误信息透出", page.data.errorMsg.includes("未获取用户身份"), page.data.errorMsg);
    check(
      "走了统一的错误呈现出口 showCallError（不能只 toast 原始 message）",
      shownErrors.length === 1,
      "showCallError 调用次数=" + shownErrors.length
    );
  }

  // 场景 3：★云函数永不 settle（用户截图场景）→ 看门狗兜底退出 loading
  console.log("\n场景 3：★云函数挂起不返回（看门狗兜底）");
  {
    const { page } = loadPage({
      getQuestions: () => new Promise(() => {}), // 永不 settle
      watchdogCapMs: 60, // 把 25s 看门狗压缩到 60ms
    });
    const p = page.loadRandom();
    await sleep(20);
    check("请求未结束前仍在 loading", page.data.loading === true, JSON.stringify(page.data));
    await sleep(120);
    check("看门狗触发后 loading 已归位", page.data.loading === false, JSON.stringify(page.data));
    check("进入错误态并给出可操作提示", page.data.loadFailed === true && page.data.errorMsg.includes("超时"));
    void p;
  }

  // 场景 4：登录失败不得中断抽题（登录失败信息与抽题失败信息要能分别呈现）
  console.log("\n场景 4：登录失败不中断抽题");
  {
    const { page } = loadPage({
      login: async function () {
        throw new Error("登录失败");
      },
      getQuestions: async () => ({ questions: [{ text: "题目A" }] }),
    });
    await page.loadRandom();
    check("loading 已归位", page.data.loading === false, JSON.stringify(page.data));
    check("仍拿到了题目", page.data.question === "题目A", page.data.question);
    check("非错误态", page.data.loadFailed === false);
  }

  // 场景 5：★回归哨兵 —— 用有缺陷的源码跑一遍，必须复现「卡在 loading」
  // 这一步证明本测试确实有牙齿：将来谁再删掉归位语句，场景 1 会立刻红。
  console.log("\n场景 5：回归哨兵（证明本测试能捕获该缺陷）");
  {
    const { page } = instantiate(legacySource(), {
      getQuestions: async () => ({ questions: [{ text: "题目B" }] }),
    });
    await page.loadRandom();
    check(
      "缺陷版本确实卡在 loading=true（说明场景 1 的断言有效）",
      page.data.loading === true,
      "缺陷未复现，请检查哨兵源码构造"
    );
  }

  console.log("\n" + "=".repeat(52));
  if (failed === 0) {
    console.log("全部通过：5 个场景均符合预期");
  } else {
    console.log("失败 " + failed + " 项");
  }
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("测试运行异常：", e);
  process.exit(1);
});
