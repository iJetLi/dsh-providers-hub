/**
 * ★★★ **第四轮审计的 4 条遗留项**（2026-11-24）。
 *
 * 上游在 #151 合并评论里列了 5 条「如实登记、本轮没动」，其中
 * `sameTierIds` 档位闸门已在 #153 修掉，剩下这 4 条。
 *
 * ## ⚠️ 本文件的判据纪律
 *
 * 前两版我用的是**源码文本匹配**（`toContain('startDecidedByUser')` 之类）——
 * 变异验证当场证明它们**无牙**：
 *
 * | 变异 | 文本判据 |
 * |---|---|
 * | 落盘改成无条件 | ❌ 绿 |
 * | 去掉 `startDecidedByUser` 的语义 | ❌ 绿 |
 *
 * ⇒ 改成**行为级**：真的造一个 `AccountPool` / 跑一次 resolver 取号，
 *    用**结果**判断，而不是看代码里有没有某个词。
 */
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import { AccountPool } from '../../src/account-pool.js'
import { BuddyBalanceSelector } from '../../src/buddy-balance-selector.js'
import { createCredentialResolver } from '../../src/credential-resolver.js'
import {
  markSubagentEnded,
  recordSubagentAssignment,
  type SubagentAssignmentMap,
} from '../../src/subagent-rotation.js'

const here = dirname(fileURLToPath(import.meta.url))
const rpcSrc = readFileSync(join(here, '../../src/jet-hub-rpc.ts'), 'utf8')

const tmpDirs = []
afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }) } catch { /* 忽略 */ }
  }
})

// ============================================================================
// ③ 每请求写盘 —— 行为级：数文件 mtime 变了几次
// ============================================================================
describe('③ recordSubagentStart 必须「没变化就不落盘」', () => {
  /**
   * 用**真实 FileStore**（`DSH_JET_HUB_STATE_DIR` 指向临时目录）+ 真 `AccountPool`，
   * 然后数 `state.json` 的 **mtime 变化次数**。
   *
   * ⚠️ 这是唯一可靠的判据：源码文本断言对「改成无条件写」**无牙**
   *    （字面量 `changed &&` 还在，只是被短路或条件恒真）。
   */
  function makeFilePool() {
    const dir = mkdtempSync(join(tmpdir(), 'jet-hub-write-'))
    tmpDirs.push(dir)
    const saved = process.env.DSH_JET_HUB_STATE_DIR
    process.env.DSH_JET_HUB_STATE_DIR = dir
    const pool = new AccountPool({ logger: { warn: () => {}, info: () => {} } } as never)
    return {
      pool,
      statePath: join(dir, 'jet-hub', 'state.json'),
      restore: () => {
        if (saved === undefined) delete process.env.DSH_JET_HUB_STATE_DIR
        else process.env.DSH_JET_HUB_STATE_DIR = saved
      },
    }
  }

  it('★★★ 同一个子代理重复登记 ⇒ state.json 的 mtime 不再变', async () => {
    const { pool, statePath, restore } = makeFilePool()
    try {
      await pool.recordSubagentStart('probe', 'child-1', 'parent-1', 1000)
      const mtimeAfterFirst = statSync(statePath).mtimeMs

      /** ⚠️ 等 20ms 确保 mtime 精度能区分（某些 fs 只有 1ms 精度）。 */
      await new Promise((r) => setTimeout(r, 20))

      /** 模拟第二、第三发请求（`resolveCredential` 每发都会调用一次）。 */
      await pool.recordSubagentStart('probe', 'child-1', 'parent-1', 2000)
      await pool.recordSubagentStart('probe', 'child-1', 'parent-1', 3000)

      const mtimeAfterRepeats = statSync(statePath).mtimeMs
      expect(
        mtimeAfterRepeats,
        '★★★ 重复登记**不该**再写盘（上一版每请求写一次）',
      ).toBe(mtimeAfterFirst)
      expect(pool.subagentAssignmentOf('probe', 'child-1')?.slot, 'slot 必须保留').toBe(0)
    } finally {
      restore()
    }
  })

  it('★★ 不同子代理 ⇒ 必须各自落盘（反向对照）', async () => {
    const { pool, statePath, restore } = makeFilePool()
    try {
      await pool.recordSubagentStart('probe', 'child-1', 'parent-1', 1000)
      const t1 = statSync(statePath).mtimeMs
      await new Promise((r) => setTimeout(r, 20))
      await pool.recordSubagentStart('probe', 'child-2', 'parent-1', 2000)
      const t2 = statSync(statePath).mtimeMs

      expect(t2, '★★ 新子代理必须落盘').toBeGreaterThan(t1)
      expect(pool.subagentAssignmentOf('probe', 'child-2')?.slot, 'slot 必须是 1').toBe(1)
    } finally {
      restore()
    }
  })
})
// ============================================================================
// ① ended 字段的生产语义
// ============================================================================
describe('① ended 字段的生产语义', () => {
  it('★★ markSubagentEnded 保留 slot 且置 ended', () => {
    const seed = recordSubagentAssignment({}, 'child-1', 'parent-1', 2, 1000)
    const out = markSubagentEnded(seed, 'child-1')
    expect(out['child-1']!.ended).toBe(true)
    expect(out['child-1']!.slot, 'resume 要用原 slot').toBe(2)
    expect(out['child-1']!.at, 'at 不得变（淘汰按它排）').toBe(1000)
  })

  it('★★ resume 时 ended 复位为 false（同一 slot 复用、at 保留）', () => {
    /**
     * ⚠️ `at` **刻意不刷新**：淘汰按 `at` 排序，若 resume 刷新 `at`，
     * 长期复用的子代理会**永远不被淘汰**（无限增长）。
     *
     * ⚠️ 我第一版断言「resume 要刷新 at」—— **错的**，实现是对的。
     */
    const seed = recordSubagentAssignment({}, 'child-1', 'parent-1', 2, 1000)
    const ended = markSubagentEnded(seed, 'child-1')
    expect(ended['child-1']!.ended).toBe(true)

    const resumed: SubagentAssignmentMap = recordSubagentAssignment(ended, 'child-1', 'parent-1', 2, 5000)
    expect(resumed['child-1']!.ended, '★★ resume 必须把 ended 复位').toBe(false)
    expect(resumed['child-1']!.slot, '★★ slot 必须不变').toBe(2)
    expect(resumed['child-1']!.at, '★★ at 必须保留原值（否则永不淘汰）').toBe(1000)
  })
})
