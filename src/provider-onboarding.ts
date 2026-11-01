/**
 * 各 provider 的**一次性奖励能力实现表** —— `ProviderRuntime.onboarding` 域的唯一真源。
 *
 * ## 它解决什么
 *
 * 重构前，`onboarding.status` / `onboarding.claim` 各自是一段
 * `if (req.provider === LOOMY.id) … else if (req.provider === RACCOON.id) …`，
 * 两处**各写一遍**同样的 provider 分派、同样的「凭据未配置 / 账号不存在」守卫。
 * 那些分支体里**没有一行协议逻辑**（协议早已封装在 `loomy-onboarding.ts` 与
 * `raccoon-credits.ts` 内），RPC 层看到的只是「选哪个函数」。
 *
 * ## ⚠️ 与 `credits` 域的边界（**别把两者合并**）
 *
 * | 域 | 语义 | 频率 |
 * |---|---|---|
 * | `credits` | **每日**签到（每天都有收益） | 每天 |
 * | `onboarding` | **一次性**新手任务 / 登录奖励（每号只能领一次） | 一次 |
 *
 * 两者混在一个域里会诱导实现方拿「今天领过没」的判据去判「领过没」——
 * 那正是本仓库记录过的「一份语义两套判据」形态。
 *
 * ## ⚠️ 为什么返回类型直接用 RPC 响应的形状
 *
 * `RpcOnboardingStatusResponse` / `RpcOnboardingClaimResponse` 与 provider 数量
 * 无关（`tasks` / `earned` / `total` / `titles` / `points` 是**所有**一次性奖励的
 * 公共字段），且 `raccoon` 的「已领时 `earned` 报满分」这条语义**只有在这个形状上**
 * 才表达得出来 —— 压成 `ClaimOutcome` 会丢掉它（见 `ProviderOnboarding.claim`）。
 * 与 `ProviderBalanceDetail` 复用 `CreditsEndpointDeps` 的形状同款理由。
 *
 * ## Magicrew（2026-11-01 接入，用户要求）
 *
 * `magicrew`（国内）与 `magicrewintl`（国际）两站**共用**同一份协议实现
 * （`src/magicrew-checkin.ts`），只有 `product` 常量不同。
 *
 * ⚠️⚠️ **国际站 `GET /onboarding/tasks` 恒返回 `{participant_type:null, tasks:[]}`**
 * —— 那是「该账号没被登记进引导计划」，**不是**「已经领完了」。所以国际版
 * `status` 会如实回 `total: 0`，UI 显示「无新人任务」而不是「已全部完成」。
 * 代码照样登记（能领就领），只是**预期拿不到**。
 */

import { LOOMY_TASK_POINTS, LOOMY_TASK_TITLES, claimAllLoomyOnboardingTasks, fetchLoomyOnboardingTasks } from './loomy-onboarding.js'
import { LOOMY } from './loomy-product.js'
import { RACCOON } from './raccoon-product.js'
import { claimRaccoonLoginReward, fetchRaccoonOnboardingStatus } from './raccoon-credits.js'
import { claimMagicrewOnboardingTasks, fetchMagicrewOnboardingStatus } from './magicrew-checkin.js'
import { MAGICREW, MAGICREW_INTL, type MagicrewProduct } from './magicrew-product.js'
import type { ClaimOutcome } from './credits.js'
import type { LoomyCredential } from './loomy.js'
import type { RaccoonCredential } from './raccoon.js'
import type { ProviderOnboarding } from './provider-runtime.js'

/** Loomy 一次性任务的只读状态（`fetchLoomyOnboardingTasks` 的返回形状）。 */
export interface LoomyOnboardingSnapshot {
  tasks: Record<string, boolean>
  earned: number
  total: number
}

/** Loomy 一次性任务的领取结果（`claimAllLoomyOnboardingTasks` 的返回形状）。 */
export interface LoomyOnboardingClaim {
  claimed: { key: string; points: number }[]
  skipped: string[]
  earned: number
  total: number
}

