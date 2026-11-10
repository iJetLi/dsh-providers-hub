# feat(codearts): 新增「手动填写回调链接」登录（手机 / 另一台电脑完成授权）

> 分支：`feat/codearts-manual-callback`（基于 `master@1d12f80`）
> 提交：1 个 · 7 文件

## 一、为什么需要它

CodeArts（华为云）的 OAuth 回调被定向到**宿主本机**：

```
http://127.0.0.1:<port>/oauth/callback?code=…
```

`buildOAuthLoginUrl` 只把 `port` 下发给 portal，portal 据此构造回调地址
（**下发 `auth_callback_url` 反而会让 portal 回退旧流程**，见 `src/login.ts` 的注释）。

⇒ 只要用户不是在**运行宿主的这台机器**上完成授权，那一跳就必然失败：

| 场景 | 浏览器看到 | 结果 |
|---|---|---|
| 本机浏览器授权 | 自动跳回 `127.0.0.1:<port>` | ✅ 原有流程 |
| **手机 / 另一台电脑**授权 | 「无法访问此网站 / 127.0.0.1 拒绝了连接」 | ❌ 跳转失败，**但地址栏里已是一条合法的回调链接** |

失败页上那条 URL 里带着**一次性 `code`**（或旧流程的 `secret`），
故真正的缺口不是「拿不到凭据」，而是**没有任何入口把它交回宿主**。

## 二、修法（方案 A：只补一条回传通道，不改授权机制）

| # | 位置 | 改动 |
|---|---|---|
| 1 | `src/login.ts` | 抽出 `createOAuthCallbackReceiver`：本地回调服务器与手动提交**共用同一个收码器**（`settled` 幂等闸门）；`startOAuthCallbackServer` 额外返回 `receiver`；`startOAuthFlow` 向调用方暴露 `submitManualCallback`；新增纯函数 `parseManualCallbackUrl` + `MANUAL_CALLBACK_FAIL_PREFIX` |
| 2 | `src/service.ts` | `startLogin` 透传 `submitManualCallback`（**漏这一行 RPC 层会拿到 `undefined`**） |
| 3 | `src/jet-hub-rpc.ts` | 新增在途表 `pendingCodeArtsCallbacks`（占位 id → 提交入口）；codearts 分支登记并在 `finally` 清理；新增端点 `account.submitCallback` |
| 4 | `src/types.ts` | 新增 `RpcSubmitCallbackRequest` |
| 5 | `plugin-src/client/jet-hub.js` | codearts 登录中渲染回调链接输入框；行内错误；登录三出口与「取消」复位状态 |
| 6 | `tests/unit/codearts-manual-callback.spec.ts` | 新增 27 条守卫（解析矩阵 + 提交行为 + **HTTP 原路径回归**） |
| 7 | `tests/unit/jet-hub-structure-ast.spec.ts` | 面板级状态提示契约 6 → 7（见 §五） |

### 关键设计取舍

1. **端口一律取链接里那个**。`redirect_uri` 必须与授权时逐字一致
   （`exchangeAuthorizationCode` 把它原样提交给 STS），
   改成本机当前端口会被 `invalid_grant` 直接拒掉 —— 而错因在主流程里极难解释。
   ⇒ 解析器返回的 `port` 来自 URL 本身；裸 `?code=…`（无端口）**刻意拒绝**而不是猜。
2. **两条来路共用一个收码器**，不各写一份换取逻辑：`code` 一次性，
   各换一次必然「第二次烧掉第一次」。
3. **`acceptCode` 返回的 promise 永不 reject**，用布尔值表达成败。
   ⚠️ 手动提交那条腿**丢弃**这个 promise（只关心「有没有接管」），
   一个被丢弃的拒绝就是**未处理的 Promise 拒绝** —— 本轮实现时真的踩到过
   （`vitest` 报 `Unhandled Rejection: RefreshTokenExpiredError`），
   已改为「永不 reject、由 `result` 表达真实成败」。
