<!-- 搬自 AGENTS.md（2026-10-06 拆分：注入预算 65,536 B，超出部分每轮被截断永不可见）。
     内容逐字节原样保留；本文件按需阅读，不进每轮注入。
     本文件是「常见开发任务」的续篇（主文件只留头部导航）。 -->

## 常见开发任务（续：调试与协议排障）

### ⚠️⚠️ 测试里取仓库路径**必须用 `fileURLToPath`，不能用 `URL.pathname`**（Issue IKLBSH A3）

**真实缺陷**：`URL.pathname` 对路径里的空格做**百分号编码**
（`D:\Vibe coding\…` → `/D:/Vibe%20coding/…`），而原先的
`new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')`
只修**盘符前缀**、**不修 `%20`** ⇒ 仓库路径含空格时 `readFileSync` 恒 ENOENT。

⚠️ **症状极具误导性**：vitest 把它报成**整份 spec 收集失败**
（`Error: ENOENT … scandir`，不是单个用例失败），看起来像测试基建坏了，
而不是「路径判据错了」。且**本机路径不含空格时永远看不到** —— 本地全绿、
报障者全红。

修法：
```ts
import { fileURLToPath } from 'node:url'
const here = fileURLToPath(new URL('.', import.meta.url))   // 目录，末尾带分隔符
```

⚠️ **`new URL('.', …)` 给的是目录，`URL.pathname` 给的是文件路径** ——
换成 `fileURLToPath` 后**不要再套 `path.dirname`**：我改的第一版多套了一层，
把 `tests/unit` 削成 `tests`，实测 ENOENT（`aggregate-panel-logic.spec.ts`）。

**涉及 4 个 spec、6 处**：`aggregate-badge.spec.ts`、`aggregate-panel-logic.spec.ts`
（1 处顶层 + 3 处函数内）、`auto-badge-restore.spec.ts`。

⚠️ **反向验证的边界（对抗审计实测证伪了「可验证性」）**：把 6 处全部改回
`URL.pathname` ⇒ 那 3 个 spec 在**本机当前路径（不含空格）下 98 条全绿**。
即「改回去在本机全绿」——这条修复是**结构性**的，逐文件变异验证**测不出来**。

⇒ 已补 `tests/unit/path-source-read.spec.ts`，用**两条互补判据**把它变成
「所有人都会红」：
1. **活体**：在临时目录里真建一个**含空格**的目录，断言
   `fileURLToPath` 得到的路径**可读**、`URL.pathname` 得到的**不可读**
   （阳性对照——若 Node 哪天改了 `pathname` 行为，该格会红）；
2. **结构性扫描**：`tests/` 下任何 `import.meta.url).pathname` **用法**都判违规
   （剥注释后匹配，避免把讨论该写法的注释误判）。此判据**与仓库路径无关**，
   故在任意环境下都能抓住回归。

⚠️ **该扫描必须排除它自己**：守卫 spec 的用例标题与报错文案里**必然**出现那串
被禁写法（否则说不清「禁止什么」）—— 本 spec 第一版漏了这一步，**立刻自伤**
（自己扫自己）。守卫类 spec 的惯例：`resolve(fileURLToPath(import.meta.url))`
与扫描结果比对后剔除自身。

- **响应根本不是 SSE**（网关直接回了 JSON，没有任何 `data:` 帧）：
  早期同样静默空结束。现抛错并**带上原文片段**，否则用户只能看到一个没有原因的失败。

回归用例：`tests/unit/qoder-silent-stop.spec.ts`。

#### ⚠️ 名称为空的 `tool_call` 会**跨 provider 传染**，让整条会话报废

**真实缺陷**（用户报障，2026-09-23）：在 zed 会话里给
`workbuddy/deepseek-v4.1-flash` 发一条**带图片**的任务，**每次都**报：

```json
{"code":11133,"msg":"the request parameters were rejected by the model provider",
 "extError":{"code":"model_param_invalid","param":"","StatusCode":400}}
```

⚠️ 该文案**不指出是哪个字段**，且与图片、工具、思考档位全都无关 —— 极易误判成
「这个模型不支持图片」。**逐项排除法**（`scripts/probe-workbuddy-image.mjs`
与 `scripts/confirm-empty-tool-name.ts` 已固化）：

| 被排除的假设 | 实测反证 |
|---|---|
| 图片 wire 形态（`{type:'image'}` / 裸 base64 / `image_url`） | 正确形态一律 200；错误形态报 **11101**（parse failed），不是 11133 |
| 33 个工具的 schema（逐个单测 + 全量） | 全部 200 |
| `thinking` / `reasoning_effort` / `max_tokens` | 单独去掉后**仍** 400 |
| input + `max_tokens` 超上下文 | `max_tokens` 降到 **64** 仍 400；短历史 + `max_tokens: 900000` 反而 200 |
| 重复 `tool_call_id`、中段 system 消息 | 变换后仍 400 |

**真凶**：会话历史里有一条 **`name:''` 的 `tool_call`**：

```json
{"type":"tool-call","id":"call_25e97a78849f449da444fc72","name":"","arguments":"{}"}
```

**实测最小复现**（wire 上的 `function.name` → 上游结果）：

| `function.name` | 结果 |
|---|---|
| `"read"` | 200 |
| `"unknown_tool"`（**不存在的**工具名） | 200 ← 上游**只校验非空，不校验存在性** |
| `""` / `null` / 缺失 | **400 code 11133** |

**来源是 qoder**（所以叫「跨 provider 传染」）：其 SSE 偶发一个**完全没有 `name`
字段**的 tool-call 分片（实测 seq=693：`{index:2, id:'call_25e9…', args:[""]}`），
早期 `openai-compat.ts` 在 `block-end` 处 `name: block.name ?? ''` 把它落成空串块 →
harness 执行得到 `unknown tool ""` → 该坏块被**持久化进会话** → 用户切到 workbuddy
后每次请求原样重放 → 400。

**两处修复，缺一不可**：

1. **消费侧（源头，`src/openai-compat.ts`）**：名字可用**之前不发射任何 chunk**
   （连 `block-start` 都不发）。
   ⚠️ **只跳过收尾的 `block-end` 是不够的** —— 上游 `BlockAssembler.assemble()`
   对没有 `block-end` 的 partial 同样会组装出 `name: partial.toolCallName ?? ''`。
   必须让该块**一个 chunk 都不产出**。名字稍后到达时，把**已累积的参数一次性补发**，
   故正常形态（首片即带 name）行为不变。
   同一修法已施加到 `buddy-adapter.ts` / `llm-adapter.ts`（含两条 DSML 分支）/
   `lobsterai-adapter.ts` / `trae-adapter.ts`。
2. **序列化侧（存量会话自愈，`src/sse.ts` 的 `resolveToolPairing`）**：
   发请求前剔除**名称不可用**的 tool_call 及其结果，让**已经坏掉的会话**无需重开即可恢复。
   - 判据用 `hasUsableToolName()`，**不能写成 `String(name).length > 0`** ——
     `undefined` / `null` 经 `String()` 会变成 `"undefined"` / `"null"` 这类**非空**
     字符串，「缺名字」会被误判成「有名字」。
   - **不得连累同批的合法调用**：实测线上形态正是「一个无名 + 一个合法 `pwsh`」，
     整批丢弃会白白损失一次有效调用。结果按 id 匹配，剔一个不破坏另一个的配对。
3. 丢弃了无名调用且**没有**留下任何可用调用时，`finish` 报 `max-tokens`（可重试）
   而非 `stop` —— 否则又是一次「模型本意调工具、harness 却认为正常答完」的无报错中断。

回归用例：`tests/unit/sse.spec.ts`（`resolveToolPairing` / `hasUsableToolName`）、
`tests/unit/qoder-silent-stop.spec.ts`（消费侧不产出空名字块）。
验收脚本：`scripts/verify-workbuddy-image-fix-e2e.ts`（**用线上那条报废会话的真实历史**
重放，判据是修复后 HTTP 200）。

#### ⚠️ 思考死循环会烧满输出额度（Reasoning Loop Guard）

**真实缺陷**（用户报障，2026-09-23）：`workbuddy/deepseek-v4.1-flash` 报
「已达到输出 token 上限，回答被截断」。

⚠️ **先排除一个错误假设**：用户最初怀疑「切换模型后沿用了旧模型的参数」。
**实测否定** —— DSH 的 `prepareCall` → `resolveCallWithInfo` 按**当前**模型解析
`maxTokens`（`dsh-llm/lib/index.js:2111`）；且同一会话 turn 1 **未做任何切换**
就爆额度，切到 lobsterai 后连续两轮正常 `completed`。问题跟着**模型**走。

**真因**：模型思考陷入病态重复：

```
Let me write. / Writing. / Go. / OK. / Producing. / Let me output. / Final.
```

`reasoning_tokens` **计入** `completion_tokens`，故思考停不下来 = 正文零产出。
实测三步全部 `reasoningTokens == outputTokens == 128000`、**无 text 块、无工具调用**。

