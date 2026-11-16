// 云函数错误分类与呈现 —— 回归测试
//
// 背景（2026-10-26 实测事故）：用户在开发者工具点「确认并生成报告」，
// 页面只弹出一个毫无意义的 toast：**"cloud.callFunction"**。
//
// 根因：页面 catch 里写 `e?.message`，而微信云函数的原生错误对象的
// `message` 恰好就是字符串 "cloud.callFunction"（框架只把方法名放进
// message），**真正的原因藏在 errMsg 里被整个丢弃**：
//   原始 errMsg 形如 "cloud.callFunction:fail Error: 内容安全检测暂不可用，请稍后重试"
//   或 "cloud.callFunction:fail -604101 ..."
//
// 本测试锁死「原始 errMsg → 中文分类 → 可操作提示」这条链路，
// 防止以后改文案时把关键原因弄丢，或把 errno 112/-604101 误分类。
//
// 做法：编译真实 miniprogram/utils/api.ts 到 vm，注入 wx 桩。
//
// 运行：node tests/api_error.test.js
// 注意：本文件在仓库根 tests/，不在 miniprogramRoot 内，不会进小程序包。

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const ts = require("typescript");

const SRC = path.join(__dirname, "..", "miniprogram", "utils", "api.ts");

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
 * 编译真实 api.ts 并返回其导出。
 * @param {object} wxStub wx 宿主桩
 * @param {number} [capTimeoutMs] 把 >=1s 的定时器压缩到该值（测超时用）
 */
function loadApi(wxStub, capTimeoutMs) {
  const source = fs.readFileSync(SRC, "utf8");
  const js = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
    fileName: "api.ts",
  }).outputText;

  const sandbox = {
    exports: {},
    module: { exports: {} },
    require: (r) => {
      if (r === "./config") return { SUBSCRIBE_TEMPLATE_ID: "" };
      throw new Error("测试未预置的模块：" + r);
    },
    console: { log: () => {}, warn: () => {}, error: () => {} },
    wx: wxStub,
    Promise,
    setTimeout: capTimeoutMs ? (fn, ms) => setTimeout(fn, ms >= 1000 ? capTimeoutMs : ms) : setTimeout,
    clearTimeout,
  };
  const ctx = vm.createContext(sandbox);
  const wrapped =
    "(function (exports, require, module, __filename, __dirname) {\n" + js + "\n})";
  const factory = vm.runInContext(wrapped, ctx, { filename: "api.js" });
  const mod = sandbox.module;
  factory.call(mod.exports, mod.exports, sandbox.require, mod, "api.js", __dirname);
  return mod.exports;
}

