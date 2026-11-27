/**
 * ★★★ **「最后一米」接线守卫**（2026-11-27 上游审计登记）
 *
 * ## 缺口（上游原话）
 *
 * > 「**最后一米零守卫**：`usage-badge` 把阈值传进 `sumAvailableCredits` /
 * >  `orderCreditRows` 的两处**全删仍 15570 全绿**」
 *
 * ## 为什么这是「最后一米」
 *
 * 整条链路的守卫分布：
 *
 * | 层 | 守卫 | 状态 |
 * |---|---|---|
 * | 后端判档 `buddyBalanceTier` | `credit-floor-chain-backend.spec.ts` | ✅ 上游补的 |
 * | 客户端判档 `backendOrderTier` | `credit-floor-parity.spec.ts` | ✅ |
 * | 覆盖数 `computeCoverage` | `credit-floor-wiring.spec.ts` | ✅ |
 * | **`usage-badge` 把阈值喂给那两个函数** | **本文件** | ✅ **本次补** |
 *
 * ⇒ 前几层全绿**不代表**这份数据真的传到了消费点 ——
 *   删掉 `usage-badge.js` 里那两行 `imminentFloor: value?.imminentFloor`，
 *   整条链路就断在最后一米，而**没有任何用例变红**。
 *
 * ## ⚠️ 为什么只能做源码守卫
 *
 * `usage-badge.js` 顶部 `import * as React` ⇒ 单测 import 不进来
 *（react 是 esbuild external，本仓 `node_modules` 没有）。
 *
 * ⚠️ 这比行为级弱（挡不住 `if(false)`），但**这是该文件的固有局限** ——
 * 要彻底消灭它，需要把整个 `renderCredits` 做成可注入的纯渲染函数（成本远超收益）。
 * 如实登记。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = join(HERE, '../../plugin-src/client')

const usageBadge = readFileSync(join(SRC, 'usage-badge.js'), 'utf8')

/**
 * 取某个调用点**实参列表里**是否出现某字段（不跨越调用边界）。
 *
 * ⚠️ 不能用「文件里出现过 `imminentFloor`」这种宽松判据 —— 那样
 *   `creditRowTierOf` 那条腿就会把 `sumAvailableCredits` 那条腿的空缺遮住
 *（本仓反复记录过「两处实现互为掩护」）。
 */
function argsOf(source: string, callSignature: string, maxLen = 600): string {
  const at = source.indexOf(callSignature)
  if (at < 0) return ''
  return source.slice(at, at + maxLen)
}

describe('★★★ 最后一米：`usage-badge` 必须把阈值传进两个消费点', () => {
  it('★★★ `sumAvailableCredits` 的实参必须带两个阈值', () => {
    const args = argsOf(usageBadge, 'sumAvailableCredits(value?.accounts, {')
    expect(args, '★★ 必须找到该调用点（形态变了就更新本守卫）').not.toBe('')
    expect(
      args,
      '★★★ 漏传 `imminentFloor` ⇒ 徽标「可用积分」把已降档的部分也算进去 ⇒ **数字骗人**',
    ).toContain('imminentFloor:')
    expect(
      args,
      '★★★ 漏传 `expiringFloor` ⇒ 同上',
    ).toContain('expiringFloor:')
  })

  it('★★★ `creditOrderOptionsOf` 的实参必须带两个阈值', () => {
    const args = argsOf(usageBadge, 'orderCreditRows(accounts, creditOrderOptionsOf({')
    expect(args, '★★ 必须找到该调用点').not.toBe('')
    expect(
      args,
      '★★★ 漏传 ⇒ 弹窗排序 / 分组按 `> 0` 判档 ⇒ **与后端选号分叉**',
    ).toContain('imminentFloor:')
    expect(args, '★★★ 同上').toContain('expiringFloor:')
  })

  it('★★ 两处都必须**真的从 `value` 取**（不能写死 0）', () => {
    /**
     * ⚠️ 防「传了个常量 0」—— 那语法上满足「传了」，但功能等于关闭。
     *
     * ⚠️ 锚点必须用**完整调用签名**：我第一版用 `'orderCreditOptionsOf({'`，
     *   而文件里 `:2996` 的**注释**也含 `creditOrderOptionsOf()` ⇒
     *   `indexOf` 命中注释 ⇒ 截到空串 ⇒ 假红。
     *   ⇒ 用 `'orderCreditRows(accounts, creditOrderOptionsOf({'`（只在真调用处出现）。
     */
    for (const sig of [
      'sumAvailableCredits(value?.accounts, {',
      'orderCreditRows(accounts, creditOrderOptionsOf({',
    ]) {
      const args = argsOf(usageBadge, sig)
      expect(args, `★★ 必须找到调用点 ${sig}`).not.toBe('')
      expect(args, `★★ ${sig} 必须从 value 取阈值`).toMatch(
        /imminentFloor: value\?\.imminentFloor/,
      )
    }
  })
})

describe('★★★ 反向：不得出现「只传一个」的半接线形态', () => {
  it('★★ 两处调用的 `imminentFloor` 与 `expiringFloor` 必须成对出现', () => {
    /**
     * ⚠️ 与 `credit-window-rpc-contract.spec.ts` 的「两个天数必须成对回传」**同型**：
     * 只给一半会让一半按新口径、一半按旧口径 ⇒ 面板自相矛盾。
     */
    for (const [label, sig] of [
      ['sumAvailableCredits', 'sumAvailableCredits(value?.accounts, {'],
      ['creditOrderOptionsOf', 'orderCreditRows(accounts, creditOrderOptionsOf({'],
    ]) {
      const args = argsOf(usageBadge, sig)
      const hasImminent = args.includes('imminentFloor:')
      const hasExpiring = args.includes('expiringFloor:')
      expect(
        hasImminent,
        `★★ ${label}：两个阈值必须成对（当前 imminentFloor=${hasImminent} expiringFloor=${hasExpiring}）`,
      ).toBe(hasExpiring)
    }
  })
})