**判据**（`createReasoningLoopDetector`，`src/sse.ts`）：尾部 3000 字符窗口内
「非空行 ≥40 且去重行比例 <0.35」判为局部循环，且**循环状态须持续 ≥2000 字符**。

⚠️ **「持续体量」这一层不可省**：实测 seq=401 在 14848/15795（94%）处被判局部
循环，但它随即**自愈并产出了工具调用** —— 其持续体量仅 1024，被 2000 正确排除；
三个真死循环的持续体量是 435,968 ~ 509,184。正常样本窗口去重率最低 0.149、
死循环 0.017~0.031（**5 倍余量**），实测**零误报**。

判据选型（正常 109 条 / 死循环 6 条真实样本）：

| 判据 | 正常误报 | 死循环命中 |
|---|---|---|
| n-gram 重复占比 | 0/109 | 2/3 |
| **窗口去重行比例 + 持续体量** | **0/109** | **3/3** |
| 尾部行周期 | 0/109 | 1/3 |

**中断动作**：丢弃后续思考增量 → **`reader.cancel()` 中止上游**（真正止损，见下）
→ 收尾发**截断后的 reasoning block**（保留 `cutAt` 前的干净前缀）
→ `finish` 报 **`error` + `REASONING_LOOP`**（**有分辨力**，见下节；2026-09-29 改判）。

⚠️ **「止损」这一步不可省**（终审 C1，已实测）：只跳过**下行**累积/发射、却把流读到底，
则上游继续生成、**128000 token 照烧**（实测上游 200 帧被读 **200 帧**；守卫在 ~2304
字符即命中，即 99.5% 额度仍被消耗）。

四个必须保留的实现要点：

1. **`block-end` 是权威覆盖**（实测 `scripts/verify-blockend-override.ts`）：
   即便前面已 yield 全部重复 delta，收尾发截断后的 block 即可，**无需撤回**。
2. **命中后 `reader.cancel()` + `break` 出 SSE 读取循环**（止损）。
   ⚠️ **`break` 必须放在内层行循环之后、外层读取循环的末尾** —— 这样同一 chunk 里
   已到达的 `usage` / `[DONE]` 仍会被处理。放进内层 `while` 会整块跳过本 chunk
   剩余行（**实测踩过**：五处首次插入全部误落内层，typecheck 与多数用例都不报错，
   只有「同帧 usage」用例抓到）。
   ⚠️ **绝不能 abort `options.signal`** —— 那是**调用方**信号，abort 会被上层报成
   「用户取消」（`aborted`）而非我们想要的 `error`。只 cancel reader。
   ⚠️ `reader.cancel()` 必须 `.catch(() => {})`：连接已断时会抛错，不吞掉会把
   「正常止损」变成一次失败。
   ⚠️ **不得用 `continue`**（Task 2 审查发现、已实测复现）：`continue` 跳过本帧
   **剩余全部**处理，而 `usage` 与 `tool_calls` 都在 reasoning 分支**之后** ——
   「reasoning + usage 同帧」时 usage 被静默丢弃（实测：混合帧收到 **0 个** usage
   chunk，对照组 **1 个**）。正确写法是 `if (!loopDetected) { … }` 只包住累积与发射。
3. **`loopDetected` 的 finish 优先级高于 `tool_calls`** —— 循环中生成的工具
   调用参数不可信；且若无任何可用调用，落到 `stop` 会让任务**静默中断**
   （与「无报错中断」同族）。
4. **思考判据只喂 `reasoning`** —— 正文里的重复（代码块、列表）在思考通道是正常输出。
   ⚠️ 但**正文有自己的独立守卫**，见下节（2026-09-25 补充）。

开关 `DSH_REASONING_LOOP_GUARD` —— **默认开启**，仅显式假值关闭（与
`DSH_HIDE_MODELS_WITHOUT_ACCOUNT` 同为「默认开」语义，用独立的
`resolveReasoningLoopGuardFlag`，不要与 `isTruthyFlag` 混用）。

六个适配器全部接入（含 codearts 的 `reasoning` 与 `<thought>` **两条**出口）。
回归用例：`tests/unit/reasoning-loop.spec.ts`（判据）、
`tests/unit/reasoning-loop-adapter.spec.ts`（各适配器中断行为）；
fixture 为**真实会话文本**（`tests/fixtures/reasoning-*.txt`）。

#### ⚠️⚠️ 死循环中断**不得复用 `max-tokens`**：必须给有分辨力的错误（Gitee !IKIZNK）

**真实缺陷**（用户报障，2026-09-29）：

> 会话异常问题：**已达到输出 token 上限**回答被截断，已有输出保留在对话中。
> 发送"继续"可让模型接着输出。

用户的原话点明了性质：

> 如果只是陷入思考循环的出错，就要给出**有分辨力**的错误提示，
> 现在用「达到输出 token 上限」是**不对**的。

**根因：DSH 客户端对 `max-tokens` 只有一句固定 i18n 文案，且不读适配器的 message。**
`dsh-client-ui-chat/lib/client.js` 的 `message.maxTokens` / `.hint`：

```
已达到输出 token 上限 / 回答被截断，已有输出保留在对话中。发送"继续"可让模型接着输出。
```

⇒ 于是「**检测到死循环并主动止损**」被显示成「**token 用满了**」，
而那句「发送继续可让模型接着输出」对死循环**恰好是错的建议**。

**全库取证**（219 会话；脚本 `scripts/probe-max-tokens-provenance.mjs`）——
`finish=max-tokens` 的 35 步里：

| 归因 | 步数 | 占比 |
|---|---|---|
| **循环守卫截断**（**不是** token 上限）| **25** | **71%** |
| 真·烧满额度（`output=32000/64000/128000`）| 5 | 14% |
| 上游 `length` / 其他折叠 | 5 | 14% |

⚠️ **判据（决定性，不依赖 usage）**：守卫命中时 `block-end` 只发**截断后的前缀**，
而已流出的 delta 无法撤回 ⇒ **「流出思考总量 − 落块思考量」＝ 被截掉的量**。
这 25 例的截掉量**恒为 1994~1999 字符**（= `minLoopChars` 默认 2000），
被截段行去重率 **0.0114~0.0831**（阈值 `<0.35`），内容形如
`OK. / Hmm. / Hmm. / …`（233× `Hmm.`）、`好。/ 执行。/（写。）/（结束。）`。

⚠️ **这 25 例全部是真循环、零误报** —— 问题**不在判据，在上报方式**
（脚本 `scripts/probe-loop-truncation-content.mjs` 逐例打印被截原文可复核）。

**更严重的副作用：文案里的建议对死循环无效**（脚本
`scripts/probe-continue-after-loop.mjs`）：25/25 例守卫命中之后，用户**都**被迫手动介入：

```
11×  "继续"
 9×  "继续上面未完成的任务"
 1×  "你陷入思考循环了，醒醒。继续上面未完成的任务"   ← 用户自己诊断出来了
 1×  "你的思考陷入死循环了，继续调查上面的问题"       ← 同上
```

且有会话**反复命中同一守卫**（`session-fa` 4 次、`session-8c` 4 次、`session-27` 3 次）。

##### 修法：改报 `error` + `REASONING_LOOP`，**并带「无可见产出」门禁**

为什么 `error` 能把文案送到用户眼前（两条都是实测/源码依据）：

1. UI 的 `failureMessage()` 只对 `AUTH` / `QUOTA` / `ACCOUNT_QUOTA` /
   `ACCOUNT_SIGNED_OUT` / `ACCOUNT_SIGN_IN_REQUIRED` 做**文案替换**，
   **其余码一律原样显示我们的 message**（`dsh-client-ui-chat/lib/client.js`
   的 `failureMessage`）。这正是用户说的「出错5次重试那里会显示失败原因」那条通道。
2. UI 读的是 `reason.error`（`client.js` 的 `failureFrom`），而
   `dsh-llm` 的 `LlmFailure` 形状是 `{message, code, …}` ⇒ **适配器给什么就显示什么**。

⚠️ **但 `error` 路径会丢内容，故必须加门禁**（`dsh-agent-loop/lib/index.js`）：

```js
if (finish.kind === "error" || finish.kind === "aborted") {
  live.settle("assistant/attempt", …)   // ← 只落 attempt（UI 不可见）
  if (action?.kind !== "retry") throw new LlmError(finish.failure.message, …)
}
live.settle("assistant/message", …)     // ← error 走不到这里
```

即 **error 不落 `assistant/message`**，该步已产出内容不进会话历史。
实测（`scripts/probe-error-finish-content-loss.mjs`）：**351 次 `finish=error` 里
222 次该步没有 `assistant/message`** ⇒ 内容确实会丢。

⇒ 故判据必须是「**只是**思考循环」（用户原话里的「只是」正是这层门禁）：

| 命中时的产出 | 报什么 | 理由 |
|---|---|---|
| **只有思考**（实测 25/25 例都是）| `error` + `REASONING_LOOP` | 可见内容为零，报 error 不丢东西，文案有分辨力 |
| 还有正文或工具调用 | `max-tokens`（保持原行为）| 报 error 会把可见内容整块丢掉，更糟 |

