# 智谱清言（chatglm.cn **网页端**）provider —— 实测事实

> 采集日期：**2026-11-04**。方法：主包逆向（`main.28af679a.js`，6.0 MB，rspack 产物）
> + **消融矩阵**（37 格）+ 免 token 端点探活。
> ⚠️ **没有任何真凭据走过签到/余额路径**（用户明确要求不拿真号试，怕封号）——
> 下面凡是标「未实测」的都**不得**当成已验证事实引用。

## 0. 与 `zcode` / `autoclaw` 的关系：**三个完全不同的产品面**

| provider | 域名 | 鉴权 | 签到 |
|---|---|---|---|
| `zcode` | `zcode.z.ai` / `bigmodel.cn` | OAuth + `zcode_jwt` | 有（每次要现产阿里云 captcha） |
| `autoclaw` | `autoglm-acceleration-api.zhipuai.cn` | 桌面端 token（JWT，24h） | 有（**刷新即登录事件**，无独立签到端点） |
| **`chatglm`（本文）** | **`chatglm.cn`** | **cookie / `Authorization: Bearer chatglm_token`** | **有：`POST /chatglm/member-api/member/daily_login_score`** |

三家同属智谱，但**端点 / 鉴权 / 签到协议 / 凭据格式全部不同，凭据不互通**。
⚠️ 别因为「都是智谱」就照抄 `zcode` 或 `autoclaw` —— 那会让新渠道在第一步就打错主机。

## 1. 端点清单（逐字取自主包模块 `85048` / `86129`）

所有路径都自带 `/chatglm` 前缀，主机恒为 `https://chatglm.cn`。

| 用途 | 方法 | 路径 | 需 token |
|---|---|---|---|
| **每日登录积分（签到本体）** | POST | `/chatglm/member-api/member/daily_login_score` | 是 |
| 用户信息（**余额**来源） | GET | `/chatglm/user-api/user/info` | 是 |
| 积分流水 | GET | `/chatglm/member-api/member/score_record` | 是 |
| 消费抽券活动状态 | GET | `/chatglm/member-api/member/score_activity_status` | 是 |
| 活动是否开放 | GET | `/chatglm/member-api/member/score_activity_open` | **否**（免 token） |
| 暑期/返校季：查是否已领 | GET | `/chatglm/member-api/member/summer_day_claim_status` | 是 |
| 暑期/返校季：领取 | POST | `/chatglm/member-api/member/summer_day_give_score` | 是 |
| 抽券 | POST | `/chatglm/member-api/member/score_activity_draw` | 是 |
| **续期** | POST | `/chatglm/user-api/user/refresh` | Bearer = **refresh token** |

**API 命名空间全集**（主包里出现的前缀）：`action-api`、`mainchat-api`、`user-api`、
`backend-api`、`member-api`、`payment-api`、`operation-api`、`feed-api`、`search-api`、
`share-api`、`productivity-api`、`agent-api`、`glms-api`。

## 2. ⚠️⚠️ 签到的判据是 `result.score`，**不是 `status`**

实测信封形态（`status:0` 表示请求成功）：

```jsonc
// 真领到（score > 0）
{ "status": 0, "message": "success", "result": { "score": 15 }, "rid": "..." }
// 今天已领（score === 0）—— **status 同样是 0**
{ "status": 0, "message": "success", "result": { "score": 0 },  "rid": "..." }
```

官方客户端 `e0()`（`claimDailyLoginReward`）的写法逐字可证：它先按**本地日期**
写 `localStorage['daily-login-score:<uid>']` 做去重，再发请求，`score > 0` 才弹
`+N` 的 toast 并把 `member_info.left_score`（**字符串**）本地加 N。

⇒ **上游语义**：`score === 0` 就是「今天已领」。只判 `status === 0` 会把「已领」
报成「领取成功 +0 积分」—— 那正是本仓库反复记录过的「显示成功但 +0」缺陷形态。

