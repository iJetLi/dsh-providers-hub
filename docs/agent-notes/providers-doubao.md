# 豆包（Doubao）provider 实测笔记

> 2026-11-03 接入。签到/登录全部真机实测；本文件记录**与直觉相反**的坑，
> 与设计文档冲突时**以本文件为准**。

## 1. 协议事实（全部真机实测）

| 项 | 值 |
|---|---|
| 签到领取 | `POST https://www.doubao.com/alice/ug/campaign/landing/checkin`，body `{"scene":"pc_incentive_task_mvp_v3"}`，公共 query 见 `src/doubao.ts` 的 `doubaoCheckinQuery` |
| 成功响应 | `{data:{checked_in:true,checkin_date,continuous_days,idempotent:true,reward_amount:200,reward_status:3},code:0}` |
| 签到状态 | `POST /alice/ug/campaign/landing/get`（同 scene；`code:0` 但 `main_page_info.buttons:[]` = 该账号**不在投放范围**） |
| 鉴权 | **纯 cookie**（`sessionid`/`sid_tt`/`ttwid` 等），无 Authorization |
| 签名 | query 的 **`a_bogus`**（不是 header `X-Bogus`！），由页面上下文 `window.bdms.frontierSign({'X-MS-STUB':''})['X-Bogus']` 生成 |
| 请求头 | `Agw-Js-Conv: str`、UA 带 `SamanthaDoubao/x.x` |

## 2. ⚠️⚠️ 关键坑

### 2.1 `a_bogus` 只能在豆包页面上下文产出

字节反爬签名，闭源含环境指纹。**纯 Node fetch 裸调恒 `710010702 系统错误`**
（哪怕 cookie/公共 query 全对）。实测可行路径：起 Chromium（任意 Chrome 即可，
**不需要豆包内核**）加载 `www.doubao.com/chat/`，页面里 `bdms` 就绪后签名。

### 2.2 ⚠️⚠️ 账号隔离的第一版是**假隔离**（真实缺陷，已修）

初版挂豆包客户端 `User Data` + 页面脚本 `credentials:'include'`：
- `credential.cookie` **根本没用上**（浏览器自动带 profile 的 cookie）；
- 所有账号的签到都打在「客户端当前登录的那个号」上。

**修法（支点验证过）**：独立临时 profile（`mkdtemp`）+ `Network.setCookie`
逐条注入**该账号**的 cookie + query 用**该账号**的 deviceId/webId。
多账号实测：A/B 两号的 deviceId 实测不同（`verify_mw0tswwg_…` vs
`verify_mw0u7kbq_…`），A 号签到返回 A 的连续天数，B 号按 B 身份被服务端
评估（不在投放范围）——身份归属正确。

### 2.3 ⚠️⚠️ `710010702` 的真实语义（三轮对照实验定案）

**不是「系统错误」**。2026-11-03 多轮对照实验的证据链：

| 实验 | 环境 | 设备号 | checkin 结果 |
|---|---|---|---|
| 几小时前 | A 客户端 User Data（活 cookie） | 真实注册号 | **成功 +200** |
| 当晚 | 同一环境、同一账号、活 cookie | 真实注册号 | 710010702 |
| 当晚 | 同一环境、同一账号 | **页面正在用的**注册号 | 710010702 |
| 当晚 | 同一环境 | 派生新号 | 710010702 |
| 当晚 | B 账号（全新） | 任何号 | 710010702 |

且 `landing/get` 对所有组合都回 `code:0` 但活动内容**全空**（`chosen_type:0`、`buttons:[]`）；
本地缓存的活动快照 `phase:"settled"`。

**结论**：710010702 = **当前没有可领的签到活动**（当日名额发完 / 活动收摊 /
未对该账号投放——三者对用户动作相同）。与账号、cookie、签名、设备号**都无关**
（活 cookie + 页面正在用的真实设备号也报）。已分类为 `inactive`，
不按网络故障排查。

### 2.4 ⚠️⚠️ 设备身份必须「确定性派生 + 每账号一套」（TRAE/Qoder 同款纪律）

**为什么不能拿登录会话的 `s_v_web_id` / `ttwid` 当设备号**：
- `s_v_web_id` 是 `verify_…` 前缀的**预验证 id**，服务端没注册过；
- `ttwid` 是 URL 编码串，不是数字设备号；
- 官方 query 用的是 **19 位数字**的 `device_id` / `web_id` / `tea_uuid`。

**落地**（`src/doubao.ts`）：
- `doubaoDerivedDeviceIdentity(accountKey)`：SHA-256 seededStream 派生
  19 位数字（算法与 `src/trae.ts` 的 `deriveDeviceId15` 同源），
  `accountKey` = `sessionid`（账号稳定标识）⇒ 每账号一套、跨日稳定；
- `isRegisteredDeviceShape`：凭据里存的显式设备号**只有 15–21 位纯数字才算数**
  （verify 前缀 / 含 `%`/`|` 一律判无效回落派生）；
