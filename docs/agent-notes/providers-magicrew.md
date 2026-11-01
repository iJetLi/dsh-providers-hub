# 超级麦吉（Magicrew）provider 笔记

> ⚠️ 本文件是**知识库**而非运行时依赖（`src/` 不引用它）。改实现前先读这里。

## ⚠️⚠️ 便携版浏览器导入：注册表那条腿（2026-10-30 四路审计修）

Gitee PR !162 声称「扫描 Windows App Paths 对应的便携版 `Data` / `User Data`」，
审计查出 **5 个真缺陷 + 14 处无牙守卫**（`Data` 候选这个**核心修复本身零覆盖**）。
**全部已修并补上守卫**。

### 真缺陷与修法

| # | 缺陷 | 修法 |
|---|---|---|
| **P0** | **`reg.exe` 输出不是 UTF-8**，是**系统 OEM 代码页**（中文 Windows = GBK）⇒ `encoding:'utf8'` 把中文解成 **U+FFFD（不可逆）** ⇒ 拼出不存在的目录；且 `basename()` 守卫只看 ASCII 后缀 ⇒ **乱码路径照样通过** | `encoding:'buffer'` 取原始字节 + `decodeRegistryOutput()`；⚠ **代码页必须读权威的 `OEMCP`**（`HKLM\SYSTEM\CurrentControlSet\Control\Nls\CodePage` 的 `OEMCP` 值，本机 = **936**）—— **不能**按 locale 猜（ja=932 SJIS / ko=949 / **zh-TW=950 Big5**，都不是 GBK）；⚠ 且 `Intl` 的 locale 是**用户区域格式**、不一定等于 UI 语言 |
| **P0** | **`dirname(dirname(exe))` 硬编码两级** ⇒ `<install>/chrome.exe` 布局**高一级** ⇒ 永远读不到 | **逐级向上探测**（起点是 **exe 所在目录**，最多 4 级）+ 存在性判据（该级下有 `Data/Default` 或 `User Data/Default`） |
| **P1** | **核心修复零守卫**：删掉 `join(install,'Data')` ⇒ 全部用例**全绿** | 补**行为级**守卫（造真实目录树，断言 `Data` 根被认出来；两种布局各一条） |
| **P1** | **`spawnSync` 无 `timeout`** ⇒ `reg` 卡住即**无限期冻结** Electron 主进程 | 加 `timeout: 5_000`（同仓 `killProcessTree` 的 `taskkill` 早有 `timeout: 10_000` ⇒ 同纪律漏了） |
| **P1** | **`chrome://newtab/` 被抢**：实测 `new URL('chrome://newtab/').hostname` = `'newtab'`（**非空**）⇒ 旧兜底 `?? pages[0]` 会**导航用户正在看的标签页** | 只导**空白页**（**前缀**匹配：`about:blank` / `chrome://newtab` / `chrome://new-tab-page` / `chrome-search://local-ntp` / `edge://newtab` …）；**没有空白页就不导航** |
| **P1** | **导航失败 ⇒ 删号**：`ensureLoginPage` 抛错 ⇒ `failLogin` ⇒ **占位账号被删**，而**窗口还开着**、用户可自己登录 | 导航失败**只记 warn、不抛**（`cdp === undefined` 仍抛）+ **接线级兜底 try** + 行为级守卫（注入抛错的 `ensureLoginPage` ⇒ 断言**不抛**且 **dispose 未被调用**） |
| **P2** | **标准安装推出垃圾路径**（`C:\Program Files\Google\Data`）⇒ 污染目录列表 + 扫无关目录的 localStorage | **存在性过滤**（一处同时治编码错/布局错/垃圾路径） |
| **P2** | 每次 `magicrewBrowserRoots()` 同步跑 8 次 `reg query`（实测 **399~550ms**），`readLocalBrowserCreds` 对 2 个 hostname 各调一次 ⇒ **~1.1s 事件循环冻结** | **进程级缓存**（5 分钟 TTL，`windowsRegisteredBrowserPathsCached`）+ 可注入查询器 |
| **P2** | `REG_EXPAND_SZ` 的 `%VAR%` 展开会把**不存在**的变量替换成**空串** ⇒ 路径被**改短** ⇒ 误命中别的路径 | 只展开**环境里真的有**的变量；不存在的**原样保留**（⇒ 存在性过滤正确筛掉） |
| **P3** | `basename(executable) !== name` **误杀系统 Edge**（实测 `App Paths\msedge.exe` 的值是 `Microsoft Edge.exe`）⇒ 生产函数本机返回 `[]` | 判据改成「值是个存在的 `.exe`」（产品归属由**注册项键名**保证） |
| **P3** | `/\bREG_SZ\b/i` **不匹配 `REG_EXPAND_SZ`**（`\b` 在 `_` 前不成立）⇒ 含 `%VAR%` 的默认值被漏 | 正则改成 `/\bREG_(?:EXPAND_)?SZ\b/i` + 环境变量展开 |
| **P3** | 导航复用 3 秒的凭据超时 ⇒ 真机实测黑洞地址 15 秒未返回 ⇒ 用户看到内部超时文案 | 导航独立用 `CDP_NAVIGATE_TIMEOUT_MS = 30_000` |

### ⚠️⚠️ 前提本身不成立（**未修已登记**）

**便携版 Chrome 不注册 App Paths**（那是**安装器**的行为）⇒ 这条腿在**最需要它的
便携版场景**下恒不产出（实测本机 `App Paths` 下只有 Edge/360 系/magpie，
**无 `chrome.exe` / `chromium.exe`**）。

⇒ **真兜底只有 `MAGICREW_CHROME_USER_DATA`**（环境变量）。
⇒ 注册表那条腿保留的价值：① 少数工具确实登记；② `Data` 候选对**已注册**的
绿色版软件仍然有效。

### ⚠️⚠️ about:blank 竞态**真机未复现**

真机（scoop chromium 154）实测：带 URL 启动时 CDP 就绪那一刻 page URL
**已经是**目标 URL；**不带** URL 时是 **`chrome://newtab/`**（**不是**
`about:blank`）⇒ 真机上 `ensureMagicrewLoginPage` 走的是「同站点不导航」分支。

⇒ PR !162 的那条声称（「用户面对 about:blank」）**前提未成立**。
⇒ 但「空白页总得处理」仍然成立 ⇒ 本次改成**只导空白页**（三种形态）。
⇒ ⚠️ **未修已登记**：是否该**改用 `Target.createTarget` 新开一个标签页**
（而不是抢现有空白页）—— 需要真实环境评估（用户可见行为变更）。

### ⚠️ 关于 leveldb 读取

读取方是 `magicrewProfilesOf(root)`（只认 `Default` 与 `Profile N`）+
`join(root, profile, 'Local Storage', 'leveldb')` ⇒ **相对结构**是
`<root>/<profile>/Local Storage/leveldb` ⇒ 便携版的 `Data` 根**只要**
profile 目录名是 `Default` / `Profile N` 就**同构**。
⚠️ **便携版实际的 profile 目录名零实测**（本机无便携版 Chrome）。

⚠️ **未修已登记**：leveldb **单文件**读失败被静默跳过（可能只剩半条记录）⇒
「读不到」与「用户没登录」同形且零日志（U1）。

## ★★ 两站：国内站与**国际站**（2026-11-01 接入）

本 provider 实际覆盖**两个站**，是**同一个 Go 服务的两个数据面**（协议逐字符同构），
但**账号体系物理隔离** ⇒ 两个独立 provider，实现**零复制**（只差一个 product 常量）。

