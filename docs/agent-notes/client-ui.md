<!-- 搬自 AGENTS.md（2026-10-06 拆分：注入预算 65,536 B，超出部分每轮被截断永不可见）。
     内容逐字节原样保留；本文件按需阅读，不进每轮注入。 -->

## ⚠ 「通用面板」里的按钮与弹窗**必须按 provider 分支**（Issue IKJLK3）

**真实缺陷**（Gitee issue IKJLK3，用户报障，2026-10-03）：Jet Hub 的
`ProviderPanel`（`plugin-src/client/jet-hub.js`）按 `provider` prop 复用**同一个组件**，
于是「+ 新建账号」按钮存在于**全部 13 个 provider 的面板**里，而 2026-10-03 刚搬进去的
**登录渠道弹窗是 zCode 专用**的（标题硬编码「添加 ZCode 账号」+ 一个渠道 `<select>`）。
二者没有分支，后果是**三个同源缺陷**：

| 现象 | 根因 |
|---|---|
| 在 CodeArts / Qoder 等面板点「+ 新建账号」，弹出的是「添加 ZCode 账号」 | 按钮无条件 `setPendingLogin(false)` |
| 弹窗里选 bigmodel / z.ai **没有落点** | 载荷构造 `provider === 'zcode' ? {provider, zcodeProvider} : {provider}`，非 zcode 那一支不传 |
| opencode 要点**两层**弹窗 | 按钮先弹 ZCode 渠道窗，点「确定」才走到 `setKeyModal` 的 API key 表单 |

⇒ 修法是**判据收进纯函数**，不写在组件里：
`plugin-src/client/new-account.js` 的 `newAccountAsksChannel(provider)` 与
`buildCreateAccountPayload(provider, zcodeProvider)`（与 `account-model-link.js` /
`model-bulk.js` 同样做法：单测环境是 `node`、**react 不在依赖内**，
组件渲染不了，判据必须抽出来才能**真跑**覆盖）。语义定为
**「只有 zcode 先问渠道，其余 provider 点按钮即登录」**。

⚠ **三条同源教训**（下次在通用面板加 provider 专属 UI 前先过一遍）：

1. **判据方向要选失败安全的那边**：`newAccountAsksChannel` 写成**白名单**
   （`provider === 'zcode'`）而不是「排除法」。将来新增 provider 忘了改这里，
   后果是「少问一次」而非「弹错窗」—— 少一次确认是降级，弹错窗是破坏。
2. **「通用组件里的 provider 专属 UI」是接线 bug，不只是漏一个 `if`**：
   按钮 `onClick` 与弹窗渲染处**两处都要接**（渲染处那道是防御性的），
   回归用例也分两条守 —— 只锁纯函数会被「判据还在但没人调用」绕过。
3. ⚠ **既有测试会贴死写法**：`tests/unit/zcode-channel-dialog.spec.ts` 原本断言
   `onClick: () => setPendingLogin(false)` 与 `pendingLogin === undefined ? null :`，
   分支化后全部变红。⚠ 那**不是**要改实现去迁就测试 —— 要把断言改成锁**意图**
   （「zCode 面板仍必须先弹窗」「条件仍挂在 `pendingLogin` 上」），
   并在注释里写明为什么放宽，否则下一个改写法的人会照着把分支删回去。

⚠ **同类问题还有服务端那一半**（E2）：`account.create` 的 `zcodeProvider`
原先只有 `?? 'bigmodel'` 兜底、**无白名单** —— RPC 载荷是**客户端自报**的
（入口无 schema 校验），`ZcodeLoginProvider` 只是 TS 联合类型，运行时任何字符串都能进来，
未登记值会被原样送进 `startZcodeLogin` 打到不存在的授权端点（表现为「授权页打不开 /
轮询超时」这类极难定位的失败）。现由 `normalizeZcodeLoginProvider()` 归一，
**回落**（与既有缺省兜底同向，不报错，老客户端照常能登录）+ 非缺省时 `console.warn`。

⚠ **提单人对 E1 的判断有误，别照抄**：「`account.create` 未校验 provider，会一路走到链尾」
—— 链尾**本来就有**兜底 `else { return unknown provider }`，且 `id` 只在分支内使用，
未知 provider **不会**被写进账号池。不必再加一道重复校验。

⚠ **`dim-jh-zcDialog*` 类名已经不准**了：它是**通用弹窗样式**，只服务 Jet Hub 页
的登录渠道弹窗。曾想改名，但样式表一起动、收益仅是可读性，故保留名字 —— 别再据类名
判断「这段 UI 只属于 zCode」。
⚠ 它原先还有第二个使用方（官方模型卡片里的 ZCode 账号区，`zcode-card.js`），那份已随
Gitee issue IKJLHQ 整体移除（见上一节）。

⚠ 另两条同 issue 的低频项：登录重入闸门 `if (pollRef.current !== 0) return`
**不能静默 return**（弹窗确定按钮是「先关弹窗再调 createAccount」，
早退时用户只看到「点了没反应」，要复用 `probeNotice` 给提示）；
`console.log('account.create response =', res)` 会把**含 OAuth state 的 loginUrl**
打进控制台（用户截图求助时外泄），只记 `provider` 与本地 `accountId`。

回归用例 `tests/unit/new-account-dialog.spec.ts`（14 条，做过 8 个变异的反向验证）。
⚠ 写这类源码级断言时**必须先定位再匹配**：`jet-hub.js` 里有 **3 处**
`pollRef.current !== 0`（另两处在 `stopPoll` 的清理里），只按字面量找第一个
会命中无关代码；且断言要对**剥掉注释**的文本做，否则文件头为记录旧实现写下的
那行字就能喂绿（本轮修的正是「登录渠道选择」，注释里必然提到它）。

## 账号池与多账号

`AccountPool`（`src/account-pool.ts`）在 `jet-hub` settings 命名空间下保存账号索引，凭据本体存于 `ctx.credentials`。要点：

- 账号条目以 `provider` 字段区分归属，`getAvailableAccount` / `listAccounts` 均按该字段过滤
- 适配器必须以 `this.product.id` 作为 provider 实参查询账号池（写死 `'buddy'` 会让 WorkBuddy 永远匹配不到账号）
- 限流后按池中「已启用且不在重置时间内」的下一个账号自动重试；全部耗尽才抛 `QUOTA_EXCEEDED`

### ⚠️⚠️ 全部账号被**模型限流**时，必须报限流，不能报成「未登录」（真实缺陷，2026-10-03）

**用户报障**：`/compact` 连续四次失败，UI 只显示通用文案
「Compaction could not produce a useful summary」。解出会话日志后，`compaction/end`
携带的真实错误是：

```
buddy: no usable credential; log in from the Jet Hub panel first
```

而当时 Jet Hub 里 buddy 账号**已登录、已启用、凭据完好** —— 真实原因是它被
`deepseek-v4.1-flash` 的**模型级限流**挡住（解禁时刻就存在 `modelRateLimits` 里）。
用户被指去「重新登录」，方向完全错。

**链路**（四个环节都正确，合起来却报出假原因）：

1. 唯一的启用账号带该模型的未过期限流标记 → 候选筛（原
   `src/index.ts` 里 buddy 系那段编排闭包，符号名已随 Task 6 删除
   —— 见 git 历史 `d35d9e3`）筛成**空集**；
2. `select()`（`src/buddy-balance-selector.ts`）对空候选只能回一个笼统的
   `{kind:'exhausted'}`，**未锁定时 `reason` 被丢弃**；
3. 调用方退到**单凭据 ref** `BUDDY_ACCESS_TOKEN` —— 而 Jet Hub 登录只写
   `BUDDY_ACCOUNT_XXX`，该 ref **从未存在过** → `resolveCredential` 返回 `undefined`；
4. 适配器据此抛 `MISSING_CREDENTIAL`（`src/buddy-adapter.ts`）。

⇒ 与 qoder 的 `110` 被误归 `SERVER`、`10605` 排队被漏判是**同一个病根**：
**用默认归类代替了对业务语义的判断**。

**修法**：新增纯判据 `allAccountsRateLimitedForModel()`（`src/account-pool.ts`），
在「候选为空、即将退到单凭据 ref」这一刻**证明**失败原因。位置必须是
`getAvailableAccount` **之后**、`ctx.credentials.resolve` **之前**：
池里还有号时不该报限流，而退到单凭据之后就来不及了。

- ⚠️ **只改错误语义，不改可用性**：没有账号可用就是没有，压缩该失败仍然失败；
  修的是「用户看到的原因」。**绝不静默换模型**（那是替用户做决定），
  **绝不绕过限流标记**（那会让标记形同虚设）。
- ⚠️ **判据必须窄**，与选号侧严格同口径（缺标记 / `0` / `now >= resetAt` 都算不受限），
  且空 `modelId` 直接不判定 —— 选号侧约定空 modelId 不做限流过滤
  （`if (modelId.length === 0) return true`），不同口径会把「未登录」误报成「限流」。
  ⚠️ 该空串守卫**不是**冗余：`updateModelRateLimit` **不校验** modelId，
  理论上可落下 `modelRateLimits['']` 脏键，没有它就会被当成真实限流上报。
- ⚠️ **只统计启用账号**（`.filter(a => a.enabled)`）：停用账号本就不参与自动选号，
  把它们算进来会让「有一个号被停用」的普通情况被误报成「全部限流」。
- ⚠️ **错误码取 `QUOTA_EXCEEDED`**（本仓库既有惯例，且**不在**
  `DEFAULT_RETRYABLE_CODES` 里）；**不可取 `AUTH`** —— 那会把整条 message
  换成「API 密钥无效」（判据见下文「安全策略拦截」那条的取证），
  精心写的解禁时刻在 UI 上一个字都看不到。
- ⚠️ **文案必须带解禁时刻与「无需重新登录」**：只说「限流」而不给时间，
  用户仍会去重登或干等。
- ⚠️ **两处都要接**（`CODEBUDDY` / `WORKBUDDY` 各一处），否则两个 provider 行为不一致。
- 测试：`tests/unit/buddy-ratelimit-misreport.spec.ts`（19 条：行为级判据 + 源码级接线
  + 回归保护）。⚠️ 已做**反向验证**：移除两处判定调用 → 3 条变红；
  逐条破坏判据（去 `modelId` 空串守卫 → 1 条、去 `resetAt===undefined` → 2 条、
  去 `now>=resetAt` → 2 条、去 `resetAt===0` → 1 条、最早解禁改最晚 → 1 条）。
  ⚠️ 写用例时注意：断言「判定先于单凭据兜底」**不能只搜 ref 名** ——
  `BUDDY_CREDENTIAL_REF` 在文件更早处（import 与注册）也出现，会命中错位置
  （实测 `check=12308` 反而大于 `fallback=751`）；锚点要用**完整的兜底调用语句**。

### 账号顺序 = 选号优先级（Jet Hub 拖拽排序）

**数组顺序本身就是 `getAvailableAccount` 的候选优先级**，即自动选号与限流换号的实际取号顺序。

- ⚠️ **不要重新引入「按限流重置时间重排候选」的 sort**。早期实现有
  `candidates.sort((a,b) => resetAtA - resetAtB)`，它会让手动顺序形同虚设 ——
  用户把某账号拖到首位，只要另一个账号的重置时间更早，实际选中的仍是后者。
  现语义分两档（2026-11-09 订正，别再把两句混成一句）：**走余额分档的 14 家渠道**
  （`BALANCE_TIERED_PROVIDERS`）默认是「**先按积分到期档位排序、档内才看拖拽顺序**」
  —— 面板对它们渲染「严格手动顺序」开关（`JetHubState.strictManualOrder`，稀疏表、
  缺键 = 关 = 升级前行为；打开后拖拽序才是唯一优先级，但档位仍判「能不能用」：
  锁定永久积分时只剩永久积分的号照旧被跳过）；其余渠道（codearts / raccoon /
  cline / gemini …）才是「**手动顺序优先，限流豁免**」：顺序完全由用户决定，
  而正处于限流期的账号已被 `filter` 排除，不会选到
- `reorderAccounts(provider, orderedIds)`：**只动本 provider 占用的下标**，
  其他 provider 账号位置不变（账号存在一个全局数组里，设置页按 provider 分组渲染）
- `orderedIds` 必须是该 provider 全部账号 id 的一个**排列**，否则抛错。
  少了 id 若静默忽略，该账号会莫名掉到末尾（用户看到「顺序自己变了」）；
  多了未知 id 说明前后端状态不一致
- RPC：`account.reorder`；前端 `plugin-src/client/jet-hub.js` + 纯逻辑
  `plugin-src/client/account-order.js`
- ⚠️ **落点必须区分 before / after**（`dropPositionFromPointer` 按指针落在目标卡片
  上半/下半判定）。只支持「插入到目标之前」时，把卡片**往下拖一格是空操作**，
  用户会以为拖拽坏了。插入线指示（`data-dropBefore` / `data-dropAfter`）必须与
  实际落点一致
- ⚠️ **移除源元素后目标下标会前移**，必须用 `indexOf` 重算而不能复用原下标，
  否则会插到目标之后。`tests/unit/account-order.spec.ts` 覆盖了这一点

#### 「严格手动顺序」开关（2026-11-09 落地 + 审计返工）

- **存哪**：`JetHubState.strictManualOrder`（`Record<string, boolean>` 稀疏表，缺键 = 关 =
  升级前行为）。**整体替换陷阱**：`AccountPool.saveState()` 的 `replace` 载荷必须显式带上
  这个键，否则任何无关写入都会把它抹掉（`tests/unit/strict-manual-order-persist.spec.ts`
  用「先打开、再做一次 `setProviderClosed`、最后断言键仍在」钉住）。
- **RPC**：`strictManualOrder.getEnabled` / `setEnabled`。`setEnabled` 返回的是
  **落盘后重读**的值，不是 `req.enabled` 的复读 —— 客户端据此做非乐观更新；
  回显实现会让「落盘失败」显示成已打开（用例用「拒绝写入的池」把两者分开）。
- **面板**：只对 `BALANCE_TIERED_PROVIDERS` 渲染（`supportsBalanceTier(provider)`）。
  busy 态用 `aria-disabled` + `onClick` 早退（**不用** `disabled`，否则原生 tooltip 一起失效），
  且 `:hover` 规则必须排除 `[aria-disabled='true']`，否则「忙碌中」仍然高亮。
  读开关失败**不得静默显示「关」**（与「用户自己关掉了」同形）⇒ 状态行改为「读取失败 —— 点击可重试」。
- **守卫分层**（四份各钉一段，缺一即静默失效）：
  | 文件 | 钉什么 |
  |---|---|
  | `strict-manual-order.spec.ts` | 两个 rank 纯函数 + Selector 接线 |
  | `strict-manual-order-wiring.spec.ts` | `src/index.ts` 真实装配 ↔ `BALANCE_TIERED_PROVIDERS` **双向差集** |
  | `strict-manual-order-resolver.spec.ts` | `createCredentialResolver` 真的把池的开关传给 Selector（buddy / loomy 两条腿） |
  | `strict-manual-order-persist.spec.ts` | 落盘 round-trip + 整体替换陷阱 + 脏值 sanitize |
  | `jet-hub-panel-wiring.spec.ts`（末段） | 真渲染 + 真点击：分档渲染、点击发 `setEnabled`、非分档不渲染 |
- ⚠️ **AST 守卫的已知极限**：`jet-hub-structure-ast.spec.ts` 只钉 `canStrictOrder` 的**条件文本**，
  钉不住它的**定义** —— 实测把它改成 `= false` 时四个文件全绿（开关永不渲染）。
  故必须另有真渲染用例（上表最后一行）。

### ⚠️ 安全策略拦截（11140）：三条通道都要换号 / 标冷却，错误码**绝不能**取 `AUTH`

腾讯侧业务码 `11140`（`request illegal`，文案写「内容未通过安全审核」）**服务端嘴上说是
内容问题，实测是账号级拦截**：同一份请求体发往池里 7 个账号得到「2 通 / 4 拦 / 1 限流」，
连「你好」都被拦，换新会话照样拦（排除上下文累积）。因此它的正确出路是**换号**，
不是让用户改内容。该结论由 !15（认证路径）与 !16（限流路径）先后确立，本次补齐剩下两处。

- ⚠️ **错误码不能取 `AUTH`，也不能取 `QUOTA` / `ACCOUNT_QUOTA`**（通用教训，不限本 provider）。
  DSH 聊天 UI 的判据是（取证：`@deepseek-ai/dsh-client-ui-chat/lib/client.js:1229-1234`）：
  ```js
  if (code === "QUOTA" || code === "ACCOUNT_QUOTA") return t("message.failure.quota");
  return code === "AUTH" ? t("message.failure.auth") : message;
  ```
  即 `AUTH` 会**把整条 message 换成「API 密钥无效」**（`displayFailure()` 那里甚至强制
  `message: ""`）。!15 精心写的「全部账号均被服务端安全策略拦截…」在 UI 上**一个字都看不到**，
  还把用户引向检查密钥（实测 7 个 token 全有效、2027-09 才过期）。
  ⇒ **凡是要把自定义文案送到用户眼前，码必须避开这三个**。
  现取 `PERMISSION_DENIED`：与本仓库 `cline-adapter.ts` 的地域限制分支同码（见下文惯例），
  且**不在** `DEFAULT_RETRYABLE_CODES`（`EMPTY_RESPONSE / RATE_LIMIT / SERVER / TIMEOUT / TRANSPORT`）
  里 → 确定性结论不会被 harness 白退避 5 次。
  ⚠️ 也别顺手改回 `AUTH`「与其余 401/403 口径一致」：口径一致不该以吞掉文案为代价。
- ⚠️ **被拦账号必须打冷却标记**（`markPolicyBlockedAccount`，`src/buddy-adapter.ts`）。
  !15 / !16 让「有可用账号就一定能用上」成立，但**每轮都要重撞坏账号**：候选顺序是用户拖拽定的
  （见上文「账号顺序」），实测那池前 4 个被拦 → 每次请求固定先发 4 次失败。
  复用账号池的 `modelRateLimits` 载体（它是**唯一**的「账号×模型暂时不可用」映射，没有 reason 字段），
  代价是账号卡片显示「限额重置 · 模型 · 30 分钟后」而非「安全策略拦截」；
  收益是 `getAvailableAccount` 的过滤、UI 的「重测 / 重置」两条人工解禁路径**全都现成生效**。
  ⚠️ **时长是自己定的 30 分钟（`BUDDY_POLICY_BLOCK_COOLDOWN_MS`），不要复用
  `parseRateLimitError` 解析不到时那个 1 小时兜底** —— 11140 报文里根本没有时间字段，
  走那条兜底等于把「策略拦截」冒充成「服务端限流」。也别与 cline / lobsterai / trae 的
  `*_RATE_LIMIT_FALLBACK_MS` 合并成一个常量（语义不同，调一个不该动另一个）。
  ⚠️ 标记**只随时间到期失效**：`sweepExpiredRateLimits` 在生产代码里**没有任何调用方**，
  别指望它来清过期项（过期标记靠**取号时的过滤器**忽略：`getAvailableAccount` / `listAvailableCredentials` 里的 `Date.now() >= resetAt`。
  ⚠️ 这里**刻意不写行号** —— 2026-11-05 二审实测它已漂到 `578`（真实位置 2668 / 2751），行号在两次提交内就会腐坏。
  ⚠️ **只标该模型**（同 qoder 额度那条口径）：跨模型无实测依据，标全部模型会误伤本可用的组合。
  ⚠️ 写标记失败**只记日志、不上抛**（与 `src/expiry-sync.ts` 惯例一致）：本次的准确错误才是主线。
- ⚠️ **流内（HTTP 200 + SSE 帧）那条通道原先整帧被静默丢掉**：buddy 的帧类型里**没有**
  `code` / `msg` 字段，而 11140 恰好是顶层 `{code,msg,displayMsg}`、无 `error` 无 `choices`
  → 一路走到循环末尾，既没内容也没报错，UI 表现成「干净地停止、无任何失败」
  （与 qoder 的 10605、TRAE 的流内错误同型）。
  ⚠️ **判据必须带「这一帧没有 `choices`」这层门禁**：正文里出现「安全审核」
  /`request illegal`/字面 `11140` 是常态（模型在讨论审核策略就会说），只看 payload 字样
  会把一个合法回答判成拦截并连带标冷却。
  ⚠️ 判据与 HTTP 层**共用** `isContentRejection()`，别在流内另写一套 —— trae 那次缺陷的成因
  就是流内分支当年自己写了一套判据。
  ⚠️ 本通道按定下的口径是「**标记 + 如实报错**」，本轮不重发（重发需要「尚未产出内容」判据
  + 外层循环，那是 `3823133 fix(trae)` 那种结构改造，不在本次范围）；下一轮选号会自动绕开。
  故报错文案取「当前账号…」而非「已逐个换号重试」——**文案必须与是否真换过号一致**。
- ⚠️ **单账号池 + 续期失败**时，`credential expired and refresh failed` 那条早退分支
  **也必须先排 11140**：单账号池必然满足「没换到号」，修复前真实原因是拦截时报的却是
  `AUTH` + 一句与凭据有关的话（写用例时实测到）。
- ⚠️ 文案里的 HTTP 状态取**最后一次拦截**的，不是首发的：「首发 401 + 途中 403/11140」
  若沿用首发状态会报出一个对不上的「HTTP 401」，把人引向「token 过期」。
- 测试：`tests/unit/buddy-adapter.spec.ts` 的
  「安全策略拦截（11140）：账号冷却 + 流内错误帧」段（7 条）。
  ⚠️ 已做**反向验证**：错误码退回 `AUTH` → **7 条**变红；禁用冷却标记 → **5 条**变红
  （含认证 / 限流 / 流内三条通道各自那条）；禁用流内识别 → **2 条**变红。
### ⚠️⚠️ 承上：**额度用尽**也不能用 harness 常量 `QUOTA_EXCEEDED_CODE`（Issue IKJVCW）

上一条讲的是「自定义文案要避开 `AUTH` / `QUOTA` / `ACCOUNT_QUOTA`」。
**但「避开 `QUOTA`」这件事有一个隐蔽的陷阱** —— 它让 codearts 成了十个
provider 里**唯一**中招的一家。

#### 陷阱：harness 常量的字面值就是被替换的那个码

```ts
// @deepseek-ai/dsh-llm
export declare const QUOTA_EXCEEDED_CODE = "QUOTA"   // ← 就是 "QUOTA"
```

于是「用 harness 的规范化常量」这个看起来最正确的写法，
**恰好产出会被客户端吞掉的码**（`failureMessage`，实测见下）：

```js
if (code === "QUOTA" || code === "ACCOUNT_QUOTA") return t("message.failure.quota");
return code === "AUTH" ? t("message.failure.auth") : message;
```

`message.failure.quota` 的中文是「**当前请求的额度已用尽**」。

#### 真实症状（用户报障）

`codeartsQuotaExhaustedMessage()` 精心写的

> `codearts: 模型 deepseek-v4.1-flash 的免费额度（benefit）已用尽，`
> `预计 5.5 小时后重置（按 UTC+8 自然日结算，预计 …）。可改用其它模型，或…`

**一个字都到不了用户眼前**，只剩「当前请求的额度已用尽」——
既没有原因（benefit 额度）、也没有出路（换模型 / 切账号 / 何时恢复）。
用户会去等额度恢复，而实际该做的是换模型。

#### 判据：**字面量 `'QUOTA_EXCEEDED'`，不是 `QUOTA_EXCEEDED_CODE`**

| 码 | 客户端替换文案？ | 在 `DEFAULT_RETRYABLE_CODES`？ | 语义 |
|---|---|---|---|
| `QUOTA`（= harness 常量） | **是** | 否 | 额度 |
| `'QUOTA_EXCEEDED'`（字面量） | **否** | 否 | 额度 |
| `PERMISSION_DENIED` | 否 | 否 | 权限（**额度用它属语义错位**） |

⚠️ **不要为了「与 harness 词汇一致」改回常量**，也**不要**照 IKJVCW 建议把额度
一律改 `PERMISSION_DENIED`：仓库里 buddy / cline / lobsterai / trae / zcode /
minimax 等 **~20 处**额度错误一律用字面量 `'QUOTA_EXCEEDED'`，且**都不被替换** ——
`codearts` 改用 harness 常量才是异类，**这正是缺陷只在本家复现的原因**。

⚠️ 下游判据**已经双认**这个词汇差异，不必配套改：
`account-probe.isRateLimitFailure` 与 `qoder-adapter.isQuotaExceededError`
都同时接受 `'QUOTA_EXCEEDED'` 与 `'QUOTA'`；`dead-model-store` 的
`IGNORED_CODES` **只收** `'QUOTA_EXCEEDED'`（原先靠 `/额度/` 文案兜底才没把模型
误记成 30 天失效，改后是显式命中，**比原来更稳**）。

#### ⚠️ 客户端按码判定的点**不止一处**（别只盯着 `failureMessage`）

审计实测（2026-10-11，桌面端 `app.asar` 与 `dsh-client-ui-chat/lib/client.js` 双份一致）：

| # | 判定点 | 判据 | 对 `'QUOTA_EXCEEDED'` 的影响 |
|---|---|---|---|
| 1 | `failureMessage` | 替换 **5** 个码：`ACCOUNT_SIGNED_OUT` / `ACCOUNT_SIGN_IN_REQUIRED` / `QUOTA` / `ACCOUNT_QUOTA` / `AUTH` | ✅ 不命中 ⇒ **message 完整透出**（本修复的目的） |
| 2 | `quotaNotice` | `code !== "QUOTA" && code !== "ACCOUNT_QUOTA"` | ❌ 不命中 ⇒ **全局额度 Toast 不再触发**（见下） |
| 3 | `displayFailure` | `if (code === "AUTH") return { code, message: "" }` | ✅ 不涉及（但这是 `AUTH` 的 message 被**置空串**之处） |

⚠️ **第 1 处的「5 个码」不要写成「三个码」** —— `src/sse.ts` 的
`REASONING_LOOP_CODE` 注释里**早就登记了同一份 5 码清单**，同一仓库两套同义
数字必有一处是错的（本次修复初版就写错成三个，被审计抓出）。

⚠️ **第 2 处是本修复的已知取舍**（审计实测，**不要**当缺陷再「修」回去）：
`quotaNotice` 驱动一条**不随 Chat 面板消失**的全局额度 Toast，它只认
`QUOTA` / `ACCOUNT_QUOTA`。改用 `'QUOTA_EXCEEDED'` 后该 Toast 不再出现。
⇒ 取舍是「失败行有真实原因、但没有全局 Toast」vs「失败行被换成误导文案、
但有全局 Toast」，**取前者**：真实原因就在失败行里，用户一定看得到；
而后者的误导文案会把用户引向「等额度恢复」这个错误动作。
若将来确实需要那条 Toast，做法是在 `plugin-src/client/` 自行注册
`shell.quota-notice` 条目接管该码，**不是**把码改回 `QUOTA`。

#### 三处产出点缺一不可

`src/llm-adapter.ts` 有**三条**会产出该码的路径（少一条就会退回「被客户端顶掉文案」）：

1. SSE 通道 `InferHub.4291.200`（HTTP 200 + 流内错误帧）；
2. 4xx 通道的同一个码（服务端也可能以 4xx 下发）；
3. **`httpErrorCode()` 里的额度归一化**（`400 + insufficient balance` 等措辞）
   —— 这条最易漏，因为它**不在**那两块醒目的额度分支里。

#### ⚠️⚠️ 401/403 下的额度分流**不得**为了「整齐」而调整（一次假阳性审计）

4xx 分支的真实顺序是：

```
isAuthError（401/403 恒真 ⇒ 续期 + continue 重试）
  → isSseQuotaExhaustedErrorCode（额度）→ isRateLimited → … → httpErrorCode
```

401/403 先被 `isAuthError` 接走续期一次，**第二轮**才轮到额度判据。
逐格实测（重建 `lib/` 后走 `stream()`）：

| 报文（4xx + 文案） | 400 | 401 | 403 |
|---|---|---|---|
| `insufficient balance` | 额度 | **AUTH** | **AUTH** |
| `insufficient quota` | 额度 | **额度** | **额度** |
| `out of credits` | 额度 | **AUTH** | **AUTH** |
| `quota exceeded` | 额度 | **AUTH** | **AUTH** |
| `InferHub.4291.200` + `insufficient quota` | 额度 | **额度** | **额度** |

只有 `insufficient quota`（与 `4291` 码值腿）能穿透 ——
因为 `isSseQuotaExhaustedErrorCode` 的**文案腿只认 `insufficient quota`**，
不认 `balance` / `credits`。这是**既有行为**，不是本次改动引入。

⚠️ **不要为了让这张表变整齐去调 `httpErrorCode` 的 401/403 优先级** ——
独立审计曾报过一条「高」严重度缺陷：`httpErrorCode` 里
`if (status === 401 || status === 403) return 'AUTH'` 排在
`isQuotaExceededError(detail)` 之前，故「403 + `insufficient balance` 落 `AUTH`、
同一文案用 400 却归额度」。**我照它改过，已撤回** —— 那是**孤立函数的假阳性**：
审计只测了被建议修改的那个函数，没看它在真实控制流里**本就排在额度判据之后**。
（教训：**审计结论必须回到生产路径复核**，不能只测被点名的那个函数。）

而且该调整**违反本仓库的成文铁律**（`AGENTS.md`「同族判据必须逐格同构」）：

> **401/403 先判**，恒归认证类 —— 状态码与额度文案并存时
> （网关侧故障常在报文里捎带余额提示）**以状态码为准**

codearts 的 401/403 来自**网关**（`APIG.0602` Invalid token / `APIG.0301` 验签失败），
网关故障时捎带余额词是常态。让余额词改写分类 ⇒ 真凭据失效被说成「额度用尽」，
用户被引向「等额度恢复」而非重新登录。该铁律是 2026-10-06 raccoon / loomy
「一个请求内 6 个号各被封 24h」事故的产物。

⚠️ 且「codearts 会用 401/403 下发额度文案」**无实测支撑**（141 个真实会话零命中；
`InferHub.4291` 仅 1 次命中且是在讨论参考实现的 Rust 源码）。
**将来真抓到该报文再按实测处理**，不要据构造报文改分类顺序 ——
提建议者自己在「无法确认」里也承认「无线上真实报文，证据强度不足」。

#### `errorDetail` 的两条腿：**只加不减**

`errorDetail`（`src/llm-adapter.ts`）是上述分类的唯一输入。审计实测它
**不认** `{"error":"<字符串>"}` 形态（只认 `typeof data.error === 'object'`），
于是该形态退回**整段 JSON** —— 用户看到一坨不可读的裸 JSON。
`src/openai-compat.ts` 的**同名函数**早已修过这个形态，本份没跟上
（又一例「一文件两套同义判据」，两处改一处时**必须同时改另一处**）。

⚠️ 修它时**只加腿、不减腿**：`error.code` / `error.type` / `error.message` /
`error_code`+`error_msg` / 顶层 `message` 五条原有腿**必须全部保留** ——
OpenAI 形态常把额度语义写在 `{"error":{"code":"insufficient_quota"}}` 里，
少了 code 那条腿，该报文会从额度**掉回** `AUTH`/`INVALID_REQUEST`。
（改的第一版真的把几条腿一起删了，是比原缺陷更糟的回退。）

⚠️ **测 `errorDetail` 必须直接断言它的返回值**，**不要**绕道「分类结果」：
`{"error":"insufficient balance"}` 这种报文，即使字符串腿失效、函数退回整段
JSON，**整段 JSON 里也含该短语** ⇒ 额度判据照样命中 ⇒ 用例全绿。
第一版就是这么写的，反向验证时才发现是**假守卫**（禁用该腿后 11 条全绿）。
故 `errorDetail` 已**导出**（与 `isSseQueueErrorCode` 同款惯例）供单测直接锁定。

测试：
- `tests/unit/llm-adapter.spec.ts` 的两段（`IKJVCW`）：
  「★ 额度错误的码不得被客户端替换」（8 条）+「★ errorDetail 的形态覆盖」（6 条）。

