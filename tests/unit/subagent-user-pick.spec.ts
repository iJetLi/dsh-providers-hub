/**
 * ★★★ **B 方案：用户手动选的账号优先于系统 pin**（2026-11-24 用户定案）。
 *
 * ## 用户原话
 *
 * > 「用户手动重选的话是按照用户的意愿来，
 * >   其他情况就是使用拉起时固定的那个，
 * >   可以避免系统乱换号，避免缓存命中低」
 *
 * ## 三级优先级
 *
 * | 级 | 字段 | 谁写 | 生效条件 |
 * |---|---|---|---|
 * | ① | `userPickedAccountId` | **用户**（子代理页面手动选）| 该号可用 |
 * | ② | `pinnedAccountId` | 系统（拉起/重算）| 该号可用 |
 * | ③ | `slot` 现算 | — | 两者都无 |
 *
 * ## 缺陷背景（本文件守的就是它）
 *
 * 用户手动选起点时，客户端调 `account.setRotation`，服务端只写
 * `preferredRotation[provider][sid]`。但 resolver **在 pin 命中时根本不看它**
 * ⇒ 用户的选择**静默无效**，弹窗还会立刻变回 pin 的位次（看起来像保存失败）。
 *
 * ⇒ 必须额外写 `userPickedAccountId`（最高优先级），并且 resolver 要读它。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  recordSubagentAssignment,
  sanitizeSubagentAssignments,
  setUserPickedAccount,
  type SubagentAssignmentMap,
} from '../../src/subagent-rotation.js'

const here = dirname(fileURLToPath(import.meta.url))
const rpcSrc = readFileSync(join(here, '../../src/jet-hub-rpc.ts'), 'utf8')
const resolverSrc = readFileSync(join(here, '../../src/credential-resolver.ts'), 'utf8')

const stripComments = (text: string): string =>
  text
    .split('\n')
    .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
    .join('\n')

function seed(): SubagentAssignmentMap {
  return recordSubagentAssignment({}, 'child-1', 'main-1', 2, 1000)
}

// ============================================================================
// 纯函数：setUserPickedAccount
// ============================================================================
describe('setUserPickedAccount：记录用户选择', () => {
  it('★★★ 记录后能读到', () => {
    const out = setUserPickedAccount(seed(), 'child-1', 'acct-U', 2000)
    expect(out['child-1']!.userPickedAccountId).toBe('acct-U')
    expect(out['child-1']!.userPickedAt).toBe(2000)
  })

  it('★★★ **同值返回原对象**（调用方据此跳过写盘）', () => {
    /**
     * ⚠️ 用户可能反复点同一个位次；每次返回新对象会导致每次都写盘。
     */
    const first = setUserPickedAccount(seed(), 'child-1', 'acct-U', 2000)
    const second = setUserPickedAccount(first, 'child-1', 'acct-U', 3000)
    expect(second).toBe(first)
  })

  it('★★★ 换账号 ⇒ 更新且返回新对象', () => {
    const first = setUserPickedAccount(seed(), 'child-1', 'acct-U', 2000)
    const second = setUserPickedAccount(first, 'child-1', 'acct-V', 3000)
    expect(second).not.toBe(first)
    expect(second['child-1']!.userPickedAccountId).toBe('acct-V')
  })

  it('★★★ 传 undefined ⇒ **清除**（回落到 pin 的语义）', () => {
    const withPick = setUserPickedAccount(seed(), 'child-1', 'acct-U', 2000)
    const cleared = setUserPickedAccount(withPick, 'child-1', undefined, 3000)
    expect(cleared['child-1']!.userPickedAccountId).toBeUndefined()
    expect(cleared['child-1']!.userPickedAt).toBeUndefined()
  })

  it('★★ 传空串 ⇒ 也当作清除', () => {
    const withPick = setUserPickedAccount(seed(), 'child-1', 'acct-U', 2000)
    const cleared = setUserPickedAccount(withPick, 'child-1', '', 3000)
    expect(cleared['child-1']!.userPickedAccountId).toBeUndefined()
  })

  it('★★ 不存在的 sessionId ⇒ 原样返回（主代理走这条）', () => {
    const before = seed()
    expect(setUserPickedAccount(before, 'nope', 'acct-U', 2000)).toBe(before)
  })

  it('★★ **不动 pin / slot / at**', () => {
    const pinned = {
      ...seed(),
      'child-1': { ...seed()['child-1']!, pinnedAccountId: 'acct-P', pinSetAt: 1500 },
    }
    const out = setUserPickedAccount(pinned, 'child-1', 'acct-U', 2000)
    expect(out['child-1']!.pinnedAccountId, 'pin 必须保留').toBe('acct-P')
    expect(out['child-1']!.pinSetAt).toBe(1500)
    expect(out['child-1']!.slot).toBe(2)
    expect(out['child-1']!.at).toBe(1000)
  })
})

