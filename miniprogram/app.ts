// app.ts
App<IAppOption>({
  globalData: {
    openid: "",
    cloudEnv: "", // 云开发环境 ID，需在 miniprogram/utils/config.ts 中填写
  },

  onLaunch() {
    if (!wx.cloud) {
      console.error("请使用 2.2.3 或以上的基础库以使用云能力");
      return;
    }
    // 初始化云开发环境（动态传入 config 中的环境 ID）
    const { CLOUD_ENV } = require("./utils/config");
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

    // 静默登录，获取 openid（不强制手机号授权）
    this.login();
  },

  async login() {
    try {
      const { result } = await wx.cloud.callFunction({
        name: "login",
        data: {},
      });
      // 云函数返回类型为 string | AnyObject，需收窄后取 openid
      const r = result as { openid?: string } | undefined;
      if (r && typeof r.openid === "string") {
        this.globalData.openid = r.openid;
      }
    } catch (e) {
      console.warn("登录失败", e);
    }
  },
});

export interface IAppOption {
  globalData: {
    openid: string;
    cloudEnv: string;
    agentHandoffs?: Record<string, { path: string; query: string; payload?: any }>;
  };
  login(): Promise<void>;
}
