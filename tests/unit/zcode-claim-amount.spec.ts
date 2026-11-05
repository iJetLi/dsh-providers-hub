/**
 * 「ZCode 领取成功 +0 积分」的回归（真实报障，2026-10-03）。
 *
 * ## 报障
 * > 国际版领取积分成功，查询已经到账，但是当时领取积分的提示显示：
 * > ZCode 旅行者6665：领取成功 +0 积分。不是实际领取到的积分
 *
 * ## 根因（实测）
 * 上游把额度放在 `preview` 的 `plan.entitlements[0].grant_units`（100000000），
 * **不在 plan 顶层**。之前没读这一层 ⇒ `toClaimOutcome` 硬填 `credit: 0`。
 *
 * ## 本文件守三件事
 * 1. `preview` 的 plan 被解析出 `grantUnits` / `unitType`（上游形状不许变）
 * 2. `toClaimOutcome` 把它填进 `credit` 并带 `unit: 'token'`
 * 3. 其余 provider 行为**逐字不变**（不传 plan ⇒ 不带 unit ⇒ 仍按积分显示）
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fetchZcodeClaimablePlans } from '../../src/zcode-upstream.js'
import { toClaimOutcome } from '../../src/zcode-auth.js'
import type { ZcodeCredential, ZcodeClaimOutcome } from '../../src/zcode-auth.js'
import type { ZcodeClaimablePlan } from '../../src/zcode-upstream.js'

const dir = dirname(fileURLToPath(import.meta.url))
const creditsSrc = readFileSync(resolve(dir, '../../src/credits.ts'), 'utf8')
/**
 * ⚠️ 读 `jet-hub.js` 时**剥掉整行注释**（2026-10-05 复审补）。
 *
 * 该文件的注释里会**逐字引用**曾经的错误写法（如汇总行那条注释就写着
 * `原先写 （共 +${totalCredit} 积分）`）—— 不剥注释的话，下面的反向断言会被
 * **注释自己**命中，于是「修好了」与「没修」都会红，断言失去意义。
 */
