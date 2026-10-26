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

1. 点击工具栏「云开发」，创建环境（环境 ID 须与 `miniprogram/utils/config.ts` 的 `CLOUD_ENV` 一致）；
2. 创建 **4 个**数据库集合（代码 grep 实测，勿按旧文档建 `users`——代码里没有它）：

   | 集合 | 权限 | 缺了会怎样 |
   |---|---|---|
   | `practices` | 仅创建者可读写 | 主流程崩，记录写不进去 |
   | `quota` | 仅创建者可读写 | 配额静默失效（catch 后放行），可被刷爆计费 |
   | `rate_limits` | 仅管理端可写 | 出题限流静默失效 |
   | `questions` | 所有用户可读 | 抽题返回空，首页点不动 |

3. `questions` 集合导入 **`data/questions/questions.import.json`**（JSON Lines，80 行）。
   不要导入 `questions.json`——那是 JSON 数组，云开发导入只认每行一条，会导入 0 条。
   详见 `data/questions/README.md`。

**验收**：4 个集合存在，`questions` 记录数 = 80，`practices` 权限不是「所有用户可读写」。

### 3. 部署云函数

**方式 A（推荐，可复现）**：用 CLI 脚本批量部署，顺序与依赖关系已固化：

```bash
python scripts/deploy_cloud.py           # 干跑：只打印命令，不上传
python scripts/deploy_cloud.py --apply   # 真部署（需 IDE 已登录 + 服务端口开启）
python scripts/deploy_cloud.py --check   # 核对云端函数清单
```

**方式 B**：对 `cloudfunctions/` 下每个目录右键 → 「上传并部署：云端安装依赖」，
建议先上 `login`，方便最早验证连通性。

