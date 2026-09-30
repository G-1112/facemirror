# 面镜 FaceMirror

> 在小程序里选一道题或上传自己的简历，对着手机说 3 分钟，60 秒内拿到能力雷达图、逐句批注和改进建议，生成可分享的成绩卡片。

一款 **AI 表达力练习微信小程序**，覆盖「课堂展示 → 课程答辩 → 求职面试」连续链路。

- 前端：微信原生 + TypeScript（无跨端框架）
- 后端：微信云开发（云函数 + 云数据库 + 云存储）
- AI：腾讯云 ASR（语音识别）+ DeepSeek/通义千问/GLM（大模型）
- 亮点：**自定义出题**（上传简历生成追问）+ **规则化表达分析**（语速/填充词/口头禅/停顿）

---

## 目录结构

```
facemirror/
├── miniprogram/             # 小程序前端
│   ├── pages/               # index/question/record/result/history
│   ├── components/          # radar-chart / sentence-note / share-poster
│   ├── skills/facemirror/   # 小程序 AI 技能分包（wx.modelContext，启用见 docs/小程序AI技能接入指南.md）
│   ├── utils/               # api.ts / expression.ts / recorder.ts / config.ts
│   └── app.ts / app.json
├── cloudfunctions/          # 云函数（Node.js，10 个）
│   ├── login / submitPractice / asr / analyze / finalize
│   └── genQuestions / getPractice / getQuestions / getHistory / updateTranscript
├── data/questions/          # 80 题题库 JSON
├── docs/                    # 作品说明文档（7 项）/ prompt-log / 小程序AI技能接入指南
└── README.md
```

---

## ⚡ 快速上手

### 0. 环境要求

- 微信开发者工具（最新稳定版）
- 已注册小程序 AppID 并开通**云开发**（云开发需非个人主体/已实名，具体以官方为准）
- Node.js 18+（仅云函数本地依赖安装需要）

### 1. 打开项目

> **必填占位清单（共 3 处，均为账号相关、无法随仓库预填）——已全部填写**：
> ① `project.config.json` 的 `appid`：✅ 已填（微信小程序真实 AppID）；
> ② `miniprogram/utils/config.ts` 的 `CLOUD_ENV`：✅ 已填（`cloudbase-d1g6atosn49a1b532`，另同步至 `miniprogram/skills/facemirror/utils/util.js` 副本）；
> ③ 订阅消息模板 ID：✅ 已填（模板「测评报告生成通知」，`utils/config.ts` 的 `SUBSCRIBE_TEMPLATE_ID` = `2Zn06BIC9A3qoLl53hm3yhVICpQVerh6X0hT-Pd0RCk`；**云函数 `finalize` 的环境变量还需部署时配同名值**，见 §云函数部署）。

1. 微信开发者工具 → 导入项目 → 选择本目录；
2. ~~把 `project.config.json` 里的 `appid` 换成你自己的 AppID~~（已填）；
3. ~~在 `miniprogram/utils/config.ts` 填入云开发环境 ID（`CLOUD_ENV`）~~（已填）。

### 1.5 本地类型检查（可选）

仓库已提交 `package-lock.json`（根目录 + 11 个云函数各一份），
用 `npm ci` 可**严格按锁文件**安装，保证与作者环境一致：

```bash
# 根目录：TypeScript 类型检查所需
npm ci          # 严格按 package-lock.json 安装（推荐）
npm run tsc     # 等价于 tsc --noEmit
npm test        # 云函数安全/越权回归测试（无需开发者工具，node 直跑）

# 若需安装云函数的本地依赖（一般不必，云端会自动装）
for d in cloudfunctions/*/; do (cd "$d" && npm ci); done
```

> **为什么要 `npm ci` 而不是 `npm install`**：`npm ci` 只读锁文件、版本完全可复现；
> `npm install` 会按 `^` 范围重新解析，可能装到不同版本。
>
> **依赖漏洞扫描**：锁文件到位后即可运行（注意本机 npm 若指向 npmmirror 镜像，
> 该镜像未实现 audit 接口，需显式指定官方源）：
> ```bash
> npm audit --registry=https://registry.npmjs.org
> ```

### 2. 开通云开发

1. 点击工具栏「云开发」，创建环境；
2. 创建数据库集合：`users`、`practices`、`questions`；
3. `questions` 集合导入 `data/questions/questions.json`（见 `data/questions/README.md`）。

### 3. 部署云函数

对 `cloudfunctions/` 下每个目录：右键 → 「上传并部署：云端安装依赖」。

### 4. 配置云函数环境变量

在云开发控制台 → 云函数 → 每个需要 Key 的函数「配置 → 环境变量」中设置：

| 变量 | 用到 | 说明 |
|---|---|---|
| `LLM_API_KEY` | analyze / genQuestions | 大模型 Key（不填则降级 mock） |
| `LLM_BASE_URL` | analyze / genQuestions | 默认 `https://api.deepseek.com` |
| `LLM_MODEL` | analyze / genQuestions | 默认 `deepseek-chat` |
| `TENCENT_SECRET_ID` | asr | 腾讯云 SecretId（不填则走人工输入） |
| `TENCENT_SECRET_KEY` | asr | 腾讯云 SecretKey |
| `SUBSCRIBE_TEMPLATE_ID` | finalize | 订阅消息模板 ID |

### 5. 编译运行

编译小程序 → 真机预览（录音、分享、订阅消息需真机）。

---

## 需要哪些 Key

| 能力 | 必需？ | 说明 |
|---|---|---|
| 大模型（DeepSeek/千问/GLM） | 可选 | 不填则评估降级为规则化 mock，仍可跑通 |
| 腾讯云 ASR | 可选 | 不填则跳过语音识别，走「人工输入转写」兜底（FR-06） |
| 订阅消息模板 ID | 可选 | 不填则跳过报告完成通知 |

**核心原则**：0 Key 也能跑通主链路（录音 → 人工输入转写 → 规则化评估 → 报告），
接入 Key 后升级为真·语音识别 + 大模型点评。

---

## 核心设计

### 云函数异步链（绕开 20 秒超时）

```
录音 → 云存储 → submitPractice(写 pending) → asr(转写) → analyze(评估) → finalize(通知)
                                                      客户端每 3s 轮询 record 状态
```

### 双引擎评估

- **LLM 语义**：相关性 / 结构 / 论据 / 专业度（各 1-5 分，必须引用原话作证据）
- **规则表达**：语速 / 填充词 / 口头禅 / 长停顿 / 时长分配 → delivery / 节奏 分
- 五维雷达 = 内容(相关性+论据) / 结构 / 表达(规则) / 节奏(规则) / 专业度

### 报告缓存

历史记录重复查看不重复调用 LLM（报告随记录落库，零成本）。

---

## 隐私与合规

- 用户上传材料与转写文本过 `security.msgSecCheck` 内容安全检测（审核硬性要求）；
- 仅通过 `wx.login` 获取 openid，不强制手机号授权；
- `app.json` 已声明 `"__usePrivacyCheck__": true`（隐私接口检查生效）；
- **发布/体验版前必做**：在 mp.weixin.qq.com 后台「设置 → 服务内容声明 → 用户隐私保护指引」
  勾选**麦克风（录音）、相册（仅写入）**两项权限的用途说明——录音与保存海报均属
  隐私接口，未配置指引会导致真机上直接调用失败；
- 含隐私协议（提交审核前需补充完整版）。

---

## 提交材料命名

`第九届传智杯-AI小程序赛道-面镜`（ZIP ≤ 300MB），含源代码、演示视频、作品说明文档、体验二维码截图。

## 许可

参赛作品，仅用于展示与学习。
