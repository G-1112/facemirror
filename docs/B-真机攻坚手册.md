# 面镜 · 真机攻坚手册

> 目标：把「云开发未开通 / ASR 未接 / 真机零实测」三个缺口，在一次连续作业内全部关掉，
> 并产出可提交的取证材料（截图 8 张 + 录屏 + 体验二维码）。
>
> 前置状态（2026-10-26 实测）：`npm test` **12 个测试文件 / 431 条断言 / 85 个场景**全过、
> `tsc --noEmit` 通过（断言数用 `node scripts/count_assertions.js` 复现）、
> `node scripts/static_check.js` 8 个页面 0 缺陷、15 个云函数代码完整；
> **云开发环境已开通**（环境 ID `cloudbase-d1g6atosn49a1b532`，15 个云函数 CLI 实测 status=Active，
> 其中 5 个深度面试函数另经 `python scripts/verify_cloud_deploy.py` 做 md5 逐文件比对一致）；
> **真机全链路仍需本手册逐项取证**。
>
> 作业时长估算：首次 4–6 小时（含排障），熟练后 90 分钟。

---

## 阶段 0 · 前置体检（先做，否则后面全是白工）

### 0.1 确认 IDE 与 CLI 可用

```bash
# 确认版本（能打印命令列表即 CLI 可用）
"D:\tools\微信web开发者工具\cli.bat" -v
```

- 打开 IDE → 设置 → 安全设置 → **服务端口：开启**（CLI 依赖它）。
- IDE 已登录（右上角头像非灰）。

### 0.2 已修复的代码缺陷（本次审计发现，勿回退）

| 文件 | 问题 | 后果 | 状态 |
|---|---|---|---|
| `cloudfunctions/asr/config.json` | **原本不存在** | `cloud.openapi.security.msgSecCheck` 未登记 → 报 `-604101` → `assertSafe` 走 fail-close → **每一次 ASR 转写都失败**，用户只能手动输入 | ✅ 已补 `permissions.openapi=["security.msgSecCheck"]` |
| `cloudfunctions/genQuestions/config.json` | 同上 | 上传简历出题必然报「内容安全检测暂不可用」 | ✅ 已补 |
| `cloudfunctions/updateTranscript/config.json` | 同上 | 人工修正转写必然报同样错误 | ✅ 已补 |
| `cloudbaserc.json` | `envId` 为 `{{envId}}` 占位符 | 用 CloudBase Framework 部署会失败 | ✅ 已填 `cloudbase-d1g6atosn49a1b532` |
| `data/questions/README.md` | 让导入 `questions.json`（JSON 数组） | 云开发导入只认 JSON Lines，会导入 0 条 | ✅ 已改为 `questions.import.json` |

