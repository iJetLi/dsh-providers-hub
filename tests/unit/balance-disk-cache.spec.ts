import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  BALANCE_DISK_FLUSH_INTERVAL_MS,
  balanceDiskCacheFile,
  clearBalanceDiskCache,
  flushDisk,
  isBalanceDiskCacheEnabled,
  isDiskDirty,
  noteDiskReading,
  primeFromDisk,
  pruneLegacyBalanceCache,
  readDiskReading,
  resetBalanceDiskCacheStateForTest,
  setBalanceDiskCacheEnabledForTest,
} from '../../src/balance-disk-cache.js'

/**
 * 余额读数的磁盘缓存（跨进程 SWR 的存储层）。
 *
 * ⚠️ 本文件必须自己打开开关：`tests/setup-isolation.ts` 默认关掉它。
 */
describe('balance-disk-cache', () => {
  let savedHome: string | undefined
  let tempHome: string

  /** 一条最小的「成功读数」（本模块只搬运，不解释内部结构）。 */
  const reading = { value: { total: 1000, remaining: 800 }, at: 1_700_000_000_000 }

  beforeEach(() => {
    savedHome = process.env.DSH_HOME
    tempHome = mkdtempSync(join(tmpdir(), 'bdc-test-'))
    process.env.DSH_HOME = tempHome
    setBalanceDiskCacheEnabledForTest(true)
    // ⚠️ 模块级状态必须在每个用例前复位（否则读到上个用例的内存镜像）。
    resetBalanceDiskCacheStateForTest()
  })

  afterEach(() => {
    setBalanceDiskCacheEnabledForTest(false)
    if (savedHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = savedHome
    rmSync(tempHome, { recursive: true, force: true })
  })

  describe('基本存取', () => {
    it('★ 没有缓存 ⇒ undefined', () => {
      expect(readDiskReading('buddy', 'a1')).toBeUndefined()
    })

    it('★★ 写入后能读回（同进程）', () => {
      noteDiskReading('buddy', 'a1', reading)
      expect(readDiskReading('buddy', 'a1')).toEqual(reading)
    })

    it('★ 按 provider + accountId 分别存（不串味）', () => {
      noteDiskReading('buddy', 'a1', reading)
      noteDiskReading('trae', 'a1', { other: true })
      // ⚠️ 读的是**内存镜像**，不依赖是否已 flush（首次那条已落盘，第二条只置脏）。
      expect(readDiskReading('buddy', 'a1')).toEqual(reading)
      expect(readDiskReading('trae', 'a1')).toEqual({ other: true })
      expect(readDiskReading('buddy', 'a2')).toBeUndefined()
    })
  })

  describe('⚠️ 写盘时机（用户指定只有三个）', () => {
    /**
     * ★★★ **首次成功立即写盘，之后不再写**（2026-11-21 修订）。
     *
     * ## 为什么第一版是错的（真实缺陷）
     *
     * 第一版：`noteDiskReading` 只置脏标记，写盘全靠「30 分钟定时器」+「退出钩子」。
     * 实测后果：用户重启间隔只有几分钟 ⇒ 30 分钟没到、钩子没跑
     * ⇒ **`flushDisk` 从未被调用** ⇒ 缓存文件**从未生成** ⇒ 功能完全没生效。
     *
     * ⇒ 补「启动后首次成功即写一次」（`primedThisProcess` 保证每进程只多写一次）。
     * 「减少写盘」的目标仍成立：一天重启 10 次也只是 10 次额外写盘。
     */
    it('★★★ 首次 `noteDiskReading` 立即写盘（自举前提）', () => {
      noteDiskReading('buddy', 'a1', reading)
      // ⚠️ 首条必须落盘，否则下次启动永远没有缓存可读。
      expect(existsSync(balanceDiskCacheFile()), '首次成功应立刻落盘').toBe(true)
      expect(isDiskDirty(), '已写盘 ⇒ 脏标记清').toBe(false)
    })

    it('★★★ 之后的 `noteDiskReading` **不立即写盘**（用户要求减少写盘）', () => {
      noteDiskReading('buddy', 'a1', reading) // 首次 ⇒ 写盘
      // 之后的读数只置脏标记，等 30 分钟定时器 / 退出钩子
      noteDiskReading('buddy', 'a2', reading)
      expect(isDiskDirty(), '第二条只置脏标记').toBe(true)
      // 文件里仍只有第一条（第二次还没 flush）
      const parsed = JSON.parse(readFileSync(balanceDiskCacheFile(), 'utf8')) as {
        readings: Record<string, unknown>
      }
      expect(Object.keys(parsed.readings)).toEqual(['buddy:a1'])
    })

    it('★★★ `flushDisk` 把后续读数写盘', () => {
      noteDiskReading('buddy', 'a1', reading) // 首次已自动写
      noteDiskReading('buddy', 'a2', reading) // 只置脏
      expect(flushDisk(), '有脏数据 ⇒ 写').toBe(true)
      expect(isDiskDirty()).toBe(false)
      const parsed = JSON.parse(readFileSync(balanceDiskCacheFile(), 'utf8')) as {
        readings: Record<string, unknown>
      }
      expect(Object.keys(parsed.readings).sort()).toEqual(['buddy:a1', 'buddy:a2'])
    })

    it('★★ 没有脏数据 ⇒ flush 不写盘（空转的定时器不产生 IO）', () => {
      expect(flushDisk()).toBe(false)
      expect(existsSync(balanceDiskCacheFile())).toBe(false)
    })

    it('★★ 写盘后再次 flush ⇒ 不重复写（脏标记已清）', () => {
      noteDiskReading('buddy', 'a1', reading) // 首次自动写
      expect(flushDisk(), '首次已写 ⇒ 无脏数据').toBe(false)
    })

    it('★ 写盘间隔常量是 30 分钟（用户指定）', () => {
      expect(BALANCE_DISK_FLUSH_INTERVAL_MS).toBe(30 * 60_000)
    })
  })

  describe('★★★ 跨进程读回（核心目的）', () => {
    it('写盘后 → 模拟重启（复位状态）→ prime 能读回', () => {
      noteDiskReading('buddy', 'a1', reading)
      flushDisk()

      // 模拟进程重启：清掉全部模块级状态
      resetBalanceDiskCacheStateForTest()

      /**
       * ⚠️ **这里不能断言 `readDiskReading` 返回 undefined**：
       * 它有**惰性读盘**（`if (!diskRead) primeFromDisk()`）⇒ 复位后第一次调用
       * 就会从磁盘读回来 —— 那是**刻意的鲁棒性设计**（没显式 prime 也能用），
       * 不是 bug。第一版用例在这里断言 undefined 而假红。
       *
       * ⇒ 正确的断言是「**读得到，且值正确**」—— 这既证明了跨进程存活，
       *   也证明了惰性 prime 生效。
       */
      expect(readDiskReading('buddy', 'a1'), '复位后惰性读盘应读回').toEqual(reading)

      // ★ 显式 prime（生产路径在 apply() 时调用它）同样读得到。
      resetBalanceDiskCacheStateForTest()
      expect(primeFromDisk()).toBe(1)
      expect(readDiskReading('buddy', 'a1')).toEqual(reading)
    })

    it('★ prime 幂等（重复调不重复读盘、结果一致）', () => {
      noteDiskReading('buddy', 'a1', reading)
      flushDisk()
      resetBalanceDiskCacheStateForTest()
      expect(primeFromDisk()).toBe(1)
      expect(primeFromDisk()).toBe(1)
    })

    it('★ 没有缓存文件时 prime 返回 0（首次运行）', () => {
      expect(primeFromDisk()).toBe(0)
    })
  })

  describe('⚠️ 格式损坏时的降级', () => {
    const writeRaw = (content: string): void => {
      const path = balanceDiskCacheFile()
      mkdirSync(join(path, '..'), { recursive: true })
      writeFileSync(path, content, 'utf8')
    }

    it('★★ 版本不符 ⇒ 丢弃', () => {
      writeRaw(JSON.stringify({ version: 999, at: 1, readings: { 'buddy:a1': { at: 1, reading } } }))
      resetBalanceDiskCacheStateForTest()
      expect(primeFromDisk()).toBe(0)
      expect(readDiskReading('buddy', 'a1')).toBeUndefined()
    })

    it('★★ 半截 JSON ⇒ 丢弃，不抛错', () => {
      writeRaw('{"version":1,"readings":{')
      resetBalanceDiskCacheStateForTest()
      expect(() => primeFromDisk()).not.toThrow()
      expect(primeFromDisk()).toBe(0)
    })

    it('★★ readings 不是对象 ⇒ 丢弃', () => {
      writeRaw(JSON.stringify({ version: 1, at: 1, readings: 'oops' }))
      resetBalanceDiskCacheStateForTest()
      expect(primeFromDisk()).toBe(0)
    })

    it('★★ 缺 at / reading 的条目被逐条剔除（一条坏数据不毁整份）', () => {
      writeRaw(JSON.stringify({
        version: 1,
        at: 1,
        readings: {
          'buddy:good': { at: 1, reading },
          'buddy:no-at': { reading },
          'buddy:no-reading': { at: 2 },
          'buddy:null': null,
        },
      }))
      resetBalanceDiskCacheStateForTest()
      expect(primeFromDisk()).toBe(1)
      expect(readDiskReading('buddy', 'good')).toEqual(reading)
      expect(readDiskReading('buddy', 'no-at')).toBeUndefined()
    })
  })

  describe('★ 原子写（tmp → rename）', () => {
    it('写完后不留 .tmp', () => {
      noteDiskReading('buddy', 'a1', reading)
      flushDisk()
      expect(existsSync(`${balanceDiskCacheFile()}.tmp`)).toBe(false)
    })

    it('内容是合法 JSON 且带版本号', () => {
      noteDiskReading('buddy', 'a1', reading)
      flushDisk()
      const parsed = JSON.parse(readFileSync(balanceDiskCacheFile(), 'utf8')) as {
        version: number
        readings: Record<string, unknown>
      }
      expect(parsed.version).toBe(1)
      expect(Object.keys(parsed.readings)).toEqual(['buddy:a1'])
    })
  })

  describe('★ 测试开关', () => {
    it('★★★ 关掉后：读恒 undefined、note 不生效、flush 恒 false', () => {
      setBalanceDiskCacheEnabledForTest(false)
      expect(isBalanceDiskCacheEnabled()).toBe(false)

      noteDiskReading('buddy', 'a1', reading)
      expect(isDiskDirty()).toBe(false)
      expect(readDiskReading('buddy', 'a1')).toBeUndefined()
      expect(flushDisk()).toBe(false)
      expect(existsSync(balanceDiskCacheFile())).toBe(false)
    })
  })

  describe('★ clearBalanceDiskCache', () => {
    it('清空后读回 undefined 且文件被删', () => {
      noteDiskReading('buddy', 'a1', reading)
      flushDisk()
      expect(existsSync(balanceDiskCacheFile())).toBe(true)

      clearBalanceDiskCache()
      expect(existsSync(balanceDiskCacheFile())).toBe(false)
      expect(readDiskReading('buddy', 'a1')).toBeUndefined()
      expect(isDiskDirty()).toBe(false)
    })

    it('清不存在的缓存不抛错', () => {
      expect(() => { clearBalanceDiskCache() }).not.toThrow()
    })
  })

  /**
   * ★★ **旧路径清理**（2026-11-21 路径迁移，与模型目录缓存同款）。
   */
  describe('旧路径清理（迁移到 jet-hub/cache/）', () => {
    it('★★★ 缓存路径必须含 jet-hub 一级（用户要求）', () => {
      const f = balanceDiskCacheFile()
      expect(f, '路径必须含 jet-hub').toContain('jet-hub')
      expect(f, '且必须在 jet-hub/cache 下').toContain(join('jet-hub', 'cache'))
    })

    it('★★ 旧文件存在 ⇒ 被删掉', () => {
      const legacy = join(tempHome, 'cache', 'balance-readings.json')
      mkdirSync(join(tempHome, 'cache'), { recursive: true })
      writeFileSync(legacy, '{}', 'utf8')
      expect(existsSync(legacy)).toBe(true)

      expect(pruneLegacyBalanceCache(), '应真的删了').toBe(true)
      expect(existsSync(legacy), '旧文件必须消失').toBe(false)
    })

    it('★★ 旧文件不存在 ⇒ 返回 false（幂等）', () => {
      expect(pruneLegacyBalanceCache()).toBe(false)
    })

    it('★★ 不得误删新路径的缓存', () => {
      noteDiskReading('buddy', 'a1', reading)
      expect(existsSync(balanceDiskCacheFile())).toBe(true)

      pruneLegacyBalanceCache()
      expect(existsSync(balanceDiskCacheFile()), '新缓存必须还在').toBe(true)
    })
  })
})