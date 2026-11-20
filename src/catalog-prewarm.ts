/**
 * 冷启动的**有界目录预热**（issue IKJVTF）。
 *
 * ## 为什么需要它
 *
 * 冷启动时凭据可能还没就绪、或本机到目录端点的**首次**连接不稳定 ——
 * 首拉失败后 `remoteModels` 保持 `undefined`，适配器回落到**静态兜底表**。
 * 此后：
 *
 * - 客户端 `ModelCatalogDirectory` 把这份**兜底目录**缓存成 `status: 'ready'`
 *   （它只认宿主事件，见 `catalog-broadcast.ts`）；
 * - 适配器侧虽有闸门冷却，但**没有任何东西会在冷却到期后再试一次** ——
 *   只有用户主动操作（打开设置页、切换模型）才可能触发下一次 `listModels`。
 *
 * 于是「远端目录其实早就拿到了，只是没人再问一次」会一直持续到用户碰巧
 * 触发重读为止。本模块补的就是这条**自愈**路径。
 *
 * ## 为什么是「有界」而不是定时轮询
 *
 * 目录是**启动期**问题：稳态下 `remoteModels` 已落地，各适配器在
 * `remoteModels !== undefined` 处直接短路，预热调用是零成本的本地判断。
 * 但若做成无限轮询，一个**真的**拿不到目录的 provider（未登录 / 上游长期故障）
 * 会被每 30 秒唤醒一次，永远打无谓请求。故只排固定的几轮就停手。
 *
 * ## ⚠️ 间隔必须大于闸门的失败冷却
 *
 * `RemoteCatalogGate` 失败后冷却 {@link REMOTE_CATALOG_COOLDOWN_MS}（30 秒）。
 * 若预热间隔**小于**它，重试会被闸门**原样挡回**、什么也不做 ——
 * 那等于没有预热。故默认间隔是 35s（> 30，留 5 秒余量）。
 *
 * ⚠️ **光有「间隔 > 冷却」还不够**（对抗审计实测证伪）：闸门的 `retryAt` 是
 * 「**失败那一刻** + 30s」，而固定排程是「**启动那一刻** + 35s / 75s」——
 * 首拉耗时 `d` 落在 `(5s, 35s]` 时 35s 轮被挡回，落在 `(45s, 75s]` 时 75s 轮
 * 也被挡回（`d=60s` 实测：`retryAt=90s`，75s 轮时仍在冷却）。
 * ⇒ 排程改为**链式**（上一轮**结束**后再排下一轮），见 `runChain`。
 *
 * 这条约束由 `tests/unit/catalog-prewarm.spec.ts` 用
 * `isPrewarmSpacingValid()` 直接守着 —— 谁把间隔改小，那条用例就变红。
 */

import { REMOTE_CATALOG_COOLDOWN_MS } from './remote-catalog-gate.js'

/**
 * 预热轮次的间隔（毫秒，**相对上一轮结束**，见 `runChain`）。
 *
 * - `0` —— 首次立即执行（凭据往往已就绪，能一把拿到目录）；
 * - `35_000` / `75_000` —— 两段补拉间隔，覆盖「首拉时凭据未就绪 / 网络抖动」。
 *
 * ⚠️ 非零项必须**大于** {@link REMOTE_CATALOG_COOLDOWN_MS}，否则被闸门挡回。
 */
export const CATALOG_PREWARM_DELAYS_MS: readonly number[] = [0, 35_000, 75_000]

/** 日志出口（两级可选链，与仓库既有约定一致：日志不该成为功能的单点故障）。 */
export interface CatalogPrewarmLogger {
  warn?: (message: string) => void
  info?: (message: string) => void
}

export interface CatalogPrewarmOptions {
  /** 要预热的 provider 列表（通常取 `modelAdapters` 的键）。 */
  providers: readonly string[]
  /**
   * 触发一轮目录读取。
   *
   * 生产形态是 `(provider) => ctx.llm.listModels(provider)` —— 它会走完整路径
   * （账号门控 → `ensureRemoteModels` → 闸门），故目录已就绪时是**零网络**的。
   */
  warm: (provider: string) => Promise<unknown>
  /** 预热时刻，默认 {@link CATALOG_PREWARM_DELAYS_MS}。 */
  delaysMs?: readonly number[]
  logger?: CatalogPrewarmLogger
  /**
   * 定时器注入（测试用）。
   *
   * 默认 `setTimeout`；返回一个取消函数。注入它可让用例**同步**推进时间，
   * 不必真的等 35 秒（也不必用 `vi.useFakeTimers` 污染同文件其余用例 ——
   * 与 `BuddyAdapterOptions.now` 同款理由）。
   */
  schedule?: (fn: () => void, ms: number) => () => void
}

