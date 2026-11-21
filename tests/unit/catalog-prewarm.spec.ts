import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

import {
  CATALOG_PREWARM_DELAYS_MS,
  isPrewarmSpacingValid,
  selectPrewarmProviders,
  startCatalogPrewarm,
} from '../../src/catalog-prewarm.js'
import { REMOTE_CATALOG_COOLDOWN_MS } from '../../src/remote-catalog-gate.js'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../..')
const src = (name: string): string => readFileSync(resolve(root, 'src', name), 'utf8')

/**
 * 冷启动目录预热（issue IKJVTF 的「冷启动自愈」半条）。
 *
 * 真实缺陷：首拉失败后适配器回落到**静态兜底表**，客户端把这份兜底目录缓存成
 * `status: 'ready'`（它只认宿主事件），而**没有任何东西会在冷却到期后再问一次**。
 */
describe('startCatalogPrewarm', () => {
  it('立即那一轮**不等定时器**就触发（排到 microtask，不阻塞 apply）', async () => {
    const warm = vi.fn(async () => {})
    const stop = startCatalogPrewarm({
      providers: ['cline'],
      warm,
      // ⚠️ 显式 [0]：本用例测「立即轮不等定时器」，与首延迟无关。
      delaysMs: [0],
      schedule: () => () => {},
    })
    // `apply()` 是同步函数：warm 不能在调用栈内被 await，但必须已被排入。
    expect(warm).not.toHaveBeenCalled()
    for (let i = 0; i < 5; i += 1) await Promise.resolve()
    expect(warm).toHaveBeenCalledWith('cline')
    stop()
  })

  it('每个 provider 各预热一次（不是只热第一个）', async () => {
    const warm = vi.fn(async () => {})
    const stop = startCatalogPrewarm({
      providers: ['cline', 'buddy', 'zcode'],
      warm,
      delaysMs: [0],
      schedule: () => () => {},
    })
    for (let i = 0; i < 5; i += 1) await Promise.resolve()
    expect(warm.mock.calls.map((call) => call[0]).sort()).toEqual(['buddy', 'cline', 'zcode'])
    stop()
  })

  it('单个 provider 失败不影响其余（allSettled 语义）', async () => {
    const warm = vi.fn(async (provider: string) => {
      if (provider === 'buddy') throw new Error('未登录')
    })
    const warn = vi.fn()
    const stop = startCatalogPrewarm({
      providers: ['buddy', 'cline'],
      warm,
      logger: { warn },
      delaysMs: [0],
      schedule: () => () => {},
    })
    for (let i = 0; i < 5; i += 1) await Promise.resolve()
    // 两个都被调用；失败那个记了日志，成功的那个不受影响。
    expect(warm).toHaveBeenCalledTimes(2)
    expect(warn).toHaveBeenCalledOnce()
    expect(String(warn.mock.calls[0]?.[0])).toContain('buddy')
    stop()
  })

  /**
   * ★★ **链式排程**（对抗审计实测证伪后改）：下一轮必须等**上一轮结束**再排。
   *
   * 旧实现把三轮**一次性**按绝对时刻排上（启动 + 0 / 35s / 75s），而闸门的
   * `retryAt` 是「**失败那一刻** + 30s」—— 首拉耗时 `d ∈ (5s, 35s]` 时 35s 轮
   * 被挡回，`d ∈ (45s, 75s]` 时 75s 轮也被挡回（`d=60s` 实测 `retryAt=90s`）。
   */
  it('★ 链式排程：下一轮在上一轮**结束之后**才排（间隔不被首拉耗时吃掉）', async () => {
    const warm = vi.fn(async () => {})
    const pending: Array<{ fn: () => void; ms: number }> = []
    const stop = startCatalogPrewarm({
      providers: ['cline'],
      warm,
      delaysMs: [0, 35_000, 75_000],
      schedule: (fn, ms) => { pending.push({ fn, ms }); return () => {} },
    })

    // 立即轮（microtask）跑完后，才排第一段 35s
    for (let i = 0; i < 5; i += 1) await Promise.resolve()
    expect(warm).toHaveBeenCalledTimes(1)
    expect(pending.map((entry) => entry.ms)).toEqual([35_000])

    // 触发 35s 段 ⇒ 第二轮跑完才排 75s 段
    pending[0]!.fn()
    for (let i = 0; i < 5; i += 1) await Promise.resolve()
    expect(warm).toHaveBeenCalledTimes(2)
    expect(pending.map((entry) => entry.ms)).toEqual([35_000, 75_000])

    // 触发 75s 段 ⇒ 第三轮跑完，没有更多轮次（**有界**，不做无限轮询）
    pending[1]!.fn()
    for (let i = 0; i < 5; i += 1) await Promise.resolve()
    expect(warm).toHaveBeenCalledTimes(3)
    expect(pending).toHaveLength(2)
    stop()
  })

  it('按 delaysMs 排程，停止函数取消全部待跑轮次', async () => {
    const warm = vi.fn(async () => {})
    const cancels: Array<() => void> = []
    const schedule = vi.fn((_fn: () => void, _ms: number) => {
      const cancel = vi.fn()
      cancels.push(cancel)
      return cancel
    })
    const stop = startCatalogPrewarm({ providers: ['cline'], warm, delaysMs: [0, 35_000, 75_000], schedule })
    for (let i = 0; i < 5; i += 1) await Promise.resolve()
    // 链式：立即轮跑完后才排第一段（不是启动时一次性排两段）
    expect(schedule).toHaveBeenCalledTimes(1)
    expect(schedule.mock.calls.map((call) => call[1])).toEqual([35_000])
    stop()
    for (const cancel of cancels) expect(cancel).toHaveBeenCalled()
  })

  it('停止后立即轮次也不再执行（插件卸载即停手，不留孤儿请求）', async () => {
    const warm = vi.fn(async () => {})
    const pending: Array<() => void> = []
    const stop = startCatalogPrewarm({
      providers: ['cline'],
      warm,
      delaysMs: [0],
      schedule: (fn) => { pending.push(fn); return () => {} },
    })
    // ⚠️ 立即那一轮排在 microtask 上，此刻尚未触达 `warm`（见上一条用例）；
    // 同一 tick 内 `stop()` ⇒ 它也该被取消 —— 插件已卸载就不该再发请求。
    stop()
    for (const fn of pending) fn()
    for (let i = 0; i < 5; i += 1) await Promise.resolve()
    expect(warm).not.toHaveBeenCalled()
  })

  it('未停止时立即轮次照常执行（与上一条对照，确认不是恒不跑）', async () => {
    const warm = vi.fn(async () => {})
    const stop = startCatalogPrewarm({
      providers: ['cline'],
      warm,
      // ⚠️ 显式 [0]：本用例测「立即轮不等定时器」，与首延迟无关。
      delaysMs: [0],
      schedule: () => () => {},
    })
    for (let i = 0; i < 5; i += 1) await Promise.resolve()
    expect(warm).toHaveBeenCalledTimes(1)
    stop()
  })

  it('空 provider 列表不抛错（极简 profile）', async () => {
    const stop = startCatalogPrewarm({ providers: [], warm: async () => {}, schedule: () => () => {} })
    for (let i = 0; i < 5; i += 1) await Promise.resolve()
    stop()
  })
})

