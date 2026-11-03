/**
 * 「锁定永久积分」开关表的**独立**持久化文档。
 *
 * ## 为什么不与账号池同放一份 state.json（真实风险，用户 2026-09-29 定案）
 *
 * `$DSH_HOME/jet-hub/state.json` 是 **dsh home 级、全局共享**的：同机上多个
 * profile 用的是同一个 home，于是一台机器上的 `desktop` 与 `web` / `tui` /
 * `headless` 读到的是**同一份**账号池文档。
 *
 * 而本插件的存储是**整体替换**语义（`store.save(全量 state)`）。于是：
 *
 * | 步骤 | 发生什么 |
 * |---|---|
 * | 1 | desktop 侧（新代码）写入 `permanentLocks: { buddy: true }` |
 * | 2 | 用户在 web 侧（**旧代码，不认识该字段**）触发任意一次整体写入：加删账号、改模型开关、命中限流标记 |
 * | 3 | 旧代码全量重写 state.json，只带它认识的键 ⇒ `permanentLocks` **被抹掉** |
 * | 4 | desktop 侧读回 ⇒ CodeBuddy / WorkBuddy **静默解锁** |
 *
 * ⚠️ 后果不是显示问题，而是**行为**问题：解锁后选号继续消耗永久积分，
 * 而积分烧掉**不可撤回**。这与本文件反复记录的那类缺陷（"整体写入漏带字段
 * 就会被静默抹掉"）同源，区别只是这次漏带的一方是**另一条工作区里我们无法
 * 修改的旧版本代码**（用户刻意把 desktop 与 web 分成两个互不影响的工作区）。
 *
 * ⇒ 结论：**把锁定表拆到本文件这份独立文档**，旧代码从不读写它，两个工作区
 * 因此在这一点上真正互不干扰。
 *
 * ## 与旧版 state.json 的兼容（单向迁移，只认"文件不存在"）
 *
 * 该字段早先住在 state.json 的 `loomyPermanentLocked` 里，老用户磁盘上只有它。
 * 故本文档**不存在**时读老字段（保住升级前的状态）；一旦本文档存在，它就是
 * **唯一权威**，不再回看老字段 —— 否则用户在 desktop 里解锁 Loomy 后，会被
 * 老字段里那个陈旧的 `true` 重新拉回锁定态（写侧同时同步老字段，见 AccountPool）。
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { PermanentLockMap } from './jet-hub-store.js'
import { sanitizePermanentLocks } from './jet-hub-store.js'
import { resolveJetHubHome } from './jet-hub-store.js'

/** 独立文档的文件名（与 state.json 同目录）。 */
export const PERMANENT_LOCKS_FILE = 'permanent-locks.json'

/** 锁定表后端的种类：文件（正常）或内存（无法定位 home 时的显式降级）。 */
export type PermanentLockStoreKind = 'file' | 'memory'

/** 读取结果：区分「文档不存在」与「存在但是空表」—— 见文件头的迁移判据。 */
export type PermanentLockRead =
  | { exists: false; locks: PermanentLockMap }
  | {
    exists: true
    locks: PermanentLockMap
    /**
     * **主文件与 .bak 都读不出来**（不是「文件里确实没锁」）。
     *
     * ⚠️ 写侧必须据此**以内存为基线**：把这份空表当成事实会连同 `.bak`
     *    一起覆盖掉，用户其余几家的锁定就永久消失了（对抗审计 B3 实测）。
     */
    degraded?: boolean
  }

/**
 * 独立文档的读写接口（同步读、异步写，与 `JetHubStore` 同款约定）。
 */
export interface PermanentLockStore {
  readonly kind: PermanentLockStoreKind
  /** 载入锁定表；文档不存在时 `exists: false`（让调用方决定如何迁移）。 */
  load(): PermanentLockRead
  /** 整体写入锁定表（原子写）。 */
  save(locks: PermanentLockMap): Promise<void>
}

/** 仅内存后端：无法定位 dsh home 时的显式降级（与 MemoryStore 同策）。 */
class MemoryLockStore implements PermanentLockStore {
  readonly kind = 'memory' as const
  private locks: PermanentLockMap = {}
  private written = false

