/**
 * CodeArts 账号的**展示名**：从凭据里的 `refresh_token` 解出真实 IAM 用户名。
 *
 * ## 为什么需要它（真实缺陷）
 *
 * 面板上的 CodeArts 卡片只会显示 `codearts-xxxxxxxx`（池 id 的前 8 位十六进制），
 * 多个账号排在一起**无法区分谁是谁** —— 用户报障原话：「登录的帐号获取不到用户名，
 * 只显示一些 hash，区分不了帐号」。
 *
 * 根因不是「上游没下发名字」，而是**两处一起丢**：
 *
 * | 环节 | 事实 |
 * |---|---|
 * | 新式 IAM OAuth 的凭据组装（`oauth.ts` 的 `credentialFromTokenResponse`） | 只映射 `credentials.*` / `refresh_token` / PKCE / DPoP，**不含任何用户字段** |
 * | 登录后写昵称（`jet-hub-rpc.ts` 的 codearts 分支） | `credential.user_name ?? id` ⇒ 新式凭据没有 `user_name` ⇒ **恒回落池 id** |
 * | 静默续期（`service.ts` 的 `refreshCredential`） | 只原样保留**已存在**的 `domain_id`/`user_id`/`user_name` ⇒ 空的一直是空 |
 *
 * 而名字其实**一直在凭据里**：华为 STS 的 `refresh_token` 是 JWT，载荷带一个
 * **内嵌 base64 JSON** 字段 `user_profile`：
 *
 * ```jsonc
 * // refresh_token 的 payload（节选）
 * { "exp": 1796232810, "type": "refreshToken",
 *   "user_profile": "<base64 JSON>",
 *   "client_id": "codearts-agent", "cnf": { "jkt": "…" } }
 *
 * // 解出来的 user_profile
 * { "account_id": "01a19d50056f7354a3a13363256be613",
 *   "account_name": "alice",
 *   "principal_is_root_user": true,
 *   "principal_urn": "iam::01a19d50…:user:alice" }
 * ```
 *
 * ## 为什么走 JWT 而不是调接口（2026-11-12 实测排除）
 *
 * 名字**没有**任何可用的在线端点 —— 用真实未过期凭据逐个只读 GET：
 *
 * | 端点 | 结果 |
 * |---|---|
 * | `GET /snap-manager/v1/statistics/plugin` | 200，但报文键全集是 `metrics` / `model_metrics` / `start_date` / `end_date` / `package` / `show` / `is_teadmin` / `is_white_list` —— **零用户名字段** |
 * | `GET /snap-manager/v1/user/info`、`/user/profile` | 404 `APIG.0101`（API 未发布） |
 * | `GET /v1/user/info`、`opengw…/api/v1/user/info` | 404 `APIG.0101` |
 * | `GET /v1/model/builtin` | 200，只有模型目录 |
 * | IAM `v3.0/OS-USER/users` | **403**（临时 AK/SK + security_token 没有 IAM 读权限） |
 *
 * ⇒ 解 JWT 是唯一可行路径，而且**优于**任何网络方案：零请求、零额度、无地域/代理
 * 依赖、无失败面，也不会像 userinfo 那样在凭据过期时静默退化成默认名。
 *
 * ## 三条纪律
 *
 * 1. **绝不编造**：解不出就返回 `undefined`（调用方回落池 id，与改动前逐字节一致），
 *    绝不猜、绝不拿 `access_key_id` 之类的哈希当名字；
 * 2. **纯函数、零 IO**：不读盘、不发请求、不碰 `ctx` —— 这样它才能在 RPC 热路径
 *    （`account.list`）里逐账号调用，也才能被单测直接驱动；
 * 3. **不打印 token**：本模块**不产生任何日志**；调用方即便要记，也只许记「解不出」
 *    这个事实与账号 id，不得打印载荷片段。
 */

import type { CodeArtsCredential } from './types.js'

/** 从凭据里解出的账号身份。 */
export interface CodeArtsIdentity {
  /**
   * 展示用名字（IAM 用户名）。
   *
   * 子用户场景（`principal_urn` 末段与 `account_name` 不同）是
   * `<子用户名>@<账号名>`；root 账号（本机 9 个实测全是）就是裸用户名。
   *
   * **取不到时不设该键** —— 与 `undefined` 语义相同，调用方一律不得编造。
   */
  name?: string
  /**
   * IAM 账号 id（`user_profile.account_id`）。
   *
   * ⚠️ 这是本家**唯一**跨续期稳定的账号标识：`access_key_id` 是临时 AK、
   * 每次续期都会变（`src/backup.ts` 的 `IDENTITY_FIELDS` 拿它当判重键是另一件事，
   * 见那里的注释）。本模块**只解出来备用、不写任何地方**。
   */
  accountId?: string
}

/** 凭据里本模块用得到的字段（只读、可只传一部分）。 */
export type CodeArtsIdentitySource = Pick<CodeArtsCredential, 'refresh_token'> & {
  /** 旧 ticket 流程写入的用户名；新式 OAuth 凭据没有这个字段。 */
  user_name?: string
}

