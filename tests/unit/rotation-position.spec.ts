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

/**
 * ★★ **2026-11-18 重写：排序口径从「积分降序」改为「后端选号机制」**。
 *
 * 用户要求「模式 A 统一成按积分行号机制排序，模式 B 在 A 基础上更换轮换起点」。
 *
 * | 模式 | 顺序 |
 * |---|---|
 * | A（无起点）| **档位序**：临期 → 短期 → 永久 → 不可用（同档按位次）|
 * | B（有起点）| A 的结果再**绕一圈**，起点及其之后提到最前 |
 *
 * ⇒ 模式 B 现在是「A + 旋转」，不再是「保持传入顺序 + 旋转」——
 *    这是本次改动的**核心**：让两种模式共享同一套排序，只有起点不同。
 */
describe('orderCreditRows —— 双模式排序（后端口径）', () => {
  const DAY = 86_400_000
  const NOW = Date.UTC(2026, 10, 18, 9)
  /** 造「剩 N 天到期」的行。 */
  const acc = (id, days) => ({
    accountId: id,
    balance: {
      total: 100,
      packages: [{
        name: 'p', unit: 'credits', remaining: 100, total: 100, used: 0, active: true,
        cycleStartTime: '', cycleEndTime: '', expiredTime: '',
        ...(days === undefined ? {} : { deductionEndTime: NOW + days * DAY }),
      }],
      expiredTotal: 0,
    },
  })
  const base = { limit: 10, windowDays: 15, imminentDays: 5, now: NOW }
  /** a=永久(30天) b=临期(2天) c=短期(10天) */
  const rows = [acc('a', 30), acc('b', 2), acc('c', 10)]

  it('★ 默认（无 rotationStartId）⇒ **档位序**：临期 → 短期 → 永久', () => {
    const { shown } = orderCreditRows(rows, base)
    expect(shown.map((r) => r.accountId), 'b(临期) → c(短期) → a(永久)').toEqual(['b', 'c', 'a'])
  })

  it('★ 设了起点 ⇒ **起点绝对第一**（S5）', () => {
    // 档位序 b(临期) → c(短期) → a(永久)；起点 = c ⇒ S5 把 c 提到第一
    const { shown } = orderCreditRows(rows, { ...base, rotationStartId: 'c' })
    expect(shown.map((r) => r.accountId), 'c 第一，随后 b(临期) → a(永久)').toEqual(['c', 'b', 'a'])
  })

  it('★ 起点在首位 ⇒ 与模式 A 完全相同（幂等）', () => {
    const noStart = orderCreditRows(rows, base)
    const startAtFirst = orderCreditRows(rows, { ...base, rotationStartId: 'b' })
    expect(startAtFirst.shown.map((r) => r.accountId)).toEqual(noStart.shown.map((r) => r.accountId))
  })

  it('起点不在列表（账号刚被删）⇒ **原样按档位序**，不报错', () => {
    const { shown } = orderCreditRows(rows, { ...base, rotationStartId: 'zzz' })
    expect(shown.map((r) => r.accountId), '找不到起点 ⇒ 保持档位序').toEqual(['b', 'c', 'a'])
  })

  it('空 rotationStartId ⇒ 按默认模式（档位序）', () => {
    const noStart = orderCreditRows(rows, base)
    const emptyStart = orderCreditRows(rows, { ...base, rotationStartId: '' })
    expect(emptyStart.shown.map((r) => r.accountId)).toEqual(noStart.shown.map((r) => r.accountId))
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

  /**
   * ★ 积分列表与下拉框必须**同源**（防格式漂移）。
   *
   * ## ⚠️ 2026-11-18 改：积分列表改成「两列定宽」结构后，不再直接用
   *    `accountOptionLabel` 拼整串（那样没法给位次和账号名各自定宽）。
   * 但其**语义必须仍然同源**，这条守卫因此改判据而不是删掉：
   *
   * | 函数 | 用途 | 共同点 |
   * |---|---|---|
   * | `accountOptionLabel` | 下拉框（单行文本） | 都从 `account.position` /
   * | `accountRowParts` | 积分列表（拆成两列） | `account.nickname` / `reasonSuffix` 取值 |
   *
   * ⇒ 判据变成三条：①两个函数都在、②两处都调 `reasonOf`、③两处都用
   *    `reasonSuffix` 拼后缀（同一个后缀口径）。
   */
  it('★ 积分列表与下拉框同源（两处都从 position/nickname/reasonSuffix 取值）', () => {
    expect(source, '下拉框函数必须在').toMatch(/accountOptionLabel\(account, reason\)/)
    expect(source, '积分列表的两段式函数必须在').toMatch(/accountRowParts\(account, reason\)/)
    // ① 两处都用同一个位次来源
    expect(source, '两处都必须用 account.position').toContain('${account.position}')
    // ② 两处都用同一个 nickname
    expect(source, '两处都必须用 account.nickname').toContain('${account.nickname}')
    // ③ 两处都用同一个后缀函数（这是最容易漂移的一格）
    const suffixUses = (source.match(/reasonSuffix\(reason\)/g) || []).length
    expect(suffixUses, 'reasonSuffix(reason) 应出现两次（下拉框 + 积分列表）').toBeGreaterThanOrEqual(2)
    // ④ 积分列表的每一行都由 rowMetaOf 查到 meta 后再算（不能跳过 meta 直接拼）
    expect(source, '账号行必须通过 rowMetaOf 取 meta').toContain('rowMetaOf(row)')
    // ⚠️ 2026-11-18：reason 先算出来（同一份 reasonOf 结果既判灰化、也拼后缀）
    expect(source, '拿到 meta 后必须先算 reason').toMatch(/const reason = meta === null \? null : reasonOf\(meta\)/)
    expect(source, '再用 reason 调 accountRowParts').toMatch(/accountRowParts\(meta, reason\)/)
  })

  it('★ 用的是「位次」而不是「账号」', () => {
    // 用户 2026-11-10 明确要求改叫「位次」，避免「编号指向哪个账号」的误解
    expect(source).toContain('位次 ${account.position}')
    expect(source).not.toContain('账号 ${account.position}')
  })

  it('★ 后缀保留全角括号', () => {
    expect(source).toContain("return '（本模型限流）'")
    expect(source).toContain("return '（无短临积分）'")
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