实现：各适配器算 `reasoningLoopIsSoleOutput = loopDetected && emittedProse === '' && toolOrder.length === 0`。
⚠️ **codearts（`llm-adapter.ts`）还有一层额外陷阱**：它有「正文为空且无工具调用时
用**推理文本回填正文**」的 `visible` 回退 —— 回退一生效 `visible !== ''`，
判据**恒为假**、永远落回误导性的 `max-tokens`（**静默失效**）。
故该回退必须加 `!loopDetected` 门禁（顺带也修掉了「把循环垃圾回填进正文并持久化」）。

##### 文案三要素（用户明确要求）

用户原话：

> 提示中要加上**当前窗口还有多少可用**，没有真的占满可以尝试继续任务

故 `reasoningLoopFailure()`（`src/sse.ts`）产出：

1. **真实原因**：`模型思考陷入病态重复，已中止本轮（**不是**输出 token 上限）。`
2. **判据数值**：尾部 N 行里只有 M 行不重复（去重率 x.xxx，阈值 <0.35）、连续循环体量。
3. **额度实况 + 建议**：`本次思考仅产出约 N 字符（约 K token），额度 L token 中**还剩约 R**（估算值）——额度没有占满，可以直接继续任务。`
   并附「若继续后再次陷入同一循环，建议降低思考档位或更换模型」。

⚠️ **额度是估算，必须如实标注**：`observedChars` 是**字符数**不是 token 数；
守卫命中时 `reader.cancel()` 已中止上游，`usage` 帧**往往根本没到达**
（实测 25 例中 **0 例**带 usage）。故用「约 1 token ≈ 3.5 字符」估算并写明「估算值」。
系数 3.5 取中文（约 1:1.5~1:2）与英文短句（`OK.`/`Hmm.`，约 1:4~1:5）之间的**保守中值**
—— 宁可低估剩余额度，也不要让用户以为还有很多而反复撞墙。
⚠️ **拿不到 `maxTokens` 时不得编造数字**（与 `maxOutputTokens` 那条口径一致）：
文案退化成「额度没有占满，可以直接继续任务」而不给具体数值。
故 `ConsumeOpenAiSseOptions` 新增可选的 `maxTokens`，由四个调用方（cline / loomy /
raccoon / qoder）透传 `options.maxTokens`。

##### `REASONING_LOOP` **刻意不在**可重试集合里

死循环是**确定性**病理（同上下文会稳定复现），若可重试则白退避 5 次
（500/1000/2000/4000/8000 ≈ 15.5 秒）并**再烧一轮额度**，而每轮可能烧掉几十万 token。
与 `QUOTA_EXCEEDED` / `PERMISSION_DENIED` 的既有口径一致。
验证脚本 `scripts/probe-reasoning-loop-retry-codes.mjs`（只读 `dsh-llm` 产物，
断言 `REASONING_LOOP`/`QUOTA_EXCEEDED`/`PERMISSION_DENIED` **不在**集合里，
而 `SERVER`/`EMPTY_RESPONSE` **在** —— 后者是对照组，防止「不在」只是解析失败）。

##### 回归与验证

- 回归用例 `tests/unit/reasoning-loop-adapter.spec.ts`（30 条）：其中 4 条新增 ——
  「文案有分辨力（含否定 token 上限、判据数值、剩余额度）」「拿不到 maxTokens 时不编造数字」
  「另有工具调用时仍报 max-tokens（不丢内容）」「另有正文时仍报 max-tokens（不丢内容）」。
- ⚠️ **已做反向验证**（三处变异，各自变红，证明非同义反复）：
  ① `reasoningLoopIsSoleOutput → false`（退回 max-tokens）→ **6 条**变红；
  ② 去掉「只是思考循环」门禁（恒为 true）→ **2 条**变红（正是内容保全那两条）；
  ③ 去掉 codearts `visible` 回退的 `!loopDetected` 门禁 → **5 条**变红。
- 端到端回放 `scripts/verify-reasoning-loop-error.mjs`：用**真实会话的 wire 分片**
  （seq=1963，流出思考 57073 / 落块 55084 / 正文块 0 / 工具调用 0）重放，确认产出
  `error` + `REASONING_LOOP`，文案含「不是 token 上限」「还剩约 111693」。
- 取证脚本（均只读、离线、零额度）：`probe-max-tokens-provenance.mjs`（归因）、
  `probe-loop-truncation-content.mjs`（被截原文）、`probe-continue-after-loop.mjs`
  （用户后续消息）、`probe-guard-hit-block-mix.mjs`（命中时的落块构成）、
  `probe-error-finish-content-loss.mjs`（error 路径丢内容）。

⚠️ **排查这类问题的两个通用教训**（本缺陷踩过）：

1. **会话日志里的 `data.stream` 是「合并形态」，不是原始 chunk 数组**：
   形如 `{type:'reasoning-chunks', texts:[…]}` / `{type:'chunk', chunk:{…}}` 混排。
   按 `item.chunk.type` 统计会**静默得到 0**（合并项没有 `.chunk`）——
   我第一版探针据此得出「reasoning 帧 = 0」的**假象**。
   文本量必须从 `texts[]` / `args[]` 累加（见 `probe-stream-shape.mjs`）。
2. **按 `turn` 聚合会掩盖失败步**：一轮有几十步，前面正常步的 `assistant/message`
   会让「本轮有内容」恒为真 ⇒ 得到「error 不丢内容」的**假阴性**。
   必须按 **(turn, step)** 聚合，或直接看 `assistant/attempt` 里那个 `finish` chunk
   （attempt **只在失败路径落盘**，本身就是「这步曾失败」的指纹）。


#### ⚠️⚠️ 循环中止后**自动续跑**：把「用户手打继续」这一步自动化（2026-10-04）

**真实报障**（用户要求，本机 DSH Desktop）：

> 能不能让模型在病态重复后，让会话自己恢复？现在病态重复后要我打个「继续」才继续
> 运行，加个自动中断病态重复和自动继续会话的功能吧。

⚠️ **这不是新需求，而是上一节那条缺陷的收尾**：全库取证（219 会话）已经证明
守卫命中的 **25/25 例**都要用户手动补一句（`11× 「继续」`、`9× 「继续上面未完成的
任务」`），而守卫命中时额度**远没有用满**（单次只烧约 2000 字符）——
**这 25 次停顿全是白停的**。「自动中断」早已由守卫完成，缺的只有中止后的那一步。

##### 为什么必须用 `agent.followup()`，不能用别的通道

| 方案 | 结论 |
|---|---|
| harness 的 `retryPolicy` | ❌ `REASONING_LOOP` **刻意不在** `DEFAULT_RETRYABLE_CODES`（同上下文会稳定复现），且**同一条请求原样重发只会再烧一轮** —— 跳出循环必须**改变输入** |
| 适配器内部「重发 + 偷偷塞一条提示」 | ❌ 违反 harness 的「**模型可见 ⟺ 已落盘**」红线：注入体不进会话日志，UI 上也看不见，用户会以为模型自己能读心 |
| `ctx.schedule`（定时提醒） | ❌ 那是**持久化**任务（最小秒级、走 Session 控制器重新激活会话），用来做「本轮刚失败、此刻续跑」既重又错 |
| **`agent.followup(createUserMessage(...))`** | ✅ 公开 Agent 接口；harness 自己的目标续跑驱动器（`dsh-goal-round-driver`）就是用它投下一轮的，本实现与它**同构**；投出去的是**真 `user/message`**，落盘 / 显示 / 重放全走既有路径，**零格式变更** |

##### 三条安全边界（都按「宁可少续跑，不可无限续跑」选）

1. **只在 `agent/status === 'idle'` 时投递**。⚠️ 错误发生的那一刻驱动器还在跑，
   此时 `followup()` 排进 `next-turn` 后**不会被唤醒**（`wakeDriver()` 对 running
   相位不 latch，见 `agent-loop/src/agent.ts`）—— 消息会**烂在收件箱里**，
   表现为「功能没反应」。故与目标驱动器一样等 idle。
2. **连续上限**（默认 2）。**连续**的定义是「上一次真循环之后就一直是循环」：
   任何**别人**投进收件箱的消息（用户手打的、目标驱动器的、子代理的）都清零
   —— 语义正好等于「用户自己补了一句『继续』之后我们又有预算」。
   ⚠️ 我们自己投的那条**不算**别人（按消息 id 过滤），否则一投就把预算清空，
   上限形同虚设。
3. **只在 `REASONING_LOOP` 上续跑**。该码只在「**只有思考**、无正文无工具调用」
   时才报（各适配器的 `reasoningLoopIsSoleOutput` 门禁），故续跑不会重复已经
   给用户看过的东西。其它错误码（`TRANSPORT` / `QUOTA_EXCEEDED` / `AUTH` …）
   一律不续跑，且会把连续计数**清零** —— 续跑只对循环负责，别的错误续跑只会
   掩盖真故障。

##### 实现要点（`src/loop-recovery.ts`）

