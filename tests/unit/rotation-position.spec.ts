/**
 * 「位次」语义的守卫（用户 2026-11-10 需求）。
 *
 * ## 背景
 *
 * 原实现存 `accountId`（跟号走），用户要求改为**存位次**（跟位置走）：
 * 「当前会话选位次 1，去管理界面拖拽后回来，仍应是位次 1（= 新的第 1 个号）」。
 *
 * ## 本文件守什么
 *
 * 1. **位次 → 账号** 的换算（含越界回落、旧格式兼容）
 * 2. **双模式排序**（默认=积分降序 / 有起点=起点最前）
 * 3. **两处 label 格式一致**（下拉框与积分列表）
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { orderCreditRows } from '../../plugin-src/client/badge-model.js'
import { sanitizePreferredRotation } from '../../src/jet-hub-store.js'

const SRC = join(process.cwd(), 'plugin-src', 'client', 'usage-badge.js')
const source = readFileSync(SRC, 'utf8')

describe('sanitizePreferredRotation —— 两种格式并存', () => {
  it('★ 新格式 `{position, at}` ⇒ 原样保留', () => {
    const out = sanitizePreferredRotation({ p: { s: { position: 2, at: 100 } } })
    expect(out.p?.s).toEqual({ position: 2, at: 100 })
  })

  it('★ 旧格式 `{accountId, at}` ⇒ **仍可读**（升级用户不丢设置）', () => {
    const out = sanitizePreferredRotation({ p: { s: { accountId: 'acc-1', at: 100 } } })
    expect(out.p?.s).toEqual({ accountId: 'acc-1', at: 100 })
  })

  it('★ 更旧的裸字符串 ⇒ 补 at=0', () => {
    const out = sanitizePreferredRotation({ p: { s: 'acc-1' } })
    expect(out.p?.s).toEqual({ accountId: 'acc-1', at: 0 })
  })

  it('position 非正整数 ⇒ 丢弃（不静默改成 1）', () => {
    for (const bad of [0, -1, 1.5, '2', null]) {
      expect(sanitizePreferredRotation({ p: { s: { position: bad, at: 100 } } })).toEqual({})
    }
  })

  it('position 合法但 accountId 也在 ⇒ **优先 position**（新格式胜出）', () => {
    const out = sanitizePreferredRotation({ p: { s: { position: 3, accountId: 'old', at: 100 } } })
    expect(out.p?.s).toEqual({ position: 3, at: 100 })
  })
})

describe('orderCreditRows —— 双模式排序', () => {
  const rows = [
    { accountId: 'a', balance: { total: 100 } },
    { accountId: 'b', balance: { total: 300 } },
    { accountId: 'c', balance: { total: 200 } },
  ]

  it('★ 默认（无 rotationStartId）⇒ **积分降序**（既有行为不变）', () => {
    const { shown } = orderCreditRows(rows, { limit: 10 })
    expect(shown.map((r) => r.accountId)).toEqual(['b', 'c', 'a'])
    // 变异：改成保持原序 ⇒ 本条红
  })

  it('★ 设了起点 ⇒ **起点最前**，其余保持传入顺序（不按余额）', () => {
    const { shown } = orderCreditRows(rows, { limit: 10, rotationStartId: 'c' })
    expect(shown.map((r) => r.accountId)).toEqual(['c', 'a', 'b'])
    // ⚠️ 关键：'a' 在 'b' 前面 —— **没有按余额重排**（b=300 却在后面）
    // 变异：把 rotateRows 换成「先按余额排再旋转」⇒ 本条红
  })

  it('★ 起点在首位 ⇒ 原样（幂等）', () => {
    const { shown } = orderCreditRows(rows, { limit: 10, rotationStartId: 'a' })
    expect(shown.map((r) => r.accountId)).toEqual(['a', 'b', 'c'])
  })

  it('起点不在列表（账号刚被删）⇒ **原样按传入顺序**，不回落到余额排序', () => {
    const { shown } = orderCreditRows(rows, { limit: 10, rotationStartId: 'zzz' })
    expect(shown.map((r) => r.accountId)).toEqual(['a', 'b', 'c'])
    // ⚠️ 注意：这里**不是** ['b','c','a']（余额序）——
    //    因为设了起点就走「保持传入顺序」这条腿，找不到就原样。
  })

  it('空 rotationStartId ⇒ 按默认模式（积分降序）', () => {
    const { shown } = orderCreditRows(rows, { limit: 10, rotationStartId: '' })
    expect(shown.map((r) => r.accountId)).toEqual(['b', 'c', 'a'])
  })

  it('折叠逻辑不受排序影响', () => {
    const noStart = orderCreditRows(rows, { limit: 2 })
    expect(noStart.shown).toHaveLength(2)
    expect(noStart.hidden).toBe(1)
    const withStart = orderCreditRows(rows, { limit: 2, rotationStartId: 'c' })
    expect(withStart.shown).toHaveLength(2)
    expect(withStart.hidden).toBe(1)
  })

  it('expanded=true ⇒ 不折叠', () => {
    const { shown, hidden } = orderCreditRows(rows, { limit: 2, expanded: true, rotationStartId: 'c' })
    expect(shown).toHaveLength(3)
    expect(hidden).toBe(1)
  })
})

describe('两处 label 共用同一函数（防格式漂移）', () => {
  it('★ 定义了 accountOptionLabel', () => {
    expect(source).toMatch(/function accountOptionLabel\(account, reason\)/)
  })

  it('★ 下拉框选项调它', () => {
    expect(source).toMatch(/accountOptionLabel\(account, reason\)/)
  })

  it('★ 积分列表调它（通过 accountLabelForCredits）', () => {
    expect(source).toMatch(/accountLabelForCredits/)
    expect(source).toContain('accountOptionLabel(meta, reasonOf(meta))')
  })

  it('★ 用的是「位次」而不是「账号」', () => {
    // 用户 2026-11-10 明确要求改叫「位次」，避免「编号指向哪个账号」的误解
    expect(source).toContain('位次 ${account.position}')
    expect(source).not.toContain('账号 ${account.position}')
  })

  it('★ 后缀保留全角括号', () => {
    expect(source).toContain("return '（本模型限流）'")
    expect(source).toContain("return '（无临时积分）'")
  })
})

describe('位次按「默认顺序」算，不随起点漂移', () => {
  it('★ 积分行的 position 从 rotationState 查，不用 map 索引', () => {
    // ⚠️ 用 `shown.map((row, i) => i + 1)` 会随起点漂移 —— 这正是用户最初担心的
    expect(source).toContain('rotationState?.accounts?.find((a) => a.id === row.accountId)')
    /**
     * ⚠️ **必须用「代码行」判定，不能裸匹配全文件**（本用例第一版就这么错）：
     * 注释里那句「不能用 `shown.map((row, i) => i + 1)`」**自己也会命中** ⇒ 假红。
     * ⇒ 只看**不以 `*` 或 `//` 开头的行**。
     */
    const codeLines = source.split('\n').filter((line) => {
      const t = line.trim()
      return !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*')
    })
    expect(codeLines.some((line) => /shown\.map\(\(row,\s*i\)/.test(line))).toBe(false)
  })
})

