import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

    /**
     * ★★★ **每条读数都必须立即落盘**（2026-11-21 二次修订）。
     *
     * ## 上一版是错的（用户实测打穿）
     *
     * 上一版：首次写盘，之后只置脏标记，靠「30 分钟定时器 + 退出钩子」。
     *
     * 而**退出钩子在强制退出时不触发**（任务管理器 / 关机 / 崩溃）
     * ⇒ 新值全部丢失 ⇒ 下次重启又读到旧文件。
     *
     * 实测证据：文件 mtime 是 20:37（确实写过），但里面 60 条读数的时刻
     * 全是 17:45~19:52（**50~176 分钟前**）—— 那次写盘写的是旧读数。
     *
     * ## 修法
     *
     * `noteDiskReading` 每次都调 `flushDisk()`。
     *
     * ⚠️ 成本可接受：`flushDisk` 是同步原子写（tmp → rename），60 条约 40KB，
     * 实测 <5ms；而余额查询本身要 1~2 秒（网络往返）⇒ 写盘开销不到 0.5%。
     */
    it('★★★ 每条读数都必须立即落盘（强杀不丢新值）', () => {
      noteDiskReading('buddy', 'a1', reading)
      noteDiskReading('buddy', 'a2', reading)
      // ⚠️ 两条都必须在文件里（不是只有第一条）
      const parsed = JSON.parse(readFileSync(balanceDiskCacheFile(), 'utf8')) as {
        readings: Record<string, unknown>
      }
      expect(Object.keys(parsed.readings).sort()).toEqual(['buddy:a1', 'buddy:a2'])
      expect(isDiskDirty(), '已写盘 ⇒ 脏标记清').toBe(false)
    })

    it('★★★ 读数变化后文件内容真的更新（不是只改内存镜像）', () => {
      noteDiskReading('buddy', 'a1', { at: 1, value: { balance: 111 } })
      let parsed = JSON.parse(readFileSync(balanceDiskCacheFile(), 'utf8')) as {
        readings: Record<string, { reading: { value: { balance: number } } }>
      }
      expect(parsed.readings['buddy:a1']?.reading.value.balance).toBe(111)

      // 新值 222
      noteDiskReading('buddy', 'a1', { at: 2, value: { balance: 222 } })
      parsed = JSON.parse(readFileSync(balanceDiskCacheFile(), 'utf8')) as typeof parsed
      expect(
        parsed.readings['buddy:a1']?.reading.value.balance,
        '★★★ 磁盘文件必须反映最新值（否则重启读到旧值）',
      ).toBe(222)
    })

    it('★★ 没有新读数时 flushDisk 不重复写（避免空转 IO）', () => {
      noteDiskReading('buddy', 'a1', reading) // 已自动写
      expect(flushDisk(), '无脏数据 ⇒ 不写').toBe(false)
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
})


/**
 * ★★★ **只有「值真的变了」才落盘**（本轮新代码的 O(N) 写盘修法）。
 *
 * ## 为什么这条必须存在
 *
 * `BalanceReading` 的第一个字段是 **`at`（取数时刻）** —— 它**每次读数都变**。
 * 我第一版修法是裸 `JSON.stringify(reading)` 比对 ⇒ **永远判「变了」**
 * ⇒ 写盘频率一点没降、判据等于没判（自己踩的坑，写在这里免得后人重踩）。
 *
 * ⇒ 正确判据是「**语义字段**的稳定序列化」：排除 `at`、键序归一、保留
 * `value` / `error` / `stale`。
 *
 * ⚠️ 徽标每 60 秒轮询一次、每次覆盖**所有**账号，而 `flushDisk` 是
 * `writeFileSync`（同步）且序列化整份 memory ⇒ 判据失效就是 O(N) 同步写盘。
 */