⚠️ 已做**反向验证**（逐条实测变红，非推断）：
- 额度码改回 `'QUOTA'` → **3 条**变红（三条产出路径各自独立锁死）；
- `httpErrorCode` 恢复「401/403 短路在前」→ **1 条**变红（报出 `'AUTH'`）；
- 额度判据放宽成裸 `insufficient` → **1 条**变红（反向守卫，报出 `QUOTA_EXCEEDED`）；
- 禁用 `errorDetail` 的字符串腿 → **2 条**变红（报出裸 JSON 形态）；
- 删掉 `errorDetail` 的 `error.code` 腿 → **1 条**变红。

⚠️ **试过但失败的攻击角度**（记下以免后人重复）：
「本仓库不再有地域封锁判据」是**结论而非疏漏** —— 详见下条。

### ⚠️⚠️ **不要给 codearts 加「地域封锁」判据**（IKJVCW 的 B 部分，已被推翻）

修复初版曾照 `cline-adapter` 的 `isClineRegionForbidden` 给 codearts 加了一套
「非凭据拒绝」判据（`isNonCredentialDenial` + 4 个 marker），**已整体撤回**。
撤回依据（四路独立取证，两轮审计交叉确认）：

| 取证 | 结果 |
|---|---|
| 全量解压 `~/.dsh/sessions` 下 **141 个真实会话** | `not available in your region` / `country` / `region not supported` / `not subscribed to required model plan` / **`access forbidden`** 命中 **0 次** |
| codearts **真实错误码词汇表**（同批会话抽取） | 全是 `APIG.0301`(验签失败) / `APIG.0602` / `APIG.0101` / `TM.00001041`(并发上限) / `InferHub.4005.200`(unsupported model) / `InferHub.002002009.404`(not registered) / `InferHub.4004.200` / `InferHub.4291.200` / `InferHub.ModelArts.81111.429` / `STS5.1806` —— **无一条地域/订阅类** |
| 端点结构 | `CHAT_API_BASE` 与 `QUEUE_STATUS_BASE` 都硬编码 `snap-access.cn-north-4.myhuaweicloud.com`（中国区华为云），插件**没有任何 region 切换能力** ⇒ 「换出口 / 换区」这个出路在 codearts 上**不存在** |
| 把真实词汇表逐条喂给新判据 | 命中 **0/12** —— 对生产流量零作用 |

⚠️ **所有地域类 marker 的证据都来自 Cline**（`cline-adapter.ts` 的实测报文、
`providers-cline.md` 坑 6、`implementation-notes.md`）。这是「移植既有实现」
的典型误用：抄了别家的**判据表**而非本家的实测事实（`AGENTS.md` 的
「先抄『类别→动作』表」那条纪律的同型错误）。

⚠️ 照搬还有**直接坏处**（实测）：新表与 cline 表对同一报文**给出相反结论**
—— `{"error":"access forbidden: x is not permitted"}` 在 cline 判「地域」、
在新表判「不是非凭据」；反向也不一致（`not subscribed` 在新表判真、cline 判假），
既非子集也非超集，是**第三套口径**。

⚠️ 而且 `not subscribed to required model plan` 归「与凭据无关」是**错的**：
本仓库自己的实测（`src/cline-rate-limit.ts` 注释、`providers-cline.md`）记它是
`ENTITLEMENT_ERROR` ——「有余额（500000）但**没有订阅计划**」，是**账号级**属性
⇒ 不同账号订阅状态可不同 ⇒ 正确处置是**换号**，而不是硬失败。
（撤回前命中该 marker 时 `getAvailableAccount` 调用 **0 次**。）

⚠️ 撤回还顺带消除两处**由它引入**的损害：非 JSON 403（CDN/网关 HTML 页）
含 marker 时会把**整页 HTML（含 `<script>`）**原样送进失败行；以及
「地域文案 + 额度文案」并存的报文被错分到权限分支而**失去换号机会**。

**结论**：将来若真在 codearts 上抓到地域封锁报文，**按实测再加**；
现在加是凭空的，且会长期维护一张无依据且与别家相反的表。

### ⚠️⚠️ **错误码取 `AUTH` 会连 message 一起吞掉**（Issue IKLBSH，第二次复发）

上面的 `failureMessage` 铁律在 opencode 上**又犯了一次**，且这次有**真实报文**：

| | 取值 | 用户看到 |
|---|---|---|
| 修前 | `'AUTH'` | 「**API 密钥无效**」+ **报文与指路文案全丢** |
| 修后 | `'PERMISSION_DENIED'` | 完整文案（「根因是 session id **形状**、换 key 或换出口都无效」）|

**取证**（`scripts/scan-error-corpus.mjs` 扫 868 个真实会话的真实失败面）：
两条 `turn/end` 失败事件的 `code` 就是 `AUTH`，message 逐字是
```
opencode: HTTP 403 — {"type":"error","error":{"type":"FreeTierError",
            "message":"Error from provider (Console): OpenCode's free tier
            can only be used from within OpenCode"}}
```
（会话 `session-d7c80d34`，2026-10-02）⇒ 该缺陷**在真实流量上发生过**。

⚠️ **这不是孤例，是复发形态**：`buddy` 的 `11140`（2026-09-27）从 `AUTH`
改成 `PERMISSION_DENIED` 时，`buddy-adapter.ts` 的注释里就已逐字记下同一条
`failureMessage` 判据。**下次接新 provider 时，凡「文案本身就是出路」的错误
（形状门禁 / 账号级拦截 / 需要用户做非登录动作的），码一律避开
`AUTH` / `QUOTA` / `ACCOUNT_QUOTA` 三个。** 判据可复用
`dead-model-store` 的 `IGNORED_CODES`（`AUTH` / `QUOTA_EXCEEDED` / `RATE_LIMIT` /
`MISSING_CREDENTIAL` / `PERMISSION_DENIED`）—— 它是「与模型是否存在无关」
的白名单，正好覆盖这类错误。

⚠️ **`PERMISSION_DENIED` 不在 `DEFAULT_RETRYABLE_CODES` 里**（该集合是
`EMPTY_RESPONSE / RATE_LIMIT / SERVER / TIMEOUT / TRANSPORT`）⇒ 改成它
**不会**引入「白退避 5 次」的回退 —— 这是选它而不选 `SERVER` 的理由。

⚠️ **本条追认 A4（「非凭据 401/403 一律判 AUTH」）**：它与 `codearts` 的**地域
marker 表**是两件事 ——

| A4 的两半 | 取证结论 |
|---|---|
| 「非凭据 401/403 → `AUTH` → 客户端吞文案」的**机制** | ✅ **真实存在**，有真实报文（上表；opencode 已修）|
| issue 建议的 `isNonCredentialDenial` + 地域 marker 表 | ❌ **无实测支撑**，见上一节，**维持撤回** |

⚠️ **`buddy-adapter.ts` 的通用 403 出口仍会产出 `AUTH`**（`httpErrorCode` 的
`401 || 403 → AUTH`）。该出口在**换号耗尽**且最后一次不是 11140 形态时可达
⇒ 同样吞文案。**但我没有真实报文**（真实失败面里 `buddy`/`workbuddy` 的 403
**全部**是 11140 形态）⇒ **只登记、不据推断改**（`AGENTS.md` 的既有纪律：
没有实测报文就不改分类）。

### ⚠️ **`errorDetail` 要认 `detail` 字段**（Issue IKLBSH A1）

上游代理（如包装成 `acp-proxy failure` 的那类）把异常包成
`{"error":"<摘要>","detail":"<真实原因>"}`：只读 `error` 会只剩**没有信息量的
摘要**，真正的原因（连接超时 / 鉴权细节）全在 `detail` 里。

⚠️ **本仓库有 6 份同义的 `errorDetail`**（`openai-compat` / `llm-adapter` /
`buddy-adapter` / `lobsterai-adapter` / `trae-adapter` / `accio-adapter`）。
6 份各写一条判据必然漂移，故该腿**只留一份实现**
（`openai-compat.ts` 的 `detailFieldText`），其余 5 份 import 它。

⚠️ **证据强度如实标注（两轮审计独立复核后修订）**：868 会话 / 190 条真实失败面
里 `"detail"` **零命中**；全文命中逐条查证**全部**是 JSON Schema 的
`description` 字段与源码讨论窗口。⇒ 定性是「**结构上可达、零实测**」，
**不是**「真实存在」。我原本的旁证「harness 的 `providerErrorDetail` 也产出该
字段」**被审计证伪** —— 它只在 `DeepSeekFilesError` 那条路上产出，与 HTTP 错误体
不是同一数据面。**别把它写成「已实测」**。

#### ⚠️⚠️ 展示出口与分类出口**必须分开**（真实净回归，两轮审计独立确证）

「无条件加一条 detail 腿」会把**纯展示改进变成行为变更**：
`httpErrorCode(status, body)` 拿 `errorDetail(body)` 的**产物**去跑
`isQuotaExceededError` / `isContextWindowExceededError` 正则 ⇒

| 报文 | 只算既有腿 | 加上 detail 腿 |
|---|---|---|
| `{"message":"bad request","detail":"out of credits"}` | `INVALID_REQUEST` | **`QUOTA_EXCEEDED`** |
| `{"message":"bad request","detail":"prompt is too long for this model"}` | `INVALID_REQUEST` | **`CONTEXT_WINDOW_EXCEEDED`** |

后者还会**触发 DSH 的上下文溢出压缩**、改变重试与换号行为。

⇒ 修法：**两条出口** —— `errorDetail`（**展示**，含 detail）／
`errorDetailForClassify`（**分类**，不含），两者**共用** `errorDetailImpl`
（不各写一份，那是首条红线）。分类调用点**只有 `llm-adapter.ts` 的两处**：
`httpErrorCode` 与 4xx 额度判据。

⚠️ **该回归原本零守卫**：我加的 3 条 A1 用例只断言 `errorDetail` 的**返回值**，
没有一条锁**分类结果** ⇒ 把分类输入换回含 detail 的产物时全量测试**一条都不红**
（两轮审计各自实测确认）。⇒ 已补 2 条**行为级**分类守卫 + 1 条结构性扫描
（`tests/unit/error-detail-wiring.spec.ts`）。

⚠️ **第二处分类点比第一处更隐蔽**：`isSseQuotaExhaustedErrorCode(code, message)`
的**第二参是原始 body**（既有行为），故文案腿「insufficient quota」**本就**
看得到 detail ⇒ 用「额度措辞」的报文测它**测不出差别**。真正会被翻转的是
**码值腿**（`4291`）：detail 里出现 `InferHub.4291.200` 时才翻转。
（我第一版守卫在这里也漏了 —— 变异实测：换回展示出口后那条行为用例**仍绿**。）

⚠️⚠️ **「接线了 6 处」≠「6 处都有守卫」**（对抗审计实测）：把 `detailFieldText`
改成恒 `undefined` ⇒ 只红 3 条且**全在 `llm-adapter.spec.ts`**；`openai-compat`
自己那份**零行为级守卫**（变异实测 0 条红）。⇒ 已补结构性扫描覆盖全部 6 处。

⚠️ **为什么守卫用「计数 + 扫描」而非逐文件断言**：新增第 7 份 `errorDetail` 时
新文件不在清单里 ⇒ **静默漏掉**。扫描 + 计数才能同时抓住「漏接一处」与
「新增一份没接」。

## 模型黑名单（Jet Hub「显示列表」开关）

同一 `jet-hub` 命名空间的 `disabledModels` 字段保存「被关闭的模型」，形如 `{ buddy: { 'glm-5.2': true } }`。要点：

- **黑名单制**：只有键存在且为 `true` 才隐藏，未记录的模型默认打开（新模型上线自动可见）
- 过滤点在适配器的 `listModels`，每次调用实时读 `pool.disabledModelsFor(provider)`，改开关后无需重建适配器
- **只影响模型目录播报，不影响路由**：被关闭的模型仍可 `resolveModel` / 正常收发请求（DSH 约定：`listModels` 结果仅供参考）
- `AccountPool` 的 `writeAccounts` / `writeModels` 都是**整体 replace**，两者必须互相携带对方的字段，否则一次账号操作会把模型开关清空（反之亦然）
- `CodeArtsAdapter.listModels` 必须 `await this.ensureRemoteModels()`：早期用 `void` 丢弃 Promise，冷缓存时会误用静态兜底表
- RPC：`model.list` / `model.setDisabled`（`src/jet-hub-rpc.ts`），前端在 `plugin-src/client/jet-hub.js` 的 `ModelListPanel`

### ⚠️ 改完开关必须广播 `llm/adapters-updated`，否则界面要重启才更新

**真实缺陷**（用户报障）：在 Jet Hub 关掉 LobsterAI 的若干模型后，**模型选择器里
仍然看得到它们**；**重启 DSH 后**才正确消失。落盘侧一切正常
（`state.json` 的 `disabledModels.lobsterai` 有 28 条），适配器侧也正常
（`listModels` 每次实时读 `disabledModelsFor()`）。

**根因在客户端缓存，不在本插件的适配器**：`dsh-client-ui-model-selection` 的
`ModelCatalogDirectory` 把 `modelCatalog` 响应存进一个
**`status === 'ready'` 即短路返回缓存**的 store（`lib/client.js` 的 `load()`：
`if (state.status === 'ready' && state.value !== null) return Promise.resolve(state.value)`）。
它只在三个**转发的宿主事件**上 `refresh()`：

```js
ctx.remote.$on('llm/adapters-updated',        () => this.catalog.refresh())
ctx.remote.$on('settings/document-updated',   () => this.catalog.refresh())
ctx.remote.$on('credentials/reference-updated', () => this.catalog.refresh())
```

⚠️ **0.1.7 起黑名单不再走 settings 文档**（改落插件自有文档
`$DSH_HOME/jet-hub/state.json`，见上「持久化」章节），因此写开关**不触发上述
任何一个事件** → 客户端长期复用旧目录，**直到重启**（`connection/reset` →
`resetGeneration()`）才重拉。这正是「不重启不生效、重启就好」的成因。

**修法**：`model.setDisabled` 写完黑名单后显式广播一次
`ctx.emit('llm/adapters-updated')`（`src/jet-hub-rpc.ts`）。选它的理由：

- 按契约它是**无载荷**的「目录可能变了，请重新读 `listModels`」通知
  （dsh-llm README：*consumers re-read the registries*），语义完全吻合；
- 它在 `API_REMOTE_FORWARDED_EVENTS` 白名单里（`dsh-api-remotes`），故会真的送达浏览器；
- **不改变拓扑**，故 dsh-llm 的 invariant 监听（对每个 provider 读一次
  `retryPolicy`）必然通过，不会误报 `INVARIANT`。

⚠️ **广播必须包 try/catch**：通知失败不能反噬**已经落盘**的开关 —— 否则用户看到
「切换失败」而实际已生效，再点一次又因幂等而看似「无效」，比不提示更难排查。

⚠️ **`ctx.emit(name)` 不传 `thisArg`**，故 cordis 的 `dispatch` 里 `filter` 为
`undefined`，所有监听器（含 api-remotes 的转发监听）都会命中 —— 这是该修法成立的
前提（`EventsService.dispatch`：`hook.global || !filter || filter.call(...)`）。

⚠️ **新增任何「只写插件自有文档、却影响模型目录」的端点时，都要照此广播**。
判据是「这次写入会不会改变 `listModels` 的结果」，而不是「是否写了 settings」。

回归用例：`tests/unit/jet-hub-rpc.spec.ts` 的三条 —— 关闭/打开都广播、校验失败
不广播、广播抛错仍算成功（替身必须真的实现 `ctx.emit`，否则生产代码的广播会以
`ctx.emit is not a function` 被 try/catch 静默吞掉，用例形同虚设）。

### ⚠️⚠️ 远端目录**落地时**也必须广播 —— 十个适配器原先 0 处广播（Issue IKJVTF）

**真实缺陷**（用户报障，2026-10-07）：Jet Hub 模型设置页显示 **5 个**模型
（含 2 个 `cline-pass/*`），**对话框模型选择器只剩 2 个**（两个 `cline-free/*`）
—— 重启 DSH 后「模型消失」。

**根因是两个独立缺陷**（master 上复核仍存在，见该 issue 的评论）：

**① 远端目录落地后从不广播。** 两条链路读的**不是同一份数据**：

| 入口 | 取数 |
|---|---|
| 设置页 | 插件 RPC `model.list` → 适配器 `listAllModels()`（**每次实时**） |
| 对话框 | DSH `buildModelCatalog` → `ctx.llm.listModels()` → `remoteModels ?? fallbackCatalog()` |

客户端在 `status === 'ready'` 时短路返回缓存，只在四个宿主事件上 `refresh()`。
**首拉失败**（凭据解析不出 / 目录端点那次请求超时）→ 客户端把**兜底表**缓存成
ready；此后远端目录真的落地也**没有任何事件**通知它重读 ⇒ 永久分叉。
修复前十个适配器的 `ensureRemoteModels` 全是 **0 处广播**。

⚠️ **窗口的准确边界**（对抗审计复核后订正）：四个事件里的
`credentials/record-updated` / `credentials/reference-updated` **只由凭据
「写入 / 重载」触发**（`dsh-credentials/lib/index.js` 的 `notifyRecordUpdated`
仅被 `set` / `delete` / `reload` 三处调用）。**冷启动时凭据早已在磁盘上、
没有写入动作** ⇒ 它们**不会**触发。所以「凭据未就绪」那半**也**在这个窗口内，
不是只覆盖「凭据稍后就绪」。⇒ 本修复是必需的，不是锦上添花。

⚠️ **但有一个它解决不了的边界**：客户端在 `ModelDirectory` **构造时**就
`catalog.load()`，而广播是 `queueMicrotask` 派发的 ⇒ **冷启动首次打开对话框
仍会先看到兜底表**，要等目录落地 + 广播之后（最长约 35s，即首个预热轮）
才自愈。别向用户承诺「重启后立刻就对」。

**② 残缺目录被永久缓存。** `hasClineRemoteModels` 只要**任一来源非空**就判
「已拿到」。实测 `recommended-models` 成功、`/api/v1/models` 失败时
（宿主日志 `[cline] 模型目录来源失败：models fetch failed`），这份残缺目录被
`if (this.remoteModels !== undefined) return` **永久短路** ⇒ 只有 `/api/v1/models`
才有的 466 条按量计费模型（含 `apodex/apodex-1.1-mini:free`）**再也拉不回来**，
连预热重试都在短路处直接返回。

⚠️⚠️ **这条有个极隐蔽的第二层**（对抗审计实测证伪，初版修复**完全没修好**）：
`RemoteCatalogGate` 的冷却（`retryAt` / `cooling()`）在生产里**只有闸门自己
那一处调用点**，而它排在适配器的短路**之后**。所以只把「`complete` 传对」
是**没用的** —— 残缺目录**也**赋值了 `remoteModels`，短路照样命中，
`cooling()` 永远读不到。**短路判据本身必须从「已定义」改成「已完整」**：

```ts
// ❌ 初版（= 没修）：残缺目录也赋值了 remoteModels ⇒ 永久短路
if (this.remoteModels !== undefined) return
// ✅ 现在：残缺时放行到闸门，由 30s 冷却控制重试节奏
if (this.remoteComplete) return
```

⚠️ **反向验证**：把这一行改回 `remoteModels !== undefined` ⇒ **3 条**行为用例
变红；把 `remoteComplete` 恒置 `true` ⇒ **3 条**变红。
初版用例只断言 `gate.cooling() === true` 是**假绿**（守着生产读不到的字段）——
现改为断言「清掉冷却后**真的重拉**并把 `apodex/*` 补回来」。

⚠️ **`complete` 判据不能用 `warnings.length === 0` 反推**（第三条入口）：
「**主动跳过**一个来源」与「**取到了**一个来源」在 warnings 上不可区分。两条实测：
- **无凭据**时 `/api/v1/models` **不发请求**（`fetchClineRemoteModels` 直接
  `return []`）⇒ 若不计 warning 就被判成完整。该路径**真实可达**：
  `providerCatalogVisible` 只查「有没有已登录账号」、**不过滤 `enabled`**，
  而 `getAvailableAccount` 过滤 ⇒「有账号但全部停用」时门控通过、凭据却 undefined。
- **HTTP 200 + 形状异常**（网关降级返回 `{}` / HTML）：解析器静默返回空表、
  零 warning ⇒ 判成完整并永久缓存。

⇒ 现在由 `fetchClineRemoteModels` **显式**给出 `complete`（两个来源各自的
「请求成功 + 形状可识别」），跳过与形状异常**都记 warning**。

**修法（四条一起，缺任何一条都还会看到症状）**：

1. **`src/catalog-broadcast.ts` 是「模型目录变更」这类广播的唯一实现**。
   `jet-hub-rpc.ts` 原先自带的那份 `try { ctx.emit(...) } catch` 已改为同名导入
   —— 两份实现必然漂移（本 issue 的缺陷① 就是「十处全漏」）。它同时做
   **同 tick 按 ctx 合并**（`WeakSet` + `queueMicrotask`），因为一次目录落地
   会牵动多个 provider。
   ⚠️ 仍有**两处内联 `ctx.emit('llm/adapters-updated')` 未收口**（审计指出，
   有意留待后续）：`index.ts` 的 opencode 能力预热、`jet-hub-rpc.ts` 的永久积分
   锁定端点。后者用 `ctx.logger.warn`（**无两级可选链**，logger 缺席时会抛、
   仅被 catch 吞），与 `catalog-broadcast.ts` 的 `ctx.logger?.warn?.` 不一致。
   ⚠️ **合并标记必须在 `emit` 之后清**：`llm/adapters-updated` 的监听器会再次走
   `buildModelCatalog` → `listModels` → 可能又触发目录落地；标记若提前清，
   每次派发都翻一倍 ⇒ **广播风暴**。
2. **通知放在 `RemoteCatalogGate`**（十个适配器的**单点收口**）的成功分支，
   且必须在 `await task` **之后** —— 那时适配器才刚把目录赋给 `remoteModels`，
   客户端重读才拿得到新数据（早于它广播等于白广播）。
   适配器拿不到 `ctx`，故由各 `registerXxxLlm` 注入
   `onCatalogLoaded: () => broadcastCatalogChanged(ctx)`。
3. **`run` 返回值扩展为 `{ got, complete }`** —— 两个判据**不能合并**：

   | 字段 | 语义 | 决定 |
   |---|---|---|
   | `got` | 拿到**非空**目录（**残缺也算**） | **显示** + **广播** |
   | `complete` | **所有来源**都拿全了 | **永久缓存** + **清冷却** |

   只看「非空」⇒ 残缺目录被永久缓存（缺陷②）；只看「完整」⇒ 残缺时整个目录
   都不展示，用户的模型列表凭空消失。**向后兼容**：返回裸布尔时
   `complete = got`，既有八个单来源适配器的返回值**一行都不用改**。
   ⚠️ 别把这两处「为统一」改成同一个变量 —— 反向验证各自独立锁死。
   ⚠️⚠️ **光传对 `complete` 是不够的** —— 短路判据必须同步改成
   `if (this.remoteComplete) return`，否则冷却永远读不到（见缺陷② 的第二层）。
4. **`complete` 由数据源显式给出，不由 `warnings` 反推**：`ClineRemoteModels.complete`
   来自两个来源各自的「请求成功 + 形状可识别」；跳过（无凭据）与形状异常
   （HTTP 200 + `{}` / HTML）**都记 warning**。

**冷启动自愈**：`src/catalog-prewarm.ts` 做**有界**预热（立即起、此后每 35s 一轮，
共三轮）。⚠️ **间隔必须大于闸门的 30s 失败冷却**，否则重试被**原样挡回**、
什么也不做（症状是「静默无效」，没有报错，只是目录一直补不回来）。

⚠️⚠️ **光有「间隔 > 冷却」还不够**（对抗审计实测证伪，初版按绝对时刻一次性排程）：
闸门的 `retryAt` 是「**失败那一刻** + 30s」，而固定排程是「**启动那一刻** + 35s / 75s」——
首拉耗时 `d ∈ (5s, 35s]` 时 35s 轮被挡回，`d ∈ (45s, 75s]` 时 75s 轮也被挡回
（`d=60s` 实测 `retryAt=90s`，75s 轮时仍在冷却；cline 超时 20s、buddy/loomy/raccoon 60s
都落在这两个区间）。⇒ 改为**链式**：`上一轮结束 + 间隔` 才排下一轮。
⚠️ 反向验证：改回「一次性按绝对时刻排」⇒ **2 条**变红。

该约束由 `tests/unit/catalog-prewarm.spec.ts` 的用例守着（`isPrewarmSpacingValid()`
**目前只有单测调用**，接线层没断言 —— 别把它当成运行期闸门）。
预热走 `ctx.llm.listModels`（对 `withDeadModelPruning` 包装透明；`aggregate`
走它自己的 60s 目录 TTL 缓存，边际成本≈0），停止函数挂 `ctx.effect`；
`setTimeout` 必须 `unref`（否则命令行 `dsh` 会被它挂住不退）。
各 provider 的账号门控都在远端拉取**之前**，故未登录的 provider 是零请求。

**测试**：`tests/unit/catalog-broadcast.spec.ts`（18 条：异步派发、同 tick 合并、
**emit 期间的重入不形成风暴**、不同 ctx 独立、logger 缺席不抛错、`got`/`complete`
逐格判据、残缺后冷却到期可重试、冷却中跳过不广播、`onLoaded` 抛错不反噬）+
`tests/unit/catalog-prewarm.spec.ts`（23 条：立即轮不阻塞、逐 provider 预热、
单点失败不影响其余、停止即停手、**链式排程**、间隔 > 冷却）+
`tests/unit/cline-adapter.spec.ts` 的「残缺目录自愈」**真接线**用例
（不注入 `loadModels`，走真实 `loadClineModels` + 真实 `fetchImpl`
—— 注入式加载器可以省略 `remote`，从而掩盖完整性判据）。

⚠️ **这些用例必须是行为断言，不能只断言 `cooling()`**：初版那条
「残缺后仍会重试」断言的是 `gate.cooling() === true`，而该字段在生产路径上
**读不到**（见缺陷② 第二层）⇒ **假绿**（把 `complete` 改成恒 `true`，它照样通过）。
现在断言的是「清掉冷却后**真的重拉**、`apodex/*` 被补回来、之后转为完整不再重拉」。

⚠️ **接线类的 `expect(source).toMatch(...)` 是源码文本断言，挡不住真实回退**
（审计实测：把 buddy 的 `onCatalogLoaded` 注入整行注释掉 ⇒ 171 条全绿 0 红）。
故另补了一条**真装配**行为用例（`registerBuddyLlm(ctx, …)` + `ctx.emit` 替身
+ 真实 `listModels`，断言目录落地后真的 emit 一次）—— 该变异现在会让**1 条变红**。

⚠️ **已做反向验证**（每条独立，别当同义反复删掉）：

| 变异 | 变红 |
|---|---|
| 短路改回 `remoteModels !== undefined` | **3 条** |
| `remoteComplete` 恒置 `true` | **3 条** |
| `fetchClineRemoteModels` 的 `complete` 恒 `true` | **3 条** |
| 真正原形态（`warnings` 反推 + 删掉两条新 warning） | **2 条** |
| 预热改回「一次性按绝对时刻排」 | **2 条** |
| 闸门不广播 | **5 条** |
| 冷却按 `got` 而非 `complete` | **3 条** |
| 广播改同步 emit + 标记提前清 | **3 条** |

**顺带清掉的死代码**：`cline-adapter.ts` 曾有两行重复的 `return true`
（`git log -L` 显示由合并提交 `4ce4a6e` 引入，`0ca8256` 在其后加了
`if (!gotRemote) return false` 使其成为不可达代码）。

### ⚠️⚠️ buddy / codearts 的**多端点残缺**：同一形态的第三个入口（审计 I3）

⚠️ 这一条是**同一缺陷在另两个 provider 上的复发**，且它们都是插件**主力**
provider —— 只修 Cline 是不够的。两家的目录都来自**两个**独立端点，
而「一个成功、另一个失败」是**常态**而非异常：

| provider | 两个端点 | 只在一个端点里出现的东西 |
|---|---|---|
| **buddy / workbuddy** | `/console/enterprises/{scope}/models` + `/v3/config` | `hy4-preview-f`（**限时免费**变体，促销 `modelIds` 只写着它） |
| **codearts** | `opengw gateway/config` + `snap-access /v1/model/builtin` | benefit 模型（`glm-5.3-flash` 等）与常规模型各占一半 |

⚠️ 两处的失败路径都**静默**：`fetchSignedGet` 返回 `undefined`、
`requestConfig` 返回空快照。于是单端点成功时 `models.length > 0`，
而旧短路判据是 `remoteModels !== undefined` ⇒ **残缺目录永久固化**
（冷却读不到，与 Cline 的缺陷② 逐格同构）。
buddy 那格的用户可见症状正是 issue 里报过的原话
**「hy4 preview 现在 ide 是免费我们还是 0.29」** —— 促销倍率只由
`/v3/config` 下发，而它是失败的那一个。

**修法（与 Cline 同一套语义，但数据源层要各自上报）**：

- 数据源加**出参**（不改返回值形状，既有调用方与 10+ 条单测零改动）：
  `fetchCodeArtsRemoteModels(cred, fetch, outcome?)` 上报
  `{ gatewayOk, builtinOk }`；`buddy-oauth.fetchModels(cred, fetch, signal, product, outcome?)`
  上报 `{ scopedOk, configOk }`。
  ⚠️ **成功判据是「请求成功 + 形状可识别」，不是「解析出非空列表」**：
  上游把某个来源的模型**全部下架**时，`result.models: []` 是**合法**状态，
  把它当失败会让冷却永不清理。buddy 侧的 `requestConfig` 因此新增 `ok` 字段
  —— **不能**靠「`promotions` 是否为空」反推（上游真的没有促销时它也是空的）。
- 服务层用 `lastCatalogOutcome` 出参对象原地写入（`CodeArtsAuth` /
  `BuddyAuth` 各一份，由 `index.ts` 构造时注入初值两个 `false`）。
- 适配器短路判据改成 `if (this.remoteComplete) return`，完整性由接线层桥接的
  `catalogComplete: () => …` 回调给出（与 `onCatalogLoaded` 同一模式）。
  ⚠️ **回调缺席时退回「完整」**（`?? true`）—— 那是既有单测替身的形态，
  把「判不出」当残缺会让 provider 反复重拉、架空冷却。

⚠️ **反向验证**（逐条独立，别当同义反复删掉）：

| 变异 | 变红 |
|---|---|
| codearts 短路改回 `remoteModels !== undefined` | **1 条** |
| buddy 短路改回 `remoteModels !== undefined` | **1 条** |
| codearts `remoteComplete` 恒 `true` | **1 条** |
| buddy `remoteComplete` 恒 `true` | **1 条** |
| codearts 形状判据放宽（形状不可识别也算取到） | **1 条** |
| buddy `configOk` 恒 `true` | **2 条** |
| codearts 无凭据早退时默认成 `true` | **1 条** |

⚠️ 最后两条是**补漏**：初版用例只覆盖了适配器层，把数据源的
`configOk` 恒置 `true` 时**全绿 0 红**（198 条）。补上
`tests/unit/buddy-oauth.spec.ts` 的「各来源成败」7 条后才有 2 条变红。

**测试**：`tests/unit/models.spec.ts`（新增 8 条：两来源各自的成败格、
形状可识别但合法为空、形状不可识别、无 AK/SK 早退、不传 outcome 的兼容性）+
`tests/unit/buddy-oauth.spec.ts`（新增 7 条，同构）+
`tests/unit/llm-adapter.spec.ts` / `buddy-adapter.spec.ts` 各 3 条
**行为**用例（残缺 → 展示但不永久缓存 → 清冷却后**真的重拉补齐** → 转为完整
不再重拉；完整 → 清冷却；未注入回调 → 退回旧行为）。

⚠️ buddy 那条的观测点必须选**只由远端下发**的字段（`creditsRate`）：
`reconcileWithFallback` 是**白名单重建**，兜底表里的 id 残缺时**仍在**列表里，
故「id 是否出现」判不出补齐；而 `hy4-preview-f` **不在**兜底表里，
要靠 `agentReferenced: true` 这条例外才保留（真实形态：服务端声明可选）。

### 其余六个 provider：确认**无需**处理

lobsterai / loomy / minimax / raccoon / trae / zcode 都是**单来源**目录
（`models.length === 0 → return false`），**没有「部分成功」形态**
⇒ `complete` 恒等于 `got`，短路判据无需改动。
⚠️ buddy 的 `reconcileWithFallback` 是**白名单重建**（本地合成），不是残缺 ——
但它上游的 `fetchModels` **是**多端点，见上一节。

