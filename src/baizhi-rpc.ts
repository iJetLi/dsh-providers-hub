/**
 * baizhi（百智云）专用 RPC 的**方法处理函数**（不是自注册端点）。
 *
 * ## 为什么要有自己的方法（而不是复用 account.create）
 *
 * 百智云的凭据是一把**长期静态 API Key**（`sk-…`，67 位）。
 *
 * ⚠️ 2026-11-02 三审 F🟡-9：本处原写「用户**手工粘贴**的 API Key」——那只是备用路径。
 * 主路径是浏览器登录（`account.create { mode:'browser' }` → `baizhi.startSession`）
 * 与「大模型商店」：登录了 `baizhi.cloud` 后去
 * `https://ai-models.app.baizhi.cloud/console/api-keys` 生成 `sk-`。
 * 两条路最后都落到**同一份凭据结构** ⇒ 本文件只负责写入与判重。
 *
 * 本仓库已有先例（opencode → modelscope → qiniu → monkeycode），本文件
 * 照 `src/qiniu-rpc.ts` 同款形态实现：只导出 {@link handleBaizhiRpc}，
 * 由 `jet-hub-rpc.ts` 的 `handleMethod` 在 `default` **之前**调用
 * （对不认识的方法返回 `undefined`，让主 switch 继续匹配）。
 *
 * ## 与 qiniu 的差异（都来自协议事实，不是风格）
 *
 * | | qiniu | baizhi |
 * |---|---|---|
 * | 凭据字段 | `access_token` | `access_token`（同，AccountPool 身份反查要求） |
 * | Key 形状 | 无固定前缀 | 实测 `sk-` + 64 位，但**闸门仍不绑死前缀**（理由同 qiniu） |
 * | 账号去重 | 按尾 8 位派生 id | 同左 |
 * | 额度/签到 | 有（七牛有积分接口） | **没有** —— 按量计费，无每日额度/签到 |
 *
 * @module src/baizhi-rpc.ts
 */

import { createHash } from 'node:crypto'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { Context } from '@deepseek-ai/cordis'
import type { ProviderAccountEntry } from './types.js'
import { BAIZHI } from './baizhi-product.js'
import { parseBaizhiCredential } from './baizhi-auth.js'
import { maskBaizhiKey } from './baizhi.js'

/** `baizhi.addAccount` 的入参。 */
export interface RpcBaizhiAddAccountRequest {
  apiKey: string
  nickname?: string
}

/** `baizhi.addAccount` 的出参。 */
export interface RpcBaizhiAddAccountResponse {
  accountId: string
  /** true = 该 Key 之前已添加过，本次只是复用。 */
  existed: boolean
}

/** `baizhi.setApiKey` 的入参。 */
export interface RpcBaizhiSetApiKeyRequest {
  accountId: string
  apiKey: string
}

/** `baizhi.setApiKey` 的出参。 */
export interface RpcBaizhiSetApiKeyResponse {
  accountId: string
  /** 打码后的新 Key（`前4…尾4`）—— **刻意不回传明文**，理由见方法实现。 */
  masked: string
  /**
   * true = Key 变了 ⇒ 账号 id 也随尾段变了，账号被**重建**在新的 id 下。
   * ⚠️ 客户端据此必须**关闭并重开**面板（旧的 id 已不存在）。
   */
  renamed: boolean
}

/** 账号池的最小依赖面（结构化类型，避免绑定具体类）。 */
export interface BaizhiPoolLike {
  listAccountsByProvider(provider: string): Array<{ id: string; enabled: boolean; credentialRef: string; nickname?: string }>
  // ⚠️ 入参用 `ProviderAccountEntry`（而不是 `Record<string, unknown>`）：
  // 后者与 `AccountPool.addAccount(entry: ProviderAccountEntry)` **不可赋值**
  // （参数逆变，tsc 直接报 TS2345），接线处就得写断言或 any。
  addAccount(entry: ProviderAccountEntry): Promise<void>
  /** 改 Key 时要移除**旧**账号（id 随尾段变）—— 见 {@link RpcBaizhiSetApiKeyResponse.renamed}。 */
  removeAccount(accountId: string): Promise<void>
}

/**
 * Key 形状：至少 16 位 `[A-Za-z0-9_.-]`，**不绑死前缀**。
 *
 * ⚠️ 这只是**形状**校验（挡手滑/占位符），**不是**有效性验证：
 * 真 Key 仍要等第一次真实请求才知道。
 *
 * 实测白泽 Key 形如 `sk-` + 64 位十六进制，但**刻意不写死 `^sk-`** ——
 * 本仓库 opencode 的 Issue IKPLRU 实测过绑死前缀的代价（上游换发
 * `oc_sk_…` 后旧闸门把新 Key 全数拒收，用户一个账号都加不进来，且完全
 * 无法自救）。
 */