⚠️ 上游**不下发**连续签到天数 ⇒ `streakDays: 0` 是**如实回 0**，不是编造。

## 3. ⚠️⚠️ 账号隔离：**不是** device_id / web_id，是 token

用户明确要求核对「是否像 TRAE 那样按设备 id 或 web id 隔离账号」。**答案：不是。**
三条独立证据：

1. **`web_id` 在主包（6.0 MB）里只出现 1 次**，位置是 `sdata.chatglm.cn` 埋点 SDK 的
   `_s_byte_id`（**字节的 `web_id`**，`credentials:'omit'`）—— 与鉴权/签到**无关**。
   `X-Web-Id` / `tea_uuid` / `x_device` 命中数为 **0**。
2. **`X-Device-Id` 的来源是 `localStorage['chatglm-deid']`**（32 位 hex；没有就
   `genV4()` 去横线后写回）—— 它是**请求指纹**，不是账号归属。
3. **消融矩阵**：`X-Device-Id` 取空 / 31 位 / 带横线 / 大写，**全部仍过闸**（见 §4）。

⇒ **隔离维度是 token**（`chatglm_token` 一值一账号）。这与 TRAE
（`src/trae.ts` 实测「同一天两账号共用 device_id 会被『该设备已签到』拦截」）
**机制不同**，不要照抄那边的「设备号互斥」叙事。

⚠️ 尽管如此，本实现**仍每账号确定性派生**一套 32 hex 设备号
（`chatglmDeviceIdOf`，与 `deriveDeviceId15` / `doubaoDerivedDeviceIdentity` 同纪律）：
上游某天若启用设备维度，结构性防御已就位，且**当前零副作用**（闸门不校验它）。

登录侧的隔离手段则是：**一次性临时 profile**（每会话一个全新目录 ⇒ cookie jar
天然不串）+ **判重指纹 = `chatglm_token` 的 SHA-256 前 16 hex**
（⚠️ token 是会话秘密，**不能用明文当指纹** —— 进 `state.json` 就是泄漏；
`doubaoSessionIdOf` 那边直接比 `sessionid` 是安全的，因为那是账号标识，两边刻意不同）。

## 4. ⚠️⚠️ 闸门强度：`X-Sign` 系**当前不被校验**（消融矩阵 37 格实测）

判据：**40102 = 过闸、仅 token 无效**；**40003 = 被前置拒绝**。

| 被删/改的项 | 结果 |
|---|---|
| `X-Sign` / `X-Nonce` / `X-Timestamp` / `X-Device-Id` / `X-Request-Id` | 40102（照过） |
| `App-Name` / `X-App-Platform` / `X-App-Version` / `X-App-fr` / `X-Lang` | 40102（照过） |
| `X-Exp-Groups` / `X-Device-Model` / `X-Device-Brand` / `Content-Type` | 40102（照过） |
| `X-Sign` = 全 0 / 空串 / nonce 不匹配 / 时间戳被改 | 40102（照过） |
| `X-Timestamp` = `0` / `9999999999999` | 40102（照过） |
| **全部头都不带（仅 UA）** | **40003（被拒）** |

⇒ **`Authorization` 头必须存在**（member-api 缺失回 40003；user-api / mainchat-api
缺失回 40001）。除此之外这套签名机制**纯装饰**。

⚠️ 但本实现**仍按官方算法产出真签名**（`chatglmSign`），理由不是「必需」，
而是「上游随时可收紧且**无前置征兆**」—— 成本一次 md5，收益是收紧时不至于
整条渠道突然全 40003。**别把这条读成「必须签名才能用」。**

### 官方算法（`86129` 模块 `w()` 逐字复刻，别"优化"）

