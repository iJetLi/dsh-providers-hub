/**
 * monkeycode-rpc.spec.ts —— 账号/凭据写入路径的守卫（2026-11-02 补）。
 *
 * 为什么要有这个 spec：`handleMonkeycodeRpc` 是**唯一**会写凭据的地方，而它是
 * 纯函数式的（`(ctx, pool, method, payload, product)`），可以直接调 —— 之前完全
 * 没有 spec，于是放过了两个真 bug：
 *
 * 1. **换 Key 时整份重写凭据** ⇒ 用户只改 API Key 就把 `signing_secret` 擦掉了，
 *    而缺 `signing_secret` 的账号**每一次推理**都在适配器里提前抛错，RPC 却回成功。
 * 2. **先写凭据、后查占用** ⇒ 被拒绝的那次调用已经把**别人**的 `access_token`
 *    换成新值、`signing_secret` 换成当前账号的旧值 ⇒ 此后那个账号每次推理 403，
 *    而用户只看到「请直接编辑那个账号」。
 *
 * 这两条的共性是「失败路径上已经发生了写入」—— 只能靠对**写入次数与内容**的
 * 断言守住，编译与手测都看不出来。
 */

import { describe, expect, it } from 'vitest'

import { credentialRef } from '@deepseek-ai/dsh-credentials'

import { MONKEYCODE, MONKEYCODE_INTL } from '../../src/monkeycode-product.js'
import { handleMonkeycodeRpc, monkeycodeSlotNamesOf } from '../../src/monkeycode-rpc.js'
import type { MonkeycodePoolLike } from '../../src/monkeycode-rpc.js'

/** 一个 16 位以上的合法形状 Key（`KEY_PATTERN` 只查长度与字符集）。 */
const KEY_A = 'oma_aaaaaaaaaaaaaaaaaaaaaaaa'
const KEY_B = 'oma_bbbbbbbbbbbbbbbbbbbbbbbb'
// 六审 A🔴-1 夹具：尾 8 位相同、全串不同、且尾 8 位**含非法字符**
// ⇒ id 相同而 refName 的 sha256 后缀不同（只有这种形态能触发「写孤儿 ref」）。
const KEY_HYPHEN_A = 'oma_aaaabbbbcccc-acd-1234'
const KEY_HYPHEN_B = 'oma_ddddeeeeffff-acd-1234'

interface FakeAccount {
  id: string
  provider: string
  nickname?: string
  enabled: boolean
  credentialRef: string
}

interface SetupOptions {
  accounts?: FakeAccount[]
  credentials?: Map<string, string>
}