- **挂载方式**：`ctx.inject(['agents'], …)`，**不写进静态 `inject`**。写了的话，
  agent-loop 缺席的 profile（纯 `ctx.llm` 的脚本、部分 headless）里本插件会
  **永久 pending**、整个 profile 启动失败 —— 与 `connection` 同一条已知坑
  （见 `index.ts` 的 `inject` 注释）。缺席时本功能整体不生效，其余能力照常。
- **判据不能只靠 `instanceof LlmError`**：`@deepseek-ai/dsh-llm` 在宿主与插件里
  可能解析成**两份模块实例**，此时 `instanceof` 恒为 false，表现是「功能完全没
  反应且没有任何报错」。故 `isReasoningLoopFailure()` 再按**码值**认一次
  （`REASONING_LOOP` 是本插件自己的常量，误判风险为零）。
- **投递走 `withoutInitiator()`**：这几行跑在别的 agent 的事件派发里，排队动作
  不该继承「当时恰好是谁在运行」的发起者归属 —— 与 `goal-round-driver` 同手法。
- **投的是「给模型的指令」**（`LOOP_RESUME_PROMPT`，约 65 字符）：说清①继续未
  完成的任务、②上一轮为什么停（思考重复，**不是**任务做完）、③这次换思路。
  ⚠️ **不写 harness 内部词汇**（「循环守卫」「去重率」），那是给用户看的诊断。
  它每轮都进请求体，**长度也是成本**（与 cline 报错文案那次同一口径），用例锁了
  `< 80` 字符。
- **新增 devDependency `@deepseek-ai/dsh-agent`**：**仅类型用途**
  （`import type {} from '@deepseek-ai/dsh-agent'` 加载 `Events` / `Context.agents`
  的声明合并），运行时**不 import 它的任何值**，故**不进 peerDependencies** ——
  不因为一个类型依赖去动消费者侧的 peer 范围。

##### 开关与默认值

| 变量 | 默认 | 语义 |
|---|---|---|
| `DSH_REASONING_LOOP_AUTO_RESUME` | 开启 | 复用守卫自己的 `resolveReasoningLoopGuardFlag`（显式假值才关），**不另写一份真假判定** |
| `DSH_REASONING_LOOP_AUTO_RESUME_MAX` | `2` | `0` 是**合法值**（= 绝不自动续跑）；非法值**回默认值而不是回 0**（`=abc` 若静默变成「关闭」，用户会以为功能坏了却查不出原因——与仓库既有 `parseInt(…) \|\| 默认值` 的教训同型）；上限封顶 `10`（单次循环只烧约 2000 字符，真要无限跑该用 goal）|

##### 回归与验证

- 回归用例 `tests/unit/loop-recovery.spec.ts`（**33 条**）：策略解析（含 `0` 合法、
  非法值回默认、封顶）、错误识别（实例 / 码值两种形态）、控制器行为（只投一次、
  非 idle 不投、收件箱有人不抢、上限后告警停手、别人介入清零、自己投的不清零、
  投递抛错降级、`forget`、多 agent 隔离）、安装与端到端派发（`agent/error` →
  `agent/status(idle)` → 投递且走 `withoutInitiator`、开关关闭时**完全不注入**），
  以及 `index.ts` 的**接线断言**（只在模块里写好函数、没人调用 = 功能不存在）。
- ⚠️ **已做反向验证**（五处变异，共 **12 条**变红，证明非同义反复）：
  ① 去掉上限（`+100`）→ 上限/多 agent 用例红；② 去掉 `pending` 归零 → 幂等用例红；
  ③ 去掉「收件箱有人不抢」→ 该用例红；④ 去掉码值兜底 → 双模块实例用例红；
  ⑤ `resolveLoopResumeMax` 改成 `Number(raw) || 默认` → `0` 合法性与「上限 0 不注入」
  两条红；另加 ⑥ `index.ts` 里把调用改名 → 接线用例红。还原后 33 条全绿。
- ⚠️ **本功能无法用 e2e 真机验证**（要模型真的陷入循环，不可控）：判据与状态机
  全部由单测锁死，`installLoopResume` 只做接线；真机上的首次验证靠用户报障反馈。


#### ⚠️ 思考标签泄漏与「引用 `</think>` 导致对话中断」

**真实缺陷**（用户报障，2026-09-27，**在本会话实时复现**）：

> 思考带着 `</think>` 原样输出到正文了，然后正文碰到 think 标签直接没输出就中断了

**根因：上游把 `</think>` 当停止串（stop string）。** 两个症状同一根因，但**性质不同**：

| # | 形态 | 机制 | 处理 |
|---|---|---|---|
| ① | 标签**单独**成块（`\n</think>\n\n`） | 服务端把停止串**含在**输出里 | **解析**切走标签（`splitThinkTaggedContent`）；另有过虑兜底（**默认关**）|
| ② | 标签**跟在正文后** | 服务端在停止串处**掐断**，但仍报 `finish_reason:"stop"` | 改判 `max-tokens`（`isProseTruncatedByStopString`）|

##### ⚠️⚠️ 首要原则：**先把解析做对，过滤只是兜底**

用户明确纠正过设计优先级（2026-09-27）：

> 我们应该正确处理这种**配对格式**的标签优先保证它正确解析，而不只是解析失败
> 再从泄露的文本中过滤，**过滤只是兜底手段，更要强化做对**

**分工（必须分清，别混）**：

| 层 | 函数 | 开关 | 职责 |
|---|---|---|---|
| **解析** | `splitThinkTaggedContent` | **恒开**（不可关）| 认全形态，把标签**切**出去 |
| **截断识别** | `isProseTruncatedByStopString` | 恒开 | 识别「上游掐断」→ 改判 `max-tokens` |
| **过滤（兜底）** | `stripBareThinkCloseTag` | **默认关**（`DSH_THINK_LEAK_STRIP=1`）| 删切分没处理的**纯标签块** |

⚠️ **过滤默认关闭是用户决定**（2026-09-27）：

> 我们现在暂时不需要泄露过滤，代码可以保留，文档和注释记明白，后续再实际
> 使用中看是否还有泄露问题，**加了过滤可能有思考解析失败但是被过滤我们发现不了**

即：**兜底会掩盖解析层的失败**。当前阶段要让泄漏**如实呈现**（观测解析成功率），
故默认不剥；确需应急再打开。代码保留，接线在（`stripBareThinkCloseTagIfEnabled`）。

⚠️ **该开关语义与另两个开关相反**：`DSH_COURSE_LEAK_STRIP` /
`DSH_REASONING_LOOP_GUARD` 是「默认开、显式假值才关」；
`DSH_THINK_LEAK_STRIP` 是「**默认关、显式真值才开**」（`1`/`true`/`yes`/`on`）。
故用独立的 `resolveThinkLeakStripFlag`，**绝不能与 `resolveCourseLeakStripFlag` 混用**
（混了会让它默认开，正好与意图相反）。

##### 解析器必须认全形态（旧判据漏 91%）

旧判据只认 `</think:hex>`。普查 41 会话（`scripts/probe-think-forms.mjs`）：

| 形态 | 块数 | 旧判据 | 现判据 |
|---|---|---|---|
| `close-only-bare`（裸闭标签）| **38** | ❌ | ✅ |
| `close-only-hex` | 4 | ✅ | ✅ |
| `mixed-hex-and-bare` | 2 | ❌ | ✅ |
| **`paired`（开+闭）** | 2 | ❌ | ✅ |

⇒ 旧判据漏 **42/46（91%）**。这正是「只靠事后过滤」的代价：这 42 处全都会
把标签泄漏给用户。

⚠️ **配对形态无需单独分支**：定界用**最后一个闭标签**，开标签由
`THINK_ANY_TAG_RE` 作为「思考段内标签」剔除 ⇒
`<think>思考</think>正文` → 思考=`思考`、正文=`正文`。
故正则放宽为 `/<\/think(?::[0-9a-f]+)?>/g`（hex 后缀可选）。

⚠️ **引用语境必须排除**（`isQuotedThinkTag`，四条件）：全库 46 处标签里
**39 处处于引用语境**（反引号紧邻 / 反引号 span 内 / 单双引号内 / 代码围栏内），
只有 7 处裸露。若不排除，模型**讨论**标签的正文会被拦腰切断
（`'</think>无 hex</think>'` 这类）。判据 4（同行引号奇数）**故意偏保守**：
误判只导致「该切分未切分」（标签留在正文，由兜底处理），
而不是「把正文当思考移走」（不可逆的内容错位）。

##### ⚠️⚠️ 绝不能用「逐帧探测」当解析门禁（跨帧必然漏判）

**这是本次审计发现的真实缺陷**，我一度写过、后删除：

```ts
// ❌ 错误写法：逐帧探测，命中才在收尾切分
if (!proseHasThinkTag && textDelta.includes('</think>')) proseHasThinkTag = true
// ... 收尾
if (proseHasThinkTag) { splitThinkTaggedContent(textBlock.text) }
```

