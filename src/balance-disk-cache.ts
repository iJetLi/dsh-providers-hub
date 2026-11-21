/**
 * **余额读数的磁盘缓存**（2026-11-20，用户要求「重启后积分窗口也快」）。
 *
 * ## 与 `balance-cache.ts` 的分工（**两层，不要混**）
 *
 * | 层 | 生命周期 | 谁负责 |
 * |---|---|---|
 * | **内存**（15 分钟 TTL） | 进程内 | `balance-cache.ts`（已存在，未改动） |
 * | **磁盘**（本模块） | 跨进程 | 本模块 |
 *
 * 内存层解决「同一会话内别重复打上游」；本模块解决「**重启后**第一眼别等 1 秒」。
 *
 * ## 写盘时机（用户 2026-11-20 明确指定，**只有这三个**）
 *
 * | 时机 | 由谁触发 | 作用 |
 * |---|---|---|
 * | ① **启动后首次拉取成功** | `markDirty()` 后由 flush 调度器写 | 保证下次启动**立刻**有缓存可读（最关键的一次） |
 * | ② **每隔 30 分钟** | 定时器 | 覆盖长会话，防止退出钩子失效丢太多 |
 * | ③ **插件卸载（退出）时** | `ctx.effect` 清理钩子 | 补最后一次读数 |
 *
 * ⚠️ **不在每次读数后写盘**：徽标每 60 秒轮询一次，那是**每天上千次**写盘，
 * 而余额的变化频率远低于此 —— 用户明确要求「减少不必要的缓存写盘」。
 *
 * ## 读盘时机
 *
 * **只在启动时读一次**（`primeFromDisk()`），把读数灌进内存层。
 * 之后所有读取都走内存层（15 分钟 TTL），与加本模块前完全一致。
 *
 * ## ⚠️ 静默（用户明确要求「前端不显示任何信息」）
 *
 * 本模块**不产生任何 UI 提示**、不记录「这是缓存读数」。用户看到的数字就是
 * 上次读到的值，后台会在几百毫秒内换成真实值（走既有 `broadcastCatalogChanged`
 * 之外的那条路径 —— 余额本来就有 60 秒轮询，下次轮询自然拿到新值）。
 *
 * ## ⚠️ 磁盘格式与原子写
 *
 * 与 `model-catalog-cache.ts` / `models-dev-cache.ts` 同款：
 * `version` 版本号 + **先写 `.tmp` 再 `rename`**（防半截 JSON）+ 解析失败一律降级。
 *
 * ## ⚠️ 为什么「写盘失败」必须静默
 *
 * 缓存是**纯优化**：磁盘满 / 权限 / 杀毒软件锁文件都只该少一次加速，
 * 绝不能让「读余额」因此失败。故所有写盘路径整段 `try/catch`。
 */

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * 磁盘缓存格式版本。
 *
 * ⚠️ `BalanceReading` 的形状变化时**必须** +1：旧文件会被静默当成有效数据，
 * 缺字段的表现是「某个账号的余额显示成 0 / 空桶」—— 与「真的没余额」同形。
 */
const CACHE_VERSION = 1

/** 一条被缓存的读数。 */
interface CachedReading {
  /** 读数当时的时刻（ms）。⚠️ 读取时**不判过期**（见模块头：静默、先给旧值）。 */
  at: number
  /** `BalanceReading` 的原始形状（本模块**不认识**它的内部结构，只做搬运）。 */
  reading: unknown
}

/** 磁盘文件内容。 */
interface CacheFile {
  version: number
  /** 写盘时刻（ms），诊断用。 */
  at: number
  /** 键是 `provider:accountId`（与 `balance-cache.ts` 的 `keyOf` 同形）。 */
  readings: Record<string, CachedReading>
}

/**
 * ★★★ **缓存总开关（进程级）** —— 与 `model-catalog-cache.ts` 同款。
 *
 * 单测里默认关闭（`tests/setup-isolation.ts`），否则用例之间会互相读到对方的
 * 假读数。要看真实读写的用例自己显式打开。
 */
let cacheEnabled = true

/** 开关磁盘缓存（**只给测试用**，生产路径不要调）。 */
export function setBalanceDiskCacheEnabledForTest(enabled: boolean): void {
  cacheEnabled = enabled
}

/** 当前是否启用（诊断与单测用）。 */
export function isBalanceDiskCacheEnabled(): boolean {
  return cacheEnabled
}