**仍未处理**（与本 PR 正交，建议单独立项）：
- issue 末尾那条「Node 原生 `fetch` 不读系统代理、目前只有 opencode 通道支持
  per-account 代理」与本 PR 的两个根因**正交**，但它会**加剧**缺陷①
  （代理不可达 ⇒ 首拉必失败），建议单独立项。

### ⚠️ 设置页目录必须走 `listAllModels`，不能复用 `listModels`

**真实缺陷**（用户报障「打开的显示了倍率，关闭的就没有显示倍率」）：

`listModels` 会**按黑名单过滤**，于是被关闭的模型**不在其返回值里**。设置页必须
把它们渲染出来（否则用户无法重新打开），端点只能凭 `disabledMap` 的 key（裸 id）
补回 —— 那条路径拿不到展示名，只能退化成裸 id，**倍率与模型名随之丢失**。

故每个适配器都额外提供 **`listAllModels()`**：返回**不套黑名单**的完整目录，
且带**最终展示名**（含倍率、同名消歧）。`model.list` 优先用它，再自行回填
`disabled`；`listAllModels` 缺失时才退化为「listModels + 裸 id 补回」的历史行为。

⚠️ **`ctx.llm` 不透传自定义方法**（DSH 只保证 `listModels`），所以适配器实例必须
由 `index.ts` 显式收集成 `modelAdapters` 传给 `registerJetHubRpc`。五个
`register*Llm` 因此都**返回适配器实例**（而非 `void`）。加新 provider 时别忘两处：
`listAllModels()` + 在 `index.ts` 的 `modelAdapters` 里登记。

⚠️ **同名消歧必须基于未过滤的全量集合**（`displayNameFor(model, source)` 而非
`listed`）：用过滤后的集合会让「关掉其中一个同名模型」改变另一个的变体标记，
名字随开关跳变。

### ⚠️⚠️ 判「某个 id 在不在目录里」时，**两个目录来源都必须取并集**（Issue IKJW33）

**真实缺陷**（Gitee issue IKJW33，用户报障 2026-10-08）：对**已从远端目录消失**的
模型 id 调 `on`/`off`，命令返回「✅ 成功 1」但**实际什么都没发生、且零警告**。
用户实测两例：`cline/cline-free/deepseek-v4.1-flash` 与
`cline/stealth/space-bunny-alpha` 在记录「上游 model not found」后从 cline 目录
消失（490 → 489）。后果：① 脚本/AI 助手据「成功 1」误判开关已生效（**作者本人
就据此误判过一次**）；② 黑名单里残留幽灵条目，GUI 看不见、关闭记录却还挂着。

修法是照常写入 + 响应里补 `warnings[]`（**不改成 `ok:false`+`not-found`**：
打开方向是幽灵条目的**唯一**清理路径，且目录可能读不出来）。但**判据本身**踩了
两个方向相反的坑，**每个方向都被实测证伪过一次** —— 这是本节最该记住的：

| 只用 | 症状 | 实测证据 |
|---|---|---|
| `listAllModels()` | **误报**：冷缓存下它返回**编译期兜底表**（`model-catalog.ts` 的 `cached ?? config.syncCatalog()`），而兜底表是**子集** | 探针实测 cline 冷缓存只有 **3** 条，远端有 **460** 条 ⇒ 远端任意正常模型都被判「不在目录」。而 issue 的复现路径**恰恰是冷缓存**（脚本直接调 `on`，从未先跑 `list`） |
| `listModels()` | **反向误报**：`opencode` 的 `listAllModels()` **恒返回**编译期兜底表（永不读远端），而 `listModels()` 在**只有匿名槽**时还会 `filter(isFree)` | 审计端到端实测：无付费账号时关闭 13 个**设置页可见**的模型，**13/13 全部收到假警告**（「该模型可能已被上游下架」，而它并没下架，只是当前身份看不到） |

⇒ **取并集**：`llm.listModels()` ∪ `modelAdapters[provider].listAllModels()` ∪
黑名单里 `true` 的 id。方向刻意是「**宁漏勿误**」：`known` 越大 ⇒ 误报越少。
提示类信息的**误报比漏报糟得多**（用户会对整类提示脱敏），故宁可漏报。

四条**不能省**的实现约束：

1. ⚠️ **`listModels()` 读失败（超时/抛错/空目录）必须整体放弃核对**，**不得**
   退化成「只用 `listAllModels()` 兜底表」—— 那会退回上表第一行的误报形态。
   代价是「首次拉取就失败」时**漏报**（issue 的原始场景最可能命中），
   **这是刻意的取舍，别当漏写删掉**。空目录另有一层理由：
   `createModelCatalog` 在「无已登录账号」时返回 `[]`（门控隐藏整个 provider），
   空目录意味着「看不到」而非「全部下架」。
2. ⚠️ **黑名单必须在 `await` 之后读**（放在核对函数内部，不由调用方传快照）：
   提前取快照会让「快照」与「实际写入」之间隔着一次 `listModels`（最长 2 秒），
   期间另一路 RPC 的写入使快照失真 ⇒ 实测「**实际产生了变更却报『本次没有产生
   任何变更』**」（与 issue 要消除的误导同型）。放在 await 之后，从读黑名单到
   写入全是**同步代码、无 await** ⇒ 窗口归零。
3. ⚠️ **必须带超时**（`CATALOG_READ_TIMEOUT_MS = 2000`）：`listModels()` 冷缓存下
   会真的发远端拉取 ⇒ 「写开关」这个原本纯本地的操作多了一条网络依赖。
   开关**绝不能**被远端拖住。GUI 路径缓存通常已热（先看到列表才会去点开关），
   是纯内存读；只有脚本冷启动直调开关才可能等一次拉取。
4. ⚠️ **`listAllModels()` 抛错要吞掉**（单独 try/catch）：开关是主操作，
   核对只是提示层，失败只少一半来源、不能让开关失败。

⚠️ **「有效清理」静默这条语义只由一处承担**（并回黑名单里的 id）——
`catalogWarnings` **不再判一次 `before[id]`**：那会是**同义的两套判据**
（本仓库踩过「一文件两套同义判据必然先腐坏一套」），且内层在生产路径上**不可达**
（实测：把 `before` 换成「操作后」快照，**没有任何用例变红**）。

⚠️ **`dead` 表里的 id 算「不在目录」，但文案必须可操作**：失效模型被
`withDeadModelPruning` 从**两个来源**同时剔除，而 `model.list` 又把它们补回
设置页（`dead:true`）供用户点「重新显示」⇒ 它们天然落在「目录外」。
issue 的两例正是这个形态 —— 只说「不在目录」不够，必须给出
「可在模型列表里点『重新显示』恢复」这条指引。

⚠️⚠️ **本节的测试曾整片恒真，是本 issue 最隐蔽的一处缺陷**（审计内存变异实测）：
`model-groups.spec.ts` 里对客户端渲染的断言写成独立的
`toMatch(/'data-tone': 'warn'/)` + `toMatch(/role: 'status'/)`，而这两个字面量在
**全文件**分别出现 **5 次**与 **2 次**（别的面板也有）⇒ 断言被别处满足。
实测四个变异**全部仍绿**：删掉整个渲染块 / 改成 `'warning'`+`role:'alert'`
（**正是注释自称防住的那个坑**）/ 删掉 `data-tone` / GUI 完全不展示。
⇒ 源码级断言必须**锚定到片段**再断言相邻关系：

```js
const start = client.indexOf('toggleWarnings.length > 0')
const block = client.slice(start, client.indexOf(': null,', start))
expect(block).toMatch(/'data-tone': 'warn',\s*\r?\n\s*role: 'status'/)
```

⚠️ 同理，「两个入口都接了」这类**并列断言**要用**计数**（`match(...).length === 2`），
`toMatch` 只要求任意一处命中 ⇒ 只接一个入口时照样绿（审计变异 E2 实测）。

回归用例：`tests/unit/jet-hub-rpc.spec.ts` 的「目录外 id 的开关必须给出 warnings
（Issue IKJW33）」段 + `tests/unit/model-groups.spec.ts` 的三条渲染/接线断言。
⚠️ **条数以 `pnpm test` 输出为准**（本节刻意不写数字：接一个 provider 就会失效）。
⚠️ 已做**反向验证**（10+ 条变异各自独立锁死）：去掉并集、失败时退化用兜底表、
不吞 `listAllModels` 异常、黑名单改在 await 之前读、去掉超时、去掉 dead 指引、
两个方向文案对调、客户端不渲染/不消费、`tone` 写错 —— **每条都有对应用例变红**。

## 目录门控：没有已登录账号就隐藏整个 provider

**需求**：「如果某供应商没有已登录的账号，就不显示该供应商的所有模型，这样对
大多数用户来说模型选择选项卡臃肿的问题能改善很多。」

### 机制：DSH 原生支持「空目录即隐藏」，无需前端改动

`dsh-api-session-controller` 的 `buildModelCatalog` 显式做了

```js
groups: catalog.flatMap(...).filter(group => group.models.length > 0)
```

（注释：*"successful non-empty provider groups"*）。所以适配器 `listModels`
返回 `[]` 就能让整个 provider 分组从模型选择器消失。

两点**必须遵守**：

1. ⚠️ **返回空数组，绝不抛错** —— 抛错会被 `catch` 归入 `failures`，界面上
   反而多出一条 provider 报错，比「不显示」更糟；
2. ⚠️ **不影响路由** —— `routableProviders` 由 `listProviders()` 单独生成
   （不经该 filter），且 DSH 明确约定 *"Catalog membership is advisory and
   never changes routing"*。隐藏目录 ≠ 拒绝请求，已持久化的模型仍可
   `resolveModel` / 正常收发（与黑名单同一契约）。

### 判据：凭据能否解析（**不是**「有没有账号条目」）

`AccountPool.hasLoggedInAccount(provider)`，由
`providerCatalogVisible()`（同文件）包装。两条语义都容易被改错：

| 语义 | 原因 |
|---|---|
| 判据是**凭据可解析** | 服务层的 `logout()` **只 unset 凭据、保留账号条目**（删条目是另一条路径 `removeAccount`）。若只看「有条目」，用户登出后模型仍然显示，门控形同虚设 |
| **不看 `enabled`** | 停用只影响「自动选号」，与「是否已登录」无关。若过滤 `enabled`，把所有账号停用的用户会发现整个 provider 的模型凭空消失。与「续期只看 `refreshable`、不看 `enabled`」是同一条既有约定 |

⚠️ **十个 provider 判据完全一致，没有例外**：早期 CodeArts 曾额外接受固定单凭据
ref（`CODEARTS_ACCESS_TOKEN`），该模式**已移除**，`extraCredentialRefs` 参数一并
删除。老用户若只用固定 ref 登录过，模型列表会变空 —— 需在 Jet Hub 重新登录一次
（用户已确认接受，不做自动迁移）。

### 保守放行的三种情形（门控是**展示优化**，不是安全边界）

1. `accountPool === undefined`（headless / CLI / 单测）；
2. 替身未实现 `hasLoggedInAccount`（**能力检测** —— 大量既有单测只 mock 了
   `disabledModelsFor`）；
3. 读凭据抛异常（存储损坏等）。

三种都返回「可见」：判定不可用时**宁多勿少**，否则会让用户看到「所有模型凭空
消失」且无从排查。

### 开关与落点

- `DSH_HIDE_MODELS_WITHOUT_ACCOUNT` —— **默认开启**，只有显式假值
  （`0`/`false`/`no`/`off`）才关闭。与 `DSH_TRAE_MAX_MODE` 同为「默认开」语义，
  故用**独立的** `resolveHideWithoutAccountFlag`，不要与 `isTruthyFlag`
  （「默认关」）混用。
- 门控放在各 `listModels` 的 **`ensureRemoteModels()` 之前**：无账号时连远端
  目录都不必拉（省一次无谓 HTTP）。
- ⚠️ **门控只加在 `listModels`，`listAllModels`（设置页）不受影响** ——
  否则用户关掉模型后连开关都看不到，更无法重新打开（这是此前修过的真实缺陷）。
- 六个适配器的 `listModels` 都要加（`llm-adapter` / `buddy` / `lobsterai` /
  `qoder` / `trae`）。`buddy` 与 `workbuddy` 共用同一个适配器类，但
  `this.product.id` 不同 → 两者按各自 provider 独立判定，互不影响。

## ⚠️ 模型行布局：长 id 会把开关挤出可视区（真实缺陷）

**用户报障**：「cline 功能是具备的，不过针对某一个模型的开关在最后，需要横向滑动，
我没有看到」。

### 根因：CSS 让行横向溢出，开关被推出弹窗

**不是功能缺失** —— 开关一直在渲染，只是**看不见**。三处收缩约束缺失叠加：

| 位置 | 错误写法 | 后果 |
|---|---|---|
| `.dim-jh-modelList` | 单列 grid 未写 `grid-template-columns` | 列宽默认 `auto`，按**最宽内容**撑开 |
| `.dim-jh-modelRow` | 无 `min-width: 0` | grid 项的 `min-width` 默认 `auto`，**拒绝收缩** |
| `.dim-jh-modelId` | `flex: none` | 保持内容宽度，**直接把开关顶出去** |

三者叠加 → 整行溢出弹窗 → 排在 id 之后的开关被推到可视区外。
Cline 有 **300 个 id 超过 20 字符**（最长 56），所以几乎每行都中招。

**这正是该 provider 在 `state.json` 的 `disabledModels` 里长期为空的原因** ——
不是用户不想关，是**根本看不到开关**。（与「缺搜索/筛选」是两个独立问题：
搜索解决"找不到某个模型"，本缺陷解决"连开关都看不见"。）

### 修法：三处收缩约束，缺一不可

```css
.dim-jh-modelList { display: grid; grid-template-columns: minmax(0, 1fr); gap: 2px; }
.dim-jh-modelRow { display: flex; align-items: center; gap: 12px; min-width: 0; ... }
.dim-jh-modelId { flex: 0 1 auto; min-width: 0; max-width: 46%; ... }
.dim-jh-modelName { flex: 0 1 auto; min-width: 0; ... }
/* 兜底：任何一行偶然溢出都不该让整个弹窗横向滚动 */
.dim-jh-modalBody { ...; overflow-x: hidden; }
```

⚠️ **开关自身必须保持 `flex: none`** —— 它是目标控件，绝不能参与收缩。

### 验证方式（可复用）

`verify-layout.mjs`（工作区根目录）：**从真实源码模块提取 STYLES** 渲染
`repro-real-source.html`，再用无头 Edge 截图 + 在页面内测量开关右边缘是否超出
body 可视区。用真实源码而非 CSS 副本，避免「复现页改好了、源码没改」的假阳性。

实测结果（8 行，含最长 id）：

```
弹窗内容宽 = 560px
列表横向溢出 = 否
body 横向滚动 = 否
开关被挤出可视区 = 0 / 8 行
```

修复前同法实测：**8 / 8 行的开关全部不可见**。

⚠️ **这类缺陷单测抓不到**（react 不在依赖内，无法渲染），故用
`tests/unit/model-filter.spec.ts` 的「模型行布局」段做**源码级**断言，
逐条锁住上面四处约束。反向验证：把 `flex: 0 1 auto` 改回 `flex: none`、
去掉 `minmax(0, 1fr)`、去掉 `overflow-x: hidden` —— 三次都各触发 1 条失败。

### ⚠️ 改 `jet-hub-styles.js` 时：注释里不能出现反引号

该文件整体是 **JS 模板字符串**（`const STYLES = \`...\``），注释里的反引号会
**提前终止字符串**、导致 esbuild 报 `Expected ";" but found "..."`。
本次就因此构建失败过一次 —— 说明 CSS 属性时一律不加反引号。

## 模型面板的搜索与筛选（**不含多选、不含渲染上限**）

**用户需求**：Cline 的远端目录实测约 **478 条**（`/api/v1/models` 458 条 +
`recommended-models` 的 free/recommended/clinePass 6/4/14 的并集），需要一个
搜索框与状态筛选来定位模型。**搜索与筛选确实有用，已保留。**

纯逻辑在 **`plugin-src/client/model-filter.js`**（`filterModels` / `isFilterActive` /
`matchesModelQuery` / `normalizeStatusFilter`），与 `model-bulk.js` /
`account-order.js` 同理单独成文件：本仓库单测环境里 react 不在依赖内，组件无法
渲染，抽成纯函数才能用真实断言覆盖。

### ⚠️ 四条不能改错的语义

1. **未知筛选值必须退化为「不筛」**（`normalizeStatusFilter`）。若实现成「非 all 即
   按 enabled 筛」，一次拼错的取值（`'Disabled'`）会让列表只剩已打开的模型，
   用户看到「模型少了一大半」而没有任何错误提示。`isFilterActive` 必须与它
   **保持一致**，否则会出现「判定说有筛选、实际一条都没筛」的错位。
2. **空搜索词命中全部**（那是"未搜索"，不是"搜索空串"）。
3. **`disabled` 判定用 `=== true`**：与适配器黑名单的「只有显式 true 才算关闭」
   同一语义。用 `!== false` 会把未声明该字段的条目误判为已关闭。
4. **筛选无结果必须与「该 Provider 没有模型」分开提示**。合并成一句会让用户以为
   模型全丢了，而实际只是搜索词没命中。

### ⚠️⚠️ 两个曾被错误引入、已回退的设计（**不要重新引入**）

#### 1. 多选勾选框 —— 破坏了既有点击交互

**背景（我的误判）**：我曾把「Cline 模型列表关不过来」归因为"缺搜索/筛选/多选"，
并据此给每行加了多选勾选框 + 「全选筛选结果 / 打开选中 / 关闭选中」+ 新端点
`model.setDisabledBulk`。**但用户明确指出问题 2 原本没有问题** —— 真正的缺陷是
**问题 1 的布局溢出**（见上一节），修好布局后开关本就可见可用。

**多选造成的真实行为倒退**（无头 Edge 实测确认）：

`ModelToggle` 的根元素是 **`<label>`**。原先 label 内只有 1 个 checkbox，
点行内任意位置（含模型名）都会激活它 —— 即「点模型名切换可见性」，这是既有交互。
一旦插入第二个 checkbox（多选勾选框），浏览器把点击激活到**第一个**可标记控件：

| 操作 | 单 checkbox（正确） | 双 checkbox（倒退） |
|---|---|---|
| 点行内**文字**（模型名） | 切换可见性开关 ✅ | **切换了多选勾选框，可见性开关纹丝不动** ❌ |
| 点开关本身 | 正常 ✅ | 正常 ✅ |

**结论**：⚠️ **`ModelToggle` 内必须保持只有 1 个 checkbox**。若将来确需多选，
**必须先把行容器从 `<label>` 改成 `<div>`**（并自行处理点击切换），否则必然重踩。
回归用例见 `tests/unit/model-filter.spec.ts` 的「ModelToggle 内只有 1 个 checkbox」。

#### 2. 渲染上限 200 条 + 「显示更多」 —— 属于功能收缩

改动前 478 条本来就是**一次性全渲染、工作正常**。加渲染上限后，超出的条目需要
额外点一次「显示更多」才能看到 —— 这是**凭空多一次点击**，属于功能收缩，已移除。
**不要再加回来**，除非有实测证明渲染确实卡顿（届时也应按 `filtered` 而非
`visible` 计算批量操作范围）。

### ⚠️ 搜索框自身的两处真实缺陷（用户报障，已修）

> 「搜索框在深色模式下输入的文字是白色的和底色一样看不见文字」
> 「输入文字后整个弹框的位置会发生改变，有点突兀」

两条都是**新增搜索框时引入**的，都已在本地复现确认并修复：

#### 1. 深色模式白字白底 —— 引用了**不存在**的主题 token

`.dim-jh-input` 的背景原写作 `var(--dsw-alias-bg-input, #fff)`，而主题里
**根本没有** `bg-input` 这个 token（真实的是 `bg-base` / `bg-layer-1/2/3`）。
`var()` 遇不存在的 token **不报错**，静默取 fallback `#fff` → 深色模式下
浅色文字配白底，文字完全看不见。

修法：改用官方 `Input` 原语同款的 `--dsw-alias-bg-layer-1`，并**去掉浅色
fallback**（宁可取不到值时背景异常、能一眼看出，也不要一个看起来正常却在深色
模式下毁掉可读性的 fallback）。placeholder 另用 `--dsw-alias-label-dimmed`。

⚠️ **审计工具**：`audit-tokens.mjs`（工作区根目录）会扫描插件样式里所有
`var(--dsw-*)` 引用，比对主题真实定义的 395 个 token，列出**不存在**的那些。
新增/修改样式后应跑一次 —— 这类缺陷单测抓不到（CSS 变量解析不在测试环境里）。
（该脚本同时报出既有的 `--dsw-alias-border-default`，属登录弹窗的历史问题，
与本次改动无关，未一并处理。）

#### 2. 输入文字后弹窗位置跳动 —— `align-items: center` + 高度随内容变化

弹窗高度随列表长度变化，而遮罩用的是 `align-items: center`，于是**高度变化直接
变成整体位移**。实测输入搜索词后弹窗 `top` 从 4px 跳到 **187px**（结果变少 →
弹窗变矮 → 居中的位置跟着上移），观感突兀。

修法：模型列表弹窗改为**顶部锚定**（`.dim-jh-modalOverlay--top`，
`align-items: flex-start` + `padding-top: max(24px, 8vh)`），上边缘固定、
只在下方伸缩。实测三种状态 top **恒为 38px、位移 0px**。

⚠️ 顶锚后 `max-height` 必须按 **padding box** 计算（`100%`），不能再用
`100vh - 48px` 这类视口算式 —— 否则 `8vh` 大于 `24px` 时会溢出视口。

⚠️ 该修饰类**只作用于模型列表**，账号备份弹窗仍用垂直居中。

### 验证方式（可复用）

`verify-searchbox.mjs`（工作区根目录）：从**真实源码模块提取 STYLES**，在模拟
深色 token 的页面里渲染，然后用无头 Edge 测量：

- 搜索框背景/文字色的**对比度**（实测 13.54:1，WCAG AA 要求 4.5:1）；
- 三种搜索状态下弹窗 `top` 的**位移**（实测 0px）；
- 回归断言问题 1 的布局（开关被挤出 **0 / 8 行**）。

⚠️ 单测抓不到布局与 CSS 变量解析，故用源码级断言 + 该脚本双重锁住。

## ⚠️ 停用账号时可选「同时停用该 provider 的模型」

**真实需求**（用户报障）：「我关闭了 qoder，模型列表中没有关闭，在对话中还是可以
选择到它的模型」。

### 根因：门控判据**刻意**不看 `enabled`

见上「目录门控」章节 —— 这是**整体设计**（停用只影响自动选号），不是缺陷。但它带来
一个用户可感知的落差：停用某 provider 的**最后一个**启用账号后，该 provider 在账号池
里已不可用，可它的模型**仍留在模型选择器里**（凭据还在，门控判为可见）。用户只能再
去「显示列表」里把几十上百个模型逐个关掉 —— 这正是 `state.json` 里 qoder 的 17 个
模型被手工全关、trae 的 41 个同样全关的由来。

### 修法：变成一次**显式选择**，而不是改门控语义

用户明确要求保持原设计。故在 `ProviderPanel.toggleAccount` 里加联动询问，
纯逻辑在 **`plugin-src/client/account-model-link.js`**：

- `disablingLeavesNoEnabledAccount(accounts, accountId, provider)` —— 停用后该
  provider 是否**不再有任何启用账号**；
- `allModelsDisabled(models)` —— 该 provider 的模型是否**全部已关闭**（且非空）。

| 方向 | 触发条件 | 询问 |
|---|---|---|
| 停用 | 停用后该 provider 再无启用账号 | 是否同时**关闭**它的全部模型 |
| 启用 | 此前无启用账号，且模型恰好全关 | 是否同时**打开**它们 |

### ⚠️ 五条不能改错的语义

1. **判定必须在 `account.update` 提交之前取**。提交后列表已刷新，「是否还有启用账号」
   的答案就变成变更后的状态了 —— 多账号场景下会误判。
2. **只在「最后一个启用账号」时提示**。该 provider 还有别的启用账号时，它的模型依然
   可用，关掉全部模型纯属**误伤**。
3. **只看同一 provider**。别的 provider 有启用账号与本 provider 的模型是否可用毫无
   关系 —— 若实现成「全表还有启用账号就不提示」，多 provider 用户永远不会收到提示。
4. **两个方向都必须由用户决定，不做静默联动**。静默关闭会让「停用账号」这个看似与
   模型无关的操作产生意外副作用；静默打开则可能把用户特意关掉的模型放出来。
5. **联动失败只提示、不回滚账号状态**。账号停用/启用已经落盘，此时把整次操作报成
   失败会让用户以为账号状态没变，再点一次又因幂等而看似「无效」。故只提示、让用户
   可去「显示列表」手动处理。

另外两点性能考虑：

- 启用方向**只在「此前一个启用账号都没有」时**才读模型目录（`isFirstEnabled`）。
  否则每次启用账号都会多发一次 `model.list` —— Cline 那次的目录有近 500 条。
- 目录读不出来时**静默跳过联动**：账号启用本身已经成功，不该因目录故障而报错。

### 与门控的边界

⚠️ **本联动不改变 `hasLoggedInAccount` 的判据**。「停用账号」与「是否已登录」仍是
两件事；联动只是替用户把「模型可见性」这件事**顺手做掉**，且必须经用户确认。
若将来有人想把 `enabled` 直接并入门控判据，先回看「目录门控」章节里那条
「若过滤 `enabled`，把所有账号停用的用户会发现整个 provider 的模型凭空消失」——
那正是本联动选择「询问」而不是「静默」的原因。

回归用例：`tests/unit/model-filter.spec.ts`（27 条）、
`tests/unit/account-model-link.spec.ts`（18 条）、
`tests/unit/jet-hub-rpc.spec.ts` 的 `model.setDisabledBulk` 段（14 条）、
`tests/unit/account-pool.spec.ts` 的 `setModelsDisabledState` 段（8 条）。

## 供应商级一键开关（左侧 rail 分组 + 页头弹窗开关）

**需求**：「因该提供左侧供应商的一键开关，开关逻辑和账号的开关逻辑一致（但是如果不关闭
模型就不关闭供应商），应该分组显示打开和关闭的供应商」。

### 语义（用户逐项确认）

| 决策 | 取值 |
|---|---|
| 关闭某供应商 | **关闭它的全部模型** + **停用它的全部账号** |
| 「已关闭」判据 | **该供应商的全部模型都已关闭**（不新增持久化字段，由模型黑名单推导） |
| 重新打开 | 清空该供应商的模型黑名单 + **启用它的全部账号** |
| 右侧账号面板 | **保持既有逻辑不变**；仅在其后重新加载一次列表（见下） |

⚠️ **没有新增任何持久化字段**：`state.json` 仍只有 `accounts` 与 `disabledModels`。
供应商的开关状态是**推导值**（`closed = total > 0 && disabled === total`），故无迁移、
无一致性维护成本。代价是「手动单独打开某个模型」会让该供应商回到「已打开」——
这正是判据的字面含义。

### 端点：`provider.status`（读）+ `provider.setEnabled`（写）

- `provider.status` 一次返回**全部**供应商的状态。⚠️ 全程只用**同步内存副本**：
  目录取 `modelAdapters[id].listAllModels()`（同步；不触发远端拉取），账号取
  `pool.listAccountsByProvider()`（同步读内存）。
  **不得**改用 `pool.listAccounts()` —— 它逐账号调 `credentials.describe()`（异步 IO），
  8 个供应商会把设置页首屏拖慢，而我们**只需要计数**。
- ⚠️ `listAllModels()` **不带 `disabled` 字段**，必须另取 `pool.listDisabledModels(id)`
  按 id 计数。
- ⚠️ 适配器缺失（外部/旧适配器）时 `total = 0`、`closed = false`：保守判为「未关闭」，
  让用户可以尝试操作，而不是误报成已关闭。

### ⚠️ 关闭方向的顺序不可颠倒：先关模型，再停账号

「是否已关闭」的判据是**模型是否全关**。先关模型可保证即使随后停账号失败，状态判定
依然自洽（该供应商确实已关闭），用户重试一次即可补齐账号。反过来先停账号、再关模型，
中途失败会留下「账号全停用但模型仍可见」的中间态 —— 用户在对话框里还能选到它的模型，
却没有任何可用账号。`tests/unit/jet-hub-rpc.spec.ts` 有专项用例锁死写入顺序。

### ⚠️「不关闭模型就不关闭供应商」

关闭方向必须拿到模型目录；**读失败**或**目录为空**时**整个操作失败、不落盘、不广播**。
绝不能「关不掉模型就只停账号」—— 那会让供应商显示成已关闭而模型其实还在，
用户按「已关闭」的预期却仍能选到它。前端把这种情形表现为**开关禁用**并给出原因
（`providerSwitchState` 的 `reason`），而不是让用户点下去只得到一句错误提示。

#### ⚠️⚠️ 但「拿到目录」必须取**两个来源的并集**（真实缺陷，2026-10-11）

上面那条约定立了很久，却**有一个入口绕过了它**：`fullCatalogIds` 原先是
「**优先** `modelAdapters[provider].listAllModels()`，只要它存在就短路、
**根本不读 `llm.listModels()`**」。

而 `listAllModels()` 在**冷缓存**下返回各家**编译期兜底表**
（`model-catalog.ts` 的 `cached ?? config.syncCatalog()`）—— 它是**子集**：
实测 `cline` 冷缓存只有 **3** 条，远端有 **460** 条。

⇒ 两个关闭方向都只写兜底表那几条进黑名单，**其余几百条仍可选**，而端点返回「成功」：

| 端点 | 后果 |
|---|---|
| `model.setAllDisabled` | 用户以为整个供应商已关闭，对话框里那几百条**仍能选中** |
| `provider.setEnabled` | **更重**：`provider.status` 的 `closed` 判据是 `total > 0 && disabled === total`，而 `total` **也**取自 `listAllModels()` ⇒ 界面**显示已关闭**、模型却仍可选（正是上一节列为必须避免的形态的镜像） |

⚠️ 用户报障路径**恰恰是冷缓存**：脚本/设置页首次打开就点「关闭全部」。
⚠️ 而上一节那句「读失败时不落盘」的守卫**拦不住它** —— 冷缓存兜底表返回子集时
它**不算失败**。这正是「判据写得对，但判据的**输入**是错的」这类缺陷的典型：
守卫本身没问题，问题在它拿到的目录不完整。

**修法**：`fullCatalogIds` 取 `适配器目录 ∪ 远端目录`，并把「目录是否可用」
如实回报给调用方（`FullCatalogResult.complete`）。三个调用点按**各自的完整度要求**
分流（这是它不能再返回单一 `{ ids } | { error }` 的原因）：

| 调用点 | 需求 | 目录不可用时 |
|---|---|---|
| `model.setAllDisabled` | **有新增项时必须完整**（要写黑名单） | **拒绝且不落盘**；⚠️ 并集**已全在**黑名单时**幂等成功**（见下）；⚠️ **模型列表屏（`closeProvider: false`）在 `notReady === undefined` 时放行**（只关可见项、传 `'keep'` 不动供应商关闭意图 —— 见下「五段」第 ④） |
| `provider.setEnabled` | **远端读成功即可** | 判 `remoteError`：读失败**拒绝**；读到但为空**照常关闭** |
| `account.test` | **尽力而为**（只要一个 id 就能测） | 用拿到的那些照常测 |

⚠️⚠️ **两个关闭端点刻意不同判据**（2026-08 修订，原先两行合并为「必须完整」）：
`provider.setEnabled` 是**供应商级**开关，「远端读到但为空」（无账号门控）时并集只剩
适配器兜底表，而该供应商本来就没有账号 ⇒ 模型选择器里一条都选不到，用兜底表写黑名单
**不会**造成「显示已关闭而模型仍可选」；若按 `complete` 拒绝，**无账号的供应商将永远
无法关闭**（远端目录按已登录账号门控，不登录永远读到 `[]`）。
`model.setAllDisabled` 是模型级批量操作，语义上要求目录完整；**唯一例外是「模型列表屏」**
（`closeProvider: false`）—— 那一屏用户的意图就是「关掉这家看得见的模型」，
而屏幕上那几条恰恰来自适配器兜底表（正是并集本身），拒绝它等于「界面列着 5 个、
点全关却说没有可关闭的模型」（2026-11-04 真机报障，见下第 ④ 条）。
两者共用 `fullCatalogIds`（目录来源只此一处），差异只在失败时的动作。

