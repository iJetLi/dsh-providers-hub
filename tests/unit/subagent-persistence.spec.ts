/**
 * ★★★ **持久化守卫**：`subagentAssignments` 必须两后端都**真写真读**。
 *
 * ## 上游审计原话（阻断项）
 *
 * > 「`subagentAssignments` **两个后端都没持久化**
 * >   （`SettingsStore` 的 `load`/`save`、`FileStore` 的 `load` 全漏键；
 * >   `FileStore` 只写不读）。」
 *
 * ## 为什么这个 bug 特别隐蔽
 *
 * `AccountPool` 把字段塞进 `JetHubState` 就以为完事了 —— 而 **store 层的
 * `load()` 不把它读回来** ⇒ 重启后静默变成 `{}` ⇒
 * 已拉起的子代理全部丢失 `pin` / `slot` / `userPicked`。
 *
 * ⚠️ 症状是「重启后子代理开始烧主代理的号」，**零报错**。
 *
 * ## 本文件怎么守
 *
 * `FileStore` 是**未导出的内部类** ⇒ 通过 **`createJetHubStore`**（导出）
 * 用一个「没有 settings 服务」的最小 ctx 触发文件后端，然后跑真实
 * save → load，断言字段回来。
 *
 * ⚠️ 这是**行为级**断言，不是源码文本 —— 上一版正是「只有纯函数用例，
 *    删掉整段接线 92 条仍全绿」。
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { createJetHubStore } from '../../src/jet-hub-store.js'

const here = dirname(fileURLToPath(import.meta.url))

const tmpDirs = []

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }) } catch { /* 忽略 */ }
  }
})

/**
 * 造一个最小 ctx，让 `createJetHubStore` 落到 **FileStore** 分支。
 *
 * ⚠️ 必须**没有** `settings` 服务（否则会走 SettingsStore），
 * 且 `DSH_HOME` 必须可解析（否则退化成 MemoryStore）。
 */
