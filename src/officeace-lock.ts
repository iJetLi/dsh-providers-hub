/**
 * OfficeAce（华为 MaaS）的**「锁定永久积分」唯一执行实现**。
 *
 * ## 为什么需要这个文件（Gitee issue IKLTHB 的第 ① 条，真实缺陷）
 *
 * `provider-registry.ts` 给 officeace 登记了 `permanentLock: true`，Jet Hub 据此
 * 渲染出「锁定永久积分」开关，并在提示里**逐字承诺**：
 *
 * > 锁定永久积分后只消耗「N 天内到期」的积分包（那部分再不用就作废）。
 * > 这类积分用尽后将没有可用账号。
 *
 * 而在本文件之前，**那句承诺没有任何执行代码**：
 *
 * | 判据 | 改前的现状 |
 * |---|---|
 * | `permanentLocked()` 的调用点 | 全仓**只有两处**，都在 `credential-resolver.ts` 的 buddy / loomy 分支里 |
 * | officeace 取凭据 | `index.ts` 的闭包里直接 `pool.getAvailableAccount(OFFICEACE.id, '')`，**从不读锁定表** |
 * | `officeaceExpiry`（聚合折算） | 无锁定语义：只剩永久桶 ⇒ 折算成 `NEVER`（排最后，但**不剔除**） |
 *
 * ⇒ 锁定开关打开后行为与关闭**完全一致**，写入 `permanent-locks.json` 的那个
 * `officeace: true` 是一把**哑锁**。用户的真实后果：每天都在**烧永久套餐包**，
 * 而面板上那句「今日额度用尽后将没有可用账号」永远不会出现。
 *
 * 用户在 issue 里给的两条修法我们选了**完整实现**（另一条是「摘掉
 * `permanentLock: true`，让按钮消失」）—— 因为该承诺在 officeace 上是**可兑现的**：
 * 服务端会给每个积分桶下发到期时间（`creditGroups[].expiresAt`），
 * 「只剩不会近期作废的桶」是**本地就能判定**的事实。
 *
 * ⚠️ 上表是**改前**的现状快照，别当成现行事实：本文件落地后
 *    `permanentLocked('officeace')` 的调用点变成**三处**（本文件经 `index.ts` 的装配、
 *    以及 `jet-hub-rpc.ts` 里「只读展示开关状态」那一处）。
 *
 * ## ⚠️ 锁能做到什么、做不到什么（别把它宣传成「不扣永久积分」）
 *
 * **扣减顺序是服务端定的，插件无法干预**。锁定**只能**做一件事：
 * **拒绝**那些「已经没有任何会近期作废的额度」的账号（并如实报错）。
 * 因此 `splitOfficeAceCreditsByExpiry` 的判据是「**有没有**近期作废的桶」，
 * 而**不是**「这一轮会不会扣到永久桶」—— 后者本地无从得知。
 * 这个边界在 issue 里已被用户明确确认（他正是这么描述 buddy 的行为的）。
 *
 * ## 判据：与 buddy 系**逐格同构**（本仓库红线：同族判据不得各写一份）
 *
 * | 情形 | 归属 |
 * |---|---|
 * | `expired === true` 的桶 | **跳过**（服务端仍会返回余额，计入会虚增可用额度） |
 * | `remaining <= 0` 的桶 | **跳过** |
 * | `expiresAt` 可解析，且 `expiresAt - now < 窗口` | 「临期」桶（锁定期间**唯一**可消耗的额度） |
 * | 其余（到期时间 ≥ 窗口，或**没给**到期时间） | 「永久」桶 —— ⚠️ **拿不到到期时间时归永久是保守方向**：最坏结果是锁定时少用一个号，而不是把长期积分误当临期烧掉（与 `splitBuddyCreditsByExpiry` 同款取舍） |
 *
 * ⚠️ 窗口复用 `buddyExpiringWindowMs()`（`DSH_BUDDY_EXPIRING_WINDOW_DAYS`，默认 15 天）：
 *    Jet Hub 的 `credits.permanentLock` RPC 对**所有 `usesExpiryWindow: true` 的渠道**
 *    回传的正是 `buddyExpiringWindowDays()` ⇒ 面板文案与实际筛号必须是**同一个数**。
 *
 * ⚠️ **已知取舍：试点包（`.trial` SKU）会被判成「永久」。**
 *    `fetchCloudSubscriptionFor` 有意丢弃 trial SKU 的到期时间
 *    （`expiresAt: isTrial ? undefined : expiredAt`）⇒ 这里按「没给到期时间」
 *    归入永久桶。于是「只有试点包」的账号在锁定期间会被判为不可用（保守方向，
 *    **不会**烧钱）。要支持它应当改在**归一化那一处**（如实透出 trial 的到期时间），
 *    而不是在本文件加一条 provider 特例 —— 否则「到期时间」这件事会出现两套口径。
 *
 * ## ⚠️ 锁定时**绝不回落**（与 buddy/loomy 逐字同规）
 *
 * `pickBuddyAccount` 的注释写得很清楚：锁定时落到池兜底 = 绕过锁定、照样消耗永久
 * 积分 ⇒ 锁定形同虚设。故本文件在「锁定 + 无临期额度」时**只抛错**，
 * 连 `resolveUnlocked()` 那条旧路径都不碰（那条路径里有池兜底）。
 */

