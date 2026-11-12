/**
 * CodeBuddy / WorkBuddy 账号余额缓存 + 按「积分何时作废」优先的选号。
 *
 * ## 它解决什么
 *
 * 两个 buddy 的账号池里，一个号常同时持有多种资源包（实测 WorkBuddy 每个号都有
 * 「Bonus Pack（14 天到期）」+「Free Plan Subscription（扣费截止 8 年后）」），
 * 而**服务端扣哪个包不由我们决定**。插件能做的是决定**用哪个号**：
 *
 * - 优先用「还有 15 天内到期积分」的号（那部分再不用就作废）；
 * - 只剩永久积分的号排最后；
 * - **锁定永久积分**时，只剩永久积分的号**等同于不可用**（与 Loomy 同语义）。
 *
 * 分档判据见 `buddy-balance-rank.ts`（为什么是 15 天、为什么用 `DeductionEndTime`）。
 *
 * ## 与 Loomy 那份（`loomy-balance-selector.ts`）的关系
 *
 * 同构：同样的 60 秒 TTL、同样的并发查余额、同样的「查询失败不抛错、归入最后
 * 一档」。差异只在余额的来源 —— Loomy 读服务端给的两个字段，这里读
 * `get-user-resource` 的包列表并按到期时间现算。
 *
 * ## 缓存**原料**、绝不冻结分类（本文件最重要的一条）
 *
 * 每次选号都实时查所有账号会显著变慢（N 个账号 = N 次网络往返，且该端点的响应
 * 实测可达数百 KB —— 一个账号可能有 105 个资源包）。故缓存 `get-user-resource`
 * 的原始 `CreditBalance`，TTL 60 秒。
 *
 * ⚠️ 但 TTL 的**唯一职责是抑制网络请求**，不能顺手把算好的两桶也缓存住：
 * 「临时 / 永久」是**当前时刻的函数**（`DeductionEndTime - now` 与 15 天比较），
 * 而宿主长期开着、时间只向前流 —— 一笔距到期 15.02 天的余额，在用户什么都不做的
 * 两分钟里就越过了线。若分类被缓存，选号会继续按「永久」处理一笔其实马上要作废的
 * 积分（锁定时更糟：本该可用的号被判成不可用）。所以 `balanceOf` 命中缓存也
 * **每次重新分桶**（窗口 env 也每次重读）。
 *
 * ℹ️ Loomy 那份（`loomy-balance-selector.ts`）缓存的是服务端给的**两个数字**，
 * 里面不含「按 now 现算」的成分，所以它没有这个问题 —— 不是漏改。
 */

import type { BuddyCredential } from './buddy.js'
import type { BuddyProduct } from './product.js'
import { fetchCreditBalance, type CreditBalance } from './credits.js'
import {
  buddyExpiringWindowDays,
  buddyBalanceTier,
  BUDDY_BALANCE_TIER,
  buddyTierUsable,
  rankBuddyAccountsByBalance,
  rankBuddyAccountsByManualOrder,
  rotateFromPreferred,
  splitBuddyCreditsByExpiry,
  type BuddyAccountBalance,
  type BuddyBalanceTier,
  type BuddyCreditSplit,
  type BuddyTierOptions,
} from './buddy-balance-rank.js'

/** 余额缓存 TTL（毫秒），与 Loomy 同值。 */
export const BUDDY_BALANCE_CACHE_TTL_MS = 60_000

/**
 * **失败**结果的缓存 TTL（毫秒）—— 比成功短一个数量级。
 *
 * 与 Loomy 那份同一修复（用户报障 2026-09-29）：失败条目归入 `none` 档，
 * 锁定时被判「不可用」，于是**一次网络抖动**会让整池在 60 秒内全部不可用，
 * 用户被告知「额度已用尽」而实际号里都有钱。失败是瞬时状态，
 * 不该被当成一个持续一分钟的事实。
 */
export const BUDDY_BALANCE_ERROR_CACHE_TTL_MS = 5_000

/** 单个账号的余额（含查询失败标记）。 */
export interface BuddyAccountBalanceEntry extends BuddyAccountBalance {
  /** 查询是否成功；false 时两个余额字段均为 undefined。 */
  ok: boolean
  /** 查询失败原因（诊断用）。 */
  error?: string
  /** 分到的档位（查询后即刻算出，供日志与 UI 直接读取）。 */
  tier?: BuddyBalanceTier
  /** 原始拆分结果（展示「15 天内到期 X · 永久 Y」用）。 */
  split?: BuddyCreditSplit
  /**
   * ⚠️ **本次读数是「降级结果」**（`balance.degraded === true`）。
   *
   * 语义：**总额读到了、逐包明细丢了** ⇒ 拆分出的「永久桶」可能其实是
   * 「明明有临期、但我们看不到」。此时**不得**断言 `exhausted`（见
   * `noAccountReason` 的注释与实测）。
   */
  degraded?: boolean
}

/** 一条待选账号（调用方从账号池取出）。 */
export interface BuddyCandidateAccount {
  id: string
  credentialRef: string
}

/**
 * 锁定状态下「无可用账号」的原因。
 *
 * ⚠️ 四者**必须分开报**（与 Loomy 那份同一修复）：混成一句「额度都已用尽」
 * 会让一次网络抖动伪装成"钱花完了"，用户于是去解锁、或白等到明天 ——
 * 而号其实有钱。
 */
