/**
 * ★★★ **Bug 1：子代理「帐号分布方式」必须真的生效**（2026-11-25 用户报障）。
 *
 * ## 用户原话
 *
 * > 「子代理设置里面的帐号分布方式不成功」
 *
 * ## 真正的根因：**自建选号的 provider 完全没有登记调用**
 *
 * `decideSubagentStart` 靠 `assignment.slot` 算错开位次，而那张表**只有
 * `recordSubagentStart` 会写**：
 *
 * | provider | 选起点 | **登记分配**（修前）|
 * |---|---|---|
 * | buddy 系（`credential-resolver`）| ✅ | ✅ |
 * | **codearts**（`index.ts`）| ✅ | ❌ **完全没有** |
 * | **officeace**（`officeace-lock.ts`）| ✅ | ❌ **完全没有** |
 *
 * ⇒ `assignment` 恒 `undefined` ⇒ `slot` 兜底 `0`
 * ⇒ **所有子代理同一个起点** ⇒ 用户看到「分布方式没生效」。
 *
 * ## 本文件守什么
 *
 * 1. **行为级**：`registerSubagentStartIfNeeded` 真的会调用 `recordSubagentStart`；
 * 2. **接线级**：codearts / officeace 两个调用点**真的调了**它
 *    （⚠️ 这是本 Bug 的核心 —— 修前它们一个都没调）。
 *
 * ⚠️ 为什么接线要单独守：本仓反复记录「纯函数测试全绿但接线没锁」
 * （#154 的教训），而本 Bug 恰恰就是**接线缺失**。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { registerSubagentStartIfNeeded } from '../../src/subagent-start.js'

const here = dirname(fileURLToPath(import.meta.url))
const indexSrc = readFileSync(join(here, '../../src/index.ts'), 'utf8')
const officeaceSrc = readFileSync(join(here, '../../src/officeace-lock.ts'), 'utf8')
const resolverSrc = readFileSync(join(here, '../../src/credential-resolver.ts'), 'utf8')

/** 剥注释（本仓注释里大量引用被断言的标识符）。 */
const stripComments = (text: string): string =>
  text
    .split('\n')
    .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
    .join('\n')

// ============================================================================
// ① 行为级：registerSubagentStartIfNeeded 真的会登记
// ============================================================================
describe('Bug 1：`registerSubagentStartIfNeeded` 必须真的写分配表', () => {
  const SETTING = { startMode: 'sequence' as const }

  /** 造一个记录调用的 pool。 */
  function makePool() {
    const calls: Array<{ provider: string, sessionId: string, parentSessionId: string, now: number }> = []
    return {
      calls,
      pool: {
        recordSubagentStart: async (provider: string, sessionId: string, parentSessionId: string, now: number) => {
          calls.push({ provider, sessionId, parentSessionId, now })
          return calls.length - 1
        },
      },
    }
  }

  it('★★★ 条件齐全 ⇒ 必须调用一次 recordSubagentStart', () => {
    /**
     * ⚠️ 这是**行为级**断言：真的调了才算数。
     * 把函数体改成 `return false` ⇒ 本用例立刻红。
     */
    const { calls, pool } = makePool()
    const registered = registerSubagentStartIfNeeded({
      pool,
      providerId: 'codearts',
      sessionId: 'child-1',
      parentSessionId: 'parent-1',
      setting: SETTING,
      now: () => 12345,
    })

    expect(registered, '★★★ 必须报告「已发起登记」').toBe(true)
    expect(calls.length, '★★★ 必须真的调用一次').toBe(1)
    expect(calls[0]).toEqual({
      provider: 'codearts',
      sessionId: 'child-1',
      parentSessionId: 'parent-1',
      now: 12345,
    })
  })

  it('★★ 没配子代理设置 ⇒ 不登记（零回归）', () => {
    const { calls, pool } = makePool()
    const registered = registerSubagentStartIfNeeded({
      pool,
      providerId: 'codearts',
      sessionId: 'child-1',
      parentSessionId: 'parent-1',
      setting: undefined,
    })
    expect(registered).toBe(false)
    expect(calls.length, '★★ 没配 ⇒ 一次都不该调').toBe(0)
  })

  it('★★ 父会话未知 ⇒ 不登记（宁缺不猜）', () => {
    const { calls, pool } = makePool()
    const registered = registerSubagentStartIfNeeded({
      pool,
      providerId: 'codearts',
      sessionId: 'child-1',
      parentSessionId: undefined,
      setting: SETTING,
    })
    expect(registered).toBe(false)
    expect(calls.length, '★★ 父会话未知 ⇒ 不登记').toBe(0)
  })

  it('★★ sessionId 缺失 ⇒ 不登记', () => {
    const { calls, pool } = makePool()
    const registered = registerSubagentStartIfNeeded({
      pool,
      providerId: 'codearts',
      sessionId: undefined,
      parentSessionId: 'parent-1',
      setting: SETTING,
    })
    expect(registered).toBe(false)
    expect(calls.length).toBe(0)
  })

  it('★★ 同一子代理重复调用 ⇒ 每次都发起（幂等由 pool 内部保证）', () => {
    /**
     * ⚠️ 判据分层：`registerSubagentStartIfNeeded` 只负责「要不要调」，
     * **幂等（保留原 slot）由 `account-pool.recordSubagentStart` 保证**
     * （它内部的 `nextSubagentSlot` 只在 `existing === undefined` 时才递增）。
     *
     * ⇒ 这里断言「调了两次」是对的，不是缺陷。
     */
    const { calls, pool } = makePool()
    for (let i = 0; i < 2; i += 1) {
      registerSubagentStartIfNeeded({
        pool,
        providerId: 'codearts',
        sessionId: 'child-1',
        parentSessionId: 'parent-1',
        setting: SETTING,
      })
    }
    expect(calls.length, '★★ 两次调用都应发起（幂等在下层）').toBe(2)
  })

  it('★★ pool 抛错 ⇒ 不得上抛（每发请求都要跑这条路径）', () => {
    const pool = {
      recordSubagentStart: () => { throw new Error('boom') },
    }
    expect(() => registerSubagentStartIfNeeded({
      pool,
      providerId: 'codearts',
      sessionId: 'child-1',
      parentSessionId: 'parent-1',
      setting: SETTING,
    })).not.toThrow()
  })
})

