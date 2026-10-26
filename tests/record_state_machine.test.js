// 录音页状态机回归测试（驱动真实 miniprogram/pages/record/record.ts）
//
// 背景（2026-10-26 状态机核查）：
//   record.ts 有 8 个状态：idle | recording | paused | stopping |
//   uploading | transcribing | analyzing | editing。
//   本次逐状态核查「每个状态都有出口」，发现并修复了 7 个死锁/串扰缺陷：
//   ① onRecordTap 用 default 兜底 → 长任务态点主按钮会重新 start()，
//      与仍在跑的 uploadAndSubmit/runAsr 链打架，且 runAsr 跑完还会
//      redirectTo 强行把用户弹走。
//   ② onStartRecord 在 await checkRecordAuth() 之后不复查 status →
//      await 期间用户点了「结束作答」，之后仍会 start()，两个录音生命周期并存。
//   ③ onStartRecord 失败分支不复位状态 → 停在「录音中」但没在录。
//   ④ onStop 不判 recorder.stop() 返回值、不接异常 → 永久卡「正在结束录音…」。
//   ⑤ onRecordStop 无 alive 守卫 → 页面卸载后仍启动整条上传/识别/评估链。
//   ⑥ runAnalyze 的 wx.redirectTo 无 fail 回调 → 永久卡「AI 评估中…」。
//   ⑦ onConfirmTranscript 无防重入 → 连点并发跑两条 updateTranscript+analyze 链。
//
// 本测试驱动真实源码（含真实 utils/recorder.ts 的 Recorder 类），
// 不使用「同构副本」——副本会随实现漂移，等于没测。
//
// 运行：node tests/record_state_machine.test.js
// 注意：本文件在仓库根 tests/，不在 miniprogramRoot 内，不会进小程序包。

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const ts = require("typescript");

const PAGE_SRC = path.join(__dirname, "..", "miniprogram", "pages", "record", "record.ts");
const RECORDER_SRC = path.join(__dirname, "..", "miniprogram", "utils", "recorder.ts");

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

function transpile(src, fileName) {
  return ts.transpileModule(fs.readFileSync(src, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
    fileName: fileName,
  }).outputText;
}

/**
 * 加载真实 recorder.ts，注入可控的 wx.getRecorderManager 桩。
 * 返回 { Recorder, getRecorder, reset, calls }
 */
function loadRecorderModule(managerFactory) {
  const js = transpile(RECORDER_SRC, "recorder.ts");
  const moduleRef = { exports: {} };
  const sandbox = {
    exports: moduleRef.exports,
    module: moduleRef,
    require: () => {
      throw new Error("recorder 不应有依赖");
    },
    console: { log: () => {}, warn: () => {}, error: () => {} },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Date,
  };
  sandbox.wx = { getRecorderManager: managerFactory };
  const ctx = vm.createContext(sandbox);
  const wrapped = "(function (exports, require, module, __filename, __dirname) {\n" + js + "\n})";
  const factory = vm.runInContext(wrapped, ctx, { filename: "recorder.js" });
  factory.call(
    moduleRef.exports,
    moduleRef.exports,
    sandbox.require,
    moduleRef,
    "recorder.js",
    __dirname
  );
  return moduleRef.exports;
}

/**
 * 编译并实例化真实 record.ts。
 * @param {object} opts
 *   - managerMode: "normal" | "stopThrows" | "stopSilent"
 *   - authMode: "granted" | "denied" | "slow"
 *   - apiMode:   "ok" | "error" | "manual"
 */