⚠️⚠️ **「远端读到但为空」有第二个成因，且与「无账号」完全同形**（2026-08 实测）：
**黑名单已覆盖全部模型**时 `createModelCatalog.listModels` 的
`listed = all.filter(entry => !disabled.has(entry.id))` 也会返回 `[]` ⇒
`remoteIds.length === 0` 且无 `remoteError`，与「无账号门控」**逐字段同形**。
⇒ 目录侧**无法**区分二者，判据只能建在**结果**上（黑名单是否已覆盖并集）。
漏了这条的后果（真实缺陷）：用户在**已经全关**的状态下再点一次「关闭全部」，
会得到「该供应商没有可关闭的模型」——而它明明有 N 个、只是都已关；
⚠️ 前端联动路径（停用最后一个账号时问「是否同时关闭全部模型」）会命中它，
用户看到误导告警「账号已停用，但关闭模型失败：该供应商没有可关闭的模型」。
⇒ `model.setAllDisabled` 的关闭方向因此是**五段**（顺序即语义，别重排）：
① `remoteError` 有值 ⇒ 拒绝；② 并集为空 ⇒ 拒绝；③ **并集已全在黑名单 ⇒ 幂等成功**
（什么都不写，故不需要完整目录也能安全作答）；④ **`!complete` 且 `req.closeProvider === false` 且 `catalog.notReady === undefined` ⇒ 放行**
（**只关当前可见项**，且第三参传 `'keep'` —— **不动**供应商关闭意图。放行依据：
`provider.status` 的 `closed` 仍按**同一份并集**算「可见项是否全关」，
状态与事实一致，不构成 IKJW33 的「显示已关闭而模型仍可选」；
⚠️ `notReady`（聚合冷启动，目录只有 `auto` 一条）必须排除 —— 那是不确定状态，
放行会写出残缺黑名单）；⑤ 有新增项但 `!complete`（且 `closeProvider !== false` 或 `notReady !== undefined`）⇒ 拒绝。

⚠️ **第 ⑤ 段内部还要再分一次文案**（2026-11-05 二审 P2-1，行为级探针 S4b 实测）：
`notReady` 有值 = 聚合目录**还在后台推导**，用户动作是「等一下再点」；无值 = 「没账号」，
动作是「去登录」——**两条文案不能合并**（`provider.setEnabled` 早就分开了，本端点此前
写死通用文案「该供应商没有可关闭的模型」，冷帧下界面明明列着 5 个模型、自相矛盾）。
冷帧文案必须**带 `reason` 原文**：`聚合目录尚未读取完成（<reason>），为避免只关闭
一部分模型，本次未做任何变更。请稍后重试。`
⚠️ 守卫的 `reason` 要用**独特**字符串：写成文案里已有的「聚合目录尚未读取完成」，
`toContain` 会被写死的前半句喂饱 ⇒ 删掉 `${catalog.notReady}` 插值也不会红（假绿）。

⚠️ **`complete` 不是「凡 false 即拒绝」的开关**（2026-08 修订）：它只回答
「远端那一半是否可用」，**不回答**「本次有没有东西要写」。调用方必须自己判
「有没有新增项」——两者混同就是上面那个「已全关却报错」的缺陷。
⚠️ 判据仍是 `complete` 而**不是**「`ids` 是否为空」：冷缓存下兜底表会让并集看起来
非空，而它只是**子集**，据此写黑名单正是本 issue 的原始缺陷。

⚠️⚠️ **「目录不可用」有两种形态，必须都判**（我第一版只判了前者，漏了后者）：

1. **远端读失败**（超时 / 抛错 / 无 llm 服务）—— 有 `remoteError`；
2. **远端读到但为空** —— `createModelCatalog` 在「无已登录账号」时门控返回 `[]`，
   含义是「**看不到**」而**不是**「该 provider 一个模型都没有」。
   ⚠️ 此时适配器兜底表**仍可能有内容**，照它写黑名单就是**同一个缺陷的另一个入口**
   （实测：远端 `[]` + 兜底表 1 条 ⇒ 「关闭全部」只关那 1 条并返回成功）。
   这一种**没有** `remoteError`（它不是错误）。

⇒ 判据收敛为 `complete: boolean`（= 远端读到且非空），**别让调用方各自拼**
「`remoteIds === undefined` 或 `remoteIds.length === 0`」—— 那正是本仓库踩过的
「一文件两套同义判据必然先腐坏一套」。`remoteIds` 字段已因此**删除**
（保留它就是留下第二套同义判据，审计独立指出过这一点）。

⚠️ **`account.test` 的「尽力而为」是刻意的、不可改成拒绝**：它只要**一个** id 就能测，
而「适配器有目录 + llm 临时故障（令牌过期）」是真实且常见的组合。
若那里也拒绝，该端点会从**能测**退化成
`bad-request: 无法确定要测试的模型：读取模型列表失败：令牌已过期` ——
而它自己的注释明确把这类退化列为「**自造的失败**」（实测确认过这个收缩）。

⚠️ **两种不可用的文案必须分开**（它们对用户意义不同）：
`account.test` 的「没账号」（`… 没有可测试的模型`）vs「读不到」
（`无法确定要测试的模型：读取模型列表失败：…`）；
`provider.setEnabled` 同理（`该供应商没有可关闭的模型，未做任何变更` vs 带 `remoteError`）。

⚠️⚠️ **两个关闭端点的文案必须逐字同构**（审计报的「缺口 4」）：`model.setAllDisabled`
原先用 `remoteError ?? '当前读不到完整的模型目录，未做任何变更'` 一刀切，
于是**同一个 `complete === false` 在两个端点给出不同可读性** ——
「远端读到但为空」（没账号）在它这里落到通用文案、在 `provider.setEnabled` 却走分流。
现统一为同一个三元表达式。

⚠️ **断言只 `toContain('没有可关闭的模型')` 是恒真的**（审计实测）：
文案退化成 `没有可关闭的模型：undefined`（把 `remoteError` 的 `undefined` 拼进模板）
**也含该子串** ⇒ 变异无法察觉。必须补
`expect(message).not.toContain('undefined')`。
⚠️ 同型缺口还有 `account.test`：把判据从 `remoteError !== undefined` 改成
`!catalog.complete`，生产 spec **全绿**而行为已分叉成 `无法确定要测试的模型：undefined`
—— 「远端读到但为空」这条组合**零守卫**（既有用例只覆盖 `withoutLlm` 与
`listModelsError`，两者**都带** `remoteError`）。已补用例。

⚠️ **「`ids` 可能为空」的分支在 `provider.setEnabled` 里现在是必需的，不再是死代码**
（2026-08 修订 —— 本节原先写「删掉它、实测加回全绿」，那条结论**只对旧的
`!complete` 判据成立**，判据换成 `remoteError` 后它变成唯一的「真没东西可关」落点）：

- 旧判据 `!catalog.complete` ⟺ 「远端读失败 **或** 远端空」，而后者已改判为「照常关闭」
  ⇒ 若没有 `ids.length === 0` 分支，「并集也为空」（适配器缺失 + 远端空）会**静默成功**
  并写一次空黑名单（`setModelsDisabled` 对空列表直接返回，故也不落盘 —— 但端点会
  报 `ok:true`、`models: 0`，用户以为关掉了）。
- ⚠️ 它与 `!complete` 分支**不再同义**：两者的判断对象不同（一个看并集、一个看远端），
  在「远端空 + 适配器有目录」这一格上**动作相反**（照常关闭 vs 拒绝）——
  那正是供应商级与模型级**刻意分道**的地方。
- `model.setAllDisabled` 侧的对应落点同理（见其五段判据的第 ② 段）。

⚠️ 反向断言仍必须保留：`expect(message).not.toContain('undefined')` ——
删掉它会让文案退化成 `没有可关闭的模型：undefined` 仍通过 `toContain` 断言。

⚠️ **新增代价**：`fullCatalogIds` 现在**总是**读一次远端（旧实现在适配器存在时根本不读）。
已用 `CATALOG_READ_TIMEOUT_MS`（2 秒）封住，超时即按「远端读失败」处理 ⇒
两个关闭方向**拒绝**、`account.test` 照常测。GUI 路径缓存通常已热（纯内存读）。

#### ⚠️⚠️ 读取侧：`provider.status` 的 `closed` 也必须核实（同一根因的残留）

写入侧修好后**读取侧还没修**（独立审计发现）：`provider.status` 的
`closed = total > 0 && disabled === total` 仍**只基于 `listAllModels()`**（子集）
⇒ 冷缓存 + 旧版本写下的**不完整**黑名单会**误报已关闭**：

```
兜底表 [hy3]（冷缓存）+ 黑名单 { hy3: true }（旧版本「关闭全部」的产物）
⇒ total=1, disabled=1 ⇒ closed:true
而远端还有 glm-5.2 / deepseek-v4-flash 可选 ⇒ 界面显示「已关闭」却仍能选
```

⇒ **只在子集判据说「已关闭」时才核实**（用 `fullCatalogIds` 取并集重算）。
理由：`closed` 的**危险方向只有 `true` 这一个**（报 false 是安全的 ——
用户可点开关，点了会得到明确错误）。故常见路径（未关闭）**零网络**，
只有「真的可能已关闭」才付一次读取。

⚠️⚠️ **核实的判据是「远端读成功」，不是 `complete`**：`complete` 额外要求远端
**非空**，而这里恰好有一个**正常**的空形态 —— 「全部模型都已关闭」时
`listModels()` 被黑名单**过滤成 `[]`**（那正是本端点要回答的那个状态！）。
用 `complete` 会让「一关全就永远显示未关闭」（本修复第一版踩过，两条既有用例当场变红）。
⚠️ 核实不了（远端读失败）时**保守报未关闭**（安全方向）。

⚠️ **代价与边界**：多个「已关闭」的供应商会串行各读一次目录（每次上限 2 秒）；
⚠️ 「远端读到但为空」（无账号门控）与「全部已关闭」在远端**同形**，
此时并集只剩兜底表 —— 若兜底表全命中仍报已关闭（用户确实没有可选模型），可接受。
⚠️ 存量**已修复**（不再误报），但**不回溯**：升级前写下的不完整黑名单本身仍在
配置里（用户点一次「关闭全部」或「打开全部」即可重写为完整集合）。

回归用例：`tests/unit/jet-hub-rpc.spec.ts` 的
「disabled:true 取两个目录来源的并集（冷缓存兜底子集不得当权威）」、
「关闭供应商：冷缓存兜底子集不得当权威」、「远端读到但为空（无账号门控）→ 同样拒绝且不落盘」、
「⚠️ 远端读失败时拒绝且不落盘」、「⚠️ 适配器有目录 + 远端读失败 → 仍用适配器目录照常测」、
「⚠️ 兜底子集判据说「已关闭」时必须核实」、「⚠️ 真的全关时仍报已关闭」、
「⚠️ 核实不了（远端读失败）时保守报未关闭」、「未关闭时不核实目录（子集判据为 false 即返回，零网络）」等。
⚠️ **条数以 `pnpm test` 输出为准**（本节刻意不写数字）。
⚠️ 已做**反向验证**（每条变异都有对应用例变红）：退回短路、去掉适配器半边、不回报
`remoteError`、改判 `ids` 是否为空（两个端点各一）、`account.test` 改拒绝、
不判远端为空、不吞适配器异常、`account.test` 判据改成 `!complete`、
文案恒用带原因那句、`provider.status` 退回不核实、核实用 `complete`、
核实失败不保守、未关闭时也核实。
⚠️⚠️ **2026-08 修订两条已失效的旧结论**（判据换过之后它们不再成立，别再照抄）：
1. 原先记「加回 `ids.length === 0` 分支**全绿 ⇒ 确认是死代码**」—— 那是**旧判据
   `!complete` 下**的结论；判据改成 `remoteError` 后该分支是唯一的「真没东西可关」
   落点，**必须有**（见上文）；
2. 原先记「`provider.setEnabled` 按 `complete` 与 `model.setAllDisabled` 同判据」——
   现已**刻意分道**（供应商级判 `remoteError`），见上文的两端点对照表。

⚠️ **2026-08 新增的三条变异验证**（本次修复引入，各自独立锁死）：
- 去掉 `model.setAllDisabled` 的**幂等短路**（`pending.length === 0`）⇒
  「已全部关闭时再点关闭全部」用例**变红**（报「没有可关闭的模型」）；
- 把幂等条件放宽成 `catalog.ids.length === 0 || !catalog.complete` ⇒
  **2 条**变红（「远端读到但为空 → 仍拒绝」+「只有部分已关 → 仍拒绝」）——
  证明幂等短路**没有**掩盖「拿兜底子集当权威」那个真缺口；
- 把 `provider.setEnabled` 的 `modelCount` 从 `pending.length` 改回
  `catalog.ids.length` ⇒「models 报实际变更数」用例**变红**（报 3 而非 1）。
  ⚠️ 该用例的 fixture 必须让**适配器目录给出全部 id**（那 2 条「早就关着」的只能
  来自它，因为 `listModels` 会把黑名单命中的过滤掉）；只给子集则两种计数相等，
  用例**无法区分** —— 初版就是这么写的，变异实测**全绿**（假守卫），已修正。

### ⚠️ 开关**不在**左侧行尾（2026-10-01 用户要求搬到页头弹窗）

!25 最初的形态是把开关挂在左侧每个供应商行的右侧。用户随后要求改：
「提供商开关是直接显示在 provider 右侧的，把它单独抽出来到 Jet Hub 上面的一个按钮里，
点开始列表和开关，可以选择关闭，**和模型列表中那套打开/关闭按钮的显示逻辑一样**」。

现在的形态：页头 `dim-jh-headerActions` 里的**「供应商开关」按钮** → 点开
`ProviderSwitchPanel` 弹窗（一个供应商一行、行尾一个开关）。

**为什么这个改法是对的**：关闭一个供应商是**破坏性批量操作**（一次改动几十个模型 +
全部账号），把它挂在承担导航的窄栏行尾，等于让误点代价最高的控件离高频无害动作
（选要看哪个供应商）最近。搬进弹窗后必须"点进去 → 看清影响面 → 再决定"。

⚠️ **搬走的是控件，不是判据**：`providerSwitchState`（三形态）与
`groupProviders`（分组）原样复用，新增的 `providerSwitchRows` /
`providerToggleSummary`（`plugin-src/client/provider-toggle.js`）只是把
「定义 × 状态表」拼成行数据与计数 —— **判定仍然只在纯逻辑层一处**。
弹窗与左侧 rail 读的是同一份 `provider.status`，故不可能出现
「左侧说它关了、弹窗里它还是开的」。

⚠️ **弹窗行的约束换了一套**：行容器是 `<label>` 且**内部只能有 1 个 checkbox**
（与 `ModelToggle` 同因：插入第二个 checkbox 会让「点行内文字」激活第一个可标记控件）。
原先那条「开关必须是 `<button role="tab">` 的兄弟节点」随开关一起失效 ——
现在左侧行里**只有一个 button**，`provider-toggle.spec.ts` 改为断言这一点
（行内不得出现 `React.createElement('input'`）。

⚠️ **rail 宽度 243px 是当时的遗留**：那张实测表里 243px 是为了**容纳行尾开关**
（无开关时 200px 就够）。开关搬走后左侧已有约 40px 富余，收窄回 200px 属独立的
视觉决策，本次**没做**（样式断言 `.dim-jh-rail { width: 243px; }` 仍在，
改宽度时要一起改）。

### 弹窗与模型列表弹窗共用同一套结构与类名（用户明确要求）

`ProviderSwitchPanel` 复用 `dim-jh-modalOverlay--top` / `dim-jh-modalHead`
（标题 + 计数 + 刷新 + 完成）/ `dim-jh-modalHint` / `dim-jh-modalBody` /
`dim-jh-modelList` / `dim-jh-modelRow` / `dim-jh-modelInfo` / `dim-jh-modelName` /
`dim-jh-modelId` / `dim-jh-switch`，并沿用 ESC 与点遮罩关闭、
**关闭即不挂载**（避免常驻一份开关列表）。**没有为它新写一条样式规则**。

两个容易做错的细节：

- `data-disabled` 在模型列表里的语义是「**这一项已被关闭**」（整行淡出），
  这里保持一致：`row.checked ? 'false' : 'true'`。「这行点不动」由 `input` 的
  `disabled` 表达，**两件事不能混成一个属性**。
- **busy 只锁被点的那一行**，不锁整表（与 `ModelListPanel` 的 `busyIds` 同取向）。
- ⚠️ 状态没读回来时**不显示计数**：`providerToggleSummary` 的 `known: false`
  让界面显示「正在读取状态…」/「状态读取失败」，而不是「已打开 0、已关闭 0」——
  后者会被读成「一个供应商都没有」。为此 `JetHubPage` 新增了 `providerStatusFailed`，
  用来区分「还没回来」与「回来是失败」（`providerStatuses === null` 一个值担不起两义）。

### ⚠️ `.dim-jh-providerLabel` 曾是「已定义但从未被应用」的死样式

真实代码渲染的是 `<span><strong>{label}</strong></span>`（span **没有** className），
于是长供应商名一直在**折行**（用户最初的截图里「WorkBuddy (国际 / 版)」就是两行）。
该类（含 `min-width: 0` 与 `strong` 的 `nowrap + ellipsis`）在样式表里早已存在却无人使用。

本次**启用**它，把折行改为单行省略号。这是左侧的一处**可见变化**，故用实测数据定了
rail 宽度：实测（无头 Edge + 真实源码 STYLES，rail 高 446px、纵向滚动条出现时）

| 方案 | rail 宽 | 标签可用 | 结果 | 列表总高 |
|---|---|---|---|---|
| 现状（无开关、真实标记） | 200px | 119px | 4 行折成 2 行，无截断 | 384px |
| 行尾开关 + 省略号类 | 200px | 77px | **6/8 行超宽**（最多 -64px） | 384px |
| 行尾开关 + 省略号类 | 236px | 113px | 3/8 行超宽 | 384px |
| **行尾开关 + 省略号类** | **243px** | **120px** | **3/8 行超宽（-3 / -4 / -21px）** | 384px |
| 行尾开关，**不启用**省略号类 | 243px | 120px | 4 行折成 2 行 | **424px**（行高 48→58px） |

故取 243px：与现状几乎逐像素持平，且列表总高不变。

⚠️ **测量方法上的两个坑（都踩过）**：
- **inline 元素的 `clientWidth` 恒为 0**，用 `scrollWidth - clientWidth` 判截断会得到
  「没有截断」的**假阴性**。要用 `Range.getBoundingClientRect().width` 取文本真实宽度，
  与父容器 `clientWidth` 比较。
- **不能靠行高判断折行**：2 行 × 20px = 40px 仍小于 `.dim-jh-provider` 的 `min-height: 48px`，
  行高恒为 48px，折行被完全掩盖。要用 `Range.getClientRects().length`。
- **纵向滚动条会再吃掉约 15px** 标签宽度（Windows 经典滚动条），是否出现取决于 rail 高度
  （即用户窗口高度）。测量必须同时报告「纵向滚动条 = 有/无」，否则同一宽度两次测得不同
  标签宽度会被误读成测量错误。

### 状态读取失败时退化为不分组（不阻断主功能）

`provider.status` 失败时把状态置为 `null`，rail **按 `PROVIDERS` 原顺序平铺、不分组**，
并在页头提示一句。⚠️ 此时**弹窗里的**所有开关都被 `providerSwitchState(undefined)`
判为**禁用**（`reason: '状态尚未读取'`）—— 状态未知时让用户点一个状态不明的开关比
禁用更糟。**绝不**因为左侧这个装饰性功能而让整个设置页白屏。
⚠️ 但「`null` 一个值」担不起「加载中」与「读取失败」两义 —— 弹窗计数需要分开显示，
故另有 `providerStatusFailed`（见上一节末条）。

### 右侧账号面板：只重新加载，不改逻辑

供应商开关会改掉账号的 `enabled`，故提交成功后递增 `version` 让 `ProviderPanel` 重挂载
并重新拉一次账号列表（用户已确认接受这一处刷新）。**除此外右侧一律不动**：不新增字段、
不改按钮、不改积分行、不改拖拽排序、不改账号级 `toggleAccount` 联动。

### 回归用例

- `tests/unit/provider-toggle.spec.ts` —— 纯逻辑（分组 / 三形态 / 结果文案 /
  **弹窗行数据 `providerSwitchRows`** / **计数 `providerToggleSummary`**）+ 源码级守卫
  （⚠️ **左侧行内不得出现 `input`**、页头按钮点开弹窗且关闭即不挂载、
  弹窗行是 `<label>` + **恰好一个** checkbox、弹窗与模型列表共用同一套类名、
  `data-disabled` 只表达「已关闭」、状态没读回来不显示计数、分组标题带计数、样式约束）。
  ⚠️ 源码级断言**不能跨行**：本仓库源文件是 CRLF，`'a\nb'` 形式的字面量匹配不上。
- `tests/unit/jet-hub-rpc.spec.ts` —— `provider.status` 的 `closed` 判据（含「只关一部分」
  与「空目录」两条边界）、`provider.setEnabled` 的写入顺序 / 不落盘 / 广播 / 参数校验。
- `tests/unit/account-pool.spec.ts` —— `setAccountsEnabled` 的 provider 隔离、幂等不落盘、
  不破坏黑名单、写前 `ensureLoaded`、跨实例读回。
- ⚠️ **反向验证 5 组**（证明用例非同义反复）：`closed` 改判据 → 1 条失败；空目录仍落盘 →
  1 条失败；写入顺序颠倒 → **4 条失败**；去掉「无模型即禁用」→ 3 条失败；去掉分组计数 →
  1 条失败。
- ⚠️ **测试替身必须补齐 `credentialRef`**：`sanitizeAccounts` 会把缺该字段的账号**整条丢弃**，
  于是「停用全部账号」返回 0、用例假失败（本次踩过）。
- ⚠️ **追加测试段时要确认落在哪个 `describe` 作用域**：本次一度把新段落追加进
  `TRAE 签到设备轮换代次` 的 describe 内，引用了该作用域不存在的工厂，8 条用例全部
  ReferenceError。新增段落应显式写明它所属的顶层 describe。

### 安装闸门（用户要求：确保不影响客户端启动才安装）

`verify-client-boot.mjs`（工作区根目录）是安装前的**强制闸门**，任一失败即拒绝安装：

1. **语法层**：`node --check` 每个产物 js。
2. **加载层（冒烟）**：无头 Edge 注入 `window.__ModuleLoader__`，捕获
   `load({id, factory})` → 断言 id；以 stub react 执行 `factory` → 断言导出
   `apply` / `inject`；再调 `apply(fakeCtx)` → 断言注册了 `settings.section` 且未抛错。
   这一步直接验证「插件能加载并注册设置页」，是 tsc 与单测都覆盖不到的一层。
3. **产物层**：新能力在、旧能力未被破坏、源码与部署产物哈希一致。

### 十、captcha 改为「要了才取」：先探后取 + 2 分钟需求记忆（2026-10-01）

**上游并非每次都要验证头**：外部仓库 `bonus-plan-4-open-zcode`（提交 `52b6389`）
的抓包显示官方壳在 `access.mode = normal` 时全程零验证、只有 `off-peak` 才强制；
本仓库 2026-10-01 深夜窗口的实测同向 —— **不带验证头 8/8 全 HTTP 200，连非法
param 也 200，`3007` 命中 0 次**（10 发真实请求；探针
`scripts/probe-zcode-captcha-need.mjs` 与设计稿
`docs/superpowers/specs/2026-10-01-zcode-captcha-lazy-mint-design.md` 都是
**本地文件、不入库**，需按本节思路自行重写）。
⇒ 推理路径改为：默认**不带**验证头发一次，被 `3007` 拒才 mint 并重发，
并按「账号 × 模型」记 2 分钟（真实 key 格式见 `src/captcha-requirement.ts` 的
`captchaRequirementKey`，形如 `` `${accountId}|${model}` ``；策略与 TTL 同文件）。

⚠️ **三条不可回退的口径**：
1. `3007` 必须在**适配器内部**补产重发，不能走到 `throw` —— 它映射 `RATE_LIMIT`
   且在 harness 可重试集合里，抛出去会让用户先看到一次我们**预期到**的失败；
2. 不带也成功 ⇒ **必须清记忆**（否则在不需要验证的窗口里持续白产，白扣设备信誉）；
3. 记忆只在**进程内**，不落 `jet-hub-store`（`state.json` 是同机多 profile 共享的
   home 级文档，落盘会互相传染验证结论）。

⚠️ **注释与文档的口径是双向的**（本仓库评审反复打回的就是这类）：
- **不许**把「缺 captcha 必回 `3007`」写成无条件事实（上面那次实测一次都没发生）；
- 也**不许**反过来写成「上游永不校验」，据此删掉 `3007 → 补产重发` 分支或改成
  复用 param —— 历史上确实强制索要过，而**本次只采了深夜一个窗口、跨时段未复测**。
  ⚠ 别据此造一条「读 `access.mode`」的逻辑：那是**那个壳**的 provider 配置开关，
  我们的直连路径上没有它（依据是**本机取证、不在仓库**：本机那个壳的
  `provider_config.json` 里只有 `{type:"api-key"}`）。

⚠️ **收益不是常数，别写成「省 1.2 秒」**：省下的是「不需要验证的那些请求」的一次
mint + 一份设备级验证配额与信誉；上游要验证时那一发照付。mint 的真实量纲：
**稳态（复用常驻页面）0.4–0.5 秒**（同一组 5/5 样本：中位 426ms / 平均 546ms，
两个统计量仓库里都有记载）、
**首次 mint 含 chromium 冷启动实测 4.2 秒**（Task 1 那发的 4200ms 就是这个，
不是稳态；⚠ 别与 `zcode-captcha.ts` 记的**浏览器进程**冷启动约 690ms 混为一谈 ——
后者只是起进程，不含建页与阿里云 SDK 首次加载）。

⚠️ **别把本节与本章 7.2 互相引用为依据**：7.2（「官方确实每请求一个 captcha」）
是从**官方闭源版** `app.asar` 逆向出的**那个客户端的生产行为**（每个 model request
都重新产 param）；本节说的是**上游服务端的校验行为**（深夜窗口不校验）+ 外部
**开源壳**的抓包。两者是两个层面 —— 我们新逻辑跟随的是**后者**（服务端要不要），
`mintCaptcha` 何时被调由探测结果决定，与 7.2 那条官方实现细节无关。

⚠️ **TTL 与记忆键的依据是**外部仓库**那次提交 `52b6389`，不是本仓库实测** —— 那次采样一次都没命中
「要验证」，所以 2 分钟 TTL 在本仓库**没有被证明过**。写注释时别记成「我们实测」，
否则将来按它调参的人找不到依据就会随手改。

⚠️ 与预取池是**对立**的：预取会让我们在不需要的窗口里也耗配额（同设备 150/小时），
故 `DSH_ZCODE_CAPTCHA_POOL` 默认关闭保持不变，别「为了削峰」把它打开。

⚠️ **`claim`/签到路径的 mint 语义不变**：`src/zcode-auth.ts` 里每个 plan 必单独
mint（那是确定要带的），不走先探后取。

⚠️ 载体（壳内 WebContentsView / CDP / 浏览器档）本期**一个都没做**：取证结论是
DSH 桌面版里「只改配置就能拿到内部载体」不成立 —— 插件宿主是**以
`ELECTRON_RUN_AS_NODE=1` 单独 spawn 的子进程**（`require('electron')` 拿不到
`app`/`WebContentsView`）、全 bundle **零** `remote-debugging` 开关、自建 webview
被主进程的 `will-attach-webview` 租约治理 `preventDefault()` 拒绝、而
`cordis.patch.yml` 只是**配置包补丁**不是代码注入通道。
⚠ 这四条的取证对象是 DSH 桌面版的 `app.asar`（**外部产物、不在本仓库**），
记录在上面的本地设计稿 C 段 —— 要复用结论请先重取一遍，别当常量。

回归：`tests/unit/captcha-requirement.spec.ts`（8）+
`tests/unit/zcode-captcha-lazy.spec.ts`（17 = 判据 3 + 行为 8 + 观测 5 + 探测 1）。
⚠️ 已做反向验证（均实跑）：把内层门控 `knownRequired || probeRejected` 改回
**无条件 mint** ⇒ 行为段 5 条变红；去掉 `clearCaptchaRequirement()` 那一行 ⇒
**只有**「不带也能成功 ⇒ 清记忆」变红；把 `httpErrorCodeForZcode` 的 `3007`
改归 `SERVER` ⇒ **只有**「补产后仍 3007 仍抛 `RATE_LIMIT`」那条变红
（它锁住的是「探测侧归**仍受限**、不标坏账号」，见 `isRateLimitFailure()`）。


## ⚠️⚠️ 用量徽标折叠态：渠道名与读数**必须是两个元素**（真实报障，2026-10-03）

**报障**：胶囊显示成 `LobsterAI (有道) · 合计 …` —— **数字被截掉**，而渠道名完整。

**根因不在宽度，在结构**：原先整句是**一个** `overflow: hidden; text-overflow: ellipsis`
的 span，省略号从右往左吃，被吃掉的恰好是用户唯一想看的东西（还剩多少）。
⇒ 把 `badgeView()` 的返回拆成 `name` / `detail` / `reading` **三个字段**
（`plugin-src/client/badge-model.js`），渲染层再给**不同的收缩权重**
（`usage-badge.js` 的三段式 `collapsed` + `jet-hub-styles.js` 的三条规则）：

| 段 | 类 | flex-shrink | 让位顺序 |
|---|---|---|---|
| 渠道名 | `.dim-jh-badgeName` | 99 | 第二 |
| 包名（仅套餐模式） | `.dim-jh-badgeDetail` | 999 | 第一 |
| 读数 | `.dim-jh-badgeReading` | **`flex: none`** | **不让位** |
| `•` | `.dim-jh-badgeSep` | `flex: none` + `margin: 0 3px` | 不参与 |

### ⚠️ 读数必须 `flex: none` —— 这是第二个、更隐蔽的成因

给读数留 `flex-shrink: 1`（哪怕幅度极小）时，加权分配仍会分给它**不到 1px** 的收缩
（实测 78.23 宽 / 内容 79），而 `text-overflow: ellipsis` 的触发条件是
`scrollWidth > clientWidth` —— **亚像素级收缩就足以命中**，最后一个字被换成「…」，
视觉上和整段被截一样严重。故读数的 `flex` 是 `none`，**不是** `0 1 auto`。

### ⚠️⚠️ 这条缺陷**用 `clientWidth` 量不出来**（我因此假绿了一整轮）

`clientWidth` 与 `scrollWidth` **都取整**：
- `clientWidth` 把 53.97 报成 54 ⇒ `scrollWidth > clientWidth` 判为 **false**（漏判）；
- `scrollWidth` **向上**取整，内容 39.79 报成 40 ⇒ `rect < scrollWidth` 恒成立（误判）。

我第一次写的断言用 `scrollWidth > clientWidth` 判「数字是否完整」，**全部通过**，
而**截图里明写着 `347.87积…`**。⇒ **判定省略号只能靠截图**，或量一个
**同字体的自然宽度参照元素**再与元素实际宽度比（`tests` 里没做渲染测试，
故这一条只能靠改样式时人工截图复核 —— 见下）。

### 测量数据（Edge headless，宿主 UI 字体栈，dsf 1 与 1.5 都量过）

| 用例 | 自然宽度 | 186px 下 |
|---|---|---|
| `WorkBuddy (国际版) • 200积分` | 179.3px | 完整 |
| `LobsterAI (有道) • 842.06积分` | 172.3px | 完整 |
| `WorkBuddy (国际版) • 347.87积分` | 193.6px | 名字省略，**数字完整** |
| `CodeBuddy (腾讯) • Free Plan Subscription 300 / 500积分` | 309px | 包名+名字省略，**数字完整** |

