/**
 * baizhi-rpc.spec.ts —— 百智云账号/凭据写入路径的守卫（2026-11-02 四审 G-4 补）。
 *
 * 为什么要有这个 spec：`handleBaizhiRpc` 全仓**零测试引用**（`grep -rn handleBaizhiRpc tests/`
 * 当时 0 命中），于是四审 G-4 指出的碰撞 bug 一直绿着：
 *
 * > `addAccount` 只比 `id`、不比凭据。`id` 由 Key **尾 8 位**派生，两把不同的 Key
 * > 尾 8 位相同时会撞到同一 id ⇒ 直接回 `existed: true`，新 Key 被**静默丢弃**，
 * > 卡上还是旧 Key，此后每次推理 401 而 UI 说「已存在」。
 *
 * 这类 bug 编译、手测、类型检查都看不出来 —— 只能靠对**写入次数与写入内容**的断言守住。
 * 本 spec 覆盖：addAccount 正常建号 / 形状闸门 / 同 Key 幂等 / 尾 8 位碰撞消歧 /
 * setApiKey 换 Key（含「先建后删」与凭据合并）/ 同 Key 重填不动账号 / 账号不存在 /
 * 未知方法返回 `undefined`（让主 switch 继续匹配）。
 */

import { describe, expect, it } from 'vitest'

import { credentialRef } from '@deepseek-ai/dsh-credentials'

import { BAIZHI } from '../../src/baizhi-product.js'
import { handleBaizhiRpc, baizhiSlotNamesOf } from '../../src/baizhi-rpc.js'
import type { BaizhiPoolLike } from '../../src/baizhi-rpc.js'

/** 合法形状：`KEY_PATTERN` 只查长度（≥16）与字符集，不绑死 `sk-` 前缀。 */
const KEY_A = `sk-${'a'.repeat(64)}`
const KEY_B = `sk-${'b'.repeat(64)}`
// 六审 A🔴-1 夹具（与 monkeycode 同型）：尾 8 位相同、全串不同、尾 8 位含非法字符。
const KEY_HYPHEN_A = `sk-${'e'.repeat(48)}-acd-1234`
const KEY_HYPHEN_B = `sk-${'f'.repeat(48)}-acd-1234`
/** 尾 8 位刻意相同 —— 正是 id 派生的输入，用来造碰撞。 */
const KEY_C1 = `sk-${'c'.repeat(56)}ZZZZZZZZ`
const KEY_C2 = `sk-${'d'.repeat(56)}ZZZZZZZZ`

interface FakeAccount {
  id: string
  provider: string
  nickname?: string
  enabled: boolean
  credentialRef: string
}

type RpcEnvelope<T> =
  | { ok: true, value: T }
  | { ok: false, error: { code: string, message: string } }

/** 造一套最小的 ctx + pool，并记录每一次 `credentials.set` 与 `pool.addAccount`。 */
function setup(options: { accounts?: FakeAccount[], credentials?: Map<string, string> } = {}) {
  const accounts = options.accounts ?? []
  const store = options.credentials ?? new Map<string, string>()
  const writes: Array<{ ref: string, value: string }> = []
  const added: FakeAccount[] = []
  const removed: string[] = []

  const pool: BaizhiPoolLike = {
    listAccountsByProvider: (provider) => accounts.filter((a) => a.provider === provider),
    addAccount: async (entry) => {
      const record: FakeAccount = {
        id: entry.id as unknown as string,
        provider: entry.provider as unknown as string,
        nickname: (entry as unknown as { nickname?: string }).nickname,
        enabled: (entry as unknown as { enabled?: boolean }).enabled !== false,
        credentialRef: entry.credentialRef as unknown as string,
      }
      added.push(record)
      accounts.push(record)
    },
    removeAccount: async (accountId) => {
      removed.push(accountId)
      const at = accounts.findIndex((a) => a.id === accountId)
      if (at >= 0) accounts.splice(at, 1)
    },
  }

  /**
   * ⚠️ `credentialRef(name)` 返回**带 brand 的字符串**，不是 `{ id }` 对象
   * ⇒ 假实现必须 `String(ref)`，否则 `store.get(undefined)` 恒 undefined。
   */
  const credentials = {
    resolve: async (ref: unknown) => {
      const value = store.get(String(ref))
      return value === undefined ? undefined : { value }
    },
    set: async (ref: unknown, value: string) => {
      writes.push({ ref: String(ref), value })
      store.set(String(ref), value)
    },
  }

  return { pool, ctx: { credentials } as never, store, writes, added, removed, accounts }
}

function savedCredential(write: { value: string }): Record<string, unknown> {
  return JSON.parse(write.value) as Record<string, unknown>
}