**标签必然跨帧**（上游按 token 切分），该判据要求**完整** 8 字符标签。
枚举全部分帧方式（`scripts/probe-think-flag-split.mjs`）：

| 文本 | 分 2 帧时漏判 |
|---|---|
| `思考</think>正文` | **7/11** |
| `<think>思考</think>正文` | 7/18 |
| `思考</think:6124c78e>正文` | 5/20 |

漏判 ⇒ 收尾不切分 ⇒ 标签原样落盘。这与该变量自己的注释
（「标签可能跨帧到达，必须缓冲到收尾」）**自相矛盾** —— 门禁本身就是那个
不该存在的逐帧判定。

✅ **正确写法：收尾无条件解析**（现实现）：

```ts
let textOut = textBlock.text
{
  const split = splitThinkTaggedContent(textBlock.text)  // 无标签返回 undefined
  if (split !== undefined) { /* 思考段并入 reasoning 块，textOut = split.text */ }
}
textOut = stripBareThinkCloseTagIfEnabled(textOut)       // 兜底，默认关
```

⚠️ **为什么不是「先组装再发给 DSH」**：DSH 协议**已经**提供该能力 ——
`block-end` 的 `block.text` 是**权威覆盖**（`BlockAssembler`：`if (partial.block) return partial.block`；
客户端 `case "block-end": blocks[i] = toAssistantBlock(chunk.block)`）。
故**流式照发 delta**（保住首 token 延迟），**收尾用完整文本解析一次**，
再靠 `block-end` 覆盖 UI。无需（也不应）在流式层攒文本。
普通响应无标签时返回 `undefined` ⇒ **逐字节不变**（实测单次 1.5µs）。

⚠️ **② 的判据是「反引号奇数 **且** 以反引号收尾」**，两条缺一不可：

- 只有「奇数」不够 —— 未闭合的开引号可能在中间，无法证明是**末尾**被切断；
- 只用「以反引号结尾」不够 —— 正常的 `` 运行 `pnpm test` `` 也以反引号结尾。
  实测该粗判据命中 **9** 处（6 处假阳性），本判据命中 **3** 处**全部**为真截断。

**三条实测证据**（`qoder/qfmodel`，正文尾部 + `outputTokens`）：

| 行 | 正文尾部 | outTok | 正要写 |
|---|---|---|---|
| 5378 | ``…清洗器只认 ` `` | 369 | `` `</think:hex>` `` |
| 5412 | ``…多吐了一个孤立的裸 ` `` | 643 | `` `</think>` `` |
| 5600 | `` 找到了，`trae-adapter.ts` 还没补 ` `` | **37** | `` `</think>` `` |

⚠️ **改判还必须要求「本步无可用工具调用」**：有工具调用说明模型是「写完就去调
工具」，正文以反引号收尾只是碰巧（判据 B 的 3 个命中全是无工具调用的收尾步）。
⚠️ 报 `max-tokens` 而非 `tool-calls`：本步没有工具调用，报后者会让 harness 空执行。

⚠️ **停止串是服务端模板内置的，只能防御、不能协商**。注意区分两个层面：
- **我们从不主动下发它**：`options.stop` 只有**调用方（DSH）**可能传；本仓库
  6 个适配器（`buddy` / `lobsterai` / `cline` / `loomy` / `raccoon` / `trae`）
  只是**有则透传**（`if (options.stop !== undefined && options.stop.length > 0)`），
  **没有一处主动构造** `</think>`；
- ⚠️ `openai-compat.ts`（qoder / qodercn 路径）**根本不消费 `options.stop`** ——
  即便如此仍会观察到停止串截断 ⇒ **它来自服务端会话模板，与我们的请求体无关**。

⚠️ **不要在流式层逐帧剥离标签**：标签会**跨帧**到达（`` `<` `` / `` `/thi` `` / `` `nk>` ``），
逐帧匹配不到完整标签；正确位置是**收尾**的 `block-end`（它是**权威覆盖**）。

**接入范围（两处修复各自覆盖哪些 provider，别记混）**：

| 修复落点 | 文件 | 覆盖的 provider |
|---|---|---|
| 共享协议层 | `openai-compat.ts` | **qoder / qodercn**（同类）+ **cline / loomy / raccoon**（各自 import 它） |
| 独立实现 | `buddy-adapter.ts` | buddy / workbuddy（同产品配置） |
| 独立实现 | `lobsterai-adapter.ts` | lobsterai |
| 独立实现 | `trae-adapter.ts` | trae |

⚠️ `src/llm-adapter.ts`（CodeArts）**不使用这两处判据**（它走 DSML / `<thought>`
提取器，标签语义不同）—— 不要误以为「六份适配器都接了」。
回归用例：`tests/unit/strip-bare-think.spec.ts`（8 条，剥离判据）、
`tests/unit/think-stop-string.spec.ts`（12 条，截断判据 + 四类误报边界）。

⚠️ **排查本缺陷时警惕「自己造成的假阳性」**：本会话排查期间我**一直在讨论这个
标签**，正文里合法地写过 `` `</think>` ``、`'</think>'`、裸 `</think>`（为说明形态）。
按「裸露 = 泄漏」的粗判据会数出 42 处，其中 **70 处是语法引用、4 处是排查自我指涉**，
真正的模型泄漏只有 **1 处**（`lilishop-go` 行 21908 的纯标签块）。
**判据必须排除反引号/单双引号/围栏三种引用语境**，否则会把自己的分析当成模型缺陷。

⚠️ **上游在两个通道各发一遍同一段文字**（本会话实测行 5298：`reasoning-chunks`
与 `text-chunks` 相隔 348ms、逐字相同、`outputTokens` 两者都计入）。
**这是上游行为，不是我们的重复发射**（帧是独立的两条，非同一帧二次发射），
**不需要处理**。

#### ⚠️⚠️⚠️ 「没有任何报错就中断」怎么查（DSML 篇：内容凭空消失比标签泄漏更糟）

用户报障（2026-10-13 晚）：**「用聚合 provider 的 ds v4.1 flash 发起会话很快
就结束了没有原因」**、**「指定 codebuddy 的 ds v4.1 flash 重复执行后出现
DSML tag 泄露并终止」**。怀疑与最近几个 DSML 提交有关。

**排查路径（可复用）**：这类现象**无法靠读代码推断**，必须回会话日志。
`inspect-session.mjs` 不在仓库里时，用 `zstdDecompressSync` 直接读
`~/.dsh/sessions/<工作区转义名>/<session-id>/session.v4.jsonl.zstd`
（工作区名把 `\` `/` `:` 换成 `-`）。三步：

1. **找现场**：`model/selection` 事件给出每轮的 provider/model；
   `assistant/message` 的 `data.message.content` 给出落盘的块。
2. **看块结构与 finish**：只有 reasoning+text、零 tool-call、`finish=stop`、
   usage 全 0 ⇒ 工具调用被吞（不是模型抖动）。
3. **看原始 chunk 流**（`data.stream`）：`text-delta 数=0` 而 `block-end`
   的 `block.text` 是整段原文 ⇒ 走的是 `flush()` 补回开标签那条路
   ⇒ 提取器**从未认出**这个块。

**本次真相**：模型输出

```
<｜DSML｜ calls>\n<｜DSML｜ invoke name="pwsh">\n<｜DSML｜ parameter name="command" string="true">…</｜DSML｜ parameter>\n</｜DSML｜ invoke>\n</｜DSML｜ calls>
```

`｜DSML｜` 之后**带空格**，且 `invoke` / `parameter` 同样中招 —— 而归一正则
`(<\/?)｜DSML｜\s*(?:tool_)?calls>` **只覆盖 `tool_calls` / `calls` 一种名字**。
⇒ `indexOf(DSML_INVOKE_OPEN_PREFIX)` 恒不命中 ⇒ `parseDsmlToolCalls` 返回
**空数组** ⇒ `in-dsml` 分支把它当「解析成功但无调用」⇒ **整段被静默丢弃**。

⚠️⚠️ **`[]` 与「解析出一个调用」在旧实现里走同一支**（`toolCalls.push(...parsed)`，
空数组 push 0 个）⇒ 静默。这是本仓库反复出现的那类缺陷的又一变体：
**「空」被当成「正常的无」**。判据必须显式区分，且方向取「**宁可漏判不可误伤**」
—— 放行原文让用户看得见，远比凭空消失好诊断。

⚠️ **`aggregate` 为何也中招**：它只透传 `options` 给下层
（`ctx.llm.stream({ provider: target.provider, model: target.realId })`），
下层 codearts 注入 DSML 提示、模型写 DSML、解析器读不出 ⇒ **聚合层零改动
也照样中招**。⇒ 这类缺陷的排查**不能停在聚合层**，必须追到真实 provider。

**其它同型现场（同一根因的不同表现）**：

| 表现 | 触发条件 |
|---|---|
| 内容凭空消失、`finish=stop` | 空格形态 + 空数组被当成功（**拆帧**路径） |
| 690 字符 DSML 原文进 text 块 | 空格形态但**整帧**到达（`flush()` 补回开标签） |
| `unknown tool "command"` | `parseDsmlInvoke` 在整块上搜 `name=`，误命中 parameter 名 |
| 半修形态 `<｜DSML｜invoke` | `fixDsmlMarkers` 的 `DSML` 后前视漏了字母 |

完整修法与守卫见 `providers-officeace.md` §5.6「第四次事故」，
行为级守卫 `tests/unit/dsml-label-forms.spec.ts`（23 条，二分帧穷举），
反向验证 `scripts/reverse-verify-dsml.mjs`（7/7 有效）。

#### ⚠️ 正文（text 通道）死循环：必须**独立实例**且**绝不 `cancel()`**

**真实缺陷**（用户报障，2026-09-25）：唯一活动 session（`lilishop-go` /
`workbuddy/hy4-preview-f`）出现**正文**循环，用户问「是只能处理思考不能处理
正文吗？还是这个循环还不够长？」

**答案：两者都不是 —— 是通道没接。** 旧实现六个落点**全部只喂 reasoning
增量**，正文分支从不调 `observe`。用**真实检测器**回放该会话正文，三段
**全部命中**（远超阈值，不是「不够长」）：

| seq | 正文长度 | 非空行 | 去重行 | 去重率 | 检测器 |
|---|---|---|---|---|---|
| 34752 | 4,641 | 486 | 20 | 0.0412 | HIT，cutAt=752 |
| 34768 | 8,875 | 416 | 39 | 0.0938 | HIT，cutAt=880 |
| 34823 | 34,406 | 2,711 | 473 | 0.1745 | HIT，cutAt=3256 |
| 35069 | 138,852 | — | — | — | HIT，撞满 `maxTokens: 64000` |

判据（去重率 < 0.35 且持续 ≥ 2000 字符）与思考侧**完全相同**，直接复用
`createReasoningLoopDetector`。

⚠️ **必须与思考守卫分成两个实例**：判据看**尾部 3000 字符窗口**的行去重率，
两条通道混进同一窗口会互相稀释，使守卫**双双失效**；共用一个 `cutAt` 也会
让一条通道的截断点错切另一条。

⚠️ **与思考守卫的语义差异（最关键，别照抄）**：思考死循环时模型**不产出工具
调用**，故命中即可 `reader.cancel()` 止损。但正文循环**不一样** —— 实测三段的
wire 帧顺序恒为

```
block-start(text) → text-chunks(循环正文) → block-start(tool-call)
  → tool-call-chunks → usage → block-end(tool-call) → block-end(text) → finish: tool-calls