⚠️ 宽度上限取 **186px**（原 150px）：对最宽的那个报障样例留 6.7px 余量。
⚠️ `<button>` **本来就是 `border-box`**（UA 默认样式表），故这次是**实打实多占 36px**，
不要按「只是写明 box-sizing」理解；多占的空间由 `.dim-jh-badge` 的 `flex: 0 1 auto`
（**不是 `none`**）兜底 —— 窄窗口下胶囊自己先让位，而不是把模型选择器挤出去
（后者正是 2026-10-02 那次报障的形态）。

### ⚠️ 两个静态陷阱（都有用例守着）

1. **类名不能复用 `.dim-jh-badgeValue`** —— 那个名字已被**浮层**里的读数占用，
   规则带 `font-weight: 600` 且排在样式表**更后面**（同特异性 ⇒ 后者胜），
   沿用同名会让胶囊里的数字被静默**加粗**。故胶囊用 `.dim-jh-badgeReading`。
2. **窄屏「只留状态点」的媒体查询必须排在 `.dim-jh-badgeText { display: flex }` 之后** ——
   两者特异性相同，胜负由**源顺序**决定；排到前面会让 `display: none` 被
   `display: flex` 覆盖，窄屏下文字重新出现并挤压模型选择器（宽窗口下完全看不出）。

### ⚠️ 分隔符的间距只能用 CSS，不能用字符串里的空格

`BADGE_SEP = ' • '`（带空格）**只用于 `title` / `aria-label` 那句整文**。
渲染层里 `•` 是独立 span，间距靠 `margin` —— 因为 **flex 容器把 span 之间只含空白的
文本节点渲染成零宽**（实测 gap=0：节点还在、看不见），空格会静默消失。

### ⚠️ `jet-hub-styles.js` 的注释**不能出现反引号**（本次又踩一次）

该文件的 `STYLES` 是模板字符串。我在标出「报障原文」时写了反引号，
`node --check` 直接报 `Unexpected identifier`。已有一条用例扫徽标那一段的注释块。
⚠️ 注意 `\``（转义）**也会**在产物里留下真反引号 —— 该用例照样会红。用「」代替。

⚠️ 这条只对**模板字符串所在的文件**成立：`badge-model.js` / `usage-badge.js` 是普通
JS，里面的 JSDoc 写反引号没问题 —— 但**从它们复制片段进 `jet-hub-styles.js` 就会炸**。
动手前先确认目标文件是不是模板字符串。
## ⚠️⚠️ 用量徽标折叠态：**余额优先**（口径反转，2026-10-03 用户要求）

**报障**：CodeBuddy 胶囊显示「个人体验版 500 / 500积分」，而设置页里写着
**可用积分 2434.96**。用户原话：「图3里显示我能用的积分足足 2436.96 呢」。

### 口径（现在的默认）

| 偏好 | 折叠态显示 |
|---|---|
| **auto**（默认） | **余额** → 窗口 → 套餐（三级回落） |
| subscription | 窗口 → 套餐 → 余额 |
| credits | **只**余额（不回落） |

⚠️ **两个数都是真的，但回答的不是同一个问题**：套餐读数是「某一份包还剩多少」，
服务端还会下发「体验版」这类样板包 —— 它只是余额里的一份；余额才是「一共还能用
多少」。旧口径（窗口 > 套餐 > 余额）在这种渠道上**必然少报**，且看起来像数据错误。
⚠️ **窗口/套餐读数没删**：仍在浮层里，`subscription` 档可切回去。别以为是回归。

### 实现要点

- 模式选择从「嵌套三元 + 一个 `wantsSubscription` 布尔」改成**有序候选表 +
  `find`**：旧写法让一个布尔同时承担「是否看订阅」与「是否允许回落」两义，
  加一档就要重排整棵嵌套，极易写漏组合。
- ⚠️ **每个候选必须判「有内容」而不是「存在」**：账号 `ok:true` 但 `windows: []`
  或包全失效时订阅对象是在的、内容是空的 —— 直接选中会显示成 `Cline · `
  （只有渠道名、没有数字，比显示余额更没用）。
- 展示名跟着改：`credits` 从「优先积分」改成「**只看积分**」。⚠️ 语义反转后
  `auto` 与 `credits` **都显示余额**，差别只在「是否回落」—— 沿用「优先积分」
  会让两档读起来是同义词。差别写在容器 title 里。

## ⚠️ 徽标宽度：**内容自适应 + 216px 上限**（两次报障的两个不同成因）

**同一条链路、两次报障，别把第二次当成第一次没修好**：

| 报障 | 表象 | 根因 |
|---|---|---|
| 第一次 | 数字被截（`…合计 …`） | **结构**：整句一个 `overflow:hidden` 的 span，省略号从右往左吃掉余额 |
| 第二次 | 名字被截（`CodeArts (华为…`） | **尺寸**：结构修好后 186px 仍不够长名字 + 长余额，省略号落到名字上 |

**216px 是量出来的**：13 个渠道展示名 × 10 种现实读数（含 123456.78积分 /
9499.84积分 / 94.54MToken / 0积分）共 130 组，最宽需求 **209.34px**
（`WorkBuddy (国际版) • 123456.78积分`），留 6.7px 余量。

⚠️⚠️ **上限不能再往上放，「无上限」是错的**：实测把 `max-width` 去掉后，
极窄 composer（220px）下胶囊**溢出容器 8.3px** —— 那正是 2026-10-02
「模型选择器图标被挤没」的形态。**内容自适应与上限兜底缺一不可**：
宽度由内容撑开（`Cline • 5积分` 只有 93px），上限只防挤压右侧。

⚠️ 写用例时**别把 `.dim-jh-badgeBtn` 的 `max-width` 当成「胶囊实际宽度」**：
我第一版测量脚本忘了解掉类自带的上限，量到的永远是 186（被截断后的值），
于是「所需宽度」全部失真。测量时必须 `style.maxWidth = 'none'`。


## ⚠️ 多账号的胶囊：**分组键必须先归一单位**（2026-10-03 真实缺陷）

用户报障（WorkBuddy 国际版**两个**账号）：
`WorkBuddy (国际版) • 341.78积分 · 100积分` —— 读成「把所有号的积分都列出来了」，
并担心「以后五六个号会显示很长一串」。

**根因既不是账号数，也不是宽度，而是分组键**：服务端把**同一个单位**拼成两种
写法。逐包实测（`probe-workbuddy-units.mjs`，只打印单位/包名/数值）：

| 账号 | 包 | `unit` 原值 |
|---|---|---|
| `…01CC739A` | Bonus Pack 241.78 / Free Plan Subscription 100 | `credit` / `credits` |
| `…297957E1` | Free Plan Subscription 100 | `credits` |

折叠态按**原始字符串**分组（`credit` ≠ `credits`）⇒ 两个账号落进两个分组 ⇒
渲染出两个**一模一样**的「积分」标签（用户看到的就是这个）。名字同时被
216px 上限截成 `WorkBuddy (…`。

**红线：分组键必须与展示名同源。** 凡是 `unitLabel` 会显示成「积分」的单位串，
就必须落进**同一分组**；否则文案里必然出现 `A积分 · B积分` 这种把同一单位拆成
两段的形态。故分组前一律走归一：

- 客户端 `plugin-src/client/credits-format.js` 的 `normalizeUnit()`
- 宿主 `src/credits.ts` 的 `normalizeCreditUnit()`
- 两者都只返回 `'token'` / `'credit'`，**必须逐字等价**（宿主算套餐读数、客户端
  算余额分组；不一致会让同一枚徽标里「套餐按一个单位、余额按另一个」自相矛盾）。
  契约由 `tests/unit/usage-badge-client.spec.ts` 逐项比对锁死。
- 消费点三处：`creditGroupsOf`、`planGroupsOf`（客户端）、`badge-subscription.ts`
  的 `unitOf` / `badgePlanFor`（宿主）。

⚠️ **`token` 与积分不合并**：ZCode 是 token、其余是积分，不可折算，仍分两组
（`100积分 · 94.54MToken`）。归一化只收敛**同义拼法**，不跨量纲求和。

⚠️ **不要改写 `CreditPackage.unit`**：那里要保留服务端原值（设置页逐包明细依赖
它）。归一化只发生在「当分组键 / 当展示名」那一步。

修复后同一份真实数据：`WorkBuddy (国际版) • 441.78积分`，宽度 **193.56px**
（上限 216px 都没碰到）⇒ 名字也不再被截。六个号（单位拼法混着给）同样只有一个
数字：`2066.84积分`。

⚠️ **教训的普遍性**：这是本仓库第三次栽在「用外部下发的**字符串**当键」上
（另两次：qoder 的 `110` 用错误码默认归类、`10605` 排队被漏判）。外部字段的
**拼法不可假设**，当键用之前先归一到自己的语义等价类。

## ⚠️ 徽标的两条「账号多了」规则（2026-10-03 用户要求）

胶囊对**任意账号数**都只显示一个数字（前提是单位先归一，见上一节）。另两处随账号数
放大的地方已按用户要求整理：

| 位置 | 规则 | 理由 |
|---|---|---|
| 弹窗逐账号列表 | **按余额降序** | 账号是「用完一个换一个」的资源，先要看到「还有哪个号能用」；原顺序是池的插入顺序 |
| 同上 | 读不到数的**排最后** | 那格显示的是错误文案，夹在数字中间会被误读成「余额很小」。⚠️ 不能用 0 代替（0 会插进小余额里） |
| 同上 | 超过 **5 个**折叠 | 6 个号 = 12 行（每号两行），弹窗比窗口还高 |
| 胶囊 | 合计不完整时挂 **⚠ 角标** | 账号读不到时合计会**静默少报**，数字本身看不出异常（色调仍是 ok） |

⚠️ **排序与折叠是纯函数 `orderCreditRows`（`badge-model.js`）**，不是写在组件里：
`usage-badge.js` 依赖宿主注入的 react（本仓库装不了），**组件里的逻辑测不到** ——
凡是「错了用户也只会觉得别扭、不会报错」的规则，都必须住进能单测的模块。

⚠️ **角标的四条硬约束**（每条都有对应用例）：
1. 与读数同级 `flex: none` —— 它是补语，被省略号吃掉等于没标；
2. 排在读数**之后** —— 不干扰「先看数字」的阅读顺序；
3. **不进 `view.text`** —— 那是供 title / 读屏的纯读数，说明单独走 `incompleteNote`；
4. 标记自身 `aria-hidden`，同一句话并进按钮 `aria-label`（否则读屏念两遍）。

⚠️ **只在积分模式标**：只有它是跨账号的**合计**。窗口模式按设计只显示某一个账号的
窗口、套餐模式显示「最大的那份套餐」——它们不是合计，套这句话就是错的。
（判据 `mode === 'credits' && okCount > 0 && failedCount > 0`；`okCount > 0` 是必要的，
一个都没读到时模式已回落到 `empty`，读数本身就是「用量不可用」。）

⚠️ 弹窗脚注**复用同一句话**（`view.incompleteNote`），不另写一份措辞 ——
否则会出现「胶囊说 A、弹窗说 B」。

⚠️ 实测数值（无头浏览器，比较 `getBoundingClientRect` 的渲染宽度与自然宽度 ——
不能用 clientWidth / scrollWidth，两者会四舍五入）：带角标后 193.56px → **202.19px**，
名字与读数都不出省略号，仍在 216px 上限内。

## ⚠️⚠️ 一键签到的汇总**必须按单位分列**，不得跨单位求和（2026-10-04 真实报障）

用户报障原文：
> 插件的这个一键签到，Zcode 获得的是 token 数量，但是这里显示成获得积分。
> 正文「…ZCode（智谱）+100000000（共 +100000100）」
> 应当显示为「…ZCode（智谱）+100Mtoken（共 +100Mtoken, +100积分）」

**根因不在文案，而在数据模型**：`computeClaimSummary` 的 `totalCredit` 是
**跨单位求和的标量** —— ZCode 的 1 亿 token 与其余渠道的 100 积分加在一起得
`100000100`。单位信息**在汇总这一层就丢了**，下游无论怎么写文案都只能标一个
「积分」。故修法是**让单位一路传到渲染层**，而不是在文案里猜。

| 层 | 改动 |
|---|---|
| 宿主汇总 | `RpcCreditsClaimSummary.totalByUnit: Record<'token'\|'credit', number>`（**两键恒存在**） |
| 宿主累加 | `computeClaimSummary` 用 `claimUnitOf(outcome.unit)` 分桶；`RunTotals` 同步加 `totalByUnit` |
| 格式化 | 宿主 `src/credits.ts` 的 `formatClaimGains`；客户端 `credits-format.js` 的同名函数 |
| 消费点 | `auto-checkin.ts` 的 `describeChannel`/`describeRun`；`jet-hub.js` 的 `checkinAll`；`usage-badge.js` 的 `onClaimAll`/`summarizeClaim` |

**四条红线**：

1. **`totalCredit` 保留原语义（跨单位求和），但展示路径一律不得用它** ——
   它只对**单一单位**的渠道（其余 11 个）正确。改它才是破坏性改动，故新增字段而非替换。
2. **宿主与客户端的两份格式化必须逐字等价**。客户端 bundle 不能 import 宿主代码
   （esbuild 的客户端产物没有 Node 依赖），只能各写一份 —— 契约由
   `tests/unit/claim-unit-parity.spec.ts` 逐项比对锁死。不锁的话，**同一轮签到**
   在 Jet Hub 设置页（宿主产出并落盘的文字）与用量徽标（客户端现场拼）会显示成两种写法。
3. **每个单位各带一个 `+`**，不是整段共用一个。用户给出的期望文案就是
   `+100Mtoken, +100积分`；整段共用会渲染成 `+100Mtoken, 100积分`，第二个单位
   看起来像「不是本次领到的」。故 `+` 放在 `formatClaimGains` **内部**，
   而不是留给调用方拼（一旦各拼各的，两处界面必然漂移）。
4. **顺序固定 `token` → `credit`**，不依赖对象键序（用户期望文案就是 token 在前）。

⚠️ **积分不压缩、token 才压缩**：积分余额的现实量级是 `123456.78`（IDE 顶部就是这个
精度），压成 `123.46K` 会让用户无法与官方界面核对；而 token 动辄上亿，不压缩读不出量级。
`formatCreditAmount` / `formatTokenAmount` 与客户端的 `formatCredits` / `formatTokens` 同口径。

⚠️ **数值与单位之间不留空格**（`100.00MToken` / `800积分`）：这是本仓库既有的展示惯例
（用量徽标里 ZCode 余额就渲染成 `94.54MToken`），也与用户给出的期望文案同形。

⚠️ **旧响应兼容**：`totalByUnit` 缺失时回落到 `{ credit: totalCredit }`（行为与改动前
一致，只是多了单位名）。判据与 `coversToday` 的兜底同思路 —— 缺字段 ≠ 0。
⚠️ **但兜底只做一次，且做在「逐渠道累加」那一跳**：`jet-hub.js` / `usage-badge.js`
首版在 `let totalCredit = 0` 上留了一个标量，汇总行写
`totalByUnit.token > 0 || totalByUnit.credit > 0 ? totalByUnit : { credit: totalCredit }`
—— 而那个 `totalCredit` **再无任何累加**（全文只有声明行，恒为 0）⇒ 该三元分支
**永远走不到**，旧宿主的兜底实际发生在 `s.totalByUnit || { credit: s.totalCredit }`。
现已删掉该变量与那个分支（一个恒为 0 的变量配一句「保留只为兜底旧宿主」的注释，
比删掉它危险得多）。**新增同类兜底时先自问：这个分支有哪条真实路径能走到？**

### ⚠️⚠️ 承上：**`+` 在函数内部 ⇒ 调用点绝不能再拼**（2026-10-05 复审 PR !56 补记）

**真实缺陷**（本 PR 首版自身引入，用户可见）：`formatClaimGains` 的返回值**自带**
每个单位的 `+`（`+100.00MToken, +100积分`，这是它名字里 `Gains` 的含义，也是上面
红线 3 的结果），而客户端的 **4 个调用点**「顺手」又拼了一次 ⇒ 渲染出**双加号**：

```
jet-hub.js     bits.push(`+${amount}`)          →  "++100.00MToken"
jet-hub.js     `（共 +${totalAmount}）`          →  "（共 ++100.00MToken, +100积分）"
usage-badge.js bits.push(`+${amount}`)          →  "++800积分"
usage-badge.js `（共 +${totalAmount}）`          →  "（共 ++100.00MToken, +100积分）"
```

⚠️ **宿主侧 `auto-checkin.ts` 那两处反而是对的**（`（${amounts}）` / `个 ${amounts}`）
—— 恰好**只有两个客户端界面**是坏的，而它们正是用户报障盯着的界面。
⇒ 同一件事在 6 个调用点里出现两种写法，是「手写拼装」的必然结果。

⚠️⚠️ **比缺陷本身更值得记的是：全量 5448 条用例全绿也没抓到它。** 三个原因叠加：

1. 新增的 `claim-unit-parity.spec.ts` 把 `formatClaimGains` **这个纯函数**锁得很死，
   却**只 import 纯函数、从不看调用点** —— 纯函数层面的用例**结构上不可能**发现
   「函数被用错」（它测的是输出，bug 在使用上）；
2. 宿主侧有 `auto-checkin.spec.ts` 逐字断言，客户端侧**没有对等用例**；
3. 既有的源码级守卫 `zcode-claim-amount.spec.ts` 那条 `not.toMatch`
   （`/个账号领取成功（\+\$\{summary\.totalCredit\}/`）是**恒真**的 ——
   `jet-hub.js` 里从来没有过这个形态（真实代码当时是
   `` （共 +${totalCredit} 积分） ``，**没有**「个账号领取成功」这个前缀）。
   ⇒ 它修复前后**都命中 0 次**，等于空转，而它正是「防跨单位求和回归」的那道闸。

✅ **修法与新增的不变量**（`tests/unit/claim-unit-callsites.spec.ts`，16 条）：

- **正常锚点 + 反向断言成对写**：每条 `not.toMatch` 都必须配一条 `toMatch`，
  否则「锚点形态根本不存在」⇒ 反向断言**恒真**（上面第 3 条就是这么空转了几个月）。
- **断言必须剥注释**：本仓库源码注释里大量**逐字引用**曾经的错误写法，不剥注释
  则反向断言会被注释自己命中（写这个文件时首版实测红了 4 条，全因注释）。
- **断言一律单行**：CRLF + 跨行锚点会命中 0 次被静默跳过（见下文那条 CRLF 教训）。
- 覆盖 6 个调用点（4 客户端 + 2 宿主）+ 2 处**空格口径**，并含**元测试**
  （把错误形态喂给同一个正则，必须命中）证明断言非恒真。
- 反向验证 `scripts/mutate-claim-unit-callsites.mjs`：**9/9 全部杀死、0 跳过**
  （含 2 条空格变异），且断言每条锚点**命中次数恰为 1**。

⚠️ **顺手修掉的两处空格口径不一致**（同一轮签到不能像两种单位）：`jet-hub.js`
逐账号明细与 `usage-badge.js` 余额行原写作 `+100.00M Token`（**带空格**），
而汇总行是 `+100.00MToken` —— 两行并列显示成两种单位。本仓库口径是**不留空格**
（`badge-model.js` 的 `94.54MToken`、用户期望文案 `+100Mtoken` 同形）。

⚠️ **教训的普遍性**：**「同一个格式化函数有多个手写调用点」本身就是缺陷温床**。
函数内部已经保证的东西（`+`、单位名、空格），调用点每多一处就多一次重犯机会。
⇒ 要么让调用点**只贴函数返回值**（不在外面包任何修饰），要么再加一层
「拼好一整句」的函数；**不要**让 N 个调用点各自拼一半。

### ⚠️⚠️ 承上之二：**「展示路径写死『积分』」共有三处**（2026-10-05 同批复审）

同一批审计里又找出**第三处**同型缺陷 —— 它在**用量徽标浮层的「积分区」节标题**：

```js
// 修复前（usage-badge.js）
quotaGroup === undefined ? '积分' : unitLabel(quotaGroup.unit)
//                        ^^^^^^ 兜底分支假定「非配额渠道都是积分」
```

**ZCode 的额度单位是 token**（`src/jet-hub-rpc.ts` 的 zcode 分支如实标
`unit: 'token'`），于是浮层渲染成**自相矛盾的一屏**：

```
积分                                  ← 节标题（写死）
  ZCode 旅行者6665   94.54MToken       ← 同一屏的数值（按单位走）
```

⚠️ **它此前没被发现，是因为只在「该渠道只发 token」时才显形** ——
12 个渠道里只有 ZCode 是这种形状。这与「某次实测没看到 ≠ 不存在」是同一类陷阱。

⚠️ **判据必须与分组口径同源**：修法是抽成纯函数 `creditSectionLabel(groups)`
（`plugin-src/client/badge-model.js`），有配额组用其标签（`'额度'`）、
否则用**第一个**单位的标签。⚠️ 取「第一个」是安全的，因为 `creditGroupsOf`
末尾按 `unit` 排序 ⇒ 结果确定、不依赖对象键序。

⚠️⚠️ **第三处还带出一个更重要的方法论教训：纯函数级用例测不出「组件不调用它」。**
`badge-model.spec.ts` 为 `creditSectionLabel` 加了 6 条用例，但它们**全部只 import
纯函数** —— 若有人把组件改回内联三元，那 6 条**依然全绿**（实测确认）。
故调用点契约文件里**额外**加了两条源码级断言：① 组件**必须**调用
`creditSectionLabel(`；② **不得**再出现 `=== undefined ? '积分' : unitLabel(` 形态。

⇒ **反向验证 11/11 全部杀死**（`scripts/mutate-claim-unit-callsites.mjs`），
其中两条**成对**存在、缺一不可：

| 变异 | 由谁杀死 | 说明 |
|---|---|---|
| `creditSectionLabel` 内部写死「积分」 | `badge-model.spec.ts`（1 红） | 纯函数自身有问题 |
| 组件回退到内联三元（不调用纯函数） | `claim-unit-callsites.spec.ts`（2 红） | **纯函数全绿**，只有调用点断言能抓 |

⚠️ **写变异脚本时还要注意「验证范围」**：该脚本首版只跑
`claim-unit-callsites.spec.ts`，于是第一条变异被判**幸存** —— 而它其实是被
`badge-model.spec.ts` 杀死的。**「范围没覆盖到」与「用例没抓住」在输出里长得一样**，
与本文件反复出现的那条 CRLF 教训同源。现在 `SPEC` 同时覆盖两个文件。

⚠️ **顺带**：验证脚本 `verify-claim-unit-callsites.mjs` 也踩了**同一个注释坑** ——
它检查错误形态时命中了自己注释里逐字引用的旧写法，对**已修好的产物**报假阳性
（9 通过 / 1 失败，那 1 项命中的全是注释）。**凡是对源码做形态断言的脚本，
都要剥注释再匹配。**

### ⚠️⚠️ 承上之三：空格口径要**穷举断言**，逐点断言挡不住新调用点

**真实教训（2026-10-05，复审收尾时的覆盖度自查）**：前两轮修复里，
空格口径只逐点钉住了**当时发现的那两处**（逐账号明细行、徽标余额行）。
收尾时用宽搜复查（列出全部含 `formatUnits(` 的可执行行），又抓到**第三处漏网**：

```js
// plugin-src/client/usage-badge.js 的**订阅套餐行**（修复前）
`${formatUnits(group.remaining, group.unit) ?? '?'} / ${formatUnits(group.total, group.unit) ?? '?'} ${group.label}`
//                                                                                                     ↑ 多一个空格
```

它渲染的正是 `100.00M / 200.00MToken`，而**同一个弹窗**的积分区是**无空格**的
⇒ 两处并列像两种单位。

⇒ **修法升级**：把「数值与单位之间不留空格」改成**穷举断言**
（遍历三个客户端文件，凡「`formatUnits(...)` 的数值后跟空白再紧跟单位标签变量」
即判红），并配正向锚点防恒真。

⚠️ **判据必须只认单位标签变量名**（`unitLabel(...)` / `group.label` / `best.label`），
**不要**泛化成「所有 `${}` 前不得有空格」—— 那会误伤 `jet-hub.js` 的
**模型分组标题** `` `${expanded ? '▾' : '▸'} ${group.label}` ``（那里的
`group.label` 是「GLM 系列」这类**分组名**，本就该有空格）。

⚠️ **教训的普遍性**：**逐点断言的覆盖是「已知位置」，而缺陷可能出现在任何新调用点**。
凡是「N 个位置都该遵守同一条口径」的事，判据就应当是**穷举**的
（扫全部调用点 / 断言集合为空），而不是逐个列举。

⚠️⚠️ **还有一条元教训：自查脚本/断言自己也会写歪**。本次覆盖度脚本首版有**两处自伤**，
都导致「对**已修好**的代码报未覆盖」的**假阴性**：
① 用 `includes('…大量反斜杠…')` 判断旧锚点是否移除，**转义写歪** ⇒ 反复误报；
② 空格穷举只匹配两种后缀形态，漏掉标签是别的变量名的写法。
⇒ **凡断言，先确认它「在该红时真红」** —— 这与 `not.toMatch` 恒真、
变异脚本「跳过 vs 杀死」是同一类错误，本仓库已栽过三次。


**反向验证**（`mutate-claim-unit.mjs`，8 条变异**全部杀死**）：汇总不分桶 3 红、
格式化不按单位选压缩 6 红、单位标签恒为「积分」6 红、只列一个单位 6 红、
`describeRun` 回到裸标量 5 红、`describeChannel` 回到裸数字 5 红、
客户端少一个 `+` 3 红、客户端标签恒「积分」2 红。

⚠️ **写变异脚本时必须处理 CRLF**：本仓库源码是 CRLF（实测 `src/credits.ts`
CRLF=725 / LoneLF=0），而脚本里的锚点是用 `\n` 写的。不做归一化的话**多行锚点会
命中 0 次而被静默跳过** —— 第一版就这么漏掉了 3 条最关键的变异（全是多行的）。
故脚本统一把锚点转成目标文件实际的行尾，并**断言命中次数恰为 1**。
⚠️ 这**不是一次性教训**：2026-10-05 复审时新写的
`scripts/mutate-claim-unit-callsites.mjs` 依然按这条做（归一化 + 断言命中恰为 1），
结果是 `9/9 杀死、0 跳过`。**「跳过」与「杀死」在输出里长得像** —— 不打印
跳过数、不断言命中次数，就会把「锚点没匹配上」当成「验证通过」。

⚠️ **教训的普遍性**：这是本仓库第二次栽在「**跨量纲求和**」上（第一次是胶囊把
`credit`/`credits` 拆成两组，见上一节）。凡是把**带单位的量**累加成**裸数字**，
单位就一定会在那一层丢掉；正确做法是让单位**跟着数字一起走**（分桶 / 分组），
把「怎么显示」推迟到最后一层。

## 账号池与多账号

`AccountPool`（`src/account-pool.ts`）在 `jet-hub` settings 命名空间下保存账号索引，凭据本体存于 `ctx.credentials`。要点：

- 账号条目以 `provider` 字段区分归属，`getAvailableAccount` / `listAccounts` 均按该字段过滤
- 适配器必须以 `this.product.id` 作为 provider 实参查询账号池（写死 `'buddy'` 会让 WorkBuddy 永远匹配不到账号）
- 限流后按池中「已启用且不在重置时间内」的下一个账号自动重试；全部耗尽才抛 `QUOTA_EXCEEDED`

### ⚠️⚠️ 全部账号被**模型限流**时，必须报限流，不能报成「未登录」（真实缺陷，2026-10-03）

**用户报障**：`/compact` 连续四次失败，UI 只显示通用文案
「Compaction could not produce a useful summary」。解出会话日志后，`compaction/end`
携带的真实错误是：

```
buddy: no usable credential; log in from the Jet Hub panel first
```

而当时 Jet Hub 里 buddy 账号**已登录、已启用、凭据完好** —— 真实原因是它被
`deepseek-v4.1-flash` 的**模型级限流**挡住（解禁时刻就存在 `modelRateLimits` 里）。
用户被指去「重新登录」，方向完全错。

**链路**（四个环节都正确，合起来却报出假原因）：

1. 唯一的启用账号带该模型的未过期限流标记 → 候选筛（原
   `src/index.ts` 里 buddy 系那段编排闭包，符号名已随 Task 6 删除
   —— 见 git 历史 `d35d9e3`）筛成**空集**；
2. `select()`（`src/buddy-balance-selector.ts`）对空候选只能回一个笼统的
   `{kind:'exhausted'}`，**未锁定时 `reason` 被丢弃**；
3. 调用方退到**单凭据 ref** `BUDDY_ACCESS_TOKEN` —— 而 Jet Hub 登录只写
   `BUDDY_ACCOUNT_XXX`，该 ref **从未存在过** → `resolveCredential` 返回 `undefined`；
4. 适配器据此抛 `MISSING_CREDENTIAL`（`src/buddy-adapter.ts`）。

⇒ 与 qoder 的 `110` 被误归 `SERVER`、`10605` 排队被漏判是**同一个病根**：
**用默认归类代替了对业务语义的判断**。

**修法**：新增纯判据 `allAccountsRateLimitedForModel()`（`src/account-pool.ts`），
在「候选为空、即将退到单凭据 ref」这一刻**证明**失败原因。位置必须是
`getAvailableAccount` **之后**、`ctx.credentials.resolve` **之前**：
池里还有号时不该报限流，而退到单凭据之后就来不及了。

- ⚠️ **只改错误语义，不改可用性**：没有账号可用就是没有，压缩该失败仍然失败；
  修的是「用户看到的原因」。**绝不静默换模型**（那是替用户做决定），
  **绝不绕过限流标记**（那会让标记形同虚设）。
- ⚠️ **判据必须窄**，与选号侧严格同口径（缺标记 / `0` / `now >= resetAt` 都算不受限），
  且空 `modelId` 直接不判定 —— 选号侧约定空 modelId 不做限流过滤
  （`if (modelId.length === 0) return true`），不同口径会把「未登录」误报成「限流」。
  ⚠️ 该空串守卫**不是**冗余：`updateModelRateLimit` **不校验** modelId，
  理论上可落下 `modelRateLimits['']` 脏键，没有它就会被当成真实限流上报。
- ⚠️ **只统计启用账号**（`.filter(a => a.enabled)`）：停用账号本就不参与自动选号，
  把它们算进来会让「有一个号被停用」的普通情况被误报成「全部限流」。
- ⚠️ **错误码取 `QUOTA_EXCEEDED`**（本仓库既有惯例，且**不在**
  `DEFAULT_RETRYABLE_CODES` 里）；**不可取 `AUTH`** —— 那会把整条 message
  换成「API 密钥无效」（判据见下文「安全策略拦截」那条的取证），
  精心写的解禁时刻在 UI 上一个字都看不到。
- ⚠️ **文案必须带解禁时刻与「无需重新登录」**：只说「限流」而不给时间，
  用户仍会去重登或干等。
- ⚠️ **两处都要接**（`CODEBUDDY` / `WORKBUDDY` 各一处），否则两个 provider 行为不一致。
- 测试：`tests/unit/buddy-ratelimit-misreport.spec.ts`（19 条：行为级判据 + 源码级接线
  + 回归保护）。⚠️ 已做**反向验证**：移除两处判定调用 → 3 条变红；
  逐条破坏判据（去 `modelId` 空串守卫 → 1 条、去 `resetAt===undefined` → 2 条、
  去 `now>=resetAt` → 2 条、去 `resetAt===0` → 1 条、最早解禁改最晚 → 1 条）。
  ⚠️ 写用例时注意：断言「判定先于单凭据兜底」**不能只搜 ref 名** ——
  `BUDDY_CREDENTIAL_REF` 在文件更早处（import 与注册）也出现，会命中错位置
  （实测 `check=12308` 反而大于 `fallback=751`）；锚点要用**完整的兜底调用语句**。

### 账号顺序 = 选号优先级（Jet Hub 拖拽排序）

**数组顺序本身就是 `getAvailableAccount` 的候选优先级**，即自动选号与限流换号的实际取号顺序。