| | 国内站 | 国际站 |
|---|---|---|
| provider id | `magicrew` | **`magicrewintl`** |
| 展示名 | 超级麦吉 | **MagiCrew**（registry 里作「MagiCrew (国际版)」） |
| 网页 | `www.letsmagic.cn` | `www.magicrew.ai` |
| 业务 API host | `i-magic-service.letsmagic.cn` | **`magic-service.magicrew.ai`** |
| 每日签到金额 | **+200 / 天** | **+50 / 天** |
| 强制 `organization-code` | 否（缺了仍 200） | **是**（缺了业务 API 实测回 `code 2182`「用户所在组织不存在」；聊天网关的形态**未定** —— 参考说 500，实测 apiKey 形态下仍 200） |
| 凭据 ref 前缀 | `MAGICREW_ACCOUNT_*` | **`MAGICREWINTL_ACCOUNT_*`** |
| 新人引导任务 | 8 项，**实测 total 450** | **接口恒返回空数组**（见下） |
| 2026-11-01 真实账号实测 | 余额 2661 / 8 项已领完 | 余额 300 →（签到 +50）→ 350（另有推理消耗），目录 27 个模型 |

> ⚠️ **2026-11-01 修正**：同日另一次只读探测（同一端点 `GET /api/v1/quota/points/total`）
> 读到国际站 `total_points: 347` —— 与本行 350 差 3，两个都是**当次快照**（本行已注明
> 「另有推理消耗」）。下面的残差推导用的是 347 那次（批次和 247 + 残差 100），
> 别把其中任一数字当恒定值。

### ⚠️ `api.magicrew.ai` **不是**这套 API

它是 teamshare 网关（`MAGIC_GATEWAY_ADDRESS`），对 `/v1/models`、`/api/v1/*`
一律回 `not match rule path`。真实业务 API 是 **`magic-service.magicrew.ai`** ——
来源：`GET https://www.magicrew.ai/workspace` 的 HTML 里内嵌的运行时配置
`"MAGIC_SERVICE_BASE_URL":"https://magic-service.magicrew.ai"`
（`MAGIC_APP_ENV: "international-prod"`）。

### 签到（`credits.claim`）

`POST <host>/api/v1/login-gift`，**请求体存在且为空串**（不是省略 body）。
幂等：当天已领回 `granted:false` + 「今日已领取登录积分」，**HTTP 仍 200** ——
所以可以每天无脑调用；本插件把 `granted:false` 映射成 `already-claimed`
（**不是** `claimed`，否则用户会以为每天真的在加积分）。
实现：`src/magicrew-checkin.ts` 的 `claimMagicrewLoginGift()`。

### 新人奖励（`onboarding` 域）

`GET /api/v1/onboarding/tasks` + `PUT /api/v1/onboarding/tasks/<code>/completion`。
国内站 8 项，其中 7 项 PUT 即完成。

### ⚠️⚠️ **总额到底是 450 还是 500 —— 实测是 450**

参考实现 `magpie-magicrew-auth/README.md:179` 的**标题**写「8 项，合计 500 积分」，
而**同一页的逐项表相加只有 450**（100 + 7×50）—— 两个数字自相矛盾。

**2026-11-01 用真实账号实测国内站**：`GET /api/v1/onboarding/tasks` 返回
`total = 450`、`earned = 450`（8 项，已全部领完）⇒ **450 是对的，README 标题写错了**。

⇒ 本仓**一律不写死金额**，以 `tasks[].points` 现场累加为准
（`magicrew-checkin.ts` 的 `fetchMagicrewOnboardingStatus`）。
任何注释与用户文案（含卡片 tooltip）都不得写死数字 —— 那条 tooltip 曾经写
「合计 10000 积分」（那是 **Loomy 一家**的总额），对国际站用户就是假账。

⚠️ **`first_ai_work` 回 `9303`「该新人引导任务不支持手动完成」** —— 必须真发一条
消息（走话题 Socket.IO）才置位，且那也正是**邀请奖励**的触发条件。
本插件**不做**那条腿 ⇒ 该项的分与邀请奖励**拿不到**，但会通过
`RpcOnboardingClaimResponse.manualRequired` 如实告诉用户「需你手动完成」，
**不写成** `skipped`（那是「此前已完成」的语义）。

⚠️⚠️ **国际站 `onboarding/tasks` 恒返回 `{participant_type:null, tasks:[]}`** ——
那是「该账号没被登记进引导计划」，**不是**「已经领完了」。所以国际版如实回
`total: 0`，UI 显示「无新人任务」。别把它当成功上报「0 项已全部完成」
（magpie 0.3.7 犯过这个错）。

### ⚠️⚠️ 加国际站时**必须成对登记**的位置（漏一处即静默失效）

`src/index.ts`（auth / resolver / service / adapter / 剪枝 / auths）·
`src/provider-registry.ts` · `src/provider-credits.ts` · `src/provider-onboarding.ts` ·
**`src/provider-expiry.ts`（必须显式传 `product: MAGICREW_INTL`）** ·
`src/canonical-models.ts`（`qwen-3.8-flash` 补丁两站共用同一常量）·
`src/aggregate-adapter.ts` · `src/aggregate-expiry.ts` · `src/jet-hub-rpc.ts` ·
`src/jet-hub-store.ts`（REF_PREFIX）· 客户端 `provider-icons.js` / `jet-hub.js`

⚠️ 其中 `provider-expiry.ts` 漏传 product 的症状最隐蔽：用国内基址查国际账号余额
⇒ 恒失败 ⇒ 折算恒 `UNUSABLE` ⇒ **国际站候选从聚合轮换表里静默消失**
（与 `autoclawintl` 那次同型）。
⚠️ `canonical-models.ts` 漏登记的症状同样静默：国际站自成一个孤立虚拟模型，
聚合的「Qwen3.8-Flash 轮换列表」里永远看不到它（与 `accio` 那次同型）。

⚠️ **2026-11-01 追加（三档积分 / 锁定永久积分）**：`src/index.ts` 里两站还**各自**需要
一份 `BuddyBalanceSelector` 实例 + resolver 的 `balance` 段 —— 漏了就是**假开关**
（registry 的 `permanentLock: true` 只让按钮渲染，点了不拦）。逐条见下节。

## 三档积分与锁定永久积分（2026-11-01）

> 用户 2026-10-12 定的口径，2026-11-01 在两站落地。判据全仓一致，本节只记 magicrew
> 两站的**落地形态**与**取证来源**；通用语义见 `plugin-src/client/credit-expiry.js`
> 与 `src/buddy-balance-rank.ts` 的文件头。

### 三档语义与窗口天数

| 档 | 判据 | 颜色 | 后端两桶（`src/buddy-balance-rank.ts:156`） |
|---|---|---|---|
| `permanent` | 服务端**没给** `deductionEndTime` | 绿 | `permanent` |
| `longTerm` | 有到期时间，但距扣费截止 **≥ 窗口** | 黄 | **并进 `permanent`**（后端只有两桶） |
| `expiring` | 距扣费截止 **< 窗口** | 红 + 倒计时 | `expiring` |

- 窗口默认 **15 天**（`src/buddy-balance-rank.ts:59`）；可被 env
  `DSH_BUDDY_EXPIRING_WINDOW_DAYS` 覆盖（`buddyExpiringWindowDays()` 里的归一 —— 非法值 / 空串
  **回默认、不报错**）。
- 前端三档由 `plugin-src/client/credit-expiry.js` 的 `splitCreditsByExpiry` **复刻**同一判据；
  到期时刻取 `packageExpiryMs()`：**先 `deductionEndTime`，缺失时才回落到 `expiredTime`**
  （2026-11-01 三审更正：本节原写「不是 `expiredTime`」，与代码不符 —— 兜底一直在）；
  **不是** `cycleEndTime`（月度值，会把长期积分误判成快到期）。三个出口（分桶 / 日期列 /
  标签）必须同走 `packageExpiryMs()`，否则同一个包会给出三种结论（三审已修）。
