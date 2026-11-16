// 分享海报组件「保存到相册」按钮 —— 状态锁回归测试
//
// 背景（2026-10-26 第三次改造）：全项目扫 `disabled="{{flag}}"` 时发现，
// share-poster 的 `disabled="{{saving}}"` 是最后一处同族隐患。
// 更隐蔽的是它的解锁路径：canvasToTempFilePath 成功 → saveImageToPhotosAlbum
// 有 success / fail 两条分支，**任一漏掉解锁，saving 就永久为 true**。
//
// 本测试驱动真实 miniprogram/components/share-poster/share-poster.ts。
//
// 运行：node tests/share_poster_save_button.test.js

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const ts = require("typescript");

const SRC = path.join(__dirname, "..", "miniprogram", "components", "share-poster", "share-poster.ts");
const GUARD_SRC = path.join(__dirname, "..", "miniprogram", "utils", "nav-guard.ts");
const WXML = path.join(__dirname, "..", "miniprogram", "components", "share-poster", "share-poster.wxml");

let failed = 0;
const check = (name, cond, detail) => {
  if (cond) {
    console.log("  [PASS] " + name);
  } else {
    console.log("  [FAIL] " + name + (detail ? " -> " + detail : ""));
    failed++;
  }
};

/** 编译真实的 nav-guard.ts */
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
 * 编译并实例化真实 share-poster.ts。
 * @param {object} opts
 *   - albumMode: "success" | "fail"
 *   - canvasMode: "success" | "fail"
 */