- ⚠️ **不要重新引入「按限流重置时间重排候选」的 sort**。早期实现有
  `candidates.sort((a,b) => resetAtA - resetAtB)`，它会让手动顺序形同虚设 ——
  用户把某账号拖到首位，只要另一个账号的重置时间更早，实际选中的仍是后者。
  现语义分两档（2026-11-09 订正，别再把两句混成一句）：**走余额分档的 14 家渠道**
  （`BALANCE_TIERED_PROVIDERS`）默认是「**先按积分到期档位排序、档内才看拖拽顺序**」
  —— 面板对它们渲染「严格手动顺序」开关（`JetHubState.strictManualOrder`，稀疏表、
  缺键 = 关 = 升级前行为；打开后拖拽序才是唯一优先级，但档位仍判「能不能用」：
  锁定永久积分时只剩永久积分的号照旧被跳过）；其余渠道（codearts / raccoon /
  cline / gemini …）才是「**手动顺序优先，限流豁免**」：顺序完全由用户决定，
  而正处于限流期的账号已被 `filter` 排除，不会选到
- `reorderAccounts(provider, orderedIds)`：**只动本 provider 占用的下标**，
  其他 provider 账号位置不变（账号存在一个全局数组里，设置页按 provider 分组渲染）
- `orderedIds` 必须是该 provider 全部账号 id 的一个**排列**，否则抛错。
  少了 id 若静默忽略，该账号会莫名掉到末尾（用户看到「顺序自己变了」）；
  多了未知 id 说明前后端状态不一致
- RPC：`account.reorder`；前端 `plugin-src/client/jet-hub.js` + 纯逻辑
  `plugin-src/client/account-order.js`
- ⚠️ **落点必须区分 before / after**（`dropPositionFromPointer` 按指针落在目标卡片
  上半/下半判定）。只支持「插入到目标之前」时，把卡片**往下拖一格是空操作**，
  用户会以为拖拽坏了。插入线指示（`data-dropBefore` / `data-dropAfter`）必须与
  实际落点一致
- ⚠️ **移除源元素后目标下标会前移**，必须用 `indexOf` 重算而不能复用原下标，
  否则会插到目标之后。`tests/unit/account-order.spec.ts` 覆盖了这一点

### ⚠️ 安全策略拦截（11140）：三条通道都要换号 / 标冷却，错误码**绝不能**取 `AUTH`

腾讯侧业务码 `11140`（`request illegal`，文案写「内容未通过安全审核」）**服务端嘴上说是
内容问题，实测是账号级拦截**：同一份请求体发往池里 7 个账号得到「2 通 / 4 拦 / 1 限流」，
连「你好」都被拦，换新会话照样拦（排除上下文累积）。因此它的正确出路是**换号**，
不是让用户改内容。该结论由 !15（认证路径）与 !16（限流路径）先后确立，本次补齐剩下两处。

- ⚠️ **错误码不能取 `AUTH`，也不能取 `QUOTA` / `ACCOUNT_QUOTA`**（通用教训，不限本 provider）。
  DSH 聊天 UI 的判据是（取证：`@deepseek-ai/dsh-client-ui-chat/lib/client.js:1229-1234`）：
  ```js
  if (code === "QUOTA" || code === "ACCOUNT_QUOTA") return t("message.failure.quota");
  return code === "AUTH" ? t("message.failure.auth") : message;
  ```
  即 `AUTH` 会**把整条 message 换成「API 密钥无效」**（`displayFailure()` 那里甚至强制
  `message: ""`）。!15 精心写的「全部账号均被服务端安全策略拦截…」在 UI 上**一个字都看不到**，
  还把用户引向检查密钥（实测 7 个 token 全有效、2027-09 才过期）。
  ⇒ **凡是要把自定义文案送到用户眼前，码必须避开这三个**。
  现取 `PERMISSION_DENIED`：与本仓库 `cline-adapter.ts` 的地域限制分支同码（见下文惯例），
  且**不在** `DEFAULT_RETRYABLE_CODES`（`EMPTY_RESPONSE / RATE_LIMIT / SERVER / TIMEOUT / TRANSPORT`）
  里 → 确定性结论不会被 harness 白退避 5 次。
  ⚠️ 也别顺手改回 `AUTH`「与其余 401/403 口径一致」：口径一致不该以吞掉文案为代价。
- ⚠️ **被拦账号必须打冷却标记**（`markPolicyBlockedAccount`，`src/buddy-adapter.ts`）。
  !15 / !16 让「有可用账号就一定能用上」成立，但**每轮都要重撞坏账号**：候选顺序是用户拖拽定的
  （见上文「账号顺序」），实测那池前 4 个被拦 → 每次请求固定先发 4 次失败。
  复用账号池的 `modelRateLimits` 载体（它是**唯一**的「账号×模型暂时不可用」映射，没有 reason 字段），
  代价是账号卡片显示「限额重置 · 模型 · 30 分钟后」而非「安全策略拦截」；
  收益是 `getAvailableAccount` 的过滤、UI 的「重测 / 重置」两条人工解禁路径**全都现成生效**。
  ⚠️ **时长是自己定的 30 分钟（`BUDDY_POLICY_BLOCK_COOLDOWN_MS`），不要复用
  `parseRateLimitError` 解析不到时那个 1 小时兜底** —— 11140 报文里根本没有时间字段，
  走那条兜底等于把「策略拦截」冒充成「服务端限流」。也别与 cline / lobsterai / trae 的
  `*_RATE_LIMIT_FALLBACK_MS` 合并成一个常量（语义不同，调一个不该动另一个）。
  ⚠️ 标记**只随时间到期失效**：`sweepExpiredRateLimits` 在生产代码里**没有任何调用方**，
  别指望它来清过期项（过期标记靠**取号时的过滤器**忽略：`getAvailableAccount` / `listAvailableCredentials` 里的 `Date.now() >= resetAt`。
  ⚠️ 这里**刻意不写行号** —— 2026-11-05 二审实测它已漂到 `578`（真实位置 2668 / 2751），行号在两次提交内就会腐坏。
  ⚠️ **只标该模型**（同 qoder 额度那条口径）：跨模型无实测依据，标全部模型会误伤本可用的组合。
  ⚠️ 写标记失败**只记日志、不上抛**（与 `src/expiry-sync.ts` 惯例一致）：本次的准确错误才是主线。
- ⚠️ **流内（HTTP 200 + SSE 帧）那条通道原先整帧被静默丢掉**：buddy 的帧类型里**没有**
  `code` / `msg` 字段，而 11140 恰好是顶层 `{code,msg,displayMsg}`、无 `error` 无 `choices`
  → 一路走到循环末尾，既没内容也没报错，UI 表现成「干净地停止、无任何失败」
  （与 qoder 的 10605、TRAE 的流内错误同型）。
  ⚠️ **判据必须带「这一帧没有 `choices`」这层门禁**：正文里出现「安全审核」
  /`request illegal`/字面 `11140` 是常态（模型在讨论审核策略就会说），只看 payload 字样
  会把一个合法回答判成拦截并连带标冷却。
  ⚠️ 判据与 HTTP 层**共用** `isContentRejection()`，别在流内另写一套 —— trae 那次缺陷的成因
  就是流内分支当年自己写了一套判据。
  ⚠️ 本通道按定下的口径是「**标记 + 如实报错**」，本轮不重发（重发需要「尚未产出内容」判据
  + 外层循环，那是 `3823133 fix(trae)` 那种结构改造，不在本次范围）；下一轮选号会自动绕开。
  故报错文案取「当前账号…」而非「已逐个换号重试」——**文案必须与是否真换过号一致**。
- ⚠️ **单账号池 + 续期失败**时，`credential expired and refresh failed` 那条早退分支
  **也必须先排 11140**：单账号池必然满足「没换到号」，修复前真实原因是拦截时报的却是
  `AUTH` + 一句与凭据有关的话（写用例时实测到）。
- ⚠️ 文案里的 HTTP 状态取**最后一次拦截**的，不是首发的：「首发 401 + 途中 403/11140」
  若沿用首发状态会报出一个对不上的「HTTP 401」，把人引向「token 过期」。
- 测试：`tests/unit/buddy-adapter.spec.ts` 的
  「安全策略拦截（11140）：账号冷却 + 流内错误帧」段（7 条）。
  ⚠️ 已做**反向验证**：错误码退回 `AUTH` → **7 条**变红；禁用冷却标记 → **5 条**变红
  （含认证 / 限流 / 流内三条通道各自那条）；禁用流内识别 → **2 条**变红。

### ⚠️⚠️ 模型饱和（`14003`）**不是**账号额度限流：不许换号、不许标记（真实报障，2026-10-05）

**用户报障**：第一次用 `buddy/space-bunny`（`reasoningEffort=max` / `maxTokens=128000`）就收到

```
本轮运行失败 buddy: 模型 space-bunny 所有账号均受限，请稍后再试
QUOTA_EXCEEDED
```

**而 4 个账号凭据全部有效、服务端对 `space-bunny` 实测完全可用**（4 个账号 × 小请求全 200；
长生成 417 秒 / 972 帧正常 `stop`；maxTokens/effort/system 65KB/41 个 tools 各种形状全 200）。

#### 根因：`14003` **也是 HTTP 429**，而 `isRateLimited` 对 429 **无条件**为 true

于是它落进了限流分支 → 给**每个**账号写一条 **1 小时**标记（报文里没有「将在…重置」，
故取 `RATE_LIMIT_FALLBACK_MS` 兜底）→ 整池被锁 → 用户看到「所有账号均受限」。

服务端原话（`scripts/probe-buddy-error-catalog.mjs`，4 MB 输入逼出）：

```json
{"code":14003,"msg":"too many requests",
 "displayMsg":{"zh":"模型繁忙，请换模型或稍后重试"},
 "displayTips":{"zh":"这个模型当前请求量饱和，与你的网络无关。请换个模型，或稍等一会儿再重试。"},
 "actions":["SWITCH_MODEL","SUBMIT_FEEDBACK","RETRY"]}
```

⚠️ **报文自己就说明了这不是账号问题**：`actions` 里只有 `SWITCH_MODEL`，**没有**换号选项。

#### 四条实测证据（互相印证，缺一都不能定案）

| 观测 | 结果 |
|---|---|
| 账号池 4 条 | 是 **4 个不同腾讯 uid**（`612f07cc…` / `2f7d1c08…` / `c974deb7…` / `d694eca7…`） |
| 4 条标记的写入时刻 | 20 秒内**全部**被写 `space-bunny` |
| 4 条标记的解禁时刻 | 全 = 「写入 + **整 1 小时**」= 兜底值，**非**服务端给的时刻 |
| 小请求 30 发 | 全 200，但耗时 **841ms ~ 216s** ⇒ 上游是**时变**背压 |

⇒ 「4 个互不相干的账号同时中招」在**账号级**限流下无法解释，**只能**是**模型级**。

⚠️ **`space-bunny` 还有一个特殊性**（其余 buddy 模型都没有）：目录元数据是
`"onlyReasoning": true` + `defaultEffort: "max"` + `maxOutputTokens: 128000`
—— 它把额度**全部花在思考上**，是唯一会被压满的路径（长生成实测思考 70353 字才出正文）。
排查时别只盯「账号额度」。

#### 修复口径：与 zcode `3009` 同型（**留在本账号退避重试**）

| | 额度限流 `6004` | **模型饱和 `14003`** |
|---|---|---|
| 语义 | 该**账号**在该模型上额度用完 | 该**模型**此刻整体饱和 |
| 换号 | **有效**（各账号额度独立） | **无益**（所有账号撞同一堵墙） |
| 写限流标记 | **必须**（否则每轮重撞） | **绝对不许**（会锁整池 1 小时） |
| 建议 | 等解禁 / 换账号 | **换模型** / 稍后重试 |

- 判据：`src/llm-adapter.ts` 的 `isModelSaturationError(status, body)`
  （业务码 `14003` **或**窄文案 `模型繁忙|请求量饱和|model busy|currently saturated`）；
- 接线：`src/buddy-adapter.ts` 的 `stream()` 里，**必须插在 `isRateLimited` 分支之前**
  —— 顺序就是修复本体（`14003` 满足 `isRateLimited`，晚一步就整池被锁）；
- 动作：`BUDDY_SATURATION_MAX_RETRIES`（2 次）线性退避，**始终用同一个 `credential`**；
- 用尽仍饱和 → 抛 **`RATE_LIMIT`**（可重试），文案指向「换模型」，
  ⚠️ **不许**说成「账号额度受限」（那会让用户白等 1 小时、且期间连别的模型都受影响）。

⚠️ **判据必须窄**：泛词「繁忙」**不算** —— 模型正文里正常讨论「服务器繁忙时应当重试」
就会被误判。故 `status < 400` 时一律不认文案。
⚠️ 退避间隔取**短**（2s → 4s）：该错误**自身**就要跑 46~111 秒才返回，
再叠长退避会让 UI 长期停在「运行中」而无法区分「排队」与「卡死」（与 Qoder 排队 ≥10s 封顶同因）。
⚠️ 环境变量**不许**写 `parseInt(…) || 默认值`：`0` 是合法值（单测靠它把用例压到毫秒级），
会被 `||` 静默换成 2 秒 —— 与 `QODER_QUEUE_MAX_DELAY_MS` 那次同型。

回归用例：
- `tests/unit/buddy-model-saturation.spec.ts`（8 条：真实报文 / 6004 不误判 /
  **14003 同时满足 isRateLimited**（缺陷成因）/ 两种码值编码 / 裸文案 /
  正常正文不误伤 / 不误伤 11140 / 常量一致）；
- `tests/unit/buddy-adapter.spec.ts` 的「模型饱和（14003）不换号、不标记」段
  （3 条**行为级**：两处副作用必须为 0 + 恢复即产出 + 6004 既有换号行为不许回退）。

⚠️ **已做反向验证**：把饱和判定强制为 `false`（= 修复前行为）→ **2 条行为用例变红**，
且失败输出里**确凿地打印出** `{"accountId":"acct-1","modelId":"space-bunny"}` ——
即修复前真的会写那条标记，**不是同义反复**。

⚠️ 本缺陷与 Cline 那条（下面「429 有**三种**语义」）、qoder `10605`/`110`、
zcode `3009`/`1005` 是**同一个病根**：**用状态码的默认归类代替了对业务语义的判断**。
接新的 429/限流分支时，先把「这个码的正确动作是什么」问清楚再写。

## 模型黑名单（Jet Hub「显示列表」开关）

同一 `jet-hub` 命名空间的 `disabledModels` 字段保存「被关闭的模型」，形如 `{ buddy: { 'glm-5.2': true } }`。要点：

- **黑名单制**：只有键存在且为 `true` 才隐藏，未记录的模型默认打开（新模型上线自动可见）
- 过滤点在适配器的 `listModels`，每次调用实时读 `pool.disabledModelsFor(provider)`，改开关后无需重建适配器
- **只影响模型目录播报，不影响路由**：被关闭的模型仍可 `resolveModel` / 正常收发请求（DSH 约定：`listModels` 结果仅供参考）
- `AccountPool` 的 `writeAccounts` / `writeModels` 都是**整体 replace**，两者必须互相携带对方的字段，否则一次账号操作会把模型开关清空（反之亦然）
- `CodeArtsAdapter.listModels` 必须 `await this.ensureRemoteModels()`：早期用 `void` 丢弃 Promise，冷缓存时会误用静态兜底表
- RPC：`model.list` / `model.setDisabled`（`src/jet-hub-rpc.ts`），前端在 `plugin-src/client/jet-hub.js` 的 `ModelListPanel`

### ⚠️ 改完开关必须广播 `llm/adapters-updated`，否则界面要重启才更新

**真实缺陷**（用户报障）：在 Jet Hub 关掉 LobsterAI 的若干模型后，**模型选择器里
仍然看得到它们**；**重启 DSH 后**才正确消失。落盘侧一切正常
（`state.json` 的 `disabledModels.lobsterai` 有 28 条），适配器侧也正常
（`listModels` 每次实时读 `disabledModelsFor()`）。

**根因在客户端缓存，不在本插件的适配器**：`dsh-client-ui-model-selection` 的
`ModelCatalogDirectory` 把 `modelCatalog` 响应存进一个
**`status === 'ready'` 即短路返回缓存**的 store（`lib/client.js` 的 `load()`：
`if (state.status === 'ready' && state.value !== null) return Promise.resolve(state.value)`）。
它只在三个**转发的宿主事件**上 `refresh()`：

```js
ctx.remote.$on('llm/adapters-updated',        () => this.catalog.refresh())
ctx.remote.$on('settings/document-updated',   () => this.catalog.refresh())
ctx.remote.$on('credentials/reference-updated', () => this.catalog.refresh())
```

⚠️ **0.1.7 起黑名单不再走 settings 文档**（改落插件自有文档
`$DSH_HOME/jet-hub/state.json`，见上「持久化」章节），因此写开关**不触发上述
任何一个事件** → 客户端长期复用旧目录，**直到重启**（`connection/reset` →
`resetGeneration()`）才重拉。这正是「不重启不生效、重启就好」的成因。

**修法**：`model.setDisabled` 写完黑名单后显式广播一次
`ctx.emit('llm/adapters-updated')`（`src/jet-hub-rpc.ts`）。选它的理由：

- 按契约它是**无载荷**的「目录可能变了，请重新读 `listModels`」通知
  （dsh-llm README：*consumers re-read the registries*），语义完全吻合；
- 它在 `API_REMOTE_FORWARDED_EVENTS` 白名单里（`dsh-api-remotes`），故会真的送达浏览器；
- **不改变拓扑**，故 dsh-llm 的 invariant 监听（对每个 provider 读一次
  `retryPolicy`）必然通过，不会误报 `INVARIANT`。

⚠️ **广播必须包 try/catch**：通知失败不能反噬**已经落盘**的开关 —— 否则用户看到
「切换失败」而实际已生效，再点一次又因幂等而看似「无效」，比不提示更难排查。

⚠️ **`ctx.emit(name)` 不传 `thisArg`**，故 cordis 的 `dispatch` 里 `filter` 为
`undefined`，所有监听器（含 api-remotes 的转发监听）都会命中 —— 这是该修法成立的
前提（`EventsService.dispatch`：`hook.global || !filter || filter.call(...)`）。

⚠️ **新增任何「只写插件自有文档、却影响模型目录」的端点时，都要照此广播**。
判据是「这次写入会不会改变 `listModels` 的结果」，而不是「是否写了 settings」。

回归用例：`tests/unit/jet-hub-rpc.spec.ts` 的三条 —— 关闭/打开都广播、校验失败
不广播、广播抛错仍算成功（替身必须真的实现 `ctx.emit`，否则生产代码的广播会以
`ctx.emit is not a function` 被 try/catch 静默吞掉，用例形同虚设）。

### ⚠️ 设置页目录必须走 `listAllModels`，不能复用 `listModels`

**真实缺陷**（用户报障「打开的显示了倍率，关闭的就没有显示倍率」）：

`listModels` 会**按黑名单过滤**，于是被关闭的模型**不在其返回值里**。设置页必须
把它们渲染出来（否则用户无法重新打开），端点只能凭 `disabledMap` 的 key（裸 id）
补回 —— 那条路径拿不到展示名，只能退化成裸 id，**倍率与模型名随之丢失**。

故每个适配器都额外提供 **`listAllModels()`**：返回**不套黑名单**的完整目录，
且带**最终展示名**（含倍率、同名消歧）。`model.list` 优先用它，再自行回填
`disabled`；`listAllModels` 缺失时才退化为「listModels + 裸 id 补回」的历史行为。

⚠️ **`ctx.llm` 不透传自定义方法**（DSH 只保证 `listModels`），所以适配器实例必须
由 `index.ts` 显式收集成 `modelAdapters` 传给 `registerJetHubRpc`。五个
`register*Llm` 因此都**返回适配器实例**（而非 `void`）。加新 provider 时别忘两处：
`listAllModels()` + 在 `index.ts` 的 `modelAdapters` 里登记。

⚠️ **同名消歧必须基于未过滤的全量集合**（`displayNameFor(model, source)` 而非
`listed`）：用过滤后的集合会让「关掉其中一个同名模型」改变另一个的变体标记，
名字随开关跳变。

## 目录门控：没有已登录账号就隐藏整个 provider

**需求**：「如果某供应商没有已登录的账号，就不显示该供应商的所有模型，这样对
大多数用户来说模型选择选项卡臃肿的问题能改善很多。」

### 机制：DSH 原生支持「空目录即隐藏」，无需前端改动

`dsh-api-session-controller` 的 `buildModelCatalog` 显式做了

```js
groups: catalog.flatMap(...).filter(group => group.models.length > 0)
```

（注释：*"successful non-empty provider groups"*）。所以适配器 `listModels`
返回 `[]` 就能让整个 provider 分组从模型选择器消失。

两点**必须遵守**：

1. ⚠️ **返回空数组，绝不抛错** —— 抛错会被 `catch` 归入 `failures`，界面上
   反而多出一条 provider 报错，比「不显示」更糟；
2. ⚠️ **不影响路由** —— `routableProviders` 由 `listProviders()` 单独生成
   （不经该 filter），且 DSH 明确约定 *"Catalog membership is advisory and
   never changes routing"*。隐藏目录 ≠ 拒绝请求，已持久化的模型仍可
   `resolveModel` / 正常收发（与黑名单同一契约）。

### 判据：凭据能否解析（**不是**「有没有账号条目」）

`AccountPool.hasLoggedInAccount(provider)`，由
`providerCatalogVisible()`（同文件）包装。两条语义都容易被改错：

| 语义 | 原因 |
|---|---|
| 判据是**凭据可解析** | 服务层的 `logout()` **只 unset 凭据、保留账号条目**（删条目是另一条路径 `removeAccount`）。若只看「有条目」，用户登出后模型仍然显示，门控形同虚设 |
| **不看 `enabled`** | 停用只影响「自动选号」，与「是否已登录」无关。若过滤 `enabled`，把所有账号停用的用户会发现整个 provider 的模型凭空消失。与「续期只看 `refreshable`、不看 `enabled`」是同一条既有约定 |

⚠️ **十个 provider 判据完全一致，没有例外**：早期 CodeArts 曾额外接受固定单凭据
ref（`CODEARTS_ACCESS_TOKEN`），该模式**已移除**，`extraCredentialRefs` 参数一并
删除。老用户若只用固定 ref 登录过，模型列表会变空 —— 需在 Jet Hub 重新登录一次
（用户已确认接受，不做自动迁移）。

### 保守放行的三种情形（门控是**展示优化**，不是安全边界）

1. `accountPool === undefined`（headless / CLI / 单测）；
2. 替身未实现 `hasLoggedInAccount`（**能力检测** —— 大量既有单测只 mock 了
   `disabledModelsFor`）；
3. 读凭据抛异常（存储损坏等）。

三种都返回「可见」：判定不可用时**宁多勿少**，否则会让用户看到「所有模型凭空
消失」且无从排查。

### 开关与落点

- `DSH_HIDE_MODELS_WITHOUT_ACCOUNT` —— **默认开启**，只有显式假值
  （`0`/`false`/`no`/`off`）才关闭。与 `DSH_TRAE_MAX_MODE` 同为「默认开」语义，
  故用**独立的** `resolveHideWithoutAccountFlag`，不要与 `isTruthyFlag`
  （「默认关」）混用。
- 门控放在各 `listModels` 的 **`ensureRemoteModels()` 之前**：无账号时连远端
  目录都不必拉（省一次无谓 HTTP）。
- ⚠️ **门控只加在 `listModels`，`listAllModels`（设置页）不受影响** ——
  否则用户关掉模型后连开关都看不到，更无法重新打开（这是此前修过的真实缺陷）。
- 六个适配器的 `listModels` 都要加（`llm-adapter` / `buddy` / `lobsterai` /
  `qoder` / `trae`）。`buddy` 与 `workbuddy` 共用同一个适配器类，但
  `this.product.id` 不同 → 两者按各自 provider 独立判定，互不影响。

## ⚠️ 停用账号时可选「同时停用该 provider 的模型」

**真实需求**（用户报障）：「我关闭了 qoder，模型列表中没有关闭，在对话中还是可以
选择到它的模型」。

### 根因：门控判据**刻意**不看 `enabled`

见上「目录门控」章节 —— 这是**整体设计**（停用只影响自动选号），不是缺陷。但它带来
一个用户可感知的落差：停用某 provider 的**最后一个**启用账号后，该 provider 在账号池
里已不可用，可它的模型**仍留在模型选择器里**（凭据还在，门控判为可见）。用户只能再
去「显示列表」里把几十上百个模型逐个关掉 —— 这正是 `state.json` 里 qoder 的 17 个
模型被手工全关、trae 的 41 个同样全关的由来。

### 修法：变成一次**显式选择**，而不是改门控语义

用户明确要求保持原设计。故在 `ProviderPanel.toggleAccount` 里加联动询问，
纯逻辑在 **`plugin-src/client/account-model-link.js`**：

- `disablingLeavesNoEnabledAccount(accounts, accountId, provider)` —— 停用后该
  provider 是否**不再有任何启用账号**；
- `allModelsDisabled(models)` —— 该 provider 的模型是否**全部已关闭**（且非空）。

| 方向 | 触发条件 | 询问 |
|---|---|---|
| 停用 | 停用后该 provider 再无启用账号 | 是否同时**关闭**它的全部模型 |
| 启用 | 此前无启用账号，且模型恰好全关 | 是否同时**打开**它们 |

### ⚠️ 五条不能改错的语义

1. **判定必须在 `account.update` 提交之前取**。提交后列表已刷新，「是否还有启用账号」
   的答案就变成变更后的状态了 —— 多账号场景下会误判。
2. **只在「最后一个启用账号」时提示**。该 provider 还有别的启用账号时，它的模型依然
   可用，关掉全部模型纯属**误伤**。
3. **只看同一 provider**。别的 provider 有启用账号与本 provider 的模型是否可用毫无
   关系 —— 若实现成「全表还有启用账号就不提示」，多 provider 用户永远不会收到提示。
4. **两个方向都必须由用户决定，不做静默联动**。静默关闭会让「停用账号」这个看似与
   模型无关的操作产生意外副作用；静默打开则可能把用户特意关掉的模型放出来。
5. **联动失败只提示、不回滚账号状态**。账号停用/启用已经落盘，此时把整次操作报成
   失败会让用户以为账号状态没变，再点一次又因幂等而看似「无效」。故只提示、让用户
   可去「显示列表」手动处理。

另外两点性能考虑：

- 启用方向**只在「此前一个启用账号都没有」时**才读模型目录（`isFirstEnabled`）。
  否则每次启用账号都会多发一次 `model.list` —— Cline 那次的目录有近 500 条。
- 目录读不出来时**静默跳过联动**：账号启用本身已经成功，不该因目录故障而报错。

### 与门控的边界

⚠️ **本联动不改变 `hasLoggedInAccount` 的判据**。「停用账号」与「是否已登录」仍是
两件事；联动只是替用户把「模型可见性」这件事**顺手做掉**，且必须经用户确认。
若将来有人想把 `enabled` 直接并入门控判据，先回看「目录门控」章节里那条
「若过滤 `enabled`，把所有账号停用的用户会发现整个 provider 的模型凭空消失」——
那正是本联动选择「询问」而不是「静默」的原因。

回归用例：`tests/unit/model-filter.spec.ts`（27 条）、
`tests/unit/account-model-link.spec.ts`（18 条）、
`tests/unit/jet-hub-rpc.spec.ts` 的 `model.setDisabledBulk` 段（14 条）、
`tests/unit/account-pool.spec.ts` 的 `setModelsDisabledState` 段（8 条）。

## ⚠️ 模型行布局：长 id 会把开关挤出可视区（真实缺陷）

**用户报障**：「cline 功能是具备的，不过针对某一个模型的开关在最后，需要横向滑动，
我没有看到」。

### 根因：CSS 让行横向溢出，开关被推出弹窗

**不是功能缺失** —— 开关一直在渲染，只是**看不见**。三处收缩约束缺失叠加：

| 位置 | 错误写法 | 后果 |
|---|---|---|
| `.dim-jh-modelList` | 单列 grid 未写 `grid-template-columns` | 列宽默认 `auto`，按**最宽内容**撑开 |
| `.dim-jh-modelRow` | 无 `min-width: 0` | grid 项的 `min-width` 默认 `auto`，**拒绝收缩** |
| `.dim-jh-modelId` | `flex: none` | 保持内容宽度，**直接把开关顶出去** |

三者叠加 → 整行溢出弹窗 → 排在 id 之后的开关被推到可视区外。
Cline 有 **300 个 id 超过 20 字符**（最长 56），所以几乎每行都中招。

**这正是该 provider 在 `state.json` 的 `disabledModels` 里长期为空的原因** ——
不是用户不想关，是**根本看不到开关**。（与「缺搜索/筛选」是两个独立问题：
搜索解决"找不到某个模型"，本缺陷解决"连开关都看不见"。）

### 修法：三处收缩约束，缺一不可

```css
.dim-jh-modelList { display: grid; grid-template-columns: minmax(0, 1fr); gap: 2px; }
.dim-jh-modelRow { display: flex; align-items: center; gap: 12px; min-width: 0; ... }
.dim-jh-modelId { flex: 0 1 auto; min-width: 0; max-width: 46%; ... }
.dim-jh-modelName { flex: 0 1 auto; min-width: 0; ... }
/* 兜底：任何一行偶然溢出都不该让整个弹窗横向滚动 */
.dim-jh-modalBody { ...; overflow-x: hidden; }
```

⚠️ **开关自身必须保持 `flex: none`** —— 它是目标控件，绝不能参与收缩。

### 验证方式（可复用）

`verify-layout.mjs`（工作区根目录）：**从真实源码模块提取 STYLES** 渲染
`repro-real-source.html`，再用无头 Edge 截图 + 在页面内测量开关右边缘是否超出
body 可视区。用真实源码而非 CSS 副本，避免「复现页改好了、源码没改」的假阳性。

实测结果（8 行，含最长 id）：

```
弹窗内容宽 = 560px
列表横向溢出 = 否
body 横向滚动 = 否
开关被挤出可视区 = 0 / 8 行
```

修复前同法实测：**8 / 8 行的开关全部不可见**。

⚠️ **这类缺陷单测抓不到**（react 不在依赖内，无法渲染），故用
`tests/unit/model-filter.spec.ts` 的「模型行布局」段做**源码级**断言，
逐条锁住上面四处约束。反向验证：把 `flex: 0 1 auto` 改回 `flex: none`、
去掉 `minmax(0, 1fr)`、去掉 `overflow-x: hidden` —— 三次都各触发 1 条失败。

### ⚠️ 改 `jet-hub-styles.js` 时：注释里不能出现反引号

该文件整体是 **JS 模板字符串**（`const STYLES = \`...\``），注释里的反引号会
**提前终止字符串**、导致 esbuild 报 `Expected ";" but found "..."`。
本次就因此构建失败过一次 —— 说明 CSS 属性时一律不加反引号。

## 模型面板的搜索与筛选（**不含多选、不含渲染上限**）

**用户需求**：Cline 的远端目录实测约 **478 条**（`/api/v1/models` 458 条 +
`recommended-models` 的 free/recommended/clinePass 6/4/14 的并集），需要一个
搜索框与状态筛选来定位模型。**搜索与筛选确实有用，已保留。**

纯逻辑在 **`plugin-src/client/model-filter.js`**（`filterModels` / `isFilterActive` /
`matchesModelQuery` / `normalizeStatusFilter`），与 `model-bulk.js` /
`account-order.js` 同理单独成文件：本仓库单测环境里 react 不在依赖内，组件无法
渲染，抽成纯函数才能用真实断言覆盖。

### ⚠️ 四条不能改错的语义

1. **未知筛选值必须退化为「不筛」**（`normalizeStatusFilter`）。若实现成「非 all 即
   按 enabled 筛」，一次拼错的取值（`'Disabled'`）会让列表只剩已打开的模型，
   用户看到「模型少了一大半」而没有任何错误提示。`isFilterActive` 必须与它
   **保持一致**，否则会出现「判定说有筛选、实际一条都没筛」的错位。
2. **空搜索词命中全部**（那是"未搜索"，不是"搜索空串"）。
3. **`disabled` 判定用 `=== true`**：与适配器黑名单的「只有显式 true 才算关闭」
   同一语义。用 `!== false` 会把未声明该字段的条目误判为已关闭。
4. **筛选无结果必须与「该 Provider 没有模型」分开提示**。合并成一句会让用户以为
   模型全丢了，而实际只是搜索词没命中。

### ⚠️⚠️ 两个曾被错误引入、已回退的设计（**不要重新引入**）

