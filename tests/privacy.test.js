// 录音隐私 / 授权错误分类 —— 回归测试
//
// 背景：2026-10-26 开发者工具点「开始作答」报
//   `start:fail api scope is not declared in the privacy agreement`（errno 112），
//   而页面只 toast 了 slice(0,30) 的英文原文 → 用户看到「startfail api scope is not de」。
//   本测试锁死「错误 → 中文分类 → 处置路径」的映射，防止以后改文案时把
//   关键的后台配置指引删掉，或把 errno 112 误判成「用户拒绝授权」（会导致
//   错误地引导用户去设置页，而真正的原因是平台后台没声明隐私类型）。
//
// 做法：编译真实 miniprogram/utils/privacy.ts 到 vm，注入 wx 桩。
//
// 运行：node tests/privacy.test.js
// 注意：本文件在仓库根 tests/，不在 miniprogramRoot 内，不会进小程序包。

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const ts = require("typescript");

const SRC = path.join(__dirname, "..", "miniprogram", "utils", "privacy.ts");

let failed = 0;
const check = (name, cond, detail) => {
  if (cond) {
    console.log("  [PASS] " + name);
  } else {
    console.log("  [FAIL] " + name + (detail ? " -> " + detail : ""));
    failed++;
  }
};

/** 编译真实 privacy.ts，返回其导出 */
function loadPrivacy(wxStub) {
  const source = fs.readFileSync(SRC, "utf8");
  const js = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
    fileName: "privacy.ts",
  }).outputText;

  const sandbox = {
    exports: {},
    module: { exports: {} },
    require: (r) => {
      throw new Error("测试未预置的模块：" + r);
    },
    console,
    wx: wxStub || {},
    Promise,
  };
  const ctx = vm.createContext(sandbox);
  const wrapped =
    "(function (exports, require, module, __filename, __dirname) {\n" + js + "\n})";
  const factory = vm.runInContext(wrapped, ctx, { filename: "privacy.js" });
  const mod = sandbox.module;
  factory.call(mod.exports, mod.exports, sandbox.require, mod, "privacy.js", __dirname);
  return mod.exports;
}

async function main() {
  console.log("=== 录音隐私 / 授权错误分类回归测试（驱动真实 privacy.ts）===");

  const privacy = loadPrivacy();

  // ── 场景 1：errno 112 —— 本次事故的真实错误 ──────────────────────────
  console.log("\n场景 1：errno 112（后台未声明麦克风隐私类型）");
  {
    const info = privacy.describeRecorderError({
      errMsg: "start:fail api scope is not declared in the privacy agreement",
      errno: 112,
    });
    check("分类为 privacy_not_declared", info.kind === "privacy_not_declared", info.kind);
    check("不得引导去设置页（改了也没用）", info.needOpenSetting === false);
    check("中文提示可放进 toast", info.userMessage.length > 0 && info.userMessage.length <= 30, info.userMessage);
    check("提示不含英文报错", !/[a-z]{4,}/i.test(info.userMessage), info.userMessage);
    check("说明含后台配置路径", info.detail.includes("用户隐私保护指引"), info.detail);
    check("说明含「访问你的麦克风」", info.detail.includes("麦克风"), info.detail);
    check("说明含 5 分钟生效提示", info.detail.includes("5 分钟"), info.detail);
    check("保留了原始错误便于排障", info.raw.includes("api scope is not declared"), info.raw);
  }

  // ── 场景 2：未同意隐私协议 ───────────────────────────────────────────
  console.log("\n场景 2：未同意隐私协议");
  {
    const a = privacy.describeRecorderError({ errMsg: "start:fail privacy permission is not authorized" });
    check("按 errMsg 识别为 privacy_not_agreed", a.kind === "privacy_not_agreed", a.kind);
    const b = privacy.describeRecorderError({ errMsg: "start:fail", errno: 103 });
    check("errno 103 → privacy_not_agreed", b.kind === "privacy_not_agreed", b.kind);
    const c = privacy.describeRecorderError({ errMsg: "start:fail", errno: 104 });
    check("errno 104 → privacy_not_agreed", c.kind === "privacy_not_agreed", c.kind);
    check("隐私协议问题不引导去设置页", a.needOpenSetting === false);
  }

  // ── 场景 3：用户拒绝麦克风授权 ───────────────────────────────────────
  console.log("\n场景 3：用户拒绝麦克风授权");
  {
    const info = privacy.describeRecorderError({ errMsg: "start:fail auth deny" });
    check("分类为 auth_denied", info.kind === "auth_denied", info.kind);
    check("需要引导去设置页", info.needOpenSetting === true);
    check("说明含设置页引导", info.detail.includes("设置页"), info.detail);
    const info2 = privacy.describeRecorderError({ errMsg: "authorize:fail auth deny" });
    check("authorize:fail 也归为 auth_denied", info2.kind === "auth_denied", info2.kind);
  }

  // ── 场景 4：系统层禁用 ───────────────────────────────────────────────
  console.log("\n场景 4：系统层禁用麦克风");
  {
    const info = privacy.describeRecorderError({ errMsg: "start:fail recorder is not allowed" });
    check("分类为 system_forbidden", info.kind === "system_forbidden", info.kind);
    check("不引导去设置页", info.needOpenSetting === false);
  }

  // ── 场景 5：未知错误兜底 ─────────────────────────────────────────────
  console.log("\n场景 5：未知错误兜底");
  {
    const info = privacy.describeRecorderError({ errMsg: "start:fail something odd" });
    check("分类为 unknown", info.kind === "unknown", info.kind);
    check("有可显示的兜底文案", info.userMessage.length > 0, info.userMessage);
    const empty = privacy.describeRecorderError(undefined);
    check("err 为 undefined 也不崩", empty.kind === "unknown", empty.kind);
  }

  // ── 场景 6：授权状态查询（wx 桩）────────────────────────────────────
  console.log("\n场景 6：checkRecordAuth 状态识别");
  {
    const mk = (scopeValue) => ({
      getSetting: ({ success, fail }) => {
        if (scopeValue === "__fail__") return fail({ errMsg: "getSetting:fail" });
        success({ authSetting: { "scope.record": scopeValue } });
      },
    });
    const p1 = loadPrivacy(mk(true));
    check("true → granted", (await p1.checkRecordAuth()) === "granted");
    const p2 = loadPrivacy(mk(false));
    check("false → denied（需引导去设置页）", (await p2.checkRecordAuth()) === "denied");
    const p3 = loadPrivacy(mk(undefined));
    check("undefined → notAsked（交给系统弹权限框）", (await p3.checkRecordAuth()) === "notAsked");
    const p4 = loadPrivacy(mk("__fail__"));
    check("查询失败 → notAsked 兜底（不阻断录音）", (await p4.checkRecordAuth()) === "notAsked");
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
