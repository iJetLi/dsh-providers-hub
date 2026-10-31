<!-- 搬自 AGENTS.md（2026-10-06 拆分：注入预算 65,536 B，超出部分每轮被截断永不可见）。
     内容逐字节原样保留；本文件按需阅读，不进每轮注入。 -->

## ⚠️ ZCode（智谱）provider：「卡住 + 停止按钮无效」的两个根因（真实缺陷，2026-09-29）

**用户报障原文**：

> zcode 执行任务会卡住……显示「**深度求索中，用时 5分27秒...**」，
> 还没有继续输出推理或者思考……此时**停止按钮点击都没反应**，
> 我重启后才能让这个任务停止。

### 一、先记住这条判据：日志里的收尾事件可能是**伪造的**

排查时**不要**看到 `turn/end{kind:'interrupted'}` 就以为「turn 正常结束过」。
`dsh-session` 的 `openTurnClosers()`（`lib/types/repair.js`）会在加载会话时给
**打开的 turn** 补一份合成收尾，并且**复用最后一个真实事件的时间戳**
（原文：*"The last real event supplies the seq base and the timestamp for the
synthetic closers"*）。

⇒ **判据：`step/end` 与 `step/start` 同一毫秒 + `turn/end{kind:'interrupted'}`**
= 那不是真收尾，**这个 turn 从未结束**（适配器的 generator 挂在某个 `await` 上）。

本机实测三次（全是 `zcode/GLM-5.3-Flash`）：

| 会话 | `step/start` | 最后一个真实事件 | 无输出时长 |
|---|---|---|---|
| `session-a77ed457` | 17:20:57.353 | 17:38:14.442 | **1018.7 秒**（用户看到的「5分27秒」正在其中） |
| `session-fe7a9979` | 20:00:25.179 | 20:00:25.179（即 start 本身） | 直到重启宿主 |
| `session-2271311d` | 20:10:59.738 | 20:10:59.738 | 直到切换模型 |

### 二、根因 A（本次直接原因）：流式读取阶段**既无超时、也失了中断通道**

`src/zcode-adapter.ts` 旧实现把清理放在 **`fetch` 的 `finally`** 里 ——
那个 `finally` 在「响应头一到」就执行：

```ts
try { response = await this.fetchImpl(..., { signal: controller.signal }) }
finally {
  clearTimeout(timer)                                    // ← 流还没读，超时就被清了
  options.signal?.removeEventListener('abort', onAbort)  // ← 中断通道也被摘了
}
yield* consumeAnthropicSse(response.body, ...)           // ← 这一段无超时、无中断
```

而 `src/zcode-anthropic.ts` 的 `iterateSseFrames` 里是裸的
`await reader.read()`，且 `finally` 只有 `releaseLock()`。

⇒ 上游（免费通道首字节实测有 20 秒以上长尾，也会整段静默）一旦不吐数据：
`read()` 永远挂着、**`abort` 唤不醒它**、180 秒的 `requestTimeoutMs` 形同虚设、
用户点「停止」也到不了 controller —— **只能重启宿主**。

**修法**（三处，缺一不可）：

1. `iterateSseFrames(body, { signal })`：abort 时**主动 `reader.cancel()`**
   （取消底层流会让挂起的 `read()` 立刻以 `{done:true}` 收尾，这是**唯一**能唤醒
   它的手段）；循环顶部再判一次 `aborted` 兜底。
2. `finally` 里**先 `await reader.cancel()` 再 `releaseLock()`** ——
   `releaseLock()` **不关闭底层流**，上游连接会继续生成并**白扣额度**。
3. `zcode-adapter.ts`：把超时/中断的作用域提升到**整轮**
   （`stream()` 负责建 `AbortController` + 计时器，`streamScoped()` 干活），
   并把 `controller.signal` 一路传进 SSE 消费；超时收尾抛 **`TIMEOUT`**
   （可重试），**但用户中断必须原样上抛**（否则用户主动取消会被白重试）。

