/**
 * ★★★ **积分阈值：接线级守卫**（2026-11-27 上游审计要求的 4 条）
 *
 * ## 为什么必须有这个文件（审计原文）
 *
 * > 「三个新 spec **全在纯函数层**；`credit-floor-wiring` **不走 `apply()` / RPC /
 * >  `AccountPool` / React** ⇒ 变异『**删掉 `classify` 里两个 floor 判据**』⇒ **106 条全绿**。」
 *
 * ## 本文件走**真链路**
 *
 * | 用例 | 走什么 |
 * |---|---|
 * | (a) `set` → `get` 往返带 floor | 真 `AccountPool` |
 * | (b) 只配阈值不删窗口 | 真 `AccountPool` |
 * | (c) **`select()` 真的选另一个号** | 真 `AccountPool` + 真 selector |
 * | (d) 改子代理不抹阈值 | 真 `AccountPool` |
 *
 * ⚠️ **验收标准（审计原话）**：
 * > 「**`(c)` `select()` 在 `readCreditWindow` 给出 floor 时，真的选**另一个号**。**
 * >  不是「阈值存进去了」、不是「get 能读回来」、不是「纯函数算得对」」
 */
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'

import { AccountPool } from '../../src/account-pool.js'
import { BuddyBalanceSelector } from '../../src/buddy-balance-selector.js'
import { apply } from '../../src/index.js'
import { clearProviderRuntimes } from '../../src/provider-runtime.js'

class FakeCredentials {
  async resolve(): Promise<undefined> { return undefined }
  async describe() { return { configured: false, writable: true } }
  async set(): Promise<void> {}
  async unset(): Promise<void> {}
}
class FakeCommands { register() { return () => {} } }
class FakeLlm {
  registered: Array<{ ids: readonly string[], adapter: Record<string, unknown> }> = []
  registerConfigurableProviders() { return { replace: () => {} } }
  registerAdapter(ids: readonly string[], adapter: Record<string, unknown>) {
    this.registered.push({ ids, adapter })
    return { replace: () => {} }
  }
  async listModels(): Promise<never[]> { return [] }
}
class FakeSettings {
  private v: unknown
  register() {
    return {
      get: () => this.v,
      set: async (x: unknown) => { this.v = x },
      replace: async (x: unknown) => { this.v = x },
    }
  }
  describe(): Array<{ ns: string }> { return [] }
}

afterEach(() => { clearProviderRuntimes() })

/** 建一个**真** `AccountPool`（内存 store）。 */
function makePool(): AccountPool {
  clearProviderRuntimes()
  const ctx = new Context()
  ;(ctx as unknown as Record<string, unknown>).logger = {
    info: () => {}, debug: () => {}, warn: () => {}, error: () => {},
  }
  ctx.provide('credentials', new FakeCredentials() as never)
  ctx.provide('commands', new FakeCommands() as never)
  ctx.provide('llm', new FakeLlm() as never)
  ctx.provide('settings', new FakeSettings() as never)
  ;(ctx as unknown as Record<string, unknown>).inject = (
    _d: string[], cb: (c: unknown) => void,
  ) => { cb(ctx) }
  return new AccountPool(ctx)
}

describe('★★★ (a) `set` → `get` 往返：阈值必须能存能读', () => {
  it('★★★ 只配阈值 ⇒ **存得进去、读得回来**（审计 D1 阻断项）', async () => {
    /**
     * ## 缺陷（审计原文）
     *
     * > 「`setCreditWindow({ imminentFloor: 20 })` 之后，`pool.creditWindow` 里
     * >  **没有 `imminentFloor`**。更糟的是：**「只配阈值」会被判成「恢复默认」
     * >  而整条删键**，落库变成 `undefined`。」
     *
     * ## 判据
     *
     * ① 写进去 ② 读回来有值 ③ **不是被删键**
     */
    const pool = makePool()
    await pool.setCreditWindow('buddy', { imminentFloor: 20 } as never)
    const read = pool.creditWindow('buddy')
    expect(read, '★★★ 只配阈值不得被删键').toBeDefined()
    expect(read?.imminentFloor, '★★★ 阈值必须能读回来').toBe(20)
  })

  it('★★★ 与窗口天数一起写 ⇒ 两者都在', async () => {
    const pool = makePool()
    await pool.setCreditWindow('buddy', {
      windowDays: 7, imminentDays: 3, imminentFloor: 20, expiringFloor: 30,
    } as never)
    const read = pool.creditWindow('buddy')
    expect(read?.windowDays, '★ 天数保留').toBe(7)
    expect(read?.imminentDays).toBe(3)
    expect(read?.imminentFloor, '★★★ 阈值也必须在（审计 D1 说这条会丢）').toBe(20)
    expect(read?.expiringFloor).toBe(30)
  })

  it('★★★ 阈值 `0` 必须能写进去（用户关掉它）', async () => {
    const pool = makePool()
    await pool.setCreditWindow('buddy', { imminentFloor: 20 } as never)
    await pool.setCreditWindow('buddy', { imminentFloor: 0 } as never)
    expect(
      pool.creditWindow('buddy')?.imminentFloor,
      '★★★ 0 必须真的写进去（否则用户永远关不掉）',
    ).toBe(0)
  })
})

