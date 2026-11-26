/**
 * ★★★ **死残留守卫**：三个「声明了但不存在」的符号不得再出现
 *
 * ## 为什么要有这个文件
 *
 * `AccountPool` 在 `34b2137f` 的重构里删掉了 `pinSubagentAccount` /
 * `setUserPickedAccount`（子代理起点改存 `preferredRotation`），但
 * `credential-resolver.ts` 的**接口声明和调用点没跟着删**：
 *
 * ```ts
 * if (sessionId !== undefined && pinMode !== 'fixed') {
 *   void deps.pool.pinSubagentAccount?.(…)   // ← ?. 永远短路
 * }
 * ```
 *
 * ⇒ **静默 no-op**：不报错、不生效、注释还写着「钉住」。
 *
 * ⚠️ 上游在 PR #171 点名过这个残留，当时只清了 `index.ts` 那处，
 *    `credential-resolver.ts` 里还有**两处**（免费路径 + 付费路径）。
 *
 * ## 本文件挡什么
 *
 * | 判据 | 挡什么 |
 * |---|---|
 * | 「符号在 `src/` 里**非注释**出现」= 0 | 调用点/接口声明被重新加回来 |
 * | `AccountPool` 确实没有这些方法 | 有人以为「池上有，只是没接线」 |
 *
 * ⚠️ 为什么用**源码计数**而不是行为级：这三者的「不存在」是**结构性事实**
 * （类型层面就不该有），行为级测不出来 —— 一个永假的 `?.()` 不改变任何输出。
 * 这与上游说的「守卫要打在行为上」不矛盾：**这里要守的正是「符号不该存在」**。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = join(HERE, '../../src')

/** 读源码并**剥掉注释**（防「注释里提过」被算成出现）。 */
function readStripped(name: string): string {
  return readFileSync(join(SRC, name), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}
/**
 * ★★★ **递归列出 `src/` 下所有 .ts 文件**（2026-11-27 正向审计修）。
 *
 * ## 为什么要改这一条
 *
 * 原实现只扫 **4 个硬编码文件名**（`credential-resolver` / `index` / `account-pool`
 * / `officeace-lock`）。审计实测：往 **`jet-hub-rpc.ts`** 里注入一句真的
 * `pool.pinSubagentAccount?.(...)` ⇒ **守卫 5 条全绿**。
 *
 * ⇒ 那条「不得复活」的守卫**只挡得住「在原处加回来」**，挡不住「在别处加回来」——
 *   而后者才是真实复发的形态（`34b2137f` 那两处之一就在别的文件里）。
 */
function readStrippedRaw(fullPath: string): string {
  return readFileSync(fullPath, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}
function allSrcFiles(dir: string = SRC): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...allSrcFiles(full))
    else if (entry.isFile() && entry.name.endsWith('.ts')) out.push(full)
  }
  return out
}

/**
 * 三个已删除的符号。
 *
 * ⚠️ 每个都带**删除理由**，避免下一个人「看不懂为什么不能加回来」。
 */
const REMOVED = [
  {
    name: 'pinSubagentAccount',
    why: 'AccountPool 在 34b2137f 已删（起点改存 preferredRotation）⇒ `?.()` 永远短路 = 静默 no-op',
  },
  {
    name: 'setUserPickedAccount',
    why: '同上；用户手选现在直接写 preferredRotation（与主代理同一个入口）',
  },
  {
    name: 'isSubagentById',
    why: '全仓零调用的死函数（判据 `parentOfSession(sid) !== undefined` 已内联在需要处）',
  },
]

describe('★★★ 死残留：已删除的符号不得复活', () => {
  for (const item of REMOVED) {
    it(`★★★ ${item.name} 在 src/ 里不得有非注释出现`, () => {
      /**
       * ⚠️⚠️ **必须扫全 `src/`**（2026-11-27 正向审计修的假绿）。
       *
       * 原实现只扫 4 个硬编码文件 ⇒ 往 `jet-hub-rpc.ts` 注入真调用时**全绿**。
       * 判据仍是「词边界计数」（`\b` 防 `XxxYyy` 误命中），但现在覆盖整棵树。
       */
      const hits: string[] = []
      for (const full of allSrcFiles()) {
        const code = readStrippedRaw(full)
        const n = (code.match(new RegExp('\\b' + item.name + '\\b', 'g')) ?? []).length
        if (n > 0) hits.push(`${full.slice(SRC.length + 1)}×${n}`)
      }
      expect(
        hits,
        `★★★ ${item.name} 已被删除，不得加回来。理由：${item.why}`,
      ).toEqual([])
    })
  }

  it('★★★ AccountPool 上确实没有这三个方法（不是「有但没接」）', () => {
    /**
     * ⚠️ 这条与上面三条**不是重复**：
     *
     * 上面守的是「src/ 里没人提到它们」；
     * 这条守的是「**池上真的没有**」—— 若有人实现了池方法却没接线，
     * 上面那条会绿（没人提到），但功能仍然没生效。两条合起来才完整。
     */
    const pool = readFileSync(join(SRC, 'account-pool.ts'), 'utf8')
    for (const item of REMOVED) {
      /** ⚠️ 只看「方法定义」形态（`name(` 前面是缩进 + 可选 async），不看注释。 */
      const stripped = pool
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1')
      const defined = new RegExp('^\\s*(async\\s+)?' + item.name + '\\s*\\(', 'm').test(stripped)
      expect(
        defined,
        `★★ ${item.name} 不应在 AccountPool 上定义（若真要恢复，需同时接线上并删掉本守卫）`,
      ).toBe(false)
    }
  })

  it('★★ 反向对照：仍在使用的子代理方法必须存在（证明上面不是「一律为空」）', () => {
    /**
     * ⚠️ **没有这条，上面三条可能是「文件读错了 / 正则写错了」导致的假绿**。
     * 这里挑几个**确实在用**的方法，断言它们**在** —— 若它们也不在，
     * 说明本文件的读取或正则坏了，上面的「不得出现」就毫无意义。
     */
    const pool = readFileSync(join(SRC, 'account-pool.ts'), 'utf8')
    const ALIVE = [
      'recordSubagentStart',
      'setPreferredRotation',
      'preferredRotationFor',
      'subagentAssignmentOf',
      'subagentRotationFor',
      'setSubagentStartPosition',
      'subagentStartPositionOf',
      'activeAccountOf',
      'setActiveAccount',
    ]
    /**
     * ⚠️⚠️ **必须断言「作为方法定义存在」，不能用 `includes` 子串**（2026-11-27 正向审计修）。
     *
     * 原实现是 `expect(pool.includes(m)).toBe(true)` —— 审计实测：
     * 把 `setActiveAccount` 改名成 `setActiveAccountZZZ` 后，
     * `pool.includes('setActiveAccount')` **仍为 true**（子串），**守卫全绿**。
     *
     * ⇒ 反向对照的意义是「证明读取与正则没坏」，用子串连「名字还在不在」都测不出来。
     */
    const stripped = pool
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1')
    for (const m of ALIVE) {
      const asMethod = new RegExp('^\\s*(?:async\\s+)?' + m + '\\s*[(<]', 'm').test(stripped)
      expect(
        asMethod,
        `★★ ${m} 应当仍作为 AccountPool 的方法存在（若不在，说明本文件的判据已失效）`,
      ).toBe(true)
    }
  })
})