#### 1. 多选勾选框 —— 破坏了既有点击交互

**背景（我的误判）**：我曾把「Cline 模型列表关不过来」归因为"缺搜索/筛选/多选"，
并据此给每行加了多选勾选框 + 「全选筛选结果 / 打开选中 / 关闭选中」+ 新端点
`model.setDisabledBulk`。**但用户明确指出问题 2 原本没有问题** —— 真正的缺陷是
**问题 1 的布局溢出**（见上一节），修好布局后开关本就可见可用。

**多选造成的真实行为倒退**（无头 Edge 实测确认）：

`ModelToggle` 的根元素是 **`<label>`**。原先 label 内只有 1 个 checkbox，
点行内任意位置（含模型名）都会激活它 —— 即「点模型名切换可见性」，这是既有交互。
一旦插入第二个 checkbox（多选勾选框），浏览器把点击激活到**第一个**可标记控件：

| 操作 | 单 checkbox（正确） | 双 checkbox（倒退） |
|---|---|---|
| 点行内**文字**（模型名） | 切换可见性开关 ✅ | **切换了多选勾选框，可见性开关纹丝不动** ❌ |
| 点开关本身 | 正常 ✅ | 正常 ✅ |

**结论**：⚠️ **`ModelToggle` 内必须保持只有 1 个 checkbox**。若将来确需多选，
**必须先把行容器从 `<label>` 改成 `<div>`**（并自行处理点击切换），否则必然重踩。
回归用例见 `tests/unit/model-filter.spec.ts` 的「ModelToggle 内只有 1 个 checkbox」。

#### 2. 渲染上限 200 条 + 「显示更多」 —— 属于功能收缩

改动前 478 条本来就是**一次性全渲染、工作正常**。加渲染上限后，超出的条目需要
额外点一次「显示更多」才能看到 —— 这是**凭空多一次点击**，属于功能收缩，已移除。
**不要再加回来**，除非有实测证明渲染确实卡顿（届时也应按 `filtered` 而非
`visible` 计算批量操作范围）。

### ⚠️ 搜索框自身的两处真实缺陷（用户报障，已修）

> 「搜索框在深色模式下输入的文字是白色的和底色一样看不见文字」
> 「输入文字后整个弹框的位置会发生改变，有点突兀」

两条都是**新增搜索框时引入**的，都已在本地复现确认并修复：

#### 1. 深色模式白字白底 —— 引用了**不存在**的主题 token

`.dim-jh-input` 的背景原写作 `var(--dsw-alias-bg-input, #fff)`，而主题里
**根本没有** `bg-input` 这个 token（真实的是 `bg-base` / `bg-layer-1/2/3`）。
`var()` 遇不存在的 token **不报错**，静默取 fallback `#fff` → 深色模式下
浅色文字配白底，文字完全看不见。

修法：改用官方 `Input` 原语同款的 `--dsw-alias-bg-layer-1`，并**去掉浅色
fallback**（宁可取不到值时背景异常、能一眼看出，也不要一个看起来正常却在深色
模式下毁掉可读性的 fallback）。placeholder 另用 `--dsw-alias-label-dimmed`。

⚠️ **审计工具**：`audit-tokens.mjs`（工作区根目录）会扫描插件样式里所有
`var(--dsw-*)` 引用，比对主题真实定义的 395 个 token，列出**不存在**的那些。
新增/修改样式后应跑一次 —— 这类缺陷单测抓不到（CSS 变量解析不在测试环境里）。
（该脚本同时报出既有的 `--dsw-alias-border-default`，属登录弹窗的历史问题，
与本次改动无关，未一并处理。）

#### 2. 输入文字后弹窗位置跳动 —— `align-items: center` + 高度随内容变化

弹窗高度随列表长度变化，而遮罩用的是 `align-items: center`，于是**高度变化直接
变成整体位移**。实测输入搜索词后弹窗 `top` 从 4px 跳到 **187px**（结果变少 →
弹窗变矮 → 居中的位置跟着上移），观感突兀。

修法：模型列表弹窗改为**顶部锚定**（`.dim-jh-modalOverlay--top`，
`align-items: flex-start` + `padding-top: max(24px, 8vh)`），上边缘固定、
只在下方伸缩。实测三种状态 top **恒为 38px、位移 0px**。

⚠️ 顶锚后 `max-height` 必须按 **padding box** 计算（`100%`），不能再用
`100vh - 48px` 这类视口算式 —— 否则 `8vh` 大于 `24px` 时会溢出视口。

⚠️ 该修饰类**只作用于模型列表**，账号备份弹窗仍用垂直居中。

### 验证方式（可复用）

`verify-searchbox.mjs`（工作区根目录）：从**真实源码模块提取 STYLES**，在模拟
深色 token 的页面里渲染，然后用无头 Edge 测量：

- 搜索框背景/文字色的**对比度**（实测 13.54:1，WCAG AA 要求 4.5:1）；
- 三种搜索状态下弹窗 `top` 的**位移**（实测 0px）；
- 回归断言问题 1 的布局（开关被挤出 **0 / 8 行**）。

⚠️ 单测抓不到布局与 CSS 变量解析，故用源码级断言 + 该脚本双重锁住。

## ⚠️⚠️ 注入的 `<style>` **必须署名** `data-plugin`，否则会被别的插件认领后连带删除（Issue IKK764）

**用户报障**：Jet Hub 面板的整套 `.dim-jh-*` 样式，在**安装 / 更新 / 禁用任意一个别的插件之后**
立刻退化成浏览器默认样式（标题没层级、按钮变原生控件、卡片配色圆角全丢）；
**F5 刷新（或重启 DSH）后恢复**，但下一次再装/改插件又复发 —— 用户侧看起来就像「这个插件坏了」。

### 根因：不是 CSS 写错，是注入的 `<style>` **没有署名**

宿主 `@deepseek-ai/dsh-client-modules`（`lib/client.js`）对样式标签有**归属机制**：

| 函数 | 判据 | 位置 |
|---|---|---|
| `claimStyles(id)` | 对 `querySelectorAll('style:not([data-plugin])')` 的**每一条** `setAttribute('data-plugin', id)` | `client.js:492-498` |
| `removeOwnedStyles(id)` | 删除 `style[data-plugin="<id>"]` | `client.js:194-197` |
| `materialize` 调用点 | factory 执行**之后** `claimStyles(ownerId)` | `client.js:684` |

即：**任何无主的 `<style>` 都会被认领给「当前正在物化的那个插件」**。
而 `installJetHubStyles()` 是在 `ctx.effect(...)`（插件 apply 阶段）里注入的，
**必然晚于自己那次 `claimStyles`** ⇒ 旧实现（无署名）下这条标签**始终无主**。

之后任何一个插件物化都会把它认领走；等那个插件热重载 / 被 prune / 被禁用 / factory 抛错，
宿主就把「它名下」的样式**连根删掉**：

| `removeOwnedStyles` 的触发路径 | 行 |
|---|---|
| `updateManifest`（该行 revision 变化） | `client.js:796` |
| `prune`（该行不再被引用） | `client.js:821` |
| 条目被替换 `replace` | `client.js:367` |
| factory 抛错 | `client.js:690` |

宿主 README 把它写作设计：*graph updates discard stale unowned factories, their styles*。
而「安装/修改插件」本身就是一次 graph update ⇒ **每次都必然踩到**。

⚠️ **让问题无法自愈的是模块级 `injected` 布尔**：标签被外部删除后，即使 apply 再跑
也直接 `return`，永远不再补注 —— 这就是「只有整页刷新才恢复」的成因。

⚠️ **影响是全局的**：`lib/client/jet-hub.js` 整包**只有这一处**
`document.createElement('style')`（源码 1 处、产物 1 处，已用 grep 精确计数），
该标签承载全部 `.dim-jh-*` 规则 ⇒ 掉的是**整套 UI**，不是局部。

### 修法：署名 + 幂等改 DOM 存在性判断

`plugin-src/client/jet-hub-styles.js`（DSH 自家构建预设产出的插件就是这个形状，
本机实测 `dshmarket` / `dsh-rewind-plugin` 都写了 `tag.dataset.plugin`）：

```js
const PLUGIN_ID = 'dsh-providers-hub'          // = build.mjs 的 loaderId（必须等于包名）
const STYLE_TAG_ID = PLUGIN_ID + '/jet-hub.css'
const STYLE_SELECTOR = 'style[data-plugin-css=' + JSON.stringify(STYLE_TAG_ID) + ']'

export function installJetHubStyles() {
  if (document.querySelector(STYLE_SELECTOR) !== null) return () => {}   // DOM 存在性，不是模块级布尔
  const style = document.createElement('style')
  style.dataset.plugin = PLUGIN_ID        // ← 关键：署名
  style.dataset.pluginCss = STYLE_TAG_ID
  style.textContent = STYLES
  document.head.appendChild(style)
  return () => { document.querySelector(STYLE_SELECTOR)?.remove() }
}
```