- ⚠️⚠️ **到期时间未知（缺失 / 0 / 非数字 / NaN）一律归永久桶**：后端
  `splitBuddyCreditsByExpiry()` 的 `known` 为假 ⇒ `permanent += remaining`；
  前端 `packageExpiryMs()` 返回 `null` ⇒ 同样落 `permanent`。
  方向**不是单边保守，而是有代价的取舍**（2026-11-01 三审更正：本节原写「宁可少用一个号」，
  把代价说轻了）：
  - **防住的**：把真·永久积分误判成临期 ⇒ 锁定期提前烧掉（不可撤回）；
  - **付出的**：其实仍在有效期内、只是上游没给到期时间的批次会被判成永久 ⇒ 锁定期间
    整号**拒用**，那些积分**锁在外面直到作废**。实测（`expires_at: "2026-11-06T12:00:00Z"`，
    即上游换成带时区的 ISO）该号的临期积分拿不到、到点静默清零。
  - ⇒ 真正可达的触发点是**上游报文格式漂移**（当前 13 条实测报文全是 `YYYY-MM-DD HH:mm:ss`，
    结构可达、生产零实测）。将来上游一旦改格式，**必须**同步 `magicrewParseExpiresAt`，
    否则症状是「面板明明有积分、锁定却报没有」且日志零字 —— 正是本节记的那种失败。
- ⚠️⚠️ **`windowDays` 不是 buddy 专属**：判据是 registry 的 `usesExpiryWindow`
  （`src/jet-hub-rpc.ts:7665`），不是「是不是 buddy」。写死 15 会在 env 覆盖后与真实筛号口径分叉。

### 取证（2026-11-01 两站各一次**只读**探测）

`GET /api/v1/quota/points/total`，两站均 HTTP 200：

| 站 | provider id | `total_points` | `expiring_quota_details` | 批次和 | **残差** |
|---|---|---|---|---|---|
| 国内（超级麦吉） | `magicrew` | **2661** | **11 条** | **1661** | **1000** |
| 国际（MagiCrew (国际版)） | `magicrewintl` | **347** | **2 条** | **247** | **100** |

国内站 11 条构成：200（`2026-11-01 23:59:59`，**探测当天到期**）· 11 + 50×6（6 条，
`2026-11-26 14:58:29` ~ `15:02:54`）· 100（`2027-11-03 23:02:08`）· 50 · 1000（`2027-11-03`）
⇒ 200 + 11 + 300 + 100 + 50 + 1000 = **1661**。国际站 2 条：47（`2026-11-01 23:59:59`）
+ 200（`2027-11-03 23:45:12`）= **247**。

⚠️ **没有独立的永久积分端点**：`/api/v1/quota/points`、`/points/list`、`/points/detail`、
`/points/permanent`、`/points/expiring`、`/points/batches` 六个**全部 404**（2026-11-01 实测）
⇒ 永久积分**只能**用残差推算，别再去找那个端点。

### ⚠️ 残差 = 永久积分（推导）

`permanent = total_points − Σ(expiring_quota_details[].remaining_points)`

- 两站残差都是**正整数**（1000 / 100）且**没有任何到期时刻** ⇒ **最可能**是上游
  **根本不下发到期时间**的那部分（注册奖励 / 活动赠送 / 后台充值）—— 即用户口径的**永久积分**。
- 不合成会怎样：账号卡片 hover 只列批次，「只列 1661、合计 2661」⇒ 用户以为丢了 1000 积分。
- 实现是 `src/magicrew-credits.ts` 里 `permanentRemaining` 那段（搜 `name: '永久积分'`）。
  守恒由 `tests/unit/magicrew-credits.spec.ts` **两处**钉住：一条断言
  `sum(remaining) === total`（合成的那份也算进去），另一条断言 `packages` 恰好 2 条
  （1 条批次 + 1 条合成包）—— 后者是**形状钉**，不是守恒钉。
- ⚠️ `expiredTotal` 恒 0 是**如实为 0**（上游不下发已失效额度），不是算出来的 0
  （见 `src/magicrew-credits.ts` 里 `expiredTotal: 0` 那行的注释；口径同 `src/astudio-credits.ts`）。

### ⚠️⚠️ 两条被取证推翻的旧结论（`⚠️ 2026-11-01 修正`）

**①「`expiring_quota_details` 只下发临期批次」不准确。** 它下发的是「**所有会过期**的批次」：
国内站含 `2027-11-03` 的**远期**批次、国际站含 `2027-11-03 23:45:12` —— 不是「近期 / 临期」，
上游名字里的 `expiring` 只是**命名**、不是判据 ⇒ 判据只有「窗口内 / 窗口外」。
（旧表述已改写进 `src/magicrew-credits.ts` 里标着「两条结论」的那段文档块。）
⚠️ 但 `src/magicrew-credits.ts` 里那句「上游是否**只回还没过期**的批次**未取证**」是
**另一件事**：本次的 13 条（11 + 2）在探测时刻都还没到期，**这条没被推翻**，别顺手改掉。

**② 合成包原名「长期积分」（`longLived`）是命名错误，已改名 `permanentRemaining` / `'永久积分'`。**

⚠️ **「长期积分」在本仓仍是「一词两义」，别 grep 到就用**：`src/magicrew.ts` 里那句
「折算口径（余额为 0 / 批次到期 / **长期积分**）」仍指**残差**（= 现在的永久积分，历史措辞）；
而**聚合层**（`src/aggregate-core.ts` / `src/aggregate-expiry.ts`）说的「长期」= `NEVER` = **无到期**，
与本节的「长期 = 有到期但超出窗口」**正好相反**。改文案前先确认是哪一层。
前端落桶判据是「**有没有 `deductionEndTime`**」：这个包**没有** ⇒ 落 `permanent`（绿）。
叫「长期」会让**展示语义**（黄）与**数据语义**（绿）打架，用户会去找一个并不存在的「长期」分组。
真正的「长期」（黄）是**有到期时间但超出窗口**的批次，**不是**这个合成包
（`src/magicrew-credits.ts` 的合成包注释与 `tests/unit/magicrew-credits.spec.ts` 都写明了）。
⚠️ 改名**只**发生在合成包与相关注释；`tests/unit/magicrew-credits.spec.ts` 里那个用例的**局部变量**
还叫 `longLived`（历史名，断言值已是「永久积分」）—— 看到那个变量名别以为改名没做完。

⚠️ 另外 registry 原先**刻意不登记** `usesExpiryWindow` / `permanentLock` 的两条理由
（「本家不走 `splitBuddyCreditsByExpiry`」「本家没有这个能力」）也被同一份取证推翻
—— `src/provider-registry.ts` 里那段（标题「为什么现在**能**登记」）的旧理由已改写。

⚠️⚠️ **禁止给合成包编造远期 `deductionEndTime`**（两条理由，缺一都不能动这条禁令）：
1. **落桶会错**：编了它就有到期时间 + 超窗口 ⇒ 前端落 `longTerm`（黄），永久分被显示成长期分；
2. **文案与排序都会错**：面板会渲染出「约 N 天后到期」，且 `magicrewExpiry`
   （`magicrewExpiry()`）会把它算进「最早作废时刻」—— 破坏「有余额但无到期时间
   ⇒ `NEVER`」这条聚合排序口径，一个**永不过期**的积分包从此有了假死线。

### ⚠️⚠️ 两个 RPC 与前端**全字段驱动**（积分两 RPC 零分支新增）

- `credits.balances`：通用分支判 `descriptorOf(provider)?.usesExpiryWindow === true`
  ⇒ 回传 `windowDays: buddyExpiringWindowDays()`（`src/jet-hub-rpc.ts:7665-7668`）；
- `credits.permanentLock`：同一判据回传 `windowDays`（`:6785-6789`），白名单
  `PERMANENT_LOCK_PROVIDERS` 由 `PROVIDER_REGISTRY.filter(d => d.permanentLock === true)`
  **派生**（`:724-726`）⇒ 两站只要在 `src/provider-registry.ts` 登记字段就自动进白名单；
- 前端 `plugin-src/client/credits-capabilities.js:225` 的 `supportsPermanentLock()` 读
  `descriptorOf(provider)?.permanentLock === true`、`:279` 的 `permanentLockCopy()` 读
  `usesExpiryWindow`（`:292`）⇒ **`credits-capabilities.js` 在「积分两 RPC」这一批里一行未改**。
  ⚠️ 但 `plugin-src/client/credit-expiry.js` **不再是一行未改**（2026-11-01 三审修了四处前端
  分叉：裸 `Number()`、两套判据、UTC 日期、已过期负数天，见 `protocol-wire.md` 对应小节）。