/** 造一套最小的 ctx + pool，并记录每次 `credentials.set` 的 (ref, 值)。 */
function setup(options: SetupOptions = {}) {
  const accounts = options.accounts ?? []
  const store = options.credentials ?? new Map<string, string>()
  const writes: Array<{ ref: string, value: string }> = []
  const added: FakeAccount[] = []
  const removed: string[] = []

  const pool: MonkeycodePoolLike = {
    listAccountsByProvider: (provider) => accounts.filter((a) => a.provider === provider),
    addAccount: async (entry) => {
      const record: FakeAccount = { ...entry }
      added.push(record)
      // ⚠️ 必须真的进池：G-2 的「消歧 id 复查占用」只有在池里能看见前一张卡时
      //    才可达，池里不收的话三连加会一路建出三条同 id 账号而用例看不出来。
      accounts.push(record)
    },
    removeAccount: async (id) => { removed.push(id) },
  }

  /**
   * ⚠️ `credentialRef(name)` 返回的是**带 brand 的字符串**（`brandString`），
   * 不是 `{ id }` 对象 ⇒ 假实现必须把 ref 当字符串用（`String(ref)`），
   * 否则 `store.get(undefined)` 恒 undefined，`previous` 永远读不到，
   * 「合并写回」那组断言会全部落空（第一版就是这个错）。
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

  const ctx = { credentials } as never
  return { pool, ctx, store, writes, added, removed, accounts }
}

describe('monkeycode.addAccount', () => {
  it('建账号并落凭据（access_token + signing_secret）', async () => {
    const { pool, ctx, writes, added } = setup()
    const result = await handleMonkeycodeRpc(ctx, pool, 'monkeycode.addAccount', {
      apiKey: KEY_A,
      signingSecret: 'secret-0123456789',
    })
    expect(result?.ok, result && !result.ok ? result.error.message : '').toBe(true)
    expect(added).toHaveLength(1)
    expect(added[0].provider).toBe(MONKEYCODE.id)
    expect(added[0].refreshable, '静态 Key 型：不假装能续期').toBe(false)
    expect(writes).toHaveLength(1)
    const saved = JSON.parse(writes[0].value) as Record<string, unknown>
    expect(saved.access_token).toBe(KEY_A)
    expect(saved.signing_secret).toBe('secret-0123456789')
  })

  it('Key 形状不对 ⇒ 拒绝、**零写入**且**不建条目**', async () => {
    const { pool, ctx, writes, added } = setup()
    const result = await handleMonkeycodeRpc(ctx, pool, 'monkeycode.addAccount', { apiKey: 'short' })
    expect(result?.ok).toBe(false)
    expect(writes, '被拒绝的请求不能留下任何写入').toHaveLength(0)
    /**
     * ⚠️ 必须同时断 `added`（2026-11-02 二审 D🟡-7）：只断 `writes` 时，若实现把
     * `pool.addAccount` 挪到形状校验之前，就会留下**没有凭据的幽灵卡片**
     * —— 而那条断言仍然是绿的。
     */
    expect(added, '被拒绝的请求也不能建出账号条目').toHaveLength(0)
  })

  it('★★ 账号不存在 ⇒ 拒绝且零写入（不能悄悄新建一条同 id 的）', async () => {
    const { pool, ctx, writes, added } = setup({ accounts: [] })
    const result = await handleMonkeycodeRpc(ctx, pool, 'monkeycode.setApiKey', {
      accountId: 'no-such-account',
      apiKey: KEY_B,
    })
    expect(result?.ok).toBe(false)
    expect(writes, '账号不存在时不得写任何凭据').toHaveLength(0)
    expect(added, '账号不存在时不得新建条目').toHaveLength(0)
  })
})

