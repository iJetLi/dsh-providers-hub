# AutoClaw（智谱清言桌面端）provider 笔记

## 积分余额与「逐批次到期」（PR 115，2026-10-17 两轮独立审计 + 变异验证）

### ⚠️⚠️⚠️ P0：**流水的 `amount` 是「历史发放额」，不是「该批次剩余额」**

PR 115 用 `/agent-assetmgr/api/v1/ledgers_std` 的流水给每个积分包补
`deductionEndTime`，实现里把每笔 `credit` 的 `amount` **直接当 `remaining` 求和**。

**流水是历史账变**：一笔 `credit` 记的是「某时刻发放了 N 分」，此后消耗走独立的
`debit` 行，而**上游没有下发任何「该批次已消耗多少」的字段**
⇒ 拿 `amount` 当剩余额 = **拿发放上限当余额**。

⇒ **用户一旦消耗过积分，批次和就 ≠ `total_balance`**，守恒校验恒不成立 ⇒
永远回退钱包包 ⇒ **逐批次分档（含红色「临期」+ 倒计时）永不出现**，
表现为「**刚登录那会儿对、用一段时间后静默失效**」，无报错、无日志。

**必须逐格对照 `src/trae-credits.ts:378`** —— 那边是同款「条目级到期」问题，
但服务端给了 `quota.credits_limit`（上限）**与** `usage.credits_amount`（已用）
**两腿**，所以能折算 `remaining = creditsLimit - used`。
⚠️ **教训可推广：「同款问题」只共享问题形状，不共享解法是否成立**。
照抄别家的判据前先确认**它依赖的那条腿在你家也在**。

✅ 当前取舍：守恒校验当**安全网**（不守恒就回退钱包包，绝不给错数）。
⚠️ **未解决**：要让「消耗后仍能正确分档」，必须由上游下发批次剩余
（`wallet_remaining` 之类）。**在那之前不得声称本渠道已支持按批次分档**，
registry 的 `usesExpiryWindow: true` 只是「把 `windowDays` 回传下去」的**能力开关**。

⚠️ **取证不可复核**：PR 注释引用的 `scripts/probe-autoclaw-expiry.mjs`
**在本仓库不存在**（只有 `probe-autoclaw-reasoning.mjs` / `probe-autoclaw-vision.mjs`）；
`docs/audit/pr111-autoclaw-audit.md` 亦明确记载钱包接口 `wallets[]`
**没有任何时间字段**。⇒ 那句「实测 28/28 全带值、守恒 20700」**不得当作实测证据**。

### ⚠️ `display` 必须按官方口径**严格**判断（这是原报障的根）

用户报障「红色每日 0」的真正修复点在**过滤判据**，不在批次包。

| 写法 | 缺 `display` 字段时 | 后果 |
|---|---|---|
| `typeof cast.display === 'boolean' ? cast.display : true` | **fail-open，判为可见** | 「每日积分」池原样回归 ⇒ **原症状逐字复现** |
| `cast.display === true`（官方 `main.cjs readWallets`） | 判为不可见 | ✅ |

⚠️ 实测钱包响应里**每个池都带 `display`**，严格判断不会误伤真实数据；
但**不能**反过来「宽松更安全」—— 宽松正好放回 bug。

### ⚠️ 批次包名**不得**命中「当日池」名单（否则整段三档被短路）

`plugin-src/client/credit-expiry.js` 的 `DAILY_POOL_NAMES = ['每日赠送','每日积分']`
是**精确相等**匹配，而 `plugin-src/client/usage-badge.js:1459-1463` 是**先判先 return**：
`formatPoolSplitLine(...)` 非 null 就单段返回，**根本走不到**
`splitCreditsByExpiry` 的三档 + 倒计时。

⇒ 上游只要下发一条描述为「每日积分」的发放，本渠道就会被误判成 Loomy / Raccoon
那种**当日重置池**，渲染出无色的「长期 X · 每日 Y」，
**恰恰把红色临期 + 倒计时整段短路掉**，还把批次到期语义说反
（本渠道每日签到分是发放进余额、按批次到期，不是当日重置）。

修法：批次包名命中名单时加「（批次）」后缀。
⚠️ **不要改客户端那份名单** —— 它是**共享**判据，为一个渠道改会影响其余五家；
且名单语义是「服务端按语义分开的当日池」，本渠道的池是**按到期时刻聚合**的，
两者本就不该共用同一份名字表。

⚠️ **两份名单各存一处**（`src/**` 是 TS、`plugin-src/client/**` 是 esbuild 的 JS，
**不共享模块图**）⇒ 宿主侧副本的同步锁在
`tests/unit/autoclaw-credits.spec.ts` 的「宿主侧当日池名单副本逐字一致」那条。

### ⚠️ 守卫判据的两个血泪点（本轮审计实测）

1. **「隐藏池余额恰好为 0」会让守卫无牙**：夹具里隐藏池余额都是 0 时，
   把过滤器换成「按 `balance === 0` 剔除」（同样让隐藏池不输出）**依然全绿**
   ⇒ 对「判据是 display」**零判别力**。**必须把隐藏池余额取非 0** 才钉得住。
2. **「packages 长度为 1」区分不了两条路径**：「守恒不成立」与「流水失败」
   产出**同形**结果 ⇒ 只断言长度等于恒真残留。要断言「真被问过流水端点」
   **且**「回退包里一个 `deductionEndTime` 都没有」才有牙。

⚠️ **更要紧的一条**：原 PR 的验收夹具到期时刻距**真实当前** ~76.7 天
⇒ 落在 15 天窗口外 ⇒ 即便全绿，实际只会渲染黄色「长期」，
永远不是红色「临期 + 倒计时」——**而那正是用户诉求本体**。
⇒ 断言「`deductionEndTime` 被算出来」**不等于**断言「会变红」；
必须把批次真正喂给 `splitCreditsByExpiry` 并断言 `expiring` 与 `earliestExpiringAt`。

### ⚠️ 其余已修的小项

- **负数 `amount`（冲正/退款）一律丢弃**（判据 `<= 0` 而非 `=== 0`）：
  并进批次会让 `remaining` 变负，而客户端 `splitCreditsByExpiry` **静默 skip**
  `remaining <= 0`（`credit-expiry.js:99`）⇒ 合计与总额悄悄脱钩。