> **两个易踩的坑（都已处理，别改回去）**：
> 1. `asr` / `genQuestions` / `updateTranscript` 会调用 `security.msgSecCheck`，
>    必须在各自目录的 `config.json` 里声明 `permissions.openapi`，否则报 `-604101`。
>    该配置有 10 分钟缓存，刚上传即报错请等一会儿。
>    → 2026-10-26 起改为**共享模块 `sec-check.js`**（三份同源副本）：
>    **违规必拒**（UGC 审核硬要求）；**检测服务不可用则降级放行 + 留痕**
>    （`seccheck:"unavailable"` / `seccheckReason`），不再让平台接口故障
>    把「录音 → 转写 → 评估 → 报告」整条主链路卡死。详见《真机攻坚手册》§9.1。
> 2. 超时**无法**在 `config.json` 设。部署后须去云开发控制台把 `asr` / `analyze` 改成 **60 秒**，
>    否则长音频会被默认超时强杀。
>
> **🔴 排障：页面只弹一个没意义的 toast**
>
> 三种典型形态，各自的成因完全不同：
>
> | 现象 | 含义 | 处理 |
> |---|---|---|
> | toast 弹 **`cloud.callFunction`** | 代码只取了 `e?.message`，而微信框架只把方法名放进 message | **代码侧已修**（见 `utils/api.ts` 的 `describeCallError`）。现在会显示中文短提示 + Console 打印 `[云函数] <函数名> 调用失败: <完整 errMsg>` |
> | toast 弹 **`errCode -504002 fun…`** | 官方定义 = **云函数执行失败**（= 已部署但**运行时报错**，**不是**未部署）。`fun` 是 errMsg 里的 `functionName:<函数名>` 被截断 | **看 Console 里 `[云函数] <函数名> 调用失败:` 那一行的完整 errMsg**，`message:` 字段才是真实原因；再去 云开发控制台 → 云函数 → 对应函数 → 日志 看堆栈 |
> | toast 弹 **`api scope is not de…`** | 平台层错误（errno 112）：mp 后台未声明「访问你的麦克风」隐私类型 | 见上文《隐私与合规》，**后台配置，代码改不了** |
>
> 错误码含义以微信开放文档《错误码》表为准
> （https://developers.weixin.qq.com/miniprogram/dev/wxcloud/reference/errcode.html ），几个容易记错的：
> `-504002` = 云函数执行失败 · `-501001` = 云端系统错误（**不是**"云函数不存在"）·
> `-604101` = 无权限调用此 API，需给云函数配置云调用权限 · `-604102` = 调用超时。
>
> ⚠️ **别再把 `-504002` 当成"云函数未部署"**。2026-10-26 用开发者工具 CLI 实测：
> 本项目 **10 个云函数全部已部署且状态 `Active`**（`updateTranscript` timeout 20 / `analyze` timeout 60 /
> runtime Nodejs16.13，依赖 `wx-server-sdk ~2.6.3` 完整）。
> 所以 `-504002` 一律按「**云函数内部抛了异常**」处理 —— 去 `message:` 字段和云函数日志里找真因。
>
> **📌 本项目实例（2026-10-26）**：`updateTranscript` 报 `-504002`，
> 真实原因在云函数日志里：`msgSecCheck` 调用失败。
> 根因是**平台侧**的 `msgSecCheck` 不可用，不是本项目代码 bug ——
> 最常见三个：`61010`（用户未在近两小时访问小程序，**开发者工具模拟器必现**）、
> `45009`（**未上架小程序每日仅 100 次**调用配额）、
> `-604101`（云调用权限声明后有约 10 分钟缓存期）。
> 现已按上述策略降级放行，主链路不再被平台接口故障阻断。
>
> **一键确认云端缺哪个函数**（只读探测，不写库、不推送、不调 LLM）：
> 临时在 `miniprogram/pages/question/question.ts` 的 `onLoad` 开头加
> `require("../../../tests/diag_cloud.js");`，编译后 Console 会逐个列出 10 个云函数的部署状态，
> 并指出哪些缺失。用完删掉该行。
>
> **命令行核对云端清单**（需 IDE「设置 → 安全设置 → 服务端口」开启）：
> ```bash
> # 列出云端已有云函数（这是事实，不是推测）
> "D:/tools/微信web开发者工具/cli.bat" cloud functions list
> # 看单个函数的 status / timeout / runtime
> "D:/tools/微信web开发者工具/cli.bat" cloud functions info --name updateTranscript
> ```
>
> **云函数部署完整性**
>
> 部署顺序见 `scripts/deploy_cloud.py` 的 `ORDER`：
> `login → getQuestions → genQuestions → submitPractice → getPractice → getHistory → updateTranscript → asr → analyze → finalize`。
> **中途任一函数部署失败，后面的都不会自动部署** —— 这是最常见的"跑到一半才发现后面全缺"。
>
> 补齐方式（二选一）：
> - 逐个：开发者工具里对 `cloudfunctions/<函数名>` 目录右键「上传并部署：云端安装依赖」
> - 批量：`python scripts/deploy_cloud.py --apply`
>   （需先在 IDE「设置 → 安全设置 → 服务端口」开启；`--check` 可核对云端清单）
>
> ⚠️ 刚上传完的云函数，openapi 权限有 **10 分钟缓存期**，期间报 `-604101` 属正常，等一会儿即可。
> ⚠️ `asr` / `analyze` 需在云开发控制台把超时改成 **60 秒**（`config.json` 设不了）。
>
> 完整排障流程见 [`docs/B-真机攻坚手册.md`](docs/B-真机攻坚手册.md)。

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

### ⚠️ 状态锁铁律（2026-10-26 四次线上事故沉淀，必读）

本项目先后踩过**同一个根因家族**的四个坑：
「题目永远加载中…」/「开始练习按钮点不动」/「保存海报按钮点不动」/「录音页卡在处理中」。
共同点是——**某个 `state flag` 被置 `true` 后，只有唯一一条路径能把它置回 `false`**。

**规矩**：