/**
 * 从 JWT 的 `user_profile` 字段读 `account_name` / `principal_urn` / `account_id`。
 *
 * ⚠️ **不解签名**：本函数只用于「显示名」这种展示用途，不作任何信任判断；
 * 载荷来自我们自己的凭据文件，与 `oauth.ts` 的 `readJwtTime` 同一取舍。
 *
 * ⚠️ **必须能吃两种 base64 字母表**：实测 9 个真实账号里 **6 个带 `=` 填充、
 * 3 个不带**（同一端点签发，形状不统一）。`Buffer.from(x, 'base64url')` 两种都吃，
 * 别自己写 `atob` + 手工补 `=` —— 补错了会静默解出乱码 JSON。
 */
function readUserProfile(refreshToken: string): Record<string, unknown> | undefined {
  const parts = refreshToken.split('.')
  // 真 JWT 恒 3 段。段数不符 = 不是 JWT（未来上游若换成不透明串）⇒ 当作「读不到」。
  if (parts.length !== 3) return undefined
  const payloadPart = parts[1]
  if (payloadPart === undefined || payloadPart.length === 0) return undefined
  let payload: unknown
  try {
    payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8'))
  } catch {
    return undefined
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined
  const raw = (payload as Record<string, unknown>).user_profile
  if (typeof raw !== 'string' || raw.length === 0) return undefined
  try {
    const profile = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))
    return typeof profile === 'object' && profile !== null && !Array.isArray(profile)
      ? profile as Record<string, unknown>
      : undefined
  } catch {
    return undefined
  }
}

/** 读一个非空字符串字段（去空白）；否则 `undefined`。 */
function readName(profile: Record<string, unknown>, key: string): string | undefined {
  const value = profile[key]
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/**
 * `principal_urn` 的末段（`iam::<accountId>:user:<name>`）。
 *
 * ⚠️ 用**最后一个** `:user:` 之后的部分，不用 `split(':')` 取末元素：用户名理论上
 * 可以含冒号之外的任意字符，而 `split(':').pop()` 在末段为空时会拿到空串（本函数
 * 会因此返回 `undefined`，方向正确），但用 `lastIndexOf` 表达意图更明确、也不会在
 * 用户名恰含 `:` 时错位。
 */
function readUrnUserName(profile: Record<string, unknown>): string | undefined {
  const urn = readName(profile, 'principal_urn')
  if (urn === undefined) return undefined
  const marker = ':user:'
  const at = urn.lastIndexOf(marker)
  if (at < 0) return undefined
  const name = urn.slice(at + marker.length).trim()
  return name.length > 0 ? name : undefined
}

/**
 * 解出账号身份（名字 + IAM 账号 id）。
 *
 * 取值顺序（**固定，任一步失败即回退，绝不编造**）：
 *
 * 1. `refresh_token` → `user_profile` → `principal_urn` 末段（**最具体**：子用户时
 *    这里是子用户名，而 `account_name` 是租户/账号名）；
 * 2. 退 `user_profile.account_name`；
 * 3. 两者都有且**不同** ⇒ `<urn 末段>@<account_name>`（子用户消歧）；
 *    相同（root）⇒ 裸名，**不加任何后缀**（本机 9 个真实账号全走这一格，观感不变）；
 * 4. 没有 `refresh_token` / 不是 JWT（老 ticket 凭据）⇒ 退凭据顶层 `user_name`；
 * 5. 全无 ⇒ 返回空对象（`name` 不设键）。
 *
 * @param credential 已解析的凭据（或其子集）。
 */
export function codeartsIdentity(credential: CodeArtsIdentitySource | undefined): CodeArtsIdentity {
  if (credential === undefined || credential === null) return {}
  const refreshToken = credential.refresh_token
  if (typeof refreshToken === 'string' && refreshToken.length > 0) {
    const profile = readUserProfile(refreshToken)
    if (profile !== undefined) {
      const accountName = readName(profile, 'account_name')
      const urnName = readUrnUserName(profile)
      const accountId = readName(profile, 'account_id')
      const name = urnName === undefined
        ? accountName
        : accountName === undefined || accountName === urnName
          ? urnName
          : `${urnName}@${accountName}`
      return {
        ...name === undefined ? {} : { name },
        ...accountId === undefined ? {} : { accountId },
      }
    }
  }
  // 旧 ticket 凭据（`src/login.ts` 的 `parseCredentialResponse` 会写这个字段）。
  const legacy = typeof credential.user_name === 'string' ? credential.user_name.trim() : ''
  return legacy.length > 0 ? { name: legacy } : {}
}

/**
 * 展示名的便捷出口（`codeartsIdentity().name`）。
 *
 * 单独导出是为了让调用点读起来就是「我要一个名字」，而不是
 * `codeartsIdentity(c).name`（后者容易被误写成 `?? c.user_name ?? id` 那种
 * 「解不出就编造」的链 —— 编造的正确落点是**调用方**回落池 id，不是本模块）。
 */
export function codeartsAccountName(
  credential: CodeArtsIdentitySource | undefined,
): string | undefined {
  return codeartsIdentity(credential).name
}