- **永久桶按描述分列**，不再用「单一累加器 + 取第一条名」的哨兵：
  哨兵初值恰等于默认名 `'其他积分'` ⇒ **首条真名恰为「其他积分」时哨兵不会被替换，
  被下一条顶掉**，活动赠送与注册奖励被混为一谈。
- **`metadata.description` 是空串时回退顶层 `description`**：`??` 不落空串
  ⇒ 原实现会把包名打成通用兜底「积分发放」。
- **兜底造包只在 `total > 0` 时做**：全部钱包 `display:false` 且零余额时
  凭空造 `remaining: 0` 的死包是纯噪声。
- **整段翻页共用一份时间预算**：原先每页各 arm 一次 15s，
  钱包 1 + 流水 5 = **最坏 90s**，超过徽标 **60s** 轮询周期 ⇒ 请求叠加。

### ⚠️ 聚合折算：`autoclawExpiry` 恒为 `NEVER`

`src/aggregate-expiry.ts` 的 `autoclawExpiry` 复用 `sharedPackageExpiry`
（取有效包 `deductionEndTime` 最小值）⇒ 走钱包包（无 `deductionEndTime`）时恒 `NEVER`。
⚠️ 这与 registry 那条「尽力而为」的注释**口径一致、不冲突**，别去改它。

⚠️ 但注意：`WIRED_EXPIRY_PROVIDERS` 里 autoclaw 的**注释**声称折算取的是
「有余额无到期 ⇒ NEVER」（`aggregate-expiry.ts:957-975`）—— 该注释描述的是
**回退路径**，两种路径都自洽，改动任一侧时同步另一侧的注释。

## ⚠️⚠️⚠️ P0：access_token 的真实死线曾按「编造的 7 天」记录 ⇒ 自动续期与积分自愈全部静默跳过（2026-10-19 真实报障，Gitee IKOYEG）

### 现象（用户原话可复现的时序）

dsh web **启动时还能看到积分**，过一会儿变成「AutoClaw 登录凭据失效，请重新登录」。
本次实测：dsh web 22:50:41 启动（正常）→ 23:19 面板报错。

### 实测事实（只读 JWT 元数据，**未对真实凭据发起任何续期请求**）

⚠️ **账号一律以「账号 A/B/C」代称**：本次报障涉及用户**真实账号**，而本仓库铁律是
「注释与用例里的号码一律用**编造的假号** —— 真号会随代码进仓库历史，不可撤回」
（见 `autoclaw.ts` 的 `autoclawDisplayNickname`）。**连掩码号也不写**：
掩码保留前 3 位 + 后 4 位，识别力远高于直觉。

| 账号 | JWT `iat` | JWT `exp`（真实死线） | 池/凭据里的 `expires_at` |
|---|---|---|---|
| 账号 A | 2026-10-18 23:02:36 | **2026-10-19 23:02:36** | 2026-10-25 23:02:41 |
| 账号 B | 2026-10-18 23:03:11 | **2026-10-19 23:03:11** | 2026-10-25 23:03:16 |
| 账号 C | 2026-10-18 23:04:03 | **2026-10-19 23:04:03** | 2026-10-25 23:04:09 |

⇒ access_token **就是明文 JWT**（`user_id/device_id/iat/exp/jti`），寿命恒
**86400s（24 小时）**，死线一到 `/agent-assetmgr/api/v2/wallets` 立刻回
`code 410000`（= `autoclaw-credits.ts` 那句「登录凭据失效」）。而
`expires_at` = 登录时刻 + **恰好 10080 分钟 = 7×86400s**。

### 根因（一条编造的数字，卡死两条链）

`loginAutoclawWithCode` 在上游既不给 `expires_at` 也不给 `expires_in` 时写下
`Date.now() + 7 * 86400_000`。而这份值同时是**唯一**的续期判据：

| 链 | 读点 | 被跳过的方式 |
|---|---|---|
| 定时续期 | `autoclaw-auth.ts` 的 `AUTOCLAW_EXPIRY_ACCESSORS.expiresAtOf` → `shouldRefreshNow` | 判「还有 6 天」⇒ `refreshAll` 每 30 分钟一轮**永远跳过** |
| 积分按需自愈 | `jet-hub-rpc.ts` 的 `healExpiredAccountBeforeBalance`（`entry.expiresAt <= now`） | 池值说 10月25日 ⇒ **点「刷新积分」也不自愈** |

旁证（决定性）：凭据里的 `iat` 至今仍是登录那一刻 ⇒ **从未续期过一次**。
症状形态恒定：**过期前不自愈、过期后也不自愈、日志零字**，UI 还显示
「有效期 10月25日 · 自动续期」（假象）。

### 引入提交与「为什么以前没看到」

- 唯一肇因提交 **`6da5505`**（2026-10-17 00:47，AutoClaw 首次接入）——
  `git log -S"7 * 86400_000" -- src/autoclaw-oauth.ts` 只命中它，且
  `git show 6da5505:src/autoclaw-oauth.ts` 里那一行**逐字相同**。
  ⚠️ **同一次提交**里还写进了 `refreshAccountWithReconcile` 的 lead-time 跳过
  与 `SELF_HEAL_REFRESHABLE_PROVIDERS` 的登记 ⇒ **上线即带病**，不存在
  「以前能自愈、后来被改坏」的过渡版本。后续 `13aa60d`（审计）未触碰任何
  expires 行。
- 与它无关但易被误认成肇因的两处都更早且对本渠道无语义：
  `healExpiredAccountBeforeBalance` = `0523e74`（10-10）、
  `shouldRefreshNow` = `48b2570`（09-28）；`577b27a`（10-18）给 CodeArts 补的
  refresh 寿命腿 autoclaw 未提供 ⇒ 零行为变化。
- 没被更早发现的原因是**物理上只到过这一次死线**：provider 10-17 才进仓库，
  池内账号建于 10-18 23:02 ⇒ 首次死线就是 10-19 23:02。且症状**每 24 小时
  必然复发**，而「手动修法」（重新登录）会重写 `createdAt` 与假有效期、
  把死线顺延并把证据一起重置（≈ 每次报障都自动销毁现场）。

### 修法（同一真源，三条腿）

1. `src/autoclaw.ts` 新增 `autoclawJwtExpiresAtMs`（读 JWT `exp`，**不验签**：
   网关自己也只按 `exp` 判）与 `autoclawAccessTokenExpiresAtMs`
   （**JWT 优先，声明值兜底**）；