describe('baizhi.addAccount', () => {
  it('建账号并落凭据（只有 access_token，没有 oma_ 那套字段）', async () => {
    const { pool, ctx, writes, added } = setup()
    const result = await handleBaizhiRpc(ctx, pool, 'baizhi.addAccount', { apiKey: KEY_A }) as RpcEnvelope<{ accountId: string, existed: boolean }>

    expect(result.ok, result.ok ? '' : result.error.message).toBe(true)
    if (!result.ok) return
    expect(result.value.existed).toBe(false)
    expect(result.value.accountId).toBe(baizhiSlotNamesOf(KEY_A).id)
    expect(added, '建了且只建了一条').toHaveLength(1)
    expect(added[0].provider).toBe(BAIZHI.id)
    expect(writes).toHaveLength(1)
    const saved = savedCredential(writes[0])
    expect(saved.access_token).toBe(KEY_A)
    expect(saved.signing_secret, '百智云没有 signing_secret').toBeUndefined()
  })

  it('Key 形状不对 ⇒ 拒绝、**零写入**且**不建条目**', async () => {
    const { pool, ctx, writes, added } = setup()
    const result = await handleBaizhiRpc(ctx, pool, 'baizhi.addAccount', { apiKey: 'short' }) as RpcEnvelope<unknown>

    expect(result.ok).toBe(false)
    expect(writes).toHaveLength(0)
    expect(added).toHaveLength(0)
  })

  it('同一把 Key 重复添加 ⇒ existed=true 且**零写入**（幂等，不是报错）', async () => {
    const { pool, ctx, writes } = setup()
    await handleBaizhiRpc(ctx, pool, 'baizhi.addAccount', { apiKey: KEY_A })
    const before = writes.length

    const second = await handleBaizhiRpc(ctx, pool, 'baizhi.addAccount', { apiKey: KEY_A }) as RpcEnvelope<{ accountId: string, existed: boolean }>
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.value.existed).toBe(true)
    expect(writes, '幂等路径不得再写一次凭据').toHaveLength(before)
  })

  it('★★ 尾 8 位相同但 Key 不同 ⇒ 必须消歧（否则新 Key 被静默丢弃，此后恒 401）', async () => {
    const { pool, ctx, writes, store, added } = setup()
    const first = await handleBaizhiRpc(ctx, pool, 'baizhi.addAccount', { apiKey: KEY_C1 }) as RpcEnvelope<{ accountId: string, existed: boolean }>
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const oldRef = added[0].credentialRef
    const oldStored = store.get(String(credentialRef(oldRef)))

    const second = await handleBaizhiRpc(ctx, pool, 'baizhi.addAccount', { apiKey: KEY_C2 }) as RpcEnvelope<{ accountId: string, existed: boolean }>
    expect(second.ok, second.ok ? '' : second.error.message).toBe(true)
    if (!second.ok) return

    expect(second.value.existed, '不同 Key 不得被当成「已存在」').toBe(false)
    expect(second.value.accountId, '消歧后 id 必须不同').not.toBe(first.value.accountId)
    expect(added).toHaveLength(2)
    expect(added[1].credentialRef, '消歧卡必须用**新的** ref').not.toBe(oldRef)
    expect(store.get(String(credentialRef(oldRef))), '旧卡凭据必须原封不动').toBe(oldStored)
    expect(store.get(String(credentialRef(added[1].credentialRef)))).toContain(KEY_C2)
  })

  /**
   * ⚠️⚠️ **四审 G-1 的唯一可达场景**（2026-11-02 五审 J🟡-1 补）：
   * 消歧卡的 id 是 `<base>-<hash8>`，`baizhiSlotNamesOf` 算不出那个后缀 ⇒
   * 对它填**它自己的** Key 时会被当成「已对应另一个账号」而永远改不了凭据。
   */
  it('★★★ 消歧卡填它自己的 Key ⇒ 只刷新凭据，不迁移 id（四审 G-1）', async () => {
    const { pool, ctx, writes, added, removed } = setup()
    const first = await handleBaizhiRpc(ctx, pool, 'baizhi.addAccount', { apiKey: KEY_C1 }) as RpcEnvelope<{ accountId: string }>
    if (!first.ok) throw new Error('前置失败')
    const second = await handleBaizhiRpc(ctx, pool, 'baizhi.addAccount', { apiKey: KEY_C2 }) as RpcEnvelope<{ accountId: string }>
    if (!second.ok) throw new Error('前置失败')
    const disambiguatedId = second.value.accountId
    expect(disambiguatedId, '前置：必须建出一张消歧卡').not.toBe(first.value.accountId)
    const writesBefore = writes.length
    const addedBefore = added.length

    const again = await handleBaizhiRpc(ctx, pool, 'baizhi.setApiKey', {
      accountId: disambiguatedId,
      apiKey: KEY_C2,
    }) as RpcEnvelope<{ accountId: string, renamed: boolean }>
    expect(again.ok, again.ok ? '' : again.error.message).toBe(true)
    if (!again.ok) return

    expect(again.value.renamed, '同一把 Key 不该改 id').toBe(false)
    expect(again.value.accountId).toBe(disambiguatedId)
    expect(removed, '不能删任何账号').toHaveLength(0)
    expect(added, '不能新建条目').toHaveLength(addedBefore)
    expect(writes, '只写一次凭据').toHaveLength(writesBefore + 1)
    const last = writes[writes.length - 1]
    expect(last.ref, '写入目标必须是消歧卡自己的 ref').toBe(String(credentialRef(added[addedBefore - 1].credentialRef)))
    expect(savedCredential(last).access_token).toBe(KEY_C2)
  })

  /**
   * ⚠️⚠️ **四审 G-2 的唯一可达场景**：`add(C1)` → `add(C2)`（同尾消歧）→ 再 `add(C2)`。
   */
  it('★★★ 同一把碰撞 Key 连加三次 ⇒ 第三条幂等，绝不出现两条同 id 账号（四审 G-2）', async () => {
    const { pool, ctx, added, removed, writes } = setup()
    const first = await handleBaizhiRpc(ctx, pool, 'baizhi.addAccount', { apiKey: KEY_C1 }) as RpcEnvelope<unknown>
    expect(first.ok).toBe(true)
    const second = await handleBaizhiRpc(ctx, pool, 'baizhi.addAccount', { apiKey: KEY_C2 }) as RpcEnvelope<unknown>
    expect(second.ok).toBe(true)

    const third = await handleBaizhiRpc(ctx, pool, 'baizhi.addAccount', { apiKey: KEY_C2 }) as RpcEnvelope<{ existed: boolean }>
    expect(third.ok).toBe(true)
    if (!third.ok) return
    expect(third.value.existed, '第三次必须幂等返回').toBe(true)

    expect(added, '只该有两张卡').toHaveLength(2)
    const ids = added.map((entry) => entry.id)
    expect(new Set(ids).size, '两条卡的 id 必须互不相同').toBe(ids.length)
    expect(removed).toHaveLength(0)
    // ⚠️ 六审 A🟡-2：幂等路径必须零写入（与 monkeycode 同型；变异 M16 实测全绿）。
    expect(writes, '幂等返回不能顺手写凭据').toHaveLength(2)
  })
  /**
   * 六审 A🔴-1（百智云同型）：「id 相等分支」曾写入按新 Key 重算的 `refName`。
   * 后果与 monkeycode 逐字相同：卡片仍持旧 Key、多出一个孤儿 ref、RPC 回成功。
   */
  it('★★ 尾 8 位相同、全串不同 ⇒ 凭据必须写进**卡片自己的 ref**（六审 A🔴-1）', async () => {
    const names = baizhiSlotNamesOf(KEY_HYPHEN_A)
    const next = baizhiSlotNamesOf(KEY_HYPHEN_B)
    expect(next.id, '夹具前提：两把 Key 必须派生出同一个 id').toBe(names.id)
    expect(next.refName, '夹具前提：ref 必须不同').not.toBe(names.refName)

    const card = {
      id: names.id,
      provider: 'baizhi',
      nickname: '碰撞卡',
      enabled: true,
      credentialRef: names.refName,
    }
    const store = new Map<string, string>()
    store.set(names.refName, JSON.stringify({
      access_token: KEY_HYPHEN_A,
      session_cookie: 'cookie-hyphen-a',
      user_id: 'user-hyphen',
    }))
    const { pool, ctx, writes } = setup({ accounts: [card], credentials: store })

    const result = await handleBaizhiRpc(ctx, pool, 'baizhi.setApiKey', {
      accountId: names.id,
      apiKey: KEY_HYPHEN_B,
    }) as RpcEnvelope<unknown>
    expect(result.ok, 'ok' in result ? '' : '').toBe(true)
    expect(writes, '只该写一次').toHaveLength(1)
    expect(writes[0]!.ref, '写入目标必须是卡片自己的 ref').toBe(names.refName)
    const saved = JSON.parse(store.get(names.refName)!) as Record<string, unknown>
    expect(saved.access_token, '卡片里必须是新 Key').toBe(KEY_HYPHEN_B)
    expect(saved.user_id, '旧 user_id 必须保留').toBe('user-hyphen')
    expect(store.has(next.refName), '不许凭空多出一个孤儿 ref').toBe(false)
  })

  it('未知方法 ⇒ 返回 undefined（让主 switch 继续匹配，不能被当成「格式错误」）', async () => {
    const { pool, ctx } = setup()
    expect(await handleBaizhiRpc(ctx, pool, 'opencode.addAccount', { apiKey: KEY_A })).toBeUndefined()
    expect(await handleBaizhiRpc(ctx, pool, 'baizhi.nope', {})).toBeUndefined()
    expect(await handleBaizhiRpc(ctx, pool, '', {})).toBeUndefined()
  })
})

