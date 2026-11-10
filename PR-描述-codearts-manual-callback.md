# feat(codearts, trae): 新增「手动填写回调链接」登录（手机 / 另一台电脑完成授权）

> 分支：`feat/codearts-manual-callback`（基于 `master@1d12f80`）
> 范围：CodeArts（华为云）+ TRAE（字节跳动）· 含本描述

## 一、为什么需要它

两家的授权回调都被定向到**宿主本机**：

| provider | 回调地址 | 回传内容 |
|---|---|---|
| CodeArts | `http://127.0.0.1:<port>/oauth/callback?code=…` | OAuth 授权码（需本机交换） |
| TRAE | `http://127.0.0.1:<port>/authorize?refreshToken=…&userInfo=…&userJwt=…` | **直传 token 材料** |

⇒ 只要用户不是在**运行宿主的这台机器**上完成授权，那一跳就必然失败：

| 场景 | 浏览器看到 | 结果 |
|---|---|---|
| 本机浏览器授权 | 自动跳回 `127.0.0.1:<port>` | ✅ 原有流程 |
| **手机 / 另一台电脑**授权 | 「无法访问此网站 / 127.0.0.1 拒绝了连接」 | ❌ 跳转失败，**但地址栏里已是一条合法的回调链接** |

失败页上那条 URL 里带着完整凭据材料（codearts 的一次性 `code`；TRAE 的
`refreshToken` / `userJwt.Token`），故真正的缺口不是「拿不到凭据」，
而是**没有任何入口把它交回宿主**。

## 二、修法（方案 A：只补一条回传通道，不改授权机制）

| # | 位置 | 改动 |
|---|---|---|
| 1 | `src/login.ts` | 抽出 `createOAuthCallbackReceiver`：本地回调与手动提交**共用同一个收码器**（`settled` 幂等闸门）；`startOAuthFlow` 暴露 `submitManualCallback`；新增纯函数 `parseManualCallbackUrl` + `MANUAL_CALLBACK_FAIL_PREFIX` |
| 2 | `src/service.ts` | `startLogin` 透传 `submitManualCallback`（**漏这一行 RPC 层会拿到 `undefined`**） |
| 3 | `src/trae-oauth.ts` | `startTraeLoginFlow` 暴露 `submitManualCallback`：复用同一 `exchangeTraeCallback` + 同一 `resultPromise` 落定通道 + `settledRef` 幂等闸门；新增 `ManualTraeCallbackSubmitResult` 类型 |
| 4 | `src/trae-auth.ts` | `startLogin` 透传 `submitManualCallback` |
| 5 | `src/jet-hub-rpc.ts` | 通用在途表 `pendingManualCallbacks`（占位 id → `{provider, submit}`）；codearts 与 TRAE 分支各登记 + `finally` 清理；端点 `account.submitCallback` 按 provider 转调 |
| 6 | `src/types.ts` | `RpcSubmitCallbackRequest`（注释覆盖两家形态） |
| 7 | `plugin-src/client/jet-hub.js` | 登录中渲染回调链接输入框（条件扩到 codearts + trae）；行内错误；三出口复位；placeholder 按 provider 切换 |
| 8 | `tests/unit/codearts-manual-callback.spec.ts` | 27 条守卫（解析矩阵 + 提交行为 + HTTP 原路径回归） |
| 9 | `tests/unit/trae-manual-callback.spec.ts` | 9 条守卫（token 直传 + 幂等 + PKCE 形态 + HTTP 原路径回归） |
| 10 | `tests/unit/jet-hub-structure-ast.spec.ts` | 面板级状态提示契约 6 → 7（见 §五） |

### 关键设计取舍

1. **codearts：端口一律取链接里那个**。`redirect_uri` 必须与授权时逐字一致
   （`exchangeAuthorizationCode` 把它原样提交给 STS），改成本机当前端口会被
   `invalid_grant` 直接拒掉。⇒ 解析器返回的 `port` 来自 URL 本身；
   裸 `?code=…`（无端口）**刻意拒绝**而不是猜。
2. **TRAE：没有端口/PKCE 约束**。回调直传 token，交换请求只带
   `ClientID` + `RefreshToken`、**不带** `redirect_uri` ⇒ 链接端口与本机
   监听端口是否一致不影响换取。`machineId`/`deviceId` 登录时已生成，
   手动提交与浏览器回调走**同一个** `exchangeTraeCallback`（同一 session）。