2. 三个写入点（`loginAutoclawWithCode` / `refreshAutoclawToken` /
   `probeAutoclawLocalCredential`）与解析点 `parseAutoclawCredential` 共用它；
   **删除 7 天编造** ⇒ 两者都读不到时返回 `undefined`（= 不知道），由
   `shouldRefreshNow(undefined) === true` 放行续期（宁可多刷一次，不可编造）；
3. ⚠️ **纠正点必须是「每次 parse」**：存量坏凭据躺在用户目录里不会自己变，
   parse 一返回真死线，下一轮 `refreshAll` 立刻放行 ⇒ **无需重新登录**即自愈
   （成不成取决于 refresh_token 是否仍被上游接受；不成会按既有终态逻辑
   标 `refreshable:false` 并提示重登）。

### 守卫与变异验证（2026-10-19 实测，本仓库纪律）

新增 8 条用例（`tests/unit/autoclaw.spec.ts` 的「★★ access_token 死线以 JWT 为准」
与登录/续期路径），并与既有 `isAutoclawTokenExpired` 用例互补。变异验证归因：

| 变异 | 结果 | 结论 |
|---|---|---|
| M1：砍掉 `autoclawAccessTokenExpiresAtMs` 的 JWT 腿（`return declaredExpiresAtMs`） | **6 条红** | JWT 权威这条腿有牙 |
| M2：在 `loginAutoclawWithCode` 恢复 `Date.now() + 7 * 86400_000` | **仅 1 条红**（「两者都没有时必须是 undefined」） | ⚠️ 删除兜底这条腿**只**由那一条守着；JWT 那几条**抓不到**它（因为 JWT 优先会掩盖兜底）⇒ 两条腿的守卫不可互相替代 |

⚠️ 还修了一处**零判别力的旧断言**：原用例只写
`expect(cred.expires_at).toBeGreaterThan(Date.now())`，对「+7 天编造」**恒真**
（本次同时补上「差值必须 < 2 天」的量级断言）。这正是缺陷当初漏过测试的地方。

### 未验证项（如实登记）

- **续期端点是否仍接受这批 refresh_token**：未测。本仓库红线是
  「诊断脚本不得对真实凭据发起 refresh」（曾因此烧掉两个真实账号）
  ⇒ 只能由修复后插件的正常 `refreshAll` 去试，其终态由既有逻辑表达。
- **桌面端一键导入路径**（`probeAutoclawLocalCredential`）改为 JWT 优先后，
  若桌面端自写的 `expiresAt` 与 JWT `exp` 不一致，现以 JWT 为准 ——
  本机未登录桌面端，**未真机取证**。本次三个坏账号走的是短信登录路径
  （`expires_at` = 登录时刻 +7 天 ⇒ 该路径不经过 JWT 解析），故与本项无关。
- `parseAutoclawCredential` 里 `expires_in`（相对秒数）分支仍以**读取时刻**
  为基准换算 ⇒ 若某天有实现把相对秒数写进凭据，每次读取都会往后平移。
  当前落盘的是绝对毫秒 `expires_at`，**未触发**，故未改（不扩大范围）。

## ⚠️⚠️ 401 按需续期：**续的必须是「本次实际用的那个账号」**（2026-10-27 两轮审计）

PR154 的**根因链完全成立**（这三段已被两位审计员逐行复核）：

```
401（AT 到期）
  → autoclaw-adapter.ts 的 401 重试判据带 `&& this.options.refresh`
    而两站自 6da5505（首次接入）起都没传过它 ⇒ 不续期、不重发
  → autoclaw.ts 的 isAutoclawAuthError 首条命中 'invalid token' ⇒ 归 'AUTH'
  → 客户端（dsh-client-ui-chat 的 failureMessage）把 message **换成固定文案
    「API 密钥无效」并丢掉原文**
```

**但第一版修法在多账号池下不成立**——这也是本仓库里「注释写得越确定越要验」的又一例。

### ① 续错号：两条**不同**的选号规则

第一版闭包用 `pool.getAvailableAccount(AUTOCLAW.id, '')` 取号，而请求实际用的凭据
来自 `createCredentialResolver` → 该家接了 `balance: { kind: 'buddy' }`
⇒ **用哪个号由余额分档决定**：

| 判据 | 请求用的号（分档） | 第一版的续期号 |
|---|---|---|
| 排序 | 按到期档位（`pickBuddyAccount` + `buddyBalanceTier`） | **用户手动序第一个** |
| 限流过滤 | 按**真 `modelId`** | 传 `''` ⇒ **整体短路**（`account-pool.ts` 的 `modelId.length === 0`） |

实测（真跑 `createCredentialResolver` + 复刻池逻辑）：分档选中 **B**，
`getAvailableAccount` 返回 **A** ⇒ 401 后 **续 A、重发仍用 B 的旧 token**
⇒ 401 原样复现，而 A 被白轮换一把 RT。
端到端三次请求的结果是 `["AUTH","AUTH","AUTH"]`，`grant RT` 是
`["RTA-0","RTA-1","RTA-2"]`（**全是无关账号**）。

⚠️ 更隐蔽的第二层：即使续对了号，`adapter` 重发前还会**重新 `resolveCredential`**
（又选一次号）⇒ 可能挑回另一个号。

### ② 修法：把「本次用的凭据」交给回调，并**用它返回的新凭据重发**

```ts
// src/autoclaw-adapter.ts
refresh?: (used?: AutoclawCredential) => Promise<void | AutoclawCredential>
// 适配器：const renewed = await this.options.refresh(credential)
//          → 形状可用就直接用它重发（不再 resolveCredential）
// src/index.ts（两站各一条）
refresh: async (used) => {
  const accountId = used?.access_token
    ? await pool.findAccountIdByCredential(AUTOCLAW.id, used.access_token).catch(() => '')
    : ''
  const entry = accountId ? (await pool.listAccounts(AUTOCLAW.id)).find((i) => i.id === accountId) : undefined
  if (entry !== undefined) return await autoclaw.renewCredentialForRef(entry.credentialRef, pool, entry.id)
  // 池里没有这个 token（单凭据路径）⇒ 退默认 ref；**读不到就显式抛**
  const single = await autoclaw.renewCredentialForRef(AUTOCLAW.defaultCredentialRef)
  if (single === undefined) throw new Error('autoclaw: 401 后无可续期的账号…')
  return single
}
```

