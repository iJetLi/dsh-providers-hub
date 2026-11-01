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
