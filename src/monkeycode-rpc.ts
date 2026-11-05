/**
 * @module src/monkeycode-rpc.ts
 */

import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'

import { MONKEYCODE, type MonkeycodeProduct } from './monkeycode-product.js'
import { parseMonkeycodeCredential } from './monkeycode-auth.js'
import type { MonkeycodeCredential } from './monkeycode.js'

/**
 * 账号池的最小接口（只声明本文件用到的成员）。
 *
 * ⚠️ 不用 `AccountPool` 的具体类型：Jet Hub 的 RPC 层把池参数透传成 `never`
 * （见 `jet-hub-rpc.ts` 的 `pool as never`），用具体类型会逼调用方做无意义的
 * 类型断言。结构化声明也让单测可以传一个纯 stub。
 */
export interface MonkeycodePoolLike {
  listAccountsByProvider(provider: string): Array<{
    id: string
    enabled: boolean
    credentialRef: string
    nickname?: string
  }>
  addAccount(entry: {
    id: string
    provider: string
    nickname?: string
    enabled: boolean
    credentialRef: string
    refreshable: boolean
    createdAt: number
  }): Promise<void>
  removeAccount(accountId: string): Promise<void>
}

/**
 * Key 的形状判据。
 *
 * ⚠️ **刻意不绑死 `sk-` / `oma_` 前缀**：上游将来可能加新前缀，绑死会让新
 * Key 直接被判「形状不对」且用户完全无从判断（opencode 的 IKPLRU 教训）。
 * 这里只要求「足够长、无空白、是可见字符」。
 */
const KEY_PATTERN = /^[A-Za-z0-9_.\-/+=]{16,}$/

/** 签名密钥的形状（48 位，但这里只做长度与字符集的下限校验）。 */
const SECRET_PATTERN = /^[A-Za-z0-9_.\-/+=]{8,}$/

/** RPC 返回：失败。 */
function fail(message: string): { ok: false; error: { code: 'bad-request'; message: string } } {
  return { ok: false, error: { code: 'bad-request', message } }
}

/** RPC 返回：成功。 */
function done<T>(value: T): { ok: true; value: T } {
  return { ok: true, value }
}

/**
 * 由 API Key 派生**账号 id** 与**凭据 ref 名**。
 *
 * ⚠️ ref 名必须是合法 C 标识符（`credentialRef()` 只认
 * `/^[A-Za-z_][A-Za-z0-9_]*$/`，否则抛 TypeError）。而 Key 的尾巴常含
 * `-` / `.`，故先取大写、再把非法字符剔掉；剔完若可能碰撞（不同 Key 剥出
 * 同一个名字），追加 Key 的 sha256 前 8 位。
 *
 * ⚠️ 用**尾巴**而不是开头：`oma_` 开头的那几位对所有 Key 都一样，
 * 用它派生会让所有账号撞到同一个 id。
 *
 * ⚠️ ⚠️ **ref 前缀必须带上产品 id**（`MONKEYCODE_ACCOUNT_*` /
 * `MONKEYCODEINTL_ACCOUNT_*`）：两站是**独立账号池**，同一把 Key 在两个站
 * 没有任何关系，共用前缀会让 `jet-hub-store.ts` 的 `ACCOUNT_REF_RE` 在
 * `state.json` 缺失时把国际站账号认成国内站（静默串号）。
 * 同理**账号 id 前缀也要带产品 id**，否则两个池里的同名尾巴会互相顶掉。
 */
export function monkeycodeSlotNamesOf(
  apiKey: string,
  product: MonkeycodeProduct = MONKEYCODE,
): { id: string; refName: string } {
  const tail = apiKey.slice(-8)
  const upper = tail.toUpperCase()
  const providerPrefix = product.id.toUpperCase()
  const refName = /^[A-Z0-9_]+$/.test(upper)
    ? `${providerPrefix}_ACCOUNT_${upper}`
    : `${providerPrefix}_ACCOUNT_${upper.replace(/[^A-Z0-9_]/g, '')}_${
      createHash('sha256').update(apiKey).digest('hex').slice(0, 8).toUpperCase()
    }`
  return { id: `${product.id}-${tail.toLowerCase()}`, refName }
}

/** 从 payload 里取可选的字符串字段（去首尾空白；非字符串视为缺失）。 */
function optionalString(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key]
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