⚠️ **返回值保持可选**：既有的零参实现、`probeById` 的 `refresh: async () => {}`
仍然合法（返回 `undefined` 时退回旧行为）—— 不破坏任何调用方。

⚠️ **池空兜底修前是死路**：`autoclaw.refresh()` 读的 `AUTOCLAW.defaultCredentialRef`
全仓**没有任何写入点**（只有产品定义 + `fallback` 声明）⇒ 它内部
`if (!resolved) return` 静默返回 ⇒ 用户白等一次 60s 超时、然后仍然 401。
现在改成**显式抛错**，让适配器走原有的 401 分类路径。

### ③ per-ref 单飞（去重）：PR154 把「偶发」变「必然」

`AutoclawAuth` 修前**没有任何并发保护**（全仓唯一的 in-flight 表在
`autoclaw-credits.ts`，**不覆盖这条腿**）。实测同一 ref 并发 3 次
⇒ **3 份 grant，三份都用同一把 `RT-0`**。

- **PR154 之前**：401 根本不续期，只有「定时器 / 面板按钮 / 积分自愈」三条入口 ⇒ 偶发；
- **PR154 之后**：DSH 每轮并发发「主回复 + 标题 + 压缩」三条请求 ⇒
  每次过期边界**必然**撞车。

这与 `docs/adding-a-new-provider.md:143-147` 的明文纪律冲突
（「三条续期入口会并发消费同一份 `refresh_token` ⇒ 必须上 per-`credentialRef`
的 `SerialQueue`」）。这恰好是 PR155 修掉的那条形态，PR154 又新建了一份。

⇐ 现在 `AutoclawAuth.refreshInFlight`（key = **原始 `refName` 实参**，
与 `MinimaxAuth.renewInFlight` 同口径；`credentialRef()` 只校验**不归一**，
生产三条腿传的都是同一个 `entry.credentialRef` 字符串 ⇒ 无别名风险），
语义是**去重**：命中在飞任务就 `await` 并**返回同一份结果**。

### ④ 终态判据同样是 message 正则（与 minimax 逐字同形）

见 `providers-loomy-raccoon-minimax.md` 的同名小节：`msg.includes('expired')`
/ `msg.includes('401')` 会把 `503 token expired`、`429 key expired soon`、
`certificate has expired` 全判成终态。已收口到 `src/refresh-failure.ts`，
AutoClaw 自己的词汇（`Invalid token`）在调用点显式声明。

### ⑤ 守卫必须**行为级**（第一版是源码文本，实测五种假接线全绿）

第一版在 `autoclaw-lock-wiring.spec.ts` 里用 `readFileSync` + `toMatch`/`toContain`，
红队逐字复刻判据后实测以下**全部绿**：片段塞进字符串字面量、**行尾 `//`** 冒充
（`codeOnly` 只剥整行 `//`）、`if (false) {…}`、`if (Math.random() >= 0) return`
恒早退、整块塞进 `false ? … : async () => {}`。反向还有**假红**：
`refresh: () => autoclaw.refresh()` 这类合法重构会红。

⇐ 现在搬到 `tests/unit/autoclaw-401-refresh-wiring.spec.ts`，**真跑 `apply()`**、
真驱动适配器、让第一次 chat 请求 401，断言「被续的是**本次实际用的那个账号**」
且「重发用的是**新** token」。**7 个变异全部变红**：
忽略 `used` / 不返回新凭据 / 删键 / 不传 `entry.id` / 空实现 / 国际版忽略 `used` /
单飞改回串行。

⚠️ **写这条守卫时踩到的两个坑**（后人会再踩）：
1. **必须按 URL 分流**：本家两个端点的认证头是**相反的**
   （`autoclaw-model-config` 只认 `Authorization`、`chat/completions` 只认
   `X-Authorization`）。若对所有请求都回 401，目录那次也会 401 ⇒ 适配器回落
   兜底表、`stream()` 一次都不发 ⇒ 用例以「没续期」**假红**。
2. **必须钉死请求用哪个号**：若让 `resolveCredential` 自然选，两条规则都选 A
   ⇒ 「续错号」这个缺陷根本不会暴露。用例里改成直接覆盖
   `adapter.options.resolveCredential` 返回 B 的凭据。

## ⚠️⚠️⚠️ 国际版**没有任何可用的登录入口**：Z.ai OAuth 三样全写了但零调用（2026-11-02 真实报障，已修）

### 现象

「AutoClaw（国际版）账号管理」点「+」新建账号，弹窗里**只有一个**选项
「⚡ 一键导入本机桌面端凭据」，而弹窗说明同时写着「**或使用手机短信验证码快速登录**」
—— 承诺的第二个选项根本不存在。用户本机没装客户端 ⇒ 唯一那条路也走不通
⇒ **国际版完全无法添加账号**。

⚠️ **另一处独立缺陷（不在本节范围内）**：同一场景下错误还会被吞成
`connection: invalid server-response failure` —— 根因是 `reply()` 把**字符串** `error`
展开成了字符索引对象（`{0:'未',1:'检',…}`），宿主判 `typeof error.code !== 'string'` 就抛。
修法在**另一个分支**（`fix/rpc-error-shape`：`reply()` 出口归一化 + 源码普查），
**本分支不含**，所以这里不写「见某处」的悬空引用。

### 为什么短信对国际版不可用（这是事实，不是缺陷）

国际版后端**也接受**短信（`/userapi/v1/agent-send-code` 在国际基址回 `code=0 SUCCESS`），
但国际账号是**邮箱 + OAuth 创建**的：`account-profile.json` 里 `phone: null`，
且**没有绑手机号的端点**（`agent-bind-phone` / `bind-phone` 全 404）。
依据：`src/autoclaw-product.ts` 那张「为什么是两个 provider」的表（登录方式一行写的就是
「国内：短信验证码 / 国际：**Z.ai OAuth**」）+ `src/autoclaw-oauth.ts` 文件头。

⇒ 客户端 `autoclawSmsAvailable = provider === 'autoclaw'` 是**对的**，但那意味着
**国际版一个登录分支都不渲染**。

### 真正的缺陷：Z.ai OAuth 这条路是**死代码**

三样都在，但**零调用方**（2026-11-02 接线前的 `grep` 实测；下表的「0」是**当时**的数字，现在见文末「接线后」表）：