import {
  buddyExpiringWindowMs,
  resolveImminentWindowMs,
} from './buddy-balance-rank.js'
import type { OfficeAceCredential, OfficeAceSubscriptionSummary } from './officeace-auth.js'

/**
 * ★★★ **子代理起点分配**（2026-11-25）。
 *
 * 本家是**自建选号**的 provider（不走 `createCredentialResolver`）⇒ 用户在面板
 * 里给子代理配的起点策略原先对它**静默无效、零报错**（与 `codearts` 同形态）。
 *
 * ⚠️ 判据**全部**在共享纯函数模块里（与 resolver 同一份实现），
 * 本文件**一行判据都不写** —— 手抄一份会让同一语义两套实现必然漂移。
 */
import { OFFICEACE } from './officeace-product.js'
import { decideSubagentStart } from './subagent-start.js'
import type { SubagentStartPoolLike } from './subagent-start.js'


/** 池内一个候选账号的最小形状（结构类型，便于单测注入替身）。 */
export interface OfficeAceAccountRef {
  readonly id: string
  readonly credentialRef: string
}

/**
 * 一次订阅读取的结果。
 *
 * ⚠️ **刻意不返回 `undefined`**：`undefined` 会被读成「没有余额」，
 *    而本判定必须把「**读不到**」与「**读到且没有临期额度**」分开报
 *    （把一次网络抖动报成「额度用尽」会让用户去解锁并不可撤回地烧钱 ——
 *    `buddyLockedError` 的 doc 里有这条真实报障）。
 */
export type OfficeAceSummaryRead =
  | { readonly ok: true; readonly summary: OfficeAceSubscriptionSummary }
  | { readonly ok: false; readonly error: string }

/**
 * 「锁定永久积分」时判定「为什么没有可用账号」。
 *
 * 只有两档，且**只有 `exhausted` 有事实依据**可以说「只剩不会近期作废的额度」。
 */
export type OfficeAceNoAccountReason =
  /** 所有候选账号都**读到过**余额，且一个临期桶都没有。 */
  | { readonly kind: 'exhausted' }
  /** 至少一个候选账号的余额/凭据**读不到** ⇒ 不能断言「用尽」。 */
  | { readonly kind: 'unknown'; readonly errors: readonly string[] }