⚠️ 本批 `src/jet-hub-rpc.ts` **确实有改动**，但那是国际站的**登录 / 导入 / 轮询**分支
（`magicrewintl` 的 auth 键与指纹查找），**不是**积分两 RPC —— 别把两件事混成一件。

⚠️⚠️ **`windowDays` 缺失 = 三档整行静默不渲染**（最值钱的那条坑）：
`plugin-src/client/credit-expiry.js` 的 `normalizeWindowDays` 对 `undefined` / `null` / `''`
返回 `null`，而 `splitCreditsByExpiry` **函数体第一句**（`days === null || !Array.isArray(packages)`）直接 `return null`
⇒ 调用方退化成**不显示分类**。**症状**：积分合计正常、账号卡片正常、**零报错**，
只是没有「永久 / 长期 / 临期」三行配色。
⇒ 判「三档没生效」时**先看 `credits.balances` 响应里有没有 `windowDays`**，别去查配色表。

⚠️ **两条精确化（2026-11-01 二审）**，否则容易按错的因果排查：

1. **`credits.permanentLock` 侧漏传 `windowDays` 不会让整行消失** —— 前端那里另有回落：
   `credits-capabilities.js` 的 `normalizeWindowDays` 对同样输入返回 **15**（与
   `credit-expiry.js` 里那个**同名函数语义相反**！）⇒ 症状是「锁定文案按 15 天写」，
   而三档行仍在。**只有 `credits.balances` 缺 `windowDays` 才会整行不渲染。**
2. **两个 RPC 写的是同一份 state**（`plugin-src/client/jet-hub.js` 里那三个
   `setExpiryWindowDays(res?.windowDays ?? null)`：只读路径与两处锁定回调）⇒ 后到的
   **覆盖**先到的，所以「一个 RPC 传了、另一个没传」不是「没事」，而是「**看谁最后跑**」。
   ⇒ 两侧都必须传。

### ⚠️⚠️ `balance` 段是开关的**承重件**（没有它就是假开关）

`src/provider-registry.ts:1044-1045`（国内）/ `:1118-1119`（国际）的
`usesExpiryWindow: true` + `permanentLock: true` 只做两件事：让面板**渲染按钮**、
让 `credits.permanentLock` **接受写入**。真正**执行**锁定的是
`src/index.ts` 里 `magicrewResolver`（国内）/ `magicrewIntlResolver`（国际）各自的
`balance` 段（**不写绝对行号**：这个文件是全批改动最频繁的，二审期间行号漂了三次）：

```
balance: { kind: 'buddy', selector: …, lockedError: magicrewLockedError('…'), isFreeModel: NO_FREE_MODEL }
```

`kind: 'buddy'` ⇒ 沿 `pickBuddyAccount` 编排：`src/credential-resolver.ts` 的
`const allowPermanent = !deps.pool.permanentLocked(providerId)`（`pickBuddyAccount` 调用前一行；
同文件 Loomy 分支里还有一行同形，别混改）
读 `deps.pool.permanentLocked(providerId)` ⇒ 传 `allowPermanent` ⇒
`src/buddy-balance-rank.ts` 的 `buddyBalanceTier()` 在 `allowPermanent === false` 时把永久桶判成 `none`
⇒ 落到 `lockedError`，**绝不**回落 `getAvailableAccount`。
⚠️ **删掉这一段：按钮照旧、RPC 照旧、锁定一点用没有**（officeace 的原始缺陷，Gitee IKLTHB；
`tests/unit/permanent-lock-execution.spec.ts:260-292` 的 `anchor` 判据就是为这类删除而写）。

`magicrewLockedError(displayName)`（`src/index.ts`，搜 `const magicrewLockedError`）四档文案齐全
（`unknown` / `no-candidates` / `credential-only` / `exhausted` 四档齐全，搜 `reason.kind ===`），
错误码统一 **`QUOTA_EXCEEDED`** 字面量 —— 不能用宿主常量 `'QUOTA'`，后者会被客户端换成
「当前请求的额度已用尽」并**吞掉** message（Issue IKJVCW）；也**不能**用 `AUTH`（会连
message 一起吞掉，而这里的文案本身就是出路：「去哪个面板解锁」「别去解锁」），
更不能用可重试的 `TRANSPORT`（重试一万次也不会好；Loomy 那家才是 `TRANSPORT`，
见 `loomy-balance-error-contract.spec.ts`）。⚠️ `credential-only` 档尤其要**明确劝阻解锁**：
根因是凭据读不出来，解锁只会不可撤回地消耗永久积分。
⚠️ 两站必须传**各自的 `displayName`**（`'超级麦吉'` / `'MagiCrew (国际版)'`，各在自家 resolver 的 `balance` 段）：
两站账号体系物理隔离，用户要知道去哪个面板解锁；`permanent-lock-execution.spec.ts:208-211`
的注释写明「只查裸符号会让一站的接线在、使另一站也绿」。
⚠️ 函数位置在 `loomyLockedError` **之前**（`src/index.ts` 里 `const magicrewLockedError` 前那段
`## 位置约束` 注释）。但**别信那句「插进去会变红」** —— 它是错的：
⚠️ **「插进 Loomy 区间必然变红」是错的**（2026-11-01 二审实测并订正）：`loomy-balance-error-contract.spec.ts`
的终点锚点早在 2026-10-20 就从 `const buddy = new BuddyAuth` 换成了 `'\n  const '`（下一个同级声明），
它自己的注释明写「就是为了别人插 const 时不再被迫挪顺序」；实测在该区间插一个用 `'QUOTA_EXCEEDED'` 的
同级 const，那个切片**逐字节不变**。位置的真正守卫是 `tests/unit/magicrew-lock-wiring.spec.ts` 的
`expect(mine).toBeLessThan(loomy)`。

### ⚠️ `isFreeModel: NO_FREE_MODEL` 是**刻意的保守取舍**

`NO_FREE_MODEL` = `src/credential-resolver.ts:268` 的 `() => false`，该字段是**必填**的
显式表态（见同文件 `:230-267` 的完整文档块 —— 不要删字段）。

⚠️ **定性必须说准：这是「判不了」，不是「本家没有」**。本家**确实有**模型级免费概念
（`src/magicrew-adapter.ts:560` 按 `magicrewIsFree(wirePoints)` 产出 `isFree: true`），
而 `NO_FREE_MODEL` 原文档写的前置条件是「**核实过**该家不存在模型级免费概念」——
magicrew 不满足它，却仍然用了本常量。`src/credential-resolver.ts` 的常量文档里已
**逐条登记了这个例外**（2026-11-01），读那一段，别把它读成「magicrew 没有免费模型」。
为什么不能用真判据：免费判定取决于 `fetchMagicrewModelPoints()` 异步取回、缓存在
**适配器实例私有字段** `modelPoints` 里的 `input_points`，而 `isFreeModel(modelId)` 是
**同步 + 单个 id** ⇒ resolver 这一层没有可注入的同步查询口（装配顺序还是 resolver 在前）。
猜判据的代价是**免费模型静默绕开锁定、真烧掉永久积分**（不可撤回）；保守取舍只在
「锁定 + 该号只剩永久积分 + 用户选的恰是免费模型」这一格多报一次 `exhausted`
（代价：一次余额请求 + 一句可被解锁绕开的报错）。⚠️ 上游到底有没有 `input_points === 0`
的模型**尚未取证**。
⇒ 将来适配器若暴露同步的「modelId → 是否免费」查询（查 `modelPoints` 即可），
这里改成真实判据（与 buddy 系同款），**不是**删字段。

### ⚠️⚠️ 两站**必须各自一份** `BuddyBalanceSelector` 实例

`src/index.ts` 里两个并列的常量：`magicrewBalanceSelector`（`product: MAGICREW`）与
`magicrewIntlBalanceSelector`（`product: MAGICREW_INTL`）。