官方依据：云调用必须在云函数目录 `config.json` 的 `permissions.openapi` 声明所需接口，
否则无法调用，未登记时返回 `-604101`；配置有 **10 分钟缓存**，刚上传即报错请等 10 分钟再试。
（[微信官方 · 云调用](https://developers.weixin.qq.com/miniprogram/dev/wxcloud/guide/openapi/openapi.html)）

### 0.3 记录三个「不可回滚」的现状值

先抄下来，后面排障要用：

```
AppID             : wx5f84fd45875f4924
云环境 ID          : cloudbase-d1g6atosn49a1b532
订阅模板 ID        : 2Zn06BIC9A3qoLl53hm3yhVICpQVerh6X0hT-Pd0RCk
```

---

## 阶段 1 · 开通云开发环境（约 10 分钟）

1. IDE 工具栏点「云开发」→ 开通 → 计费选「按量付费 / 免费额度」。
2. 若已有环境：确认 **环境 ID 与上面完全一致**（`cloudbase-d1g6atosn49a1b532`）。
   不一致时改两处：`miniprogram/utils/config.ts` 的 `CLOUD_ENV`、
   `miniprogram/skills/facemirror/utils/util.js` 副本。

**验收**：云开发控制台能打开，左侧有「数据库 / 存储 / 云函数」三个入口。

---

## 阶段 2 · 建库建集合（约 10 分钟）

### 2.1 代码里真正用到的集合（grep 实测，共 5 个）

| 集合 | 谁在用 | 缺了会怎样 |
|---|---|---|
| `practices` | submitPractice / getPractice / getHistory / asr / analyze / updateTranscript / finalize | **主流程直接崩**，一条记录都写不进去 |
| `quota` | asr（20 次/日）、analyze（30 次/日） | 代码 catch 后**保守放行** → 配额静默失效，可被刷爆计费 |
| `rate_limits` | genQuestions | 代码 catch 后**静默失败** → 出题限流失效（这也是 `npm test` 里那行 `db.command.gte is not a function` 的来源，测试环境无真实命令对象，属预期） |
| `questions` | getQuestions | 抽题返回空数组，首页「开始练习」点不动 |
| `interviews` | deepSession / deepAnalyze（深度面试） | **深度面试会话无处存放** → 简历页生成题目后保存失败，进答题页报「面试记录不存在」 |

> ★`interviews` 漏建是本链路部署最常见的坑。云函数是自动部署的，**数据库集合必须手动建**。
> 代码侧已把 `-502005`（集合不存在）识别出来，弹窗会直接告诉你
> 「数据库集合 interviews 不存在，请先在云开发控制台创建该集合（权限选「仅创建者可读写」）」，
> **不要再根据「请重试」去反复重试**。

> 旧文档写的「users / practices / questions 三个集合」是错的：代码里没有 `users`，
> 但有 `quota` 与 `rate_limits`。按旧文档建库会踩两个静默降级。

### 2.2 权限规则（逐个集合 → 权限设置 → 自定义安全规则）

```json
// practices：仅创建者可读写（IDOR 修复的落地前提）
{ "read": "doc.openid == auth.openid", "write": "doc.openid == auth.openid" }

// quota：仅创建者可读写
{ "read": "doc.openid == auth.openid", "write": "doc.openid == auth.openid" }

// rate_limits：云函数写入，客户端不可读
{ "read": false, "write": false }

// questions：所有人可读，仅管理端可写（导入用控制台，不开放客户端写）
{ "read": true, "write": false }

// interviews：仅创建者可读写（深度面试会话，含用户的简历与作答内容，敏感度高）
{ "read": "doc.openid == auth.openid", "write": "doc.openid == auth.openid" }
```

**验收**：5 个集合都在，且 `practices` 与 `interviews` 的权限**不是**「所有用户可读写」
——否则 IDOR 修复等于白做，且用户的简历内容会泄露。

### 2.3 导入题库

```bash
# 导入文件必须用 questions.import.json（JSON Lines，80 行）
# questions.json 是 JSON 数组，导入会得到 0 条
```

控制台 → 数据库 → `questions` → 导入 → 选 `data/questions/questions.import.json` → JSON 格式。

**验收**：集合记录数 = **80**。

---

## 阶段 3 · 部署 15 个云函数（约 10 分钟）

### 3.1 用脚本部署（推荐，可复现）

```bash
cd "E:\葛铭坤\26传智\团队赛\微信小程序\facemirror"

# 先干跑看命令对不对（不会上传）
python scripts/deploy_cloud.py

# 真部署（按依赖顺序：login → getQuestions → genQuestions → submitPractice
#           → getPractice → getHistory → updateTranscript → asr → analyze → finalize）
python scripts/deploy_cloud.py --apply

# 核对云端函数清单
python scripts/deploy_cloud.py --check
```

> 脚本现状：干跑已验证（2026-10-23，生成 10 条命令全部正确）；
> `--apply` 需 IDE 已登录 + 服务端口开启，**首次执行请盯着输出**。

### 3.2 用 IDE 手动部署（脚本不可用时的退路）

对 `cloudfunctions/` 下每个目录：右键 → **上传并部署：云端安装依赖**。
顺序同上，`login` 先上，方便最早验证连通性。

### 3.3 部署后必须手改的两处超时

`config.json` 只能声明 openapi 权限，**不能设超时**；`cloudbaserc.json` 里的 60s
只在走 CloudBase Framework 部署时生效。用 IDE/脚本部署后：

云开发控制台 → 云函数 → `asr` → 配置 → 超时时间 **60 秒**
云开发控制台 → 云函数 → `analyze` → 配置 → 超时时间 **60 秒**

> 为什么要 60s：`asr` 内部两段式轮询预算 12s + 创建任务，`analyze` 要等 LLM 返回；
> 留默认 20s 时长音频会被强杀（代码注释里已写明这个前提）。
> **截图存档**：`截图/D01-超时配置.png`

**验收**：`cli cloud functions list` 输出 10 个函数，`asr` / `analyze` 的 Timeout 显示 60。

---

## 阶段 4 · 注入 6 个环境变量（约 10 分钟）

控制台 → 云函数 → 选中函数 → 配置 → 环境变量。

| 函数 | 变量 | 取值 | 不配的后果 |
|---|---|---|---|
| `analyze`、`genQuestions` | `LLM_API_KEY` | DeepSeek/通义/GLM 的 Key | 降级 `mockEval`：报告能出，但点评是模板话术，**没有逐句批注与示范回答** |
| 同上 | `LLM_BASE_URL` | `https://api.deepseek.com`（通义填 `https://dashscope.aliyuncs.com/compatible-mode/v1`） | 默认 DeepSeek |
| 同上 | `LLM_MODEL` | `deepseek-chat` / `qwen-plus` / `glm-4-flash` | 默认 deepseek-chat |
| `asr` | `TENCENT_SECRET_ID` | 腾讯云子账号 SecretId（需 `QcloudASRFullAccess` 策略） | 走 mock：空转写 + 手动输入兜底（**演示可接受，但视频必须说明**） |
| `asr` | `TENCENT_SECRET_KEY` | 同上 SecretKey | 同上 |
| `finalize` | `SUBSCRIBE_TEMPLATE_ID` | `2Zn06BIC9A3qoLl53hm3yhVICpQVerh6X0hT-Pd0RCk` | 返回「未配置」，**不影响主链路** |

> ⚠️ 腾讯云 ASR 用的是**腾讯云账号**的 SecretId/Key，不是微信的 AppSecret，
> 也不是 DeepSeek 的 Key——这是最容易搞混的一处（旧文档已标注过）。
> 子账号授权：访问管理 → 用户 → 关联策略 → `QcloudASRFullAccess`。

**验收**：每个函数配置页能看到对应变量（值是否打码以控制台为准）。
**截图存档**：`截图/D02-环境变量.png`（任选一个函数页面即可）

---

## 阶段 5 · 逐函数冒烟（约 20 分钟，核心排障环节）

在控制台 → 云函数 → 选中 → **云端测试**，逐个喂下面的 event。
顺序很重要：先 login，最后 finalize。

### 5.1 `login`

```json
{}
```
预期：`{"openid":"oXXXX..."}`。拿到这个 openid 后面要用。
❌ 返回空 → 云环境 ID 不对，或 `CLOUD_ENV` 与实际环境不一致。

### 5.2 `getQuestions`

```json
{ "scene": "interview", "limit": 2 }
```
预期：`{"questions":[{...},{...}]}`，两条题目文本不同。
❌ `{"questions":[]}` → 题库没导入（回到 2.3）。

### 5.3 `submitPractice`（手动造一条记录，后面 asr/analyze 都靠它）

```json
{ "scene": "interview", "questionText": "请做一个简单的自我介绍", "audioFileID": "", "durationSec": 0 }
```
预期：`{"recordId":"xxxx"}`。**记下这个 recordId**。

> 注意：云端测试的 `OPENID` 来自**控制台测试身份**，不一定是小程序里那个 openid。
> 因此下面 asr/analyze 用云端测试跑时，归属校验可能通过（同一次测试身份），
> 但**真机链路必须重跑一遍**——这也正是「冒烟 ≠ 真机实测」的原因。

### 5.4 `asr`

```json
{ "recordId": "上一步的 recordId" }
```
三种预期，对应三种配置状态：

| 返回 | 含义 | 下一步 |
|---|---|---|
| `{"status":"asr_done","transcript":"...","needManual":false}` | ASR 通了 | 直接进 5.5 |
| `{"status":"asr_running"}` | 任务未完成（正常） | 客户端会自动续查，云端测试可再点一次 |
| `{"status":"asr_done","transcript":"","needManual":true}` | 未配腾讯云凭证 → mock | 手动输入兜底，主链路仍可演示 |
| `{"error":"内容安全检测暂不可用..."}` | **`msgSecCheck` 权限未生效** | 见 §9.1 |

### 5.5 `analyze`

```json
{ "recordId": "同一个 recordId" }
```
预期：`{"status":"done","report":{"totalScore":..,"radar":[..5个数..],"expression":{...},"strengths":[...],"sentenceNotes":[...]}}`。
❌ `{"error":"转写文本为空..."}` → 5.4 没成功，先补 `updateTranscript` 填一段文本再回来。

### 5.6 `updateTranscript`（人工修正入口）

```json
{ "recordId": "同上", "transcript": "各位老师好，我是软件工程专业的应届毕业生，今天想用三分钟介绍一下我的项目经历。" }
```
预期：`{"ok":true}`；随后 `practices` 里该记录 `status` 回落为 `asr_done`、旧 `report` 被清空。

### 5.7 `getPractice` / `getHistory`

```json
{ "recordId": "同上" }
```
```json
{ "page": 1, "pageSize": 10 }
```
预期：前者返回 `status/transcript/report`；后者返回 `{"list":[...],"total":>=1}`。

### 5.8 `genQuestions`（需先有材料 fileID）

```json
{ "fileID": "cloud://cloudbase-d1g6atosn49a1b532.xxxx/materials/xxx.txt", "scene": "interview" }
```
预期：`{"questions":[{"question":"...","target":"...","difficulty":"..."}]}`。
❌ 报「他人材料」→ fileID 与当前 openid 不匹配（越权保护生效，属正常）。

### 5.9 `finalize`

```json
{ "recordId": "同上" }
```
预期：`{"ok":true}` 且手机收到一次服务通知；未配模板 ID 时 `{"ok":false,"error":"未配置 SUBSCRIBE_TEMPLATE_ID"}`。
❌ `-604101` → `finalize/config.json` 的 `subscribeMessage.send` 权限有 10 分钟缓存，等一会儿再试。

---

## 阶段 6 · 小程序端真机全链路（约 40 分钟）

### 6.1 编译前

- IDE → 详情 → 本地设置：勾「不校验合法域名」（开发期）；
- 正式体验版需把 `LLM_BASE_URL` 的域名加进 request 合法域名
  （DeepSeek 为 `https://api.deepseek.com`）；
- 公众平台 → 设置 → 服务声明 → **用户隐私保护指引**：勾选
  **麦克风（录音）**、**相册（仅写入）** 两项用途，否则真机调用直接失败
  （`app.json` 已声明 `__usePrivacyCheck__: true`）。

### 6.2 真机跑一遍并计时

按 `docs/B-真机实测清单.md` 的 A→I 九组执行，**边跑边填表**：

| 环节 | 开始 | 结束 | 耗时 | 结果 |
|---|---|---|---|---|
| 首屏加载 | | | | |
| 抽题返回 | | | | |
| 录音 60s → 上传完成 | | | | |
| ASR 返回转写 | | | | |
| 报告渲染完成 | | | | |
| 海报保存成功 | | | | |

> 文档里「60 秒内出报告」「ASR 字准确率 ≥92%」目前都是**目标值不是实测值**。
> 跑完照实回填：如果实测是 78 秒，就写 78 秒，并写明机型与网络；
> 写实测数字比写漂亮数字安全得多。

### 6.3 计时取证方式

用另一台手机录屏（含系统时钟），或 IDE 真机调试面板的 Network 时间轴。
**不要**用秒表估——评委问「怎么测的」要答得出来。

### 6.4 ★深度面试链路真机联调（约 20 分钟，新增链路必测）

前置：`interviews` 集合已建好且权限为「仅创建者可读写」；
5 个云函数已部署并经 `python scripts/verify_cloud_deploy.py` 校验一致。

| # | 操作 | 预期 | 异常时查 |
|---|---|---|---|
| D-01 | 首页点「深度面试 · 简历驱动」 | 进入 `pages/resume`，步骤条显示「1 上传简历」 | 首页 `onDeep` 的 nav-guard 是否卡住 |
| D-02 | 点「选择简历文件」→ 选一个 `.txt`（含教育/项目/技能） | 云存储上传 → 解析 → 进入「2 核对解析」 | `parseResume` 日志；文件ID 是否含 `/{openid}/` |
| D-03 | 看解析结果页 | 教育/经历/项目/获奖/技能 5 类分区展示；顶部标签显示「AI 识别」或「规则识别」 | 若显示「规则识别」说明 LLM Key 未配 → 属预期降级，不是 bug |
| D-04 | 填岗位名（如「后端开发工程师」）→ 点「下一步：填写目标岗位」 | 出现「岗位能力评估标准」6 个维度 + 权重 | `analyzeJob` 日志 |
| D-05 | 点「生成 15~20 道面试题」 | 题目列表 15~20 道，每道带「依据：xxx」 | `genDeepQuestions` 日志；若报「题目数量不足」说明简历信息太少 |
| D-06 | 点「开始逐题作答」 | 进入 `pages/deep`，显示「第 1 / N 题」、题型标签、**出题依据** | — |
| D-07 | 点「查看追问」/「查看答案要点提示」 | 折叠区展开 | — |
| D-08 | 写一段 ≥5 字的回答 → 点「提交并下一题」 | **立刻显示本题得分 + 命中/遗漏要点**；自动跳到第 2 题 | 若提交后看不到得分 → `applyQuestion` 的 `keepFeedback` 被改坏 |
| D-09 | 写到一半 → 小程序切后台 30 秒 → 回到前台 | **正在输入的内容不丢** | `loadSession` 的 `hasDraft` 判定 |
| D-10 | 全部答完 | 自动跳「深度面试 · 总结报告」页 | — |
| D-11 | 报告页 | 六维雷达 + 6 条维度分 + 优势 + 短板 + 4 类建议 + 逐题点评 | 雷达长度必须为 6 |
| D-12 | 中途退出小程序 → 重新进入 → 继续答 | **回到上次没答的那题**（云端续答） | `interviews` 集合里该文档的 `currentIndex` | 
| D-13 | Console 检查 | 无红色 error；`msgSecCheck` 若报 61010/45009 属**平台侧配额/访问记录**，已被降级策略兜住 | — |

**取证建议**：D-02（解析结果）、D-05（题目列表）、D-08（单题得分反馈）、D-11（六维报告）四张截图最关键。

---

## 阶段 7 · 取证清单（缺一项都不算完成）

| # | 文件名 | 内容 | 来源用例 |
|---|---|---|---|
| 1 | `截图/A01-首屏.png` | 首页三场景卡片 | A-01 |
| 2 | `截图/C01-录音中.png` | 录音计时界面 | C-01 |
| 3 | `截图/C02-转写修正.png` | ASR 结果 + 可编辑输入框 | C-02 |
| 4 | `截图/D01-雷达报告.png` | 五维雷达 + 总分 | D-01 |
| 5 | `截图/D02-逐句批注.png` | 批注卡片（含原句/问题/建议） | D-02 |
| 6 | `截图/E01-历史列表.png` | 历史记录分页 | E-01 |
| 7 | `截图/F01-海报.png` | 分享海报成品 | F-01 |
| 8 | `截图/I01-配额拦截.png` | 「今日练习次数已达上限」 | I-01 |
| 9 | `截图/D03-超时配置.png` | 控制台 asr/analyze 60s | §3.3 |
| 10 | `截图/D04-环境变量.png` | 环境变量配置页 | §4 |
| 11 | `截图/J01-体验二维码.png` | 体验版二维码 | 阶段 8 |
| 12 | `演示视频/01-核心链路.mp4` | 录音→报告全流程（真机画面） | 阶段 8 |

> 命名规则沿用「用例编号-描述」，与《B-真机实测清单》一一对应，评委一眼能对上。

---

## 阶段 8 · 提交体验版并取二维码（约 20 分钟）

1. IDE → 上传 → 版本号 `1.0.0`，备注「表达力练习首版」；
2. 公众平台 → 版本管理 → 提交审核（**先确认隐私指引已配**，否则必被驳回）；
3. 审核通过后 → 「体验版」→ 下载二维码 → 存 `截图/J01-体验二维码.png`；
4. 录演示视频：真机 + 屏幕录制，覆盖「选场景 → 抽题 → 录音 → 转写 → 报告 → 海报」。

> 若审核周期来不及：先用**体验版**（不需要审核）截图与录屏，文档里写「体验版已可完整跑通，
> 正式版审核中」——不要写成「已上线」。

---

## 阶段 9 · 失败处置手册

### 9.1 `-604101` / 「内容安全检测暂不可用」

| 可能原因 | 判断 | 处置 |
|---|---|---|
| `config.json` 未上传或未生效 | 控制台看函数配置里 openapi 权限为空 | 重新部署该函数；**等 10 分钟**（有缓存） |
| 主体资质不支持事件级检测 | 权限已登记仍报权限类错误 | 见下方应急降级 |
| 传参不合法 | 报参数错误而非权限错误 | 检查 `content` 长度（已截 2500）、`version:2`、`scene:2` |

**降级策略（已于 2026-10-26 正式实现，不再需要手工改代码）**：

新增共享模块 `cloudfunctions/{asr,genQuestions,updateTranscript}/sec-check.js`
（云函数不能跨目录 require，三份为同源副本，由测试保证一致）。
核心契约：

| 情形 | 处置 | 理由 |
|---|---|---|
| 检测正常 + 判定 `risky`（违规） | **拒绝**，返回 `{ error: "内容包含违规信息…" }` | 微信 UGC 审核硬要求，绝不放行 |
| 检测服务不可用（`61010` / `45009` / `-604101` / `-1` / `44991` / `-501001`） | **放行 + 留痕**（`seccheck:"unavailable"`、`seccheckReason:<原始 errMsg>`） | 平台侧原因与本项目代码无关，不应让主链路断裂 |
| 检测正常 + `pass` | 放行，留痕 `seccheck:"pass"` | 正常路径 |

> ⚠️ **降级不是「跳过检测」**：检测服务正常时严格检测、违规必拒；
> 仅在平台接口本身不可用时才降级，且**留痕可审计** ——
> 可在云数据库筛出 `seccheck == "unavailable"` 的记录做人工复核。
> 这一条必须如实写进作品说明文档。

**官方错误码速查**（`msgSecCheck`，小程序可用）：

| errCode | 含义 | 本项目是否降级 |
|---|---|---|
| `61010` | 用户访问记录超时（**用户未在近两小时访问小程序**） | ✅ 降级 |
| `45009` | 超出每日调用配额（**未上架小程序仅 100 次/天**） | ✅ 降级 |
| `44991` | 超出每分钟调用限制 | ✅ 降级 |
| `-604101` | 云调用无权限（声明后约 10 分钟缓存期） | ✅ 降级 |
| `-1` / `-501001` | 系统繁忙 / 云端系统错误 | ✅ 降级 |
| `40001` / `40003` | access_token 无效 / openid 不合法 | ❌ 抛错 |
| `40129` | scene 值错误 | ❌ 抛错 |
| `43104` | appid 与 openid 不匹配 | ❌ 抛错 |

> ⚠️ **`61010` 在开发者工具模拟器里必现**：模拟器的 openid 访问记录不刷新，
> 而官方要求「用户需在近两小时访问过小程序」。真机不受影响。

### 9.2 `asr` 超时 / `asr_running` 一直不结束

- 先确认超时已是 60s（阶段 3.3）；
- 录音超过 5 分钟时 ASR 本身耗时长，客户端 8 次退避续查后仍可能未完成 → 属可接受，
  文档写「≤3 分钟录音可稳定出报告」比写「任意时长」稳；
- 检查音频是否真的传上去了：云存储 → `audio/` 目录。

### 9.3 `analyze` 一直 mock（报告没有逐句批注）

`LLM_API_KEY` 没生效。检查：变量名拼写、是否配到了 `analyze` 而不是只配了 `genQuestions`
（两个函数各配一份，**不共享**）、`LLM_BASE_URL` 末尾是否多了斜杠（代码已处理，但确认服务商地址对）。

### 9.4 `getHistory` 空 / `getPractice` 报「无访问权限」

- 云端测试的 openid 与真机 openid 不同 → 各自只能看自己的记录，属正常；
- 集合权限若设成「所有用户可读写」，`where({openid})` 仍能查，但安全性已破 → 回到 2.2 改规则。

### 9.5 `submitPractice` 报 `database collection not exists`

`practices` 集合没建，或建在了**另一个环境**。回到阶段 2 核对环境 ID。

### 9.6 ★`errCode -504002`（云函数执行失败）

**先纠正一个常见误判**：`-504002` 官方定义是「**云函数执行失败**」，
即**云函数已经部署、但运行时报错** —— **不是**"云函数没部署"。
（`-501001` 才是"云端系统错误"，也不是"云函数不存在"。）

本项目 2026-10-26 用开发者工具 CLI 实测过：15 个云函数**全部已部署且状态 `Active`**（其中 5 个深度面试函数另经 md5 逐文件比对一致），
所以再遇到 `-504002`，直接按"函数内部抛异常"排查，别再去重传云函数。

排查三步：

1. **看客户端 Console** —— 代码已把完整 errMsg 打到控制台，形如：
   ```
   [云函数] updateTranscript 调用失败: cloud.callFunction:fail errCode -504002 functionName:updateTranscript, message:内容安全检测暂不可用，请稍后重试（原因：…）
   ```
   `message:` 后面才是**真实原因**；`functionName:` 只是函数名，不是错误描述。
2. **看云函数日志** —— 云开发控制台 → 云函数 → 对应函数 → 日志，看完整堆栈与栈顶报错行。
3. **按原因对症**：

| `message:` 里的原因 | 处置 |
|---|---|
| `内容安全检测暂不可用（原因：…）` | 见 9.1：openapi 权限未声明 / 10 分钟缓存期 / 主体不支持 |
| `记录不存在或无访问权限` | 归属校验失败 → 确认 `openid` 与 `recordId` 匹配（见 9.4） |
| `未登录` | 云函数里 `getWXContext().OPENID` 为空 → 检查调用方是否已 `wx.cloud.init` 并完成登录 |
| `缺少 recordId` | 客户端参数缺失 → 检查 `call()` 的 data 字段 |
| `Cannot read property … of undefined` | 云函数内部空指针 → 看日志定位具体行，常见是环境变量未注入 |

> 客户端已把「长文案截断 + 完整原因进 modal」处理好（`utils/api.ts` 的 `showCallError`），
> 用户端看到的是中文短提示 + 可展开的完整原因，**开发者排障请直接看 Console**。

---

## 阶段 10 · 收尾（别漏，这几条直接影响评分）

1. 把《B-真机实测清单》的「✅/⚠️/❌ + 取证文件名」补齐，**删掉所有未执行的空行**；
2. 回填真实实测数字到 `docs/作品说明文档.md` §e，并删除「（待真机实测）」标注；
3. README 的「需要哪些 Key」表按实际配置情况改写（哪些配了、哪些走 mock）；
4. 若走了 mock（ASR 或 LLM），在文档显式声明：「当前为 mock 模式，核心链路完整，接入 Key 后升级为真实能力」；
5. 提交前重跑一次 `npm test` 与 `npm run tsc`，把输出贴进 README 的「测试记录」；
6. 更新 `docs/B-真机实测清单.md` 顶部的实测日期与机型。

---

## 附 · 一张图看懂依赖顺序

```
阶段0 体检
   ↓
阶段1 开通环境 ──→ 阶段2 建 4 集合 + 权限 ──→ 2.3 导入 80 题
   ↓
阶段3 部署 10 函数（config.json 已带 openapi 权限）──→ 3.3 asr/analyze 超时改 60s
   ↓
阶段4 注入 6 个环境变量
   ↓
阶段5 云端测试逐函数冒烟（login 先上，submitPractice 造记录，再 asr → analyze）
   ↓
阶段6 真机全链路 + 计时
   ↓
阶段7 取证 12 项  ──→ 阶段8 体验版 + 二维码 + 录屏
   ↓
阶段10 文档回填（删掉「待实测」，写真实数字）
```

**判定标准**：阶段 5 全绿 ≠ 真机通过。只有阶段 6 跑通、阶段 7 取证齐、阶段 10 文档回填完毕，
才算这个缺口真正关掉。