```
nonce = genV4() 去掉横线              → 32 hex
o     = String(Date.now())            → 13 位
t     = sum(o 的各位数字) − Number(o[倒数第 2 位])
stamp = o[0 .. -3] + String(t % 10) + o[末位]
sign  = md5(`${stamp}-${nonce}-8a1317a7468aa3ad86e997d08f3f31cb`)
```

⚠️ **`stamp` 不是时间戳本身**：它是「倒数第 2 位被替换成
`(各位数字和 − 原倒数第 2 位) % 10`」。写成 `Date.now()` 直传是**算法退化**
（`tests/unit/chatglm.spec.ts` 有定量断言钉住它）。

## 5. 凭据格式与登录可行性

**cookie**（`js-cookie` 写入，**非 HttpOnly** ⇒ 可在浏览器里直读）：

| cookie | 寿命 | 用途 |
|---|---|---|
| `chatglm_token` | **30 天** | `Authorization: Bearer` 的值 |
| `chatglm_refresh_token` | **180 天** | 续期端点的 Bearer |
| `chatglm_user_id` | — | 展示 / 判重（**不进**凭据的字段名） |

## 5.5 ⚠️⚠️⚠️ token 是 JWT：三条**实测**事实（推翻了本节 5 的早期推断）

一次性干净 profile 打开 `chatglm.cn` 后，立即读 `Storage.getCookies` 拿到的
`chatglm_token` 解出来是：

```jsonc
{
  "sub": "7e028697fb254b45b788bb6491e28952",
  "exp": 1793857636,
  "iat": 1793771236,                              // ← exp − iat = 86400s = **24 小时**
  "uid": "6aeac6e4c18a82be3199e01b",
  "device_id": "72b875712e784cbaa46493406846a706", // ← **32 hex，服务端下发**
  "is_guest": true,                                // ← **游客态！**
  "mode": 1,
  "type": "access"
}
```

### ⚠️⚠️⚠️ ① 站点对**未登录访客**也发 token ⇒「有 token」≠「已登录」

`is_guest: true` 是游客态。旧实现只看「cookie jar 里有 `chatglm_token`」⇒
**窗口一打开就被判成「登录成功」**，`finally` 立刻 `close()` 把窗口杀掉，
**用户根本看不到登录界面**（用户报障原话：「没单独起一个浏览器来显示登录」）。

判据改为**`token 存在 且 不是游客`**（`chatglmCredentialFromCookies` 的 `guest` 字段）。
⚠️ 解不出来（非 JWT）时**按非游客处理**（fail-open）：上游若改成不透明 token
我们就无从判断，此时 fail-closed 会让登录**永远不成功**（更糟的失败形态）。

### ⚠️⚠️ ② `expires_at` 必须读 JWT 的 `exp`，**不能照 cookie TTL 算**

cookie `chatglm_token` 的 `expires: 30`（天）与 token 的**真实寿命 24 小时**
**不是一回事**（cookie 活得比 token 久）。旧实现写 `now + 30 天` ⇒
`expires_at` 比真值大 29 天 ⇒ `refreshAll` 的 lead-time **永不触发** ⇒
过期前不自愈、过期后也不自愈、**日志零字**（`autoclaw` 的 P0 同型形态）。
⚠️ 读不到 `exp` ⇒ **不写该字段**（宁缺勿造）。

### ⚠️ ③ `device_id` 是**服务端下发**的，派生只是兜底

`chatglmDeviceIdOf` 的优先级：凭据存量 → **token 里的 `device_id`** → `accountKey` 派生。

### ⚠️⚠️ 变异验证：判据必须写在**纯函数**里，不能藏在 CDP 方法内