  load(): PermanentLockRead {
    return { exists: this.written, locks: { ...this.locks } }
  }

  async save(locks: PermanentLockMap): Promise<void> {
    this.locks = { ...locks }
    this.written = true
  }
}

/** 文件后端：`$DSH_HOME/jet-hub/permanent-locks.json`（原子写：tmp + rename）。 */
class FileLockStore implements PermanentLockStore {
  readonly kind = 'file' as const

  constructor(
    private readonly path: string,
    private readonly logger: { warn(message: string): void } | undefined,
  ) {}

  /**
   * 读锁定表。
   *
   * ⚠️⚠️ **读不出来时绝不 fail-open**（2026-11-01 三审实测的 D2）：
   * 旧实现 catch 后直接返回空表 ⇒ 文件写坏（并发写 / 断电 / 手工编辑）的后果是
   * **所有 provider 静默解锁**，选号继续烧永久积分 —— 而积分烧掉**不可撤销**。
   * 方向必须与「钱不可逆」一致：**宁可维持上一次已知的锁定，也不默认放行**。
   *
   * 两层回落：主文件解析失败 ⇒ 读 `.bak`（每次覆盖前留的上一版）；都读不出来
   * 才退回空表（并 warn）。⚠️ 只有「主文件 + .bak 都不存在」才返回 `exists: false`,
   * 因为那个标记会触发「从 state.json 老字段迁移」，判错会把用户已解除的锁重新打开。
   */
  load(): PermanentLockRead {
    if (!existsSync(this.path)) {
      const backup = this.parseFile(`${this.path}.bak`, '备份')
      // 主文件不存在但备份还在（例如 rename 前崩溃）⇒ 用备份，别触发迁移。
      if (backup !== undefined) return { exists: true, locks: backup }
      return { exists: false, locks: {} }
    }
    const direct = this.parseFile(this.path, '主文件')
    if (direct !== undefined) return { exists: true, locks: direct }
    const backup = this.parseFile(`${this.path}.bak`, '备份')
    if (backup !== undefined) {
      this.logger?.warn(`[jet-hub] ${this.path} 已损坏，已回落到 .bak（锁定状态以备份为准）`)
      return { exists: true, locks: backup }
    }
    /**
     * ⚠️⚠️ **双损坏时不能只 warn 就交空表**（2026-11-02，PR #168 对抗审计 B3 实测）：
     * 旧实现返回 `{exists:true, locks:{}}` ⇒ 写侧的「磁盘存在就以磁盘为准」
     * 会把**内存里还在的锁定**整份丢掉，并且**连同 `.bak` 一起**写成新的小表
     * ⇒ 用户再锁任意一家，其余几家的锁定静默消失且**不可恢复**（重启后连 warn 都没了）。
     *
     * ⇒ 用 `degraded` 告诉写侧「这份空表不是事实，而是读不出来」，
     *   写侧据此**以内存为基线**（见 `AccountPool.setPermanentLocked`）。
     */
    this.logger?.warn(
      `[jet-hub] ${this.path} 与 .bak 均不可读 ⇒ 本次以**内存里的锁定**为准`
      + '（请检查该文件；损坏期间不要依赖另一条工作区的面板）',
    )
    return { exists: true, locks: {}, degraded: true }
  }

