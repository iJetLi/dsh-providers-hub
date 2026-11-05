/**
 * 账号卡片「还能不能用」的纯判据（Gitee issue IKS2MV）。
 *
 * 锁三件事：
 * 1. **封禁与限流是两笔账**：封禁是账号级、不随日期过期；限流是逐模型、带重置时刻；
 * 2. **「重置」与「重测」的可用条件不同**：纯封禁账号上「重测」不发任何请求
 *   （`retestAccount` 只测有模型标记的模型），故它必须禁用、只留「重置」与「测试」；
 * 3. **脏值不容错**：封禁标记来自可编辑的备份文件，一条脏值会让账号**永久**不可选。
 */
import { describe, expect, it } from 'vitest'
import {
  accountLimitActionState,
  activeRateLimits,
  policyBlockedInfo,
} from '../../plugin-src/client/account-status.js'

const NOW = 1_800_000_000_000

describe('账号状态判据：封禁（账号级，issue IKS2MV）', () => {
  it('★ 有 policyBlockedAtMs ⇒ 视为封禁（并带出上游原文）', () => {
    const info = policyBlockedInfo({
      policyBlockedAtMs: NOW - 60_000,
      policyBlockedMessage: '账号存在异常行为，已被限制使用',
    })
    expect(info).toEqual({ blocked: true, message: '账号存在异常行为，已被限制使用' })
  })

  it('★ 脏值一律不算封禁（否则账号会被永久排除，用户只能手动捞）', () => {
    for (const bad of [undefined, null, 0, -1, Number.NaN, 'x', 1e308, Number.POSITIVE_INFINITY]) {
      expect(policyBlockedInfo({ policyBlockedAtMs: bad }).blocked, String(bad)).toBe(false)
    }
  })

  it('报文缺失/非字符串 ⇒ 空串（渲染层据此不显示那一行）', () => {
    expect(policyBlockedInfo({ policyBlockedAtMs: NOW, policyBlockedMessage: 42 }).message).toBe('')
  })
})

describe('账号状态判据：限流（逐模型）', () => {
  it('★ 只显示未到期的；过期的保留在存储里但不上卡片', () => {
    const limits = activeRateLimits({
      modelRateLimits: { expired: NOW - 1000, active: NOW + 1000 },
    }, NOW)
    expect(limits).toEqual([{ modelId: 'active', resetAt: NOW + 1000 }])
  })

  it('脏值 / 非对象输入 ⇒ 空数组（不抛错）', () => {
    expect(activeRateLimits({ modelRateLimits: 'nope' }, NOW)).toEqual([])
    expect(activeRateLimits({ modelRateLimits: null }, NOW)).toEqual([])
    expect(activeRateLimits({}, NOW)).toEqual([])
    expect(activeRateLimits({ modelRateLimits: { a: 'x', b: Number.NaN } }, NOW)).toEqual([])
  })
})

describe('账号状态判据：操作按钮可用性', () => {
  it('★ 没有任何标记 ⇒ 两个按钮都不该出现', () => {
    const s = accountLimitActionState({}, NOW)
    expect(s).toMatchObject({ canReset: false, canRetest: false, policyBlocked: false })
    expect(s.activeRateLimits).toEqual([])
  })

  it('★★ 纯封禁（无模型标记）⇒ 只能「重置」不能「重测」', () => {
    // 判据出处：`retestAccount` 在 `modelIds.length === 0` 时**一次请求都不发**，
    // 纯封禁账号上按「重测」毫无反应（用户会以为按钮坏了）；正确入口是「测试」。
    const s = accountLimitActionState({ policyBlockedAtMs: NOW - 1000 }, NOW)
    expect(s.canReset).toBe(true)
    expect(s.canRetest).toBe(false)
    expect(s.policyBlocked).toBe(true)
  })

  it('★ 纯限流（已过期）⇒ 两个按钮都可用（用户最想清掉的就是过期记录）', () => {
    const s = accountLimitActionState({ modelRateLimits: { m: NOW - 1000 } }, NOW)
    expect(s.canReset).toBe(true)
    expect(s.canRetest).toBe(true)
    // 但卡片上不显示「正在限流」
    expect(s.activeRateLimits).toEqual([])
  })

  it('两者都有 ⇒ 都可用，且任务书里两条信息都要能渲染', () => {
    const s = accountLimitActionState({
      policyBlockedAtMs: NOW - 1000,
      policyBlockedMessage: '账号存在异常行为',
      modelRateLimits: { m: NOW + 1000 },
    }, NOW)
    expect(s.canReset).toBe(true)
    expect(s.canRetest).toBe(true)
    expect(s.policyBlocked).toBe(true)
    expect(s.activeRateLimits).toHaveLength(1)
  })
})