export type BuddyNoAccountReason =
  /** 所有候选都查到了余额，且可用那类积分确实都是 0。 */
  | { kind: 'exhausted' }
  /**
   * 至少一个候选**查询失败**，无法判定它是否真的没额度。
   *
   * ⚠️ `degraded: true` = 至少一个候选的余额是**降级读数**（总额读到、逐包明细
   * 丢了）⇒ **不能**按「纯查不到」放宽永久积分锁定（2026-11-05 对抗审计 P2-1）：
   * 明细丢失时「有临期积分」会被误判成「只剩永久积分」，而放宽就会真烧掉永久积分。
   */
  | { kind: 'unknown'; errors: string[]; degraded?: boolean }
  /**
   * **一个候选都没有** ⇒ 压根没走到余额查询，也就无从断言「积分用尽」。
   *
   * ⚠️ 这一档是**必须**的（真实报障 2026-10-13，CodeBuddy）：候选由
   * `candidatesOf` 按 `enabled` + 模型限流筛出，**全部账号都被目标模型限流**
   * 时它就是个空集 —— 循环一次都不执行，`reason` 保持 `undefined`，调用方的
   * `?? { kind: 'exhausted' }` 兜底于是把「限流」谎报成「积分都已用尽」，
   * 用户据此去解锁永久积分，方向完全错（解禁时刻其实就写在 `modelRateLimits` 里）。
   */
  | { kind: 'no-candidates' }
  /**
   * **候选非空、余额也真的查了、分档每次都选出了「可用档」的号** —— 只是那些号
   * 的**凭据**解析不出来（`readCredential` 返回 `undefined`）。
   *
   * ⚠️ 这一档同样是**必须**的，而且它比 `no-candidates` 更隐蔽（2026-10-14 审计
   * 实测打穿）：分档返回 `ok: true` 这一事实**本身就证明**该号有可用的临期积分
   * （锁定时 `buddyTierUsable` 只对 `expiring` 为真），所以此时**恰恰不能**说
   * 「积分都已用尽」—— 我们刚刚查到它有钱，矛盾出在**凭据**上。
   *
   * 可达时序（三条都是真实路径，不是理论构造）：
   * 1. 余额缓存（60s TTL）在上一轮请求里命中并写入了「该号有临期积分」，
   *    凭据在这 60 秒内失效（续期失败 / 被并发烧掉 / 用户删除）；
   * 2. 多候选时同理：`select()` 逐个把「档位最优但凭据坏」的号排除，耗尽后
   *    `reason` 从未被赋值（它是 `undefined` 而非 `exhausted`）；
   * 3. 单候选最直接：一次 `select()` 就选出了那个有临期积分的号。
   *
   * ⇒ 报「积分都已用尽」会再一次把用户推向「解锁永久积分」（**不可撤回地烧钱**），
   *   而真正该做的是**修凭据 / 重新登录那个账号**。
   */
  | { kind: 'credential-only' }

/** 选号结果：选中，或「为什么没选中」。 */
export type BuddySelectionResult
  = { ok: true; account: BuddyCandidateAccount; balance: BuddyAccountBalanceEntry }
  | { ok: false; reason: BuddyNoAccountReason }

/**
 * `fetchBalance` 的**条件必填**规则（2026-10-06 PR !68 审计）。
 *
 * 只有 buddy 系能省略它（凭据结构相同，缺省实现直接调 `fetchCreditBalance`）。
 * **其它 provider 必须显式传入** —— 否则编译器无从发现「忘了传」。
 *
 * ⚠️ 这不是洁癖：已实测漏传时 `tsc` **零报错**，而 `fetchCreditBalance` 会拿
 * 异形的 `product` 拼 URL（`TraeProduct` 根本没有 `endpoint` 字段）⇒ 发出
 * `undefined/...` 的畸形请求 → 余额恒查不到 → 未锁定时换号优化静默失效、
 * 锁定时永远报「无法确认是否有可用账号」。这条漏洞比烧积分更难归因。
 */
/**
 * 余额查询回调的**第二、三参**（账号 id / 按账号取出口）。
 *
 * ## 为什么需要它
 *
 * 出口代理是**账号维度**的，而选号器在给某个候选查余额时**知道**那是哪个账号
 * ⇒ 必须把它传给 `fetchBalance`，否则国际站那类「端点按出口 IP 分流」的渠道
 * 会恒查不到余额（症状：聚合轮换里被**静默剔除**，而面板走另一条带 XFF 的
 * 链路却还能刷新 —— 极难归因）。
 *
 * ⚠️ 之所以是**可选对象**而不是再添一个位置参数：既有 6 处 `fetchBalance`
 * 都是两参箭头（buddy / trae / loomy / raccoon / minimax 两站），加必填第三参
 * 会让它们全部要改；而它们是**合法且正确**的（那几家不需要按账号换出口）。
 */
export interface BalanceFetchContext {
  /** 正在查余额的账号 id（拿不到时为空串 = 无账号维度）。 */
  accountId: string
  /** 按账号 id 取出口（未注入 = 直连）。 */
  fetchFor?: (accountId: string) => typeof fetch
}

type FetchBalanceRule<TProduct, TCredential> = TProduct extends BuddyProduct
  ? {
    /** 余额查询（缺省走真实的 `fetchCreditBalance`）。 */
    fetchBalance?: (
      credential: TCredential,
      product: TProduct,
      ctx?: BalanceFetchContext,
    ) => Promise<CreditBalance | null>
  }
  : {
    /** ⚠️ 非 buddy provider **必填** —— 缺省会拼出畸形 URL 并静默失效。 */
    fetchBalance: (
      credential: TCredential,
      product: TProduct,
      ctx?: BalanceFetchContext,
    ) => Promise<CreditBalance | null>
  }