- 登录落库只存 `accountKey`，不再存 verify 形态 id。

**为什么仍然做**（即使 2.3 证明设备不是 710010702 的直接原因）：
TRAE（同天两账号共用 device_id 被「该设备已签到」拦截，`src/trae.ts` 实测）
与 Qoder（缺 machine 头族 ⇒ 服务端不下发活动，`src/qoder-machine.ts` 消融表）
都记录了**真实的设备维度限制**。豆包的活动系统是同一族（字节 UG campaign），
设备维度迟早会被启用；每账号独立设备号是结构性防御，无副作用。

### 2.5 两步签到：landing/get **不能**用来短路

实测**已签账号**的 `landing/get` 也回空活动（签完当天就没有可领对象）。
若「无活动就不发 checkin」，会把「今天已签」误报成「没有活动」。
⇒ `landing/get` 只查状态（丰富文案/诊断），**checkin 始终发**（幂等：
已签回 `checked_in:true, idempotent:true`）。

### 2.6 登录：扫码会话落池（不走登录 API）

豆包登录页 = 打开 `www.doubao.com/chat/` → 点「登录」→ **页面内弹二维码模态框**
（不是独立登录页）→ 手机豆包 App 扫 → `.doubao.com` 种 `sessionid`。

实现（`src/doubao-login.ts`）：可见 Chromium + **一次性 profile**（每账号
天然独立设备身份）→ 自动点「登录」弹码 → 浏览器级 `Storage.getCookies`
（不需要 sessionId，可读 HttpOnly —— kukuai 笔记 §5.4.5 同款结论）轮询
`sessionid` 出现即成功 → 全量 cookie + deviceId（`s_v_web_id`）+ webId
（`ttwid`）落池。

### 2.7 cookie 解密链（一次性取证用）

豆包客户端 `User Data` 是 Chromium 147 标准 v10 加密：
`Local State` 的 `os_crypt.encrypted_key` → DPAPI 解出 32 字节主密钥 →
cookie `v10|nonce(12)|cipher|tag(16)` AES-256-GCM，**明文前有 32 字节
SHA256(host) 前缀要剥掉**（Chrome 130+）。客户端运行时 Cookies 文件被
独占锁（连共享读都不给），要复制需先关客户端。

## 3. 接线清单（缺一处即静默失效）

- `src/doubao.ts`（凭据模型 + 端点常量 + query 构造）
- `src/doubao-credits.ts`（余额如实 `null` + 签到薄壳）
- `src/doubao-signin.ts`（CDP 会话：独立 profile + 注入账号 cookie + bdms 签名）
- `src/doubao-login.ts`（扫码登录会话落池）
- `src/provider-registry.ts`（`doubao`：`channel:false`、`autoCheckinExcluded:true`、
  `rateLimit:false`、`credits:{balance:true,dailyCheckin:true}`）
- `src/provider-credits.ts`（credits 表 `doubao` 项）
- `src/jet-hub-rpc.ts`（`account.create` browser 分支 + `login.poll` 分派 +
  sessionid 指纹判重 + `doubaoLoginInFlight` 表）
- `plugin-src/client/jet-hub.js`（doubao 新建账号分支：直接 `mode:'browser'` + `startLoginPoll`）
- `plugin-src/client/provider-icons.js` + `jet-hub-styles.js`（图标）
- 守卫 spec 计数：registry 26 条 / autoCheckinExcluded `['zcode','doubao']` /
  rateLimit:false 名单 +doubao / credits 表集合 20

## 4. 端到端验证记录（2026-11-03）

1. 账号 A（客户端登录态解密）：独立 profile + 注入 32 条 cookie →
   **签到成功 +200（连续 2 天）**，重复调用幂等。
2. 账号 A（扫码登录产出凭据）：同链路 → **签到成功 +200（连续 2 天）**。
3. 账号 B（扫码登录）：deviceId/webId 与 A 完全不同 → 服务端按 B 身份评估，
   `inactive`（不在投放范围）——隔离正确。
4. 守卫：10 spec 472 全绿；`tsc --noEmit` 0 错误。

## 5. ⚠️⚠️ 浏览器探测：候选链必须跨平台（Gitee issue IKV5HC，2026-11-13 修）

### 5.1 症状与根因

macOS 14 用户点「+ 新建账号」/「重新读取」只看到

```
登录失败：豆包登录需要本机有 Chromium 内核浏览器（Chrome / 豆包客户端），未找到可执行文件。
```

而他的 Mac 上 **Chrome 装得好好的**。根因：`doubaoLoginBrowserExecutable()` 与
`doubaoSigninBrowserExecutable()` 的候选链**逐条都是 Windows 路径** ——

```ts
process.env.DSH_DOUBAO_BROWSER_PATH,
'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
join(process.env['ProgramFiles'] ?? 'C:\\Program Files', ...),
join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData','Local'), ...),
'D:\\Program File\\Doubao\\app\\Doubao.exe',
```