async function main() {
  console.log("=== 云函数错误分类回归测试（驱动真实 api.ts）===");

  // ── 场景 1：★本次事故的错误形态 ────────────────────────────────────
  console.log("\n场景 1：★原始错误只剩 \"cloud.callFunction\"（用户实际看到的）");
  {
    const api = loadApi({});
    const info = api.describeCallError({ errMsg: "cloud.callFunction", message: "cloud.callFunction" });
    check("不得把 \"cloud.callFunction\" 当成用户文案", info.text !== "cloud.callFunction", info.text);
    check("给出了中文兜底文案", /[一-龥]/.test(info.text), info.text);

    // 关键回归：errorText 绝不能返回 "cloud.callFunction"
    const t = api.errorText({ errMsg: "cloud.callFunction", message: "cloud.callFunction" }, "加载失败");
    check("errorText 不返回无意义的 cloud.callFunction", t !== "cloud.callFunction", t);
    check("errorText 有中文", /[一-龥]/.test(t), t);
  }

  // ── 场景 2：云函数内部业务错误（原样透传中文）──────────────────────
  console.log("\n场景 2：云函数返回的业务错误");
  {
    const api = loadApi({});
    const info = api.describeCallError({
      errMsg: "cloud.callFunction:fail Error: 内容安全检测暂不可用，请稍后重试",
    });
    check("剥掉了 cloud.callFunction:fail 前缀", !info.text.includes("cloud.callFunction"), info.text);
    check("保留了业务错误原文", info.text.includes("内容安全检测暂不可用"), info.text);
    check("剥掉了 Error: 前缀", !info.text.startsWith("Error:"), info.text);
  }

  // ── 场景 3：-604101 openapi 权限未生效 ─────────────────────────────
  console.log("\n场景 3：-604101（openapi 权限未生效 / 10 分钟缓存期）");
  {
    const api = loadApi({});
    const info = api.describeCallError({ errMsg: "cloud.callFunction:fail -604101 request:fail" });
    check("识别为权限未生效", info.text.includes("权限未生效"), info.text);
    check("给出了可操作指引", !!info.hint && info.hint.includes("10 分钟"), info.hint);
    check("指引提到 config.json 声明", !!info.hint && info.hint.includes("config.json"), info.hint);
  }

  // ── 场景 4：未部署 vs 执行失败（★2026-10-26 CLI 实测后修正语义）────
  console.log("\n场景 4：云函数未部署 / 执行失败");
  {
    const api = loadApi({});
    const a = api.describeCallError({ errMsg: "cloud.callFunction:fail function not found" });
    check("识别为未部署", a.text.includes("未部署"), a.text);
    check("给出了部署指引", !!a.hint && a.hint.includes("deploy_cloud.py"), a.hint);

    // ★实测截图里的错误形态：errCode -504002 function not found
    const c = api.describeCallError({
      errMsg: "cloud.callFunction:fail errCode -504002 function not found",
    });
    check("-504002 + function not found → 明确判定未部署", c.text.includes("未部署"), c.text);
    check("给出了部署指引", !!c.hint && c.hint.includes("deploy_cloud.py"), c.hint);

    // ⚠️ 官方错误码表：-504002 = 「云函数执行失败」（**不是**「未部署」）。
    //    CLI 实测 10 个云函数全部 Active，所以裸 -504002 必须指向"看日志"，
    //    上一轮把它判成"未部署"是判断错误，此处锁定正确语义。
    const d = api.describeCallError({ errMsg: "cloud.callFunction:fail errCode -504002" });
    check("-504002 单独出现 → 判定为「云函数执行失败」", d.text.includes("执行失败"), d.text);
    check("-504002 不再被误判成未部署", !d.text.includes("未部署"), d.text);
    check("-504002 指引指向日志排查", !!d.hint && d.hint.includes("日志"), d.hint);

    // 错误码从 errCode 字段取也能识别
    const e = api.describeCallError({ errCode: -504002, errMsg: "cloud.callFunction:fail" });
    check("errCode 字段可作为锚点", e.text.includes("执行失败"), e.text);

    // ⚠️ 官方错误码表：-501001 是「云端系统错误」，**不是**「云函数不存在」
    //    （上一轮曾误标，此处锁定正确语义）
    const b = api.describeCallError({ errMsg: "cloud.callFunction:fail errCode -501001" });
    check("-501001 按官方表识别为云端系统错误", b.text.includes("云端系统"), b.text);
    check("-501001 不被误判成未部署", !b.text.includes("未部署"), b.text);
  }

  // ── 场景 7：★errMsg 的 message: 字段优先提取（真实事故形态）──────────
  console.log("\n场景 7：errMsg 的 message: 字段优先提取");
  {
    const api = loadApi({});
    // ★用户实际截图的形态：errCode -504002 + functionName + message
    const a = api.describeCallError({
      errMsg:
        "cloud.callFunction:fail errCode -504002 functionName:updateTranscript, " +
        "message:内容安全检测暂不可用，请稍后重试 RequestId:xxxx",
    });
    check("优先提取 message: 里的真实原因", a.text.includes("内容安全检测暂不可用"), a.text);
    check("不把 functionName 当成未部署", !a.text.includes("未部署"), a.text);
    check("内容安全类错误给出 msgSecCheck 指引", !!a.hint && a.hint.includes("msgSecCheck"), a.hint);
    check("指引提到 permissions.openapi", !!a.hint && a.hint.includes("permissions.openapi"), a.hint);
    check("指引提到 10 分钟权限缓存期", !!a.hint && a.hint.includes("10 分钟"), a.hint);

    // message: 里的原因优先于错误码表的笼统文案
    const b = api.describeCallError({
      errCode: -504002,
      errMsg: "cloud.callFunction:fail errCode -504002 message:题目记录不存在",
    });
    check("message 优先于错误码表文案", b.text.includes("题目记录不存在"), b.text);

    // message: 是英文时不当成中文原因，交给后续兜底
    const c = api.describeCallError({
      errMsg: "cloud.callFunction:fail errCode -504002 message:internal error",
    });
    check("英文 message 不被当作中文原因", !c.text.includes("internal error"), c.text);
    check("英文 message 回落到错误码表", c.text.includes("执行失败"), c.text);

    // 无 message: 字段时，仍按错误码表兜底
    const d = api.describeCallError({ errMsg: "cloud.callFunction:fail errCode -604101" });
    check("无 message 字段时按错误码表兜底", d.text.includes("权限未生效"), d.text);
  }

  // ── 场景 5：超时 / 网络 / 权限 ─────────────────────────────────────
  console.log("\n场景 5：超时 / 网络 / 权限");
  {
    const api = loadApi({});
    const a = api.describeCallError({ errMsg: "cloud.callFunction:fail timeout" });
    check("识别为超时", a.text.includes("超时"), a.text);
    check("超时给了 60 秒配置指引", !!a.hint && a.hint.includes("60 秒"), a.hint);
    const b = api.describeCallError({ errMsg: "cloud.callFunction:fail request:fail network error" });
    check("识别为网络异常", b.text.includes("网络"), b.text);
    const c = api.describeCallError({ errMsg: "cloud.callFunction:fail permission denied" });
    check("识别为权限问题", c.text.includes("权限"), c.text);
  }

  // ── 场景 6：★call() 的错误包装（端到端）────────────────────────────
  console.log("\n场景 6：call() 端到端错误包装");
  {
    // 6a. wx.cloud 原生 reject → 抛出的 Error.message 必须是可读中文
    const api = loadApi({
      cloud: {
        callFunction: () => Promise.reject({ errMsg: "cloud.callFunction:fail Error: 内容安全检测暂不可用，请稍后重试" }),
      },
    });
    let caught = null;
    try {
      await api.call("updateTranscript", { recordId: "x" });
    } catch (e) {
      caught = e;
    }
    check("确实抛出了错误", !!caught);
    check(
      "Error.message 是可读中文，不是 cloud.callFunction",
      caught && typeof caught.message === "string" && caught.message !== "cloud.callFunction",
      caught && caught.message
    );
    check("message 含真实原因", caught && caught.message.includes("内容安全检测"), caught && caught.message);
    check(
      "原始 errMsg 保留在 err.raw 供排障",
      caught && String(caught.raw).includes("cloud.callFunction:fail"),
      caught && caught.raw
    );
    check("标记了出错的云函数名", caught && caught.cloudFunction === "updateTranscript", caught && caught.cloudFunction);
  }
  {
    // 6b. 云函数返回 { error } → 业务错误原样透传
    const api = loadApi({
      cloud: { callFunction: () => Promise.resolve({ result: { error: "记录不存在或无访问权限" } }) },
    });
    let caught = null;
    try {
      await api.call("updateTranscript", {});
    } catch (e) {
      caught = e;
    }
    check("业务错误原样透传", caught && caught.message === "记录不存在或无访问权限", caught && caught.message);
  }
  {
    // 6c. result 为 null → 「服务无响应」
    const api = loadApi({ cloud: { callFunction: () => Promise.resolve({ result: null }) } });
    let caught = null;
    try {
      await api.call("getQuestions", {});
    } catch (e) {
      caught = e;
    }
    check("result 为 null 时报「服务无响应」", caught && /无响应/.test(caught.message), caught && caught.message);
  }
  {
    // 6d. 云函数挂起 → 超时兜底（把 20s 压缩到 20ms）
    const api = loadApi(
      { cloud: { callFunction: () => new Promise(() => {}) } },
      20
    );
    let caught = null;
    const t0 = Date.now();
    try {
      await api.call("analyze", {});
    } catch (e) {
      caught = e;
    }
    const elapsed = Date.now() - t0;
    check("挂起时按超时兜底", caught && /超时/.test(caught.message), caught && caught.message);
    check("超时耗时合理", elapsed < 2000, elapsed + "ms");
  }
  {
    // 6e. 成功路径不受影响
    const api = loadApi({
      cloud: { callFunction: () => Promise.resolve({ result: { ok: true, value: 42 } }) },
    });
    const r = await api.call("getPractice", {});
    check("成功路径原样返回", r && r.ok === true && r.value === 42, JSON.stringify(r));
  }

  {
    // 6f. ★长错误文案：toast 必须截断，完整原因必须走 modal
    //     （真机 showToast 的 title 最多约 14 个汉字，超出被微信截成省略号）
    const toastCalls = [];
    const modalCalls = [];
    const api = loadApi({
      showToast: (o) => toastCalls.push(o),
      showModal: (o) => modalCalls.push(o),
      setTimeout: setTimeout,
    });
    api.showCallError({
      errMsg:
        "cloud.callFunction:fail errCode -504002 functionName:updateTranscript, " +
        "message:内容安全检测暂不可用，请稍后重试（原因：openapi.ACCESS_DENIED）",
    });
    check("弹了 toast", toastCalls.length === 1, JSON.stringify(toastCalls));
    const t = toastCalls[0] ? toastCalls[0].title : "";
    check("toast 不超过 15 个字符", t.length <= 15, t + " (" + t.length + ")");
    check("toast 不含英文原因", !t.includes("ACCESS_DENIED"), t);
    // modal 在 1800ms 后弹，需要等一下
    await new Promise((r) => setTimeout(r, 1900));
    check("弹了 modal 给完整原因", modalCalls.length === 1, JSON.stringify(modalCalls));
    const c = modalCalls[0] ? modalCalls[0].content : "";
    check("modal 含完整原文", c.includes("内容安全检测暂不可用"), c);
    check("modal 含括号里的底层原因", c.includes("ACCESS_DENIED"), c);
    check("modal 含 msgSecCheck 指引", c.includes("msgSecCheck"), c);
    // 2026-11-16 真机实测修复：同一段原因不得在 modal 里重复出现两次
    // （此前 hint 已带「完整原因：+全文」，又拼了一遍「完整原因：+40字截断文」）
    const occurrences = c.split("完整原因").length - 1;
    check("「完整原因」只出现一次", occurrences === 1, c);
  }

  {
    // 6g. ★页面级长业务错误（2026-11-16 真机实测 NUL PDF 弹窗重复实锤）：
    //     页面把云函数返回的 {error:"简历解析失败：...全文"} 包成 Error 传进
    //     showCallError → describeCallError 走「业务错误超长」分支，
    //     hint =「完整原因：+ 同一段全文」；旧代码又拼一遍「完整原因：+ 40 字截断文」
    //     → modal 里同一段原因重复出现两次。
    const toastCalls = [];
    const modalCalls = [];
    const api = loadApi({
      showToast: (o) => toastCalls.push(o),
      showModal: (o) => modalCalls.push(o),
      setTimeout: setTimeout,
    });
    const fullMsg =
      "简历解析失败：该 PDF 的内嵌字体缺少文字编码表，数字等字符无法正确提取。" +
      "请用 Word/WPS 打开原文档另存为 docx 格式上传，或重新导出 PDF";
    api.showCallError(new Error(fullMsg));
    await new Promise((r) => setTimeout(r, 1900));
    check("页面级长错误弹了 modal", modalCalls.length === 1, JSON.stringify(modalCalls));
    const c = modalCalls[0] ? modalCalls[0].content : "";
    check("modal 含完整报错全文", c.includes("重新导出 PDF"), c);
    const occ = c.split("完整原因").length - 1;
    check("「完整原因」只出现一次（修复重复拼接）", occ === 1, c);
    const occMsg = c.split("简历解析失败").length - 1;
    check("报错正文不重复出现", occMsg === 1, c);
  }

  console.log("\n" + "=".repeat(52));
  if (failed === 0) {
    console.log("全部通过：8 个场景均符合预期");
  } else {
    console.log("失败 " + failed + " 项");
  }
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("测试运行异常：", e);
  process.exit(1);
});