/**
 * **带原因**的余额查询（可选能力）—— 传了它就用它的 `error`，不再一律报
 * `'余额查询失败（凭据失效或响应异常）'`。
 *
 * ## 为什么必须有这一条（真实报障 2026-10-21，Qoder）
 *
 * 用户看到的报错：
 * ```
 * Qoder：无法确认是否有可用账号。……（余额查询失败（凭据失效或响应异常）；
 *         余额查询失败（凭据失效或响应异常））……
 * ```
 * 而**同一时刻**，Jet Hub 面板上两张账号卡片的积分行写的是完整原因
 * （`连不上 https://openapi.qoder.sh（UND_ERR_CONNECT_TIMEOUT）：……请导出 HTTPS_PROXY`）
 * —— 用户据此问「面板说得明明白白，为什么报错里反而不知道？」。
 *
 * 根因：`fetchBalance` 的返回类型是 `Promise<CreditBalance | null>`，
 * **`null` 把「网络不通 / 401 / 响应缺字段 / 不是 JSON」四件事抹成同一格**
 * （这正是 `src/qoder-credits.ts` 那个 `fetchQoderBalanceDetailed` 存在的原因）。
 * 面板那条腿走的是 `credits.balances` RPC，它已经改用详细变体；
 * 而**选号这条腿**（本类）仍在用丢原因的薄封装 ⇒ **同一语义两套判据**
 * （AGENTS.md 首条红线），且症状是最坏的一种：**把可操作的原因替换成一句
 * 无从下手的猜测**，用户于是去查凭据 —— 而真实原因是网络。
 *
 * ⚠️ **可选**，不是必填：buddy 系（CodeBuddy / WorkBuddy）的余额腿本来就
 * 只返回 `CreditBalance | null`，强制必填会让所有既有调用点都要造一个
 * 假的详细变体。未传时退化为原行为（那句概括文案），**语义不变**。
 *
 * ⚠️ 返回形状与 `src/provider-runtime.ts` 的 `ProviderBalanceDetail` **刻意一致**
 * （`balance: T | null` + `error?: string`）：本仓库已有该形状的三处使用
 * （`fetchBalanceDetailed` / `fetchAstudioBalanceDetailed` / `credits.balances`），
 * 再发明一个只会多一处漂移。此处**不 import 那个类型**是为了不让
 * `buddy-balance-selector.ts`（被 buddy 系共用）反向依赖 provider-runtime 的装配域
 * —— 结构化同构足够，且下面 `FetchBalanceRule` 已经证明了这种「形状对齐、不引类型」
 * 的写法在本文件是既有惯例。
 */
export interface BalanceQueryDetail<TBalance> {
  balance: TBalance | null
  /** 查不到时的**可操作**原因（点名主机 / HTTP 状态 / 缺哪个字段）。 */
  error?: string
}

/**
 * 选号依赖（便于单测注入）。
 *
 * ⚠️ **泛型化**（2026-10-06）：分档判据只读通用的
 * `packages[].{ active, remaining, deductionEndTime }`，与 provider 无关，
 * 故 TRAE / LobsterAI 也复用本选择器。`TProduct` / `TCredential` 让调用方
 * 保留自己的精确类型（缺省仍是 buddy，既有调用点无需改动）。
 *
 * ⚠️ 唯一要求：`fetchBalance` 返回的 `CreditBalance.packages[]` 必须带
 * `deductionEndTime`（拿不到就归入永久桶，见 `splitBuddyCreditsByExpiry`）。
 */
export type BuddySelectionDeps<
  TProduct = BuddyProduct,
  TCredential = BuddyCredential,
> = {
  product: TProduct
  /** 解析某账号的凭据；返回 undefined 表示不可用。 */
  resolveCredential: (credentialRef: string) => Promise<TCredential | undefined>
  /** 注入的 fetch（测试用）。 */
  fetcher?: typeof fetch
  /** 当前时间（测试用）。 */
  now?: () => number
  /** TTL 覆盖（测试用）。 */
  ttlMs?: number
  /** **失败**结果的 TTL 覆盖（测试用）。 */
  errorTtlMs?: number
  /** 「临时积分」窗口覆盖（测试用）。 */
  windowMs?: number
  /**
   * **带原因**的余额查询（可选，传了就优先用它）。
   *
   * 见 {@link BalanceQueryDetail} 的长注释：`fetchBalance` 的 `null` 把四种
   * 完全不同的失败抹成同一格，而锁定时那句概括文案会把用户引向「查凭据」，
   * 真实原因可能是网络不通。**两者都传时本字段优先**（它是 `fetchBalance`
   * 的严格超集：能拿到 `balance`，也能拿到为什么拿不到）。
   *
   * ⚠️ **第三参与 `fetchBalance` 同款**（{@link BalanceFetchContext}）：详细变体
   * 优先意味着它一旦注入，`fetchBalance` 整个不再执行 —— 若这里不给 `ctx`，
   * 那些「必须按账号换出口」的渠道（MiniMax 国际站）会**只在详细变体这条腿上
   * 丢掉出口**，症状是余额恒查不到、渠道被静默剔除，而 `fetchBalance` 上
   * 明明接好了。故两者必须同时收 `ctx`，缺一不可。
   */
  fetchBalanceDetailed?: (
    credential: TCredential,
    product: TProduct,
    ctx?: BalanceFetchContext,
  ) => Promise<BalanceQueryDetail<CreditBalance>>
  /**
   * 按**账号 id** 取出口（可选；仅「端点按出口 IP 分流」的渠道需要，
   * 如 MiniMax 国际站）。未注入时不出现在 {@link BalanceFetchContext} 里，
   * 既有 provider 的行为**逐字节不变**。
   */
  fetchFor?: (accountId: string) => typeof fetch
} & FetchBalanceRule<TProduct, TCredential>

/**
 * 一次余额查询的**原料**（缓存这个，而不是缓存分类结果）。
 *
 * 之所以能整份留着 `CreditBalance` 复用：「临时 / 永久」只依赖
 * `packages[].remaining` / `active` / `deductionEndTime` 三个字段 + 当前时刻，
 * 而这三样都在这份原料里 —— 重算分类不需要再打网络。
 */
type BalanceSource =
  | { ok: true; balance: CreditBalance }
  | { ok: false; error: string }

/** 一个账号的缓存条目：`at` 是**网络请求时刻**（只用于 TTL），不含任何计算结果。 */
interface CacheEntry {
  at: number
  source: BalanceSource
}

/**
 * 余额缓存 + 选号器。
 *
 * 生命周期与 provider 的适配器注册一致（**每个 provider 各一个实例**），
 * 故不存在跨站缓存互相串味的可能。
 *
 * ⚠️ 泛型参数见 {@link BuddySelectionDeps}；缺省仍是 buddy 系，
 * 既有调用点（CodeBuddy / WorkBuddy）无需改动。
 */
