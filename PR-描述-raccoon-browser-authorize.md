# PR：Raccoon（商汤小浣熊）扫码登录改浏览器授权 —— 官方那条链取代已死的 `/login/mp`

```text
feat(raccoon): 扫码登录改浏览器授权 —— 官方那条链取代已死的 /login/mp
```

一个提交。**问题不是我们写错了什么，而是上游把那条链作废了** —— 而插件还停在旧链上，于是用户**扫码进去只看到一个 404 页**，界面上零报错。

---

## 一、缺陷：扫码确认页已死，而签发仍是成功的

### 症状（用户看到的）

点「+ 新建账号」→ 弹窗出二维码 → 扫 → **404 页面**。插件侧**零报错、零日志**，
二维码画得出来、状态一直写「等待扫码…」，直到 5 分钟超时。

### 根因（实测，不是推测）

**扫码确认页 `/login/mp` 自 2026-11-04 起全部 404**，而**签发本身是成功的**。

2026-11-14 / 11-15 两次逐 UA 复测（微信 `MicroMessenger/8.0.49` 与桌面
Chrome 140 各测两档 query），全部 `404 + __next_error__`；带/不带 `code`、
`appname`、`source=platform`、`www.` 前缀、`/login/mp.html`、`/login/mp/index`、
`/Login/mp` 都是 404，而 `/login` 对照 200。2026-11-17 本 PR 的探针复验：
**仍然全 404**。

⚠️ **关键在「签发是成功的」** ⇒ 页面走不到 `.qr-fallback`（那是**签发失败**时
才替换二维码区域的分支）⇒ 用户扫进一个 404 页，而界面上**没有任何一句**告诉他
还能走别的路。

⇒ 这不是「补一个提示」能解决的：**旧链已经死了**。

### 官方客户端现在走的是哪条链

2026-11-05 的官方构建**不再用扫码确认页**，改走：

```
系统浏览器打开  {gateway}/authorize?login_source=desktop&appname=…&desktop_callback=loopback
                      &redirect=http://127.0.0.1:<port>/auth/callback&state=<64 hex>
   ↓ 用户在**网页里**登录（手机号 / 微信扫码 —— 那是页面自己的另一张**活的**二维码）
   ↓ 点「确认授权」⇒ 页面申请一枚**一次性** authorization_code
   ↓ 页面把 code 投递回 redirect（desktop 形态下参数名是 `code`）
   ↓ POST /api/web/auth/v1/login_with_authorization_code { authorization_code }
   ↓ 拿到 access_token（+ 网关配发的 refresh_token）
```

⚠️ 旧结论说「官方那条链的回调地址**写死在 Web bundle 里**，改不成 localhost」——
**那条已不成立**：现在的授权页**认** loopback 形态，它的解析器本身就要求那条
redirect 的形状（`^http://127\.0\.0\.1:[1-9][0-9]{3,4}/auth/callback$`）。

本仓是宿主侧 Node 进程，收不到 `office-raccoon://` 自定义协议 —— 但**回环那一半
可以自己托管**，这正是官方在 Windows/Linux 兼容形态下的做法。

---

## 二、修法

### 新增 `src/raccoon-authorize.ts`

| 导出 | 职责 |
|---|---|
| `buildRaccoonAuthorizeUrl` | 构造 `/authorize` URL，**按官方页面自己的解析器规则前置校验** |
| `startRaccoonAuthorizeReceiver` | 回环接收端（**官方接收端的七条规则**逐条重述，一次性） |
| `exchangeRaccoonAuthorizationCode` | 换码（成功门 = 官方那道门） |
| `isRaccoonIamToken` / `raccoonIamTokenIsValid` | 官方 `iamToken.js` 的两条判据 |

### 为什么 URL 要**前置**校验

页面会拒收的 URL **不该**拿给用户 —— 那种链接会解析成上下文却**在投递那一刻
才炸**，是一条「看着能点、点了没反应」的死路。官方页面自己的规则（逐条取自
它的 chunk）：

- `redirect` 必须匹配 `^http://127\.0\.0\.1:[1-9][0-9]{3,4}/auth/callback$`
  （端口 **4~5 位、首位非 0**），且端口落在 1024..65535；
- `state` 必须 **64 位小写 hex**；
- `login_source` 存在时**必须**是 `desktop`；
- `desktop_callback` 存在时**必须**是 `loopback`，且此时 `login_source` 必为
  `desktop`、`ide` 必为空、`redirect` 必过上面那条；
- 参数名**只能**取自 `{login_source, appname, state, redirect, ide, org, lang,
  desktop_callback}` —— **多一个键整条链接就作废**。

### 回环接收端的七条规则

授权码是**一次性凭据**，而一个敞开的接收端就是「凭据交换漏洞」 ⇒ 七条检查
**一条都不能少**：GET-only、`Host` 等于我们自己的 authority、来源地址是回环、
存在的 `Origin` 必须等于网关 origin、存在的 `Sec-Fetch-Dest` 必须是 `document`、
路径与查询键严格受限（只认 `code` + `state`）、`state` 常量时间比对通过。

**一次性**：有效回调被取走后，端口对一切回 **409**（那枚 code 在上游也是一次性的，
第二次投递**不得**再换一次码）。

### 换码的成功门

官方那道门逐字重述：必须有 `access_token`，**且**满足**二者之一** ——
一枚**有效**的 IAM 令牌（官方规则：同一 issuer + 非空 `sub` + 未来的 `exp`），
**或**一枚 refresh token（legacy 那一对）。

差一点就是**拒绝 + 具名原因**，**绝不**产出半截凭据（存下半个凭据 = 存下一个
轮换之后什么都不剩的东西）。