describe('monkeycode.setApiKey · 合并写回', () => {
  /** 造一个已存在、且带全量字段的账号。 */
  function setupExisting() {
    /**
     * ⚠️ 账号 id **不是随意取的**：`setApiKey` 用 `monkeycodeSlotNamesOf(apiKey)`
     * 重算 id 与 ref，再与传入的 `accountId` 比对来区分「同一个 Key」与「换 Key」。
     * 夹具必须用同一个函数派生，否则永远落到「换 id」分支，同 id 那组断言就测了个空。
     */
    const { id: existingId, refName: refId } = monkeycodeSlotNamesOf(KEY_A, MONKEYCODE)
    const existing: FakeAccount = {
      id: existingId,
      provider: MONKEYCODE.id,
      nickname: 'Spring🐻',
      enabled: false,
      credentialRef: refId,
    }
    const store = new Map<string, string>()
    store.set(refId, JSON.stringify({
      access_token: KEY_A,
      signing_secret: 'old-secret-0123456789',
      session_cookie: 'monkeycode_ai_session=abc',
      user_id: 'user-1',
      // ⚠️ 六审 J🟡-3：旧实现「按字段重建」只列了 4 个可编辑字段 + user_id，
      //    `expires_at` 会被静默写丢 —— 因此夹具里必须有这个字段，
      //    否则下面那条断言是永真的。
      expires_at: '1799999999999',
    }))
    return { ...setup({ accounts: [existing], credentials: store }), existing, refId }
  }

  it('★★ 只传新 Key ⇒ 未传的 signing_secret / session_cookie / user_id 必须保留', async () => {
    const { pool, ctx, writes, existing } = setupExisting()
    // 账号 id 由 Key 派生：这里先用 addAccount 之外的路径拿到「同一个 id」，
    // 故直接用 `setApiKey` 且 apiKey 与旧值相同 —— 形态上等价于「重填同一把 Key」。
    const result = await handleMonkeycodeRpc(ctx, pool, 'monkeycode.setApiKey', {
      accountId: existing.id,
      apiKey: KEY_A,
    })
    expect(result?.ok, result && !result.ok ? result.error.message : '').toBe(true)
    const written = writes.at(-1)
    expect(written).toBeDefined()
    const saved = JSON.parse(written!.value) as Record<string, unknown>
    expect(saved.access_token).toBe(KEY_A)
    // ⚠️ 这三条是 bug 的核心：整份重写会把它们全擦掉。
    expect(saved.signing_secret, 'signing_secret 被擦掉 ⇒ 之后每次推理都抛错')
      .toBe('old-secret-0123456789')
    expect(saved.session_cookie, 'session_cookie 被擦掉 ⇒ 积分/额度/签到全失效')
      .toBe('monkeycode_ai_session=abc')
    expect(saved.user_id, 'user_id 被擦掉 ⇒ 建号判重失效').toBe('user-1')
    // ⚠️ 六审 J🟡-3（与上面三条同型）：`MonkeycodeCredential` 有 6 个字段，而旧实现只按
    //    「可编辑字段」逐个列举 ⇒ `expires_at` 被写丢（探针打印 undefined）。
    //    现在改成 `{ ...previous, ...buildCredential(...) }` 全量复制。
    expect(saved.expires_at, 'expires_at 被擦掉 ⇒ statusOf 把账号当成永不过期').toBe('1799999999999')
  })

  it('★ 换 Key（新 id）建的新条目必须**继承停用状态**，且旧条目被删掉', async () => {
    const { pool, ctx, added, removed, existing } = setupExisting()
    const result = await handleMonkeycodeRpc(ctx, pool, 'monkeycode.setApiKey', {
      accountId: existing.id,
      apiKey: KEY_B,
    })
    expect(result?.ok, result && !result.ok ? result.error.message : '').toBe(true)
    expect(added, '换 Key ⇒ 新建一条').toHaveLength(1)
    expect(added[0].enabled, '改 Key 不能改变启用状态').toBe(false)
    /**
     * ⚠️ 下面这组是 2026-11-02 二审 D🟡-7 点名的缺口：`removed` 此前被记录却**从无断言**
     * ⇒ 把 `pool.removeAccount(accountId)` 整行删掉，43 条仍然全绿（旧卡片永久残留、
     * 同一把 Key 对应两个条目）。同时必须断**新条目的 id / credentialRef 等于新 Key
     * 派生出来的那组**：若实现把 id 算错，「先建后删」删掉的会是**新条目**而用例照样绿。
     */
    const expected = monkeycodeSlotNamesOf(KEY_B, MONKEYCODE)
    expect(added[0].id, '新条目的 id 必须由**新** Key 派生').toBe(expected.id)
    expect(added[0].credentialRef, '新条目的 ref 必须由**新** Key 派生').toBe(expected.refName)
    expect(removed, '旧条目必须被删掉（否则一张卡两个条目）').toEqual([existing.id])
    expect(removed, '删的绝不能是新条目').not.toContain(expected.id)
  })

  it('★ 用同一把 Key 重填 ⇒ 只刷新凭据，不新建也不删条目', async () => {
    const { pool, ctx, added, removed, existing, writes } = setupExisting()
    const result = await handleMonkeycodeRpc(ctx, pool, 'monkeycode.setApiKey', {
      accountId: existing.id,
      apiKey: KEY_A,
    })
    expect(result?.ok, result && !result.ok ? result.error.message : '').toBe(true)
    expect(added, 'sanity：同 id 分支不该新建条目').toHaveLength(0)
    expect(removed, '同 id 分支更不该删条目').toHaveLength(0)
    expect(writes.length, '凭据要被刷新一次').toBeGreaterThan(0)
  })
})