// ============================================================================
// ② 接线级：两个自建选号 provider 必须真的调了
// ============================================================================
describe('Bug 1：自建选号 provider 必须接上登记（修前它们一个都没调）', () => {
  it('★★★ codearts（`index.ts`）必须调用 registerSubagentStartIfNeeded', () => {
    /**
     * ⚠️ **这是本 Bug 的核心断言**。
     *
     * 修前：`index.ts` 的 codearts 分支有 `decideSubagentStart`（选起点）
     * 但**没有**任何 `recordSubagentStart` ⇒ 分配表恒空 ⇒ slot 恒 0。
     */
    const code = stripComments(indexSrc)
    expect(
      code,
      '★★★ codearts 分支必须调 registerSubagentStartIfNeeded',
    ).toContain('registerSubagentStartIfNeeded(')
  })

  it('★★★ officeace（`officeace-lock.ts`）必须调用 registerSubagentStartIfNeeded', () => {
    const code = stripComments(officeaceSrc)
    expect(
      code,
      '★★★ officeace 必须调 registerSubagentStartIfNeeded',
    ).toContain('registerSubagentStartIfNeeded(')
  })

  it('★★★ 登记必须**先于** decideSubagentStart（否则本次请求读不到新 slot）', () => {
    /**
     * ⚠️ `recordSubagentStart` 内部「先同步更新缓存、再异步落盘」
     * ⇒ 登记在算起点**之前**，本次请求才能读到新 slot。
     *    顺序反了的话，本次仍读到 `undefined` ⇒ slot 0 ⇒ 全撞号。
     *
     * ⚠️ 两个文件都要判（codearts 在 index.ts，officeace 在 lock.ts）。
     */
    for (const [name, src] of [
      ['index.ts', stripComments(indexSrc)],
      ['officeace-lock.ts', stripComments(officeaceSrc)],
    ]) {
      const regIdx = src.indexOf('registerSubagentStartIfNeeded(')
      const decIdx = src.indexOf('decideSubagentStart(')
      expect(regIdx, `${name}: 找不到登记调用`).toBeGreaterThan(-1)
      expect(decIdx, `${name}: 找不到起点计算`).toBeGreaterThan(-1)
      expect(
        regIdx,
        `★★★ ${name}: 登记必须排在 decideSubagentStart 之前`,
      ).toBeLessThan(decIdx)
    }
  })

  it('★★★ 三处必须用**同一个**共享函数（不得手抄判据）', () => {
    /**
     * ⚠️ 本仓红线「同一语义不得两套实现」。
     *
     * ## 修前的形态（这才是 Bug 1 的根源）
     *
     * | 文件 | 选起点 | 登记 |
     * |---|---|---|
     * | `credential-resolver` | ✅ | ✅ **但用内联判据**（与共享函数文本不同）|
     * | `index.ts`（codearts）| ✅ | ❌ **没有** |
     * | `officeace-lock.ts` | ✅ | ❌ **没有** |
     *
     * ⇒ 三处各写各的，必然漏。**修法是三处全部走共享函数**。
     */
    const resolverCode = stripComments(resolverSrc)
    expect(
      resolverCode,
      '★★★ credential-resolver 也必须走共享函数（修前是内联判据）',
    ).toContain('registerSubagentStartIfNeeded(')
    expect(stripComments(indexSrc), '★★★ codearts 必须走共享函数').toContain('registerSubagentStartIfNeeded(')
    expect(stripComments(officeaceSrc), '★★★ officeace 必须走共享函数').toContain('registerSubagentStartIfNeeded(')
  })
})
