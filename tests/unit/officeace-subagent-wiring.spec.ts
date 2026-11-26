/**
 * **officeace 子代理接线守卫**（2026-11-25）。
 *
 * ## 缺陷形态
 *
 * officeace **自建选号**（`credentialProvider` 钩子，不走 `createCredentialResolver`）
 * ⇒ 子代理策略**静默无效、零报错**（与 `codearts` 同形态）。
 *
 * ## ⚠️ 本家比 codearts 更深的三处差异（都实测过）
 *
 * | 差异 | codearts | officeace |
 * |---|---|---|
 * | 选号形态 | `getAvailableAccount(…, rotationStartId)` **只选一个** | 锁定态**逐个试**（for 循环）|
 * | 起点语义 | 「选中项」 | **「遍历顺序的头部」** |
 * | 会话 id 通路 | `resolveCredential(model, sessionId)` 基类直接给 | `credentialProvider` 是**零参**，必须改签名透传 |
 *
 * ⇒ 起点的正确落地是 `orderAccountsForSubagent`（**只调顺序**），
 *   而不是「挑一个号」（那会破坏「逐个试」的既有语义）。
 *
 * ## 本文件锁什么
 *
 * ① `officeace-lock.ts` 真的调了共享的 `decideSubagentStart`；
 * ② 它**只改顺序**、不跳过任何账号（`length` 不变）；
 * ③ 零回归：未配置 / 无 sessionId / 无 pool ⇒ 原样返回；
 * ④ 异常安全：`decideSubagentStart` 抛错时原样返回（选号不能因此失败）。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const here = import.meta.dirname

/** 读源码并**剥掉注释**（防「注释里写了但代码没做」的假绿）。 */
function readStripped(rel: string): string {
  return readFileSync(resolve(here, '../..', rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

describe('★★★ officeace 接线：用共享函数决定「遍历顺序」', () => {
  /**
   * ## O1 必须调 `decideSubagentStart`，且 providerId 正确
   *
   * ⚠️ providerId 写错会让它读**别家**的子代理设置（而那些设置对它无意义）。
   */
  it('★★★ O1 officeace-lock 调了 decideSubagentStart 且 providerId 正确', () => {
    const code = readStripped('src/officeace-lock.ts')
    expect(
      code,
      'officeace 未接子代理 ⇒ 面板里给子代理设的策略对它静默无效',
    ).toMatch(/decideSubagentStart\(\{/)
    expect(code, 'providerId 必须是 OFFICEACE.id').toMatch(
      /decideSubagentStart\(\{[\s\S]{0,200}?providerId:\s*OFFICEACE\.id/,
    )
  })

  /**
   * ## O2 起点必须**只调整顺序**，不得跳过账号
   *
   * ⚠️ 本家在锁定态是「逐个试，撞到有临期额度的就返回」⇒ 若把起点实现成
   * 「只返回那一个号」，就**破坏了既有语义**（其他号再也不会被尝试）。
   *
   * 判据：返回值是 `[head, ...其余]` 的形状 —— 长度与入参**相同**。
   */
  it('★★★ O2 起点只重排顺序、不丢账号', () => {
    const code = readStripped('src/officeace-lock.ts')
    // 必须是 [head, ...filter(≠head)] 的形态（长度守恒）
    expect(
      code,
      '起点若写成「只返回那一个」⇒ 破坏「逐个试」的既有语义（其余号不再被尝试）',
    ).toMatch(/return \[head,\s*\.\.\.accounts\.filter\(/)
  })
  it('★★★ O2c 起点 = oa2 时首位必须是 oa3（唯一可分辨的构造）', async () => {
    /**
     * ## 为什么起点选 oa2
     *
     * 池 `[oa1, oa2, oa3]`、`sequence` slot=0：
     *
     * | 主代理起点 | `(idx+1)%3` | 首位 | 与池首相同？ |
     * |---|---|---|---|
     * | oa1（池首）| `(0+1)%3 = 1` | **oa2** | ❌ 不同 ✅ |
     * | **oa2** | `(1+1)%3 = 2` | **oa3** | ❌ 不同 ✅ |
     * | oa3 | `(2+1)%3 = 0` | oa1 | **相同** ⚠️ 分不开 |
     *
     * ⇒ 起点取 **oa2** 时首位是 `oa3`，**与池首（oa1）不同** ⇒ 能证明「顺序真的被改过」。
     * ⚠️ 而且若不注入 `mainStartIdOf`，`effectiveMainStart` 退化成池首 oa1
     *    ⇒ 首位会是 `oa2` ⇒ **两者不同，可分辨**。
     */
    const { createOfficeAceCredentialProvider } = await import('../../src/officeace-lock.js')

    const POOL = [
      { id: 'oa1', credentialRef: 'R-oa1' },
      { id: 'oa2', credentialRef: 'R-oa2' },
      { id: 'oa3', credentialRef: 'R-oa3' },
    ]
    const visits: string[] = []

    const mkProvider = (withMainStart: boolean) => createOfficeAceCredentialProvider({
      permanentLocked: () => true,
      accounts: () => POOL,
      resolveUnlocked: async () => undefined,
      readCredential: async (ref: string) => {
        visits.push(ref)
        /** ⚠️ **全部成功** ⇒ 循环在**第一个号**就返回 ⇒ 首位 = 遍历顺序首位。 */
        return { basicAuthorization: 'x' } as never
      },
      readStoredCredential: () => undefined,
      summaryOf: async () => ({
        ok: true as const,
        /**
         * ⚠️ **必须有「近期到期」的桶**：
         *
         * 我踩过的三层：
         * | 版本 | 被卡在哪 |
         * |---|---|
         * | `{}` | `creditGroups is not iterable` |
         * | `creditGroups: [{remaining:100}]`（无到期日）| 归入 permanent ⇒ 锁定态判「没有可用账号」 |
         * | 正解 | **给一个 1 天后到期的桶** ⇒ 落在 imminent ⇒ 可用 |
         */
        summary: {
          creditGroups: [
            { remaining: 100, expired: false, expiresAt: new Date(Date.now() + 86_400_000).toISOString() },
          ],
        } as never,
      }),
      subagentPool: {
        subagentAssignmentOf: (_p: string, sid: string) =>
          (sid === 'child-1' ? { parentSessionId: 'main-1' } : undefined),
        subagentRotationFor: () => ({ startMode: 'sequence' }),
        listAccountsByProvider: () => POOL.map((a) => ({ id: a.id, enabled: true })),
        permanentLocked: () => true,
      },
      ...(withMainStart ? { mainStartIdOf: (_sid: string) => 'oa2' } : {}),
    } as never)

    visits.length = 0
    await mkProvider(true)('child-1')
    const withStart = visits[0]
    console.log('  [O2c] 注入 mainStartIdOf=oa2 ⇒ 首位:', withStart)

    visits.length = 0
    await mkProvider(false)('child-1')
    const withoutStart = visits[0]
    console.log('  [O2c] 不注入（退化成池首 oa1）⇒ 首位:', withoutStart)

    expect(withStart, '★★★ 注入 oa2 起点 ⇒ sequence 首位必须是 oa3').toBe('R-oa3')
    expect(withoutStart, '★★ 不注入 ⇒ 退化池首 oa1 ⇒ 首位 oa2').toBe('R-oa2')
    expect(
      withStart,
      '★★★ 两者必须不同（否则 P1-D 的修复不可观测）',
    ).not.toBe(withoutStart)
  })

  it('★★★ O3 deps.subagentPool 必须是可选的', () => {
    const code = readStripped('src/officeace-lock.ts')
    expect(code, 'subagentPool 必须声明为可选（否则破坏既有嵌入方）').toMatch(
      /readonly subagentPool\?\s*:\s*SubagentStartPoolLike/,
    )
  })

  /**
   * ## O4 缺失 pool 时必须**原路返回**
   *
   * 零回归的关键：单测替身 / 嵌入方不实现 `subagentPool` ⇒ 行为不变。
   */
  it('★★★ O4 无 subagentPool 时原样返回', () => {
    const code = readStripped('src/officeace-lock.ts')
    expect(code, '无 subagentPool 时必须原路返回（零回归）').toMatch(
      /const pool = deps\.subagentPool[\s\S]{0,80}?if \(pool === undefined\) return accounts/,
    )
  })

  /**
   * ## O5 异常必须被吞掉
   *
   * 选号是每发请求都要跑的路径，子代理判据的任何异常都不该让请求失败。
   */
  it('★★★ O5 异常时原路返回（选号不能因它失败）', () => {
    const code = readStripped('src/officeace-lock.ts')
    // orderAccountsForSubagent 里必须有 try/catch + catch 返回 accounts
    const at = code.indexOf('orderAccountsForSubagent')
    expect(at).toBeGreaterThan(-1)
    const block = code.slice(at, at + 2000)
    expect(block, '必须有 try').toMatch(/try\s*\{/)
    expect(
      block,
      'catch 必须原路返回 accounts（否则一次判据异常会让整个渠道不可用）',
    ).toMatch(/catch\s*\{[\s\S]{0,160}?return accounts/)
  })

  /**
   * ## O6 适配器必须**透传 sessionId**（否则整条链拿不到会话）
   *
   * ⚠️ 这是 officeace 独有的难点：`credentialProvider` 原本是**零参**，
   *    不改造就永远拿不到 sessionId ⇒ 子代理判据恒判「没配」。
   */
  it('★★★ O6 适配器必须把 sessionId 透传给 credentialProvider', () => {
    const code = readStripped('src/officeace-adapter.ts')
    expect(
      code,
      'credentialProvider 未收 sessionId ⇒ 子代理判据拿不到会话，恒判「没配」',
    ).toMatch(/credentialProvider\?\s*:\s*\(sessionId\?\s*:\s*string\)/)
    /**
     * ⚠️⚠️ **这两处必须分开断言**（变异实测）：
     *
     * 只断言「签名收了 sessionId」时，把 `stream()` 里的
     * `resolveCredential(options.sessionId)` 改回 `resolveCredential()`
     * **不会变红** —— 签名还在、传参没了，功能照样失效。
     *
     * ⇒ 签名（能不能收）+ 传参（有没有传）是**两条独立的腿**。
     */
    /**
     * ⚠️⚠️ **这条必须锚在 `stream()` 里那一处**（变异实测两次）：
     *
     * 第一版写成「文件里存在 `resolveCredential(options.sessionId)`」——
     * 而 `refresh` 重读那条（`renewed = await this.resolveCredential(options.sessionId)`）
     * 让判据**恒真** ⇒ 把 `stream()` 那处改回零参，用例照样绿（无牙）。
     *
     * ⇒ 判据必须限定在「`const credential = await …`」这个**唯一形态**上
     *（`refresh` 那处是 `const renewed = …`，两者前缀不同）。
     */
    expect(
      code,
      'stream() 必须把 options.sessionId 真的传下去（只改签名不够）',
    ).toMatch(/const credential = await this\.resolveCredential\(\s*options\.sessionId\s*\)/)
  })

  /**
   * ## O7 index.ts 必须注入 `subagentPool: pool`
   *
   * ⚠️ 只声明不注入 = 生产恒 `undefined` = 功能仍然无效
   *（本仓记录的「可选参数造成静默旁路」同型：windowMs 接了、imminentWindowMs 漏了）。
   */
  it('★★★ O7 index.ts 必须注入 subagentPool', () => {
    const code = readStripped('src/index.ts')
    expect(
      code,
      '没注入 subagentPool ⇒ 生产恒 undefined ⇒ officeace 的子代理设置仍然无效',
    ).toMatch(/createOfficeAceCredentialProvider\(\{[\s\S]{0,2500}?subagentPool:\s*pool/)
  })
})