/** 锁定判定的依赖（全部注入，便于单测；生产装配见 `index.ts`）。 */
export interface OfficeAceLockDeps {
  /** 该 provider 是否处于「锁定永久积分」状态。 */
  readonly permanentLocked: () => boolean
  /** 池内该 provider 的**全部启用账号**（顺序 = 用户拖拽的手动优先级）。 */
  readonly accounts: () => readonly OfficeAceAccountRef[]
  /**
   * **未锁定**时逐字走旧路径（`index.ts` 里那个闭包）。
   *
   * ⚠️ 刻意把整条旧路径注入进来，而不是在锁定判定里「顺手复刻一份」：
   *    旧路径里有 `getAvailableAccount`（会**跳过凭据损坏的账号**）与
   *    「池为空则读兼容文件」两个语义，复刻必然漂移。锁定是新增行为，
   *    解锁态必须**一个字节都不变**。
   */
  readonly resolveUnlocked: () => Promise<OfficeAceCredential | undefined>
  /** 按 ref 读凭据（生产 = `officeaceAuth.readCredential(ref, ctx.credentials)`）。 */
  readonly readCredential: (ref: string) => Promise<OfficeAceCredential | undefined>
  /** 兼容路径：池里没有任何账号时读本机那份单凭据。 */
  readonly readStoredCredential: () => OfficeAceCredential | undefined
  /**
   * 读某个账号的订阅分桶。
   *
   * ⚠️ **必须把 `ref` 传下去**（`ref === undefined` 只在兼容路径下出现）：
   *    云侧直读要靠它定位账号，否则回落果办客户端的**全局单 cookie**
   *    ⇒ 多账号下每个号都判成同一份余额（实测两个账号都显示 6500）。
   */
  readonly summaryOf: (credential: OfficeAceCredential, ref: string | undefined) => Promise<OfficeAceSummaryRead>
  /** 当前时刻（毫秒），单测注入用。 */
  readonly now?: () => number
  /** 临期窗口（毫秒），默认 `buddyExpiringWindowMs()`。 */
  readonly windowMs?: () => number
  /**
   * 「临期」子窗口（毫秒）。省略时经 `resolveImminentWindowMs` 从环境变量解析，
   * 并**钳制到 `windowMs` 以内**（两个窗口是嵌套关系，见 `buddy-balance-rank.ts`）。
   */
  readonly imminentWindowMs?: () => number
  /**
   * ★★★ **子代理起点分配的池读能力**（2026-11-25，可选）。
   *
   * 本家**自建选号** ⇒ 用户给子代理配的起点策略原先对它**完全无效且零报错**。
   *
   * ⚠️ **必须可选**：单测替身与嵌入方不实现它 ⇒ 缺失时走既有路径
   *（`decideSubagentStart` 内部全是可选链 ⇒ 恒判「没配」⇒ 选号逐字节不变）。
   */
  readonly subagentPool?: SubagentStartPoolLike
}

/**
 * 三个桶的合计。
 *
 * ⚠️ `imminent` 是 `expiring` 的**子量**（`0 <= imminent <= expiring`），
 * 与 `src/buddy-balance-rank.ts` 的 `BuddyCreditSplit` **逐格同构**。
 * 保留 `expiring` 的 15 天语义是刻意的：它是「锁定永久积分」的可用性判据
 *（`split.expiring > 0` ⇒ 该号可烧），改含义会让锁定态误判。
 */
export interface OfficeAceCreditSplit {
  /** 窗口内到期的积分合计（锁定期间唯一可消耗的额度）。 */
  readonly expiring: number
  /** {@link expiring} 的子量：其中临期子窗口内到期的部分。只在 `> 0` 时出现。 */
  readonly imminent?: number
  /** 其余积分合计（≥ 窗口，或到期时间未知）。 */
  readonly permanent: number
}

/**
 * 把一个订阅读取结果拆成「临期」与「永久」两桶。
 *
 * ⚠️ 判据与 `splitBuddyCreditsByExpiry` **逐格同构**（含边界方向
 * `end - now < windowMs`、含「到期时间未知 ⇒ 永久」）。两处的差异只有**数据形状**
 * （buddy 读 `packages[].deductionEndTime` 数值，officeace 读 `creditGroups[].expiresAt`
 * ISO 字符串）：前者是 `active` 布尔，后者是 `expired` 布尔（语义相反，故这里取反）。
 *
 * @param summary - 订阅读取结果。
 * @param now - 当前时刻（毫秒）。
 * @param windowMs - 本次生效的窗口（毫秒）。⚠️ **必填**：生产上恒由调用方显式传入
 *   （装配处传 `windowMs()`，也就是与面板、取号**同一个**窗口）。原来这里有
 *   `= buddyExpiringWindowMs()` 默认值，第二轮对抗性审计实测**把它改成常数 15 天
 *   仍然全绿** ⇒ 它是死代码，却又是「一条判据两份取值」的潜入口（谁少传一次，
 *   筛号窗口就与文案窗口分叉，且**不会有任何红**）。删掉默认值让「忘了传」变成
 *   编译错误。
 */