describe('⚠️ 裸字符串格式不得让 `in` 运算符抛错（真实缺陷，2026-11-10）', () => {
  /**
   * ## 缺陷经过
   *
   * 用户报障：「下拉框无论选哪项都自动回跳默认，窗口闪一下」。
   *
   * 根因链：
   * 1. `state.json` 里存的是**最老格式**（裸字符串 `"buddy-53b8288f"`）；
   * 2. `sanitizePreferredRotation` **原样保留**它（不转换）；
   * 3. `setPreferredRotation` 里写 `'position' in current` ⇒
   *    **对字符串用 `in` 直接抛 `TypeError`**；
   * 4. 写入崩溃 ⇒ RPC 返错 ⇒ 前端回跳默认 + 闪一下。
   *
   * ⇒ 本组用例锁死：**三种格式都不得抛错**。
   */
  it('★ 三种格式的判断都不抛错（用 typeof 收窄）', () => {
    const cases = [
      ['buddy-1', 'string'],
      [{ accountId: 'buddy-1', at: 0 }, 'legacy-object'],
      [{ position: 2, at: 1 }, 'position-object'],
      [undefined, 'undefined'],
      [null, 'null'],
    ]
    for (const [entry] of cases) {
      // 复现 preferredRotationFor 的三支判断 —— 不得抛
      expect(() => {
        if (typeof entry === 'string') return entry
        if (typeof entry === 'object' && entry !== null && 'accountId' in entry) return entry.accountId
        if (typeof entry === 'object' && entry !== null && 'position' in entry) return entry.position
        return undefined
      }).not.toThrow()
    }
  })

  it('★ 源码里不得出现裸 `in` 判断（必须先用 typeof 收窄）', () => {
    const poolSource = readFileSync(join(process.cwd(), 'src', 'account-pool.ts'), 'utf8')
    // 匹配 `'xxx' in entry` / `'xxx' in current` 这类，但前面没有 typeof 的
    /**
     * ⚠️ **必须排除注释行**（本用例第一版漏了，把注释里那句
     * 「原写 `'accountId' in entry`」当成真实代码 ⇒ 假红）。
     */
    const codeLines = poolSource.split('\n').filter((line) => {
      const t = line.trim()
      return t.length > 0 && !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*')
    })
    const risky = codeLines.filter(
      (line) => /'[a-zA-Z]+' in (entry|current)/.test(line) && !line.includes('typeof'),
    )
    expect(risky).toEqual([])
  })

  it('★ `PreferredRotationEntry` 类型含 string 分支', () => {
    const storeSource = readFileSync(join(process.cwd(), 'src', 'jet-hub-store.ts'), 'utf8')
    expect(storeSource).toMatch(/export type PreferredRotationEntry =[\s\S]*?\| string/)
  })

  it('★ `atOf` 辅助把裸字符串当 `at = 0`（淘汰时最先丢）', () => {
    const storeSource = readFileSync(join(process.cwd(), 'src', 'jet-hub-store.ts'), 'utf8')
    expect(storeSource).toContain("return typeof entry === 'string' ? 0 : entry.at")
  })
})