| 存在的东西 | 调用方 |
|---|---|
| `AutoclawAuth.buildZaiAuthUrl()` | **0** |
| `AutoclawAuth.loginWithZaiCode()` | **0**（只有定义与文档引用） |
| `AUTOCLAW_OAUTH_CALLBACK_PATH = '/auth/callback-zai'` | 只出现在常量定义与注释 |
| `exchangeAutoclawZaiCode()` | 只被上面那个零调用的 `loginWithZaiCode` 调 |

本地登录服务的路由当时只有 4 条：`GET /autoclaw/login`、`POST /autoclaw/send-code`、
`POST /autoclaw/submit-code`、`POST /autoclaw/import-local` —— **没有回调路由**；
登录页 HTML 写死国内形态（短信 + 一键读本机），**不区分站点**。

⚠️⚠️ **方法可推广**：本仓已多次出现「写了但没接」的形态
（`SELF_HEAL_REFRESHABLE_PROVIDERS` 漏登记、`WIRED_EXPIRY_PROVIDERS` 漏一家、
`AGGREGATE_CHANNELS` 加错表）。**判据永远是 `grep` 调用方，不是「方法存在」** ——
这次就是三个方法 + 一个常量整整齐齐摆着，功能却完全不可达。

### 修法（四处，缺一不可）

| 位置 | 改动 |
|---|---|
| 登录页（`startAutoclawSmsLoginFlow`） | 按 `product.id` 分裂：国内渲染短信表单；**国际渲染 `<a href="{buildAutoclawZaiAuthUrl(redirectUri)}">` 授权按钮**，且**不渲染** `id="phone"`（否则用户白试一次） |
| `redirectUri` | 两处都从 `req.socket.localPort` **现算** —— 端口是 `listen(0)` 分配的，只有收到请求时才知道；OAuth 要求授权时的 `redirect_uri` 与换 token 时的 `navigate_uri` **逐字节相同** |
| 新增 `GET /auth/callback-zai` | `code` + `state` → `exchangeAutoclawZaiCode(..., redirectUri)` → `settleOk({ credential, phone })`。⚠️ **失败不要 `settleErr`**：那会立刻结束整个 flow（user 连重试都不行），只回错误页让用户再点一次 |
| 客户端 `plugin-src/client/jet-hub.js` | 新增 `autoclawZaiAvailable`；国际版渲染 `{ value: 'zai', label: '🌐 使用 Z.ai 账号登录' }`（非 `local` 的取值会落到 RPC 的「其它情况」分支 ⇒ `startLogin` ⇒ 打开登录页）；说明文案按站分；**默认值国际版落 `zai`**（`local` 要求本机装了客户端，默认选它等于默认走最可能失败的路） |

### 守卫与变异验证

`tests/unit/autoclawintl-zai-wiring.spec.ts`（5 条，**不连外网**：假 `fetch` 接住换 token 请求）：

| 变异 | 结果 |
|---|---|
| 登录页不再按站点分裂（`smsLogin = true \|\| …`） | **3 红** |
| 删掉回调路由（回到死代码状态） | **2 红** |
| 换 token 时把 `navigate_uri` 加个后缀 | **1 红**（逐字节断言） |
| 客户端选项值改成 `zai-disabled` | **1 红** |

⚠️ **第四条第一次是假绿**：我原本断言 `toContain("value: 'zai'")`，而 `jet-hub.js` 里
**zcode 的登录渠道**也有一处 `{ value: 'zai', label: '🌐 z.ai（chat.z.ai，国际版）' }`
⇒ 裸断言被它兜住，五条用例全绿。改成锚定整段
`"value: 'zai', label: '🌐 使用 Z.ai 账号登录'"` 后才有牙。
**这就是「源码级断言必须锚定片段」的第 N 次实证。**

### ⚠️ 两处「仍是死代码 / 未消费」的遗留（已登记，本轮刻意不动）

| 符号 | 现状 | 为什么不动 |
|---|---|---|
| `AUTOCLAW_OAUTH_CALLBACK_PORTS = [18432, 19654, 19723, 53699]` | **零消费**（只有定义） | 注释自称「与官方客户端 `OAUTH_CALLBACK_PORTS` 逐字相同」，但新实现用 `listen(0)` 随机端口 ⇒ 两套设计并存。**若 Z.ai 对 `redirect_uri` 做端口/主机名白名单，功能会直接死在授权页**（见「未验证」第 1 条）。改成消费它（按候选端口逐个 `listen`、全占用再退随机）需要真实上游才能判断哪种更稳，**先登记** |
| `AutoclawAuth.buildZaiAuthUrl()` | **零调用** | flow 里用的是**模块级** `buildAutoclawZaiAuthUrl`（它不依赖 `AutoclawAuth` 实例）。两个同义入口并存 = 下一个维护者可能改一个忘另一个。**登记：改授权 URL 拼法时两处一起改**（或直接删掉类方法） |

### 未验证（如实登记）

- **真实 Z.ai 授权页的端到端**：需要人工在浏览器里点授权（自动化会弹真窗口，本仓纪律禁止在单测里做）。
  已用假 `fetch` 验证了「登录页 → 授权 URL → 回调 → 换 token → settle」的**全部接缝**，
  唯一没验的是 `chat.z.ai` 真实授权页把 `code`/`state` 带回来的那一步。
- `AutoclawAuth.loginWithZaiCode()` 仍是**零调用**：flow 里走的是 `exchangeAutoclawZaiCode`
  （`loginWithZaiCode` 内部要 `ctx.credentials` 自落盘 + 领积分，而 flow 的职责是
  「返回凭据、由 RPC 侧落盘」—— 与短信路径同形）。留着不删是因为它是已导出的公开方法，
  但**登记在此：它不在任何生产路径上**。
- **`redirect_uri` 是否被上游按端口/主机名白名单校验**：官方客户端用 4 个**固定端口**
  （见上表），而本实现用 `listen(0)` 随机端口 + `127.0.0.1`。公开 OAuth client 做严格
  字符串匹配是常见做法 ⇒ **若匹配，功能直接不可用**。不碰真实上游无法判断。