export function splitOfficeAceCreditsByExpiry(
  summary: OfficeAceSubscriptionSummary,
  now: number,
  windowMs: number,
  /**
   * 「临期」子窗口（毫秒）。
   *
   * ⚠️ **必填，与 `windowMs` 同款**（该处 :151-170 的注释解释过为什么去掉默认值）。
   *
   * 关键区别在于「忘了传会怎样」：
   * - `windowMs` 取错 ⇒ 直接误烧/漏烧长期积分（不可撤回）；
   * - `imminentMs` 取错 ⇒ 临期与短期的**归属**偏了，但「能不能烧」不变
   *   （那个判据是 `expiring > 0`）。
   *
   * 即便如此仍然必填：给默认值后任何 3 参调用会传 `undefined`
   * ⇒ `left < undefined` **恒为 false** ⇒ 临期档**静默消失**、日志零字。
   * 本 PR 实测发现 6 处既有测试全是 3 参调用（当时靠 `undefined` 侥幸通过），
   * 正是这个形态 —— 改成必填能让「忘了传」变成编译错误或立即显形。
   */
  imminentMs: number,
): OfficeAceCreditSplit {
  let expiring = 0
  /**
   * `expiring` 的子量。⚠️ 与 `expiring` **在同一分支里成对累加** ——
   * 这是 `imminent <= expiring` 的唯一保证方式（与 buddy 那份同款写法）。
   */
  let imminent = 0
  let permanent = 0
  for (const group of summary.creditGroups) {
    // ⚠️ `expired` 与 buddy 的 `active` 语义**相反**：这里是「已失效请跳过」。
    if (group.expired === true) continue
    const remaining = Number(group.remaining)
    if (!Number.isFinite(remaining) || remaining <= 0) continue
    // ⚠️ `expiresAt` 是 ISO 8601 字符串（与 STS 的 `expiration` 同形），
    //    不是数值时间戳 —— 别顺手加 `> 1e12` 归一化（那是兄弟渠道的坑）。
    const end = typeof group.expiresAt === 'string' ? Date.parse(group.expiresAt) : Number.NaN
    const known = Number.isFinite(end) && end > 0
    if (!known) { permanent += remaining; continue }
    /**
     * ⚠️⚠️ **边界方向与 buddy 严格一致**：`<` 才是窗口内。
     * ⇒ 正好 `imminentMs` 的那笔算「短期」，不算临期。
     *
     * ⚠️ **本函数刻意不按 `end <= now` 单独拆 `expired` 桶**（与 buddy 的一处
     * 已知差异，已登记为独立 issue）：已过期的桶仍会被 `end - now < windowMs`
     * 判成 `expiring`。本 PR **不修**，因为那是与本功能无关的行为变更；
     * 混进来会让评审焦点模糊。此处只保证 `imminent` 的判据与 buddy 同构。
     */
    const left = end - now
    if (left < imminentMs) { imminent += remaining; expiring += remaining; continue }
    if (left < windowMs) { expiring += remaining; continue }
    permanent += remaining
  }
  return { expiring, permanent, ...imminent > 0 ? { imminent } : {} }
}

/**
 * 「读不到」结论的缓存时长：**5 秒**。
 *
 * 抖动是秒级的，而「读不到」的代价只是多打一次网络请求（且**不会**烧钱）。
 */
export const OFFICEACE_LOCK_UNKNOWN_TTL_MS = 5_000

/**
 * 「只剩永久桶」结论的缓存时长：**60 秒**。
 *
 * ⚠️ **刻意不给「有临期额度」这个结论做任何缓存**（这是与 buddy 余额选择器的
 * 唯一一处**有意差异**，别照着 buddy 抄）：
 *
 * | 结论 | 是否缓存 | 理由 |
 * |---|---|---|
 * | 有临期额度 | **不缓存** | 这个结论接下来要**花掉**那笔额度：一次 GET 换「不会误烧永久积分」，而缓存 60 秒意味着最多 60 秒内都可能烧到永久桶 |
 * | 只剩永久桶 | 缓存 60 秒 | 这个结论只会导致**拒绝**（不花钱）；缓存它 = 拒绝路径不打网络 |
 * | 读不到 | 缓存 5 秒 | 同上，抖动期不刷屏 |
 *
 * 三个数字都只决定「**多久重问一次服务端**」：缓存的是**结论**（`permanent` /
 * `unknown`），分桶口径本身每次现算（同一份 `splitOfficeAceCreditsByExpiry`）。
 */