| 规矩 | 说明 |
|---|---|
| ① 不用 `disabled="{{flag}}"` 做防重入 | `disabled` 会同时禁用控件**并**阻断 `bindtap`。flag 一旦卡在 true，按钮就**永久不可用**，用户只能重启小程序。正确做法：按钮**永不禁用**，flag 只做视觉反馈（文案/透明度），防重入用 JS 侧 early-return |
| ② 防重入锁必须有"不依赖回调"的解锁路径 | `wx.navigateTo` 的 `success`/`fail` 回调**可能都不触发**（页面栈满 / 路由被拦截 / 目标页加载中）。只靠回调复位 = 定时炸弹 |
| ③ 锁用**时间戳**而非布尔 | 有效期判断 → 锁**自动过期，永不永久卡死** |
| ④ 每个置 `true` 的 flag 至少 2 处置回 `false` | 成功分支 + `catch`/`finally` 分支，且**每条置 true 路径都能到达至少一条置 false 路径** |
| ⑤ 回归测试要断言"失败路径也能自愈" | 造一个"回调都不触发"的桩，断言页面能自动恢复——只测正常路径等于没测 |
| ⑥ 业务前置条件 ≠ 防重入 | 「没题目/加载中」是**业务前置**，要在 JS 层拦截并给**可操作提示**；「连点」才是防重入。两者混为一谈会让用户看到灰按钮却不知道为什么 |
| ⑦ **状态机必须逐状态核查出口** | 多状态页面（录音页 8 态）里，`switch` 的 `default` 分支是最危险的位置——它会命中**所有**没显式列举的状态。多状态机用 `default: this.onStartRecord()` 兜底，用户在「上传中」点主按钮就会重开一条并行链，状态互相覆盖。**改多状态页面时，先画出状态转移表，逐个确认每个状态都有出口** |

**统一实现**：`miniprogram/utils/nav-guard.ts`

本项目所有**导航类**防重入场景都走这一个守卫，不再各页各写一遍：

```ts
// Page 生命周期
this._guard = createNavGuard({
  onLockChange: (locked) => { if (this.alive) this.setData({ navigating: locked }); },
});
// 业务入口
if (!this._guard.tryLock()) return;   // 窗口内 → 忽略连点
wx.navigateTo({ url, success: () => this._guard.unlock(), fail: () => this._guard.unlock() });
// onUnload 里必须
this._guard.dispose();
```

守卫内部 4 重保险：`navigateTo` 回调 → `onShow` 兜底复位 → 3s 看门狗 → 时间戳锁自动过期。

> **注意**：录音页（`pages/record/record.ts`）是**状态机**而非导航页，
> 它的防重入靠**状态白名单**而非 `nav-guard`——见下方《录音页状态机》。

**已接入的页面/组件**：

| 位置 | 锁 | 业务前置条件的处理 |
|---|---|---|
| `pages/index/index.ts` | `navigating` | — |
| `pages/question/question.ts` | `navigating` | 没题目→"请先获取题目"；加载中→"题目加载中，请稍候"；加载失败→"加载失败，请先点「重新加载」" |
| `components/share-poster/share-poster.ts` | `saving` | — |
| `pages/record/record.ts` | 状态白名单 + `_modalOpen` / `_manualPending` / `_submitting` | 长任务态→"正在处理中，请稍候"；非 editing 态→"正在处理中，请稍候" |

**对应回归测试**：

| 测试 | 覆盖 | 断言数 |
|---|---|---|
| `tests/nav_guard.test.js` | 守卫本身（自动过期 / dispose / 可控时钟边界） | 7 场景 |
| `tests/index_start_button.test.js` | 首页按钮可点性 + WXML 铁律 | 6 场景 |
| `tests/question_go_button.test.js` | 出题页「去作答」+「换一题」+ 业务前置分流 | 7 场景 |
| `tests/share_poster_save_button.test.js` | 海报「保存到相册」**成功/失败/销毁三条解锁路径** | 7 场景 |
| `tests/record_state_machine.test.js` | 录音页 8 态状态机（每个状态的出口 + 失败路径自愈） | 12 场景 |

> ⚠️ 组件（`Component()`）的 TS 类型**不接受顶层自定义字段**，
> 守卫要挂到实例上：`(this as any)._guard = createNavGuard(...)`。

---

### 🎙️ 录音页状态机（8 态，`pages/record/record.ts`）

录音页是本项目**状态最复杂**的页面，8 个状态：

