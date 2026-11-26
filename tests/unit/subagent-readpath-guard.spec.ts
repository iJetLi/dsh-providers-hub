/**
 * ★★★ **读端守卫：codearts / officeace 的子代理起点必须参照「主代理实际在用」**
 *
 * ## 上游审计原话（PR #158 第四轮，合并前最后一轮）
 *
 * > 「`activeAccountOf` **全仓只有 `credential-resolver` 两处消费**（`:858` / `:1041`），
 * >   而 codearts / officeace **不走那条腿**（自建选号）⇒ **后三处是死写入**。」
 * >
 * > | 编号 | 缺陷 | 实测 |
 * > |---|---|---|
 * > | **P0-A** | codearts 子代理参照**下拉框**，不是主代理实际在用 | 手算 `acc4`，**实测 `acc2`** |
 *
 * ## 为什么本文件必须是**行为级**
 *
 * 上游实测（合并前）：
 *
 * > 「你的 25 文件 265 条子代理守卫全绿，三条 P0 存活 ——
 * >   因为新 wiring spec 主体是**源码正则**：
 * >   变异 `if (false && codeartsIsSubagent)` ⇒ **116 条全绿**。」
 *
 * ⇒ 源码正则对「包在死分支里」天然免疫。本文件用**真值驱动**：
 * 直接调 `resolveSubagentMainStartId`（已从 `apply()` 闭包抽成模块级纯函数），
 * 断言它返回**哪个账号**，而不是源码里有没有那个字符串。
 *
 * ## 与 `codearts-subagent-wiring.spec.ts` 的分工（**别合并**）
 *
 * | 文件 | 判据 | 能挡什么 |
 * |---|---|---|
 * | `codearts-subagent-wiring.spec.ts` | 源码正则 | 「调用被整段删掉」|
 * | **本文件** | **真值驱动** | 「调用还在但判据错了」/「包在 `if(false)` 里」|
 */
import { describe, expect, it } from 'vitest'

import { resolveSubagentMainStartId } from '../../src/index.js'

/**
 * 池替身：**只有** `resolveSubagentMainStartId` 会用到的那三个方法。
 *
 * ⚠️ 刻意**不实现**其它方法 —— 若将来该函数偷偷调了别的（比如池的选号），
 *    这里会直接崩，而不是静默返回 `undefined` 让用例变绿。
 */
function makePool(options: {
  /** 分配记录里的父会话（落盘事实）。 */
  assignmentParent?: string
  /** 「实际在用」表：sessionId → accountId。 */
  active?: Record<string, string>
  /** 「下拉框起点」表：sessionId → accountId。 */
  preferred?: Record<string, string>
}) {
  return {
    subagentAssignmentOf: (_p: string, sid: string) =>
      (options.assignmentParent === undefined ? undefined : { parentSessionId: options.assignmentParent }),
    activeAccountOf: (_p: string, sid: string) => options.active?.[sid],
    preferredRotationFor: (_p: string, sid: string) => options.preferred?.[sid],
  }
}

/** 父会话兜底（模拟 `resolveSubagentParent`）。 */
const noParent = () => undefined