function loadComponent(opts) {
  const options = opts || { albumMode: "success", canvasMode: "success" };
  const source = fs.readFileSync(SRC, "utf8");
  const js = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
    fileName: "share-poster.ts",
  }).outputText;

  const toasts = [];
  const modals = [];
  const albumCalls = [];

  const wxStub = {
    showToast: (o) => toasts.push(o),
    showModal: (o) => modals.push(o),
    canvasToTempFilePath: (o) => {
      if (options.canvasMode === "success") {
        setTimeout(() => o.success && o.success({ tempFilePath: "tmp://poster.png" }), 0);
      } else {
        setTimeout(() => o.fail && o.fail({ errMsg: "canvasToTempFilePath:fail" }), 0);
      }
    },
    saveImageToPhotosAlbum: (o) => {
      albumCalls.push(o);
      if (options.albumMode === "success") {
        setTimeout(() => o.success && o.success({}), 0);
      } else {
        setTimeout(() => o.fail && o.fail({ errMsg: "saveImageToPhotosAlbum:fail auth deny" }), 0);
      }
    },
  };

  let compConfig = null;
  const requireStub = (request) => {
    if (request === "../../utils/nav-guard") return loadGuard();
    // FR-11 小程序码：海报保存会先调 getWxacode 取码；桩固定返回 ok:false
    // → loadQrImage 走降级分支（无码海报），本测试聚焦保存/解锁路径不受影响
    if (request === "../../utils/api") {
      return { call: async () => ({ ok: false }) };
    }
    throw new Error("测试未预置的模块：" + request);
  };

  const sandbox = {
    Component: (cfg) => {
      compConfig = cfg;
    },
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
  const factory = vm.runInContext(wrapped, ctx, { filename: "share-poster.js" });
  const mod = { exports: {} };
  factory.call(mod.exports, mod.exports, requireStub, mod, "share-poster.js", __dirname);

  // 造一个最小组件实例
  const inst = Object.assign({}, compConfig);
  inst.data = JSON.parse(JSON.stringify(compConfig.data));
  inst.setData = function (patch) {
    Object.assign(this.data, patch);
  };
  // methods 里的函数要绑定到实例
  if (compConfig.methods) {
    Object.keys(compConfig.methods).forEach((k) => {
      inst[k] = compConfig.methods[k].bind(inst);
    });
  }
  // 挂载 canvas 桩
  inst.getCanvasInfo = async () => ({
    node: {
      width: 0,
      height: 0,
      getContext: () => ({
        setTransform: () => {},
        scale: () => {},
        fillStyle: "",
        fillRect: () => {},
        beginPath: () => {},
        moveTo: () => {},
        lineTo: () => {},
        stroke: () => {},
        fillText: () => {},
        measureText: () => ({ width: 10 }),
        closePath: () => {},
        fill: () => {},
        arc: () => {},
        save: () => {},
        restore: () => {},
        setLineDash: () => {},
      }),
    },
    width: 300,
    height: 400,
  });
  inst.drawPoster = () => {};

  // 触发 attached（创建守卫）
  if (compConfig.lifetimes && compConfig.lifetimes.attached) {
    compConfig.lifetimes.attached.call(inst);
  }
  // 把 detached 挂到实例上（测试需要主动触发销毁）
  if (compConfig.lifetimes && compConfig.lifetimes.detached) {
    inst.detached = compConfig.lifetimes.detached.bind(inst);
  }

  return { inst, toasts, modals, albumCalls };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log("=== 分享海报「保存到相册」状态锁回归测试（驱动真实 share-poster.ts）===");

  // ── 场景 1：WXML 层铁律 ─────────────────────────────────────────────
  console.log("\n场景 1：★WXML 层铁律——按钮不得用 disabled 属性");
  {
    const wxml = fs.readFileSync(WXML, "utf8");
    const tag = (wxml.match(/<button[^>]*save-btn[\s\S]*?>/) || [])[0] || "";
    check("找到了保存按钮标签", tag.length > 0, tag);
    check("按钮**不得**有 disabled 属性", !/disabled\s*=/.test(tag), tag);
    check("按钮仍绑定 bindtap=save", /bindtap\s*=\s*"save"/.test(tag), tag);
  }

  // ── 场景 2：正常保存成功 → 必须解锁 ────────────────────────────────
  console.log("\n场景 2：保存成功");
  {
    const { inst, toasts } = loadComponent({ albumMode: "success", canvasMode: "success" });
    await inst.save();
    await sleep(300);
    check("saving 已复位为 false", inst.data.saving === false, String(inst.data.saving));
    check("提示已保存到相册", toasts.some((t) => t.title.includes("已保存到相册")), JSON.stringify(toasts));
  }

  // ── 场景 3：★相册保存失败 → 也必须解锁 ─────────────────────────────
  console.log("\n场景 3：★相册保存失败分支也必须解锁");
  {
    const { inst, modals } = loadComponent({ albumMode: "fail", canvasMode: "success" });
    await inst.save();
    await sleep(300);
    check("saving 已复位为 false", inst.data.saving === false, String(inst.data.saving));
    check("给出了相册权限指引", modals.length === 1, JSON.stringify(modals));
  }

  // ── 场景 4：★canvas 生成失败 → 也必须解锁 ─────────────────────────
  console.log("\n场景 4：★canvas 生成失败分支也必须解锁");
  {
    const { inst } = loadComponent({ albumMode: "success", canvasMode: "fail" });
    await inst.save();
    await sleep(300);
    check("saving 已复位为 false", inst.data.saving === false, String(inst.data.saving));
  }

  // ── 场景 5：★连点只处理一次 ───────────────────────────────────────
  console.log("\n场景 5：连点保护");
  {
    const { inst, albumCalls } = loadComponent({ albumMode: "success", canvasMode: "success" });
    const p1 = inst.save();
    const p2 = inst.save();
    const p3 = inst.save();
    await Promise.all([p1, p2, p3]);
    await sleep(300);
    check("连点 3 次只真正保存了 1 次", albumCalls.length === 1, String(albumCalls.length));
    check("saving 已复位为 false", inst.data.saving === false, String(inst.data.saving));
  }

  // ── 场景 6：★锁自动过期（回调不来也不永久卡死）────────────────────
  console.log("\n场景 6：★锁自动过期");
  {
    const { inst } = loadComponent({ albumMode: "success", canvasMode: "success" });
    await inst.save();
    check("saving 视觉态为 true", inst.data.saving === true, String(inst.data.saving));
    // 等过窗口（3s）→ 看门狗自动解锁
    await sleep(3200);
    check("锁过期后 saving 自动复位", inst.data.saving === false, String(inst.data.saving));
  }

  // ── 场景 7：组件销毁后不得再 setData ───────────────────────────────
  console.log("\n场景 7：组件销毁后不得再 setData");
  {
    const { inst } = loadComponent({ albumMode: "success", canvasMode: "success" });
    await inst.save();
    let after = 0;
    const orig = inst.setData;
    inst.setData = function (p) {
      after++;
      return orig.call(this, p);
    };
    // 模拟组件销毁（detached 会 dispose 守卫 → 看门狗被清掉）
    inst.detached();
    await sleep(3200);
    check("销毁后无 setData 调用", after === 0, "销毁后又发生了 " + after + " 次 setData");
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
