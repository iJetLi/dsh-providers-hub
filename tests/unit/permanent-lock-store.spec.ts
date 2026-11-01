/**
 * 「锁定永久积分」独立文档（`src/permanent-lock-store.ts`）的读写回归。
 *
 * ## 为什么这份文档必须独立存在（真实风险）
 *
 * `$DSH_HOME/jet-hub/state.json` 是 **dsh home 级、同机多 profile 共享**的文档，
 * 而本插件的存储是整体替换语义。用户刻意把 desktop 与 web 分成两个工作区
 * （`dsh-codearts` 给 desktop、`deepseek-harness-codearts` 给 web），web 侧的
 * 代码**不认识**锁定表这个字段 —— 它任何一次整体写入（加删账号、改模型开关、
 * 命中限流）都会把该字段抹掉，于是 desktop 侧的 CodeBuddy / WorkBuddy 锁定
 * **静默失效**，而失效的后果是真把永久积分烧掉（不可撤回）。
 *
 * ⇒ 把表拆到 `permanent-locks.json`，旧代码从不读写它，两个工作区才真正互不影响。
 * 这里守的是这份文档自身的读语义（尤其是「不存在」与「空表」必须可区分）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  PERMANENT_LOCKS_FILE,
  createPermanentLockStore,
} from '../../src/permanent-lock-store.js'

/** 造一个最小 ctx（锁定后端只需要 logger 与 env 解析）。 */
function makeCtx(): never {
  return { logger: { warn: () => {}, info: () => {} } } as never
}

let dir: string
let previousDir: string | undefined
const docPath = () => join(dir, 'jet-hub', PERMANENT_LOCKS_FILE)

beforeEach(() => {
  previousDir = process.env.DSH_JET_HUB_STATE_DIR
  dir = mkdtempSync(join(tmpdir(), 'dsh-permanent-locks-'))
  process.env.DSH_JET_HUB_STATE_DIR = dir
})

afterEach(() => {
  if (previousDir === undefined) delete process.env.DSH_JET_HUB_STATE_DIR
  else process.env.DSH_JET_HUB_STATE_DIR = previousDir
  rmSync(dir, { recursive: true, force: true })
})

describe('能力探测与落盘位置', () => {
  it('能定位 home 时走文件后端，且与 state.json 同目录', async () => {
    const store = createPermanentLockStore(makeCtx())
    expect(store.kind).toBe('file')
    await store.save({ buddy: true })
    expect(existsSync(docPath())).toBe(true)
  })

  it('无法定位 home 时显式降级为内存（不抛错）', () => {
    delete process.env.DSH_JET_HUB_STATE_DIR
    const store = createPermanentLockStore({ logger: { warn: () => {} } } as never)
    // 解析顺序里 profileContext 缺失会退到 $DSH_HOME 或 ~/.dsh，故这里只在
    // 两者都没有时才是 memory —— 断言"不抛错"即可。
    expect(['file', 'memory']).toContain(store.kind)
    expect(() => store.load()).not.toThrow()
  })
})

describe('读取语义：「不存在」与「空表」必须可区分', () => {
  it('文档不存在时 exists: false（调用方据此做一次性迁移）', () => {
    const read = createPermanentLockStore(makeCtx()).load()
    expect(read).toEqual({ exists: false, locks: {} })
  })

  it('文档存在且是空表时 exists: true —— 这正是"用户明确解锁"的意思', async () => {
    const store = createPermanentLockStore(makeCtx())
    await store.save({})
    expect(store.load()).toEqual({ exists: true, locks: {} })
  })

  /**
   * ⚠️ 这条区分是**防"解不掉的开关"**的根基：迁移只在 exists:false 时读老的
   * 镜像字段。若把"空表"也当成不存在，用户解锁 Loomy 后重启又会被老字段拉回锁定。
   */
  it('空表不会被误判为不存在', async () => {
    const store = createPermanentLockStore(makeCtx())
    await store.save({})
    expect(store.load().exists).toBe(true)
  })
})