/**
 * ★ **间隔必须大于闸门冷却** —— 这是本机制唯一的硬约束。
 *
 * 若预热间隔小于 `RemoteCatalogGate` 的失败冷却，重试会被闸门**原样挡回**、
 * 什么也不做 —— 那等于没有预热，且症状是「静默无效」（没有报错，只是目录
 * 一直补不回来）。故这条判据必须有用例守着，别只写在注释里。
 */
describe('预热间隔 > 闸门冷却（★ 硬约束）', () => {
  it('★ 每个**轮间**间隔都严格大于 REMOTE_CATALOG_COOLDOWN_MS', () => {
    expect(REMOTE_CATALOG_COOLDOWN_MS).toBe(30_000)
    /**
     * ⚠️ **`slice(1)`**：首项是「首轮启动前的延迟」（10 秒，给宿主首屏让路），
     * 不是轮间间隔、也不与闸门冷却竞争 —— 见 `isPrewarmSpacingValid` 的注释。
     */
    for (const delay of CATALOG_PREWARM_DELAYS_MS.slice(1).filter((d) => d > 0)) {
      expect(delay, `预热间隔 ${delay}ms 不大于冷却 ${REMOTE_CATALOG_COOLDOWN_MS}ms，会被闸门挡回`)
        .toBeGreaterThan(REMOTE_CATALOG_COOLDOWN_MS)
    }
  })

  /**
   * ★★ **间隔校验**（2026-11-20 修订）。
   *
   * ⚠️ 判据从「所有非零项」改成「**第二项起**」：
   * `delays[0]` 现在是「首轮**启动前**的延迟」（10 秒，给宿主首屏让路），
   * 它**不是**轮间间隔、也不与闸门冷却竞争（首轮之前没有失败发生过）。
   * 把它纳入「> 冷却」判据是**假约束**（10 秒不需要大于 30 秒）。
   */
  it('isPrewarmSpacingValid：默认排程合规', () => {
    // 默认 = [10_000, 35_000, 75_000] ⇒ 只看 [35_000, 75_000]，都 > 30_000
    expect(isPrewarmSpacingValid(CATALOG_PREWARM_DELAYS_MS)).toBe(true)
  })

  it('isPrewarmSpacingValid：**第二项起**小于冷却 ⇒ 不合规', () => {
    // ⚠️ 首项 10_000 不参与校验（它是启动延迟），故 [10_000, 10_000] 才是违规的
    expect(isPrewarmSpacingValid([10_000, 10_000])).toBe(false)
    expect(isPrewarmSpacingValid([0, 30_000])).toBe(false) // 相等也不行：闸门用 `<=` 判剩余量
  })

  it('isPrewarmSpacingValid：首项 0（立即）不参与校验', () => {
    // 首项 0 = 立即，不与冷却竞争 ⇒ 单元素 [0] 合规
    expect(isPrewarmSpacingValid([0])).toBe(true)
    // 而 [10_000] 是**不合规**的：非零项必须 > 冷却
    expect(isPrewarmSpacingValid([10_000])).toBe(false)
  })
})