/**
 * 两家「一次性奖励挂在 auth 实例上」的渠道所需的最小接口。
 *
 * ⚠️ **结构化类型而不是 `LoomyAuth` / `RaccoonAuth`**：本模块只需这几个方法，
 * 导入两个 auth 类会把 `@deepseek-ai/cordis` 与一整套登录流程拖进依赖图 ——
 * 而它只被 `index.ts`（已经持有实例）与单测使用。结构化类型同时让单测可以传
 * **只带一个方法的替身**。
 *
 * ⚠️ 这与 `ProviderCreditsDeps` 同款做法（见 `provider-credits.ts`），
 * 且**理由相同**：实例可能带注入的 `fetchImpl`（测试替身 / 代理），
 * 故优先走实例方法；实例缺席时回退自由函数 + 全局 `fetch`
 *（与 `index.ts` 的实际构造逐字等价 —— 它**总是**传实例）。
 */
export interface ProviderOnboardingDeps {
  /** Loomy auth 实例（省略时回退到自由函数 + 全局 fetch）。 */
  readonly loomy?: {
    fetchOnboardingTasks(credential: LoomyCredential): Promise<LoomyOnboardingSnapshot>
    claimOnboardingTasks(credential: LoomyCredential): Promise<LoomyOnboardingClaim>
  }
  /** Raccoon auth 实例（省略时回退到自由函数 + 全局 fetch）。 */
  readonly raccoon?: {
    fetchOnboardingStatus(credential: RaccoonCredential): Promise<{ claimed: boolean; points: number }>
    claimLoginReward(credential: RaccoonCredential): Promise<ClaimOutcome>
  }
}

/**
 * 构造「id → 一次性奖励能力」的表。
 *
 * ⚠️ 只覆盖**真有**一次性奖励的渠道（与 `PROVIDER_REGISTRY` 的
 * `credits.onboardingTasks` 声明一致）：目前是 `loomy` 与 `raccoon`。
 */