describe('baizhi.setApiKey', () => {
  it('换 Key ⇒ 建新号 + 删旧号，新凭据由**新** Key 派生', async () => {
    const { pool, ctx, writes, added, removed } = setup()
    const created = await handleBaizhiRpc(ctx, pool, 'baizhi.addAccount', { apiKey: KEY_A }) as RpcEnvelope<{ accountId: string }>
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const oldId = created.value.accountId

    const changed = await handleBaizhiRpc(ctx, pool, 'baizhi.setApiKey', { accountId: oldId, apiKey: KEY_B }) as RpcEnvelope<{ accountId: string, renamed: boolean }>
    expect(changed.ok, changed.ok ? '' : changed.error.message).toBe(true)
    if (!changed.ok) return

    expect(changed.value.renamed).toBe(true)
    expect(changed.value.accountId).toBe(baizhiSlotNamesOf(KEY_B).id)
    expect(removed, '旧账号必须被移除').toEqual([oldId])
    const last = writes[writes.length - 1]
    expect(last.ref).toBe(String(credentialRef(baizhiSlotNamesOf(KEY_B).refName)))
    expect(savedCredential(last).access_token).toBe(KEY_B)
    expect(added.map((a) => a.id)).toEqual([oldId, baizhiSlotNamesOf(KEY_B).id])
  })

  it('同一把 Key 重填 ⇒ renamed=false 且**不动账号**（不删不建）', async () => {
    const { pool, ctx, added, removed } = setup()
    const created = await handleBaizhiRpc(ctx, pool, 'baizhi.addAccount', { apiKey: KEY_A }) as RpcEnvelope<{ accountId: string }>
    if (!created.ok) throw new Error('前置失败')
    const before = added.length

    const again = await handleBaizhiRpc(ctx, pool, 'baizhi.setApiKey', { accountId: created.value.accountId, apiKey: KEY_A }) as RpcEnvelope<{ renamed: boolean }>
    expect(again.ok).toBe(true)
    if (!again.ok) return
    expect(again.value.renamed).toBe(false)
    expect(removed, '同 Key 不该删账号').toHaveLength(0)
    expect(added, '同 Key 不该再建一条').toHaveLength(before)
  })

  it('改 Key 时**合并**旧凭据（不许把 session_cookie / user_id 抹掉）', async () => {
    const { pool, ctx, writes } = setup({
      accounts: [{
        id: 'baizhi-abcdef12',
        provider: BAIZHI.id,
        nickname: '我的百智',
        enabled: true,
        credentialRef: baizhiSlotNamesOf(KEY_C1).refName,
      }],
      credentials: new Map([[
        String(credentialRef(baizhiSlotNamesOf(KEY_C1).refName)),
        JSON.stringify({
          access_token: KEY_C1,
          session_cookie: 'sl-session=keep-me',
          user_id: 'u-42',
          nickname: '我的百智',
        }),
      ]]),
    })

    const result = await handleBaizhiRpc(ctx, pool, 'baizhi.setApiKey', { accountId: 'baizhi-abcdef12', apiKey: KEY_C2 }) as RpcEnvelope<{ renamed: boolean }>
    expect(result.ok, result.ok ? '' : result.error.message).toBe(true)

    const saved = savedCredential(writes[writes.length - 1])
    expect(saved.access_token).toBe(KEY_C2)
    expect(saved.session_cookie, '登录态必须带过去').toBe('sl-session=keep-me')
    expect(saved.user_id, '判重要用的 user_id 不许丢').toBe('u-42')
    expect(saved.nickname, '用户自定义昵称不许被冲掉').toBe('我的百智')
  })

  it('账号不存在 ⇒ 拒绝且**零写入零建条目**', async () => {
    const { pool, ctx, writes, added, removed } = setup()
    const result = await handleBaizhiRpc(ctx, pool, 'baizhi.setApiKey', { accountId: 'baizhi-ghost000', apiKey: KEY_B }) as RpcEnvelope<unknown>

    expect(result.ok).toBe(false)
    expect(writes).toHaveLength(0)
    expect(added).toHaveLength(0)
    expect(removed).toHaveLength(0)
  })
})