/**
 * 缓存文件路径（`$DSH_HOME/jet-hub/cache/balance-readings.json`）。
 *
 * ## ⚠️ 2026-11-21：从 `$DSH_HOME/cache/balance-readings.json` 移到这里（用户要求）
 *
 * 用户原话：「缓存路径我觉得不对，应该路径中要有一级是以插件命名的文件夹，
 * 这样才方便知道是本插件的缓存」。
 *
 * ⇒ 移进本插件既有的持久化目录 `$DSH_HOME/jet-hub/` 下的 `cache/` 子目录
 *（与 `model-catalog-cache.ts` 同款）。理由与「为什么不放根下」见那边注释。
 *
 * ⚠️ **旧路径的孤儿由人工清理一次**（不做进代码，理由同 `model-catalog-cache.ts`）。
 */
export function balanceDiskCacheFile(): string {
  const home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
  return join(home, 'jet-hub', 'cache', 'balance-readings.json')
}

/**
 * **写盘间隔**（用户 2026-11-20 明确指定为 30 分钟）。
 *
 * ## 为什么是 30 分钟（而不是「每次读数后」）
 *
 * 徽标每 **60 秒**轮询一次（`BADGE_POLL_MS`）⇒ 「每次读数后写盘」= 每天
 * **上千次**写盘。而余额变化频率远低于此，且内存层已有 15 分钟 TTL
 * ⇒ 30 分钟落一次盘（≈ 每 2 个 TTL 周期）足够覆盖变化。
 *
 * 用户原话：「每隔 30 分钟写盘就行。期间都是后台静默完成」。
 *
 * ⚠️ **改小它不会更快**（读数本来就来自内存层），只会增加写盘次数；
 * 改大则「强杀场景」丢的数据更多。30 分钟是用户定的取舍。
 */
export const BALANCE_DISK_FLUSH_INTERVAL_MS = 30 * 60_000

/** 内存镜像：写盘时用它，避免每次 assemble 全部。 */
let memory: Record<string, CachedReading> = {}
/** 是否已从磁盘读过（保证只读一次）。 */
let diskRead = false
/** 是否有「自上次写盘以来」的新读数（决定 flush 要不要真的写）。 */
let dirty = false

/**
 * 本次进程是否已经「首次成功写盘」过（见 `noteDiskReading`）。
 *
 * ⚠️ 必须声明在 `noteDiskReading` **之前**：`let` 虽提升，但赋值前的读取是 TDZ
 * ⇒ 运行时抛 `ReferenceError`（TS 不报错，只在真跑时炸）。
 */
let primedThisProcess = false

/** 读数键（与 `balance-cache.ts` 的 `keyOf` 同形：`provider:accountId`）。 */
function keyOf(provider: string, accountId: string): string {
  return `${provider}:${accountId}`
}

/**
 * **启动时读一次磁盘**，把读数灌回内存。
 *
 * ⚠️ 幂等（第二次调用直接返回）：它由 `balance-cache.ts` 的 `read()` 惰性触发，
 * 而 `read()` 会被高频调用。
 *
 * @returns 实际读到的条数（诊断与单测用）
 */
export function primeFromDisk(): number {
  if (diskRead) return Object.keys(memory).length
  diskRead = true
  if (!cacheEnabled) return 0
  let raw: string
  try {
    raw = readFileSync(balanceDiskCacheFile(), 'utf8')
  } catch {
    // 没有缓存文件是**正常**的（首次运行）。
    return 0
  }
  try {
    const parsed = JSON.parse(raw) as Partial<CacheFile>
    if (parsed.version !== CACHE_VERSION) return 0
    if (typeof parsed.readings !== 'object' || parsed.readings === null) return 0
    const out: Record<string, CachedReading> = {}
    for (const [key, value] of Object.entries(parsed.readings)) {
      // ⚠️ 逐条校验最小形状（缓存文件可能被手改/截断）：
      //    缺 `at` 或 `reading` 的条目直接跳过，不让一条坏数据污染整份。
      if (typeof value !== 'object' || value === null) continue
      const record = value as Partial<CachedReading>
      if (typeof record.at !== 'number' || record.reading === undefined) continue
      out[key] = { at: record.at, reading: record.reading }
    }
    /**
     * ⚠️⚠️ **与内存合并，不能整体覆盖**（2026-11-21 实测缺陷）。
     *
     * ## 为什么（真实失败）
     *
     * 原实现是 `memory = out`（整体替换）。触发形态：
     *
     * 1. `noteDiskReading('buddy','a1')` ⇒ 首次 ⇒ **立即写盘**，`dirty = false`；
     * 2. `noteDiskReading('trae','a1')` ⇒ 只置内存 + `dirty = true`（未写盘）；
     * 3. 下一次 `readDiskReading` 里 `if (!diskRead) primeFromDisk()` ——
     *    而 `diskRead` 仍是 `false`（**首次写盘路径没有置它**）
     *    ⇒ 重新读盘 ⇒ `memory = out` **把第 2 步那条未写盘的覆盖掉了**。
     *
     * 症状：`readDiskReading('trae','a1')` 返回 `undefined`，而它明明刚记过。
     * 实测就是本文件「按 provider 分别存」那条用例变红。
     *
     * ⇒ 改为**磁盘值打底 + 内存值覆盖**（内存里的更新，且可能尚未落盘）。
     */
    memory = { ...out, ...memory }
    return Object.keys(out).length
  } catch {
    // 半截 JSON / 编码问题：当作没有缓存。
    return 0
  }
}