- **`verifyCredentialSite` 会不会拒掉 Z.ai 换出的 token**：回调 `settleOk` 之后，RPC 还要
  打一次余额端点（`fetchAutoclawBalanceDetailed`）校验归属，失败就 `failLogin` 删账号。
  单测里的假 `fetch` 只认换 token 端点、其余返 500 ⇒ **这条真实网络请求零覆盖**。
  若 Z.ai OAuth 返回的是 z.ai 平台 token 而非 AutoClaw access_token，整条路径会在最后一步被拦下
  （有防线、但功能不通）。
- **我们并不发送 `state`**：`buildAutoclawZaiAuthUrl` 只设 `response_type` / `client_id` /
  `redirect_uri`（刻意不生成 state，见文件头「关于 state.nh」）⇒ 真实回调很可能**没有**
  `state` 参数，此时透传空串。单测用伪造的 `state` 让「原样透传」断言成立，**不能**证明真实链路。

### 审查后追加的修复（2026-11-02，两路只读审查 + 红队，共 11 条必修）

| # | 必修 | 处置 |
|---|---|---|
| 1 | **回调路由未按站点门控** —— 国内版 flow 上 `/auth/callback-zai` 竟可 settle（实测会把 Z.ai 凭据写进国内槽位），成功页还写「国际版」 | 路由开头加 `product.id !== AUTOCLAW_INTL.id ⇒ 404`；成功文案中性化 |
| 2 | **180s 等待窗口偏短**（buddy 5min / accio 10min / astudio 5min）—— 超时后关窗口、删账号、回跳 `ECONNREFUSED` | `startLogin` 按站点给：国际版 **600 秒**，国内仍 180 秒 |
| 3 | **成功页在 `verifyCredentialSite` 之前宣告「已绑定」** —— 浏览器说成功、IDE 说失败 | 改成「授权已完成，正在绑定账号 —— 请返回 IDE 查看结果」 |
| 4 | **`exchangeAutoclawZaiCode` 仍编造 7 天有效期**（IKOYEG 的第四处写入点，本轮把它接成生产路径 ⇒ P0 复活） | 改用 `autoclawAccessTokenExpiresAtMs(accessToken, 声明值)`：JWT 优先、都读不到就 `undefined`；补「上游不给 expires_*」用例 |
| 5 | **OAuth 路径缺同账号去重** —— 同一账号授权两次会出现两张卡片、积分翻倍（2026-10-19 那次 62416 的同型） | 落库前按 `user_id` 去重：新凭据写给已存在那条 → 删本次占位 → 留 info 日志；`provider` 用 `autoclawProduct.id`（短信那条硬编码 `AUTOCLAW.id`，对国际版恒查不到） |
| 6 | **三处注释仍写「国际版登录尚未接入 / 只能手工注入 token」**（`autoclaw-product.ts` / `provider-registry.ts` / `index.ts`，其中 `index.ts` 还预告了一个不存在的 `login.startOAuth` 分支） | 三处同批改成「已于 2026-11-02 接入」，并写明实现形态 |
| 7 | 判据假绿：`not.toContain('id="phone"')` 挡不住「换个 id 的表单」 | 改断言「国际版页 **`<input>` 计数为 0**」+ `type="tel"` 也为 0 |
| 8 | 判据假绿：`code`/`state` 断言打在**用例自己的字面量**上（实现写死也绿） | 每次运行生成**随机 nonce** |
| 9 | 判据无牙：「仍 pending」只用 120ms race（抓不到延迟 settle，也分不清「不 settleErr」与「什么都没写」） | 改成**失败后重试一次必须成功**（确定性），并断言 `bodies` 依次是坏 code → 好 code |
| 10 | 判据假绿：客户端四条断言只锚字面量 | 锚点跨「条件展开 + 字面量」：`...(autoclawZaiAvailable ? [{ value: 'zai' …`，另加 sms 侧同款与「不得用或式」互斥判据 |
| 11 | 真实用户路径零覆盖：`startLogin` 里把 `product` 写成国内 `AUTOCLAW` **零红** | 新增「`new AutoclawAuth(AUTOCLAW_INTL).startLogin()` 的页面必须含 Z.ai」 |

### ⚠️⚠️ 自查追加的两条（2026-11-02，写完全部必修后自己复审去重块时发现）

两条都**不在审查员的清单里**，是把去重块逐行过一遍才发现的：

| # | 缺陷 | 症状 | 修法 |
|---|---|---|---|
| 12 | **查重时读池抛错 ⇒ 走 `.catch` ⇒ `failLogin` ⇒ 删账号** | 去重跑在 `started.result.then(...)` 链上，而该链统一 `.catch(error => failLogin(id, error))`。可此刻**凭据已经换到手了** ⇒ 把「查重依赖不可用」判成「登录失败」⇒ 用户看到「登录失败」而实际授权成功、占位条目连同刚拿到的凭据一起被清掉，只能重来一次 | 包 `try/catch`，读池失败记 warn 后**照常落库**（「读不到 ≠ 没有」，与 `poolEntryOf` 返回 `unknown` 同取向；与 officeace 那条注释同一个教训） |
| 13 | **命中的原卡已被用户停用 ⇒ 并入后仍是停用** | 用户手动停用某张国际版卡片 → 用同一个 Z.ai 账号重新授权 ⇒ 新卡并入老卡并删除新卡 ⇒ 老卡**依旧停用** ⇒ 面板「新卡片消失、老卡片灰着」= 用户以为没登上；若那是唯一账号，还会因「无已启用账号」整组隐藏 | 并入时若 `existing.enabled === false` ⇒ 一并 `enabled: true` 并记 warn（语义与 officeace 的 P2 同口径：**用户刚主动用这个号登录过，就是想让它可用**） |

**守卫**：`tests/unit/autoclaw-oauth-dedupe.spec.ts` 各加一条（读池抛错 ⇒ 条目还在 + 凭据落盘；原卡停用 ⇒ 并入后 `enabled === true`）。
**变异**：去掉 `try/catch` ⇒ 该条红（1s 超时形态 = 账号被删、永远等不到凭据）；去掉 `...(wasDisabled ? { enabled: true } : {})` ⇒ 红；判据反向（`enabled === true`）⇒ 红。三条均恢复 `IDENTICAL`。
**变异复验（全部打红，恢复逐字节一致）**：`<input>` 换 id（2 红）／`code` 写死（2 红）／失败即 `settleErr`（红）／删站点门控（1 红）／恢复编造 7 天（1 红）／zai 挂错条件（1 红）／默认值改回 `local`（1 红）／`startLogin` 写死国内（1 红）／去重 `provider` 写死国内（1 红）／整段删去重（2 红）。