export class BuddyBalanceSelector<
  TProduct = BuddyProduct,
  TCredential = BuddyCredential,
> {
  private readonly cache = new Map<string, CacheEntry>()

  constructor(private readonly deps: BuddySelectionDeps<TProduct, TCredential>) {}

  /** 清空缓存（凭据变化、手动刷新余额、领取积分后调用）。 */
  invalidate(accountId?: string): void {
    if (accountId === undefined) this.cache.clear()
    else this.cache.delete(accountId)
  }

  /**
   * 当前生效的「临时积分」窗口（毫秒）。
   *
   * ⚠️ **每次调用都重新解析环境变量**，不能缓存：窗口可被用户随时改，
   * 而提示文案与选号判据必须取同一个值 —— 缓存会让两者在不同时刻分裂。
   */
  private windowMs(): number {
    return this.deps.windowMs ?? buddyExpiringWindowDays() * 24 * 60 * 60 * 1000
  }

  /**
   * 查一个账号的余额分类（**缓存原料、每次现算**）。
   *
   * ⚠️ TTL 只用于抑制**网络请求**，绝不能拿来冻结分类：「临时 / 永久」是
   * **当前时刻的函数** —— 一笔距到期 15.2 天的余额，什么都没人操作，
   * 过 30 分钟就成了临时积分。所以这里缓存的是 `get-user-resource` 的原始
   * `CreditBalance`，命中缓存也重新分桶（并重新读一次窗口 env）。
   * 宿主是长期开着的，时间只会向前流动。
   *
   * ⚠️ **查询失败不抛错**：返回 `ok: false` 的条目，由分档逻辑归入最后一档 ——
   * 让「一个号查不到」不至于让整个选号失败（凭据过期是最常见的失败原因，
   * 此时应继续用别的号，而不是把错误抛给用户）。
   *
   * ⚠️ **失败结果的 TTL 短一个数量级**（与 Loomy 那份同一修复，见
   * `BUDDY_BALANCE_ERROR_CACHE_TTL_MS`）：把一次抖动缓存满 60 秒，会让
   * 「查不到」伪装成「额度用尽」整整一分钟。
   */
  async balanceOf(account: BuddyCandidateAccount): Promise<BuddyAccountBalanceEntry> {
    const now = this.deps.now?.() ?? Date.now()
    const cached = this.cache.get(account.id)
    if (cached !== undefined) {
      /**
       * ⚠️⚠️ **降级结果必须走「错误」那档短 TTL**（2026-10-21 二轮审计，P2）。
       *
       * `ok: true` + `degraded: true` 的组合语义是「总额读到了、逐包明细丢了」——
       * 它**不是一个稳定的成功读数**，而是一次**瞬态不确定性**（例如流水端点抖动）。
       *
       * 若按 `ok` 走 60 秒长 TTL：一次抖动 ⇒ **60 秒内每次选号都报 `unknown`**
       *（修前更糟：60 秒内报「积分都已用尽」）。
       * ⇒ 降级与失败同等对待，走 `errorTtlMs`（默认 5 秒）⇒ 抖动一过即自愈。
       *
       * ⚠️ 判据必须读 `cached.source.balance.degraded`（**原料**），不是
       * `classify()` 之后的条目 —— `classify` 依赖 `now`，而这里是在**决定
       * 要不要重算**，必须看「当时取到的原料」。
       */
      const degradedSource = cached.source.ok && cached.source.balance.degraded === true
      const ttl = cached.source.ok && !degradedSource
        ? (this.deps.ttlMs ?? BUDDY_BALANCE_CACHE_TTL_MS)
        : (this.deps.errorTtlMs ?? BUDDY_BALANCE_ERROR_CACHE_TTL_MS)
      if (now - cached.at < ttl) {
        return this.classify(account.id, cached.source, now)
      }
    }

    const source = await this.fetchSource(account)
    this.cache.set(account.id, { at: now, source })
    return this.classify(account.id, source, now)
  }

  /**
   * 把原料按**当前时刻**分成两桶并定档。
   *
   * 单独成函数就是为了「原料只查一次、分类随时间重算」这件事结构上无法被绕过。
   */
  private classify(
    id: string,
    source: BalanceSource,
    now: number,
  ): BuddyAccountBalanceEntry {
    if (source.ok !== true) return failedEntry(id, source.error)
    const windowMs = this.windowMs()
    const split = splitBuddyCreditsByExpiry(source.balance, now, windowMs)
    if (split === undefined) return failedEntry(id, '余额响应无法解析出积分池')
    const entry: BuddyAccountBalanceEntry = {
      id,
      ok: true,
      expiringBalance: split.expiring,
      permanentBalance: split.permanent,
      split,
      // ⚠️ 透传「降级」：总额可信、明细不可达 ⇒ 下游不得据此断言 exhausted。
      ...(source.balance.degraded === true ? { degraded: true } : {}),
    }
    entry.tier = buddyBalanceTier(entry, { now, windowMs })
    return entry
  }

  /** 发一次请求取原料（不做任何分类）。 */
  private async fetchSource(account: BuddyCandidateAccount): Promise<BalanceSource> {
    let credential: TCredential | undefined
    try {
      credential = await this.deps.resolveCredential(account.credentialRef)
    } catch (error) {
      return { ok: false, error: `读取凭据失败：${error instanceof Error ? error.message : String(error)}` }
    }
    if (credential === undefined) {
      return { ok: false, error: '凭据未配置或已失效' }
    }

    let balance: CreditBalance | null
    try {
      // ⚠️ 缺省实现只适用于 buddy 系（凭据结构相同）。其它 provider 的
      // `fetchBalance` 由 {@link FetchBalanceRule} 在**编译期**强制必填；
      // 这里再加一道运行时防御 —— 万一有人用 `as` 绕过了类型，
      // 宁可立刻抛一条能指认到原因的错，也不要发出 `undefined/...` 的畸形请求
      // 让它变成一句无法归因的「余额查询失败」。
      //
      // ⚠️ **详细变体优先**（见 {@link BalanceQueryDetail}）：它返回
      // `{ balance, error? }`，能同时给出「有没有余额」和「为什么查不到」。
      // 传了它就不再走 `fetchBalance` —— 两者都传时详细变体是严格超集。
      const detailed = this.deps.fetchBalanceDetailed
      if (detailed !== undefined) {
        /**
         * ⚠️ **同样要传第三参**：详细变体优先于 `fetchBalance`，若此处不给
         * `ctx`，那些「按出口 IP 分流」的渠道会在这条腿上丢掉出口配置
         * （详见 {@link BuddySelectionDeps.fetchBalanceDetailed} 的注释）。
         */
        const result = await detailed(credential, this.deps.product, {
          accountId: account.id,
          ...this.deps.fetchFor === undefined ? {} : { fetchFor: this.deps.fetchFor },
        })
        if (result.balance === null) {
          // ⚠️ `error` 缺失时仍给一句**能指认到「未知」**的话，而不是
          //    回落到那句会把用户引向凭据的概括文案 —— 后者是确定的错误归因。
          return { ok: false, error: result.error ?? '余额查询失败（未提供具体原因）' }
        }
        return { ok: true, balance: result.balance }
      }
      const injected = this.deps.fetchBalance
      if (injected === undefined && typeof (this.deps.product as { endpoint?: unknown }).endpoint !== 'string') {
        throw new Error(
          `${(this.deps.product as { id?: string }).id ?? 'provider'} 未注入 fetchBalance，`
          + '且产品配置没有 endpoint —— 选号器无法查询该 provider 的余额',
        )
      }
      balance = await (injected
        ?? ((cred: TCredential, product: TProduct) =>
          fetchCreditBalance(cred as unknown as BuddyCredential, product as unknown as BuddyProduct, this.deps.fetcher ?? fetch)))(
        /**
         * ⚠️ **第三参带上账号上下文**：出口代理是**账号维度**的，而本方法
         * 手上正有 `account.id` —— 不传下去，按出口 IP 分流的渠道（MiniMax
         * 国际站）会恒查不到余额 ⇒ 在聚合轮换里被**静默剔除**。
         */
        credential,
        this.deps.product,
        { accountId: account.id, ...this.deps.fetchFor === undefined ? {} : { fetchFor: this.deps.fetchFor } },
      )
    } catch (error) {
      return { ok: false, error: `余额查询异常：${error instanceof Error ? error.message : String(error)}` }
    }
    if (balance === null) {
      return { ok: false, error: '余额查询失败（凭据失效或响应异常）' }
    }
    return { ok: true, balance }
  }

  /**
   * 从候选账号中按「快到期优先」选一个。
   *
   * 排序规则见 `rankBuddyAccountsByBalance`：
   * 有快到期积分 → 只剩永久 → 无余额/查不到。**档内保持传入顺序**（= 手动顺序）。
   *
   * ⚠️ **`options.strictManualOrder === true` 时改用
   * `rankBuddyAccountsByManualOrder`**（见 `JetHubState.strictManualOrder`）：
   * 先后完全按用户的拖拽序，档位退化为「可用 / 不可用」判据。此时
   * `expiring` 与 `permanent` 两种账号**同权**，不再「临期优先」—— 但
   * `none`（查不到 / 锁定态下只剩永久）照旧沉底，故「锁定永久积分」语义不变。
   *
   * ⚠️ **锁定永久积分时（`allowPermanent: false`）**：只剩永久积分的账号落入
   * `none` 档（不可用）。若**全部候选都不可用**，返回 `ok: false` 并带上原因 ——
   * 调用方据此报明确错误，而不是硬着头皮消耗永久积分。
   *
   * ⚠️ **解锁时不改变既有行为**：所有候选余额都是 0 仍返回第一个候选，
   * 让上游去报真正的失败原因（凭据、限流、余额），错误信息更准确。
   *
   * @param candidates - 已按 `enabled` 与模型限流过滤过的候选（顺序即手动优先级）。
   * @param options - `allowPermanent` 为 false 时禁止消耗永久积分。
   */
  async select(
    candidates: readonly BuddyCandidateAccount[],
    options: BuddyTierOptions = {},
  ): Promise<BuddySelectionResult> {
    if (candidates.length === 0) {
      // ⚠️ 空候选 = **压根没查过余额**，不能报 `exhausted`（那是在替服务端
      //    断言「积分是 0」）。见 `no-candidates` 的说明。
      return { ok: false, reason: { kind: 'no-candidates' } }
    }

    // 并发查余额：账号数通常个位数，并发比串行快得多。
    const balances = await Promise.all(candidates.map((c) => this.balanceOf(c)))
    const byId = new Map(candidates.map((c, i) => [c.id, { account: c, balance: balances[i]! }]))

    const rankedByStrategy = options.strictManualOrder === true
      // 严格手动顺序：档位只当「可用 / 不可用」判据，先后完全按用户的拖拽序。
      ? rankBuddyAccountsByManualOrder(balances, options)
      : rankBuddyAccountsByBalance(balances, options)
    /**
     * 「轮换起点」：**唯一旋转点**，必须在两种策略各自排完序之后。
     *
     * ⚠️ 不能放进那两个排序函数里 —— 会变成「同一语义两份实现」，
     *    且默认模式与严格模式各一份，必然漂移。
     * ⚠️ 必须在排序**之后** —— 放在前面会被排序覆盖掉。
     * ⚠️ `rotationStartId` 为 `undefined` 时 `rotateFromPreferred` 原样返回
     *    ⇒ 与改动前**逐字节相同**（本功能的唯一回归面）。
     */
    const ranked = rotateFromPreferred(rankedByStrategy, options)
    const first = ranked[0]
    if (first === undefined) {
      return { ok: false, reason: noAccountReason(balances) }
    }

    // ⚠️ 排序只保证「可用的在前」，**不保证第一个可用** —— 未锁定时 none 档
    // 也参与排序（作为兜底），故只在锁定情况下才把「全部不可用」判成无可用账号。
    if (options.allowPermanent === false && !buddyTierUsable(buddyBalanceTier(first, options))) {
      // ⚠️⚠️ **降级只能放行「查不到」的账号，不能放行「明确只剩永久积分」的账号**
      //（2026-11-05 三审回归面 P1-1，`631f1c8` 引入的回归）。
      //
      // `noAccountReason` 是**池级**判据：只要有**任何一个**账号查不到就返回
      // `unknown`（`kind: 'unknown'`）。而降级分支（见 `select` 下方的
      // `degradeOnUnknown`）会把 `allowPermanent` **全局**置真后重排 ——
      // 置真后 `buddyBalanceTier` 对「`expiring = 0` 且 `permanent > 0`」的账号
      // 返回 `permanent`（可用）⇒ 该账号被选中 ⇒ **用户明明关掉了「消耗永久
      // 积分」却被烧永久积分**。
      //
      // 叠加形态实测（真实 `lib/` 链路，`probe-degrade-mixed.mjs`）：
      // ```
      // 候选 = [a1 查不到, a2 只剩永久 800]
      //   degrade=false ⇒ locked（reason: unknown）        ← 正确
      //   degrade=true  ⇒ account a2 (tier=permanent) 🚨   ← 烧永久积分
      // ```
      //
      // ⚠️ `expiring > 0` 的账号在锁定态**本就可承载**（`buddyBalanceTier` 先
      // 判 `expiring`），永远进不了这条降级分支 ⇒ 降级的真实风险是
      // 「**永久**积分」，不是「临期积分」（本文件与 `src/index.ts` 原先三处
      // 注释写反了，已一并订正）。
      //
      // ⇒ 只要存在「余额查得到、且只剩永久积分」的账号，就必须报 `exhausted`
      //   （`exhausted` 不会触发 `pickBuddyAccount` 的降级分支），而不是
      //   `unknown`。用 `buddyBalanceTier` 判而不是硬编码字段名，避免与
      //   `positiveOrZero` 的归一化漂移。
      const definitive = balances.some(
        (entry) => entry.ok
          && entry.degraded !== true
          && buddyBalanceTier(entry, { allowPermanent: true }) === BUDDY_BALANCE_TIER.permanent,
      )
      return { ok: false, reason: definitive ? { kind: 'exhausted' } : noAccountReason(balances) }
    }

    const picked = byId.get(first.id)
    if (picked === undefined) return { ok: false, reason: { kind: 'exhausted' } }
    return { ok: true, account: picked.account, balance: picked.balance }
  }
}