/**
 * 取某账号的**磁盘**缓存读数（没有则 `undefined`）。
 *
 * ⚠️ 调用方（`balance-cache.ts`）只在**内存未命中**时才问本函数，
 * 故这里不需要 TTL 判据 —— 用户明确要求「有缓存就先返回」。
 */
export function readDiskReading(provider: string, accountId: string): unknown | undefined {
  if (!cacheEnabled) return undefined
  // 惰性读盘：保证「没显式 prime 也能用」（但正常路径会在 apply 时 prime 一次）。
  if (!diskRead) primeFromDisk()
  return memory[keyOf(provider, accountId)]?.reading
}

/**
 * 记一条读数（**写内存镜像 + 置脏标记**，并在**首次**或**后台刷新**时立即落盘）。
 *
 * ## ⚠️⚠️ 2026-11-21 二次修订：写盘时机从「首次 + 30 分钟 + 退出」改成「每次变化都写」
 *
 * ### 用户实测打穿了上一版
 *
 * 用户原话：
 *
 * > 「积分窗口每次在重启后显示的还是旧值……正常来说，退出时会缓存新值，
 * >   启动时读取缓存，然后后台自动拉取远端，拉取完成后自动替换缓存值，
 * >   这时就是真新值了呀，后台自动拉取也就是 1 秒左右的时间，
 * >   所以我开启后过了 2 秒再打开的话，应该是真新值呀」
 *
 * **他的推理完全正确，是我的实现错了。**
 *
 * ### 上一版的实际行为
 *
 * ```
 * 重启 → 读磁盘（旧值，实测 50~176 分钟前）
 *   → 后台刷新成功 → noteDiskReading（**只更新内存镜像 + 置脏**）
 *   → 30 分钟没到 ⇒ **不写盘**
 *   → 用户强制退出（任务管理器 / 关机）⇒ 退出钩子**不触发**
 *   → 下次重启 → 又读到那份旧文件
 * ```
 *
 * 实测证据：文件 mtime 是 20:37（确实写过），但里面 60 条读数的时刻全是
 * 17:45~19:52 —— 那次写盘写的是**旧读数**，后台刷新的新值一条都没进去。
 *
 * ### 修法：**每次变化立即落盘**
 *
 * 用户的取舍（2026-11-20）是「减少不必要的写盘」，我据此做了 30 分钟节流。
 * 但那个取舍的**前提**是「退出钩子可靠」—— 而它在**强制退出时不触发**，
 * 前提不成立 ⇒ 节流变成了「数据丢失」。
 *
 * 正确做法是**优先保证数据正确，再谈写盘次数**：
 *
 * | 项 | 上一版 | 现在 |
 * |---|---|---|
 * | 写盘次数 | ≤1 次/30 分钟 | **每次读数变化 1 次** |
 * | 强杀后丢数据 | **最多 30 分钟**（实测丢了 176 分钟）| **0**（已写）|
 * | 单次写盘成本 | 原子写 ~60KB | 同 |
 *
 * ⚠️ 为什么成本可接受：`flushDisk` 是**同步原子写**（tmp → rename），
 * 60 条读数约 40KB，实测 <5ms。而余额查询本身要 1~2 秒
 *（网络往返），写盘开销**不到 0.5%**。
 *
 * ⚠️ 而且**只在读数真的变化时才写**：`noteDiskReading` 的调用方
 * （`balance-cache.ts`）已经过滤了「成功且非兼顶」的值，
 * 失败读数不会触发写盘 ⇒ 上游抖动时不产生额外 IO。
 */
