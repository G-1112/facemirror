# 小程序 AI 技能接入指南（面镜 · skills/facemirror）

> 本文档是 `miniprogram/skills/facemirror/` 技能分包的**启用说明书**。
> 技能代码已生成并通过静态校验（V001~V021，0 error），但 `app.json` 集成**刻意留为手动步骤**——
> 因为当前仓库 `appid = touristappid`、正式 AppID 尚未开通「小程序 AI 开发模式」，
> 预先写入 `agent.skills` 可能在未开通的账号上引起预览/上传告警。
> 完成下列 3 步前，技能分包不参与运行，对现有功能零影响。

## 这是什么

微信「小程序 AI」（`wx.modelContext`）允许用户在微信 AI 对话中直接调用小程序能力。
接入后用户可以对着微信 AI 说「给我出道面试题」「我上次练习多少分」，
由 `skills/facemirror` 的 3 个原子接口应答，并经 handoff 卡片接力进小程序开口作答：

| 原子接口 | 能力 | 接力页 |
|---|---|---|
| `drawQuestion` | 抽一道面试/答辩/展示题 | `/pages/question/question`（预设题目，直接开练） |
| `getPracticeHistory` | 查本人练习历史与得分 | `/pages/history/history` |
| `getPracticeReport` | 查某次练习报告摘要 | `/pages/result/result?recordId=...` |

设计上**刻意只暴露只读能力**：录音作答、材料出题等需要真实交互/文件上传的链路
（`wx.cloud.uploadFile` 不在技能分包白名单）留在小程序内，由 handoff 引导进入。

## 启用步骤（约 15 分钟 + 平台审核）

### 1. 开通小程序 AI 开发模式

微信公众平台 → 基础功能 → AI 能力 → 申请「开发模式」（需正式 AppID，游客模式不可用）。
调试基础库需 ≥ 3.16.2。

### 2. `miniprogram/app.json` 追加两处配置

```json
{
  "agent": {
    "skills": [
      {
        "name": "facemirror",
        "description": "面试表达力练习：抽练习题目、查询练习历史、查看评估报告",
        "path": "skills/facemirror"
      }
    ]
  },
  "subPackages": [
    { "root": "skills", "name": "skills", "pages": [], "independent": true }
  ]
}
```

- `app.json` 顶层已有 `"lazyCodeLoading": "requiredComponents"` ✓（技能分包的硬前置，已满足）
- 主包 `app.ts` 的 `wx.onAgentHandoff` 接收器**已注册**（带特性探测，未开通时不触发）

### 3. `project.config.json` 打包包含 skills 目录

```json
"packOptions": {
  "include": [{ "type": "folder", "value": "skills" }]
}
```

注意：`project.config.json` 里的路径相对**仓库根**，若开发者工具以仓库根为项目目录
（`miniprogramRoot: miniprogram/`），include 值应为 `miniprogram/skills` 对应的目录配置，
以开发者工具实际提示为准。

### 4. 真机闭环校验（wxa-skills-validate）

开通后在本机执行（需要已安装微信开发者工具并开启服务端口）：

```bash
node validate.mjs <项目根>     # 静态校验（当前已通过）
node execute.mjs --project <项目根> --name drawQuestion --args '{"scene":"interview"}' --output ./cli-agent-run/execute-result.drawQuestion.json
# getPracticeHistory 无参 → 先执行；getPracticeReport 从其 structuredContent.list[0].recordId 取参后执行
```

全部 execute 通过后按 `wxa-skills-validate` 技能产出 `DELIVERY.md`。

## 已完成的验证

- 静态校验 V001~V021：**0 error**（报告见 `.workbuddy` 校验产物 / 审查报告附录）
- handoff query 参数名与接力页 `onLoad` 读取字段人工核对一致
  （question 页读 `scene/mode/question`；result 页读 `recordId`；history 页无参）
- 体积自查：mcp.json ≈ 3 KB（上限 24 KB）、SKILL.md ≈ 1 KB（上限 16 KB）

## 未完成的验证（诚实标注）

- **未真机 execute**：本机无微信开发者工具 CLI、AppID 未开通 AI 开发模式；
  代码已按 `[ai-mode:static]` 标注（见各文件头注释），响应字段取自云函数源码消费点
  （`.ai-mode-skills/analysis-apis.md`），非抓包实测。