```
idle ──onStartRecord──> recording ⇄ paused
  │                        │  │
  │                   onStop│  │onStop / 超时
  │                        ↓  ↓
  └──createManualRecord──> stopping ──onRecordStop──> uploading ──runAsr──> transcribing
                             │  ↑(失败)                    │(失败)                │(失败)
                             ↓  │                          ↓                     ↓
                          editing <────runAnalyze失败──── editing <──needManual── editing
                                                                    │
                                                                成功→ analyzing ──redirectTo──> 结果页
```

**每个状态都有出口**，2026-10-26 逐状态核查时修掉了 7 个缺陷：

| # | 缺陷 | 后果 | 修法 |
|---|---|---|---|
| 1 | `onRecordTap` 用 `default: onStartRecord()` 兜底 | 长任务态点主按钮会**重开一条录音链**，与仍在跑的 `uploadAndSubmit`/`runAsr` 状态互相覆盖；`runAsr` 跑完还会 `redirectTo` 把用户强行弹走 | 改**白名单分派**：只有 `idle` 能开始录音，其余状态提示"正在处理中，请稍候" |
| 2 | `onStartRecord` 在 `await checkRecordAuth()` 后不复查 `status` | await 期间用户点了「结束作答」，之后仍会 `start()` → 两个录音生命周期并存 | await 后复查 `status !== "idle"` 则中止并提示 |
| 3 | `onStartRecord` 失败分支不复位状态 | 停在「录音中」但**根本没在录**，倒计时还在走 | catch 里 `clearTimer()` + 归位 `idle` |
| 4 | `onStop` 不判 `recorder.stop()` 返回值、不接异常 | 永久卡「正在结束录音…」，用户以为程序死了 | `stop()` 改为返回 `boolean`（是否真的发起了停止），`false` 或抛异常 → 归位 `idle` + 提示 |
| 5 | `onRecordStop` 无 `alive` 守卫 | 页面卸载后迟到回调仍启动整条上传/识别/评估链 | 开头加 `if (!this.alive) return;` |
| 6 | `runAnalyze` 的 `wx.redirectTo` 无 `fail` 回调 | 跳转失败（页面栈满等）→ 永久卡「AI 评估中…」，而数据其实已算好 | 补 `fail`：归位 `editing`，用户可改文本重试 |
| 7 | `onConfirmTranscript` 无防重入 | 连点「确认并生成报告」并发跑两条 `updateTranscript`+`analyze` 链，配额双扣、两次 `redirectTo` 抢跳 | 加 `_submitting` 闸门 + `status !== "editing"` 前置校验 |

**WXML 侧同步收紧**：「结束作答」按钮的条件由 `status !== 'idle'` 改为
`status === 'recording' || status === 'paused'` —— 把前置条件写死在按钮上，
即使外层 `record-area` 的条件将来被改宽，也不会出现「在 uploading 态还能点结束」的死按钮。

**底层 `utils/recorder.ts` 的两个关键修复**：

1. **看门狗必须先于 `manager.stop()` 安装**：原实现是「先 `manager.stop()` 再装看门狗」，
   而 `manager.stop()` 在状态异常时会**同步抛异常** → 抛出后看门狗代码根本不执行 →
   `onStop` 回调永远不来 → 页面卡死。现在改为先装看门狗，再调 `manager.stop()`，
   并在 catch 里**立即**触发一次 `timedOut` 兜底回调。
2. **`start()` 必须先 `clearTimer()`**：连点「开始作答」触发两次 `start()` 时，
   前一次的时长定时器会泄漏 → 旧定时器到点后触发 `stop()` → **刚开的录音被提前掐断**。

> ⚠️ `wx.getRecorderManager().stop()` **概率性不触发 `onStop`**（微信官方社区 2019-01-24 原帖：
> 「模拟器上就三四下就不触发了」，vivo/oppo 真机为重灾区）。
> 这是录音页必须保留看门狗兜底的根本原因，**不要为了"简化"而删掉**。

---

## 隐私与合规

### 🔴 阻塞项：录音功能必须先在 mp 后台声明「麦克风」隐私类型

