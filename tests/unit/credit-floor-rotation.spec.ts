import { describe, expect, it } from 'vitest'
import { rotateFromPreferred } from '../../src/buddy-balance-rank.js'

function bal(imminent: number, expiring: number, permanent: number) {
  return { imminentBalance: imminent, expiringBalance: expiring, permanentBalance: permanent }
}

describe('P1 探针：rotateFromPreferred 是否认积分阈值', () => {
  it('★★★ 起点号临期 ≤ 阈值 ⇒ **不得**排首位（阈值必须生效）', () => {
    // a1: 临期 5（≤20）⇒ 应降级为「短期」；a2: 临期 100（正常临期档）
    const a1 = { id: 'a1', ...bal(5, 500, 0) }
    const a2 = { id: 'a2', ...bal(100, 500, 0) }
    const ranked = [a1, a2]
    // 不带阈值：a1 仍是「临期」⇒ 起点占首位（这是改动前的正确行为）
    const off = rotateFromPreferred(ranked, { rotationStartId: 'a1' })
    console.log('  [阈值关] 首位 = ' + off[0]!.id)
    // 带阈值 20：a1 被降级 ⇒ **不该**占首位
    const on = rotateFromPreferred(ranked, { rotationStartId: 'a1', imminentFloor: 20 })
    console.log('  [阈值20] 首位 = ' + on[0]!.id)
    expect(off[0]!.id, '阈值关时起点照旧占首位（零回归）').toBe('a1')
    expect(on[0]!.id, '★★★ 阈值 20 时临期 5 的号不得占首位（P1 修复的判据）').not.toBe('a1')
  })
})