3. **两条来路共用一个收码器**，不各写一份换取逻辑：codearts 的 `code` 一次性、
   TRAE 的 `refreshToken` 轮换是破坏性的 —— 各换一次必然「第二次烧掉第一次」。
4. **`acceptCode` 返回的 promise 永不 reject**（codearts），用布尔值表达成败。
   ⚠️ 手动提交那条腿**丢弃**这个 promise，一个被丢弃的拒绝就是**未处理的
   Promise 拒绝** —— 本轮实现时真的踩到过（`vitest` 报 `Unhandled Rejection`），
   已改为「永不 reject、由 `result` 表达真实成败」。TRAE 同理：手动提交的
   exchange 失败走 `resolveRef.reject`，不产生游离拒绝。
5. **失败绝不让进程退出**：解析失败、端口越界、会话已结束都返回 `ok:false` +
   中文原因，RPC 层原样下发；客户端只显示**行内**错误，**不**走 `setPhase('error')`
   —— 那条路径会让轮询停摆，而浏览器里那一跳可能还在进行。
6. **顺手修掉一处既有缺陷**（codearts）：原实现在 HTTP 回调里**换取失败也 307 到
   `login_succeed=true`**，用户会看到「登录成功」而账号根本没建。现在按换取结果
   选目标页，并加了回归用例钉住两个方向。
7. **端点泛化而非新增**：`account.submitCallback` 一张表按 provider 转调，
   不为 TRAE 另开端点 —— 「人工搬运回调链接」是同一语义，机制差异是各家
   `submitManualCallback` 自己的事，端点不做第二次判断。

## 三、用户体验

```
点击「+ 新建账号」→ 宿主拉起无痕窗口（换号）
  → 手机扫码 / 登录 → 浏览器停在「无法访问 127.0.0.1」
  → 复制地址栏整条链接 → 粘进面板「提交回调链接」→ 提交
  → login.poll 自动收口（成功 / 失败都走既有三态通道）
```

## 四、边界与不做什么

- **只服务 `codearts` 与 `trae`**：其余 provider 的登录分支一个字节未改。
- **不改授权机制**：仍由宿主起本地回调服务器、仍走同一条换取路径；
  手动提交只是把浏览器那一跳换成人工搬运。
- **不做「粘贴凭据 JSON 直接导入」**：那等于信任任意文本当登录态，安全性无法界定。
- **在途表只在本进程内存里**：宿主重启后 `account.submitCallback` 报「会话已失效」，
  前端提示重建账号 —— 而不是让用户对着一条永远用不上的链接反复粘贴。

## 五、为什么动了 `jet-hub-structure-ast.spec.ts`

那条用例是**面板结构契约**（防括号错位，并锁「每条提示的渲染条件是自己的变量」）。
本 PR 新增第 7 条面板级提示，故**同步更新契约**（10 → 11 个子项、6 → 7 条提示、
`expected` 数组加 `showCodeartsCallback`），而不是绕过守卫。

⚠️ 为了让守卫能按既有纪律命中，渲染条件写成**单个派生标识符**
`showCodeartsCallback`（不是内联复合条件）—— 这是守卫本身要求的形态。
TRAE 加入后条件扩为 `provider === 'codearts' || provider === 'trae'`，
但仍收在同一个派生标识符里，守卫期望不变。

**变异验证（守仍有牙）**：

| 变异 | 结果 |
|---|---|
| `showCodeartsCallback` 改成常量 `false` | 1 条红 |
| 整个提示块删除 | 3 条红 |
| 还原 | 11/11 绿 |

## 六、验证