export function createProviderOnboarding(
  deps: ProviderOnboardingDeps = {},
): Readonly<Record<string, ProviderOnboarding>> {
  return {
    /**
     * Loomy 新手任务（8 项，合计 10000 分，**一次性**）。
     *
     * ⚠️ 优先走**实例方法**（实例可能带注入的 `fetchImpl`）。
     * ⚠️ 判**方法存在**而不是 `deps.loomy !== undefined`：调用方常常只持有
     *    一个部分替身（单测的 `{}` 桩），用 `!== undefined` 会走进
     *    `undefined is not a function` 并被吞成一条笼统错误 —— 那正是
     *    「静默降级」的形态。判方法则如实回退到自由函数。
     */
    loomy: {
      status: async (credential) => {
        const loomyCredential = credential as LoomyCredential
        const viaInstance = deps.loomy?.fetchOnboardingTasks
        const state = typeof viaInstance === 'function'
          ? await viaInstance.call(deps.loomy, loomyCredential)
          : await fetchLoomyOnboardingTasks(loomyCredential, LOOMY)
        return {
          tasks: state.tasks,
          earned: state.earned,
          total: state.total,
          // ⚠️ 标题与分值表来自**共享常量**（`loomy-onboarding.ts`），
          //    不在这里另抄一份：抄一份就会与 claim 侧漂移。
          titles: { ...LOOMY_TASK_TITLES },
          points: { ...LOOMY_TASK_POINTS },
        }
      },
      claim: async (credential) => {
        const loomyCredential = credential as LoomyCredential
        const viaInstance = deps.loomy?.claimOnboardingTasks
        const result = typeof viaInstance === 'function'
          ? await viaInstance.call(deps.loomy, loomyCredential)
          : await claimAllLoomyOnboardingTasks(loomyCredential, LOOMY)
        return {
          claimed: result.claimed.map((item) => ({
            key: item.key,
            // ⚠️ 标题缺失时回落 key（**不是**空串）：前端按 key 渲染清单，
            //    空标题会渲染出一个看不见的条目。
            title: LOOMY_TASK_TITLES[item.key] ?? item.key,
            points: item.points,
          })),
          skipped: result.skipped,
          earned: result.earned,
          total: result.total,
        }
      },
    },

    /**
     * Raccoon 桌面端登录奖励（3000 分，**幂等一次性**）。
     *
     * ⚠️ raccoon 只有**一项**一次性奖励，把它映射成 Loomy 那套「任务」形状的一项，
     * 复用同一个 RPC 与 UI（`desktop_login_reward` 是**契约键**，前端按它取值）。
     *
     * ⚠️ 已领状态靠**账单反查**（服务端没有单独的状态端点）。
     */
    raccoon: {
      status: async (credential) => {
        const raccoonCredential = credential as RaccoonCredential
        const viaInstance = deps.raccoon?.fetchOnboardingStatus
        const status = typeof viaInstance === 'function'
          ? await viaInstance.call(deps.raccoon, raccoonCredential)
          : await fetchRaccoonOnboardingStatus(RACCOON, raccoonCredential)
        return {
          // ⚠️ `tasks` 是 `Record<key, boolean>`（完成状态），不是数组。
          tasks: { desktop_login_reward: status.claimed },
          earned: status.claimed ? status.points : 0,
          total: status.points,
          titles: { desktop_login_reward: '桌面端登录奖励（每号一次）' },
          points: { desktop_login_reward: status.points },
        }
      },
      /**
       * ## ⚠️ **已领时 `earned` 必须报满分，不是 0**（真实缺陷，用户报障）
       *
       * `earned` 回答的是「该项目**累计**领到多少」，与「本次请求是否新增」无关。
       * 早期在 `already-claimed` 分支写 `earned: 0`，于是 UI 显示
       * 「✅ 1 个此前已完成 / 累计已领 **0** / 3000」—— **自相矛盾**：
       * 既然「此前已完成」，那 3000 分显然已经拿到手了。
       *
       * ⚠️ 且已领时的金额必须从**账单反查**取得（领取响应体里没有它），
       * 与 `status` 同一数据源 —— 否则两处会显示不同的数字
       *（例如活动金额变化后，一处 3000、一处 3500）。
       * 只读 GET，且仅在「点按钮时已领」这一低频路径上发生。
       */
      claim: async (credential) => {
        const raccoonCredential = credential as RaccoonCredential
        // raccoon 的领取端点是**幂等**的：已领过返回 `granted:false`，
        // 此时 claimed 为空数组、skipped 含该项。
        const viaClaim = deps.raccoon?.claimLoginReward
        const outcome = typeof viaClaim === 'function'
          ? await viaClaim.call(deps.raccoon, raccoonCredential)
          : await claimRaccoonLoginReward(RACCOON, raccoonCredential)
        if (outcome.kind === 'failed') {
          // ⚠️ 失败必须上抛给端点转成 `ok:false`，**不能**在这里包成一条
          //    「成功但没领到」的响应（那会让用户以为领过了）。
          throw new Error(outcome.message)
        }
        const claimed = outcome.kind === 'claimed'
          ? [{ key: 'desktop_login_reward', title: '桌面端登录奖励', points: outcome.credit }]
          : []
        const points = outcome.kind === 'claimed'
          ? outcome.credit
          : (typeof deps.raccoon?.fetchOnboardingStatus === 'function'
              ? await deps.raccoon.fetchOnboardingStatus.call(deps.raccoon, raccoonCredential)
              : await fetchRaccoonOnboardingStatus(RACCOON, raccoonCredential)).points
        return {
          claimed,
          skipped: outcome.kind === 'already-claimed' ? ['desktop_login_reward'] : [],
          // 该项目累计已领 = 满分（无论本次是否新增）。
          earned: points,
          total: points,
        }
      },
    },

    /**
     * 超级麦吉（Magicrew 国内站）新人奖励 —— 8 项新手引导任务，
     * 每个账号**一辈子一次**。
     *
     * ⚠️ `first_ai_work` 服务端固定回 `9303`「不支持手动完成」⇒ 原语**不发请求**
     * 并把它归 `manualRequired`（**不是** `skipped` —— 那个字段的契约是
     * 「此前已完成」，而它既没完成也没领到分；见 `src/types.ts` 的同名字段注释），
     * 否则既拿不到该任务的分，又会把它写成「已完成」= 报假账。
     */
    magicrew: magicrewOnboardingOf(MAGICREW),

    /**
     * **MagiCrew 国际站**新人奖励。
     *
     * ⚠️⚠️ 预期拿不到：该站 `onboarding/tasks` **恒返回空数组**（账号没被登记进
     * 引导计划）⇒ `status` 回 `total: 0`，UI 显示「无新人任务」。
     * 登记它是为了「万一登记了就能领」，以及让 UI 不至于因为缺这个 provider
     * 而把整个新人奖励入口隐藏掉。
     */
    magicrewintl: magicrewOnboardingOf(MAGICREW_INTL),
  }
}

