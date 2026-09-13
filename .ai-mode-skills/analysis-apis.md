# analysis-apis — 面镜（facemirror）原子接口规格

> wxa-skills-generate 阶段 3 产物。sampleSource: static-source（无 probe 环境：本机无微信开发者工具 CLI，
> AppID 为 touristappid 且未开通小程序 AI 开发模式）。响应字段取自云函数源码消费点。

## drawQuestion（抽一道练习题目）

- 真实入口：`pages/question/question.ts loadRandom()` → `getQuestions({ scene, limit: 1 })`
- 云函数：`cloudfunctions/getQuestions/index.js`
  - 入参：`{ scene = "interview", category?, limit = 1 }`（limit 服务端夹到 1..20；
    `presentation` 在云函数内映射为 `interview` + `category=通用`，分包透传即可，与主包行为一致）
  - 返回：`{ questions: [{ _id, scene, category, text, difficulty }] }`；题库为空返回 `{ questions: [] }`
- 鉴权：云函数校验 OPENID（自动）
- handoff：`/pages/question/question`，query 参数名以该页 `onLoad(query)` 读取为准：
  `query.scene` / `query.mode` / `query.question`（`mode=retry` 时直接使用 `question` 作为预设题目）
- 空结果语义：题库未导入时合法为空 → 返回文本说明，不带 handoff

## getPracticeHistory（查询我的练习历史）

- 真实入口：`pages/history/history.ts load()` → `getHistory({ page, pageSize: 10 })`
- 云函数：`cloudfunctions/getHistory/index.js`
  - 入参：`{ page = 1, pageSize = 10 }`（pageSize 服务端夹到 1..20；只返回本人 status=done 记录）
  - 返回：`{ list: Practice[], total, page, pageSize }`，Practice 含
    `{ _id, scene, questionText, transcript, status, durationSec, report?, createdAt }`
  - 响应归一化：report 体积大，分包只取 `{ recordId=_id, scene, questionText, status, totalScore=report?.totalScore, createdAt }`
- 鉴权：云函数按 OPENID 隔离（自动）
- handoff：`/pages/history/history`，该页 `onLoad()` 不读取任何参数 → `handoff: { query: "" }`

## getPracticeReport（查看某次练习的评估报告）

- 真实入口：`pages/result/result.ts load()` → `getPractice(recordId)`
- 云函数：`cloudfunctions/getPractice/index.js`
  - 入参：`{ recordId }`（服务端归属校验：非本人记录返回 error）
  - 返回：`{ status, transcript, sentences, scene, questionText, durationSec, report }`，
    report 含 `{ totalScore, dimensions, radar, strengths, improvements, modelAnswer, sentenceNotes, expression, overall }`
  - 响应归一化：分包只取 `{ status, scene, questionText, durationSec, totalScore, overall }`
- 鉴权：云函数按 OPENID 隔离（自动）
- handoff：`/pages/result/result`，该页 `onLoad(query)` 读取 `query.recordId`

## 未收集的能力（及原因）

| 能力 | 原因 |
|---|---|
| 录音作答 / ASR / AI 评估（submitPractice/asr/analyze/finalize） | 需要真实录音交互，AI agent 无法代替用户说话；由 drawQuestion 的 handoff 引导进小程序完成 |
| 材料自定义出题（genQuestions） | 需先 `wx.cloud.uploadFile` 上传材料，该 JSAPI 不在技能分包接口侧白名单（JSAPI_WHITELIST §1 仅列 init/callFunction/database），无法合规实现 |
| 转写修正（updateTranscript） | 依赖录音产物上下文，低频编辑操作，留在小程序内 |
| login | 基础设施：云函数经 OPENID 自动鉴权，非用户直接能力 |
| 敏感接口 | 项目无注销/删除/解绑类接口 |

## 可行性

三个接口均为 ✅ 高置信：真实入口唯一、参数/返回路径清晰、均为只读或低风险调用。