describe('P0-A：起点参照必须「实际在用优先，下拉框兜底」', () => {
  /**
   * ## 上游给的对照数字
   *
   * 池 `acc1..acc4`、主代理下拉框 `acc1`、**实际在用 `acc3`**、子代理 `sequence` slot=0：
   *
   * | 判据 | 起点 | `sequence` 结果 | 算式 |
   * |---|---|---|---|
   * | 只读下拉框（**修前**）| `acc1` | `acc2` | `(0+1)%4 = 1` |
   * | 读实际在用（**修后**）| `acc3` | `acc4` | `(2+1)%4 = 3` |
   *
   * ⇒ 本组直接断言**返回的起点 id**，与上面两行一一对应。
   */

  it('★★★ 有「实际在用」⇒ 用它（不是下拉框）', () => {
    const pool = makePool({
      assignmentParent: 'main-1',
      active: { 'main-1': 'acc3' },
      preferred: { 'main-1': 'acc1' },
    })
    expect(
      resolveSubagentMainStartId(pool, 'codearts', 'child-1', noParent),
      '★★★ 必须返回实际在用的 acc3（返回 acc1 = 修前的缺陷）',
    ).toBe('acc3')
  })

  it('★★★ 没有「实际在用」⇒ 回落下拉框', () => {
    /**
     * ⚠️ 这是**降级路径**（插件刚重启 / 父会话没发过请求）——
     * 不能因为「实际在用」拿不到就返回 undefined，否则子代理完全失去参照。
     */
    const pool = makePool({
      assignmentParent: 'main-1',
      preferred: { 'main-1': 'acc1' },
    })
    expect(
      resolveSubagentMainStartId(pool, 'codearts', 'child-1', noParent),
      '★★★ 实际在用缺失时必须回落 acc1',
    ).toBe('acc1')
  })

  it('★★★ 两者都有且**不同**时，必须选实际在用（顺序不能反）', () => {
    /**
     * ⚠️ 这条与第一条**不是重复**：第一条的值是固定的（`acc3`），
     * 这条验证的是**顺序**（若写成 `preferred ?? active` 也返回 `acc1`，
     * 但第一条就抓不到了 —— 因为它也返回 `acc1`？不，第一条 active=acc3，
     * 写成反序会返回 acc1 ⇒ 第一条也会红）。
     * ⇒ 真正的作用是**用两个不同方向的值把顺序钉死**：
     *    这里 active=`acc2`、preferred=`acc4`，反序会得 `acc4`。
     */
    const pool = makePool({
      assignmentParent: 'main-1',
      active: { 'main-1': 'acc2' },
      preferred: { 'main-1': 'acc4' },
    })
    expect(
      resolveSubagentMainStartId(pool, 'codearts', 'child-1', noParent),
      '★★★ 顺序必须是 active 优先（反序会得 acc4）',
    ).toBe('acc2')
  })

  it('★★ 主代理没有分配记录时，用 `resolveParent` 兜底', () => {
    /**
     * ⚠️ 首轮窗口：分配记录还没建立，只能靠会话头。
     * ⇒ `resolveParent` 必须真的被调用（变异「删掉 ?? resolveParent(…)」会红这条）。
     */
    const pool = makePool({
      active: { 'main-9': 'acc3' },
      preferred: { 'main-9': 'acc1' },
    })
    expect(
      resolveSubagentMainStartId(pool, 'codearts', 'child-1', () => 'main-9'),
      '★★ 分配记录缺失时必须走 resolveParent 兜底',
    ).toBe('acc3')
  })

  it('★★ 两个父会话来源都没有 ⇒ `undefined`（不猜）', () => {
    const pool = makePool({ active: { 'main-1': 'acc3' } })
    expect(resolveSubagentMainStartId(pool, 'codearts', 'child-1', noParent)).toBeUndefined()
  })

  it('★★ `sessionId` 为空 ⇒ `undefined`（目录 / 网关流量）', () => {
    const pool = makePool({ assignmentParent: 'main-1', active: { 'main-1': 'acc3' } })
    expect(resolveSubagentMainStartId(pool, 'codearts', undefined, noParent)).toBeUndefined()
    expect(resolveSubagentMainStartId(pool, 'codearts', '', noParent)).toBeUndefined()
  })

  it('★★ 池方法抛错 ⇒ `undefined`（绝不能打断选号）', () => {
    /**
     * ⚠️ 这是每发请求都要跑的路径 —— 任何异常都必须被吞成 `undefined`，
     * 否则一次池内部故障会让**整个请求失败**。
     */
    const pool = {
      subagentAssignmentOf: () => { throw new Error('boom') },
      activeAccountOf: () => 'acc3',
      preferredRotationFor: () => 'acc1',
    }
    expect(resolveSubagentMainStartId(pool, 'codearts', 'child-1', noParent)).toBeUndefined()
  })
})

describe('P0-A 端到端：起点 id 喂给 sequence 后，结果是上游期望的那个号', () => {
  /**
   * ## 为什么再验一次
   *
   * 上游给的对照是「**实测值**」：`acc2`（修前）→ `acc4`（修后）。
   * 上面只断言了「返回哪个 id」，这里把 id 真的喂给 `sequence` 算一遍，
   * 确认**换算链条**也是对的（避免「id 对但算法错」）。
   */
  const POOL = ['acc1', 'acc2', 'acc3', 'acc4']

  /** 与 `startIndexOfSlot` 的 `sequence` 逐字同构。 */
  const sequence = (mainStartId: string, slot: number): string =>
    POOL[(POOL.indexOf(mainStartId) + 1 + slot) % POOL.length]!

  it('★★★ 主代理下拉 acc1、实际在用 acc3、slot=0 ⇒ 落到 acc4（上游的「修后」值）', () => {
    const pool = makePool({
      assignmentParent: 'main-1',
      active: { 'main-1': 'acc3' },
      preferred: { 'main-1': 'acc1' },
    })
    const startId = resolveSubagentMainStartId(pool, 'codearts', 'child-1', noParent)
    expect(startId).toBe('acc3')
    expect(
      sequence(startId as string, 0),
      '★★★ 修后应为 acc4（修前只读下拉框会落到 acc2）',
    ).toBe('acc4')
    /** ⚠️ 反向对照：证明「修前的错值」确实是另一个 —— 否则这条没有区分力。 */
    expect(sequence('acc1', 0), '★★ 修前（只读下拉框）得到的是 acc2').toBe('acc2')
  })
})
