import { describe, expect, it } from 'vitest'

import { newMarvisDeviceGuid } from '../../src/marvis-device.js'

/**
 * 设备 guid 的唯一职责：**每次调用都给一个新的 32 位小写 hex**。
 *
 * ⚠️ 这里刻意不再测「稳定设备 id」那一套（`createMarvisDeviceRegistry` /
 * `parseRegistrySvid` / `marvisDeviceGuid`）—— 它们在 2026-11-09 整支评审 M1
 * 里被判定为不可达代码并删除：生产只用随机 guid，而共用本机 svid 恰恰会让
 * 多个账号互相顶号（见模块头注释）。
 */

describe('newMarvisDeviceGuid', () => {
  it('是 32 位小写 hex（与 Marvis 自己发的 svid 同形）', () => {
    const guid = newMarvisDeviceGuid()
    expect(guid).toMatch(/^[0-9a-f]{32}$/)
    expect(guid).toHaveLength(32)
  })

  it('两次不同（不能退化成常量）', () => {
    const seen = new Set<string>()
    for (let index = 0; index < 50; index += 1) seen.add(newMarvisDeviceGuid())
    expect(seen.size).toBe(50)
  })
})