/** 默认定时器：`setTimeout` + 返回取消函数。 */
function defaultSchedule(fn: () => void, ms: number): () => void {
  const timer = setTimeout(fn, ms)
  // Node 的 timer 会**阻止进程退出**（除非 unref）。预热只是启动期的优化，
  // 绝不能因为它在排队就让 `dsh` 命令行挂住不退 —— 故 unref。
  // ⚠️ 浏览器/其它宿主没有 `unref`，故用可选调用。
  ;(timer as unknown as { unref?: () => void }).unref?.()
  return () => clearTimeout(timer)
}

/**
 * ★★★ **筛出「值得预热」的 provider**（2026-11-20，真实启动卡顿修复）。
 *
 * ## 它修的是什么
 *
 * 实测（33 个 provider，冷启动第 1 轮）：
 *
 * ```
 * +     8ms  22 个 provider 全部完成
 * +  1289ms  workbuddy / codearts
 * + 12586ms  cline (12585ms)   ← 独占 12.5 秒
 * ```
 *
 * 本机 60 个账号只覆盖 **10 家**，其余 **23 家一个账号都没有**，却照样被预热。
 * 更糟的是 `cline`：账号 **已停用但凭据还在** ⇒ 骨架的账号门控
 * （`providerCatalogVisible` → `hasLoggedInAccount`，判据是「凭据可解析」，
 * **刻意不看 `enabled`**）照样放行 ⇒ 它完整走完「两个端点 + models.dev 6.47MB」
 * 的链路 ⇒ 12.5 秒。
 *
 * ## 判据：至少一个**启用**账号
 *
 * - 没有启用账号 ⇒ 用户此刻用不到这家 ⇒ 目录拉下来也没人看；
 * - 与页头供应商开关 / 模型选择器的可见性**同源**；
 * - **同步**（读账号池内存副本），不引入异步开销。
 *
 * ⚠️ **刻意不用 `hasLoggedInAccount`**：它异步（逐个解析凭据），33 家筛一遍
 * 比预热本身还慢；且它**不看 `enabled`** —— 正是本缺陷的成因之一。
 *
 * ⚠️ **代价（已确认接受）**：用户新登录/重新启用一个 provider 后，它的目录
 * 不在本轮预热里 ⇒ 要等下一次 `listModels`（打开设置页 / 切模型）才拉。
 * 那是**用户主动动作触发的**，不构成启动卡顿。
 *
 * @param providers - 全部候选 provider id（通常是 `Object.keys(modelAdapters)`）
 * @param listAccounts - 读某 provider 的全部账号（含停用），通常是
 *   `(p) => pool.listAccountsByProvider(p)`
 * @returns 过滤后的 provider 列表（保持原顺序）
 *
 * ⚠️ **读池异常时保守保留**该 provider：预热失败只是慢，误删会让目录
 * **永不预热**（那是更糟的静默失效，客户端会永久停在兜底表上）。
 */
export function selectPrewarmProviders(
  providers: readonly string[],
  listAccounts: (provider: string) => readonly { enabled?: boolean }[],
): string[] {
  return providers.filter((provider) => {
    try {
      return listAccounts(provider).some((account) => account.enabled !== false)
    } catch {
      return true
    }
  })
}

/**
 * 启动有界预热，返回**停止函数**（须挂到 `ctx.effect` 上）。
 *
 * 每轮对每个 provider 各调一次 {@link CatalogPrewarmOptions.warm}。
 * 单个 provider 失败**不影响**其余（`Promise.allSettled` 语义）——
 * 一个未登录的 provider 不该让其它 provider 的预热一起消失。
 */