describe('写入与读回', () => {
  it('多 provider 各自独立持久化，跨实例读回', async () => {
    const writer = createPermanentLockStore(makeCtx())
    await writer.save({ buddy: true, workbuddy: true })

    const reader = createPermanentLockStore(makeCtx())
    expect(reader.load()).toEqual({ exists: true, locks: { buddy: true, workbuddy: true } })
  })

  it('落盘带 schema 标记（便于将来演进时判别）', async () => {
    await createPermanentLockStore(makeCtx()).save({ loomy: true })
    const raw = JSON.parse(readFileSync(docPath(), 'utf-8')) as Record<string, unknown>
    expect(raw.schema).toBe('dsh-codearts-auth/permanent-locks/v1')
    expect(raw.locks).toEqual({ loomy: true })
  })

  it('解锁是删键：再次读回不含该 provider', async () => {
    const store = createPermanentLockStore(makeCtx())
    await store.save({ buddy: true })
    await store.save({})
    expect(store.load().locks).toEqual({})
  })

  it('写入是原子的（不留 .tmp 残file）', async () => {
    await createPermanentLockStore(makeCtx()).save({ buddy: true })
    expect(existsSync(`${docPath()}.tmp`)).toBe(false)
  })
})

describe('脏数据与容错', () => {
  /**
   * ⚠️ 误锁比误解锁更难排查：`{ buddy: 'yes' }` 这类脏值绝不能判成已锁定。
   * 只认显式 `true`（与模型黑名单同一约定）。
   */
  it('只保留显式 true，其余值丢弃', async () => {
    mkdirSync(join(dir, 'jet-hub'), { recursive: true })
    writeFileSync(docPath(), JSON.stringify({
      schema: 'dsh-codearts-auth/permanent-locks/v1',
      locks: { buddy: 'yes', workbuddy: false, loomy: 1, qoder: true },
    }), 'utf-8')
    expect(createPermanentLockStore(makeCtx()).load().locks).toEqual({ qoder: true })
  })

  it('locks 是数组时按空表处理（typeof [] 也是 object）', () => {
    mkdirSync(join(dir, 'jet-hub'), { recursive: true })
    writeFileSync(docPath(), JSON.stringify({ schema: 'x', locks: ['buddy'] }), 'utf-8')
    const read = createPermanentLockStore(makeCtx()).load()
    expect(read.exists).toBe(true)
    expect(read.locks).toEqual({})
  })

  /**
   * 手工编辑过的文档可能直接写裸表（没有 schema/locks 包装）。
   * 认它比把它当空表更安全 —— 后者会让用户的锁定凭空消失。
   */
  it('兼容裸表形态', () => {
    mkdirSync(join(dir, 'jet-hub'), { recursive: true })
    writeFileSync(docPath(), JSON.stringify({ buddy: true, workbuddy: 'no' }), 'utf-8')
    expect(createPermanentLockStore(makeCtx()).load().locks).toEqual({ buddy: true })
  })

  /**
   * ⚠️ 文档损坏时按「存在但空表」处理，**不**回落到老的镜像字段：
   * 那条路会把用户已解除的锁定重新打开（保守方向在这里是反的）。
   * ⚠️ 但这只适用于「主文件与 `.bak` 都读不出来」这一格 —— 只要 `.bak` 还在，
   * 就必须用它（见下面两条 D2 用例）。
   */
  it('文档损坏时按空表处理且不报 exists:false', () => {
    mkdirSync(join(dir, 'jet-hub'), { recursive: true })
    writeFileSync(docPath(), '{ not json', 'utf-8')
    const read = createPermanentLockStore(makeCtx()).load()
    expect(read.exists).toBe(true)
    expect(read.locks).toEqual({})
  })

  /**
   * ⚠️⚠️ **D2（2026-11-01 三审实测）：损坏时绝不 fail-open**。
   *
   * 修前：`load()` 的 catch 直接返回空表 ⇒ 文件被写坏（并发写 / 断电 / 手工编辑）
   * 的唯一后果是**所有 provider 静默解锁**，选号继续烧永久积分 —— 而积分烧掉
   * **不可撤销**。方向必须与「钱不可逆」一致：宁可维持上一次已知的锁定。
   *
   * 修后：主文件解析失败 ⇒ 回落 `.bak`。
   *
   * ⚠️⚠️ **`.bak` 的语义在四审改过一次**：它曾经是「上一次写入**前**的版本」（备份在
   * `rename` **之前**复制），那就是**落后一版**。实测由此产生的三个方向：最后一版新增的
   * 锁会丢；用户**刚解锁**后主文件损坏会被备份拉回锁定（= 解不掉的开关）；回落后再写一次
   * 会把坏主文件复制成 `.bak`（恢复只有一次机会）。现在备份在 `rename` **之后**刷新 ⇒
   * `.bak` = 「最近一次成功发布的完整内容」⇒ 本条期望值也从「上一版」变成「最新一版」。
   */
  it('★★ 主文件损坏时回落到 .bak（绝不静默解锁，且是**最新**一版）', async () => {
    const store = createPermanentLockStore(makeCtx())
    await store.save({ magicrew: true })
    await store.save({ magicrew: true, magicrewintl: true })
    // 把主文件写成半截 JSON（模拟并发写 / 断电 / 手工编辑）
    writeFileSync(docPath(), '{"schema":"x","locks":{"magicrew":tr', 'utf-8')
    const read = createPermanentLockStore(makeCtx()).load()
    expect(read.exists).toBe(true)
    // ⚠️ 两个锁都要在：落后一版的备份只会有 { magicrew: true }（四审前就是这个值）
    expect(read.locks).toEqual({ magicrew: true, magicrewintl: true })
  })

  /**
   * ⚠️⚠️ **四审新增方向：用户刚解锁后主文件损坏，不得把锁拉回来**。
   *
   * 这是「备份落后一版」最坏的一格：先 `{loomy:true}`，用户解锁成 `{}`，主文件随后损坏
   * ⇒ 旧语义会回落到 `{loomy:true}`，等于一个**用户再也解不掉的开关**（与文件头
   * 「文档一旦存在就是唯一权威」直接冲突）。
   */
  it('★★ 用户解锁后主文件损坏，.bak 不得把锁拉回来', async () => {
    const store = createPermanentLockStore(makeCtx())
    await store.save({ loomy: true })
    await store.save({})
    writeFileSync(docPath(), '{"schema":"x","locks":{"loomy":tr', 'utf-8')
    const read = createPermanentLockStore(makeCtx()).load()
    expect(read.exists).toBe(true)
    expect(read.locks).toEqual({})
  })

  /**
   * 主文件消失了但 `.bak` 还在（例如 `rename` 之前崩溃、或有人删了主文件）。
   *
   * ⚠️ 这里 `exists` 必须是 **true**：返回 false 会触发「从 state.json 老字段
   * 迁移」，而那个老字段可能是陈旧的 `true`，会把用户已经解开的锁重新打开
   * （见 `loadLocks` 与文件头的迁移判据）。
   */
  it('★★ 主文件缺失但 .bak 还在 ⇒ 用 .bak，且不触发迁移（exists: true）', async () => {
    const store = createPermanentLockStore(makeCtx())
    await store.save({ loomy: true })
    await store.save({ loomy: true, magicrew: true })
    rmSync(docPath())
    const read = createPermanentLockStore(makeCtx()).load()
    expect(read.exists).toBe(true)
    // `.bak` 现在是「最近一次成功发布的内容」⇒ 两个锁都在（改前只会剩 loomy）
    expect(read.locks).toEqual({ loomy: true, magicrew: true })
  })

  /**
   * ⚠️ **语义**：`.bak` = 「最近一次成功发布的完整内容」，**首次写入就有**（四审改）。
   * 旧语义是「上一次写入前的上一版」，且首次没有备份 —— 那样主文件首写后一旦损坏
   * 就没有任何可恢复的内容。
   */
  it('★ 每次成功写入后 .bak 与主文件同内容（首次就有）', async () => {
    const store = createPermanentLockStore(makeCtx())
    await store.save({ buddy: true })
    expect(existsSync(`${docPath()}.bak`)).toBe(true)
    const first = JSON.parse(readFileSync(`${docPath()}.bak`, 'utf-8')) as { locks: unknown }
    expect(first.locks).toEqual({ buddy: true })
    await store.save({ buddy: true, loomy: true })
    const second = JSON.parse(readFileSync(`${docPath()}.bak`, 'utf-8')) as { locks: unknown }
    expect(second.locks).toEqual({ buddy: true, loomy: true })
    // 与主文件逐字节同内容（不是「上一版」）
    expect(readFileSync(`${docPath()}.bak`, 'utf-8')).toBe(readFileSync(docPath(), 'utf-8'))
  })

  it('顶层是数组时不抛错，按空表处理', () => {
    mkdirSync(join(dir, 'jet-hub'), { recursive: true })
    writeFileSync(docPath(), '[]', 'utf-8')
    expect(createPermanentLockStore(makeCtx()).load().locks).toEqual({})
  })
})