为什么不能共用：`BuddyBalanceSelector` 在构造期固定 `product`，而 `product` 决定余额请求的
**host**（`i-magic-service.letsmagic.cn` vs `magic-service.magicrew.ai`）⇒ 共用会让国际站账号
用**国内基址**查余额。症状与 `src/provider-expiry.ts` 漏传 `product` 那次**逐字同型**：
国际站余额恒查不到 ⇒ 锁定时永远报「无法确认」/ 永久积分恒 0，而**面板刷新可能仍然正常**
（两条取数路径 ⇒ 别拿「面板能刷新」当反证）。⚠️ 两个 resolver 的 `balance` 段也各写一份
（两个 resolver 各写一份），**不共用**。

### 一个如实登记的副作用（与 buddy 系逐格同构，不是本次新增）

后端只有两桶 ⇒ **锁定时「长期」积分也一起被拦**：`src/buddy-balance-rank.ts:300-301` 把
「有到期时间但超窗口」并入 `permanent` 桶，`buddyBalanceTier()` 在 `allowPermanent === false` 时整桶不看
⇒「只剩 100 天后到期的号」锁定后同样判不可用，而 `magicrewLockedError` 的 `exhausted` 档（`src/index.ts`）
文案只提「永久积分」。这是**既有口径**（buddy / trae / lobsterai / officeace 同款），
要改得六家一起改（独立任务）。登记在此，避免下次把它当成 magicrew 独有 bug 重查一遍。

### ⚠️ 三条**审查挖出来但本批不改**的已知边界（2026-11-01，对抗审查）

1. **国际站 `displayName` 有两个取值**：`src/provider-registry.ts:1100` 是
   `'MagiCrew (国际版)'`，而 `src/magicrew-product.ts:282` 是 `'MagiCrew'`。于是
   **登录 / 导入失败**文案走 `MAGICREW_INTL.displayName`（`src/jet-hub-rpc.ts:4588`）
   叫「MagiCrew」，而**面板 / 锁定错误**叫「MagiCrew (国际版)」（`src/index.ts` 里
`lockedError: magicrewLockedError('MagiCrew (国际版)')` 这一行
   用字面量）。这是**既有**的不一致（国际站接入那天就在），与三档/锁定无关；
   改它要动国际站既有用户可见文案 ⇒ 本批只登记，不改。
2. **聚合候选表不感知锁定**：`src/aggregate-adapter.ts` 的 `availableByModel`（约 `:2366-2373`）
   只问 `getAvailableAccount`，`src/aggregate-expiry.ts:289` 也只有注释 ⇒ 锁定后
   「只剩永久」的账号仍会被聚合**尝试一次**，再由 `src/credential-resolver.ts` 的
`if (picked.kind === 'locked')` 分支
   拦下（用户在聚合渠道会看到一次失败再换号）。与 buddy 系**同构**的既有形态，非本次引入。
3. **`fetchMagicrewBalance` 没有「缺组织码」前置守卫**（签到侧有：
   `src/magicrew-checkin.ts:157-165` 用 `product.needsOrgOnGateway`）⇒ 缺组织码时
   请求照发、上游 4xx ⇒ 积分显示通用失败、锁定退化成 `unknown` 档，**真因不出现在
   任何文案里**。已把可诊断线索写进 `unknown` 档文案（`src/index.ts` 里 `需要网关组织码的站点`
那行，点名
   `organizationCode`），但**没有**加前置守卫（加了会改变「余额到底查没查」的行为，
   要同步一大批既有用例，独立任务）。

### 守卫与同步点（本批一起落）

| 文件 | 钉住什么 |
|---|---|
| `tests/unit/is-free-model-required.spec.ts` | 两站的 `balance` 块**必须**显式写 `isFreeModel`（**块数** 11 → **13**；注意这是「块数」不是「用例数」，本文件实测 **11 条用例**）；本批顺带把它的两条计数判据改成**先剥注释**（`stripComments`）—— 原文用裸 `code`/`b.body` 匹配 `isFreeModel:`，于是「注释里提起该字段」→ `total` 假红（本批实测撞到，13→15）、「删掉代码只留一行注释」→ 块内 `has` 假绿（缺陷原地复发而全绿）。实测：把国内那行 `isFreeModel: …` 改成注释后，**恰好只有**「每一处都有」这条红（10 passed），`total` 那条不红 |
| `tests/unit/magicrew-credits.spec.ts` | 合成包名字是「永久积分」（`:72-87`）、无 `deductionEndTime` ⇒ `magicrewExpiry` 仍判 `NEVER` |
| `tests/unit/permanent-lock-execution.spec.ts` | `LOCK_EXECUTION_PATHS` 新增 `magicrew` / `magicrewintl`（`:212-223`），`anchor` 带各自 `displayName`；`:253` 断言 `spec` 文件**真的存在** |
| `tests/unit/credits-capabilities.spec.ts` | 锁定能力 `SUPPORTED` 含两站（`:755`），且 `:764` 遍历时对账后端白名单、`:771` 双向相等；`:751-752` 记了「`expiring_quota_details[]` 带 `expires_at`、残差是永久积分」 |
| `tests/unit/credits-runtime-parity.spec.ts` | `usesExpiryWindow` 期望集合含两站；两站端点路径逐字符相同（搜 `MAGICREW_INTL` 的两条端点断言） |
| `tests/unit/magicrew-lock-wiring.spec.ts` | **本批新增的守卫**，实测 **20 条**（**五段** describe；条数会随加固增加，别把它当准数）：① registry 契约（两站字段 + `PERMANENT_LOCK_PROVIDERS` 派生关系）；② `src/index.ts` **按站切片**的源码接线（`selector`、`lockedError` 带各自 `displayName`、`isFreeModel` **必填**、`fetchBalance` 闭包**透传 `product`**、四档全 `QUOTA_EXCEEDED`、`magicrewLockedError` 的位置不得插进 Loomy 的切片）；③ 三档分档（真实报文喂 `fetchMagicrewBalance`，再分别用**前端** `splitCreditsByExpiry` 与**后端** `splitBuddyCreditsByExpiry` + `buddyBalanceTier` 各验一遍：国内 ⇒ 永久 1000 / 长期 1461 / 临期 200，国际 ⇒ 100 / 200 / 47；合成包**必须没有** `deductionEndTime`；反证「残差 ≤ 0 ⇒ **不**造包」；窗口边界 16 天落永久桶、10 天落临期桶）；④ 锁定判据（四档文案 + 只红该条的 `allowPermanent === false` 分支）；⑤ 两站选号器是**不同实例** —— 其中一条是**行为级**「同一份余额、两个 `product` 打到各自 host」（真 `new` 两个 selector + 假 `fetchImpl` 收 URL） |
| `tests/unit/permanent-lock-store.spec.ts` | 锁表文档的读语义（14 → **17 条**）。三审补的 3 条守 **D2「损坏绝不 fail-open」**：主文件损坏 ⇒ 回落 `.bak`；主文件缺失但 `.bak` 在 ⇒ 用它且 `exists: true`（不能触发老字段迁移）；覆盖写入前真的留了 `.bak`。详见 `docs/agent-notes/protocol-wire.md` 的「锁定表的状态层四个缺陷」 |
| `tests/unit/account-pool.spec.ts` | 198 → **200 条**。三审补的 2 条守 **D1「多进程写锁表不互相覆盖」**：两个池实例各锁一个 provider ⇒ 两键都保留；一个实例**解锁**时不得连带丢掉另一个实例刚写的锁（后者的基线必须来自磁盘，不能只来自本进程内存）。⚠️ 该文件的 `beforeEach` 必须**同时删 `.bak`**，否则 D2 落地后上一个用例的锁定会从备份复活（实测 13 条假红） |
| `tests/unit/credit-expiry.spec.ts` | 前后端三档判据对账 + 标签/已过期（106 → **117 条**，三审补的 4 格对账 + 3 条标签，四审再补跨日两格 + 3 条 `formatExpiryHint`；**条数会随加固增加，别当准数**） |

### 真机只读验收（2026-11-01 21:37，`tsc` 重建后用 `lib/` 生产产物跑）

- **国际站**：`total_points 347`、2 条批次 ⇒ 合成包「永久积分 **100**」；
  三档 **永久 100 / 长期 200 / 临期 47**（合计 347，守恒）；后端两桶 **永久 300 / 临期 47**；
  `earliestExpiringAt = 2026-11-01T15:59:59Z`（= 本地 23:59:59）；**锁定后仍可用**（有临期桶）。