**接线后的事实**（与上表对照）：`AUTOCLAW_OAUTH_CALLBACK_PATH` 已在 3 处被使用（登录页拼 URL、路由判路、回调拼 `redirect_uri`）；`exchangeAutoclawZaiCode` 由回调直接调用；`buildZaiAuthUrl` / `loginWithZaiCode` 仍 0 调用（见上「遗留」表）。

## ⚠️⚠️⚠️ 第二轮真机报障：`/auth` **不是授权端点**，缺 `state` 直接走不下去（2026-11-02，已修）

### 现象（用户截图 + 复述）
点「🌐 使用 Z.ai 账号继续」⇒ 浏览器里 Z.ai 登录**成功**（已经能看到 GLM-5.3 首页）⇒ **停在 `chat.z.ai` 首页**，我们本地 `/auth/callback-zai` **一个请求都没收到** ⇒ 面板一直等，最后超时；用户看到的永远是「尚未配置账号」。

### 服务端探针（全部**匿名** GET，无凭据，可复现）

| 请求 | 响应 |
|---|---|
| `GET /api/oauth/authorize?client_id=…&response_type=code&redirect_uri=…`（**无 state**） | **422 Unprocessable Entity** |
| 同上 **+ `state=aosi.probe-…`** | **307** → `/auth?response_type=code&client_id=…&redirect_uri=…&state=aosi.probe-…` |
| 同上但 `client_id` 换成 `client_bogus000` | 307（**不校验 client_id**） |
| 同上但 `redirect_uri` 换成 `https://evil.example.com/cb` | 307（**不校验 redirect_uri**） |
| `GET /auth/oauth/authorize?…` | 200（前端路由，不是端点） |

⇒ 两条独立根因：

1. **入口用错了端点**。`https://chat.z.ai/auth` 是它**登录页的前端路由**，不是授权端点。它读 `redirect_uri` **只是为了判断「我在 OAuth 流程里」**（客户端 bundle：`Hht = () => !!t.get("redirect_uri") || gJ() || !!t.get("sso_redirect")`），真正的回跳目标走 `redirect` 参数 / sessionStorage（`L9 = () => IL(new URLSearchParams(location.search).get("redirect"))`，而 `IL` 只认 `/auth/oauth/authorize?` 前缀）⇒ **直接打开 `/auth?...&redirect_uri=...` 时，登录完没有可回的目标，落回首页**。
2. **`state` 一个都没带**。上一轮的设计假设是「`state` 留给官方授权页生成」，但实际是 OAuth 的标准语义：**`state` 由客户端生成、授权端原样回传**。`/api/oauth/authorize` 缺它 **直接 422**；就算用 `/auth` 绕过端点，后面那步 `authorize` 仍会拒绝。

### 修法（四处，缺一不可）
| 文件 | 改动 |
|---|---|
| `src/autoclaw-oauth.ts` | `AUTOCLAW_ZAI_AUTH_URL` → `https://chat.z.ai/api/oauth/authorize` |
| 同上，新增 `autoclawZaiState(now?)` | 生成 `aosi.<base64url(JSON)>`（`{n: 随机, t: 时间}`）；`nh` 仍未知但服务端不硬校验内容 |
| 同上，`buildAutoclawZaiAuthUrl(redirectUri, state)` | 参数从 1 个变 2 个，把 `state` 写进 URL |
| flow 的 GET 处理器 | `buildAutoclawZaiAuthUrl(redirectUri, (pendingZaiState = autoclawZaiState()))` —— 每渲染一次登录页换一个；回调里比对 `pendingZaiState`，**不一致只 `console.warn` 不拒绝**（用户刷新过页面时旧标签页的回调仍应被认领；`state` 在这里是诊断线索，不是防伪） |

### 守卫（`tests/unit/autoclawintl-zai-wiring.spec.ts`）
- 授权链接必须匹配 `href="https://chat.z.ai/api/oauth/authorize?`；
- **不得**出现 `href="https://chat.z.ai/auth?`（端点写回去就红）；
- `response_type === 'code'`；`state` **非空**且以 `aosi.` 开头（只断言「参数存在」不够：空串也能让 `searchParams.get` 返回 `''`）。

### 变异（`C:/Users/Betsy/AppData/Local/Temp/mut-zai-state.cjs`，三条全红、恢复 `IDENTICAL`）
删 `url.searchParams.set('state', state)` ⇒ 1 红；`AUTOCLAW_ZAI_AUTH_URL` 改回 `/auth` ⇒ 3 红；`autoclawZaiState` 返回空串 ⇒ 1 红。

### 可推广的教训
**「把某个参数留给对方填」在 OAuth 里是错误假设。** `state` 的语义就是「本端生成、对端原样回传」；指望授权页替我们生成，等价于把一个必需参数留空 —— 而服务端的表现是 422（明确）或「登录完落回首页」（静默），后者极难归因：**回调端零请求**，面板端只有「等待超时」这一种可观测形态。

## ⚠️⚠️⚠️ 第三轮真机报障：`redirect_uri` 的**端口必须是注册过的**（2026-11-02，已修）

### 现象（用户截图）
上一轮修好端点与 `state` 之后，浏览器地址栏已经是对的
（`chat.z.ai/api/oauth/authorize?response_type=code&client_id=client_EnD0QI8bLRFT8cciLp389Q&redirect_uri=http%3A%2F%2F127.0.0.1%3A60768%2Fauth%2Fcallback-zai&state=aosi.…`），
但页面正文只有一行：

```
{"detail":"Redirect URI not registered for this client"}
```

### 根因
回调地址的**端口**是 `listen(0)` 随机分配的（这次是 `60768`）。已登录用户请求
`/api/oauth/authorize` 时，服务端**校验 `redirect_uri` 白名单** —— 未注册的端口直接拒绝。

`AUTOCLAW_OAUTH_CALLBACK_PORTS = [18432, 19654, 19723, 53699]` 本来就是这个用途
（官方客户端注册的那几个），但在本次接线之前它是**零消费**常量（审查员已登记「与 `listen(0)` 设计冲突」）
⇒ 缺陷一直在，只是走到真机才暴露。