describe('monkeycode.setApiKey · 新 id 被占用时必须零写入', () => {
  it('★★ 拒绝路径不得污染那个已存在账号的凭据', async () => {
    const occupiedNames = monkeycodeSlotNamesOf(KEY_B, MONKEYCODE)
    const occupiedRef = occupiedNames.refName
    const occupied: FakeAccount = {
      id: occupiedNames.id,
      provider: MONKEYCODE.id,
      enabled: true,
      credentialRef: occupiedRef,
    }
    const selfNames = monkeycodeSlotNamesOf(KEY_A, MONKEYCODE)
    const selfRef = selfNames.refName
    const self: FakeAccount = {
      id: selfNames.id,
      provider: MONKEYCODE.id,
      enabled: true,
      credentialRef: selfRef,
    }
    const store = new Map<string, string>()
    store.set(occupiedRef, JSON.stringify({ access_token: KEY_B, signing_secret: 'occupied-secret' }))
    store.set(selfRef, JSON.stringify({ access_token: KEY_A, signing_secret: 'self-secret' }))
    const { pool, ctx, writes } = setup({ accounts: [self, occupied], credentials: store })

    // 把 self 的 Key 改成 KEY_B ⇒ 目标 id 正是 occupied 的 id。
    const result = await handleMonkeycodeRpc(ctx, pool, 'monkeycode.setApiKey', {
      accountId: self.id,
      apiKey: KEY_B,
    })
    expect(result?.ok, '占用时必须拒绝').toBe(false)
    /**
     * ⚠️ 这条是这个 bug 的唯一判据：被拒绝时 `refName` 恰好就是 occupied 的 ref，
     * 若实现「先写后查」，这里会看到 occupied 被写过（值变成 self 的 secret）。
     */
    expect(writes, '拒绝路径不能对任何 ref 写入').toHaveLength(0)
    expect(store.get(occupiedRef), 'occupied 的凭据必须原封不动')
      .toBe(JSON.stringify({ access_token: KEY_B, signing_secret: 'occupied-secret' }))
  })
})