/**
 * 判定「为什么没有可用账号」：区分**真的用尽**与**查不到**。
 *
 * 只要有任何一个候选是查询失败，就不能断言"额度都已用尽"—— 我们对它的余额
 * 其实一无所知。混报会让用户去解锁或白等一天，而号其实有钱。
 */
function noAccountReason(balances: readonly BuddyAccountBalanceEntry[]): BuddyNoAccountReason {
  const errors = balances.filter(b => !b.ok).map(b => b.error ?? '未知原因')
  // ⚠️ `degraded` 标记**先算**：只要池里有一个「降级读数」，本档就**不是**「纯查不到」
  // （2026-11-05 对抗审计 P2-1）⇒ 调用方不得据此放宽永久积分锁定。
  const hasDegraded = balances.some((b) => b.ok && b.degraded === true)
  if (errors.length > 0) return { kind: 'unknown', errors, ...(hasDegraded ? { degraded: true } : {}) }
  /**
   * ⚠️⚠️ **「明细不可达」也不能断言 `exhausted`**（2026-10-21 二轮审计 P1）。
   *
   * `ok: false` 只覆盖「连总额都没拿到」。还有一类更隐蔽的：
   * **总额拿到了、明细丢了**（`balance.degraded === true`）—— 例如 AutoClaw
   * 的流水端点抖动时静默回退钱包包，回退包**没有 `deductionEndTime`**。
   *
   * 而 `splitBuddyCreditsByExpiry` 把「没有到期时刻」判成**永久桶**（对真·永久是对的）
   * ⇒ 一次明细抖动会让「有临期积分的账号」被判成**只剩永久积分** ⇒
   * 锁定时报「积分都已用尽」—— **那句会把用户推向不可撤回的解锁**。
   *
   * 实测（AutoClaw，同一账号同一 5000 余额，只改流水端点是否 500）：
   * ```
   * 流水正常 → split={expiring:5000} tier=expiring（可用）✅
   * 流水 500 → split={permanent:5000} tier=none（「积分都已用尽」）❌
   * ```
   * ⇒ **降级必须与失败同等对待**：都归 `unknown`（「无法确认」），不归 `exhausted`。
   */
  const degraded = balances.filter((b) => b.ok && b.degraded === true)
  if (degraded.length > 0) {
    return {
      kind: 'unknown',
      degraded: true,
      errors: [`${degraded.length} 个账号的**逐包明细**不可用（总额已读到，但没有到期时刻）`],
    }
  }
  return { kind: 'exhausted' }
}