describe('sanitize 保留 userPicked', () => {
  it('★★★ 合法值被保留', () => {
    const raw = {
      'child-1': {
        sessionId: 'child-1', parentSessionId: 'main-1', at: 1000, slot: 2,
        userPickedAccountId: 'acct-U', userPickedAt: 2000,
      },
    }
    const out = sanitizeSubagentAssignments(raw)
    expect(out['child-1']!.userPickedAccountId).toBe('acct-U')
    expect(out['child-1']!.userPickedAt).toBe(2000)
  })

  it('★★ 非法值被丢弃（不猜）', () => {
    for (const bad of ['', 123, null, {}]) {
      const raw = {
        'child-1': {
          sessionId: 'child-1', parentSessionId: 'main-1', at: 1000, slot: 2,
          userPickedAccountId: bad,
        },
      }
      expect(sanitizeSubagentAssignments(raw)['child-1']!.userPickedAccountId, String(bad)).toBeUndefined()
    }
  })
})

// ============================================================================
// 接线：两处必须同时改
// ============================================================================
describe('接线：服务端写入 + resolver 读取', () => {
  it('★★★ `account.setRotation` 必须**真的调用** setUserPickedAccount', () => {
    /**
     * ⚠️ 判据不能是「文件里出现过 `setUserPickedAccount`」——
     * 接口声明 / 注释 / 其他 case 里都有这个词，变异「删掉调用」照样绿
     *（我第一版就这么漏的）。
     *
     * ⇒ 必须断言 **`account.setRotation` 的 case 块内**有 `.setUserPickedAccount?.(` 调用。
     */
    const code = stripComments(rpcSrc)
    const start = code.indexOf("case 'account.setRotation'")
    expect(start, '找不到 account.setRotation').toBeGreaterThan(-1)
    const end = code.indexOf("case '", start + 10)
    expect(end, '找不到下一个 case').toBeGreaterThan(start)
    const body = code.slice(start, end)

    expect(
      body,
      '★★★ case 块内必须有 setUserPickedAccount 的**调用**（只写 preferredRotation 的话，pin 会盖过用户选择）',
    ).toMatch(/\.setUserPickedAccount\?\.\(/)
  })

  it('★★★ 位次→账号换算必须用「全量启用账号」（与 resolver 同口径）', () => {
    const code = stripComments(rpcSrc)
    const idx = code.indexOf('const allForPick = await pool.listAllAccounts()')
    expect(idx, '找不到换算代码').toBeGreaterThan(-1)
    const window = code.slice(idx, idx + 400)
    expect(window, '★★★ 必须过滤 enabled').toContain('enabled !== false')
    expect(window, '★★★ 必须按位次取（1-based）').toContain('req.position - 1')
  })

  it('★★★ resolver 付费路径：userPicked 优先于 pin', () => {
    const code = stripComments(resolverSrc)
    const userIdx = code.indexOf('userPickedId')
    const pinIdx = code.indexOf('const pinnedId = assignment?.pinnedAccountId')
    expect(userIdx, '★★★ 付费路径必须读 userPickedAccountId').toBeGreaterThan(-1)
    expect(pinIdx).toBeGreaterThan(-1)
    /**
     * ⚠️ 判据：`userPickedId` 的**首次出现**必须在 `pinnedId` 之前
     *（先判高优先级）。
     */
    expect(
      userIdx,
      '★★★ userPicked 判断必须在 pin 之前（否则优先级反了）',
    ).toBeLessThan(pinIdx)
  })

  it('★★★ resolver 免费路径也必须同构（两处都要改）', () => {
    const code = stripComments(resolverSrc)
    /** 免费路径的判据变量名（与付费路径不同，故意的：能分辨是哪一处改漏了）。 */
    expect(code, '★★★ 免费路径必须读 userPicked').toContain('const userPicked = subAssignment?.userPickedAccountId')
    expect(code, '★★★ 免费路径必须有 userPickedUsable').toContain('userPickedUsable')
  })

  it('★★ resolver 两处都必须「不可用则回落」，而不是清除用户选择', () => {
    /**
     * 用户选的号**暂时**不可用时应回落到 pin，但 `userPickedAccountId`
     * **不能清** —— 等它恢复可用要自动切回。
     *
     * ⚠️ 判据：resolver 里**不得**出现清除该字段的调用。
     */
    const code = stripComments(resolverSrc)
    expect(
      code,
      '★★★ resolver 不得清除 userPicked（那是「用户选择」，只能由用户再选改变）',
    ).not.toMatch(/setUserPickedAccount\([^)]*undefined/)
  })
})

/**
 * ★★★ **显示与生效必须一致**（2026-11-24 用户定 B 方案的完整闭环）。
 *
 * ## 缺陷形态（只改 resolver 不改 getRotation 会出现的症状）
 *
 * | 位置 | 用户选位次 3 后 |
 * |---|---|
 * | resolver（实际生效）| ✅ 用位次 3 |
 * | `account.getRotation`（显示）| ❌ 仍显示 pin 的位次 5 |
 *
 * ⇒ 弹窗显示「位次 5」，但实际在用位次 3 —— **界面撒谎**，
 * 用户会以为保存失败了、反复重选。
 */
describe('显示必须与生效同构', () => {
  it('★★★ getRotation 的 selectedId 必须 userPicked 优先于 pin', () => {
    const code = stripComments(rpcSrc)
    const start = code.indexOf("case 'account.getRotation'")
    expect(start, '找不到 getRotation').toBeGreaterThan(-1)
    const end = code.indexOf("case '", start + 10)
    const body = code.slice(start, end)

    /**
     * ⚠️ 判据：必须写成 `userPickedAccountId ?? pinnedAccountId`
     *（顺序不能反，也不能只取 pin）。
     */
    expect(
      body,
      '★★★ 必须 userPicked 优先（否则弹窗显示与生效率不一致）',
    ).toMatch(/userPickedAccountId\s*\?\?\s*subagentAssign\?\.pinnedAccountId/)
  })

  it('★★★ 三级判据必须与 resolver 同构（两处都是 userPicked > pin）', () => {
    const rpcCode = stripComments(rpcSrc)
    const resCode = stripComments(resolverSrc)

    /** resolver 付费路径：先读 userPickedId 再读 pinnedId。 */
    const resUserIdx = resCode.indexOf('const userPickedId = assignment?.userPickedAccountId')
    const resPinIdx = resCode.indexOf('const pinnedId = assignment?.pinnedAccountId')
    expect(resUserIdx).toBeGreaterThan(-1)
    expect(resPinIdx).toBeGreaterThan(-1)
    expect(resUserIdx, 'resolver: userPicked 必须先判').toBeLessThan(resPinIdx)

    /** getRotation：同一个 `??` 表达式里 userPicked 在前。 */
    const rpcIdx = rpcCode.indexOf('userPickedAccountId ?? subagentAssign?.pinnedAccountId')
    expect(rpcIdx, 'getRotation: userPicked 必须在前').toBeGreaterThan(-1)
  })
})
/**
 * ★★★ **账号名只在子代理页面显示**（2026-11-24 用户第二次定案）。
 *
 * ## 用户原话
 *
 * > 「主对话会面不需要显示帐号名，只要原来的位次就行，跟子代理对话页面不同」
 *
 * ## 两个页面的语义不同
 *
 * | 页面 | 用户关心 | 显示 |
 * |---|---|---|
 * | 主代理 | 「我选的起点生效了吗」| `位次 2` |
 * | 子代理 | 「这个子代理在用哪个号」| `位次 2 · 177****4916` |
 *
 * ⚠️ 主代理页面显示账号名反而有害 —— 那里的位次是用户**自己**选的，
 * 加个名字会让人以为「系统给我换了个号」。
 */
describe('账号名只在子代理会话下发', () => {
  it('★★★ selectedAccountName 必须以 subagentAssign 存在为前提', () => {
    const code = stripComments(rpcSrc)
    const idx = code.indexOf('const selectedAccountName =')
    expect(idx, '找不到 selectedAccountName').toBeGreaterThan(-1)
    const window = code.slice(idx, idx + 200)
    expect(
      window,
      '★★★ 必须同时判 `selectedId === null` **与**「不是子代理」（否则主代理也显示名字）',
    ).toMatch(/selectedId === null \|\| !isSubagentSessionForBadge/)
  })

  it('★★★ 判据来自 subagentAssign（与选号同源，不另写一套）', () => {
    /**
     * ⚠️ 分配表**只登记子代理**（主代理永不登记）——
     * 这与 resolver 里选号用的判据完全同源。
     *
     * ⇒ 不得用 `isSubagentSession()`（那是进程内父子表，
     *   与持久化的分配表是两个东西，两套判据必然漂移）。
     */
    const code = stripComments(rpcSrc)
    const idx = code.indexOf('const isSubagentSessionForBadge')
    expect(idx, '★★★ 必须有明确的「是不是子代理」判据').toBeGreaterThan(-1)
    const window = code.slice(idx, idx + 150)
    expect(window, '★★★ 判据必须来自分配表').toContain('subagentAssign !== undefined')
    expect(window, '★★★ 不能用 isSubagentSession（那是另一套状态）').not.toContain('isSubagentSession(')
  })

  it('★★ 主代理仍能拿到位次（只是不带名字）', () => {
    /**
     * ⚠️ 主代理的 `selectedPosition` 计算**完全不受影响** ——
     * 本次改动只影响 `selectedAccountName` 这一个字段。
     */
    const code = stripComments(rpcSrc)
    const posIdx = code.indexOf('const selectedPosition = selectedId === null')
    expect(posIdx, '★★ 主代理的位次计算必须保留').toBeGreaterThan(-1)
  })
})