—— 在 macOS / Linux 上 `existsSync` 一条都不命中 ⇒ `return undefined` ⇒
`DoubaoLoginSession.open()` 抛「未找到可执行文件」。

### 5.2 为什么必须「兜到 `findBrowserExecutable()`」而不是自己加几条 mac 路径

本仓其余四家浏览器登录**全都是**这个形状：

| 文件 | 行 | 形状 |
|---|---|---|
| `src/baizhi-browser-login.ts` | 246 | `deps.executablePath ?? (deps.resolveBrowser ?? findBrowserExecutable)()` |
| `src/magicrew-browser-login.ts` | 879 | 同上 |
| `src/marvis-browser-login.ts` | 299 | 同上 |
| `src/monkeycode-browser-login.ts` | 52 | 同上 |

⇒ 豆包是**唯一漏掉**的那个。自己再抄一份 macOS 路径 = 造第二份口径
（`docs/agent-notes/misc.md` 的「一文件两套同义判据」），而 `chromium-session.ts`
的 `browserCandidates()` 已经覆盖 macOS 的 `.app` 包（Chrome / Chromium / Edge /
Brave，且**必须**用 `posix.join` —— 用 `join` 会在 Windows 上拼出
`/Applications\Google Chrome.app\…`，Issue IKJKNT 的成因之一）、Linux 的
`PATH` + AppStream 元数据、Windows 的 scoop / Edge / Chromium。

### 5.3 修法的两个要点

1. **顺序**：本项目自己的候选链**在前**（`DSH_DOUBAO_BROWSER_PATH` 仍最优先、
   豆包客户端内核仍排在通用 Chrome 之前），跨平台探测只在「前五条一条都不存在」
   时才走到 ⇒ **存量 Windows 用户的解析结果逐字节不变**。
2. **两个函数一起改**：`doubaoLoginBrowserExecutable` 与
   `doubaoSigninBrowserExecutable` 是**两份**候选链（历史原因），只修登录会变成
   「扫码能进、签到照样报错」，症状与「豆包今天没活动」同形。

### 5.4 可测性：`findBrowserExecutable` 必须能注入

开发机与 CI 都是 Windows ⇒ `platform === 'darwin'` 那条分支**结构上不可测**
（会静默烂掉，这是 IKJKNT 的老账）。故给两处都加了可选入参
`BrowserLookup { platform?, env?, home?, exists? }`（`findBrowserExecutable`
本就有同名字段透传给 `browserCandidates`，本次只是把它**提到签名上**并抽成
具名类型 `BrowserLookup`）：

```ts
findBrowserExecutable({ platform: 'darwin', env: {}, home: '/Users/jet',
                        exists: (p) => p === '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' })
```

⚠️ 反向教训：**不注入 `exists` 时本机（装了 Chrome）恒能命中** ⇒「什么都没找到
⇒ `undefined`」那一格在本机**恒为假**，想测只能注入。变异实测：把
`findBrowserExecutable(lookup)` 改回无参调用，三条用例同时红（本机 scoop
chromium 被当成「找到了」）。

### 5.5 顺手修的第三条：自动点击「登录」只发 `click`

`clickLoginButton()` 原本是 `if (loginEl) loginEl.click()`。豆包登录按钮的
处理器挂在 `pointerdown` / `mousedown` 上（报障人实测），而
`HTMLElement.click()` **只派发 `click`**（`pointerdown` / `mousedown` /
`pointerup` / `mouseup` 一个都不发）⇒ 处理器不触发、二维码不弹，用户只能手点。

修法两级（判据抽到导出的 `clickDoubaoLoginButton`，返回**三态**
`'trusted' | 'synthetic' | 'not-found'` 以便单测区分）：

1. **受信任鼠标事件（首选）**：先 `Runtime.evaluate` 取按钮**中心点**，再
   `Input.dispatchMouseEvent` 发 `mousePressed` + `mouseReleased` ——
   浏览器进程派发的 `isTrusted === true` 事件，Chromium 会按标准顺序自行派生
   `pointerdown` / `mousedown` / `pointerup` / `mouseup` / `click`；
2. **合成事件（兜底）**：按钮存在但**拿不到盒子**（`0×0` / 被浮层裁掉）时，
   用 JS 按同一顺序 `dispatchEvent` 一整套。这些 `isTrusted === false`，但对
   「只监听事件、不校验 `isTrusted`」的页面足够。

⚠️ 返回三态而不是 `void` 是**故意的**：只断言「没抛错」的话，把整段换回
`loginEl.click()` 也照样绿（本仓「假绿」常客）⇒ 必须数
`Input.dispatchMouseEvent` 的调用次数与参数。

### 5.6 守卫

`tests/unit/doubao-browser-discovery.spec.ts`（15 条）：两个函数 × 6 格
（macOS / Linux / Windows 存量不变 / `DSH_DOUBAO_BROWSER_PATH` 优先 / 都没有 ⇒
`undefined` / 真实 macOS 候选链首项）+ 2 条反向对照（Windows 链不含 `.app`）
+ 3 条点击三态。变异 8/8 有牙。