describe('★ 尾 8 位碰撞（三审 F🟢-4）', () => {
  // 两把**不同的** Key，尾 8 位都是 `ABCD1234` ⇒ `monkeycodeSlotNamesOf` 派生出
  // 完全相同的 id 与 ref。原先的幂等分支不看凭据，会直接回
  // `existed: true` ⇒ 用户以为添加成功，实际上新 Key 被丢、卡上还是旧凭据。
  const KEY_1 = 'aaaa-key-one-ABCD1234'
  const KEY_2 = 'bbbb-key-two-ABCD1234'

  it('同一把 Key 重复添加 ⇒ 幂等（existed）且零写入', async () => {
    const names = monkeycodeSlotNamesOf(KEY_1, MONKEYCODE)
    const store = new Map<string, string>()
    store.set(names.refName, JSON.stringify({ access_token: KEY_1 }))
    const account: FakeAccount = {
      id: names.id,
      provider: MONKEYCODE.id,
      enabled: true,
      credentialRef: names.refName,
    }
    const { pool, ctx, writes } = setup({ accounts: [account], credentials: store })
    const result = await handleMonkeycodeRpc(ctx, pool, `${MONKEYCODE.id}.addAccount`, { apiKey: KEY_1 })
    expect(result?.ok).toBe(true)
    const payload = (result as { value?: { existed?: boolean } } | undefined)?.value
    expect(payload?.existed).toBe(true)
    expect(writes, '幂等路径不能写盘').toHaveLength(0)
  })

  it('★★ 尾 8 位相同但 Key 不同 ⇒ 建新卡，绝不覆盖旧凭据', async () => {
    const names = monkeycodeSlotNamesOf(KEY_1, MONKEYCODE)
    const store = new Map<string, string>()
    store.set(names.refName, JSON.stringify({ access_token: KEY_1, signing_secret: 'old-secret' }))
    const account: FakeAccount = {
      id: names.id,
      provider: MONKEYCODE.id,
      enabled: true,
      credentialRef: names.refName,
    }
    const { pool, ctx, writes, added } = setup({ accounts: [account], credentials: store })
    const result = await handleMonkeycodeRpc(ctx, pool, `${MONKEYCODE.id}.addAccount`, { apiKey: KEY_2 })
    expect(result?.ok).toBe(true)
    const payload = (result as { value?: { accountId?: string; existed?: boolean } } | undefined)?.value
    expect(payload?.existed, '不能把它当成已存在').toBe(false)
    expect(payload?.accountId, '必须换一个 id（带消歧位）').not.toBe(names.id)
    expect(added, '必须真的新建一张卡').toHaveLength(1)
    expect(added[0]!.credentialRef, '新卡的 ref 不能等于旧卡的 ref')
      .not.toBe(names.refName)
    expect(store.get(names.refName), '旧卡凭据必须原封不动')
      .toBe(JSON.stringify({ access_token: KEY_1, signing_secret: 'old-secret' }))
    const written = writes.at(-1)!
    expect(written.ref, '写入目标不能是旧卡').not.toBe(names.refName)
    expect(JSON.parse(written.value).access_token).toBe(KEY_2)
  })

  /**
   * ⚠️⚠️ **四审 G-1 的唯一可达场景**（2026-11-02 五审 J🟡-1 补）：
   *
   * 消歧卡的 id 是 `<base>-<hash8>`，而 `monkeycodeSlotNamesOf` **永远算不出**
   * 那个后缀 ⇒ 对这张卡填**它自己的** Key 时 `newId` 是基础 id、≠ `accountId`，
   * 于是掉进占用检查、报「已对应另一个账号（基础 id）」并把用户指向**别的卡**。
   * 这张卡的 `signing_secret` / `session_cookie` 从此永远改不了。
   *
   * 现有「同一把 Key 重填」用例走的是 `newId === accountId` 分支，**碰不到这里**
   * （把 G-1 的早退改成 `if (false)` 时它照样绿）。
   */
  it('★★★ 消歧卡填它自己的 Key ⇒ 只刷新凭据，不迁移 id、不指向别的卡（四审 G-1）', async () => {
    const base = monkeycodeSlotNamesOf(KEY_1, MONKEYCODE)
    const store = new Map<string, string>()
    store.set(base.refName, JSON.stringify({ access_token: KEY_1 }))
    const { pool, ctx, writes, added, removed } = setup({
      accounts: [{ id: base.id, provider: MONKEYCODE.id, enabled: true, credentialRef: base.refName }],
      credentials: store,
    })

    const created = await handleMonkeycodeRpc(ctx, pool, `${MONKEYCODE.id}.addAccount`, { apiKey: KEY_2 }) as
      { ok?: boolean, value?: { accountId?: string } }
    const disambiguatedId = created.value?.accountId
    expect(disambiguatedId, '前置：必须建出一张带 -hash8 的消歧卡').not.toBe(base.id)
    const writesBefore = writes.length
    const addedBefore = added.length

    const again = await handleMonkeycodeRpc(ctx, pool, `${MONKEYCODE.id}.setApiKey`, {
      accountId: disambiguatedId,
      apiKey: KEY_2,
      signingSecret: 'signew1234',
    }) as { ok?: boolean, value?: { accountId?: string, renamed?: boolean } }

    expect(again.ok, '消歧卡改自己的 Key 必须成功').toBe(true)
    expect(again.value?.renamed, '同一把 Key 不该改 id').toBe(false)
    expect(again.value?.accountId).toBe(disambiguatedId)
    expect(removed, '不能删任何账号（删卡会 unset 共用 ref）').toHaveLength(0)
    expect(added, '不能新建条目').toHaveLength(addedBefore)
    expect(writes, '只写一次凭据').toHaveLength(writesBefore + 1)

    const target = added[addedBefore - 1]!
    const lastWrite = writes.at(-1)!
    expect(lastWrite.ref, '写入目标必须是消歧卡自己的 ref（带 _HASH8）')
      .toBe(String(credentialRef(target.credentialRef)))
    const saved = JSON.parse(lastWrite.value) as { access_token?: string, signing_secret?: string }
    expect(saved.access_token).toBe(KEY_2)
    expect(saved.signing_secret, 'signing_secret must use new value').toBe('signew1234')
  })

  /**
   * ⚠️⚠️ **四审 G-2 的唯一可达场景**（2026-11-02 五审 J🟡-1 补）：
   *
   * `add(KEY_1)` → `add(KEY_2)`（同尾 ⇒ 建消歧卡）→ **再** `add(KEY_2)`。
   * 第二次也算出同一个消歧 id；而 `account-pool.addAccount` 是**纯追加、不查重**
   * ⇒ 会出现两条同 id 账号共用同一个 ref，删掉其中一条会让另一张卡变成
   * 「凭据不可读」（`removeAccount` 会 `credentials.unset`）。
   */
  it('★★★ 同一把碰撞 Key 连加三次 ⇒ 第三条幂等，绝不出现两条同 id 账号（四审 G-2）', async () => {
    const store = new Map<string, string>()
    const { pool, ctx, added, removed, writes } = setup({ credentials: store })

    const first = await handleMonkeycodeRpc(ctx, pool, `${MONKEYCODE.id}.addAccount`, { apiKey: KEY_1 })
    expect((first as { ok?: boolean }).ok).toBe(true)
    const second = await handleMonkeycodeRpc(ctx, pool, `${MONKEYCODE.id}.addAccount`, { apiKey: KEY_2 })
    expect((second as { ok?: boolean }).ok).toBe(true)

    const third = await handleMonkeycodeRpc(ctx, pool, `${MONKEYCODE.id}.addAccount`, { apiKey: KEY_2 }) as
      { ok?: boolean, value?: { existed?: boolean } }
    expect(third.ok).toBe(true)
    expect(third.value?.existed, '第三次必须幂等返回，不能又建一条').toBe(true)

    expect(added, '只该有两张卡').toHaveLength(2)
    const ids = added.map((entry) => entry.id)
    expect(new Set(ids).size, '两条卡的 id 必须互不相同').toBe(ids.length)
    expect(removed).toHaveLength(0)
    /**
     * ⚠⚠ 六审 A🟡-2：本用例此前**没有一条 `writes` 断言** —— 而同文件「同 Key 幂等」
     * 用例断的就是零写入（同一不变量两套口径）。变异 M12 实测：在幂等早退前先
     * `credentials.set(...)` 一次 ⇒ 17 passed 全绿。前两次建号各写 1 次，第三次必须 0 次。
     */
    expect(writes, '幂等返回不能顺手写凭据').toHaveLength(2)
  })
  /**
   * 六审 A🔴-1：「改 Key」的 **id 相等分支**曾写入按新 Key 重算的 `refName`。
   *
   * 当卡片的 ref 带 `_<sha256 前 8>`（尾 8 位含 `-` / `.` 时才会加）、而用户改成
   * **尾 8 位相同、全串不同**的 Key 时：`id` 相同（不过账号条目）但 `refName` 的
   * 哈希后缀不同 ⇒ 按 `refName` 写会落到一个**没人引用的孤儿 ref**：卡片仍持旧 Key，
   * RPC 却回 `ok:true, renamed:false` —— 零日志的静默无效。
   */
  it('★★ 尾 8 位相同、全串不同 ⇒ 凭据必须写进**卡片自己的 ref**（六审 A🔴-1）', async () => {
    const names = monkeycodeSlotNamesOf(KEY_HYPHEN_A, MONKEYCODE)
    const next = monkeycodeSlotNamesOf(KEY_HYPHEN_B, MONKEYCODE)
    // 夹具前提必须成立，否则这条用例测的是另一条路径。
    expect(next.id, '夹具前提：两把 Key 必须派生出同一个 id').toBe(names.id)
    expect(next.refName, '夹具前提：ref 必须不同（sha256 后缀不同）')
      .not.toBe(names.refName)

    const card: FakeAccount = {
      id: names.id,
      provider: MONKEYCODE.id,
      nickname: '碰撞卡',
      enabled: true,
      credentialRef: names.refName,
    }
    const store = new Map<string, string>()
    store.set(names.refName, JSON.stringify({
      access_token: KEY_HYPHEN_A,
      signing_secret: 'secret-hyphen-a',
      session_cookie: 'cookie-hyphen-a',
      user_id: 'user-hyphen',
    }))
    const { pool, ctx, writes } = setup({ accounts: [card], credentials: store })

    const result = await handleMonkeycodeRpc(ctx, pool, 'monkeycode.setApiKey', {
      accountId: names.id,
      apiKey: KEY_HYPHEN_B,
    })
    expect(result?.ok, result && !result.ok ? result.error.message : '').toBe(true)
    expect(writes, '只该写一次').toHaveLength(1)
    expect(writes[0]!.ref, '写入目标必须是卡片自己的 ref')
      .toBe(names.refName)
    const saved = JSON.parse(store.get(names.refName)!) as Record<string, unknown>
    expect(saved.access_token, '卡片里必须是新 Key（写 refName 时这里仍是旧 Key）')
      .toBe(KEY_HYPHEN_B)
    expect(saved.user_id, '旧 user_id 必须保留').toBe('user-hyphen')
    expect(store.has(next.refName), '不许凭空多出一个孤儿 ref').toBe(false)
  })
})