⚠️ 可作对照的实现：`D:\jet\code\js\dsh-free-glm\src\adapter.ts` 早已修过同型三处
（[L1897-1900](file:///D:/jet/code/js/dsh-free-glm/src/adapter.ts) 清理覆盖全流程、
[L712-729](file:///D:/jet/code/js/dsh-free-glm/src/adapter.ts) 把超时 signal 传进 SSE、
[L921-948](file:///D:/jet/code/js/dsh-free-glm/src/adapter.ts) `cancel()` 再 `releaseLock()`），
注释原文就是「**`abort` 不会唤醒 `reader.read()`**」「超时失去全部作用，请求可无限挂起」。

### 三、根因 B（同型的第二颗雷）：captcha 侧有无超时的等待，且失败后**把闸门焊死**

`src/zcode-captcha.ts`：

| 位置 | 旧行为 | 后果 |
|---|---|---|
| `acquirePage` 取页 | `while (this.pageBusy) await sleep(50)` —— **无上限、不看 signal** | 一旦标志没被复位就**永久自旋** |
| `acquirePage` 建连 | `await new Promise(... ws 'open' ...)` —— **无超时** | Chromium 僵死时 `open`/`error` 都不来 ⇒ 永久挂起 |
| `acquirePage` 建页 | `await browser.send('Target.createTarget')` 在 try **之外** | CDP 抛错后 `pageBusy` 不复位 |
| `mint()` 的 `finally` | `if (this.reusablePage === page) this.releasePage(page)` | catch 里已 `discardPage()` 把 `reusablePage` 置空 ⇒ 条件**恒为假** ⇒ `pageBusy` **永不复位** |

最后一条是**致命**的：它让「一次 captcha 失败」升级成「此后每次 mint 都死锁」——
adapter 的 `await this.mintCaptcha()` 永不返回，请求根本不发出，UI 永远「深度求索中」。

**修法**：取页自旋加 `pageWaitTimeoutMs`（默认 30s）+ 判 signal；建连加
`connectTimeoutMs`（默认 10s）；`createTarget` 包进 try；`mint()` 的 `finally`
改成 **`else this.pageBusy = false`**（无条件复位）；`mint(config, { signal })`
与 `ZcodeAuth.mintCaptcha` / `index.ts` 的注入点**逐层透传 signal**。

⚠️ 超时**不**复位别人的 `pageBusy`（此刻它属于另一个持有者，越权复位会让两个
mint 共用同一页面 —— captcha 是一次性的，必串状态）。

### 四、回归用例与**反向验证**

`tests/unit/zcode-stream-hang.spec.ts`（8 条，全部毫秒级、零网络、零额度）：

| 用例 | 反向验证（改回旧行为 ⇒ 变红） |
|---|---|
| abort 唤醒挂起的 read | 去掉 abort→`cancel` 注册 ⇒ **红**（挂到用例超时） |
| 中断必须真的 cancel 底层流 | 同上 ⇒ 红 |
| 消费方 `break` 时必须取消底层流 | 去掉 `finally` 的 `reader.cancel()` ⇒ 红（仅此条红） |
| 200 + 整段静默 ⇒ `TIMEOUT` | 不把 signal 传进 SSE 消费 ⇒ **红（挂 5s 超时）** |
| 用户中断**不得**翻译成 `TIMEOUT` | 同上 ⇒ 红 |
| 取页等待有上限 | 去掉 deadline 判定 ⇒ **红（挂 5s 超时）** |
| `mintOnPage` 失败后 `pageBusy` 必须复位 | `finally` 改回条件式 ⇒ 红 |

⚠️ 写这类用例时**判据是「在有限时间内结束」**：唤醒/超时/复位任一失效，
用例呈**挂起直到 vitest 超时**，而不是干脆的断言失败 —— 那正是线上那条路径的形状。

### 五、其它必须记住的点

- **两次 checkout 都要改**：`D:\jet\code\js\dsh-codearts` 与
  `D:\jet\code\js\deepseek-harness-codearts` 是同一插件的两份链接目录，而
  `~/.dsh/profiles/web/pnpm-lock.yaml` link 的是**后者**（GUI 加载它）、
  `desktop` 用前者。改完两份 `src/` 都要 `pnpm build:all`，且**必须重启宿主**才生效。
- `requestTimeoutMs`（`zcode-product.ts`，180s）现在**覆盖整轮**（含 captcha 与流读取），
  不再是「只到响应头」。
- captcha **当时**每请求现 mint（每次新建 page，历史实测约 1.2 秒）**不是**本次卡住的原因：
  卡住前后的请求都正常，且 17:20 那次卡死后 19:59 的 zcode 请求又成功了 ——
  若是 `pageBusy` 死锁，后续请求会**全部**一起卡。⇒ 别把 `imageUrls`/captcha 配额当成第一嫌疑人。
  ⚠ 那个 1.2 秒是「每次新建 page」时代的数字，**现行两条都已变**：页面复用（中位 426ms /
  平均 546ms）+ 按需产出（不索要验证时一次都不 mint）。口径见本章第十节与 README 的 ZCode 章节。

---

## ⚠️ ZCode 上游节流三件套（吸收自 `dsh-free-glm`，2026-09-30）

**起因**：`dsh-free-glm` 的作者指出我们的瓶颈是「每请求 +1.2s captcha」（**当时的形态**：
每请求都产、且每次新建 page；1.2 秒是那时的实测，现行口径见本章第十节）。
核对后确认：**这不仅对，而且还有第二处更大的漏算**（见第 4 条）。
本次把那边已验证的三套机制搬了过来，并顺手补上了 prompt caching 断点。

### 一、captcha **预取池**（`src/captcha-pool.ts`）

**要解决的问题**：`zcode-captcha.ts` 实测「页面空闲 <8s 复用约 0.5 秒，
更久（实测 15s 必 `F001`）要**新建页面约 3.7 秒**」，而 agent 多步循环的
两步间隔**通常大于 8 秒** ⇒ 现产路径几乎每步都付建页面的钱。

**关键依据（那边的实测，决定了「能提前产」这件事成立）**：

| 生成后经过 | 使用结果 |
|---|---|
| 0 / 10 / 30 / 60 秒 | ✅ 可用 |
| 120 秒 | ❌ 3007 |

⇒ 「一次性」只指**用一次就作废**，**不指必须立刻用**。

**实现要点（三条都是那边记过的坑）**：

1. **现产之后也要补池**。少了它，首次请求现产后池永远空，优化形同虚设。
2. **取走即补下一个**（不 await，不阻塞本次请求）。
3. **预取要 inflight 去重**，否则每轮请求都叠一个预取，白耗 captcha 配额。
4. ⚠ **`hasFresh()` 必须只读**（本次写单测时实测到的缺陷）：初版实现成
   「调一次 `takeFresh()` 看结果」，而 `takeFresh()` 会清空池 ——
   于是**看一眼就把预取好的 param 丢掉了**，池在诊断代码路过时静默失效。
   修法：拆出 `peekFresh()`（只判不删）+ `takeFresh()`（删）。

**开关**：`DSH_ZCODE_CAPTCHA_POOL=0` 关闭（关闭后与引入池之前逐字一致）；
`DSH_ZCODE_CAPTCHA_POOL_TTL_MS` 调 TTL（默认 **30 秒** —— 比那边的 45 秒保守，
因为**我们没有复测过**这个窗口，且两边的产出路径不同：它走壳内 renderer，
我们走普通 Chromium CDP。若实测无 3007 可放宽）。

**回归**：`tests/unit/captcha-pool.spec.ts`（9 条）。
反向验证：删掉 `take()` 里现产后的 `prefetch()` ⇒ 第 1 条变红。

### 二、上游**发车闸门**（`src/model-gate.ts`）

**依据（那边分模型实测）**：`429` 里的 `3009 model concurrency limit exceeded`
是**并发配额**（撞它时 token 还剩 299.4 万），且两个模型窗口明显不同：

```
GLM-5.3-Flash  605 次 200    0 次限流      ← 从未撞过
GLM-5.3         74 次 200   21 次重试     6 次最终 429
```

⇒ **串行**（不重叠）+ **按模型最小间隔**（不挨太近）。加了之后 `3009` 21 → 1 次。
参数落在 `zcode-product.ts`（`serializeUpstream` / `modelGapMs`：
`glm-5.3` 350ms、`glm-5.3-flash` 0），**不要在适配器里写死**。

⚠ **闸门只包 fetch，不包 captcha**：那边第一版把 mint 一起放进闸门，
`mintMs` 从 200-500ms 暴涨到 **2500-3100ms**（变成「排在 N 个人后面再 mint」）。

⚠ 与 `model-queue.ts` 分工不同：那个管**服务端指定的**排队时长（`10605`），
这个管**客户端自保**的发车节流。

**回归**：`tests/unit/model-gate.spec.ts`（8 条，含「等待期间中断必须生效」——
否则前面某个请求挂住会把后面全部拖死）。

### 三、额度用尽 / 无权益 → **标记 + 切号**

**两种 429 的处置必须分开**（`isZcodeConcurrencyLimited` / `isZcodeQuotaExhausted`）：

| 形态 | 判据 | 处置 |
|---|---|---|
| 并发限流 | `3009` | **退避重试**（`ZCODE.concurrencyRetryMax`=2，1500ms 线性退避），**不换号、不标记** |
| 额度用尽 | `1005 exceed quota limit` / `1113 余额不足` | **标记该账号+该模型到 UTC+8 当日 24:00**，换下一个账号重发 |
| 无权益 | **秒回空**（`EMPTY_RESPONSE` 且耗时 < `ZCODE_FAST_EMPTY_MS`=3 秒） | 同上（换号） |
| 链路卡住 | 慢回空（≈180s） | 重试 / 排查，**不换号**（换号解决不了） |

⚠ **`isZcodeQuotaExhausted` 必须先排除 `3009`** —— 否则会把一个完全可用的账号
误标成「当日用尽」（与 qoder 那次「把 rate_limit 当 billing」同型）。

⚠ **重试前必须重新 mint captcha**（一次性；在索要验证的窗口里，沿用旧的会回 `3007`）：
实现上把 `mintCaptcha()` 放在**内层循环第一行**，天然满足。

⚠ **`emitted` 闸**：一旦已向调用方 yield 过内容，就不许再切号/重试
（否则用户看到两份输出）。HTTP 层错误与空响应都发生在输出之前，不受此限。

⚠ **切号三件事**（与 `qoder-adapter.ts` 同因，缺一即空转）：
① 标记用的是**局部可变**的 `activeAccountId`（不是回调，回调切号后不跟着变）；
② 取号必须传 `tried`（池按手动顺序返回，刚失败的账号可能仍排第一）；
③ `tried` 跨重试保留。回调由 `index.ts` 的 `activeZcodeAccountId` 提供，
在 `resolveCredential` 里记录**实际返回的那个账号**。

⚠ 无法再切时抛 **`QUOTA_EXCEEDED`**（**不在** harness 的
`DEFAULT_RETRYABLE_CODES` 里）—— 不能落 `SERVER`，否则「今日额度已用尽」
这种确定性错误会被白退避重试 5 次（约 15.5 秒）。

**回归**：`tests/unit/zcode-throttle.spec.ts`（13 条：5 条纯函数 + 8 条行为，
含「3009 不标记账号」「秒回空切号」「已产出内容后不切号」「tried 传下去」）。

### 四、**prompt caching 断点**（本次额外发现的更大瓶颈）

**用户反馈**：`dsh-free-glm` 的作者说我们「每请求 +1.2s」（**当时的形态**：每请求都产、
每次新建 page；现行已改按需 + 复用，见本章第十节）。
captcha 只解释**一部分**；下面这条解释**每一步**的开销：

`toAnthropicTools()` **从不产出 `cache_control`**，而 `system` 此前**每块都打**
（3-4 块）—— 正好用满 Anthropic「单请求最多 4 个断点」的预算，
于是 `tools` 再也打不了点。而 DSH 每步带 24 个工具、约 19KB schema
（那边 P0-2 的实测原文），**每步全量重算这段 prefill**。

**修法（两处）**：

1. `zcode-identity.ts`：system **只在最后一块**打断点。前缀式缓存语义下，
   一个位于末块的断点**覆盖面等于（不小于）**每块各打一个；
   且「调用方 system（DSH 的 AGENTS.md，本仓库数十 KB）必须落在断点内」——
   只打末块天然满足。
2. `zcode-adapter.ts` 的 `withToolCacheBreakpoint()`：给**最后一个** tool 打断点
   （前缀式 ⇒ 覆盖「system + 全部 tools」整段）。总断点数 = 2 ≤ 4。

⚠ **不影响准入**：3012 的判据是身份块的**内容与结构**存在，
`cache_control` 只是缓存提示。用例断言了「断点总数 ≤ 4」。

**回归**：`tests/unit/zcode.spec.ts` 的「只在最后一块打 cache_control」等 3 条 +
`zcode-throttle.spec.ts` 的「tools 断点真的进了请求体」。

### 五、额度用尽时**必须说出真实原因**（用户报障，2026-10-01）

**用户看到的原文**：

> 本轮运行失败　`zcode: 模型返回了空响应（无任何 text / thinking / tool 内容）`
> `EMPTY_RESPONSE`　（并伴随「已重试模型请求 (5/5)」）

**两处都不对**：

| 项 | 问题 |
|---|---|
| **文案** | 说的是**现象**（没收到内容），没说**原因**（额度用尽）—— 用户无从判断该等额度、换模型还是加账号 |
| **错误码** | `EMPTY_RESPONSE` **在** harness 的 `DEFAULT_RETRYABLE_CODES` 里 ⇒ 这种**确定性**错误被白退避重试 5 次（约 15.5 秒，即截图里的 5/5） |

⚠ **这与 qoder「110 额度错误落 `SERVER`」是同型缺陷**：
**用错误码的默认归类代替了对业务语义的判断**（本文件 qoder 章节记过该教训）。

**上游为什么回「空」而不是报错**：额度耗尽时请求**根本没送达模型**
（对照那边的实测：`provider runtime headers` 请求从未出现），网关直接回
**HTTP 200 + 空内容** —— 所以它**看起来**像空响应，实际是权益问题。

**最可惜的地方：判据本来就是现成的**。`isFastEntitlementMiss()` 早就实现了
「**秒回空**（<3s）= 该账号对该模型无权益」（依据：150-200ms 空响应
vs 卡住形态的 ≈180000ms），但它此前**只用于决定「要不要切号」**，
判据本身从未进入文案 —— 于是「无法再切号」那一步抛出的还是通用裸错误。

**修法（`zcode-adapter.ts`）**：「秒回空」且**无法再切号**时 → 抛
`zcodeEntitlementErrorMessage()` 的文案 + **`QUOTA_EXCEEDED`**
（不在可重试集合里 ⇒ 立即失败）。

⚠ **文案措辞必须诚实**：不断言是「额度用尽」还是「无权益」—— 两者在 wire 上
**表现完全相同**（都是秒回空），我们**无法区分**。故写
「额度已用尽或没有可用权益」并给出两种都能解决的建议。

⚠ **不得在 `zcode-anthropic.ts` 的 SSE 层做这个分类**：那一层**拿不到耗时上下文**
（它不知道自己跑了多久），若在那里武断报「额度用尽」，**慢回空**那条路径
（链路故障，该重试）就会被误报成「换账号」。故该层保留通用文案与可重试的
`EMPTY_RESPONSE`，**分类交给适配器**（它持有 `consumeStartedAt`）。

**回归**：`tests/unit/zcode-throttle.spec.ts` 的
「额度用尽：文案必须说出真实原因、错误码必须不可重试」段（3 条：
无账号池时抛 `QUOTA_EXCEEDED` + 文案含真实原因且**不含**那句通用文案 +
慢回空不得被误判 + 多账号时才提账号数）。
反向验证：把错误码改回 `EMPTY_RESPONSE` ⇒ 第 1 条变红。

### ⚠ 改完这些要做的两件事（同 zcode 其它改动）

1. **两份 checkout 都要同步**（`D:\jet\code\js\dsh-codearts` 与
   `D:\jet\code\js\deepseek-harness-codearts`），并各自 `pnpm build:all`。
2. **必须重启宿主**才生效（插件模块在进程启动时读进内存）。

### 六、会话实证：额度耗尽 + **两个插件抢同一份 captcha 信誉**（2026-10-01）

**用户报障**：zcode 赠送额度用完后，界面报通用的「空响应」；并追问
「我们哪里设置 zcode 保活频率的？用我们的 zcode 执行任务后用 dsh-free-glm
执行会碰到错误，似乎我们保活频率太高了」。

#### 6.1 先纠正一个归属：那条 `503 降级冷却` **不是我们抛的**

用户贴的截图里的文案是 **`zcode-bridge:`** 开头 + 「降级冷却 / 连续 5 次失败 /
约 233 秒后可重试」。两处都对得上 **dsh-free-glm 的桥**：

- 前缀：我们的 provider 报错一律是 `zcode: `；`zcode-bridge:` 是它的 `PROVIDER` 名。
- 逻辑：`mintBackoffUntilMs` + `noteMintFailure()` + 指数冷却、出口在
  `dsh-free-glm/patches/zcodeBridgeServer.ts:3151`。

⚠ **顺带回答「滑块要在哪做」**：必须在**开源版实例窗口**里做。
dsh-free-glm 的桥只认源码检出的 `packages/desktop`（`appDirCandidates()`），
官方闭源版起不来桥 ⇒ 闭源版窗口**永远不会弹**它那个验证。
且**冷却期内桥直接返回 503、连 mint 都不发起**（`mintBackoffRemainingMs() > 0`），
所以要在**冷却结束后**主动发一次对话才会弹滑块。

#### 6.2 但用户的方向**成立**：确实在抢同一份设备信誉

**关键证据（两个 session，同一台机器，时间相差约 1 分钟）**：

| session | provider | 现象 |
|---|---|---|
| `session-eced01ed` | **`zcode`（我方）** | 14:26:53 起连续 **12 次**空响应失败（6 请求 × 2 turn），每次重试**都重新 mint 一个 captcha** |
| `session-b0e4eb3f` | **`zcode-bridge`（dsh-free-glm）** | 开局第 1 步就报 **`502 Failed to mint auth material`** |

⇒ captcha 信誉是**设备级**的（不是按插件算），我们多产的每个 captcha
都在消耗它的额度。**两个都开着就是在互相抢。**

⚠ **排查可复现**：会话内容在 `~/.dsh/sessions/<工作目录编码>/<session>/session.v4.jsonl.zstd`，
用 Node 内置 `zlib.zstdDecompressSync` 解压（**无需装 zstd**）。
字段是 `e.type` / `e.time` / `e.data`，**不是** `kind`/`timestamp` —— 我第一版按
猜的字段名取时间线，全部取到空值。

#### 6.3 修了什么（三处）

**① 空响应必须说出真实原因**（见上一节）：秒回空 → `QUOTA_EXCEEDED`
+ 「额度已用尽或没有可用权益」。

⚠ **判据用耗时是可行的，但要看对指标**：会话实测**单次请求耗时仅 125ms**
（`step/start 14:26:53.069` → `attempt .194`），命中 3 秒阈值。
⚠ 我一度把「重试间隔 6.858s」误当成「单次耗时」而以为修复失效 ——
**重试间隔 ≠ 单次请求耗时**，两者在日志里长得像（都是相邻 attempt 的时间差）。
`step/start → assistant/attempt` 的差才是单次耗时。

**② HTTP `body === null` 分支也是同一缺口**（本轮新发现）：

| 形态 | 分支 | 原先 |
|---|---|---|
| 200 + 空 SSE 流（0 帧） | `consumeAnthropicSse` 的 `!sawAny` | ① 已覆盖 |
| 200 + **`body === null`** | `zcode-adapter.ts` 的 `response.body === null` | ❌ 抛裸 `EMPTY_RESPONSE` |

后者**跳过整个 SSE 消费** ⇒ 哪怕 ① 修好，走这条路的用户仍看到通用文案
且白重试。现已同样改为「先换账号，换不动就 `QUOTA_EXCEEDED` + 真实文案」。

**③ captcha 产出失败退避**（`src/captcha-backoff.ts`，**本轮最重要**）：

此前我们**完全没有**这个机制 —— 额度耗尽时连 mint 12 个 captcha。
现按那边的做法（阈值 3、首次 1 分钟、指数翻倍、上限 30 分钟）加闸门：
连续产出失败达阈值后**直接抛错、不再发起 mint**。
那边的原话：「**继续请求不会让信誉恢复，只会更糟**」。

- ⚠ **`steps` 必须用 `streak - threshold`**：用 `streak` 会让第 3 次失败
  直接等到 `base × 8`（8 分钟），与「起步 1 分钟」的语义相反（用例守住了）。
- ⚠ 冷却到点**只清冷却、不清 `streak`**：否则退避重新从 1 分钟起步，
  达不到「指数」效果。
- ⚠ **只对「产出失败」计数**（`mintOnPage` 抛错），不对「上游回 `3007`」计数 ——
  后者归因不清（可能是服务端抖动），记成我们的信誉问题会误伤。
- ⚠ 闸门放在 `mintCaptcha` 的**取池之前**：这样池的 `prefetch()` 后台路径
  天然也被挡住，**不需要池自己判断退避**。
- 关闭：`DSH_ZCODE_CAPTCHA_BACKOFF=0`。

**回归**：`tests/unit/captcha-backoff.spec.ts`（7 条）+
`zcode-throttle.spec.ts` 新增 2 条（HTTP 空 body 的文案与换账号）。
反向验证：去掉 `remainingMs()` 的到点清零 ⇒ 「冷却到点后恢复」变红。

#### 6.4 仍未做的两件事（需要用户拍板）

1. **captcha 预取池默认值**：它让 mint 次数**翻倍**（每请求 1 次 + 后台预取 1 次），
   是**唯一主动加倍**信誉消耗的改动。在信誉紧张的设备上是净负面。
   建议把 `enabled` 默认值反转为 `false`（保留实现与开关）。
   ⚠ **已实测存在跨插件干扰，但未实测「预取池是否是压垮信誉的那一下」** ——
   不要把它当成已证结论。
2. **持久化 captcha profile**：我们每次 `mkdtempSync` 新建临时 profile
   （`zcode-captcha.ts:547`），而 dsh-free-glm 用 ZCode 实例的长期 profile
   ⇒ 它的信誉能跨会话累积，我们不能。**但阿里云的信誉究竟按 IP、
   按指纹还是两者加权，没有实测过** —— 若是按指纹，独立 profile 反而
   保护了对方的信誉（各算各的）；若是按 IP，我们就是在直接抢。**结论未定，勿凭推断动手。**

### 七、官方 ZCode 的 captcha 护栏（逆向 `app.asar` 实证，2026-10-01）

**起因**：用户追问「zcode 如果每一步都认证一样也会碰到上限吧，是否它不是
每步都用一个 captcha」。⇒ 去逆向**官方闭源版**安装目录核实。

#### 7.1 怎么读的（可复现）

官方安装版是 Electron 打包产物，源码在 `app.asar`（312 MB）：

```
C:\Users\Jet\AppData\Local\Programs\ZCode\resources\app.asar
```

⚠ **两个读取要点**（都踩过）：
1. asar 头是 `[u32=4][u32 headerSize][u32 jsonSize][u32 jsonStrSize]`，
   JSON 表从 **offset 16** 开始、长度 `headerSize - 8`。
2. ⚠ **JSON 表尾部有填充字节**，直接 `JSON.parse` 会报
   `Unexpected non-whitespace character after JSON` —— 必须
   `s.slice(0, s.lastIndexOf('}') + 1)` 再 parse。
3. 数据区起点 = `16 + jsonLen`；每个文件的 `offset` 是**相对数据区**的。

captcha 代码在 `/out/renderer/assets/styles-*.js`（5.8 MB）——
与 dsh-free-glm 记录的 `styles-S9_69L9k.js` 同一类产物。

#### 7.2 官方**确实是每请求一个 captcha**——但有三层我们没有的护栏

先回答用户的疑问：**不是复用**。证据：
- 每个 model request 都走 `Fnn()` → `Mnn()` 重新产出，再经 `lnn()` 注入
  `X-Aliyun-Captcha-Verify-Param` / `-Region` 两个头。
- `Snn`（param 表）**只有 `set` / `delete`，没有 `get`** ——
  它是**诊断记录表**，不是复用缓存。

但官方有三层护栏，**我们此前一条都没有**：

| 机制 | 官方实现（产物里的符号） | 我们此前 |
|---|---|---|
| **全局串行队列** | `wnn` promise 链 + `jnn()`，日志 `zcode-plan verification queue slot acquired`。同一刻只产一个 | ❌ 无（DSH 会并发发请求，每个都独立 mint） |
| **配置 TTL 缓存** | `f3()`：`expiresAt: t + 6e4`（**60 秒**）+ 在飞去重 `d3` | ❌ `index.ts` 用 `??=` 做**永久缓存** |
| **结果观测** | `mnn({result: 'traceless_passed' \| 'interactive_displayed'})` 上报 ARMS，并维护两个计数 | ❌ 完全没有 |

另有：**超时 120 秒**（`Htn = 12e4`，我们是 75 秒）；
**重复提交检测**（`Pnn()` 记住上轮 `certifyId`，相同就警告
`请求可能触发 F008 重复提交` —— 这正是 dsh-free-glm 里 `F008` 的来源）。

#### 7.3 阿里云的限流是**双维度**且有**默认阈值**（官方文档）

用户提供的文档
（[功能相关问题](https://www.alibabacloud.com/help/zh/captcha/captcha2-0/user-guide/function-related-issues)
与 [自定义策略](https://www.alibabacloud.com/help/zh/captcha/captcha2-0/user-guide/custom-policy)）：

| 维度 | 默认限制 |
|---|---|
| **同设备每小时** | **150 次** ← **最紧的一条** |
| 同设备每日 | 400 次 |
| 同 IP 每小时 | 4000 次 |
| 同 IP 每日 | 10000 次 |

⇒ 文档明确「**基于 IP 或者设备维度**的安全策略阈值」是**两个独立维度、
共同作用**。**设备维度 150/小时**才是我们真正的约束：
一次多步任务每步 1 次，**加上我此前默认开启的预取池就是 2 次/步**。

⚠ **这解释了实盘现象**：`session-eced01ed` 那种 246 步的长任务，
加上 dsh-free-glm 同期在跑，撞穿「设备每小时 150」是**大概率**而非偶然。

#### 7.4 本轮改了什么（四项，全部对齐官方）

1. **预取池默认关闭**（`captcha-pool.ts` 的 `CAPTCHA_POOL_DEFAULT_ENABLED`）。
   依据：① 官方根本没有预取；② dsh-free-glm 的池默认也是关的
   （`=1` 才启用，注释「先观察稳定性」）；③ 它让消耗**翻倍**。
   ⚠ **归因强度**：跨插件干扰有实证，但「预取池是压垮信誉的那一下」**未证实**——
   翻转的理由是①②，不是把③当结论。
2. **captcha 产出走全局串行队列**（新增 `serial-queue.ts`，接在
   `ZcodeAuth.mintCaptcha` 的**取池之前**，故池的 prefetch 后台路径也被挡）。
3. **captcha 配置改 60 秒 TTL 缓存**（新增 `ttl-cache.ts`，替换
   `index.ts` 的 `??=` 永久缓存）。⚠ 旧写法还有第二个缺陷：
   **首次失败会被永久固化**（`??=` 把回退兜底值也记住）。
4. **观测**（`ZcodeAuth.captchaObservability()`）：计数
   `tracelessPassed` / `interactiveDisplayed` / `failed`，
   并在**被要求交互式验证时显式告警**。
   ⚠ `interactive` 的判据是**轮询 DOM**（`#aliyunCaptcha-window-popup` 等
   四个 id，取自 dsh-free-glm 的实测记录）——因为官方文档 Q9 明说
   「该安全策略逻辑**不支持自定义，不对外透出**」，没有回调可用。
   用「**曾经出现**」而非「此刻存在」：交互元素在验证完成后会被移除，
   只在 success 那一刻查 DOM 会**漏报**（而那正是最需要知道的场景）。

**回归**：`serial-queue.spec.ts`（13）+ `captcha-backoff.spec.ts`（9）+
`captcha-pool.spec.ts`（9）+ **`zcode-captcha-guard.spec.ts`（6，接线验证）**。
⚠ 最后一类**不能省**：本仓库历史上多次栽在「原语写好了但没接上」
（`zcode-upstream.ts` 的 `fetchImpl` 曾是**死参数**）。
反向验证：把 `CAPTCHA_POOL_DEFAULT_ENABLED` 改回 `true` ⇒ 池用例变红；
去掉 `mintCaptcha` 的队列包装 ⇒ 接线用例的 `maxInFlight` 变 3（期望 1）。

⚠ **写这类用例的两个坑**（都踩过）：
- `ZcodeAuth extends Service`，构造时会调 `ctx.provide(...)` ⇒
  **必须用真实的 `new Context()`**，手写对象桩会在构造期抛
  `Cannot read properties of undefined (reading 'provide')`。
- 测队列时**必须先排除预取池的干扰**（池命中不调底层 mint）——
  默认已关闭，故天然走现产路径。

#### 7.5 仍未做

- **captcha 超时 75 秒 → 120 秒**（对齐官方 `Htn`）：官方值更长是给了
  交互式验证（真人拖动）留时间；我们是无感验证，75 秒对**无感**够用。
  若要支持「降级后让用户手动拖」，才需要调到 120 秒 —— 那是另一个功能。
- **持久化 profile**：见上一节，结论仍未定。
- **captcha 配置 TTL 的实盘验证**：60 秒取自官方同值，但我们**没有实测过**
  服务端配置的实际变化频率。若发现 `sceneId` 变更后仍有延迟，
  可下调 `CAPTCHA_CONFIG_TTL_MS`。

### 八、⚠️⚠️ 多账号凭据被**跨账号覆盖**（真实数据破坏缺陷，2026-10-02）

**这是本文件记录过的「构造全新对象抹掉字段」同型坑的第四次**，且这次
**破坏了用户数据**（不是显示错误）。

#### 8.1 用户报障

> 登录了 2 个账号（**两个不同微信各自收到 bigmodel 登录通知**）。
> 第二个账号有余额，但**插件里刷新积分显示 0**、发消息报
> 「额度已用尽或没有可用权益」；而 **IDE 里同一个账号发消息能收到回复**。

#### 8.2 根因（实测证据）

`refreshAll()` 与 `refreshAccountCredential()` 都拿 `this.current()` 的结果
**无条件写回目标 ref** —— 而 `current()` → `readCredentialFromPool()` 只取
**池里第一个凭据可用的账号**。于是 30 分钟一轮的续期定时器（或面板「刷新」）
把**账号 A 的凭据铺满了整个池**，抹掉账号 B 的真实凭据。

**实测证据**（用户机器 `~/.dsh/.credentials.yaml`，两个 `ZCODE_ACCOUNT_*`
逐字段比对，**ref 名与值均已脱敏**）：

| 字段 | 账号条目 #1 | 账号条目 #2 |
|---|---|---|
| 凭据 ref 名 | `ZCODE_ACCOUNT_<A>` | `ZCODE_ACCOUNT_<B>` |
| `zcode_jwt` 的 sha256 | `aa20f5d1…`（前 8 位） | **`aa20f5d1…`（相同）** |
| `device_mid` | `be4c6392…`（前 8 位） | **`be4c6392…`（相同）** |
| `account_label` | `<同一昵称>` | **`<同一昵称>`** |
| `bigmodel_access_token` 指纹 | `fe31a108…`（前 8 位） | **`fe31a108…`（相同）** |

⚠ **本文档刻意不写真实值**（ref 名会暴露账号编号、昵称是用户的微信账号名、
`device_mid` 是设备标识）。需要复核时按下方方法自行从本机取。

⇒ 两个条目**逐字节相同**，是**同一个账号占了两条**。
用户确认「是两个不同微信账号」，故**只能是覆盖所致**。

**症状为何极像服务端问题**：IDE 用它自己那份真实凭据（B）→ 正常；
插件池里两条都是 A → A 已耗尽 → 报额度用尽。
⚠ **排查要点：每当「IDE 能用而插件说没额度」，先怀疑凭据被覆盖，而不是配额。**

#### 8.3 修法：**绝不跨账号写**

ZCode **不可续期**（凭据是静态的、没有 refresh 端点），所以「刷新」唯一
正确的语义是「**逐账号重新解析自己的 ref，再写回自己**」——
与 `BuddyAuth.refreshAll` 的做法一致（那边也是逐账号读自己的 ref）。

⚠ **`refreshAll` 不再使用 `current()`**；每个账号 `readCredentialFromRef(自己的 ref)`，
解不出就**跳过并告警**，**绝不**用别的账号（或磁盘凭据）去填它。

⚠ **为什么不用磁盘 `~/.zcode/v2/credentials.json` 兜底**（听起来合理，实际不可实施）：
它是**单账号**格式，而池是**多账号**的 —— 我们**无法判断**那份磁盘凭据属于
池里**哪一个**账号。拿它去补任意一条，等于重犯同一个错误（换成「单体覆盖」）。

⚠ **旧注释的本意是错的**：「把磁盘上的最新凭据回写到每个账号的 ref，
这样用户在官方客户端重新登录后新凭据能铺开到所有条目」——
那个前提在**多账号池**下**不成立**：磁盘凭据只对应一个账号。

> 📌 **2026-10-05 更新**：上面这条「磁盘凭据」现在**根本不存在**了 ——
> 读本机 ZCode 数据的整套能力已被删除（见下方 §9）。本节保留这段推理，
> 因为它记录的仍是「为什么不能用**一份**凭据去填**多账号**池」的通用教训。

#### 8.4 回归与**反向验证**

`tests/unit/zcode-account-isolation.spec.ts`（6 条）：
「A 绝不写进 B」「池顺序颠倒时同样不串」「某账号凭据不可用时跳过而不填别的」
「`refreshAccountCredential` 只动目标 ref」「目标损坏时如实报错」
「单账号失败不影响其余」。

⚠ **已做反向验证**：把 `refreshAll` 改回「`current()` 一次然后写全部」⇒
**3 条变红**，其中一条直接复现用户症状（`expected 'account-A' to be 'account-B'`）。

⚠⚠ **反向验证本身踩了一次「假绿」**：第一次替换脚本因 **CRLF** 未匹配到方法结尾、
**静默失败**，测试全绿 —— 差点据此认为「用例抓不住旧实现」。
⇒ **改完代码做反向验证时，必须确认替换真的生效**（打印替换后的代码片段），
否则「全绿」可能是「什么都没改」。

#### 8.5 ⚠️ 两条既有测试此前**断言的是缺陷行为**（已改写）

`zcode-wiring.spec.ts` 里：

| 旧测试 | 问题 |
|---|---|
| `refreshAll 是「回写磁盘凭据」而不是续期，且逐账号隔离失败` | 测试名自称「隔离失败」，却断言 `REF_1` 与 `REF_2` **都被写入同一份磁盘凭据** —— 把 bug 固化成预期 |
| `refreshAccountCredential 无凭据时如实抛错` | 断言的文案要求用户「去官方客户端重新登录」，而多账号下那**解决不了**该账号的问题 |

⇒ 已改写为断言**正确语义**（逐账号各写各的；两个空 ref 保持空）。

⚠ **教训**：测试名里出现「…失败」「…不隔离」这类**消极措辞**时，要停下来问
「我是在断言**预期行为**，还是在记录**已知缺陷**？」后者应当写成 TODO
或直接修掉，不该固化成绿色。

#### 8.6 用户需要做的事（数据已被破坏，代码修复救不回来）

⚠ **B 的原始凭据在那次覆盖中已被抹掉，无法从残留数据恢复**。
用户需在 Jet Hub 里**重新登录**第二个微信账号。修复后的代码不会再覆盖它。

### 九、重复添加同一账号的去重（2026-10-02）

#### 9.1 ⚠⚠ 先纠正我写错过的判据：**`device_mid` 不能用来认账号**

我最初告诉用户「判据可用 `device_mid` 或 JWT 的 `user_id`」——**前半句是错的**，
写进文档会误导后来者。真相：

| 字段 | 来源 | 同一账号重新登录 |
|---|---|---|
| `device_mid` | **我们随机生成**（`generateDeviceMid()`） | **会变** ⇒ **不可作标识** |
| `user_id` | **服务端下发**（`user.data.user_id`） | **不变** ⇒ 正确判据 |

依据（`zcode-login.ts` 的实测注释）：「同一 JWT 换任意随机 UUID 都返回 200」
—— `device_mid` 的**值不被服务端绑定校验**，插件每次登录都会生成一个新的。

⚠ 若照错判据实现，**同一账号重新登录一次就会被判成新账号**，
去重功能**反向失效**（比不做还糟：用户以为去重了，实际每次登录都多一条）。
`tests/unit/zcode-dedup.spec.ts` 里有一条**专门的反例**把它钉住。

#### 9.2 `user_id` 此前**根本没被存进凭据**（去重的前提缺失）

`startLogin` 组装 `ZcodeCredential` 时**丢掉了 `loginResult.userId`** ——
登录响应里明明有（官方断言它是必需字段），但从未被搬进凭据。
故修去重必须**先补这个字段**（`src/zcode.ts` 的 `ZcodeCredential.user_id`）。

⚠ 该字段**可选**：2026-10-02 之前登录的凭据没有它。
`isUsableZcodeCredential` **不得**因缺它而拒绝（否则老用户突然无法用）——
已有用例锁住这点。

#### 9.3 判据查询：新增 `findAccountIdByIdentityField`

与既有的 `findAccountIdByCredential` **有意不同**（别合并）：

| | `findAccountIdByCredential` | `findAccountIdByIdentityField` |
|---|---|---|
| 用途 | **限流记录归属** | **通用去重** |
| 字段 | 写死两套（`access_key_id` / `access_token`） | 调用方指定 |
| `enabled` | **只看已启用** | **不看**（停用账号同样占位置） |

⚠ **必须容忍字段缺失**：读不到该字段的条目**跳过**（= 无法判断），
而不是当成「不匹配」或报错 —— 前者漏判，后者让老用户添加不了账号。

#### 9.4 时机与处置

- **时机必须在登录成功之后**：登录前只有占位条目（无凭据、无 `user_id`），
  无从判断。故去重在 `jet-hub-rpc.ts` 的 `started.result.then(...)` 里。
- **处置是「停用 + 改名」，不是删除**：
  前端 `login.poll` 靠「条目还在 + 凭据已写入」判断登录成功，
  **删掉条目会显示成「登录失败」**（事实恰恰相反），
  会误导用户反复重试。现在：`enabled: false`（⇒ 不参与选号，这就是去重的
  实际效果）+ 昵称标「（重复，已停用）」+ 日志。
- **保留原来那条不动**：它可能已被排序、改名或承载限流记录。

#### 9.5 回归与反向验证

- `tests/unit/zcode-dedup.spec.ts`（7 条）：`user_id` 能匹配 /
  **`device_mid` 不能匹配**（反例）/ 缺字段时跳过 / 空 identity /
  跨 provider 不误判 / 停用账号参与判重 / 老凭据仍可用
- `tests/unit/zcode-rpc-login.spec.ts` 新增 2 条**接线验证**：
  「同一账号添加两次 ⇒ 第二条被停用」「凭据里带上 user_id」

⚠ **已做两次反向验证**（这次特别注意确认替换**真的生效** ——
上一次因 CRLF 静默失败过）：
- 删掉 `user_id` 的搬运 ⇒ **2 条变红**（含「添加两次」那条）
- 短路 `findAccountIdByIdentityField` 调用（保留 user_id 存储）⇒
  **1 条变红**（「添加两次」那条）
⇒ 证明两类用例分别覆盖「字段没存」与「没做去重」两种失效。

⚠ **写这类用例的脚手架坑**：`AccountPool` 是**真实**实现、会读写磁盘，
必须 ① `mkdtempSync` + `DSH_JET_HUB_STATE_DIR` 隔离；
② 用 `ctx.provide('credentials', fake)`（**不是**属性赋值 ——
`AccountPool` 经 `ctx.credentials` 取服务）；
③ **不要**用 `replaceAll`（那是 Jet Hub 的导入路径，语义不同；
我第一版用它导致 3 条用例假失败）。

### 十、⚠️⚠️ **不再读取本机 ZCode 客户端的数据**（用户决策 2026-10-05，Issue IKJNPZ）

**用户决策**：「可否改成不读本机 ide 的数据，只用我们自己的 auth 流程」——
**已整体执行**。凭据现在**只有一条来源**：插件自己的 OAuth 流程
（`zcode-login.ts` → 写 `ctx.credentials`）。

#### 10.1 起因：Issue IKJNPZ 暴露了那条路的**双重失效**

用户报障（2026-10-04，issue IKJNPZ）：zai 渠道下读本机凭据得到的
`account_label` 退化成「设备xxxxxxxx」、`user_id` 缺失。

**本机实机复现**（`credentials.json` 实为 `oauth:zai:*` 一族，
`oauth:active_provider = "zai"`）：

```
zcode_jwt     ✅ len=255      device_mid  ✅ len=36
user_id       ❌ 缺失          account_label = 设备72c145cd
bigmodel_access_token ❌ 缺失   zai_access_token ❌ 缺失
```

⚠⚠ **issue 建议的修法不足以解决它自己描述的连带影响** ——
`KEY_FRAGMENTS.userInfo` 从 `'oauth:bigmodel:user_info'` 放宽成 `'user_info'`
**只能修好 `account_label`**。因为**两个渠道的 user_info 形状根本不同**：

| | 键名 | 实测形状 |
|---|---|---|
| bigmodel | `oauth:bigmodel:user_info` | `{id, username, displayName, rawProfile}` |
| **zai** | `oauth:zai:user_info` | `{user_id, email, avatar, name}` ← **没有 `id`** |

⇒ `readUserIdFromUserInfo()` 只认 `id` / `userId` / `rawProfile.user_id`，
**不认顶层 `user_id`**；`identityFromUserInfo()` 只认 `displayName` /
`username` / `rawProfile.name`，**不认 `name`** ⇒ 放宽片段后 `user_id` 与
`account_name` **仍然缺失** ⇒ `adoptOfficialCredential` 的**闸②**
（`user_id` 缺失 + 池里有其它账号 ⇒ 失败关闭）**照样拦下**。
⚠ **教训**：报障者只看了一层（键名匹配），没看下一层（**结构**不兼容）。
按建议改完仍会复现「连带影响」。

⚠ **issue 也漏了第 4 处**：`readZcodeCredential` 只填
`bigmodel_access_token`，**`zai_access_token` 是死字段**（全仓只有
`zcode-auth.ts` 的登录路径会填它）⇒ zai 账号走该路时
`fetchCodingPlanApiKey` 的 `zai ?? bigmodel` **两边都是 undefined**。

#### 10.2 删除范围（`git diff` 实测：src 净减约 700 行）

| 文件 | 删掉的东西 |
|---|---|
| `src/zcode.ts` | `readZcodeCredential` / `resolveZcodeCredential` / `readRawCredentials` / `credentialFileCandidates` / `resolveCredentialFilePath` / `decryptCredentialValue` / `deriveCredentialKey` / `pickCredential` / `KEY_FRAGMENTS` / `readDeviceMid` / `telemetryFileCandidates` / `detectZcodeAppVersion` / `labelFromUserInfo` / `identityFromUserInfo` / `readUserIdFromUserInfo` + 全部 `enc:v1:` 常量（597 → 178 行） |
| `src/zcode-auth.ts` | `ZcodeAuthOptions.readCredential` 注入点、`localCredential()`、`adoptOfficialCredential()`、`adoptIntoOrphanAccount()`、`hasStoredCredential()`、`hasOtherZcodeAccounts()`、`accountIdOf()`（−255 行） |
| `src/jet-hub-rpc.ts` | `account.create` 里的两段本机复用短路（孤儿收编 / 同 `user_id` 返回 `{reused:true}`） |

**保留**：`phoneFromUserId`（登录路径在用）、`isUsableZcodeCredential`、
`isZcodeExpired`、`ZCODE_APP_VERSION_FALLBACK`（`zcode-upstream.ts` 有 6 处用）、
`ZcodeCredential` 的全部字段、`source` 字段（**存量凭据**里可能写着 `'ide'`）。

#### 10.3 ⚠ 顺带修好 coding-plan：**一条早已断掉的链**

删除过程中发现的**既有**断链（与本次删除无因果关系）：

| | 状态 |
|---|---|
| `coding_plan_key_zai` / `_bigmodel` 的**唯一**写入点 | 上面被删的 `readZcodeCredential()` |
| 唯一能补 key 的 `fetchCodingPlanApiKey()` | **零调用方**（建好却没人调） |
| ⇒ 纯插件登录用户的 coding-plan（**付费**）通道 | **一直不可用** |

用户选择「顺手接线」后已修：`ZcodeAuth.resolveCodingPlanKey()` 由
`startLogin` 在组装凭据后调用，**best-effort + 8 秒超时 + 失败只记日志**
（没买订阅是常态，**绝不能**因此把用户挡在门外；`start-plan` 照常可用）。
⚠ **字段按「拿到哪个 OAuth token」落位**（zai → `_zai`，bigmodel → `_bigmodel`），
与 `zcode-transport.ts` 里 `zai ?? bigmodel` 的优先级一致。

⚠ **这次接线是删掉读本机凭据后**唯一**能让付费 plan 继续可用的路子** ——
不接它，装了 IDE 的用户会失去该通道（`glm-5.3` / `glm-5.3-flash`）。

#### 10.4 ⚠⚠ 防回退锁是**扫源码字面量**，不是「断言函数不存在」

`tests/unit/zcode-no-local-credential-read.spec.ts`（4 条）。理由：
删掉导出后，「有没有人重新加回读取逻辑」在运行时**无从断言** ——
新写的 `readZcodeCredentialFromDisk()` 不会让任何既有用例变红。
故改成扫 `src/*.ts`（先剥掉注释避免本文自身的说明文字误报），
命中 `.zcode/v2` / `credentials.json` / `telemetry-state.json` /
`zcode-install-manifest` / `zcode-credential-fallback` / `enc:v1:` /
`aes-256-gcm` 即失败。

⚠ **必须用词边界**：`zcode-auth.ts` 里仍有 `readStoredCredential` /
`readCredentialFromRef` / `readCredentialFromPool` 三个**合法**方法
（只读 `ctx.credentials`，不碰磁盘），裸 `/readCredential/` 会把它们一起误报 ——
我第一版就写错了，改成 `/\breadCredential\b/` 才绿。

⚠ **已做反向验证**：在 `zcode-transport.ts` 临时加回
`join(homedir(), '.zcode', 'v2', 'credentials.json')` ⇒ **1 条变红**并指出文件名；
还原后全绿。⇒ 不是同义反复。

#### 10.5 ⚠ 用户可见文案**必须同步改**，否则把用户引向无效操作

删的是能力，但**文案会留下来**。已改的三处（漏了任何一处都在误导人）：

- `zcode-adapter.ts` 的 401/1002 文案原写「请重新在**官方 ZCode 客户端**登录」
  ⇒ 现在去客户端登录**完全无效**（插件根本不读它），已改指 Jet Hub。
- `zcode-auth.ts` 的 `probe()` / `persistCurrent()` 原因文案原写
  「若已装官方 ZCode 客户端并登录过，本插件也会自动读取它的凭据」。
- `zcode-adapter.ts` 的 `MISSING_CREDENTIAL` 文案同款。

⚠ `types.ts` 的 `reused` 字段**保留**（当前已无 provider 会返回 `true`），
理由：它是**契约防御**（判据写成「后端声明复用则 `loginUrl` 为空是正常的」，
比反过来假设「空串必是错误」更稳），不必为一次能力下线去改前端渲染分支。
`forceNew` 则**已删**（前端 2026-10-02 起不再传、后端也不再读 = 无操作）。

#### 10.6 踩过的两个坑

1. ⚠ **反向验证脚本本身出错，比反向验证失败更危险**：第一次用
   `PowerShell -replace` 时把拼接表达式写进了参数位（`-replace` 只接 3 个参数），
   脚本在写入前抛错，`$mutated` 仍为空 ⇒ **把源文件清空了**，
   测试报的却是 `ZcodeAuth is not a constructor`（看着像接线坏了，其实是文件没了）。
   ⇒ 教训：**写回前必须校验**（`if ($mutated -eq $backup) { 还原; throw }`
   外加字符数变化量守卫）。第二次加守卫后又因阈值过严（403 > 400）主动中止并还原 ——
   守卫本身是对的。
2. ⚠ **mock `runZcodeLogin` 必须回调 `onAuthorizeUrl`**：`startLogin` 是两步式，
   它 `await` 一个**只由该回调 resolve** 的 `urlPromise` ⇒ 替身不回调就整条用例
   5 秒超时，症状看起来像「接线失败」。且**别用逐条 `mockImplementation`**：
   `() => fakeLogin(...)` 这个箭头函数**不接参数**，会把含 `onAuthorizeUrl` 的
   `options` 整个吞掉 —— 同一个坑的第二个入口。正确做法是**可变状态** +
   单一实现始终透传参数（`zcode-coding-plan-key.spec.ts` 即此写法）。

#### 10.7 回归与反向验证

- `zcode-no-local-credential-read.spec.ts`（4 条，防回退）——反向验证过（1 条变红）。
- `zcode-coding-plan-key.spec.ts`（6 条，coding-plan 接线）——**反向验证过**：
  摘掉 `startLogin` 里那 4 行接线 ⇒ **恰好 2 条**「换到 key」变红
  （`expected undefined to be 'AK-1.SECRET'`），另 4 条「不牵连登录」仍绿
  ⇒ 说明两类用例分别覆盖「接上了」与「失败不炸」两种失效。
- 5 个受影响的既有 spec 改用**真实 `ctx.credentials` 路径**注入凭据
  （不再用已删的 `readCredential` 注入点）—— 这反而是**更好的测试**：
  它们现在覆盖的是生产环境真正走的路径。

⚠ **子代理并发改测试时的竞态**：本次两个 agent 并行改测试，其中一个在跑全量时
撞上我正在用脚本改写 `src/zcode-auth.ts`，`readFileSync` 读到空串报
`expected '' to match /extends Service/`。**那不是缺陷，是写入竞态** ——
**改完必须整体重跑全量**再下结论。

## ⚠️⚠️ `3012` 的 HTTP 状态码是 **405**（不是 403），且身份块**之外**的变量已全部排除（Issue IKJI0Y，2026-10-03）

**用户报障**（issue IKJI0Y）：免费通道调用模型返回
`上游风控拦截（3012 unusual activity）`，但他**逐字核对了身份块**
（`2898` 字符 vs 声明的 `2900`），怀疑还有别的触发因素。
且他指出错误文案**没有任何可观测信息**，排查只能靠猜。

### 一、复测结论：**唯一的判据仍然是身份块**

本机**复现了 3012**（三个账号、17 次真实请求）。消融矩阵：

| 消融 | 结果 |
|---|---|
| 裸请求（无身份块·无日期块·极简头） | ✗ **405 + 3012** |
| 无身份块、其余官方头齐全 | ✗ **405 + 3012** |
| **有**身份块 + **极简**头（无任何 `X-*`） | ✓ 200 |
| 有身份块、**不带日期块** | ✓ 200 |
| 有身份块、`app_version` 报 `3.14.4` / `4.0.0` | ✓ 200 |
| 三个账号各一发完整形态 | ✓ 200 ×3 |
| 多轮历史（`tool_use` / `tool_result`） | ✓ 200 |
| 带 `tools`（DSH 每步 24 个） | ✓ 200 |
| **单账号无间隔连发 6 发** | ✓ 200 ×6 |
| 无 `Authorization`（阴性对照） | 401（鉴权与身份块相互独立） |

⇒ **频率、并发、多轮历史、工具声明、版本头、账号池**均**非**判据。

### 二、⚠️ 两条**必须修正**的旧说法（别再照旧口径排查）

1. **HTTP 状态码是 `405`，不是 `403`**。按 403 排查会一路走到
   「风控 = 鉴权/权限」的错误分支。响应体还带 **`logid`** ——
   向用户索取现场时**优先要它**（上游侧排障凭据）。
2. **日期块在这个窗口不是判据**（去掉照样 200）。它仍**照发**
   （官方如此、零成本），但它与身份块是**必要非充分** ——
   ❌ **不要再把「3012 的最后一个开关」当成唯一结论**（那句来自早期窗口）。

⚠ 顺带纠正一处**文档数字打架**：`zcode-identity.ts` 头注释曾写
「`cliPrefix + stable（前两块）= 2355`」与「完整四块 = 7599」，
而实际 `stable` 是**三段**、合计 **2856**，前缀后共 **2898**；
README 曾写 2900。⇒ 三处已统一为 **2898**，单测锁死 `42+2856`。
（`tests/unit/zcode.spec.ts` 那条「>2300 且 <3000」的量级断言保留，
但它**锁不住**逐段数字 —— 新增的诊断用例补上了逐段断言。）

⚠ **因此「身份块达标仍 3012」目前没有已知解释**。若再遇到，
唯一能区分「账号自身被标记」与「共用出口 IP 被标记」的办法是**看诊断行**。

### 三、本次新增：`3012` 的错误文案带**可观测诊断行**

新文件 **`src/zcode-diagnostics.ts`**（进程级，**不落盘** ——
与 `captcha-requirement.ts` 同口径：`jet-hub/state.json` 是同机多 profile
共享的 home 级文档，落盘会把一个 profile 的画像传染给另一个）。

实测输出：

```
zcode: 上游风控拦截（3012 unusual activity）。⚠ …请勿连续重试。
本机诊断：账号#1 · 本进程 成功 1/失败 2 · 最近成功 1分29秒前 · 距上条 2.4s ·
身份块 2898 字符(42+2856) · 日期块 有 · HTTP 405
原始响应：request has been blocked due to unusual activity.
```

⚠ **三条不能写错的设计**：

1. **诊断行绝不含凭据**。账号只以**进程内自增序号**（`账号#N`）出现，
   不含 accountId / JWT / device_mid 的任何片段。
   用例用「**逐子串排除**」（连 `1a2b` 这种半截都排除）钉死这条 ——
   防止将来有人「图方便」改成截前 8 位。
2. **身份块字符数必须读「实际构造出来的 `system`」，不是常量**。
   常量只能证明「源码里写了多少字」，证明不了「线上发出去多少字」。
   真出现「身份块没进请求体」时会如实显示 `0 字符`，
   而不会显示 2898 把问题盖住。⚠ 用例专门断言了这一条。
3. **`距上条` 的分母是 `previousSentAt`，不是 `lastSentAt`**。
   适配器的调用顺序是「先 `noteZcodeRequestSent` 记**本次**、再在失败时诊断」，
   两者用同一个 `sentAt` ⇒ 若诊断读 `lastSentAt`，算出来**恒为 `0ms`**。
   ⚠ 这个缺陷是**端到端脚本真的打印出 `距上条 0ms` 才暴露的** ——
   首版单测按「记一条旧的、直接诊断一条新的」写，**全绿但是假绿**。

⚠ **单测必须按适配器的真实调用顺序写**（先记本次、再诊断）。
这是本条最容易重犯的地方：写反了用例照样绿。

⚠ `formatGap` 的分钟/小时档要**逐档单独算**（初版写成
`${Math.floor(seconds % 60)}分` ⇒ 90 秒渲染成「30分30秒」，
同样是在**真实输出**里才发现的，纯函数单测当时没覆盖 ≥60 秒）。

⚠ 只给 **3012** 附诊断：`3009` / `1005` / `3007` 的文案**本身已说明原因**，
附加只会让它们变脏（且各有单测钉住措辞）。
**不传诊断时行为与原来逐字一致**（旧调用点不受影响）。

⚠ `noteZcodeRequestOk/Failed` 必须用**局部可变的** `activeAccountId`
（切号后会变），与额度切号那段是同一条纪律：标记要记在真正发出这条请求的
账号上，否则切到 B 之后失败会把账记到 A 头上。

**回归**：`tests/unit/zcode-diagnostics.spec.ts`（17 条）。
⚠ **已做四轮反向验证**：诊断改读常量 ⇒ 1 条红；诊断行塞 accountId ⇒ 2 条红；
间隔退回读 `lastSentAt` ⇒ 3 条红；`formatGap` 退回旧 bug ⇒ 2 条红。

取证脚本（**均只读、零额度**）：`scripts/probe-zcode-3012-issue.mjs`（身份块自检 +
消融）、`scripts/probe-zcode-3012-matrix.mjs`（负向对照矩阵，**会真的触发 3012** ——
⚠ 有冷却惩罚，跑前先想清楚）、`scripts/probe-zcode-3012-accounts.mjs`（账号/多轮/频率）、
`scripts/verify-zcode-3012-diagnostic.mjs`（用实测响应体做端到端文案组装，**零网络**）。

## ⚠️ ZCode captcha 的真实形状（2026-10-01，3.14.4 之后）

**官方 3.14.4（2026-09-29 发布）更新说明：「关闭模型请求验证码校验」。**
我们随后直连上游实测（`scripts/probe-claim-gate.mjs` 等）得到两个结论级的判据：

| 端点 | 不带验证头 | 结论 |
|---|---|---|
| `/api/v1/zcode-plan/anthropic`（模型请求） | **HTTP 200**（6 个采样点，正文正常） | **不再索要** ⇒ 推理路径 mint 次数**恒为 0** |
| `/api/v1/zcode-plan/billing/claim`（领取） | `400 / 3007`（带**非法** captcha 同样 3007） | **始终索要**，校验**前置于** plan 校验 ⇒ mint 只剩这条低频路径 |

⚠ **三条不许再犯的**：
1. **判据只能来自直连实测**。我们走的是 `zcode.z.ai` 的 HTTP，与客户端是哪种构建无关。
2. **静态取证用错基准会得出假结论**：我曾拿本机 3.14.3 与 scoop 3.14.4 的 renderer 产物
   做符号对比，想据此判断"官方是否索要" —— 但**两个都是开源构建**（`@zcode/desktop` +
   `workspace:*` 依赖），而**开源版本来就不带 captcha 生产者**（开源/闭源差异见 bonus-plan
   文档），于是 3.14.3 的"零命中"被误当成"官方不索要"的证据。真相来自上游实测。
3. **"窗口期不校验"这个说法已经作废**：此前 6 次采样"不带也 200"并不是时段现象，
   而是 3.14.4 之后的**常态**（模型请求）。别再为此挂哨兵等窗口。

**桌面内部载体（`src/captcha-supply.ts` / `captcha-carrier.ts` / `captcha-carrier-server.ts`
/ `zcode-carrier-page.ts` + `plugin-src/client/zcode-carrier.js`）**：
`dshDesktop.browser.acquire()` → 隐藏 `<webview src="about:blank#<lease>">` → 问
`captcha.carrierUrl` 要地址 → 导航到那个**独立回环端口**上的载体页 → `executeJavaScript` 读
`window.__zcodeCaptcha` → RPC 回传供给槽。**零 CDP、零 DSH 本体源码改动**（走官方
sidebar-browser 自己的通道）。

### ⚠⚠ 载体页**必须**另起一个回环端口（2026-10-02 真机取证，别再改回同源）
初版把页面挂在插件自己的 `/api/jet-hub/captcha-carrier`，理由是"与 GUI 同源"—— **这个前提是错的，
真机上收益恒为 0**。DSH Desktop 0.2.0-rc.2 的 `resources/app.asar/lib/main.js` 原文：

| 判据 | 后果 |
|---|---|
| `allowedNavigation(v)` = http(s) + 无账号密码 + `!isApplicationHost(url)` | 命中即 `preventDefault` |
| `isApplicationHost(u)` = **`u.port === host.port`** 且（主机相同或回环） | 插件 API 与 Host 同端口 ⇒ 命中 |
| `onBeforeRequest`：命中 `isApplicationHost` 就 `callback({cancel:true})` | 请求发不出去 |
| `acquire()`：`partition = \`dsh-sidebar-browser-${randomUUID()}\`` | **无 `persist:`** ⇒ 内存 session，没有 Host 会话 cookie |

⇒ 桌面 GUI 真实 origin 是自定义 scheme `dsh-app://app/`，插件 API 由 `forwardWebRequest(request,
hostUrl, hostCookie)` 转发到 `http://127.0.0.1:<host 端口>` ⇒ 载体页挂在那个端口上
**每轮都在第一个判断退出、guest 都不建**，且失败被 `preventDefault` 吞掉，日志一切正常。
✅ **`isApplicationHost` 要求端口相同 ⇒ 换端口即绕开** ⇒ server 侧懒起一个
**只监听 `127.0.0.1`、只有 `GET /carrier`、只回静态 HTML** 的小服务（`src/captcha-carrier-server.ts`），
client **每轮**问 `captcha.carrierUrl`（`null` ⇒ 记 `no-carrier-url` 并安静退出）。
⚠ 那条 `/api/jet-hub/captcha-carrier` 旧路由**保留**（web 版下手工诊断用），但**不许**再拿它当 guest 入口。

✅ **真机已实测通过**（2026-10-01，DSH Desktop 0.2.0-rc.2 真窗口，开机自检逐段）：
`carrierUrl` → `http://127.0.0.1:19469/carrier`（插件自起的独立随机端口）→ `acquire` 得
`dsh-sidebar-browser-f34495a3-…` → 隐藏 `<webview>` 导航 → 注入读回 `origin=http://127.0.0.1:19469`
⇒ **换端口确实绕开了 `isApplicationHost`** → guest 里成功产出 `len=280` / `interactive=false`。
⚠ **只剩「上游接不接受这个 param」未实测** —— 领取是真实操作、会消耗用户额度，不代跑；
它由降级链第 ④ 条兜住（当次换 chromium + 累计 3 次禁用内部载体）。
⚠ 排查看日志里的 `reason=<分类码>`（人话见 `CARRIER_FAILURE_LABELS`）。

⚠ **设备信誉不跨启动**（2026-10-02 纠正 I4）：主进程按 workspace 键缓存 partition，但那张表在
**进程内存**里、partition 名**没有 `persist:` 前缀** ⇒ 内存 session。
**同一次运行内**释放/重建 guest 仍是同一台设备；**DSH 一关，下次启动就是一台全新设备**
⇒ 跨启动信誉不保留，这会**抬高**被降级成交互式验证的概率。
那个信号现在会随 `captcha.contribute` 的 `interactive` 字段回传 host 并 `warn`
（`captchaSupplyStats().interactive` / `pendingInteractive`，见 `carrier.stats().supply`）。

⚠ **收益口径**：需求位只挂在 **claim** 入口（`ZcodeAuth.claimDailyWith` 的 try/finally），
而 client 产一个 param 要 2–4 秒 > 槽的 1.5 秒等待 ⇒ **首个 plan 多数仍走 chromium**。
内部载体的价值是**去掉对 chromium 的依赖**（没装可用 chromium 的用户从"领不了额度"变可领），
**不是提速**。降级链：槽内有就用 → 空则等 ≤1.5s → 等不到用 chromium → 内部 param 被 `3007` 拒
则当次改用 chromium 重发、累计 3 次禁用内部载体（`DSH_ZCODE_INTERNAL_CARRIER=0` 可全关）。
⚠ 这条降级链**领取路径也接上了**（`claimDailyWith` 内，评审 C4）：领取端点**始终**索要 captcha
且校验前置于 plan 校验，是内部 param 最容易被拒的地方；重发**上限一次**，
换 chromium 后仍被拒的文案要能让用户看出「这更像设备信誉问题」。

### ⚠⚠⚠ captcha 的 **region 必须与产 param 的那份配置同源**（Issue IKJNPS，2026-10-05）

**真实缺陷**（用户报障，Gitee issue IKJNPS）：z.ai 国际渠道账号点「一键领取」**恒失败**
`captcha 校验失败（zcode-v3-start-plan-trust-1004）`，15/15 全部 `400 / code 3007`；
同账号在 ZCode IDE 里正常。多账号 / web 版 / 桌面版 / 换浏览器链路都一样。

**根因**：region 与 param 是**两份真相**。

| | 修复前取自 | 值 |
|---|---|---|
| param（`mintCaptcha` 用的配置） | 调用方 `fetchCaptchaConfig()` → **服务端下发** | `sgp` |
| 请求头 `x-aliyun-captcha-verify-region` | `claimDailyFor` 的**默认参数** `ZCODE_CAPTCHA_FALLBACK.region` | `cn` |

阿里云验签把 param 与 region **成对**校验 ⇒ 不一致即 `3007`。
⚠ **作者本人在 cn 区**（本仓库兜底常量与 README 实测记录都是 `cn`），所以本地永远复现不到；
**非 cn 区账号 100% 复现**。⚠ 这类「本地默认值恰好等于服务端值」的缺陷具有**零本地症状**。

**修法（采纳 issue 的第 2 条：配置成为唯一真相源）**：
- `ZcodeAuth.claimDailyWith` 在 **plan 循环之前**解析**一次**配置
  （`fetchCaptchaConfig().catch(() => undefined) ?? ZCODE_CAPTCHA_FALLBACK`），
  同时落进 `this.captchaMintConfig`（`CaptchaCarrier` 那条 chromium 兜底腿读它），
  `region = captchaRegion ?? captchaConfig.region`；
- 注入回调的类型改成 `ZcodeClaimCaptchaMint = (config: ZcodeCaptchaConfig) => Promise<string>`，
  **实参就是那份配置**；`jet-hub-rpc.ts` 里改为 `async (config) => zcode.mintCaptcha(config)`
  （原来自己再拉一次 —— 那正是「两份真相」的来源）；
- `claimDailyFor` / `claimDaily` 的 `captchaRegion` **取消 `cn` 默认值**（可选覆盖仍保留）；
  `3007` 换链重发**沿用同一份配置**（换 param 不换 region）。

⚠⚠ **同型第二个实例（推理路径，别只修领取）**：`zcode-adapter.ts` 组头时原来恒写
`this.options.captchaRegion ?? 'cn'`，而 param 来自 `resolveZcodeCaptchaConfig()`（远端）。
现为 `this.captchaConfig?.region ?? this.options.captchaRegion ?? 'cn'` ——
`this.captchaConfig` 由 mint 回调里的 `setCaptchaConfig(remote)` 写入，且 **mint 先于组头**，
所以读到的一定是**本次 param 用的那份**。`index.ts` 里那个字面量降级为「连配置都没有」的兜底。

⚠ **`TtlCache` 连 `undefined` 也缓存**（`get()` 无条件 `write(value)`），
而 `fetchZcodeCaptchaConfig` 自己吞掉全部异常返回 `undefined`
⇒ **数「`/client/configs` 请求次数」判不出「配置是否被重复解析」**（实测把解析搬进
for 循环，用例仍全绿）。「只解析一次」只能锁**源码结构**（解析在 `for` 之前）。

回归用例 `tests/unit/zcode-captcha-region.spec.ts`（8 条：sgp 同源 / 失败一起退兜底 /
显式覆盖 / 循环前解析 / `3007` 重发仍同源 / 推理路径同源 / 两条源码看守）。
⚠ 已做**反向验证**：region 改回兜底常量 ⇒ 3 条红；适配器改回写死 `cn` ⇒ 推理那条红；
解析搬进循环 ⇒ 结构那条红。

⚠ **issue 附注的「web 版 3007 不重试」维持现状**（不是遗漏）：`source === 'chromium'`
本身就说明**载体链本轮没参与**（web 版拿不到 `dshDesktop.browser` ⇒ `supplied` 恒 0，
或 env 关了）⇒ **没有第二条链可换**；且重试只白扣同设备每小时 150 次配额，
面对同一个服务端判定期限期望收益极低。修好 region 后 chromium 侧残留的 `3007` 都是时效/信誉性质。

## ⚠️⚠️ 冷启动切号空转：代价是**硬失败**（不是「慢一发」），且 `tried` 有**三重冗余**（2026-10-06）

**用户报障**：「用完余额一个号就自动卡死了，不会切下一个号。」

### 一、根因与修法（`src/zcode-adapter.ts` 的 `streamScoped`）

`currentAccountId()` 读的是 `index.ts` 的 `activeZcodeAccountId` 那个 Map，
而它**只在 `resolveCredential` 内部被写入**。原先顺序是反的：

```ts
let activeAccountId = this.options.currentAccountId?.()      // ← 先读（冷启动时是空的）
let credential = await this.resolveCredentialOrThrow(options) // ← 后写
```

⇒ `activeAccountId === undefined` ⇒ `switchAccountOnQuota()` 的守卫整段跳过
（**既不标记、也不放进 `tried`**）⇒ 池按手动顺序返回的第一个候选正是刚失败的那个
⇒ 这次「切号」切回同一账号、同一份凭据，白发一发。
**修法：取凭据移到读 id 之前**，让两者指向同一账号。

### 二、⚠ 代价是**硬失败**，别再说成「空转一发」（复审实测，2026-10-06）

受 `quotaSwitchMax === 2` 限制，一次请求最多 3 发。「空转」那一发把切号预算吃掉一格：

| 池 | 修复前 | 修复后 |
|---|---|---|
| 2 账号（A 用尽、B 可用） | `[A, A, B]` **成功** | `[A, B]` 成功 |
| **3 账号（A、B 用尽、C 可用）** | **`[A, A, B]` ⇒ 抛 `QUOTA_EXCEEDED`，C 从未被尝试** | `[A, B, C]` 成功 |

⇒ **池里最后一个账号永远够不着**，用户看到「所有号都用完了」而那个号还有额度。
报障措辞「卡死」是**准确的** —— 把它降级描述成「慢一发」会让人低估修复价值。

⚠ **回归必须用 ≥3 账号池**：2 账号池下缺陷版也能成功（`[A,A,B]`），
**复现不出用户症状**。`tests/unit/zcode-rotation-coldstart.spec.ts` 第 1 条就是它，别改成 2 账号池。

### 三、⚠ `tried` 与限流标记是**三重冗余**，行为测试锁不住「谁负责排除」

排除刚失败的账号有三道防线：① `streamScoped` 顶部的 `tried.add`；
② `switchAccountOnQuota` 内部同一个 add；③ 写进池的 `modelRateLimits`
（`getAvailableAccount` 自己会过滤）。

⇒ **单点删除任一处，行为断言仍然全绿**（2026-10-06 复审实测：删 ① 绿、删 ② 绿、
删两处才红）。这不是缺陷而是 defense-in-depth，但它意味着**行为测试对接线零区分能力**。
故该 spec 第 4 条直接断言**契约**：首次切号传给池的 `tried` 必须含失败账号
（删两处 ⇒ 变空）、且必须写下该模型的限流标记（删写入 ⇒ `marks` 为空）。
⚠ 实测口径：删**两处** `tried.add` 时第 4 条变红而第 1~3 条仍绿；
删标记写入时第 4 条同样变红。

### 四、⚠ 兜底路径（`zcode.current()`）**不是**缺陷 —— 别「顺手修」

池被筛空时落 `index.ts` 的 `zcode.current()` 兜底（它不看 `enabled`/限流，照样返回凭据），
此时 `activeAccountId === undefined` ⇒ 守卫跳过 ⇒ **不标记任何账号**。

复审用 5 条独立探针实测后判定：**这是对的，不是漏修**。
`getAvailableAccount` 本身就按 `enabled` + `modelRateLimits` 过滤，
**能走到兜底就意味着已无「enabled 且未限流」的账号可切** —— 标记谁都不会让它被选中，
只会写一条永远不起作用的记录。正确行为是「只发 1 发、不写无效标记、如实报 `QUOTA_EXCEEDED`」，
spec 第 5 条把它钉住（防止将来有人「顺手补上标记」）。

### 五、⚠⚠ 教训：**「未经证实的修复」不得随同真修复夹带合入**

同批还有一个「边缘拦截页归不可重试」的改动，声称「48 小时实测 127 次」。
复审解压全部 577 个会话日志复核：**405+HTML 命中 100% 来自该 PR 自己的 diff 与测试代码**，
排除后真实会话里为 **0 处**；注释声称「与 `probe-jethub-models.mjs` 同口径」，
而该文件**在整个 git 历史中不存在**。

而它引入的是**真实可用性回归**（master vs 该改动）：

| 响应 | master | 该改动 |
|---|---|---|
| 502 nginx 页 `<html>…502 Bad Gateway…` | `SERVER`（可重试） | **`PERMISSION`** |
| **504 阿里云 ALB 页（2026-09-29 真实 zcode 响应）** | `SERVER` | **`PERMISSION`** |
| 429 被 CDN 包成 HTML（本仓库 `account-pool.ts` 自己记过的形态） | `RATE_LIMIT` | **`PERMISSION`** |

`PERMISSION` **不在** `DEFAULT_RETRYABLE_CODES`（`[EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT]`）
⇒ 标准可重试的瞬态网关错误被降为不可重试。且该 PR 的描述**明确承诺「只含冷启动修复」**，
diff 里却带着这一整段 ⇒ 维护者按描述复审会放行一段未复审的改动。**已整体剔除。**

两条可复用的审查规则：
1. **「N 次实测」必须能定位到一手响应**；若统计口径命中的是**判据自己的字面量**
   （如 `data-spm` 出现在 diff/测试文本里），那是自我指涉的循环论证，不构成证据。
2. **凡新增「不可重试」判据，必须逐个验证既有可重试形态不被吞掉** ——
   只拿纯文本样本断言「普通 5xx 仍可重试」（`'service unavailable'`）会**恰好绕开 HTML 形态**，
   给出假保证。要拿 nginx/ALB 的**真实 HTML 页**当样本。

### 六、⚠⚠ 浏览器候选链：Windows 上 `homedir()` **恒等于** `USERPROFILE` ⇒ 行为判据不可用（PR #75，2026-10-06）

第三方（@Ghandi）提交 PR #75，指出「探测跟随 `os.homedir()`」那条用例
（`tests/unit/zcode-browser-detection.spec.ts`）**恒真**。本机复核后**结论要分两半**：

**✅ 成立的一半**：原用例**确实守不住目标**，但**根因与 PR 作者所述不同**，
且在 **Windows 上同样恒真**（他只验了 macOS）。原用例靠
`setEnv('USERPROFILE', dir)` 造家目录变化，而本机实测：

```
未变异：homedir() = C:\Users\Jet\AppData\Local\Temp\zcode-browser-home-KGiOeH  found = undefined
变异后：homedir() = C:\Users\Jet\AppData\Local\Temp\zcode-browser-home-RP5R3e  found = undefined
                                          ← 逐字相同 ⇒ 用例照样全绿
```

根因：**Windows 上 `os.homedir()` 本身就取自 `USERPROFILE`** ——
「读 `homedir()`」与「读死 `USERPROFILE`」算出**同一个值**，
任何基于「结论是否变化」的判据都**不可能**区分二者。
⇒ **别再用「改 env 看结论」判这一条**，跨平台都不可行。

**⚠️ 不成立的一半**：PR #75 把该用例改判「`home` 注入口被尊重」
（纯函数 + 钉平台 + `realHomeScoop()` 反向判据）。那条**本身是有效的**
（变异 `const home = homedir()` 确实变红，已复核），但它守的是
**另一个更弱的性质** —— 「注入口被尊重」**推不出**「没给注入口时回落到 `homedir()`」。
⇒ **PR 合入后，那条本文件头声称要守的性质一度完全无人看守**：
实测把实现改成 `input.home ?? process.env.USERPROFILE ?? homedir()`，
`zcode-browser-*.spec.ts` **43 条全绿**、全量 **6060 条全绿**。

**⇒ 已补结构判据**（同文件末尾两条）：剥注释后扫源码，
断言三个分支函数体内无 `USERPROFILE`、且 `home` 默认值仍为 `input.home ?? homedir()`。
范式取自 `raccoon-client-independence.spec.ts`（「不读取任何环境变量」）。
**三种绕过实测全部变红**：① 默认链加 `?? process.env.USERPROFILE`；
② 在 `windowsBrowserCandidates` 里偷读 `process.env.USERPROFILE`；
③ 拆成 `process.env['USER' + 'PROFILE']`。
⚠ 另加一条「扫描健壮性」护栏（证明真扫到了四个函数 + 代码正文），
否则「一个文件都没扫到」会让整条判据**静默恒真** —— 同 `raccoon` 那条的教训。

**三条可复用规则**：

1. **改断注入口的测试前，先问「被守的性质是否等价」** —— 新判据可失败 ≠ 原性质被守住。
   守「注入口被尊重」与守「默认值来自 `homedir()`」是**两条不同的断言**。
2. **`homedir()` 与 `USERPROFILE` 在 Windows 上不可区分** ⇒ 这类契约只能**结构判据**守，
   任何行为判据（改 env、看结论、比对路径）在 Windows 上都会恒真。
3. **扫描类断言必须自带「扫到了东西」的护栏**，否则空扫描 = 全绿。

⚠ 同批关联：IKJMQ5（CWD 竞态）与 IKJPBJ（墙钟定时器）由 PR #75 一并关联关闭。

#### 六之补、⚠⚠ 那条结构判据**自己也漏了调用点** —— 单维度判据各漏一半（IKJS58 复核，2026-10-08）

PR #75 + `9f133b0` 合入后，判据的**扫描域是「三个分支函数体 + 一个赋值点」**，
而**调用点不在内**。于是把注入搬到调用方即可全绿（本机 Windows 实测）：

```ts
for (const candidate of browserCandidates({ home: process.env.USERPROFILE })) {
```

`zcode-browser-*.spec.ts` **34 条全绿**（含新加的两条结构判据）。它在
「`USERPROFILE` 被沙箱/CI 改写」时与坏实现**行为等价** —— 正是本文件
「### 2」要防的场景，只是换了个位置。

**修这条判据时踩了多次坑 —— 结论是：判据需要「属性 + 位置」两个维度，
但即便如此，纯文本判据也堵不住这类绕过。**

| 版次 | 判据 | 漏掉的绕过（均实测） |
|---|---|---|
| 初版 | `process.env` **出现次数 == 1** | `process['env']`（无该字面量）、裸 `const p = process` |
| 二版 | 只锁**属性名**白名单 `{platform, env, kill}` | `process.env` 搬到**调用点**（属性名 `env` 仍合法） |
| 三版 | 加位置维度，用 `split(ENV_DEFAULT).join('')` **剔除** | ⚠ **自身缺陷**：剔除是全局的，把 `(input.env ?? process.env).USERPROFILE` 里的**坏用法连同合法串一起剔除** ⇒ 自豁免 |
| **现版** | 属性白名单 **+** 位置用**计数 == 1**（不自豁免） | 见下方「原理上不可判定」清单 |

⚠⚠ **`split/join` 剔除法是反例，别再用**：它让「合法串出现第二次」即可豁免自己。
计数法（`process.env` 恰好 1 处）不会自豁免 —— 那个坏实现会数到 2 处、直接变红。
（这条修正是**审计实测**发现的，不是推理。）

⚠⚠ **`fnBody` 必须跳过参数列表**（本轮修的真实缺陷）：早期实现直接
`indexOf('{', start)` 取第一个 `{` —— 对 `browserCandidates` 这种**参数是对象
字面量类型**的函数，那个 `{` 落在**参数类型注解**里，于是「函数体」只截到
`{ platform?: …; env?: … }` 就结束（实测 len=103），**真正的函数体一行都没扫到**
⇒ 依赖它的断言**静默恒真**。修法：先按圆括号配对跳过参数列表，再取 `{`。
这次是「扫描类断言必须自带护栏」的又一实例。

⚠⚠ **判据只扫候选链的 5 个函数体，不扫全文件**：扫全文件会让
`process.pid` / `process.hrtime` / `process.stdout` / `process.env.NODE_ENV`
这类**与家目录无关**的新增用法全部**假失败**（审计实测 4 例）。
窄域把假失败面压到「与家目录真正相关的区域」。

⚠⚠ **裸 `process` 的负前瞻不能用 `\s*`**：`\s` 会**跨行**，
`const p = process` + 换行 + 下一行的标识符被当成续接，负前瞻失效
⇒ 实测漏掉「裸 process 别名」这条。必须用 `[ \t]*` 限定同行。

⚠⚠ **`process . env`（点前后空白）必须归一**再判：`process.  env` 不含
`process.env` 连续字面量，会**同时**绕过位置维度与正向锚定 ⇒ 实测全绿。
现版先 `.replace(/process\s*\.\s*env\b/g, 'process.env')` 归一。

#### 六之补二、⚠⚠⚠ 两轮独立审计的结论：**纯文本判据原理上堵不住这类绕过**

我为此开了两个 subagent（一个审计、一个**对抗审计**），两者**各自独立**
找到同一类关键绕过。以下是必须记住的部分 —— 比上面那条判据本身重要。

**审计实测出的漏网清单**（全部让结构判据 9/9 全绿）：

| 漏网手法 | 机制 | 能否被文本判据堵住 |
|---|---|---|
| `import proc from 'node:process'` → `proc.env.USERPROFILE` | 进程对象可从**别的模块名**导入 | ❌ 只能加黑名单，不穷尽 |
| `import { env as hostEnv } from 'node:process'` | 同上（具名导入） | ❌ 同上 |
| `const p = process as NodeJS.Process` → `p.env.USERPROFILE` | `as` **断言改名** | ❌ 同上 |
| `env[['USER','PROFILE'].join('')]` | `env` 是**合法参数**，属性名可计算 | ❌ **文本层不可判定** |
| `eval('pro'+'cess')['env']['USER'+'PROFILE']` | 动态求值 | ❌ **原理上不可判定** |
| `env.VITEST ? home : 偷env` | **测试环境自检测** | ❌ 跑在 vitest 下就规矩，**任何在用测试都抓不到** |
| `input.platform === undefined ? 偷env : home` | **条件门**：只在生产调用形态使坏 | ✅ **已由行为判据封死** |

**⇒ 真正守住这条性质的是行为判据，不是结构判据。**

新文件 `tests/unit/zcode-browser-home-source.spec.ts` 用
`vi.mock('node:os')` 把 `homedir()` 换成**哨兵值**、
`USERPROFILE` 换成**另一个哨兵** —— 两者不再相等，「实现到底读了哪一个」
直接体现在输出里。这**破解了本文件「### 2」那条论断**：

> ~~「Windows 上 `homedir()` ≡ `USERPROFILE`，行为判据不可能区分，只能结构判据」~~

那个论断对**「改 env」**成立，但**漏了一条出路：不改 env，改 `homedir()` 本身**。

⚠⚠ **三条设计要点，缺一条判据就废**（都是实测踩出来的）：

1. **导入时机**：`vi.mock('node:os')` 要在**模块顶层注册**，但被测模块必须在
   `beforeAll` 里 `await import()` —— 在模块顶层 `await import()` 会让
   `zcode-captcha.ts` 拿到**真实** `node:os`（Windows 上真实 `homedir()` 恰好
   就读 `USERPROFILE`），于是**正确实现被误判成红**。
2. **必须有无参入口用例**：显式传 `platform` 的用例挡不住条件门 ——
   生产入口 `findBrowserExecutable()` 是 `browserCandidates()` **无参**调用。
   该用例钉 `process.platform = 'win32'`（`Object.defineProperty` 实测可行，
   否则判据又退化成「只在 Windows 成立」＝ IKJS58 的病根本身），
   把 `USERPROFILE` 指向**种好 exe 的临时目录**，断言输出不含该目录。
3. **测试环境自检测（`VITEST` 门）目前无解**：它让**任何**在用 vitest 判据都
   看到干净行为。要抓它只能靠**外挂验证**（进程外打包 + 哨兵 shim，无 `VITEST`）——
   本轮红队就是这么证实「生产已坏」的。**别指望单测能抓这一类。**

**两条判据是互补的，不是冗余**（双向实测）：

| 变异 | 结构判据 | 行为判据 |
|---|---|---|
| V2 调用点传 `process.env.USERPROFILE` | 🔴 抓住 | 🟢 漏（不经调用点） |
| `env[evilKey]` / 条件门 | 🟢 漏 | 🔴 抓住 |

⇒ 结构判据**不能删**（V2 只有它能抓），但注释必须写明**「不穷尽」**，
且必须配那条无参入口行为用例。

**收尾反向验证矩阵**（12 格，实测全符合预期）：

| 变异 | 类型 | 结构 | 行为 |
|---|---|---|---|
| V1 默认链加 `?? process.env.USERPROFILE` | 破坏 | 🔴 | 🔴 |
| V2 调用点传 `process.env.USERPROFILE` | 破坏 | 🔴 | 🔴 |
| U2 `process.  env`（点后空格） | 破坏 | 🔴 | 🔴 |
| V3 `env` 计算属性名 | 破坏 | 🟢 | 🔴 |
| **M3 条件门** | 破坏 | 🟢 | 🔴 |
| **M10 `node:process` 导入 + 条件门** | 破坏 | 🟢 | 🔴 |
| D1 死代码 `void process.env.USERPROFILE` | 死代码 | 🔴（刻意） | 🟢 |
| F1~F5 无辜（`process.pid`/`hrtime`/`NODE_ENV`/注释/`platform`）| 无辜 | 🟢 | 🟢 |

**可复用教训（比本条本身更重要）**：

1. **单维度判据会漏**：「属性名对」不等于「位置对」。写白名单时先问
   「**这个白名单元素允许出现在任意位置吗**」——不允许就得再加位置维度。
2. **锚定标识符，不锚定字面量**：`process.env` 是字面量，`a['env']` 绕过它。
3. **负前瞻的 `\s` 会跨行**，导致断言**静默恒真**（与它要防的问题同型）。
4. **`split/join` 剔除法会自豁免**：让合法串出现第二次即可豁免自己。
   用计数，别用剔除。
5. **扫描类断言必须证明「真扫到了东西」**：本轮 `fnBody` 因没跳过参数列表，
   把「函数体」截成了参数类型注解 ⇒ 断言静默恒真。
6. **反向验证矩阵必须校验「确实执行了」**：本轮首次跑矩阵用
   `execFileSync('npx', …)` —— Windows 上 `npx` 是 `npx.cmd`，直接 `ENOENT`，
   输出为空被误判成 GREEN，**「32/32 全绿」其实是没跑**。
   ⇒ 矩阵必须自带护栏（含目标 spec 名、解析到 `Tests N failed/passed`、
   退出码与解析一致）。红队还实测到**多行 `old_string` 匹配会因 CRLF/LF
   变动静默失败**，导致「变异没施加却显示全绿」—— 必须断言 marker 存在。
7. **纯文本判据的能力边界要写进注释**：本轮注释先写了「根治手段」等过强措辞，
   审计立刻证明它 7 类漏网。**注释降调不是自我否定，是防止后人误信。**

## ⚠️⚠️ 额度是**按模型分桶**的：8M = 3M(GLM-5.3) + 5M(GLM-5.3-Flash)（真实缺陷，2026-10-12）

**用户报障原文**：

> 智谱账号送的 8m 算力其中分为 5.3-3m 和 5.3flsh-5m，插件判断这个账号没用完，
> 就不会切换下一个账号使用……可否判定 plan 中的 token 是属于哪个模型专属的

### 一、判据确实存在，而且是上游直接下发的（本机只读实测）

`scripts/probe-zcode-plan-buckets.mjs`（只发 GET，零额度、零 captcha）实测启用账号：

```json
[bucket] plan_id="zcode-v3-start-plan-0817"  entitlement_id="ent_2_0817_glm_5p3"
         show_name="GLM-5.3"        capabilities=["model:glm-5.3"]
         total_units=3000000        remaining_units=3000000
[bucket] entitlement_id="ent_2_0817_glm_5p3f"
         show_name="GLM-5.3-Flash"  capabilities=["model:glm-5.3-flash"]
         total_units=5000000        remaining_units=5000000
```

⇒ **8M 就是这两个桶（3M + 5M）**，且每个桶带 `capabilities: ["model:<小写 id>"]`
—— 这是**模型专属**的权威判据。另有 `entitlement_id`（**只作排查用**，
命名约定改版就可能变，**不参与判定**）。

### 二、缺陷根因：全桶汇总把「某模型专属桶已尽」冲掉了

`zcodeExpiry` 的判据是**全桶汇总**的 `balance.remaining > 0`，它**不接收也不判断
modelId**。于是 GLM-5.3 的 3M 烧光、Flash 的 5M 还在时：

| 层 | 行为 |
|---|---|
| 折算（`zcodeExpiry`） | `remaining = 5M > 0` ⇒ 该渠道「有额度、可用」 |
| 选型（auto / aggregate） | 该 zcode 仍进候选，可能被派发 **GLM-5.3** |
| 池的按模型过滤 | `modelRateLimits['GLM-5.3']` 仍是空的（**只有真撞墙后才写**）⇒ 问不出东西 |
| 结果 | 请求发出 → 上游报额度用尽 → **才开始**换号（用户看到的「不切换」） |

且 `ZcodeBalanceBucket` 此前**根本没有 `capabilities` 字段** ——
`fetchZcodeBalance` 把它整体丢弃，判据无米下锅。

### 三、修法（新模块 `src/zcode-entitlements.ts` + 折算层写池标记）

1. `zcode-upstream.ts` 补读 `capabilities` / `entitlement_id`；
2. 新模块 `zcode-entitlements.ts` 提供**纯判据**：
   `bucketCoversModel` / `entitlementForModel` / `exhaustedModelsOf`；
3. `zcodeExpiry` 在**已经拿到 balance 的那一次**顺带算出「哪些模型已尽」，
   经注入的 `markModelsExhausted` 写进账号池 ⇒ **零额外网络请求**
   （实测报文验证，见 `scripts/verify-zcode-entitlement-scenarios.mjs` 的 7 场景）。

`ProviderRuntime.expiry.credentialExpiry` 因此多了**可选**第二参
（`accountId` / `catalogIds` / `markModelsExhausted`）—— 另外 6 家**一行都不用改**
（它们忽略第二参），这是刻意的「可选能力由实现自己声明」模式。

### 四、⚠⚠⚠ 四个最容易写错的格（都做过反向验证）

| 格 | 错误写法 | 后果 |
|---|---|---|
| **通用桶**（无 `capabilities`） | 判成「不覆盖任何模型」 | 赠送的 1 亿通用额度被忽略 ⇒ **误封**一个可用账号到次日 |
| **证据不足**（`bucketCount === 0`，如 GLM-5.2 在本机账号上没有专属桶） | 判成「已尽」⇒ 写标记 | 上游字段漂移时会**一次封掉整个渠道**、用户无法自愈 |
| **查不到余额**（网络 / 401 / 500） | 当「已尽」 | 同上，且**每次抖动都封一天** |
| **写标记走 `updateModelRateLimit`** | 顺手复用它 | 它末尾会**沉底**账号 ⇒ 用户每次 auto 选型都看到**账号顺序莫名变化** |

⚠️ **通用桶必须参与判定**（这是用户明确要求的兼容格）：

> 同时要兼容之前除了 8M 的 2 种模型的专用 tokens 外还有赠送的 1 亿 token
> 专用的用光了赠送的还在也不切换

语义是**取并集**：「专属额度」与「通用赠送额度」都能承接同一个模型，
**两边都见底**才判该模型已尽。故判据是「覆盖该模型的桶里**任意一个**还有余额」
（通用桶覆盖一切 ⇒ 它还有余额时任何模型都不会被判已尽）。

⚠️ **专用池 vs 通用池的消费顺序未实测**：用户提到「先花赠送的每日积分、再花专用积分
则现状已涵盖」。我们**只按余额判**，不假设顺序 —— 任何一方还有余额就不标，
故顺序如何都不影响正确性（这也让该分支**无需实测**）。

### 五、⚠ 大小写：上游小写 vs 目录大写（本缺陷最容易写错的一点）

| 来源 | 形态 |
|---|---|
| 上游 `capabilities` | `model:glm-5.3` ← **小写** |
| `client/configs` 的 `builtinModels[].modelId`（= DSH 目录 id） | `"GLM-5.3"` ← **大写** |

而池的过滤是 `a.modelRateLimits[modelId]` **精确匹配**（`modelId` 来自 DSH 的
**大写**目录 id）⇒ 拿小写去写**永远不命中**，且**零报错**（静默失效）。

⇒ 三个环节各自处理，**不需要**额外的归一化函数：
`modelOfCapability` 统一小写输出 → `bucketCoversModel` 两边都小写再比 →
`exhaustedModelsOf` 直接回**传进来的** `catalogIds` 元素。

⚠️ **初版写过一个 `normalizeModelId` 专门做这件事，反向验证实测它零生产调用方**
（上面三格已覆盖）⇒ **已删除**。别再加回来：那是「看起来像关键防线、
实际没有读者」的代码。同批还删掉了 `entitlementOfBalance`（同样零调用方）。

### 六、回归与反向验证

- `tests/unit/zcode-model-entitlements.spec.ts`：读数（含
  `capabilities` 缺失 ⇒ `undefined` 而非 `[]` 的三态区分）/ 纯判据逐格 /
  `exhaustedModelsOf` 的 8M 两桶与通用桶全组合 / **端到端写池 + 不沉底** /
  折算值不受写标记影响。
  ⚠️ **本文件刻意不写条数**：初版写「43 条」而实测已 61（条数是**必然腐坏**的快照，
  本仓库为此专门记过一条约定）。**条数以 `pnpm test` 输出为准。**
  ⚠️ 另：本节所有「实测」都指向 `scripts/*.mjs`，而那个目录被 `.gitignore` 忽略
  ⇒ **证据不随提交分发**（审计指出的可复核性问题）。要复核须拿到脚本内容，
  或按本节写明的判据自行重跑。
- **四轮反向验证**（均实测能抓住回归）：
  | 变异 | 变红条数 |
  |---|---|
  | 通用桶改成「不覆盖」 | **5**（含端到端那条） |
  | 两层大小写归一化都删 | **14**（含端到端） |
  | 证据不足也判「已尽」（危险方向） | **7**（含「空桶」「无覆盖桶」两格） |
  | 写标记改走 `updateModelRateLimit`（沉底） | **1**（专为它加的契约用例） |
- ⚠️ **「不沉底」那条用例初版是假绿**：它让探针跑一轮再看顺序，而桩 fetch 对
  两个账号返回同一份余额 ⇒ **两个都被标记** ⇒ 若实现会沉底恰好沉底两次、
  顺序回到原样 ⇒ 用例照样绿（变异实测确认）。改成**直接测池方法**并只标第一个
  账号，同时加一条**反向对照**（`updateModelRateLimit` **必须**沉底）——
  没有那条对照，「顺序不变」在沉底功能被整体删掉时也会绿。
- ⚠️ **纯函数用例挡不住「函数没有调用方」**：初版给 `entitlementOfBalance` 写了
  5 条三态用例、全绿，而它**零生产调用方** ⇒ 生产路径的保守性完全无人看守。
  现已全部改打在 `exhaustedModelsOf` 上。

取证脚本（**均只读、零额度**）：`scripts/probe-zcode-plan-buckets.mjs`（桶结构）、
`scripts/probe-zcode-model-id-casing.mjs`（两边大小写对比）、
`scripts/verify-zcode-model-entitlements-live.mjs`（真实报文过生产解析）、
`scripts/verify-zcode-entitlement-scenarios.mjs`（7 场景行为对照，零网络）、
`scripts/verify-zcode-direct-selection.mjs`（直选路径读标记，含反向对照）、
`scripts/verify-zcode-routing-effect.mjs`（真实池 3 账号的改道效果 + 不沉底）、
`scripts/verify-zcode-marker-latency.mjs`（60 秒滞后窗口）、
`scripts/verify-zcode-marker-race.mjs`（并发写不丢标记）、
`scripts/verify-zcode-catalogids-lazy.mjs`（只有 zcode 读目录）、
`scripts/verify-zcode-available-vs-remaining.mjs`（口径同源）、
`scripts/verify-zcode-abort-and-marker-failure.mjs`（标记失败不影响折算）、
`scripts/verify-zcode-string-units.mjs`（**字符串额度字段 ⇒ 不得误封整天**）、
`scripts/verify-zcode-fallback-bypass.mjs`（回退绕过标记的边界）、
`scripts/verify-zcode-mark-self-heal.mjs`（额度恢复自愈）、
`scripts/verify-zcode-real-model-strings.mjs`（**真实会话日志**里的 model 形态 —— 键假设的唯一权威）、
`scripts/verify-zcode-catalog-edge.mjs` / `verify-zcode-blank-key.mjs`（目录空白 id 边界）。

### 七、⚠ 覆盖边界：标记**写在折算时**，但**读在两个路径上**

分清「谁写」与「谁读」——这决定了当前收益的准确范围：

| | 路径 | 会写标记吗 | 会**读**标记吗 |
|---|---|---|---|
| auto / aggregate | 选型时调 `createExpiryProbe` | ✅ **是**（本轮的落点） | ✅（`availableByModel` / `hasUsableAccountFor` 按模型问池） |
| **对话框里直选** `zcode/GLM-5.3` | `zcode-adapter` 的 `resolveCredential(model)` | ❌ **不写**（不经过折算） | ⚠️ **只在池那一层读**（见下方两个边界） |

⇒ 准确的收益是：

1. **auto / aggregate 不再选中「该模型已尽」的账号**（本轮修的主症状）；
2. 直选路径**只要标记已被任何一次折算写下、且池里还有别的未标账号**，
   也会立刻被过滤掉 —— 即修复**不需要**等用户先撞一次墙。

⚠️⚠️ **第 2 条有两个必须说清的边界**（对抗审计实测 2026-10-12，我已独立复现）：

| 边界 | 事实 |
|---|---|
| **池被该模型筛空时，`fallback` 会绕过标记** | `createCredentialResolver` 在池返回 `null` 时落 `fallback`，而 zcode 的 fallback 是 `zcode.current()` —— 它**既不看 `enabled`、也不看 `modelRateLimits`** ⇒ 单账号或全池标尽时**仍返回凭据**，请求照常发往已尽的模型。实测：`scripts/verify-zcode-fallback-bypass.mjs`（场景①② 返回 `jwt-zcode-A`；场景③「只标 A、B 未标」正确取到 B）。 |
| **这是既有设计，不是本轮的缺陷** | `src/index.ts` 在 2026-10-06 实测后**刻意**保持原样（注释原文：「zcode 没有 IKJOZ9 的症状，不该被『顺手修』；加判定反而会把本来能跑通的一发变成硬失败」）。⚠️ 但本轮**改变了它的后果**：以前只有「真撞限额」才写标记，现在折算层会**主动**写 ⇒ 绕过路径被触发的频率显著上升。 |

⚠️ **两个方向的处置都未做，理由如实登记**：
- **不改 fallback**：那是刻意的既有语义（见上），改它需要重开 IKJOZ9 的判定；
- **不改文档口径**：故本条**如实写成两半**，不再宣称「直选一律认标记」。

⚠️ 准确的表述是：**标记只在「池查询」这一层生效**；`fallback` 是它之外的一条旁路。

⚠️ **第 2 条不是推断，已用生产代码路径实测**
（`scripts/verify-zcode-direct-selection.mjs`：真建账号池 + 真的
`createCredentialResolver`，零网络）：

| 步骤 | 结果 |
|---|---|
| ① 无标记时直选 `GLM-5.3` | 取到 `zcode-A`（手动序第一） |
| ② 给 A 写下 `GLM-5.3` 已尽后直选 `GLM-5.3` | 取到 **`zcode-B`**（A 被过滤） |
| ③ 直选 `GLM-5.3-Flash`（A 未被标记） | 取到 **`zcode-A`**（未误伤） |

⚠️ 第 ③ 格是必需的**反向对照**：没有它，「取到 B」可能只是因为池顺序变了。

⚠️ **真实选取路径的端到端实测**（`scripts/verify-zcode-routing-effect.mjs`：
真账号池 3 个账号 A/B/C，A 手动序第一且在 `GLM-5.3` 上已尽）——
这一条回答的是「**修复有没有真的让请求改道**」，而不只是「池里有标记」：

| 查询 | 取到的账号 | 期望 | 含义 |
|---|---|---|---|
| `GLM-5.3` | **`zcode-B`** | B | ★ 已尽的 A 被跳过（本缺陷主症状已修） |
| `GLM-5.3-Flash` | **`zcode-A`** | A | A 未被误伤（手动序优先仍生效） |
| 空 `modelId` | **`zcode-A`** | A | 空串跳过模型过滤（既有语义未变） |
| 写标记后的顺序 | `[A, B, C]` | 不变 | ★ **不沉底** |

⚠️ 最后一行与「A 在 Flash 上仍取得到」是**一对**：它们共同证明标记是
**按模型**的，不是把账号整体封掉。少任一条，都可能掩盖「误封」这一危险方向。

⚠️⚠️ **但上面全部用我自己构造的 model 字符串** —— 键形态若与**真实请求**不符，
标记仍会是永不命中的死键，而**单元测试抓不到**（它们用同样的构造字符串）。
⇒ 用**真实会话日志**当裁判（`scripts/verify-zcode-real-model-strings.mjs`，
扫 781 个会话文件提取 `{provider:'zcode', model}` 的实际取值）：

```
"GLM-5.3-Flash"   x1359        ← 只出现这一个
```

⇒ 形态与目录 id **完全一致**（大写、无 ` · x0.1` 后缀）⇒ 修复写入的键
**确实能被真实请求命中**。这是「键形态」假设的唯一权威依据，
**不要只靠单元测试就认为它成立**。

⚠️ 仍未覆盖的一格：**冷启动后从未跑过 auto/aggregate、用户直接选模型**时，
标记还没被写下（折算层没跑过）⇒ 那一发仍会发出去，由上游拒绝后走既有的
`switchAccountOnQuota` 切号（= 修复前的行为）。

⚠️ **还有一个 60 秒的滞后窗口**（本机实测，`scripts/verify-zcode-marker-latency.mjs`）：
写标记发生在 `zcodeExpiry` **真的被调用**时，而它有 `EXPIRY_CACHE_TTL_MS`（60 秒）
缓存 ⇒ 「上一次折算时某模型还有额度、之后被烧光」的那个窗口内，缓存命中会
**跳过 `zcodeExpiry`**，于是标记最长晚 60 秒才写下（清缓存后才写，实测已确认）。

| 时刻 | 折算值 | 是否写标记 |
|---|---|---|
| 首次折算（GLM-5.3 还有 3M） | 当日 24:00 | 否（都还有额度） |
| 上游已烧光，**同缓存窗口内**再折算 | 与上次相同（缓存命中） | **否**（这就是滞后） |
| `clear()` 之后 | 当日 24:00 | ✅ 写下 `GLM-5.3` |

⚠️ 这**不是回归**：修复前该窗口同样是「不写标记且继续派发」（永久如此），
现在只是把它压缩到 60 秒。要彻底消除仍需下面的请求前预检。

若要连这些格子也短路，需在 `zcode-adapter.ts` 发请求前加一次按模型的预检
（一次本地 TTL 缓存命中的余额查询）——**本轮刻意未做**：它会引入
「每次请求都可能查余额」的新路径与新的缓存一致性面，而收益只是省下
**冷启动后第一次**那一发。留待有实测需求时再评估。

### 八、⚠️ 独立审计（2026-10-12，subagent 驱动）

本轮改动经过**两个独立 subagent** 的审计：一个做常规代码审计、一个做
**对抗性审计**（在隔离副本里跑 53 个变异，专门找「测试全绿但生产行为错」的洞）。
对抗审计交出 **8 个真实覆盖漏洞 + 1 个致命接线漏洞**，本轮已逐条处置。

#### 八之1 ★★★ 审计发现的**死锁**：折算取号被自己写的标记筛空

**这是本轮最有价值的发现，且它比我修的原缺陷更严重。**

`createExpiryProbe` 取号时传的是 `probeModel = firstModelIdOf(provider)`，
而 `listAvailableCredentials(provider, probeModel)` **按模型过滤** ⇒

| 步骤 | 发生什么 |
|---|---|
| ① | 某次折算把「`GLM-5.3-Flash` 已尽」写进 `modelRateLimits` |
| ② | 下次折算取号 `listAvailableCredentials(provider, 'GLM-5.3-Flash')` **被过滤** ⇒ 账号筛空 |
| ③ | `credentials.length === 0` ⇒ 返回 `UNUSABLE` ⇒ **折算根本没跑** |
| ④ | 于是既清不掉标记、也写不了新标记 ⇒ 挂到次日 0 点 |
| ⑤ | **整个 zcode 渠道**在这期间对 auto / aggregate 不可见 |

⚠️ 生产 `probeModel` = 目录**第一个**模型 = 兜底表的 `GLM-5.3-Flash`
—— **正是用户实际一直在用的那个模型**（真实会话日志 1359 次）⇒ 不是边角情形。

**修法**：折算取号改传**空 `modelId`**（= 「不按模型过滤」的既有语义）。
依据：折算问的是「这个渠道整体最早何时作废」，与**哪个模型**无关；
按模型过滤在这里**多余**（派发前已有 `hasUsableAccountFor` /
`filterByModelAvailability` 按真实模型复核）且**有害**（上面的死锁）。

⚠️ **回退路径（`legacySingleCredential`）刻意保留 `probeModel`**：
`auto-adapter.spec.ts` 有一条**明确禁止空 modelId** 的既有用例
（「取代表账号时不得用空 modelId（会让限流过滤整体短路）」），它守的是
**另一个真实缺陷**（空 modelId 让限流过滤失效 ⇒ 把请求发给正在限流的账号）。
两者冲突 ⇒ 分路径处理；回退路径的死锁形态**如实登记为残余风险**（它只对测试桩可达）。

#### 八之2 ★★ 审计发现的**误封整天**：额度字段读不出来时被判「已尽」

`zcode-upstream.ts` 的 `num()` **只认 `number`**（它自己的注释登记了这一点）。
上游把 `remaining_units` 下发成 `"3000000"`（字符串）时两个额度字段都是
`undefined` ⇒ 判据按 0 处理 ⇒ **所有模型都被写持久标记 ⇒ 账号锁死到次日**。

⚠️ **这是本轮放大**的后果：旧行为下同一字段问题只让折算短暂 `UNUSABLE`
（下一轮自愈），现在会写**持久**标记。实测：`scripts/verify-zcode-string-units.mjs`。

**修法**：`entitlementForModel` 新增 `unreadableBuckets` 计数，
`modelsByEntitlement` 要求 `unreadableBuckets === 0` —— **读不到时既不写也不清**
（清也需要正向证据）。原则与「空桶 / 无覆盖桶不标」同一条：**读不到就不猜**。

#### 八之3 ★★★ 审计发现的**接线零守卫**：判定范围（功能规模）无人看守

把 `src/index.ts` 的 `catalogIdsOf` 接线**改名失效**，相关 spec **85 条全绿**，
而生产行为退化成「判定范围只有 `probeModel` 一个模型」⇒ 需求「两个专属桶都烧光
⇒ 两个都标」只标得动一个。

⚠️ 根因：本文件的用例全传**手写桩** `catalogIdsOf: async () => [...CATALOG]`
—— 它们证明「拿到一份目录时算得对」，**完全不证明生产装配真的给了那份目录**。

**修法**：新增「接线守卫」段（源码结构 + 行为对照两条互补），
并做反向验证确认「改名失效」与「只取 models[0]」都会变红。

⚠️ **结构判据本身踩了一个坑**：初版写 `expect(src).toContain('catalogIdsOf')`
—— 改名成 `catalogIdsOf_DISABLED` **仍然命中**（子串匹配）⇒ 变异照样全绿。
改用**键形态锚定** `[\s{,]\s*catalogIdsOf\s*:`（`\b` 拦不住 `_`，它是词字符）。

#### 八之4 其余 5 条可闭合漏洞（已补用例，逐条反向验证过）

| 变异 | 缺失的格子 | 补的用例 |
|---|---|---|
| `N04` 写标记丢 `...current` | 分两批标不同模型时，先标的被抹掉 | 「先标 Flash、再标 GLM-5.3 ⇒ 两条都在」 |
| `M31` 空 `accountId` 守卫翻成 `>= 0` | 空 accountId 不得写标记 | 「空 `accountId` ⇒ 不写任何标记」 |
| `M04` 去掉 `seen` 去重 | 目录含重复 id | 「重复项被去重」 |
| `M09` 丢弃 `available_units` | 两字段不一致时以 `available_units` 为准 | 「不一致时口径与汇总同源」 |
| `M17` 折算去掉 `remaining > 0` | 已尽桶带更早 `expires_at` | 「不得取已尽桶的更早时刻」 |

⚠️ 另有两条由**审计的 scratch 探查**暴露、我随后修掉的缺陷（不在上表内）：

| 缺陷 | 事实 | 修法 |
|---|---|---|
| **abort 被吞**（`s3-C`） | 写标记那段的 `try/catch` 初版是**裸的** ⇒ `catalogIds()` / `markModelsExhausted` 抛出的 `AbortError` 被静默吞掉、折算照常返回值。违反本模块铁律「**abort 立刻抛，绝不折算**」（该缺陷在本文件已被踩过三次）。 | `catch` 里加 `if (isAbortError(error)) throw error`。⚠️ **只判这一条**：`zcodeExpiry` 的签名里没有 `signal`，故 `signal?.throwIfAborted()` 不可用 —— 如实登记为「唯一一处判据少于其它 catch」，原因是签名差异。 |
| **额度读不出来 ⇒ 误封整天** | 见下一节（八之2 已在正文登记），⚠️ 其**独立复现**由 `scripts/verify-zcode-string-units.mjs` 给出。 | `unreadableBuckets` 守卫 |

⚠️ **审计的 12 个 `scratch-*.spec.ts` 实际残留在工作区**（报告的「已清理」不准确）
—— 已备份后删除。其中 4 个探查（`clearrl` / `selfpoison` / `mech` / `abort`）各有价值：
`clearrl` 查出「清除路径是否会误清限流标记」（结论：zcode 只有一种标记形态、
**都是**「次日 0 点」，故清除即正确的自愈，不是误清）；
`mech` 与 `selfpoison` 佐证了标记在池层的实际效果与自愈。

#### 八之5 ★★★ 审计发现的**两种标记语义互相打架**（死循环，比原缺陷更严重）

**这是第一个审计（代码审计）报的唯一「当前仍存在」的 IMPORTANT，我独立复现了。**

`modelRateLimits` 是**一张共用表**，两个来源写的**键与值完全相同**
（`accountId` + `modelId` + UTC+8 次日 0 点）：

| 来源 | 语义 | 证据强度 |
|---|---|---|
| `updateModelRateLimit`（各适配器） | **撞墙**：上游真的拒绝了 | **强**（一次真实失败的请求） |
| `markModelsExhaustedForExpiry`（折算观测） | 余额接口说该模型没额度了 | 弱（可能滞后 / 口径不同） |

而折算**每轮选型都跑** ⇒ 我新加的清除路径**无条件**删键，把适配器刚写的标记擦掉：

```
round0: pick=zcode-A 适配器写标记=true 折算后仍在=false   ← 被擦了
round1: pick=zcode-A 适配器写标记=true 折算后仍在=false   ← 又被擦
round2: pick=zcode-A ...                                  ← 死循环，每次真烧一发请求
```

⚠️ **关掉折算缓存后实测 `3/3` 轮全中**（`scripts/verify-zcode-fight-single.mjs`）。
⚠️ **不关缓存会误测**：第二轮命中 60 秒缓存、折算根本没重跑，会把死循环
误测成「只多撞一次」—— 我第一版正是这么测的（得到 `2/3`），差点低估严重性。
对照组（只撞墙、不折算）里标记仍在 ⇒ 证明差异**确实来自折算路径**。

**修法：按「谁的证据更强」分道。** 新增纯内存的 `expiryMarkedKeys` 登记
「本机制写下的标记」：

- `markModelsExhaustedForExpiry` 写成功后**登记**来源；
- `updateModelRateLimit`（适配器）为某键写过 ⇒ **认领**它（从集合移除）
  ⇒ 观测路径再也擦不掉；
- `clearModelsExhaustedForExpiry` **只删登记过的**键。

⚠️ 该集合**纯内存、不落盘**：丢失它的后果是「既有标记来源不明 ⇒ 清不掉」，
属**保守方向**（标记本来就会在次日 0 点自然过期）。刻意不给
`JetHubState` 加一份需要迁移与对账的新结构。

⚠️ **自愈未被牺牲**：同时实测「额度恢复 ⇒ 本机制的标记仍会被清」
（`scripts/verify-zcode-mark-self-heal.mjs`），并有**反向对照**用例钉住
（少了它，「不许擦」会被实现成「一律不清」⇒ 单向门复发）。

#### 八之6 第一个审计报的其余 MINOR（已逐条处置）

| MINOR | 事实 | 处置 |
|---|---|---|
| **接线守卫可被「注释掉的接线」满足** | 三条源码正则**不区分注释** ⇒ 把整段接线改成注释（语义失效）后三条仍全绿 | 判据前先 `stripComments`（助手取自 `provider-runtime-wiring.spec.ts`）。⚠️ 实测确认「注释掉接线」现在**会红** |
| 「结构判据与行为判据**互补**」 | **证伪**：那条行为用例传**手写桩**、不驱动 `index.ts` 真接线 ⇒ 两条都只测桩 | 注释改为如实分工（「结构 vs 范围」），不再宣称互补 |
| `aggregate-expiry.ts` 两语句挤一行 | 本轮 diff 新增的格式伪影（`tsc` 不管） | 已修；并全仓扫描确认无同型残留 |
| 文档写「**43 条**」而实测 61 | 条数是**必然腐坏**的快照（本仓库专门记过该约定） | 删掉条数，并写明「以 `pnpm test` 输出为准」 |
| JSDoc 称清除方法「**返回清除条数**」 | **证伪**：实为 `Promise<void>`（返回条数的是另一个方法 `clearModelRateLimits`） | 改为如实描述 + 注明「别与另一个混为一谈」 |
| 「写与清**逐格互补**」 | **部分证伪**：「读不到」那一格**两边都不出现**（既非互补也非覆盖） | 注释改为「判据互补，但**不覆盖全部格子**」，并点明那一格的语义是「不知道」 |

⚠️ 审计还指出一条**可复核性**问题（未判为缺陷但值得记）：**所有「实测」都指向
`scripts/*.mjs`，而该目录被 `.gitignore` 忽略** ⇒ 证据不随提交分发。
⇒ 已在该节写明；后续若有争议，须按各节写明的判据自行重跑。

#### 八之7 审计点名的其余等价变异与观察

- 删 `if (modelIds.length === 0) return`：下一行同样 return，可观测行为相同；
- 删 `&& context.catalogIds !== undefined`：抛错被外层 `try/catch` 吞掉，结果相同；
- 类型谓词改断言：**仅类型层**。

⚠️ 一并纠正一处**误报**：审计称全量 `pnpm test` 有 8 条既有失败
（`plugin-meta-locale` 6 条等）。我复跑那 3 个文件 **61 条全绿** ——
审计跑全量时我正在改源码，属**读取竞态**，不是既有失败。

#### 八之8 三条**必须记住的审计纪律**（本轮再次印证）

1. **审计前先固化基线**：对抗审计会改源码跑变异 ⇒ 给它一份**隔离副本**
   （源码拷贝 + `node_modules` junction），并明令禁止碰真实工作区。
2. **副本 = 快照**：审计期间你若继续改源码，报告就落在**过期快照**上。
   ⇒ 收到报告后必须**逐条核对**是否已被后续加固覆盖，不能照单全收。
   ⚠️ 本轮报告里有 3 条在我加固后已不成立、1 条数字是误报。
3. **变异/改文件脚本会静默毁坏工作区**（本轮**真实发生两次**）：
   - 用正则删 `index.ts` 的 `catalogIdsOf` 时，脚本报「未生效」但**实际已把接线删掉**；
   - 用 PowerShell 的 `List.AddRange` 重排本文档章节时**类型转换异常**，
     把整份文档写成 **0 字节**（靠另一份 checkout 的副本才救回）。
   ⇒ ① 变异后**必须独立校验源码状态**（`grep` 目标符号 / `git diff --numstat`），
   **不能只信脚本自己的返回值**；② 改写大文件**优先用 `edit` 工具**，
   不要在 shell 里拼接「读—改—写」；③ 批量改写前先确认有可恢复的副本。
   与本仓库记过的「反向验证脚本自身出错更危险」同型。

⚠️ 改完这些要做的两件事（同 zcode 其它改动）：**两份 checkout 都要同步**
（`D:\jet\code\js\dsh-codearts` 与 `D:\jet\code\js\deepseek-harness-codearts`）
并各自 `pnpm build:all`；**必须重启宿主**才生效。

#### 八之9 ⚠️⚠️ 本轮最重要的**流程**教训：审计目标必须冻结

两个审计**都**报告了同一件事，而且它比任何单条缺陷都值得记：

| 审计 | 报告原文（要点） |
|---|---|
| 对抗审计 | 「审计副本 = 创建时的快照」⇒ 我在它跑的同时继续改源码，它的变异基线就过期了 |
| 代码审计 | 「**首要事实：审计期间工作区被另一个 agent 并发修改**」—— 它早期的两个 CRITICAL 在审计途中被我修掉，复核时不成立（它逐条标了「已闭合」并给出前后 hash） |

⚠️ **这不是审计的失误，是我的流程失误**：我在审计运行期间继续修源码
（死锁、abort、字符串字段…），导致：

1. **审计结论的时效性被打折** —— 必须逐条核对「是否已被后续加固覆盖」；
2. **代码审计无法做变异验证**（它明确登记：在真实工作区注入变异会毁掉我的状态，
   而项目笔记明令禁止并行做变异）；
3. **它跑全量时撞上我改到一半的源码**，误报「8 条既有失败」。

**可复用的规则（下次启动审计前照做）**：

- **审计期间冻结源码**：要么等改完再审计，要么**明确接受「报告会落在快照上」**
  并在收到后逐条复核（本轮就是后者，代价是多花了一轮核对）；
- **隔离副本的基线要写进报告**（hash + 时间戳）—— 本轮代码审计做对了，
  这让「哪几条已闭合」可以精确核对；
- **报告里的「N 条失败」必须自己复跑确认** —— 并发修改会让它变成误报。

⚠️ 另一条与本仓库旧约定**相印证**的观察：项目 `AGENTS.md` 早已写明
「同一工作区无法安全并行（subagent 做变异验证会在源码里注入临时变异）」，
本轮**再次实测到同一形态** —— 只是这次「打架的」不是两个 subagent，
而是「审计 subagent 与主会话」。⇒ 那条约定应读作
「**任何**两个会改工作区的参与者都不许并行」，不限 subagent。

## ⚠️⚠️ 3.14.5 起官方**架构上支持**推理带 captcha，开关是服务端下发的 `skip_model_request`（2026-10-12）

**用户要求**（并同时更新了闭源版到 `ZCode.exe` **3.14.5.7961**）：
「检查一下现在推理过程是不是要 captcha 了，如果推理过程中又要了我们使用 zcode
对话推理过程中也要对应的调用 captcha 流程」。

### 一、先澄清一个**归属**：不是那次重构造成的

用户同时报「一键领取没有弹出 chromium」并怀疑 `3aa34a3`（抽出共享 `ChromiumSession`，
为集成库库AI 而做的重构）改坏了 captcha 流程。**逐项取证后：不成立。**

- `git show --stat 3aa34a3` 只动 **3 个文件**（新增 `src/chromium-session.ts`、
  瘦身 `src/zcode-captcha.ts`、5 个测试），**没有**碰 `zcode-auth.ts` /
  `captcha-carrier.ts` / `jet-hub-rpc.ts` / `captcha-supply.ts`；
- 逐字对比重构前后（旧 2119 行 → 新 1138 行）：`spawn` 参数（含
  `--window-position` / `--window-size` / `--lang` / `detached`）、端口挑选与
  「应答端口一致性」校验、`taskkill /T /F`、profile 退避删除、`STEALTH_PATCH`、
  `buildDomExpression` / `buildMintExpression`、页面复用与 `pageBusy` 无条件复位
  **全部逐字保留**；
- **114 条** captcha 相关单测全绿。

⇒ 「不弹 chromium」是 `19226ca`（2026-10-01「captcha 全链路重做」）引入的
**内部载体优先**设计（桌面版走 `dshDesktop.browser` 的隐藏 webview guest，
取不到才落 chromium）。旧记录已写明其收益口径是「**去掉对 chromium 的依赖**，
不是提速」。想看 chromium 用 `DSH_ZCODE_INTERNAL_CARRIER=0`；web 版拿不到
`dshDesktop.browser`，必然弹 chromium。

### 二、逆向**最新闭源版** `app.asar` 得到的官方判据链（3.14.5.7961）

产物：`C:\Users\Jet\AppData\Local\Programs\ZCode\resources\app.asar`（326 MB）。
captcha 逻辑在 `/out/renderer/assets/styles-C4MhEMbW.js`（6.1 MB，文件名随版本变）。

```js
// ① 准入：只有智谱积分账号走这条路
function xnn(e){ return e?.access?.type==='zhipu-account' && e.access.mode==='start-plan' }

// ② 索要 captcha（`model-request` 与 `captcha-retry` 两种 reason 都进这里）
async function Lnn(e){
  if (!xnn(e.providerConfig)) return
  const t = await U4(f3(e.codingPlanSubscriptionService), e.signal)
  if (t?.enabled===false || t?.skipModelRequest===true) return { headers:{} }   // ← 跳过
  if (!t || p3(t)) throw Error(Snn)
  const n = await Pnn(t, { providerId, requestId, source, signal })
  Inn(e.providerId, n)
  return { captchaVerifyParam: n, headers: unn({ captchaVerifyParam: n, captchaRegion: t.region }) }
}
```

`/out/host/index.js` 侧新增配对机制：

```js
// schema：requestProviderRuntimeHeaders 的 reason 取值域
reason: t.enum(["model-request", "captcha-retry"])

// host 把 renderer 回的 runtimeProviderHeaders 合进请求头（**只认这两个键**）
for (const [le, Ze] of Object.entries(m.response.runtimeProviderHeaders ?? {})) {
  const De = ["X-Aliyun-Captcha-Verify-Param","X-Aliyun-Captcha-Verify-Region"]
    .find(Nt => Nt.toLowerCase() === le.trim().toLowerCase())
  if (De && Ze.trim()) H[De] = Ze.trim()
}
```

⇒ **推理请求真的会走 captcha**，且被拒后有 `captcha-retry` 重试一轮。

⚠ **`access` 是本地设置，不是服务端下发**：`znn()` 读的是
`providerSettingsService.getView().providers[].effectiveConfig.access`。
故 `xnn` 的准入判据在我们这边**不可复现**（我们不是官方壳）。

⚠ **官方那把 `skip_model_request` 转成 camelCase**（`/out/host/index.js` 的
`getCaptchaConfig()`）：
```js
let { skip_model_request: r, ...o } = n
return { ...o, ...typeof r === 'boolean' ? { skipModelRequest: r } : {} }
```
⇒ **只在真的是布尔时才写字段**，缺席就是缺席 —— 我们的读法必须同口径。

### 三、服务端**当前**把开关关着（本机一手实测，只发 GET、零额度）

`GET /api/v1/client/configs?app_version=3.14.5&platform=unknown`，三个账号一致：

```json
"captcha": { "enabled": true, "prefix": "no8xfe", "region": "cn",
             "sceneId": "11xygtvd", "skip_model_request": true }
```

`skip_model_request: true` ⇒ 官方 `Lnn` 第二行即返回，**不产 param、不注头**
⇒ **现在推理仍然不要 captcha**，我们既有的「先探后取」依然正确。

⚠ **判据只能来自这两条**（逆向产物 + 一手实测），别再用「官方更新说明」
推断：3.14.4 的说明写「关闭模型请求验证码校验」，而 3.14.5 的架构**已经把
推理带 captcha 的能力做进去了**，只是**服务端开关没开** —— 两者不矛盾。

### 四、修了什么（缺陷：这个信号我们**读不到**）

`fetchZcodeCaptchaConfig` 此前只读 `region`/`prefix`/`sceneId`，
把 `skip_model_request` 与 `enabled` **整体丢弃** ⇒ 「上游要不要验证」不可读，
门控只能一律「先探后取」。这在 `true` 时最优（那一发必然成功、零成本），
但服务端一旦翻成 **`false`**，先探**必然**被 `400/3007` 拒 ⇒
**每一个用户请求都白吃一发往返**（再在适配器内部补产重发）。

**落点（4 处）**：
1. `zcode-upstream.ts` 的 `fetchZcodeCaptchaConfig` 补读两个字段，
   **只在真的是布尔时才写**（与官方 `getCaptchaConfig()` 逐字同口径）；
2. `zcode-captcha.ts` 的 `ZcodeCaptchaConfig` 加两个**可选**字段
   + 新纯判据 `requiresCaptchaUpfront()`；
3. `zcode-adapter.ts` 内层循环门控加 `upfrontCaptcha`（**只在 `attempt === 0`**）；
4. `captcha-requirement.ts` 加第三个观测计数 `upfrontCaptchaCount`
   （**独立成项**，不并进 `knownRequiredCount`：后者的语义是「跨请求靠 2 分钟
   记忆少探一次」，本项是「靠上游配置少探一次」，证据来源与失效条件都不同）。

⚠⚠ **方向别写反**：能省的是 `skipModelRequest === false`（明确要 ⇒ 直接带），
**不是** `true`。`true` 表示上游不校验，先探本来就零成本、无可省。

### 五、三态判据（最容易写错的两格）

| `skipModelRequest` | `enabled` | 首发动作 | 理由 |
|---|---|---|---|
| **`false`** | 非 `false` | **直接带 param** | 上游明确要 ⇒ 先探必被 `3007` 拒 |
| `true` | 非 `false` | 先探 | 上游不校验 ⇒ 先探零成本且省一次 mint |
| **缺席 / 非布尔** | 任意 | 先探 | **不知道就不猜** |
| 任意 | **`false`** | 先探 | 上游把 captcha 整个关了 ⇒ 一票否决 |

⚠ **缺席 ≠ `false`**：写成 `skipModelRequest !== true` 这类宽松判据，
会在老配置/字段漂移时把「不知道」当成「上游明确要验证」⇒
**每个请求白发一个 param**，白扣的是阿里云**设备级**配额（同设备 150/小时）。
同「额度桶：读不到就不猜」那条纪律。

### 六、回归与反向验证

- `tests/unit/zcode-captcha-upfront.spec.ts`（新，**三态 + 接线**；
  ⚠ 条数以 `pnpm test` 输出为准，别在文档里写死）。
  含**接线守卫**两条：`index.ts` 必须把 `fetchCaptchaConfig()` 的**原样结果**
  交给 `setCaptchaConfig`（不能重建一个只有三个字段的对象）、
  适配器必须真的**读**判据并进 mint 门控（不是只 import）。
- `tests/unit/captcha-requirement.spec.ts` / `zcode-captcha-lazy.spec.ts`
  的 3 条 `toEqual` 形状断言随之更新（新增观测项 ⇒ **合理的联动**，
  不是行为回归；已在断言里显式写出新字段并保留「无配置时必须为 0」的守护）。
- **7 个变异全部被抓住**（`scripts/mutate-zcode-captcha-upfront.mjs`，
  带三重守卫：旧片段出现次数必须恰好 1、写入后**回读校验**、
  还原后与备份 **sha256 一致**）：

  | 变异 | 结果 |
  |---|---|
  | M1 宽松判据（把「缺席」当「要验证」） | 🔴 1 条红 |
  | M2 方向写反（只看 `=== true`） | 🔴 4 条红 |
  | M3 去掉 `enabled` 一票否决 | 🔴 1 条红 |
  | M4 强制布尔化（缺席压成 false） | 🔴 1 条红 |
  | M5 适配器门控去掉 `upfrontCaptcha` | 🔴 3 条红 |
  | M6 `index.ts` 重建对象（丢两个开关） | 🔴 1 条红 |
  | M7 观测记错桶（upfront 记进 probeFirst） | 🔴 1 条红 |

⚠⚠ **反向验证脚本第一次跑时 M4「未施加」**：工作区文件是 **CRLF**，
而脚本里的多行片段写的是 `\n` ⇒ `split(old)` 数到 **0 次**。
**是脚本自带的「出现次数必须恰好 1」守卫把它拦下的**（否则会显示「全绿」，
被误读成「用例抓不住这个回归」）。修法：匹配与替换都在 `\n` 空间做，
写回时按原文件行尾还原。**这正是本仓库记过的 CRLF 假绿，第二次踩到。**

### 七、端到端取证（零网络，import `lib/` 编译产物）

`scripts/verify-zcode-captcha-upfront-live.mjs`：用**真实报文**过生产解析函数，
并逐格对照判据表（14 格全符合），关键三行：

```
当前线上（skip=true）      → {…,"enabled":true,"skipModelRequest":true}  ⇒ 判据 false（仍先探，行为逐字未变）
服务端翻开关（skip=false）  → {…,"skipModelRequest":false}               ⇒ 判据 true （首发直接带）
老配置（无该字段）          → {…,"enabled":true}                          ⇒ 判据 false（不猜，仍先探）
```

⇒ **当前线上行为与改动前逐字一致**（`skip_model_request: true`），
修复只在服务端翻开关后生效 —— 这是「**零当前行为变化、换来未来自愈**」的改动。

取证脚本（均只读、零额度，`scripts/` 被 gitignore ⇒ **不随提交分发**）：
`scan-zcode-captcha-trace.mjs`（asar 全量 captcha 痕迹扫描）、
`find-zcode-needle.mjs` / `extract-zcode-context.mjs`（按 need 定位并取上下文）、
`probe-zcode-captcha-config-live.mjs`（**一手**拉服务端 captcha 配置）、
`probe-zcode-access-mode.mjs`（access 与 providers 结构）、
`mutate-zcode-captcha-upfront.mjs`（反向验证矩阵）、
`verify-zcode-captcha-upfront-live.mjs`（端到端判据对照）。

### 八、仍未做（如实登记）

1. **`access.mode` 侧无法覆盖**：`xnn()` 依赖官方壳的本地 provider 设置
   （`access.type === 'zhipu-account' && access.mode === 'start-plan'`），
   我们直连上游时没有这个概念 ⇒ 若将来上游改成「只对 `off-peak` 模式索要」，
   我们的判据（只看 `enabled` + `skip_model_request`）可能不够。
   **未实测**，故不预先加判据。
2. **`captcha-retry` 那一轮的语义未对齐**：官方在推理被拒后会带
   `reason: 'captcha-retry'` **重新要一次** runtime headers。
   我们的对应物是适配器内 `3007` 分支的补产重发（语义等价），
   但**没有**「因 3012 而重取」那条 —— 而 3012 按现有实测**不是** captcha 问题
   （判据是请求体身份块，见本章前半），故不合并。
3. **3012 与 captcha 的因果关系**：本次**未发现**二者有因果。
   用户截图里那行诊断（`身份块 2898 字符(42+2856) · HTTP 405`）
   只出现在**推理**路径的 `describeZcodeRequestShape`；领取路径刻意**不传**
   `shape`（它只有 `{plan_id}`，照搬会误报「身份块 0 字符」）。
   ⇒ 那条 3012 是**推理**被拦，与「领取没弹 chromium」是**两件独立的事**。

## ⚠️⚠️ 「web 版一键领取不弹 chromium」的真因：`preview` 回了 `plans=[]`（2026-10-12 续查）

**用户澄清（关键）**：不弹的是 **dsh web** 环境（不是 desktop），
「以前点领取积分按钮都会弹，现在不弹了」；且界面**有结果文字：
「今日暂无领取额度」**。

⚠ **上一轮我按 desktop 前提作答，方向是错的** —— 本节是对它的订正。
「不弹 chromium」与「显示今日暂无额度」**不是两个问题，而是同一件事**。

### 一、判据链：返回点在**任何 captcha 产出之前**

`claimDailyWith`（`src/zcode-auth.ts`）的顺序是：

```
setCaptchaDemand(true)                 ← 只是置需求位（web 版无人消费它）
await reportZcodeActivation(...)
plans = await fetchZcodeClaimablePlans(...)   ← GET /billing/preview
if (plans.length === 0) return [{ kind:'already-claimed', message:'今日暂无可领额度…' }]
                                        ↑ ★ 在这里就返回了
const captchaConfig = await this.fetchCaptchaConfig() ...   ← 下面才开始 mint
```

而浏览器是**惰性**创建的（`captchaPoolInstance()` 里 `this.captchaBrowser ??= new …`
才 `spawn`）⇒ **preview 空 ⇒ 一次 mint 都不发生 ⇒ 一台浏览器都不起**。

⚠ **判据与文案自 `90890d0`（2026-09-29 最初实现）起一字未改**
（`git log -S'plans.length === 0' -- src/zcode-auth.ts` 只命中那一次）
⇒ **确认不是回归，也与 `3aa34a3` 的 ChromiumSession 重构无关**。

### 二、反向对照（`scripts/verify-zcode-claim-mint-gate.mjs`，零网络零浏览器）

用**生产编译产物**跑 `claimDaily`，只换 preview 的桩：

| preview | mint 调用次数 | outcome | claim 是否发出 |
|---|---|---|---|
| **有 plan** | **1** ★ ⇒ 会 spawn 浏览器 | `claimed` | 是 |
| **无 plan** | **0** ★ ⇒ 一台浏览器都不起 | `already-claimed` / 「今日暂无可领额度…」 | **否** |

⇒ 与用户现象逐字吻合，且**这是正确行为**：没有可领的东西时，
没有任何理由去起一个 200–400MB 的浏览器、白扣一次设备级 captcha 配额
（阿里云同设备 150/小时）。

### 三、服务端 side 的一手实测（只发 GET，零额度）

`scripts/probe-zcode-balance-vs-preview.mjs` —— **两个端点语义不同，别混**：

| 端点 | 回答什么 | 本机实测 |
|---|---|---|
| `GET /billing/balance` 的 `data.plans[]` | 你**拥有**哪些活动 | 启用账号 **1 条** |
| `GET /billing/preview` 的 `data.plans[]` | 今天**可领**哪些 | 启用账号 **0 条** |

启用账号（本机唯一 enabled）的 balance 原文：

```
plan_id=zcode-v3-start-plan-0817  name="ZCode Start Plan"  status=active
starts_at=2026-10-09 21:40   ends_at=2026-10-13 23:59
entitlement ent_2_0817_glm_5p3   GLM-5.3        3000000 units  used_units=0
entitlement ent_2_0817_glm_5p3f  GLM-5.3-Flash  5000000 units  used_units=0
bucket period_end = 2026-10-12 23:59:59（当日）
```

⚠ **两个决定性的观察**：
1. **`used_units` 全为 0** ⇒ 这个账号**一次都没领过**。故文案
   **刻意不说「今天已领取」**（那会是个谎），只说「今日暂无可领额度（服务端按日刷新）」。
2. 该账号 `account.createdAt` = **今天 19:02**（`starts_at` 却是 10-09）
   ⇒ 典型的「**新登录账号、当日份额还没投放 / 活动窗口未对齐**」。

⚠ **「今天已领过」与「活动未投放」在 wire 上无法区分**（都只表现为 `plans=[]`），
故 `already-claimed` 这个 kind 是**刻意的归并**（两者用户动作相同：明天再来）。
真正的区分需要上游给「已领」标记，**它没给**。

⚠ **多形态排除**：`app_version`（3.14.3 / 3.14.5）、`platform`（win32 / unknown）、
带不带 query —— 四种形态对同一账号**都回 `plans=0`** ⇒ 不是请求形态问题。

### 四、排除了哪些「看起来很像」的嫌疑（都实测过）

| 嫌疑 | 结论 | 证据 |
|---|---|---|
| `3aa34a3` 的 ChromiumSession 重构改坏了 captcha | ❌ **不成立** | 只动 3 个文件、spawn 参数逐字保留、114 条 captcha 单测全绿 |
| web 版被内部载体抢走（`supplied > 0`） | ❌ 不成立 | web 版 client 拿不到 `dshDesktop.browser` ⇒ 贡献循环第一行就 return；`supplied` 恒 0 |
| 退避冷却闸门拦住了 mint | ❌ 不成立 | `remainingMs()=0`（放行） |
| 找不到浏览器 | ❌ 不成立 | `findBrowserExecutable()` = scoop chromium（存在） |
| 预取池默认关闭导致行为变化 | ❌ 与「弹不弹」无关 | 池默认 `false` 只影响**已开始 mint 之后**的取参路径 |
| desktop 实例污染供给槽 | ❌ 本机当时只有 web | 用户确认「只有 dsh web（没开 desktop）」 |

### 五、用户自查方法（下次再遇到「不弹」）

**看结果文字即可定性**，不需要抓包：

| 界面显示 | 含义 | 浏览器会不会起 |
|---|---|---|
| 「今日暂无领取额度」 | `preview.plans=[]` ⇒ 上游今天没给可领份额 | **不会**（正确：无物可领） |
| 「领取成功 +N」/「今日已领取」 | 走通了 mint → claim | 会（或走了内部载体） |
| 「captcha 产出失败 …」/「找不到可用的浏览器」 | mint 阶段失败 | 尝试过、失败 |
| 点下去**完全没反应** | 前端重入闸门或 RPC 卡住 | 需另查 |

⚠ 若想**确认** captcha 链路完好，用一个**确实有可领份额**的账号点一次；
或看下面这条命令（只读、零额度）：

```
node scripts/probe-zcode-balance-vs-preview.mjs   # balance.plans 有、preview.plans 空 ⇒ 就是本形态
```

### 六、⚠⚠⚠ 用户反证「以前有额度也会弹」——已复现，且**结论不用改**

用户追问（关键）：**「之前就算弹出今日暂无额度，领取过程中还是弹出 chromium 的」**。

⚠ 我第一版结论只覆盖了**单账号**语义（「preview 空 ⇒ 必不 mint」）。
用户描述的现象在**多账号**下完全成立 —— 而 `credits.claimAll` 的 zcode 分支
正是**逐账号循环**（`jet-hub-rpc.ts`），preview 也是**按账号**查的。

`scripts/verify-zcode-multiaccount-claim.mjs`（生产编译产物、零网络）实测：

| 场景 | mint 次数 | 上游调用序 | 各账号 outcome |
|---|---|---|---|
| ① 单账号、无额度 | **0** | `preview→0` | `already-claimed` |
| ② 单账号、有额度 | **1** ★弹 | `preview→1 → claim` | `claimed` |
| ③ A 有额度 + B 无 | **1** ★弹 | `preview→1 → claim → preview→0` | A `claimed` / B `already-claimed` |
| ④ A 无 + B 有额度 | **1** ★弹 | `preview→0 → preview→1 → claim` | A `already-claimed` / B `claimed` |
| ⑤ 全部无额度 | **0** | `preview→0 → preview→0` | 都 `already-claimed` |

⇒ **「弹出 chromium」与「显示今日暂无额度」可以在同一次一键领取里同时出现**
（场景③④：只要有**任意一个**账号 preview 有 plan）。
这**精确解释**了用户的历史观感，且**不需要**「preview 空却仍 mint」这种矛盾行为。

⇒ 现在不弹，是因为**本机唯一 enabled 的账号 preview 为空**（场景①或⑤）。
用户池里其余 4 个账号 `balance.balances=0`（无权益）、且全部 `enabled=false`，
故当前**没有任何**账号会触发 mint。

⚠ **决定性的一点**：用户问「如果真的还能领积分要 captcha，那不是没生成吗？」
—— **不会**。判据是**逐账号**的：只要那个账号 preview 有 plan，
`plans.length !== 0` 就**不会**提前 return，后面 `mintClaimCaptcha` 照常产出 param
（场景②③④ 实测 mint>0）。**不存在**「该带 captcha 却没生成」的窗口。

### 七、⚠⚠ 排查时踩过的**自我指涉**假证据（别重犯）

我扫会话日志找历史行为时，`找不到可用的浏览器` 这一串在某个会话里命中 **307 次**。
若当真，会得出「浏览器探测长期失败」的错误结论。

`scripts/inspect-zcode-needle-provenance.mjs` 按**事件类型与角色**拆开：

```
命中行数: 66
按事件类型: { "tool/result": 15, "assistant/message": 40, "tool/call": 3, … }
按角色:     { "tool": 15, "assistant": 40, … }
```

⇒ **全部来自我自己读 `zcode-captcha.ts` 源码、以及写分析文字**——
`tool/result` 里是文件内容回显，`assistant/message` 是我的推理与总结。
**没有一条是真实运行日志**（真实运行日志应是 `assistant/attempt` 或宿主 logger 输出）。

⚠ 这正是本仓库记过的**循环论证**：统计口径命中的是**判据自己的字面量**
（我写文档时把那句话打进了会话记录），不构成证据。
⇒ **扫日志找行为证据时，必须先按 `type`/`role` 过滤掉「我自己写的文字」**，
否则「读代码」与「线上发生过」会被混为一谈。

### 八、★ 决定性验证：激活上报成功、preview 仍空（排除我方缺陷）

`src/zcode-upstream.ts` 的 `reportZcodeActivation` 头注释有一句**很重的断言**：

> ⚠ **这一步不能省**：不补这两条事件，`preview` 恒为空 `plans: []`
> —— 于是「今天可领」永远是「没有可领」，用户以为签到坏了。

⇒ 它把「preview 为空」的**第一嫌疑人**指向了自己（激活没生效）。
而该函数**内部吞掉全部异常**（best-effort），故**不能只看「没抛错」就认为成功**。

`scripts/probe-zcode-activation-then-preview.mjs` 按**生产顺序**（先上报、再 preview）
并**自己发一次**拿到真实 HTTP：

```
① [app_launch]        HTTP 200  {"code":0,"msg":"","logid":"20261012144129…"}
   [app_daily_active] HTTP 200  {"code":0,"msg":"","logid":"20261012144130…"}
①′ 生产封装 reportZcodeActivation() ✅ 返回、未抛
② 紧接着 fetchZcodeClaimablePlans() → plans.length = 0     ← ★ 仍为空
```

⇒ **激活上报 200/code:0 成功、紧接着 preview 仍空** ⇒ **排除「激活没生效」**，
确认是**上游当日对该账号无投放**（我方无法靠改代码解决的一侧）。

⚠ 这一步**必须做**：少了它，「preview 空」究竟是我方没上报、还是上游没投放
**无法区分** —— 而两者处置完全相反（前者要修 `reportZcodeActivation`，后者只能等/换账号）。

### 九 ⚠ 对「不弹 chromium 是否意味着 captcha 没生成」的正面回答

用户问：**「领取过程如果真的还能领积分要 captcha，那不是没生成吗？」**

**不会漏。** 判据是**逐账号**的，`plans.length === 0` 只跳过**那一个账号**：

```
for (const account of accounts) {              ← jet-hub-rpc.ts 的逐账号循环
  accountOutcomes = await zcode.claimDailyFor(credential, mint 回调)
      └─ claimDailyWith:  preview(该账号) → 空 ⇒ 只有它 return
                                      → 非空 ⇒ 继续 mint（★ 产 param、弹浏览器）
}
```

⇒ 只要**任意一个**账号 preview 有 plan，那一个账号**必然**走到 `mintClaimCaptcha`
（实测场景②③④的 mint=1）。**不存在**「该带 captcha 却没生成」的窗口 ——
因为 mint 就发生在**该账号自己**的 plan 循环里，与别的账号空不空无关。

⚠ 反过来说：**preview 空的账号不做 captcha 产出是刻意的正确行为** ——
没有可领的东西却去起一个 200–400MB 的浏览器、白扣一次设备级
配额（阿里云同设备 150/小时），那才是缺陷。

### 十、★★ `logid` 进诊断行（2026-10-12，3012 排障的**唯一凭据**）

**动因**：笔记本章第三节早已写着「响应体还带 **`logid`** —— 向用户索取现场时
**优先要它**（上游侧排障凭据）」，但**它从未被解析过**
（全仓 `grep -i logid` 在 `src/` 里**零命中**）⇒ 用户报障时我们只能给出
「账号#1 · 身份块 2898 字符 · HTTP 405」，**没有一样是上游能据以查日志的**。

⚠ 这是典型的「**文档记了、代码没做**」缺口 —— 排查价值最高的一项恰好从未落地。

#### 10.1 一手实测：`logid` 在**两个地方**，且值相同

`scripts/probe-zcode-logid-shape.mjs`（只发 GET、零额度）四个端点
（`client/configs` / `billing/preview` / `billing/balance` / `event/report`）
**全部同时带这两个**：

```
[header] x-request-id = 20261012145652694e8f48d3614ae49634
[body]   logid        = 20261012145652694e8f48d3614ae49634   ← ★ 逐字相同
```

#### 10.2 判据：**双来源**（体优先、头兜底）—— 两者覆盖不同故障，都不能省

| 来源 | 覆盖 | 为什么另一条盖不住 |
|---|---|---|
| 响应体顶层 `logid` | **业务层错误**（`{"code":3012,…}`） | 主路；值是上游业务日志 id |
| HTTP 头 `x-request-id` | **边缘/网关 HTML 页**（502 / 504 / 阿里云 ESA） | 那种响应**体里没有 `logid`**，而它是另一类高频故障 |

⚠ **体优先于头**：实测二者相同，故这条只在将来分叉时才有可观测差异 ——
写成显式优先级是为了「分叉时行为确定」，不是依赖「它们恰好相等」。

⚠ **取不到一律 `undefined`**，绝不编造、也不渲染空壳：
- 空白（`""` / `"   "`）等同没有（上游确实下发过空 `logid`）；
- **非字符串**（数字 / 对象）也 `undefined` —— 若 `String()` 化会渲染出
  `logid [object Object]`，**比没有更糟**（会让人以为拿到了凭据）。

#### 10.3 落点（三处，含两处**在信息最全的地方**提取）

| 文件 | 做什么 |
|---|---|
| `zcode-diagnostics.ts` | 新增纯函数 `extractZcodeLogId(body, headers)`；`ZcodeDiagnosticInput.logId`（**可选**）；诊断行末位追加 `logid <值>`（缺则整项省略） |
| `zcode-adapter.ts`（推理） | `logId: extractZcodeLogId(text, response.headers)` —— 手里就有 `response` |
| `zcode-upstream.ts`（领取） | `claimZcodePlan` 在**持有 `response` 与完整 `text`** 的那层提取，落进 `ZcodeClaimOutcome.logId`；`zcode-auth.ts` 只负责渲染 |

⚠ 领取侧**必须**在 `claimZcodePlan` 里提取（不能在下游 `toClaimOutcome`）：
下游只拿得到 `message` 字符串 —— **既没有 header、正文也可能已被
`text.slice(0, 200)` 截断**。与本章既有那条纪律同源：
「**在信息最全的地方归一，不要在已经丢过信息的下游猜**」。

⚠ `logid` 排在诊断行**最后**：它最长（32 位十六进制），
放前面会把「账号 / 计数 / 身份块」这些一眼要看的信息挤出屏幕。

#### 10.4 回归与**反向验证**

- `tests/unit/zcode-diagnostics.spec.ts` 新增一段（体/头/优先级/大小写不敏感/
  空白与非字符串防御/**接线守卫**两条）。
  ⚠ 条数以 `pnpm test` 输出为准，别在文档里写死。
- **8 个变异全部被抓住**（`scripts/mutate-zcode-logid.mjs`，三重守卫：
  旧片段出现次数必须恰好 1、写入后**回读校验**、还原后 **sha256 一致**）：

  | 变异 | 结果 |
  |---|---|
  | L1 体不再优先（改成头优先） | 🔴 2 条红 |
  | L2 去掉 header 兜底（边缘页就没凭据了） | 🔴 2 条红 |
  | L3 空白/非字符串不再防御 | 🔴 3 条红 |
  | L4 诊断行不再渲染 logid | 🔴 1 条红 |
  | L5 推理路径没接上 | 🔴 1 条红 |
  | L6 领取路径没接上 | 🔴 1 条红 |
  | L7 领取侧不在持有 response 的那层提取 | 🔴 1 条红 |
  | L8 大小写不敏感失效（写死小写键） | 🔴 1 条红 |

⚠ L3 第一版**没有唯一片段**（同一段「非空字符串」逻辑在
`extractZcodeLogId` 与 `readHeaderCaseInsensitive` 里各内联一份），
脚本的「出现次数必须恰好 1」守卫把它拦下 ⇒ 顺手抽成共享助手
`nonEmptyString()`。**这既是给变异让路，也消掉了一处真实重复。**

- 端到端取证（`scripts/verify-zcode-logid-e2e.mjs`，零网络、import `lib/`）：
  6 格形态全符合，含「阿里云 ESA 页靠头取到」「nginx 502 页无头时如实
  `undefined`」「真实 `Headers` 对象（有 `get`）」；并复验**红线**
  （诊断行仍不含 accountId / JWT 的任何子串）。

#### 10.5 这解决 3012 了吗 —— **没有**

⚠ 必须说清：`logid` 是**排障凭据**，不是修复。它把「用户报障时我们什么都问不出来」
变成「用户能把上游能查的那一串交回来」。3012 的根因**依然未知**
（「身份块达标仍 3012」仍无解释，见本章前半的 §二）。

### 十一、B1 归因统计：**本机零现场**，且自检证明过滤器没过严（2026-10-12）

原计划用本机历史做「账号级 vs 出口 IP 级」的归因。结论：**做不了，因为没有现场**。

#### 11.1 两个脚本的分工（**第二个是必需的**）

| 脚本 | 做什么 |
|---|---|
| `analyze-zcode-3012-attribution.mjs` | 按「真实运行事件」白名单聚合 3012 现场，输出账号/时间窗归因 |
| `verify-zcode-3012-filter.mjs` | **自检**：把过滤前后的命中全量列出来，证明「0 现场」不是**过滤过严**造成的 |

⚠ **少了第二个脚本，「0 个现场」这个结论是不可信的** ——
它既可以意味着「真的没发生」，也可以意味着「我的过滤器把真实现场滤掉了」。
两者结论完全相反（前者 ⇒ 无从归因；后者 ⇒ 我写错了判据）。

#### 11.2 自检结果：994 条命中**全部**是我自己写的文字

含 `unusual activity` 的文件 **71 个**、命中行 **994 条**，按事件类型全量拆开：

| `type` | 条数 | 性质 |
|---|---|---|
| `tool/result` | **444** | 我**读文件**的内容回显（`zcode-*.ts` 的源码本体） |
| `assistant/message` | **343** | 我**写的推理与总结** |
| `tool/call` | **191** | 我 `write` / `edit` 的**参数**（设计文档、注释） |
| `agent/inbox/spliced` | 8 | 子代理消息 |
| `user/message` | 8 | 用户消息里引用的文字 |

⇒ **`assistant/attempt` 与宿主 logger 输出：0 条**。
即**本机从未真实发生过 3012**；那 994 条**全部是文本层面的自指涉**
（我写文档、读源码时把 `3012` / `unusual activity` 打进了会话记录）。

⚠ 这是本章 §七 那条教训的**第二次实例**，且这次是**定量**的：
**71 个文件 / 994 行**听起来像「大量真实现场」，实际**一条都不是**。
⇒ 凡「从会话日志统计线上行为」，**必须先用 `type` 白名单把运行事件与
对话文本分开**，否则数字会大到误导（会把「我读过这段代码」当成「线上发生过」）。

#### 11.3 这个结论本身的价值

1. **排除了「本机早就有 3012、只是没注意」这条可能** —— 用户说「本机没有有问题的
   会话」是**实测成立**的，不是印象；
2. **归因统计只能等真实现场**。有了 §十 的 `logid`，下次在**有问题的机器**上
   撞到 3012 时拿到的就是**上游能查日志的凭据** —— 归因从「猜」变成「可查」；
3. 脚本**已就位**（在 `scripts/`，被 gitignore），下次直接跑即可。

---

## ⚠️⚠️ 营销投放（1024 程序员节）与**客户端版本门控**（用户报障，2026-10-23）

**用户报障原文**：

> 「我在 scoop 中装了 zcode 最新版 3.16.3，其中有 1024 程序员节送的 5 亿 token，
>  （截图）**把这个领取功能集成在每日签到中一并领取**，只有 zcode 中国版有，
> 国际版好像没有」

### 一、先钉住结论：这不是「多一个活动」，而是**签到漏了一个来源**

| | 端点 | 实测（本机 4 个账号，全部一致） |
|---|---|---|
| 每日赠送 | `GET /api/v1/zcode-plan/billing/preview` | `data.plans` 里有 `…start-plan-trust-…`（有投放时） |
| **营销投放** | `GET /api/v1/marketing/touch` | **1024 活动只在这里** |
| 余额桶 | `GET /api/v1/zcode-plan/billing/balance` | `balances: []`（活动未领前为空） |

**决定性判据**：领取 1024 的账号，`preview.plans` 与 `balance.balances`
**都是空数组**，而 `marketing/touch` 里明明有横幅。
⇒ 只查 preview 的签到，**与「今天没有活动」在 wire 上完全同形**
（都是 `plans: []`），永远不会去领它。这就是「官方客户端有、插件借不到」的全部原因。

### 二、逆向取证（scoop 安装版 `resources/app.asar`，341 MB）

⚠ 本机实际是 **3.16.2**（`3.16.3` 是用户口述的版本；活动是**按请求头**版本门控的，
与本机安装版本无关，见第三节）。读取方法与 §7.1 同（asar 头 + JSON 表尾部填充）。

| 事实 | 出处（asar 内路径 + 符号） |
|---|---|
| 投放查询与回执 | `out/host/index.js` 的 `createMarketingTouchService`：`GET /api/v1/marketing/touch?seq=<n>`、`POST /api/v1/marketing/touch/action` |
| 请求头只有**四个** | 同上：`X-Device-Mid` / `X-Client-Language` / `X-ZCode-App-Version` /（可选）`Authorization` |
| 投放 schema | `out/renderer/assets/src-oukR4Y1K.js`：`resource_position` = `banner` \| `popup`，按钮 action ∈ `close` / `open_url` / **`claim_zcode_plan{plan_id}`** / `navigate` / `copy_text` |
| **点击后走哪** | `out/host/index.js` 的 `claimManualPlan(planId)` → **`POST /api/v1/zcode-plan/billing/claim`**，body `{plan_id}`，带 `Authorization` + **captcha 头** |
| 成功后回执 | `out/renderer/assets/styles-n-UNIiNg.js`：动作成功后立刻 `p(delivery, 'confirm')` |
| 需要 captcha 的旁证 | i18n `manualClaimPlan.claim.failure.captcha`＝「Captcha verification failed.」（`out/renderer/assets/IntlProvider-C2IbGUkl.js`） |

**★ 最关键的一条**：`claimManualPlan` 用的**就是我们既有签到用的同一个 claim 端点、同一套 captcha**
⇒ 集成只需要「多一个 plan 来源 + 一次回执」，**不需要**新协议、新验证机制。

### 三、⚠️⚠️ 版本门控：同一个账号、同一套头，**只改一个字段**结果完全不同

本机只读实测（`scripts/probe-zcode-marketing-touch.mjs`，4 个账号，只发 GET）：

| `X-ZCode-App-Version` | `marketing/touch` 的 `data.deliveries` |
|---|---|
| `3.14.3`（**插件凭据里记的版本**） | **`[]`（空）** |
| `3.16.3` | `[{campaign_id:"2113475573403824128", …}]` ★ |

且「完整头集」与「官方最小头集」**结果相同** ⇒ 判据只有版本这一个变量。

官方文案也印证：`manualClaimPlan.claim.failure.ineligible`
＝「当前账号或**客户端版本**不满足领取条件」。

⚠ **因此必须按请求覆盖版本**（`ZCODE_VERSION_GATED_MIN_APP_VERSION`），
而**不能**去改凭据里的 `app_version`、也**不能**全局抬
`ZCODE_APP_VERSION_FALLBACK`：推理 / 额度 / 领取三条路径的既有实测结论
（含 §「3012 的消融矩阵」那一整表）都是在 3.14.3 上取到的，
无证据地整体抬版本会把这些结论一起作废。
落地形态：`buildZcodeHeaders` 新增可选的 `appVersion` 覆盖，**只有营销请求**传它。

⚠ **下限未二分**：只测了 `3.14.3` 空 / `3.16.3` 有，中间档没测。
取值即「与用户官方客户端同版本」，**不声称 3.16.3 是最低下限**。

#### 3.1 ⚠️⚠️ **领取端点（claim）也受同一个门控** —— 只抬投放的版本会「看得到、领不到」

**这条是真机一发定音**（`scripts/probe-zcode-claim-version-gate.mjs`，同一账号、
**其余头完全相同**，只改 `X-ZCode-App-Version`）：

| 版本 | `POST /zcode-plan/billing/claim` |
|---|---|
| `3.14.3`（凭据里的） | **`400 / code 1004 "no permission"`** ← 官方文案 `ineligible`＝「当前账号或**客户端版本**不满足领取条件」 |
| `3.16.2` | **`200 / code 0`** + `data.plan.{user_plan_id, status:"active", entitlements:[3 亿 + 2 亿]}` ★ |

⚠⚠ **形态极具误导性**：`1004` 读起来像「这个账号没资格」，而真实原因是
**我们报的版本号旧了**。第一次用生产路径（`claimDailyFor`）跑就是这个结果 ——
「活动查得到、却领不到，且理由看起来像账号问题」。

⚠ 官方客户端 claim 同样报自己的版本：`app.asar` → `out/host/index.js` 的
`claimManualPlan` 用 `'X-ZCode-App-Version': Ir`，而本机 `Ir` 即客户端版本
`3.16.2`（同文件 `var Vu="3.16.2"`）⇒ **报 3.14.3 的一直是我们**。

⚠ **顺带纠正一条逆向读法**：官方 `claimManualPlan` 的**显式** headers 里
**没有** `X-Device-Mid`，但**照抄它会回 `3001 parameter error`** ——
因为那层公共头由 `Fa(this.apiClient, …)` 注入，**在片段里看不见**。
⇒ 照抄「显式 headers」时，必须把「封装层注入的公共头」一起算上。

⚠ **两个端点必须同抬**：`fetchZcodeMarketingPlans` 与 `claimZcodePlan`
都过 `zcodeVersionGatedAppVersion()`（同一份实现，不许各写一份）。
**每日赠送 plan 的领取在抬高版本下的表现未单独实测**，但官方客户端
（3.16.2）自己也在领它 ⇒ 风险低（如实登记）。

### 四、1024 活动的实际形状（实测原文，测试 fixture 逐字取自它）

```json
{ "campaign_id": "2113475573403824128", "resource_position": "banner", "priority": 50,
  "banner": {
    "buttons": [ { "action": { "type": "close" } },
                 { "action": { "type": "claim_zcode_plan",
                               "args": { "plan_id": "zcode-v3-start-plan-1024" } } } ],
    "background": { "args": { "zcode_plan": {
      "plan_id": "zcode-v3-start-plan-1024", "name": "ZCode 1024 Dev Day", "priority": 101,
      "starts_at": 1792756800, "ends_at": 1792976400,
      "entitlements": [
        { "show_name": "GLM-5.3-Flash", "unit_type": "token", "grant_units": 300000000 },
        { "show_name": "GLM-5.3",       "unit_type": "token", "grant_units": 200000000 } ] } } } } } }
```

⇒ **3 亿 + 2 亿 = 5 亿**，正是用户截图那行「5 亿 TOKENS」。

⚠⚠ **额度必须**求和**，不能只取 `entitlements[0]`**：`fetchZcodeClaimablePlans`
（preview 那条）历来只取第一条 —— 那条路径实测每个 plan 只有一条 entitlement，
**故刻意不动它**；营销这条一个 plan 有多条（按模型分），只取第一条会**少报 2 亿**。
两条路径各有实测依据，**分开实现、分别钉住**。

⚠ 同一份 `zcode_plan` 元数据被服务端**镜像**到多个资产位
（`banner.background.args` 与 `success_popup.hero.args` 各一份，实测如此）
⇒ 解析必须**递归找** `plan_id` 而不是写死路径（但有深度上限，
服务端下发的任意 JSON 必须有界扫描）。

### 五、落地形态（三处）

1. `src/zcode-upstream.ts`：`fetchZcodeMarketingPlans()`（只读，失败一律降级 `[]`）、
   `claimablePlansFromMarketingDeliveries()`（纯函数，便于测）、
   `reportZcodeMarketingAction()`（`confirm` 回执，只有 `{code:0}` 算成功）、
   `mergeZcodeClaimablePlans()`（去重 + priority 降序，preview 优先但**补** `campaignId`）。
2. `src/zcode-auth.ts`：新增 `fetchAllClaimablePlans()`（两个来源合并），
   **`claimDailyWith` 与 `fetchCheckinStatus` 都改用它** ——
   后者也要改，否则面板显示「今日已领取」而 1024 其实没领（自相矛盾）。
3. `claimOnePlan`：领取成功/已领取后发一次 `confirm`。

⚠ **`confirm` 的门控是「只在成功时发」**：失败时发等于告诉服务端「别再给我看了」，
用户**白丢一次机会**（`cancel` 语义更明确，本实现**从不**发送）。
⚠ **`confirm` 必须 `await` 而不是 fire-and-forget**：它只有一跳，而领取流程结束后
宿主可能很快关掉浏览器/进程，「发出去但没到」等于没发。
⚠ `confirm` **不参与** `noteZcodeRequest*` 埋点：那套统计的是推理/领取端点的
风控画像，营销端点不是风控对象，混进去会污染画像。

### 六、回归与反向验证（`tests/unit/zcode-marketing-touch.spec.ts`，26 条）

六个变异逐条实跑（每个都先打印「变异已注入 ✓」自证，跑完自动还原）：

| 变异 | 结果 |
|---|---|
| 删掉 `fetchAllClaimablePlans` 里的 marketing 那一行 | **红 7 条**（含接线、confirm、状态灯） |
| `buildZcodeHeaders` 的 `appVersion` 覆盖失效 | **红 1 条**（版本门控那条） |
| 去掉 `confirm` 的 `outcome.ok` 门控 | **红 1 条**（「失败绝不发 confirm」） |
| 去掉 `action.type !== 'claim_zcode_plan'` 判据 | 第一版**全绿（无牙！）** → 见下 |
| `units += value` → 只取第一条 | **红 2 条**（5 亿那条 + 单位不混加那条） |
| **claim 的版本覆盖失效**（改成 `credential.app_version`） | **红 1 条**（「claim 也必须带门控版本」） |

⚠⚠ **「无牙」的那一条值得单独记**：第一版用例里 `close` 按钮的 `args` 是 `null`
（实测原样），于是它**碰巧**被「`args.plan_id` 必须是非空字符串」那条腿挡住了 ——
把 `type` 判据整行删掉，用例**仍然全绿**。
⇒ 修法是**补一条独立用例**：构造「非领取动作**也带了** `plan_id`」的畸形投放
（服务端数据不可信，将来完全可能），断言 `[]`。
补后该变异**变红**。
⇒ 可推广：**「某条判据」的用例，必须让其它腿都不足以挡住它** ——
否则你测的是「另一条腿」，而这条判据可以整条消失。

#### 6.1 ★★ 真机验收（走生产路径，非另写等价实现）

`scripts/verify-zcode-marketing-claim-live.mjs` —— 用**插件自己的凭据** +
`lib/` 里的**生产代码**（`ZcodeAuth.claimDailyFor` + `ZcodeAuth.mintCaptcha`）：

```
账号 zcode-7314e232  app_version=3.14.3（凭据里的）
① marketing plans = 1
   {"planId":"zcode-v3-start-plan-1024","priority":101,"name":"ZCode 1024 Dev Day",
    "grantUnits":500000000,"unitType":"token","marketingCampaignId":"2113475573403824128"}
② preview plans = 0                    ← 1024 活动**不在** preview（本改动的全部理由）
③ 真实领取（生产路径）
   {"kind":"claimed","credit":500000000,"streakDays":0,"isStreakDay":false,"unit":"token"}  ★★
```

⇒ **`credit: 500000000` + `unit: "token"` = 用户截图里的「5 亿 TOKENS」，领取成功。**

⚠ 领取后 `balance` 仍显示 0 —— **不是失败**：活动的 `effective_at`
（`1792767600` = 2026-10-23 23:00 UTC+8）**尚未到**，官方 `success_popup`
的文案也是「将于 … 生效」。判据要看 claim 的 `code 0` / 本行的 `claimed`。

⚠ 另一个账号（`zcode-eb16e1cd`）在**第一次领取成功后再查投放**得到
`deliveries = []` ⇒ **服务端在用户领过之后会自己撤下该 campaign**。
这也意味着：**「领取后再查为 0」不能当成 `confirm` 生效的证据**
（两者在这一格上同形，见 §七）。

### 七、仍未做 / 已知边界

- **面板的「可领」展示（`fetchZcodeBalance` 的 `claimablePlans`）不含营销投放** ——
  它只读 preview。即：签到能领到，但余额徽标里的「可领」条目看不到它。
  要接需在 `fetchZcodeBalance` 里也并一次营销查询（多一跳只读请求），
  **本次刻意不做**（用户诉求是「签到一并领取」；改动面越小越好）。
- **活动结束后**：`deliveries` 自然变空，签到回到原状（无需清理逻辑）。
- **国际版（`zai`）**：用户说「国际版好像没有」。本次**不做渠道特判** ——
  投放由服务端按账号/渠道决定，国际账号自然拿不到（与「不猜上游」的既有纪律一致）。
- **`confirm` 的实际效果未做对照实验**（是否真的让服务端停止重复投放）。
  依据是官方 renderer 的行为与「已领过的 plan 会被反复投放」这一实测现象；
  若将来发现仍重复投放，这里是第一嫌疑人。
  ⚠ **别拿「领取后投放变 0」当证据**：服务端在用户领过之后**自己**也会撤下该
  campaign（本机两个账号都观察到），两者在这一格上**同形**（见 §6.1 末）。
- **`data.plan` 未被解析利用**：claim 成功响应里有权威的
  `user_plan_id` / `status` / `starts_at` / `ends_at` / `entitlements[].effective_at`
  （官方 `claimManualPlan` 正是读它做「领取成功」弹窗）。我们只用
  `plan.grantUnits`（来自投放里的镜像元数据）做展示 —— 够用，但少了一份
  「上游回执」的交叉校验。
- **`seq` 参数**固定传 `0`（官方是自增计数）。实测 `0` 能拿到投放；
  未验证自增值是否改变投放集合。

### 八、可复现的探针（都在 `scripts/`，只读或「一次性写」且写明副作用）

```bash
# ① 只读：投放 + preview + balance（版本/头集矩阵写在脚本里）
node scripts/probe-zcode-marketing-touch.mjs          # 只扫 enabled 账号
node scripts/probe-zcode-marketing-touch.mjs --all    # 含停用账号（本机 4 个 zcode 账号全停用）

# ② 一次性**写**：claim 的版本门控（默认官方头集；--ours-version 只改版本）
node scripts/probe-zcode-claim-version-gate.mjs [账号id] [--ours-version]

# ③ 端到端**写**：走生产路径真实领取（领取成功后打 confirm）
node scripts/verify-zcode-marketing-claim-live.mjs [账号id]
```

⚠ 三者与既有探针同规矩：**不循环、不重试、不对真实凭据做续期**
（zcode 无 refresh 端点）。②③ 会真实领取额度，且每发消耗一个**设备级**
captcha 配额 —— 别当只读工具反复跑。

---

## ⚠️⚠️ 领取后「额度仍是 0」的真相：**已领但还没到生效时刻**（2026-10-23 21:19）

**用户报障原文**：

> 「我重启后用 zcode 领取显示 2 个成功 2 个已领取，**但是我查询额度后还是 0**」

截图里 ZCode 两行都是「**+500.00MToken 领取成功**」，而额度查询是 0。

### 一、结论：**不是缺陷**，是上游的 `effective_at`

上游 `billing/balance` 对「已领未生效」的账号返回（**实测原文**）：

```json
{ "balances": [],                                  ← 桶是空的 ⇒ 「剩余 0」
  "plans": [{ "plan_id": "zcode-v3-start-plan-1024", "status": "active",
              "entitlements": [
                { "show_name": "GLM-5.3-Flash", "unit_type": "token",
                  "grant_units": 300000000, "effective_at": 1792767600 },
                { "show_name": "GLM-5.3",       "unit_type": "token",
                  "grant_units": 200000000, "effective_at": 1792767600 } ] }] }
```

`1792767600` = **2026-10-23 23:00 UTC+8**（报障时是 21:19 ⇒ 还差 83 分钟）。

⇒ 额度**已锁定在 `plans` 里**，但 `balances` 桶**要等 23:00 才建**。
官方成功弹窗的文案也正是「**将于 … 生效**」（实测 `description` 里是
「… 将于 … 生效」）。

⚠ **判据**：上游 `data.plan.status === 'active'` + `entitlements[].effective_at`
**晚于现在** ⇒ 就是「已领未生效」。**这不是「领取失败」**，更不是「白领了」。

### 二、⚠️⚠️ 由此暴露的**真缺口**：插件**没有把这个中间态显示出来**

用户只能看到「领取成功」+「额度 0」⇒ **看起来像白领了**。

⇒ 修法（**两个字段，两个入口**）：

| 位置 | 改动 | 为什么 |
|---|---|---|
| `src/zcode-upstream.ts` | `ZcodeBalanceResult` 新增 `pendingPlans`；`fetchZcodeBalance` 用 `pendingPlansOf(data.plans)` 填充 | 「已领、等生效」是**独立于桶**的一态 |
| `src/provider-credits.ts` | `buildZcodeBalance` 把它做成**独立包**，`remaining/total` 都给 **0**，`cycleStartTime` 携带**生效时刻**，`active: false` | 见下 |

⚠⚠ **绝不能把它并进 `remaining` / `total`**（`total` 是折算层的判据）：

`aggregate-expiry.ts` 的 `zcodeExpiry` 判据是 **`balance.remaining > 0`**
（`aggregate-expiry.ts` 的注释明写「判据是 `remaining`（**已拥有**的余额）」）
⇒ 并进去 ⇒ 折算判成「有额度」⇒ **在 23:00 之前就把 zcode 派发出去**
（必然失败：额度还不存在）。
⇒ 故：**桶 = 现在能用；`pendingPlans` = 已领、等生效**；`zcodeExpiry` **不读**它
（实测 `zcodeExpiry` 源码里 `pendingPlans` 命中 **0** 处）。

### 三、⚠️⚠️ 国际版（`zai`）**同样能领**——「只有中国版有」是**界面/入口**差异

**用户追问**：「2 个旅行者账号应该是国际版账号，但我看有个旅行者账号也领取成功了，
应该只有中国版才有」。

**实测（`scripts/probe-zcode-account-channel.mjs` + `probe-zcode-intl-vs-cn-activity.mjs`）**：

| 账号 | 渠道（凭据字段） | `billing/balance` 的 1024 plan |
|---|---|---|
| sysenxde / xrbwohf3 | 中国版 `bigmodel`（`user_channel=WECHAT_OPEN`） | `status: active` |
| **旅行者9665 / 旅行者6665** | **国际版 `zai`**（只有 `zai_access_token`） | **`status: active`** ★ |

⇒ **服务端在额度层面完全不按 OAuth 渠道区分**：两个国际版账号拿到的是**同一个**
`zcode-v3-start-plan-1024`（3 亿 + 2 亿）。

⚠ 补一条**反直觉**的实测：用**渠道专属 token**（`zai_access_token` /
`bigmodel_access_token`）当 Bearer 查 `billing/balance` ⇒ **HTTP 401**；
只有 `zcode_jwt` 能用 ⇒ 该端点**只认 `zcode_jwt`**，与渠道无关。

⚠ `X-Client-Language` 取 `zh-CN` / `en-US` **不影响**投放（两组都是 `code 0`、
`deliveries` 相同）。

⇒ 「只有中国版有」的观感来自**官方客户端的界面**：
官方「奖励中心」页是**分站**的 —— `isTrustedRewardsUrl` 的判据是
`/^\/(cn|en)\/rewards\/?$/`（`app.asar` → `out/main/chunk-XYX2CJ3H.js`），
且 marketing touch 的 `baseUrl` **恒为 `zcode.z.ai`**（中国版域）。
⇒ **国际版用户看不到那个入口，但额度本身拿得到**（实测两个旅行者账号都拿到了）。

⚠ **本仓库不做渠道特判**：投放由服务端决定，我们只按实测拿到的 plan 领取
（与「不猜上游」的既有纪律一致）。

### 四、回归与反向验证（`tests/unit/zcode-pending-effective.spec.ts`，11 条）

三个变异逐条实跑（`scripts/mutate-zcode-guard.mjs`，每个都自证「变异已注入 ✓」、
跑完自动还原）：

| 变异 | 结果 |
|---|---|
| 把待生效额度**并进 `total`** | **红 1 条**（「总量不含待生效」那格） |
| pending 包的 `active` 改成 `true` | **红 1 条** |
| 「已到生效时刻」的也计入 `pendingPlans` | **红 2 条** |

⚠ 其中「总量不含待生效」那一格是**最关键的**：它是「23:00 之前不派发 zcode」
这条不变式的**唯一**守卫（折算层只读 `total`/`remaining`）。

### 五、可复现的探针（本轮新增）

```bash
# 只读：领取后上游到底返回什么（桶 / 计划 / 生效时刻）
node scripts/probe-zcode-post-claim-balance.mjs

# 只读：每个账号是中国版（bigmodel）还是国际版（zai）
node scripts/probe-zcode-account-channel.mjs

# 只读：同一端点用「渠道 token」与「zcode_jwt」的差异 + 语言变量
node scripts/probe-zcode-intl-vs-cn-activity.mjs
```










## ⚠️⚠️ 405 的判据是「system 恰好 3 块」，而这条不变式曾**零守卫**（2026-10-25 合并审计）

`!151` 用三轮对照证明：**第 4 个 `system` 块会让请求必然 405 + 3012**，与它多长无关
（2 062 字符照样 405）；把调用方 system 挪进首轮 user 消息后同一请求 200，且模型照样
遵守那段约定。落地方向完全正确。

**但审计实测**：把这处修复**原样放回去**（适配器里 `system.push({type:'text',text:options.system})`
+ 删掉 `withCallerSystem`）后，**871 条 zcode 用例 + 双 tsc 全绿**。原因：当时的用例只测
`buildZcodeSystemBlocks()` 的返回值（它已经没有 caller 形参，断言近乎恒真），**从不过适配器**；
全仓只有 `zcode-throttle.spec.ts:439` 读过真实请求体，且只断言 `tools` 的断点。

⇒ 现有守卫：`tests/unit/zcode-wire-invariants.spec.ts` —— 让 `ZcodeAdapter.stream()` 真跑一次、
截 `fetchImpl` 收到的 `init.body`，断言 `system.length===3` / caller 零次在 system / 恰好一次在
messages 且排在日期块之后。**改 zcode 适配器装配时它必须绿。**

⚠️ 同一轮审计还挖出「同姓」的四处自相矛盾（都已修，但结论要记）：
① `X-Platform`/`X-Os-Category` 硬编码 windows 而 `X-Os-Version` 取真实 `os.release()`
⇒ 非 Windows 宿主上「windows 类别 + Darwin 内核号」，任何官方客户端都不会发；
② 头走门控版（3.16.3）而 query/body 走凭据版（3.14.3）⇒ 同一请求两个版本号；
③ `X-Session-Id` 是**模块级常量** ⇒ 池里所有账号共用一个 session id（真实客户端是每会话一个）；
④ `app_version` 不做格式校验 ⇒ `3.16.3-beta.1` / `3.016.3` 会被 `compareZcodeAppVersion`
当成「更大」而**绕过**门控，`\r\n` 注入会让 `Headers()` 抛 `TypeError`。
⇒ 判据：`zcodeClientPlatform()` 三值同源且**平台与内核版本都可入参**（本机 `os.release()`
恰好等于伪装值 `10.0.26100`，不注入就永远测不出①）；带 query `app_version` 的站点必须把
同一个值显式传给 `buildZcodeHeaders`。

⚠️ 另：`buildZcodeHeaders` 被 `zcode-transport.ts` 复用，所以 `coding-plan` 腿（`api.z.ai`）
现在也从 10 头变 18 头 —— 作者只在 `/v1/messages` 上实测过，`api.z.ai` 未实测（已登记）。

⚠️ 方法论：`zcode-identity.ts` 头注释原写「判据是身份块是否存在，**不是**块数多少」，
与现行不变式**正面冲突**。这类过期注释就是下一次回归的引信（谁按它把第 4 块加回来，
测试不会红）。改代码时**必须连注释一起改**，否则等于留下一个静默的骗局。

## ⚠️⚠️⚠️ **405 恒不可重试**：白重试 5 轮会加重冷却惩罚（issue IKQ4B4，2026-10-25）

`405` 在 ZCode **从不是**「HTTP 方法不允许」的通用语义 —— 它是**风控拦截的专属状态码**
（上面「3012」节的消融矩阵：裸请求 / 无身份块都是「**405 + 3012**」）。而
`3012` 有账号冷却惩罚（30 分钟起，反复触发升级到 24 小时乃至停用）
⇒ **对 405 重试不只是无用，是有害的**。

### 缺陷形态（用户报障 + 本机复现）

上游有时把拦截包成**边缘 HTML 页**（`<title>405</title>`，无业务码、无风控语义）
⇒ `looksLikeZcodeHtmlPage` 命中 ⇒ 走 HTML 短路 ⇒ 归 `SERVER` ⇒
**在 harness 的 `DEFAULT_RETRYABLE_CODES` 里** ⇒ 白重试 5 轮。

本机实测（会话 `3acf2ebd` turn 16 的 `llm/retry` 事件，逐字）：

```
policyKey: ["normal",5,["EMPTY_RESPONSE","RATE_LIMIT","SERVER","TIMEOUT","TRANSPORT"],500,10000,0.1]
retry 1/5 code SERVER delay 476ms   status 405
retry 2/5 code SERVER delay 950ms
retry 3/5 code SERVER delay 1928ms
retry 4/5 code SERVER delay 4107ms
retry 5/5 code SERVER delay 7237ms
```

⇒ 用户原话「405 html 重试了 3 个 5 次都没用」。

### 与 2026-10-07 那次修复的关系：**不冲突，各管一段**

那次把「HTML 页一律 `SERVER`」是为了修「**5xx 瞬断**被误判成不可重试」
（`500` + 含 `1005` 的边缘页原来报 `QUOTA_EXCEEDED`，只失败一次）。
它**顺带**把 405 也变成了可重试 —— 而它自己的注释已承认 405 从未被真正锁住：

> `405`：去掉短路后会走末尾 `return 'SERVER'`……仍相同 ⇒ 改用能被业务码劫持的断言

⇒ 两件事方向相反：那次是「瞬断不该不可重试」，本次是「风控不该可重试」。

### 修法的三个邻位（缺一个就红，全部实测过）

| 邻位 | 错放的后果 |
|---|---|
| 必须在 HTML 短路**之前** | 405 最常见的形态就是 HTML 页 ⇒ 放后面永不可达 |
| 必须在「有权威业务码」**之后** | `{"code":1005}` + 405 被吞成 `PERMISSION_DENIED`，本该是 `QUOTA_EXCEEDED`（真实回归，1 条红） |
| 码**不能取 `PERMISSION`** | 等价守卫钉住「`PERMISSION` ⟺ `hasZcodeUnusualActivity`」，而 405 页没有风控语义 ⇒ 冒名且让守卫红 |

⇒ 取 **`PERMISSION_DENIED`**（与 `cline-adapter` 的地域限制、`buddy-adapter` 的渠道校验
同口径）：不可重试、但不冒充具体某一种上游错误。

### 文案必须同轴（`describeUpstreamError`）

归类改成不重试后，文案若仍说「建议稍后重试」就是**骗人**（用户等了、重试了，什么都不会发生）。
这是 `IKLBSH`（`AUTH` 吞 message）/ `!IKIZNK`（思考死循环复用 `max-tokens`）的同族形态：
**文案本身就是出路**的错误，码与文案必须同时改。

⇒ 405 分支的文案要说「**不会自动重试**」+ 冷却惩罚后果 + 「**更换账号无效**」，
且**不得**含「额度」「凭据失效」（那是方向相反的指引）。

⚠️ **ESA 页让位**：`formatZcodeEdgePageHint` 里的「边缘CDN」是 ESA 专属词，
守卫「ESA 分支与通用分支必须可区分」钉住「普通 405 页不得含边缘CDN」
⇒ 405 分支判据要加 `!looksLikeZcodeEsaPage(...)`。
ESA 判据已从 `formatZcodeEdgePageHint` 内联抽成导出 `looksLikeZcodeEsaPage`
（**判据只留一份**，否则 `describeUpstreamError` 再抄一份正则就是「一文件两套同义判据」）。

### 守卫

`tests/unit/zcode-claim-3012.spec.ts` 的「★★ 405 恒不可重试」一节（8 条），
变异验证：删掉 405 那一格 ⇒ **5 条红**（3 条新增 + 2 条既有）。

### ⚠️ 真机验证（2026-10-25，真实账号 + 真实凭据，只发 1 发）

`GLM-5.3-Flash` + 3 块 system + 调用方 system 进 messages ⇒ **HTTP 200**
（1347ms），模型正文正确回复 `OK`，且 thinking 里复述了那段约定
⇒ `9893e91` 的修复在真机上确认有效，本次改动**没有把正常路径改坏**。

并发 5 发同形态 ⇒ **5/5 个 200，零 429、零 405**。

## ⚠️⚠️⚠️ **`glm-5.3-flash` 的 gap 从 0 改成 500ms**：并发下 Flash 也会撞 3009（issue IKQ4B4，2026-10-25）

`model-gate.ts` 的闸门保证「串行（不重叠）+ 按模型间隔」。而
`zcode-product.ts` 原配 `'glm-5.3-flash': 0`，注释理由是「Flash 从未撞过限流」。

### 那条理由已被实测证伪

依据是 `dsh-free-glm` 的分模型实测：

```
GLM-5.3-Flash  605 次 200    0 次限流      ← 该窗口内 Flash 配额够用
GLM-5.3         74 次 200   21 次重试     6 次最终 429
```

⚠ 其成立前提是**串行单发**（605 次里没有并发）。一旦开并发
（多个 subagent / 多轮并行），`gap=0` ⇒ 闸门只保证不重叠、**不保证间隔**
⇒ N 个请求首尾相接密集连发 ⇒ 只要该模型的并发窗口 < N 就撞
`429 + 3009 model concurrency limit exceeded`。

本机实测（会话 `3acf2ebd` turn 15）：模型正是 `GLM-5.3-Flash`，撞了 429+3009，
随后 turn 16 **升级成 405 风控拦截** ——「并发开多就全废」的起点。
用户原话：「1.5 亿 token 并发多了以后碰到，是 glm-5.3-flash，普通的 glm-5.3
没有碰到（可能是因为我用 5.3 都是单线程的）」。

### 为什么两个缺陷是**串联**的

```
gap=0 ⇒ 撞 429+3009
  ⇒ 适配器②层退避 2 轮 × harness⑤层 5 轮 = 单请求最多 10+ 发
  ⇒ 并发放大（4-5 个 subagent ⇒ 40-50 发密集打同一模型通道）
  ⇒ 触发风控 ⇒ 405
  ⇒ 405 归 SERVER 又再放大 5 轮 ⇒ 越重试越糟
```

⇒ 修任何一环都能打断这条链，但**两环都修**才能真正解决「并发开多就全废」。

### 修法与参数

`'glm-5.3-flash': 500`（**用户指定值**，比 glm-5.3 的 350ms 略保守 ——
Flash 首帧通常 <1s ⇒ 单请求耗时短 ⇒ 同样间隔下单位时间内请求数更多）。
代价可接受：并发 5 个铺开只需 2.5s，相对推理耗时占比很小。

### 一条**已排除**的假设（别再走一遍）

「换 `x-session-id` 能否避免限流」——**不能**：

- 并发配额是**服务端按「模型 + 账号」计量**的（`zcode-product.ts` 明写），
  session id 不参与；
- session id 按 `device_mid` 派生，而 `device_mid` 是登录时随机生成的**凭据字段**
  ⇒ 为规避限流而每请求换 session id，反而造出「同一账号多个会话」的形状，
  那才是真实客户端不会产出的异常信号（`zcode-upstream.ts:167` 正是这么论证的）。

⇒ 真正该动的是 **gap（客户端自保节流）**，不是 session id（伪装身份）。

### 守卫

`tests/unit/model-gate.spec.ts` 的「ZCODE 产品配置」一节（3 条），
**逐个模型枚举**而非汇总式「全部 > 0」（汇总式在有一个非零值时恒真，
将来新增模型漏配 gap 不会红）。变异验证：flash gap 改回 0 ⇒ **2 条红**。

### ⚠️⚠️ 真机验证（2026-10-25，本机 6 账号 + 真实凭据）纠正的一个认知

**「gap 不是加速节流，而是秒回时的下限保护」** —— 这一点初版判断错了，
是实测打出来的：

| 场景 | gap=500ms | gap=0（缺陷态） |
|---|---|---|
| **正常响应**（上游 1-3s） | 5/5 个 200，铺开 | **5/5 个 200，同样铺开** |
| **秒回**（上游 60-250ms） | 间隔 512/512/510/510ms | 间隔 199/131/224/**60**ms |

⇒ 正常响应下 `serializeUpstream: true` 的**串行模式已天然铺开**
（后一发要等前一发的上游耗时结束），gap=0 与 gap=500 **看不出差别**
（实测两者都 5/5 个 200，零 429、零 405）。

⇒ gap 的价值只在**请求快速返回**时显现：上游拒绝（400）、空响应、
风控拦截（405）都返回得快，那时 gap=0 ⇒ N 个请求在毫秒级首尾相接
（实测最小间隔塌到 **60ms**，5 发总铺开从 2044ms 压到 615ms）。

⚠️ **这与用户撞 429 的场景完全吻合**：429/405 都是秒回形态。
⇒ 修 gap 是修「秒回时的密集连发」，不是修「正常流量的节流」。

⚠️ 顺带一条：`GLM-5.3` 的 6 个账号当时**全部**带未过期的
`modelRateLimits` 标记（解禁 = UTC+8 当日 24:00）⇒ `GLM-5.3` 可选账号 0/6，
而 `GLM-5.3-Flash` / `GLM-5.2` 均 6/6。**「glm-5.3 用不了」是自然日额度
烧光 + 既有结算设计，与本次修复无关** —— 报障时先看这个，别误判成新缺陷。

## ⚠️⚠️ 会话亲和的**负载溢出**（`DSH_ZCODE_SESSION_BALANCE_OVERFLOW_REQUESTS`，2026-10-31 审计后定稿）

会话亲和（`accountSelection: 'session-balance'`）下账号负载 ≈ **会话长度**：一个跑整天的
会话把它哈希到的那个号独自吃满。本机真实账本（`~/.dsh/jet-hub/token-ledger.json`，
按 `provider=zcode` 按账号聚合 `requests`）实测 `2026-10-31` 六个有量账号为
`1233 / 459 / 8 / 7 / 7 / 7` —— 单号占当日 **71.6%**，`max/mean = 4.30`。

修法是**软溢出**：`rankAccountsBySessionWithOverflow()`（`src/session-balance.ts`）
把「今日请求数 ≥ 阈值」的账号整组沉底，其余仍按 rendezvous 哈希序。

### 三个必须记住的判据

1. **它是「上限（cap）」，不是均衡器。** 最终比值上界 ≈ `阈值 ÷ 当日均匀量`。
   固定 300 在本机实测把 `4.30 → 1.42`；默认曾取 600，**4 天里 3 天峰值 < 600
   ⇒ 一个号都不会沉底 ⇒ 零效果**（且 PR 正文举证的峰值 322 也 < 600）。
2. **它做不到「已有会话保持亲和」，而且是靠「中途换号」生效的。** 函数是**无状态
   纯函数**、调用方**每个请求**都重跑（池里没有 `sessionId → accountId` 记忆）。
   会话所在账号越阈的那一发就会迁移：实测 8 号池 1300 连跑在第 **601 / 1201** 次
   各迁移一次；阈值低于均匀量时还会「为 1 次请求换号」并「越过阈值后弹回原号」
   （全员超载 ⇒ 退回哈希序）。**不要**再在任何地方写「同一会话固定落同一账号」——
   这句话在 README / 客户端 tooltip / 4 处源码注释里已一并订正。
3. **阈值是绝对量，不是「当日总量的相对量」。** 相对量实测被否决：阈值随总量上涨
   会把已超载账号重新变 fresh ⇒ 会话反复弹回。同一场景实测换号次数
   **固定 300 = 5 次**、`max(200, 1.2×均值) = 204 次`、`1.5×均值 = 428 次`。

### 环境变量

| 变量 | 缺省 | 语义 |
|---|---|---|
| `DSH_ZCODE_SESSION_BALANCE_OVERFLOW_REQUESTS` | `300` | 账号今日请求数达到它即沉底；`0` = 关闭溢出（纯哈希亲和） |

⚠️ **只认纯十进制整数**（`/^\d+$/`）。宽松 `Number.parseInt` 的静默失效已实测：
`'1e3'` → **1**（每个号第一发就算超载 ⇒ 能等于没修）、`'0x10'`/`'0b101'` → **0**
（把溢出整条关掉）。两者都**无日志**。现在非纯数字串一律回落 300。

### 数据源与代价

负载来自 token-ledger 的**日聚合**（`readTokenLedgerDayMap()`，UTC+8 日键）：
`backend.load()` 是**纯内存读**、零网络请求，实测真实 8 桶 ≈ 0.9 µs/次、
最坏 500 桶 ≈ 85 µs/次 —— **不构成性能问题**。口径是「每次 `stream()` 记一行」，
即**逻辑轮次**（适配器内部换号重发不额外记账；宿主 step 重试会）。

⚠️ 选号处的账本读取**必须包 try/catch 退化为空表**（`sessionLoadIndex()`）：
记账后端是外部注入点，统计故障绝不能把整条推理链路变成不可用 —— 与
`src/index.ts` 的「记账绝不反噬推理」同一条纪律。

### 已知边界（别当成缺陷）

- **小池 + 高量**：2 个号各 850 次、阈值 300 ⇒ 两个号长期都超载 ⇒ 退回哈希序
  ⇒ 不生效（此时不均衡度本身也只有 ≤2.0，可接受）。
- **大池 + 高量**：20 个号均分 86 ⇒ 单号很难到 300 ⇒ 不生效。5~8 号池最合适。
- 阈值按 **UTC+8 日界**归零，跨日那一刻所有账号重新变 fresh。
- **聚合渠道的流量不参与**：`aggregate` 选号不走本函数，且账本里记成
  `provider='aggregate'` + 空 `accountId` ⇒ 索引看不到那部分负载。
- **不看模型**：索引按账号跨模型求和。某号在 `GLM-5.3-Flash` 上超载，会让它在
  `GLM-5.3` 的选号里也被沉底（多半是想要的，但要知道这是合并口径）。

### 守卫（2026-10-31 对抗审计补齐后）

`tests/unit/session-balance.spec.ts` 的「× 溢出均衡接线」那一组用**真实
`attachTokenLedgerStore`** 挂假账本，从 `AccountPool` 层端到端验证。补齐前**整条生产
接线零守卫**：把 `account-pool.ts` 的调用换回 `rankAccountsBySession(...)`（= 修法
完全失效）**全仓 11654 条测试仍全绿**；把日键写成 `'1970-01-01'` 同样全绿。
现在这两条变异都变红（连同 try/catch、NaN 归一、默认 300、env 严格解析）。

⚠️ 同组里那两条**等价变异**（删「`fresh`/`overflowed` 任一侧为空就早退」、删
`threshold <= 0` 早退）**删掉后行为逐字节相同**（5632 格穷举实测）⇒ 它们是**不可观测
的防御性代码**，**不要**为它们编用例声称覆盖。同理「全员超载退回哈希序」这条
**语义**值得锁，但它锁不住那段代码。

⚠️ 该 spec 现在**已列进 `tsconfig.tests.json` 的 `include`**：初版不在，于是
`typecheck:tests` 对它恒为「0 错」，而它正是「把日聚合表当账号负载表传」这种
**形状错误**的唯一现场（纳入后立刻暴露 3 处 `TS2345`，那两条用例当时是假绿）。