⚠️⚠️ **`PLUGIN_ID` 必须等于包名**（同一条腿的另一个入口，见
[issue IKLUME](#⚠️⚠️-包名--插件身份四处载体必须逐字相同issue-iklume)）：宿主用的
`ownerId` 是 `stripClientSuffix(registration.id)`，而 `registration.id` 就是构建脚本
注入的 loader id（本插件产物顶部 `window.__ModuleLoader__.load({ id: "dsh-providers-hub", ... })`）。

⚠️ **代价要说准，不要夸大**（2026-10 审计修正）：署名错了**不会**让 IKK764 原样复发 ——
本插件自己闭包里的 disposer 照样会删掉自己那张表。真实代价只有两条，且都**静默**：

1. 宿主侧样式 inventory 里**没有它**（`claimStyles(ownerId)` 认不走 ⇒ `data-plugin-css`
   这条腿在宿主那里等于不存在）；
2. 宿主的两道安全网对它失效（别的插件的 `claimStyles` 认领不走它、宿主的 `prune`
   也回收不掉它）—— 失效方向是「少了一层保护」，不是「多了一次误删」。

⚠️ **本文件不得再出现模板字符串**：整份文件只允许 `STYLES` 首尾那两个反引号
（三条既有护栏用例会计数，2026-10-08 我加 `data-plugin-css` 时用模板字符串
接线，一次触发 3 条红）。故 `STYLE_TAG_ID` / `STYLE_SELECTOR` 一律用 `+` 拼接。

⚠️ **不需要 MutationObserver**：署名之后，唯一还能删掉这条标签的是
`removeOwnedStyles('dsh-providers-hub')`，它只出现在两条路径 ——
`replace(自己)`（factory **必然重跑**，DOM 存在性判断随之复位）与
`prune`（此时本插件已不在模块图里，删样式是**正确**行为）。「DOM 存在性判断」已覆盖。

### 验证（可复用）

`tests/unit/jet-hub-styles-ownership.spec.ts`（10 条）：

- 断言全打在**可观察 DOM 结果**上（标签条数 / `data-plugin` 归属 / 认领与回收后是否幸存），
  不是源码字符串 —— 因此对实现方式中立；
- 宿主那侧的 `claimStyles` / `removeOwnedStyles` **优先取真实实现** —— 从已安装的 DSH
  （`require.resolve` → 全局 `node_modules` → 用户 profile）里抽取两个函数的**真实源码**求值；
  找不到时（干净克隆 / CI）退化为同语义内联实现，并**干净跳过**对拍用例；
- 一条「扫描面有效性」护栏：定位到宿主时硬断言其**判据语义**未变
  （`style:not([data-plugin])` / `factory(...)` 后紧跟 `claimStyles(ownerId)`），
  否则本文件会静默失效。

⚠️ **已做反向验证**（四种变异各自独立锁死，**不是同一反复**）：

| 变异 | 变红条数 |
|---|---|
| 去掉署名（保留 DOM 存在性幂等） | 6 |
| 幂等改回模块级布尔（保留署名） | 5 |
| `PLUGIN_ID` 与 `loaderId` 不一致 | 7 |
| disposer 改成删「所有」`style[data-plugin]`（过度删除） | 1 |

⚠️ 变异 4 最初**全绿**（用例没抓住）—— 因为原 disposer 用例只验「删自己」、
没验「不删别人的」，现已补上该断言。**这就是反向验证的价值**。

⚠️ 另用独立脚本驱动**真实发布产物** `lib/client/jet-hub.js`（本机 profile 是 `link:` 到它）
跑过同样的 8 步：署名正确、别的插件认领不到、回收后幸存、外部删除后 apply 能自愈。
产物与源码构建结果经 sha256 逐字节比对确认同源。

⚠️ 变异验证时**不要**用 `git checkout -- <文件>` 还原（AGENTS.md 明令禁止）——
本项目已因此丢过两次未提交的修复（2026-10-08 一次、2026-10 审计 IKLUME 一次）。
还原应当用**事先备份的副本**（如 `$env:TEMP` 下的备份），或 `git stash` 之外的安全手段。

## ⚠️⚠️ 包名 = 插件身份：四处载体必须逐字相同（issue IKLUME）

**真实缺陷**（Gitee issue IKLUME）：`0.2.0-rc.11` 把包名从 `dsh-codearts-auth` 改成
`dsh-providers-hub` 时，`build.mjs` 的 `loaderId` 与 `jet-hub-styles.js` 的 `PLUGIN_ID`
**一起**留在了旧名上，而宿主那侧从来没有变 —— 它按**加载行名解析出的包名**建 client entry。
于是前端产物注册 `dsh-codearts-auth`、宿主等 `dsh-providers-hub` ⇒ 该 entry 永远
import 不到，启动即 `N entry did not activate`，桌面端落进恢复模式并把插件自动禁用。

### 四处载体（缺一处都是静默失效）

| # | 位置 | 谁在读它 |
|---|---|---|
| ① | `package.json` 的 `name` | **唯一真源**。宿主 `locatePkgJson()` 用 `nearestPackage(moduleUrl, expectedPackageName)` 校验它，`reconcilePackage(packageName)` 以它作 client graph 的**行 id** |
| ② | `cordis.patch.yml` 加载行的 `name:` | 宿主 `resolveSource()` 读的**输入**；不匹配则 client 半边**静默跳过**（不是报错） |
| ③ | `build.mjs` 产物首行 `__ModuleLoader__.load({ id })` | 前端 `register(registration)` 用 `registration.id`；宿主按它报 `loaded without registering "<pkg>"` |
| ④ | `jet-hub-styles.js` 的 `PLUGIN_ID` | 样式标签的 `data-plugin` == 宿主 `ownerId`（见上一节） |

⚠️ **① 之外的三个都必须从 ① 派生或与 ① 对齐**。③ 现在**直接由 ①（`package.json.name`）
生成**，不再有字面量；④ 仍是字面量（浏览器模块运行期读不到 `package.json`，
彻底消除它需要 esbuild `define` 构建期注入，**本轮刻意不做**），但已被
**安装期闸门** + **行为用例**双重锁住。

⚠️ **不要动**这两个里的 `codearts-auth`：`cordis.patch.yml` 加载行的 `id: codearts-auth`
（loader 行锚点，与包名无关）与 `src/index.ts` 的 `export const name`（cordis 插件名）。
同理 `JET_HUB_NS = 'jet-hub'`、`~/.dsh/jet-hub/` 状态目录、日志前缀、凭据 ref 前缀
**全都与包名解耦**，改名时一个都不要跟。

⚠️ 上面这组「与包名解耦」是**核过读点**的（2026-10 审计要求补证据，原先属未举证断言）：
`git grep codearts-auth -- src/ plugin-src/` 命中的全部是**日志前缀**、五处 store 的
`schema`、`BACKUP_FORMAT`（真读点，见本节末尾的落盘标记表）与 `cordis.patch.yml` 的行
`id:`；**没有任何一处把它与 `package.json.name` 比较**。`src/index.ts:184` 的
`export const name = 'codearts-auth'` 是 cordis 插件名 —— 它的对齐对象是 patch 行的
`id:`，**不是**包名，所以它不是第 5 个身份载体；但它同样没有守卫，改名时容易被顺手
误伤，故在此点名。

### ⚠️⚠️ 安装期闸门：`pnpm add git+…` 不跑 vitest

`plugin-src/client/build.mjs` 在构建前跑一次**身份自检**（判据本体住在
`plugin-src/client/registration-id-check.mjs`，与单元测试**共用同一份**），不一致就
**抛错中止**。⚠️ 它检查的**不是**「②③④ 都与 ① 逐字相同」这么整齐的一件事
（2026-10 审计指出原话夸大：③ 本来就是从 ① **派生**的，谈不上「对齐」）——
真正被检查的是这四条：

1. ② `cordis.patch.yml` 的**加载行 `name:`** == ①；
2. ④ `jet-hub-styles.js` 的 `PLUGIN_ID` **声明** == ①；
3. ④ 的**署名使用点**没有写死字面量（`.plugin = '…'` / `setAttribute('data-plugin', '…')`）；
4. **产物文本里回读到的注册 id** == ①（这一条与 ③ 的生成方式是两件事）。

这条**必须**放在构建脚本里，理由（审计实测）：

- `pnpm add git+https://…` 走的是 `prepare → build:all`（`tsc` + `copy-assets` + `build.mjs`），
  **一次 vitest 都不会执行** ⇒ 单元测试里的守卫在**安装路径上保护力为 0**；
- 构建脚本在**两条路径上都跑**（安装时经 `prepare`、开发时经 `pnpm build:client`）。

熔断形态（改一处身份载体 ⇒ 文案指名到具体载体；改**产物生成方式** ⇒ 走下面第二条）：

```
Error: 客户端注册 id 自检失败（issue IKLUME）：
- plugin-src/client/jet-hub-styles.js 的 PLUGIN_ID 必须是 "dsh-renamed-again"，实际 "dsh-providers-hub"（…）
- cordis.patch.yml 的加载行 name: 必须是 "dsh-renamed-again"，实际 "dsh-providers-hub"（…）
```

```
Error: 内部错误：产物里注册的 id 是 "dsh-codearts-auth"，与 package.json 的 name "dsh-providers-hub" 不一致
```

⚠️ 第二条是 **2026-10 对抗审计第一轮打穿后补的**，也是唯一「**不改任何身份载体、
只改产物的 id 生成方式**」也拦得住的一格（见下）。

### ⚠️⚠️ 闸门自己的四个洞（2026-10 两轮对抗审计，均已修）

第一版闸门能拦「载体之间不一致」，但它自己有四个洞，其中三个是**零守卫**：

| # | 洞 | 审计实测 | 现在的判据 |
|---|---|---|---|
| F1 | 写盘前的自检 `if (!wrapped.startsWith(header))` 是**恒真式**（`wrapped` 就是用 `header` 拼出来的） | 把产物 id 换成**写死的旧名** ⇒ 构建 **exit 0**、产物注册错名，而 stdout 照样打印 `registered id: dsh-providers-hub`（**成功日志谎报**） | 从**最终文本回读** `readRegisteredId()` 再比对（实测：同一变异现在 exit 1、且**产物没被写坏**） |
| F2 | 只校验 ④ 的**声明**，不校验**使用点** | 把 `style.dataset.plugin` 的取值写成字面量 ⇒ 闸门 exit 0（单测红 8 条） | 闸门扫使用点；单测有专门一格（实测红） |
| F3 | 闸门**本体零守卫**：`if (problems.length > 0)` 改成 `if (false)` ⇒ **21/21 全绿**（全仓找不到一条**代码**引用 `build.mjs`） | 同上 | ① 判据搬进 `registration-id-check.mjs`，单测用**临时目录夹具**直接打（6 条，含反向验证）；② `build.mjs` 改成**顶层无条件调用**（没有分支可以短路）；③ 再加一条**接线断言**（必须 import 且顶格调用）—— 实测：删掉调用 ⇒ 恰好那条红 |
| F8 | 同一判据**两份**且语义不同（闸门「每一处 `name:` 都等于包名」vs 用例 `toHaveLength(1)`） | `cordis.patch.yml` 里放两条**都正确**的 `name:` ⇒ 闸门绿、用例红 | 收敛成**共享模块**：用例只断言「真实仓库 `checkRegistrationId(…) === []`」 |

⚠️ 还修了两类**假红**（判据把合法写法判成错）：

- **合法 YAML 尾注释**：`name: "dsh-providers-hub" # 加载行` 被旧判据报成
  「**没有找到**加载行 name:」并让安装硬失败 —— 最坏的一种误导（把惯用写法说成
  「你没写」），而真实的 `yaml` 解析器读到的值是对的（审计实测）。现在**先剥行尾
  注释**（引号内的 `#` 不当注释）。
- **产物头部逐字节锚定**：旧用例断言 `toContain('window.__ModuleLoader__.load({\n  id: "…",')`，
  把头部**多行改单行**（行为等价，只读探针实测 `executed=1`）判红 2 条。现在用
  `readRegisteredId()` 的正则回读，对形态不敏感（⚠️ 而**回读本身**必须有，否则就是
  F1 那个恒真式 —— 两者是一枚硬币的两面）。

⚠️ **已知射程**（不要当成全覆盖）：

- 使用点判据只拦「直接写字面量」；把正确的声明复制进同名遮蔽作用域再用它署名
  （审计 G13）拦不住 —— 那一格由**行为用例**拦（实测 8 条红），而行为用例在安装
  路径上不跑。
- 加载行判据**对缩进深度不敏感**：`config:` 块里的 `name:` 也会被当成加载行
  （审计 G5，合成场景；10 个真实 patch 无反例，标**推断**）。
- `package.json` 的 `name` 首尾带空白 ⇒ 已单列一条指出**真因就是它自己**
  （审计 F9：原先两条 problem 都在指责另外两处载体，把该改的地方藏起来了）。

### ⚠️ 宿主真身不在场时：需要宿主的那两条断言会**整组跳过**

`tests/unit/client-registration-id.spec.ts` 里只有**两条**断言真的需要宿主真身
（`@deepseek-ai/dsh-client-modules/lib/client.js`）：装载成功、以及它的反向验证。
本仓库 devDependencies **不含**这个包（宿主侧包，只随 DSH 安装），所以：

- 找不到时那两条 `describe.skip`，并**在控制台显式告警**（审计 F6：原先整组静默跳过、
  `vitest` 仍 exit 0 —— 等于把「绿」当成「验过」）；
- **不需要**宿主的断言（产物 id 回读、安装期闸门本体、三处载体一致性）**刻意留在
  skip 组之外**，干净克隆 / CI 上仍然真的在验；
- 要强制验真身（例如 CI 里挂了 DSH）用 **`DSH_HOST_CLIENT=<client.js 绝对路径>`**；
  此时路径不存在会**抛错**而不是回退 —— 那是「必须验」的显式承诺，静默回退会骗人。

⚠️ 三级查找（本仓库依赖树 → 运行测试的 node 的全局 `node_modules` → 用户 profile）
的**排序**只有源码可读，本机只有一份宿主副本故未实测；换一台装了多个 DSH 的机器时
可能拿到与运行时不同版本的那一份。

### ⚠️⚠️ 判据必须打在**行为**上，不能读源码正则

上一版守卫（PR !98 引入）用正则读 `build.mjs` / `jet-hub-styles.js` 里的字面量再比对包名。
变异验证（10 个变异体 + 5 个边界体）实测它同时具备**三类假红**与**两类假绿**：

| 形态 | 变异 | 旧守卫 |
|---|---|---|
| 假红 | `build.mjs` 改从 `package.json` 读包名（issue 自己推荐的修法；产物 SHA256 **逐字节不变**） | 红 |
| 假红 | `const loaderId = "dsh-providers-hub"`（改双引号，行为等价） | 红 |
| 假红 | 真定义上方多一行**写着旧名**的注释（`// const loaderId = 'dsh-codearts-auth'`）—— 正则读到注释里的值，而产物其实是对的 | 红 |
| **假绿** | 注释诱饵写新名、真定义留旧名、且**不重建** ⇒ 被断言的**真定义**根本不生效 | **全绿** |
| **假绿** | 只动产物：`id: "wrong-id", // was id: "dsh-providers-hub"` | **全绿** |

⚠️ 第三行**原先写作「注释放新名也红」，那是错的**（2026-10 第二轮审计实测纠正）：
旧正则 `/const loaderId = '([^']+)'/` 取**首个**匹配，注释里放新名时读到的就是正确值
⇒ 照常**绿**。要让这一格红，注释里必须放**旧名**，而那时它是「产物对、断言红」的
假红 —— 与第四行「同一个变异、相反结论」，这本身就说明旧判据不可信。

⇒ 现行判据换成 **`tests/unit/client-registration-id.spec.ts` 的端到端装载**：
拿**真实的** `lib/client/jet-hub.js` 字节，交给**真实的** `dsh-client-modules` 加载器
（`createClientModuleSystem` + 一行 boot 图）按包名 `prefetch`，装载不上就红。
它对引号形态、注释诱饵、产物陈旧免疫；对头部**形态**重构（多行改单行）也免疫
（回读用正则，不逐字节锚定 —— 见上面那一组假红）。并且内含一条**反向验证**
（把产物 id 换掉 ⇒ 必须以 issue 原文的三段报错刷红），证明它**不是恒真**。

⚠️ 而「② 的直读断言」（`cordis.patch.yml` 的 `name:`）现在**与安装期闸门共用
`registration-id-check.mjs` 的 `checkRegistrationId()`** —— 这一处在旧守卫下**零守卫**
（`git grep cordis.patch.yml tests/` = **0**，把它改回旧名全绿），而且两份判据语义不同
还会互相矛盾（闸门「每一处都等于包名」vs 用例「恰好一条」），已收敛为一份。

⚠️ 本节数字（「17/17」等）已按 AGENTS.md 自己的规矩删除：条数是**必然腐坏**的快照，
以 `pnpm test` 输出为准。

### ⚠️ 改名的**第三条腿在用户机器上**（本仓库修不完）

宿主在 **profile** 里按**包名字符串**寻址 bundle
（`dsh-app-boot` 的 `resolveBundleDir()` → `node_modules/<name>`，**不校验** manifest 的
`name`），而老 profile 两处都锁着旧名：

```jsonc
// ~/.dsh/profiles/<name>/package.json
{ "dependencies": { "dsh-codearts-auth": "link:…" },
  "dsh": { "profile": { "bundles": [ …, "dsh-codearts-auth" ] } } }
```

⚠️ **这一格的失败是静默的**：`resolveBundleDir` 抛错 ⇒ 该 bundle 进 `skippedBundles` ⇒
**插件行根本不插入**，宿主只在 stderr 留一行（无异常、无 UI 提示）。

⚠️ 别把它与「两处**都**不改成」那一格混为一谈（2026-10 审计指出同一补丁里三处表述
互斥：README 顶部说「静默消失」、README 对照表第一格说「界面不出现」、本节说
「`N entry did not activate` + 自动禁用」）。权威表述是本节的这一条：

- **两处都锁旧名**（老 profile 的现状）：bundle 目录**解析得到**，但包里 patch 的
  加载行写的是**新包名**、它在「profile 目录」这个解析基准下解析不到 ⇒ **该行在宿主
  侧 import 失败** ⇒ 宿主报 `N entry did not activate` 并把插件**自动禁用**；
  宿主 `preflight()` 只 deny「兼容性冲突」，其余失败**留给 cordis Loader 自己报**。
  这与「静默消失」**同向但更准确** —— 症状不是「UI 少了一块」，而是插件被禁用。
- **只改一处**（无论哪一处）：走上面那条 `skippedBundles` 的**静默**路径。

两处**必须一起改**。推荐不手改，用 `dsh plugin --profile <name> remove/add` 各走一遍，
且**逐个 profile 都要走**（本机 `desktop` / `headless` / `tui` / `web` 四个都锁旧名）；
迁移说明见 README「⚠️ 从旧包名 `dsh-codearts-auth` 升级」。

### ⚠️ 改名时**必须保留旧值**的落盘标记

| 位置 | 是否真读点 | 依据 |
|---|---|---|
| `src/types.ts` 的 `BACKUP_FORMAT`（`dsh-codearts-auth/backup`） | ✅ **真读点** | `src/backup.ts` 里 `record.format !== BACKUP_FORMAT` 即抛 `BackupFormatError` ⇒ 改了老备份**全部读不出**；`plugin-src/client/backup-convert.js` 里同一字面量的副本也真读（`looksLikeForeignAccountList()` 会因此把老备份**误判成外域账号清单**） |
| `plugin-src/client/backup-crypto.js` 的 `format` | ⚠️ **写点无读点** | `isEncryptedBackup()` 只判 `kdf` + `ciphertext`；`decryptBackup()` 不读 `format` |
| 五处 store 的 `schema`（auto-checkin / badge-preferences / dead-model-store / permanent-lock-store / token-ledger） | ⚠️ **写点无读点** | 逐条核过读路径：`locksFieldOf()` 只判 `schema === undefined`，其余四处**不比较值** |

⇒ 结论：**都保留旧值**（改了对存量用户没有收益，只有风险），但理由要写准 ——
**只有 `BACKUP_FORMAT` 是兼容读取点**，其余是「写点无读点」的落盘标记
（真实用户的 `~/.dsh/jet-hub/*.json` 里确实躺着这 5 个旧值）。
⚠️ 把整组说成「跟着改名会让用户读不出已落盘状态」是**过度陈述**（2026-10 审计）。

## ⚠️⚠️ 聚合的三态门控与手工排序（2026-10-15，issue IKL7F9 + IKLQR2）

> 规格：`docs/superpowers/specs/2026-10-15-aggregate-gating-manual-order-design.md`
> 计划：`docs/superpowers/plans/2026-10-15-aggregate-gating-manual-order.md`（均**不入库**：`docs/superpowers` 被 gitignore）

### 1. 三态判据**只留一份**（客户端只渲染、不判定）

权威实现是 `src/aggregate-core.ts` 的 `resolveCandidateGate`（零 import 纯函数），
优先级 **显式拒绝 > 显式允许 > 默认**（已接入折算 ⇒ 参与；未接入 ⇒ 默认不参与）。
宿主在 `aggregate.catalog` 里把结果**直接下发**（每个候选带 `state` 与 `expiryWired`）
⇒ 客户端**不得**自己重算（「同一语义两套判据」是本仓库首条红线）。

⚠️ 两个字段的**分工**不要混：
- `state` = 三态**判定结果**（`allowed` / `rejected` / `default-rejected`）；
- `expiryWired` = **渠道级事实**（该渠道接不接入折算），**只**用来回答一个问题：
  「关掉这条候选时该写**拒绝表**还是**白名单**」—— 见 `candidateToggleAction` 的四行表。

### 2. ⚠️⚠️ 未接入渠道的候选必须赋 `NEVER`，**不能**落到 probe 的 `UNUSABLE`

`src/aggregate-adapter.ts` 的 `candidatesFor` 里有一段**看起来可以删掉**的分支：

```ts
if (!WIRED_EXPIRY_PROVIDERS.includes(candidate.provider)) {
  candidate.expiry = NEVER    // 可用、只是没有临期信息
  continue
}
```

**为什么不能让它走 probe**：`credentialExpiry` 对未接入渠道**恒返回 `UNUSABLE`**
（`aggregate-expiry.ts` 的短路）⇒ `rankCandidates` 会把它剔除 ⇒ 症状是
「我明明在面板上打开了，它还是不参与」，**零报错、零日志**。

⚠️ **它的前提是「门控已经跑过」**：能走到这里的未接入候选必然是白名单里**显式放行**的
那几条。⇒ 用例必须**两个方向都覆盖**，否则把门控整段删掉用例仍然全绿
（本任务变异验证实测：第一版「未放行 ⇒ 不在池里」那条用例**无牙**，因为
buddy 先成功、永远走不到 raccoon）。

### 3. ⚠️ 目录身份与用户门控**无关**（`:636` 的过滤为什么删、为什么不能再加回来）

`refreshCatalog` 里**曾经**有一条 `WIRED_EXPIRY_PROVIDERS` 过滤，2026-10-15 **整条删除**：

1. **判据已恒真**：`providerIds()` = `AGGREGATE_CHANNELS ∩ 存活路由` ⇒ 每条候选的
   `provider` 必然在 `AGGREGATE_CHANNELS` 内 ⇒ 换成渠道全集即恒 `true`；
2. **它让用户点不动**：未接入渠道的**独有模型**会被整条剔掉 ⇒ 用户在面板里手工打开后，
   选择器里**仍然看不到它**（打开白做）。

⚠️⚠️ **不得改成「至少一个候选当前参与轮换」**：那会让「用户把某模型的候选全部拒绝」
把该模型**从选择器里移除**，而仓库有**两处成文不变式**明文禁止：
`jet-hub-store.ts` 的 `AggregateRejectionMap` 上方（「候选全被拒 ≠ 关闭模型」）与
面板的 `isAllCandidatesRejected`（「面板需对候选全被拒给出显式提示」）。
附带好处：`this.catalog` 保持稳定 ⇒ `provider.status` 的 `total` **不随用户点击漂移**。

### 4. ⚠️ 面板显示顺序 = 真实轮换顺序（跨层一致性用例）

客户端 bundle 是**独立 entry、不 import 宿主模块**（`build.mjs`）⇒ 比较器无法复用，
只能在 `plugin-src/client/aggregate-panel-logic.js` 里写第二份
（`rankCandidatesForPanel`）。**唯一守卫**是一条**跨层一致性用例**
（`tests/unit/aggregate-panel-logic.spec.ts` 的「与宿主 rankCandidates 同序」）：
同一份 fixture 过两个实现、逐项相等。**改动任一侧先跑它。**

⚠️ 两处都必须保留 `expiryA !== expiryB` 这一格：两个 `Infinity` 相减得 `NaN`
（非法比较器返回值，`sort` 会当 `0` ⇒ 顺序随引擎漂移）。

### 5. 两张表**各有各的域，不做互斥归一**（用户 2026-10-15 的修正）

| 渠道类型 | 默认态 | 例外靠哪张表 |
|---|---|---|
| **已接入**折算 | 参与 | **拒绝表**（黑名单语义：只有「不参与」需要显式记录） |
| **未接入**折算 | 不参与 | **白名单**（只有「参与」需要显式记录） |

两表的键域由 `expiryWired`（渠道级编译期事实）划分 ⇒ **天然不相交** ⇒
写一侧**不得**改另一侧（顺手清另一侧会静默改掉**属于别的操作**的用户状态：
拒绝一条候选不该顺手关掉同渠道其它手工打开的候选）。
判定优先级 `rejected > allowed > 默认` 保留为**纵深防御**。

⚠️ 但**落笔时我第一版按「互斥归一」实现**（写一侧清另一侧），用户看过设计后推翻 ——
「同一枚开关的两个方向」听起来对称，但两表的**语义域**不对称。设计文档 §5.1 有留档。

---

## ⚠️⚠️ 源码文本断言的**共同弱点**：`if (false)` 短路禁用（2026-10-16 对抗审计）

PR #102 合并后跑了对抗性审计，它用 **5 条 `if (false)` 型变异**打穿了本仓库一批
**源码文本断言**（`toMatch(/字面量/)` / `toContain('字面量')`）：

| 变异写法 | 原判据 | 结果 |
|---|---|---|
| `if (false) { event.dataTransfer.setData('text/plain', …) }` | `/dataTransfer\.setData\('text\/plain'/` | 🟡 **绿**（无牙）|
| `if (false) { void commitOrder(…) }` | `/void commitOrder\(/` | 🟡 **绿** |
| 保留条件行 + 加一句**无条件** `await onSortByExpiry()` | 字面量存在性 | 🟡 **绿** |
| `onDragEnd: draggable ? () => {} : undefined`（保留方法名） | `/onDragEnd/` | 🟡 **绿** |

**根因**：判据打在**文本存在性**上，而字面量在死分支里**照样存在**、代码却永不执行。
⇒ 这类断言能防「整行被删」，但防不住「今天能跑、明天被包进死分支」。

**为什么不能改成行为判据**：客户端单测环境**没有 react、`environment: 'node'`（无 DOM）**
⇒ 组件内部逻辑（`AggregatePanel` 的 effect / 事件处理器）**够不到**。
本仓库的既有做法是「把判据抽成纯函数」（`aggregate-panel-logic.js` 的模块注释），
但**接线本身**（谁调谁、有没有被条件包住）仍然只能靠源码断言。

**已落地的补强**（`tests/unit/aggregate-panel-logic.spec.ts`）：
1. **常量假条件检测**：命中行往上找最近的 `if (false)` / `if (0)` / `while (false)`，
   遇到属性起始（`onDrop:` 等）就停 ⇒ 判「不得被包进死分支」；
2. **无条件调用检测**：用**缩进级别**判「每个 `onSortByExpiry()` 都被条件包住」
   —— 无条件调用的缩进与其上那条 `if` **同级**，有条件的会**更深**。

⚠️ **两条过程教训（比结论更重要）**：
1. **判据没抓住，先怀疑判据本身，别先怀疑被测代码。** 我第一版「往上找 6 行内有无
   `if (`」的启发式**抓不到** —— 它找到了**相邻**那条语句的 `if`，把无条件调用
   误判成有条件的。改成缩进比对才成立。
2. **变异「全绿」不等于「守卫无牙」——也可能是变异根本没注入。**
   我第一次注入 M4 时用单行精确匹配，而文件里是 `\r\n` ⇒ `replace` **静默不生效**
   ⇒ 我据此以为判据无牙，其实**什么也没改**。对抗审计方也在同一处误报过
   （多行正则锚点在 CRLF 上不匹配）。
   ⇒ **变异脚本必须区分「锚点未命中」与「无牙」**：注入后**打印实际片段**确认，
   锚点未命中要单独报 `PATCH-NOT-APPLIED`（不算结论）。这条已写进本仓库的变异纪律。

**仍未覆盖（如实登记）**：`onDragEnd` 那类「保留方法名、函数体改成 no-op」的变异
**无法用文本判据区分**（`onDragEnd: ` 后面接 `() => {}` 与接真实现，正则都命中）
—— 要覆盖它需要 AST 或真 react 渲染，本期不做。

---

## 原生侧栏入口：一个入口要三处 id 同名（2026-10-21）

Jet Hub 之前只有 `settings.section` 一个入口。加成主导航一行之后，**同一个页面**有
两条入口路径（设置弹层 / 中央主面板），组件与 `rpcCall` 都只有一份。

> **2026-10-24 更新**：两条入口已改为**互斥**，由插件详情页设置卡片的
> 「面板入口」下拉（`仅侧栏` / `仅设置页`）决定保留哪一条。偏好键从布尔
> `sidebarEntryEnabled` 换成枚举 `panelEntry`，RPC 换成 `panelEntry.get` /
> `panelEntry.set`，客户端文件名相应改成 `panel-entry-store.js` /
> `panel-entry.js`。**下面 1-3 条的结论全部仍然成立**，只把文件名与端点名更新了。

### ⚠️ 1. `sidebar.panellist.id` == `main.key` == `settings.section.id`

宿主按「侧栏行的 id」去 `main` 槽里查 key（`layout.selectPanel(id)`）。三者不一致时
界面看起来**完全正常**，只有点下去才会发现「面板没换」—— 而且 `selectPanel` 对未注册
的 key 是**抛错**，被兜底成「什么都不发生」。本实现统一用
`JET_HUB_PANEL_KEY = 'jet-hub'`（`plugin-src/client/panel-entry-store.js`）。

⚠️ 正因如此，`main` key **必须无条件注册**：入口切到「仅设置页」之后，用户仍可能
把面板停在 Jet Hub 上，少了这个 key `selectPanel('jet-hub')` 就会抛错。

### ⚠️ 2. 偏好必须落宿主，不能落浏览器存储

Web 端 origin 是 `http://127.0.0.1:<随机端口>`（每次启动都变）⇒ 浏览器存储随旧
origin 一起被抛弃，症状是「改掉的入口下次启动又变回来了」。故走
`panelEntry.get` / `panelEntry.set` + `AccountPool` 的内存副本 + **两个**持久化
后端。⚠️ `SettingsStore.save` 是**整体替换白名单**：漏掉本键时，任何一次账号/黑名单/
顺序写入都会把它从文档里删掉（与拒绝表、原生搜索开关同型的历史缺陷）。

⚠️⚠️ **schema 不许加 `.default()`**（2026-10-24 实测缺陷）：schemastery 的
`.default()` 会在 `scope.get()` 返回的文档里**填入**默认值，于是
`sanitizePanelEntry(value.panelEntry, value.sidebarEntryEnabled)` 第一层（新键合法
即返回）直接命中，**老布尔迁移永远不执行** ⇒ 老用户明确关掉的入口升级后静默变回
「仅侧栏」，且此后每次 save 都把 `'sidebar'` 写死，原设置永久丢失。
缺键由 sanitize 自己兜底，schema 不需要再给默认值。

### ⚠️ 3. 关掉入口时若面板正停在本插件上，要主动 `selectPanel(null)`

否则布局里留着一个再也没有入口的 `activePanelId`。`layout` **不在**插件的 `inject`
声明里（那是硬依赖，缺了整个插件不激活），用 `ctx.inject(['layout'], scoped => …)`
拿作用域副本。

### ⚠️⚠️ 4. 单账号卡片不占满：`column flex + align-items: flex-start` 的收缩

`.dim-jh-panelHead` 原是 `display:flex; flex-direction:column; align-items:flex-start`，
账号列表容器是它的 flex item ⇒ 宽度 = **max-content**。多账号时那句排序提示把容器撑宽，
所以缺陷**只在单账号**暴露成 ~257px 窄条。

⚠️ **那提示的实际长度**（2026-10-21 实测）：它是 `jet-hub.js` 里**两段拼接**的文案、
共 **100 字符**，而 `.dim-jh-orderHint` 是 `font-size:12px` ⇒ max-content **约 1200px**
（初版注释写的「654px」**是错的**，已订正）。⇒「只有单账号暴露」是**有条件**的：
列表宽 = `min(约1200px, 面板可用宽)`，面板宽超过约 1200px 时多账号同样是窄条（只是没那么夸张）。

修复**不是**给卡片加 `width:100%` —— 那只是等于父容器的 max-content，量出来仍是 257。
先给容器拉伸（原 PR 的点补丁）：

```css
.dim-jh-accountList { align-self: stretch; min-width: 0; }
```

⇒ 教训：flex item 上的 `width:100%` 不是万能药，**先量「谁决定了宽度」**（用
`document.title`/DOM 覆层把 `offsetWidth` 打出来比猜 CSS 快得多）。

### 5. 客户端状态模块必须无 React

客户端单测是 `environment: 'node'` 且 devDependencies **没有 react** ⇒ 任何 import
react 的客户端模块都**无法单测**。故把偏好状态拆成 `panel-entry-store.js`
（无 React，可单测），React 组件与槽注册留在 `panel-entry.js`；插件详情页的设置卡片
（`settings-card.js`）也只 import store。顺带避免了
`panel-entry.js → jet-hub.js → panel-entry.js` 的循环。


## ⚠️⚠️ `notice` 类状态必须是对象形状；**接线层的守卫只能靠行为级**（2026-10-22 报障 + 2026-10-25 审计）

### 事故

用户报障：**「魔搭社区的令牌我一保存，页面直接清空，切换页面无效，只能重启 dsh」**。

根因（`ProviderPanel`）：渲染端按**对象**读三个字段

```js
'data-tone': probeNotice.tone,
React.createElement('div', null, probeNotice.text),
probeNotice.details.length > 0 ? … : null
```

而两处调用把 `probeNotice` 写成了**裸字符串**（`submitModelscopeKeyEdit` 的三元、
`submitOpencodeEntry` 的 `res.existed` 分支）。字符串没有 `.details` ⇒
`undefined.length` 抛 `TypeError` ⇒ React 卸载整棵设置页子树。

修法是**三层**（真正的修复在源头，后两层是纵深）：

1. 源头：两处调用改成 `{ tone, text, details: [] }`；
2. 渲染端：`details` 过 `safeNoticeDetails()`（`Array.isArray` 保护）；
3. 写入端：`setProbeNotice` 包装成经 `normalizeProbeNotice()` 归一。

⚠️ 第 3 层**不能**用来解释「所以源头可以写错」：它防的是回归，不是免责。

### ⚠️⚠️ 三条源码文本断言**各有真实旁路**（实测，别再重复）

新增的 `tests/unit/notice-shape.spec.ts` C1/C2/D1 是源码文本断言。审计用**完整白屏
回归态**实测：

| 旁路 | 形态 | 为什么逃得掉 |
|---|---|---|
| 三元字面量 | `setProbeNotice(x ? 'a' : 'b')` | C1 正则要求 `(` 后**紧跟**引号 |
| 下标读取 | `probeNotice.details['length']` | D1 只匹配 `.details.length` |
| 死分支包装 | `if (false) { setState(normalize(x)) }` | C2 的 `toMatch` 在死分支里照样命中 |

三者**同时**注入时，41 条相关用例**全绿**，而同一份代码执行时**确实抛**
`TypeError: Cannot read properties of undefined (reading 'length')`（可执行证明）。

⚠️ 还发现**反向伤害**：D1 抓不住 `['length']`，却会把**完全正确的等价重构**
（内联 `Array.isArray(…) ? … : []`）判成**假红** ⇒ 既漏检又误伤。

### ⚠️⚠️ 那个「无法行为级测试」的前提是**错的**（本次最贵的单条缺陷）

三条断言曾经声称：「单测环境是 `node`，`react` 是宿主注入的 external，
`jet-hub.js` **根本 import 不了**，组件无法渲染」。

**这是假的** —— 仓库自己的 `tests/unit/jet-hub-tdz.spec.ts:99` 早就用
`vi.mock('react', …)` 注入替身 + 真实 `await import('../../plugin-src/client/jet-hub.js')`
跑过运行时渲染。那个错误前提**正当化**了「接线层不用行为级测试」，并让三条无牙断言
看起来足够。

⇒ 真正的守卫是 `tests/unit/jet-hub-panel-wiring.spec.ts`（**行为级**）：
真渲染 `ProviderPanel`、把渲染时传进 `useCallback` 的每个回调**真调用**、喂一个
裸字符串，然后断言 **state 里不得留下字符串**。实测：

| 状态 | 本文件 | `jet-hub-panel-wiring.spec.ts` |
|---|---|---|
| 现实现 | 15 passed | 4 passed |
| M22（三旁路同时注入） | **全绿** | **1 failed**（「有回调把裸字符串原样写进 state」） |

**教训可推广**：用一个**未经验证的「无法测试」断言**去正当化弱判据，比没有判据更危险
—— 它会让人停止寻找真正可行的测法。要断言「测不了」之前，先 grep 仓库里有没有
**已经在测**的先例。

### ⚠️ React 错误边界的能力边界（`plugin-src/client/error-boundary.js`）

2026-10-24 真机实测（`window.onerror` 触发、容器内容不变、边界零介入）：错误边界
**只捕获渲染期**（子组件渲染 / constructor / 生命周期）。以下四类**完全不受保护**：

1. **事件回调里的异常**（`onClick` / `onChange`）—— React 不把它们算渲染期；
2. **异步回调 / `await` 之后**（Promise、`setTimeout`、订阅回调）；
3. **模块求值期（import 时）**—— 那时 React 还没开始渲染；
4. **渲染进程级崩溃**。

⇒ 反向推论同样重要：**不要把取数/解析逻辑挪进渲染路径**、**不要依赖边界去接住异步
错误**。加边界只是把「一次失误 = 白屏」降级成「一次失误 = 一块报错」，**不是修复**。

⚠️ fallback 自身**必须永不抛错**（否则 React 再卸一次树，边界与没有边界等价）：
`error.message` 可能是**抛错的 getter**、`String(Object.create(null))` 会抛
⇒ 文案计算全部收进 `describeThrown()`，三级降级各自包 `try`。
⚠️ 判据不能用 `null` 当「没出错」的哨兵：`null` 是**合法抛出值**，
`getDerivedStateFromError(null)` 返回 `{error:null}` ⇒ 边界**不产出 fallback**、
容器被清空（真机实测，与没有边界同形）⇒ 用 `Symbol` 哨兵。

### ⚠️⚠️ 宿主**本来就为每个 slot entry 自带错误边界**（别把归因写错）

`@deepseek-ai/dsh-client-ui-renderer` 的 `SlotErrorBoundary` **从该包最早版本
`0.1.0-rc.8`（2026-08-19）起**就为每个 slot entry 包裹（审计拉了 5 个历史版本实测：
`0.1.0-rc.8` / `0.1.1-rc.1` / `0.1.2-rc.1` / `0.1.7-rc.2` / `0.2.0-rc.1` 全部有）。
它渲染 `<div data-slot-error>` 并 `reportEntryError` 到插件运行状态页。

⇒ **「插件内没有 ErrorBoundary ⇒ 整页清空」这条归因不成立**，写文档/复盘时不要这么写。

那本插件的边界还有什么用？**三样**（都不是「防白屏」）：

1. **可读的报错文案** —— 宿主的 crash face 是空元素 + 无文案，用户什么也看不到；
2. ⚠️ **可恢复** —— 宿主对**非 chain** 槽会**abdicate**（`reportEntryError(…, {abdicate: kind !== 'chain'})`），
   而失败记录只在**插件重载/卸载**时清除（`dsh-cordis-client-runner` 的 `this.failures.delete(...)`
   分别发生在「装载成功」「teardown」「编排计划」三处，**视图切换路径上没有**）⇒
   **切页不会恢复**；而插件内边界只覆盖**子树** ⇒ 重挂载即可恢复；
3. **非 slot 路径**（例如 `JetHubMainPanel` 自己那层）。

⚠️ 用户报障里的「切页无效」正是 abdicate 永久性造成的，**不需要**假设「宿主缺边界」。

### ⚠️ fallback 的恢复路径：**「不必重启」是成立的**，但不要写成「已修好」

宿主 `SettingsPanel` 在 `open === false` 时**整棵不挂载**（`open && <SettingsPanel>`），
`main` 是 **keyed** 槽、靠 `entryKey` 切 key ⇒ 「关掉设置再打开」与「切走再切回」
**都能恢复**。故 fallback 文案里的「不必重启」**不是虚假陈述**。

⚠️ 但真实缺陷仍在（P2 级）：**恢复路径不可发现**。fallback 只写「已拦住，其余页面
仍可正常使用」，没告诉用户「关掉这一节再打开就恢复」。⇒ 若要改，改的是**可发现性**
（加一句「关掉再打开这一节即可恢复」或加重试按钮），**不是**「文案在撒谎」。

## ⚠️⚠️ 页头按钮搬进侧边栏 + 「设置」弹窗 + 供应商开关（GitHub PR #52，2026-11-09 审计）

三域（需求实现 / 正确性与回归 / 对抗性变异）+ 我本人独立复核，基线
`build:all` exit 0、8 个相关 spec 372 passed、全量 **519 files / 12526 passed / 0 failed**。
三条用户需求 **11 个实现项全部满足**，旧页头 7 个控件逐个确认去向、无遗失无第二入口。
以下是这次审计挖出来、且**不能凭直觉改**的点。

### ⚠️⚠️ 「只写关闭意图、黑名单不动」是**假的**（P1，必读）

PR 描述写着：「启用/关闭供应商**不再**替用户决定模型黑名单；只写关闭意图，
黑名单**逐字不动**；关→开两跳之后，手工关掉的模型仍然是关的」。

**`src/` 一行未改**（10 个文件全在 `plugin-src/client` + 测试），服务端仍双向改黑名单：

- 关闭 → `src/jet-hub-rpc.ts` 的 `provider.setEnabled` 调
  `pool.writeModelsWithProviderClosed(provider, catalog.ids, true)`
  → `src/account-pool.ts` 里 `for (const id of modelIds) perProvider[id] = true`
  ⇒ **把当前目录的每一条模型都灌进黑名单**；
- 打开 → `pool.clearModelsWithProviderClosed(provider)` → `delete next[provider]`
  ⇒ **整家黑名单清空**（不是「只清意图写进去的那些」）。

一次性探针（真实 `AccountPool` + 真实 settings 后端）实测：
手工关掉 `glm-5.3` → 关供应商 → 再开供应商 ⇒ `listDisabledModels` 由
`{'glm-5.3': true}` 变成 `{}`，失败输出逐字
`AssertionError: expected {} to deeply equal { 'glm-5.3': true }`。

⚠️ **真正的「只写意图、不动黑名单」在服务端是另一个端点**
（`model.setAllDisabled` 的 `'keep'` 分支），供应商开关**不走**那条路。
⇒ 要么改文案（已改，见下），要么动 `src/`（那是另一个 PR 的量）。
⚠️ 另一个入口同样覆盖细粒度状态：两方向都会 `pool.setAccountsEnabled(provider, enabled)`
⇒ 用户手工停用过的**个别账号**也被整体开关抹掉。

### ⚠️⚠️ 文案三处自相矛盾（已修）

同一个交互里两句相反的话：

- 开关的 `title`：「（关闭 = 停用它的全部账号；**模型黑名单保持不动**）」← 假；
- confirm 弹窗：「将关闭它的 **N 个模型（从对话框的模型选择里移除）**」← 真；
- `ProviderPanel` 的 doc 注释：「**但黑名单不动**」← 假。

⇒ 现统一为「关闭 = 停用它的全部账号，并把当前目录里的模型全部关掉；
再打开时这些模型会一起恢复，**包括手工关掉的**」，且注释里记了探针与行号。

### ⚠️⚠️ 删「第二个更新点」时**不要连守卫一起删**

`providerStatusSeqRef` 是「最后写者胜」的唯一实现。本 PR 删掉了
`patchProviderStatus`（第二个占号点），于是把 `tests/unit/jet-hub-structure-ast.spec.ts`
里那条 `describe('★★ 客户端 provider 状态序号闸门（AST 级）')` **整段删掉**。

但机制一行没少（仍是 1 个 `++` + 2 个 `!==`），删掉的只是**守卫**。
域C 变异实测：把 `++` 改成不递增、或删掉 catch 里的比较，**12526 条全绿**。

⇒ 正确做法是**把计数从 2 改成 1**（已恢复：`updates === 1`、`comparisons === 2`，
另加一条「`loadProviderStatuses` 体内两道闸门恰好 2 处」）。同一类教训见
`docs/agent-notes/providers-officeace.md`：「登记了一处例外 ≠ 这处例外有守卫」。

### ⚠️⚠️ `disabled` 会把**原生 tooltip 一起关掉**（`title` 白写）

开关禁用时原因只挂在 `title: switchState.reason` 上，而同一元素
`disabled: switchState.disabled === true || switchBusy`。**Chromium 不为 disabled
的表单控件显示原生 tooltip** ⇒ 用户悬停什么都没有；`aria-label` 里也只有
「已启用/已关闭」⇒ 屏幕阅读器同样拿不到原因。测试全绿，因为它断言的是
`providerSwitchState()` 的**返回值字符串**，不是 DOM。

⇒ 改用 WAI-ARIA 的标准做法：**`aria-disabled` + onClick 早退**
（仍可聚焦、tooltip 照常显示、AT 读出「不可用」，行为上依然点不动），
CSS 选择器同步从 `:disabled` 改成 `[aria-disabled='true']`。
⚠️ **属性本身不是拦截** —— 真正拦住点击的是早退，必须用**行为级**用例守。

### ⚠️⚠️ 「循环指认」：两条 spec 各自指着对方，实际零守卫

`provider-toggle.spec.ts` 那 130 条几乎全是**源码字符串 / 切片断言**（除
`providerSwitchState` 纯函数）；而 `model-center-panel.spec.ts` 写着
「行为守卫在 `provider-toggle.spec.ts`」。

域C 变异 M6 把开关的 `onClick` 体整个包进 `if (false)` ⇒ **148 条全绿**。
⇒ 讽刺的是 PR 自己在描述里写着「点『网关』/『用量』/『供应商开关』什么都不发生，
而 **127 条测试全绿**」—— 同一个 PR 里又造了一个同型的。

修法（已落）：`jet-hub.js` 导出 `ProviderPanel`（**只为单测**，生产无第二处引用），
`tests/unit/checkin-panel-wiring.spec.ts` 新增一段**真渲染 + 真 handler**：
点「已启用」⇒ `onToggleProvider('codearts', false)`；点「已关闭」⇒ `(…, true)`；
点「禁用」⇒ **一次都不调**。
⚠️ 为什么必须直接渲染 `ProviderPanel`：本仓的 react 替身**不调用函数组件**，
从 `JetHubPage` 往下走只能拿到 `<ProviderPanel …>` 这个**元素**，看不到内部开关。

### ⚠️ `provider.status` 失败**不许**把汇总置 null

原实现失败就 `setProviderStatuses(null)`，于是**一次瞬态失败（429 / 502 / 超时）
让全部 29 个开关变灰**（`PROVIDER_REGISTRY` 当前 29 条 —— 别写成「8 个」，
那是本仓早期的 provider 数），而唯一恢复路径是「设置 → 打开供应商开关 → **刷新**」——
那条路径在提示文案里一个字都没提。⇒ 改成**保留上一次读到的汇总**（它是「稍旧」
不是「错的」，再点一次服务端会自己纠正），提示文案补上「可在『设置 → 打开供应商
开关』里点『刷新』重试」。只有从未读到过（仍是初始 null）才退化为不分组平铺。

### ⚠️ 死 import 让「运行态圆点」静默消失

`gatewayButtonLabel(status)`（返回 `'网关 ●'` / `'网关'`）在 `jet-hub.js` 里
**引入了却零使用** —— 底部操作行的网关按钮硬编码 `'网关'`。
`openai-gateway-panel.spec.ts` 仍在测那个纯函数 ⇒ **测试不会红**，
但旧页头的「网关 ●」运行态圆点丢了，运行/停止的差别只剩 `title`。
⇒ 已改回 `gatewayButtonLabel(gatewayStatus)`。
**判据：引入一个纯函数却不用它，比不引入更危险 —— 因为测试会替你证明它「在工作」。**

### ⚠️⚠️ react 替身的 `useRef` 少写一个字段 ⇒ 所有「按序号丢弃过期响应」的闸门在单测里恒为「全丢弃」

`tests/unit/checkin-panel-wiring.spec.ts` 里的 react 替身原先这样实现 `useRef`：

```js
useRef(initial) { const s = slots[k]; if (!('cur' in s)) s.cur = initial; return s }
```

属性名是 **`cur`**，而真实 React 的 ref 上叫 **`current`**。于是 `React.useRef(0)`
之后 `providerStatusSeqRef.current` 是 `undefined`，`++undefined` = **`NaN`**，
而 `NaN !== NaN` **恒真** ⇒ 每个响应都被判成「过期的」，`setProviderStatuses`
一次都不会执行。

⚠️ 症状极具误导性：不是报错，是 **`providerStatuses` 恒为 `null`**，
看起来像「服务端没回」或「组件没渲染」。

⚠️⚠️ **这正是那条序号闸门十几年没人用行为级测它的根因** —— 在那个替身下
任何依赖 `useRef(数字)` 的闸门都不可观测，只能退回源码/AST 断言。
⇒ 已改为初始化时**同时**写 `cur` 与 `current`（`cur` 保留只为不破坏既有写法）。

**可推广的判据**：写 hooks 替身时，属性名必须与真实 API 逐个对齐
（`current` 不是 `cur`）；**替身少一个字段 ⇒ 被测代码的整条分支静默失效**，
而它表现为「状态不更新」而不是「测试失败」。本仓已有同型教训：
`providers-accio` 的「替身缺一条真实实现里有的腿 ⇒ 对应变异全体无牙」。

### 已登记未修（P3）
- `isInsideCheckinDock`（`plugin-src/client/checkin-panel-logic.js`）**零生产调用方**，
  却有 3 条用例（6 条断言）在守它（`auto-checkin-panel.spec.ts`）⇒ 死代码 + 假信心。
- **设置弹窗没有 Escape、没有焦点陷阱**：`renderSettingsPanel`（`plugin-src/client/jet-hub.js`）
  只有遮罩点击 + 「完成」两个出口，而 `aria-modal="true"` 已声明 —— 键盘用户关不掉。
  同文件的 `ProviderSwitchPanel` 有 Escape 处理，两处不一致。
- **另有 23 个零引用 CSS 类**（全仓 321 个 `.dim-*` 逐条扫描，只删了 `.dim-jh-header`
  一条）⇒ 下次清理时一并删，别只删一个就宣布「死 CSS 清完了」。
- `openSettings` 里 `if (showSettings) { closeSettings(); return }` 不可达。
- `saveCheckinTimesWith` 的超时注释称「底层请求若成功 `setAutoCheckin` 仍会更新界面」
  —— `Promise.race` 只结算一次，界面**不会**更新（只有重开面板 `loadAutoCheckin` 才追平）。
- 三条 `★★★` 用例证明的是**被遮罩挡住**的交互：设置弹窗盖着（`z-index:3000`）时
  点底部操作行。真正可达的只有弹窗内的「打开供应商开关」。
- 保存进行中点「设置」⇒ 意图静默丢弃。
- `switchBusy` 只由 `providerBusy` 提供，模型列表的 `toggleModel` / `setProviderAll`
  不入忙集（两屏互相遮挡 ⇒ 实测不可达，降级登记）。
- **AST 判据只认三种写法**（`!==` / 前缀 `++` / `+=`）⇒ `!=`、`= x + 1`、后缀 `x++`
  会**假红**（误报方向安全，但阻碍合法重构）。假红不危险，**但别把它当有牙**。
- **「状态未知」在 rail 分组上仍与「全部已启用」同形**（`groupProviders` 把非对象
  `statuses` 当 `{}`）—— 开关本身是禁用态、可区分，但侧边栏的组归属看不出来。

## ⚠️⚠️ 二审（2026-11-09，返工提交 `bfb55eb` 之后）：三条「代码对、守卫可被静默拿掉」

一审的 9 条守卫全部有牙（16/16 期望红），但对抗审计又用 18 条变异找出**三条
「代码正确、守卫拿掉也不红」**的腿。这不是回归，是**守卫强度**问题 —— 记录在此
以免下次有人用那三种改法「合法地」把闸门关掉。

### 补的三条行为级用例

| 补的用例（`tests/unit/checkin-panel-wiring.spec.ts`） | 挡的改法 | 红因（逐字） |
|---|---|---|
| `★★ 迟到的旧 provider.status 不得覆盖新状态（序号闸门的行为级守卫）` | 成功分支的 `seq !== providerStatusSeqRef.current` 删掉 / 用 `&& false` 短路 | `AssertionError: ★★ 迟到的旧响应必须被丢弃…: expected { models: { total: 9, disabled: 9 } } to deeply equal { models: { total: 2, disabled: +0 } }` |
| `★★ 同帧连点两次只发一次 provider.setEnabled（防双写）` | `if (providerToggleInFlightRef.current.has(providerId)) return` 删掉 | `AssertionError: ★★ 同帧连点两次必须只发一次 provider.setEnabled…: expected 2 to be 1` |
| `★ 读失败后恢复成功 ⇒ 那条「显示的是上一次读到的状态」必须收掉` | 成功分支的 `setProviderNotice(prev => …)` 删掉 | `AssertionError: ★ 恢复成功后那条 warn 必须消失…: expected '供应商开关状态读取失败（502 Bad Gateway），暂时读不到；账号…' to be ''` |

### 三条教训

1. **AST 计数判据的射程只有「被整段删掉」，挡不住「留着但失效」** ——
   `if (false && (…))`、删 `return` 留空 `if` 体、把 `++` 搬到隔壁函数，三种
   语义已死的改法让 `++`=1、`!==`=2 三个数字**全不变**（34 条全绿）。
   ⇒ **必须成对**：AST 挡「整段删除」，行为级挡「保留但失效」。
2. **`slice(at, at + 4000)` 这种「函数体切片」会越界** —— `loadProviderStatuses`
   的函数体只有 900 余字符，4000 字符窗口直接盖到隔壁的 `commitProviderOrder`，
   于是「函数体内恰好 2 处」名不副实：把闸门**搬到隔壁函数**也绿。
   修法 = 用 AST 找 `VariableDeclaration` 取 `initializer` 的**精确**范围。
3. **变异红在「超时」上不等于红在「被测腿」上** —— 防双写用例第一版只放行
   「当前那一个」写请求的 resolver，去重腿一删，第二次写永远挂着 ⇒ 用例以
   30s 超时变红。**红因是超时，不是 `expect(writes.length).toBe(1)`。**
   修法 = 把所有挂起的 resolver 收进数组、一次放行 ⇒ 红因回到断言本身
   （`expected 2 to be 1`）。同型先例：本仓 `providers-magicrew` 的
   「红不自动等于红因是被测变异」。

