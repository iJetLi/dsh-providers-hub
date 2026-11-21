/**
 * ★★★ **`fromCache` 标记与客户端补读**（2026-11-21）。
 *
 * ## 它修的是什么（用户实测）
 *
 * 用户原话：
 *
 * > 「重启后过了 3 秒首次打开的显示值，还是有 bug 呀，
 * >   重启后首次打开显示的都不知道是多久的旧值了，为什么没生效」
 *
 * 截图证据：首开显示「可用 269.68」，手动刷新后变成「246.22」
 *（269.68 是**消耗前**的旧值）。
 *
 * ## 机理
 *
 * 磁盘缓存让首屏从 1~2 秒降到毫秒级，代价是**首帧显示上次会话的旧值**。
 * 服务端返回旧值的同时 fire-and-forget 刷新，新值 1~2 秒就绪。
 *
 * **但客户端不会自动重绘** —— 面板只在「挂载 / 切 provider / 手动刷新」时读。
 * ⚠️ 那个 60 秒轮询**只对 `modelscope` 生效**
 *（`if (provider !== 'modelscope') return`）⇒ 其余 provider 首开后
 * **永远不会自己更新**。
 *
 * ## 修法
 *
 * 服务端回传 `fromCache: true`（**不上屏**，用户明确要求「前端不显示任何信息」）
 * ⇒ 客户端 2.5 秒后 `loadCredits(true, true)` 静默补读一次。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '../..')

const serverSource = readFileSync(join(root, 'src/jet-hub-rpc.ts'), 'utf8')
const clientSource = readFileSync(join(root, 'plugin-src/client/jet-hub.js'), 'utf8')
const typesSource = readFileSync(join(root, 'src/types.ts'), 'utf8')

describe('fromCache：服务端标记 + 客户端补读', () => {
  it('★★★ 响应类型必须有 fromCache 字段（供客户端判断）', () => {
    const idx = typesSource.indexOf('export interface RpcCreditsBalancesResponse')
    expect(idx).toBeGreaterThan(-1)
    const body = typesSource.slice(idx, typesSource.indexOf('}', idx) + 1)
    expect(body, '必须有 fromCache 字段').toContain('fromCache')
  })

  it('★★★ 服务端必须在「磁盘缓存命中」时置位（不是「上游失败兼顶」）', () => {
    /**
     * ⚠️ 判据必须是 `stale === true && error === undefined`：
     *
     * - 磁盘缓存命中 ⇒ stale + 无 error ⇒ 该补读 ✅
     * - 上游失败兼顶 ⇒ stale + 有 error ⇒ **不该补读**（只会再失败一次）❌
     */
    expect(serverSource, '必须有 sawDiskCacheHit 标记').toContain('sawDiskCacheHit')
    expect(serverSource, '判据必须同时要求 stale 与 error === undefined')
      .toMatch(/reading\.stale === true && reading\.error === undefined/)
  })

  it('★★★ 服务端必须在两条响应分支都回传 fromCache', () => {
    // usesWindow 为 true / false 两个分支都要带
    const count = (serverSource.match(/sawDiskCacheHit \? \{ fromCache: true \}/g) ?? []).length
    expect(count, '两个响应分支各一处').toBeGreaterThanOrEqual(2)
  })

  it('★★★ 客户端必须在 fromCache 时补读一次（且走 force + quiet）', () => {
    expect(clientSource, '必须读 fromCache').toContain('fromCache === true')
    /**
     * ⚠️⚠️ **必须精确断言 `loadCredits(true, true)`**（两个 true 都要）。
     *
     * - 第一个 `true` = **force**：不 force 会命中 120 秒 TTL 的旧内存值 ⇒ 白补读；
     * - 第二个 `true` = quiet：不 quiet 面板会闪一下「读取中」。
     *
     * ⚠️ 不能用宽松的 `/loadCredits\(true,\s*true\)/` 单独断言 ——
     * 变异 M4（改成 `loadCredits(false, true)`）实测**无牙**
     *（该正则只匹配字面 `true`，但 `false, true` 里也含 `true` 子串？不 ——
     *  实际原因是断言写在**整个文件**上，而文件里别处也有 `loadCredits(true, true)`）。
     *
     * ⇒ 必须**定位到 fromCache 分支内**再断言。
     */
    const fromCacheIdx = clientSource.indexOf('res?.fromCache === true')
    expect(fromCacheIdx, '找不到 fromCache 分支').toBeGreaterThan(-1)
    // 取该分支到下一个 catch 之间的片段
    const branchEnd = clientSource.indexOf('} catch (caught)', fromCacheIdx)
    const branch = clientSource.slice(fromCacheIdx, branchEnd < 0 ? fromCacheIdx + 2000 : branchEnd)
    expect(branch, '★★★ fromCache 分支内必须 loadCredits(true, true)（force + quiet）')
      .toMatch(/loadCredits\(\s*true\s*,\s*true\s*\)/)
    expect(branch, '★★★ 不得是 loadCredits(false, ...)（那样命中 TTL 旧值）')
      .not.toMatch(/loadCredits\(\s*false/)
  })

  it('★★★ 补读前必须比对 provider（防止旧闭包在新 provider 下误触发）', () => {
    /**
     * `mounted` 是**共享** ref：切 provider 时旧 effect 清理置 false，
     * 但新 effect 随即置回 true ⇒ 只判 mounted 会让旧闭包误触发。
     */
    expect(clientSource, '必须捕获 providerAtSchedule').toContain('providerAtSchedule')
    expect(clientSource, '必须比对 provider').toMatch(/providerAtSchedule !== provider/)
  })
})