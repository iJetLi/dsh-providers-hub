/**
 * `account.refresh` 的**行为级**测试夹具（Task 2 引入）。
 *
 * ## ⚠️ 为什么需要它（重构改变了「测试怎么影响分派」）
 *
 * 重构前，`account.refresh` 是 `switch (entry.provider)`，各 `case` 里**字面写出**
 * 了实例名（`await raccoon.refreshAccountCredential(...)`）。于是「某 provider
 * 有没有被接上」这件事是**代码文本**，各 provider 的 wiring 用例用 `readFileSync`
 * + 正则扫它（`case RACCOON.id:` 之类）。
 *
 * 重构后分派走 `authOf(auths, entry.provider)`（Task 9 引入的**命名对象形参**）
 * ⇒ 那些文本形态**消失了**，而它们守的意图（该 provider 的续期真的落到它自己的
 * 实例上）必须用**行为**重新表达。本夹具就是那个表达方式：
 * **直接传 `auths` 桩**、驱动真实端点、断言**哪个桩**被调用。
 *
 * ## ⚠️ 刻意**不**走全局注册表（`src/provider-runtime.ts`）
 *
 * 本夹具**参数化**：桩经 `registerJetHubRpc` 的第三个实参注入，**不碰**任何
 * 模块级可变状态。理由（Task 2 起草时实测）：
 * 1. 全局表是**模块级**的，同进程内多个测试文件会互相看见对方的桩；
 * 2. `registerProviderRuntime` **保留先注册者**（fiber 重启竞态的设计后果，
 *    见该函数注释），于是**真跑 `apply()`** 的测试文件一旦先进表，后注册的桩
 *    会被**静默忽略** —— 症状是一条看起来无关的断言失败。
 *
 * 走形参后，每个用例的桩只对它自己那次 `registerJetHubRpc` 可见。
 *
 * ⚠️ 本文件**不**替调用方做清理（没有 `afterEach`）：参数化之后就没有需要清理的
 * 共享状态了 —— 这正是它比「注册全局桩」的版本更可取的地方。
 */

import { registerJetHubRpc, JET_HUB_API_PATH } from '../../src/jet-hub-rpc.js'
import type { ProviderAccountEntry } from '../../src/types.js'
import { expectedProviderIdsWithAuth } from './provider-sets.js'

/**
 * 13 个**可续期** provider —— **被测对象**（手写清单，故意不派生）。
 *
 * ## ⚠️ 它由 `EXPECTED_REFRESH_PROVIDER_IDS` 守着（Task 2 复审 Finding I-1）
 *
 * 原文写「与 `src/index.ts` 的能力注册清单、以及 `JetHubAuths` 的 13 个键同源」
 * —— 那是一句**未被测量的保证**（本仓库红线：注释必须与测量一致）。实测当时
 * **没有任何断言**把它与 `PROVIDER_REGISTRY` 交叉核对，而它是
 * 「loomy / raccoon 的 `account.refresh` 行为覆盖」的**唯一驱动源**
 * （那两家的专属 spec 已退化为纯结构断言，见 `loomy-rpc-dispatch.spec.ts:77-84`
 * 与 `raccoon-rpc-dispatch.spec.ts:46`）
 * ⇒ 有人加 provider 时忘了这里、或删掉某一行，对应 provider 的行为覆盖
 * 会**静默降到零且全绿**（failure-class #1「静默漏算」）。
 *
 * ⇒ 现在由 `lobsterai-rpc-dispatch.spec.ts` 的
 *    「★ REFRESH_PROVIDERS 与 registry 逐项相等（漏一个即红并点名）」一条守着：
 *    本清单必须**逐项等于** {@link EXPECTED_REFRESH_PROVIDER_IDS}，漏一个即红**并点名**。
 *
 * ⚠️ **刻意不把本清单改成派生**：那样守卫会退化成同义反复，而且会失去
 * 「本清单漏了一个 provider」这个**真实失效模式**的探测力（派生后 registry 一加
 * provider，夹具就自动给它造桩 ⇒ 用例照样绿，而生产 `auths` 里可能根本没接）。
 * 这里要的正是「registry 是权威、本清单是被测对象」这个方向，与
 * `jet-hub-rpc-auth-wiring.spec.ts` 的 `AUTH_SERVICE` / `EXPECTED_AUTH_PROVIDER_IDS`
 * 同一套做法。
 *
 * ⚠️ `opencode` 凭据是静态 API key，**没有续期概念**，故被豁免
 *（`aggregate` 由 `channel: false` 自然排除）。
 */