/** 构造一个「查询失败」的余额条目。 */
function failedEntry(id: string, error: string): BuddyAccountBalanceEntry {
  return { id, ok: false, error }
}

/**
 * `select` 的**结构化**形状（`BuddyBalanceSelector` 满足它，无需继承）。
 *
 * ## 为什么不是直接收 `BuddyBalanceSelector`
 *
 * `BuddyBalanceSelector` 带 `private` 成员 ⇒ 它是**名义类型**：任何结构等价的
 * 替身都**不能**赋给它。而 `credential-resolver.ts` 必须能在单测里注入替身
 *（否则选号编排的每一格都得起一台真适配器）。
 *
 * ⚠️ 这是**纯放宽**：`select` 的签名本就不提及 `TProduct` / `TCredential`
 *（它只吃 `BuddyCandidateAccount[]` 与 `BuddyTierOptions`），故真实例天然满足
 * 本接口 —— 既有调用点一个都不用改。
 */
export interface BuddySelectorLike {
  select(
    candidates: readonly BuddyCandidateAccount[],
    options?: BuddyTierOptions,
  ): Promise<BuddySelectionResult>
}

/**
 * 选号 + 取凭据的完整编排（供 `src/index.ts` 的 buddy 系 provider 调用）。
 *
 * ## 为什么需要这一层
 *
 * `select()` 只保证「档位最优」，**不保证那个账号的凭据能解析出来**。凭据损坏 /
 * 未配置时必须换下一个候选，否则一次抖动就会让请求失败。而循环放在池里做不了
 * （池不知道余额），放在适配器里又会让两个 provider 各写一遍 —— 故收敛成本函数。
 *
 * ⚠️ **锁定与未锁定的收尾不同**（这是本函数的全部复杂度来源）：
 * - 锁定：候选耗尽即 `kind: 'locked'`，调用方**必须报错**，绝不能退回
 *   `getAvailableAccount` —— 那会绕过锁定、照样消耗永久积分，使锁定形同虚设。
 * - 未锁定：候选耗尽（通常是凭据都坏了）时返回 `kind: 'exhausted'` 并带上
 *   `tried`，调用方据此把同一批账号传给 `getAvailableAccount` 的排除集合，
 *   从而**继续尝试池里的其余账号**（既有行为）。
 *
 * @param selector - 该 provider 专属的选号器（缓存不能跨站共用）。
 *   ⚠️ 只要求 {@link BuddySelectorLike} 这个**结构**形状，不要求具体类 ——
 *   具体类带 `private` 成员（名义类型），会让 `credential-resolver.ts` 的
 *   测试替身无法传入。真实例天然满足该接口，既有调用点不受影响。
 * @param candidates - 已按 `enabled` + 模型限流过滤的候选。
 * @param options - 锁定标志与凭据解析器。
 */