export const OFFICEACE_LOCK_PERMANENT_TTL_MS = 60_000

interface LockCacheEntry {
  readonly at: number
  readonly verdict: OfficeAceNoAccountReason | { readonly kind: 'permanent' }
}

/**
 * 造一个与适配器契约一致的 `credentialProvider`（锁定态走本文件的新路径）。
 *
 * @returns 无参函数：`() => Promise<OfficeAceCredential | undefined>`；
 *          **锁定且无临期额度时抛错**（`officeaceLockedError`），绝不回落池。
 */
export function createOfficeAceCredentialProvider(
  deps: OfficeAceLockDeps,
): () => Promise<OfficeAceCredential | undefined> {
  const now = (): number => deps.now?.() ?? Date.now()
  const windowMs = (): number => deps.windowMs?.() ?? buddyExpiringWindowMs()
  /**
   * 临期子窗口：先取注入值/环境变量，再**钳制到 `windowMs` 以内**。
   * ⚠️ 必须用当次生效的 `windowMs()`（而不是默认 15 天）—— 用户可能两个都改了。
   */
  const imminentMs = (): number => resolveImminentWindowMs(windowMs(), deps.imminentWindowMs?.())
  /** 只存**不花额度**的结论（见 `OFFICEACE_LOCK_PERMANENT_TTL_MS` 的表）。 */
  const cache = new Map<string, LockCacheEntry>()

  /** 判定一个账号：`credential` ⇒ 返回它；否则给出结论。 */
  const classify = async (
    ref: string | undefined,
    credential: OfficeAceCredential,
  ): Promise<
    | { readonly kind: 'credential'; readonly credential: OfficeAceCredential }
    | OfficeAceNoAccountReason
    | { readonly kind: 'permanent' }
  > => {
    const key = ref ?? '__stored__'
    const at = now()
    const cached = cache.get(key)
    if (cached !== undefined) {
      const ttl = cached.verdict.kind === 'unknown'
        ? OFFICEACE_LOCK_UNKNOWN_TTL_MS
        : OFFICEACE_LOCK_PERMANENT_TTL_MS
      if (at - cached.at < ttl) return cached.verdict
      cache.delete(key)
    }
    let verdict: OfficeAceNoAccountReason | { readonly kind: 'permanent' }
    let read: OfficeAceSummaryRead
    try {
      read = await deps.summaryOf(credential, ref)
    } catch (error) {
      // ⚠️ 注入实现按契约不抛错；但契约靠不住时**也必须**落到 unknown，
      //    不能把异常冒上去（那会把一次余额抖动变成整个渠道的硬故障）。
      read = { ok: false, error: String(error) }
    }
    if (!read.ok) {
      verdict = { kind: 'unknown', errors: [read.error] }
    } else {
      const split = splitOfficeAceCreditsByExpiry(read.summary, at, windowMs(), imminentMs())
      if (split.expiring > 0) {
        // ★ 有临期额度 ⇒ **不缓存**（见 TTL 注释）：这个结论要立刻花掉那笔额度。
        cache.delete(key)
        return { kind: 'credential', credential }
      }
      verdict = { kind: 'permanent' }
    }
    cache.set(key, { at, verdict })
    return verdict
  }

  /**
   * @param sessionId 当前请求的会话 id（**可选**；2026-11-25 起由适配器透传）。
   *
   * ⚠️ 只用于**子代理起点分配**，不参与凭据解析本身。
   * ⚠️ `undefined`（网关流量 / 单测 / 旧嵌入方）⇒ 选号与改动前**逐字节相同**。
   */
  const resolveCredential = async (
    sessionId?: string,
  ): Promise<OfficeAceCredential | undefined> => {
    // ① 未锁定 ⇒ 走旧路径（零行为变化）。
    if (!deps.permanentLocked()) return deps.resolveUnlocked()

    // ② 锁定 ⇒ 逐个候选账号判定「还有没有会近期作废的额度」。
    //    ⚠️ 子代理场景只改**遍历顺序**（起点排第一），见 orderAccountsForSubagent。
    const accounts = orderAccountsForSubagent(deps.accounts(), sessionId)
    const errors: string[] = []
    for (const account of accounts) {
      const credential = await deps.readCredential(account.credentialRef)
      if (credential === undefined) {
        // ⚠️ 凭据读不出来**不是**「额度用尽」：归入 unknown（文案会说明）。
        errors.push(`${account.id}: 凭据读不出来`)
        continue
      }
      const verdict = await classify(account.credentialRef, credential)
      if (verdict.kind === 'credential') return verdict.credential
      if (verdict.kind === 'unknown') errors.push(`${account.id}: ${verdict.errors.join('；')}`)
    }

    // ③ 池里没有任何账号（尚未按账号池登录的老数据）⇒ 用兼容单凭据判一次。
    //    ⚠️ 这里**没有**池兜底可言，故不需要 `sawCredential` 之类的额外门禁。
    if (accounts.length === 0) {
      const credential = deps.readStoredCredential()
      if (credential === undefined) return undefined
      const verdict = await classify(undefined, credential)
      if (verdict.kind === 'credential') return verdict.credential
      if (verdict.kind === 'unknown') errors.push(`本机凭据: ${verdict.errors.join('；')}`)
    }

    // ④ 锁定 + 无临期额度 ⇒ **只报错，绝不回落池**（见模块头）。
    throw officeaceLockedError(
      errors.length > 0 ? { kind: 'unknown', errors } : { kind: 'exhausted' },
      // ⚠️ 与上面筛号用的是**同一个**取值（本仓库红线：同一条判据不得有第二份取值）。
      windowMs(),
    )
  }

  /**
   * ★★★ **子代理起点分配：只决定「遍历顺序」**（2026-11-25）。
   *
   * ## 为什么不是「只选一个」
   *
   * codearts 那类 provider 有「一次选一个号」的环节，故起点是**选中项**；
   * 而本家在锁定态是**逐个试**（下面的 for 里撞到「有临期额度」的就返回）
   * ⇒ 起点在这里的正确语义是**把那个号排到最前面**，其余顺序不变。
   *
   * | `decidedBy` | 语义 |
   * |---|---|
   * | `user-pick` / `pin` / `strategy` / `fixed-position` | 起点排第一（其余按原序跟在后面）|
   *
   * ⚠️ 未配置 / `follow` / 无 sessionId ⇒ `startId === undefined`
   *    ⇒ **原样返回**（不复制、不排序）⇒ 零行为变化。
   */
  const orderAccountsForSubagent = (
    accounts: readonly OfficeAceAccountRef[],
    sessionId: string | undefined,
  ): readonly OfficeAceAccountRef[] => {
    const pool = deps.subagentPool
    if (pool === undefined) return accounts
    if (accounts.length <= 1) return accounts
    try {
      const decision = decideSubagentStart({
        providerId: OFFICEACE.id,
        sessionId,
        candidateIds: accounts.map((a) => a.id),
        /**
         * ⚠️ 本家无「积分为 0 就不可用」这道门（额度判据在 `classify` 里），
         *    故恒 `true` —— 「允许烧永久积分」对它是无意义的概念。
         */
        allowPermanent: true,
        pool,
      })
      if (decision.startId === undefined) return accounts
      const head = accounts.find((a) => a.id === decision.startId)
      /**
       * ⚠️ 起点可能**不在候选里**（策略现算用全量启用账号取位次）⇒
       *    那样就原样返回，**不要**硬插一个不存在的账号。
       */
      if (head === undefined) return accounts
      return [head, ...accounts.filter((a) => a.id !== head.id)]
    } catch {
      /** ⚠️ 任何异常都不能影响选号（这是每发请求都要跑的路径）。 */
      return accounts
    }
  }

  /**
   * ⚠️ **直接返回、不包一层 setter**：适配器契约已改为
   * `credentialProvider?: (sessionId?: string) => Promise<...>`
   *（见 `officeace-adapter.ts` 的同名选项）⇒ 会话 id 按请求透传，
   * 无需可变状态（可变状态会让并发请求互相覆盖）。
   */
  return resolveCredential
}