- **国内站 4 个账号**（`MAGICREW_ACCOUNT_84C0C1E4` / `_2C4527B5` / `_5381A130` / `_5C24579B`）：
  各 `total_points 1356`、8 条批次合计 356 ⇒ 合成包「永久积分 **1000**」；
  三档 **永久 1000 / 长期 356 / 临期 0**；**锁定后不可用**（只剩永久 + 长期）——
  既是「锁定确实会拦」的实证，也印证上面那条「锁定时长期积分也一起被拦」的副作用。

⚠️ 同日国内站 `total_points` 从 **2661** 掉到 **1356**（当天到期的 200 被烧掉、部分批次减少），
而**残差始终是 1000** ⇒ 强旁证「残差 = 永久积分」（它不随批次消耗而变）；同时说明
**永久积分必须每次现算，不能缓存成一个字段**，否则批次一变就失真。

⚠️ 「合成包**不写** `deductionEndTime`」与 `src/qoder-credits.ts` 对永久哨兵 `253402214400000`
的处理是**同一条纪律**（宁可不写，也不写远期时刻；该口径见
`tests/unit/credits-capabilities.spec.ts:724-729` 的注释）。

⚠️ **本批连带修了一处既有判据 bug**（`tests/unit/autoclaw-lock-wiring.spec.ts` 的
「锁定文案不得点名未实测的池名」）：它用 `indexCode.indexOf('\n  /**', start + 10)`
作为**切片终点**，而 `indexCode` 是 `codeOnly()` **剥过注释**的文本 ⇒ `'/**'` 在里面
根本不存在 ⇒ `indexOf` 返回 `-1` ⇒ `slice(start, -1)` 一直切到**文件末尾**。
此前恰好只有 autoclaw 一家用 `'QUOTA_EXCEEDED'`，所以「四档」碰巧成立；本批给
magicrew 也加了四档 `QUOTA_EXCEEDED`（写在 autoclaw **之后**）⇒ 抓到 8 段而变红。
修法：终点改用 `'\n  const '`（下一个同级声明）。
⚠️ 可推广：**「用注释文本作为源码切片锚点」的判据在 `codeOnly()` 之后必然失效**，
而且失效形态是「切片静默变长」而不是报错 —— 只有将来新增同形代码时才会暴露。

## ⚠️⚠️ 二审（2026-11-01 22:45）：四个**降级质量**的真缺陷与修复

一审只看「输入合法时对不对」，二审专门喂**类型漂移 / 自相矛盾**的报文 —— 前三条都有
「不报错、不打日志、与『凭据失效』或『余额为零』同形」这个共同点，用户只看到积分变 0 或
账号突然不可用；第四条（越界日期）**不同形**：它是「解析成功但日期被静默归一化」，
错在分桶而不是错在取数。
四条都已修 + 补用例 + 逐条变异验证；第五格（前后端判据前向不一致）只登记不改。

| # | 缺陷（上游给什么） | 旧后果 | 修法 |
|---|---|---|---|
| P2-1 | `total_points` 是**数字字符串** `"2661"` | 判据 `typeof === 'number'` ⇒ `return undefined` ⇒ **整条余额消失** ⇒ 面板「查询失败」+ 锁定态选号判 `none`（与凭据失效同形） | 新增 `magicrewSignedDecimalOf`（`src/magicrew-number.ts`），`total` 用它 |
| P2-2 | **批次合计 > `total_points`**（`total 100` + 批次 `200+50`） | 三档合计 **350 > 实际 100**，用户无法判断哪个是真的 | **守恒裁剪**：以 `total_points` 为权威，按**到期时间从早到晚**保留、用满 total 为止 |
| P2-3 | 越界日期 `2026-13-45 25:99:99` | `Date.UTC` **静默归一化**成 2027-02-15（不是 `NaN`）⇒ 编造出一个到期时刻，前端落「长期」、后端落「永久」，**零告警** | `magicrewParseExpiresAt` 加**回读校验**（六个 UTC 分量逐项比对，越界 ⇒ `undefined`） |
| P3-4 | `remaining_points` 是 `"50"`（或 `null`/负） | 该批次被**静默丢弃**，差额被 `total − Σ批次` 的残差吸收 ⇒ **临期积分被误标成永久** ⇒ 锁定永久积分时**误拒**该账号（方向恰好反了） | 改用 `magicrewDecimalOf(...) ?? 0`（非负数仍在随后 `<= 0 ⇒ continue` 处剔除，语义不变） |

⚠️ **P2-1 的解析器为什么必须「允许负数」**：`magicrewDecimalOf` 刻意拒绝负数（任务积分 /
模型单价为负会让展示与倍率算错），但**账户余额可以为负**（上游实测出现过 `total_points: -31`
欠费）。复用拒绝负数那个会把欠费号判成「读数失败」⇒ 两个解析器分工：余额走
`magicrewSignedDecimalOf`，其余一律走 `magicrewDecimalOf`。

⚠️ **P2-2 的裁剪顺序不能反**：必须**临期优先保留**（先到期先消耗）。反过来先保留远期，
被裁掉的是临期 ⇒ 用户以为它还能用，而锁定态选号会据此误判（临期没了 ⇒ `exhausted`/`locked`）。
另：`total_points === 0` 而批次有值时 ⇒ 批次**全清**（余额为 0 不许还显示能用的积分）。

**变异验证（7 条，全部变红并逐字节复原）**：N1 `total` 退回 `typeof === 'number'` ⇒ 1 红；
N2 `remaining` 退回旧判据 ⇒ 1 红；N3 删回读校验 ⇒ 1 红；N4 `total` 改用拒绝负数的解析器 ⇒ 1 红；
N5 裁剪顺序反 ⇒ 1 红；N6 关掉裁剪块 ⇒ 2 红；N7 预算无限 ⇒ 2 红。
`tests/unit/magicrew-credits.spec.ts` 由此 29 → **35 条**。

**真机复验（同日 22:45，`tsc` 重建后用 `lib/` 生产产物，只读 GET）**：国内
`total 2661 / Σ包 2661`（守恒 ✓）、三档 **永久 1000 / 长期 1461 / 临期 200**、后端两桶
`permanent 2461 = 永久+长期`；国际 `total 347`、三档 **100 / 200 / 47**、后端 `permanent 300`。
⚠️ 与 21:37 那次**不是同一份读数**（那次是 1356 / 永久 1000 / 长期 356 / 临期 0 —— 另一个
账号，当时它还没临期批次），所以**不能说「逐字相同」**（本节初稿如此写，与本节 21:37 那段
自相矛盾，2026-11-01 三审更正）。能说的是：两次都满足守恒，且四条修法对**合法报文**
零行为变化（分档规则未变，变的只是读数）。

### ⚠️ 登记不改（P3-5）：前后端判据有 **1 格**不一致（初稿写「3 格」，三审订正）

`plugin-src/client/credit-expiry.js` 的 `splitCreditsByExpiry`（前端）与
`src/buddy-balance-rank.ts` 的 `splitBuddyCreditsByExpiry`（后端）语义逐格一致 —— **但只有
「正常形态」**。⚠️ 本节初稿写「3 格不一致、前端可能判成**丢弃**」，**2026-11-01 三审实测
订正为 1 格，且方向是「拒用」不是「丢弃」**：

| 输入 | 后端（只看 `deductionEndTime`）| 前端（`packageExpiryMs`，有 `expiredTime` 兜底）| 一致？|
|---|---|---|---|
| `deductionEndTime: true`**且无 `expiredTime`** | 永久 | 永久（非 number/string ⇒ 未知）| ✅ |
| `deductionEndTime: [ms]`**且无 `expiredTime`** | 永久 | 永久 | ✅ |
| 无可用 `deductionEndTime`**且**有 `expiredTime` | **永久** | **临期**（兜底生效）| ❌ **唯一不一致** |

