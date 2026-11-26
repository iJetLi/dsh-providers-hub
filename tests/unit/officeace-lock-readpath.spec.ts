/**
 * ★★★ **P0-C / P0-D 行为级守卫：officeace 锁定态的自举与起点参照**
 *
 * ## 上游登记（PR #168 合并时）
 *
 * > 「**P0-C / P0-D 零守卫**（`grep tests/` 对 `mainStartIdOf` 零命中）」
 *
 * ## 两个缺陷各是什么
 *
 * | 编号 | 缺陷 | 上游的修法 |
 * |---|---|---|
 * | **P0-C** | 锁定态登记鸡生蛋：分配表只能由登记写入、登记又要求 `parentSessionId` 非空 ⇒ **永远登记不上** ⇒ `isSubagentHere` 恒 false ⇒ 整条腿死代码 | 加 `resolveSubagentParent?` **兜底** |
 * | **P0-D** | 锁定态参照**池首**（没把主代理起点传进 `decideSubagentStart`）| 加 `mainStartIdOf?` 注入 |
 *
 * ## 为什么必须行为级
 *
 * 两条都是「**可选注入是否真的被用**」—— 源码里有 `deps.mainStartIdOf?.(…)` 不代表
 * 它接进了判据。本文件真跑 `createOfficeAceCredentialProvider`，观察**遍历顺序首位**。
 */
import { describe, expect, it } from 'vitest'

import { createOfficeAceCredentialProvider } from '../../src/officeace-lock.js'

const POOL = [
  { id: 'oa1', credentialRef: 'R-oa1' },
  { id: 'oa2', credentialRef: 'R-oa2' },
  { id: 'oa3', credentialRef: 'R-oa3' },
]

/** 合法且「近期到期」的订阅摘要（锁定态要求有临期额度，否则判「没有可用账号」）。 */
const expiringSummary = () => ({
  ok: true as const,
  summary: {
    creditGroups: [
      {
        remaining: 100,
        expired: false,
        // ⚠️ 1 天后到期 ⇒ 落在 imminent ⇒ 锁定态可用。
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      },
    ],
  } as never,
})

/**
 * 造一个锁定态 provider。
 *
 * @param options.withParentResolver - 是否注入 `resolveSubagentParent`（P0-C 的修复点）
 * @param options.mainStartId - 主代理起点（P0-D 的修复点）；`undefined` = 不注入
 * @param options.assignmentExists - 分配表里**预先**有没有该会话（决定是否走自举）
 */
function makeProvider(options: {
  withParentResolver: boolean
  mainStartId?: string
  assignmentExists: boolean
  visits: string[]
}) {
  /** 可变的分配表（`registerSubagentStartIfNeeded` 会往里写）。 */
  const assignments: Record<string, { parentSessionId?: string }> = options.assignmentExists
    ? { 'child-1': { parentSessionId: 'main-1' } }
    : {}

  return createOfficeAceCredentialProvider({
    permanentLocked: () => true,
    accounts: () => POOL,
    resolveUnlocked: async () => undefined,
    readCredential: async (ref: string) => {
      options.visits.push(ref)
      /** ⚠️ 全部成功 ⇒ 循环在**第一个号**就返回 ⇒ 首位 = 遍历顺序首位。 */
      return { basicAuthorization: 'x' } as never
    },
    readStoredCredential: () => undefined,
    summaryOf: expiringSummary,
    subagentPool: {
      subagentAssignmentOf: (_p: string, sid: string) => assignments[sid],
      subagentRotationFor: () => ({ startMode: 'sequence' }),
      listAccountsByProvider: () => POOL.map((a) => ({ id: a.id, enabled: true })),
      permanentLocked: () => true,
      /**
       * ★ **登记写入**：`registerSubagentStartIfNeeded` 会调它。
       * ⚠️ 必须真的写进 `assignments`，否则「自举」测不出来。
       */
      recordSubagentStart: async (
        _p: string, sid: string, parent: string,
      ) => {
        assignments[sid] = { parentSessionId: parent }
        return Object.keys(assignments).length - 1
      },
    },
    /** ★ P0-C 的修复点：父会话兜底。 */
    ...(options.withParentResolver
      ? { resolveSubagentParent: (_sid: string) => 'main-1' }
      : {}),
    /** ★ P0-D 的修复点：主代理起点。 */
    ...(options.mainStartId === undefined
      ? {}
      : { mainStartIdOf: (_sid: string) => options.mainStartId }),
  } as never)
}