export async function pickBuddyAccount<TCredential = BuddyCredential>(
  selector: BuddySelectorLike,
  candidates: readonly BuddyCandidateAccount[],
  options: {
    /** 是否允许消耗永久积分（= 未锁定）。 */
    allowPermanent: boolean
    /** 按凭据 ref 取凭据；undefined 表示该账号不可用。 */
    resolveCredential: (credentialRef: string) => Promise<TCredential | undefined>
    /** 分档选项透传（测试注入时间用）。 */
    tierOptions?: BuddyTierOptions
    /**
     * 锁定态下「余额查不到」时是否降级放行（**默认不降级**）。
     *
     * ⚠️ 默认 `false` 是刻意的：既有语义「锁定时任何不可用都必须报错」是用户
     * 明确要的确定性结果，改它需要逐家确认。只有确认「余额接口自己也会被上游
     * 网关整片拒绝」的渠道（超级麦吉两站，2026-11-04 真机 403/405）才开这个开关 ——
     * 否则一次网关抖动会把整条渠道的模型列表清空，用户一个模型都选不了。
     */
    degradeOnUnknown?: boolean
    /**
     * 「严格手动顺序」（见 `JetHubState.strictManualOrder`）。
     *
     * ⚠️ 与 `tierOptions` **刻意分开**：`tierOptions` 的契约是「测试注入时间用的
     * 透传口」，而本项是**用户可见的生产配置**，必须由调用方（`credential-resolver`）
     * 从账号池现读后显式传入。混进 `tierOptions` 会让「生产开关」与「测试注入口」
     * 共用一条通道 —— 将来谁给 `tierOptions` 换形状都会连带改掉选号策略。
     */
    strictManualOrder?: boolean
    /**
     * 「轮换起点」：本会话指定的起始账号 id（`undefined` = 默认起点）。
     *
     * 与 {@link BuddyTierOptions.rotationStartId} 同义 —— 本字段只是把它从
     * resolver 透传到 `selector.select()` 的**通道**，判据仍只有一处
     * （`rotateFromPreferred`）。
     */
    rotationStartId?: string
  },
): Promise<
  | {
    kind: 'account'
    account: BuddyCandidateAccount
    balance: BuddyAccountBalanceEntry
    credential: TCredential
    /** 本次因为**凭据不可解析**而被跳过的账号（选中项不在其中）。 */
    tried: ReadonlySet<string>
  }
  | {
    kind: 'locked' | 'exhausted'
    tried: ReadonlySet<string>
    /**
     * 判「无可用账号」的具体原因。
     * ⚠️ **总是非空**（四种成因各有名字）：调用方必须据它区分
     * 「真的用尽」/「查不到」/「凭据全坏」再报错 —— 混报会把用户引向
     * 「解锁永久积分」这个不可撤回的错动作。
     */
    reason: BuddyNoAccountReason
  }