⚠️ 第 1/2 行的 ✅ **带前置条件**（2026-11-01 四审订正）：`packageExpiryMs` 的回落条件是
「**缺失或不可解析**」，不是「仅仅缺失」—— `deductionEndTime: true` / `[ms]` / `{valueOf}`
被判成不可解析后**同样会落到 `expiredTime`**。所以真正唯一的触发面是第 3 行：
「`deductionEndTime` 不可用 **且** `expiredTime` 可用」，与它是「压根没给」还是「给了但类型不对」无关。

不一致那格的后果是**方向安全但体验打架**：前端把该批次算进「临期可用」，后端判永久 ⇒
**锁定期间该号被判 `none` 而拒用**（不会误烧永久积分，但用户会看到「面板明明有临期积分、
选号却说没有」）。本家上游只发 `YYYY-MM-DD HH:mm:ss` 字符串且**必带** `expires_at`，
所以**当前不可达** ⇒ 本批**不改**（改后端等于放宽 15 家共用的热路径判据，改前端等于拿掉
`expiredTime` 兜底）。登记为**前向风险**：哪天上游改成只给 `expiredTime`，必须两端同改。

### ✅ 面板接线已从「静态核对」升级为**行为级**守卫（2026-11-01 22:51）

二审收尾前，本批对客户端只有**静态核对**：「`rpcCall('credits.permanentLock', { provider })`
的 provider 来自 props、三处调用点没有字面量」。静态核对抓不到两类真实回归，现已补
`tests/unit/jet-hub-panel-wiring.spec.ts` 的 `describe('锁定永久积分按钮的接线（magicrew 两站真渲染）')`
（**3 条**用例，用该文件既有的 `useState`/`useCallback`/`createElement` 替身**真渲染**
`providerPanel` 并**真调用**按钮的 `onClick`）：

| 用例 | 判据 |
|---|---|
| 两站各一条 | 渲染出 `aria-label` **严格等于**「锁定永久积分」的 `button`（用 `.find()` 取首个，**不**断言「恰好一个」）；真调 `onClick` ⇒ 恰好一次 `credits.permanentLock`，`payload` **严格等于** `{ provider, locked: true }`（`provider` 是当前那站） |
| 对照（`opencode`） | **一个按钮都不渲染**，且**零** `credits.permanentLock` 请求 |

**变异验证 4 条全部变红**：M-A `canLockPermanent` 恒 false ⇒ 2 红；M-B `onClick` 换空函数 ⇒ 2 红；
M-C 把 `provider` 写死成 `'magicrew'`（两站串站）⇒ 1 红；M-D 去掉按钮门控（所有 provider 都渲染）
⇒ 1 红。`jet-hub-panel-wiring.spec.ts` 8 → **11 条**。

⚠️ **挂载时的读请求不会污染计数**：该文件的 `useEffect` 桩是空实现，所以面板挂载时那条
`credits.permanentLock` 的**读**分支不执行 ⇒ 收到的每一次都是**点击**触发的写。
若哪天把桩改成真执行 effect，计数会变 2 —— **届时改断言，不改实现**。

### ⚠️⚠️ `DSH_BUDDY_EXPIRING_WINDOW_DAYS=0` **是刻意的语义，不是缺陷**

二审曾把「填 0 ⇒ 所有积分判永久 ⇒ 锁定后整个 provider 不可用」当作「静默自锁死」要收紧，
⚠️ 限定（2026-11-01 四审实测）：**「所有积分判永久」只在后端两桶成立**。前端 `splitCreditsByExpiry`
在 `windowDays = 0` 时会把带到期时间的包放进 **`longTerm`**（实测 `{expiring:0, longTerm:100, permanent:0}`、
标签「还有 10 天」）⇒ 拿「UI 上应该全变绿」去验收会误判成「0 没生效」。锁定时整池不可用这条结论不变。
**核实后撤回**：`src/buddy-balance-rank.ts` 的 `buddyExpiringWindowDays` 注释**明写**
「`0` 是合法值（表示『没有临时积分』，于是锁定期间整池不可用）」，并警告**不能**写成
`parseInt(raw) || 默认值`（`0` 是 falsy，会被 `||` 静默换成 15 —— 与 Qoder 排队超时那个坑同型）。

⇒ 填 0 是「我就是要锁定期间整池不可用」的**显式表达**，不是配置写错。非法值（空串 / 非数字 /
**负数**）才回落 15。**不要把 0 改成回落**，那会推翻一个已经写进注释与用例的设计。
（副作用仍然存在：填 0 之后没有任何提示告诉用户「你现在一个号都用不了」—— 要做的话是
**加提示**，不是改语义。）

## ⚠️⚠️ 四审（2026-11-01 23:20~23:50）

三路**只读**审查（前端回归 / 状态层回归 / 文档与测试自审）。前端一路在当次快照上 **0 条必修**，
另两路各给出必修，逐条处置如下。

### 已修：状态层两条（影响**全部 15 家**，不只是 magicrew）

| # | 缺陷 | 修法 | 守卫 |
|---|---|---|---|
| 1 | `.bak` 在 `renameSync` **之前**复制 ⇒ 备份永远落后一版：丢最后一版锁 / 解锁被拉回来 / 坏文件污染备份 | 复制挪到 `renameSync` **之后** | `permanent-lock-store.spec.ts` 新增「用户解锁后主文件损坏，`.bak` 不得把锁拉回来」+ 三条改写（16→**18**） |
| 2 | `{ ...disk, ...memory }` 会**复活**别的进程刚删掉的键 | 改为**磁盘优先**：`disk.exists ? { ...disk.locks } : { ...this.permanentLockCache }`（磁盘不存在才退回内存 ⇒ 不静默解锁） | `account-pool.spec.ts` 新增「另一个进程刚解开的锁不得被复活」+「磁盘上有、内存里没有的锁必须保留」（200→**202**） |

⚠️ 两条都做了**方向性变异**验证：`.bak` 挪回 `rename` 前 ⇒ **4 红**（恰好那 4 条）；合并方向反转 ⇒ **1 红**
（恰好「不得被复活」）。⚠️ 第二条的守卫在修好**之前是无牙的** —— 「永不丢磁盘锁」这个方向让旧实现
同样全绿（锁定值域只有字面 `true`，并集恒不丢），**只有「复活」这个方向才咬得住**。

### 已修：我自己抓到的「半修」

`formatExpiryHint` 在 ④（新增「已过期」）修好后仍拼出 **「距到期 -3 天（已过期）」**（`Math.ceil(-0.5) = -0`）。
该函数**此前一条用例都没有**。已加 `if (left <= 0) return '已过期';` + 3 条用例。
同时发现 `plugin-src/client/jet-hub.js` 的 `formatPackageLine` **自己又拼了一遍**同一字符串 ⇒ 改为复用
`formatExpiryHint(pkg, windowDays, now)`（文案逐字节等价，少一处同语义实现）。

### 已修：两条无用例的守卫（四审补）

| 守卫 | 补的用例 | 变异 |
|---|---|---|
| `src/aggregate-expiry.ts` 的 `sharedPackageExpiry` 判据收窄（number 或数字字符串） | `aggregate-expiry.spec.ts` 新增 3 条：数字字符串算临期 / 与 number 等价 / `true`·`abc`·`0`·`null` 才算未知 | 退回 `typeof === 'number'` ⇒ **2 红** |
| `formatPackageExpiry` 的 Invalid Date 守卫（`1e16`） | `credit-expiry.spec.ts` 新增 2 条（`1e16` ⇒ 「长期」、`2100-01-01` 正常显示） | 删守卫 ⇒ **1 红** |

### ⚠️⚠️ 方法论：`TZ=… node …` 在本沙箱**不生效**

实测 `TZ=America/Los_Angeles node -e 'console.log(new Date().getHours())'` 仍输出东八区小时数 ⇒
所有「换个时区再跑一遍」的结论都会**假绿**。真跑必须：

```powershell
powershell.exe -NoProfile -Command "$env:TZ='America/Los_Angeles'; npx vitest run tests/unit/credit-expiry.spec.ts"
```