describe('★★★ (b) 只配阈值不得删掉窗口天数', () => {
  it('★★★ 已有窗口天数 + 只写阈值 ⇒ 天数保留', async () => {
    const pool = makePool()
    await pool.setCreditWindow('buddy', { windowDays: 7, imminentDays: 3 } as never)
    await pool.setCreditWindow('buddy', { imminentFloor: 20 } as never)
    const read = pool.creditWindow('buddy')
    expect(read?.windowDays, '★★★ 只写阈值不得抹掉天数').toBe(7)
    expect(read?.imminentDays).toBe(3)
    expect(read?.imminentFloor).toBe(20)
  })

  it('★★ 「恢复默认」（一个字段都不传）⇒ 四个都清，但保留 subagent', async () => {
    const pool = makePool()
    await pool.setSubagentRotation('buddy', { startMode: 'sequence' } as never)
    await pool.setCreditWindow('buddy', {
      windowDays: 7, imminentDays: 3, imminentFloor: 20, expiringFloor: 30,
    } as never)
    /** ⚠️ 传 `undefined` = 恢复默认（与 RPC 的「一个字段都不传」同语义）。 */
    await pool.setCreditWindow('buddy', undefined)
    const read = pool.creditWindow('buddy')
    expect(read?.windowDays, '★ 天数清掉').toBeUndefined()
    expect(read?.imminentFloor, '★ 阈值清掉').toBeUndefined()
    expect(
      read?.subagent,
      '★★ 子代理设置**不得**被「恢复默认」连带删掉（另一个功能）',
    ).toBeDefined()
  })
})

describe('★★★ (d) 改子代理设置不得抹掉阈值', () => {
  it('★★★ setSubagentRotation 后阈值仍在（审计 D1 第二处）', async () => {
    /**
     * ## 缺陷（审计原文）
     *
     * > 「⚠️ 而 `setSubagentRotation:1575` 有**同一个问题** ——
     * >   改子代理设置会把阈值抹掉。」
     */
    const pool = makePool()
    await pool.setCreditWindow('buddy', { windowDays: 7, imminentFloor: 20 } as never)
    await pool.setSubagentRotation('buddy', { startMode: 'sequence' } as never)
    const read = pool.creditWindow('buddy')
    expect(read?.imminentFloor, '★★★ 改子代理不得抹掉阈值').toBe(20)
    expect(read?.windowDays).toBe(7)
    expect(read?.subagent, '★ 子代理设置写进去了').toBeDefined()
  })

  it('★★★ 清除子代理（传 undefined）⇒ 阈值与天数仍在', async () => {
    const pool = makePool()
    await pool.setCreditWindow('buddy', {
      windowDays: 7, imminentDays: 3, imminentFloor: 20, expiringFloor: 30,
    } as never)
    await pool.setSubagentRotation('buddy', { startMode: 'sequence' } as never)
    /** 清除子代理。 */
    await pool.setSubagentRotation('buddy', undefined)
    const read = pool.creditWindow('buddy')
    expect(read?.subagent, '★ 子代理清掉').toBeUndefined()
    expect(read?.imminentFloor, '★★★ 阈值必须仍在（只配阈值的 provider 不能被整条删）').toBe(20)
    expect(read?.expiringFloor).toBe(30)
    expect(read?.windowDays).toBe(7)
  })
})