/**
 * 接线类断言（用 `(pool|p)` / `[^)]*` 容忍重构与签名扩展 —— 写死整串会让每加
 * 一个 provider 或每补一个参数都假失败，该教训已记在 `cline-adapter.spec.ts`）。
 */
describe('IKJVTF 接线：十个适配器都接上了广播', () => {
  const ADAPTERS = [
    'buddy-adapter.ts',
    'cline-adapter.ts',
    'llm-adapter.ts',
    'lobsterai-adapter.ts',
    'loomy-adapter.ts',
    'minimax-adapter.ts',
    'raccoon-adapter.ts',
    'trae-adapter.ts',
    'zcode-adapter.ts',
  ] as const

  for (const file of ADAPTERS) {
    it(`${file}：注册函数注入 onCatalogLoaded → broadcastCatalogChanged`, () => {
      const source = src(file)
      // 接线层必须注入，否则适配器拿不到 ctx、目录落地后无人广播。
      expect(source).toMatch(/onCatalogLoaded:\s*\(\)\s*=>\s*broadcastCatalogChanged\(ctx\)/)
      // 闸门必须收到它（否则注入了也没人用）。
      expect(source).toMatch(/onLoaded:\s*options\.onCatalogLoaded/)
      // 用唯一实现，不要自己写一份 emit（两份实现必然漂移）。
      expect(source).toContain("from './catalog-broadcast.js'")
    })
  }

  it('jet-hub-rpc.ts 复用同一个实现（不再自带一份 emit）', () => {
    const source = src('jet-hub-rpc.ts')
    expect(source).toContain("from './catalog-broadcast.js'")
    // 旧的本地实现必须已被删除 —— 两份实现必然漂移。
    expect(source).not.toMatch(/function broadcastCatalogChanged\(ctx: Context\)/)
  })

  /**
   * ★★ **行为用例：真装配一个适配器，断言目录落地后 `ctx.emit` 真被调用**（审计 I4）。
   *
   * 上面那批 `expect(source).toMatch(...)` 是**源码文本断言** —— 把
   * `onCatalogLoaded: () => broadcastCatalogChanged(ctx)` 整行注释掉，
   * 它们照样全绿（审计实测：`catalog-prewarm` + `buddy-adapter` 共 171 条 0 红）。
   * 故必须有至少一处**真装配**的证据。
   *
   * 用 buddy 作代表（`registerBuddyLlm` 的 ctx 替身范式在仓库里已成熟），
   * 走真实 `listModels` → `ensureRemoteModels` → 闸门 → `onLoaded`。
   */
  it('★★ 行为：registerBuddyLlm 装配后，目录落地真的 emit 一次 llm/adapters-updated', async () => {
    const { registerBuddyLlm } = await import('../../src/buddy-adapter.js')
    const { CODEBUDDY } = await import('../../src/product.js')

    const emitted: string[] = []
    const registered: unknown[] = []
    const ctx = {
      llm: {
        registerConfigurableProviders: (entries: unknown) => { registered.push(entries) },
        registerAdapter: (routes: unknown, adapter: unknown) => { registered.push([routes, adapter]) },
      },
      emit: (event: string) => { emitted.push(event) },
      logger: { warn: () => {}, info: () => {} },
      settings: undefined,
    }

    const adapter = registerBuddyLlm(ctx as never, {
      credentialRef: 'BUDDY_ACCESS_TOKEN' as never,
      resolveCredential: async () => ({
        access_token: 'a',
        refresh_token: 'r',
        expire_time: Date.now() + 3_600_000,
      }) as never,
      refresh: async () => {},
      // 目录落地（非空）⇒ `got = true` ⇒ 应触发 onLoaded
      fetchRemoteModels: async () => [
        { id: 'hy3', name: 'Hy3' },
      ] as never,
      product: CODEBUDDY,
    })

    // 装配阶段不该广播（目录还没落地）
    expect(emitted).toEqual([])

    await adapter.listModels('buddy')

    // ⚠️ `listModels` 内部有多个 `await`；广播现在走 **800ms 合并窗口**
    // （2026-11-20 从 `queueMicrotask` 改的，见 `catalog-broadcast.ts` 模块头），
    // 故必须真的等一个窗口过去，等 microtask 是等不到的。
    // 关键不变式是**广播真的发生了**（源码文本断言证明不了这一点）。
    await new Promise((resolve) => { setTimeout(resolve, 900) })
    expect(emitted).toContain('llm/adapters-updated')
    // 同一合并窗口：一次目录落地只广播一次。
    expect(emitted.filter((event) => event === 'llm/adapters-updated')).toHaveLength(1)
  })

  /**
   * ★★★ **首轮延后 10 秒**（2026-11-20 真实启动卡顿修复，变异 M4/M6 无牙后补）。
   *
   * 之前的用例都显式传 `delaysMs`（为了不等 10 秒），于是「**默认值**是 10 秒」
   * 和「`runChain` 真的用首项做延迟」这两件事**零覆盖** ⇒ 把它们改回 0 全绿。
   *
   * ⇒ 用 `schedule` 注入直接断言：**首个排程的 ms 必须是 10 秒**，
   * 且在那个定时器触发**之前** `warm` 不得被调用。
   */
  /**
   * ★★★ **首轮必须立即开始（首项 = 0）**（2026-11-20 二次修订）。
   *
   * ## 上一版把首项改成 10 秒是**错的**，实测首屏反而更慢（60 秒+）
   *
   * 原因在 `RemoteCatalogGate.run()` 的 in-flight 去重：
   *
   * ```ts
   * if (this.inFlight !== undefined) {
   *   await this.inFlight      // 复用别人正在飞的那次请求
   *   return
   * }
   * ```
   *
   * ⇒ **预热越早开始，宿主首屏越受益**：宿主调 `listModels` 时若预热已在飞，
   * 它 `await` 的是同一次请求，零额外成本。反过来（延后 10 秒）会让宿主
   * **自己发起**首轮请求，预热 10 秒后才重复一遍 —— 纯双输。
   *
   * ⚠️ 所以本用例守的是「**不许加人为延迟**」，而不只是「值是 0」。
   */
  it('★★★ 首轮立即开始（首项 = 0，不得加人为延迟）', async () => {
    const warm = vi.fn(async () => {})
    const scheduled: Array<{ fn: () => void; ms: number }> = []
    const stop = startCatalogPrewarm({
      providers: ['buddy'],
      warm,
      // ⚠️ 不传 delaysMs ⇒ 走默认 [0, 35_000, 75_000]
      schedule: (fn, ms) => { scheduled.push({ fn, ms }); return () => {} },
    })

    // 首轮排在 microtask 上：装配阶段**不该**有定时器（只有轮间才用 schedule）
    expect(scheduled, '首轮不得排定时器（应立即执行）').toHaveLength(0)

    // 排空 microtask 后首轮就已开跑
    for (let i = 0; i < 5; i += 1) await Promise.resolve()
    expect(warm, '首轮必须立即开跑（不得延后）').toHaveBeenCalledWith('buddy')
    stop()
  })

  it('★★ 默认常量首项是 0（接线层不传即立即预热）', () => {
    expect(CATALOG_PREWARM_DELAYS_MS[0], '首项必须 0（立即）').toBe(0)
    // 后续两段仍是「> 冷却」的补拉间隔
    expect(CATALOG_PREWARM_DELAYS_MS[1]).toBe(35_000)
    expect(CATALOG_PREWARM_DELAYS_MS[2]).toBe(75_000)
  })

  it('index.ts 接线了冷启动预热，且停止函数挂 ctx.effect', () => {
    const source = src('index.ts')
    expect(source).toContain("from './catalog-prewarm.js'")
    expect(source).toMatch(/ctx\.effect\(\(\)\s*=>\s*startCatalogPrewarm\(/)
    // 走 ctx.llm 公开路径（对 withDeadModelPruning 包装透明）。
    expect(source).toMatch(/warm:\s*\(provider\)\s*=>\s*ctx\.llm\.listModels\(provider\)/)
    /**
     * provider 列表由 `selectPrewarmProviders(...)` 筛出（2026-11-20）。
     * ⚠️ 断言「筛选函数被调用」而不是「== Object.keys」：后者是**筛选前**的
     * 全量，而本改动的目的正是**不再**预热全部（实测 33 家 → 8 家）。
     */
    expect(source).toMatch(/selectPrewarmProviders\(/)
    expect(source).toMatch(/Object\.keys\(modelAdapters\)/)
  })

  /**
   * ⚠️ 本组是**源码文本断言**（只能证明「接线在」，不能证明「行为对」）。
   * 行为由 `cline-adapter.spec.ts` 的「残缺目录自愈」段守着 —— 那里断言
   * 「冷却过后真的重拉并补齐」，而不是只断言 `cooling()`。
   *
   * ⚠️ 断言写成**不变式**而非具体表达式：早先这里写死
   * `warnings.length === 0`，把「完整判据」的实现细节钉在用例里，
   * 结果「改成更正确的判据」反而让用例变红（对抗审计指出）。
   */
  it('★ cline-adapter：短路按「已完整」判，且 got/complete 分开返回', () => {
    const source = src('cline-adapter.ts')
    // ★ 核心不变式：短路判据必须是**已完整**，不能是「已定义」。
    // 后者会让残缺目录永久固化（闸门冷却永远读不到）—— 缺陷② 的本体。
    expect(source).toMatch(/if \(this\.remoteComplete\) return/)
    expect(source).not.toMatch(/if \(this\.remoteModels !== undefined\) return\s*\n\s*await this\.catalogGate\.run/)
    // 完整判据来自 remote（每个来源各自的取数结果），**不能**由 warnings 反推：
    // 「主动跳过」（无凭据时的 /models）与「取到了」在 warnings 上不可区分。
    expect(source).toMatch(/const complete = remote === undefined \? got : remote\.complete === true/)
    // ⚠️⚠️ **完整必须并上 models.dev**（issue IKKZUG）：它是目录的第三个来源，
    // 而 `cline-pass/*` 的模型与图片能力**只有它提供**。漏掉它 ⇒ models.dev
    // 超时后目录被判成「已完整」⇒ 下面的短路永久生效 ⇒ 只能重启才能恢复
    // （用户实测：23:02 启动 → 次日 00:30 仍稳定拒图）。
    expect(source).toMatch(/this\.remoteComplete = complete && this\.modelsDev !== undefined/)
    // 残缺也要落缓存（否则每次 listModels 都重拉），但 complete=false 留冷却
    // ⚠️ 断言写成**不变式**（返回值里的 complete 必须是同一个合并后的判据），
    // 而不是 `complete }` 这种具体表达式 —— 早先这里写死 `complete }`，
    // 结果「把 complete 改成合并后的判据」反而让用例变红，而那正是本次要的修复。
    expect(source).toMatch(/return \{ got: true, complete: this\.remoteComplete \}/)
    // 完全没拿到时不落缓存
    expect(source).toMatch(/if \(!got\) return \{ got: false, complete: false \}/)
    // 死代码（重复 return true）已清掉
    expect(source).not.toMatch(/this\.remoteModels = merged\s*\n\s*return true\s*\n\s*return true/)
  })

  it('★ cline-models：两个来源各自记成败，跳过/形状异常都算「没取到」', () => {
    const source = src('cline-models.ts')
    // 显式 complete = 两个来源各自的取数结果
    expect(source).toMatch(/complete:\s*recommendedOk && modelsOk,/)
    // 无凭据是**跳过**而不是成功 —— 必须记 warning（否则被判成完整）
    expect(source).toMatch(/warnings\.push\('models 已跳过/)
    // 形状不可识别必须记 warning（HTTP 200 + 网关降级返回 `{}` / HTML）
    expect(source).toMatch(/isClineRecommendedShape\(payload\)/)
    expect(source).toMatch(/isClineModelsShape\(payload\)/)
  })
})

/**
 * ★★★ **预热只挑「有启用账号」的 provider**（2026-11-20 真实启动卡顿修复）。
 *
 * ## 实测背景（33 个 provider，冷启动第 1 轮）
 *
 *     +     8ms  22 个 provider 全部完成
 *     +  1289ms  workbuddy / codearts
 *     + 12586ms  cline (12585ms)   ← 独占 12.5 秒
 *
 * 本机 60 个账号只覆盖 **10 家**，其余 **23 家一个账号都没有**，却照样被预热。
 *
 * ⚠️ 更关键的是 `cline`：账号 **已停用但凭据还在** ⇒ 骨架的账号门控
 *（`hasLoggedInAccount` 判据是「凭据可解析」，**刻意不看 `enabled`**）
 *  照样放行 ⇒ 它完整走完「两个端点 + models.dev 6.47MB」⇒ 12.5 秒。
 *
 * ⇒ 预热前用**同步**判据筛：只留「至少一个**启用**账号」的 provider。
 */
describe('selectPrewarmProviders：预热只挑有启用账号的 provider', () => {
  /** 造一个「provider → 账号列表」的读取器；未登记的 provider 抛错。 */
  const poolOf = (table) => (provider) => {
    const accounts = table[provider]
    if (accounts === undefined) throw new Error(`未登记：${provider}`)
    return accounts
  }

  it('★★★ 只保留「至少一个启用账号」的 provider', () => {
    const list = poolOf({
      buddy: [{ enabled: true }],
      workbuddy: [{ enabled: true }, { enabled: true }],
      cline: [{ enabled: false }],
      opencode: [{ enabled: false }],
      trae: [{ enabled: true }, { enabled: false }],
    })
    const out = selectPrewarmProviders(
      ['buddy', 'workbuddy', 'cline', 'opencode', 'trae'],
      list,
    )
    expect(out).toEqual(['buddy', 'workbuddy', 'trae'])
  })

  it('★★★ 停用账号不得让该 provider 通过（真实缺陷的核心形态）', () => {
    // ⚠️ 这正是 cline 的形态：凭据还在 ⇒ hasLoggedInAccount 返回 true ⇒
    //    骨架门控放行 ⇒ 真的去拉 12.5 秒的目录。
    const list = poolOf({ cline: [{ enabled: false }] })
    expect(selectPrewarmProviders(['cline'], list)).toEqual([])
  })

  it('★★ `enabled` 缺省视为启用（与账号池其它判据一致）', () => {
    // 账号池里 `enabled` 可选，缺省 = 启用（既有口径是 `a.enabled !== false`）
    const list = poolOf({ buddy: [{}], trae: [{ enabled: undefined }] })
    expect(selectPrewarmProviders(['buddy', 'trae'], list)).toEqual(['buddy', 'trae'])
  })

  /**
   * ★★★ **必须看「所有」账号，不能只看第一条**（变异 M3 无牙后补）。
   *
   * 之前的用例里「首条账号」恰好能代表结果 ⇒ 把实现改成 `list[0].enabled`
   * 时全绿。真实形态里**停用账号经常排在前面**（先加后停用），
   * 只看第一条会把「其实还有启用账号」的 provider 误排除 ⇒ 目录永不预热。
   */
  it('★★★ 首条停用但后续有启用 ⇒ 必须保留', () => {
    const list = poolOf({ buddy: [{ enabled: false }, { enabled: true }] })
    expect(selectPrewarmProviders(['buddy'], list)).toEqual(['buddy'])
  })

  it('★★ 首条启用但后续全停用 ⇒ 保留（已有一条启用即可）', () => {
    const list = poolOf({ buddy: [{ enabled: true }, { enabled: false }, { enabled: false }] })
    expect(selectPrewarmProviders(['buddy'], list)).toEqual(['buddy'])
  })

  it('★ 全停用 ⇒ 空数组（预热整体跳过）', () => {
    const list = poolOf({ a: [{ enabled: false }], b: [{ enabled: false }] })
    expect(selectPrewarmProviders(['a', 'b'], list)).toEqual([])
  })

  it('★ 保持原顺序（不得重排）', () => {
    const list = poolOf({
      z: [{ enabled: true }],
      a: [{ enabled: true }],
      m: [{ enabled: true }],
    })
    expect(selectPrewarmProviders(['z', 'a', 'm'], list)).toEqual(['z', 'a', 'm'])
  })

  it('★★ 读池抛错 ⇒ 保守保留（宁可慢，不要永不预热）', () => {
    // ⚠️ 误删的后果是「目录永不预热」⇒ 客户端永久停在兜底表，比慢更糟。
    const list = () => { throw new Error('池读取失败') }
    expect(selectPrewarmProviders(['a', 'b'], list)).toEqual(['a', 'b'])
  })

  it('★ 空输入 ⇒ 空输出', () => {
    expect(selectPrewarmProviders([], () => [])).toEqual([])
  })
})
