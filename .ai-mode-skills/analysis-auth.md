# analysis-auth — 面镜（facemirror）鉴权事实

> wxa-skills-generate 阶段 1.2 产物。来源：主包源码逐字提取。

## 鉴权模型

**无客户端 token 管理**。主包不写 storage、不维护登录令牌：
- `miniprogram/app.ts` `onLaunch` 调 `wx.cloud.init({ env: CLOUD_ENV || undefined, traceUser: true })`，
  随后 `wx.cloud.callFunction({ name: "login" })` 取 openid 存入 `globalData.openid`（仅用于拼云存储路径）。
- 所有业务鉴权由**云函数侧**完成：`cloud.getWXContext().OPENID` 自动识别调用者身份，
  各云函数内显式 `if (!OPENID) return { error: "未登录" }` + `where({ _id, openid: OPENID })` 归属校验。

## 对技能分包的推论

- 分包调用 `wx.cloud.callFunction` 时 OPENID 由云开发链路自动携带，**无需 ensureLogin()**。
- 唯一前置：`wx.cloud.init` 必须在分包内自行完成（独立分包不共享主包初始化）→ `utils/util.js ensureCloudInit()`。
- 云环境 ID：主包 `miniprogram/utils/config.ts` 的 `CLOUD_ENV`（当前为空字符串 = 默认环境），
  分包硬编码同一值，改动时两处同步。

## 主包 storage / globalData

- 主包 `app.ts` 无 `wx.setStorageSync` 初始化语句 → 分包无需 `ensureStorageInit()`。
- `globalData.openid` 仅用于前端拼 `materials/{openid}/...` 云存储路径；技能分包不收集
  材料上传能力（`wx.cloud.uploadFile` 不在接口侧白名单），故无需复刻。

## 逐字代码片段

```ts
// miniprogram/app.ts onLaunch（节选）
const { CLOUD_ENV } = require("./utils/config");
wx.cloud.init({
  env: CLOUD_ENV || undefined,
  traceUser: true,
});
```

```ts
// miniprogram/utils/config.ts（节选）
export const CLOUD_ENV = "";
```