```

**工具调用在循环正文之后才到达**，且调用有效、任务能继续。故正文守卫：
**只截断文本，绝不 `reader.cancel()`、绝不改 `finish` reason**。若照搬
`cancel()`，会把这些有效调用**整块丢掉**，把「能继续的任务」变成「什么都不做
就结束」—— 比循环本身更糟。

⚠️ **误报余量比思考侧更宽**（全语料 155 会话 / **32,725 步**实测）：

| 量 | 正常正文 | 命中样本 | 余量 |
|---|---|---|---|
| 窗口最低去重率 | **0.7667** | 最高 0.0387 | **19.8 倍** |
| 最长连续 looping 体量 | **0** | 3,937 ~ 8,064 | — |

正文命中 **4 次，全部是真循环**；其余 32,721 步零误报。
排查脚本 `scripts/measure-prose-loop-margin.mjs`、
`scripts/analyze-prose-loop-false-positive.mjs`；
回归用例 `tests/unit/prose-loop-guard.spec.ts`。

#### ⚠️ `</think:hex>` 闭标签：思考被上游塞进 `content` 通道

**同一缺陷的另一半。** `hy4-preview-f` 把**思考**写进 `content`（正文），只在
思考段末尾留一个 `</think:6124c78e>` **闭标签**。实测该会话 93 步里只有 **9 步**
的 reasoning 通道非空 —— 思考 9,563 字符 vs 正文 64,043 字符。

全语料普查（155 会话）：含标签 **28 步**，**开标签 0 个**、闭标签 28 个，
hex 恒为 `6124c78e`（会话级）；只出现在 `workbuddy/hy4-preview-f`（25）
与 `workbuddy/deepseek-v4.1-flash`（3）。

**判据**（`splitThinkTaggedContent`，`src/sse.ts`）：
- 以**最后一个**闭标签为界，标签**前** → reasoning 块、标签**后** → text 块；
- ⚠️ **只认闭标签，不猜开标签**：开标签恒缺失，仅见开标签时无法确定「思考到哪
  结束」，**不切分**（保持原样比猜错安全）；
- ⚠️ **无标签返回 `undefined`**，保证 99.6% 的普通响应**逐字节不变**；
- ⚠️ **必须在收尾做，不能逐帧**：标签会跨帧到达（`</think:61` + `24c78e>`）；
- ⚠️ **归位时必须同时喂 `suppressor`**：收尾以 `suppressor.text()` 为 reasoning
  块的**权威**，只改 `blocks` 条目不生效（测试直接暴露过这个坑）；
- ⚠️ **归位后正文可能为空串**（实测 seq=34768 形态）—— 空块会污染会话且违反
  DSH 的 `EMPTY_RESPONSE` 契约，故**不发空 text 块**（思考段已归位，仍有产出）。

⚠️ **引用判据不可省（否则误伤正常正文）**：标签可能只是被模型**讨论/复述**。
实测 28 处里 **3 处是反引号包裹的行内引用**（含排查本缺陷时复述该标签字面量的
正文）。判据「标签是否被反引号/围栏代码块包裹」分离度 **3/3 与 25/25，零交叉**。

回归用例 `tests/unit/think-tag-split.spec.ts`；真实会话端到端回放
`scripts/verify-prose-loop-replay.ts`（用会话里保存的**真实 wire 分片**重建 SSE，
喂真实 `BuddyAdapter`，断言**工具零丢失**）。

#### ⚠️ 行首 `course` / `课` 泄漏 token 会污染提示词

**真实缺陷**（用户报障，2026-09-23）：`deepseek-v4.1-flash` 的输出与思考中
「经常一行开头带一个中文『课』或英文『course』」。

实测形态（全库核实 295 会话 / 307 万行）：

| 事实 | 数据 |
|---|---|
| `course` 片段长度 | **1381/1381 全部恰好 6 字符**，全文即 `"course"` |
| `课` 片段长度 | **3362/3366 恰好 1 字符**，全文即 `"课"` |
| 位置分布 | 行首 **2347**、行中仅 28（后者全是排查期间的会话文字） |
| 前接上下文 | 只有 `\n\n`(2395) / 块首(261) / `\n`(69) 三种，**无例外** |

100% 规整 → **不是**模型生成的自然语言，而是某个「段落起始」类**特殊 token
被解码成了字面量**（中文侧 `课`、英文侧 `course`，同源）。

⚠️ **`课查` / `课修` 是「泄漏 + 模型循环」两个问题叠加**（用户补充，已证实）：
泄漏 token 后面直接跟模型正文/循环短句（`课查。` 895 次、`课跑。` 308、
`课修。` 307…）。这也解释了为何量极大 —— 模型一旦进入循环，每轮迭代都带一个泄漏前缀。

**判据**（`stripCourseLeak`，`src/sse.ts`）：

```
行首（块首 或 前一字符是 \n，允许前置空白）的 `course`
  且后接 ∈ {空格, \t, \n, \r, 块尾}   → 删