第一版把上述判据直接写在 `ChatglmLoginSession.readCredentialOnce()`
（带 CDP 状态的私有方法）。实测变异：**把游客拦截删掉**、**把 `expires_at`
换回 `now+30 天`** —— 39 条用例**全绿**（假绿！）。
⇒ 抽出纯函数 `chatglmCredentialFromCookies(cookies)`，生产路径只做
「拿 cookie → 转交判据」两件事。改后同样的两个变异：**1 条 / 2 条当场变红**。
教训与 `docs/agent-notes/client-ui.md` 的「守卫全绿不足以证明它有牙」逐字同型。
**续期**：`POST /chatglm/user-api/user/refresh`（Bearer = **refresh token**）→
`result.access_token` / `result.refresh_token`；官方客户端把本地有效期记成
**`now + 2 小时`**（`chatglm.ts` 的 `RefreshToken` action 逐字可见）。
⚠️ `refresh_token` **是否轮换未实测** ⇒ 本实现不假设「不轮换」
（上游给了就换、没给就保留旧值）—— 两种上游行为都正确。

**登录两条路，两条都带风控**：
- 微信扫码：`WxLogin` iframe（appid `wx7b19c27985d99d60`，`state: "fangState88888My"`，
  回调 `https://chatglm.cn/WeChatLoginTransit`）或 `POST /chatglm/user-api/user/wechat_qr_login`；
- 短信：`POST /chatglm/user-api/user/phone_login` / `auth_code_login`，需要
  **图形验证码**（`captcha` / `pic_captcha_id` / `md5`，`localStorage['captcha_rid']`）。

⇒ **无法在 Node 里程序化登录**（也不该硬绕：账号被判异常，用户丢的是真账号）。
本实现的做法：起一个**可见**浏览器窗口（一次性 profile），用户自己登完后用
`Storage.getCookies`（浏览器级、可读 HttpOnly）读回 token。

## 5.6 ⚠️⚠️ 卡片「有效期 未知」：`expiresAt` 只来自**池条目**（2026-11-04 真机报障）

### 症状与根因

卡片显示「有效期 未知」。`account.list` 的 `expiresAt` **只来自池条目**
（`ProviderAccountEntry.expiresAt`），**不读凭据文件**。登录分支当时只
`credentials.set(...)` 而不 `pool.updateAccount({ expiresAt })` ⇒ 池条目没有这个字段
⇒ 卡片读到 `undefined` ⇒ 恒显示「未知」，且**永远不会自己补上**。

⚠️ 这是本仓库**第 4 次**踩同一个坑（OfficeAce → Codely → Magicrew → chatglm）。
⚠️ 不是 chatglm 独有：读写两端（登录写、列表读）必须同时在位。

### 修法（三条腿，缺一不可）

1. **登录落库时就写**：`pool.updateAccount(id, { nickname, ...chatglmExpiresAtPatch(credential) })`
   —— 判重命中既有账号的那条路径**同样**要写。
2. **`account.list` 自愈回填**：池条目缺 `expiresAt` 时，逐账号按它**自己的**
   `credentialRef` resolve 凭据、算出真实时刻并写回池（一次性自愈）。
3. **判据唯一一份** `chatglmExpiresAtPatch`：`expires_at` 优先 → JWT `exp` → 都没有就
   **不写这个键**（绝不写 0/NaN，那会让卡片显示「已过期」，比「未知」更糟）。

⚠️ `expires_at` 优先与 `autoclaw` 的「JWT 优先」**方向相反**，理由：本家的
`expires_at` 是**续期那一刻**按服务端口径算出的新值，比旧 token 里冻结的 `exp`
更贴近「这份凭据还能用多久」。

### ⚠️⚠️ 同批抓到的**独立真缺陷**：`credentialRef()` 同步抛错而 `.catch()` 接不住

`credentialRef('chatglm.account.legacy')` 的校验是 `/^[A-Za-z_][A-Za-z0-9_]*$/`，
**非法形态同步抛错**。而回填循环原先写的是：

```ts
const resolved = await ctx.credentials.resolve(credentialRef(account.credentialRef))
  .catch(() => undefined)   // ← 接不住同步 throw（throw 发生在进入 await 之前）
```