⚠️ 另一条同源教训：**变异脚本的恢复锚点必须带分号/标点一起核对** —— 我删守卫后恢复脚本用了不带 `;` 的锚点
（`const local = new Date(end)` vs 实际的 `...end);`）⇒ 匹配失败，**仓库一度停在变异态**。
变异脚本的恢复步骤必须**校验「恢复后内容与原文逐字节相同」**，不能只看 `includes`。
## ⚠️⚠️ 三审（2026-11-01 23:00~23:20）：三路对抗审查的结论与落点

三路分工：**时区/边界**（35 条日期矩阵 + ±1ms 分桶对账）、**缓存与隔离**（16 个缓存点 +
多进程锁表）、**文档复核**（逐行号打开核对 + 变异重放）。核心能力面（三档数字、守恒、
两站隔离、锁定生效、20/35/11 条用例、M-A~M-D 与 N1~N7 共 12 条变异）**全部复现成立**。

### 已修：前端 `credit-expiry.js` 四处（15 家共用，不只是 magicrew）

⚠️ **受影响的不只是 magicrew**：`usesExpiryWindow: true` 实测 **15 家**
（codearts / buddy / workbuddy / lobsterai / qoder / qodercn / trae / minimax / minimaxintl /
officeace / astudio / autoclaw / autoclawintl / magicrew / magicrewintl）。这四处里有**两处是
用户可见的变化**，上线后别当成回归：

| 修复 | 谁看得到 | 变化 |
|---|---|---|
| ③ 到期日期改**本地**分量 | 全部 15 家 | 东八区 **00:00–07:59 到期**的包，日期列由「前一天」变成「当天」；UTC-8 用户同理（对称） |
| ④ 新增「已过期」文案 | 过期包的所有渠道；**TRAE / Qoder 一定会遇到** | 文案由「-3 天内到期」变成「已过期」。`src/trae-credits.ts` 的 `active: true` 是**硬编码**，这两个渠道从不标记失效 |
| ② `daysUntilExpiry` 走 `packageExpiryMs` | 只有 `expiredTime`（或 `deductionEndTime` 是数字字符串）的包 | 标签由「到期时间未知」变成真实天数+档位 |
| ① 收窄 `typeof` | 带类型污染 `deductionEndTime` 的包 | 由「临期」改判「永久」（与后端对齐，**少显示**一些临期） |

| # | 缺陷 | 修法 |
|---|---|---|
| ① | `packageExpiryMs` 裸 `Number()` ⇒ `true`/`[ms]`/`{valueOf}` 三格**前后端落不同桶** | 收窄为 `typeof === 'number' \|\| typeof === 'string'` 再 `Number()` |
| ② | 同一文件两套判据（分桶走 `packageExpiryMs`、标签走 `typeof === 'number'`）⇒ 「分到临期桶、日期列正常、标签却写『到期时间未知』」| `daysUntilExpiry` 改为也走 `packageExpiryMs()` |
| ③ | `formatPackageExpiry` 用 `toISOString()` ⇒ **UTC 日期**，东八区用户看到早一天（`07:59:59` 与 `08:00:00` 显示成两个日期）| 改按**本地分量**拼日期（不写死 +8，共用层也要给 UTC-8 用户对）|
| ④ | 已过期但仍 `active:true` 的包显示 **负数天**（`-3 天内到期`、`-0.5 天` 被 `Math.ceil` 变成「0 天内到期」）| `expiryBucketLabel` 加「已过期」分支（顺序：未知 → 已过期 → null → 分档）|

守卫：`tests/unit/credit-expiry.spec.ts` 106 → **117 条**（对账 fixture 补 4 格类型漂移 + 3 条边界 + 跨日两格 + 3 条 `formatExpiryHint`）。
变异 V1/V2/V3 **全部变红**且复原逐字节一致。⚠️ 旧的 14 条对账 fixture **无一格是 true/数组/对象**，
旧的日期用例 `NOW+8天` 恰好落在 UTC 与北京同日 ⇒ 对 ③ **零判别力** —— 这是「守卫存在但不承重」的又一例。

### 已修：锁表层两个（`src/permanent-lock-store.ts` / `src/account-pool.ts`）

- **D2 锁表损坏 fail-open 静默解锁**（实测半截 JSON ⇒ 全部 provider 按未锁定，只 warn）⇒ `load()` 改
  两层回落（主文件 → `.bak`），`save()` 在 `renameSync` 前先 `copyFileSync` 出 `.bak`；两者都不可读才
  空表。判据是「宁可维持上一次已知的锁定，也不默认放行」。
- **D1 多进程丢锁**（两进程各载入后，后写者用陈旧内存整份覆盖 ⇒ 另一个 provider 的锁定静默消失）⇒
  `setPermanentLocked` 写前**重读磁盘并按 provider 合并**。**只解决写**：刻意不加周期重读
  （热路径读文件会在落盘失败后用磁盘旧值覆盖内存新值）⇒ **跨进程读可见性登记为已知边界**。
- 守卫：`permanent-lock-store.spec.ts` 14 → **17**、`account-pool.spec.ts` 198 → **200**；三条变异全红。
- ⚠️ 测试教训：`account-pool.spec.ts` 的 `beforeEach` **必须同时删 `.bak`** —— 只删主文件时 D2 会让
  上一个用例的锁定从备份**复活**（实测 13 条假红），这个坑只有加了备份才会遇到。

### 已修：`src/index.ts` 两条（D5）

- 「国内站省略 `rateLimit`」的注释**是错的**（两站都写 `rateLimit: false`）⇒ 已更正，真正的理由是
  「零 `updateModelRateLimit` 写点 ⇒ 从不写 `modelRateLimits` ⇒ `candidatesOf()` 恒放行」。
- 国内站 `new MagicrewService({…})` **未显式传 `product`**（靠 `?? MAGICREW` 缺省）⇒ 已显式传，
  理由：后人接第三站点时会静默打回国内基址（与 `src/provider-expiry.ts` 那次**逐字同型**）。

### 登记不改（三条，都是「改的代价大于收益」）

1. **D3 选号器 60s 私有缓存与面板读数分叉**：`src/buddy-balance-selector.ts` 注释声明的
   `selector.invalidate()` 责任方**在 `src/` 零调用**。后果：面板刚刷新到「有临期 500」时选号器仍按
   旧读数报「没有可用账号」；反向则锁定在 ≤60s 内失效。修法明确（在 `credits.claimAll` /
   `credits.balances` force / `account.create` 后调 `invalidate`），但要把两站 selector 接进 RPC 层，
   **影响全部 15 家** ⇒ 单独开一轮做。
2. **D4 聚合候选不读锁定**：`src/aggregate-adapter.ts` 的候选过滤只问 `getAvailableAccount` ⇒ 每轮
   先白撞一次再被 resolver 拦；**不烧永久积分**（真正派发必过 resolver）。与 buddy 系同构的既有形态。
3. **前后端判据 1 格不一致**（只给 `expiredTime` 的包：前端判临期、后端判永久）⇒ 见上文 P3-5 表。

### 文档复核挑出的 19 处（全部已修）

14 处是**行号漂移**（`src/index.ts` 一轮里漂了三次、`credit-expiry.js` +13 行整体推后）⇒ 治本做法是
**不写绝对行号**、改符号锚（搜 `const magicrewLockedError` / `reason.kind ===` / `buddyBalanceTier()`）。
另 3 处是**技术断言不成立**：①「P3-5 三格不一致」实为 **1 格**（上文表已重写）；②「`ctx.provide('accountPool')`
在 5977 行」实为 **6406**（已改符号锚）；③「切片器不能取裸 `'},'` 因为 `fallback` 里也有」**不成立**
（14 个 `balance: {` 块无一含 `fallback`，真正弱点是「终点用位置型锚点」）。还有 2 处自相矛盾
（「三个」vs「这四条」、「与 21:37 逐字相同」vs 两次读数根本不同）。

⚠️ **教训**：文档里的**绝对行号**在多人/多 agent 并发编辑时必然腐坏，且腐坏后**没有任何守卫能发现**
（`check-refs.cjs` 只验路径存在、不验行号）。本批之后 magicrew 相关章节一律用**符号锚 + 函数名**。