/**
 * 组装要落盘的凭据。
 *
 * ⚠️ 这里**不再写 `channel`**：两站拆成独立 provider 后，「哪条通道」由
 * provider 决定（`monkeycode` / `monkeycodeintl`），凭据里只留数据本身。
 * 存量凭据可能还带着旧的 `channel` 字段，`parseMonkeycodeCredential`
 * 会忽略它（多余字段不进类型）。
 */
function buildCredential(
  apiKey: string,
  signingSecret: string | undefined,
  nickname: string | undefined,
  sessionCookie: string | undefined,
): MonkeycodeCredential {
  return {
    access_token: apiKey,
    ...signingSecret === undefined ? {} : { signing_secret: signingSecret },
    ...nickname === undefined ? {} : { nickname },
    ...sessionCookie === undefined ? {} : { session_cookie: sessionCookie },
  }
}

/**
 * 处理一个 MonkeyCode 站点的 RPC（`monkeycode.*` / `monkeycodeintl.*`）。
 *
 * @param product 目标站点（缺省国内站）。
 * @returns `undefined` 表示「不是我认识的方法」——**必须**返回 `undefined`
 *   而不是抛错或返回失败对象，否则 `jet-hub-rpc.ts` 的主 switch 会被短路，
 *   其余方法全部变成 `unknown method`。
 */
