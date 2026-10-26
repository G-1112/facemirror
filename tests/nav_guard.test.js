// 导航防重入守卫（nav-guard）—— 单元测试
//
// 为什么要有独立单测：
//   nav-guard 是本项目**唯一**的防重入实现，被首页与出题页共用。
//   一旦它的「自动过期」语义被改坏，两个页面会同时失去兜底 ——
//   而这种回归在页面级测试里很难定位到根因。
//
// 本测试直接驱动真实 miniprogram/utils/nav-guard.ts。
//
// 运行：node tests/nav_guard.test.js

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const ts = require("typescript");

const SRC = path.join(__dirname, "..", "miniprogram", "utils", "nav-guard.ts");

let failed = 0;
const check = (name, cond, detail) => {
  if (cond) {
    console.log("  [PASS] " + name);
  } else {
    console.log("  [FAIL] " + name + (detail ? " -> " + detail : ""));
    failed++;
  }
};

/** 编译真实的 nav-guard.ts，返回其导出 */
function loadGuard() {
  const source = fs.readFileSync(SRC, "utf8");
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log("=== 导航防重入守卫单元测试（驱动真实 nav-guard.ts）===");
  const guard = loadGuard();

  // ── 场景 1：首次加锁成功 ───────────────────────────────────────────
  console.log("\n场景 1：首次加锁");
  {
    const g = guard.createNavGuard();
    check("首次 tryLock 返回 true", g.tryLock() === true);
  }

  // ── 场景 2：窗口内拒绝连点 ─────────────────────────────────────────
  console.log("\n场景 2：窗口内拒绝连点");
  {
    const g = guard.createNavGuard();
    g.tryLock();
    check("窗口内第二次 tryLock 返回 false", g.tryLock() === false);
    check("窗口内第三次仍返回 false", g.tryLock() === false);
  }

  // ── 场景 3：★窗口自动过期（核心保证）───────────────────────────────
  console.log("\n场景 3：★窗口自动过期");
  {
    const g = guard.createNavGuard({ windowMs: 120 });
    check("首次加锁成功", g.tryLock() === true);
    check("窗口内被拒", g.tryLock() === false);
    await sleep(220);
    check("窗口过期后可再次加锁", g.tryLock() === true);
  }

  // ── 场景 4：onLockChange 状态回调 ──────────────────────────────────
  console.log("\n场景 4：onLockChange 状态回调");
  {
    const events = [];
    const g2 = guard.createNavGuard({ windowMs: 100, onLockChange: (v) => events.push(v) });
    g2.tryLock();
    check("加锁时回调 true", events.length === 1 && events[0] === true, JSON.stringify(events));
    g2.unlock();
    check("解锁时回调 false", events.length === 2 && events[1] === false, JSON.stringify(events));
  }

  // ── 场景 5：★dispose 后不得再回调（防止销毁页 setData）─────────────
  console.log("\n场景 5：★dispose 后不再回调");
  {
    const events = [];
    const g3 = guard.createNavGuard({ windowMs: 80, onLockChange: (v) => events.push(v) });
    g3.tryLock();
    g3.dispose();
    await sleep(200);
    check("dispose 后看门狗未触发回调", events.length === 1, JSON.stringify(events));
    check("dispose 后无 false 事件", events.filter((e) => e === false).length === 0);
  }

  // ── 场景 6：可控时钟（无需真实等待即可精确验证过期边界）────────────
  console.log("\n场景 6：可控时钟下的过期语义");
  {
    let fakeNow = 1000;
    const g4 = guard.createNavGuard({
      windowMs: 3000,
      now: () => fakeNow,
      onLockChange: () => {},
    });
    check("加锁成功", g4.tryLock() === true);
    check("同一时刻内被拒", g4.tryLock() === false);
    fakeNow += 2999;
    check("差 1ms 仍被拒（窗口未到）", g4.tryLock() === false);
    fakeNow += 2;
    check("超过窗口后放行", g4.tryLock() === true);
  }

  // ── 场景 7：unlock 后立即可再锁 ───────────────────────────────────
  console.log("\n场景 7：unlock 后立即可再锁");
  {
    const g5 = guard.createNavGuard();
    g5.tryLock();
    check("加锁后被拒", g5.tryLock() === false);
    g5.unlock();
    check("unlock 后立即可再锁", g5.tryLock() === true);
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
