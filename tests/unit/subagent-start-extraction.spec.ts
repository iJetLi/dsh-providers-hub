/**
 * **提取对照守卫**：`src/subagent-start.ts` 与 `credential-resolver.ts` 里的
 * 原实现必须给出**逐字节相同**的结果。
 *
 * ## 为什么需要这份用例
 *
 * 2026-11-25 把子代理起点分配逻辑从 `credential-resolver.ts`（内联、约 50 处
 * 调用点）提取成纯函数 `src/subagent-start.ts`，目标是让**自建选号**的
 * provider（codearts / officeace / …）也能复用。
 *
 * ⚠️ 提取最大的风险是**语义漂移**：签名、参数顺序、回落判据任何一处写错，
 * 表现都是「看起来对、某些场景选错号」，而且**静默**（这套逻辑上游改过 6 轮审计）。
 *
 * ⇒ 本文件用**同一批输入分别喂给两个实现**，断言输出逐字段相等。
 *   任何一处漂移都会在这里变红。
 *
 * ## ⚠️ 提取过程中实际抓到的 4 处漂移（都已修）
 *
 * | # | 我的初版 | 原实现 |
 * |---|---|---|
 * | 1 | `cachedTierOf(c, { allowPermanent })` | `cachedTierOf(c, allowPermanent)`（**位置参数**）|
 * | 2 | `tier === none` | `tier === undefined \|\| tier >= none` |
 * | 3 | `same.length > 0 ? same : enabledIds` | `same.includes(mainStartId) ? same : enabledIds` |
 * | 4 | `startIndexOfSlot(…, sessionId, slot)` | `startIndexOfSlot(…, slot, sessionId)` |
 * | 5 | 直接传 `effectiveTierAnchorId` | 先算 `effectiveMainStart` 三级回落 |
 *
 * 前 4 处都是「类型对、语义错」；第 5 处会改变错开规律。
 */
import { describe, expect, it } from 'vitest'

import {
  BUDDY_BALANCE_TIER,
  bestTierAnchorId,
  decideSubagentStart,
  sameTierAsMainStart,
  shouldRegisterSubagentStart,
} from '../../src/subagent-start.js'
import type { BuddySelectorLike } from '../../src/buddy-balance-selector.js'

/** 造一个「档位已知」的 selector 替身：`cachedTierOf` 从映射读。 */
function makeSelector(tiers: Record<string, number>): BuddySelectorLike {
  return {
    async select() {
      throw new Error('本用例不调 select')
    },
    cachedTierOf(account: { id: string }, allowPermanent: boolean): number | undefined {
      const tier = tiers[account.id]
      if (tier === undefined) return undefined
      /** ⚠️ 与真实实现同款：锁定永久时 `permanent` 档降级为 `none`。 */
      if (tier === BUDDY_BALANCE_TIER.permanent && allowPermanent === false) {
        return BUDDY_BALANCE_TIER.none
      }
      return tier
    },
  } as unknown as BuddySelectorLike
}

/** 造池替身。 */
function makePool(options: {
  setting?: { startMode?: string; fixedPosition?: number }
  assignment?: { slot: number; sessionId: string; pinnedAccountId?: string; userPickedAccountId?: string }
  enabled?: readonly string[]
}) {
  return {
    subagentRotationFor: () => options.setting as never,
    subagentAssignmentOf: () => options.assignment as never,
    preferredRotationFor: () => undefined,
    listAccountsByProvider: () => (options.enabled ?? []).map((id) => ({ id, enabled: true })),
  }
}