export function startCatalogPrewarm(options: CatalogPrewarmOptions): () => void {
  const delays = options.delaysMs ?? CATALOG_PREWARM_DELAYS_MS
  const schedule = options.schedule ?? defaultSchedule
  let stopped = false
  const cancels: Array<() => void> = []

  /** 跑一轮：逐 provider 触发读取，全部失败都只记日志。 */
  const runRound = async (): Promise<void> => {
    // 逐 provider 独立等待，避免一个 provider 的慢请求拖住其余
    // （它们本就互不依赖，且各自的闸门负责去重与冷却）。
    await Promise.allSettled(options.providers.map(async (provider) => {
      try {
        await options.warm(provider)
      } catch (error) {
        options.logger?.warn?.(
          `[jet-hub] 目录预热失败（${provider}）：${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }))
  }

  /**
   * 按 {@link CatalogPrewarmOptions.delaysMs} 依次跑，**每轮结束再排下一轮**。
   *
   * ## ⚠️ 为什么不是「一次性把三轮都排上」（真实缺陷，对抗审计实测证伪）
   *
   * 闸门的失败冷却 `retryAt` 是「**失败那一刻** + 30s」，而固定排程是
   * 「**启动那一刻** + 35s / 75s」。两者错位时重试会被闸门**原样挡回**：
   *
   * | 首拉耗时 d | 35s 轮 | 75s 轮 |
   * |---|---|---|
   * | 6s（cline 超时 20s 之内） | **白费** | 有效 |
   * | 60s（buddy/loomy/raccoon 超时） | **白费** | **白费** |
   *
   * 实测：`d=60s` 时 `retryAt = 60s+30s = 90s`，而 75s 轮在 `t=75s` 时
   * `cooling()` 仍为真 ⇒ 那一轮什么也不做。
   *
   * ⇒ 改成**链式**：`上一轮结束 + 间隔` 才排下一轮。间隔本身仍严格大于冷却，
   * 故只要上一轮真的尝试过（哪怕失败），下一轮必然已越过冷却窗口。
   *
   * ⚠️ `delaysMs` 的语义随之变为「**轮次之间的间隔**」，其**首项**是首次延迟
   *（`0` = 立即）。`CATALOG_PREWARM_DELAYS_MS = [0, 35_000, 75_000]` 于是表示
   *「立即跑一轮，此后每隔 35s 再跑，共三轮」—— 对用户而言「共三轮」这个
   * **有界**语义不变（这是本模块的设计前提：不做无限轮询）。
   */
  const runChain = async (index: number): Promise<void> => {
    if (stopped) return
    if (index >= delays.length) return
    await runRound()
    if (stopped) return
    const next = delays[index + 1]
    if (next === undefined) return
    // 间隔取 `next` 自身（`[0, 35_000, 75_000]` ⇒ 两段各 35s / 75s）。
    // 首项 `0` 只表示「立即」，不参与间隔；万一有人把首项写成非 0，
    // 用它当间隔也仍是「大于冷却」的合法值。
    const gap = next > 0 ? next : REMOTE_CATALOG_COOLDOWN_MS + 1
    cancels.push(schedule(() => {
      void runChain(index + 1)
    }, gap))
  }

  // 立即那一轮：**排到 microtask**，不在调用栈内触达 `warm`。
  // `apply()` 是同步函数，而 `warm` 会发起网络请求 —— 同步调用它等于把
  // 首个请求塞进插件启动路径（与既有的 opencode 能力预热同款约定）。
  queueMicrotask(() => {
    if (stopped) return
    void runChain(0)
  })

  return () => {
    stopped = true
    for (const cancel of cancels) cancel()
    cancels.length = 0
  }
}

/**
 * 预热间隔是否满足「大于闸门冷却」这条硬约束。
 *
 * 抽成函数是为了让**接线层**也能断言（不止单测）：间隔小于冷却时预热等于没做，
 * 且症状是「静默无效」（没有任何报错，只是目录一直补不回来）。
 */
export function isPrewarmSpacingValid(delays: readonly number[] = CATALOG_PREWARM_DELAYS_MS): boolean {
  // 只看**非零**的那些：立即那一轮（0）不受冷却约束。
  return delays.filter((delay) => delay > 0).every((delay) => delay > REMOTE_CATALOG_COOLDOWN_MS)
}