4. **失败绝不让进程退出**：解析失败、端口越界、会话已结束都返回 `ok:false` + 中文原因，
   RPC 层原样下发；客户端只显示**行内**错误，**不**走 `setPhase('error')`
   —— 那条路径会让轮询停摆，而浏览器里那一跳可能还在进行。
5. **顺手修掉一处既有缺陷**：原实现在 HTTP 回调里**换取失败也 307 到
   `login_succeed=true`**（写死在 `writeHead` 之前），用户会看到「登录成功」
   而账号根本没建。现在按换取结果选目标页，并加了回归用例钉住两个方向。

## 三、用户体验

```
点击「+ 新建账号」→ 宿主拉起无痕窗口（换号）
  → 手机扫码 / 登录 → 浏览器停在「无法访问 127.0.0.1」
  → 复制地址栏整条链接 → 粘进面板「提交回调链接」→ 提交
  → login.poll 自动收口（成功 / 失败都走既有三态通道）
```

## 四、边界与不做什么

- **只服务 `provider === 'codearts'`**：其余 provider 的登录分支一个字节未改
  （`src/jet-hub-rpc.ts` 的 diff **零删除行**，纯增量）。
- **不改授权机制**：仍由宿主起本地回调服务器、仍走同一条 PKCE + DPoP 换取；
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
| 新增守卫 | `pnpm exec vitest run tests/unit/codearts-manual-callback.spec.ts` | ✅ 27/27 |
| 既有登录用例 | `vitest run tests/unit/login.spec.ts tests/unit/service.spec.ts tests/unit/plugin.spec.ts` | ✅ 85/85 |
| 结构契约 | `vitest run tests/unit/jet-hub-structure-ast.spec.ts` | ✅ 11/11 |
| 全量 | `pnpm exec vitest run` | 8 文件 / 15 用例失败 —— **与 `master@1d12f80` 基线逐条相同**（均为本机 Linux 上的 Windows 路径类用例），用例总数 12809 → 12836（**+27 = 本 PR 新增**） |

### 新用例覆盖什么

1. 解析矩阵 13 条坏输入（空 / 空白 / 引号 / 垃圾 / 非法 URL / portal 结果页 /
   非本机主机 / 路径不对 / 缺端口 / 端口越界 / 无 code / code 空白 / 非字符串）
   —— 每条都断言**有可照做的中文文案**且不含 `undefined`/`[object`；
2. 合法链接 → `{kind:'code', code, port}`，含尖括号 / 引号 / `localhost` /
   多余参数 / fragment / 旧流程 `secret`；
3. 裸 `?code=…` 与 `code=…` **必须拒绝**（不许猜端口）；
4. 手动提交 → 真实换取：`redirect_uri` 用的是**链接里的端口**、
   `code_verifier` 与 DPoP 头都在、凭据含 `access_key_id` + `refresh_token`；
5. 坏输入 / 端口越界 → `ok:false` 且**一次 STS 都不打**；
6. 落定后重复提交 → `ok:false`、不抛、**不再打第二次 STS**；
7. STS 拒绝 → `result` 拒绝（失败可见），提交当时仍 `ok:true`（失败延后到三态通道）；
8. **HTTP 原路径回归**：真发一跳 `/oauth/callback` ⇒ 307 `login_succeed=true` 且凭据落定；
   换取失败 ⇒ 307 `login_succeed=false`（不得谎报成功）。

## 七、未验证 / 已知边界（如实登记）

- **未做真实华为账号的端到端验收**：本轮用**假 STS**（注入 `fetcher`）验证
  「手动链接 → 换 token → 凭据形状」链路，真实 portal 的 `code` 行为未复测
  （需要真实账号与手机，属本环境不可达）。
- **未改 e2e**：`tests/e2e/login.e2e.spec.ts` 仍走浏览器回调那条腿；
  手动提交的真实浏览器行为（复制地址栏 → 粘贴）无法自动化，故只做单测。
- 客户端输入框是**新 UI**，未在真机上做视觉 / 无障碍核对（用既有类名，
  但 `role="alert"` 只随错误出现这一点仅由源码断言覆盖）。