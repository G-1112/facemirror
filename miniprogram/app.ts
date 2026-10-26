// app.ts
import { loginCloud } from "./utils/api";
import { getPrivacyState } from "./utils/privacy";

App<IAppOption>({
  globalData: {
    openid: "",
    // 登录状态："" 未开始 | "pending" 登录中 | "ok" 成功 | "fail" 失败
    // 供页面判断「是否需要重试登录」，避免各处重复调用 login()
    loginState: "" as "" | "pending" | "ok" | "fail",
    cloudEnv: "", // 云开发环境 ID，需在 miniprogram/utils/config.ts 中填写
    // 隐私保护指引的同意状态（启动时探测一次，供诊断用）。
    // needAuthorization=true 说明用户还没同意，录音等隐私接口可能被拦截；
    // 若接口直接报 errno 112，则是「mp 后台未声明麦克风隐私类型」，代码无法修复。
    privacy: {
      available: false,
      needAuthorization: false,
      privacyContractName: "",
    } as { available: boolean; needAuthorization: boolean; privacyContractName: string },
  },

  onLaunch() {
    if (!wx.cloud) {
      console.error("请使用 2.2.3 或以上的基础库以使用云能力");
      return;
    }
    // 初始化云开发环境（动态传入 config 中的环境 ID）
    const { CLOUD_ENV } = require("./utils/config");
    this.globalData.cloudEnv = CLOUD_ENV || "";
    wx.cloud.init({
      env: CLOUD_ENV || undefined,
      traceUser: true,
    });

    // 小程序 AI handoff 接收器（接入指南见 docs/小程序AI技能接入指南.md）。
    // 特性探测：基础库不支持时静默跳过，不影响主包任何现有行为。
    // 接力页经 onLoad(query) 消费 query 字符串；payload 在此按 pageId 暂存供首屏加速。
    const w = wx as any;
    if (typeof w.onAgentHandoff === "function") {
      w.onAgentHandoff(({ pageId, path, query, payload }: any) => {
        this.globalData.agentHandoffs = this.globalData.agentHandoffs || {};
        this.globalData.agentHandoffs[pageId] = { path, query, payload };
      });
    }

    // 静默登录，获取 openid（不强制手机号授权）。
    // 登录失败不阻断启动：此处 catch 掉，避免产生未捕获的 Promise 拒绝；
    // 真正的失败提示由各页面在需要 openid 时触发登录后给出。
    this.login().catch(() => {});

    // 探测隐私保护指引的同意状态（开发期可观测，线上无副作用）。
    // 2023-10-17 起隐私相关功能强制启用：录音（麦克风）属于隐私接口，
    // 若 mp 后台未声明「访问你的麦克风」隐私类型，录音接口会被直接禁用
    // （errno 112: api scope is not declared in the privacy agreement）。
    getPrivacyState()
      .then((p) => {
        this.globalData.privacy = p;
        if (p.available && p.needAuthorization) {
          console.warn(
            "[隐私] 微信侧仍待用户同意《用户隐私保护指引》，录音等隐私接口可能被拦截。" +
              "请在 mp 后台「设置 → 服务内容声明 → 用户隐私保护指引」中确认已声明「访问你的麦克风」。"
          );
        }
      })
      .catch(() => {});
  },

  /**
   * 静默登录。
   * 修复点：
   * 1. 原实现仅 console.warn，登录失败时页面无从得知，后续云函数调用会以
   *    「未登录」失败，用户看到的是无意义的报错。这里记录 loginState 并抛出，
   *    让调用方能给出准确提示。
   * 2. 增加并发去重：多个页面同时 onLoad 时各自 await app.login()，
   *    会并发触发多次 login 云函数调用。加 in-flight 复用。
   */
  async login() {
    if (this.globalData.loginState === "ok" && this.globalData.openid) return;
    const pending = (this as any)._loginPromise as Promise<void> | undefined;
    if (pending) return pending;

    this.globalData.loginState = "pending";
    const p = (async () => {
      try {
        // 修复：改用 api.ts 的 loginCloud()（内部带 20s 超时 + 空响应校验）。
        // 原先此处裸调 wx.cloud.callFunction，云函数未部署 / 环境未关联 /
        // 网络挂起时该 Promise 永不 settle，导致本方法永远 pending，
        // 下游 `await app.login()` 也永远等不到，出题页卡死在「题目加载中…」。
        const r = await loginCloud();
        if (r && typeof r.openid === "string" && r.openid) {
          this.globalData.openid = r.openid;
          this.globalData.loginState = "ok";
        } else {
          this.globalData.loginState = "fail";
          throw new Error("登录失败，请重进小程序重试");
        }
      } catch (e) {
        this.globalData.loginState = "fail";
        console.warn("登录失败", e);
        throw e;
      } finally {
        (this as any)._loginPromise = undefined;
      }
    })();
    (this as any)._loginPromise = p;
    return p;
  },
});

export interface IAppOption {
  globalData: {
    openid: string;
    loginState: "" | "pending" | "ok" | "fail";
    cloudEnv: string;
    privacy: { available: boolean; needAuthorization: boolean; privacyContractName: string };
    agentHandoffs?: Record<string, { path: string; query: string; payload?: any }>;
  };
  login(): Promise<void>;
}