describe('P0-C：锁定态登记自举（`resolveSubagentParent` 兜底）', () => {
  it('★★★ 分配表为空 + 有 `resolveSubagentParent` ⇒ **仍能算出起点**（自举成功）', async () => {
    /**
     * ## 缺陷形态
     *
     * 分配表只能由 `registerSubagentStartIfNeeded` 写，而它要求 `parentSessionId` 非空。
     * 若 `parentSessionId` 只从**分配表**取 ⇒ **鸡生蛋**：
     * 表空 ⇒ 拿不到 parent ⇒ 登记不上 ⇒ 表永远空 ⇒ `isSubagentHere` 恒 false
     * ⇒ **整条腿死代码**（上游实测：`registered=false` + 首位恒 `oa1`）。
     *
     * ## 修法
     *
     * `resolveSubagentParent?` 兜底（会话头 / 上层注入）。
     *
     * ## 判据
     *
     * 首位必须是**策略算出的号**（`sequence` 从池首往后 = `oa2`），而不是恒 `oa1`。
     */
    const visits: string[] = []
    const provider = makeProvider({
      withParentResolver: true,
      mainStartId: 'oa1',
      assignmentExists: false,
      visits,
    })
    await provider('child-1')
    console.log('  [P0-C 有兜底] 首位:', visits[0])
    expect(
      visits[0],
      '★★★ 自举成功 ⇒ 首位应是策略算出的 oa2（恒 oa1 = 自举失败、整条腿死代码）',
    ).toBe('R-oa2')
  })

  it('★★★ 反向对照：**没有** `resolveSubagentParent` + 表空 ⇒ 退化原序（首位 oa1）', async () => {
    /**
     * ⚠️ **没有这条，上一条的 `R-oa2` 可能只是别的原因碰巧。**
     * 这条证明「兜底注入」**真的承重**。
     */
    const visits: string[] = []
    const provider = makeProvider({
      withParentResolver: false,
      mainStartId: 'oa1',
      assignmentExists: false,
      visits,
    })
    await provider('child-1')
    console.log('  [P0-C 无兜底] 首位:', visits[0])
    expect(
      visits[0],
      '★★ 无兜底 + 表空 ⇒ 登记不上 ⇒ 原样返回 ⇒ 首位 oa1',
    ).toBe('R-oa1')
  })
})

describe('P0-D：锁定态起点参照（`mainStartIdOf` 注入）', () => {
  /**
   * ## 为什么起点选 `oa2`
   *
   * 池 `[oa1, oa2, oa3]`、`sequence` slot=0：
   *
   * | 主代理起点 | `(idx+1)%3` | 首位 | 与池首相同？ |
   * |---|---|---|---|
   * | oa1（池首）| `1` | oa2 | ❌ 不同 |
   * | **oa2** | `2` | **oa3** | ❌ 不同 ✅ |
   * | oa3 | `0` | oa1 | **相同** ⚠️ 分不开 |
   *
   * ⇒ 用 `oa2`：注入时应得 `oa3`；不注入（退化池首 oa1）时应得 `oa2`
   * ⇒ **两者不同，能证明注入真的生效**。
   */
  it('★★★ 注入 `mainStartIdOf = oa2` ⇒ 首位必须换成 `oa3`', async () => {
    const visits: string[] = []
    const provider = makeProvider({
      withParentResolver: true,
      mainStartId: 'oa2',
      assignmentExists: true,
      visits,
    })
    await provider('child-1')
    console.log('  [P0-D 注入 oa2] 首位:', visits[0])
    expect(
      visits[0],
      '★★★ 起点 oa2 ⇒ sequence 首位必须是 oa3（得 oa2 = 没参照主代理起点）',
    ).toBe('R-oa3')
  })

  it('★★★ 反向对照：**不注入** ⇒ 退化池首 ⇒ 首位 `oa2`', async () => {
    const visits: string[] = []
    const provider = makeProvider({
      withParentResolver: true,
      /** ⚠️ 不传 `mainStartId` ⇒ 退化池首 oa1。 */
      assignmentExists: true,
      visits,
    })
    await provider('child-1')
    console.log('  [P0-D 不注入] 首位:', visits[0])
    expect(visits[0], '★★ 不注入 ⇒ 池首 oa1 ⇒ 首位 oa2').toBe('R-oa2')
  })
})