行首（同上）的 `课`                     → 删
```

⚠️ **判据刻意不用白名单** —— 实测反证：泄漏就是**单个 `课` 字**，后面接任意正文，
故「`课` + 某字」永远可能是「泄漏 + 正文」的偶然组合：

| 曾以为要保护的词 | 数据真相 |
|---|---|
| `课改`(12) | 行首 **10 次全是泄漏**（`课改测试。`、`课改 handler.go。`） |
| `课时`(3) | 行首 3 次全是泄漏（`课时间轴逻辑…`） |
| `课程`(23) | **全在中部**，且全是排查期间的会话文字，非模型输出 |

`course` 后接**不接字母**是为保守（避免误删 `courseware`）；实测行首
`course` 后接非空白出现 **0 次**，故不影响覆盖率。

**两处落点，缺一不可**：

1. **消费侧（新输出）**：各适配器 `block-end` 处调 `stripCourseLeakIfEnabled` ——
   清洗已组装的块。放这里而非流式增量，是因为判据需要「行首」上下文，
   而增量里 `course` 可能跨 chunk 到达（`cou` + `rse`）。
   实测 `block-end` 是**权威覆盖**，改文本即生效（与死循环截断同机制）。
2. **序列化侧（存量自愈）**：`stripCourseLeakFromHistoryContent` 在
   `serializeMessages` 里清洗**已持久化**的历史。⚠️ **只清 `role === 'assistant'`**
   —— 判据只对模型自己的输出成立，**清洗用户输入等于篡改用户的话**；
   `tool-call` 的 `arguments` 也不清（是 JSON，改了破坏解析）。

**开关注入**：`DSH_COURSE_LEAK_STRIP` —— **默认开启**，仅显式假值
（`0`/`false`/`no`/`off`）关闭。用独立的 `resolveCourseLeakStripFlag`，
不要与 `isTruthyFlag`（默认关）混用。

⚠️ **已知边界（非零风险，故必须带开关）**：若模型真的以「课程设计已完成。」
这样的句子开头，会变成「程设计已完成。」。实测 **0/2346**，但原理上非零。
若将来实测出现真实误删，应改为「行首 课 + 白名单词」的保护式判据
（但那时需先证明白名单不会被「泄漏 + 正文」的偶然组合绕过）。
⚠️ 判据**不解析 markdown 围栏**：围栏内若出现行首 `course` 同样会被删
（实测泄漏都出现在自然语言段落，围栏内无此形态，故接受该简化）。

**实测效果**：全库 **2771 行泄漏 → 0 残留**；正常用法零误伤
（`of course` / ` recourse` / `研讨课` / `重要的一课` / `课程设计` 均保留）。
回归用例 `tests/unit/course-leak-strip.spec.ts`（33 条）；
端到端脚本 `scripts/verify-course-leak-e2e.ts`。

#### ⚠️ 纯空白思考会画出「空 Think 块」；零内容块响应必须报 `EMPTY_RESPONSE`

**真实缺陷**（用户报障，2026-09-23）：UI 上出现**空的思考（Think）块**。

实测：`deepseek-v4.1-flash` 偶发只输出**一个空格**当思考 —— 全库 **2233 个**
`trim()` 为空的 reasoning 块，`block.text` **全部是 `" "`**，且 wire 上
`reasoning-chunks.texts` 就是 `[" "]`；**上游为它计了 1 个 token**
（`usage.reasoningTokens=1`，2232/2232）⇒ **空格是模型真实生成的**，非适配器伪造。
分布：`buddy/deepseek-v4.1-flash` 1398 + `workbuddy/deepseek-v4.1-flash` 835。
（脚本 `scripts/trace-empty-reasoning.ts`、`scripts/analyze-reasoning-tokens.ts`。）

⚠️ **两个必须记住的机理**：

**① 「只改出口判据」不够 —— `BlockAssembler` 会用 `partial.text` 组装出残缺块。**
```js
assemble(partial, index) {
  if (partial.block) return partial.block                              // 有 block-end → 用它
  case "reasoning": return { type: "reasoning", text: partial.text }   // 无 → 用累积文本
```
⇒ 只要发过 `block-start`，即便**一个 `block-end` 都不发**，收尾仍会组装出块
（这正是「空 Think 块」的成因）。故必须**从一开始就不发任何 chunk**
（连 `block-start` 都不发）—— 与「空名字 `tool_call`」的修法**完全同型**。
实测脚本 `scripts/verify-empty-reasoning-fix.ts`。

**② 零内容块响应必须报 `EMPTY_RESPONSE`，不能报 `stop`。**
压制空块会引出**新退化形态**：若某响应本来只有那个空白 reasoning 块
（无 text、无 tool-call），就会产出「零块 + `finish: stop`」—— DSH 契约明令禁止：
> Providers occasionally emit a degenerate completion (a terminal stop with zero
> output); adapters classify it as this failure instead of yielding an empty
> assistant message, because **an empty message silently ends the turn with
> nothing for the user or the loop to act on**.

官方范本 `dsh-llm-deepseek`（`lib/index.js` 的 `translate()`）：
```js
reason.kind === "stop" && order.length === 0
  ? { kind: "error", failure: { message: "…no content", code: EMPTY_RESPONSE_CODE } }
  : reason
```
实测频率 **1/30404**（`scripts/quantify-empty-response-risk.ts`）。
这与本项目已两次踩过的同族坑（空名 `tool_call`、死循环）完全同型。

**判据与落点**：

| 位置 | 作用 |
|---|---|
| `src/sse.ts` 的 `createBlankReasoningSuppressor()` | 纯空白思考**一个 chunk 都不发**；转正那次**补发已累积全部文本**（含前导空格）。判据在**整块**（`["a"," "]` → `'a '` 保留），非单片 |
| `src/sse.ts` 的 `resolveEmptyResponseReason(reason, blockCount)` | 零块且原为 `stop` ⇒ `error`/`EMPTY_RESPONSE`；**只在 `kind === 'stop'` 时改写**（故 `loopDetected`/`length`/无名 tool_call/`tool-calls` 优先级全保留） |
| 5 个适配器的 reasoning 发射点（**6 处**，codearts 有两条出口） | 用 helper 的产出替代「无条件建块 + 发 chunk」 |
| 5 个适配器的 `finish` 出口 | `blockCount` = **实际发出的 `block-end` 数**，**不是 `blocks.length`** |

⚠️ **`blockCount` 必须数「实发块」。** 反例：`reasoning_content: '课'`
（本项目已知的真实泄漏 token）会让 helper **建块**，但收尾被
`stripCourseLeakIfEnabled` 洗成空串 ⇒ **实发 0 块而 `blocks.length === 1`**。
用 `blocks.length` 会把这种响应误判成「有 1 块」而报 `stop`（静默结束）。
审查据此实测：把 5 处换成 `blocks.length` 后 34/34 仍通过 —— **曾是测试盲区**，
`tests/unit/empty-response.spec.ts` 已补用例钉住它。

⚠️ **codearts 有两条 reasoning 出口**（`src/llm-adapter.ts:1113-1123` 自称
「漏一条就等于漏一条路径」）：① `delta.content` → `DsmlContentExtractor` 解析
`<thought>` → `emitDsmlFeed`；② `delta.reasoning_content` → `thinking`。
**两条共用同一个 helper 实例**（否则各自累积会错乱）。
回归测试必须**两条都覆盖** —— 审查发现只覆盖出口② 时，出口① 若回归
会**静默**放回空 Think 块（`tests/unit/blank-reasoning-adapter.spec.ts` 的
`A'/B'/C'/D'` 专组负责出口①）。

⚠️ **不得改动发送侧**：`buddy-adapter.ts` 的 `reasoning_content: reasoning` 是
**无条件写入**的（注释：推理模型缺失该字段会 400）。删掉存储侧空块后
`reasoning === ''` 但**字段依然存在** ⇒ 不会 400。**绝不可**改成条件写入。

**开关**：无独立开关（正确性修复，非可选项）。

回归用例：`tests/unit/blank-reasoning.spec.ts`（helper 语义）、
`tests/unit/blank-reasoning-adapter.spec.ts`（块层面「零 chunk」+ 出口①）、
`tests/unit/empty-response.spec.ts`（`finish` 归类 + `blockCount` 判据）。

★ **测试写法教训**（本任务反复踩到，值得单列）：

- **只断言 `finish` 不够**：空块回归时 `finish` 可能仍是 `EMPTY_RESPONSE`
  （因为 `blockCount` 仍为 0），必须**同时断言「没发任何 chunk」**。
- **测试注释里的论证必须有实测支撑**。本项目连续三次凭推理写下断言
  （「没有 D 则 A/B/C 全绿」等），**全部被自己的变异实验证伪**：
  C 与 D 都经过 `feed` 的「转正」分支，故**无法构造只打 D 的变异**。
  注释应**只写实测事实**（附「曾写进注释 / 变异 / 实测 / 结论」表格）。
- **变异测试是唯一能证明断言有判别力的手段**。用「恒真断言」或「只看测试通过」
  都会漏掉盲区 —— 本项目两次靠变异测试发现缺口（`blockCount` 盲区、
  出口① 无覆盖）。
- ⚠️ 变异实验脚本必须 `try/finally` 恢复，并在结束时用
  `git diff --quiet -- <file>` **确认无残留**（否则污染后续提交）。

### ⚠️ `tests/` 不在 `pnpm typecheck` 覆盖内

`tsconfig.json` 的 `include` **只有 `["src"]`** ⇒ `tests/` 的类型错误**不会**被
`pnpm typecheck` 发现。实测把 `tests/` 一并纳入后有 **108 个既有类型错误**
（`HeadersInit` 未定义、`ContentBlock[]` 赋值不兼容、`plugin-src/*.js` 缺声明等），
属独立工程。

⚠️ **新增/修改测试文件后，务必单独跑一次类型检查**（否则 `tests/` 里的类型错误
会被静默放过 —— 本任务已发生过一次：收紧 `src/` 的类型签名后 `pnpm typecheck`
仍 exit 0，但测试文件里有一处 TS2345）：

```
npx tsc --noEmit --strict --target ES2023 --module NodeNext --moduleResolution NodeNext \
  --skipLibCheck --esModuleInterop --types node --lib ES2023 --rootDir . <你的测试文件>
```

#### ⚠️ 测试 fixture 必须保持 LF（`core.autocrlf` 会造成假失败）

本机 `git config core.autocrlf=true`，checkout 时会把仓库里的 LF 转成 CRLF。
而 `tests/fixtures/reasoning-*.txt` 是**真实会话文本提取**，其**字符偏移被测试精确断言**
（`reasoning-loop.spec.ts` 的 `cutAt === 1536/1600`）—— 凭空多出的 3082 个 `\r`
会把偏移推到 **1792** ⇒ **两个断言失败**，且**在纯基线上同样失败**，
极易误判成「刚改的代码坏了」。

根治：`.gitattributes` 的 **`tests/fixtures/** text eol=lf`**。

⚠️ **必须是 `text eol=lf`，不能写成 `-text`**（初版写错，经审查实测纠正）：
- `-text`（不规范化）只挡**检出**期转换，**挡不住入库污染** —— 实测工作区是 CRLF 时
  `git add` 会把 48338 字节（含 617 个 `\r`）写进索引（HEAD 本为 47721），
  此后 `checkout` 把这些 `\r` 发给所有人，**偏移断言对全仓库永久失败**；
- `text eol=lf` 同时具备两项能力：检出写 LF，**入库时把 CRLF 规范化回 LF**。

用 `**` 而非 `*`：gitattributes 的单星**不跨目录**（实测子目录为 `unspecified`）。

**自查**：`git ls-files --eol -- tests/fixtures/` 应全是 `i/lf w/lf`。

### 测试

- 单元测试覆盖核心逻辑（签名、续期、参数构造、账号池），不依赖网络
- E2E 测试按 provider 分为独立脚本（`pnpm test:e2e:*`），**均带闸门且默认跳过**；哪些会消耗模型积分见 `tests/e2e/README.md`
- 测试文件按约定放在 `tests/unit/` 与 `tests/e2e/` 目录

### ⚠️⚠️ 别在工作区里跑 `pnpm install`：`node_modules` 是 junction 时会**改写主 checkout 的软链**

2026-11-17 实测事故：工作区用

```powershell
New-Item -ItemType Junction -Path ".agents\worktrees\<x>\node_modules" -Target "<repo>\node_modules"
```

共享依赖后，在工作区里执行 `pnpm run build:all` / `pnpm install` —— pnpm 的
「脚本前依赖校验」会把工作区当成 install 根，于是把**主 checkout** 的 8 个顶层
软链改写成了指向工作区 `.pnpm` 的相对路径：

```
node_modules\typescript -> ..\.agents\worktrees\codearts-model-desc\node_modules\.pnpm\typescript@5.9.3\node_modules\typescript
```

从主 checkout 看还能解析（相对路径刚好对得上），从**工作区**看就是死链
（`Test-Path node_modules\typescript\bin\tsc` = False）。销毁工作区的那一天，
主 checkout 一起坏。

**正确姿势**

- 工作区要共享依赖，**按顶层条目逐个**建 junction（绝对路径），
  `.bin` / `.pnpm` / `@scope` 都是目录，直接 junction；顶层那几个 **文件**
  （`.modules.yaml` / `.package-map.json` / `.pnpm-workspace-state-v1.json`）用
  **复制**（Windows 无开发者模式时建**文件**符号链会失败：`os error 2`）。
- 构建**不要**走 `pnpm run`，直接调脚本，绕开 pnpm 的 install 前置：
  `node node_modules\typescript\bin\tsc -p tsconfig.json && node scripts\copy-assets.mjs
  && node plugin-src\client\build.mjs && node scripts\sync-bootstrap-lib.mjs`。
- 已经搞坏了：删掉被改写的那几个顶层软链，再在**主 checkout**里
  `pnpm install --frozen-lockfile --force --ignore-scripts`（不带 `--force` 会报
  `Already up to date` 而**什么都不修**）。
- 判据：`Get-ChildItem <repo>\node_modules -Force | Where-Object { $_.Target -like '*worktrees*' }`
  必须为空。

### ✅ 基线失败已清零（2026-11-21）；判断回归仍要看「干净基线对照」

> **2026-11-21 起，全量 `npx vitest run` 是 0 失败**（14926 passed / 26 skipped）。
> 此前长期挂着 6~8 条「基线失败」，现已逐条定性并修掉 —— 逐条清单与本轮
> 修法见下一节。**但这不改变下面这条方法论**：判断「是不是我造的回归」，
> 永远应该用**干净基线工作树对照**，而不是看总数颜色。

2026-11-17 实测（历史）：纯 `origin/master` 工作树跑全量同样是
`magicrew-local-browser`（本机目录存在性）+ `qoder-web-usage`（数值对拍）等
**环境相关**用例红；并行满载时还会额外牵连 `qiniu-rpc` / `account-probe*` /
`balance-cache-wiring` / `minimax-intl` / `models-dev-cache` / `session-title`
（**单独跑就绿**）。判断是否回归的正确做法：同一批文件在
**干净基线工作树**上跑一遍对比，而不是看总数的颜色。

#### ⚠️⚠️ 2026-11-21 基线清零：8 条失败 = 5 类根因，**只有 1 类是真 bug**

本轮把「每次都得人工过滤」的 6~8 条基线失败一次性定性。**5 类根因里 4 类是
测试自身腐坏，1 类是真缺陷** —— 这个比例本身就是教训：**基线红里真 bug 是少数，
但「少数」不等于「零」**，所以不能靠「基线红就无视」的习惯处理。

| # | 用例 | 定性 | 根因（都可复现，不是猜测） |
|---|---|---|---|
| 1 | `qoder-web-usage` ×4 | **测试腐坏**（时钟腐坏） | 夹具日期写死 `NOW = 2026-11-14`，而 `splitAddOnQuota` 的 web 形态 `nowMs` 默认取 `Date.now()` ⇒ **过几天再跑，夹具全成了过去时刻** ⇒ 被「只看未来到期」的 filter 滤空 ⇒ 返回 `undefined` ⇒ 报 `Cannot read properties of undefined`。**修法：夹具显式传 `nowMs: NOW`**（生产语义是对的，不该为它兜底）。 |
| 2 | `balance-disk-cache` ×2 | **测试腐坏**（观测量选错） | 判据读的是**文件顶层 `at`**，而它是 `flushDisk(now = Date.now())` ⇒ **同一毫秒内两次写盘 `at` 相同**。实测连跑 20 轮有 **15 轮**前后相同 ⇒ 反向守卫随机假红。**修法：`vi.spyOn(Date,'now')` 装受控时钟**，推进后才前进。 |
| 3 | `model-catalog-parity`（`magicrewintl`） | **测试腐坏**（串了真网络） | 夹具给了 `resolveCredential`（假 jwt）⇒ 适配器走「有凭据就真拉」那条腿 ⇒ **真发 HTTPS**（实测国内站 228ms / 国际站 1s+）⇒ 全量满载时撞 5 秒 `testTimeout`。**修法：注入恒定拒绝的 `OFFLINE_FETCH`**（仍覆盖「远端失败 ⇒ 回退静态表」这条真实生产路径）。 |
| 4 | `raccoon-authorize`（连接数上限） | **测试腐坏**（夹具根本没造出慢连接） | 用 `http.request` + `req.write()` 造「慢连接」，但 `http.request` 一调就把请求头**发完了** ⇒ 服务端收到的是**完整请求**、立刻回 400 并释放连接 ⇒ 第 9 个连接照样 200。实测服务端日志 8 条全是 `url="/auth/callback"`（完整）。**修法：改用裸 `net.connect` 发半截请求头**（永不结束）。⚠️ 改完后 `maxConnections = 8 → 100` 的变异**有牙**（变红），改之前**无牙**。 |
| 5 | `autoclawintl-zai-wiring`（失败后重试） | **★ 真 bug** | 回环登录服务跑在**固定端口**（`18432`，随机端口会被 Z.ai 以 `Redirect URI not registered` 拒），且响应用 **keep-alive** ⇒ 第一轮的 socket 留在客户端池里，`close()` 后池子不知道 ⇒ **第二轮取到死 socket** ⇒ `other_end closed`。**修法：`res.setHeader('Connection','close')`**（与 `raccoon-authorize` 同一处方）。 |

**五条可复用的判据（都是本轮实测，不是推理）**：

1. **「过一阵就红」先怀疑夹具的日期，不是被测代码** —— `Date.now()` 与写死的
   `NOW` 混用是最常见的一种；凡是「算未来/过期」的函数，夹具**必须**把 `nowMs` 钉住。
2. **观测量不能用粗粒度时钟** —— 墙钟毫秒不能当「写没写盘」的证据（15/20 碰撞）。
   要么受控时钟，要么换成**语义字段**。
3. **单测里任何 `resolveCredential` 非 `undefined` 都要问一句「会不会真发请求」** ——
   「有凭据 ⇒ 真拉」是多数适配器的第 ② 条腿，夹具给假凭据就等于开了一扇网络门。
4. **造「慢连接」不能用 `http.request`** —— 它的 API 自己把请求发完。要真的半截
   连接只能用裸 `net`；改完**必须做变异验证**（把 `maxConnections` 改大，看会不会红），
   否则你无法知道旧夹具测的是不是空气。
5. **固定端口的回环服务必须 `Connection: close`** —— keep-alive + 固定端口 +
   重启服务 = 死 socket 复用，这是**确定性**失败，不是偶发。