describe('monkeycode.setSession', () => {
  it('传空串 = 清除会话（不是「保留旧值」）', async () => {
    const names = monkeycodeSlotNamesOf(KEY_A, MONKEYCODE)
    const refId = names.refName
    const store = new Map<string, string>()
    store.set(refId, JSON.stringify({ access_token: KEY_A, session_cookie: 'old' }))
    const account: FakeAccount = {
      id: names.id,
      provider: MONKEYCODE.id,
      enabled: true,
      credentialRef: refId,
    }
    const { pool, ctx, writes } = setup({ accounts: [account], credentials: store })
    const result = await handleMonkeycodeRpc(ctx, pool, 'monkeycode.setSession', {
      accountId: account.id,
      sessionCookie: '',
    })
    expect(result?.ok).toBe(true)
    const saved = JSON.parse(writes.at(-1)!.value) as Record<string, unknown>
    expect('session_cookie' in saved, '空串表示清除，字段应当整个消失').toBe(false)
    expect(saved.access_token, '清会话不能动推理凭据').toBe(KEY_A)
  })

  /**
   * ★★ 三审 F🟢-2：「字段缺失」与「传空串」必须分开。
   *
   * 实现里 `optionalString` 把两者都归一成 `undefined`，而下面的分支又把
   * `undefined` 当「清除」⇒ 一个只带 `accountId` 的 body 也会把 cookie 抹掉。
   * 这种“只想读现状却变成写”的副作用对外是不可观察的（都返回 ok），
   * 只能靠对「是否写盘」的断言守住。
   */
  it('★★ 没带 sessionCookie 字段 ⇒ 零写入，且原地回报现状', async () => {
    const names = monkeycodeSlotNamesOf(KEY_A, MONKEYCODE)
    const store = new Map<string, string>()
    store.set(names.refName, JSON.stringify({ access_token: KEY_A, session_cookie: 'keep-me' }))
    const account: FakeAccount = {
      id: names.id,
      provider: MONKEYCODE.id,
      enabled: true,
      credentialRef: names.refName,
    }
    const { pool, ctx, writes } = setup({ accounts: [account], credentials: store })
    const result = await handleMonkeycodeRpc(ctx, pool, 'monkeycode.setSession', {
      accountId: account.id,
    })
    expect(result?.ok).toBe(true)
    expect(writes, '字段缺失⇒必须零写入（不能把 cookie 抹掉）').toHaveLength(0)
    expect(store.get(names.refName), '底层凭据也不能变')
      .toBe(JSON.stringify({ access_token: KEY_A, session_cookie: 'keep-me' }))
    const payload = (result as { value?: { hasSession?: boolean } } | undefined)?.value
    expect(payload?.hasSession, '应当回报现有 cookie').toBe(true)
  })

  it('字段缺失且本来就没 cookie ⇒ 零写入且 hasSession=false', async () => {
    const names = monkeycodeSlotNamesOf(KEY_A, MONKEYCODE)
    const store = new Map<string, string>()
    store.set(names.refName, JSON.stringify({ access_token: KEY_A }))
    const account: FakeAccount = {
      id: names.id,
      provider: MONKEYCODE.id,
      enabled: true,
      credentialRef: names.refName,
    }
    const { pool, ctx, writes } = setup({ accounts: [account], credentials: store })
    const result = await handleMonkeycodeRpc(ctx, pool, 'monkeycode.setSession', {
      accountId: account.id,
    })
    expect(writes).toHaveLength(0)
    const payload = (result as { value?: { hasSession?: boolean } } | undefined)?.value
    expect(payload?.hasSession).toBe(false)
  })

  it('传非空串 ⇒ 写入并回报 hasSession=true', async () => {
    const names = monkeycodeSlotNamesOf(KEY_A, MONKEYCODE)
    const store = new Map<string, string>()
    store.set(names.refName, JSON.stringify({ access_token: KEY_A, signing_secret: 'sec' }))
    const account: FakeAccount = {
      id: names.id,
      provider: MONKEYCODE.id,
      enabled: true,
      credentialRef: names.refName,
    }
    const { pool, ctx, writes } = setup({ accounts: [account], credentials: store })
    const result = await handleMonkeycodeRpc(ctx, pool, 'monkeycode.setSession', {
      accountId: account.id,
      sessionCookie: '  sess-new  ',
    })
    expect(result?.ok).toBe(true)
    const saved = JSON.parse(writes.at(-1)!.value) as Record<string, unknown>
    expect(saved.session_cookie, '应当裁掉两端空格').toBe('sess-new')
    expect(saved.signing_secret, '不能动其他字段').toBe('sec')
    const payload = (result as { value?: { hasSession?: boolean } } | undefined)?.value
    expect(payload?.hasSession).toBe(true)
  })
})

describe('前缀分派', () => {
  it('不认的 action ⇒ undefined（让主 switch 继续走）', async () => {
    const { pool, ctx } = setup()
    expect(await handleMonkeycodeRpc(ctx, pool, 'monkeycode.nope', {})).toBeUndefined()
  })

  it('国际站前缀按 product 分派（id 前缀不同 ⇒ 不串台）', async () => {
    const names = monkeycodeSlotNamesOf(KEY_A, MONKEYCODE_INTL)
    const store = new Map<string, string>()
    store.set(names.refName, JSON.stringify({ access_token: KEY_A }))
    const account: FakeAccount = {
      id: names.id,
      provider: MONKEYCODE_INTL.id,
      enabled: true,
      credentialRef: names.refName,
    }
    const { pool, ctx } = setup({ accounts: [account], credentials: store })
    const result = await handleMonkeycodeRpc(
      ctx, pool, 'monkeycodeintl.setSession',
      { accountId: account.id, sessionCookie: 'sess' },
      MONKEYCODE_INTL,
    )
    expect(result?.ok, '国际站的方法必须由自己那份 product 处理').toBe(true)
  })
})