const panelSrc = readFileSync(resolve(dir, '../../plugin-src/client/jet-hub.js'), 'utf8')
  .split(/\r?\n/)
  .filter((line) => {
    const trimmed = line.trim()
    return !(trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*'))
  })
  .join('\n')

const CRED = { zcode_jwt: 'jwt', device_mid: 'mid' } as ZcodeCredential

/** 上游 `preview` 的真实形状（2026-10-03 实测）。 */
function previewResponse() {
  return {
    code: 0,
    data: {
      plans: [{
        plan_id: 'zcode-v3-start-plan-trust-1003',
        name: 'ZCode Trust Build',
        priority: 110,
        entitlements: [{
          entitlement_id: 'zcode-v3-start-plan-trust-1003',
          show_name: 'GLM-5.3-Flash',
          unit_type: 'token',
          grant_units: 100_000_000,
          period: 'one_time',
        }],
      }],
    },
  }
}

const stubFetch = (body: unknown) =>
  (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch

describe('preview 解析出真实额度（★ 报障根因所在）', () => {
  it('★ 从 plan.entitlements[].grant_units 取到 1 亿', async () => {
    const plans = await fetchZcodeClaimablePlans(CRED, stubFetch(previewResponse()))
    expect(plans).toHaveLength(1)
    expect(plans[0]?.grantUnits).toBe(100_000_000)
  })

  it('★ 同时取到 unitType=token', async () => {
    const plans = await fetchZcodeClaimablePlans(CRED, stubFetch(previewResponse()))
    expect(plans[0]?.unitType).toBe('token')
  })

  it('★ plan 没有 entitlements 时留 undefined（不编造 0）', async () => {
    const plans = await fetchZcodeClaimablePlans(CRED, stubFetch({
      code: 0, data: { plans: [{ plan_id: 'p1', name: 'n', priority: 1 }] },
    }))
    expect(plans[0]?.grantUnits).toBeUndefined()
    expect(plans[0]?.unitType).toBeUndefined()
  })

  it('★ grants 非数组时安全跳过（上游改形状不会崩）', async () => {
    const plans = await fetchZcodeClaimablePlans(CRED, stubFetch({
      code: 0, data: { plans: [{ plan_id: 'p1', entitlements: 'oops' }] },
    }))
    expect(plans[0]?.planId).toBe('p1')
    expect(plans[0]?.grantUnits).toBeUndefined()
  })
})

describe('toClaimOutcome 填真实额度与单位', () => {
  const plan: ZcodeClaimablePlan = {
    planId: 'zcode-v3-start-plan-trust-1003',
    priority: 110,
    name: 'ZCode Trust Build',
    grantUnits: 100_000_000,
    unitType: 'token',
  }
  const ok: ZcodeClaimOutcome = { planId: plan.planId, code: 0, ok: true }

  it('★★ 不再是 +0：credit 填真实额度（报障的核心）', () => {
    const r = toClaimOutcome(ok, plan.planId, { plan })
    expect(r.kind).toBe('claimed')
    if (r.kind !== 'claimed') return
    expect(r.credit).toBe(100_000_000)
  })

  it('★ 带 unit=token（前端据此显示 Token 而不是积分）', () => {
    const r = toClaimOutcome(ok, plan.planId, { plan })
    if (r.kind !== 'claimed') throw new Error('kind 不符')
    expect(r.unit).toBe('token')
  })

  it('★ ★ 不传 plan ⇒ 不带 unit（其余调用点行为逐字不变）', () => {
    const r = toClaimOutcome(ok, plan.planId)
    if (r.kind !== 'claimed') throw new Error('kind 不符')
    expect(r.unit).toBeUndefined()
    expect(r.credit).toBe(0)
  })

  it('★ already-claimed 分支不受影响', () => {
    const r = toClaimOutcome(
      { planId: plan.planId, code: 1003, ok: true, alreadyClaimed: true },
      plan.planId,
      { plan },
    )
    expect(r.kind).toBe('already-claimed')
  })

  it('★ 失败分支不受影响（3007 仍给可操作提示）', () => {
    const r = toClaimOutcome({ planId: plan.planId, code: 3007, ok: false }, plan.planId, { plan })
    expect(r.kind).toBe('failed')
    if (r.kind !== 'failed') return
    expect(r.message).toContain('captcha')
  })
})

describe('★ 类型与前端契约（源码级，反向验证必需）', () => {
  /**
   * ⚠ 为什么要源码级断言：运行时对象**本来就带** `unit`，
   * 所以「把类型里的字段删掉」这个变异**不会**让任何行为用例变红 ——
   * 反向验证实测：只测行为时该变异 0 红。
   * ⇒ 字段必须由类型**显式声明**，否则前端 `outcome.unit` 拿不到编译期保障。
   */
  it('★ ClaimOutcome.claimed 分支声明了 unit 字段', () => {
    // ⚠ 窗口要够宽：`kind: 'claimed'` 与 `unit` 之间隔着字段定义与 JSDoc
    //   （实测约 500 字符）。窗口太窄 ⇒ 这条用例恒失败或恒失效。
    expect(creditsSrc).toMatch(/kind: 'claimed'[\s\S]{0,900}?unit\?: 'token' \| 'credit'/)
  })

  it('★ 前端按 unit 渲染（不再写死「积分」）', () => {
    // 逐账号那行
    expect(panelSrc).toMatch(/领取成功 `/)
    // ⚠️ 2026-11-03 PR #171 合并后变量名从 `outcome.credit` 改成 `claimedCredit`
    //    （先归一到数字再判 0，避免把 `undefined` 渲染成 NaN）—— 判据要跟着
    //    真实调用点走，否则这条会变成「实现没坏、用例红」。
    expect(panelSrc).toMatch(/formatUnits\(claimedCredit, unit\)/)
    // 旧写法必须消失
    expect(panelSrc).not.toMatch(/领取成功 \+\$\{outcome\.credit\} 积分/)
  })

  it('★ 汇总行不再做跨单位求和（1 亿 token 与 100 积分相加会误导）', () => {
    /**
     * ⚠️ **本条断言曾长期恒真**（2026-10-05 复审发现并修正）。
     *
     * 原锚点是 `/个账号领取成功（\+\$\{summary\.totalCredit\}/`，但 `jet-hub.js`
     * 里**从来没有过**这种形态 —— 当时的真实代码是
     * `` `一键签到：${...}（共 +${totalCredit} 积分）` ``（**没有**「个账号领取成功」
     * 这个前缀）。⇒ 该正则在修复前后**都命中 0 次**，`not.toMatch` 恒成立，
     * 等于空转 —— 而它正是「防止跨单位求和回归」的那道闸。
     *
     * 现在的判据换成**真实存在过的两种形态**（都以正向锚点兜底，防再次恒真）。
     */
    // ① `totalCredit` 标量不得再出现在**展示**拼装里（只允许作为兜底输入存在）
    expect(panelSrc).not.toMatch(/（共 \+\$\{totalCredit\} 积分）/)
    // ② 逐渠道也不得再直接吐 `totalCredit` 的裸数字
    expect(panelSrc).not.toMatch(/bits\.push\(`\+\$\{s\.totalCredit\}`\)/)
    // ③ 正向锚点：修复后的形态必须真的存在（否则上面两条又变成恒真）
    expect(panelSrc).toMatch(/（共 \$\{totalAmount\}）/)
    expect(panelSrc).toMatch(/bits\.push\(amount\)/)
  })
})