**症状**（开发者工具点「开始作答」即报）：
```
start:fail api scope is not declared in the privacy agreement   // errno 112
```

**官方依据**——《小程序隐私协议开发指南 · 五、常见错误说明》原文：
> 「A:fail api scope is not declared in the privacy agreement, errno: 112
>   使用到了 A 隐私接口，但是开发者未在『MP后台-设置-服务内容声明-用户隐私保护指引』
>   中声明收集 A 接口对应的隐私类型。**补充的隐私类型声明，将在 5 分钟后生效。**」

**这是平台配置项，代码改不了。** 未声明时微信会**直接禁用**录音接口（不是"拒绝授权"，
是"接口不可用"），用户改手机设置也没用。

**修复路径**：
1. 登录 mp.weixin.qq.com → **设置 → 服务内容声明 → 用户隐私保护指引 → 更新**
2. 勾选 **「访问你的麦克风」**（录音）与 **「保存到相册」**（分享海报写入），填写用途
3. 提交审核 → 通过后**等待约 5 分钟**生效
4. 开发者工具：**清缓存 → 清除授权数据** → 重新编译

> 排查工具：临时在 `miniprogram/pages/record/record.ts` 的 `onLoad` 开头加
> `require("../../../tests/diag_privacy.js");`，编译后 Console 会自动输出
> 「隐私协议状态 / 麦克风授权状态 / 是否命中 errno 112」的判定结论，用完删掉该行。

### 代码侧已做的适配（`miniprogram/utils/privacy.ts`）

| 场景 | 处置 |
|---|---|
| errno 112（后台未声明） | `showModal` 给出**后台配置路径**（含"5 分钟生效"），不误导用户去设置页 |
| 用户未同意隐私协议（103/104） | `showModal` 提示去同意《用户隐私保护指引》 |
| 用户拒绝过麦克风授权 | 录音前 `wx.getSetting` 预检 → `showModal` 引导 `wx.openSetting()` |
| 未知错误 | 兜底中文 toast，不再抛英文原文 |

> 设计取舍：**不主动调 `wx.authorize`**——微信要求它必须在用户点击的同步回调里调用，
> `await wx.getSetting()` 之后再调会丢失手势上下文、iOS 直接失效；改为让
> `recorder.start()` 由系统自动弹权限框。**不注册 `wx.onNeedPrivacyAuthorization`**——
> 官方说明未响应时微信会自动弹**官方隐私弹窗**，零维护。

### mp 后台《用户隐私保护指引》完整填写清单（逐格对照，可直接复制）

> 官方模板原文见《小程序用户隐私保护指引内容介绍》。以下每格都已对照本仓库代码核实。

| 表单位置 | 填什么 | 依据 |
|---|---|---|
| **1. 开发者处理的信息 → 访问你的麦克风 → 用途** | 用于录制你在本小程序中的面试/答辩/课堂展示作答音频，作为语音识别输入转写为文字，并据此生成表达力评估报告。录音保存在你的微信云开发空间，并传输至腾讯云语音识别服务完成转写。 | `recorder.ts` → `submitPractice` → `asr`（腾讯云 ASR）→ `analyze` |
| **1. 开发者处理的信息 → 使用你的相册（仅写入）→ 用途** | 用于将本次评估结果生成的分享海报（雷达图、总分与改进建议）保存到你的手机相册，供你自行留存或分享。本小程序不会读取你相册中的任何内容。 | `share-poster.ts` 仅调 `wx.saveImageToPhotosAlbum`，全项目**无** `chooseImage`/`chooseMedia`/`getSavedPhotosInfo` |
| **2. 开发者对信息的存储** | 选「开发者承诺，除法律法规另有规定外，开发者对你的信息的保存期限应当为实现处理目的所必要的最短时间」 | ⚠️ **不要选"固定 180 天"**——本项目代码里**没有实现音频自动清理**（`cloudfunctions/` 全量 grep 只有 `updateTranscript` 的 `_.remove()` 删 `report` 字段），写死天数会与实际行为不符 |
| **3. 你的权益 → 联系方式（邮箱或手机号）** | 填你的真实邮箱或手机号。⚠️ **这会公开展示在小程序「关于本小程序 → 隐私保护指引」里**，请填一个愿意公开的 | 官方要求提供可联系渠道以行使查阅/复制/更正/删除权 |
| **4. 第三方插件 / SDK 信息** | 填**「无」** | `package.json` 的 `dependencies` 只有 `miniprogram-api-typings`（纯类型定义，非运行时 SDK）；小程序端未接入任何第三方插件/SDK |
| **6.1 信息的使用规则** | 官方默认表述，**不用改** | — |
| **6.2 再次以 [____] 方式告知** | **`弹窗`** | 官方标准模板原文即「再次以**弹窗**方式告知并征得你的明示同意」。若想更明确可写「重新弹窗」；**这是承诺性条款，将来真要扩展隐私用途必须真的重新弹窗**——本项目用微信官方隐私授权弹窗机制（未自绘弹窗），能兑现 |
| **7. 信息对外提供** | 保留官方默认表述；建议在补充说明里加一句「语音识别由腾讯云语音识别服务（受托处理）完成，仅处理识别所必需的音频」 | `asr` 云函数用 `cloud.getTempFileURL` 生成临时链接交腾讯云 ASR，属**委托处理**而非对外共享 |
| **更新日期 / 生效日期** | 填实际提交日 | — |