const KEY_PATTERN = /^[A-Za-z0-9_.-]{16,}$/

/**
 * 账号 id / credentialRef 由 Key 尾段派生，使重复 Key 落到同一账号。
 *
 * ⚠️⚠️ **ref 名必须是合法标识符**：宿主的 `credentialRef()` 只认
 * `/^[A-Za-z_][A-Za-z0-9_]*$/`（见 `node_modules/@deepseek-ai/dsh-credentials`
 * 的 `REF_PATTERN`），而本家的 Key 形状闸放行 `[A-Za-z0-9_.-]`（**刻意不绑死
 * 前缀**，见 `KEY_PATTERN`）⇒ 末 8 位含 `.`/`-` 的 Key 会拼出非法 ref 并
 * **抛 TypeError**，用户只会看到一句英文正则。
 *
 * 修法照抄 `src/qiniu-rpc.ts:107-131`：
 * - **尾段本来就合法** ⇒ 逐字节不变（保护存量凭据引用）；
 * - **尾段不合法** ⇒ 剥掉非标识符字符 + 追加 key 的 sha256 前 8 位，
 *   使 `…bb-ccdd` 与 `…bb_ccdd` 不会撞成同一个 ref。
 */
export function baizhiSlotNamesOf(apiKey: string): { id: string; refName: string } {
  const tail = apiKey.slice(-8)
  const upper = tail.toUpperCase()
  // ⚠️ 前缀必须是 `BAIZHI` —— `jet-hub-store.ts` 的
  // `REF_PREFIX_TO_PROVIDER` 按它反推 provider，漏登记会让
  // `BAIZHI_ACCOUNT_*` 的账号在 `state.json` 缺失时**静默消失**。
  const refName = /^[A-Z0-9_]*$/.test(upper)
    ? `BAIZHI_ACCOUNT_${upper}`
    : `BAIZHI_ACCOUNT_${upper.replace(/[^A-Z0-9_]/g, '')}_${createHash('sha256').update(apiKey).digest('hex').slice(0, 8).toUpperCase()}`
  return { id: `${BAIZHI.id}-${tail.toLowerCase()}`, refName }
}

/** 默认昵称：取 Key 尾 6 位，避免一屏账号全叫「百智云」。 */
function defaultNickname(apiKey: string): string {
  return `百智云 ${apiKey.slice(-6)}`
}

/**
 * 处理一个 baizhi RPC 方法。
 *
 * @returns `{ok:true, value}` / `{ok:false, error}`；**方法不认识时返回
 *          `undefined`**，让主 switch 继续往下走（它自己的 `default`
 *          分支仍能给出 `unknown method`，语义归属清晰）。
 *
 * ⚠️ 不认识时**必须**返回 `undefined` 而不是 `{ok:false}`：主 switch 会在
 * `default` 之前调用本函数，若本函数对未知方法也回信封，别的 provider 的
 * 方法名就会被误判成「格式错误」而不是「没这个方法」。
 */