/**
 * Magicrew 两站共用的一次性奖励实现（国内 `MAGICREW` / 国际 `MAGICREW_INTL`）。
 *
 * ⚠️ **零复制**：两站是同一个 Go 服务的两个数据面，协议**逐字符同构**，
 * 只有 `product.host` / `webOrigin` 不同 ⇒ 一个工厂 + 两个常量，
 * 复制两份会让同类缺陷修两遍（与 `autoclawintl` 同纪律）。
 *
 * ⚠️ 凭据形状校验必须与 `magicrew-checkin.ts` 一致（判 `typeof jwt === 'string'`）：
 * 裸 `JSON.parse` 会让 `{"foo":1}` 这种损坏凭据被当成有效凭据，
 * 随后 `jwt.length` 抛 **TypeError**（不可诊断，且不在 RPC 的 try/catch 覆盖范围内）。
 */
function magicrewOnboardingOf(product: MagicrewProduct): ProviderOnboarding {
  /** 从凭据里安全取 `{jwt, organizationCode}`；取不到返回 `undefined`。 */
  const paramsOf = (credential: unknown): { jwt: string, organizationCode: string } | undefined => {
    const parsed = credential as { jwt?: unknown, organizationCode?: unknown } | null | undefined
    if (typeof parsed?.jwt !== 'string' || parsed.jwt.length === 0) return undefined
    return {
      jwt: parsed.jwt,
      organizationCode: typeof parsed.organizationCode === 'string' ? parsed.organizationCode : '',
    }
  }
  const missing = (): never => {
    // ⚠️ 上抛（而不是回空状态）：`onboarding.status` 的失败会在 RPC 层转成
    // `ok:false` + 原因，用户能看到「需要重新登录」；回空状态会让面板显示
    // 「0 项任务」，把一个凭据问题伪装成「你这个号没有新人奖励」。
    throw new Error(`${product.displayName}账号未登录（缺少 JWT），请重新登录`)
  }
  return {
    status: async (credential) => {
      const params = paramsOf(credential) ?? missing()
      return await fetchMagicrewOnboardingStatus({ ...params, product })
    },
    claim: async (credential) => {
      const params = paramsOf(credential) ?? missing()
      return await claimMagicrewOnboardingTasks({ ...params, product })
    },
  }
}

/**
 * 按 provider id 从表里取实现。
 *
 * ⚠️ 用 `Object.hasOwn` 而非 `in`：`in` 会命中原型链上的键（如 `constructor`），
 * 把 `req.provider` 为怪值时误判成「有该 provider」——
 * 与 `creditsOf` / `authOf` 同因。
 */
export function onboardingOf(
  table: Readonly<Record<string, ProviderOnboarding>>,
  provider: string,
): ProviderOnboarding | undefined {
  if (!Object.hasOwn(table, provider)) return undefined
  return table[provider]
}