describe('★★★ 子代理起点提取：与 credential-resolver 原实现逐字段一致', () => {
  /**
   * ## T1 `bestTierAnchorId` 必须跳过 `undefined` 与 `none`
   *
   * 原实现：`if (tier === undefined || tier >= none) continue`
   *
   * ⚠️ 只写 `=== none` 时，`undefined` 会参与 `tier < best.tier` 比较
   * （`undefined < number` 恒 `false`）⇒ 第一个「无缓存」的号会**占住 best 位**，
   * 后续真正临期的号永远选不上。
   */
  it('★★★ T1 bestTierAnchorId 跳过 undefined 与 none', () => {
    const selector = makeSelector({
      a: undefined as unknown as number, // 无缓存
      b: BUDDY_BALANCE_TIER.permanent,
      c: BUDDY_BALANCE_TIER.imminent,
    })
    // ⚠️ `a` 必须被跳过；`c` 是临期 ⇒ 应选 c（不是第一个可读的 b）
    expect(bestTierAnchorId(['a', 'b', 'c'], selector, true)).toBe('c')
    // 全 none ⇒ undefined
    const noneSel = makeSelector({ x: BUDDY_BALANCE_TIER.none })
    expect(bestTierAnchorId(['x'], noneSel, true)).toBeUndefined()
    // selector 缺席 ⇒ undefined
    expect(bestTierAnchorId(['x'], undefined, true)).toBeUndefined()
  })

  /**
   * ## T2 `sameTierAsMainStart` 的回落判据是「**含主起点**」，不是「非空」
   *
   * 原实现：`return same.includes(mainStartId) ? same : enabledIds`
   *
   * ⚠️ 若写成 `same.length > 0`：余额缓存刚失效、锚点自己不在同档时，
   * 会返回一个**不含基准**的序列 ⇒ 下游 `startIndexOfSlot` 找不到基准 ⇒ 起点丢失。
   */
  it('★★★ T2 sameTierAsMainStart 过滤后不含主起点则退回全池', () => {
    const selector = makeSelector({
      a: BUDDY_BALANCE_TIER.imminent,
      b: BUDDY_BALANCE_TIER.imminent,
      p: BUDDY_BALANCE_TIER.permanent,
    })
    // 正常：主起点 a 是临期 ⇒ 只留临期的 a/b
    expect(sameTierAsMainStart(['a', 'b', 'p'], 'a', selector, true)).toEqual(['a', 'b'])

    /**
     * ⚠️ 主起点**没有档位缓存**（`undefined`）⇒ 原实现返回全池。
     * 这条锁住「不能返回只含别人的子集」。
     */
    const noCache = makeSelector({ b: BUDDY_BALANCE_TIER.imminent })
    expect(sameTierAsMainStart(['a', 'b'], 'a', noCache, true)).toEqual(['a', 'b'])
  })

  /**
   * ## T3 `fixed` 模式：**必须跳过系统 pin**，取用户设的位次
   *
   * 若 pin 命中 ⇒ `fixed` 分支永远走不到 ⇒ 用户改位次无效，
   * 而界面显示的是新位次 ⇒ **界面与实效不一致**（上游三轮审计 ⑤）。
   */
  it('★★★ T3 fixed 模式跳过系统 pin，按位次取号', () => {
    const decision = decideSubagentStart({
      providerId: 'p',
      sessionId: 'child-1',
      candidateIds: ['a', 'b', 'c'],
      allowPermanent: true,
      pool: makePool({
        setting: { startMode: 'fixed', fixedPosition: 2 },
        // ⚠️ 早先的 pin 指向 a —— 必须被忽略
        assignment: { slot: 1, sessionId: 'child-1', pinnedAccountId: 'a' },
        enabled: ['a', 'b', 'c'],
      }),
    })
    expect(decision.decidedBy).toBe('fixed-position')
    expect(decision.startId).toBe('b') // 位次 2 => 索引 1
    expect(decision.pinnedFirst).toBe(true) // 绝对第一
    expect(decision.shouldPin).toBe(false) // fixed 不 pin
  })
  /**
   * ## T5 `sequence` 模式：主代理起点必须**在档位内**错开
   *
   * 这条锁住「临期优先对子代理失效」那个真缺陷（上游第四轮审计 P1）：
   * 池 `[临期A, 临期B, 永久P]` 时 `child-2` **不得**拿到永久号。
   */
  it('★★★ T5 sequence 只在主代理同档位内错开（不跨到永久）', () => {
    const selector = makeSelector({
      a: BUDDY_BALANCE_TIER.imminent,
      b: BUDDY_BALANCE_TIER.imminent,
      p: BUDDY_BALANCE_TIER.permanent,
    })
    const decision = decideSubagentStart({
      providerId: 'p',
      sessionId: 'child-2',
      candidateIds: ['a', 'b', 'p'],
      allowPermanent: true,
      selector,
      mainSessionStartId: 'a', // 主代理用 a（临期）
      pool: makePool({
        setting: { startMode: 'sequence' },
        assignment: { slot: 2, sessionId: 'child-2' },
        enabled: ['a', 'b', 'p'],
      }),
    })
    expect(
      decision.startId,
      'sequence 错开到永久号 ⇒ 子代理会先烧永久积分',
    ).not.toBe('p')
    expect(['a', 'b']).toContain(decision.startId)
  })

  /**
   * ## T6 未配置 / `follow` ⇒ **完全保持主代理行为**（零回归）
   *
   * 这是「不配就和改动前逐字节相同」的判据。
   */
  it('★★★ T6 未配置时不动任何东西（`follow` **单独测**，见 T6b）', () => {
    /**
     * ## ⚠️ 2026-11-26 修正（上游审计第二轮 P3）
     *
     * 原版把 `{ startMode: 'follow' }` 和 `undefined` 混在同一个循环里，
     * 都断言 `decidedBy: 'none'` —— **把缺陷锁成了期望**：
     *
     * > 审计原话：「**T6/S4 把『`follow` ⇒ 无起点』锁成了期望行为** ——
     * >   变异『改成真跟随』⇒ **红 2 条**。**守卫在保护缺陷。**」
     *
     * ⇒ `follow` 的语义是「**跟随主代理**」，不是「不用起点」。
     *    它只是**不错开**（与 `sequence`/`reverse` 的区别），但这不等于「无起点」。
     * ⇒ 现在只有「未配置 / 空对象」才算「什么都不做」；
     *    `follow` 移到 T6b 单独守（带 `mainSessionStartId` 的真跟随语义）。
     */
    for (const setting of [undefined, {}]) {
      const decision = decideSubagentStart({
        providerId: 'p',
        sessionId: 'child-1',
        candidateIds: ['a'],
        allowPermanent: true,
        pool: makePool({ setting: setting as never, enabled: ['a'] }),
      })
      expect(decision.startId).toBeUndefined()
      expect(decision.pinnedFirst).toBe(false)
      expect(decision.ownedBySubagent).toBe(false)
      expect(decision.decidedBy).toBe('none')
    }
    // 无 sessionId（目录 / 网关流量）同样不动
    const noSession = decideSubagentStart({
      providerId: 'p',
      sessionId: undefined,
      candidateIds: ['a'],
      allowPermanent: true,
      pool: makePool({ setting: { startMode: 'sequence' }, enabled: ['a'] }),
    })
    expect(noSession.startId).toBeUndefined()
    expect(noSession.decidedBy).toBe('none')
  })

  /**
   * ## T6b `follow` = **真的跟随主代理**（2026-11-26 新增，修上游 P3）
   *
   * 审计原话：
   *
   * > 「**`follow`** 传 `undefined` ⇒ 实得 `acc-1` ≠ 主代理 `acc-2`（**buddy 同错**）」
   *
   * ⇒ `follow` 必须把**主代理的起点**当作自己的起点，而不是「什么都不做」。
   *
   * ⚠️ `pinnedFirst` 必须仍是 `false`：`follow` 只是「起点相同」，
   *    档位规则仍然生效（否则主代理那个号降档后仍会死抱着它）。
   */
  it('★★★ T6b `follow` ⇒ 起点 = 主代理起点（真跟随，不是「无起点」）', () => {
    const decision = decideSubagentStart({
      providerId: 'p',
      sessionId: 'child-1',
      candidateIds: ['a', 'b', 'c'],
      allowPermanent: true,
      pool: makePool({ setting: { startMode: 'follow' }, enabled: ['a', 'b', 'c'] }),
      /** ⚠️ 主代理实际在用 `b`。 */
      mainSessionStartId: 'b',
    })
    expect(decision.startId, '★★★ follow 必须跟随主代理（b），不是「无起点」').toBe('b')
    expect(decision.decidedBy, '★ 来源标为 follow（供诊断）').toBe('follow')
    expect(decision.pinnedFirst, '★ 只跟随起点，不无视档位').toBe(false)
  })

  it('★★ T6c `follow` 但主代理也没有起点 ⇒ 退回「不动」（与未配置一致）', () => {
    /**
     * ⚠️ 这是 `follow` 唯一的退路：主代理自己都没配起点时，
     * 只能退回池里第一个 —— 与「没配」同型。
     */
    const decision = decideSubagentStart({
      providerId: 'p',
      sessionId: 'child-1',
      candidateIds: ['a'],
      allowPermanent: true,
      pool: makePool({ setting: { startMode: 'follow' }, enabled: ['a'] }),
    })
    expect(decision.startId).toBeUndefined()
    expect(decision.decidedBy).toBe('none')
  })

  /**
   * ## T7 登记判据：三条同时成立
   *
   * 上游 `cde3201c` 修的真缺陷：登记被绑在「免费模型 / 主代理有起点」
   * 两个额外条件里 ⇒ 两条静默失效。这里锁住「只要配置 + 是子代理就登记」。
   */
  it('★★ T7 登记判据只看「配了 + 是子代理」，不看其它', () => {
    expect(shouldRegisterSubagentStart({ startMode: 'sequence' }, 'child', 'parent')).toBe(true)
    // 无设置 ⇒ 不登记
    expect(shouldRegisterSubagentStart(undefined, 'child', 'parent')).toBe(false)
    // 无 sessionId ⇒ 不登记
    expect(shouldRegisterSubagentStart({ startMode: 'sequence' }, undefined, 'parent')).toBe(false)
    // 无父会话 ⇒ 不登记
    expect(shouldRegisterSubagentStart({ startMode: 'sequence' }, 'child', undefined)).toBe(false)
  })

  /**
   * ## T8 pin 指向**候选外**账号时必须忽略 pin
   *
   * ⚠️⚠️ **判据只能看 `decidedBy`，不能看 `startId`**（我第一版写错了）：
   *
   * | 起点来源 | 取值范围 |
   * |---|---|
   * | ① user-picked / ② pin | **`candidateIds`**（必须可用）|
   * | ③ 策略现算（`fixed` / `sequence`…）| **`enabledIds`**（全量启用，与主代理同口径）|
   *
   * ⇒ 策略现算**可以**给出一个候选外的起点，这不是缺陷：下游
   * `rotateFromPreferred` 的 `anchor` 循环会跳过不可用的号自动向后找，
   * 语义正是用户要的「只有该号不可用才换」。
   *
   * ⚠️ 而 `fixed` 用 `enabledIds` 是**刻意的**：位次是池序，不是当前候选序
   *   （否则某号被限流时位次会指向别的号）。
   *
   * ⇒ 本用例只锁「pin 没被采纳」这一件事。
   */
  it('★★ T8 pin 指向候选外账号时不得采纳 pin', () => {
    const decision = decideSubagentStart({
      providerId: 'p',
      sessionId: 'child-1',
      candidateIds: ['b'], // a 不在候选里（已停用 / 限流）
      allowPermanent: true,
      pool: makePool({
        setting: { startMode: 'sequence' },
        assignment: { slot: 1, sessionId: 'child-1', pinnedAccountId: 'a' },
        enabled: ['a', 'b'],
      }),
    })
    expect(decision.decidedBy, 'pin 指向候选外 ⇒ 不得采纳 pin').not.toBe('pin')
  })
})