⇒ 一条脏 `credentialRef` 会让**整个 `account.list` 抛 500**（症状：面板一片空白，
点任何按钮都失败）。**OfficeAce 那块是同一写法、同一隐患**，已一并修复（包 try）。
⚠️ 可推广：凡「`await f(x).catch(...)`」而 `x` 的表达式**本身会抛**，那个 `.catch`
就是装饰 —— 重点是**同步段**必须在 try 内。

### ⚠️⚠️ 变异验证：判据写在私有方法里 = 无守卫

第一版守卫只测纯函数 `chatglmExpiresAtPatch` 的取值域。实测：

| 变异 | 修复前 | 修复后 |
|---|---|---|
| 登录分支删掉 `...chatglmExpiresAtPatch(credential)`（= 报障原状） | **0 条失败** | 2 条失败 |
| `account.list` 的自愈块整个短路 | **0 条失败** | 1 条失败 |
| 回填不包 try（还原同步抛错隐患） | **0 条失败** | 1 条失败 |

⇒ 补写 `tests/unit/chatglm-browser-login.spec.ts`：**真跑** `account.create` 三步式
（`vi.mock` 换掉 `ChatglmLoginSession` ⇒ **零进程、零窗口**），并用 `login.poll`
当同步点（不引入固定延迟）。

### ⚠️ 测试脚手架的坑（写了才通）

- RPC 请求体是 **connection 的信封格式**
  `{type:'client-request', rpcId, method:'jet-hub', payload:{method, payload}}`，
  不是裸 `{method, payload}`；写成裸的会回 `ok:false`，症状极像「provider 没接线」。
- 测试里的 `credentialRef` 必须**合法形态**（大写字母+下划线），
  否则被测代码在回填时同步抛错 —— 而那是**被测缺陷本身**的另一条腿，
  混进来会让「回填没生效」与「ref 非法」两种失败**同形**。
## 5.7 ⚠️⚠️⚠️ 服务器部署时窗口开在服务器上（2026-11-04 用户报障）

### 报障

> 「部署到服务器后，为啥浏览器不是在本地电脑打开，codeArts 就可以在本地电脑打开，
> 而不是服务器那里」

### 根因：`account.create` 的返回值决定走哪条开窗路径

| provider | `loginUrl` | 谁开窗 | 窗口在哪 |
|---|---|---|---|
| CodeArts / OfficeAce / buddy / loomy… | **非空** | **客户端** `window.open` | **用户本地**浏览器 |
| 本渠道（修复前） | **空串** | **宿主** `spawn(浏览器)` | **服务器**进程 |

客户端拿到**空** `loginUrl` 会整段跳过开窗分支：

```js
if (!loginUrl) { await loadAccounts(); setProbeNotice(...); return }   // ← 全流程到此结束
```

⇒ 唯一那个窗口是宿主 `spawn` 出来的，落在服务器上；无头部署里它画在 Xvfb 虚拟屏，
用户根本看不到。**这正是报障现场。**

⚠️ 代码里早就承认了这个形态：`plugin-src/client/jet-hub.js` 的
`if (res.incognitoOpened === true)` 分支逐字写着「无头/远端部署里（宿主只有
Xvfb `:99`、用户经隧道用自己的浏览器访问），宿主『开了』但**画在没人看的虚拟屏上**」
—— 那个 `confirm`（「要在本机浏览器再打开一个吗？」）就是为此存在。
**但本渠道当时返回空 `loginUrl`，连那个 `confirm` 都走不到。**

### ⚠️⚠️ 与 CodeArts 的**本质差异**（仿照不等于等同）

CodeArts 能「本地开窗 + **全自动收口**」，是因为它的 `loginUrl` 是
**标准 OAuth 授权页 + 本地回调服务器**：`startOAuthFlow` 起一个 loopback 端口，
浏览器授权后 `302` 回 `127.0.0.1:<port>` 收 code ⇒ 零操作。

**智谱清言网页端没有这条回调链路**：