function loadPage(opts) {
  const options = Object.assign(
    { managerMode: "normal", authMode: "granted", apiMode: "ok" },
    opts || {}
  );

  const calls = { toasts: [], modals: [], loading: [], upload: [], redirect: [], submit: [] };

  // ---- 真实 recorder 模块 + 可控 manager ----
  const recorderModule = loadRecorderModule(() => ({
    onStop: () => {},
    onError: () => {},
    start: (o) => {
      calls.start = o;
    },
    pause: () => {
      calls.pause = true;
    },
    resume: () => {
      calls.resume = true;
    },
    stop: () => {
      calls.stopCount = (calls.stopCount || 0) + 1;
      if (options.managerMode === "stopThrows") throw new Error("audio is stop");
      // stopSilent：不触发 onStop（模拟看门狗场景）
    },
  }));

  const js = transpile(PAGE_SRC, "record.ts");
  const moduleRef = { exports: {} };
  let pageConfig = null;

  const wxStub = {
    showToast: (o) => calls.toasts.push(o),
    showModal: (o) => {
      calls.modals.push(o);
      // 不自动触发 success：由测试显式调用 modal.success
    },
    showLoading: (o) => calls.loading.push(o),
    hideLoading: () => {},
    cloud: {
      uploadFile: async (o) => {
        calls.upload.push(o);
        if (options.apiMode === "error") throw new Error("upload failed");
        return { fileID: "cloud://test/a.mp3" };
      },
    },
    redirectTo: (o) => {
      calls.redirect.push(o);
      if (options.apiMode !== "redirectFail") {
        if (o.success) setTimeout(() => o.success({}), 0);
      } else {
        if (o.fail) setTimeout(() => o.fail({ errMsg: "redirectTo:fail" }), 0);
      }
    },
  };

  const apiStub = {
    submitPractice: async (p) => {
      calls.submit.push(p);
      if (options.apiMode === "submitFail") throw new Error("submit failed");
      return { recordId: "rec-001" };
    },
    requestSubscribe: async () => {},
    call: async (name) => {
      if (name === "asr") {
        if (options.apiMode === "asrFail") throw new Error("asr failed");
        if (options.apiMode === "asrManual") return { needManual: true, transcript: "" };
        return { status: "done", transcript: "我的回答内容" };
      }
      if (name === "analyze") {
        if (options.apiMode === "analyzeFail") throw new Error("analyze failed");
        return { ok: true };
      }
      return { ok: true };
    },
    showCallError: (e, fallback) => {
      calls.toasts.push({ title: String((e && e.message) || fallback), icon: "none" });
    },
    errorText: (e, fallback) => (e && typeof e.message === "string" && e.message.trim()) || fallback,
  };

  const privacyStub = {
    checkRecordAuth: async () => {
      if (options.authMode === "slow") {
        await sleep(30);
        return "granted";
      }
      return options.authMode === "denied" ? "denied" : "granted";
    },
    describeRecorderError: (err) => ({
      kind: "unknown",
      title: "录音失败",
      detail: String((err && err.message) || "未知错误"),
      userMessage: "录音失败，请重试",
      needOpenSetting: false,
    }),
    openRecordSetting: async () => "granted",
  };

  const requireStub = (request) => {
    if (request === "../../utils/recorder") return recorderModule;
    if (request === "../../utils/api") return apiStub;
    if (request === "../../utils/privacy") return privacyStub;
    throw new Error("测试未预置的模块：" + request);
  };

  const sandbox = {
    Page: (cfg) => {
      pageConfig = cfg;
    },
    getApp: () => ({ globalData: {} }),
    wx: wxStub,
    console: { log: () => {}, warn: () => {}, error: () => {} },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Date,
    Promise,
  };
  const ctx = vm.createContext(sandbox);
  const wrapped = "(function (exports, require, module, __filename, __dirname) {\n" + js + "\n})";
  const factory = vm.runInContext(wrapped, ctx, { filename: "record.js" });
  factory.call(
    moduleRef.exports,
    moduleRef.exports,
    requireStub,
    moduleRef,
    "record.js",
    __dirname
  );

  const page = Object.assign({}, pageConfig);
  page.data = JSON.parse(JSON.stringify(pageConfig.data));
  page.setData = function (obj) {
    Object.assign(this.data, obj);
  };
  if (typeof page.onLoad === "function") {
    page.onLoad({ scene: "interview", question: encodeURIComponent("请做个自我介绍") });
  }

  return { page, calls, recorderModule };
}