  /** 读一个文件并解析；不存在或损坏都返回 `undefined`（由调用方决定回落顺序）。 */
  private parseFile(path: string, label: string): PermanentLockMap | undefined {
    if (!existsSync(path)) return undefined
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown
      return sanitizePermanentLocks(locksFieldOf(parsed))
    } catch (error) {
      this.logger?.warn(`[jet-hub] 读取 ${label} ${path} 失败: ${String(error)}`)
      return undefined
    }
  }

  async save(locks: PermanentLockMap): Promise<void> {
    mkdirSync(join(this.path, '..'), { recursive: true })
    /**
     * ⚠️⚠️ **临时文件名必须唯一**（2026-11-02，PR #168 对抗审计 B4 实测）：
     * 原先用**固定**的 `${path}.tmp`，而本文件的立论场景正是「两个进程共用同一个
     * `$DSH_HOME`」—— 实测两进程各跑 6 秒：`ok=572 fail=35` / `ok=579 fail=29`，
     * 错误是 `ENOENT`（改名时对方的 tmp 已被抢走）与 `EPERM`（Windows 上对方
     * 正在写）。**写直接丢**，而内存已经先改了 ⇒ 磁盘/内存分叉。
     *
     * 照 `token-ledger-store.ts` 的写法：`pid + randomUUID()`。
     */
    const tmp = `${this.path}.${process.pid}.${randomUUID()}.tmp`
    // 带 schema 标记：与本仓库其它状态文档同惯例，便于将来演进时判别。
    writeFileSync(tmp, JSON.stringify({ schema: SCHEMA, locks }, null, 2), 'utf-8')
    renameSync(tmp, this.path)
    /**
     * ⚠️⚠️ **备份必须在 `rename` **之后**刷新**（2026-11-01 四审实测：先在 `rename`
     * **之前** `copyFileSync` 的写法有缺陷，已修）。
     *
     * 语义：`.bak` = **最近一次成功发布的那一版**全文。三个必须如此的理由：
     *
     * 1. **备份落后一版会丢最后一个锁**：实测
     *    `setPermanentLocked('qoder', true)` → `(…, false)` → `setPermanentLocked('buddy', true)`
     *    之后把主文件写坏 ⇒ 回落到的 `.bak` 是**上一版**（`{}`）⇒ `buddy` 的锁定消失。
     * 2. **会复活用户刚解开的锁**（方向最坏）：先 `{loomy:true}`、用户**解锁**成 `{}`、
     *    主文件随后损坏 ⇒ 旧写法回落到的 `.bak` 是 `{loomy:true}` ⇒ **解不掉的开关**，
     *    与文件头明写的「文档一旦存在就是唯一权威」直接冲突。
     * 3. **回落后再写一次会污染备份**：旧写法第二次 `save` 会把**正在损坏的主文件**
     *    复制成 `.bak` ⇒ 再坏一次就没有可恢复的内容了（恢复只有一次机会）。
     *
     * 挪到 `rename` 之后后，`.bak` 恒等于「刚刚成功发布的完整内容」⇒ 主文件即使被外部
     * 写坏，恢复到的也是**最后一版**而不是上一版。备份失败只 warn：它不该让这次已经
     * 成功发布的写入算作失败。
     */
    try {
      copyFileSync(this.path, `${this.path}.bak`)
    } catch (error) {
      this.logger?.warn(`[jet-hub] 备份 ${this.path} 失败（本次写入已生效）: ${String(error)}`)
    }
  }
}

const SCHEMA = 'dsh-codearts-auth/permanent-locks/v1'

/**
 * 取出文档里的锁定表字段，同时兼容**裸表**形态。
 *
 * 裸表（顶层直接 `{ buddy: true }`）不是本实现写出的形态，但状态文档可能被
 * 手工编辑过；认它比把它当空表更安全（后者会让用户的锁定凭空消失）。
 */
function locksFieldOf(parsed: unknown): unknown {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return parsed
  const record = parsed as Record<string, unknown>
  if (record.locks !== undefined) return record.locks
  // 顶层含已知 provider 键或为空对象时视为裸表
  if (record.schema === undefined) return record
  return {}
}

/**
 * 创建锁定表后端。
 *
 * home 的解析与账号池**同一个函数**（`resolveJetHubHome`），保证两份文档
 * 永远落在同一目录 —— 否则会出现「账号池在 A 处、锁定表在 B 处」的分裂。
 */
export function createPermanentLockStore(ctx: Context): PermanentLockStore {
  const home = resolveJetHubHome(ctx)
  if (home === undefined) {
    ctx.logger?.warn?.('[jet-hub] 无法定位 DSH home，永久积分锁定开关仅存在于内存中')
    return new MemoryLockStore()
  }
  return new FileLockStore(join(home, 'jet-hub', PERMANENT_LOCKS_FILE), ctx.logger)
}