1. `chatglm_token` 是 `chatglm.cn` 域的 cookie，**宿主读不到用户本地那一份**
   （部署在服务器 ⇒ 两机不同；即使同机，也只有浏览器进程能读自己的 cookie jar）；
2. 上游**没有给我们注册过的 `redirect_uri`**（`WeChatLoginTransit` 是它自己的中转页）。

⇒ 本渠道只能是**两步**：① 本地开窗让用户自己登录 → ② **用户把登录态粘回面板**。
这比「什么都没发生」好得多，但**不是** CodeArts 那种零操作体验 ——
后来的注释里**不要**写成「已等同 CodeArts」。

### 修法（三条腿）

1. **返回非空 `loginUrl`**（`CHATGLM_BROWSER_LOGIN_URL`，`?from=dsh-jet-hub` 只作可读标识）
   ⇒ 客户端在你**本地**浏览器 `window.open`。
   宿主的 `mode:'browser'` 可见窗口**仍保留**（本机部署时它才是能自动读 cookie 的那条路）。
2. **新增 `mode: 'paste'`**（`account.create`）：收 `pasteText` →
   `chatglmCredentialFromInput` 归一 → **先验一次上游**（`fetchChatglmBalanceDetailed`，
   幂等只读）→ 按 token 指纹判重 → 落库 + `chatglmExpiresAtPatch`。
   这是**服务器部署的唯一可用路径**。
3. **客户端 `ChatglmPasteModal`**：独立 state（不蹭 `credentialModal`，
   那家语义是「读本机浏览器/开窗」不收输入）；**明文走 ref 不进 state**
   （与 `keyModal` / `qiniuKeyEditModal` 同款约定）；弹窗里给出可直接复制的
   `document.cookie.match(/chatglm_token=([^;]+)/)?.[1]` 一行。

### ⚠️⚠️ 变异验证（第一版又是假绿）

| 变异 | 修复前 | 修复后 |
|---|---|---|
| `loginUrl` 改回 `''`（= 报障原状） | **9 条全绿** | **1 条失败** |
| `paste` 路径不写 `expiresAt` | — | 1 条失败 |
| `paste` 不验上游（直接落库） | — | 1 条失败 |

⇒ 补 `tests/unit/chatglm-browser-login.spec.ts` 的「必须返回非空 `loginUrl`」一条。
⚠️ 这条守的是**返回值形状**，不是源码文本 —— 它是「窗口在哪开」的唯一可判据点。

### ⚠️ 测试脚手架的坑

粘贴路径会**真发一次上游校验**（这是刻意的：不让用户以为自己粘成功了）。
⇒ 用例必须 stub `globalThis.fetch` 回一个 `status:0` 信封；不 stub 会打到真实
`chatglm.cn`，离线环境下恒回 `40102` 导致**假红**（而且测试真对外发了请求）。
## 5.8 ⚠️⚠️⚠️ 宿主侧**不再起浏览器**（2026-11-04 用户最终要求）

### 用户原话

> 「现在在服务器打开浏览器特别卡，根本就识别不到滑动块，还是要在本地电脑打开浏览器
> 才可以，不然很难登录账号」

这句话点了**两个各自独立的缺陷**，第二个是硬的：

1. **服务器上开浏览器极慢** —— 无 GPU；智谱的**滑块验证码在无头环境里渲染不出来**
   （用户「根本识别不到滑动块」）；无 Xvfb 时进程压根起不来。
2. 就算窗口真在服务器上开了，**用户也看不见**（远端部署时那台机器的屏不属于用户）。

⇒ 5.7 那版「保留宿主无痕窗口 + 客户端本地再开一个」的折中**不满足要求**：
用户端的症状是「窗口卡在服务器上、滑块拖不动」，多开一个本地窗并不能救那个。

### 最终设计（宿主**零**浏览器进程）