/**
 * 「锁定永久积分 + 无可用账号」的报错文案。
 *
 * ## ⚠️ 三条硬要求
 *
 * 1. **必须与「额度用尽」分开报「读不到」**：把一次网络抖动说成「用尽」会让用户
 *    去解锁，而解锁会**不可撤回地**烧掉永久积分（`buddyLockedError` 的同款真实报障）。
 * 2. **不得建议「重新登录」**：officeace 那条 401 的取证已证明重新登录**改变不了**
 *    `modelAppKey`/`modelAppSecret`（issue IKLTHB 第 ② 条）—— 把它写进这里就是
 *    换一个地方重复那条被证伪的指引。
 * 3. **错误码必须避开 `AUTH`/`QUOTA`/`ACCOUNT_QUOTA`**：DSH 客户端会把这三个码的
 *    报文**整段替换**成通用文案，于是上面这些指路的话一个字都到不了用户眼前
 *    （本仓库红线，见 `dead-model-store` 的 `IGNORED_CODES`）。本函数返回的是**裸
 *    `Error`**（不带 `code`）—— 与 officeace 适配器既有的错误同款，故不会被替换。
 *
 * ## ⚠️ 窗口天数**必须由调用方传进来**（不许在本函数里另算一份）
 *
 * 本仓库红线「一文件两套同义判据」：筛号用的是 `deps.windowMs()`，若文案自己再调
 * `buddyExpiringWindowMs()`，注入场景下就会出现「按 1 天窗口拒绝、报文却说 15 天」
 * —— 用户照着报文去核对会得到相反的结论。故 `windowMs` 是**入参**，
 * `createOfficeAceCredentialProvider` 把**同一个**取值传进来（第一轮审计「轻微 1」）。
 *
 * @param reason - `createOfficeAceCredentialProvider` 的判定结果。
 * @param windowMs - 本次筛号实际生效的窗口（毫秒）。⚠️ **必填**（第二轮对抗性审计
 *   实测：这里的默认值改成常数 15 天后 22 条单测**全绿** ⇒ 生产装配恒显式传参，
 *   默认值纯属死代码，却为「一条判据两份取值」留了后门）。**非法值**（NaN/≤0）
 *   仍回落到 `buddyExpiringWindowMs()`：那是防御，不是「忘了传」的兜底 —— 由 ⑩ 钉住。
 */