export async function handleMonkeycodeRpc(
  ctx: Context,
  pool: MonkeycodePoolLike,
  method: string,
  payload: unknown,
  product: MonkeycodeProduct = MONKEYCODE,
): Promise<unknown> {
  try {
    const body = (typeof payload === 'object' && payload !== null ? payload : {}) as Record<string, unknown>
    // 两站共用同一套动作名，只在方法前缀上区分。
    const prefix = `${product.id}.`
    const action = method.startsWith(prefix) ? method.slice(prefix.length) : method

    switch (action) {
      case 'addAccount': {
        const apiKey = optionalString(body, 'apiKey')
        const signingSecret = optionalString(body, 'signingSecret')
        const nickname = optionalString(body, 'nickname')
        const sessionCookie = optionalString(body, 'sessionCookie')
        if (apiKey === undefined) return fail('缺少 API Key：请粘贴 oma_ 开头的 Key。')
        if (!KEY_PATTERN.test(apiKey)) {
          return fail('API Key 形状不对：应为至少 16 位的可见字符，且不含空格。')
        }
        if (signingSecret !== undefined && !SECRET_PATTERN.test(signingSecret)) {
          return fail('签名密钥（signing_secret）形状不对：应为至少 8 位的可见字符。')
        }
        let { id, refName } = monkeycodeSlotNamesOf(apiKey, product)
        const collide = pool.listAccountsByProvider(product.id).find((entry) => entry.id === id)
        if (collide !== undefined) {
          /**
           * ⚠⚠ 2026-11-02 三审 F🟢-4：幂等分支必须**先确认是同一把 Key**。
           *
           * `id` 是用 Key **尾 8 位**派生的（`monkeycodeSlotNamesOf`）；两把
           * 不同的 Key 尾 8 位恰好相同时会撞到同一个 id。原写法
           * 不看凭据就 `return done({ existed: true })` ⇒ 用户看到「已添加」，
           * 而实际上**新 Key 被丢弃、卡上还是别人的凭据**（静默失效）。
           */
          const resolvedCollide = await ctx.credentials
            .resolve(credentialRef(collide.credentialRef))
            .catch(() => undefined)
          const collideToken = resolvedCollide === undefined
            ? undefined
            : parseMonkeycodeCredential(resolvedCollide.value)?.access_token
          if (collideToken === apiKey) {
            // ⚠️ 幂等：重复粘贴同一个 Key 不该报错（用户分不清「已存在」与「失败」）。
            return done({ accountId: id, existed: true })
          }
          // 尾 8 位碰撞：换一个**带 Key 全量 sha256 后 8 位**的 id / ref，
          // 绝不去动已有那张卡（它的凭据也不能被覆盖）。
          const disambiguator = createHash('sha256').update(apiKey).digest('hex').slice(0, 8)
          id = `${id}-${disambiguator}`
          refName = `${refName}_${disambiguator.toUpperCase()}`
        }
        /**
         * ⚠️⚠️ **2026-11-02 四审 G-2：消歧后的 id 也必须复查占用**。
         *
         * 上面只查了**基础** id；消歧之后 id 变成 `<base>-<hash8>`，
         * 而 `account-pool.addAccount` 是**纯追加、不查重**（`src/account-pool.ts` 的
         * `addAccount`）。触发序列：`add(KEY_1)` → `add(KEY_2)`（同尾、生成消歧 id）
         * → **再** `add(KEY_2)` → 第二次也会算出同一个消歧 id。
         * 而 `removeAccount` 会先 `credentials.unset(entry.credentialRef)` → 两条同 id
         * 账号共用同一个 ref，删掉其中一条会让另一张卡变成
         * 「凭据不可读」。⇒ 建条目前必须再查一次，命中就幂等返回。
         */
        if (pool.listAccountsByProvider(product.id).some((entry) => entry.id === id)) {
          return done({ accountId: id, existed: true })
        }

        const credential = buildCredential(apiKey, signingSecret, nickname, sessionCookie)
        // ⚠️ **必须 await**：`ctx.credentials.set` 返回 `Promise<void>`（全仓
        //    23 处调用都 await）。漏掉时写盘失败会变成 unhandled rejection，
        //    而 `pool.addAccount` 照样成功 ⇒ 留下一个「条目在、凭据不在」的
        //    幽灵账号，用户看到的是「余额未配置」且永远自愈不了。
        await ctx.credentials.set(credentialRef(refName), JSON.stringify(credential))
        await pool.addAccount({
          id,
          provider: product.id,
          ...nickname === undefined ? {} : { nickname },
          enabled: true,
          credentialRef: refName,
          // ⚠️ 静态 Key 没有续期端点，如实标记 false（与落盘凭据一致）。
          refreshable: false,
          createdAt: Date.now(),
        })
        return done({ accountId: id, existed: false })
      }

      case 'setApiKey': {
        const accountId = optionalString(body, 'accountId')
        const apiKey = optionalString(body, 'apiKey')
        const signingSecret = optionalString(body, 'signingSecret')
        const sessionCookie = optionalString(body, 'sessionCookie')
        if (accountId === undefined) return fail('缺少 accountId。')
        if (apiKey === undefined) return fail('缺少 API Key。')
        if (!KEY_PATTERN.test(apiKey)) return fail('API Key 形状不对。')
        const existing = pool.listAccountsByProvider(product.id)
          .find((entry) => entry.id === accountId)
        if (existing === undefined) return fail(`账号 ${accountId} 不存在。`)

        const { id: newId, refName } = monkeycodeSlotNamesOf(apiKey, product)
        /**
         * ⚠️⚠️ **只覆盖本次显式给出的字段**（2026-11-02 审查发现）：
         * 原先直接 `buildCredential(apiKey, signingSecret, nickname, sessionCookie)`，
         * 后两个字段只取**本次入参** ⇒ 用户只改 Key 时会把旧的 `signing_secret`
         * 一起擦掉，而缺 `signing_secret` 的账号**每一次推理**都会在适配器里
         * 提前抛「这个账号缺少 signing_secret」，RPC 却回了成功。
         * ⇒ 先读旧凭据再合并（与 `baizhi.startSession` 的合并写法同款）。
         */
        /**
         * ⚠⚠ **「读不到」与「还没有凭据」不是一回事（六审 A🟡-4）。**
         *
         * 原写法 `resolve(...).catch(() => undefined)` 把 I/O 错误 / 坏 JSON 与「占位卡还没有凭据」
         * 归成同一个 `undefined` ⇒ 凭据损坏时点「改 Key」会静默丢掉 `user_id` /
         * `session_cookie`（建号判重与积分从此失效），而 RPC 还回成功。
         * ⇒ 抛错就硬失败（零写入），与同文件 `setSession` 的口径一致；
         *   而「解析不到」（浏览器登录建的占位卡）仍然允许 previous 为空。
         */
        let resolvedPrevious
        try {
          resolvedPrevious = await ctx.credentials.resolve(credentialRef(existing.credentialRef))
        } catch (caught) {
          const message = caught instanceof Error ? caught.message : String(caught)
          return fail(`读取该账号的凭据失败（${message}）；为避免覆盖，本次未做任何修改。`)
        }
        const previous = resolvedPrevious === undefined
          ? undefined
          : parseMonkeycodeCredential(resolvedPrevious.value)
        /**
         * ⚠️⚠️ **先铺一层旧凭据，再叠可编辑字段**（2026-11-02 五审 J🟡-3 收口）。
         *
         * 原写法是「按字段重建」：只列出 `buildCredential` 的四个可编辑字段，
         * 再手工补一个 `user_id`。后果是 `MonkeycodeCredential` 里**每多一个字段
         * 就要在这里补一行**，漏一个就静默写丢 —— `user_id` 曾经这么丢过一次
         * （判重失效、同一账号多出一张卡），`expires_at` 则一直丢着（探针打印
         * `expires_at = undefined`，只因今天没人写它才没有用户可见后果）。
         *
         * 现在统一成同文件 `case 'setSession'` 的口径：`{ ...previous }` 全量复制，
         * 再由 `buildCredential` 覆盖四个可编辑字段。语义等价、且以后加字段不必回头补。
         *
         * `user_id` 为什么必须活下来：它是**浏览器登录时平台下发的稳定账号身份**，
         * 也是「同一账号重复登录」判重的唯一依据（见 `src/jet-hub-rpc.ts` 的
         * `account.create` 判重块）。丢掉它 ⇒ 同一账号再登录一次就多出一张卡。
         */
        const credential: MonkeycodeCredential = {
          ...previous,
          ...buildCredential(
            apiKey,
            signingSecret ?? previous?.signing_secret,
            existing.nickname,
            sessionCookie ?? previous?.session_cookie,
          ),
        }
        /**
         * ⚠️⚠️ **2026-11-02 四审 G-1：同一把 Key ⇒ 只合并凭据、不迁移 id**。
         *
         * 消歧卡的 id **不由 Key 唯一决定**（`addAccount` 给碰撞 Key 加了
         * `-<sha256 前 8 位>`），而 `monkeycodeSlotNamesOf` 永远算不出那个后缀
         * ⇒ 对这张卡填**它自己的** Key 时，`newId` 是基础 id、不等于
         * `accountId`，于是掉进下面的占用检查，报「该 API Key 已对应另一个账号
         * （基础 id）」并把用户指向**别的卡**，这张卡的
         * `signing_secret` / `session_cookie` 从此永远改不了（只能删卡重建，
         * 而删卡会 unset 共用 ref）。
         *
         * → 同一把 Key 就只刷新凭据内容，不碰账号条目。
         * ⚠️ 写入目标必须是 `existing.credentialRef`：消歧卡的 ref 带
         * `_HASH8`，而按 Key 重算出的 `refName` 指向的是**另一张卡**的凭据。
         */
        if (previous?.access_token === apiKey) {
          await ctx.credentials.set(credentialRef(existing.credentialRef), JSON.stringify(credential))
          return done({ accountId, renamed: false })
        }
        if (newId === accountId) {
          /**
           * ⚠⚠ **六审 A🔴-1（2026-11-02）：写入目标必须是 `existing.credentialRef`。**
           *
           * 这个分支的真实前提不是「同一把 Key」（那种情况已在上一个
           * `previous?.access_token === apiKey` 早退里返回了），而是「**Key 变了但 id 没变**」
           * —— 尾 8 位相同、全串不同，且尾 8 位含 `-` / `.` 等非法字符时，
           * `id` 只由尾 8 位决定（相同），而 `refName` 的哈希后缀由**整把 Key** 的
           * sha256 前 8 位决定（不同）⇒ 按 `refName` 写会落到一个**没人引用的孤儿 ref**，
           * 卡片仍持旧 Key，而 RPC 返回 `ok:true, renamed:false` —— 零日志的静默无效。
           */
          await ctx.credentials.set(credentialRef(existing.credentialRef), JSON.stringify(credential))
          return done({ accountId, renamed: false })
        }
        /**
         * ⚠️ **新 id 已被别的账号占用**时必须拒绝（2026-11-02 审查发现）：
         * `account-pool.addAccount` 是纯追加、**不查重** ⇒ 直接建会出现两条
         * 同 id 条目（卡片上两个一模一样的账号，删除其中一个会连带删掉共用凭据）。
         */
        if (pool.listAccountsByProvider(product.id).some((entry) => entry.id === newId)) {
          /**
           * ⚠️⚠️ **拒绝路径绝不能先写凭据**（2026-11-02 复审发现）：
           * `refName` 由 `monkeycodeSlotNamesOf(apiKey)` 派生 ⇒ 被拒绝时它正是
           * **那个已存在账号**的 ref。原先在占用检查之前就 `credentials.set(refName, …)`，
           * 于是这条拒绝路径已经把别人的 `access_token` 换成新 Key、把
           * `signing_secret` 换成**当前账号的**旧值 ⇒ 此后那个账号每次推理都 403，
           * 而用户只看到「请直接编辑那个账号」。
           * ⇒ 写入只在占用检查**通过之后**发生。
           */
          return fail(`该 API Key 已对应另一个账号（${newId}），请直接编辑那个账号，避免同一 Key 出现两次。`)
        }
        await ctx.credentials.set(credentialRef(refName), JSON.stringify(credential))
        // ⚠️ **先建后删**：先删旧条目再建新的，中途失败会留下一个「账号消失、
        // 凭据还在」的状态，用户得手工清理。反过来最坏只是多一个待删条目。
        await pool.addAccount({
          id: newId,
          provider: product.id,
          ...existing.nickname === undefined ? {} : { nickname: existing.nickname },
          // ⚠️ **继承停用状态**（2026-11-02 审查发现）：原先硬编码 `true`
          //    ⇒ 用户特意停用的账号，改一次 Key 就被悄悄启用。
          enabled: existing.enabled,
          credentialRef: refName,
          refreshable: false,
          createdAt: Date.now(),
        })
        await pool.removeAccount(accountId)
        return done({ accountId: newId, renamed: true })
      }

      case 'setSession': {
        /**
         * 写入平台会话 cookie（额度 / 积分 / 签到要用，推理不需要）。
         *
         * ⚠️ 只改凭据、不碰账号条目：cookie 与推理通道完全解耦，
         * 没它推理照常可用（见 `MonkeycodeCredential.session_cookie` 的注释）。
         */
        const accountId = optionalString(body, 'accountId')
        if (accountId === undefined) return fail('缺少 accountId。')
        // ⚠️ 2026-11-02 三审 F🟢-2：这里**不能用 `optionalString`**。
        //    `optionalString`（见本文件 `:94-99`）把「字段缺失」与「空串」
        //    **都归一成 `undefined`**，而这两种情形在这里语义相反：
        //    - 字段缺失 = 「本次只读不写」⇒ **不能**碰旧 cookie；
        //    - 传空串   = 「清除会话」（面板上的清空按钮走这条路）⇒ `delete`。
        //    混在一起会让「传个只带 accountId 的 body」也把 cookie 抹掉。
        const rawCookie = (body as Record<string, unknown> | undefined)?.['sessionCookie']
        const hasCookieField = typeof rawCookie === 'string'
        const sessionCookie = hasCookieField ? (rawCookie as string).trim() : undefined
        const entry = pool.listAccountsByProvider(product.id)
          .find((candidate) => candidate.id === accountId)
        if (entry === undefined) return fail(`账号 ${accountId} 不存在。`)
        const resolved = await ctx.credentials.resolve(credentialRef(entry.credentialRef)).catch(() => undefined)
        const credential = resolved === undefined ? undefined : parseMonkeycodeCredential(resolved.value)
        if (credential === undefined) return fail('该账号的凭据不可读：请用「浏览器登录」重新添加，或在卡片上点「改 Key」重新粘贴 API Key。')
        const existingCookie = typeof credential.session_cookie === 'string' ? credential.session_cookie : ''
        if (!hasCookieField) {
          // 没带这个字段 ⇒ 完全不写盘，只回报现状。
          return done({ accountId, hasSession: existingCookie !== '' })
        }
        const next: MonkeycodeCredential = { ...credential }
        if (sessionCookie === undefined || sessionCookie === '') delete next.session_cookie
        else next.session_cookie = sessionCookie
        await ctx.credentials.set(credentialRef(entry.credentialRef), JSON.stringify(next))
        return done({ accountId, hasSession: sessionCookie !== undefined && sessionCookie !== '' })
      }

      default:
        return undefined
    }
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error))
  }
}