function makeFileStore() {
  const dir = mkdtempSync(join(tmpdir(), 'jet-hub-persist-'))
  tmpDirs.push(dir)
  const savedEnv = process.env.DSH_HOME
  process.env.DSH_HOME = dir
  const ctx = { logger: { warn: () => {}, info: () => {} } }
  const store = createJetHubStore(ctx)
  return {
    store,
    restore: () => {
      if (savedEnv === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = savedEnv
    },
  }
}

/** 一个带子代理分配的完整 state（其余字段给最小合法值）。 */
function stateWithAssignments() {
  const now = Date.now()
  return {
    accounts: [],
    subagentAssignments: {
      probe: {
        'child-1': {
          sessionId: 'child-1',
          parentSessionId: 'main-1',
          at: now,
          slot: 3,
          pinnedAccountId: 'acct-p',
          pinSetAt: now,
        },
      },
    },
  }
}

describe('持久化：subagentAssignments 必须真写真读', () => {
  it('★★★ FileStore：save 后 load 能读回（上游审计的阻断项）', async () => {
    const { store, restore } = makeFileStore()
    try {
      expect(store.kind, '必须是文件后端（否则测的不是生产路径）').toBe('file')

      await store.save(stateWithAssignments())
      const loaded = await store.load()

      expect(loaded?.subagentAssignments, '★★★ 必须读得回（上一版这里是 undefined）').toBeDefined()
      expect(loaded.subagentAssignments.probe, '必须有 provider 键').toBeDefined()
      expect(loaded.subagentAssignments.probe['child-1'], '必须有 session 条目').toBeDefined()
      expect(
        loaded.subagentAssignments.probe['child-1'].pinnedAccountId,
        '★★★ pin 必须存活（否则重启后子代理会烧主代理的号）',
      ).toBe('acct-p')
      expect(loaded.subagentAssignments.probe['child-1'].slot, 'slot 必须存活').toBe(3)
    } finally {
      restore()
    }
  })

  it('★★★ 老文档没有该键 ⇒ 空表（不是 undefined）', async () => {
    const { store, restore } = makeFileStore()
    try {
      await store.save({ accounts: [] })
      const loaded = await store.load()

      expect(loaded.subagentAssignments, '★★ 老文档 → 空表（与升级前行为一致）').toEqual({})
    } finally {
      restore()
    }
  })

  it('★★ 空 provider 表被丢弃（不留噪音键）', async () => {
    const { store, restore } = makeFileStore()
    try {
      await store.save({ accounts: [], subagentAssignments: { probe: {}, other: {} } })
      const loaded = await store.load()

      expect(loaded.subagentAssignments, '★★ 空表不该留下噪音键').toEqual({})
    } finally {
      restore()
    }
  })
})

/**
 * ⚠️ **`SettingsStore` 的两处只能源码锚点**（如实登记）。
 *
 * ## 为什么不能行为级测
 *
 * `SettingsStore` 依赖宿主的 `ctx.settings.register(namespace, schema)` 返回值，
 * 单测里造不出那个 scope 对象（要复刻宿主 settings 服务的完整契约）。
 *
 * ⇒ 用**源码锚点**固定「schema / load / save 三处都有该键」。
 *
 * ⚠️ 这是**弱守卫**（上游审计批评的正是这类文本断言）—— 所以：
 * 1. `FileStore` 那条腿有**行为级**用例（真实 save → load）；
 * 2. 本组只补 `SettingsStore` 的**存在性**，并**如实标注它是弱守卫**。
 */
describe('SettingsStore：源码锚点（弱守卫，已如实登记）', () => {
  const storeSrc = readFileSync(join(here, '../../src/jet-hub-store.ts'), 'utf8')

  it('★★ schema 必须声明该键（否则 settings 后端写不进去）', () => {
    expect(
      storeSrc,
      '★★ schema 缺键 ⇒ SettingsStore 的 save 会被宿主 schema 丢掉',
    ).toMatch(/subagentAssignments:\s*Schema\.dict/)
  })

  it('★★ SettingsStore.load 的 return 必须包含该键', () => {
    /**
     * 定位 `SettingsStore` 类体，找它的 load 返回块。
     */
    const classIdx = storeSrc.indexOf('class SettingsStore implements JetHubStore')
    expect(classIdx).toBeGreaterThan(-1)
    const nextClass = storeSrc.indexOf('class MemoryStore', classIdx)
    const body = storeSrc.slice(classIdx, nextClass > 0 ? nextClass : undefined)

    /** ⚠️ `SettingsStore.load` 是**同步**的（`load(): JetHubState | undefined {`），不是 async。 */
    const loadIdx = body.indexOf('load(): JetHubState')
    expect(loadIdx).toBeGreaterThan(-1)
    const loadBlock = body.slice(loadIdx, loadIdx + 4000)
    expect(
      loadBlock,
      '★★ SettingsStore.load 必须读回该键（否则重启后丢失）',
    ).toContain('subagentAssignments: sanitizeSubagentAssignmentsOf(value.subagentAssignments)')
  })

  it('★★ SettingsStore.save 必须写出该键', () => {
    const classIdx = storeSrc.indexOf('class SettingsStore implements JetHubStore')
    const nextClass = storeSrc.indexOf('class MemoryStore', classIdx)
    const body = storeSrc.slice(classIdx, nextClass > 0 ? nextClass : undefined)

    const saveIdx = body.indexOf('async save(')
    expect(saveIdx).toBeGreaterThan(-1)
    const saveBlock = body.slice(saveIdx, saveIdx + 4000)
    expect(
      saveBlock,
      '★★ SettingsStore.save 必须写出该键（否则重启后丢失）',
    ).toContain('subagentAssignments: sanitizeSubagentAssignmentsOf(state.subagentAssignments)')
  })
})