| 项 | 命令 | 结果 |
|---|---|---|
| 类型 | `pnpm exec tsc -p tsconfig.json --noEmit` | ✅ 0 错 |
| 测试类型 | `pnpm exec tsc -p tsconfig.tests.json` | ✅ 0 错 |
| codearts 新守卫 | `vitest run tests/unit/codearts-manual-callback.spec.ts` | ✅ 27/27 |
| TRAE 新守卫 | `vitest run tests/unit/trae-manual-callback.spec.ts` | ✅ 9/9 |
| 既有登录用例 | `vitest run tests/unit/login.spec.ts tests/unit/service.spec.ts tests/unit/plugin.spec.ts` | ✅ 85/85 |
| 既有 TRAE 用例 | `vitest run tests/unit/trae-oauth.spec.ts tests/unit/trae-auth.spec.ts tests/unit/trae.spec.ts` | ✅ 212/212 |
| 结构契约 | `vitest run tests/unit/jet-hub-structure-ast.spec.ts` | ✅ 11/11 |
| 全量 | `pnpm exec vitest run` | 8 文件 / 15 用例失败 —— **与 `master@1d12f80` 基线逐条相同**（均为本机 Linux 上的 Windows 路径类用例） |

### TRAE 新用例覆盖什么

1. 合法链接 → 凭据落定、`refreshToken` 被轮换、`machine_id`/`device_id` 持久化；
   **端口刻意用另一个值**（TRAE 无端口约束，这正是与 codearts 的差异）；
2. 空串 / 垃圾 / 非字符串 → `ok:false` + 可读原因，不打任何上游请求；
3. 裸 query（`/authorize?…`）也能解析；
4. PKCE 形态（只有 `code`）→ 明确报「暂不支持 PKCE」而不是含糊的缺 token；
5. 落定后重复提交 → `ok:false`、不抛、**不再发第二次 ExchangeToken**；
6. ExchangeToken 拒绝 → `result` 拒绝（失败可见），提交当时仍 `ok:true`；
7. **HTTP 原路径回归**：真发一跳 `/authorize` ⇒ 200 且凭据落定；
   回调无效 ⇒ 400 且 `result` 拒绝（不永远挂起）。

**TRAE 变异验证**：

| 变异 | 结果 |
|---|---|
| 去掉 `settledRef` 幂等闸门 | 1 条红（重复提交二次 ExchangeToken） |
| 手动提交不走 exchange | 4 条红 |
| 还原 | 9/9 绿 |

## 七、真机验收（CodeArts + TRAE）

**两家均已实测可用**（真实账号 + 手机，2026-11-10）：完整走通
「+ 新建账号 → 手机完成授权 → 复制地址栏回调链接 → 面板粘贴并提交
→ 凭据落库、账号出现在面板」。

| 项 | CodeArts | TRAE |
|---|---|---|
| 真实上游签发的凭据材料能被本机换取 | ✅ 已验（portal `code` → STS） | ✅ 已验（`refreshToken` → ExchangeToken） |
| 客户端输入框可用（粘贴 → 提交 → 反馈） | ✅ 已验 | ✅ 已验 |
| 登录成功后账号正常出现在账号池 | ✅ 已验 | ✅ 已验 |
| `redirect_uri` 端口语义 | ✅ 用链接里的端口被 STS 接受 | ✅ 无端口约束（交换不带 redirect_uri），已验 |

**本地构建产物验证**（重启 DSH web 后从现装路径加载）：
两家 `submitManualCallback` 均真实存在且可调用；RPC 端点 `account.submitCallback`
在构建产物里接线完整（两家各一对 set/delete）；客户端 bundle 语法通过、
双形态 placeholder 与派生标识符均在。

## 八、仍未覆盖 / 已知边界（如实登记）

- **未改 e2e**：`tests/e2e/login.e2e.spec.ts` 仍只走浏览器回调那条腿。
  「手机授权 + 复制地址栏」这一串人工动作无法自动化，故手动提交那条腿
  以单测（含假 STS / 假 ExchangeToken 换取）+ 两家真机验收共同覆盖，而不是 e2e。
- **客户端新 UI 未做逐项视觉 / 无障碍核对**：用的是既有类名，
  可用性已随两家真机验收通过；但 `role="alert"` 只随错误出现这一点
  仍只有源码断言，未用读屏器实测。
- **codearts 旧流程（`secret` 回调）的手动提交未真机验证**：代码路径与
  `code` 共用同一个收码器，单测覆盖了 `kind:'secret'` 的解析与转交，
  但真机上未构造过一条 `secret` 型回调链接。
- **TRAE PKCE 新流程**：手动提交会明确报「暂不支持 PKCE」（与浏览器回调
  同口径），不是本 PR 引入的限制 —— 浏览器回调那条腿同样不支持。