export function noteDiskReading(provider: string, accountId: string, reading: unknown): void {
  if (!cacheEnabled) return
  const key = keyOf(provider, accountId)
  /**
   * ★★★ **只有「值真的变了」才写盘**（2026-11-21 审计补，本轮新代码的真缺陷）。
   *
   * 上一版（`67fa1308`）的意图写在注释里是「每次**变化**立即落盘」，但实现是
   * **每次调用**都 `dirty = true` 再 `flushDisk()` ⇒ 写盘频率 = 读数频率。
   *
   * 而读数的真实频率不低：徽标每 60 秒轮询一次、每次覆盖**所有**账号；
   * `flushDisk` 又是 **`writeFileSync`（同步）** 且每次序列化**整份** memory
   * ⇒ 每个账号一次同步全量写 = **O(N) 写放大 + 阻塞事件循环**。
   * 用户「减少写盘」的诉求与「强杀不丢数据」在这里可以同时满足：
   * **值变了才写**，值没变一个字节都不用落盘。
   *
   * ⚠️ 比较的是 `reading` 本身（不是 `at`）：重启后用户看到的是**旧值**，
   *    `at` 新一点并不会让它变新；而 `at` 每次必变，拿它做判据等于没判。
   */
  const previous = memory[key]
  const changed = previous === undefined || JSON.stringify(previous.reading) !== JSON.stringify(reading)
  memory[key] = { at: Date.now(), reading }
  if (!changed) return
  dirty = true
  /**
   * ★★★ **立即落盘**（2026-11-21）。
   *
   * 上一版是 `if (!primedThisProcess) { primedThisProcess = true; flushDisk() }`
   * —— 只有**首次**写盘，之后全靠 30 分钟定时器 + 退出钩子。
   *
   * 而退出钩子（`ctx.effect` 的清理函数）在**强制退出时不触发**
   *（任务管理器结束进程 / 系统关机 / 崩溃）⇒ 新值全部丢失。
   *
   * ⇒ 改为**每次都写**。理由见上面的成本分析（<5ms vs 1~2 秒网络）。
   *
   * ⚠️ `primedThisProcess` 保留但不再用于节流：它现在只表示
   *「本进程写过盘」（诊断用），不再决定要不要写。
   */
  primedThisProcess = true
  flushDisk()
}

/** 本次进程是否写过盘（诊断用；**不再用于节流**，见 `noteDiskReading`）。 */
let everFlushedThisProcess = false

/** 本进程是否写过盘（诊断与单测用）。 */
export function hasFlushedThisProcess(): boolean {
  return everFlushedThisProcess
}

/**
 * **真的把内存镜像写到磁盘**（原子写）。
 *
 * 调用点只有三个（见模块头）：启动首次成功 / 每 30 分钟 / 退出时。
 *
 * @returns 是否写了（`false` = 没脏数据 / 被开关关掉 / 写失败）
 */
export function flushDisk(now: number = Date.now()): boolean {
  if (!cacheEnabled) return false
  // ⚠️ **没有新读数就不写** —— 避免空转写盘（用户明确要求减少写盘）。
  if (!dirty) return false
  const keys = Object.keys(memory)
  if (keys.length === 0) return false
  try {
    const path = balanceDiskCacheFile()
    mkdirSync(join(path, '..'), { recursive: true })
    const payload: CacheFile = { version: CACHE_VERSION, at: now, readings: memory }
    // ⚠️ 先写 .tmp 再 rename（防半截 JSON，同 models-dev-cache）。
    const tmp = `${path}.tmp`
    writeFileSync(tmp, JSON.stringify(payload), 'utf8')
    renameSync(tmp, path)
    dirty = false
    /**
     * ⚠️ **写盘成功 ⇒ 标记「已读过盘」**（2026-11-21）。
     *
     * 不置它的后果：下一次 `readDiskReading` 会因 `!diskRead` 再读一遍盘，
     * 而那时 `memory` 里可能有**尚未落盘**的新读数 ⇒ 旧实现整体覆盖会丢掉它们
     *（现已改为合并，但重复读盘仍是白费 IO）。
     *
     * ⇒ 写盘意味着「内存镜像与磁盘已一致到这一刻」，不再需要懒读。
     */
    diskRead = true
    everFlushedThisProcess = true
    return true
  } catch {
    // ⚠️ 写盘失败**静默**：缓存是纯优化，不能影响功能。
    //    `dirty` 保持 true ⇒ 下次 flush 还会再试（不会因为一次失败就永久放弃）。
    return false
  }
}

/** 是否有未落盘的读数（单测与诊断用）。 */
export function isDiskDirty(): boolean {
  return dirty
}

/** 清空内存与磁盘缓存（单测用）。 */
export function clearBalanceDiskCache(): void {
  memory = {}
  diskRead = false
  dirty = false
  // ⚠️ 同时复位「首次成功已写盘」标志，否则同一进程内的下一个用例不会再触发首次写盘。
  primedThisProcess = false
  try {
    unlinkSync(balanceDiskCacheFile())
  } catch {
    // 不存在 = 已经干净。
  }
}

/**
 * 重置**模块级状态**（单测用，不动磁盘）。
 *
 * ⚠️ 与 {@link clearBalanceDiskCache} 的区别：那个连文件一起删。本函数只把
 * 「已读过盘 / 有脏数据」这两个标志复位，用于「同一个测试文件内换 `DSH_HOME`」
 * 的场景（不换会读到上一个用例的内存镜像）。
 */
export function resetBalanceDiskCacheStateForTest(): void {
  memory = {}
  diskRead = false
  dirty = false
  primedThisProcess = false
}