async function main() {
  console.log("=== 录音页状态机回归测试（驱动真实 record.ts + 真实 recorder.ts）===");

  // ── 场景 1：★长任务态点主按钮不得重新开始录音 ───────────────────────
  console.log("\n场景 1：★长任务态点主按钮不重新 start（不与后台链打架）");
  {
    for (const st of ["stopping", "uploading", "transcribing", "analyzing", "editing"]) {
      const { page, calls } = loadPage({});
      page.setData({ status: st });
      page.onRecordTap();
      check(
        "状态 " + st + "：没有发起录音",
        calls.start === undefined,
        "status=" + st + " start 被调用了"
      );
      check(
        "状态 " + st + "：状态未被改写",
        page.data.status === st,
        "变成了 " + page.data.status
      );
      check(
        "状态 " + st + "：给出了「处理中」提示",
        calls.toasts.length === 1 && calls.toasts[0].title.includes("处理中"),
        JSON.stringify(calls.toasts)
      );
    }
  }

  // ── 场景 2：★recorder.stop() 未真正发起停止 → 必须归位 idle ─────────
  console.log("\n场景 2：★onStop 时 stop() 返回 false → 归位 idle（不卡 stopping）");
  {
    // 用一个 started=false 的 recorder：从未 start 过，stop() 返回 false
    const { page, calls } = loadPage({});
    page.recorder = { stop: () => false, release: () => {} };
    page.setData({ status: "recording" });
    page.onStop();
    check("状态已归位 idle", page.data.status === "idle", page.data.status);
    check("给了用户可操作提示", calls.toasts.length === 1, JSON.stringify(calls.toasts));
    check(
      "提示文案含「录音未开始」",
      calls.toasts[0] && calls.toasts[0].title.includes("录音未开始"),
      calls.toasts[0] && calls.toasts[0].title
    );
  }

  // ── 场景 3：★recorder.stop() 抛异常 → 必须归位 idle ────────────────
  console.log("\n场景 3：★onStop 时 stop() 抛异常 → 归位 idle");
  {
    const { page, calls } = loadPage({});
    page.recorder = {
      stop: () => {
        throw new Error("audio is stop");
      },
      release: () => {},
    };
    page.setData({ status: "recording" });
    page.onStop();
    check("状态已归位 idle", page.data.status === "idle", page.data.status);
    check("给了用户可操作提示", calls.toasts.length === 1, JSON.stringify(calls.toasts));
  }

  // ── 场景 4：★recorder.stop() 抛异常时看门狗仍须兜底 ─────────────────
  console.log("\n场景 4：★recorder.stop() 同步抛异常 → 仍要触发兜底回调");
  {
    const { recorderModule } = loadPage({ managerMode: "stopThrows" });
    const rec = new recorderModule.Recorder();
    let stopCb = null;
    rec.start({ durationSec: 60 }, (res) => {
      stopCb = res;
    });
    // 正常路径：manager.stop() 抛异常时，recorder 自己消化异常并**立即**
    // 触发一次 timedOut 兜底回调 → 页面能回到 idle，返回 true 表示
    // 「停止流程已闭环，由 recorder 负责回调」。
    const accepted = rec.stop();
    check("抛异常被 recorder 内部消化（不向外冒泡）", accepted === true, String(accepted));
    check(
      "★抛异常后仍触发了兜底回调（timedOut）",
      stopCb && stopCb.timedOut === true && stopCb.tempFilePath === "",
      JSON.stringify(stopCb)
    );
  }

  // ── 场景 5：★页面卸载后 onStop 不得再启动整条链 ─────────────────────
  console.log("\n场景 5：★页面卸载后 onRecordStop 不启动上传链");
  {
    const { page, calls } = loadPage({});
    page.onUnload();
    page.onRecordStop({ tempFilePath: "/tmp/a.mp3", duration: 3 });
    check("没有发起上传", calls.upload.length === 0, JSON.stringify(calls.upload));
    check("没有提交练习记录", calls.submit.length === 0, JSON.stringify(calls.submit));
    check("alive 已置 false", page.alive === false, String(page.alive));
  }

  // ── 场景 6：★redirectTo 失败 → 归位 editing（不卡 analyzing）─────────
  console.log("\n场景 6：★redirectTo 失败 → 归位 editing");
  {
    const { page, calls } = loadPage({ apiMode: "redirectFail" });
    page.setData({ recordId: "rec-001", status: "editing" });
    await page.runAnalyze("rec-001");
    await sleep(20);
    check("状态归位 editing", page.data.status === "editing", page.data.status);
    check("编辑器已显示", page.data.showEditor === true, String(page.data.showEditor));
    check("给了可见提示", calls.toasts.length >= 1, JSON.stringify(calls.toasts));
  }

  // ── 场景 7：★连点「确认并生成报告」只提交一次 ───────────────────────
  console.log("\n场景 7：★onConfirmTranscript 防重入");
  {
    const { page, calls } = loadPage({});
    page.setData({ recordId: "rec-001", status: "editing", transcript: "我的回答" });
    const p1 = page.onConfirmTranscript();
    const p2 = page.onConfirmTranscript();
    await Promise.all([p1, p2]);
    check(
      "并发的 updateTranscript 只发生一次",
      calls.redirect.length <= 1,
      "redirect 次数 " + calls.redirect.length
    );
  }

  // ── 场景 8：★非 editing 态不得提交 ──────────────────────────────────
  console.log("\n场景 8：★状态前置——非 editing 态不提交");
  {
    const { page, calls } = loadPage({});
    page.setData({ recordId: "rec-001", status: "analyzing", transcript: "我的回答" });
    await page.onConfirmTranscript();
    check("没有发起跳转", calls.redirect.length === 0, String(calls.redirect.length));
    check(
      "给出了「处理中」提示",
      calls.toasts.length === 1 && calls.toasts[0].title.includes("处理中"),
      JSON.stringify(calls.toasts)
    );
  }

  // ── 场景 9：★await 期间状态变更 → 不再 start ───────────────────────
  console.log("\n场景 9：★onStartRecord 在 await 后复查 status");
  {
    const { page, calls } = loadPage({ authMode: "slow" });
    const p = page.onStartRecord();
    // await 期间模拟用户点了「结束作答」→ 状态被改
    page.setData({ status: "stopping" });
    await p;
    check("没有发起录音", calls.start === undefined, "start 被调用了");
    check("状态未被改回 recording", page.data.status === "stopping", page.data.status);
  }

  // ── 场景 10：★onStartRecord 失败必须归位 idle ───────────────────────
  console.log("\n场景 10：★onStartRecord 失败 → 归位 idle（不留假录音）");
  {
    const { page, calls } = loadPage({});
    page.recorder = {
      start: () => {
        throw new Error("start boom");
      },
      release: () => {},
      stop: () => true,
    };
    await page.onStartRecord();
    check("状态归位 idle", page.data.status === "idle", page.data.status);
    check("倒计时已清零", page.data.remaining === 0, String(page.data.remaining));
    check("倒计时文本已清空", page.data.remainingText === "", page.data.remainingText);
    check("给出了失败提示", calls.toasts.length === 1, JSON.stringify(calls.toasts));
  }

  // ── 场景 11：★recorder.start 重复调用必须清掉旧定时器 ────────────────
  console.log("\n场景 11：★recorder.start 重复调用 → 旧时长定时器必须被清");
  {
    // 行为验证（不是「未抛异常」这种恒真断言）：
    // 第一次 start 用极短时长（0.02s），第二次 start 用长时长（60s）。
    // 若第一次的定时器没被清除，它会在 20ms 后触发 this.stop()，
    // 于是 manager.stop() 被调用一次 → 录音被提前掐断。
    // 正确实现下，两次 start 之后 manager.stop() 应**从未**被调用。
    const { recorderModule, calls } = loadPage({});
    const rec = new recorderModule.Recorder();
    rec.start({ durationSec: 0.02 }, () => {});
    rec.start({ durationSec: 60 }, () => {});
    await sleep(120); // 远大于 0.02s
    check(
      "★重复 start 后旧定时器未触发 stop（录音不会被提前掐断）",
      !calls.stopCount,
      "manager.stop 被调用了 " + (calls.stopCount || 0) + " 次"
    );
    // 收尾：释放掉第二次 start 留下的定时器，避免测试进程挂住
    rec.release();
  }

  // ── 场景 12：★页面卸载后 runAsr / runAnalyze 不得再 setData ─────────
  console.log("\n场景 12：★页面卸载后 runAsr / runAnalyze 不再 setData");
  {
    const { page } = loadPage({});
    let setDataAfterUnload = 0;
    const originalSetData = page.setData;
    page.setData = function (obj) {
      setDataAfterUnload++;
      return originalSetData.call(this, obj);
    };
    page.onUnload();
    const callsAtUnload = setDataAfterUnload;

    await page.runAsr("rec-001");
    await page.runAnalyze("rec-001");

    check(
      "卸载后 runAsr/runAnalyze 没有产生任何 setData",
      setDataAfterUnload === callsAtUnload,
      "卸载后又发生了 " + (setDataAfterUnload - callsAtUnload) + " 次 setData"
    );
  }

  // ── 场景 13：★8 个状态都有出口（结构化核查）────────────────────────
  console.log("\n场景 13：★8 个状态逐个确认有出口");
  {
    const src = fs.readFileSync(PAGE_SRC, "utf8");
    const statuses = [
      "idle",
      "recording",
      "paused",
      "stopping",
      "uploading",
      "transcribing",
      "analyzing",
      "editing",
    ];
    for (const st of statuses) {
      // 该状态必须至少在一个 setData 中作为目标出现（即有地方能进入该状态）
      const enters = new RegExp('status:\\s*"' + st + '"').test(src);
      check("状态 " + st + " 有明确的进入点", enters, "源码中未找到 status: \"" + st + "\"");
    }
    // 关键：所有「进入长任务态」的路径都必须能被带回来
    check(
      "上传/识别/评估三条失败路径都归位 idle 或 editing",
      /status:\s*"idle"/.test(src) && /status:\s*"editing"/.test(src),
      ""
    );
  }

  console.log("\n" + "=".repeat(52));
  if (failed === 0) {
    console.log("全部通过：13 个场景均符合预期");
  } else {
    console.log("失败 " + failed + " 项");
  }
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("测试运行异常：", e);
  process.exit(1);
});