### ⚠️ 探针陷阱：未登录时的 307 **不能**证明端口没问题
上一轮的服务端探针表里，`redirect_uri` 换成 `https://evil.example.com/cb` 也是 **307** ⇒ 我当时据此认为
「未登录时不校验 `redirect_uri`」。**但那只对未登录态成立**：登录后同一个端点会硬校验白名单。
⇒ **凡「某一格在未登录态放行」的结论，都不能外推到登录态**。这条比端口本身更容易再犯。

### 修法（`src/autoclaw-oauth.ts`）
| 改动 | 说明 |
|---|---|
| 新增 `AutoclawCallbackListenable`（结构类型） | `listen` / `once` / `removeListener` 三方法，便于单测注入替身 |
| 新增 `listenOnCallbackPorts(server, candidates = AUTOCLAW_OAUTH_CALLBACK_PORTS)` | 逐个试，成功即返回；**全失败才**回退 `listen(0)` |
| 私有 `tryListen(server, port)` | 挂一次 `listening`/`error`，占用时 `resolve(false)` 不抛 |
| flow 的启动处 | `await listenOnCallbackPorts(server)` 取代 `server.listen(0, …)` |

回退 `listen(0)` 那一支是**刻意的**：4 个端口都被占时（同机开了两个 IDE / 残留进程），
OAuth 反正登不上（未注册端口必被拒），但**本地登录页仍要能打开** —— 至少用户能看到页面与错误。

### 守卫（`tests/unit/autoclawintl-zai-wiring.spec.ts`，14 条）
- 集成格：`AUTOCLAW_OAUTH_CALLBACK_PORTS` 必须 `toContain(new URL(redirectUri).port)`；
- 3 条端口选择用例（`fakeServer(busy)` 替身 + `queueMicrotask` 派发）：第一个可用 ⇒ `calls === [ports[0]]`；
  前两个占用 ⇒ `[...busy, ports[2]]` 且不含 `0`；全占用 ⇒ `[...全部, 0]`。

### 变异（`C:/Users/Betsy/AppData/Local/Temp/mut-autoclaw-port.cjs`，两条全红、恢复 `IDENTICAL`）
直接 `listen(0)` ⇒ **4 红**（含集成那条）；只试第一个候选 ⇒ **2 红**。

### 可推广的教训
1. **「随机端口」在 OAuth 里是错的默认值。** 回调端口是**在对方那里注册过的常量**，不是随便挑一个；
   随机端口只在「对端不校验」时才碰巧能用。
2. **一个参数的前置条件可能只在「已登录」分支里生效**（见上面的探针陷阱）。
   诊断这类问题不能只打一次匿名请求，要区分「未登录 / 已登录」两种状态。

### 追加：端口只是第一层 —— 真正的机制是**服务端签发**（同日第二次修复）

端口改对之后（真机地址栏已经是 `127.0.0.1:18432`），**报错一字未变**：
`{"detail":"Redirect URI not registered for this client"}`。

⇒ 说明「未注册」指的不是端口，而是**这一组 `(client_id, redirect_uri, state)` 没在服务端登记**。

**客户端 `dist/main.cjs` 里根本没有 `client_id` 常量。** 它的顺序是：

```js
// 1) 先起 loopback（端口 18432/19654/19723/53699，路径 /auth/callback-zai）
// 2) 向**服务端**要授权地址
const t = await this.post('/userapi/overseasv1/zai-oauth-url', { navigate_uri });
const oauthUrl = a.data.oauth_url, state = a.data.state;   // ← 由服务端签发
// 3) 打开 oauthUrl → 回调拿 code+state → 4) POST zai-oauth-login
```

我们此前是**照抄**一次真实 URL 里的 `client_id`（`client_EnD0QI8bLRFT8cciLp389Q`）
自己拼 URL + 自造 `aosi.xxx` 的 `state`。抄来的那组 `state` 早已随上一轮流程失效，
服务端找不到「这个 `redirect_uri` 属于哪次注册」⇒ 报成「redirect_uri 未注册」。
**这个报错文案极具误导性**：它让人以为是端口/路径问题（两者其实都已经对了）。

#### 修法
| 改动 | 说明 |
|---|---|
| 新增 `AUTOCLAW_ZAI_AUTH_URL_PATH = '/userapi/overseasv1/zai-oauth-url'` | 服务端签发端点（`overseasv1`） |
| 新增 `fetchAutoclawZaiAuthUrl(navigateUri, options)` | POST `{navigate_uri, source_id, device_id}`（管理头与 `zai-oauth-login` 同一组）；解析 `data.{oauth_url,state}`；失败**不抛**，返回 `{ok:false,error}` |
| 登录页 GET 处理器 | 改为 `async`（`createServer` 里 `void handleRequest(req,res)`）；先申请，成功用它给的 `authUrl`/`state`，失败**降级**为自拼并在页面上显示原因 |
| `handleRequest` | 从 `createServer` 的内联回调抽成具名函数（异步体不能写在内联回调里还能 `await`） |
| `escapeHtml` | 从回调分支的局部函数提升为模块级（登录页也要用） |

#### 守卫（新增 2 条，共 16 条）
- ★★★「必须向 `zai-oauth-url` 申请，并用它返回的 URL 与 state」：断言请求体 `navigate_uri` 等于回调地址、
  页面 `href` 的 `client_id`/`state` 来自假上游（`client_stub`/`aosi.server-issued`）、
  且**页面不含**自拼常量 `AUTOCLAW_ZAI_CLIENT_ID`；
- ★「申请失败时必须降级并**把原因显示出来**」（否则用户只会看到 Z.ai 那句误导性报错）。

#### 变异（全部打红、恢复 `IDENTICAL`）
跳过服务端签发 ⇒ 2 红；申请时不带 `navigate_uri` ⇒ 3 红；`zaiIssue` 恒为空（告警永不显示）⇒ 1 红。

#### 可推广的教训
1. **「抄一个真实 URL 的参数」不等于「复刻协议」。** 那段 URL 里的 `client_id` 是常量没错，
   但 `state` 是一次性的、且与 `redirect_uri` 在服务端**成组注册**。照抄静态部分、自己编动态部分，
   得到的是一组「自洽但不合法」的参数，服务端报错却指向静态部分（`redirect_uri`）。
2. **同一句报错可能有两个独立成因。** 端口修好后报错逐字不变，就该立刻怀疑「报错指的不是我以为的那件事」，
   而不是继续在同一条腿上找。