export const REFRESH_PROVIDERS = [
  'codearts', 'buddy', 'workbuddy', 'lobsterai', 'qoder', 'qodercn',
  'trae', 'cline', 'loomy', 'raccoon', 'minimax', 'zcode', 'gemini',
  // officeace（2026-10-12）：华为云 OAuth 单账号，`refreshAccountCredential`
  // 重读并续期那一份凭据（见 `officeace-auth.ts` 的该函数注释）。
  'officeace',
  // accio（2026-10-13）：有真实 refresh 端点（`accio-auth.ts` 的
  // `refreshCredential`），`refreshAccountCredential` 续期并回写池内 `expiresAt`。
  'accio',
// minimaxintl（2026-10-15）：MiniMax Code 国际版，与 `minimax` 共用同一个
  // `MinimaxAuth` 类，有真实 refresh 端点（`account.minimax.io/oauth2/token`）。
  // ⚠️ 它与 `minimax` 是**两个 provider**（账号不互通、凭据 ref 前缀不同），
  // 故**必须各占一项** —— 漏了它，国际站账号的 `account.refresh` 行为覆盖为零。
  'minimaxintl',
  // astudio（2026-10-16，goal 302 接线）：有真实续期通路（src/astudio-auth.ts 的
  // refreshOnce / refreshAccountCredential）—— 上游 401 时重取权威凭据并回写磁盘会话。
  'astudio',
  // autoclaw（2026-10-17）：AutoClaw（智谱）有真实 refresh 端点
  // （`autoclaw-auth.ts` 的 `refreshCredential` → `refreshAutoclawToken`），
  // 且 `refreshAccountCredential` 续期并回写池内 `expiresAt`
  // ⇒ 不属 loomy / zcode 那类「设计上没有 refresh 端点」的豁免。
  'autoclaw',
  // ⚠️ autoclawintl（2026-10-20）：AutoClaw 国际版，与 `autoclaw` 共用同一个
  //   `AutoclawAuth` 类、有真实 refresh 端点（`/userapi/v1/refresh`，国际站
  //   实测续期成功），且 `refreshAccountCredential` 续期并回写池内 `expiresAt`。
  //   ⚠️ 与 `autoclaw` 是**两个 provider**（账号不互通、凭据 ref 前缀不同），
  //   故必须各占一项 —— 漏了它，国际站账号的 `account.refresh` 行为覆盖为零。
  'autoclawintl',
  // ⚠️ **本 fork 独有**（modelscope，2026-10-16）：它**在**表里（与 loomy 同款理由
  //    —— 没有 refresh 端点，但 `refreshAccountCredential` 仍按统一接口做
  //    有效性对账并回写池内 `expiresAt`）。
  'modelscope',
  // ⚠️ **Codely**（Unity，2026-10-22 A6）：有真实 refresh 端点（`POST /auth/refresh`，
  //    实测 200 且 `refresh_token` 不轮换），`refreshAccountCredential` 续期并回写凭据 +
  //    池内 `expiresAt` ⇒ 不属 loomy / zcode 那类豁免。
  //    ⚠️ 它之前不在本表里，理由是当时 `CodelyAuth.refreshAll` **2 参、对不上契约**
  //    （TS2322）⇒ 接不上。现已改成单参并真接（见 A5）。
  'codely',
  // qiniu (fork-only, 2026-10-29): same reason as modelscope / loomy -- no refresh
  // endpoint (static sk- API key, long-lived), but QiniuAuth.refreshAccountCredential
  // still re-reads the credential and writes back pool expiresAt via the shared
  // contract, so it stays in this table (omitting it leaves that provider zero coverage).
  'qiniu',
  // ⚠️ 超级麦吉（Magicrew，2026-10-29）：有真实 refresh 端点
  //    （`PUT /api/v1/model-gateway/tokens`，`refreshMagicrewKey` 是 refresh_token 的唯一出口），
  //    `refreshAccountCredential` 续期并回写池内 `expiresAt` ⇒ 不属 loomy / zcode 那类豁免。
  'magicrew',
  // ⚠️ **MagiCrew 国际版**（`magicrewintl`，2026-11-01）：与 `magicrew` 共用同一个
  //    `MagicrewAuth` 类与同一条续期通路（`PUT /api/v1/model-gateway/tokens`），
  //    只是 host 不同 ⇒ 必须各占一项，漏了它国际站账号的 `account.refresh`
  //    行为覆盖为零（与 minimaxintl 同型）。
  'magicrewintl',
  // ⚠️ **MonkeyCode**（`monkeycode`，2026-11-02）：与 qiniu / modelscope 同型 ——
  //    **没有 refresh 端点**（凭据是长期静态 API Key：白泽 `sk-…` / 网关 `oma_…`，
  //    `expires_at` 通常缺失），但 `MonkeycodeAuth.refreshAccountCredential` 仍按
  //    统一接口做有效期对账并回写池内 `expiresAt` ⇒ **留在本表里**，
  //    漏了它这一家的 `account.refresh` 行为覆盖就降为零。
  'monkeycode',
  // 百智云（2026-11-02）：`channel: true`、`rateLimit` 缺省 true。它的
  // `refreshAccountCredential` 是**有效期对账**（静态 sk- 无续期端点），
  // 与 qiniu / loomy 同型 —— 必须登记，否则 account.refresh 行为覆盖为零。
  'baizhi',
  // ⚠️ 2026-11-02 拆站：国际站是**独立部署**（独立账号池 / cookie / 网关），
  //    `channel: true` ⇒ 必须进批量续期表，否则它的 `account.refresh` 覆盖为零。
  'monkeycodeintl',
] as const