> {
  const tried = new Set<string>()
  let allowPermanent = options.allowPermanent !== false
  /**
   * ⚠️ **候选为空必须当场定因**（真实报障 2026-10-13，CodeBuddy）：
   * 下面的循环上界是候选数，空候选时**一次都不执行**，`reason` 会保持
   * `undefined`；调用方的 `?? { kind: 'exhausted' }` 于是把「候选被模型限流
   * 筛空」**凭空**断言成「积分都已用尽」，用户据此去解锁永久积分 ——
   * 而解禁时刻其实就写在 `modelRateLimits` 里。
   */
  let reason: BuddyNoAccountReason | undefined
    = candidates.length === 0 ? { kind: 'no-candidates' } : undefined
  // 循环上界取候选数：每次迭代至少排除一个账号，故必然终止。
  for (let remaining = candidates; remaining.length > 0;) {
    const picked = await selector.select(
      remaining,
      {
        ...options.tierOptions,
        allowPermanent,
        // ⚠️ 每次迭代都带上：降级分支会把 `allowPermanent` 翻真，而本项与它无关，
        //    不能因为走了降级就把「严格手动顺序」丢掉（那会让用户开了开关却偶发失效）。
        ...(options.strictManualOrder === true ? { strictManualOrder: true } : {}),
        // 「轮换起点」：同样每次迭代都带上（与 strictManualOrder 同因）——
        // 降级会改变 `allowPermanent`、从而改变「哪些号可用」，起点必须跟着重算。
        ...(options.rotationStartId === undefined ? {} : { rotationStartId: options.rotationStartId }),
      },
    )
    if (!picked.ok) {
      /**
       * ⚠️⚠️ **「余额查不到」≠「没有可用积分」，锁定时必须降级放行**（2026-11-04 真机报障）。
       *
       * 症状（用户原话「模型都选不了了」）：面板上「永久积分」锁定开着，而余额接口
       * 被上游网关拒（真机 HTTP 403/405）⇒ 每个账号都 `ok:false` ⇒ `noAccountReason`
       * 给出 `unknown` ⇒ 调用方 `plan.lockedError(reason)` 抛错 ⇒ **整个 provider
       * 的模型列表被清空**，模型选择器里只剩一大段错误文案，用户一个模型都选不了。
       *
       * 语义上 `unknown` 只说明「**我们不知道**这个号有没有积分」，它既不等于
       * 「积分用尽」（`exhausted`），也不等于「全是永久积分」（`locked` 的本意）。
       * 把它当成硬拒绝，等于让一次网关抖动把整条渠道打掉 —— 代价远大于收益：
       * 降级只是「可能消耗**永久**积分」，而不降级是「完全用不了」。
       *
       * ⚠️⚠️ **风险是「永久」不是「临期」**（2026-11-05 三审回归面 P2-1，本文件与
       * `src/index.ts` 原先三处都写反了）：`expiring > 0` 的账号在 `allowPermanent
       * = false` 时 `buddyBalanceTier` **先判 `expiring`** ⇒ 本来就可用 ⇒ 永远不会
       * 进这条降级分支。能进本分支的只可能是 `expiring = 0` 的账号，即
       * 「只剩永久积分」或「余额完全为 0」—— 正是用户锁定时要防的那件事。
       *
       * ⇒ 锁定态遇到 `unknown` 时**放宽一次**（`allowPermanent = true`）重跑同一个
       * 候选集：只要余额是查得到的，档位判定照旧生效，锁定语义不变；只有在
       * 「查不到」这一格才退化成「允许消耗永久积分」。
       *
       * ⚠️⚠️ **但「明确只剩永久积分」的账号绝不能被这样放行**：`noAccountReason`
       * 是池级判据（任一账号查不到即 `unknown`），若池里同时有「查不到」与
       * 「明确只剩永久」，全局置 `allowPermanent` 会把后者放行 ⇒ 烧永久积分。
       * 故 `select` 在进入本分支前已先判 `definitive`（存在明确只剩永久的账号
       * ⇒ 报 `exhausted`）。
       *
       * ⚠️⚠️ **「降级读数」也不能被这样放行**（2026-11-05 对抗审计 P2-1）：
       * `noAccountReason` 把「纯查不到」与「总额读到、明细丢了（`degraded`）」都归
       * `unknown`，而 `definitive` 守卫刻意 `&& entry.degraded !== true` 把降级账号
       * **排除在** `definitive` **之外** ⇒ 降级读数恰好落进本分支 ⇒ 放宽后按
       * 「永久积分」烧。而明细丢失时「有临期积分」本就可能被误判成「只剩永久积分」
       * ⇒ 这正是 `noAccountReason` 那段注释要防的事。
       * ⇒ 本分支必须再加一条腿：`reason.degraded !== true`。
       *
       * ⚠️ 不会死循环：`allowPermanent` 置真后 `!allowPermanent` 恒假，本分支只进一次。
       * ⚠️ 放开后若仍失败，`kind` 由 `allowPermanent` 决定 ⇒ 变 `exhausted`
       *    （走池兜底），不再是「锁定拒绝」—— 与「真的没有可用账号」如实对应。
       */
      if (!allowPermanent && picked.reason.kind === 'unknown'
        && picked.reason.degraded !== true
        && options.degradeOnUnknown === true) {
        allowPermanent = true
        continue
      }
      reason = picked.reason
      break
    }
    const credential = await options.resolveCredential(picked.account.credentialRef)
    if (credential !== undefined) {
      return { kind: 'account', account: picked.account, balance: picked.balance, credential, tried }
    }
    tried.add(picked.account.id)
    remaining = remaining.filter(c => c.id !== picked.account.id)
  }
  // 锁定时的「无可用账号」是**用户要的确定性结果**，与凭据无关；
  // 未锁定时的失败只可能是凭据问题，交给调用方继续走池的兜底。
  //
  // ⚠️ `reason` 仍缺席 ⇒ **是「凭据全坏」而不是「积分用尽」**（2026-10-14 审计
  //    实测打穿的漏网路径）。走到这里只有两种情形：
  //    ① 候选为空 —— 开头已预置 `no-candidates`，故此时 `reason` 非空；
  //    ② 候选非空、每次 `select()` 都返回 `ok:true`，但那些号的凭据都解析不出来
  //       ⇒ 循环耗尽候选，`reason` 一次都没被赋值。
  //    而 `ok:true` **本身就证明**该号落在「可用档」（锁定时只有 `expiring` 可用）
  //    ⇒ 明知它有钱却报「积分都已用尽」是**自相矛盾**，且会把用户推向
  //    「解锁永久积分」（不可撤回地烧钱）。故必须如实归到 `credential-only`。
  //    ⚠️ 不能省着不填让调用方的 `?? { kind: 'exhausted' }` 兜底 —— 那正是缺陷本体。
  if (reason === undefined) reason = { kind: 'credential-only' }
  return { kind: allowPermanent ? 'exhausted' : 'locked', tried, reason }
}