export function officeaceLockedError(
  reason: OfficeAceNoAccountReason,
  windowMs: number,
): Error {
  const effective = Number.isFinite(windowMs) && windowMs > 0 ? windowMs : buddyExpiringWindowMs()
  const days = Math.round(effective / (24 * 60 * 60 * 1000))
  if (reason.kind === 'unknown') {
    return new Error(
      'OfficeAce：无法确认是否有可用账号。已锁定永久积分，而部分账号的余额或凭据读不到'
      + `（${reason.errors.slice(0, 2).join('；')}）。这些账号**可能仍有**「${days} 天内到期」`
      + '的积分 —— 请重试；若反复如此，请在 Jet Hub 的 OfficeAce 面板点「刷新积分」'
      + '确认云侧余额能否读到（本机登录态只影响余额读取，不影响推理用的 Basic 凭据）。',
    )
  }
  return new Error(
    'OfficeAce：没有可用账号。已锁定永久积分，而所有账号的积分桶都**不会在'
    + `${days} 天内到期**（只剩套餐包/长期活动包一类不会很快作废的额度，`
    + '或积分桶已空）。'
    + '⚠️ 扣减顺序由服务端决定，插件无法干预 —— 锁定只能**拒绝**这类账号，'
    + '故这是该开关的预期效果，不是故障。请在 Jet Hub 的 OfficeAce 面板解锁永久积分，'
    + '或等有临期额度的积分包发放（每日签到赠送的额度当日作废）。',
  )
}
