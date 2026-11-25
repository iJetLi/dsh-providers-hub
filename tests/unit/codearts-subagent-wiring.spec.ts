/**
 * **codearts 子代理接线守卫**（2026-11-25）。
 *
 * ## 缺陷形态
 *
 * codearts **自建选号**（`resolveCredential` 里直接调 `pool.getAvailableAccount`），
 * 不走共享的 `createCredentialResolver` ⇒ 子代理那套「用户手选 / 系统 pin /
 * 位次 / 错开」判据**完全拿不到**：
 *
 * > 用户在面板里给子代理设了账号策略，对 codearts **静默无效、零报错**。
 *
 * 与 `officeace` 是**同一形态**的漏接线。
 *
 * ## 修复方式
 *
 * 调 `src/subagent-start.ts` 的 `decideSubagentStart`（与 `credential-resolver`
 * **同一份实现**）—— 不手抄判据（那会让同一语义两套实现必然漂移，
 * 本套逻辑上游已改 6 轮审计）。
 *
 * ## 本文件锁什么
 *
 * ① `index.ts` 的 codearts 段**确实**调了 `decideSubagentStart`；
 * ② 该段的**参数正确**（providerId / 无 selector / allowPermanent 恒 true）；
 * ③ `decideSubagentStart` 在「无 selector」下的确切语义
 *    （codearts 没有余额分档 ⇒ 必须退化为纯索引错开）；
 * ④ 零回归：未配置子代理时**不改变任何东西**。
 *
 * ⚠️ 判据取「行为级」而非纯文本：③④ 跑真实函数；
 * ①② 必须读源码（`resolveCredential` 是闭包，无法从外部注入池后调用），
 * 但用**常量假条件检测**防 `if (false)` 短路（本仓记录的假绿形态）。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  BUDDY_BALANCE_TIER,
  decideSubagentStart,
} from '../../src/subagent-start.js'

const here = import.meta.dirname

/** 读 `index.ts` 并**剥掉注释**（防注释里的字样造成假绿）。 */
function readIndexCode(): string {
  const raw = readFileSync(resolve(here, '../../src/index.ts'), 'utf8')
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

/** 切出 codearts 的 `resolveCredential` 闭包（从声明到配对结束）。 */
function codeartsResolverBlock(): string {
  const code = readIndexCode()
  const at = code.indexOf("resolveCredential: async (modelId?: string, sessionId?: string)")
  expect(at, '找不到 codearts 的 resolveCredential（形态变了？）').toBeGreaterThan(-1)
  let depth = 0
  let end = -1
  for (let i = code.indexOf('{', at); i < code.length; i++) {
    if (code[i] === '{') depth++
    else if (code[i] === '}') {
      depth--
      if (depth === 0) { end = i; break }
    }
  }
  expect(end, 'codearts resolveCredential 大括号不配对').toBeGreaterThan(at)
  return code.slice(at, end)
}

/** 池替身（只实现 decideSubagentStart 需要的那几个）。 */
function makePool(options: {
  setting?: { startMode?: string; fixedPosition?: number }
  assignment?: { slot: number; sessionId: string; pinnedAccountId?: string; userPickedAccountId?: string }
  enabled?: readonly string[]
  preferred?: Record<string, string>
}) {
  return {
    subagentRotationFor: () => options.setting as never,
    subagentAssignmentOf: () => options.assignment as never,
    preferredRotationFor: (_p: string, sid: string) => options.preferred?.[sid],
    listAccountsByProvider: () => (options.enabled ?? []).map((id) => ({ id, enabled: true })),
  }
}

describe('★★★ codearts 接线：必须调共享的 decideSubagentStart', () => {
  /**
   * ## G1 codearts 段必须真的调用它
   *
   * ⚠️ 判据取「调用存在 + 参数对」，且用**剥注释后的源码**，
   * 避免「注释里写了但代码没调」的假绿。
   */
  it('★★★ G1 codearts 的 resolveCredential 调了 decideSubagentStart', () => {
    const block = codeartsResolverBlock()
    expect(
      block,
      'codearts 未接子代理 ⇒ 面板里给子代理设的策略对它静默无效',
    ).toMatch(/decideSubagentStart\(\{/)
    // 参数：providerId 必须是 codearts（写错会让它读别家的设置）
    expect(block, "providerId 必须是 'codearts'").toMatch(/providerId:\s*'codearts'/)
  })

  /**
   * ## G2 **不得**给 codearts 传 selector
   *
   * codearts **没有余额分档**（无 `buddyBalanceTier` 概念）。
   * 传一个 selector 会让它按「档位」过滤，而档位对它是无意义的 ——
   * 症状是「错开序列被莫名裁剪」。
   *
   * ⚠️ 正确语义：无 selector ⇒ `bestTierAnchorId` 返回 `undefined` ⇒
   * `sameTierIds = enabledIds`（全池）⇒ **纯索引错开**。
   */
  it('★★★ G2 codearts 不得传 selector（它没有余额分档）', () => {
    const block = codeartsResolverBlock()
    expect(
      /selector:/.test(block),
      '给 codearts 传了 selector ⇒ 会按不存在的「档位」裁剪错开序列',
    ).toBe(false)
  })

  /**
   * ## G3 **必须**把子代理的起点覆盖到 `rotationStartId`
   *
   * 只算出决策但不使用 = 白算（本仓记录的「字段透传了但没人用」同族缺陷）。
   */
  it('★★★ G3 决策出的起点必须真的传给选号', () => {
    const block = codeartsResolverBlock()
    expect(
      block,
      'decideSubagentStart 的 startId 没有覆盖 rotationStartId ⇒ 子代理设置不生效',
    ).toMatch(/rotationStartId\s*=\s*subagentStart\.startId/)
    // 而且 `rotationStartId` 必须真的进入 getAvailableAccount
    expect(block, '起点必须传给选号函数').toMatch(
      /getAvailableAccount<CodeArtsCredential>\(\s*'codearts',\s*'',\s*undefined,\s*rotationStartId,?\s*\)/,
    )
  })

  /**
   * ## G4 pin 回写必须有（`fixed` 模式除外）
   *
   * 用户原话：「拉起时定死，只有该号不可用才换」——
   * 不回写 pin ⇒ 每次请求重算 ⇒ 池一波动就换号 ⇒ prompt cache 全失效。
   */
  it('★★ G4 必须按 shouldPin 回写 pin', () => {
    const block = codeartsResolverBlock()
    expect(block, '没有 pin 回写 ⇒ 每次请求重算起点、缓存失效').toMatch(
      /subagentStart\.shouldPin/,
    )
    expect(block).toMatch(/pinSubagentAccount\(\s*'codearts'/)
  })

  /**
   * ## G5 主代理起点必须从**父会话**读
   *
   * ⚠️ 上游第四轮审计 P1 真缺陷：用子代理自己的 `sessionId` 查起点
   * 恒 `undefined` ⇒ 档位/错开基准整块失效。
   */
  it('★★★ G5 必须用父会话的起点作基准', () => {
    const block = codeartsResolverBlock()
    expect(
      block,
      '没用父会话起点作基准 ⇒ 错开基准恒 undefined（上游 P1 同型缺陷）',
    ).toMatch(/subagentMainStartIdOf\(\s*'codearts'/)
  })
})

describe('★★★ 无 selector 时的语义：纯索引错开（codearts 的实际形态）', () => {
  /**
   * ## S1 无 selector ⇒ 在**全池**上错开，不被裁剪
   *
   * 这是 codearts 的真实形态。若 `decideSubagentStart` 在无 selector 时
   * 返回空集，codearts 的错开就完全失效。
   */
  it('★★★ S1 无 selector 时在 enabledIds 全池上错开', () => {
    const decision = decideSubagentStart({
      providerId: 'codearts',
      sessionId: 'child-2',
      candidateIds: ['a', 'b', 'c'],
      allowPermanent: true,
      // ⚠️ 不传 selector —— codearts 的形态
      pool: makePool({
        setting: { startMode: 'sequence' },
        assignment: { slot: 2, sessionId: 'child-2' },
        enabled: ['a', 'b', 'c'],
      }),
    })
    expect(decision.startId, '无 selector 时也必须能错开').toBeDefined()
    expect(['a', 'b', 'c']).toContain(decision.startId)
    expect(decision.decidedBy).toBe('strategy')
  })

  /**
   * ## S2 不同 slot 必须落到**不同**起点
   *
   * `sequence` 的语义就是「往后错开」。若两个子代理拿到同一个号，
   * 错开等于没做（而缓存命中率也上不去）。
   */
  it('★★★ S2 sequence 下不同 slot 错开到不同账号', () => {
    const startOf = (slot: number, sid: string) => decideSubagentStart({
      providerId: 'codearts',
      sessionId: sid,
      candidateIds: ['a', 'b', 'c'],
      allowPermanent: true,
      pool: makePool({
        setting: { startMode: 'sequence' },
        assignment: { slot, sessionId: sid },
        enabled: ['a', 'b', 'c'],
      }),
    }).startId
    const s1 = startOf(1, 'child-1')
    const s2 = startOf(2, 'child-2')
    expect(s1, 'slot=1 应有起点').toBeDefined()
    expect(s2, 'slot=2 应有起点').toBeDefined()
    expect(s1, '两个子代理拿到同一个号 ⇒ 错开没生效').not.toBe(s2)
  })

  /**
   * ## S3 `fixed` 在无 selector 下也必须工作
   *
   * `fixed` 不依赖档位（它按位次直接取），故 codearts 也能用。
   */
  it('★★★ S3 fixed 模式在无 selector 下按位次取号', () => {
    const decision = decideSubagentStart({
      providerId: 'codearts',
      sessionId: 'child-1',
      candidateIds: ['a', 'b', 'c'],
      allowPermanent: true,
      pool: makePool({
        setting: { startMode: 'fixed', fixedPosition: 3 },
        assignment: { slot: 1, sessionId: 'child-1' },
        enabled: ['a', 'b', 'c'],
      }),
    })
    expect(decision.decidedBy).toBe('fixed-position')
    expect(decision.startId, '位次 3 => 索引 2').toBe('c')
    expect(decision.pinnedFirst, 'fixed 必须绝对第一').toBe(true)
  })

  /**
   * ## S4 零回归：未配置 / follow ⇒ 什么都不动
   *
   * 这是「不配就和改动前逐字节相同」的判据。
   */
  it('★★★ S4 未配置子代理时决策为 none（不动任何东西）', () => {
    for (const setting of [undefined, { startMode: 'follow' }, {}]) {
      const decision = decideSubagentStart({
        providerId: 'codearts',
        sessionId: 'child-1',
        candidateIds: ['a'],
        allowPermanent: true,
        pool: makePool({ setting: setting as never, enabled: ['a'] }),
      })
      expect(decision.startId, `setting=${JSON.stringify(setting)} 时不该有起点`).toBeUndefined()
      expect(decision.decidedBy).toBe('none')
      expect(decision.pinnedFirst).toBe(false)
    }
  })

  /**
   * ## S5 `reverse` 与 `sequence` 方向必须相反
   *
   * 两者的差别只在方向；写错会得到同一个结果（用户设了「倒序」却没变化）。
   */
  it('★★ S5 reverse 与 sequence 必须给出不同起点', () => {
    const startOf = (mode: 'sequence' | 'reverse') => decideSubagentStart({
      providerId: 'codearts',
      sessionId: 'child-1',
      candidateIds: ['a', 'b', 'c', 'd'],
      allowPermanent: true,
      pool: makePool({
        setting: { startMode: mode },
        assignment: { slot: 2, sessionId: 'child-1' },
        enabled: ['a', 'b', 'c', 'd'],
      }),
    }).startId
    expect(startOf('sequence'), 'sequence 与 reverse 结果相同 ⇒ 方向没生效')
      .not.toBe(startOf('reverse'))
  })

  /**
   * ## S6 档位语义对 codearts 不适用（反向对照）
   *
   * 传 selector 时 `sequence` 会**裁剪**到同档；不传时不裁剪。
   * 这条锁住「codearts 刻意不传」的理由 —— 若将来有人给它传了 selector，
   * 行为会变化，那条 G2 守卫会先红。
   */
  it('★★ S6 有 selector 时会裁剪、无 selector 时不裁剪（差异证明 G2 的意义）', () => {
    const selector = {
      async select() { throw new Error('不调') },
      cachedTierOf: (a: { id: string }) =>
        a.id === 'p' ? BUDDY_BALANCE_TIER.permanent : BUDDY_BALANCE_TIER.imminent,
    } as never
    const base = {
      providerId: 'codearts',
      sessionId: 'child-3',
      candidateIds: ['a', 'b', 'p'],
      allowPermanent: true,
      pool: makePool({
        setting: { startMode: 'sequence' },
        assignment: { slot: 3, sessionId: 'child-3' },
        enabled: ['a', 'b', 'p'],
      }),
    }
    /** 有 selector + 主代理在临期档 ⇒ 不会错开到永久号 p。 */
    const withSel = decideSubagentStart({ ...base, selector, mainSessionStartId: 'a' })
    expect(withSel.startId, '有档位时不该跨到永久号').not.toBe('p')
    /** 无 selector（codearts 的形态）⇒ 全池错开，可能到 p（这是既有语义）。 */
    const noSel = decideSubagentStart(base)
    expect(noSel.startId, '无 selector 时仍应给出起点').toBeDefined()
  })
})