/**
 * **期望**可续期的 provider 集合 —— 从 `PROVIDER_REGISTRY` 派生，
 * ⚠️ **绝不读 `REFRESH_PROVIDERS`**（否则比对恒真，见 `REFRESH_PROVIDERS` 的注释）。
 *
 * ⚠️ 2026-10-08（Task 11-F）：判据改由 {@link expectedProviderIdsWithAuth} 单一持有
 *（原先这里与另外三处各自硬编码 `d.channel && d.id !== 'opencode'`）。
 * 那两条豁免各自的**理由**由 `jet-hub-rpc-auth-wiring.spec.ts` 的
 * 「两个豁免者的豁免理由逐条被验证」负责 —— 本文件**不另立**第二套豁免判据
 *（本仓库红线：一个语义不许有两套判据）。
 *
 * ⚠️ 不用 `settingsNamespace` 之类的**巧合字段**推断：`opencode` 恰好是唯一没有
 * 它的 `channel` provider，但那是巧合而非语义（AGENTS.md 明确反对）。
 */
export const EXPECTED_REFRESH_PROVIDER_IDS: readonly string[] = expectedProviderIdsWithAuth()

/** 一次续期调用的**全部**实参 —— 三个都要断（issue !IKIRTT 靠后两个）。 */
export interface RefreshCall {
  /** 被调用的桩属于哪个 provider（= 它自己的 id）。 */
  readonly provider: string
  /** 第 1 个实参：要续期的**凭据 ref**（必须是池内条目那个，不是默认单凭据 ref）。 */
  readonly ref: string
  /** 第 3 个实参：账号 id（回写账号池的定位键）。 */
  readonly accountId: string
  /** 第 2 个实参：账号池（断言它就是本次注册用的那个对象）。 */
  readonly pool: unknown
}

/** 构造一条账号池条目。 */
export function accountEntry(provider: string, credentialRef: string): ProviderAccountEntry {
  return {
    id: `${provider}-1`,
    provider,
    nickname: '行为测试号',
    enabled: true,
    credentialRef,
    createdAt: 1,
    refreshable: true,
  }
}

export interface RefreshHarness {
  /** 采集到的续期调用（按发生顺序）。 */
  readonly calls: readonly RefreshCall[]
  /** 本次注册用的账号池对象 —— 用来断言桩收到的第 2 个实参就是它。 */
  readonly pool: unknown
  /**
   * 本次注册用的 auths 桩对象（键 = provider id）。
   *
   * ⚠️ 暴露它是为了让用例能断言**桩的形状**本身，而不只是它的调用记录 ——
   * 例如「桩**没有** `refresh` 方法」这件事，若只写
   * `expect(calls.some(c => …refresh…)).toBe(false)` 就是**恒真**的
   *（没有 `refresh` 方法当然不会被调用到），见 `lobsterai-rpc-dispatch.spec.ts`
   * 里那条反向断言。
   */
  readonly auths: Readonly<Record<string, unknown>>
  /** 驱动一次 `account.refresh`，返回 RPC 结果载荷。 */
  call(accountId: string): Promise<{
    ok: boolean
    value?: { success: boolean }
    error?: { code?: string; message?: string }
  }>
}