### 凭据的边界

授权码只走「接收端 → 换码 → 凭据」这一条链，**从不**进入任何响应体或日志。
失败只报**原因词**，不带报文原文 —— 报文可能回显那枚 code。

### 登录页：第三个 Tab，且**默认落在它上面**

本地登录页（`raccoon-login-page.ts`）多一个 Tab「浏览器登录」，另有三个端点
`/raccoon/authorize/{start,status,cancel}`。

⚠️ **默认 Tab 改成浏览器登录**：默认停在扫码上 = 用户点开就看到一个**必然 404**
的二维码。**扫码与短信两条 Tab 都保留**（上游哪天把 `/login/mp` 修回来，它就
又能用了）—— 这是**让位**，不是**替换**。

---

## 三、实测证据（2026-11-17，零消耗）

新增探针 `pnpm test:e2e:raccoon-authorize`（**不登录、不换码、不碰任何真实
账号**；只 GET 那个 404 页、只 GET 授权页读它的 HTML、只 POST 一枚**自造的**
code —— 它必然被拒，那正是判据）：

| # | 断言 | 结果 |
|---|---|---|
| ① | `/login/mp` **不再是 200**（否则扫码链还活着，就不该让位） | ✅ 404 |
| ② | `/authorize` 200，且**原样回显**五个参数、**不是**错误壳 | ✅ 200 |
| ③ | 换码端点对瞎编的 code 回 **400 / `{code:200035}`** | ✅ |

---

## 四、验证

- **新增单测 36 条**（`tests/unit/raccoon-authorize.spec.ts`）：回环接收端
  **真起 `127.0.0.1` 随机端口**、每条拒绝**真发 HTTP 请求**（用桩服务器测，测的
  就是「我们以为的规则」而不是规则本身）；换码用**注入的 fetch**（零网络）。
- **新增整条链集成 4 条**（`tests/unit/raccoon-login-page.spec.ts`）：本地页 +
  回环 + 换码**串起来**（三段各自都对、串起来却不通，是这一族最常见的形态）。
- **变异 14/14 有牙**（`scripts/mutate-raccoon-authorize.mjs`；⚠️ 该脚本按本仓
  惯例**不入库**（`scripts/*` 是 gitignore 的本地工具目录），**结论入账**）。
  脚本会**先跑基线**（基线不绿就停）、每个变异**自证注入成功**（锚点未命中报
  `PATCH-NOT-APPLIED`，**不**当成「无牙」）、跑完**还原并复验**。
- **全量 14123 通过**。仅 `qoder-web-usage`(4) 与 `magicrew-local-browser`(1)
  失败 —— 已在**改动前的基线上逐条复现**（前者在干净基线同样红、后者读本机真实
  浏览器目录），**与本 PR 无关**。

---

## 五、途中被测试抓出的三个真问题（如实登记）

1. ⚠️ **单测真的开了浏览器** —— 那会在**用户桌面**上弹出真实窗口，而它会
   **真的**加载授权页并（若浏览器里已有会话）**真的**投递一个回调 ⇒
   **消费掉接收端**，让用例测到的东西完全不是它想测的。
   ⇒ `startRaccoonLoginFlow` 增 `openAuthorizePage` 注入点，单测传 `() => {}`。
2. ⚠️ **「取消等待」被报成「失败」** —— 接收端的落定回调无条件写 `failed`，
   而 `cancel()` 会让它落定为 `closed` ⇒ 用户明明是自己取消的，却看到「失败」。
   ⇒ 取消那一支**让出** `failed`（状态先挪出 `waiting` 再 cancel）。
3. ⚠️ **本地页服务器在登录落定的那一刻就关了**（既有契约）⇒ 页面那句「登录
   成功」是**尽力而为**的（页面 2 秒一轮，换码往往在两拍之间就完成了）
   ⇒ 页面的轮询失败分支必须说「登录已完成或页面已关闭」，不能停在「等待中」。
   **真正的成功信号来自 Jet Hub 那边的 `login.poll`。**

---

## 六、⚠️ 四条不能凭直觉改的点（已写进 `docs/agent-notes/providers-loomy-raccoon-minimax.md`）

1. **`iss` 是「裸 host + `/iam`」**（`xiaohuanxiong.com/iam`，**无 scheme**）。
   `iss` 是**等值**比较 ⇒ 按带 scheme 的严格等值去比，会**误拒每一枚真令牌**。
2. **IAM 形态的判定只看 `iss` 的后缀**（`endsWith('/iam')`）—— 所以一枚**带
   scheme** 的 `iss` **仍然**算 IAM 形态。它过不了上面那条严格等值检查，但那是
   **另一条**判据。两条分工不同，别把它们写成同一条。
3. **页面投递时用的参数名在 desktop 形态下是 `code`**（非 desktop 才是
   `authorization_code`）—— 接收端只认 `code` + `state`，认错名字 = **永远收
   不到回调**。
4. **上游形状是「单测锁不住」的**：单测只能锁「代码按某个形状写」，锁不住
   「那个形状本身对不对」 ⇒ 三条上游事实各由**一条 e2e 探针**固定。

---

## 七、范围声明

- ⚠️ **只动 raccoon 的登录链**：`src/raccoon-authorize.ts`（新）、
  `src/raccoon-login-page.ts`（第三个 Tab + 三个端点），加测试与文档。
  **其它 provider 一行未动**；扫码与短信两条旧路径**一行未删**。
- ⚠️ **不含任何 UI / 供应商列表 / 凭据存储格式改动**。
- ⚠️ 本 PR **不读**本机「商汤小浣熊」桌面客户端的任何文件（那条「只读直连」
  形态与本 PR 无关，也未被本 PR 触碰）。