| `account.create` 的 mode | 宿主做什么 | 用户做什么 |
|---|---|---|
| `'browser'` | **只返回 `loginUrl`**；**不建号**、不起进程、无 `login.poll` | 客户端在**本地**浏览器 `window.open` 打开 `CHATGLM_BROWSER_LOGIN_URL` |
| `'paste'` | 归一 → **验上游** → 判重 → 建号 + 写有效期 | 登录完把 `chatglm_token`（或整条 cookie）粘进面板 |

### ⚠️ 连带删除的东西（以及为什么不能悄悄加回来）

- **`ChatglmLoginSession` 整个类删掉**（`spawn` 浏览器 + `MiniCdp` +
  `Storage.getCookies` 轮询 + 一次性 profile）。`src/chatglm-login.ts` 现在只剩
  两个常量 + `chatglmTokenFingerprint`。
- **`chatglmLoginInFlight` 单飞表删掉**：没有后台任务可 await。
- **`login.poll` 的 chatglm 分支删掉**：`mode:'browser'` 不建号，
  `accountId` 恒为空串，客户端**不调** `startLoginPoll`。
  ⚠️ 落到那里（有人拿一个 chatglm 账号 id 发 poll）如实回 `{done:false}`。

⚠️⚠️ **一旦本家重新在宿主侧开窗，必须同时恢复三样**：单飞表 + `login.poll` 分支
+ `accountId` 非空。缺任一处都会出问题：并发点两次开两个窗口 / 客户端起一个
**假的** 5 分钟轮询然后报「登录超时」（用户此时其实正在粘贴弹窗里操作）。

### ⚠️ `accountId` 必须返回**空串**（这是刻意的）

非空会让客户端起 `startLoginPoll`，而那边**没有任何东西会落定** ⇒ 5 分钟后报
「登录未完成（超时）」。那个超时是**假的**。守卫用例锁了这条。

### ⚠️⚠️ 与 CodeArts 的**本质差异**（仍不成立）

CodeArts 能「本地开窗 + 自动收口」，是因为它的 `loginUrl` 是标准 OAuth 授权页 +
**本地回调服务器**（`startOAuthFlow` 起 loopback 端口收 code）。
智谱清言网页端**没有**这条回调链路（`chatglm_token` 是 `chatglm.cn` 域 cookie、
宿主读不到；上游没给我们注册过的 `redirect_uri`）⇒ **必须手动粘**。
**别在后来的注释里写成「已等同 CodeArts」。**

### 变异验证

| 变异 | 结果 |
|---|---|
| `accountId` 改回非空（客户端会起假轮询） | **1 条失败** |
| `mode:'browser'` 加回 `pool.addAccount`（会造幽灵卡） | 由「不得建占位账号」那条锁住 |

### ⚠️ 测试用例已按新设计重写（三条）

旧版验证「`mode:'browser'` 起浏览器 → `login.poll` → 建号」的三条用例，
在**新设计下不可能成立**（宿主不再建号）。重写为：

- 「`mode:'browser'` **不得**起浏览器、**不得**建占位账号」（新增，锁住本次变更）
- 「凭据里读不到有效期 ⇒ 不写这个键」（改为直接打纯函数 `chatglmExpiresAtPatch`）
- 「声明值 `expires_at` 优先」（同上）

⚠️ 有效期判据本身**没有变**，只是喂给它的路径从 `mode:'browser'` 的轮询落库
变成了 `mode:'paste'` 的建号（后者已有独立用例覆盖）。
## 6. `rateLimit: false` 与 `channel: false` 的理由（两者**不同**）

- **`channel: false`**：没有模型目录 / 适配器 / auth 服务（纯签到渠道，
  与 `doubao` 同型）。`credits.balance: true` 的判据**独立于** `channel`。