export interface RefreshHarnessOptions {
  /**
   * 让指定 provider 的续期**抛错**（issue IKJOZA 的失败语义：失败必须回
   * `ok:false`，不得包成 `ok:true + value.success:false`）。
   */
  readonly throwing?: Readonly<Record<string, string>>
}

/**
 * 搭一个只记录调用、不发网络的 `account.refresh` 端点。
 *
 * ⚠️ 每个 provider 的桩**都记自己那个 id**（而不是记「第 N 个实参」）——
 * 这正是把「位置参数错位」这个历史缺陷（本仓库自陈复发 6 次）从测试里
 * 一并消灭的地方：断言 `calls === [{ provider: 'raccoon', … }]` 时，
 * 「raccoon 的账号去刷了别的实例」必然变红。
 */
export function refreshHarness(
  accounts: ProviderAccountEntry[],
  options: RefreshHarnessOptions = {},
): RefreshHarness {
  let handler: ((request: Request) => Promise<Response>) | undefined
  const ctx = {
    connection: {
      fetch: {
        register: (spec: { path: string; fetch: (request: Request) => Promise<Response> }) => {
          if (spec.path === JET_HUB_API_PATH) handler = spec.fetch
        },
      },
    },
    logger: { warn: () => {}, info: () => {}, error: () => {} },
    credentials: {
      resolve: async () => undefined,
      describe: async () => ({ configured: false }),
    },
    get: () => undefined,
    // `connection` 由生产代码用**惰性注入**（`ctx.inject`）挂载，而非插件级
    // 静态 `inject`：它只存在于 Web bundle，静态声明会让 headless/CLI profile
    // 永久 pending 而启动失败。替身必须复刻这一机制，否则 registerJetHubRpc
    // 会以 `ctx.inject is not a function` 直接抛错。
    inject: (_deps: string[], callback: (ctx: unknown) => void) => { callback(ctx) },
  }

  const calls: RefreshCall[] = []
  const auths: Record<string, unknown> = {}
  for (const provider of REFRESH_PROVIDERS) {
    auths[provider] = {
      refreshAccountCredential: async (ref: string, pool: unknown, accountId: string) => {
        const message = options.throwing?.[provider]
        if (message !== undefined) throw new Error(message)
        calls.push({ provider, ref, accountId, pool })
      },
    }
  }

  const pool = {
    listAllAccounts: async () => accounts,
    listAccounts: async (provider: string) => accounts.filter((a) => a.provider === provider),
    updateAccount: async () => {},
  }

  // ⚠️ 13 个键**一个都不能少**（`JetHubAuths` 的字段全是必填）—— 缺键在
  //    `pnpm typecheck:tests` 覆盖到的文件里是编译错误；本夹具的键由
  //    `REFRESH_PROVIDERS` 派生，故清单漏一个 provider 时这里少一个键。
  //    ⚠️ 而「清单漏了」这件事**不能靠类型检查发现**（`as never` 绕过了
  //    `JetHubAuths` 的逐字段检查）—— 由 `lobsterai-rpc-dispatch.spec.ts` 的
  //    registry 守卫负责，见 `REFRESH_PROVIDERS` 的注释。
  registerJetHubRpc(ctx as never, pool as never, auths as never)

  return {
    calls,
    pool,
    auths,
    call: async (accountId: string) => {
      const h = handler
      if (h === undefined) throw new Error('jet-hub RPC 端点未注册')
      const response = await h(new Request('http://127.0.0.1/api/jet-hub', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request',
          rpcId: 'r1',
          method: 'jet-hub',
          payload: { method: 'account.refresh', payload: { accountId } },
        }),
      }))
      const body = await response.json() as {
        result: {
          ok: boolean
          value?: { success: boolean }
          error?: { code?: string; message?: string }
        }
      }
      return body.result
    },
  }
}
