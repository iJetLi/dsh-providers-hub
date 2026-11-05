/**
 * 智谱清言（chatglm.cn **网页端**）的登录辅助 —— **只保留纯函数常量与指纹**。
 *
 * ## ⚠️⚠️⚠️ 本模块**不再起浏览器**（2026-11-04 用户明确要求）
 *
 * 用户原话：「现在在服务器打开浏览器特别卡，根本就识别不到滑动块，还是要在
 * 本地电脑打开浏览器才可以，不然很难登录账号」。
 *
 * 这里点了**两个各自独立的缺陷**，第二个是硬的：
 * 1. **服务器上开浏览器极慢** —— 无 GPU，且智谱的**滑块验证码在无头环境里渲染不出来**
 *    （用户「根本识别不到滑动块」）；无 Xvfb 时进程压根起不来。
 * 2. 就算窗口真在服务器上开了，**用户也看不见**（部署在远端时那台机器的屏不属于用户）。
 *
 * ⇒ 旧实现（`ChatglmLoginSession`：`spawn` 浏览器 + `MiniCdp` + `Storage.getCookies`
 * 轮询 + 一次性 profile）**整个删除**。它当时解决了「窗口立刻被关」的缺陷
 * （游客态 `is_guest` 误判，见 `chatglm.ts` 的 `chatglmCredentialFromCookies`），
 * 但那个判据本身**保留下来**（现在是纯函数、在 `chatglm.ts` 里，仍被
 * `chatglm-browser-login.spec.ts` 覆盖）—— 只是不再由浏览器驱动来喂它。
 *
 * ## 现在的两条路（都不在宿主侧开窗）
 *
 * | `account.create` 的 mode | 宿主做什么 | 用户做什么 |
 * |---|---|---|
 * | `'browser'` | **只返回 `loginUrl`**（不建号、不起进程） | 客户端在**本地**浏览器 `window.open` 打开 `CHATGLM_BROWSER_LOGIN_URL` |
 * | `'paste'` | 归一 → **验上游** → 判重 → 建号 + 写有效期 | 登录完把 `chatglm_token`（或整条 cookie）粘进面板 |
 *
 * ⚠️ **没有 `login.poll`**：`mode: 'browser'` 不建占位账号（没有东西会来填它），
 * 客户端在 `accountId` 为空时**不**调 `startLoginPoll`。
 *
 * ## ⚠️⚠️ 与 CodeArts 的**本质差异**（别在后来的注释里写成「已等同」）
 *
 * CodeArts 的 `loginUrl` 是标准 OAuth 授权页 + **本地回调服务器**
 * （`startOAuthFlow` 起 loopback 端口，浏览器授权后 `302` 回 `127.0.0.1:<port>` 收 code）
 * ⇒ 用户授权完**自动**回来，零操作。
 *
 * **智谱清言网页端没有这条回调链路**：
 * - `chatglm_token` 是 `chatglm.cn` 域的 cookie，**宿主读不到**你本地那一份
 *   （部署在服务器时两机不同；即使同机，也只有浏览器进程能读自己的 cookie jar）；
 * - 上游没给我们注册过的 `redirect_uri`（`WeChatLoginTransit` 是它自己的中转页）。
 *
 * ⇒ 本地登录完**必须**手动粘回 token。这比「窗口开在服务器上、什么都点不到」好得多，
 * 但**不是**零操作体验。
 *
 * @module src/chatglm-login.ts
 */

import { createHash } from 'node:crypto'
import { CHATGLM_BASE_URL, type ChatglmCredential } from './chatglm.js'

/** 登录页（登录框在该页右上角；`chatglm.cn/login` 也可，但 `/` 更稳）。 */
export const CHATGLM_LOGIN_PAGE_URL = `${CHATGLM_BASE_URL}/main/alltoolsdetail`

/**
 * 交给客户端在**用户本地浏览器**里打开的 URL（即 `account.create` 的 `loginUrl`）。
 *
 * ## ⚠️⚠️ 为什么必须返回**非空** `loginUrl`（2026-11-04 用户报障）
 *
 * `account.create` 的返回值决定走哪条开窗路径：
 *
 * | provider | `loginUrl` | 谁开窗 | 窗口在哪 |
 * |---|---|---|---|
 * | CodeArts / OfficeAce / buddy… | **非空** | **客户端** `window.open` | **用户本地** |
 * | 本渠道（修复前） | **空串** | **宿主** `spawn` | **服务器** |
 *
 * 客户端拿到**空** `loginUrl` 会**整段跳过**开窗分支
 * （`if (!loginUrl) { await loadAccounts(); …; return }`）⇒ 唯一那个窗口是宿主
 * `spawn` 出来的，落在服务器上 —— 正是报障现场。
 *
 * ## ⚠️ 两个尾部参数都只是**可读标识**
 *
 * `?from=dsh-jet-hub` 让用户回头看地址栏能认出这窗口是插件开的；
 * **不承担**任何回调职责（上游会忽略它并停在登录页）。
 */
export const CHATGLM_BROWSER_LOGIN_URL = `${CHATGLM_LOGIN_PAGE_URL}?from=dsh-jet-hub`

/**
 * 凭据指纹（判重键）—— `chatglm_token` 的 SHA-256 前 16 hex。
 *
 * ⚠️ **不能直接拿 token 当指纹**：它是会话秘密，进日志 / `state.json` 就泄漏。
 * 哈希后既稳定又不可逆。与 `jet-hub-rpc.ts` 的 `doubaoSessionIdOf` 用法同型但
 * **刻意不同**：那边直接比 `sessionid` 是安全的（它是账号标识，不是秘密）。
 *
 * ⚠️ 本函数在 `mode: 'browser'`（不建号）与 `mode: 'paste'`（建号前判重）两条路上
 * **都必须**用同一份 —— 两份拷贝必然漂移（本仓库记过「一语义两套判据」事故）。
 */
export function chatglmTokenFingerprint(credential: ChatglmCredential | undefined): string | undefined {
  const token = credential?.chatglm_token
  if (typeof token !== 'string' || token.length === 0) return undefined
  return createHash('sha256').update(token, 'utf8').digest('hex').slice(0, 16)
}