**两个容易踩的坑**：
1. **只勾代码里真用到的隐私类型**。勾了不用 → 审核会追问用途；漏勾用到的 → 直接 errno 112 禁用接口。
2. **审核通过 ≠ 立刻生效**。接口权限约 5 分钟生效，但**整份指引的审核通过可能要 1~7 个工作日**，期间「版本管理」里仍需另提交版本审核。

### mp 后台「用途」文案（与代码实际行为逐条对齐，可直接复制）

后台需勾选两项隐私类型（**只勾代码里真正用到的**）：

| 后台选项 | 用途文案（直接复制） |
|---|---|
| **访问你的麦克风** | 用于录制你在本小程序中的面试/答辩/课堂展示作答音频，作为语音识别输入转写为文字，并据此生成表达力评估报告。录音保存在你的微信云开发空间，并传输至腾讯云语音识别服务完成转写。 |
| **使用你的相册（仅写入）** | 用于将本次评估结果生成的分享海报（雷达图、总分与改进建议）保存到你的手机相册，供你自行留存或分享。本小程序不会读取你相册中的任何内容。 |

**写文案的三条硬约束（与本仓库代码一一核实过）**：
1. **不要写"仅本次使用后即删除"** —— 代码里**没有删除音频的逻辑**
   （`cloudfunctions/` 全量 grep 只有 `updateTranscript` 里的 `_.remove()`，删的是 `report` 字段）。
   音频实际长期保存在云存储 `audio/` 路径下。
2. **腾讯云 ASR 要如实写出** —— 与 README §技术栈、`docs/作品说明文档.md` 已披露的一致；
   若后台另有「第三方处理者 / 共享」章节，按实际情况一并填写。
3. **相册是纯写入** —— `miniprogram/` 全量只有 `wx.saveImageToPhotosAlbum`，
   无 `chooseImage` / `chooseMedia` / `getSavedPhotosInfo`，故可声明"不读取相册内容"。

### 提交后

审核通过 → **约 5 分钟**生效 → 开发者工具「清缓存 → 清除授权数据」→ 重新编译 →
首次点「开始作答」会弹微信**官方隐私授权弹窗**，点「同意」即可。

### 其他合规项

- 用户上传材料与转写文本过 `security.msgSecCheck` 内容安全检测（审核硬性要求）；
- 仅通过 `wx.login` 获取 openid，不强制手机号授权；
- `app.json` 已声明 `"__usePrivacyCheck__": true`（隐私接口检查生效）；
- 含隐私协议（提交审核前需补充完整版）。

---

## 提交材料命名

`第九届传智杯-AI小程序赛道-面镜`（ZIP ≤ 300MB），含源代码、演示视频、作品说明文档、体验二维码截图。

## 许可

参赛作品，仅用于展示与学习。
