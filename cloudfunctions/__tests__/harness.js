/**
 * 云函数本地测试桩：mock `wx-server-sdk`，让云函数逻辑可在 Node 中直接单测。
 *
 * 用法：
 *   const { loadFunction, resetMocks } = require("./harness");
 *   const fn = loadFunction("submitPractice", { OPENID: "o1" });
 *   const res = await fn({ scene: "interview", questionText: "x" });
 *
 * 设计：不依赖任何第三方测试框架，用 node:assert 即可断言，保证离线可复现。
 */
const path = require("path");
const Module = require("module");

/** 简易内存「集合」 */
function makeCollection(store, name) {
  if (!store[name]) store[name] = [];
  const coll = store[name];

  const matches = (doc, where) =>
    Object.entries(where || {}).every(([k, v]) => doc[k] === v);

  return {
    where(cond) {
      return {
        limit(n) {
          return {
            async get() {
              return { data: coll.filter((d) => matches(d, cond)).slice(0, n) };
            },
          };
        },
        async count() {
          return { total: coll.filter((d) => matches(d, cond)).length };
        },
        orderBy() {
          return this;
        },
        skip() {
          return this;
        },
        async get() {
          return { data: coll.filter((d) => matches(d, cond)) };
        },
      };
    },
    doc(id) {
      return {
        async get() {
          const d = coll.find((x) => x._id === id);
          return { data: d ? { ...d } : null };
        },
        async update({ data }) {
          const d = coll.find((x) => x._id === id);
          if (!d) return { stats: { updated: 0 } };
          for (const [k, v] of Object.entries(data)) {
            // 支持原子指令 { __inc: n } 与字段删除 { __remove: true }
            if (v && typeof v === "object" && "__inc" in v) {
              d[k] = (d[k] || 0) + v.__inc;
            } else if (v && typeof v === "object" && "__remove" in v) {
              delete d[k];
            } else {
              d[k] = v;
            }
          }
          return { stats: { updated: 1 } };
        },
        // doc().set()：upsert（存在则更新，不存在则创建），支持原子指令
        async set({ data }) {
          let d = coll.find((x) => x._id === id);
          if (!d) {
            d = { _id: id };
            coll.push(d);
          }
          for (const [k, v] of Object.entries(data)) {
            if (v && typeof v === "object" && "__inc" in v) {
              d[k] = (d[k] || 0) + v.__inc;
            } else if (v && typeof v === "object" && "__remove" in v) {
              delete d[k];
            } else {
              d[k] = v;
            }
          }
          return { stats: { updated: 1 } };
        },
      };
    },
    async add({ data }) {
      const _id = `id_${coll.length + 1}_${Math.random().toString(36).slice(2, 8)}`;
      coll.push({ _id, ...data });
      return { _id };
    },
    orderBy() {
      return this;
    },
    limit() {
      return this;
    },
    async get() {
      return { data: [...coll] };
    },
  };
}

/** 构造一次 mock 环境（每次调用 loadFunction 前重置） */
function resetMocks(state) {
  state.store = {};
  state.openid = "";
  state.sent = [];
  state.warnings = [];
}

/**
 * 加载指定云函数模块，返回其 main 函数。
 * @param {string} fnName 云函数目录名
 * @param {object} opts { OPENID }
 */
function loadFunction(fnName, opts = {}) {
  const state = {
    store: {},
    openid: opts.OPENID || "",
    sent: [],
    warnings: [],
  };

  const dbCommand = {
    inc: (n) => ({ __inc: n }),
    remove: () => ({ __remove: true }),
  };

  const cloudMock = {
    DYNAMIC_CURRENT_ENV: "test-env",
    init() {},
    database() {
      const api = {
        command: dbCommand,
        collection: (name) => makeCollection(state.store, name),
      };
      return api;
    },
    getWXContext() {
      return { OPENID: state.openid };
    },
    async getTempFileURL({ fileList }) {
      return { fileList: fileList.map((f) => ({ fileID: f, tempFileURL: `https://cdn/${f}` })) };
    },
    // 云存储下载：state.fileContents[fileID] 可注入测试内容（Buffer/string），
    // 未注入时返回一段默认材料文本，保证 genQuestions 主链路可测
    async downloadFile({ fileID }) {
      const injected = state.fileContents && state.fileContents[fileID];
      const content =
        injected !== undefined
          ? injected
          : "我在 XX 项目中负责后端架构，QPS 提升 40%，使用 FastAPI 与 Redis。";
      return { fileContent: Buffer.isBuffer(content) ? content : Buffer.from(String(content), "utf-8") };
    },
    openapi: {
      security: {
        // state.msgSecSuggest 可配置（默认 pass），用于测试违规拒绝路径
        // state.msgSecError 可配置为错误码字符串 → 桩会抛异常（模拟平台接口不可用）
        //   典型值："61010"（用户访问记录超时）/ "45009"（每日配额）/ "-604101"（权限未生效）
        async msgSecCheck() {
          if (state.msgSecError) {
            const e = new Error("service unavailable");
            e.errCode = state.msgSecError;
            e.errMsg =
              "openapi.security.msgSecCheck:fail system error: error code: " + state.msgSecError;
            throw e;
          }
          return { result: { suggest: state.msgSecSuggest || "pass" } };
        },
      },
      subscribeMessage: {
        // state.subscribeError 可配置为错误消息 → 桩会抛异常（模拟订阅消息发送失败）
        //   典型值："user refuse to accept the msg"（用户点「拒绝」，属正常分支）
        //   其他值（如 "template id is invalid"）→ 真故障分支
        async send(payload) {
          if (state.subscribeError) {
            const e = new Error(state.subscribeError);
            e.errMsg = "openapi.subscribeMessage.send:fail " + state.subscribeError;
            throw e;
          }
          state.sent.push(payload);
          return { errCode: 0 };
        },
      },
    },
  };

  const fnPath = path.resolve(__dirname, "..", fnName, "index.js");
  // 云函数目录下的共享模块（如 sec-check.js）也必须在桩生效期间加载，
  // 否则它们会拿到真实的 wx-server-sdk（未安装 → require 失败），
  // 或者拿到上一个测试残留的模块实例（桩不生效 → 断言假红/假绿）。
  const secCheckPath = path.resolve(__dirname, "..", fnName, "sec-check.js");

  // 拦截 require("wx-server-sdk")
  const origResolve = Module._resolveFilename;
  Module._resolveFilename = function (request, ...rest) {
    if (request === "wx-server-sdk") return "wx-server-sdk";
    return origResolve.call(this, request, ...rest);
  };
  const origLoad = Module._load;
  Module._load = function (request, ...rest) {
    if (request === "wx-server-sdk") return cloudMock;
    return origLoad.call(this, request, ...rest);
  };

  delete require.cache[fnPath];
  delete require.cache[secCheckPath];
  let mod;
  try {
    mod = require(fnPath);
  } finally {
    Module._resolveFilename = origResolve;
    Module._load = origLoad;
  }

  return { main: mod.main, state };
}

module.exports = { loadFunction, resetMocks };
