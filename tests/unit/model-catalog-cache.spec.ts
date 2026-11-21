import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  clearCatalogCache,
  isCatalogCacheEnabled,
  modelCatalogCacheDir,
  modelCatalogCacheFile,
  readCatalogCache,
  readCatalogCacheAt,
  setCatalogCacheEnabledForTest,
  writeCatalogCache,
} from '../../src/model-catalog-cache.js'
import type { CatalogEntry } from '../../src/model-catalog.js'

/**
 * 模型目录的磁盘缓存（SWR 的存取层）。
 *
 * ⚠️ 本文件的用例**必须自己打开缓存开关**：`tests/setup-isolation.ts` 默认
 * 把它关掉了（整个测试套件都关），否则单测会互相串味。
 */
describe('model-catalog-cache', () => {
  let savedHome: string | undefined
  let tempHome: string

  const entries: readonly CatalogEntry[] = [
    { id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 200_000 },
    { id: 'ds-v4', name: 'DS · x0.5', isFree: true },
  ]

  beforeEach(() => {
    savedHome = process.env.DSH_HOME
    tempHome = mkdtempSync(join(tmpdir(), 'mcc-test-'))
    process.env.DSH_HOME = tempHome
    // ★ 本文件要看真实读写 ⇒ 显式打开（全局默认是关的）。
    setCatalogCacheEnabledForTest(true)
  })

  afterEach(() => {
    setCatalogCacheEnabledForTest(false)
    if (savedHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = savedHome
    rmSync(tempHome, { recursive: true, force: true })
  })

  describe('基本存取', () => {
    it('★ 没有缓存 ⇒ undefined（首次运行的正常形态）', () => {
      expect(readCatalogCache('buddy')).toBeUndefined()
    })

    it('★★ 写后能读回，且字段逐字保留', () => {
      expect(writeCatalogCache('buddy', entries, true)).toBe(true)
      const read = readCatalogCache('buddy')
      expect(read).toEqual(entries)
      // ⚠️ 逐字段核对（`toEqual` 对 readonly 断言仍可能漏掉「多了字段」）
      expect(read?.[0]?.contextWindow).toBe(200_000)
      expect(read?.[1]?.isFree).toBe(true)
    })

    it('★ 按 provider 分文件（互不覆盖）', () => {
      writeCatalogCache('buddy', entries, true)
      writeCatalogCache('trae', [{ id: 'x', name: 'X' }], true)
      expect(readCatalogCache('buddy')).toHaveLength(2)
      expect(readCatalogCache('trae')).toHaveLength(1)
    })

    it('★ 文件落在 $DSH_HOME/cache/model-catalog/<provider>.json', () => {
      writeCatalogCache('buddy', entries, true)
      const expected = join(tempHome, 'jet-hub', 'cache', 'model-catalog', 'buddy.json')
      expect(existsSync(expected)).toBe(true)
    })

    it('★ 缓存写入时刻可读（诊断用）', () => {
      const now = 1_700_000_000_000
      writeCatalogCache('buddy', entries, true, now)
      expect(readCatalogCacheAt('buddy')).toBe(now)
    })

    it('★ 没有缓存时 readCatalogCacheAt 返回 0', () => {
      expect(readCatalogCacheAt('nope')).toBe(0)
    })
  })

  describe('⚠️ 空目录不写盘（核心不变式）', () => {
    it('★★★ 空数组 ⇒ 不写，且**不覆盖**已有好缓存', () => {
      writeCatalogCache('buddy', entries, true)
      // 模拟「上游这次回了空目录」：绝不能把磁盘上那份好的覆盖掉
      expect(writeCatalogCache('buddy', [], true)).toBe(false)
      expect(readCatalogCache('buddy')).toHaveLength(2)
    })
  })

  describe('⚠️ 磁盘格式损坏时的降级', () => {
    const writeRaw = (content: string): void => {
      const dir = join(tempHome, 'jet-hub', 'cache', 'model-catalog')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'buddy.json'), content, 'utf8')
    }

    it('★★ 版本不符 ⇒ 丢弃（格式演进安全）', () => {
      writeRaw(JSON.stringify({ version: 999, at: 1, provider: 'buddy', entries, complete: true }))
      expect(readCatalogCache('buddy')).toBeUndefined()
    })

    it('★★ provider 不符 ⇒ 丢弃（防串味）', () => {
      writeRaw(JSON.stringify({ version: 1, at: 1, provider: 'trae', entries, complete: true }))
      expect(readCatalogCache('buddy')).toBeUndefined()
    })

    it('★★ 半截 JSON ⇒ 丢弃，不抛错', () => {
      writeRaw('{"version":1,"entries":[')
      expect(readCatalogCache('buddy')).toBeUndefined()
    })

    it('★★ entries 不是数组 ⇒ 丢弃', () => {
      writeRaw(JSON.stringify({ version: 1, at: 1, provider: 'buddy', entries: 'oops' }))
      expect(readCatalogCache('buddy')).toBeUndefined()
    })

    it('★★ 条目缺 id/name ⇒ 逐条剔除（一条坏数据不该让整份作废）', () => {
      writeRaw(JSON.stringify({
        version: 1,
        at: 1,
        provider: 'buddy',
        entries: [
          { id: 'good', name: 'Good' },
          { name: 'no-id' },
          { id: 'no-name' },
          { id: '', name: 'empty-id' },
          null,
        ],
        complete: true,
      }))
      const read = readCatalogCache('buddy')
      expect(read).toHaveLength(1)
      expect(read?.[0]?.id).toBe('good')
    })

    it('★★ 全部条目都非法 ⇒ 等同没有缓存', () => {
      writeRaw(JSON.stringify({ version: 1, at: 1, provider: 'buddy', entries: [{ name: 'x' }], complete: true }))
      expect(readCatalogCache('buddy')).toBeUndefined()
    })
  })

  describe('⚠️ 路径安全', () => {
    it('★★★ 含 ../ 的 provider id 不得逃逸缓存目录', () => {
      const dir = modelCatalogCacheDir()
      writeCatalogCache('../../../evil', entries, true)
      const file = modelCatalogCacheFile('../../../evil')
      // ⚠️ 净化后必须在缓存目录**之内**
      expect(file.startsWith(dir)).toBe(true)
      // 且确实写进去了（证明不是「因为没写所以没逃逸」）
      expect(existsSync(file)).toBe(true)
      // 上级目录不应出现 evil.json
      const escaped = join(tempHome, 'jet-hub', 'cache', 'evil.json')
      expect(existsSync(escaped)).toBe(false)
    })
  })

  describe('★ 原子写（tmp → rename）', () => {
    it('写完后不留 .tmp 残留', () => {
      writeCatalogCache('buddy', entries, true)
      const tmp = `${modelCatalogCacheFile('buddy')}.tmp`
      expect(existsSync(tmp)).toBe(false)
    })

    it('★ 内容是合法 JSON（能被独立解析）', () => {
      writeCatalogCache('buddy', entries, true)
      const raw = readFileSync(modelCatalogCacheFile('buddy'), 'utf8')
      const parsed = JSON.parse(raw) as { version: number; provider: string }
      expect(parsed.version).toBe(1)
      expect(parsed.provider).toBe('buddy')
    })
  })

  describe('★ 测试开关', () => {
    it('★★★ 关掉后读恒 undefined、写恒 false（且不碰磁盘）', () => {
      writeCatalogCache('buddy', entries, true)
      expect(readCatalogCache('buddy')).toHaveLength(2)

      setCatalogCacheEnabledForTest(false)
      expect(isCatalogCacheEnabled()).toBe(false)
      // 读：连文件都不碰
      expect(readCatalogCache('buddy')).toBeUndefined()
      // 写：不产生新文件
      expect(writeCatalogCache('trae', entries, true)).toBe(false)
      expect(existsSync(modelCatalogCacheFile('trae'))).toBe(false)
      // ⚠️ 但**旧文件仍在**（开关只管行为，不做清理）
      expect(readCatalogCacheAt('buddy')).toBeGreaterThan(0)
    })
  })

  describe('★ clearCatalogCache', () => {
    it('删除缓存后读回 undefined', () => {
      writeCatalogCache('buddy', entries, true)
      clearCatalogCache('buddy')
      expect(readCatalogCache('buddy')).toBeUndefined()
    })

    it('删不存在的缓存不抛错', () => {
      expect(() => { clearCatalogCache('nope') }).not.toThrow()
    })
  })
})