export async function handleBaizhiRpc(
  ctx: Context,
  pool: BaizhiPoolLike,
  method: string,
  payload: unknown,
): Promise<unknown> {
  const fail = (message: string) => ({ ok: false as const, error: { code: 'bad-request', message } })
  const done = <T>(value: T) => ({ ok: true as const, value })
  try {
    switch (method) {
      case 'baizhi.addAccount': {
        const req = (payload ?? {}) as RpcBaizhiAddAccountRequest
        const apiKey = typeof req.apiKey === 'string' ? req.apiKey.trim() : ''
        if (!KEY_PATTERN.test(apiKey)) {
          return fail(
            'API Key 形状不对（至少 16 位字母数字；'
            + '请到 https://ai-models.app.baizhi.cloud/console/keys 新建一把 `sk-` 开头的密钥'
            + '（注意：baizhi.cloud 控制台发出的 `bzy_` 密钥打不通模型网关）',
          )
        }
        let { id, refName } = baizhiSlotNamesOf(apiKey)
        /**
         * ⚠️⚠️ **2026-11-02 四审 G-4：这里原先只比 id、不比凭据**。
         *
         * `id` 由 Key **尾 8 位**派生（`baizhiSlotNamesOf`）；两把不同的 Key
         * 尾 8 位恰好相同时会撞到同一个 id。原写法直接
         * `return done({ existed: true })` ⇒ 用户看到「已添加」，实际新 Key
         * **被静默丢弃、卡上还是旧 Key**，此后每次推理 401 而 UI 说「已存在」。
         * monkeycode 侧三审已修（见 `src/monkeycode-rpc.ts` 的 `addAccount`），
         * 这一家当时漏掉了 —— 且 `handleBaizhiRpc` 全仓**零测试**，所以它一直绿着。
         */
        const collide = pool.listAccountsByProvider(BAIZHI.id).find((a) => a.id === id)
        if (collide !== undefined) {
          const resolvedCollide = await ctx.credentials
            .resolve(credentialRef(collide.credentialRef))
            .catch(() => undefined)
          const collideToken = resolvedCollide === undefined
            ? undefined
            : parseBaizhiCredential(resolvedCollide.value)?.access_token
          // ⚠️ 幂等：重复粘贴同一把 Key 不该报错（用户分不清「已存在」与「失败」）。
          if (collideToken === apiKey) {
            return done({ accountId: id, existed: true } satisfies RpcBaizhiAddAccountResponse)
          }
          // 尾 8 位碰撞：换一个带 Key 全量 sha256 前缀的 id / ref，
          // 绝不去动已有那张卡（它的凭据也不能被覆盖）。
          const disambiguator = createHash('sha256').update(apiKey).digest('hex').slice(0, 8)
          id = `${id}-${disambiguator}`
          refName = `${refName}_${disambiguator.toUpperCase()}`
        }
        // ⚠️ 2026-11-02 四审 G-2 同型防御：消歧后的 id 也复查一次占用
        //    （`addAccount` 是纯追加、不查重；两条同 id 账号共用同一个 ref，
        //    删掉一条会让另一条变成「凭据不可读」）。
        if (pool.listAccountsByProvider(BAIZHI.id).some((a) => a.id === id)) {
          return done({ accountId: id, existed: true } satisfies RpcBaizhiAddAccountResponse)
        }
        const nickname = typeof req.nickname === 'string' && req.nickname.trim().length > 0
          ? req.nickname.trim()
          : defaultNickname(apiKey)
        await ctx.credentials.set(credentialRef(refName), JSON.stringify({
          // ⚠️ 字段名必须是 `access_token`（AccountPool 身份反查用，见 baizhi.ts）。
          access_token: apiKey,
          nickname,
        }))
        await pool.addAccount({
          id,
          provider: BAIZHI.id,
          nickname,
          enabled: true,
          credentialRef: refName,
          // ⚠️ 百智云**没有 refresh 端点**（API Key 是静态材料，默认长期有效），
          // 标 true 会让 UI 显示「可自动续期」——一个永远不会发生的承诺。
          refreshable: false,
          createdAt: Date.now(),
        })
        return done({ accountId: id, existed: false } satisfies RpcBaizhiAddAccountResponse)
      }

      case 'baizhi.setApiKey': {
        const req = (payload ?? {}) as RpcBaizhiSetApiKeyRequest
        if (typeof req.accountId !== 'string' || req.accountId.length === 0) {
          return fail('缺少 accountId')
        }
        const apiKey = typeof req.apiKey === 'string' ? req.apiKey.trim() : ''
        if (!KEY_PATTERN.test(apiKey)) {
          return fail(
            'API Key 形状不对（至少 16 位字母数字；'
            + '请到 https://ai-models.app.baizhi.cloud/console/keys 新建一把 `sk-` 开头的密钥'
            + '（注意：baizhi.cloud 控制台发出的 `bzy_` 密钥打不通模型网关）',
          )
        }
        const old = pool.listAccountsByProvider(BAIZHI.id).find((a) => a.id === req.accountId)
        if (!old) return fail(`未找到账号 ${req.accountId}`)

        // ⚠️ 昵称**沿用旧的**：改 Key 不该顺手把用户起的名字冲掉。
        const keepNickname = typeof old.nickname === 'string' && old.nickname.length > 0
          ? old.nickname
          : defaultNickname(apiKey)

        /**
         * ⚠️⚠️ **必须读旧凭据再合并**（2026-11-02 审查发现）：原先直接写
         * `{ access_token, nickname }` ⇒ 把 `session_cookie` / `user_id` 一起抹掉。
         * 而 `session_cookie` 是**读积分**的唯一凭据（来自「浏览器登录」），
         * 用户「怀疑 Key 失效了」重填同一把 Key 之后，积分会从 235.05 瞬间变成
         * 「未登录」，且卡片上没有任何提示说「你把登录态弄丢了」。
         */
        /**
         * ⚠⚠ **「读不到」与「还没有凭据」不是一回事（六审 A🟡-4、与 monkeycode 同型）。**
         * 抛错 ⇒ 零写入硬失败；解析不到（占位卡）⇒ 允许 previous 为空。
         *
         * ⚠ 不能用 IIFE：那样 `return fail(...)` 会把错误包装并进 `previous` 的类型里
         * （TS2339），且外层取不到那个分支。
         */
        let previous: ReturnType<typeof parseBaizhiCredential>
        try {
          const resolvedOld = await ctx.credentials.resolve(credentialRef(old.credentialRef))
          previous = resolvedOld === undefined ? undefined : parseBaizhiCredential(resolvedOld.value)
        } catch (caught) {
          const message = caught instanceof Error ? caught.message : String(caught)
          return fail(`读取该账号的凭据失败（${message}）；为避免覆盖，本次未做任何修改。`)
        }
        const { id, refName } = baizhiSlotNamesOf(apiKey)
        /**
         * ⚠️⚠️ **2026-11-02 四审 G-1 同型：同一把 Key ⇒ 只合并凭据、不迁移 id**。
         *
         * 消歧卡的 id **不由 Key 唯一决定**（`addAccount` 给碰撞 Key 加了
         * `-<sha256 前 8 位>`），而 `baizhiSlotNamesOf` 永远算不出那个后缀
         * ⇒ 对这张卡填**它自己的** Key 时会掉进下面的占用拒绝，
         * 并把用户指向别的卡；这张卡的登录态从此改不了。
         * → 写入目标必须是 `old.credentialRef`（消歧卡的 ref 带
         * `_HASH8`，按 Key 重算的 `refName` 指向的是另一张卡）。
         */
        if (previous?.access_token === apiKey) {
          await ctx.credentials.set(credentialRef(old.credentialRef), JSON.stringify({
            ...previous,
            access_token: apiKey,
            nickname: keepNickname,
          }))
          return done({ accountId: req.accountId, masked: maskBaizhiKey(apiKey), renamed: false } satisfies RpcBaizhiSetApiKeyResponse)
        }
        if (id === req.accountId) {
          /**
           * ⚠️ 只刷新凭据内容，**不动**账号（否则会先删后建、期间面板上
           * 的这条账号会短暂消失，用户可能重复点击）。
           *
           * ⚠⚠ **写入目标必须是 `old.credentialRef`（六审 A🔴-1）**：这里走到的是
           * 「Key 变了但 id 没变」（尾 8 位相同、全串不同且尾 8 位含非法字符），
           * 而 `refName` 的哈希后缀由**整把 Key** 算出 ⇒ 写 `refName` 会贴到孤儿 ref。
           */
          await ctx.credentials.set(credentialRef(old.credentialRef), JSON.stringify({
            ...previous,
            access_token: apiKey,
            nickname: keepNickname,
          }))
          return done({ accountId: id, masked: maskBaizhiKey(apiKey), renamed: false } satisfies RpcBaizhiSetApiKeyResponse)
        }

        // ⚠️⚠️ **Key 变了 ⇒ 账号 id 随尾段变**（`id` 由 Key 尾 8 位派生，见
        //    `baizhiSlotNamesOf`）⇒ 这不是「改一个字段」，而是**换一条账号**。
        //    ⚠️ 顺序刻意是「先建后删」：反过来若新建失败，用户就**连旧账号
        //    一起丢了** —— 删除不可逆（本仓库记过多起同类事故）。
        const target = pool.listAccountsByProvider(BAIZHI.id).find((a) => a.id === id)
        if (target) {
          return fail(`该 API Key 已对应另一个账号（${id}），请直接编辑那个账号，避免同一 Key 出现两次`)
        }
        // ⚠️ 同上：换 id 也要把「只跟登录态绑定」的字段带过去。
        await ctx.credentials.set(credentialRef(refName), JSON.stringify({
          ...previous,
          access_token: apiKey,
          nickname: keepNickname,
        }))
        await pool.addAccount({
          id,
          provider: BAIZHI.id,
          nickname: keepNickname,
          // ⚠️ 停用状态**继承**旧的：用户特意关掉的账号不该被改 Key 顺手启用。
          enabled: old.enabled,
          credentialRef: refName,
          // ⚠️ 同 `addAccount`：静态 API Key，没有 refresh 端点 ⇒ 诚实记 false。
          refreshable: false,
          createdAt: Date.now(),
        })
        await pool.removeAccount(req.accountId)
        return done({ accountId: id, masked: maskBaizhiKey(apiKey), renamed: true } satisfies RpcBaizhiSetApiKeyResponse)
      }

      default:
        // ⚠️ 返回 `undefined`（不是错误信封）：方法不属于 baizhi，
        // 让主 switch 继续匹配 —— 它自己的 `default` 会给出
        // `unknown method`，那才是准确的归属。
        return undefined
    }
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error))
  }
}


export { parseBaizhiCredential }