describe('余额磁盘缓存：值没变就不写盘', () => {
  /**
   * ## ⚠️⚠️ 观察方式：受控时钟 + 文件顶层 `at`（2026-11-21 修）
   *
   * `noteDiskReading` **内部就会立即写盘**（作者的设计），写没写在返回值上看不出来，
   * 所以必须看文件。但文件顶层的 `at` 是 `flushDisk(now = Date.now())` —— **墙钟**，
   * 同一毫秒内的两次写盘会得到**相同的 `at`**。
   *
   * 实测（连跑 20 轮「值真的变了必须写盘」）：**15 轮**前后 `at` 相同
   * ⇒ 反向守卫随机假红（`expected 1795272207488 not to be 1795272207488`）。
   * 这不是被测代码的问题，是**判据选错了观测量**：墙钟分辨率不能当「写没写」的证据。
   *
   * ⇒ 把 `Date.now` 换成受控时钟：**只在我们推进之后才前进**。于是
   * 「写了一次」与「没写」在文件 `at` 上必然可区分，判据恢复确定性。
   */
  let home: string
  let clock = 1_700_000_000_000
  /** 推进受控时钟 —— 让「再写一次」在文件 `at` 上可观察。 */
  const tick = (): void => { clock += 1_000 }
  const fileAt = (): number => (JSON.parse(readFileSync(balanceDiskCacheFile(), 'utf8')) as { at: number }).at

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'bdc-dedup-'))
    process.env.DSH_HOME = home
    setBalanceDiskCacheEnabledForTest(true)
    resetBalanceDiskCacheStateForTest()
    // ⚠️ 必须在这个 describe 的 beforeEach 里装：`vi.restoreAllMocks()` 在 afterEach，
    //    上个用例的桩不会漏到这里。
    clock = 1_700_000_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => clock)
  })
  afterEach(() => {
    vi.restoreAllMocks()
    setBalanceDiskCacheEnabledForTest(false)
    rmSync(home, { recursive: true, force: true })
  })

  it('★★★ 同一个值（仅 `at` 不同）不得触发第二次写盘', () => {
    noteDiskReading('qoder', 'acct-1', { at: 1, value: { remaining: 100 } })
    const first = fileAt()
    // ⚠️ 先推进时钟：若这里真的写了盘，`at` 必然变 ⇒ 断言会红（而不是碰运气）。
    tick()
    // 同样的 value、不同的 at ⇒ 不该再写（文件 at 不变）。
    noteDiskReading('qoder', 'acct-1', { at: 999_999, value: { remaining: 100 } })
    expect(fileAt(), '仅 `at` 变了不算值变化 —— 否则徽标轮询就是 O(N) 同步写').toBe(first)
  })

  it('★★★ 键序不同但内容相同 ⇒ 仍不得写盘', () => {
    noteDiskReading('qoder', 'acct-1', { at: 1, value: { a: 1, b: 2 } })
    const first = fileAt()
    tick()
    noteDiskReading('qoder', 'acct-1', { at: 2, value: { b: 2, a: 1 } })
    expect(fileAt(), '键序不是语义 —— 对象构造路径不同不该触发写盘').toBe(first)
  })

  it('★★★ 值真的变了必须写盘（反向守卫，防判据过度收敛）', () => {
    noteDiskReading('qoder', 'acct-1', { at: 1, value: { remaining: 100 } })
    const first = fileAt()
    tick()
    noteDiskReading('qoder', 'acct-1', { at: 2, value: { remaining: 90 } })
    expect(fileAt(), '余额变了必须落盘（否则强杀后丢新值 = 本 PR 要修的原缺陷）').not.toBe(first)
    // ⚠️ 再看**语义内容**：只断言「文件被动过」会让「写了但写的是旧值」也绿。
    const stored = (JSON.parse(readFileSync(balanceDiskCacheFile(), 'utf8')) as {
      readings: Record<string, { reading: { value: { remaining: number } } }>
    }).readings['qoder:acct-1']
    expect(stored?.reading.value.remaining, '落盘的必须是**新值**').toBe(90)
  })

  it('★★★ `error` / `stale` 是语义字段 —— 变了也要写盘', () => {
    noteDiskReading('qoder', 'acct-1', { at: 1, value: { remaining: 100 } })
    const first = fileAt()
    tick()
    noteDiskReading('qoder', 'acct-1', { at: 2, value: { remaining: 100 }, error: '上游挂了' })
    expect(fileAt(), '`error` 参与语义').not.toBe(first)
  })
})