- **`rateLimit: false`**：零 `updateModelRateLimit` 写点、不在 `probeById` 里
  ⇒「重测 / 重置」点下去**零请求、零清除**（`account.retest` 走
  `adapterForProbe` 会抛「chatglm 没有探测适配器」）。接推理链路时翻正。

## 7. 接线清单（⚠️ 缺一处即静默失效，本仓库已复发十余次）

| # | 位置 | 内容 |
|---|---|---|
| 1 | `src/provider-registry.ts` | `chatglm` 条目（**必须在 `magicrew` 之前**，否则破坏「magicrew 是倒数第二」） |
| 2 | `src/provider-credits.ts` | 积分表条目（`fetchBalanceDetailed` + `claim` + `precheckStatus: false`） |
| 3 | `src/jet-hub-store.ts` | `['CHATGLM', 'chatglm']` 前缀（**漏加 ⇒ `state.json` 丢失后账号静默消失**） |
| 4 | `src/jet-hub-rpc.ts` | `JetHubAuths.chatglm` 类型 + `SELF_HEAL_REFRESHABLE_PROVIDERS` 的 `'chatglm'` |
| 5 | `src/index.ts` | `new ChatglmAuth(...)` + `registerJetHubRpc` 的 `chatglm:` 传值 |
| 6 | `plugin-src/client/provider-icons.js` | `CHATGLM_ICON` + `PROVIDER_ICONS.chatglm` |
| 7 | `plugin-src/client/jet-hub-styles.js` | `.dim-jh-providerIcon.chatglm` |
| 8 | `plugin-src/client/jet-hub.js` | 新增账号分支（`mode: 'browser'`） |
| 9 | 守卫计数 | `provider-registry.spec` 26→27、`credits-runtime-parity.spec` 20→21、`zcode-wiring.spec` 25→27 / auth 键 23→24 |

## 8. ⚠️ 本轮**由守卫抓出来的既有缺陷**（不是新渠道引入的）

1. **`doubao` 从未登记到 `REF_PREFIX_TO_PROVIDER`**
   （`jet-hub-store.spec.ts` 的「恢复表覆盖客户端 PROVIDERS」当场红并点名）。
   ⇒ 豆包账号在 `state.json` 缺失时**静默消失**（凭据还在 `.credentials.yaml`、
   索引建不出来，用户只能重新扫码）。已一并补上 —— 这是那张表存在的理由，
   也是「守卫比人眼可靠」的又一例（同款坑第 **10** 次）。
2. **`doubao` 没有进任何自愈豁免表**（`credits-balance-self-heal.spec.ts` 点名）。
   已登记理由：浏览器 cookie 凭据、上游无 refresh 端点、续期只能人工重扫码。
3. **`doubao` 不在 `VIRTUAL_PROVIDERS` 豁免里**（`catalog-shared-skeleton.spec.ts` 点名）。
   已与 `chatglm` 一并登记「纯签到渠道（channel:false）」理由。

## 9. 未实测 / 已知边界（如实登记，不要当成已验证）

- **真凭据从未走过签到/余额路径**（用户要求不拿真号试）。所有状态码语义
  （`40102` / `40003`）都来自**假 token 探测**，`score > 0` / `score === 0`
  两种成功形态来自**主包逆向**而非实测响应。
- **`refresh_token` 是否轮换未实测**（实现已按「两种都可能」写）。
  ⚠️ 2026-11-04 更新：**JWT 已实测**（§5.5）—— expires_at / device_id / is_guest
  三项从「推断」升级为「实测」；但**真凭据的签到/余额响应**仍未实测（见下条）。
- **`user/info` 的 `member_info` 完整字段集未实测**（只用到 `left_score`）。
- **暑期赠分 / 消费抽券两条活动链未接线**（端点已登记在 `CHATGLM_PATHS`，
  但 `claim` 只做每日登录积分 —— 那两条是**有条件活动**，不该塞进每日签到）。
- **图形验证码 / 滑块无任何程序化方案**（登录走浏览器，见 §5）。
