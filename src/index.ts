import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { LlmError } from '@deepseek-ai/dsh-llm'
import Schema from '@deepseek-ai/schemastery'
import { createHash } from 'node:crypto'
import { registerCodeArtsLlm, PROVIDER as CODEARTS_PROVIDER } from './llm-adapter.js'
import { startCatalogPrewarm } from './catalog-prewarm.js'
import { broadcastCatalogChanged } from './catalog-broadcast.js'
import { registerBuddyLlm } from './buddy-adapter.js'
import { registerLobsteraiLlm } from './lobsterai-adapter.js'
import { registerQoderLlm } from './qoder-adapter.js'
import { registerTraeLlm } from './trae-adapter.js'
import { registerClineLlm } from './cline-adapter.js'
import { registerLoomyLlm, parseLoomyRemoteModels } from './loomy-adapter.js'
import { registerRaccoonLlm } from './raccoon-adapter.js'
import { CODEARTS_CREDENTIAL_REF, CodeArtsAuth } from './service.js'
import { isRemoteCatalogComplete } from './models.js'
import { isBuddyCatalogComplete } from './buddy-oauth.js'
import { BUDDY_CREDENTIAL_REF, BuddyAuth, createPoolRefresh } from './buddy-auth.js'
import { LobsteraiAuth } from './lobsterai-auth.js'
import { QoderAuth } from './qoder-auth.js'
import { TraeAuth } from './trae-auth.js'
import { ClineAuth } from './cline-auth.js'
import { LoomyAuth } from './loomy-auth.js'
import { RaccoonAuth } from './raccoon-auth.js'
import { LOOMY } from './loomy-product.js'
import { LoomyBalanceSelector } from './loomy-balance-selector.js'
import { RACCOON } from './raccoon-product.js'
import { ZcodeAuth } from './zcode-auth.js'
import { registerZcodeLlm } from './zcode-adapter.js'
import { ZCODE } from './zcode-product.js'
import { ZCODE_CAPTCHA_FALLBACK, type ZcodeCaptchaConfig } from './zcode-captcha.js'
import type { CarrierOutcome } from './captcha-carrier.js'
import { AccountPool, allAccountsRateLimitedForModel } from './account-pool.js'
import { geminiFetchForAccount, setGeminiProxyPool } from './gemini-proxy.js'
import { MultiAccountRefreshScheduler } from './refresh-scheduler.js'
import { hasLegacyNamespaceRegistration, settingsOf, suppressAutoSettingsPage } from './settings-compat.js'
import { DEFAULT_BODY_LIMITED_IMAGE_MAX_BYTES, type ImageRequestTarget } from './image-budget.js'
import { buildRaccoonNickname, registerJetHubRpc, type JetHubAuthLike } from './jet-hub-rpc.js'
import { ALL_PRODUCTS, CODEBUDDY, WORKBUDDY } from './product.js'
import { mountOpenAiGateway } from './openai-gateway/index.js'
import { installLoopResume } from './loop-recovery.js'
import { installWebNative } from './web-native.js'
import {
  attachTokenLedgerStore,
  reportLedgerAccount,
} from './token-ledger.js'
import { createTokenLedgerStore } from './token-ledger-store.js'
import { buddyExpiringWindowDays } from './buddy-balance-rank.js'
import { BuddyBalanceSelector } from './buddy-balance-selector.js'
import type { BuddyNoAccountReason } from './buddy-balance-selector.js'
import type { LoomyNoAccountReason } from './loomy-balance-selector.js'
import { createCredentialResolver } from './credential-resolver.js'
import { LOBSTERAI } from './lobsterai-product.js'
import { QODER, QODER_CN } from './qoder-product.js'
import { TRAE } from './trae-product.js'
import { CLINE } from './cline-product.js'
import { configureDeadModelStore, withDeadModelPruning } from './dead-model-store.js'
import type { CodeArtsCredential, BuddyCredential } from './types.js'
import type { LobsteraiCredential } from './lobsterai.js'
// 「锁定永久积分」的余额分档需要各家的余额查询函数：分档判据
// （`splitBuddyCreditsByExpiry`）只读通用的 `packages[].{active, remaining,
// deductionEndTime}`，故把各家的 fetch 指给同一个选择器即可（见各自接线处）。
import { fetchLobsteraiCreditBalance } from './lobsterai-credits.js'
import { fetchTraeCreditBalance } from './trae-credits.js'
// ⚠️ Qoder **两站**的 `fetchQoderCreditBalance`（2026-10-20，同为「永久积分锁定」新增）：
//    它只吃 `QoderCredential`、且**第三个参数才是 `fetcher`**（与 minimax / astudio
//    那两份的 `(credential, fetcher, product)` 顺序不同，别照抄）。
//    ⚠️⚠️ 两站**必须各传自己的 product**：`QODER` 指向 `openapi.qoder.sh`、
//    `QODER_CN` 指向 `openapi.qoder.com.cn` —— 传错会让选号读到对方站点、
//    余额恒查不到（未锁定 ⇒ 换号优化静默失效；锁定 ⇒ 永远报「没有可用账号」）。
import { fetchQoderCreditBalance } from './qoder-credits.js'
// ⚠️ astudio 的 `fetchAstudioCreditBalance` 是 2026-10-20 为「永久积分锁定」新增的
//    薄封装（压平 `fetchAstudioBalanceDetailed` 的 `{balance, error?}` 成
//    `CreditBalance | null`，因为 `BuddyBalanceSelector` 的 `fetchBalance` 契约
//    只要余额、不要原因）。**不要**在选号路径上直接调 Detailed —— 那会丢掉
//    「为什么查不到」的分流（会话失效 / 服务不可用 / 形状不认识）。
import { fetchAstudioCreditBalance } from './astudio-credits.js'
// ⚠️ MiniMax 两站的 `fetchMinimaxCreditBalance`（2026-10-20，同为「永久积分锁定」新增）：
//    它是 `fetchMinimaxCreditBalanceDetailed` 的薄封装（压平 `{balance, error?}` 成
//    `CreditBalance | null`），因为 `BuddyBalanceSelector` 的 `fetchBalance` 契约
//    只要余额、不要原因。**不要**在选号路径上改调 Detailed。
import { fetchMinimaxCreditBalance } from './minimax-credits.js'
import type { QoderCredential } from './qoder.js'
import type { TraeCredential } from './trae.js'
import type { ClineCredential } from './cline.js'
import type { LoomyCredential } from './loomy.js'
// ⚠️ 2026-10-16：loomy 选号吃共享读数时需要 `CreditBalance` 形状（两池）。
import type { CreditBalance } from './credits.js'
// ⚠️ AutoClaw 两站（2026-10-21，用户要求「补锁定开关」）：`fetchAutoclawCreditBalance`
//    是 `fetchAutoclawBalanceDetailed` 的薄封装（压平 `{balance, error?}` 成
//    `CreditBalance | null`，因为 `BuddyBalanceSelector` 的 `fetchBalance` 契约
//    只要余额、不要原因）。**不要**在选号路径上改调 Detailed —— 那会在选号路径上
//    重写一套失败分类，与本文件「同义判据只留一处」的纪律冲突。
//    ⚠️ 它的第二参是 `options?: AutoclawCreditsOptions`（`{ product, fetcher? }`），
//    与 qoder 那份的 `(credential, product)` 位置顺序**不同**，别照抄。
import { fetchAutoclawCreditBalance } from './autoclaw-credits.js'
import type { RaccoonCredential } from './raccoon.js'
import { MinimaxAuth } from './minimax-auth.js'
import { registerMinimaxLlm } from './minimax-adapter.js'
import { MINIMAX, MINIMAX_INTL } from './minimax-product.js'
// ⚠️ `PROVIDER_REGISTRY` 供 namespace 清单派生（`registerProviderSettings` 的实参）；
//    `descriptorOf` 供**能力注册表**逐项取元数据（见下面的注册段）。
//    brief 原稿称「Task 1 已加过 `descriptorOf`，合并进同一行」，实测**没有** ——
//    故 Task 2 才把它并进本行。
import { PROVIDER_REGISTRY, descriptorOf } from './provider-registry.js'
import { registerProviderRuntime, registerBalanceCache, expiryOf, runtimeOf, wiredRefreshTargets, type ProviderRuntime } from './provider-runtime.js'
// ⚠️ Task 8：探测适配器的**构造**从 `account-probe.ts` 搬到本文件（注册处）——
//    那里已改为查注册表，未登记则抛错（不再有 `else` 兜底交给 CodeArtsAdapter）。
//    ⇒ 这里需要**全部**会写 `modelRateLimits` 的适配器类（含 loomy / raccoon，
//    旧链漏了它们 = 同型缺陷第 5 次）。
//    ⚠️ **刻意不写「几家」**：本句原写「全部 **10 家**」，实测那只是**紧邻下面
//    这一段**导入的类数（10）—— 而 `OpencodeAdapter` 的导入在更下面的独立一行
//    （它同时供 `registerOpencodeLlm` 用），于是「会写标记的适配器类」实为 **11**；
//    按**家**展开则是「每个会写标记的家」（数字会随 provider 增减腐坏，别写）。
//    ⇒ 权威清单与判据见 `probeById` 自己的头注释，别在这里写数字。
import { BuddyAdapter } from './buddy-adapter.js'
import { LobsteraiAdapter } from './lobsterai-adapter.js'
import { QoderAdapter } from './qoder-adapter.js'
import { ClineAdapter } from './cline-adapter.js'
import { ZcodeAdapter } from './zcode-adapter.js'
import { TraeAdapter } from './trae-adapter.js'
import { CodeArtsAdapter } from './llm-adapter.js'
import { GeminiAdapter } from './gemini-adapter.js'
import { LoomyAdapter } from './loomy-adapter.js'
import { MinimaxAdapter } from './minimax-adapter.js'
import { RaccoonAdapter } from './raccoon-adapter.js'
// ===== Accio（阿里）=====
// ⚠️ `AccioAuth` / `AccioAdapter` / `ACCIO` 与其余 provider **平行而非继承**：
//    它的信封是 Gemini 风格（snake_case）、token 在 **body**（放 Authorization
//    头恒流内 402）、且**不需要** SecurityGuard 签名（实测不带 `pctb-x-*` 同样 200）。
//    详见 `docs/agent-notes/providers-accio.md`。
import { AutoclawAuth } from './autoclaw-auth.js'
import { registerAutoclawLlm } from './autoclaw-adapter.js'
import { AUTOCLAW, AUTOCLAW_INTL } from './autoclaw-product.js'
import { isAutoclawUuidUserId, type AutoclawCredential } from './autoclaw.js'
import { AccioAuth } from './accio-auth.js'
import { AccioAdapter, registerAccioLlm } from './accio-adapter.js'
import { ACCIO } from './accio-product.js'
import type { AccioCredential } from './accio.js'
// AStudio（讯飞 AstronStudio）：直连上游 MAAS。**没有 OAuth 授权页** —— 推理凭据是
// 本机客户端登录后明文落盘会话的一份拷贝（见 astudio-auth.ts 模块头）。
// 本家符号分属四个模块：auth 服务在 astudio-auth.ts、适配器注册在 astudio-adapter.ts、
// 产品常量在 astudio-product.ts、纯函数与凭据类型在 astudio.ts。
import { AstudioAuth } from './astudio-auth.js'
import { registerAstudioLlm } from './astudio-adapter.js'
import { ASTUDIO } from './astudio-product.js'
// ⚠️ 类型必须在**类型位置**导入：`verbatimModuleSyntax` 下漏了它会在
//    `resolveAstudioCredentialByRef` 的返回标注处报 TS2552（2026-10-20 实测）。
import type { AstudioCredential } from './astudio.js'
// ⚠️ **本 fork 独有**的 provider（上游 rc.11 仍无 modelscope）。
// 见 `docs/agent-notes/providers-modelscope.md` 与 `src/modelscope-product.ts` 模块头的逐条出处表。
import { ModelscopeAuth } from './modelscope-auth.js'
import { ModelscopeAdapter, registerModelscopeLlm } from './modelscope-adapter.js'
import { MODELSCOPE } from './modelscope-product.js'
import { modelscopeModelsUrl, modelscopeHeaders, type ModelscopeCredential } from './modelscope.js'
import type { ZcodeCredential } from './zcode.js'
import { GEMINI_DEFAULT_PROJECT, GEMINI_SESSION_LANE_SMOKE } from './gemini.js'
import { createProviderCredits, creditsOf } from './provider-credits.js'
import { createProviderOnboarding, onboardingOf } from './provider-onboarding.js'
import type { MinimaxCredential } from './minimax.js'
import { GeminiAuth } from './gemini-auth.js'
import { registerGeminiLlm } from './gemini-adapter.js'
import { GEMINI } from './gemini.js'
// OfficeAce（华为 ModelArts MaaS 云端直连）：适配器 + 产品配置 + 鉴权模块
//（登录 / 推理 / 续期 / 余额 / 倍率全部直连云端，**不依赖 OfficeAce 客户端**）。
import { registerOfficeAceLlm } from './officeace-adapter.js'
import { OFFICEACE } from './officeace-product.js'
import * as officeaceAuth from './officeace-auth.js'
// 「锁定永久积分」在 officeace 上的**唯一执行实现**（issue IKLTHB 第 ① 条：
// 该渠道登记了 `permanentLock: true`，而原先全仓没有任何代码读这张锁定表）。
import { createOfficeAceCredentialProvider } from './officeace-lock.js'
import type { GeminiCredential } from './gemini.js'
import { createGeminiSigStore } from './gemini-sigstore.js'
import { OpencodeAdapter, registerOpencodeLlm } from './opencode-adapter.js'
import { AUTO_PROVIDER, registerAutoLlm } from './auto-adapter.js'
import { AGGREGATE_PROVIDER, registerAggregateLlm } from './aggregate-adapter.js'
// ⚠️ `createExpiryProbe` 从**底座**导入，不是从 `aggregate-adapter.js`
//（它定义在 `aggregate-expiry.ts`，理由见该文件与 Task 7 的 Files 说明）。
import { createExpiryProbe } from './aggregate-expiry.js'
// ⚠️ 共享余额读数缓存（2026-10-15，规格 §5.7）：装配层建**一个**实例，
//    `credits.balances` 端点与 buddy 系四家的折算共用它（见下面 `balanceCache` 的长注释）。
import { createBalanceCache, createBalanceRefresher, REFRESH_PERIOD_FALLBACK_MS, type BalanceCacheEntry } from './balance-cache.js'
// ⚠️ 模型目录的后台刷新器（用户 2026-10-18 要求：20 分钟定时更新）。
//    与余额刷新器**共用同一套骨架**（武装 + 单飞 + 幂等），但**不复用实例** ——
//    余额缓存 key 是 `(provider, accountId)`、目录的 key 是 provider，语义不同。
import { createCatalogRefresher } from './model-catalog.js'
// ⚠️ 中止判据复用适配器的**共享实现**（`aggregate-adapter.ts` 的 `isAbortLike`）：
//    本仓库已有 4 份同义实现，装配层不该再添第五份。
import { isAbortLike as isAbortLikeError } from './aggregate-adapter.js'
import { createProviderExpiry } from './provider-expiry.js'
// ⚠️ opencode 的 RPC 由 `jet-hub-rpc.ts` 的 handleMethod 统一分派
// （它调 handleOpencodeRpc），本文件**不再**单独注册端点 —— 详见
// `opencode-rpc.ts` 模块头「为什么是被主 switch 调用」。
import {
  ensureDefaultAnonymousSlot, listIdentitySlots, poolEntrySnapshot,
} from './opencode-auth.js'
import { OPENCODE } from './opencode-product.js'
import type { OpencodeCredential } from './opencode.js'
import { MODELS_DEV_TTL_MS, primeModelsDev, refreshModelsDev } from './models-dev-cache.js'
import { invalidateOpencodeCapabilities } from './opencode-capability.js'
import { closeAllProxyDispatchers } from './opencode-proxy.js'
import { execFile } from 'node:child_process'

/**
 * 懒加载的 OpenCode UA：首个请求要发时才探测本机 opencode 版本，探测一次即缓存。
 *
 * ⚠️ 拿不到**不阻塞、不抛错**，回退 `OPENCODE.defaultUserAgent`：UA 只是一个伪装
 * 维度，服务端并未校验其真实性（opencode2dsh 实测），不值得为此延迟启动。
 * 探测最多等 2 秒；本机没装 opencode 是**正常情况**（匿名通道照样能用）。
 * ⚠️ 用 `execFile` 而非 `exec`：**不经过 shell**，参数不会被解释；带
 * `windowsHide` 免得在 Windows 上闪一个黑框。
 * ⚠️ 缓存 Promise 而非结果：并发首请求只会 spawn 一次探测进程。
 */
function lazyOpencodeUserAgent(): () => string {
  let pending: Promise<string> | undefined
  return () => {
    pending ??= new Promise<string>((resolve) => {
      execFile('opencode', ['--version'], { timeout: 2000, windowsHide: true }, (_err, stdout) => {
        resolve(typeof stdout === 'string' ? stdout : '')
      })
    })
      .then((out) => {
        const version = out.match(/(\d+\.\d+\.\d+)/)?.[1]
        return version === undefined ? OPENCODE.defaultUserAgent : `opencode/${version}`
      })
      .catch(() => OPENCODE.defaultUserAgent)
    // 同步取值：缓存命中时立刻有值；未命中时用产品默认（不阻塞首个请求）。
    let cached = OPENCODE.defaultUserAgent
    void pending.then((ua) => { cached = ua })
    return cached
  }
}

/**
 * 拉取 Zen 模型目录的超时（毫秒）。
 *
 * ⚠️ 桌面版实测：到 `opencode.ai` 的 fetch 可能**永不 settle**（宿主网络
 * 异常），而 `loadOpencodeCatalog` 的兜底分支只有在内层 Promise **结束**
 * 后才可能执行。挂死时模型列表与用量徽标会同时空白（用户报障 2026-10-02）。
 * 8 秒足够覆盖正常路径（实测首字节 720ms 量级），又不会让 UI 干等太久。
 */
const OPENCODE_CATALOG_TIMEOUT_MS = 8_000

export type { CreditBalanceService, PublicCreditAccount, PublicCreditPackage } from './credit-balance-service.js'

export const name = 'codearts-auth'
// `connection` 刻意不列入静态 inject：它只由 Web bundle（dsh-client-connection）
// 提供，headless/CLI profile 里并不存在。静态 inject 会让本插件在那些 profile
// 里永久 pending，进而让整个 profile 以
// "plugin tree failed to load: 1 entry did not activate" 启动失败
// —— chicheng-cron 的 skill/agent 任务正是通过 `dsh --profile headless` 运行的，
// 会因此全部 exit 1。Jet Hub 的 RPC 端点在 Web 下通过 apply 内的可选注入挂载，
// 其余 profile 只是不注册该端点。
export const inject = ['credentials', 'commands', 'llm']

/**
 * 插件 Config schema。
 *
 * ⚠️ **DSH 0.1.7-rc.1 起，settings 表单的命名空间就是 profile 条目 id**
 * （本插件的条目 id 是 `codearts-auth`），且只投影本条目 Config 中标记了
 * `.volatile()` 的字段。因此这里保留一个 `providers` 映射：
 * - **历史**：它曾是各 provider 用 `registerConfigurableProviders({ settingsNs })`
 *   声明时的落地位置，模型设置页据此把它们判定为「已配置」（判据见
 *   `dsh-client-ui-settings-models` 的 `configured`）。**2026-10-01 起本插件不再
 *   声明可配置 provider**（见 `llm-register-compat.ts` 模块头），该映射因此没有
 *   消费者，保留它只为不改变 `settings.describe()` 的既有形状；
 * - 本插件的凭据与账号管理**不**走这里（那是 Jet Hub 的账号池 +
 *   `ctx.credentials`），故该字段只承接一个宽松映射，不参与业务读取。
 *
 * 必须是 schemastery schema：`SettingsForms.describe()` 会对每个注册项调用
 * `schema.toJSON()`，传入裸函数（`(value) => ...`）会让它抛
 * `TypeError: ... .toJSON is not a function`，进而使所有依赖 settings 的界面
 * （模型设置页、sidebar 的 settings.get/shell.get）全部失败。
 */
export const Config = Schema.object({
  providers: Schema.dict(Schema.any()).default({}).volatile(),
})

/**
 * 注册 provider 配置 namespace（**仅老契约需要**）。
 *
 * - **≤0.1.6**：`ctx.settings` 允许插件注册任意 namespace，六个 provider 各占
 *   一个（`llm-buddy` / `llm-workbuddy` / ...）。注册缺失会让模型设置页在
 *   `refFor → deriveKeyRef(provider)` 处以
 *   `provider.toUpperCase is not a function` 崩溃，故注册后回读 `describe()` 自检。
 * - **0.1.7-rc.1**：settings 换成 `SettingsForms`，**没有 `register`**，命名
 *   空间只能是 profile 条目 id —— 此时不再（也无法）注册。这里刻意**静默跳过**：
 *   旧实现在这条分支上会打一条误导性的
 *   「settings 服务不可用」告警（启动日志实证）。
 *
 * ⚠️ **2026-10-01 起各 provider 不再声明为可配置 provider**（`settingsNamespaceFor`
 * 因此没有调用方），模型设置页不再有这些 namespace 的消费者 —— 这份注册此后只影响
 * ≤0.1.6 的老契约 profile，属遗留行为，本次未一并删除。
 */
function registerProviderSettings(ctx: Context, ...namespaces: string[]): void {
  const settings = settingsOf(ctx)
  if (!hasLegacyNamespaceRegistration(settings) || settings?.register === undefined) return
  for (const ns of namespaces) {
    try {
      settings.register(ns, Config)
    } catch (error) {
      ctx.logger.warn(`[codearts-auth] settings namespace "${ns}" 注册失败: ${String(error)}`)
    }
  }
  // 回读确认：模型设置页要求 settingsNs 真实存在于 describe() 中。
  // 注意：describe() 会遍历所有已注册 namespace 并调用各自 schema 的
  // toJSON()/redactSecrets()，任一注册项的 schema 不合规都会让整条调用抛错。
  // 因此这里必须把异常打出来，而不是静默吞掉。
  try {
    const descriptors = settings.describe?.({ redactSecrets: true }) ?? []
    const registered = descriptors.map(v => v.ns)
    const missing = namespaces.filter(ns => !registered.includes(ns))
    if (missing.length > 0) {
      ctx.logger.warn(`[codearts-auth] provider namespace 未生效: ${missing.join(', ')}`)
    }
    ctx.logger.info(`[codearts-auth] settings.describe ok, namespaces: ${registered.join(', ')}`)
  } catch (error) {
    ctx.logger.error(
      `[codearts-auth] settings.describe 失败（将导致模型设置页/sidebar settings API 不可用）: `
      + `${error instanceof Error ? error.stack ?? error.message : String(error)}`,
    )
  }
}

/**
 * 图片附件桥接：把持久化图片读成原始字节供适配器内联。
 *
 * 用 `ctx.get` 而非 `inject` —— 附件服务缺失时 provider 仍可正常加载，

 * 只是收到图片时报 UNSUPPORTED_CONTENT。三个 provider 共用本实现：
 * 两个 CodeBuddy 系产品（CodeBuddy / WorkBuddy）共用同一后端与协议；
 * LobsterAI 的图片形态同为 OpenAI 兼容的 `image_url` data URL
 * （2026-09-17 实测服务端接受并正确识别内容）。

 */
export function makeReadImage(ctx: Context) {
  return async (attachment: unknown): Promise<{ data: Uint8Array; mediaType: string }> => {
    const attachments = ctx.get('attachments') as
      { readImage?: (ref: never) => Promise<{ data: Uint8Array; ref: { mediaType: string } }> } | undefined
    if (attachments?.readImage === undefined) {
      throw new Error(
        'codearts-auth: 附件服务（attachments）不可用，无法把图片内联进请求；'
        + '请确认当前 profile 已装载 @deepseek-ai/dsh-attachment-local。',
      )
    }
    const stored = await attachments.readImage(attachment as never)
    return { data: stored.data, mediaType: stored.ref.mediaType }
  }
}

/**
 * 图片「请求版本」桥接（issue !IKITT9）。
 *
 * 走 `ctx.attachments.readImageRequest(ref, target)`：由附件服务按目标尺寸与
 * 字节目标产出**确定性、可缓存**的缩放版本（alpha 走 WebP、不透明走 JPEG、
 * 85/75/60 质量阶梯），适配器只负责选目标。
 *
 * ⚠️ **任何不可用都返回 `undefined`，绝不抛错**，调用方据此回退原图。三种
 * 真实成因都必须容忍，否则「加上缩放」本身会变成新的故障源：
 *
 * 1. 宿主 profile 没装附件服务，或该版本没有 `readImageRequest`（老契约）；
 * 2. 附件后端明确拒绝投影（`ATTACHMENT_PROJECTION_UNSUPPORTED`）；
 * 3. 派生过程中的其它错误（缓存不可写、字节校验失败…）。
 *
 * 回退方向是刻意选 conservative 的一侧：宁可发一张大图（顶多触发网关的
 * 图片 token 上限），也不能因为「想缩图」而把一次本来能成功的请求打死。
 */
export function makeReadImageRequest(ctx: Context) {
  return async (
    attachment: unknown,
    target: ImageRequestTarget,
  ): Promise<{ data: Uint8Array; mediaType: string } | undefined> => {
    const attachments = ctx.get('attachments') as {
      readImageRequest?: (
        ref: never,
        requestTarget: never,
      ) => Promise<{ data: Uint8Array; mediaType?: string; attachment?: { mediaType?: string } }>
    } | undefined
    if (attachments?.readImageRequest === undefined) return undefined
    try {
      const projected = await attachments.readImageRequest(attachment as never, target as never)
      const mediaType = projected.mediaType ?? projected.attachment?.mediaType
      if (mediaType === undefined) return undefined
      return { data: projected.data, mediaType }
    } catch (error) {
      // 只记日志、随后回退原图：缩放是优化，不是请求的前置条件。
      ctx.logger?.warn?.(
        '[jet-hub] 图片请求版本派生失败，回退原图：'
        + `${error instanceof Error ? error.message : String(error)}`,
      )
      return undefined
    }
  }
}

/**
 * **AutoClaw 存量账号自愈**：先补齐 `user_id`，再按它去重。
 *
 * ## 为什么要「先补齐」（两轮失败才换来这一步）
 *
 * 用户三次报障「同一账号被加了 3 次」。实测三条凭据的字段形态**不一致**：
 *
 * | ref | 凭据 `user_id` | JWT `user_id` | JWT `guid` |
 * |---|---|---|---|
 * | `A6539467` | —（无该字段） | `839684` | `""`（空串） |
 * | `D6BF9EB2` | —（无该字段） | `839684` | `""`（空串） |
 * | `A3C56DD6` | `7c54a9a…`（UUID） | `839684` | `""`（空串） |
 *
 * 即存在两个**互不相通**的 id 空间：
 *
 * - **UUID**（`7c54a9acc…`）= 账号主键，服务端 `user-profile` 与凭据字段都用它；
 * - **`numericUserId`**（`839684`）= JWT 的 `user_id`，纯数字。
 *
 * 「字段优先、JWT 兜底」会让前两条落到 `839684`、第三条落到 UUID
 * ⇒ **分裂成两组、一条都去不掉**（用户二次报障「怎么还是在啊」的直接原因）。
 *
 * ## 定稿做法
 *
 * 1. 逐条 ref 调 `POST /userapi/v1/user-profile`（实测三条都拿回同一个 UUID），
 *    把 `user_id` **写回凭据**；
 * 2. 补齐后全池统一按 `user_id` 分组去重（`dedupeByCredentialField`）。
 *
 * ⚠️ 全程**尽力而为**：单条补齐失败只跳过该条、记 warn，绝不让启动失败。
 * ⚠️ 网络请求按 8s 超时，N 条串行最坏 N×8s —— 但它是 `void` 起的，
 *    不阻塞插件启动，也不阻塞用户第一条消息。
 */
async function autoclawSelfHeal(
  pool: AccountPool,
  ctx: Context,
): Promise<void> {
  // ⚠️⚠️ **读池本身也会抛**（2026-10-20 合并审计补记，实测有牙）：
  //    `AccountPool.listAccountsByProvider()` → `readAccounts()` → `ensureLoaded()`
  //    → `SettingsStore.load()` 在 scope 尚未就绪时抛 `TypeError`。原先只有
  //    **per-条目** 的 try 包住循环体，读池这一句在 try **之外** ⇒ 一抛就是
  //    **未捕获 rejection**（Node 默认 `--unhandled-rejections=throw`），
  //    全量单测实测 52 条 `Unhandled Rejection`。
  //    自愈是**尽力而为**：任何失败都只能记 warn，绝不能让启动失败。
  let entries: ReturnType<AccountPool['listAccountsByProvider']>
  try {
    entries = pool.listAccountsByProvider('autoclaw')
  } catch (error) {
    ctx.logger?.warn?.(
      `[autoclaw] 账号自愈读池失败（不影响启动）：`
      + `${error instanceof Error ? error.message : String(error)}`,
    )
    return
  }
  if (entries.length < 2) return

  // ── ① 补齐 user_id（只补缺的那条）──
  for (const entry of entries) {
    try {
      const raw = await ctx.credentials.resolve(credentialRef(entry.credentialRef))
      if (raw === undefined || raw.value.length === 0) continue
      const cred = JSON.parse(raw.value) as {
        access_token?: unknown
        device_id?: unknown
        user_id?: unknown
      }
      // ⚠️⚠️ **跳过条件必须是「已经是 UUID」，不能是「有值」**
      //    （2026-10-20 审计 P1，实测真缺陷）。
      //
      //    登录路径用 `readUserIdFromJwt()` 写回的 `user_id` 是**字符串形态的
      //    数字 id**（`String(839684)` ⇒ `"839684"`），原判据
      //    `typeof === 'string' && trim() !== ''` 对它**恒真** ⇒ 自愈从不为
      //    PR 之后新登录的账号补 UUID ⇒ 池里永久并存 `autoclaw:839684` 与
      //    `autoclaw:7c54a9a…` 两组 ⇒ 去重对混合池无效（PR 要修的症状原样存在）。
      //
      //    ⇒ 只有「已经是 UUID 主键」才算补齐完成。
      if (isAutoclawUuidUserId(cred.user_id)) continue

      const token = typeof cred.access_token === 'string' ? cred.access_token : ''
      const device = typeof cred.device_id === 'string' ? cred.device_id : ''
      if (token === '' || device === '') continue

      const ts = Math.floor(Date.now() / 1000).toString()
      const sign = createHash('md5').update(`${AUTOCLAW.appId}&${ts}&${AUTOCLAW.appKey}`).digest('hex')
      const resp = await fetch(`${AUTOCLAW.apiBase}/userapi/v1/user-profile`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Auth-Appid': AUTOCLAW.appId,
          'X-Auth-TimeStamp': ts,
          'X-Auth-Sign': sign,
          'X-Lang': 'zh-CN',
          'X-Channel': 'official',
          'Authorization': `Bearer ${token}`,
          'X-Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ source_id: 'autoclaw', device_id: device }),
        signal: AbortSignal.timeout(8000),
      })
      if (!resp.ok) {
        ctx.logger?.warn?.(
          `[autoclaw] 账号 ${entry.id} 补齐 user_id 失败（HTTP ${resp.status}），跳过该条`,
        )
        continue
      }
      const json = (await resp.json()) as { code?: number; data?: { user_id?: unknown } }
      const userId = json.data?.user_id
      if (json.code !== 0 || typeof userId !== 'string' || userId.trim() === '') {
        ctx.logger?.warn?.(
          `[autoclaw] 账号 ${entry.id} 补齐 user_id 失败（code=${json.code}），跳过该条`,
        )
        continue
      }
      // ⚠️ 只改 `user_id` 一个键，其余凭据字段原样保留
      //    （access_token/refresh_token/device_id 一个字节都不能动）。
      await ctx.credentials.set(
        credentialRef(entry.credentialRef),
        JSON.stringify({ ...cred, user_id: userId.trim() }),
      )
      ctx.logger?.info?.(
        `[autoclaw] 账号 ${entry.id} 已补齐 user_id（${userId.trim().slice(0, 8)}…）`,
      )
    } catch (error) {
      ctx.logger?.warn?.(
        `[autoclaw] 账号 ${entry.id} 自愈异常（不影响启动）：`
        + `${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  // ── ② 按补齐后的 user_id 去重 ──
  // ⚠️ **不再给兜底解析器**：此时所有 ref 都应当有 UUID，
  //    若有（网络全失败），跳过总比误删好。
  const removed = await pool.dedupeByCredentialField('autoclaw', 'user_id')
  if (removed > 0) {
    ctx.logger?.warn?.(
      `[autoclaw] 已清理 ${removed} 条重复账号（同一账号被重复添加导致积分累加翻倍）`,
    )
  }
}

/**
 * 「重测」用的**探测适配器工厂**（Task 8）。
 *
 * ⚠️ 各家代码**逐字**从 `src/account-probe.ts` 的 `else if` 链搬来（含各自的
 * 注释）；那条链已删除，改为查本表（**未登记 ⇒ 抛可读错误**）。
 *
 * ## 谁必须在这里
 *
 * 判据是「该 provider 的适配器会不会写 `modelRateLimits`」（写了才有重测语义）。
 * 核对方式机械、不要靠记忆：
 *
 *     grep -n 'updateModelRateLimit(' src/*.ts        # 写点（池侧定义 + 各适配器直调）
 *     grep -n 'markLimited' src/*.ts                  # 适配器侧经回调注入的写点
 *
 * ⚠️ **两条都要跑**：实测多数适配器是**直调** `pool.updateModelRateLimit(...)`
 * （只有 `cline` / `opencode` 用 `markLimited` 这个名字），只看第二条会把
 * 大部分家漏掉。
 *
 * ⚠️ **不要在这里抄名单、也不要写「几家」**：本段曾写「会写标记的 provider 共
 * **13 家**」并紧跟 13 个名字，2026-10-11 加入 `minimax`（issue IKJW32）后当场过期
 * —— 这正是本文件自己记的「同一条事实的多份抄写必然漂移」的又一次实证。
 * 权威判据是上面那两条 grep；权威清单是 `tests/helpers/provider-sets.ts` 的
 * `WRITES_RATE_LIMIT_PROVIDERS`（守卫把它与源码写点**双向**比对，
 * 漏一家 / 多一家都点名变红）。本表必须**恰好**登记那份清单里的家。
 *
 * 登记史（只记形态、不记数字）：
 *
 * - **第 5 次** `loomy` / `raccoon`：旧 `else if` 链里**没有它们的分支** ⇒ 落入
 *   `else` 被交给「华为云 HMAC 签名」的 `CodeArtsAdapter`，而它们的限流标记
 *   （UTC+8 当日 24:00）**永远清不掉**。
 * - **第 6 次** `opencode`：不是漏项，而是「登记表刻意豁免了它」且**理由被证伪**。
 * - **第 7 次** `minimax`：它先前**确实**不写标记（14 家里唯一），故曾被判
 *   「不需要 probe」；2026-10-11 接上请求级换号 + 冷却后该前提作废。
 *   ⇒ 判据永远是「**现在**写不写标记」，不是「曾经写不写」。
 *
 * ⚠️⚠️ **不要再写「`opencode` 不写标记」**（2026-10-08 原注释如此，独立复审
 * 实测证伪）：它与「余额是本地派生的通道可用性、零网络」说的是**两件事** ——
 * 后者是它不进积分表的理由（见 `provider-credits.ts`），前者是它进不进出本表的
 * 判据。把前者当成后者的推论，恰好把一个**真实的漏挂**说成了「不需要」。
 *
 * ⚠️ **UI 入口**：`jet-hub.js` 里「重测所有」/「重置所有」/卡片级「重测」「重置」
 * 都由 `supportsRateLimit(provider)` 门控（缺省 **true**），**不是**
 * `accountTest`（那是另一个「测试」按钮的位）。原注释称「`accountTest` 只有
 * `gemini` 为 true ⇒ 其余渠道没有入口」—— **该推论是错的**：`opencode` 没有
 * `rateLimit: false` 豁免 ⇒ 这些按钮**会渲染**。
 * ⇒ 本表的完整性**已经是用户可见功能**，不是「将来才复发」的内部契约
 * （只有「测试」那一个按钮仍限 `gemini`）。
 *
 * ⚠️ 一致性与「漏一家」由 `tests/unit/provider-runtime-wiring.spec.ts` 的 probe
 * 域守卫从硬编码清单 + {@link PROBE_EXEMPT} 派生锁死（漏挂会让它**点名**变红）。
 */
export const probeById: Record<string, NonNullable<ProviderRuntime['probe']>> = {
  // CodeBuddy 系（buddy / workbuddy）→ BuddyAdapter，按各自 product 发请求。
  buddy: {
    createProbeAdapter: (ref, credential) => new BuddyAdapter({
      credentialRef: credentialRef(ref),
      resolveCredential: async () => credential as BuddyCredential,
      refresh: async () => {},
      product: CODEBUDDY,
    }),
  },
  workbuddy: {
    createProbeAdapter: (ref, credential) => new BuddyAdapter({
      credentialRef: credentialRef(ref),
      resolveCredential: async () => credential as BuddyCredential,
      refresh: async () => {},
      product: WORKBUDDY,
    }),
  },
  // LobsterAI → 自己的端点与头族。
  lobsterai: {
    createProbeAdapter: (ref, credential) => new LobsteraiAdapter({
      credentialRef: credentialRef(ref),
      resolveCredential: async () => credential as LobsteraiCredential,
      refresh: async () => {},
      product: LOBSTERAI,
    }),
  },
  // Qoder 国际版与中国版**共用同一个适配器类**，差异全在 product 配置里
  //（区域端点、client_id、模型表）。探测只发一次最小纯文本请求，不涉及
  // 工具/图片，故除了 product 之外无需注入其它钩子；`uid` 由凭据自身携带
  //（旧凭据缺 uid 时适配器会明确报错，而不是发出必然失败的请求）。
  qoder: {
    createProbeAdapter: (ref, credential) => new QoderAdapter({
      credentialRef: credentialRef(ref),
      resolveCredential: async () => credential as QoderCredential,
      refresh: async () => {},
      product: QODER,
    }),
  },
  qodercn: {
    createProbeAdapter: (ref, credential) => new QoderAdapter({
      credentialRef: credentialRef(ref),
      resolveCredential: async () => credential as QoderCredential,
      refresh: async () => {},
      product: QODER_CN,
    }),
  },
  // Cline → WorkOS 凭据 + 自己的端点。
  cline: {
    createProbeAdapter: (ref, credential) => new ClineAdapter({
      credentialRef: credentialRef(ref),
      resolveCredential: async () => credential as ClineCredential,
      refresh: async () => {},
      product: CLINE,
    }),
  },
  // ⚠️ **本 fork 独有**（modelscope，2026-10-16）。
  //
  // 探测只发一次最小请求（`probe` 走适配器的 `listModels` / 一次最小补全），
  // 故只需把**这一份凭据**喂进 `slots`（单槽），不需要池 —— 与 cline 同款。
  // ⚠️ `fetchRemoteCatalog` 留空：目录探测不是「探活」的职责，
  //    且它会在 `listModels` 里回退兜底表（不会抛）。
  modelscope: {
    createProbeAdapter: (ref, credential) => new ModelscopeAdapter({
      credentialRef: credentialRef(ref),
      slots: async () => [{ id: MODELSCOPE.id, apiKey: (credential as ModelscopeCredential).access_token }],
      product: MODELSCOPE,
      // ⚠️ 不传 `warn`：`probeById` 是**模块级**常量（在 `apply()` 之前求值），
      //    此处**没有 `ctx`**。与 cline / lobsterai 的 probe 条目同款。
    }),
  },
  // ZCode（智谱）→ Anthropic Messages 体 + 阿里云 captcha 参数。
  //
  // ⚠️ 已知取舍：探测路径**没有** `mintCaptcha` 透传通道（`ProbeDeps` 里没有
  // 这一项），故**一旦上游索要验证**，这里的适配器就**自建**一个常驻浏览器
  //（上游不要验证时压根不 mint，也就不会拉）。若宿主里已有 `index.ts`
  // 注入的那台（`zcode.mintCaptcha`），短时会并存两台（约 200MB/台）。
  // 这仍然远好于旧缺陷的形态 —— 落 else 会被交给**华为云 HMAC 签名**的
  // `CodeArtsAdapter` 去发 zcode 凭据，探测必然失败，而 zcode 的额度标记
  //（UTC+8 当日 24:00）会一直清不掉。
  // 后续若要消除这层浪费，应给 `ProbeDeps` 加一条 `mintCaptcha` 透传，
  // 与 `index.ts` 的 `zcode.mintCaptcha` 共用同一台常驻浏览器。
  zcode: {
    createProbeAdapter: (ref, credential) => new ZcodeAdapter({
      credentialRef: credentialRef(ref),
      resolveCredential: async () => credential as ZcodeCredential,
      refresh: async () => {},
      product: ZCODE,
    }),
  },
  // TRAE → SOLO 格式请求体 + Cloud-IDE-JWT 头族。
  // 只有一个产品（`TRAE` 常量），没有 productById 式的查表，故直接按 id 注册。
  // 不传 product → TraeAdapter 内部默认用 TRAE。
  trae: {
    createProbeAdapter: (ref, credential) => new TraeAdapter({
      credentialRef: credentialRef(ref),
      resolveCredential: async () => credential as TraeCredential,
      refresh: async () => {},
    }),
  },
  // Gemini（Cloud Code Assist）。
  //
  // 探测只发一次最小纯文本请求，不涉及图片/工具，故除 product 与 lane 外
  // 无需其它钩子。
  //
  // ⚠️ lane 必须是 `smoke`：原版实测冒烟路径与推理路径的 sessionId **不同**
  //（同 prompt 同预算下取值不同，说明 lane 进了哈希）。不传会让探测流量与
  // 真实推理混进同一个会话，污染会话归并与 thoughtSignature 回填。
  //
  // ⚠️ `project` **显式钉兜底串**，与「刻意不传 accountPool / fetchRemoteModels」
  // 同一个理由：探测是**轻量存活检查**，要的是一次到推理端点的真请求。
  // 若走自动探测，会先多打一次 `loadCodeAssist`，且 LCA 失败（限流/网络抖动）
  // 会让探测报「项目号探测失败」而不是它真正要报的「账号仍受限」—— 反而掩盖
  // 了用户点「重测」想知道的答案。探测**不写**任何东西（不传 persistProject）。
  gemini: {
    // ⚠️ **第三个形参 `entry` 不能丢**（IKLTZ2 审计 P1-1，真实缺陷）：
    // 探测路径**刻意不传 `accountPool`**（`account-probe.ts` 的既定语义：
    // 只测这一个账号、且不写任何标记）⇒ 适配器内那条「按 access_token 反查
    // 账号 id」的路**根本不存在** ⇒ 出口解析器拿到空 id、按「直连」处理
    // ⇒ **该账号的代理被完全绕过**。
    // 症状与 issue 原话同形：墙外环境下「测试 / 重测」**恒失败**，而这个失败
    // 与「账号已失效」在 UI 上完全同形 ⇒ 用户会去误删好号。
    //
    // ⚠️ 对照 opencode 的 `(ref, credential, entry)`（下方 L649）：它接下了
    // entry 并把 `entry.opencodeProxy` 喂进槽里，本家原先漏了这一步。
    createProbeAdapter: (ref, credential, entry) => new GeminiAdapter({
      credentialRef: credentialRef(ref),
      resolveCredential: async () => credential as GeminiCredential,
      refresh: async () => {},
      sessionLane: GEMINI_SESSION_LANE_SMOKE,
      project: GEMINI_DEFAULT_PROJECT,
      product: GEMINI,
      // ⚠️ **探测必须走该账号的代理**：账号卡片上的「测试 / 重测」按钮打的是
      // 真实推理端点，而 Gemini 全部端点都在墙外。
      fetchFor: geminiFetchForAccount,
      accountIdOverride: entry?.id ?? '',
    }),
  },
  // CodeArts → 华为云 HMAC 签名（**它自己的**签名方案，不是「兜底」）。
  // ⚠️ 旧实现里它是 `else` 的兜底分支 —— 那正是缺陷根源。现在它必须
  // **显式登记**，未登记的 provider 不再被静默交给它。
  codearts: {
    createProbeAdapter: (ref, credential) => new CodeArtsAdapter({
      credentialRef: credentialRef(ref),
      resolveCredential: async () => credential as CodeArtsCredential,
      refresh: async () => {},
    }),
  },
  // Loomy（讯飞）→ 自己的端点。⚠️ 旧链**漏了它**（第 5 次同型缺陷，见上）。
  loomy: {
    createProbeAdapter: (ref, credential) => new LoomyAdapter({
      credentialRef: credentialRef(ref),
      resolveCredential: async () => credential as LoomyCredential,
      refresh: async () => {},
      product: LOOMY,
    }),
  },
  // Raccoon Work（商汤小浣熊）→ 自己的端点。⚠️ 旧链**漏了它**（同第 5 次）。
  raccoon: {
    createProbeAdapter: (ref, credential) => new RaccoonAdapter({
      credentialRef: credentialRef(ref),
      resolveCredential: async () => credential as RaccoonCredential,
      refresh: async () => {},
      product: RACCOON,
    }),
  },
  // MiniMax Code（中国版）→ Anthropic Messages 端点。
  //
  // ⚠️ 它**曾经**不必在这里（issue IKJW32 之前：适配器不写 `modelRateLimits`）。
  // 2026-10-11 接上请求级换号 + 冷却后它**会写**标记（额度 24h / 限流 1h）
  // ⇒ 必须登记，否则标记写进去却永远清不掉 —— 与上面 `opencode` 完全同型。
  // 探测**不传** `fetchRemoteModels` / `accountPool` / `readImage`：与其余家同一
  // 理由（探测是轻量存活检查，不写任何状态、也不为一次探测额外拉目录）。
  // ⚠️ 尤其**不传 `accountPool`**：那会让 `stream()` 的反查与轮换在探测路径上
  // 复活（探测失败若写回限流标记，会把「重测 A 账号」变成污染池的副作用）。
  minimax: {
    createProbeAdapter: (ref, credential) => new MinimaxAdapter({
      credentialRef: credentialRef(ref),
      resolveCredential: async () => credential as MinimaxCredential,
      refresh: async () => {},
      product: MINIMAX,
    }),
  },
  // MiniMax Code 国际版 —— 与中国版同因（它同样会写 `modelRateLimits`），
  // 只是 product 换成 `MINIMAX_INTL`（探测请求必须打到 `agent.minimax.io`，
  // 否则国际站账号的「重测」会用国内站主机发凭据、必然 401 ⇒ 标记永远清不掉）。
  minimaxintl: {
    createProbeAdapter: (ref, credential) => new MinimaxAdapter({
      credentialRef: credentialRef(ref),
      resolveCredential: async () => credential as MinimaxCredential,
      refresh: async () => {},
      product: MINIMAX_INTL,
    }),
  },
  // Accio（阿里）→ 自己的网关端点。
  //
  // ⚠️ 它**曾经**不必在这里（issue IKM3ZV 之前：适配器不写 `modelRateLimits`，
  // `provider-registry.ts` 的 `rateLimit: false` 与 `WRITES_RATE_LIMIT_PROVIDERS`
  // 都据此把它排除）。2026-10-18 接上请求级换号 + 冷却后它**会写**标记
  // （额度至 UTC+8 当日 24:00 / 限流 1h）⇒ 必须登记，否则标记写进去却清不掉。
  //
  // ⚠️ 刻意**不传** `accountPool`（与 minimax 同一理由）：那会让 `stream()` 的
  // 反查与轮换在探测路径上复活（探测失败若写回限流标记，会把「重测 A 账号」
  // 变成污染池的副作用）。也**不传** `fetchRemoteModels` / `readImage`。
  accio: {
    createProbeAdapter: (ref, credential) => new AccioAdapter({
      resolveCredential: async () => credential as AccioCredential,
      refresh: async () => {},
      product: ACCIO,
    }),
  },
  // OpenCode Zen。
  //
  // ## ⚠️ 这里**必须**用第三个参数 `entry`，不能只靠 `credential`
  //
  // Zen 的出口与指纹的**权威在账号池条目**，不在凭据里：RPC 的
  // `opencode.setProxy` 落到 `AccountPool.setOpencodeProxy`，只写
  // `entry.opencodeProxy`（**不回写凭据**）；指纹代次同理只写
  // `entry.opencodeFingerprintGeneration`。只拿凭据去造槽，探测就会
  // **走错的出口 IP、发错的 project id** —— 而探测的全部意义正是
  // 「用这个账号的真实出网条件打一次请求」。
  //
  // ## ⚠️ 早先这里登记的「豁免」理由是**实测证伪的**
  //
  // 旧理由称「它的适配器需要整个 identitySlots 序列 + 池条目 id
  // （slotId 与 refName 不是同一键空间），补它要给 `ProbeDeps` 加池透传，
  // 属接口扩张」。逐条核对后不成立：
  //   - 探测**不需要整个序列**，只需要**它自己那一个**槽：`stream()` 只调
  //     `identitySlots()` 取序列，不读目录（`fetchRemoteCatalog` 只在
  //     `catalog()` 里用），而探测路径本就刻意不传 `markLimited`；
  //   - **不需要池**：`probeWithAdapter` 手上已有完整的 `ProviderAccountEntry`，
  //     它带着权威的代理与代次；
  //   - `slotId` 与 `refName` 的键空间差异在这里不成立：探测不调
  //     `markLimited`，没有任何按 slotId 写回的动作。
  // ⇒ 真正缺的只是「把 `entry` 交给工厂」这一件事，故给
  // `createProbeAdapter` 加了可选的第三个参数（纯放宽，其余各家的适配器不受影响）。
  //
  // ## 刻意**不**传的四个钩子
  //
  // `fetchRemoteCatalog` / `disabledModels` / `markLimited` / `readImage`
  // 一律不传，与其余家同一理由（探测是轻量存活检查，不写任何状态、
  // 不为一次探测额外拉目录）。其中 `markLimited` 尤其重要：探测失败若写回
  // 限流标记，会把「重测 A 账号」变成污染池的副作用。
  //
  // ## ⚠️ 槽由 `poolEntrySnapshot` 造，且**不继承**池里的 `enabled`
  //
  // `listIdentitySlots` 会跳过 `enabled === false` 的条目，而探测的既定语义是
  // 「**停用账号也要能重测**」（`account-probe.ts` 模块头第 2 条设计）。
  // 故这里**不传** `enabled`，用 `poolEntrySnapshot` 的缺省 `true`。
  //
  // UA 用产品默认值：`probeById` 是**模块级**常量（在 `apply()` 之前求值），
  // 够不到那里懒探测出的真机版本。UA 只是伪装维度、服务端未校验真实性
  // （见 opencode 接线块的注释），且**不影响**限流判定的结论。
  opencode: {
    // ⚠️ `OpencodeAdapterOptions` **没有** `credentialRef` / `resolveCredential`
    // / `refresh` 这三项（其余各家的适配器有）：Zen 的身份就是槽本身，
    // 适配器不做续期、也不按 ref 解析凭据。多传会被 tsc 直接点破。
    createProbeAdapter: (_ref, credential, entry) => {
      const credentialKey = (credential as OpencodeCredential | undefined)?.api_key
      // 凭据坏掉/缺失时退回匿名 key：与主接线块同一兜底口径，
      // 让探测报「账号不可用」而不是抛空指针。
      const apiKey = typeof credentialKey === 'string' && credentialKey.length > 0
        ? credentialKey
        : OPENCODE.anonymousKey
      return new OpencodeAdapter({
        identitySlots: async () => listIdentitySlots(
          [
            poolEntrySnapshot({
              id: entry?.id ?? OPENCODE.id,
              apiKey,
              // ⚠️ 刻意不传 `enabled`（缺省 true）：停用账号也要能重测。
              proxy: entry?.opencodeProxy,
              generation: entry?.opencodeFingerprintGeneration,
            }),
          ],
          OPENCODE.defaultUserAgent,
        ),
      })
    },
  },
}

/** 注册 codeartsAuth 服务与 codearts LLM 路由（不注册斜杠命令）。 */
export function apply(ctx: Context): void {
  // 本插件自带 Jet Hub 设置页，关闭 0.1.7 起由 Config schema 反渲染的自动表单
  // （老契约没有 configure()，静默跳过）。
  suppressAutoSettingsPage(ctx)

  // provider 配置命名空间的注册**只在老契约（≤0.1.6）下执行**：
  // 那时 `settings.register` 可用，十二个 namespace 分别对应 codearts 路由、
  // CodeBuddy（buddy）、WorkBuddy（workbuddy）、LobsterAI（lobsterai）、
  // Qoder（qoder / qodercn）、TRAE（trae）、Cline（cline）、Loomy（loomy）、
  // Raccoon（raccoon）、MiniMax（minimax）与 Zcode（zcode）。
  //
  // 0.1.7-rc.1 起 settings 换成 SettingsForms（无 register），命名空间只能是
  // profile 条目 id，故这里不做任何注册。
  //
  // ⚠️ 2026-10-01 起各 provider 已**不再**声明为可配置 provider，故这批 namespace
  // 在模型设置页上已无消费者（详见该函数头的说明）。
  // ⚠️ 2026-10-08 改：namespace 清单从 `PROVIDER_REGISTRY` 派生，不再手抄 13 个。
  //    原先改 registry 的 `settingsNamespace` **行为完全不变**（宿主侧另有一份
  //    13 个字面量的副本），是「唯一真相源」名不副实的一处。
  //
  // ⚠️ **顺序变了**：原清单是 `buddy, workbuddy, codearts, lobsterai, …`（人工排列），
  //    派生后是 registry 的声明顺序（`codearts, buddy, workbuddy, …`）。
  //    ⚠️ **这个顺序无关紧要**：`registerProviderSettings` 内部是 `for (const ns of …)`
  //    逐个 `settings.register(ns, Config)`，注册顺序不影响 `describe()` 的语义
  //    （它按 ns 查、不按序）。**但必须确认既有断言不断言顺序** ——
  //    执行时 `rg -n "llm-buddy|llm-zcode|llm-codearts" tests/unit/` 核对；
  //    若有断言依赖顺序，改为**集合相等**（`.sort()`）而不是保持原顺序。
  registerProviderSettings(
    ctx,
    ...PROVIDER_REGISTRY
      .map((d) => d.settingsNamespace)
      .filter((ns): ns is string => ns !== undefined),
  )
  const service = new CodeArtsAuth(ctx)
  const pool = new AccountPool(ctx)

  /**
   * **AutoClaw 存量账号去重自愈**（2026-10-19 用户三次报障后定稿）。
   *
   * 用户形态：面板里同一个手机号出现 **3 次**，积分被重复累加
   *（20842 + 20842 + 20842 = 62526，真实余额只有 20842）。
   *
   * ## 为什么不能只按凭据字段 `user_id` 去重（两轮失败的原因）
   *
   * 实测三条凭据的字段形态**不一致**：
   *
   * | ref | 凭据 `user_id` | JWT `user_id` | JWT `guid` |
   * |---|---|---|---|
   * | `A6539467` | —（无） | `839684` | `""`（空） |
   * | `D6BF9EB2` | —（无） | `839684` | `""`（空） |
   * | `A3C56DD6` | `7c54a9a…`（UUID） | `839684` | `""`（空） |
   *
   * ⇒ 有两个**互不相通**的 id 空间：UUID（账号主键，服务端 `user-profile`
   *    也用它）与 `numericUserId`（JWT 的 `user_id`，纯数字）。
   *    「字段优先、JWT 兜底」会让前两条落到 `839684`、第三条落到 UUID
   *    ⇒ **分裂成两组，一条都去不掉**（用户二次报障「怎么还是在啊」）。
   *
   * ## 定稿做法：先用服务端把 UUID **补齐**，再按 UUID 去重
   *
   * 1. 逐条 ref 调 `user-profile`（实测三条都能拿回同一个 UUID）把
   *    `user_id` 字段**写回凭据** —— 这一步同时修好了「老凭据缺字段」；
   * 2. 补齐后全池统一按 `user_id`（UUID）分组去重。
   *
   * ⚠️ **异步、不阻塞启动**：`void` 而非 `await`。补齐要走 N 次网络，
   *    等它会让插件启动慢一拍；失败也只记 warn（自愈是尽力而为）。
   * ⚠️ **只对 autoclaw 启用**：其他渠道的 `access_token` 会轮换，
   *    拿它去重会把**不同账号误合并**。这是按渠道逐个放开的白名单。
   * ⚠️⚠️ `void` 起**必须挂 `.catch`**（双保险）：函数内部已对读池与逐条
   *    失败各自兜底，但「`void` 一个 async 函数」本身就是未捕获 rejection 的
   *    入口 —— 将来有人在函数里加一条会抛的新腿，这里仍能兜住并留下日志。
   */
  void autoclawSelfHeal(pool, ctx).catch((error: unknown) => {
    ctx.logger?.warn?.(
      `[autoclaw] 账号自愈失败（不影响启动）：`
      + `${error instanceof Error ? error.message : String(error)}`,
    )
  })

  /**
   * ★★ **共享余额读数缓存**（2026-10-15 规格 §5.7；2026-10-16 起 loomy 也接入）——
   * 本进程**唯一**的一份。
   *
   * ## ⚠️⚠️ 为什么必须建在**这里**（位置不变式）
   *
   * 消费者有三处，定义顺序不能变：
   * ① loomy 选号器（`loomyBalanceSelector`，约在本段之后）—— 2026-10-16 新增；
   * ② `credits.balances` 端点（经 `registerBalanceCache` 的进程级注册位）；
   * ③ 聚合折算（`sharedExpiryProbe` 的 `balanceOf`）。
   *
   * ⚠️ 我第一版把它留在文件后段（`sharedExpiryProbe` 旁边）⇒ ① 会读到
   *   **尚未初始化的 `const`**（TDZ）—— `tsc` 不报错（`const` 在模块作用域
   *   有块级作用域，闭包里引用合法），只在 loomy 首次选号时抛
   *   `ReferenceError`。⇒ 位置本身就是一条不变式，登记在此。
   *
   * ## 谁在用它（各有各的取舍）
   *
   * | 消费者 | 传哪些账号 | 为什么 |
   * |---|---|---|
   * | `credits.balances` 端点（积分面板 / 徽标） | **全部**账号（含停用 —— 既有语义） | 用户要在同一个列表里看到每个账号还剩多少 |
   * | loomy 选号（余额分档） | **候选**账号（已过滤 enabled/限流） | 不该用没资格的号去推断整体 |
   * | 聚合折算（buddy 系四家） | **可用**账号 | 不可用的账号本来就不该参与候选 |
   *
   * ⇒ 「谁该被读」是**调用方的取舍**，「同一账号的读数在 TTL 内复用」才是本缓存
   * 提供的**基础设施**（用户 2026-10-15 的更正原话见 `balance-cache.ts` 模块头）。
   *
   * ⚠️⚠️ **必须是同一个实例**：两次 `createBalanceCache` 会让同一个账号被查两次
   *（那正是本模块要消除的），且 `clear` 也得分两次 —— 与 `sharedExpiryProbe` 那条
   * 「初版内联导致两份缓存」的真实缺陷**同型**。
   *
   * ⚠️ TTL 120 秒（规格 §5.7.4-3 的诚实登记）：聚合是**多候选回落**结构，
   *   陈旧 60 秒的代价是「多一次失败尝试后回落」（用户看不到失败），换来上游
   *   请求不翻倍；面板侧有 5 分钟重探与手动 `force` 兜底。
   *
   * ⚠️ 陈旧兼顶上界 15 分钟（`staleTtlMs`）：用户 2026-10-16 要求
   *   「拿不到新数据就读旧数据」，但必须有上界 —— 见 `balance-cache.ts` 的注释。
   */
  const balanceCache = createBalanceCache({
    ttlMs: 120_000,
    failureTtlMs: 15_000,
    // ⚠️ 中止判据**复用**适配器导出的共享实现（它含 `code: 'ABORTED'` 与 499 报文
    //    两条腿）—— 不要在装配层再写一份（本仓库已有 4 份同义实现，别再添第五份）。
    isAbort: (error) => isAbortLikeError(error),
    fetch: (provider, entry) => fetchBalanceReading(pool, provider, entry),
  })
  // ⚠️ 注册到**进程级**注册位：`credits.balances` 端点拿不到本函数的局部变量
  //   （`registerJetHubRpc` 的 4 形参不变式不许加第 5 个），故走与
  //   `ProviderRuntime.credits` 同一张表（见 `provider-runtime.ts` 的说明）。
  //   ⚠️ 未注册 ⇒ 端点回退到自己的原路径（行为与升级前一致）—— 那是刻意的降级。
  registerBalanceCache(balanceCache)

  /**
   * ★★ **余额缓存的后台刷新器**（2026-10-18，Task 2）。
   *
   * ## 为什么必须有它（用户原话）
   *
   * 「这个 2 分钟是 interval 不是 timeout」—— 原实现是 cache-aside（读驱动），
   * 而读路径在提交 `a725101` 之后陈旧命中**一个请求都不发** ⇒ 没有任何东西会再取
   * 新数据 ⇒ 缓存会永远陈旧。本刷新器补上「后台保鲜」那一半。
   *
   * ## ⚠️ 位置不变式
   *
   * 必须建在 `balanceCache` **之后**：它要拿缓存实例（与上面那条位置不变式同源）。
   *
   * ## ⚠️ 凭据必须**在装配层解析**
   *
   * `fetchBalanceReading`（本文件下方）在 `entry.credential === undefined` 时
   * 直接抛「凭据未提供」⇒ 刷新器若传空 entry，**每一轮都被记成失败读数**
   * （外面看「刷新器在跑」，实则永远拿不到新值 —— 零报错的恒绿形态）。
   * ⇒ 这里按 `credentialRef` 解析（与 `jet-hub-rpc.ts` 的
   *   `resolveCredentialForCache` **同款**口径）；解析失败返回 undefined，
   *   刷新器据此**跳过**该账号（那一枪必然失败，纯浪费）。
   */
  const balanceRefresher = createBalanceRefresher(balanceCache, {
    // ⚠️ `listAllAccounts()` 实测是 **async**（`src/account-pool.ts:1308`）；
    //    刷新器内部一律 `await`，直接传引用即可。
    // ⚠️ 传**全部**账号（含停用）：停用只影响自动选号（仓库铁律「续期不得按
    //    `enabled` 过滤」），凭据仍需保鲜 —— 由刷新器自己判低频节奏。
    listAccounts: () => pool.listAllAccounts(),
    resolveCredential: async (refName) => {
      const resolved = await ctx.credentials.resolve(credentialRef(refName))
      if (resolved === undefined) return undefined
      try {
        return JSON.parse(resolved.value)
      } catch {
        return undefined
      }
    },
    // ⚠️ **引用常量、不要重打 `60_000`**（2026-10-18 复审 Minor 修正）：
    //    装配层与 `createBalanceRefresher` 各写一份同一个字面量，等于把
    //    `DEFAULT_STALE_TTL_MS` 刚消灭掉的那类重复又引入了一次。
    //    ⚠️ **理由（别丢）**：周期 = 共享缓存 `ttlMs`(120s) 的**一半** ——
    //    周期恰等于 `ttlMs` 时条目在刚过期那一刻才被刷，读路径仍会频繁撞上
    //    「陈旧且后台刚开始刷」，常新目标落空；取一半 ⇒ 任何时刻至少有半个周期余量。
    intervalMs: REFRESH_PERIOD_FALLBACK_MS,
    // ⚠️⚠️ **日志必须接上**：刷新器把失败吞掉并记日志（后台没有调用方可通知）
    //    ⇒ 不接 logger 就是**完全静默**：面板只显示「查询失败」，用户与维护者
    //    都看不到「后台刷新器压根没在刷」。这两行同时是接线守卫的判据落点。
    info: (message) => ctx.logger?.info?.(message),
    warn: (message) => ctx.logger?.warn?.(message),
  })
  // 生命周期挂 `ctx.effect`，与插件一致（释放后停手）—— 与既有 `modelsDevTimer`、
  // `startCatalogPrewarm` 同款约定。
  ctx.effect(() => {
    balanceRefresher.start()
    return () => { balanceRefresher.stop() }
  })

  // CodeArts 目录的**各来源成败**出参（issue IKJVTF 复审，审计 I3）：
  // `service.refreshModels` 每轮原地写入，适配器的 `catalogComplete` 读它。
  // 初值两个 false —— 在首轮真正拉取之前，**没有**任何来源可算「取到」。
  service.lastCatalogOutcome = { gatewayOk: false, builtinOk: false }

  // 「已失效模型」剔除：注入 ctx 只为把日志接进 DSH logger 并复用同一份 home
  // 解析。必须在任何 `registerXxxLlm` 之前调用 —— 各适配器经
  // `registerAdapterIdempotent` 注册时就会包装上剔除逻辑（见该函数注释）。
  configureDeadModelStore(ctx)

  // ===== Token 账本持久化（第 2 期 · 日聚合落盘）=====
  //
  // ⚠️ 账本本体是模块级单例（`token-ledger.ts`），没有 ctx 可拿 —— 故在启动时
  // 把后端挂进去（`attachTokenLedgerStore`）。挂载发生在**任何适配器注册之前**：
  // 启动早期就有模型请求（标题生成等）时，落盘已在位。
  //
  // ⚠️ 后端契约是**绝不抛错**（`recordTokenUsage` 的调用点在推理关键路径上，
  // 见其函数注释），`FileLedgerStore` 内部已按此实现。
  //
  // ⚠️ dispose **必须用返回的 disposer**（不能无条件 `attach(undefined)`）：
  // 插件 fiber 重启时新 apply 与旧 fiber 的异步 dispose **交错执行**
  //（本仓库已确证的事故，见 `llm-register-compat.ts` 模块头），无条件摘会把
  // **新实例刚挂上**的后端摘空 ⇒ 落盘停摆且历史视图恒为空。disposer 自带所有权
  // 校验（只摘自己的），并顺带 `flush` 当前这份数据。
  const tokenLedgerStore = createTokenLedgerStore(ctx)
  const detachTokenLedger = attachTokenLedgerStore(tokenLedgerStore)
  ctx.effect(() => () => {
    try {
      tokenLedgerStore.flush()
    } finally {
      detachTokenLedger()
    }
  }, 'token-ledger-persistence')

  // WorkBuddy provider 已从中国版（copilot.tencent.com）改造为国际版
  // （www.workbuddy.ai）。旧账号存的是中国版凭据，其 token.domain 指向旧端点，
  // 用新 endpoint 发请求必然失败且会一直续期失败，故启动时清理掉。
  //
  // ⚠️⚠️ 判据**不是**「凭据 domain ≠ 产品 apiDomain」（那会误删合法账号，见
  // `pruneAccountsWithForeignDomain` 的注释），而是「domain 确证属于**其它**产品」：
  // 故这里必须把**别的产品的已知域**传进去，否则函数无从判断「失配」。
  // 未知域一律保留 —— 跨机导入的账号 / 上游新增 realm 主机都不该被静默删除。
  const foreignBuddyDomains = ALL_PRODUCTS
    .filter(product => product.id !== WORKBUDDY.id)
    .flatMap(product => [...(product.knownDomains ?? [])])
  void pool.pruneAccountsWithForeignDomain(WORKBUDDY, foreignBuddyDomains).then((removed) => {
    if (removed.length > 0) {
      // ⚠️ 用 `warn` 而不是 `info`：这是**删除用户数据**的动作。原先记 `info`，
      // 与「账号自己没了、日志里什么都没有」的报障形态同型（对抗审计指出）。
      ctx.logger.warn(
        `[jet-hub] 已清理 ${removed.length} 个 WorkBuddy 旧版（中国版）账号，请重新登录：${removed.join(', ')}`,
      )
    }
  }).catch((error: unknown) => {
    ctx.logger.warn(`[jet-hub] 清理 WorkBuddy 旧版账号失败：${String(error)}`)
  })

  // ⚠️ **CodeArts 不注册任何斜杠命令**（`codearts-login` / `codearts-status` /
  // `codearts-refresh` 三个已删除）：登录、状态与续期统一在 Jet Hub 设置页完成，
  // 与 buddy / workbuddy / lobsterai / qoder / trae 的既有做法一致。
  const codearts = registerCodeArtsLlm(ctx, {
    credentialRef: credentialRef(CODEARTS_CREDENTIAL_REF),
    resolveCredential: async () => {
      // CodeArts **只认账号池**，与其余五个 provider 一致。
      //
      // ⚠️ 早期它额外支持「单凭据模式」（`CODEARTS_ACCESS_TOKEN`）：登录后把凭据
      // 写到那个固定 ref，适配器在账号池取不到时回退去读它。该模式**已移除** ——
      // 登录入口只有 Jet Hub 设置页，凭据一律写入 `CODEARTS_ACCOUNT_XXX`，
      // 固定的 `CODEARTS_ACCESS_TOKEN` 不会再被写入或读取。
      //
      // 这里仍保留 `credentialRef` 选项，仅为满足适配器契约与报错文案
      // （其余 provider 同样传各自的默认 ref，但都不再作为回退来源）。
      const available = await pool.getAvailableAccount<CodeArtsCredential>('codearts', '')
      return available?.credential
    },
    // 续期按**账号池里的具体账号**走：`refreshAccountCredential` 读写的是
    // `CODEARTS_ACCOUNT_XXX`，而旧的 `service.refresh()` 读写的是已废弃的
    // 单凭据 ref —— 那会刷到另一个（不存在的）凭据上。
    refresh: async () => {
      const available = await pool.getAvailableAccount('codearts', '')
      if (available) await service.refreshAccountCredential(available.entry.credentialRef, pool, available.entry.id)
    },
    fetchRemoteModels: () => service.refreshModels(pool),
    // ⚠️ 完整性桥接（issue IKJVTF 复审，审计 I3）：CodeArts 的目录来自**两个**
    // 独立端点（gateway/config + snap builtin），`refreshModels` 会把各来源成败
    // 原地写进 `service.lastCatalogOutcome`。适配器据此判「这次目录完不完整」
    // —— 残缺时只展示、不永久缓存，冷却到期后可补齐。
    catalogComplete: () => {
      const outcome = service.lastCatalogOutcome
      return outcome === undefined ? undefined : isRemoteCatalogComplete(outcome)
    },
    accountPool: pool,
  })

  // ===== Buddy (腾讯 CodeBuddy) 服务 =====
  // 不注册斜杠命令：登录/状态/续期都在 Jet Hub 设置页完成（多账号 + 账号池），
  // 命令式的单凭据入口已无必要。

  /**
   * 按凭据 ref 解析 buddy 系凭据（CodeBuddy 与 WorkBuddy **共用这一个函数**）。
   *
   * 两站凭据同构（同一 CLI 内核、同一认证协议），差别只在 endpoint；
   * 解析这件事与 endpoint 无关，故不写两份。
   */
  const resolveBuddyCredentialByRef = async (refName: string): Promise<BuddyCredential | undefined> => {
    const resolved = await ctx.credentials.resolve(credentialRef(refName))
    if (!resolved) return undefined
    try {
      return JSON.parse(resolved.value) as BuddyCredential
    } catch {
      return undefined
    }
  }

  /**
   * 两个 buddy 各自的**按到期分档选号器**（各自一份余额缓存，绝不串味）。
   *
   * ⚠️ **为什么需要它**：一个 buddy 账号常同时持有多种资源包（实测 WorkBuddy
   * 每个号都有「Bonus Pack（14 天到期）」+「Free Plan Subscription（扣费截止
   * 8 年后）」），而**服务端扣哪个包不由插件决定**。插件能决定的只有「用哪个号」：
   * 优先用还有「15 天内到期积分」的号（那部分再不用就作废），只剩长期积分的号
   * 排最后 —— 与「锁定永久积分」配套（锁定时后者直接判不可用）。
   *
   * 判据出处见 `buddy-balance-rank.ts`（为什么是 15 天、为什么用 DeductionEndTime
   * 而不是 CycleEndTime / ExpiredTime，都有实测对照）。
   */
  const buddyBalanceSelector = new BuddyBalanceSelector({
    product: CODEBUDDY,
    resolveCredential: resolveBuddyCredentialByRef,
  })
  const workbuddyBalanceSelector = new BuddyBalanceSelector({
    product: WORKBUDDY,
    resolveCredential: resolveBuddyCredentialByRef,
  })

  /**
   * 在「候选为空、即将退到单凭据 ref」这一刻，先证明失败原因是不是**限流**。
   *
   * ## 它修的是什么（真实缺陷，2026-10-03）
   *
   * 用户报障：`/compact` 连续四次报
   * 「Compaction could not produce a useful summary」，会话日志里 `compaction/end`
   * 携带的真实错误却是 `buddy: no usable credential; log in from the Jet Hub
   * panel first` —— 而当时 Jet Hub 里 buddy 账号**已登录、已启用**，只是它被
   * `deepseek-v4.1-flash` 的模型级限流标记挡住（解禁时刻就在
   * `modelRateLimits` 里）。
   *
   * 链路：唯一的启用账号被限流 → 候选筛成空集 →
   * `select()` 只能回一个笼统的 `exhausted`（`reason` 在未锁定时被丢弃）→
   * 退到单凭据 ref `BUDDY_ACCESS_TOKEN`，而 Jet Hub 登录只写
   * `BUDDY_ACCOUNT_XXX`、该 ref **根本不存在** → 适配器抛 `MISSING_CREDENTIAL`。
   *
   * 即：**凭据问题被误报成「没登录」，而真实原因是限流**。用户据此去重新
   * 登录，方向完全错。这与本仓库已记录的同类病根一致 —— 用默认归类代替了
   * 对业务语义的判断（qoder 的 `110` 被误归 `SERVER`、`10605` 排队被漏判）。
   *
   * ⚠️ 这里**只改错误语义，不改可用性**：没有账号可用就是没有，压缩该失败
   * 仍然失败；修的是「用户看到的原因」。绝不静默换模型、也绝不绕过限流标记。
   *
   * ⚠️ **但「不改可用性」对 zcode 不成立** —— 正因如此，zcode **刻意不接**这条：
   * 其余各家的兜底读的是 Jet Hub 登录路径下**从不被写入**的 `*_ACCESS_TOKEN`，
   * 判定抛错时那条路本就取不到东西；而 zcode 的兜底 `zcode.current()` 会**再读
   * 一次账号池**且不看 `enabled`、仍能返回凭据 —— 加判定会把本来能跑通的一发
   * 变成硬失败。完整实测见 zcode 注册处那条注释。
   *
   * @param product - 目标 provider（用其 `id` 与 `displayName`）。**只要求这两个字段**：
   *   除 buddy / workbuddy 外，cline 也接这条（它同样会因模型级限流被挡住，
   *   而 `ClineProduct` 与 `BuddyProduct` 是两个类型）。
   * @param modelId - 本次请求的模型；空串时不做判定（与选号侧约定一致）。
   * @throws LlmError 带 `QUOTA_EXCEEDED` 码与解禁时刻，仅当**所有**启用账号
   *   都在该模型上受限时；其余情形静默返回，交给原有的 `MISSING_CREDENTIAL`。
   */
  const throwIfAllAccountsRateLimited = (
    product: { id: string; displayName: string },
    modelId?: string,
  ): void => {
    const limited = allAccountsRateLimitedForModel(
      // 只统计**启用**账号：停用账号本就不参与自动选号，把它们算进来会
      // 让「有一个号被停用」的普通情况被误报成「全部限流」。
      pool.listAccountsByProvider(product.id).filter(a => a.enabled),
      modelId ?? '',
    )
    if (limited === undefined) return
    throw new LlmError(
      `${product.displayName}：模型 ${modelId} 的可用账号均在限流中，`
      + `最近一个将于 ${new Date(limited.resetAtMs).toLocaleString('zh-CN')} 解禁。`
      + `可改用其它 provider / 模型，或等待解禁后再试（无需重新登录）。`,
      'QUOTA_EXCEEDED',
    )
  }

  /**
   * 「锁定永久积分 + 无可用账号」的报错文案（buddy / workbuddy / lobsterai / trae 共用）。
   *
   * ## ⚠️ 必须**分四种原因**报（与 Loomy 那条同型缺陷）
   *
   * 把「余额查询失败（一次网络抖动）」混成「额度已用尽」，用户会去解锁、
   * 或白等到明天 —— 而号其实有钱。故 `kind === 'unknown'` 单独一条文案。
   *
   * 同理，`kind === 'no-candidates'`（**一个候选都没筛出来**，余额分档压根
   * 没跑）也绝不能报「积分都已用尽」：那是在替服务端断言一件我们从没查过的
   * 事（真实报障 2026-10-13，CodeBuddy：`明明有积分却显示不可用`）。
   * ⚠️ 全被模型限流这一支已在 `credential-resolver.ts` 用
   * `throwIfAllRateLimited` 提前拦下（报出解禁时刻），故走到本分支的
   * `no-candidates` 主要是「没有任何启用中的账号」——但文案仍**并列**两种
   * 可能，不把话说死：判定本身依赖 `throwIfAllRateLimited` 被接线，
   * 谎报一个确定原因会把用户指向错误的方向。
   *
   * ⚠️ `kind === 'credential-only'`（**余额分档确实选出了有可用积分的号，
   * 只是那些号的凭据读不出来**）同样**绝不能**报「积分都已用尽」——
   * 那是**自相矛盾**（分档刚证明它有钱），且会把用户推向「解锁永久积分」
   * （不可撤回地烧钱）。这是 2026-10-14 审计实测打穿的漏网路径：
   * `pickBuddyAccount` 的 `reason` 在「候选非空但凭据全坏」时曾保持 `undefined`，
   * 被调用方的 `?? { kind: 'exhausted' }` 兜成「已用尽」。
   * 该文案必须**正向点名凭据**，并**明确劝阻解锁**。
   *
   * ## 为什么抽成函数而不是四家各写一遍
   *
   * 四家的文案**逐字相同**，只有 `displayName` 不同（`buddyExpiringWindowDays()`
   * 也在运行时解析，以便用户改窗口后文案跟着变）。各写一遍 = 改一处漏三处。
   *
   * @param displayName - 产品名（用户据此知道去哪个面板解锁）。
   */
  const buddyLockedError = (displayName: string) =>
    (reason: BuddyNoAccountReason): Error => {
      const days = buddyExpiringWindowDays()
      if (reason.kind === 'unknown') {
        return new Error(
          `${displayName}：无法确认是否有可用账号。已锁定永久积分，而部分账号的余额查询失败`
          + `（${reason.errors.slice(0, 2).join('；')}）。这些账号**可能仍有**「${days} 天内到期」`
          + '的积分 —— 请重试，或在 Jet Hub 对应面板检查凭据是否失效。',
        )
      }
      if (reason.kind === 'no-candidates') {
        return new Error(
          `${displayName}：没有可用账号。已锁定永久积分，而本次**没有任何候选账号**`
          + '（该 provider 下没有启用中的账号，或全部账号都在本次请求的模型上受限）。'
          + `请在 Jet Hub 的 ${displayName} 面板确认账号已启用、且未全部处于限流中；`
          + '或改用其它 provider / 模型，或解锁永久积分后重试。',
        )
      }
      if (reason.kind === 'credential-only') {
        // ⚠️ **必须与「积分用尽」逐字分开**，且要**明确劝阻解锁**：解锁会不可
        //    撤回地烧掉永久积分，而本情形的根因在凭据、与积分无关。
        return new Error(
          `${displayName}：无法使用任何账号。已锁定永久积分，而余额分档**确实选出了**`
          + '有可用积分的账号 —— 但它们的**凭据读不出来**（凭据缺失 / 已失效 / 被并发续期覆盖）。'
          + '⚠️ 这与「积分用尽」是两件事，**不要去解锁永久积分**（解锁会不可撤回地烧掉它们）。'
          + `请在 Jet Hub 的 ${displayName} 面板检查这些账号的凭据，必要时重新登录。`,
        )
      }
      /**
       * ⚠️⚠️ **穷尽性守卫**（2026-10-14 审计新增）：走到这里**只允许**是
       * `{ kind: 'exhausted' }` —— 它是**唯一**有事实依据可以说「积分用尽」的一档
       * （余额分档真的查过，且每个候选的可用积分都确实是 0）。
       *
       * 这里以前是**裸 `return`** 当兜底。将来给 `BuddyNoAccountReason` 再加一档时，
       * 它会**静默**落进「积分都已用尽」的文案 —— 而那句文案会把用户推向
       * 「解锁永久积分」（**不可撤回地烧钱**）。本 PR 修的 `no-candidates` 正是
       * 这个形态（它曾落进这里），故补一道**编译期**闸门，不再靠人记得改文案。
       *
       * 判据：把 `reason` 赋给**只剩 `exhausted` 那一档**的类型。若上面少接住一档
       * （`reason` 的联合里多出别的成员），`tsc` 当场报 `TS2322`
       * （联合类型不可赋给单成员类型），而不是静默退回「已用尽」文案。
       */
      const exhaustedOnly: { kind: 'exhausted' } = reason
      void exhaustedOnly
      return new Error(
        `${displayName}：没有可用账号。已锁定永久积分，而所有账号的「${days} 天内到期」`
        + '积分都已用尽。请在 Jet Hub 的 '
        + `${displayName} 面板解锁永久积分，或等待资源包到期后重新发放额度。`,
      )
    }

  /**
   * Qoder（`qoder` 国际版 / `qodercn` 中国版）的
   * 「锁定永久积分 + 无可用账号」报错文案。
   *
   * ⚠️ **不是漏抽 `buddyLockedError`，而是本家口径**必须**不同**：buddy 系的
   * 「临期」指服务端**资源包**（`DeductionEndTime`），而 Qoder
   * **逐包到期时刻根本拿不到**（见下）。照抄它会让用户按一个**在本家不存在**
   * 的判据去排查。
   *
   * ## ⚠️⚠️ 本家最关键的事实：**Qoder 的「临期桶」恒为 0**
   *
   * 这是本函数每一档文案都必须自洽的前提，先说清机制：
   *
   * | 事实 | 取证来源 |
   * |---|---|
   * | 上游只下发**聚合标量**（`userQuota` / `addOnQuota` 各一个 `total/used/remaining`），**没有逐包明细** | `/sash/api/v2/me/usage` 真机实测（见 `qoder-credits.ts` 文件头） |
   * | 逐包明细端点**不可用**：`/api/v1/me/quotas/{key}/histories`、`/api/v1/me/usages/big_model_credits/histories` 在 **qoder.cn 域 401**（只对浏览器登录态开放）、在 **openapi 域 404**；`/sash/*` 逐包端点全 404 | 2026-10-20 端点探测 |
   * | `usage.expiresAt` 是**永久哨兵**（`253402214400000` = `9999-12-31`），**不是**真实到期时刻 | 真机实测（同上） |
   * | 本机账号 `dedicatedResourcePackages` = `undefined`（那一路径目前取不到任何带日期的包） | 真机实测 |
   * | 到期**语义**是「领取后 30 天」（`benefit.validity = {mode:'RELATIVE_DAYS', days:30}`），但那是**活动声明**，不是某个包的**时刻** | `/sash/api/v1/me/campaigns` 真机实测 |
   *
   * ⇒ 聚合侧 `toPackage` 对**拿不到时刻**的包**不写 `deductionEndTime`**，
   * 于是 `splitBuddyCreditsByExpiry` 按**保守方向**把它们全归入**永久桶**：
   * **expiring 恒为 0**。锁定永久积分时，这样的账号一定被判 `none`（不可用）——
   * 这是**正确**行为（我们确实只能证明它只有永久积分）。
   *
   * ## 由此推出两条**文案纪律**（违反即误导）
   *
   * 1. **不得写「N 天内到期」「15 天内」这类绑定天数的说法**。Qoder 拿不到
   *    逐包时刻，任何天数都是**编造**；宿主的窗口（`buddyExpiringWindowDays()`，
   *    默认 15 天、可被 `DSH_BUDDY_EXPIRING_WINDOW_DAYS` 覆盖）对本家**不产生
   *    任何筛选效果**，写进文案只会让用户以为「等几天就会有临期额度可用」。
   *    ⚠️ 注意前端 `permanentLockCopy` 那一侧因为 registry 的
   *    `usesExpiryWindow: true` 会渲染出**带天数**的通用面板文案 —— 那是面板
   *    对「按到期分桶」这一能力的统一表述，**与本函数无关**；本函数是**真出
   *    故障时**用户看到的那句，必须写实际机制。
   * 2. **必须明说「解锁才能继续用」**。因为本家的临期桶恒为 0，
   *    「等一会儿就有临期额度」是**不可能发生**的事 —— 用户唯一的下一步是
   *    解锁（会消耗长期/永久积分，须如实告知）。
   *
   * ## 四档（与 buddy 同形，但措辞逐档按本家重写）
   *
   * `unknown` / `no-candidates` / `credential-only` / `exhausted`
   * —— 四者的**必要性**见 `BuddyNoAccountReason` 的定义注释，不在本处重复。
   *
   * ⚠️ **两站共用本函数，只换 `displayName`**：两站协议与端点形状逐字相同
   *（同一个 `QoderAdapter` 类、同一个 `fetchQoderCreditBalance`，差异全在
   * `QODER` / `QODER_CN` 的主机与 client_id），各写一遍 = 改一处漏一处。
   * 但 `displayName` **必须**逐站区分：两站账号不互通，用户要知道去哪个面板解锁。
   *
   * ⚠️ **本家没有 XFF / 地理分流问题**（与 MiniMax 国际站的关键差异）：
   * Qoder 两站各自有独立域名且互不 307，故**不要**照抄 minimax 文案里那段
   * 「填 `X-Forwarded-For`」的指引（照抄会让用户去改一个**不生效**的设置）。
   *
   * ⚠️ **错误码取 `QUOTA_EXCEEDED`**（与 buddy / Loomy 一致）：
   * 这确实是额度问题；且它**不在**宿主 `DEFAULT_RETRYABLE_CODES` 里，
   * 故不会被白重试 —— 锁定是**确定性**结果，重试无用。
   */
  const qoderLockedError = (displayName: string) =>
    (reason: BuddyNoAccountReason): Error => {
      if (reason.kind === 'unknown') {
        return new LlmError(
          `${displayName}：无法确认是否有可用账号。已锁定永久积分，而部分账号的余额查询失败`
          + `（${reason.errors.slice(0, 2).join('；')}）。`
          + '这些账号**可能仍有**可消耗的额度 —— 请重试，'
          + `或在 Jet Hub 的 ${displayName} 面板检查凭据是否失效`
          + '（Qoder 的凭据有有效期，失效后需要重新登录该账号）。'
          + '⚠️ 国际版（`openapi.qoder.sh`）本机网络不通时会**每次都**查不到余额，'
          + '若你用的是国际版请先确认该域名可达。',
          'QUOTA_EXCEEDED',
        )
      }
      if (reason.kind === 'no-candidates') {
        return new LlmError(
          `${displayName}：没有可用账号。已锁定永久积分，而本次**没有任何候选账号**`
          + '（该 provider 下没有启用中的账号，或全部账号都在本次请求的模型上受限）。'
          + `请在 Jet Hub 的 ${displayName} 面板确认账号已启用、且未全部处于限流中；`
          + '或改用其它 provider / 模型，或解锁永久积分后重试。',
          'QUOTA_EXCEEDED',
        )
      }
      if (reason.kind === 'credential-only') {
        // ⚠️ **必须与「积分用尽」逐字分开**，且要**明确劝阻解锁**：解锁会不可
        //    撤回地消耗长期积分，而本情形的根因在凭据、与积分无关。
        return new LlmError(
          `${displayName}：无法使用任何账号。已锁定永久积分，而余额分档**确实选出了**`
          + '有可用额度的账号 —— 但它们的**凭据读不出来**（凭据缺失 / 已失效 / 被并发续期覆盖）。'
          + '⚠️ 这与「额度用尽」是两件事，**不要去解锁永久积分**（解锁会不可撤回地消耗它们）。'
          + `请在 Jet Hub 的 ${displayName} 面板检查这些账号的凭据，必要时重新登录。`,
          'QUOTA_EXCEEDED',
        )
      }
      /**
       * ⚠️⚠️ **穷尽性守卫**（与 buddy / Loomy 两份同型）：
       * 走到这里**只允许**是 `{ kind: 'exhausted' }`。把 `reason` 赋给单成员类型，
       * 将来 `BuddyNoAccountReason` 加了新档位却忘写文案时，`tsc` 当场报
       * `TS2322`，而不是静默落进「额度都已用尽」—— 那句会把用户推向
       * **不可撤回**的解锁操作。
       */
      const exhaustedOnly: { kind: 'exhausted' } = reason
      void exhaustedOnly
      /**
       * ⚠️⚠️ **本档文案已按事实重写**（2026-10-21 对抗性审计发现：原文案与代码行为**相反**）。
       *
       * ## 原文案错在哪
       *
       * 旧文案逐字声称：
       * > 「Qoder 上游**只下发聚合额度、不给逐包到期时刻**，插件因此**无法确认**
       * >  哪些额度是临期的」
       * > 「说「等临期积分到期后重新发放」会让用户白等（**本家根本没有那个临期池**）」
       *
       * **两句都不成立**：`qoder-credits.ts` **确实**解析
       * `dedicatedResourcePackages[].expiresAt` 并写进 `deductionEndTime`
       *（支路 B，`e1d9bf1` + `1e1b6bb` 还专门加了旗标/哨兵判据）⇒
       * 一旦上游下发该字段，插件**完全能确认**哪些额度是临期的。
       *
       * 实测反例（构造报文，本机）：
       * ```
       * dedicatedResourcePackages: [{ remaining: 800, expiresAt: NOW + 60d }]
       * → split = { expiring: 0, permanent: 2500 }
       * ```
       * 该账号被判 `none`（正确，60 天后才到期、超出 15 天窗口），但**再等约 45 天**
       * 这个包就会自己进入临期档、账号自动恢复可用 ——「白等」这句恰好说反了：
       * 用户等下去**真的会**有临期额度。
       *
       * ## 为什么原文案会写成那样
       *
       * 它把「**本机两个账号**的 `dedicatedResourcePackages` 恰好是 `undefined`」
       * （一个**样本偶然**）写成了「上游**从不**下发」（一个**通用前提**）。
       * 这正是本仓库反复登记的那类错误：**样本缺失 ≠ 字段不存在**。
       *
       * ## 新文案的口径（三条纪律）
       *
       * 1. **不声称「拿不到逐包到期」** —— 拿到了就用；没拿到才落永久桶。
       * 2. **不写死天数**：15 天窗口可被 `DSH_BUDDY_EXPIRING_WINDOW_DAYS` 覆盖，
       *    写死数字会在用户改配置后自相矛盾。
       * 3. **必须给出「解锁」这条确定的出路**（这是唯一能立即恢复的操作），
       *    同时**如实提示**「若你的账号有带到期日的资源包，等它进入窗口后会自愈」
       *    —— 那是事实，不是安抚。
       */
      return new LlmError(
        `${displayName}：没有可用账号。已锁定永久积分，而当前账号的额度都属于`
        + '**长期 / 永久**那一类（要么上游没给逐包到期时刻，要么到期日还在'
        + '「临期窗口」之外 —— 窗口默认 15 天，可由 `DSH_BUDDY_EXPIRING_WINDOW_DAYS` 调整）。'
        + '⚠️ 锁定永久积分时，**无法证明有临期额度**的账号会被判为不可用'
        + '（宁可少用一个号，也不要把长期额度误当临期烧掉）—— 这是锁定的**预期效果**。'
        + `请在 Jet Hub 的 ${displayName} 面板**解锁**永久积分后继续使用`
        + '（解锁会真的消耗那些长期/永久额度）；'
        + '若你的账号确实有带到期日的资源包（`dedicatedResourcePackages`），'
        + '等它进入临期窗口后本账号会自动恢复可用，无需其它操作。',
        'QUOTA_EXCEEDED',
      )
    }

  /**
   * AStudio 的「锁定永久积分 + 无可用账号」报错文案。
   *
   * ⚠️ **不是漏抽 `buddyLockedError`**，而是本家口径**必须**不同：
   * buddy 系的「临期」指「服务端资源包 `DeductionEndTime` 距今 < 15 天」，
   * 而 AStudio 的三个池语义是**会员 / 购买 / 赠送（活动）积分**，
   * 只有「赠送积分」实测带 `activityNextExpireTime`（会员与购买两池实测
   * 为 `null`，即长期有效）。用户按 buddy 那句「等待资源包到期后重新发放额度」
   * 去排查会找不到对应的东西。
   *
   * ⚠️ 若将来 `astudio-credits.ts` 的池分类变了（例如会员池也开始下发改期），
   * 本函数里的池名要跟着改 —— 它是**唯一**被用户看到的池名清单。
   *
   * ⚠️ 错误码取 `QUOTA_EXCEEDED`（与 buddy 系一致：这确实是额度问题，
   * 且不会像 `AUTH` 那样在部分客户端把 message 吞掉）。
   *
   * ⚠️ **本函数放在这里（`buddyLockedError` 之后、`loomyLockedError` 之前）是
   *    历史的偶然，不是约束**：它只用 `BuddyNoAccountReason`，与 buddy 三份同族，
   *    放哪都不影响正确性。**不要**为了让某个按位置切片做断言的既有用例通过而
   *    调整本函数的声明顺序 —— 2026-10-20 我一度这么做（那时
   *    `loomy-balance-error-contract.spec.ts` 的 `lockedErrorBody()` 用
   *    `indexOf('const buddy = new BuddyAuth')` 当切片终点，恰好把本函数圈了进去，
   *    于是本家 `QUOTA_EXCEEDED` 被当成 Loomy 的码核对而变红）。
   *    正确修法是**把那条断言的切片终点改精确**（改成「下一个同级 `const`」），
   *    已在该 spec 里改并写明理由。断言描述的是「这个函数用了哪些码」，
   *    不是「这个函数后面跟着谁」。
   */
  const astudioLockedError =
    (displayName: string) =>
    (reason: BuddyNoAccountReason): Error => {
      const days = buddyExpiringWindowDays()
      if (reason.kind === 'unknown') {
        return new LlmError(
          `${displayName}：无法确认是否有可用账号。已锁定永久积分，而部分账号的余额查询失败`
          + `（${reason.errors.slice(0, 2).join('；')}）。这些账号**可能仍有**「${days} 天内到期」`
          + '的积分 —— 请重试，或在 Jet Hub 的 AStudio 面板检查凭据是否失效'
          + '（AStudio 的凭据是本机客户端会话的拷贝，客户端退出登录会让它失效）。',
          'QUOTA_EXCEEDED',
        )
      }
      if (reason.kind === 'no-candidates') {
        return new LlmError(
          `${displayName}：没有可用账号。已锁定永久积分，而本次**没有任何候选账号**`
          + '（该 provider 下没有启用中的账号，或全部账号都在本次请求的模型上受限）。'
          + `请在 Jet Hub 的 ${displayName} 面板确认账号已启用、且未全部处于限流中；`
          + '或改用其它 provider / 模型，或解锁永久积分后重试。',
          'QUOTA_EXCEEDED',
        )
      }
      if (reason.kind === 'credential-only') {
        // ⚠️ **必须与「积分用尽」逐字分开**，且要**明确劝阻解锁**：解锁会不可
        //    撤回地烧掉永久积分，而本情形的根因在凭据、与积分无关。
        return new LlmError(
          `${displayName}：无法使用任何账号。已锁定永久积分，而余额分档**确实选出了**`
          + '有可用积分的账号 —— 但它们的**凭据读不出来**（凭据缺失 / 已失效 / 被并发续期覆盖）。'
          + '⚠️ 这与「积分用尽」是两件事，**不要去解锁永久积分**（解锁会不可撤回地烧掉它们）。'
          + `请在 Jet Hub 的 ${displayName} 面板检查这些账号的凭据；AStudio 没有 OAuth 授权页，`
          + '需要在 AStudio 客户端登录后用「导入本机会话」重建凭据。',
          'QUOTA_EXCEEDED',
        )
      }
      /**
       * ⚠️⚠️ **穷尽性守卫**（与 buddy / Loomy 两份同型）：走到这里**只允许**是
       * `{ kind: 'exhausted' }`。把 `reason` 赋给单成员类型，将来
       * `BuddyNoAccountReason` 加了新档位却忘写文案时，`tsc` 当场报 `TS2322`，
       * 而不是静默落进「积分都已用尽」—— 那句会把用户推向不可撤回的解锁操作。
       */
      const exhaustedOnly: { kind: 'exhausted' } = reason
      void exhaustedOnly
      /**
       * ⚠️⚠️ **本段文案已按代码实际行为重写**（2026-10-21 对抗性审计发现）。
       *
       * ## 原文案错在哪
       *
       * 旧文案把「临期」**唯一归给赠送池**：
       * > 「所有账号的「N 天内到期」积分（AStudio 的**赠送/活动积分**池）都已用尽。
       * >  会员积分与购买积分**通常是长期有效的**，锁定状态下动不到它们。」
       *
       * 而 `astudio-credits.ts` 的三个池（会员 / 购买 / 赠送）**同等地**走
       * `pushPool(...)`，各自把自己的 `{member,buy,activity}NextExpireTime`
       * 归一化进 `deductionEndTime` ⇒ **任何一个池**有窗口内到期都会被算进临期桶。
       *
       * 实测反例（构造报文，本机）：
       * ```
       * { memberBalance: 800, memberNextExpireTime: NOW+4d,
       *   buyBalance: 1000,   buyNextExpireTime: null,
       *   activityBalance: 0 }
       * → split = { expiring: 800, permanent: 1000 }
       *    ↑ 临期 800 **全部来自会员池**，赠送池一分没有
       * ```
       * ⇒ 用户拿着旧文案去「查赠送池」会一无所获，而真正快到期的在**会员池**。
       *
       * ## 旧文案为什么会写成那样
       *
       * 它把「本机实测时会员/购买两池的 `NextExpireTime` 恰好是 `null`」
       * 写成了「通常是长期有效的」这个**通用结论**。同一个错误的另一形态：
       * **样本偶然 ≠ 字段语义**。
       *
       * ## 新文案的口径
       *
       * 1. **三个池平等列出**（会员 / 购买 / 赠送），不猜哪个有到期；
       * 2. 保留 `days`（本家 `usesExpiryWindow: true`，那个天数**确实**是筛选判据，
       *    与 Qoder 不同 —— 那里拿不到逐包时刻、写天数才是编造）；
       * 3. 给出两条出路：解锁（确定可行）／等下一笔活动积分发放（若确因活动池用尽）。
       */
      return new LlmError(
        `${displayName}：没有可用账号。已锁定永久积分，而所有账号的「${days} 天内到期」`
        + '积分都已用尽。⚠️ AStudio 的**会员 / 购买 / 赠送（活动）**三个积分池'
        + '都会各自下发到期时间、都被计入临期判据 —— 不限于赠送池，'
        + '请在该账号的「资源包」明细里逐个核对（而不是只看赠送池）。'
        + `请在 Jet Hub 的 ${displayName} 面板解锁永久积分`
        + '（解锁后长期有效的部分才可用），或等待下一次活动积分发放。',
        'QUOTA_EXCEEDED',
      )
    }

  /**
   * MiniMax Code 的「锁定永久积分 + 无可用账号」报错文案。
   *
   * ⚠️ **不是漏抽 `buddyLockedError`**，而是本家口径**必须**不同：
   * buddy 系的「临期」指服务端**资源包**（`DeductionEndTime`），
   * 而 MiniMax 的到期来自 `/minimax-cloud/api/v1/credit/details` 的
   * **每条明细各自带 `expire_at_ms`**（2026-10-20 实测真实账号 20 条全部有值，
   * 到期时刻 = 发放时刻 + 30 天）。buddy 那句「等待资源包到期后重新发放额度」
   * 在 MiniMax **没有对应物** —— 它的额度来自**每日签到**与活动发放，
   * 用户按 buddy 的口径去排查会找不到那个「资源包」。
   *
   * ⚠️ 两个产品（`minimax` / `minimaxintl`）**共用本函数**，只换 `displayName`：
   * 两站的积分语义与端点形状逐字相同（同一个 `fetchMinimaxCreditBalanceDetailed`，
   * 差异只在 `MINIMAX_INTL` 的主机与 ref 前缀），各写一遍 = 改一处漏一处。
   * 但 `displayName` **必须**逐站区分：两站账号不互通，用户要知道去哪个面板解锁。
   */
  const minimaxLockedError = (displayName: string) =>
    (reason: BuddyNoAccountReason): Error => {
      const days = buddyExpiringWindowDays()
      if (reason.kind === 'unknown') {
        return new LlmError(
          `${displayName}：无法确认是否有可用账号。已锁定永久积分，而部分账号的余额查询失败`
          + `（${reason.errors.slice(0, 2).join('；')}）。这些账号**可能仍有**「${days} 天内到期」`
          + '的积分 —— 请重试，或在 Jet Hub 的对应面板检查凭据是否失效。'
          + '⚠️ **国际站**另有地理分流风险：`agent.minimax.io` 会按出口 IP 把大陆来源'
          + ' 307 到中国站，而中国站不认国际站 token ⇒ 表现为余额查询恒失败'
          + '（issue IKMEVG）；可在面板设置里填 `X-Forwarded-For`。',
          'QUOTA_EXCEEDED',
        )
      }
      if (reason.kind === 'no-candidates') {
        return new LlmError(
          `${displayName}：没有可用账号。已锁定永久积分，而本次**没有任何候选账号**`
          + '（该 provider 下没有启用中的账号，或全部账号都在本次请求的模型上受限）。'
          + `请在 Jet Hub 的 ${displayName} 面板确认账号已启用、且未全部处于限流中；`
          + '或改用其它 provider / 模型，或解锁永久积分后重试。',
          'QUOTA_EXCEEDED',
        )
      }
      if (reason.kind === 'credential-only') {
        // ⚠️ **必须与「积分用尽」逐字分开**，且要**明确劝阻解锁**：解锁会不可
        //    撤回地烧掉永久积分，而本情形的根因在凭据、与积分无关。
        return new LlmError(
          `${displayName}：无法使用任何账号。已锁定永久积分，而余额分档**确实选出了**`
          + '有可用积分的账号 —— 但它们的**凭据读不出来**（凭据缺失 / 已失效 / 被并发续期覆盖）。'
          + '⚠️ 这与「积分用尽」是两件事，**不要去解锁永久积分**（解锁会不可撤回地烧掉它们）。'
          + `请在 Jet Hub 的 ${displayName} 面板检查这些账号的凭据，必要时重新登录。`,
          'QUOTA_EXCEEDED',
        )
      }
      /**
       * ⚠️⚠️ **穷尽性守卫**（与 buddy / Loomy / AStudio 三份同型）：走到这里
       * **只允许**是 `{ kind: 'exhausted' }`。把 `reason` 赋给单成员类型，
       * 将来 `BuddyNoAccountReason` 加了新档位却忘写文案时，`tsc` 当场报
       * `TS2322`，而不是静默落进「积分都已用尽」—— 那句会把用户推向
       * **不可撤回**的解锁操作。
       */
      const exhaustedOnly: { kind: 'exhausted' } = reason
      void exhaustedOnly
      return new LlmError(
        `${displayName}：没有可用账号。已锁定永久积分，而所有账号的「${days} 天内到期」`
        + '积分（MiniMax 的**签到 / 活动发放**额度，每条明细自带 30 天有效期）都已用尽。'
        + '长期有效的部分在锁定状态下动不到它们。'
        + `请在 Jet Hub 的 ${displayName} 面板解锁永久积分，或等待下一次签到 / 活动发放。`,
        'QUOTA_EXCEEDED',
      )
    }

  /**
   * AutoClaw（国内站 / 国际版）的「锁定永久积分 + 无可用账号」报错文案。
   *
   * ⚠️ **不是漏抽 `buddyLockedError`**，而是本家池名**必须**不同：
   * buddy 系的「临期」指**服务端资源包**（`DeductionEndTime`），而 AutoClaw 的
   * 批次来自**钱包流水**（`wallets` + `wallet_expires_at`），且**永久桶按描述分组**
   * （`autoclaw-credits.ts` 的 `permanentByLabel`）—— 上游给什么描述就是什么包名。
   * 照抄 buddy 那句会让用户去钱包里找一个叫「资源包」的东西，而
   * AutoClaw 面板上根本没这个名字。
   *
   * ⚠️⚠️ **本函数文案不得点名具体池名**（2026-10-21 二轮审计，P1）：
   * 初版写过「活动赠送」「注册奖励」，那两个名字**没有任何实测来源**（详见
   * `exhausted` 档的注释）。仓库内实测到的真实包名是
   * 「`AutoClaw 用户登录奖励积分，7天有效`」「`每日签到`」这类**上游原样字符串**，
   * 编一个分组名会让用户照着去找、一无所获。
   *
   * ## 四档（与 buddy / minimax 同形，措辞按本家重写）
   *
   * `unknown` / `no-candidates` / `credential-only` / `exhausted` ——
   * 四者的**必要性**见 `BuddyNoAccountReason` 的定义注释，不在本处重复。
   *
   * ## ⚠️ 与 minimax 的关键差别：**没有 XFF / 地理分流**
   *
   * AutoClaw 两站各有独立域名（国内 `autoglm-api`、国际 `autoglm-api.autoglm.ai`），
   * **互不 307** ⇒ 本家文案**不得**照抄 minimax 那段「填 X-Forwarded-For」的指引
   * （照抄会让用户去改一个**不生效**的设置）。这句已写进 `unknown` 档的反面：
   * 只说「检查凭据」，不说 XFF。
   *
   * ## 错误码取 `QUOTA_EXCEEDED`
   *
   * 与 buddy / Loomy / minimax 一致：这确实是额度问题，且它**不在**宿主
   * `DEFAULT_RETRYABLE_CODES` 里 ⇒ 不会被白重试（锁定是**确定性**结果）。
   *
   * ⚠️⚠️ **但 `unknown` 档存在一处全仓既有的自相矛盾**（2026-10-21 二轮审计指出，登记不修）：
   *
   * 该档文案写「**请重试**」，而错误码 `QUOTA_EXCEEDED` **不可重试** ⇒ 用户按文案
   * 去重试，宿主不会自动重试、手动重试大概率仍是同一失败。
   *
   * 实测全仓口径（`grep` 六份 `lockedError` 的 `unknown` 档）：
   *
   * | 函数 | 码 | 可重试 | 文案 |
   * |---|---|---|---|
   * | `buddyLockedError` / `qoderLockedError` / `astudioLockedError` / `minimaxLockedError` / **`autoclawLockedError`** | `QUOTA_EXCEEDED` | ❌ | 「请重试」 |
   * | `loomyLockedError` | **`TRANSPORT`** | ✅ | 「请稍后重试」 |
   *
   * ⇒ **五家一致、Loomy 独异**。这不是本次引入的回归（本函数只是跟随了多数派），
   *   而是**既有的一致性缺口**。
   *
   * **为什么不修**：改错误码要碰红线 —— `AUTH` / `QUOTA` 类码在部分客户端会
   * **连 message 一起吞掉**（IKLBSH 复发形态），`QUOTA_EXCEEDED` 是刻意选的
   * （`QUOTA` 会被 harness 换成固定文案）。改文案（去掉「请重试」）又要同步五家
   * + 相关断言，属独立任务。⇒ 登记，不捎带。
   *
   * ⚠️ 两站共用本函数，只换 `displayName`；`displayName` **必须**逐站区分
   * （两站账号不互通，用户要知道去哪个面板解锁）。
   *
   * ## ⚠️ 位置约束（与 astudio 那处同理）
   *
   * 本函数放在 `loomyLockedError` **之前**是有意的：`loomy-balance-error-contract.spec.ts`
   * 用「`const loomyLockedError` 到 `const buddy = new BuddyAuth`」切片来核对 Loomy 的
   * 错误码（Loomy 用可重试的 `TRANSPORT`，本家必须用不可重试的 `QUOTA_EXCEEDED`）。
   * 插进那个区间会让该用例把本家的码当成 Loomy 的核对而**必然变红**。
   */
  const autoclawLockedError = (displayName: string) =>
    (reason: BuddyNoAccountReason): Error => {
      const days = buddyExpiringWindowDays()
      if (reason.kind === 'unknown') {
        return new LlmError(
          `${displayName}：无法确认是否有可用账号。已锁定永久积分，而部分账号的余额查询失败`
          + `（${reason.errors.slice(0, 2).join('；')}）。这些账号**可能仍有**「${days} 天内到期」`
          + '的积分 —— 请重试。'
          + `⚠️ 若持续失败，请在 Jet Hub 的 ${displayName} 面板检查凭据是否失效`
          + '（AutoClaw 的 access_token 是**明文 JWT、寿命恒 24h**，过期后需要重新登录）。',
          'QUOTA_EXCEEDED',
        )
      }
      if (reason.kind === 'no-candidates') {
        return new LlmError(
          `${displayName}：没有可用账号。已锁定永久积分，而本次**没有任何候选账号**`
          + '（该 provider 下没有启用中的账号，或全部账号都在本次请求的模型上受限）。'
          + `请在 Jet Hub 的 ${displayName} 面板确认账号已启用、且未全部处于限流中；`
          + '或改用其它 provider / 模型，或解锁永久积分后重试。',
          'QUOTA_EXCEEDED',
        )
      }
      if (reason.kind === 'credential-only') {
        // ⚠️ **必须与「积分用尽」逐字分开**，且要**明确劝阻解锁**：解锁会不可
        //    撤回地消耗永久积分（流水里那些**不带到期时间**的发放批次），
        //    而本情形的根因在凭据、与积分无关。
        return new LlmError(
          `${displayName}：无法使用任何账号。已锁定永久积分，而余额分档**确实选出了**`
          + '有可用积分的账号 —— 但它们的**凭据读不出来**（凭据缺失 / 已失效 / 被并发续期覆盖）。'
          + '⚠️ 这与「积分用尽」是两件事，**不要去解锁永久积分**（解锁会不可撤回地消耗它们）。'
          + `请在 Jet Hub 的 ${displayName} 面板检查这些账号的凭据，必要时重新登录。`,
          'QUOTA_EXCEEDED',
        )
      }
      /**
       * ⚠️⚠️ **穷尽性守卫**（与 buddy / Loomy / AStudio / MiniMax 四份同型）：
       * 走到这里**只允许**是 `{ kind: 'exhausted' }`。把 `reason` 赋给单成员类型，
       * 将来 `BuddyNoAccountReason` 加了新档位却忘写文案时，`tsc` 当场报
       * `TS2322`，而不是静默落进「积分都已用尽」—— 那句会把用户推向
       * **不可撤回**的解锁操作。
       */
      const exhaustedOnly: { kind: 'exhausted' } = reason
      void exhaustedOnly
      /**
       * ⚠️⚠️ **本档文案已按「可核实的池名」重写**（2026-10-21 二轮审计，P1 文案失实）。
       *
       * ## 原文案错在哪
       *
       * 初版写「**永久桶**（**「活动赠送」「注册奖励」** 等不带到期时间的批次）」。
       * 审计员逐层考古后确认：**这两个名字没有任何实测来源**，是编的。
       *
       * 事实链：
       * - `parseAutoclawLedgerBatches` 的包名取 `metadata.description > description > source`，
       *   即**上游给什么就是什么**，可能是任意字符串；
       * - 仓库内**唯一**的实测包名样本是「`AutoClaw 用户登录奖励积分，7天有效`」
       *   与「`每日签到`」（`tests/unit/autoclaw-credits.spec.ts` 的 fixture 注明为实测形状）；
       * - 「活动赠送 / 注册奖励」的最早出处是 `autoclaw-credits.ts` 里**描述代码分支**的
       *   一句注释（「无到期字段的发放（活动赠送的永久分）」），随后经
       *   registry 注释 → 审计报告 → 本次提交 → 本函数文案 **五层转述**，
       *   从未有一次报文支撑。
       *
       * ## 用户可见后果（改前）
       *
       * 用户拿着「去找叫『活动赠送』『注册奖励』的分组」去翻钱包流水，
       * **一无所获**（真实名字是「AutoClaw 用户登录奖励积分，7天有效」这类长句）。
       *
       * ## 改法
       *
       * **不再点名任何具体池名**，改为描述**判据本身**（「流水里不带到期时间的发放」）
       * —— 判据是代码里可核实的，池名不是。
       */
      return new LlmError(
        `${displayName}：没有可用账号。已锁定永久积分，而所有账号的「${days} 天内到期」`
        + '积分（AutoClaw 的**带到期时间的发放批次** —— 钱包流水里那些'
        + '带有效期的「每日签到 / 登录奖励」等发放）都已用尽。'
        + '**永久桶**（流水里**不带到期时间**的那些发放）在锁定状态下动不到它们'
        + ' —— 这是锁定的预期效果。'
        + `请在 Jet Hub 的 ${displayName} 面板解锁永久积分，或等待下一次签到 / 活动发放。`,
        'QUOTA_EXCEEDED',
      )
    }

  /**
   * Loomy 的「锁定永久积分 + 无可用账号」报错文案（issue IKMCOO 缺陷 2/3）。
   *
   * ⚠️ **与 buddy 那份分开**（不是漏抽）：Loomy 的口径是「**今日赠送额度**」
   * （服务端每日刷新的那个池），而 buddy 系是「N 天内到期的资源包」——
   * 两者是不同的业务概念，合并成一句会让用户按错误的判据去排查。
   *
   * ⚠️⚠️ **必须分「全部查不到」与「部分查不到」**（issue IKMCOO 缺陷 2，
   *   2026-10-16）：原实现只有一档 `unknown`，判据是「有任一候选失败」，
   *   于是 **3 个号全查不到**也被报成「**部分**账号的余额查询失败」，
   *   并建议「检查凭据是否失效」—— 而本机实测（4 个账号 `/points/records`
   *   全部 200、字段完整）凭据**全部有效**，照着做完全无效。
   *
   * ⚠️⚠️ **错误码用 `TRANSPORT`，不用自定义码**（issue IKMCOO 缺陷 3，
   *   2026-10-16 实测修正）：原判据里我先写的是新增码 `BALANCE_UNAVAILABLE`，
   *   实读宿主 `@deepseek-ai/dsh-llm/lib/types/retry-policy.js` 的
   *   `DEFAULT_RETRYABLE_CODES` 发现它是
   *   `['EMPTY_RESPONSE','RATE_LIMIT','SERVER','TIMEOUT','TRANSPORT']`
   *   —— **自定义码不在其中** ⇒ 宿主照样不重试，缺陷 3 **根本没被修好**
   *   （症状与原来逐字相同：整轮被打断）。
   *   ⇒ 语义最贴近且**确在**默认可重试集合里的是 `TRANSPORT`
   *   （本故障就是「一次取数往返没能完成」），具体分类靠 message 表达。
   *
   * ⚠️ **刻意不用 `AUTH` / `QUOTA`**：那两类在部分客户端会连 message 一起
   *   吞掉（见 AGENTS.md 的 IKLBSH 复发形态），而本故障**需要**用户看到
   *   「换渠道 / 稍后再试」这句指路文案。
   */
  const loomyLockedError = (reason: LoomyNoAccountReason): Error => {
    const details = reason.kind === 'exhausted' ? '' : `（${reason.errors.slice(0, 2).join('；')}）`
    if (reason.kind === 'all-unknown') {
      return new LlmError(
        'Loomy：无法确认是否有可用账号。已锁定永久积分，而**所有**账号的余额查询都失败了'
        + `${details}。这通常是上游限流 / 风控 / 网络中断，**不是**凭据失效 —— `
        + '无需重新登录。可稍后重试，或改用其它 provider / 模型；'
        + '若急于继续，可在 Jet Hub 的 Loomy 面板**临时解锁永久积分**（会消耗永久积分）。',
        'TRANSPORT',
      )
    }
    if (reason.kind === 'partial') {
      return new LlmError(
        'Loomy：无法确认是否有可用账号。已锁定永久积分，而**部分**账号的余额查询失败'
        + `${details}。其余账号的今日额度已确认用尽；这些账号**可能仍有**今日额度 —— `
        + '请稍后重试，或在 Jet Hub 的 Loomy 面板核对这些账号的凭据。',
        'TRANSPORT',
      )
    }
    /**
     * ⚠️⚠️ **穷尽性守卫**（与 buddy 那份同型，2026-10-14 审计引入）：
     * 走到这里**只允许**是 `{ kind: 'exhausted' }` —— 它是唯一有事实依据
     * 可以说「今日额度已用尽」的一档（余额分档真的查过，且每个候选的今日
     * 额度确实都是 0）。把 `reason` 赋给单成员类型，将来加了新档位却
     * 忘了写文案时，`tsc` 当场报 `TS2322`，而不是静默落进「已用尽」。
     */
    const exhaustedOnly: { kind: 'exhausted' } = reason
    void exhaustedOnly
    return new Error(
      'Loomy：没有可用账号。已锁定永久积分，而所有账号的今日赠送额度都已用尽。'
      + '请在 Jet Hub 的 Loomy 面板解锁永久积分，或等待明日额度刷新。',
    )
  }

  const buddy = new BuddyAuth(ctx)
  // buddy 目录的**各来源成败**出参（issue IKJVTF 复审，审计 I3）：
  // `buddy.fetchModels` 每轮原地写入，适配器的 `catalogComplete` 读它。
  // 初值两个 false —— 首轮真正拉取之前没有任何来源可算「取到」。
  buddy.lastCatalogOutcome = { scopedOk: false, configOk: false }
  const buddyAdapter = registerBuddyLlm(ctx, {
    credentialRef: credentialRef(BUDDY_CREDENTIAL_REF),
    resolveCredential: createCredentialResolver<BuddyCredential>(
      // ⚠️ 依赖在**每次 apply() 时**构造一次，闭包捕获的是同一批引用。
      { pool, reportAccount: (id) => { if (id !== undefined) reportLedgerAccount(CODEBUDDY.id, id) } },
      {
        product: CODEBUDDY,
        // 优先按「快到期积分」分档选号（锁定永久积分时也走这条，见上）。
        // provider 实参用 CODEBUDDY 而非字面量 'buddy'：写死字面量在改名/多产品
        // 场景下会静默查不到账号（本插件在 workbuddy 上踩过同类坑）。
        readCredential: resolveBuddyCredentialByRef,
        balance: {
          kind: 'buddy',
          selector: buddyBalanceSelector,
          lockedError: buddyLockedError('CodeBuddy'),
          // 免费模型跳过「锁定 + 临期积分」这道门（判据见 BuddyAdapter.isFreeModel）。
          // `buddyAdapter` 在此处是自引用：闭包只在注册完成后才执行，故无 TDZ 问题。
          isFreeModel: (modelId) => buddyAdapter.isFreeModel(modelId),
          // ⚠️ **保留旧闭包的既有不对称**：分档选中时**不**回报账本
          //（buddy 系旧闭包只在池兜底那一支回报）。理由见该字段的说明。
          reportPickedAccount: false,
        },
        fallback: { kind: 'ref', refName: BUDDY_CREDENTIAL_REF },
        // 退到单凭据 ref 之前先证明失败原因：全被模型限流时报明确的限流错误，
        // 而不是让它降级成误导性的 MISSING_CREDENTIAL（见该助手的说明）。
        throwIfAllRateLimited: throwIfAllAccountsRateLimited,
      },
    ),
    // 刷新**账号池里实际使用的那一个账号**，而不是默认单凭据 ref ——
    // 后者在 Jet Hub 登录路径下根本不存在，会把 401 报成「未配置凭据」
    // 并自锁。详见 createPoolRefresh 的注释。
    refresh: createPoolRefresh(pool, 'buddy', buddy),
    fetchRemoteModels: () => buddy.fetchModels(pool),
    // ⚠️ 完整性桥接（issue IKJVTF 复审，审计 I3）：buddy 的目录是 scoped +
    // `/v3/config` 的**并集**，两来源 id 集合不同 ⇒ 残缺时只展示、不永久缓存。
    catalogComplete: () => {
      const outcome = buddy.lastCatalogOutcome
      return outcome === undefined ? undefined : isBuddyCatalogComplete(outcome)
    },
    readImage: makeReadImage(ctx),
    // 图片请求版本（缩放）桥接：issue !IKITT9。不可用时适配器自动回退原图。
    readImageRequest: makeReadImageRequest(ctx),
    accountPool: pool,
    product: CODEBUDDY,
  })

  // ===== WorkBuddy (腾讯 WorkBuddy) 服务 =====
  // 与 CodeBuddy 同源（同后端、同协议），差异全部由 product 配置承载。
  // 服务名由 BuddyAuth 依 product.id 派生，故两个产品分别注册为
  // ctx.buddyAuth / ctx.workbuddyAuth，互不覆盖。
  // 同样不注册斜杠命令：入口在 Jet Hub 的 WorkBuddy 面板。
  const workbuddy = new BuddyAuth(ctx, { product: WORKBUDDY })
  workbuddy.lastCatalogOutcome = { scopedOk: false, configOk: false }
  const workbuddyAdapter = registerBuddyLlm(ctx, {
    credentialRef: credentialRef(WORKBUDDY.defaultCredentialRef),
    // 只从 workbuddy 的账号池取账号，回退到 WorkBuddy 自己的单凭据 ref，
    // 保证不会串用 CodeBuddy 的凭据。
    // 选号策略与 CodeBuddy 同款，但用的是**WorkBuddy 自己的锁状态与余额缓存**
    // （两站积分构成不同：实测国际版是「Bonus Pack 14 天 + Free Plan 长期」）。
    resolveCredential: createCredentialResolver<BuddyCredential>(
      { pool, reportAccount: (id) => { if (id !== undefined) reportLedgerAccount(WORKBUDDY.id, id) } },
      {
        product: WORKBUDDY,
        readCredential: resolveBuddyCredentialByRef,
        balance: {
          kind: 'buddy',
          selector: workbuddyBalanceSelector,
          lockedError: buddyLockedError('WorkBuddy'),
          // 免费模型跳过「锁定 + 临期积分」这道门（判据见 BuddyAdapter.isFreeModel）。
          // 用户报障「账户可用却提示没有可用账号」正是缺了这一条：免费模型不扣积分，
          // 却被永久积分锁定拦下。
          isFreeModel: (modelId) => workbuddyAdapter.isFreeModel(modelId),
          // ⚠️ 同 buddy：保留旧闭包「分档选中时不回报账本」的既有不对称。
          reportPickedAccount: false,
        },
        fallback: { kind: 'ref', refName: WORKBUDDY.defaultCredentialRef },
        // 同 buddy：区分「全部限流」与「真的没登录」（见该助手的说明）。
        throwIfAllRateLimited: throwIfAllAccountsRateLimited,
      },
    ),
    // 同上：必须刷池内账号（`WORKBUDDY_ACCESS_TOKEN` 从未被写入过）。
    // 这条正是「workbuddy + deepseek-v4.1-flash 一直报未配置凭据」的根因。
    refresh: createPoolRefresh(pool, 'workbuddy', workbuddy),
    fetchRemoteModels: () => workbuddy.fetchModels(pool),
    // ⚠️ 完整性桥接（同 buddy，见上）。
    catalogComplete: () => {
      const outcome = workbuddy.lastCatalogOutcome
      return outcome === undefined ? undefined : isBuddyCatalogComplete(outcome)
    },
    readImage: makeReadImage(ctx),
    readImageRequest: makeReadImageRequest(ctx),
    accountPool: pool,
    product: WORKBUDDY,
  })

  // ===== LobsterAI (有道龙虾) 服务 =====
  // 第三个产品线，但协议与腾讯系**完全不同**：不走 external-link 轮询登录，
  // 而是本地回调 + authCode 换 token（见 src/lobsterai-oauth.ts）。
  // 服务名由 LobsteraiAuth 依 product.id 派生，注册为 ctx.lobsteraiAuth。
  // 与其他 provider 一样不注册斜杠命令：入口在 Jet Hub 的 LobsterAI 面板。
  const lobsterai = new LobsteraiAuth(ctx)
  /**
   * 按凭据 ref 解析 LobsterAI 凭据（供选号器查余额与最终取凭据共用）。
   *
   * 抽成局部函数而非内联两遍：选号器需要它查余额，而解析最终凭据又要用它 ——
   * 两处若各写一遍 JSON 解析，格式一变就会只改一处（与 Loomy 那条同因）。
   *
   * ⚠️ **形状校验必须与 `LobsteraiAuth` 的 `parseCredential` 对齐**（理由同
   * TRAE 那份注释：裸 parse 会让损坏凭据一路流到适配器的
   * `credential.access_token.length`，抛不可诊断的 TypeError）。
   */
  const resolveLobsteraiCredentialByRef = async (refName: string): Promise<LobsteraiCredential | undefined> => {
    const resolved = await ctx.credentials.resolve(credentialRef(refName))
    if (!resolved) return undefined
    try {
      const parsed = JSON.parse(resolved.value) as LobsteraiCredential
      return typeof parsed === 'object' && parsed !== null && typeof parsed.access_token === 'string'
        ? parsed
        : undefined
    } catch {
      return undefined
    }
  }
  /**
   * LobsterAI 的**按余额优先选号器**（为「锁定永久积分」提供分档依据）。
   *
   * ⚠️ 复用 `BuddyBalanceSelector` 而不是新写一个：分档判据
   * （`splitBuddyCreditsByExpiry`）只读通用的
   * `packages[].{ active, remaining, deductionEndTime }`，**与 provider 无关**。
   * LobsterAI 的 `fetchLobsteraiCreditBalance` 把 `expiresAt`（ISO 8601）归一化到
   * `deductionEndTime`，故结构一致。
   *
   * ⚠️ **缓存不能跨站共用**（选择器内含按账号 id 的缓存），故每家一个实例。
   *
   * ⚠️ 到期时间缺失的包归入**永久桶**（`splitBuddyCreditsByExpiry` 的保守方向）：
   * LobsterAI 实测所有包都带 `expiresAt`，故这条只在响应异常时生效 ——
   * 那时宁可把它当「不会马上作废」（锁定时少用一个号），
   * 也不要把长期积分误当快到期烧掉。
   */
  const lobsteraiBalanceSelector = new BuddyBalanceSelector({
    product: LOBSTERAI,
    resolveCredential: resolveLobsteraiCredentialByRef,
    fetchBalance: (credential, product) => fetchLobsteraiCreditBalance(credential, product),
  })
  const lobsteraiAdapter = registerLobsteraiLlm(ctx, {
    credentialRef: credentialRef(LOBSTERAI.defaultCredentialRef),
    // 只从 LobsterAI 自己的账号池取账号，回退到自己的单凭据 ref，
    // 保证不会串用 CodeBuddy / WorkBuddy / CodeArts 的凭据。
    // provider 实参用 LOBSTERAI 而非字面量 'lobsterai'：写死字面量在
    // 改名/多产品场景下会静默查不到账号（本插件在 workbuddy 上踩过同类坑）。
    //
    // 优先按「快到期积分」分档选号（锁定永久积分时只挑有快到期积分的号）。
    // 与 buddy 系同一套编排：候选先按「enabled + 模型未受限」筛，
    // 分档只在这批候选内部进行 —— 不能因为某个号积分多就绕开限流标记。
    resolveCredential: createCredentialResolver<LobsteraiCredential>(
      { pool, reportAccount: (id) => { if (id !== undefined) reportLedgerAccount(LOBSTERAI.id, id) } },
      {
        product: LOBSTERAI,
        // ⚠️ 必须传 LobsterAI 自己的解析器：buddy 系那份对它的凭据结构会解析出
        // 错误形状（见各自 credential 类型）。
        readCredential: resolveLobsteraiCredentialByRef,
        balance: {
          kind: 'buddy',
          selector: lobsteraiBalanceSelector,
          lockedError: buddyLockedError('LobsterAI'),
          // ⚠️ LobsterAI **没有** `isFreeModel`（只有 buddy / trae 的适配器有）：
          // 它的模型表不带倍率字段，判不出「免费」—— 缺省即「从不跳过锁定」。
        },
        fallback: { kind: 'ref', refName: LOBSTERAI.defaultCredentialRef },
        // 退到单凭据 ref 之前先证明失败原因（见 `throwIfAllAccountsRateLimited`
        // 的说明）：全被模型限流时报明确的限流错误，而不是降级成「请先登录」。
        throwIfAllRateLimited: throwIfAllAccountsRateLimited,
      },
    ),
    refresh: async () => {
      // 必须刷新**解析凭据时所用的那一个**账号，而不是默认单凭据 ref。
      //
      // 为什么：resolveCredential（上面）优先从账号池取
      // `LOBSTERAI_ACCOUNT_XXX` 的凭据，而 `lobsterai.refresh()` 读写的是
      // `LOBSTERAI_ACCESS_TOKEN`。两者错配的后果是 —— 适配器检测到池凭据
      // 过期 → 调 refresh → 成功回写到**另一个** ref → 再 resolve 仍取到
      // 那份未更新的过期凭据 → 带着过期 token 发请求 → 401。
      // 用户看到的是「刚在 Jet Hub 登录好，却一直认证失败」，
      // 而日志里续期全是成功的，极难排查。
      //
      // 与 Go 一致：`handler.go:197-209` 也是先 Pick 出账号、再对该账号
      // `RefreshToken(acct)`（而非某个全局单例）。
      const available = await pool.getAvailableAccount(LOBSTERAI.id, '')
      if (available) await lobsterai.refreshAccountCredential(available.entry.credentialRef, pool, available.entry.id)
      else await lobsterai.refresh()
    },
    fetchRemoteModels: () => lobsterai.fetchModels(pool),
    resolveClientVersion: () => lobsterai.resolveClientVersion(),
    readImage: makeReadImage(ctx),
    // 图片请求版本（缩放）桥接：issue !IKITT9。该家实测 13 张原图（≈50 MiB）
    // 就回 `SERVER code=500`，撞的是请求体体积。
    readImageRequest: makeReadImageRequest(ctx),
    accountPool: pool,
    product: LOBSTERAI,
  })

  // ===== Qoder (阿里系 AI IDE) 服务 =====
  // 第五个产品线，协议与四者**都不同源**：PKCE 设备码轮询登录
  // （不起本地回调服务器，见 src/qoder-oauth.ts）。
  // 服务名由产品 id 派生，注册为 ctx.qoderAuth。
  // 与其它 provider 一样不注册斜杠命令：入口在 Jet Hub 的 Qoder 面板。
  const qoder = new QoderAuth(ctx)
  /**
   * 按凭据 ref 解析 Qoder 凭据（供选号器查余额与最终取凭据共用）。
   *
   * ⚠️ **两站共用这一份**（`qoder` / `qodercn` 的凭据形状逐字相同：同一套
   * OAuth 实现，差异只在主机与 ref 前缀）—— 与 minimax 那份同因，
   * 各写一遍 = 改一处漏一处。
   *
   * ⚠️ **逐字保留历史上的裸 `JSON.parse` 形态**（不在此处加形状校验）：
   * 加校验是一次**行为变更**（此前被接受的损坏凭据会变成被拒），
   * 不在本 Task 范围内。历史形态见 git 历史里 qoder / qodercn 两段
   * `readCredential` 里那两份**逐字重复**的内联箭头。
   */
  const resolveQoderCredentialByRef = async (refName: string) => {
    const resolved = await ctx.credentials.resolve(credentialRef(refName))
    if (!resolved) return undefined
    try {
      return JSON.parse(resolved.value)
    } catch {
      return undefined
    }
  }
  /**
   * Qoder 两站的**按「额度何时作废」分档选号器**（为「锁定永久积分」提供依据）。
   *
   * ⚠️ 复用 `BuddyBalanceSelector` 而不是新写一个：分档判据
   * （`splitBuddyCreditsByExpiry`）只读通用的
   * `packages[].{ active, remaining, deductionEndTime }`，**与 provider 无关**。
   *
   * ⚠️ **两家各建一个实例，不得合并**：选择器内含**按账号 id 的缓存**，
   * 跨站共用会让一站的读数污染另一站（与 minimax 两站同因）。
   *
   * ⚠️⚠️ **必须各传自己的 `product`**：`QODER` 指向 `openapi.qoder.sh`、
   * `QODER_CN` 指向 `openapi.qoder.com.cn` —— 互换的后果**不是报错**而是静默：
   * 对方站点不认本站 token ⇒ 余额恒 `null` ⇒ 未锁定时换号优化失效、
   * 锁定时永远报「没有可用账号」。
   */
  const qoderBalanceSelector = new BuddyBalanceSelector({
    product: QODER,
    resolveCredential: resolveQoderCredentialByRef,
    fetchBalance: (credential, product) => fetchQoderCreditBalance(credential, product),
  })
  const qoderCnBalanceSelector = new BuddyBalanceSelector({
    product: QODER_CN,
    resolveCredential: resolveQoderCredentialByRef,
    fetchBalance: (credential, product) => fetchQoderCreditBalance(credential, product),
  })
  /**
   * 「本次实际使用的账号 id」跟踪表（provider id → 账号 id）。
   *
   * ## 为什么需要它
   *
   * 额度受限时要标记**当前账号**（见 `QoderAdapter.switchAccountOnQuota`）。
   * 但「当前账号」不能靠「再问一次账号池的默认账号」得到 —— 池的选号是
   * `getAvailableAccount()` 的即时决策，与适配器**本次实际拿到**的那份凭据
   * 可能是两个账号（例如池已因限流切走，而适配器手上仍是旧凭据）。
   * 标记落错账号的后果：真正受限的账号没被标记 → 下次又被选中 → 反复撞墙；
   * 无辜账号被标记 → 它当天用不了（虽不致命，但属无谓损失）。
   *
   * 故在 `resolveCredential` 里**记录实际返回的那个账号**，供适配器查询。
   * 用 `Map` 按 provider 分开，国际版与中国版互不影响。
   */
  const activeQoderAccountId = new Map<string, string | undefined>()
  const qoderAdapter = registerQoderLlm(ctx, {
    credentialRef: credentialRef(QODER.defaultCredentialRef),
    // 只从 Qoder 自己的账号池取账号，回退到自己的单凭据 ref，
    // 保证不会串用其它 provider 的凭据。
    // provider 实参用 QODER 而非字面量 'qoder'：写死字面量在
    // 改名/多产品场景下会静默查不到账号（本插件在 workbuddy 上踩过同类坑）。
    // ⚠️ `modelId` 透传：Qoder 的额度是「模型 + 账号」维度（见
    // `qoder-adapter.ts` 的 `switchAccountOnQuota`），传空串会让它刚写下的
    // 当日额度标记在下次选号时被忽略。
    resolveCredential: createCredentialResolver<QoderCredential>(
      {
        pool,
        // ⚠️ 这里**必须**处理 `undefined`：没有账号条目可标记时要**清空**，否则
        // 留着过期的 id 会让额度标记落在无辜账号上（见 `activeQoderAccountId`）。
        reportAccount: (id) => {
          activeQoderAccountId.set(QODER.id, id)
          if (id !== undefined) reportLedgerAccount(QODER.id, id)
        },
      },
      {
        product: QODER,
        readCredential: async (refName) => {
          const resolved = await ctx.credentials.resolve(credentialRef(refName))
          if (!resolved) return undefined
          try {
            return JSON.parse(resolved.value) as QoderCredential
          } catch {
            return undefined
          }
        },
        // 优先按「快到期额度」分档选号（锁定永久积分时只挑有快到期额度的号）。
        // ⚠️ `qoderLockedError` **本家独有**（不共用 buddy 系那份）：buddy 的
        //    「临期」指资源包 `DeductionEndTime`，而本家逐包到期时刻拿不到 ——
        //    照抄会让用户按一个不存在的判据去排查（见该函数的长注释）。
        // ⚠️ `reportPickedAccount: true` 是**必须的**（与 minimax 两站同因）：
        //    本家的旧闭包是纯池选号、账本**一直在回报**；接上 `balance` 后
        //    「分档选中」那一支若不回报 ⇒ token 用量记不到本渠道上（静默）。
        balance: {
          kind: 'buddy',
          selector: qoderBalanceSelector,
          lockedError: qoderLockedError('Qoder'),
          reportPickedAccount: true,
        },
        fallback: { kind: 'ref', refName: QODER.defaultCredentialRef },
        // 区分「全部限流」与「没登录」（见该助手的说明）—— 否则用户会去
        // 重新登录，而凭据其实是好的（真实缺陷，Gitee IKJOZ9）。
        throwIfAllRateLimited: throwIfAllAccountsRateLimited,
      },
    ),
    refresh: async () => {
      // 必须刷新**解析凭据时所用的那一个**账号，而不是默认单凭据 ref。
      //
      // 为什么：resolveCredential（上面）优先从账号池取
      // `QODER_ACCOUNT_XXX` 的凭据，而 `qoder.refresh()` 读写的是
      // `QODER_ACCESS_TOKEN`。两者错配的后果是 —— 适配器检测到池凭据
      // 过期 → 调 refresh → 成功回写到**另一个** ref → 再 resolve 仍取到
      // 那份未更新的过期凭据 → 带着过期 token 发请求 → 401。
      // 用户看到的是「刚在 Jet Hub 登录好，却一直认证失败」，
      // 而日志里续期全是成功的，极难排查。
      const available = await pool.getAvailableAccount(QODER.id, '')
      if (available) await qoder.refreshAccountCredential(available.entry.credentialRef, pool, available.entry.id)
      else await qoder.refresh()
    },
    readImage: makeReadImage(ctx),
    // 图片请求版本（缩放）桥接：issue !IKITT9。该家实测 15 张原图（≈57 MiB）
    // 直接 `TRANSPORT: fetch failed`，撞的是请求体体积。
    // ⚠️ qoder 与 qodercn **共用同一个 QoderAdapter 类**，故两站同时受益
    //（与「差异收敛到产品配置」这个模式一致 —— 别以为只改了一站）。
    readImageRequest: makeReadImageRequest(ctx),
    accountPool: pool,
    product: QODER,
    // 远端模型目录（2026-10-20）：**由 auth 服务取数**，只做池的只读读取。
    // ⚠️ 刻意**不**走 `resolveCredential` —— 它选中账号时会 reportAccount，
    //    而目录请求是周期性的（20 分钟刷新器），会把「本次实际使用的账号」
    //    改写成目录用的账号 ⇒ 额度标记落到无辜账号上（见 `QoderAdapterOptions.fetchRemoteModels`）。
    fetchRemoteModels: () => qoder.fetchModels(pool),
    // 额度受限时标记「本次实际使用的账号」（理由见 `activeQoderAccountId` 注释）。
    currentAccountId: () => activeQoderAccountId.get(QODER.id),
  })

  // ===== Qoder 中国版（qodercn）=====
  // 与上面的国际版是**同一套协议实现**的第二个实例（差异全在 QODER_CN 配置里：
  // 域名 qoder.cn / openapi.qoder.com.cn / gateway.qoder.com.cn、client_id
  // 732aef47-…、以及一张自己的 14 条模型表）。刻意**不复制**任何 qoder*.ts
  // 实现文件 —— 协议同源，复制会让同类缺陷（tools 不下发、工具历史丢
  // tool_calls、错误帧不抛错）修两遍。
  // 服务名由 `${product.id}Auth` 派生，注册为 `ctx.qodercnAuth`（product id
  // `qodercn` 全小写、不带连字符 —— 按变量名驼峰惯例拼会得到大小写不符的名字）。
  // 不注册斜杠命令：入口在 Jet Hub 的「Qoder (中国版)」面板。
  const qoderCn = new QoderAuth(ctx, { product: QODER_CN })
  const qoderCnAdapter = registerQoderLlm(ctx, {
    credentialRef: credentialRef(QODER_CN.defaultCredentialRef),
    // 只取中国版自己账号池的账号，回退到 QODERCN_ACCESS_TOKEN。
    // ⚠️ provider 实参必须是 QODER_CN：写死 'qoder' 会让中国版
    // 永远查不到自己的账号（本插件在 workbuddy 上踩过同类坑）。
    // ⚠️ `modelId` 透传：与 QODER 同因（当日额度是「模型 + 账号」维度）。
    resolveCredential: createCredentialResolver<QoderCredential>(
      {
        pool,
        // 同国际版：`undefined` 是「清空标记」的有意义事件。
        reportAccount: (id) => {
          activeQoderAccountId.set(QODER_CN.id, id)
          if (id !== undefined) reportLedgerAccount(QODER_CN.id, id)
        },
      },
      {
        product: QODER_CN,
        readCredential: async (refName) => {
          const resolved = await ctx.credentials.resolve(credentialRef(refName))
          if (!resolved) return undefined
          try {
            return JSON.parse(resolved.value) as QoderCredential
          } catch {
            return undefined
          }
        },
        // 同国际版：分档选号 + 本家独有文案 + 回报实际选中的账号。
        // ⚠️ `displayName` **必须**逐站区分（两站账号不互通，用户要知道去哪个
        //    面板解锁）；`selector` 也必须是中国版自己那一个（缓存不跨站共用）。
        balance: {
          kind: 'buddy',
          selector: qoderCnBalanceSelector,
          lockedError: qoderLockedError('Qoder (中国版)'),
          reportPickedAccount: true,
        },
        fallback: { kind: 'ref', refName: QODER_CN.defaultCredentialRef },
        // 同国际版：区分「全部限流」与「没登录」（见该助手的说明，IKJOZ9）。
        throwIfAllRateLimited: throwIfAllAccountsRateLimited,
      },
    ),
    refresh: async () => {
      // ⚠️ 必须刷新**解析凭据时所用的那一个**账号，而不是默认单凭据 ref。
      // 理由与国际版那条真实缺陷完全同因：resolveCredential 优先取池内凭据，
      // 而 refresh() 读写 QODERCN_ACCESS_TOKEN，两者错配会让日志里续期全成功、
      // 用户却「刚登录却一直认证失败」。
      const available = await pool.getAvailableAccount(QODER_CN.id, '')
      if (available) await qoderCn.refreshAccountCredential(available.entry.credentialRef, pool, available.entry.id)
      else await qoderCn.refresh()
    },
    readImage: makeReadImage(ctx),
    // 同 QODER：两站共用同一个适配器类，缩放桥接也必须两边都接
    //（只接一边会让中国版的截图照样撞 57 MiB）。
    readImageRequest: makeReadImageRequest(ctx),
    accountPool: pool,
    product: QODER_CN,
    // 远端模型目录：同国际版（两站共用同一套实现，差异只在产品配置）。
    fetchRemoteModels: () => qoderCn.fetchModels(pool),
    // 额度受限时用它标记「当前账号」（见 `QoderAdapter.switchAccountOnQuota`）。
    // ⚠️ 取「**本次实际使用**的账号」而非池里默认那一个：池的默认账号可能与之
    // 不同（例如本账号被限流、池已切到别的账号），标错就会让标记落在无辜账号上。
    currentAccountId: () => activeQoderAccountId.get(QODER_CN.id),
  })

  // ===== TRAE（字节 TRAE IDE）服务 =====
  // 第六个产品线，协议与前面几者**完全不同**：认证用 ExchangeToken（轮换 refreshToken），
  // 对话用 Cloud-IDE-JWT 鉴权，载荷需从 OpenAI 格式转换为 SOLO 格式，
  // SSE 为自定义格式（非 OpenAI 标准），需独立解析。
  // 服务名由 TraeAuth 依 product.id 派生，注册为 ctx.traeAuth。
  // 不注册斜杠命令：入口在 Jet Hub 的 TRAE 面板。
  const trae = new TraeAuth(ctx)
  /**
   * 按凭据 ref 解析 TRAE 凭据（供选号器查余额与最终取凭据共用）。
   * 抽成局部函数而非内联两遍的理由同 buddy / Loomy。
   *
   * ⚠️ **形状校验必须与 `TraeAuth` 的 `parseCredential` 对齐**（不可只 `JSON.parse`）：
   * 裸 parse 会把 `{"foo":1}` 这种损坏凭据**当成有效凭据**返回，随后适配器的
   * `credential.access_token.length` 抛 **TypeError**（而非可诊断的
   * MISSING_CREDENTIAL），且发生在选号之后、不在余额查询的 try/catch 覆盖范围内。
   * 写两遍、强度还不一致 = 改一处漏一处，故此处与 `trae-auth.ts` 保持同一判据。
   */
  const resolveTraeCredentialByRef = async (refName: string): Promise<TraeCredential | undefined> => {
    const resolved = await ctx.credentials.resolve(credentialRef(refName))
    if (!resolved) return undefined
    try {
      const parsed = JSON.parse(resolved.value) as TraeCredential
      return typeof parsed === 'object' && parsed !== null && typeof parsed.access_token === 'string'
        ? parsed
        : undefined
    } catch {
      return undefined
    }
  }
  /**
   * TRAE 的**按余额优先选号器**（为「锁定永久积分」提供分档依据）。
   *
   * ⚠️ 同 LobsterAI：复用 `BuddyBalanceSelector`，因为分档判据只读通用的
   * `packages[].{ active, remaining, deductionEndTime }`。TRAE 的
   * `fetchTraeCreditBalance` 把条目级 `expire_time`（秒级 Unix）归一化到
   * `deductionEndTime`，故结构一致。
   *
   * ⚠️ **缓存不能跨站共用**（选择器内含按账号 id 的缓存），故每家一个实例。
   */
  const traeBalanceSelector = new BuddyBalanceSelector({
    product: TRAE,
    resolveCredential: resolveTraeCredentialByRef,
    fetchBalance: (credential, product) => fetchTraeCreditBalance(credential, product),
  })
  const traeAdapter = registerTraeLlm(ctx, {
    credentialRef: credentialRef(TRAE.defaultCredentialRef),
    // 优先按「快到期积分」分档选号（锁定永久积分时只挑有快到期积分的号）。
    // 与 buddy 系同一套编排：候选先按「enabled + 模型未受限」筛，
    // 分档只在这批候选内部进行 —— 不能因为某个号积分多就绕开限流标记。
    resolveCredential: createCredentialResolver<TraeCredential>(
      { pool, reportAccount: (id) => { if (id !== undefined) reportLedgerAccount(TRAE.id, id) } },
      {
        product: TRAE,
        // ⚠️ 必须传 TRAE 自己的解析器（buddy 系那份对它的凭据结构会解析出
        // 错误形状 —— 它带 uid / machine_id 等字段）。
        readCredential: resolveTraeCredentialByRef,
        balance: {
          kind: 'buddy',
          selector: traeBalanceSelector,
          lockedError: buddyLockedError('TRAE'),
          // 免费模型跳过「锁定 + 临期积分」这道门（判据见 TraeAdapter.isFreeModel）。
          // ⚠️ TRAE 确有 `rate: 0` 的合法免费模型（见 `trae.ts` 的 readConsumptionRate
          // 注释与 `traeDisplayName` 把 0 显示成「免费」），不跳过就会在锁定时被
          // 余额门拦下并报「积分都已用尽」—— 而免费模型根本不扣积分，报错完全误导。
          // `traeAdapter` 在此处是自引用：闭包只在注册完成后才执行，故无 TDZ 问题。
          isFreeModel: (modelId) => traeAdapter.isFreeModel(modelId),
        },
        fallback: { kind: 'ref', refName: TRAE.defaultCredentialRef },
        // 区分「全部限流」与「没登录」（见该助手的说明，IKJOZ9）。
        throwIfAllRateLimited: throwIfAllAccountsRateLimited,
      },
    ),
    refresh: async () => {
      const available = await pool.getAvailableAccount(TRAE.id, '')
      if (available) await trae.refreshAccountCredential(available.entry.credentialRef, pool, available.entry.id)
      else await trae.refresh()
    },
    fetchRemoteModels: () => trae.fetchModels(pool),
    // 图片字节桥接：TRAE 上游**支持图片**（见 Issue #IKHDKC 的实测记录），
    // 但模态按模型判定（远端 `display_config.multimodal`），故这里只负责读字节。
    readImage: makeReadImage(ctx),
    accountPool: pool,
    product: TRAE,
  })

  // ===== Cline（Cline 桌面端 / Cline API）服务 =====
  // 第七个产品线，协议与前面六者**都不同源**：登录是 **WorkOS 设备码轮询**
  // （api.workos.com，不起本地回调端口），鉴权头是 `Bearer workos:<jwt>`
  // （前缀**不可剥**），推理是**标准 OpenAI 兼容**端点。
  // 服务名由 ClineAuth 依 product.id 派生，注册为 ctx.clineAuth。
  // 不注册斜杠命令：入口在 Jet Hub 的 Cline 面板。
  const cline = new ClineAuth(ctx)
  /**
   * 「本次实际使用的是哪个 Cline **池账号**」——「订阅额度 → 请求记录」的
   * 「账号」列按它归属，面板也是用这个 id 过滤的。
   *
   * ⚠️ 与 `activeQoderAccountId` 同因：必须在 `resolveCredential` 里记录
   * **实际返回的那个账号**，不能事后自己再查一次池 —— 池的选号是即时决策，
   * 与适配器本次拿到的凭据可能已经不是一个账号。
   *
   * ⚠️ 真实缺陷（用户报障「请求记录中数据空白」）：此处曾**完全没有**这个通道，
   * 适配器只好退回记凭据里的 `account_id`（`usr-…`），而面板按池 id
   * （`cline-bb211a53`）过滤 → 两个 id 空间不一致 → 表格永远空白。
   */
  let activeClineAccountId = ''
  const clineAdapter = registerClineLlm(ctx, {
    credentialRef: credentialRef(CLINE.defaultCredentialRef),
    // 只从 Cline 自己的账号池取账号，回退到自己的单凭据 ref，
    // 保证不会串用其它 provider 的凭据。
    // provider 实参用 CLINE 而非字面量 'cline'：写死字面量在
    // 改名/多产品场景下会静默查不到账号（本插件在 workbuddy 上踩过同类坑）。
    // ⚠️ `modelId` 透传：否则模型级限流标记被忽略（详见 buddy 处说明）。
    resolveCredential: createCredentialResolver<ClineCredential>(
      {
        pool,
        // 记录实际选中的池账号（空串 = 回退到单凭据 ref 模式，见适配器注释）。
        // ⚠️ 取不到号时**必须**置空串，否则旧 id 会让「请求记录」的账号列串味。
        reportAccount: (id) => {
          activeClineAccountId = id ?? ''
          // Token 账本（第 2 期）：回报「本笔请求解析出的账号」（空串不回报）。
          if (activeClineAccountId.length > 0) reportLedgerAccount(CLINE.id, activeClineAccountId)
        },
      },
      {
        product: CLINE,
        readCredential: async (refName) => {
          const resolved = await ctx.credentials.resolve(credentialRef(refName))
          if (!resolved) return undefined
          try {
            return JSON.parse(resolved.value) as ClineCredential
          } catch {
            return undefined
          }
        },
        fallback: { kind: 'ref', refName: CLINE.defaultCredentialRef },
        // ⚠️ 与 buddy / workbuddy 同因（真实缺陷，2026-10-03 用户报障）：
        // 唯一的 cline 账号被**模型级限流**标记挡住时，候选会筛成空集，最终降级成
        // `cline: no usable credential; log in first` —— 凭据明明在、账号也登录着，
        // 用户却被指去重新登录，方向完全错。故必须在退到单凭据 ref **之前**
        // 先把「其实是限流，预计 X 后解禁」说清楚。
        throwIfAllRateLimited: throwIfAllAccountsRateLimited,
      },
    ),
    refresh: async () => {
      // 必须刷新**解析凭据时所用的那一个**账号，而不是默认单凭据 ref。
      //
      // 为什么：resolveCredential（上面）优先从账号池取
      // `CLINE_ACCOUNT_XXX` 的凭据，而 `cline.refresh()` 读写的是
      // `CLINE_ACCESS_TOKEN`。两者错配的后果是 —— 适配器检测到池凭据
      // 过期 → 调 refresh → 成功回写到**另一个** ref → 再 resolve 仍取到
      // 那份未更新的过期凭据 → 带着过期 token 发请求 → 401。
      // 用户看到的是「刚在 Jet Hub 登录好，却一直认证失败」，
      // 而日志里续期全是成功的，极难排查。
      const available = await pool.getAvailableAccount(CLINE.id, '')
      if (available) await cline.refreshAccountCredential(available.entry.credentialRef, pool, available.entry.id)
      else await cline.refresh()
    },
    // 图片字节桥接：Cline 内嵌目录的 `capabilities` 含 `images`，
    // 模态按模型判定（见 ClineAdapter.inputModalitiesFor）。
    readImage: makeReadImage(ctx),
    // 图片请求版本（缩放）桥接：issue !IKITT9。该家实测 24 张原图全过、
    // 32 张（≈122 MiB）才 `TRANSPORT` —— 余量比其他家大，但仍需兜住长会话。
    readImageRequest: makeReadImageRequest(ctx),
    accountPool: pool,
    // 「请求记录」的账号归属（见上面的 `activeClineAccountId`）。
    currentAccountId: () => activeClineAccountId.length > 0 ? activeClineAccountId : undefined,
    product: CLINE,
  })

  // ===== Loomy（讯飞办公助手）服务 =====
  // 第八个产品线，与前面七者**都不同源**：登录是**短信验证码**
  // （讯飞 CAccount，HMAC-SHA1 签名，没有 loginUrl 可打开），
  // 推理是标准 OpenAI 兼容（复用 openai-compat.ts）。
  // 服务名由 LoomyAuth 依 product.id 派生，注册为 ctx.loomyAuth。
  // 不注册斜杠命令：入口在 Jet Hub 的 Loomy 面板。
  const loomy = new LoomyAuth(ctx)

  /**
   * 按凭据 ref 解析 Loomy 凭据（供选号器与兜底路径共用）。
   *
   * 抽成局部函数而非内联两遍：选号器需要它查余额，而解析最终凭据又要用它 ——
   * 两处若各写一遍 JSON 解析，格式一变就会只改一处。
   */
  const resolveLoomyCredentialByRef = async (refName: string): Promise<LoomyCredential | undefined> => {
    const resolved = await ctx.credentials.resolve(credentialRef(refName))
    if (!resolved) return undefined
    try {
      return JSON.parse(resolved.value) as LoomyCredential
    } catch {
      return undefined
    }
  }

  /**
   * 把共享读数里的 `CreditBalance` 拆成 loomy 选号要的两个数。
   *
   * ⚠️⚠️ **按包名映射，只此一处**：`provider-credits.ts` 的 `makePackage` 写的
   *   包名是「永久积分」/「每日赠送」，共享缓存里存的就是那个形状。
   *   ⚠️ **判据用 `includes` 而非 `===`**：包名带「（陈旧）」之类后缀时
   *   仍要认得出来 —— 用等值会在文案微调后静默变成「读不到余额」，
   *   那正是本 issue 的症状形态。
   * ⚠️ 两池都认不出时返回 `{}`（**不编造 0**）：上层据此判「没有可用读数」。
   */
  const loomyPoolsOf = (balance: CreditBalance): { daily?: number; permanent?: number } => {
    let daily: number | undefined
    let permanent: number | undefined
    for (const pkg of balance.packages ?? []) {
      if (pkg.name.includes('每日')) daily = pkg.remaining
      else if (pkg.name.includes('永久')) permanent = pkg.remaining
    }
    return {
      ...daily === undefined ? {} : { daily },
      ...permanent === undefined ? {} : { permanent },
    }
  }

  /**
   * 按账号池 id 取一份已解析的 loomy 凭据（共享读数的槽需要它）。
   *
   * ⚠️ 读不到（账号已删 / 凭据损坏）返回 `undefined` ⇒ 缓存记成失败读数 ⇒
   *   选号器照常回落自己取数（并得到它自己的「凭据未配置或已失效」结论）。
   */
  const readLoomyCredentialFor = async (accountId: string): Promise<LoomyCredential | undefined> => {
    const entry = pool.listAccountsByProvider(LOOMY.id).find((a) => a.id === accountId)
    if (entry === undefined) return undefined
    return await resolveLoomyCredentialByRef(entry.credentialRef)
  }

  /**
   * Loomy 的**按余额优先选号器**（负载均衡）。
   *
   * ⚠️ **为什么需要它**（真实缺陷）：实测 Loomy 的今日赠送额度（每天 5000）
   * 耗尽后，服务端**继续扣永久积分且不报错** —— 「耗尽」是**静默降级**而非错误。
   * 而本插件既有的「限流 → 换号」只在服务端返回限流错误时触发，
   * 故对 Loomy **完全无效**：会一直烧同一个号（用户报障）。
   *
   * 策略：优先有今日额度的号 → 其次有永久积分的号 → 都无/查不到排最后。
   * 档内保持手动拖拽顺序（详见 `loomy-balance-rank.ts`）。
   */
  const loomyBalanceSelector = new LoomyBalanceSelector({
    product: LOOMY,
    resolveCredential: resolveLoomyCredentialByRef,
    /**
     * ★ 吃**共享余额读数**（2026-10-16，issue IKMCOO 缺陷 1）。
     *
     * ## 为什么必须接（用户报障的核心矛盾）
     *
     * 「面板显示三个账号都有余额，但对话一直报『余额查询失败』」—— 两条路径
     * 各发各的请求、各存各的缓存，于是**可以同时成立且互相矛盾**。
     * ⇒ 这里让选号与面板**看同一份读数**，矛盾从根上消失。
     *
     * ⚠️ **`LOOMY_CREDIT_DETAIL` 从共享读数里取**：`CreditBalance` 有两池
     *   （`packages`），而选号器要的是 `permanent` / `daily` 两个数 ——
     *   由**包名**映射（`provider-credits.ts` 造包时写的就是「永久积分」/
     *   「每日赠送」）。⚠️ 这层映射**只此一处**，不得在别处再写一份。
     *
     * ⚠️ **陈旧读数按成功处理**：兼顶值确实可用（`ok: true`），只是标了
     *   `error` 让 UI 能显示数据时间。标成失败会把「有今日额度的号」踢出候选 ——
     *   那正是本 issue 的症状。
     *
     * ⚠️ 共享缓存**未注册**时返回 `undefined` ⇒ 选号器照常自己取数（逐字节同旧）。
     */
    sharedReading: async (accountId) => {
      const reading = await balanceCache.readStale(LOOMY.id, accountId, {
        credential: await readLoomyCredentialFor(accountId),
      })
      if (reading.value === undefined) return undefined
      return {
        ...loomyPoolsOf(reading.value as CreditBalance),
        stale: reading.stale,
        at: reading.at,
        ...reading.error === undefined ? {} : { error: reading.error },
      }
    },
  })

  const loomyAdapter = registerLoomyLlm(ctx, {
    credentialRef: credentialRef(LOOMY.defaultCredentialRef),
    /**
     * 解析本轮该用哪个账号的凭据。
     *
     * ⚠️ `modelId` 由适配器传入（见 `LoomyAdapterOptions.resolveCredential`
     * 的签名说明）—— **必须透传给选号**，否则模型级限流过滤失效
     *（早期实现传空串 `''`，等于「不按模型过滤」）。
     *
     * ⚠️ **loomy 走自己的分档分支，不并入 buddy 那套 `pickBuddyAccount`**：
     * 它的 reason 类型（`LoomyNoAccountReason`）与余额语义（`dailyBalance`
     * 今日赠送额度 vs buddy 系的「N 天内到期的资源包」）都不同，且旧闭包里
     * **没有池取号那一步** —— 强行合并会同时引入「凭据坏了就换号」与「回落池」
     * 两个行为变更。设计边界是**抽象编排，不抽象协议**。
     */
    resolveCredential: createCredentialResolver<LoomyCredential>(
      { pool, reportAccount: (id) => { if (id !== undefined) reportLedgerAccount(LOOMY.id, id) } },
      {
        product: LOOMY,
        // 复用上面的解析器而不是再写一遍 JSON.parse：两处各写一遍时，
        // 形状校验的强度会分叉（这正是 TRAE 那份注释记的坑）。
        readCredential: resolveLoomyCredentialByRef,
        balance: {
          kind: 'loomy',
          selector: loomyBalanceSelector,
          lockedError: loomyLockedError,
        },
        fallback: { kind: 'ref', refName: LOOMY.defaultCredentialRef },
        // ⚠️ 先证明失败原因是不是限流（见该助手的说明，IKJOZ9）：唯一启用账号
        // 被该模型限流时，候选在筛选里已被筛空 —— 那不是「没登录」。
        throwIfAllRateLimited: throwIfAllAccountsRateLimited,
      },
    ),
    refresh: async (forCredential) => {
      // ⚠️ Loomy **没有 refresh 端点**，这里的 `refresh` 语义是
      // 「探测凭据是否仍有效」，失效时抛错提示重新登录。
      //
      // 仍须刷新**解析凭据时所用的那一个**账号，而不是默认单凭据 ref ——
      // 否则探测的是另一份凭据，用户会看到「刚登录好却一直认证失败」。
      //
      // ⚠️⚠️ **优先探测调用方指定的那一份凭据**（2026-10-20 审计 E-2）。
      //
      // 适配器在热路径上用它裁决「**本轮要用的那份**凭据还能不能用」，
      // 而这里原先恒探测 `pool.getAvailableAccount(LOOMY.id, '')` = **池默认号**
      // ⇒ 二者可能不是同一个号 ⇒ **另一个号的终态会打死本轮**
      //（实测：本轮号完全可用，仍整轮失败、业务请求 0 次）。
      //
      // ⚠️ 反查失败时**退回原行为**（探测默认号）而不是跳过探测：
      //    「宁可退化成旧行为，也不要凭空少做一次健康检查」。
      const target = forCredential === undefined
        ? undefined
        : await pool.findAccountIdByCredential(LOOMY.id, forCredential.access_token).catch(() => undefined)
      // ⚠️ 从池里取**该账号自己的** `credentialRef`，不自己拼 `LOOMY_ACCOUNT_` 前缀
      //    —— 前缀是记账格式，拼错会静默探测到另一份/不存在的凭据。
      const targetEntry = target === undefined || target.length === 0
        ? undefined
        : pool.listAccountsByProvider(LOOMY.id).find((entry) => entry.id === target)
      if (targetEntry !== undefined) {
        await loomy.refreshAccountCredential(targetEntry.credentialRef, pool, targetEntry.id)
        return
      }
      const available = await pool.getAvailableAccount(LOOMY.id, '')
      if (available) await loomy.refreshAccountCredential(available.entry.credentialRef, pool, available.entry.id)
      else await loomy.refresh()
    },
    // ⚠️ 必须注入：适配器在热路径上把「非终态探测失败」降级为告警而不是抛错，
    // 没有这个出口就等于静默（本仓库反复记录过的失败形态）。
    warn: (message) => ctx.logger?.warn?.(message),
    // 远端模型目录：GET /api/v1/models。
    // ⚠️ 必须用 **token 头**（业务端点），不是 Bearer —— 带错会得到
    // `100002 缺少 token`，表现为「模型列表永远停在兜底表」。
    // 失败时返回空数组，由适配器回退兜底表。
    fetchRemoteModels: async () => {
      const available = await pool.getAvailableAccount(LOOMY.id, '')
      const resolved = available !== null && available !== undefined
        ? { value: JSON.stringify(available.credential) }
        : await ctx.credentials.resolve(credentialRef(LOOMY.defaultCredentialRef))
      if (resolved === undefined) return []
      let credential: LoomyCredential
      try {
        credential = JSON.parse(resolved.value) as LoomyCredential
      } catch {
        return []
      }
      const response = await fetch(`${LOOMY.apiBase}/models`, {
        headers: { Accept: 'application/json', token: credential.access_token },
        signal: AbortSignal.timeout(30_000),
      })
      if (!response.ok) return []
      return parseLoomyRemoteModels(await response.json())
    },
    // 图片字节桥接：按模型能力判定（远端 capabilities.input_modalities 含 image）。
    readImage: makeReadImage(ctx),
    accountPool: pool,
    product: LOOMY,
  })

  // ===== Raccoon Work（商汤小浣熊）服务 =====
  // 第九个产品线。登录与 Loomy 同型（**本地页承载**的微信扫码 + 短信双路径），
  // 但**有** refresh 端点（凭据可静默续期），且客户端可能未安装。
  //
  // ⚠️ **不依赖客户端**：官方桌面端靠 `office-raccoon://auth/callback` 自定义协议
  // 回调，本插件（宿主侧 Node 进程）收不到；故改为「宿主本地生成 code + 自行轮询」，
  // 完全绕开该回调。凭据存插件自有的 ctx.credentials，不读客户端任何文件。
  // 见 tests/unit/raccoon-client-independence.spec.ts 的回归防线。
  //
  // 服务名由 RaccoonAuth 依 product.id 派生，注册为 ctx.raccoonAuth。
  // 不注册斜杠命令：入口在 Jet Hub 的 Raccoon 面板。
  const raccoon = new RaccoonAuth(ctx)
  const raccoonAdapter = registerRaccoonLlm(ctx, {
    credentialRef: credentialRef(RACCOON.defaultCredentialRef),
    // 只从 raccoon 自己的账号池取账号，回退到自己的单凭据 ref，
    // 保证不会串用其它 provider 的凭据。
    // provider 实参用 RACCOON 而非字面量：写死字面量在改名/多产品场景下
    // 会静默查不到账号（本插件在 workbuddy 上踩过同类坑）。
    // ⚠️ `modelId` 透传：否则模型级限流标记被忽略（详见 buddy 处说明）。
    resolveCredential: createCredentialResolver<RaccoonCredential>(
      { pool, reportAccount: (id) => { if (id !== undefined) reportLedgerAccount(RACCOON.id, id) } },
      {
        product: RACCOON,
        // ⚠️ raccoon 的兜底是**裸 `JSON.parse`**（历史形态，本 Task 逐字保留）。
        // 它此前也没有形状校验，本 Task 的约束是零行为变更 ⇒ 不在此处加严。
        readCredential: async (refName) => {
          const resolved = await ctx.credentials.resolve(credentialRef(refName))
          if (!resolved) return undefined
          try {
            // `getAvailableAccount` 的凭据类型是 `CodeArtsCredential | BuddyCredential`
            // 联合（历史遗留），与 `RaccoonCredential` 无充分重叠，故经 `unknown` 转换。
            return JSON.parse(resolved.value) as unknown as RaccoonCredential
          } catch {
            return undefined
          }
        },
        fallback: { kind: 'ref', refName: RACCOON.defaultCredentialRef },
        // 区分「全部限流」与「没登录」（见该助手的说明，IKJOZ9）。
        throwIfAllRateLimited: throwIfAllAccountsRateLimited,
      },
    ),
    refresh: async () => {
      // ⚠️ raccoon **有** refresh 端点（与 Loomy 恒 false 不同），这里是真续期。
      //
      // 仍须刷新**解析凭据时所用的那一个**账号，而不是默认单凭据 ref ——
      // 否则续期的是另一份凭据，用户会看到「刚登录好却一直认证失败」。
      const available = await pool.getAvailableAccount(RACCOON.id, '')
      if (available) {
        // ⚠️ **必须传 pool + entry.id**：续期成功后要把新的 `expiresAt` 写回
        // 账号池，否则 UI 会一直显示「已过期」而实际能正常发消息
        //（真实缺陷：JWT 已续到 15:09、账号池仍是 12:02，相差 3.1 小时）。
        // 这条路径正是「发消息时按需续期」，故它是最常触发回写的地方。
        await raccoon.refreshAccountCredential(
          available.entry.credentialRef, pool, available.entry.id,
        )
      } else {
        await raccoon.refresh()
      }
    },
    // 远端模型目录：委托给 RaccoonAuth.fetchModels（它负责 Bearer 头与
    // visible 过滤 + raccoonDisplayName 生成含倍率的展示名）。
    // 失败时返回空数组，由适配器回退兜底表。
    fetchRemoteModels: () => raccoon.fetchModels(pool),
    // 图片字节桥接：按模型能力判定（远端 tags 含 vision）。
    readImage: makeReadImage(ctx),
    // ⚠️ raccoon 尤其需要请求版本：该网关按**请求体字节**设限
    // （实测 `HTTP_413: request body exceeds 10MB`，两张大截图就占掉大半配额）。
    readImageRequest: makeReadImageRequest(ctx),
    accountPool: pool,
    product: RACCOON,
  })

  // ===== MiniMax Code（中国版）服务 =====
  //
  // ⚠️ 登录走 **OAuth 设备码 + PKCE**（与 Qoder 同型：不起本地监听端口，
  // `startLogin` 立即返回 `verification_uri_complete`，后台轮询换 token）。
  // 但协议族与其余九个都不同 —— 它是**首个 Anthropic Messages 协议族**的 provider。
  //
  // ⚠️ **本轮不实现推理**：账号余额不足（`insufficient_balance_error`），无法端到端
  // 验证。适配器的 `stream()` 抛明确错误（**不静默返回空流** —— 静默会让 UI 表现为
  // 「干净地停止、无任何报错」，是 Qoder 早期的同型缺陷）。
  // 故**不传** `readImage` / `readImageRequest`（图片只在推理时有意义）。
  //
  // 服务名由 MinimaxAuth 依 product.id 派生，注册为 ctx.minimaxAuth。
  // 不注册斜杠命令：入口在 Jet Hub 的 MiniMax 面板。
  /**
   * 按凭据 ref 解析 MiniMax 凭据（**两个产品共用**）。
   *
   * ⚠️ 拆成具名函数（原先是两处内联的匿名箭头，逐字重复）：选号器的
   * `resolveCredential` 与注册项的 `readCredential` 必须是**同一个**解析器 ——
   * 写两份、强度不一致 = 改一处漏一处（本仓库在 LobsterAI / TRAE / AStudio
   * 三处都踩过这个形态）。
   *
   * ⚠️ **保持裸 `JSON.parse` 的历史形态，不在此处加形状校验**：那会是行为变更
   * （与 raccoon / gemini 同款）；本函数只做「抽出来共用」这一件事。
   */
  const resolveMinimaxCredentialByRef = async (
    refName: string,
  ): Promise<MinimaxCredential | undefined> => {
    const resolved = await ctx.credentials.resolve(credentialRef(refName))
    if (!resolved) return undefined
    try {
      return JSON.parse(resolved.value) as unknown as MinimaxCredential
    } catch {
      return undefined
    }
  }
  /**
   * MiniMax 两站的**按「积分何时作废」分档选号器**（为「锁定永久积分」提供依据）。
   *
   * ⚠️ 复用 `BuddyBalanceSelector` 而不是新写一个：分档判据
   * （`splitBuddyCreditsByExpiry`）只读通用的
   * `packages[].{ active, remaining, deductionEndTime }`，**与 provider 无关**。
   * `fetchMinimaxCreditBalanceDetailed` 自 2026-10-20 起把每条明细的
   * `expire_at_ms`（毫秒时间戳，实测无需 ×1000）归一化到 `deductionEndTime`。
   *
   * ⚠️ **两站各一个实例**：选择器内含按账号 id 的余额缓存，共用会串味
   *（两站账号不互通、主机也不同）。
   *
   * ⚠️⚠️ **国际站必须透传 XFF**（与 `creditsTable` / `expiryTable` 那两处同因）：
   * `agent.minimax.io` 按出口 IP 把大陆来源 307 到中国站，而中国站不认国际站
   * token ⇒ 折算恒失败 ⇒ 该渠道在聚合轮换里被**静默**剔除（面板却还能刷新，
   * 因为那走的是另一条带了 XFF 的链路）。`pool.minimaxXff()` **每次现读**，
   * 不固化成字符串 —— 用户随时可能改设置。
   */
  const minimaxBalanceSelector = new BuddyBalanceSelector({
    product: MINIMAX,
    resolveCredential: resolveMinimaxCredentialByRef,
    fetchBalance: (credential, product) => fetchMinimaxCreditBalance(credential, fetch, product),
  })
  const minimaxIntlBalanceSelector = new BuddyBalanceSelector({
    product: MINIMAX_INTL,
    resolveCredential: resolveMinimaxCredentialByRef,
    fetchBalance: (credential, product) =>
      fetchMinimaxCreditBalance(credential, fetch, product, pool.minimaxXff()),
  })
  const minimax = new MinimaxAuth(ctx)
  const minimaxAdapter = registerMinimaxLlm(ctx, {
    credentialRef: credentialRef(MINIMAX.defaultCredentialRef),
    // provider 实参用 MINIMAX 而非字面量：写死字面量在改名/多产品场景下
    // 会静默查不到账号（本插件在 workbuddy 上踩过同类坑）。
    // ⚠️ 只从 minimax 自己的账号池取账号，回退到自己的单凭据 ref，
    // 保证不会串用其它 provider 的凭据。
    resolveCredential: createCredentialResolver<MinimaxCredential>(
      { pool, reportAccount: (id) => { if (id !== undefined) reportLedgerAccount(MINIMAX.id, id) } },
      {
        product: MINIMAX,
        // ⚠️ 与选号器**共用同一个**解析器（原先这里是一份内联的匿名箭头，
        //    与下面 MINIMAX_INTL 那份逐字重复 ⇒ 改一处漏一处；已抽成
        //    `resolveMinimaxCredentialByRef`）。历史形态是**裸 `JSON.parse`**，
        //    逐字保留，不在此处加形状校验（那会是行为变更）。
        readCredential: resolveMinimaxCredentialByRef,
        /**
         * ⚠️ **2026-10-20 新增**（用户报障：「MiniMax Code 积分也有到期时间，
         * 也应当有相同功能」）。
         *
         * 此前本家**不传 `balance`** ⇒ 走 `getAvailableAccount` 的「手动序第一个
         * 启用账号」，**与到期时间无关** ⇒ 既没有「临期优先」，也没有任何东西
         * 可供「锁定永久积分」判断 ⇒ 锁上了也不知道该不该拦。
         *
         * ⚠️ 本家**没有**免费模型概念（`MinimaxAdapter` 不实现 `isFreeModel`），
         * 故不传该字段 —— 缺省 `undefined` 走常规分档路径（正确行为）。
         */
        balance: {
          kind: 'buddy',
          selector: minimaxBalanceSelector,
          lockedError: minimaxLockedError('MiniMax Code (中国版)'),
          /**
           * ⚠️⚠️ **刻意不写 `reportPickedAccount: false`**（与 buddy 系那两处**相反**）。
           *
           * `reportPickedAccount: false` 是**buddy 系旧闭包的历史不对称**
           *（它们只在池兜底那一支回报），本 Task 逐字保留。而 MiniMax 的旧闭包
           * 是**纯池选号**（本就无余额分档）⇒ 它的账本**一直在回报**。
           * 若照抄 buddy 写 `false`，本节新增的 `balance` 会让「分档选中」那支
           * 不再回报 ⇒ **账本归属静默丢失**（token 用量记不到这个渠道上）。
           * 该形态由 `tests/unit/credential-resolver.spec.ts` 的
           * 「<provider>：池命中时回报 token 账本」逐家驱动 `apply()` 守着 ——
           * minimax / minimaxintl 正在那份名单里（它们此前**可达**）。
           */
          reportPickedAccount: true,
        },
        fallback: { kind: 'ref', refName: MINIMAX.defaultCredentialRef },
        // 区分「全部限流」与「没登录」（见该助手的说明，IKJOZ9）。
        throwIfAllRateLimited: throwIfAllAccountsRateLimited,
      },
    ),
    refresh: async () => {
      // ⚠️ MiniMax **有** refresh 端点（`/oauth2/token` 的 refresh_token 授权），
      // 这里是真续期（与 Loomy 的「只能探测有效性」不同）。
      //
      // 仍须刷新**解析凭据时所用的那一个**账号，而不是默认单凭据 ref ——
      // 否则续期的是另一份凭据，用户会看到「刚登录好却一直认证失败」。
      const available = await pool.getAvailableAccount(MINIMAX.id, '')
      if (available) {
        // ⚠️ **必须传 pool + entry.id**：续期成功后要把新的 `expiresAt` 写回
        // 账号池，否则 UI 会一直显示「已过期」而实际能正常发消息
        //（真实缺陷：JWT 已续到 15:09、账号池仍是 12:02，相差 3.1 小时）。
        //
        // ⚠️ `getAvailableAccount` 返回 **`{ entry, credential }`** 两层 ——
        // 账号 id 与 credentialRef 在 **`available.entry`** 里，**不是**
        // `available.id` / `available.credentialRef`（那是 `undefined`，
        // 会让续期**静默写不回账号池**）。
        await minimax.refreshAccountCredential(
          available.entry.credentialRef, pool, available.entry.id,
        )
      } else {
        await minimax.refresh()
      }
    },
    // 远端模型目录：委托给 MinimaxAuth.fetchModels（它负责 Bearer 头 + 信封解析）。
    // ⚠️ **必须走远端** —— 客户端内置静态表只有 3 个模型，远端下发 4 个，
    // 照抄内置表会漏掉 `MiniMax-M3.1-Flash-Preview`（用户截图里选中的那个）。
    // 失败时返回兜底表（适配器侧也有兜底）。
    fetchRemoteModels: () => minimax.fetchRemoteModelsOnly(pool),
    // 图片字节桥接：模态按模型判定（远端 `modalities.input` 含 image，
    // 只有 M3.1-Flash-Preview 与 M3 是）。适配器声明不支持时会**报错**，
    // 不会把图片发出去让服务端 400。
    // ⚠️ 实测 MiniMax 收 **裸 base64** 的 Anthropic `image.source.base64`
    // （OpenAI 的 `image_url` 形状被服务端明确拒绝）。
    // ⚠️ 暂**不接** `readImageRequest` 缩放桥接：MiniMax 的单图上限是
    // 10 MiB（远端 `capabilities.max_image_bytes_inline`），未实测过超限行为，
    // 不凭猜测加一层（Qoder/Raccoon 是**实测撞了体积限制**才接的）。
    readImage: makeReadImage(ctx),
    accountPool: pool,
    product: MINIMAX,
  })

  // ===== MiniMax Code 国际版（minimaxintl）=====
  //
  // 与中国版是**同一套协议实现**的第二个实例（差异全在 `MINIMAX_INTL` 配置里：
  // 主机 `account.minimax.io` / `agent.minimax.io`、目录 region `en`、
  // 凭据 ref 前缀 `MINIMAXINTL_`）。刻意**不复制**任何 `src/minimax*.ts`
  // 实现文件 —— 协议同源，复制会让同类缺陷（SSE 收尾丢帧、换号记账、
  // 思考档位）修两遍。
  //
  // 服务名由 `${product.id}Auth` 派生，注册为 `ctx.minimaxintlAuth`
  //（product id 全小写、不带连字符 —— 按变量名驼峰惯例拼会得到大小写不符的名字）。
  //
  // ⚠️ **两站账号不互通、API 主机也不同** ⇒ 它们是两个 provider 而不是
  //    「一个 provider 加一个站点参数」（理由见 `src/minimax-product.ts` 文件头）。
  // ⚠️ **验证状态如实标注**（2026-10-16 合并审计修正 —— 原文写「三项未真机验证」，
  //    已被本 PR 后续的真机取证推翻，见 `src/minimax-product.ts` 文件头的实测表）：
  //    推理路径与签到端点形状**已真机验证通过**（2026-10-15，真实国际站账号，
  //    推理 200 + 真实 SSE、签到/积分 200）；**只有兜底模型表**未按国际站远端采集
  //   （它与国内站共用同一份，只在远端失败时兜底）。
  const minimaxIntl = new MinimaxAuth(ctx, { product: MINIMAX_INTL })
  const minimaxIntlAdapter = registerMinimaxLlm(ctx, {
    credentialRef: credentialRef(MINIMAX_INTL.defaultCredentialRef),
    // ⚠️ provider 实参必须是 MINIMAX_INTL：写死 MINIMAX 会让国际站永远查不到
    // 自己的账号（本插件在 workbuddy 上踩过同类坑）。
    resolveCredential: createCredentialResolver<MinimaxCredential>(
      { pool, reportAccount: (id) => { if (id !== undefined) reportLedgerAccount(MINIMAX_INTL.id, id) } },
      {
        product: MINIMAX_INTL,
        // ⚠️ 与中国版**共用同一个**解析器（见 `resolveMinimaxCredentialByRef` 的说明）。
        //    两站凭据形状逐字相同（同一套 OAuth 实现，只换主机与 ref 前缀）。
        readCredential: resolveMinimaxCredentialByRef,
        // ⚠️ 与中国版**同因同日**新增（2026-10-20）：两站共用同一个
        //    `fetchMinimaxCreditBalanceDetailed`。
        //    ⚠️⚠️ 但**选号器必须是国际站那一个实例** —— 它透传 `pool.minimaxXff()`
        //    （绕地理分流，issue IKMEVG）；误用国内站实例会让国际站余额查询
        //    恒失败 ⇒ 该渠道在聚合轮换里被静默剔除。
        balance: {
          kind: 'buddy',
          selector: minimaxIntlBalanceSelector,
          lockedError: minimaxLockedError('MiniMax Code (国际版)'),
          // ⚠️ 与中国版**同因**：本家旧闭包是纯池选号、账本一直在回报 ⇒
          //    必须 `true`，写 `false` 会让 token 用量记不到国际站上（见中国版处说明）。
          reportPickedAccount: true,
        },
        fallback: { kind: 'ref', refName: MINIMAX_INTL.defaultCredentialRef },
        throwIfAllRateLimited: throwIfAllAccountsRateLimited,
      },
    ),
    refresh: async () => {
      // 同中国版：刷新**解析凭据时所用的那一个**账号，不是默认单凭据 ref。
      const available = await pool.getAvailableAccount(MINIMAX_INTL.id, '')
      if (available) {
        // ⚠️ **必须传 pool + entry.id**（两层结构）：否则续期成功后新 `expiresAt`
        // 写不回账号池，UI 会一直显示「已过期」而实际能正常发消息。
        await minimaxIntl.refreshAccountCredential(
          available.entry.credentialRef, pool, available.entry.id,
        )
      } else {
        await minimaxIntl.refresh()
      }
    },
    fetchRemoteModels: () => minimaxIntl.fetchRemoteModelsOnly(pool),
    readImage: makeReadImage(ctx),
    accountPool: pool,
    product: MINIMAX_INTL,
  })

  // ===== Gemini（Google Cloud Code Assist 免费线）=====
  //
  // ⚠️ **只做 OAuth**（用户拍板）：API key / AI Studio 两条线不做 —— 免费线
  // 是 Cloud Code 项目制，凭据就是 Google OAuth 的 access_token + refresh_token。
  //
  // 与其余 provider 的四处**形态差异**（全部来自 `docs/GEMINI-PORT-PLAN.md`
  // §2.2 的抓包实测，**不许"顺手统一"**）：
  //   1. 请求走**双层信封**（`{model, project, request:{contents,…}}`），且
  //      **必须逐层字母序序列化** —— 上游对字段顺序敏感，原版靠 Go 的 map
  //      键自动排序实现；TS 的 `JSON.stringify` 按插入序，故走
  //      `marshalAlphabetical`（见 `gemini.ts`）。
  //   2. 五个身份头**逐字写死**（`geminiHeaders`），且流式请求**刻意不带
  //      `Accept`**（与抓包一致）。
  //   3. `thoughtSignature` 是**跨轮状态**：`functionCall` 上的签名要落盘、
  //      下一轮按「工具名 + 规范化参数」回填，否则多轮工具调用必被上游拒。
  //      故这里建一个独立的 `gemini-sigs.json` 缓存（**不放 state.json** ——
  //      那是整体替换语义，会被别的写入覆盖掉）。
  //   4. 模型暴露 1 个 `gemini-3.8-flash` + 4 档 efforts（低/中/高/自适应）；
  //      **不**暴露带后缀的模型名，也**不**暴露 lite（上游恒 404，用户
  //      2026-10-03 拍板移除）。
  //
  // 服务名由 GeminiAuth 依 product.id 派生，注册为 ctx.geminiAuth。
  // 不注册斜杠命令：入口在 Jet Hub 的 Gemini 面板。
  //
  // ⚠️ Gitee issue IKLTZ2：Gemini 全部端点都在墙外，而 undici 既不读 Windows
  // 系统代理、也不读 `HTTP(S)_PROXY` ⇒ 「浏览器授权成功、面板里账号一直不出现」。
  // 这里接上**按账号取 fetcher** 的解析器（与 `probeById` 共用同一份）。
  setGeminiProxyPool(pool)
  const gemini = new GeminiAuth(ctx, { fetchFor: geminiFetchForAccount })
  const geminiSigStore = createGeminiSigStore(ctx)
  // ⚠️ 项目号探测缓存必须**在这里建一次、长期复用** —— 每次 `stream()` 现造
  // 等于没有跨请求缓存，每轮推理都会多打一次 `loadCodeAssist`。
  const geminiProjectCache = new Map<string, string>()
  const geminiAdapter = registerGeminiLlm(ctx, {
    credentialRef: credentialRef(GEMINI.defaultCredentialRef),
    // ⚠️ provider 实参用 GEMINI 而非字面量（同 minimax 的既有约定：
    // 写死字面量在改名/多产品场景下会静默查不到账号）。
    resolveCredential: createCredentialResolver<GeminiCredential>(
      { pool, reportAccount: (id) => { if (id !== undefined) reportLedgerAccount(GEMINI.id, id) } },
      {
        product: GEMINI,
        // ⚠️ 与 raccoon / minimax 同款：兜底是**裸 `JSON.parse`**（历史形态，
        // 本 Task 逐字保留，不在此处加形状校验 —— 那会是行为变更）。
        // `getAvailableAccount` 的凭据类型是历史遗留的联合类型，与
        // `GeminiCredential` 无充分重叠，故经 `unknown` 转换；运行时安全性由
        // provider 过滤保证（查询用 `GEMINI.id`，取到的必是 gemini 凭据）。
        readCredential: async (refName) => {
          const resolved = await ctx.credentials.resolve(credentialRef(refName))
          if (!resolved) return undefined
          try {
            return JSON.parse(resolved.value) as unknown as GeminiCredential
          } catch {
            return undefined
          }
        },
        fallback: { kind: 'ref', refName: GEMINI.defaultCredentialRef },
        // 区分「全部限流」与「没登录」（见该助手的说明，IKJOZ9）。
        throwIfAllRateLimited: throwIfAllAccountsRateLimited,
      },
    ),
    refresh: async () => {
      // ⚠️ 必须刷新**解析凭据时所用的那一个**账号，而不是默认单凭据 ref ——
      // 否则续期的是另一份凭据，用户会看到「刚登录好却一直认证失败」。
      const available = await pool.getAvailableAccount(GEMINI.id, '')
      if (available) {
        // ⚠️ **必须传 pool + entry.id**：续期成功后要把新的 `expiresAt` 写回
        // 账号池，否则 UI 一直显示「已过期」而实际能正常发消息。
        // ⚠️ `getAvailableAccount` 返回 **`{ entry, credential }`** 两层 ——
        // 账号 id 与 credentialRef 在 **`available.entry`** 里，**不是**
        // `available.id` / `available.credentialRef`（那是 `undefined`，
        // 会让续期**静默写不回账号池**）。
        await gemini.refreshAccountCredential(
          available.entry.credentialRef, pool, available.entry.id,
        )
      } else {
        await gemini.refresh()
      }
    },
    // 模型表是**静态**的（用户拍板：不拉远端目录，Cloud Code 没有模型列表端点）。
    // 故这里不传 `fetchRemoteModels`。
    // 图片两跳：先按 640,000 px 预算取缩放版，拿不到才发原图。
    readImage: makeReadImage(ctx),
    readImageRequest: makeReadImageRequest(ctx),
    sigStore: geminiSigStore,
    accountPool: pool,
    product: GEMINI,
    // 项目号：缺省**自动探测**（`loadCodeAssist` 的 `cloudaicompanionProject`），
    // 不是恒为 `aicode-consumers`（那只是探测为空时的兜底）。
    projectCache: geminiProjectCache,
    // ⚠️ **推理主路径的出口**（IKLTZ2）：此前这里只有裸 `fetch`（连 seam 都没有）。
    fetchFor: geminiFetchForAccount,
    persistProject: async (value: string) => {
      // ⚠️ 回写到**解析凭据时所用的那个账号**，不是默认单凭据 ref ——
      // 写错对象会让另一个账号的凭据被污染。
      const available = await pool.getAvailableAccount(GEMINI.id, '')
      const ref = available
        ? available.entry.credentialRef
        : credentialRef(GEMINI.defaultCredentialRef)
      await ctx.credentials.set(credentialRef(ref), value)
    },
    ...ctx.logger === undefined ? {} : { logger: ctx.logger },
  })

  // ===== Accio（阿里 Accio Work）=====
  //
  // 与其余 provider 的**三处实测差异**（`docs/agent-notes/providers-accio.md`，
  // 全部来自真实凭据的对照实测，**不许「顺手统一」**）：
  //   1. **有标准 OAuth 2.0 + PKCE**（`client_id='accio-work'`，公开客户端）
  //      ⇒ 完全脱离 IDE，**不读**本机 `credentials.enc`、**不需要** DPAPI；
  //   2. **不需要 SecurityGuard 签名** —— 不带 `pctb-x-*` 同样 200
  //      ⇒ 不需要 `security_guard.node` 与那串阿里 DLL（参考实现把它当必需是过度设计）；
  //   3. 但 **token 必须放 body 的 `token` 字段** —— 放 `Authorization` 头恒
  //      **流内 402**（HTTP 仍是 200 ⇒ 不看流内 `error_code` 会误判成「成功但没内容」）。
  //
  // 服务名由 AccioAuth 依 product.id 派生，注册为 ctx.accioAuth。
  // 不注册斜杠命令：入口在 Jet Hub 的 Accio 面板。
  // ===== AutoClaw（智谱清言）=====
  /**
   * 按凭据 ref 解析 AutoClaw 凭据（供选号器查余额与最终取凭据共用）。
   *
   * ⚠️ **两站共用这一份**（`autoclaw` / `autoclawintl` 的凭据形状逐字相同：
   * 同一套协议实现，差异只在主机与 ref 前缀）—— 与 qoder 那份同因，
   * 各写一遍 = 改一处漏一处。
   *
   * ⚠️ **逐字保留历史上的裸 `JSON.parse` 形态**（不在此处加形状校验）：
   * 加校验是一次**行为变更**（此前被接受的损坏凭据会变成被拒），不在本任务范围内。
   */
  const resolveAutoclawCredentialByRef = async (refName: string) => {
    const resolved = await ctx.credentials.resolve(credentialRef(refName))
    if (!resolved) return undefined
    try {
      return JSON.parse(resolved.value) as unknown as AutoclawCredential
    } catch {
      return undefined
    }
  }
  /**
   * AutoClaw 两站的**按「额度何时作废」分档选号器**（2026-10-21，
   * 用户要求「补锁定开关」）。
   *
   * ## 为什么本家需要它
   *
   * `autoclaw-credits.ts` 的批次映射里有一条**代码分支**：`wallet_expires_at`
   * 缺失 / `<= 0` 的发放 ⇒ 进 `permanentByLabel` ⇒ **不带 `deductionEndTime`**
   * （= 永久桶）。⇒ 只要上游下发那种条目，用户钱包里就会有永不作废的积分，
   * 需要能保护它们。补登记 `permanentLock` **必须同时接上本选号器**，
   * 否则就是**假开关**（按钮在、点了不拦 —— `credential-resolver.ts` 的
   * `allowPermanent` 只在 `balance` 计划存在时才被读到）。
   *
   * ⚠️⚠️ **前提强度如实标注（2026-10-21 二轮审计）**：上述「永久桶」分支
   * **结构上可达、但零实测**。仓库内唯一一次针对流水字段完整性的实测
   *（`5fbe7ab` 的 commit message）结论是「**28/28 全带 `wallet_expires_at`**」——
   * 方向上**否定**该形态存在。若上游确实恒带到期字段，则本家的永久桶**恒为空**
   * ⇒ `allowPermanent` 为 true/false 行为完全相同 ⇒ 这个开关**永不产生实际效果**
   *（但也不会出错：它只是把「已存在的分档能力」接上）。
   *
   * ⇒ 保留本接线（成本为零、与仓库 11 家同构、上游一旦下发无到期条目即生效），
   *   但**不得**声称「本家确实有永久桶」。可核实的验证方法见审计报告 §十三。
   *
   * ## 为什么复用 `BuddyBalanceSelector`
   *
   * 分档判据（`splitBuddyCreditsByExpiry`）只读通用的
   * `packages[].{active, remaining, deductionEndTime}`，**与 provider 无关**；
   * `autoclaw-credits.ts` 的批次包正是这个形状（`deductionEndTime` 由
   * `wallet_expires_at` 秒级归一成毫秒）。
   *
   * ## ⚠️ 与 buddy 系的**关键差异**（别照抄那两行）
   *
   * | | buddy 系 | AutoClaw |
   * |---|---|---|
   * | `rateLimit` | 省缺 true | **false**（不写 `modelRateLimits`、不在 `probeById`）|
   * | 请求级换号 | 有 | **刻意没有** |
   * | 「每日红」池语义 | 有 | **不适用**（签到积分是发放进余额、按批次到期）|
   *
   * ⇒ 本家的锁定只作用于「按余额分档选号」这一层，不涉及换号冷却（本来就没有）。
   *
   * ## ⚠️ 两家各建一个实例，不得合并
   *
   * 选择器内含**按账号 id 的缓存**，跨站共用会让一站的读数污染另一站
   * （与 minimax / qoder 两站同因）。
   *
   * ## ⚠️ 必须各传自己的 `product`
   *
   * `AUTOCLAW` 指向国内基址、`AUTOCLAW_INTL` 指向国际基址（`autoglm-api.autoglm.ai`）
   * —— 互换的后果**不是报错**而是静默：对方站点不认本站 token ⇒ 余额恒 `null`
   * ⇒ 未锁定时换号优化失效、锁定时永远报「没有可用账号」。
   */
  const autoclawBalanceSelector = new BuddyBalanceSelector({
    product: AUTOCLAW,
    resolveCredential: resolveAutoclawCredentialByRef,
    fetchBalance: (credential, product) => fetchAutoclawCreditBalance(credential, { product }),
  })
  const autoclawIntlBalanceSelector = new BuddyBalanceSelector({
    product: AUTOCLAW_INTL,
    resolveCredential: resolveAutoclawCredentialByRef,
    fetchBalance: (credential, product) => fetchAutoclawCreditBalance(credential, { product }),
  })
  const autoclaw = new AutoclawAuth(ctx)
  const autoclawAdapter = registerAutoclawLlm(ctx, {
    resolveCredential: createCredentialResolver<AutoclawCredential>(
      { pool, reportAccount: (id) => { if (id !== undefined) reportLedgerAccount(AUTOCLAW.id, id) } },
      {
        product: AUTOCLAW,
        // ⚠️ 2026-10-21：改用上面共用的 `resolveAutoclawCredentialByRef`
        //    （原先这里是一份内联的逐字重复实现，两站各一份）。
        readCredential: resolveAutoclawCredentialByRef,
        fallback: { kind: 'ref', refName: AUTOCLAW.defaultCredentialRef },
        /**
         * ⚠️ **必须接 `balance`**（2026-10-21，用户要求「补锁定开关」）。
         *
         * registry 里登记 `permanentLock: true` 只让**按钮渲染**、RPC 放行；
         * 真正的拦截在 `credential-resolver.ts` 读
         * `pool.permanentLocked(providerId)` ⇒ 传给 `pickBuddyAccount`
         * 的 `allowPermanent`。**没有本段就是假开关**：按钮在、点了不拦。
         *
         * ⚠️ `reportPickedAccount: true` 是**必须的**（与 qoder / minimax 同因）：
         * 本家的旧闭包是**纯池选号**、账本**一直在回报**（见下面
         * `reportAccount` 那行）。接上 `balance` 后「分档选中」那一支若不回报
         * ⇒ token 用量记不到本渠道上（静默）。
         */
        balance: {
          kind: 'buddy',
          selector: autoclawBalanceSelector,
          // ⚠️ 本家独有文案（池名是「钱包流水批次」而不是 buddy 的「资源包」）。
          lockedError: autoclawLockedError('AutoClaw'),
          reportPickedAccount: true,
        },
        // ⚠️ **必须接**（与 accio 同因）：本工厂的兜底是**固定 ref**
        //    （`AUTOCLAW_ACCESS_TOKEN`），而 Jet Hub 登录只写
        //    `AUTOCLAW_ACCOUNT_XXX` ⇒ 池被筛空时它会退到那个**从不被写入**的
        //    ref，报出误导性的「请先登录」（issue IKJOZ9 的形态）。
        //    ⚠️ 今天它是**恒不命中的死代码**（`autoclaw-adapter.ts` 不写
        //    `modelRateLimits` —— `provider-runtime-wiring.spec.ts` 的
        //    `WRITE_SITE_FILES` 把这一点登记为空并**验证**了「确实没有写点」）。
        //    保留它是有意的：判据是「兜底形态是否会让池被筛空时报错」，
        //    而不是「今天有没有标记」。
        throwIfAllRateLimited: throwIfAllAccountsRateLimited,
      },
    ),
    product: AUTOCLAW,
    // ⚠️⚠️ **必须接 `readImage`**（2026-10-17 审计 P0 修复）。
    //    `zai_auto-fast` 的 `supportsImage: true` 有实测依据
    //    （`docs/autoclaw-models.md:42`：AutoClaw 体系内唯一支持图文多模态
    //    的通道），`resolveModel` 已据此向宿主声明 `['text','image']`
    //    ⇒ 宿主**不投影**图片、**原样**下发（`dsh-llm/lib/index.js:2311`）。
    //    ⚠️ **漏了它这条路径恒抛 `UNSUPPORTED_CONTENT`**：声明支持图片却
    //    必然失败，正是「声明即承诺」被破坏的形态（与 modelscope / opencode
    //    同约定：不传 `readImage` 时带图请求抛 `UNSUPPORTED_CONTENT`，而不是
    //    静默丢图让用户以为模型看到了图）。
    //    ⚠️ 刻意**不接** `readImageRequest` 缩放桥接：智谱侧对单图字节上限
    //    无实测依据，编一个预算是凭空造数字（同 modelscope 的取舍）。
    readImage: makeReadImage(ctx),
    // ⚠️⚠️ **必须接 `disabledModels` 与 `providerClosed`**（2026-10-20，IKP8OF）：
    //    本家手写 `listModels`、不走共享骨架，而这两条回调此前**一个都没传** ⇒
    //    用户在 Jet Hub 里关掉的 autoclaw 模型**照样出现在选择器里**（实测形态与
    //    modelscope 那条「接线层漏实参」逐字相同：字段与消费点都在，只缺实参）。
    //    `providerClosed` 另外覆盖「关闭之后才新增的模型」（黑名单里没有它们）。
    disabledModels: () => pool.disabledModelsFor(AUTOCLAW.id),
    providerClosed: () => pool.providerClosedFor(AUTOCLAW.id),
  })

  // ===== AutoClaw 国际版（autoclawintl）=====
  //
  // 与国内版是**同一套协议实现**的第二个实例（差异全在 `AUTOCLAW_INTL` 配置里：
  // 基址 `autoglm-api.autoglm.ai` / 凭据 ref 前缀 `AUTOCLAWINTL_`）。
  // 刻意**不复制**任何 `src/autoclaw*.ts` 实现文件 —— 协议同源，复制会让同类
  // 缺陷（净额批次、临期分档、签到判据）修两遍（与 `minimaxintl` 同纪律）。
  //
  // ⚠️⚠️ **为什么是独立 provider**（三条判据全中，见 `autoclaw-product.ts`
  //    `AutoclawProduct` 的注释表）：
  //    ① 账号体系不互通（国内手机号 `7c54a9ac…` / 国际邮箱 `2c99dc99…`）；
  //    ② API 主机不同；
  //    ③ **登录方式不同**（国内短信验证码 / 国际 Z.ai OAuth）。
  //
  //    实测佐证：拿国内签发的 token 打国际基址，`wallets` / `user-profile`
  //    一律 `410000 用户未登录`、推理 `401 Invalid token` ⇒ 用户体系物理隔离。
  //
  // ⚠️ **当前登录**：Z.ai OAuth 尚未接入（`state.nh` 来源未知，
  //    见 `AUTOCLAW_INTL` 的注释）⇒ 本 provider 目前只能手工注入 token 使用。
  //    接入后它会自己有一条 `login.startOAuth` 分支。
  const autoclawIntl = new AutoclawAuth(ctx, { product: AUTOCLAW_INTL })
  const autoclawIntlAdapter = registerAutoclawLlm(ctx, {
    resolveCredential: createCredentialResolver<AutoclawCredential>(
      { pool, reportAccount: (id) => { if (id !== undefined) reportLedgerAccount(AUTOCLAW_INTL.id, id) } },
      {
        product: AUTOCLAW_INTL,
        // ⚠️ 与国内版共用同一个解析器（两站凭据形状逐字相同）。
        readCredential: resolveAutoclawCredentialByRef,
        fallback: { kind: 'ref', refName: AUTOCLAW_INTL.defaultCredentialRef },
        // ⚠️ **必须接 `balance`**（与国内版同因同日，见那一段的长注释）。
        //    ⚠️ `selector` 必须是**国际站自己**那个实例（缓存不跨站共用）；
        //    `displayName` **必须**逐站区分（两站账号不互通，用户要知道去哪个面板解锁）。
        balance: {
          kind: 'buddy',
          selector: autoclawIntlBalanceSelector,
          lockedError: autoclawLockedError('AutoClaw (国际版)'),
          reportPickedAccount: true,
        },
        throwIfAllRateLimited: throwIfAllAccountsRateLimited,
      },
    ),
    // ⚠️ provider 实参必须是 AUTOCLAW_INTL：写死 AUTOCLAW 会让国际站永远
    //    查不到自己的账号（本插件在 workbuddy 上踩过同类坑）。
    product: AUTOCLAW_INTL,
    readImage: makeReadImage(ctx),
    // ⚠️⚠️ 同国内版（IKP8OF）：本家手写 `listModels`，两条回调必须显式接线。
    //    两个站点各一条，漏一处即该站静默失效（本仓库的既有纪律）。
    disabledModels: () => pool.disabledModelsFor(AUTOCLAW_INTL.id),
    providerClosed: () => pool.providerClosedFor(AUTOCLAW_INTL.id),
  })

  const accio = new AccioAuth(ctx)
  const accioAdapter = registerAccioLlm(ctx, {
    // ⚠️ **不传 `credentialRef`**：`AccioAdapterOptions` 里没有这一项 —— 该适配器
    // 从不直接读凭据 ref（`resolveCredential` 已把池选号与单凭据兜底都包住），
    // 与 trae / gemini 那几家「适配器自己读 ref」的形态不同。多传会被 tsc 拒。
    // provider 实参用 ACCIO 而非字面量（同 minimax / gemini 的既有约定：
    // 写死字面量在改名 / 多产品场景下会静默查不到账号）。
    // ⚠️ `modelId` 透传：否则模型级限流标记被忽略（见 buddy 处说明）。
    resolveCredential: createCredentialResolver<AccioCredential>(
      { pool, reportAccount: (id) => { if (id !== undefined) reportLedgerAccount(ACCIO.id, id) } },
      {
        product: ACCIO,
        // ⚠️ 与 raccoon / minimax / gemini 同款：兜底是**裸 `JSON.parse`**（历史形态，
        //    逐字保留，不在此处加形状校验 —— 那会是行为变更）。
        //    `getAvailableAccount` 的凭据类型是历史遗留的联合类型，与
        //    `AccioCredential` 无充分重叠，故经 `unknown` 转换；运行时安全性由
        //    provider 过滤保证（查询用 `ACCIO.id`，取到的必是 accio 凭据）。
        readCredential: async (refName) => {
          const resolved = await ctx.credentials.resolve(credentialRef(refName))
          if (!resolved) return undefined
          try {
            return JSON.parse(resolved.value) as unknown as AccioCredential
          } catch {
            return undefined
          }
        },
        fallback: { kind: 'ref', refName: ACCIO.defaultCredentialRef },
        // ⚠️ **必须接**：本工厂的兜底是**固定 ref**（`ACCIO_ACCESS_TOKEN`），而
        //    Jet Hub 登录只写 `ACCIO_ACCOUNT_XXX` ⇒ 池被筛空时它会退到那个
        //    **从不被写入**的 ref，报出误导性的「请先登录」（issue IKJOZ9 的形态，
        //    本仓库 12 家同型缺陷）。
        //    ⚠️ 与 zcode 的差别正在这里：zcode 的兜底是 `kind: 'custom'`（会**再读
        //    一次账号池**），故它不会误报、**刻意不接**；accio 的兜底是固定 ref。
        //    ⚠️ 今天它是**恒不命中的死代码**（`accio-adapter.ts` 不写
        //    `modelRateLimits`，池永远不会因模型级限流把 accio 账号筛空 ——
        //    `provider-runtime-wiring.spec.ts` 的 `WRITE_SITE_FILES` 把这一点
        //    登记为空并**验证**了「确实没有写点」）。**保留它是有意的**：
        //    判据是「兜底形态是否会让池被筛空时报错」，而不是「今天有没有标记」——
        //    将来给 accio 接上请求级换号 + 冷却（如 minimax 在 IKJW32 那样）时，
        //    这层守卫已经在位，不会静默退化成「请先登录」。
        throwIfAllRateLimited: throwIfAllAccountsRateLimited,
      },
    ),
    refresh: async () => {
      // ⚠️ **必须刷新「解析凭据时所用的那一个」账号**，而不是默认单凭据 ref ——
      // 否则续期的是另一份凭据，用户会看到「刚登录好却一直认证失败」。
      // ⚠️ **必须传 pool + entry.id**：续期成功后要把新的 `expiresAt` 写回账号池，
      //    否则 UI 一直显示「已过期」而实际能正常发消息（issue !IKIRTT 的形态）。
      // ⚠️ 池里没有账号时退到默认单凭据 ref：`AccioAuth` **没有** 无参 `refresh()`
      //    （与 buddy / trae 那几家不同），它的续期入口一律是
      //    `refreshAccountCredential(refName, …)`。
      const available = await pool.getAvailableAccount(ACCIO.id, '')
      if (available) {
        await accio.refreshAccountCredential(
          available.entry.credentialRef, pool, available.entry.id,
        )
      } else {
        await accio.refreshAccountCredential(ACCIO.defaultCredentialRef)
      }
    },
    // 远端模型目录：`POST /api/llm/config/v2`（token 在 body）。
    // 失败或未登录一律返回空数组，由适配器回退 `ACCIO.fallbackModels`。
    fetchRemoteModels: () => accio.fetchModels(pool),
    accountPool: pool,
    product: ACCIO,
    // ⚠️ **图片通路已接通**（issue IKLR7V，2026-10-14 真机实测）：
    //    上游原生收图（Gemini 风格的 `parts[].inline_data`），且 `multimodal: true`
    //    的模型四色全对、`multimodal: false` 的模型**静默忽略图片**（含一家会幻觉）。
    //    故这里接上字节桥接，`inputModalities` 按**逐模型**的 `supportsImage` 如实声明。
    //    ⚠️ 泛型参数（`AccioCredential`）与上面 `resolveCredential` 一致。
    readImage: makeReadImage(ctx),
    readImageRequest: makeReadImageRequest(ctx),
  })

  // ===== AStudio（讯飞 AstronStudio，云端直连上游 MAAS）=====
  //
  // 形态与 OfficeAce / Accio 同类：进程内 LlmAdapter 直发远端，无子进程、无端口。
  // 独有语义：**没有 OAuth 授权页**，凭据来自本机 AStudio 客户端的明文会话文件；
  // Jet Hub 的 account.create 因此走 importLocalSession（见 jet-hub-rpc.ts）。
  //
  // 服务名由 AstudioAuth 依 product.id 派生（astudioAuth）并在构造时自注册，
  // 故这里**不需要**再 ctx.provide('astudioAuth' / 'astudioLlm')。
  // 不注册斜杠命令：入口在 Jet Hub 的 AStudio 面板。
  const astudio = new AstudioAuth(ctx)
  /**
   * 按凭据 ref 解析 AStudio 凭据（供**选号器查余额**与最终取凭据共用）。
   *
   * ⚠️ 形状校验必须与 `astudio-auth.ts` 的 `parseAstudioCredential` 对齐
   *（判 `typeof access_token === 'string'`）。裸 `JSON.parse` 会让
   * `{"foo":1}` 这种损坏凭据被当成有效凭据返回，随后适配器的
   * `credential.access_token.length` 抛 **TypeError**（不可诊断），
   * 且发生在选号之后 —— 不在余额查询的 try/catch 覆盖范围内。
   * 这条注释与 LobsterAI / TRAE 那两处同因（写两遍、强度不一致 = 改一处漏一处）。
   *
   * 实测凭据字段（两个账号，2026-10-20）：`access_token`(65 字符) /
   * `account_id` / `uid` / `nickname` / `sso_session_id` / `token` /
   * `login_method` / `logged_in_at` / `source`。分档判据只用到
   * `access_token`（作为 `Cookie: ssoSessionId=` 的值去查 `/points/balance`）。
   */
  const resolveAstudioCredentialByRef = async (
    refName: string,
  ): Promise<AstudioCredential | undefined> => {
    const resolved = await ctx.credentials.resolve(credentialRef(refName))
    if (!resolved) return undefined
    try {
      const parsed = JSON.parse(resolved.value)
      return typeof parsed === 'object' && parsed !== null && typeof parsed.access_token === 'string'
        ? (parsed as AstudioCredential)
        : undefined
    } catch {
      return undefined
    }
  }
  /**
   * AStudio 的**按「积分何时作废」分档选号器**（为「锁定永久积分」提供依据）。
   *
   * ⚠️ 复用 `BuddyBalanceSelector` 而不是新写一个：分档判据
   * （`splitBuddyCreditsByExpiry`）只读通用的
   * `packages[].{ active, remaining, deductionEndTime }`，**与 provider 无关**。
   * AStudio 的 `buildAstudioBalance` 自 2026-10-20 起把
   * `{member,buy,activity}NextExpireTime`（不带时区的本地时间串，实测形如
   * `"2026-11-20T01:50:14"`）归一化到 `deductionEndTime`（毫秒），故结构一致。
   *
   * ⚠️ **缓存不能跨站共用**（选择器内含按账号 id 的缓存），故每家一个实例。
   *
   * ⚠️ 到期时间缺失的包归入**永久桶**（`splitBuddyCreditsByExpiry` 的保守方向）：
   * 宁用锁定时少用一个号，也不要把长期积分误当快到期烧掉。
   */
  const astudioBalanceSelector = new BuddyBalanceSelector({
    product: ASTUDIO,
    resolveCredential: resolveAstudioCredentialByRef,
    fetchBalance: (credential, product) => fetchAstudioCreditBalance(credential, product),
  })
  /**
   * AStudio 的凭据编排（候选筛选 → 余额分档 → 取凭据 → 回退）。
   *
   * ⚠️ 单独取名而不是内联，因为下面 `registerAstudioLlm` 的 `resolveCredential`
   * 是**零参**签名，必须先拿到这个带参函数再包一层（见那处注释）。
   */
  const astudioCredentialPlan = createCredentialResolver<AstudioCredential>(
    {
      pool,
      reportAccount: (id) => {
        if (id !== undefined) reportLedgerAccount(ASTUDIO.id, id)
      },
    },
    {
      product: ASTUDIO,
      // ⚠️ 必须传 ASTUDIO 自己的解析器（buddy 系那份虽然形状恰好兼容 ——
      //    同样判 `access_token` 是字符串 —— 但两家凭据字段不同：astudio 带
      //    `sso_session_id` / `login_method` / `source`，且将来任一方加校验就会分叉）。
      readCredential: resolveAstudioCredentialByRef,
      balance: {
        kind: 'buddy',
        selector: astudioBalanceSelector,
        // ⚠️ 本家**没有**免费模型概念（`AstudioAdapter` 不实现 `isFreeModel`），
        //    故不传该字段 —— 缺省 `undefined` 会让 `createCredentialResolver`
        //    走「免费模型短路」之外的常规分档路径（正确行为）。
        lockedError: astudioLockedError('AStudio'),
        // ⚠️⚠️ **必须是 `true`**（2026-10-21 合并审计发现：PR !119 原写的 `false`
        //    让上面 `reportAccount` 成了**不可达的死接线**）。
        //
        // **原注释错在哪**：原文「与 buddy 系一致：本家旧闭包也没有回报」是**类比错误** ——
        // buddy 系能写 `false` 是因为它们的**适配器自己回报**（`buddy-adapter.ts` /
        // `trae-adapter.ts` / `lobsterai-adapter.ts` 都调 `reportLedgerAccount`），
        // 而 **AStudio 适配器全文零回报**（grep 实测 0 处），且 master 上它压根没有
        // `reportAccount` 接线 ⇒「旧闭包也没有回报」描述的是**一个缺陷状态**。
        //
        // **实测这行是死代码**（`credential-resolver.ts` 三条回报点：①免费短路 ——
        // astudio 无 `isFreeModel` 不进；②分档选中 `:388` 被 `!== false` 拦住；
        // ③池选号 `:454` —— ②里已 `return picked.credential`，走不到）：
        // ```
        // reportPickedAccount=false     → cred=true reports=[]     poolReached=false
        // reportPickedAccount=true      → cred=true reports=["a1"] poolReached=false
        // reportPickedAccount=undefined → cred=true reports=["a1"] poolReached=false
        // ```
        // ⇒ `false` 时**零回报**，而那正是 `reportAccount: (id) => reportLedgerAccount(...)`
        // 唯一的调用来源 ⇒ 那行接线永不执行。
        //
        // **后果**：`token-ledger.ts` 拿不到 `accountId` ⇒ 整笔用量归到 `'-'`（未归属）桶
        // ⇒ AStudio 账号卡片看不到自己的 token 用量，多账号时无法区分谁在烧。零报错零日志。
        //
        // **为什么改 `true` 是纯增益**：master 上 astudio 走 `auth.currentCredential()`
        // （单凭据、从未回报归属）⇒「有归属」是新增能力不是回退，它**没有旧闭包要保真**
        // （该分支在 master 上根本不存在）。⚠️ 与 buddy 系的取舍**不同源**，别照抄那两行。
        reportPickedAccount: true,
      },
      fallback: { kind: 'ref', refName: ASTUDIO.defaultCredentialRef },
      // 退到单凭据 ref 之前先证明失败原因：全被模型限流时报明确的限流错误，
      // 而不是降级成误导性的 MISSING_CREDENTIAL（见 throwIfAllAccountsRateLimited）。
      throwIfAllRateLimited: throwIfAllAccountsRateLimited,
    },
  )
  const astudioAdapter = registerAstudioLlm(ctx, {
    // ⚠️⚠️ **`accountPool` 必须传**（Gitee issue IKP8OF 审计发现，真实缺陷）：
    //    本家此前是**唯一**把 `createModelCatalog` 的 deps 传成 `{}` 的适配器
    //    （其余各家都传 `{ accountPool }`）⇒ 骨架里 `deps.accountPool?.disabledModelsFor`
    //    与 `providerClosedFor?.(...)` 全部因 `?.` **静默跳过** ⇒
    //    **用户在 Jet Hub 里关掉的 astudio 模型照样出现在选择器里**，
    //    关闭整个供应商也无效。症状与 modelscope 那次「接线层漏实参」逐字相同。
    // ⚠️ 仍**不传** `readImage`（实测六个模型的 input_modalities 全是 text，
    //    图片通路不成立），且本家刻意不做请求级换号。
    accountPool: pool,
    // ⚠️ **2026-10-20 新增**：此前本家不传 `resolveCredential`，适配器走
    //    `auth.currentCredential()` ⇒ **单凭据、无选号**，于是：
    //    · 「锁定永久积分」开关即使打开也**毫无作用**（没有选号层可拦）；
    //    · 多账号时永远只用池里「第一个可用」的那个，第二个号的临期额度用不上。
    //    接上 `createCredentialResolver`（与 buddy/lobsterai/trae 同一套编排）后，
    //    候选先按 `enabled` + 模型限流筛，再按「15 天内到期优先」分档。
    //
    // ⚠️⚠️ **必须包一层转成零参签名**：`createCredentialResolver` 返回的是
    //    `(modelId?: string) => Promise<TCredential | undefined>`，而
    //    `AstudioAdapterOptions.resolveCredential` 声明的是
    //    `() => Promise<AstudioCredential | undefined>`（**零参**）。
    //    直接把带参函数传过去会 TS2322（参数个数不兼容）。
    //    ⚠️ 传 `''` 而不是省参数：空串意味着「不按模型筛候选」——
    //    `candidatesOf` 对空 `modelId` 跳过 `modelRateLimits` 过滤，
    //    这与本家适配器（`requestLevelRotation` 关闭、不按模型换号）的语义一致；
    //    若将来接上请求级换号，这里应改为透传真实 modelId。
    resolveCredential: () => astudioCredentialPlan(''),
    // ⚠️ AstudioAdapterOptions 原本只有 product / fetchImpl / auth / resolveCredential /
    //    refresh / fetchRemoteModels / onCatalogLoaded / warn 八项 —— **没有**
    //    accountPool 与 readImage。⚠️ **但 `accountPool` 已于 2026-10-20 补上**
    //    （Gitee issue IKP8OF：缺它会让黑名单与「供应商整体关闭」静默失效，
    //    见上面那一段），故本块与它**并存**、不是二选一。
    //    仍**没有** `readImage`：实测六个模型的 input_modalities 全是 text，
    //    图片通路不成立，多传必 TS2353。
    //    ⚠️ 同样**没有** `credentialRef`：`registerAstudioLlm` 内部会用
    //    `auth.currentCredential()` 作为「池里无账号」时的回退，不需要外部传 ref
    //    （传了必 TS2353，2026-10-20 实测踩到）。
    //    ⚠️ 但「请求级换号」与「按余额分档选号」是**两件事**：前者是 429 后换号
    //    （本家确实没有），后者是「该用哪个号」（上面刚接上）。两者互不依赖。
    // ⚠️ **不传 onCatalogLoaded**：registerAstudioLlm 内部已注入唯一的
    //    broadcastCatalogChanged(ctx)，这里再传就是第二份广播。
    // ⚠️ 传 auth 即可拿到三个默认回调（currentCredential / refreshOnce /
    //    fetchCatalogModels），下面只覆盖确实需要定制的那一个。
    auth: astudio,
    product: ASTUDIO,
    refresh: async () => {
      // ⚠️ 必须返回 AstudioRefreshOutcome：本家 401 的唯一入口是 refreshOnce
      //    （**不抛**，以 credential/terminal/reason 回传），**不是**返回
      //    Promise<void> 的 refreshAccountCredential —— 后者的签名与语义都不匹配
      //    该形参（TS2322），且它会把终态错误抛进适配器。
      // ⚠️ 刷的必须是「解析凭据时所用的那一个」账号（同上面 accio 处说明）；
      //    池里没有账号时退到默认单凭据 ref。
      const available = await pool.getAvailableAccount(ASTUDIO.id, '')
      return await astudio.refreshOnce(
        available?.entry.credentialRef ?? ASTUDIO.defaultCredentialRef,
      )
    },
    warn: (message: string) => { ctx.logger?.warn?.(message) },
  })

  // ===== ModelScope（魔搭）—— **本 fork 独有** =====
  //
  // ⚠️ 迁移说明（2026-10-16）：本 provider 在 rc.3 时代按「槽制 + 自建反代」形态实现，
  //    rc.11 引入 `provider-registry` / `provider-runtime` / `credential-resolver`
  //    三套抽象后，接入点收敛到「注册表声明 + 一次 `registerProviderRuntime`」。
  //    ⚠️ **`ModelscopeAdapterOptions` 仍是槽制（`slots`）**，与 accio 的
  //    `resolveCredential` 形态不同 —— 那是有意的：魔搭的凭据是**多枚 key 轮转**
  //    （旧 fork 的 `PROXY_UPSTREAM_MODELSCOPE` 存的就是 JSON 数组），
  //    而 `createCredentialResolver` 的契约是「一个 ref 一份凭据」。
  //    详见 `src/modelscope-rpc.ts` 的 `modelscopeSlotNamesOf`。
  //
  // 服务名由 ModelscopeAuth 依 product.id 派生，注册为 ctx.modelscopeAuth。
  const modelscope = new ModelscopeAuth(ctx)
  const modelscopeAdapter = registerModelscopeLlm(ctx, {
    // 单凭据回退 ref：池里没有 modelscope 账号时用它（与其余 provider 同约定）。
    credentialRef: credentialRef(MODELSCOPE.defaultCredentialRef),
    // ⚠️ 槽序列由**接线层**解析好传进来（适配器不直接读凭据）。
    //    `modelId` 透传：接线层据此过滤「该模型正处于限流窗口」的账号
    //    （与其余 provider 的 `getAvailableAccount` 同语义）。
    slots: async (modelId?: string) => {
      const entries = await pool.listAccounts(MODELSCOPE.id)
      const usable = await Promise.all(entries.map(async (entry) => {
        // 与其余 provider 同款：停用账号不参与自动选号。
        if (!entry.enabled) return undefined
        // ⚠️ 模型级限流标记：`modelId` 缺省时**不查**（目录路径刻意不传，
        //    见适配器的模块头说明 —— 传了会让被限流的账号把整个目录拖空）。
        if (modelId !== undefined && modelId.length > 0) {
          const resetAt = entry.modelRateLimits?.[modelId]
          if (typeof resetAt === 'number' && resetAt > Date.now()) return undefined
        }
        const resolved = await ctx.credentials.resolve(credentialRef(entry.credentialRef))
        if (!resolved) return undefined
        try {
          const parsed = JSON.parse(resolved.value) as ModelscopeCredential
          if (typeof parsed.access_token !== 'string' || parsed.access_token.length === 0) return undefined
          return { id: entry.id, apiKey: parsed.access_token }
        } catch {
          return undefined
        }
      }))
      return usable.filter((s): s is { id: string; apiKey: string } => s !== undefined)
    },
    accountPool: pool,
    product: MODELSCOPE,
    // ⚠️ **本 fork 独有**（2026-10-17 审计 P1 修复）：限流标记的**写入端**。
    //    ⚠️ 本回调此前**没有注入**，而上面 `slots()` 里却在**主动读**
    //    `entry.modelRateLimits?.[modelId]` 来跳过受限账号 —— 读端存在、写端缺失
    //    ⇒ 那段判据恒不命中（死代码），适配器里的 `this.options.markLimited?.()`
    //    也恒为 no-op ⇒ **限流标记永远写不进池**。
    //    守卫为什么没抓住：`provider-runtime-wiring.spec.ts` 只检查**适配器文件里
    //    有没有调用形**（`.markLimited?.(` 确实存在 ⇒ 绿），**从不检查接线层有没有
    //    注入该回调** ⇒ 「适配器写了调用、接线层没注入」这一形态打不穿。
    //    与 opencode（`index.ts:2940`）同款实现。
    markLimited: async (slotId, modelId, resetAtMs) => {
      await pool.updateModelRateLimit(slotId, modelId, resetAtMs)
    },
    // 远端目录：`GET {base}/v1/models`。失败回退 `MODELSCOPE_FALLBACK_MODELS`
    // （适配器的 `loadModelscopeCatalog` 内部兜底，不会抛）。
    // ⚠️ **必须带超时**：桌面版到外部域名的 fetch 可能永不 settle
    //（opencode 的真机事故 2026-10-02：没有超时 ⇒ listModels 永不返回 ⇒
    //  模型列表与徽标同时空白）。超时后回退兜底表，UI 立刻可用。
    fetchRemoteCatalog: (apiKey: string, signal?: AbortSignal) => fetch(modelscopeModelsUrl(MODELSCOPE), {
      headers: modelscopeHeaders(apiKey),
      signal: signal ?? AbortSignal.timeout(10_000),
    }),
    // ⚠️ **刻意不接 `readImageRequest`**：`ModelscopeAdapterOptions` 没有该字段
    //    （它按「像素预算发请求版本」的形态只在 opencode / accio 那几家实现）。
    //    魔搭的图片走 `readImage` 单一路径，逐模型按 `supportsImage` 声明模态。
    readImage: makeReadImage(ctx),
    // ⚠️⚠️ **必须接 `disabledModels`**（2026-10-17 审计发现）：模型黑名单是
    //    「设置页 → 显示列表」逐 id 开关的产物，而**模型选择器读的正是这份黑名单**
    //    （`ModelscopeAdapter.listModels` 读 `options.disabledModels?.()`）。
    //    ⚠️ 本回调此前**没有传** ⇒ 黑名单完全失效 ⇒ 用户在「显示列表」里关掉的模型
    //    **照样出现在模型选择器里**（实测：只开了 V4.1 Flash，选择器仍列全部 36 个）。
    //    ⚠️ 典型形态：适配器**支持**该能力（字段与消费点都在），只是**接线层漏了实参**
    //    ⇒ 无报错、无日志，纯静默。
    disabledModels: () => pool.disabledModelsFor(MODELSCOPE.id),
    // ⚠️⚠️ **必须接 `providerClosed`**（Gitee issue IKP8OF）：本家不走共享骨架
    //    （`model-catalog.ts`），故「整个供应商关闭」这条判据必须在这里显式接线，
    //    否则关闭后**新长出来的模型**仍会出现在选择器里（黑名单里没有它们）。
    providerClosed: () => pool.providerClosedFor(MODELSCOPE.id),
  })

  // 一次性修复**老账号**的昵称与凭据字段（与上面 WorkBuddy 的启动清理同类）。
  //
  // 早期实现把服务端的 `name` 直接当昵称用，而实测它是**自动生成的默认名**
  //（本机账号是 `RaccoonAva`），注册第二个账号时会重名、无法区分；
  // 且凭据里没存 `phone`（后来才发现 `user_info.phone` 可用于消歧）。
  // 光改代码只影响新登录的账号，故这里主动补一次：
  // 拉 `user_info` 补 `phone`，并用 `buildRaccoonNickname` 重算昵称。
  //
  // ⚠️ 幂等 + 失败不阻塞启动（`repairAccountNicknames` 内部逐账号 catch）。
  void raccoon.repairAccountNicknames(pool, buildRaccoonNickname).then((repaired) => {
    if (repaired.length > 0) {
      ctx.logger.info(
        `[jet-hub] 已修正 ${repaired.length} 个 Raccoon 账号的显示名（追加手机号尾号以便区分）：${repaired.join(', ')}`,
      )
    }
  }).catch((error: unknown) => {
    ctx.logger.warn(`[jet-hub] 修正 Raccoon 账号显示名失败：${String(error)}`)
  })

// ===== ZCode（智谱 z.ai 免费额度通道）=====
//
// 形态与前面所有 provider **相同**：读凭据 → 直发远端。
// 登录走**插件自己的**授权流（`zcode-login.ts`），凭据由插件写进
// `ctx.credentials`，**不读取本机 ZCode 客户端的任何数据**（2026-10-05 决策，
// 理由见 `zcode.ts` 文件头）。
//
// 与其余 provider 的三处差异（全部实测）：
//   1. 协议是 **Anthropic Messages**（不是 OpenAI 兼容）——
//      见 `zcode-anthropic.ts` 的转换层。
//   2. captcha **按需**产出（默认不带验证头探一次，被 `3007` 拒才 mint，并按
//      「账号 × 模型」记 2 分钟）—— 见 `zcode-captcha.ts` 与 `captcha-requirement.ts`；
//      mint 的耗时口径与「上游并非每次都要验证」的实测见 README 的 ZCode 章节。
//   3. 请求体必须带官方身份块与首轮日期块，否则上游回 `3012` ——
//      见 `zcode-identity.ts`。
//
// ⚠ **完全可脱离官方客户端使用**：登录走官方 CLI 设备授权流
// （`/oauth/cli/init` → 浏览器授权 → `/oauth/cli/poll/{flow_id}`，
// 纯 HTTP，见 `zcode-login.ts`），且 `device_mid` **由插件自己生成**。
//
// ⚠ **不可续期**：凭据是静态的（JWT 的 payload 里没有 `exp`）。
// 失效时上游回 401/1002，适配器归为 AUTH 并提示用户重新登录。
//
// 服务名注册为 ctx.zcodeAuth（由 `Service` 基类完成）。
// 不注册斜杠命令：入口在 Jet Hub 的 ZCode 面板。
//
// ⚠ **必须把账号池传进去**：`ZcodeAuth.current()` 要从账号池里找用户在
// Jet Hub 登录时创建的那个 ref（`ZCODE_ACCOUNT_XXXX`），而不是只认固定的
// `ZCODE_CREDENTIAL`。不传的话「登录成功但面板显示未配置」。
const zcode = new ZcodeAuth(ctx, {
  accountPool: pool,
  /**
   * ★ 二期内部载体（`src/captcha-carrier.ts`）的诊断日志。
   *
   * 那两条告警（「内部载体的 param 被上游拒（第 N 次）」「累计拒 3 次 ⇒ 本次运行禁用
   * 内部载体」）是排查「内部载体为什么没起作用 / 为什么被自动关掉」的**唯一**线索，
   * 缺省不接就等于线上什么都看不见。
   * ⚠ 取 logger 用两级可选链（同文件既有的 `log` / `makeReadImageRequest` 写法）：
   *   宿主某些形态不给 logger，写成点号直调会让调用点所在的产出路径抛 TypeError。
   */
  carrierLog: (message: string) => {
    ctx.logger?.warn?.(message)
  },
})
/**
 * captcha 配置：优先向服务端索取，失败回退内置兜底值。
 *
 * ## ⚠ 这里**不再**做缓存（2026-10-01 修正）
 *
 * 旧实现是 `??=` 的**永久缓存**，两个缺陷（都已实测确认）：
 *
 * 1. **服务端换 `sceneId`／灰度切换后永不生效**（必须重启宿主才能跟上）；
 * 2. **首次拉取失败会被永久固化** —— `??=` 连「回退到兜底值」这个结果
 *    一起记住，此后即使服务端恢复也不会重试。
 *
 * 正确做法是官方 `f3()` 的语义：**60 秒 TTL + 在飞去重、失败不缓存**。
 * 那个能力已下沉到 `ZcodeAuth.fetchCaptchaConfig()`
 *（见其 `captchaConfigCacheInstance`），故这里只做「拿 → 回退」的编排。
 */
const resolveZcodeCaptchaConfig = async (): Promise<ZcodeCaptchaConfig> => {
  const remote = await zcode.fetchCaptchaConfig().catch(() => undefined)
  if (remote !== undefined) {
    zcodeAdapter.setCaptchaConfig(remote)
    return remote
  }
  return ZCODE_CAPTCHA_FALLBACK
}
/**
 * 「本次 ZCode 请求**实际使用**的账号 id」。
 *
 * ## 为什么需要（与 `activeQoderAccountId` 同因）
 *
 * 额度受限时适配器要**标记失败的账号**，而它能拿到的只有这个回调。
 * 池的选号是即时决策，且**切号后回调不会跟着变** —— 若适配器改用
 * 「池当前的默认账号」，切到 B 之后失败时会**再标记一次 A**，
 * B 从未被标记，下次取号又把 B 选中，于是在 A/B 之间反复空转
 * （`qoder-adapter.ts` 的 `switchAccountOnQuota` 注释里记了这条实测）。
 *
 * ⇒ 在 `resolveCredential` 里记录**实际返回的那个账号**，供适配器查询。
 */
const activeZcodeAccountId = new Map<string, string | undefined>()
const zcodeAdapter = registerZcodeLlm(ctx, {
  credentialRef: credentialRef(ZCODE.defaultCredentialRef),
  resolveCredential: createCredentialResolver<ZcodeCredential>(
    {
      pool,
      /**
       * ⚠️ `undefined` 是**有意义的事件**：账号池里没有条目时要**清空**记录，
       * 留着旧 id 会误伤一个无辜账号（见 `activeZcodeAccountId` 的说明）。
       */
      reportAccount: (id) => {
        activeZcodeAccountId.set(ZCODE.id, id)
        if (id !== undefined) reportLedgerAccount(ZCODE.id, id)
      },
    },
    {
      // 只从 zcode 自己的账号池取账号，回退到自己的单凭据 ref，
      // 保证不会串用其它 provider 的凭据。
      // provider 实参用 ZCODE 而非字面量：写死字面量在改名/多产品场景下
      // 会静默查不到账号（本插件在 workbuddy 上踩过同类坑）。
      // ⚠ `modelId` 透传：否则模型级限流标记被忽略（详见 buddy 处说明）。
      product: ZCODE,
      // ⚠️ zcode 的 `readCredential` **用不到**（它的兜底是下面的 `custom`，
      // 既不做余额分档、也不按 ref 读）。传一个恒 `undefined` 的实现而不是把它
      // 改成可选：可选会让「忘了传」在编译期无声通过，而那正是 TRAE 注释里记的坑。
      readCredential: async () => undefined,
      /**
       * ⚠️ 落到 `ZcodeAuth.current()` —— 它已经实现了「账号池 → 单凭据 ref」
       * 的解析顺序。**不要**在这里重复实现那条优先级（重复必然漂移）。
       *
       * ⚠️⚠️ **刻意不接 `throwIfAllAccountsRateLimited`** —— 与 IKJOZ9 修好的
       * 那批 provider 相反。
       *
       * ⚠️ **刻意不写「几家」**：本句原写「那 8 家」（写这句话时的快照），
       * 后又改成「那 10 家」—— **两个数都不对**（实测接线处 = **11**，
       * 与 `buddy-ratelimit-misreport.spec.ts` 的 `WIRING` 表逐一点名的
       * 11 家一致）。这类「家数」是**必然腐坏**的快照：每新增一家就会失效，
       * 而「数字对不上」会让人怀疑整段约定。
       * ⇒ 名单的**唯一权威**是那张 `WIRING` 表（漏一家会点名），
       * 本注释只留「那批」。
       *
       * 其余各家的兜底是读一个在 Jet Hub 登录路径下**从不被写入**的 `*_ACCESS_TOKEN`，
       * 于是「池被限流筛空」必然一路退化成 `undefined` → 适配器误报「请先登录」
       * —— 那才是 IKJOZ9 的症状。
       *
       * zcode 的兜底 `current()` 却会**再读一次账号池**
       *（`zcode-auth.ts` 的 `readStoredCredential` → `readCredentialFromPool`），
       * 且既不看 `enabled`、也不看 `modelRateLimits` ⇒ 池被筛空时它**照样返回凭据**。
       *
       * 实测（2026-10-06，真实 `apply()` + 真账号池，临时探针）：
       *   · 唯一启用账号被限流、凭据合法 → **返回该凭据**，不抛「未登录」；
       *   · 池里还有一个「停用但健康」的账号且**排在前面**（`readCredentialFromPool`
       *     取数组序第一个能解析的）→ **返回那个停用账号的凭据**，请求能跑通。
       *
       * ⇒ ① zcode 没有 IKJOZ9 的症状，不该被"顺手修"；② 在第二种组合下，
       * 加判定反而会把本来能跑通的一发变成硬失败。故保持原样。
       * 回归断言见 `buddy-ratelimit-misreport.spec.ts` 的「zcode 同型缺陷判定」段。
       */
      fallback: { kind: 'custom', resolve: async () => await zcode.current() },
    },
  ),
  refresh: async () => {
    /**
     * ⚠ ZCode **没有** refresh 端点（与 Loomy 恒 false 同类，但原因不同）：
     * 凭据是**静态**的（登录一次就固定下来，JWT 里没有 `exp`）。
     *
     * 这里做的是「重读凭据并回写账号条目」，让用户重新登录后不重启即可生效。
     *
     * ⚠⚠ **绝不能用 `current()` + `getAvailableAccount()` 的组合**（审查发现的
     * 真实缺陷，与 `refreshAll` 里记录的那个数据破坏同类）：`current()` 会**先读池**
     * 且**不看 `enabled`**（它按数组顺序取第一个能解析的），而 `getAvailableAccount`
     * **会过滤 `enabled`** —— 两者选的可能是**不同账号**，于是「把 A 的凭据写进 B 的
     * ref」，30 分钟一轮就会串掉整池。
     * 正确做法是交给 `refreshAll`：它逐账号读**自己的** ref、写回**自己的** ref。
     */
    await zcode.refreshAll(pool)
  },
  // ⚠ captcha 是**一次性**的 —— 每次调用都必须现产一个新 param。
  // 走 `zcode.mintCaptcha`：整个插件**共用一台**常驻浏览器
  //（适配器自建会变成两台，白占 200MB）。
  //
  // ⚠ `options.signal` 必须继续往下传：captcha 侧的取页等待与建连历史上有
  // 无超时的路径，不传就等于「用户点停止也停不下来」（真实缺陷，2026-09-29）。
  mintCaptcha: async (options?: { signal?: AbortSignal }) => {
    const config = await resolveZcodeCaptchaConfig()
    return await zcode.mintCaptcha(config, options)
  },
  /**
   * ★ 二期内部载体：推理热路径取 param 走**载体链**（内部供给槽优先，等不到才落
   * 上面那条 chromium 链）。与 `mintCaptcha` 的差别只有「返回值带来源」这一层。
   *
   * ⚠ 这两条回调**必须都在**：少接一条，被 `3007` 拒的那一发就退回普通入口重新取，
   *   归因（内部 vs chromium）就此丢失 —— 累计拒绝到阈值的自动禁用也就永远到不了。
   * ⚠ 载体链不可用（`DSH_ZCODE_INTERNAL_CARRIER=0` / web 版从未收到贡献）时
   *   `zcode.mintCaptchaParam` 自己会退回那条 chromium 链 ⇒ 这里不需要判断开关。
   */
  mintCaptchaParam: async (options?: { signal?: AbortSignal }) => {
    const config = await resolveZcodeCaptchaConfig()
    return await zcode.mintCaptchaParam(config, options)
  },
  mintCaptchaAfterRejection: async (
    outcome: CarrierOutcome,
    options?: { signal?: AbortSignal },
  ) => {
    const config = await resolveZcodeCaptchaConfig()
    return await zcode.mintCaptchaAfterRejection(outcome, config, options)
  },
  /**
   * captcha 的 region —— **只是「连配置都没有」时的最后兜底**，正常路径不生效。
   *
   * ⚠ region 必须与产 param 的那份配置同源（真实缺陷，Gitee issue IKJNPS；
   *   领取路径与推理路径各有一个实例）。上面三个 mint 回调都会走
   *   `resolveZcodeCaptchaConfig()`，它把远端配置写进适配器
   *   （`setCaptchaConfig`）⇒ 组头时适配器读的是 `captchaConfig.region`，
   *   这里这个字面量只在自建浏览器那条腿（没有任何注入回调）且从未拉到配置时兜底。
   *
   * ⚠ 别把它写回「无条件生效」——服务端下发的 region 因账号/渠道而异
   * （作者账号是 `cn`，z.ai 国际渠道实测 `sgp`），写死只会在 cn 区账号上碰巧正确。
   */
  captchaRegion: ZCODE_CAPTCHA_FALLBACK.region,
  /**
   * 诊断日志：把「先探后取」的前置耗时与补产事件接到宿主 logger。
   *
   * ⚠ **必须注入** —— 适配器里那三条出口（`zcode-adapter.ts` 的
   * `前置耗时 …`、`上游要求 captcha（3007）…`、`captcha 被拒（3007），换新 param 重试`）
   * 全走 `this.options.log?.()`，缺省**完全不输出**（见 `ZcodeAdapterOptions.log`
   * 的注释）。不接上就是：带 captcha 的那一发比不带的慢一次 mint（稳态约 0.4–0.5
   * 秒、首次含 chromium 冷启动 4.2 秒；口径见 README 的 ZCode 章节）在外部**没有任何可看的证据**
   * —— 「先探后取到底生效没有」只能靠猜。
   *
   * ⚠ 取 logger 用可选链 `?.info?.()`：与同文件既有防御写法一致
   * （`makeReadImageRequest` 的降级告警、`refreshAllCredentials` 的批量续期告警
   * 都是 `ctx.logger?.warn?.(...)`）。宿主没给 logger 时**静默**，
   * 绝不能在推理路径上抛错。
   */
  log: (message: string) => {
    ctx.logger?.info?.(message)
  },
  /**
   * ⚠ **图片字节桥接** —— 这是图片能真正发出去的关键。
   *
   * DSH 的图片块只带 `attachment:{attachmentId}`，真正拿字节要经附件服务。
   * 缺了这两项，`serializeMessages` 拿到**空映射**，图片会退化成
   * `[image unavailable]` 占位符 —— 实测症状是模型回
   * 「我在当前对话中没有收到任何图片」。
   *
   * ⚠ 与其余 provider 同款约定（十余处一致）：
   *   - `readImage`：拿原始字节（内联为 data URL）
   *   - `readImageRequest`：拿**按预算缩放后**的字节；**不可用时返回
   *     `undefined`**（不抛错），适配器据此回退原图
   */
  readImage: makeReadImage(ctx),
  // 图片请求版本（缩放）桥接：ZCode 免费通道的请求体没有实测硬上限，
  // 但 base64 后的截图很大（2560×1600 各约 3.9 MB），两张就接近常见网关
  // 的 10MB 门槛 —— 与 raccoon 的同因（issue !IKITT9 那一族）。
  readImageRequest: makeReadImageRequest(ctx),
  // ⚠️ **字节目标必须显式传**（2026-10-12 修）：适配器读 `options.imageMaxBytes`，
  // 缺省时 `requestImageTargetFor` 会回退到 **2 MiB**（那是为腾讯系的图片 token
  // 预算准备的），而 ZCode 撞的是**请求体体积**（见上面那条注释里的 10MB 门槛）。
  // 与四家 product 的同款缺陷/修法一致（见 `image-budget.spec.ts` 的守卫用例）。
  imageMaxBytes: DEFAULT_BODY_LIMITED_IMAGE_MAX_BYTES,
  // 模型目录用静态白名单（实测可用的两个）—— 上游模型池含
  // 实测返回空响应的两条（GLM-5-Turbo / GLM-5.2），故不枚举远端。
  fetchRemoteModels: () => zcode.fetchRemoteModelsOnly(),
  accountPool: pool,
  product: ZCODE,
  // 就绪判据 = 有可用凭据（插件自存的）。
  isReady: async () => (await zcode.current()) !== undefined,
  /**
   * 额度用尽 / 无权益时，适配器据此**标记失败的账号并切换**。
   *
   * 回调的是「本次实际使用的账号」（理由见 `activeZcodeAccountId` 的注释）——
   * 不要改成 `pool.getAvailableAccount(...)` 之类「再问一次池」的实现。
   */
  currentAccountId: () => activeZcodeAccountId.get(ZCODE.id),
})

/**
 * ⚠ **必须用 `fetchRemoteModelsOnly()` 而不是 `fetchModels()`**（来自 PR #31
 * `05e4ad7`，保留其与桥无关的部分；本地桥 `zcode-bridge.ts` 已随 PR #29 的
 * 过时方案一并弃用，故这里只剩适配器这**一个**消费点）。
 *
 * 为什么必须有这条：适配器判「这次拿到目录了吗」的判据是「返回空数组」。
 * 若接线用 `fetchModels()`（失败时回吐兜底表），那个判据**永不命中**
 * ⇒ 兜底表被当成远端结果写进 `remoteModels` 并永久缓存，用户登录 /
 * 网络恢复后**再也不会重拉**（连失败冷却都不会开），只能重启 DSH。
 * 「回退兜底表」这件事只应由**展示侧**（适配器）做一次。
 *
 * ## 为什么不接本地桥（原 PR 的说明，保留供日后参考）
 *
 * 原 PR 让 ZCode 同时走一条「官方 pi-ai 声明式 provider + 本地 Anthropic
 * 透明桥」的镜像 route（`zcode-free`），其核心假设是「每个请求必须现产
 * captcha」。该假设已被 master 的大重构（`19226ca`）推翻：ZCode 3.14.4 起
 * **推理不再校验 captcha**，只有领取才要 —— 桥每请求白产一个，白烧设备级
 * 验证配额（阿里云同设备 150 次/小时）。故**只保留**「目录拉取不污染缓存 +
 * 自愈两闸 + 写盘串行化」这些与桥无关的修复，桥与镜像整个弃用。
 */

  // 一次性修复**老 TRAE 账号**的展示名（与上面 Raccoon 同类，同因）：
  // 服务端 ScreenName 是**按 uid 自动生成的默认名**（`用户26815487395`），
  // 多账号无法区分；`GetUserInfo` 的 `NonPlainTextMobile`（脱敏手机号）可区分。
  // 光改代码只影响新登录的账号，故这里主动补一次。
  //
  // ⚠️ 幂等 + 失败不阻塞启动（`repairAccountNicknames` 内部逐账号 catch）。
  void trae.repairAccountNicknames(pool).then((repaired) => {
    if (repaired.length > 0) {
      ctx.logger.info(
        `[jet-hub] 已修正 ${repaired.length} 个 TRAE 账号的显示名（改用脱敏手机号以便区分）：${repaired.join(', ')}`,
      )
    }
  }).catch((error: unknown) => {
    ctx.logger.warn(`[jet-hub] 修正 TRAE 账号显示名失败：${String(error)}`)
  })

  // 一次性修复**老 LobsterAI 账号**的展示名（同类，但成因不同）：
  // 服务端把**手机号本身**当 `user.nickname` 下发，且只脱敏到「露末 4 位」
  // （`130****1100`）—— 按用户要求收敛为只露末 2 位（`130******00`）。
  // 纯本地归一化（幂等），无需重新登录。
  //
  // ⚠️ 幂等 + 失败不阻塞启动（`repairAccountNicknames` 内部逐账号 catch）。
  void lobsterai.repairAccountNicknames(pool).then((repaired) => {
    if (repaired.length > 0) {
      ctx.logger.info(
        `[jet-hub] 已修正 ${repaired.length} 个 LobsterAI 账号的显示名（手机号改为只露末 2 位）：${repaired.join(', ')}`,
      )
    }
  }).catch((error: unknown) => {
    ctx.logger.warn(`[jet-hub] 修正 LobsterAI 账号显示名失败：${String(error)}`)
  })

  // 一次性修复**老 Gemini 账号**的展示名（同类，成因见 `gemini-auth.ts` 的
  // `repairAccountNicknames`）：旧版本解析令牌响应时丢掉了 `id_token`，身份只剩
  // userinfo 一次可静默失败的跨域请求，失败即让昵称退化成池 id（`gemini-6a53dbca`）。
  // 光改代码只影响新登录的账号，故这里主动补一次。
  //
  // ⚠️ 幂等 + 失败不阻塞启动（`repairAccountNicknames` 内部逐账号 catch）。
  void gemini.repairAccountNicknames(pool).then((repaired) => {
    if (repaired.length > 0) {
      ctx.logger.info(
        `[jet-hub] 已修正 ${repaired.length} 个 Gemini 账号的显示名（改用 Google 账号邮箱）：${repaired.join(', ')}`,
      )
    }
  }).catch((error: unknown) => {
    ctx.logger.warn(`[jet-hub] 修正 Gemini 账号显示名失败：${String(error)}`)
  })

  // ===== 多账号静默续期调度 =====
  // 替代原有的单账号 scheduleRefresh()，使用 refreshAll() 遍历所有账号续期
  const REFRESH_INTERVAL_MS = 30 * 60 * 1000  // 每 30 分钟检查一次

  /**
   * 十三个 provider 实例的续期入口（`buddy` 与 `workbuddy` 是两个实例、同一个类；
   * `qoder` 与 `qodercn` 同理）。
   *
   * ⚠️ 条数会随 provider 增长（早期写「十个」已过时）——注释里的数字**不是**契约，
   * 派生的键集合才是（见 `wiredRefreshTargets`）。
   *
   * 收成一张表是为了让「失败必须留日志」这条规则**只写一遍** —— 原先这里是
   * 十个空 catch（注释写着「静默」），把 provider 内部的告警与异常一起吞掉，
   * 「凭据一直刷不动」在日志里完全无痕（issue !IKIRTT 的可观测性条目）。
   *
   * ## ⚠️⚠️ 2026-10-08（Task 10）：改为**从能力注册表派生**，且**惰性求值**
   *
   * 原先这里**手抄 13 行**。失效形态极隐蔽：**漏一家 ⇒ 该家凭据永不自动续期**，
   * 而症状只是「每隔一段时间就要重新登录」，**日志里一个字都没有**。
   *
   * ⚠️ **必须是函数调用而不是在这里立即求值**：本行（`apply()` 中段）在
   * **注册循环之前**执行，而注册循环在 `apply()` 的**末尾**。立即求值会得到
   * **空表** ⇒ 所有 provider 都不再自动续期，而日志里只有 `isPoolEmpty`
   * 的常规输出。
   *
   * ⇒ 改为在 `refreshAllCredentials` **内部**每次调用时现取（见下）。
   * 代价是一次极廉价的 Map 遍历；收益是**与注册时机彻底解耦**。
   *
   * ⚠️ **与被删清单里的注释的关系**（2026-10-08 独立复审修正）：原先手抄的 13 行
   * 各自带注释，删除时它们被**压缩成本函数上方这段 5 项摘要**（不是「逐条上移到
   * `probeById` / `wiredRefreshTargets` 侧」—— 实测那两个符号处对这些家零命中）。
   * 摘要保留的 5 个失效模式（**不得静默丢弃**，Task 6 的主导失效类）：
   * Loomy 不可续期（只探测已过期）、raccoon 的 lead 窗口、minimax 的
   * refresh_token 轮换、zcode 静态凭据仍回写、gemini 漏挂的后果。
   * ⚠️ 其中 gemini 那条的**后果措辞已过时**：定时器自 issue IKJOZB 起已改为
   * **无条件武装**（只看池里有没有账号，不看续期表的成员资格）⇒ 漏挂 gemini 的
   * 真实后果是「**gemini 凭据永不自动续期**」，**不是**「定时器不武装」。
   */
  async function refreshAllCredentials(): Promise<void> {
    // ⚠️ **每次现取**（wiredRefreshTargets() 是函数、读注册表）：注册发生在
    //    apply() 末尾，而本函数最早在调度器 start() 的首轮就被调用 ⇒
    //    若在这里读一个**在注册前求值的常量**，会得到**空表** ⇒
    //    所有 provider 都不再自动续期，而日志里只有 isPoolEmpty 的常规输出
    //    （⚠️ 注意 WIRED_EXPIRY_PROVIDERS **不属**这一类：它是刻意保留的纯数据清单，理由见 `aggregate-expiry.ts` 自己的注释。）
    for (const [tag, refreshAll] of wiredRefreshTargets()) {
      try {
        await refreshAll(pool)
      } catch (error) {
        // 单个 provider 抛错不得中断其余九个（各 refreshAll 内部本就逐账号
        // try，能冒到这里的已是「整批失败」级别的异常）。
        ctx.logger?.warn?.(
          `[jet-hub] ${tag} 批量续期失败：${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
  }

  // 启动时**无条件**武装续期调度器，并在账号入库时补一次武装。
  //
  // ⚠️ 空池判据（`isPoolEmpty`）**只用于日志措辞**，不再参与「是否武装」的决策。
  // 它的历史形态是「按 `accounts.some(a => a.refreshable)` 决定武装」——
  // 那让这个定时器**是否武装**取决于一批可能已被误标成 false 的布尔，而它存在
  // 的意义恰恰是去修正误标。本次事故实测：36 条账号只剩 3 条 `true`
  // （raccoon / minimax / cline 各一），只要那三条被删或被同样误标，
  // **codearts 的自愈与启动首轮会一起消失**，且日志里一个字都不会有。
  // 各家 `refreshAll` 内部本来就按凭据材料 / 是否过期过滤（`loomy` 只探已过期的、
  // 其余看 `refreshableOf(credential)`），故放宽判据最多多一次本地遍历。
  //
  // ⚠️ 仍然**不看 `enabled`**（AGENTS.md 既有铁律）：停用只影响自动选号，
  // 不该让凭据停止续期。早期写成 `a.refreshable && a.enabled`，于是
  // 「所有账号都被停用」时续期定时器根本不启动，凭据一路烂到 refresh_token 失效。
  //
  // ⚠️⚠️ **更不能因为「启动瞬间池为空」就不武装**（issue IKJOZB 的真实缺陷）：
  // 冷启动空池是正常态（新用户、刚清过存储），而原先的 `if (accounts.length === 0)
  // return` 让整个调度器**不被创建**、之后又没有重新武装的路径 ⇒ 该会话内登录的
  // 账号**永远不会被主动续期**（只剩请求内按需续期），凭据悄悄过期而面板仍显示
  // 「可自动续期」，且日志里一个字都没有。
  // 现在武装与池内容彻底解耦（见 `src/refresh-scheduler.ts`）：
  // ① 无条件武装；② 定时器内空池只记日志、下轮继续；③ `pool.onAccountAdded`
  // 提供「入库即补武装」这条 issue 点名缺失的路径。
  //
  // ⚠️ **必须立刻先跑一轮**（issue !IKIRTT 的主缺陷，已内建在 `start()` 里）：
  // 早先这里只有 `setInterval`，第一次处理要等满一个周期。短寿命 provider
  // （cline 1 小时、codearts 约 2 小时、raccoon 3 小时）的凭据在宿主关闭期间
  // 早就到期了，于是重启后**最长 30 分钟**一直显示「已过期」、积分行一直 401。
  // 这一轮与 lead-time 过滤配合（`src/expiry-sync.ts` 的 `shouldRefreshNow`），
  // 只对「距过期不足 1 小时」的账号发续期请求，其余只做一次本地对账 ——
  // 既补上了首轮，又不会在启动时打出几十个无谓请求。
  const refreshScheduler = new MultiAccountRefreshScheduler({
    refresh: refreshAllCredentials,
    intervalMs: REFRESH_INTERVAL_MS,
    isPoolEmpty: async () => (await pool.listAllAccounts()).length === 0,
    // ⚠️ 可选链：`logger` 在极简 profile 下可能缺席，而日志不该成为续期的
    // 单点故障（与仓库既有的 `ctx.logger?.warn?.()` 一致）。
    info: (message) => ctx.logger?.info?.(message),
    warn: (message) => ctx.logger?.warn?.(message),
  })
  // ⚠️ 不 await：`apply()` 是同步函数，而 `start()` 内含首轮续期（会发网络请求，
  // 可达数十秒）。阻塞在这里会让插件启动卡住（与 opencode 能力预热同款约定）。
  void refreshScheduler.start().catch((error: unknown) => {
    // 走到这里说明 `refresh()` 或订阅通知本身出了意料之外的异常；`onTick`
    // 内部已消化常规失败，故这条只是最后一道可观测性兜底。
    ctx.logger?.warn?.(
      `[jet-hub] 多账号续期调度器启动失败（本次会话不会自动续期）：`
      + `${error instanceof Error ? error.message : String(error)}`,
    )
  })
  // issue IKJOZB 点名缺失的那条「重新武装的路径」：账号入库（登录成功、导入、
  // 恢复备份）时若调度器未武装则补上。⚠️ 订阅点必须挂在 `AccountPool` 上，
  // 不能逐个登录流程接线 —— 全仓库十几处 `pool.addAccount` 调用点，漏一处
  // 就意味着那个 provider 静默地永不续期。
  //
  // ⚠️ **同时清空临期折算缓存**（真实缺陷，对抗审计实测证伪）：缓存原先**没有
  // 任何失效通道** ⇒ 刚登录（或限流刚解禁）的账号在**最长 60 秒内对路由不可见**，
  // 用户拿到误导性的 `MISSING_CREDENTIAL | …没有任何可用候选`（明明刚登录成功）。
  // ⚠️ 用**可变引用**（`let sharedExpiryProbeRef`）而不是直接捕获 `const` ——
  // 探针定义在**本订阅之后**（那里才够 `ctx.llm` 注册完 provider），
  // 闭包直接引用会命中 TDZ。
  let sharedExpiryProbeRef: { clear: () => void } | undefined
  // ⚠️⚠️ **候选序缓存也必须清**（真实缺陷，独立审计实测证伪：我原先只清了一半）。
  //
  // 两个缓存**不是**同一个东西：
  //   - 折算缓存：`provider → 最早失效时刻`（决定**排序**）；
  //   - 候选序缓存（`AggregateAdapter.choiceCache`）：`${model}\0${拒绝表指纹} →
  //     DispatchTarget[]`（决定**用哪几个候选**），TTL 同样 60 秒。
  //
  // 后果（审计实测）：buddy **未登录**时被剔除（只剩 codearts）⇒ 那个**非空**结果
  // 被缓存 ⇒ 用户随后**登录 buddy** ⇒ 折算缓存被清（排序值对了），但
  // **候选序仍是「只有 codearts」的旧数组** ⇒ 60 秒内 buddy 仍不被使用。
  // ⇒ 「刚登录的账号对路由不可见」只解决了一半。
  //
  // ⚠️ 候选序缓存的键含**拒绝表**指纹但**不含账号状态**，故账号变化必须**显式**清它。
  // ⚠️ 同样用可变引用（`aggregateAdapter` 定义在本订阅之后）。
  let sharedChoiceCacheRef: { clearChoiceCache: () => void } | undefined
  const unsubscribeAccountAdded = pool.onAccountAdded(() => {
    refreshScheduler.notifyAccountAdded()
    // ⚠️ 未定义时什么都不做（订阅可能在它们建好前就触发 —— 那是正常时序）。
    sharedExpiryProbeRef?.clear()
    sharedChoiceCacheRef?.clearChoiceCache()
  })
  ctx.effect(() => () => {
    unsubscribeAccountAdded()
    refreshScheduler.stop()
    service.stop()
    buddy.stop()
    workbuddy.stop()
    lobsterai.stop()
    qoder.stop()
    qoderCn.stop()
    trae.stop()
    cline.stop()
    loomy.stop()
    zcode.stop()
    // ⚠ 必须 dispose captcha 浏览器 —— 否则会留下孤儿 chromium
    //（约 200-400 MB，且用户没有界面能关掉它）。
    zcodeAdapter.stop()
    // AStudio（讯飞）的 stop() 置 active=false，阻止在途刷新回写凭据。
    astudio.stop()
  }, 'jet-hub: multi-account refresh scheduler')

  // 保留旧的 stop scheduler（兼容旧命令）
  ctx.effect(() => () => {
    service.stop()
    buddy.stop()
    workbuddy.stop()
    lobsterai.stop()
    qoder.stop()
    qoderCn.stop()
    trae.stop()
    cline.stop()
    loomy.stop()
    zcode.stop()
    // 同上：captcha 浏览器必须随插件一起回收。
    zcodeAdapter.stop()
    // 同上：AStudio 的在途刷新必须随插件一起回收。
    astudio.stop()
  }, 'codearts-auth.scheduler (legacy)')

  // ===== OfficeAce（华为 ModelArts MaaS，云端直连）=====
  //
  // 形态与前面所有 provider 相同：进程内 LlmAdapter 直发远端，无子进程、无端口。
  //
  // 独有语义：**凭据完全自主** —— 登录走华为云 OAuth（PKCE + DPoP），推理用
  // `model_app_key:secret` 的 Basic 鉴权，STS 用 refresh_token 续期（30 天），
  // 积分余额与倍率经 V11 签名直读云侧。全程**不经过 OfficeAce 客户端**
  //（协议逆向见 `officeace-auth.ts` 模块头）。
  /**
   * 「启用中的 OfficeAce 账号」清单（**顺序 = 用户拖拽的手动优先级**，与
   * `getAvailableAccount` 的候选序同一份）。
   *
   * ⚠️ 锁定判定（逐账号看余额）与未锁定取号（取第一个）**必须共用这一份**：
   *    各写一遍会让「锁定遍历了谁」与「未锁定用了谁」悄悄漂移 —— 而
   *    `officeace-refresh-all.spec.ts` 的调用点普查刻意「新增即红」，正是要求
   *    每新增一处取池都要先证明它**不是第二份遍历**。这里抽成一处即为此
   *    （纯重构 ⇒ 那个普查的调用点计数**保持不变**）。
   */
  const enabledOfficeAceAccounts = () => pool.listAccountsByProvider(OFFICEACE.id)
    .filter((entry) => entry.enabled !== false)

  /**
   * 「不理会锁定」的取号路径 = **锁定前的那条原路径，逐字保留**。
   *
   * 两个用途（**同一份实现**，刻意不写第二份）：
   * 1. 未锁定态的推理取号 —— 即 `credentialProvider` 的 `resolveUnlocked`；
   * 2. **只读目录探测**（`/v2/models` + 倍率）—— 它们不扣积分，**绝不能被锁定
   *    牵连**（否则面板报「读取模型列表失败」、供应商关不掉、分组消失）。
   */
  const resolveOfficeAceCredential = async () => {
    const available = await pool.getAvailableAccount(OFFICEACE.id, '')
    const ref = available?.entry?.credentialRef
      ?? enabledOfficeAceAccounts()[0]?.credentialRef
    if (ref === undefined) return officeaceAuth.readStoredCredential()
    return officeaceAuth.readCredential(ref, ctx.credentials as never)
  }

  const officeAceAdapter = registerOfficeAceLlm(ctx, {
    disabledModels: () => pool.disabledModelsFor(OFFICEACE.id),
    // ⚠️⚠️ 同上（IKP8OF）：本家手写 `listModels`，不走共享骨架。
    providerClosed: () => pool.providerClosedFor(OFFICEACE.id),
    // ⚠️ **按当前选中账号的 ref 取凭据**（2026-10-13）：凭据存在 DSH 凭据库里
    //    按 `credentialRef` 索引（与 gemini / raccoon 同款）。缺省会读兼容文件
    //    `session.json`，那份是**所有账号共用**的 ⇒ 号池轮换形同虚设。
    //
    // ⚠️⚠️ **锁定态必须在这里分道**（Gitee issue IKLTHB 第 ① 条，2026-10-12 起
    //     一直是哑锁）：`permanentLocked()` 在全仓只有 `credential-resolver.ts`
    //     的 buddy / loomy 两个分支读过，而 officeace 走的是**适配器自己的**
    //     `credentialProvider` ⇒ 面板上那个开关写进了 `permanent-locks.json`
    //     却没有任何执行代码。判定逻辑全部在 `officeace-lock.ts`（纯函数 + 注入），
    //     这里只负责装配：**未锁定态逐字保留原路径**（即上面那份
    //     `resolveOfficeAceCredential`），锁定态**绝不回落池**。
    credentialProvider: createOfficeAceCredentialProvider({
      permanentLocked: () => pool.permanentLocked(OFFICEACE.id),
      // 锁定判定要**逐账号**看余额 ⇒ 取全部启用账号（与未锁定取号同一份清单）。
      accounts: () => enabledOfficeAceAccounts()
        .map((entry) => ({ id: entry.id, credentialRef: entry.credentialRef })),
      resolveUnlocked: resolveOfficeAceCredential,
      readCredential: (ref) => officeaceAuth.readCredential(ref, ctx.credentials as never),
      readStoredCredential: () => officeaceAuth.readStoredCredential(),
      // ⚠️ **必须带 ref**（云侧 V11 直读；缺了会回落果办客户端的全局单 cookie
      //    ⇒ 多账号判成同一份余额 ⇒ 按错误的余额决定「能不能烧永久积分」）。
      summaryOf: async (credential, ref) => {
        try {
          const summary = await officeaceAuth.fetchSubscriptionSummary(48, ref, credential)
          return summary === undefined
            ? { ok: false, error: '读不到订阅摘要（未登录 / 云侧查询失败）' }
            : { ok: true, summary }
        } catch (error) {
          return { ok: false, error: `订阅摘要查询失败：${String(error)}` }
        }
      },
    }),
    // ⚠️ **目录探测必须绕开锁定**（Gitee issue IKLTHB 第 ① 条的自查连带发现）：
    //    `credentialProvider` 在「锁定 + 只剩永久桶」时会抛错，而
    //    `listModels` 的调用方全都不接这个错（`dsh-llm` 直接 `await`）⇒
    //    症状是一串与锁定无关的：面板「读取模型列表失败」、`关闭供应商` 被
    //    `remoteError` 拒、聚合静默少一个候选、模型选择器分组消失。
    //    只读端点不扣积分，没有理由被锁定牵连；见适配器 `probeCredential` 的表。
    probeCredential: resolveOfficeAceCredential,
    // ⚠️ **图片输入桥**（2026-10-13）：deepseek-v4.1-flash / kimi-k2.6 实测支持
    //    多模态（1×1 PNG 探针通过）。漏接 = 用户发图后适配器报
    //    「需要附件服务」—— 图根本到不了模型。
    readImage: makeReadImage(ctx),
    // ⚠️ **必须注入**（同其余渠道）：宿主在「登录 / 点刷新积分」等时机调它把新凭据
    //    拉进来。漏接的症状是该渠道的账号永不过期 —— 用户重新登录后旧凭据仍被
    //    继续用，且日志里一个字都没有。
    // ⚠️ **必须走账号池**（与 gemini 同款，守卫用例断言）：OfficeAce 只有一个账号
    //    条目，但仍要先按 `getAvailableAccount(provider, '')` 从池里取 ——
    //    「池筛掉后回落到单凭据 `refresh()`」正是被 `trae-model-id-selection.spec.ts`
    //    断言禁止的失效形态（那个用例的判据是「续期拿到的 ref === 被限流账号的 ref」）。
    refresh: async () => {
      // ⚠️ 必须走账号池（与 gemini / loomy 同款，守卫用例断言）：OfficeAce 只有
      //     一个账号条目，但仍要从池里取 —— 「池筛掉后回落到单凭据 `refresh()`」
      //     正是 `trae-model-id-selection.spec.ts` 明文禁止的失效形态（判据是
      //     「续期拿到的 ref === 被该模型限流的那个账号的 ref」且 fallback 计数为 0）。
      const available = await pool.getAvailableAccount(OFFICEACE.id, '')
      if (available) {
        await officeaceAuthService.refreshAccountCredential(
          available.entry.credentialRef, pool, available.entry.id,
        )
        return
      }
      // ⚠️ 池被限流标记筛空时**不能回落 `refreshAll`**：那会让被限流的账号
      //    永远等不到续期（issue 的核心）。改为从池里直接取**第一个启用账号**。
      // ⚠️ `listAccountsByProvider` 是**同步**返回数组（不是 Promise）——
      //    给它接 `.catch()` 是类型错误。
      const all = pool.listAccountsByProvider(OFFICEACE.id)
      const first = all.find((entry) => entry.enabled !== false) ?? all[0]
      if (first !== undefined) {
        await officeaceAuthService.refreshAccountCredential(
          first.credentialRef, pool, first.id,
        )
        return
      }
      // 池里真的没有账号（尚未登录）⇒ 才允许续期那一份本机凭据。
      await officeaceAuth.refreshStoredCredential().catch(() => undefined)
    },
    // ⚠️ 必须注入：DSH 的模型目录是**推送式**的（客户端把 catalog 缓存在
    //    `status === 'ready'` 的短路 store 里，只在收到 `llm/adapters-updated`
    //    等事件时才重读）。不广播 = 注册成功、`listModels` 也正常，但模型选择器
    //    里**看不到分组**（真实症状 2026-10-12）。
    onCatalogLoaded: () => { ctx.emit('llm/adapters-updated') },
  })
  // 冷启动也广播一次：首次目录在注册后异步就绪，不补这一发就只能等用户重启。
  ctx.emit('llm/adapters-updated')

  // ===== OpenCode Zen（账号槽 + 匿名槽平权混合池）=====
  //
  // 形态与前面所有 provider 相同：进程内 LlmAdapter 直发远端，无子进程、无端口。
  // 两处独有语义：
  // 1. **身份 = 槽**：账号槽（手动粘贴的 `sk-` key，可各配代理）+ 匿名槽
  //    （凭证就是字面量 `public`，永远本机出口）。免费模型下全槽**平权**轮换，
  //    收费模型只走账号槽（匿名凭证只被服务端认作免费通道）。
  // 2. **每账号可配代理**：NAT 后的多台 PC 共享一个出口 IP，而 Zen 的匿名通道
  //    按出口 IP 限流 ⇒ 要真正分开只能给各账号各配一条出口（`opencode-proxy.ts`）。
  //
  // ⚠️ 指纹派生的**唯一作用是防关联**（opencode 协议层没有机器指纹），
  // 不参与配额计算 —— 换配额桶只能靠换 key 或换代理。
  // ⚠️ 版本探测**不能**在 apply 里 await（apply 是同步函数）：那会让插件启动
  // 阻塞最多 2 秒。改为**懒加载**：首个请求要发时才探测并缓存，探测失败直接
  // 用 `OPENCODE.defaultUserAgent`（UA 只是伪装维度，服务端未校验真实性）。
  const opencodeUA = lazyOpencodeUserAgent()
  const opencodeAdapter = registerOpencodeLlm(ctx, {
    identitySlots: async () => listIdentitySlots(
      await Promise.all(pool.listAccountsByProvider(OPENCODE.id).map(async (entry) => {
        const resolved = await ctx.credentials
          .resolve(credentialRef(entry.credentialRef))
          .catch(() => undefined)
        let parsed: { api_key?: string } = {}
        if (resolved !== undefined) {
          try {
            parsed = JSON.parse(resolved.value) as typeof parsed
          } catch {
            // 凭据损坏：回退到匿名凭证，让用户看到「凭据未配置」而不是整条崩掉
          }
        }
        const apiKey = parsed.api_key ?? OPENCODE.anonymousKey
        // ⚠️⚠️ **指纹代次必须以账号池为权威重算**（本任务最容易漏的一步）：
        // 「指纹」按钮只把 generation 写进账号条目
        // （`updateOpencodeFingerprintGeneration`），凭据里的 `fingerprint`
        // 仍是添加账号时的旧值。若直接透传凭据里的 fingerprint，代次涨了而
        // project id **纹丝不动** —— 用户点了「指纹」却什么都没换，且**不报错**，
        // 是最难排查的一类静默失效。
        //
        // ⚠️ **派生收敛在 `poolEntrySnapshot`（唯一实现）**：探测路径（账号卡片
        // 「重测」）也要造同一个投影，两处各写一份就会分叉 —— 而分叉的那一侧
        // 恰好没有用例挡（identity 选错只是让多个匿名通道指纹相同，**不报错**）。
        // 池字段是权威（`opencodeProxyFor` / `opencodeFingerprintGenerationFor`）。
        return poolEntrySnapshot({
          id: entry.id,
          apiKey,
          enabled: entry.enabled,
          proxy: pool.opencodeProxyFor(entry.id),
          generation: pool.opencodeFingerprintGenerationFor(entry.id),
        })
      })),
      // 取值一次即可：`listIdentitySlots` 要的是字符串，不是惰性函数。
      // 首次调用时可能还是产品默认值（探测在后台跑），后续请求才用真机版本 ——
      // 宁可前几次 UA 用兜底值，也不让插件启动阻塞在 2 秒的子进程上。
      opencodeUA(),
    ),
    // ⚠️⚠️ **必须有超时**（真机事故 2026-10-02）：桌面版到 opencode.ai 的
    // fetch 可能**永不 settle**（与同源的 remote.session 故障都是宿主网络问题）。
    // 没有超时 → `loadOpencodeCatalog` 的 try/catch 永远走不到 →
    // `listModels` 永不返回 → **模型列表与徽标同时空白**（用户报障）。
    // 有超时则超时后回退兜底表，UI 立刻可用（只是暂时看不到付费模型）。
    fetchRemoteCatalog: (slot, signal) => fetch(`${OPENCODE.baseUrl}${OPENCODE.modelsPath}`, {
      headers: { authorization: `Bearer ${slot.apiKey}` },
      // 组合两个信号：调用方给的（取消）+ 自己的超时（防挂死）。
      signal: signal === undefined
        ? AbortSignal.timeout(OPENCODE_CATALOG_TIMEOUT_MS)
        : AbortSignal.any([signal, AbortSignal.timeout(OPENCODE_CATALOG_TIMEOUT_MS)]),
    }),
    disabledModels: () => pool.disabledModelsFor(OPENCODE.id),
    // ⚠️⚠️ 同上（IKP8OF）：本家手写 `listModels`，不走共享骨架。
    providerClosed: () => pool.providerClosedFor(OPENCODE.id),
    markLimited: async (slotId, modelId, resetAtMs) => {
      // 匿名条目同样落盘：它是池里的一条普通条目，限额标记在面板可见、
      // 可用「重测/清除」恢复（早期把匿名槽当进程内状态，重启即丢）。
      await pool.updateModelRateLimit(slotId, modelId, resetAtMs)
    },
    warn: (message) => ctx.logger.warn(`[codearts-auth] ${message}`),
    // ⚠️ 图片字节桥接：Zen 有多个免费模型实测支持图片输入（big-pickle /
    // space-bunny-free / mimo-v2.6 / mimo-v2.5，2026-10-02 真机验证），
    // 模态由 `opencode-capability.ts` 按远端 models.dev 播报。
    // ⚠️ 不接 `readImageRequest`（缩放桥接）：Zen 免费通道对图片体积的
    // 限制**未实测**，不凭猜测加一层压缩（Qoder/Raccoon 是实测撞到体积
    // 限制才接的）。先发原图，撞到限制再按实测加。
    readImage: makeReadImage(ctx),
  })
  // 保证至少有一条匿名通道（零账号也能用免费模型）。
  //
  // ⚠️ **不 await**：`apply()` 是同步的（不能 await），而这里是异步 IO。
  // 走 fire-and-forget —— 它只是「补一条默认条目」，失败最坏结果是用户
  // 手动点「+ 添加匿名通道」，而 `listIdentitySlots` 每次请求都实时读池，
  // 补完立即生效，不需要等它。
  void ensureDefaultAnonymousSlot(
    (entry) => pool.addAccount(entry),
    (refName, value) => ctx.credentials.set(credentialRef(refName), value),
    () => pool.listAccountsByProvider(OPENCODE.id),
    // ⚠️ 判据是「池里有没有匿名条目」而不是「有没有账号」：用户若主动
    // 删光了匿名通道，那是明确选择，不该每次启动又塞回来（删除会像失灵）。
    () => pool.listAccountsByProvider(OPENCODE.id).some((e) => e.id.startsWith(`${OPENCODE.id}-anon-`)),
  ).then((id) => {
    if (id !== '') ctx.logger.info(`[codearts-auth] 已为 OpenCode 创建默认匿名通道：${id}`)
  }).catch((error: unknown) => {
    ctx.logger.warn(`[codearts-auth] 创建默认 OpenCode 匿名通道失败：${String(error)}`)
  })

  // models.dev 本地缓存：启动预热 + **定期刷新**（用户 2026-10-17）。
  //
  // ⚠️⚠️ 三条硬约定（第一条是 2026-10-02 的真机事故）：
  // 1. 渲染路径上**只读同步缓存**，永不 await 网络 —— 我最初在 `listModels`
  //    里 await 这个拉取，而它 5 MB / 慢则 1.4s、宿主网络异常时**永不返回**，
  //    于是模型选择器一直空白（用户报障「一直卡着」）。
  // 2. 拉取完成要**广播目录变更**：能力表是能力判定的来源，DSH 已经用
  //    「纯文本」渲染过一帧，不广播它不会重算（免费模型会一直显示不支持图片）。
  // 3. **全仓唯一直读点**是 `src/models-dev-cache.ts`：opencode 的能力表与
  //    cline 的目录补全都只读它那份磁盘缓存，不再各自直连（此前两处各一套
  //    直连 + TTL + ETag，既重复又让 5 MB 的请求在插件里发生两次）。
  //
  // 首次运行磁盘没缓存时，本次刷新可能晚于首帧几十秒；那段时间能力按纯文本、
  // 目录按本地兜底表保守处理（见各模块的降级注释）。
  primeModelsDev()
  // ⚠️ 走**唯一**的广播实现（`src/catalog-broadcast.ts`）：能力表是能力判定的
  // 来源，它一变就必须让客户端重读目录 —— 与十个适配器的「目录落地」同一语义，
  // 不该各写一份 emit（审计指出此处曾是内联实现，且 `ctx.logger.warn` 缺两级
  // 可选链：logger 缺席时会抛、仅被 catch 吞）。
  //
  // ⚠️ 归一缓存（`opencode-capability.ts` 的 `normalized`）必须在刷新后作废，
  // 否则它会继续用旧的归一结果 —— 那是「改了没用，重启才好」的形态。
  refreshModelsDev(() => { broadcastCatalogChanged(ctx) }, {
    onUpdated: () => { invalidateOpencodeCapabilities() },
    warn: (message) => ctx.logger?.warn?.(message),
  })
  // ⚠️⚠️ **定期刷新**（用户要求「定期读取 models.dev」）：改前只有启动时那一次，
  //   上游新增模型后**必须重启进程**才看得见（`TtlCache` 模块头记的就是这条
  //   缺陷的同型）。周期取 TTL 的一半（3 小时）—— 比 TTL 短才能保证「最坏
  //   情况下也只落后半个 TTL」，比 TTL 长则会让每次刷新都撞在 TTL 判据上而
  //   **真的发出请求**前就返回（那样等于没有周期刷新）。
  const modelsDevTimer = setInterval(() => {
    refreshModelsDev(() => { broadcastCatalogChanged(ctx) }, {
      onUpdated: () => { invalidateOpencodeCapabilities() },
      warn: (message) => ctx.logger?.warn?.(message),
    })
  }, Math.floor(MODELS_DEV_TTL_MS / 2))
  ;(modelsDevTimer as unknown as { unref?: () => void }).unref?.()
  // ⚠️ 回收：定时器必须随插件卸载而停，否则进程退出会被它挂住
  //   （与上面 `closeAllProxyDispatchers` 的回收并列，同款约定）。
  ctx.effect(() => () => { clearInterval(modelsDevTimer) })
  // ⚠️ 这里**不再**调 `registerOpencodeRpc`：opencode 的端点已并入
  // `registerJetHubRpc` 内部的 handleMethod（见 `opencode-rpc.ts` 模块头）。
  // 代理 dispatcher 是常驻连接池：插件卸载必须回收，否则进程退出会挂住。
  // ⚠️ 用仓库既有的 `ctx.effect(() => () => …)` 回收模式；cordis 的 Events
  // 里**没有** `dispose` 事件（`ctx.on('dispose', …)` 直接类型报错）。
  ctx.effect(() => () => { void closeAllProxyDispatchers() })

  // 聚合 provider：一个规范模型名挂多渠道候选表，按临期积分自动选渠道、失败自动切换
  //（见 `aggregate-adapter.ts` 模块头）。注册放在全部 provider 适配器之后：
  // 它经 ctx.llm 公开路径委托目标适配器，且目录推导要读各渠道的 listModels。
  // ⚠️ 必须传 expiryProbe：不传则所有渠道都折算成 UNUSABLE ⇒ 聚合目录虽在，
  //    但任何请求都会报「没有任何可用候选」。
  //
  // ⚠️ 聚合 provider 必须**早于** `modelAdapters` 定义注册：那张表要引用本调用返回的
  //    适配器实例（`pruned(AGGREGATE_PROVIDER, aggregateAdapter)`）。而 `modelAdapters`
  //     又必须早于 `registerJetHubRpc`（后者要拿它做设置页目录）。故聚合的注册位置
  //     比 auto 更靠前 —— 这不是笔误。
  /**
   * **共享**的临期探针（aggregate 与 auto 用同一个实例）。
   *
   * ## ⚠️ 为什么必须共享（真实缺陷，对抗审计实测证伪）
   *
   * 初版这里**直接内联** `createExpiryProbe(...)`，而 `AutoAdapter` 内部**又建一个**
   * （它自己的 `expiryProbeInstance`）⇒ **两份独立的缓存实例**，后果：
   * ① 同一渠道被折算两次（白打两次上游余额接口）；
   * ② **缓存失效必须清两次** —— 而 `clear()` 若只清到一份，另一份仍会让
   *    「刚登录的账号最长 60 秒对路由不可见」（用户拿到误导性的
   *    「没有任何可用候选」，而它其实刚登录成功）。
   *
   * ⇒ 在装配层建**一个**，两个适配器都用它；`clear()` 一次即全部生效。
   *
   * ⚠️ **共享带来的一个语义松弛 —— 它**曾经**被判定为「无害」，那个判定是错的**
   *（真实缺陷，2026-10-07 探针实测证伪）：
   *    `AutoAdapter` 自己那份 `firstModelOf` 是「跳过被禁用 + 按倍率**挑最便宜**」，
   *    而这里共享的这个是「取目录**第一个**」。共享后**两个消费者都用后者**。
   *
   *    ⚠️ 旧注释的理由是「`firstModelIdOf` 的返回值只被当作 `probeModel` 传给取号器，
   *    **不参与折算结果的任何计算**」—— 前半句对，**结论错**：`probeModel` 确实不参与
   *    「最早失效时刻」这个数值，但它**参与账号池的限流过滤**
   *   （`getAvailableAccount` 按 `entry.modelRateLimits[modelId]` 过滤），
   *    而那正是「这个模型现在还能不能用」的判据。
   *
   *    ⇒ 实测（探针）：目录为 `[glm-5.3-flash, Deepseek-V4.1-Flash · x0.1]`、
   *    账号在 `deepseek-v4.1-flash` 上额度已尽时，auto **仍选中**
   *    `codearts/deepseek-v4.1-flash` —— 因为折算问的是 `glm-5.3-flash`
   *   （未被标记），按 modelId 的过滤整体失效，请求发出去必然
   *    `InferHub.4291.200 insufficient quota`。
   *
   *    ⚠️ **已修**：两个消费者现在都**显式按将要派发的真实模型**复核账号可用性
   *   （`auto-adapter.ts` 的 `hasUsableAccountFor`、`aggregate-adapter.ts` 的
   *    `filterByModelAvailability`）—— 判据仍只有一份（账号池的 `modelRateLimits`），
   *    这两个方法只是「问对模型」。
   *
   *    ⚠️ 若将来有人让折算逻辑**依赖** `probeModel` 的**具体取值**
   *   （如「按最便宜的模型查额度」），仍需让两个消费者各自传自己的实现。
   */
/**
 * 共享缓存的**取数原语**（从 `credits.balances` 的查表分派里抽出的那一半）。
 *
 * ## ⚠️ 为什么必须与 `credits.balances` 用同一个函数（规格 §11-1 的核实结论）
 *
 * 两条路径（面板端点 / 聚合折算）取的是**同一个数**：只有共用同一份取数实现，
 * 「面板显示的余额」与「折算据此排序的余额」才不可能分叉。若各写一份，两边
 * 对同一份报文可能得出不同的 `error` / `extra` 口径（本仓库首条红线）。
 *
 * ⚠️ 取数**不含 self-heal**：续期留在 `credits.balances` / `credits.claimAll` 的
 * **端点入口**（规格 §5.7.1 末行）—— 折算路径触发填充时不该把续期开销带进发消息路径。
 * ⚠️ opencode / qoder 族 / officeace 的**特例短路仍在端点里**（它们不走本原语）：
 * 本函数只处理「查表分派」那一段（`creditsOf` + `fetchBalance(Detailed)`）。
 *
 * @returns 解析出的 `CreditBalance`（失败时抛错 ⇒ 缓存记成 `error` 读数）。
 */
async function fetchBalanceReading(
  pool: AccountPool,
  provider: string,
  entry: BalanceCacheEntry,
): Promise<unknown> {
  const runtime = runtimeOf(provider)
  const impl = runtime?.credits
  if (impl === undefined) throw new Error(`unsupported provider: ${provider}`)
  if (entry.credential === undefined) throw new Error('凭据未提供')
  // ⚠️ `ProviderCallContext` 的三个字段与 `jet-hub-rpc.ts` 里那份**同形**
  //（那里是端点闭包内的注册实例，这里是装配层的实例；实现侧只需一个形状）。
  // ⚠️ 必须与端点那份**指向同一个池**，否则折算拿到的账号集合与面板看到的不一致。
  // ⚠️ `accountId` **必须带上**（Gitee issue IKLTZ2）：Gemini 折算路径要按账号
  // 取出口代理；漏了它 ⇒ 这条路径恒直连，症状是「面板能刷新、聚合折算却失败」。
  const callContext = {
    resolveCredential: (refName: string) => ctx.credentials.resolve(credentialRef(refName)),
    warn: (message: string) => ctx.logger?.warn?.(message),
    accountPool: pool,
    accountId: entry.id,
  }
  // ⚠️ `fetchBalanceDetailed` 优先（它带 `error` / `extra`，是既有端点的口径）。
  if (impl.fetchBalanceDetailed !== undefined) {
    const detailed = await impl.fetchBalanceDetailed(entry.credential, callContext)
    if (detailed.balance === null) throw new Error(detailed.error ?? '余额查询失败')
    return detailed.balance
  }
  if (impl.fetchBalance === undefined) throw new Error(`unsupported provider: ${provider}`)
  const balance = await impl.fetchBalance(entry.credential, callContext)
  if (balance === null) throw new Error('余额查询失败')
  return balance
}


  const sharedExpiryProbe = createExpiryProbe(pool, async (provider) => {
    const models = await ctx.llm.listModels(provider)
    return models[0]?.id
  }, {
    /**
     * ★ zcode 的**按模型额度**判定需要全部目录模型 id（2026-10-12）。
     *
     * 上游 `capabilities` 是**小写**（`glm-5.3`），而池过滤的键是目录形态的
     * **大写**（`GLM-5.3`）⇒ 必须用这张目录去比对，否则标记写进去永远不命中
     * （静默失效，见 `zcode-entitlements.ts` 的 `exhaustedModelsOf`）。
     *
     * ⚠️ **只对 zcode 求值**：其余 6 家不调这个函数（探针里是惰性的），
     *    故它们每轮**零额外目录读取**。这里仍加 `provider === ZCODE.id` 判断，
     *    是为了让「谁需要它」在装配层一眼可见。
     *
     * ⚠️⚠️ **本段接线此前零测试守卫**（2026-10-12 对抗审计实测）：
     *    把它整段删掉，4 个相关 spec **158 条全绿**，而生产行为会退化 ——
     *    判定范围只剩 `probeModel` 一个模型 ⇒ 「两个专属桶都烧光」时
     *    **第二个模型不被标记**，直选它仍会拿到已尽的账号。
     *    ⇒ 违反的是**需求 (C) 的规模**（判据对，范围错）。
     *    `tests/unit/zcode-model-entitlements.spec.ts` 的
     *    「真实装配」段现在驱动**这一段真代码**（从 `index.ts` 里取值，
     *    不手写 `[...CATALOG]` 桩）—— 删掉本段即红。
     */
    catalogIdsOf: async (provider) => {
      if (provider !== ZCODE.id) return []
      const models = await ctx.llm.listModels(provider)
      return models.map((model) => model.id)
    },
    /**
     * ★★ **共享余额读数**（2026-10-15，规格 §5.7）。
     *
     * ## 用户原话（本模块存在的理由）
     *
     * 「为什么不能更新账号积分用共享缓存，取号逻辑只是在调用缓存的时候取舍的问题，
     * 不影响刷新账号积分缓存呢，账号积分缓存是更底层基础设置，计算怎么取号是
     * 基础设施上的使用逻辑」
     *
     * ⇒ 这里注入的是**同一个** `balanceCache` 实例（`credits.balances` 端点用的是
     * 它）—— 于是 buddy 系四家的折算**吃同一份读数**，而不是各自再打一次上游。
     * 「只给可用账号」这一取舍由 `createExpiryProbe` 自己的取号逻辑决定
     *（它本来就只遍历可用账号），与缓存无关。
     *
     * ⚠️ 返回 `undefined` ⇒ **本次没有共享读数** ⇒ 实现方回落到自己发请求
     * （`fetchBalanceWithCache`，见 `aggregate-expiry.ts:275` 的契约）：
     * 折算的**可用性**不得依赖本缓存（否则缓存不可用会静默变成「该渠道折算恒 UNUSABLE」）。
     * ⇒ 而返回 **`null`** 是「结论：这个账号现在不可用」（`sharedPackageExpiry`
     * 对 `null` 判 `UNUSABLE`，且**不**回落重查）—— 下面那条正是这一格。
     */
    balanceOf: async (provider, accountId, credential) => {
      const reading = await balanceCache.readOne(provider, accountId, { credential })
      // ★★ **陈旧读数不得参与折算**（2026-10-18）。
      //
      // 读路径改成 stale-while-revalidate 后，缓存陈旧时折算会拿到**旧值**，
      // 而 `stale` 字段原先只在 `readStale` 里判（`balance-cache.ts` 的注释记着
      // 那个限制）⇒ 折算会**静默地长期用 10 分钟前的数字排序**。
      //
      // ⚠️⚠️ **必须返回 `null` 而不是 `undefined`**（实测确证，2026-10-18）：
      //   契约（`aggregate-expiry.ts:275`）与实现（`fetchBalanceWithCache`）都规定
      //   `undefined` = 「**本次没有共享读数**⇒ 回落到自己发请求」，`null` 才是
      //   「结论：不可用」。实测（mock `fetchCreditBalance` 成功）：
      //     - 返回 `undefined` ⇒ fallback **被调用 1 次**，折算返回**上游的值**（≠ UNUSABLE）
      //     - 返回 `null`      ⇒ fallback **0 次**，折算返回 `-1`（UNUSABLE）
      //   ⇒ 写 `undefined` 会得到「陈旧账号每次折算**多打一次上游请求**」，
      //     恰恰是本条要消灭的行为（且与「读路径一个请求都不发」相悖）。
      //
      // ⚠️ 与 officeace 分支的既有约定同构（`aggregate-expiry.ts:1141`：
      // 「`summary.stale === true` ⇒ 判 `UNUSABLE`」）。同一次改动在别处新增了
      // 这条、而面板出口把两天前的快照当实时余额显示，被审计记为
      // 「**同一份数据两层结论相反**」（`jet-hub-rpc.ts:5462`）——
      // 本行就是避免复发的那一腿。
      //
      // ⚠️ **有意的行为代价（如实登记）**：折算可能因陈旧读数而少一个候选渠道，
      // 用户表现为**聚合轮换里某个渠道暂时不出现**。这比「用 10 分钟前的数字
      // 排序」安全，且与 officeace 既有行为一致（用户 2026-10-18 明确接受）。
      if (reading.stale === true) return null
      return reading.error === undefined ? reading.value : undefined
    },
  })
  // ⚠️ 赋给上面的可变引用 ⇒ 账号入库时清空折算缓存（见那里的注释）。
  sharedExpiryProbeRef = sharedExpiryProbe

  const aggregateAdapter = registerAggregateLlm(ctx, {
    accountPool: pool,
    expiryProbe: sharedExpiryProbe,
    // ⚠️ **函数**而非快照（P2）：设置面板改了拒绝表后，**下一次请求**就要生效。
    //    传快照会让用户以为开关坏了（要重启插件才生效）。
    //    `pool.listAggregateRejections()` 返回进程内权威副本（与 state.json 同步）。
    rejections: () => pool.listAggregateRejections(),
    // ⚠️ 同样是**函数**（不是快照），理由与 `rejections` 完全相同：面板改完开关，
    //    下一次请求就要生效。三张表都是「同一枚开关的不同域」，故接线必须一起给
    //   （漏一个 ⇒ 该功能整个不生效，且**完全静默**：例如漏 `allowed` 时，
    //   用户手工打开的未接入候选仍会被判成「默认不参与」）。
    allowed: () => pool.listAggregateAllowed(),
    order: () => pool.listAggregateOrder(),
    orderMode: () => pool.listAggregateOrderMode(),
  })
  // ⚠️ 赋给上面的可变引用 ⇒ 账号入库时**也**清候选序缓存（见那里的长注释：
  //    两个缓存不同，只清折算缓存会让「刚登录的账号」在 60 秒内仍不进候选序）。
  sharedChoiceCacheRef = aggregateAdapter
  // ===== Jet Hub RPC 注册 =====
  // Jet Hub「自动」：一个 `auto` 模型名用整池，按「积分最快作废」跨 provider 选型
  // （见 `auto-adapter.ts` 模块头）。注册放在全部 provider 适配器之后：它经
  // ctx.llm 公开路径委托目标适配器，目录/凭据此时均已就绪。
  //
  // ⚠️ 位置在 `modelAdapters` 表**之前**：那张表要收它的实例（见下面的
  //    `'jet-hub-auto'` 键），而 `usage.badge` 对 `jet-hub-auto` 的改写依赖它。
  // ⚠️ 上游 `ba10f4f` 重写 aggregate 时把这条接线一并删掉了 ⇒ 旧 auto 的徽标
  //    彻底消失（用户报障 2026-10-08「也没胶囊了？」）。这里补回来。
  const autoAdapter = registerAutoLlm(ctx, {
    accountPool: pool,
    // ⚠️ **与 aggregate 共用同一个探针**（真实缺陷，对抗审计实测证伪）：
    //    不传时 `AutoAdapter` 会**自建一份**，于是有两份独立缓存 ⇒
    //    ① 同一渠道被折算两次（白打两次上游余额接口）；
    //    ② 缓存失效要清两次，漏一次就让「刚登录的账号最长 60 秒对路由不可见」。
    expiryProbe: sharedExpiryProbe,
  })
  // provider → 适配器实例：Jet Hub「显示列表」需要 `listAllModels()`（不受用户
  // 黑名单影响的全量目录，带最终展示名/倍率）。DSH 的 `ctx.llm` 只保证
  // `listModels`，不透传自定义方法，故这里显式把实例传下去。
  //
  // ⚠️⚠️ **必须走 `withDeadModelPruning`，不能直接用 `registerXxxLlm` 的返回值**
  // （致命缺陷，2026-10-06 复审 !66 实测）：那些函数返回的是 `new XxxAdapter(...)`
  // —— **原始实例**，而 `registerAdapterIdempotent` 只把**代理**注册进了 `ctx.llm`。
  // 于是 `jet-hub-rpc` 的 `model.list` 先 `await llm.listModels()`（走代理，已剔除），
  // 紧接着又用本表的 `listAllModels()` **覆盖**成全量目录（走原始，**未剔除**）⇒
  // 已失效模型被加回设置页，PR 想修的「用户仍看到下架模型」原问题**完全没修到**。
  //
  // 这里复用与注册**同一个**包装函数，确保两条路径的可见性一致。
  // ⚠️ `codearts` 不在 `modelAdapters` 的常规形态里，但它同样需要该包装。
  //
  // ⚠️ 包装失败**不阻断启动**：回退到原始实例即可（它只是显示层的收敛）。
  const pruned = <T extends object>(
    provider: string,
    adapter: T,
    options?: { enabled?: boolean },
  ): T => {
    try {
      return withDeadModelPruning([provider], adapter, options)
    } catch (error) {
      ctx.logger.warn(`[jet-hub] ${provider} 的失效模型剔除包装失败，使用原适配器: ${String(error)}`)
      return adapter
    }
  }
  const modelAdapters: Record<string, { listAllModels(): readonly { id: string; name: string }[] }> = {
    // `codearts` 是 registerCodeArtsLlm 返回的**适配器实例**（与 CodeArtsAuth
    // 服务实例 `service` 不同名，故这里可以简写）。
    codearts: pruned(CODEARTS_PROVIDER, codearts),
    buddy: pruned('buddy', buddyAdapter),
    workbuddy: pruned('workbuddy', workbuddyAdapter),
    lobsterai: pruned(LOBSTERAI.id, lobsteraiAdapter),
    qoder: pruned(QODER.id, qoderAdapter),
    qodercn: pruned(QODER_CN.id, qoderCnAdapter),
    trae: pruned(TRAE.id, traeAdapter),
    cline: pruned(CLINE.id, clineAdapter),
    loomy: pruned(LOOMY.id, loomyAdapter),
    raccoon: pruned(RACCOON.id, raccoonAdapter),
    minimax: pruned(MINIMAX.id, minimaxAdapter),
    minimaxintl: pruned(MINIMAX_INTL.id, minimaxIntlAdapter),
    autoclaw: pruned(AUTOCLAW.id, autoclawAdapter),
    // ⚠️ 国际版与国内版**同一套实现的两个实例**，但 provider id 不同 ⇒
    //    必须各自一条（与 minimaxintl 同款）。键是 provider id `autoclawintl`
    //    （全小写），值是变量 `autoclawIntlAdapter`（驼峰）。
    autoclawintl: pruned(AUTOCLAW_INTL.id, autoclawIntlAdapter),
    accio: pruned(ACCIO.id, accioAdapter),
    gemini: pruned(GEMINI.id, geminiAdapter),
    zcode: pruned(ZCODE.id, zcodeAdapter),
    opencode: pruned(OPENCODE.id, opencodeAdapter),
    // ⚠️ **本 fork 独有**（modelscope，2026-10-16）。必须进这张表：
    //    `provider.status` 的「已关闭」判据是 `total > 0 && disabled === total`，
    //    它读的是 `listAllModels()` 那份**不套黑名单**的全量目录。表里缺它 ⇒
    //    退化到 `llm.listModels`（已按黑名单过滤）⇒ 「关闭整个 provider」时
    //    漏写黑名单 ⇒ 出现「provider 显示已关闭、模型却仍可选用」的矛盾态。
    modelscope: pruned(MODELSCOPE.id, modelscopeAdapter),
    // OfficeAce（华为 MaaS 云端直连）：目录静态 + 平台侧可用性，同其余渠道。
    officeace: pruned(OFFICEACE.id, officeAceAdapter),
    // AStudio（上游 MAAS 云端直连）：目录来自 model-manager 远端 + 兜底表，同其余渠道。
    astudio: pruned(ASTUDIO.id, astudioAdapter),
    // ⚠️ 聚合 provider 也必须进这张表（设计文档 §5.2 的必改点）：`jet-hub-rpc.ts` 的
    // `fullCatalogIds` **优先**用本表的 `listAllModels()`（不套黑名单的全量目录），
    // 缺失时才退化到 `llm.listModels(provider)` —— 后者已被适配器按黑名单过滤。
    // 于是「关闭整个聚合 provider」时只拿到**未被关闭的** id ⇒ 已关闭的模型漏写黑名单，
    // 而 `provider.status` 的判据是 `closed = total > 0 && disabled === total`
    // ⇒ 出现「provider 显示已关闭、模型却仍可选用」的矛盾态。
    // `pruned(...)` 会包上失效模型剔除；聚合已提供**同步** `listAllModels()`，满足契约。
    // ⚠️ 但聚合必须传 `enabled: false`（**完全不参与**该机制：不记录、**也不过滤**）
    //    —— 真实缺陷（全分支终审 C2 + 审计轮次二补修的残留面）。本机制是为
    //    「**编译期兜底快照**跟不上上游下架」设计的，而聚合层的目录是**动态推导**的
    //    （上游下架后下次推导自然消失）⇒ 既不需要记录，也不该被过滤。
    //    ① **记录**的危害：外层包装观察到的是 `aggregate` + **虚拟键**（实测），于是
    //       「某一个渠道没有该 realId」被记成「**整个规范模型**失效」，而它在其余渠道
    //       上完全可用；且恢复入口 `model.clearDead` 的 UI 在设置页 provider 面板里，
    //       而客户端 `PROVIDERS` **没有 `aggregate`** ⇒ **没有任何 UI 能恢复**。
    //    ② **过滤**的危害（补修的那半）：初版只跳过记录、仍保留过滤 ⇒ 若表里**已有**
    //       旧版本写下的 `aggregate` 记录（C2 修复前跑过一次就会有），虚拟模型**仍被
    //       隐藏**，且同样无 UI 可恢复 —— 实测探针确认（预置 `aggregate/m1` 后
    //       `listModels` 只返回 `['auto','m2']`）。
    //    ⇒ 传 `enabled: false` 让本函数**直接返回原适配器**，历史遗留记录被忽略。
    aggregate: pruned(AGGREGATE_PROVIDER, aggregateAdapter, { enabled: false }),
    // ⚠️ 旧 auto 也必须进这张表：`jet-hub-rpc.ts` 的 `usage.badge` 经它取
    //    「实际转发历史 / 预测 / 倍率」（见 `ModelCatalogSource.autoState`）。
    //    ⚠️ **不能**给 `registerJetHubRpc` 加第 17 个位置参数 —— 那条派生式不变量
    //    「客户端 PROVIDERS 条数 + 1 == 形参个数」会立刻变红（实测 10 条接线断言
    //    同时失败），而它正是为了防「位置错位 = 拿 A 的实例当 B 用」。
    //    ⚠️ 同样传 `enabled: false`：auto 是**动态**的单模型（真实目标由选型决定），
    //    「编译期兜底快照跟不上上游下架」那套记录/过滤机制对它没有意义。
    'jet-hub-auto': pruned(AUTO_PROVIDER, autoAdapter, { enabled: false }),
  }

  /**
   * ★ **模型目录的后台刷新器**（用户 2026-10-18 的要求）。
   *
   * 「各个模型的模型列表缓存也要带定时更新，20 分钟更新一次，如果不更新随高峰低谷
   * 变化的积分消耗倍率是更新不到实际的倍率」
   *
   * ## ⚠️ 为什么必须建在 `modelAdapters` **之后**（位置不变式）
   *
   * 它要读那张表拿实例。早于建表 ⇒ 空表 ⇒ **目录永不刷新、且零日志**
   * （与 `wiredRefreshTargets()` 前身在 2026-10-15 踩的坑同型）。
   *
   * ## ⚠️ 为什么走 `modelAdapters` 而不是 `ctx.llm`
   *
   * `ctx.llm` 是 DSH 的公开面，**不认识** `refresh()`（那是本插件给目录契约加的可选成员）。
   * 而 `modelAdapters` 的每一项都是 `pruned()` 的 Proxy —— 它对**其余成员原样透传并绑定
   * `this`**（`src/dead-model-store.ts:748-749`），故新加的 `refresh()` 能自动透出来。
   *
   * ## ⚠️ 未实现 `refresh` 的 provider 必须跳过
   *
   * `opencode` 这类本地派生渠道（零网络）本就没有远端可拉。对它们空转会让
   * 「刷新器说跑了 9 家、实际只刷了 3 家」**完全静默**。
   */
  const catalogRefresher = createCatalogRefresher({
    listProviders: () => Object.keys(modelAdapters),
    refreshOf: (provider) => {
      const adapter = modelAdapters[provider] as { refresh?: () => Promise<void> } | undefined
      const refresh = adapter?.refresh
      // ⚠️⚠️ **`undefined` 只能表示「这家没有该成员」**（2026-10-20 修正）：
      //    刷新器据此统计「本轮几家真的参与」，**零参与即 warn**
      //    （见 `createCatalogRefresher` 的注释）。故**不要**写成
      //    `return adapter?.refresh?.()` —— 那会让「成员存在但同步返回 void」
      //    与「成员根本不存在」不可区分，统计随之失真。
      //    ⚠️ 而本仓库实测的失效形态恰恰是「成员根本不存在」：`be42b25` 给
      //    `createModelCatalog` 的 config 加了 `refresh` 回调，却**没有**把它
      //    转发成适配器实例的成员，而该提交的注释误以为 `pruned()` 的 Proxy
      //    会把它透出来（Proxy 只透传适配器**自己的**成员）。
      if (typeof refresh !== 'function') return undefined
      return Promise.resolve(refresh.call(adapter)).then(() => undefined)
    },
    info: (message) => ctx.logger?.info?.(message),
    warn: (message) => ctx.logger?.warn?.(message),
  })
  // ⚠️ 生命周期挂 `ctx.effect`，与插件一致（释放后停手）——
  //    与既有 `modelsDevTimer`、余额刷新器同款约定。
  ctx.effect(() => {
    catalogRefresher.start()
    return () => { catalogRefresher.stop() }
  })

  // 插件卸载前把签名缓存落盘：`stream()` 每次结束都 flush，但用户可能
  // 直接关掉 DSH 而上一轮的 flush 还在排队 —— 落一次盘几乎零成本，
  // 丢的却是「下一轮工具调用能不能带上签名」。
  ctx.effect(() => () => { void geminiSigStore.flush().catch(() => {}) })

  // 冷启动的**有界目录预热**（issue IKJVTF 的冷启动自愈半条）。
  //
  // 为什么必须有：首拉失败后适配器回落到**静态兜底表**，客户端把这份兜底目录
  // 缓存成 `status: 'ready'`（它只认宿主事件），而**没有任何东西会在冷却到期后
  // 再问一次** —— 只有用户主动打开设置页/切模型才可能触发下一次 `listModels`。
  // 于是「远端目录其实早已可达，只是没人再问」会一直持续到用户碰巧触发重读。
  //
  // ⚠️ **间隔必须大于 `RemoteCatalogGate` 的 30 秒失败冷却**，否则重试被闸门
  // 原样挡回、什么也不做（等于没预热）。该约束由 `catalog-prewarm.ts` 的
  // `CATALOG_PREWARM_DELAYS_MS` 与 `tests/unit/catalog-prewarm.spec.ts` 共同守着。
  //
  // ⚠️ 走 `ctx.llm.listModels` 而不是适配器私有方法：它会走完整路径
  // （账号门控 → `ensureRemoteModels` → 闸门），目录已就绪时是**零网络**的，
  // 且对 `withDeadModelPruning` 包装透明（直接拿原始实例会绕过那层收敛）。
  //
  // ⚠️ **不 await**：`apply()` 是同步函数，预热会发网络请求（与既有的
  // opencode 能力预热同款约定）。停止函数挂 `ctx.effect`，插件释放后停手。
  ctx.effect(() => startCatalogPrewarm({
    providers: Object.keys(modelAdapters),
    warm: (provider) => ctx.llm.listModels(provider),
    logger: { warn: (message) => ctx.logger?.warn?.(message) },
  }))


  // ⚠️ **命名对象**（2026-10-08 改，原为 13 个位置参数）：位置参数下改顺序/插队
  // 都会**静默错位**（症状是「某个 provider 用另一个 provider 的凭据续期」），
  // 本仓库历史上因此复发 6 次。命名对象让错位在类型层面不可能，且新增 provider
  // 只加一个键。
  //
  // ⚠️ **键是 provider id `qodercn`，值是变量 `qoderCn`** —— 两者不同名是刻意的：
  // 键必须与 `entry.provider` 同形，否则按 id 取实例会落空（`authOf(auths, id)`，
  // 见 `jet-hub-rpc.ts` 的 `JetHubAuths` 注释）。本地变量名沿用既有惯例。
  // 写成 `qoderCn:` 会编译失败（接口没有该键），这正是我们要的。
  //
  // ⚠️ **分派现状**：`account.refresh` **已**改成 `authOf(auths, entry.provider)`
  // 查表分派（Task 2 完成，见 `jet-hub-rpc.ts` 的 `account.refresh` 分支）——
  // Task 9 引入命名对象时还在的那 13 个同构 `switch (entry.provider)` case
  // （含 `requireQoderFamily` 取 Qoder 同族实例那一处）**已整体删除**。
  // 上面「键必须是 provider id」那条约定正是该查表能命中 `qodercn` 的前提。
  // ===== 积分能力表（设计文档 §3.3 / Task 3）=====
  //
  // ⚠️ **只建一份，且只挂一个消费点**：`ProviderRuntime.credits` ——
  //    给**拿不到 `auths` 形参**的跨模块消费点（Task 5 的 `aggregate-expiry.ts`、
  //    Task 8 的 `account-probe.ts`）。
  //
  // ⚠️ `credits.balances` / `credits.status` **不再读这里**（2026-10-08 设计复审 C1）：
  //    它们由 `registerJetHubEndpoints` 从**已解构的 `auths`** 现造一张等价的表。
  //    原先本处还把它当第 5 个实参传给 `registerJetHubRpc`，那既是一个纯测试接缝
  //    （生产路径上两处传的是**同一批实例**、删掉实参行为不变），又是一个
  //    可选的**位置**形参 —— 在它之前插入新形参会**静默**错位（本仓库实测复发
  //    6 次的形态）。
  //
  // ⚠️ **两处是两个独立的 `createProviderCredits` 调用**（本处 + `jet-hub-rpc.ts`），
  //    故「有人改了一处忘了另一处」在原理上仍可能。防线是**两侧各自被钉在
  //    `PROVIDER_REGISTRY` 上**，而不是「只有一份所以不可能漂移」：
  //    - 本处的表 → `provider-runtime-wiring.spec.ts` 真跑 `apply()`，
  //      断言每个有余额能力的渠道 `runtimeOf(id).credits` 都**有余额方法**；
  //    - 端点侧的表 → `credits-runtime-parity.spec.ts` 的「表里的渠道集合 ===
  //      registry 里有余额能力、且非特例的渠道」（含带 deps 的形态）。
  //    两侧同源同构，故任一侧少一家都会被点名。
  //
  // ⚠️ 三家（loomy / raccoon / zcode）的余额查询走**各自 auth 实例**上的方法
  //    （实例可能带注入的 `fetchImpl`），故必须传实例 —— 重构前 RPC 就是这么调的。
  //    其余走自由函数 + 全局 fetch。
  const creditsTable = createProviderCredits({
    loomy, raccoon, zcode,
    // ⚠️ LobsterAI 的 `clientVersion` 是签到**必填**参数且**动态**解析（带 TTL 缓存）
    //    —— 故传**惰性**解析器，不能先 await 成一个常量（那会让「缓存过期后拿到
    //    新版本」失效）。见 `ProviderCreditsDeps.lobsteraiClientVersion`。
    lobsteraiClientVersion: () => lobsterai.resolveClientVersion(),
    // ⚠️⚠️ **MiniMax 国际站的 XFF 必须在这里也接上**（真实缺陷，2026-10-17 审计打穿）。
    //
    // 本文件与 `jet-hub-rpc.ts` 是**两个独立的 `createProviderCredits` 调用**
    //（上面那段注释正是为此而写），而 `ProviderRuntime.credits` 被
    // `fetchBalanceReading`（本文件 L≈3136）消费 —— 后者是 `balanceCache` 的
    // **取数原语**：`collectCreditBalances` 命中缓存前会先走它，失败才回落到端点表。
    //
    // ⇒ 只接端点表的话，**面板第一次查国际站余额走的正是这条无 XFF 的路径**，
    //   失败后还要吃满 failureTtl（15s）才可能重试 —— 症状就是「设了 XFF，
    //   积分行仍然查询失败」。本次只改了一处，正是那份注释警告的形态。
    //
    // ⚠️ 惰性读（用户随时可能改设置），不能固化成字符串。
    minimaxXff: () => pool.minimaxXff(),
    // ⚠️ Gemini 的按账号 fetcher（Gitee issue IKLTZ2）：**折算路径**也要走代理，
    // 否则「面板能刷新、聚合候选却恒折算失败」—— 与上面 minimaxXff 同型陷阱
    // （这里也正是它第一次被引入的同一个 `createProviderCredits` 调用）。
    geminiFetchFor: geminiFetchForAccount,
  })
  /**
   * **一次性奖励**能力表（Loomy 新手任务 / raccoon 登录奖励）。
   *
   * ⚠️ 与 `creditsTable` 同款：两处（本处 + `jet-hub-rpc.ts`）是两个独立调用，
   *    防线是**两侧各自被钉在 `PROVIDER_REGISTRY` 上**，而不是「只有一份」。
   */
  const onboardingTable = createProviderOnboarding({ loomy, raccoon })

  /**
   * **临期折算**能力表（供聚合 / auto 的候选排序）。
   *
   * ⚠️ 与 `creditsTable` / `onboardingTable` 的关键区别：本表是**唯一**的一份，
   *    且它的消费点**只有** `ProviderRuntime.expiry` —— 没有任何端点侧副本
   *    （那两个域各有第二份「从 `auths` 现造」的表，本域没有：它的消费者是
   *    `src/aggregate-expiry.ts`，那是个拿不到 `auths` 形参的独立模块）。
   *
   * ⚠️ 表**建在 `src/provider-expiry.ts`**（而不是内联在这里）：几十处既有用例
   *    直接构造 `createExpiryProbe` / `AggregateAdapter`、**不调 `apply()`**，
   *    它们要验折算**值**（TTL 缓存 / 取全部账号 / `clear()`）就必须让 runtime 里
   *    有**真实**实现。表若内联在此，那些用例只能各写一份自己的映射 ⇒
   *    「同一语义两套判据」（本仓库首条红线）。生产与单测**共用同一份**。
   *
   * ⚠️ **只挂「已接入临期折算」的渠道**（`expiry` 域存在即已接入）——
   *    **刻意不在此写数字、也不抄名单**：同一事实的多份抄写必然漂移（见本文件下方
   *    `probeById` 那段教训）。`WIRED_EXPIRY_PROVIDERS` 与它的一致性由
   *    `tests/unit/expiry-runtime-parity.spec.ts` 真跑 `apply()` 锁死：
   *    未接入的渠道**不该**出现在聚合候选里。返回 `UNUSABLE` 也会被剔除，
   *    但让它压根不进目录更诚实 —— 见 `aggregate-expiry.ts` 的长注释。
   *
   * ⚠️ **这里挂的是「选哪个原语」，不是原语本身**：各家的 `*Expiry` 原语
   *    （判据与量纲各异）原样保留在 `aggregate-expiry.ts`
   *    （设计文档 §3.5.3 / §3.6 的边界）。
   *
   * ⚠️ 用 `expiryOf` 而非下标（原型链键误判），与 `creditsOf` 同因。
   */
  const expiryTable = createProviderExpiry({
    // ⚠️⚠️ **MiniMax 国际站的 XFF 必须在这里也接上**（2026-10-20，与 L3858 那处
    //    `creditsTable` 的 `minimaxXff` **同因**）。
    //
    // `ProviderRuntime.credits` 与 `ProviderRuntime.expiry` 是**两个独立消费域**
    //（前者喂积分面板，后者喂聚合候选排序），两者的 xff 通道**各走各的**：
    // 只接 credits 那处的话，症状正是「面板能刷新、聚合候选却恒折算失败」
    //（本仓库在 2026-10-17 审计里已对 `creditsTable` 记录过同型缺陷）。
    //
    // ⚠️ 惰性读（用户随时可能改设置），不能固化成字符串。
    minimaxXff: () => pool.minimaxXff(),
  })


  // ===== 能力注册表（设计文档 §3.3）=====
  //
  // ⚠️ **本段是前瞻接线**（2026-10-08 调序后修正）：`account.refresh` 的分派
  //    **不走**这张表 —— 它查 Task 9 引入的 `auths` 形参（见 `jet-hub-rpc.ts` 的
  //    `authOf`）。本表是给**真正跨模块**的消费点用的：Task 5 的
  //    `aggregate-expiry.ts` 与 Task 8 的 `account-probe.ts` ——
  //    那两个模块拿不到 `auths` 形参。
  //
  // ⚠️ 仍必须在**所有 provider 实例都已创建之后**注册：实例要先存在。
  //
  // ⚠️ 注册的是**引用**，不是快照：`registerProviderRuntime` 只记 Map 条目，
  //    各 auth 实例的后续状态变化（凭据缓存、队列）对它透明。
  //
  // ⚠️ 这里**不注册 opencode**（它没有续期概念）与 aggregate / auto
  //    （虚拟 provider，无账号无凭据）。它们的 runtime 只有 descriptor。
  //    ⚠️ opencode 的积分也**不在** `creditsTable` 里（它的余额是本地派生的
  //    通道可用性、零网络，作为特例留在 `credits.balances` 里短路）。
  /**
   * OfficeAce 的 auth **不是 `Service` 子类**（它导出的是纯函数集合，没有实例
   * 状态需要挂到 cordis 服务上）。但仓库的统一 auth 契约（`JetHubAuthLike`）
   * 与多条守卫用例都按 **`ctx.<provider>Auth` 服务名**取实例 —— 故这里显式
   * 把命名空间包成一个服务形状的对象。
   *
   * ⚠️⚠️ **必须「复制」模块导出，不能手工枚举**（2026-10-13 事故）：
   *    早先这里是手写的一份方法清单，`persistLogin` 加入后忘了同步 ⇒
   *    `login.poll` 调 `auths.officeace.persistLogin` 得到 `undefined`，
   *    被 catch 成「登录交换失败」—— 用户看到的是**授权完却登录失败**，
   *    而日志里只有一句被吞掉的类型错误。手工枚举的清单**必然**漂移。
   *
   * ⚠️ **不能用 `Object.create(officeaceAuth)` 继承**：赋值会沿原型链走到
   *    模块命名空间的 getter-only 属性，照样抛
   *    `Cannot set property … which has only a getter`（已实测证伪）。
   *    故一次性展开复制 —— 模块导出是静态函数，复制的是引用，不会失效。
   *
   * ⚠️ **不能直接挂模块命名空间**：同上，getter-only 会让守卫用例的 spy 崩溃。
   */
  const officeaceAuthService: typeof officeaceAuth = { ...officeaceAuth }
  // ⚠️ 以下几个需要注入 `ctx.credentials`（多账号根）：凭据存在 DSH 凭据库里
  //    按 ref 索引。不传 ⇒ 走兼容文件 `session.json`，那份是**所有账号共用**
  //    的，续期会串号（2026-10-13 改造）。
  Object.assign(officeaceAuthService, {
    refreshAccountCredential: (refName: string, pool: unknown, accountId: string) =>
      officeaceAuth.refreshAccountCredential(refName, pool as never, accountId, ctx.credentials as never),
    /**
     * 批量续期：**复用 `officeace-auth.ts` 的 `refreshAccountList`**，
     * 只把「续期某一个账号」分派到本对象的 `refreshAccountCredential`。
     *
     * ⚠️⚠️ **不要再抄一份遍历逻辑**（IKLPTZ 的真实成因）：这里原先逐字复制了
     * 模块里的那份，连注释都一样，于是「把同步的 `listAccountsByProvider`
     * 当 Promise 用」这个误判被**复制了两遍**，一个 bug 要修两处、测试也要
     * 覆盖两处。收成一份之后，`refreshAccountList` 的签名就是唯一真源。
     *
     * ⚠️ **不得直接挂模块函数 `officeaceAuth.refreshAll`**：那份走的是**没有
     * `ctx.credentials`** 的兼容文件腿，多账号下会串号（2026-10-13 改造）。
     * 这里必须走本对象 —— 它的 `refreshAccountCredential` 才注入了凭据库。
     *
     * ⚠️ 守卫用例（`provider-runtime-wiring.spec.ts`）的判据是「布桩在
     * `ctx.officeaceAuth.refreshAccountCredential` 上，然后断言 `refreshAll`
     * 打到它」。故这里**必须**经 `officeaceAuthService` 取方法（走本对象），
     * 绕开它去调模块函数 ⇒ spy 收不到，用例静默少一家覆盖。
     */
    refreshAll: (pool: unknown) => officeaceAuth.refreshAccountList(
      pool,
      (account) => officeaceAuthService.refreshAccountCredential(
        account.credentialRef, pool, account.id,
      ),
    ),
  })
  {
  /**
   * OfficeAce 的 auth 服务形状包装（`officeaceAuthService`）—— 定义在下方
   * 的能力注册段里。它必须与 `ctx.provide("officeaceAuth", …)` 及
   * `registerJetHubRpc` 的 `auths.officeace` 是**同一个对象**（守卫用例布桩在
   * ctx 上，两处各建一个会让 spy 收不到调用；理由见定义处注释）。
   */
    const registry: ReadonlyArray<readonly [string, JetHubAuthLike]> = [
      ['codearts', service],
      ['buddy', buddy],
      ['workbuddy', workbuddy],
      ['lobsterai', lobsterai],
      ['qoder', qoder],
      ['qodercn', qoderCn],
      ['trae', trae],
      ['cline', cline],
      ['loomy', loomy],
      ['raccoon', raccoon],
      ['minimax', minimax],
      // ⚠️ MiniMax Code 国际版：与 `minimax` **共用同一个 `MinimaxAuth` 类**，
      //    故键与值都是它自己那个实例（`minimaxintl`）。写成 `minimax: minimaxIntl`
      //    这类错位会让国际站账号的续期去刷国内站凭据（同族串接，本仓库复发过 6 次）。
      ['minimaxintl', minimaxIntl],
      ['zcode', zcode],
      ['gemini', gemini],
      // OfficeAce（华为 MaaS 云端直连）：值是 **auth 服务形状的包装对象**
      //（`officeaceAuthService`，不是 Service 实例）—— 必须与
      // `ctx.provide('officeaceAuth', …)` 及 `registerJetHubRpc` 的
      // `auths.officeace` 是**同一个对象**，否则守卫用例布在 ctx 上的 spy
      // 收不到本循环的调用（实测症状：`续期没有分派到它自己的实例（实际：无）`）。
      ['officeace', officeaceAuthService as unknown as JetHubAuthLike],
      ['autoclaw', autoclaw],
      // ⚠️ AutoClaw 国际版：与 `autoclaw` **共用同一个 `AutoclawAuth` 类**，
      //    故键与值都是它自己那个实例（`autoclawIntl`）。写成 `autoclaw: autoclawIntl`
      //    这类错位会让国际站账号的续期去刷国内站凭据（同族串接，本仓库复发过 6 次）。
      //    漏加这一行 = 它不进注册表 ⇒ 续期/积分/探测三条链路**全部静默失效**
      //    （`provider-runtime-wiring.spec.ts` 会点名 `autoclawintl 未注册`）。
      ['autoclawintl', autoclawIntl],
      ['accio', accio],
      // AStudio（讯飞 AstronStudio）：值是 AstudioAuth 服务实例 —— 它已在构造时
      // provide 自己（服务名 astudioAuth），必须与 registerJetHubRpc 的 auths.astudio
      // 是**同一个对象**，否则守卫用例布在该实例上的 spy 收不到本循环的调用。
      // 实测签名可结构化匹配 JetHubAuthLike（refreshAccountCredential(refName, pool?,
      // accountId?) 的可选形参可接收必填实参；refreshAll(pool) 完全一致），
      // 故**不需要**上面 officeace 那样的 as unknown as JetHubAuthLike 包装。
      ['astudio', astudio],
      // ⚠️ **本 fork 独有**的 provider（上游 rc.11 仍无 modelscope）。
      //    漏加这一行 = 它不出现在注册表里 ⇒ 续期/积分/探测三条链路全部静默失效。
      ['modelscope', modelscope],
    ]
    for (const [id, auth] of registry) {
      const descriptor = descriptorOf(id)
      if (descriptor === undefined) {
        // ⚠️ 不静默跳过：registry 与这里的清单漂移会表现为「某个 provider 的功能没了」。
        ctx.logger?.warn?.(`[jet-hub] provider registry 缺少声明：${id}`)
        continue
      }
      // ⚠️ 返回值必须判：`false` 表示「已存在、跳过了本次」——
      //    那发生在 **fiber 重启竞态**（新 apply 与旧 dispose 交错），是正常现象，
      //    记一条 info 即可（不是错误）。静默忽略会让「某个 provider 的注册被跳过」
      //    在日志里无痕。
      const registered = registerProviderRuntime({
        descriptor,
        auth: {
          // ⚠️ 只传三个参数、顺序固定 —— 各家的 `refreshAccountCredential` 签名一致
          //（本插件的统一 auth 契约）。包一层而不是直接挂方法引用：直接挂会让
          // `this` 丢失（各家方法内部用 `this.product` / `this.ctx`）。
          refreshAccount: (refName, pool, accountId) =>
            auth.refreshAccountCredential(refName, pool, accountId),
          // ⚠️ **每个会写限流标记的家都要挂**：漏一家 ⇒ 该家凭据**永不自动续期**，
          //    而症状是「每隔一段时间就要重新登录」，且日志里一个字都没有。
          // ⚠️ **真正锁住这件事的只有 `provider-runtime-wiring.spec.ts`**
          //    （它真跑 `apply()`，再逐个驱动 `auth.refreshAll` 并断言打到
          //    **自己那个**实例）。2026-10-08 独立复审修正原注释：它原先点名
          //    `refresh-targets-derived.spec.ts` 与 `refresh-bootstrap-wiring.spec.ts`
          //    各有一条 —— 实测**两者都不 import `index.ts`**，
          //    它们注册的是**自己的桩**再断言桩，改坏本段循环它们照样全绿
          //    （`refresh-targets-derived.spec.ts` 的用例⑦ 现锁的是
          //    `modelAdapters` 的键，与本段无关）。
          // ⚠️ 包一层而不是直接挂方法引用：直接挂会让 `this` 丢失
          //   （各家 `refreshAll` 内部用 `this.product` / `this.ctx`）。
          refreshAll: (pool) => auth.refreshAll(pool),
        },
        // ⚠️ `creditsOf` 而非 `creditsTable[id]`：`in`/下标会命中原型链上的键
        //（如 `constructor`），与 `jet-hub-rpc.ts` 的 `authOf` 同因。
        // ⚠️ qoder 系**没有** credits 条目（形态不匹配，是特例），故这里
        //    对它们是 `undefined` —— 如实表达「该渠道不在表里」。
        credits: creditsOf(creditsTable, id),
        // ⚠️ 与 credits 同法：`onboardingOf` 而非下标（原型链键误判）。
        // ⚠️ 只有 loomy / raccoon 有条目 —— 其余如实为 `undefined`。
        onboarding: onboardingOf(onboardingTable, id),
        // ⚠️ 与 credits / onboarding 同法：`expiryOf` 而非下标（原型链键误判）。
        // ⚠️ 只有**已接入临期折算**的渠道有条目 —— 其余如实为 `undefined`
        //    （那是「未接入」的诚实表达：`credentialExpiry` 据此返回 `UNUSABLE`）。
        //    ⚠️ `WIRED_EXPIRY_PROVIDERS` **不**从这里派生（它是编译期常量），
        //    两者的一致性由 `expiry-runtime-parity.spec.ts` 真跑 `apply()` 锁死。
        expiry: expiryOf(expiryTable, id),
        // ⚠️ 与其余域同法：`probeById[id]` 用 `Object.hasOwn` 语义（下标会命中原型链）。
        // ⚠️ **`probeById` 已登记全部会写限流标记的家**（判据 = `probeById` 头注释
        //    里那两条 grep；权威清单 = `tests/helpers/provider-sets.ts` 的
        //    `WRITES_RATE_LIMIT_PROVIDERS`），
        //    其余如实为 `undefined`（`adapterForProbe` 据此抛「不支持重测」，
        //    不落回 CodeArtsAdapter）。
        //    ⚠️ **刻意不写「几家」、也不抄名单**：本句曾写「现登记 **12 家**」，
        //    实测顶层键是 13；2026-10-11 加入 `minimax`（issue IKJW32）后是 14 ——
        //    同一事实的多份抄写必然漂移（`probeById` 头注释、本段、
        //    `account-probe.ts` 的判据都各抄过一份）。数字与名单一律看
        //    `probeById` 的键与 `WRITES_RATE_LIMIT_PROVIDERS`，两边由守卫双向比对。
        //    ⚠️ 原注释写「只有 zcode / gemini / trae 注册」，那是 Task 8 计划里的
        //    **样例**被留在了原地（2026-10-08 独立复审发现）；完整名单与缺项
        //    见 `probeById` 自己的头注释（别在这里再抄一份易腐的清单）。
        ...Object.hasOwn(probeById, id) ? { probe: probeById[id] } : {},
      })
      if (!registered) {
        ctx.logger?.info?.(
          `[jet-hub] provider runtime "${id}" 已注册（插件 fiber 重启竞态），跳过本次`,
        )
      }
    }
  }

  /**
   * OfficeAce 的 auth **不是 `Service` 子类**（它导出的是纯函数集合，没有实例
   * 状态需要挂到 cordis 服务上）。但仓库的统一 auth 契约（`JetHubAuthLike`）
   * 与多条守卫用例都按 **`ctx.<provider>Auth` 服务名**取实例 —— 故这里显式
   * 把命名空间包成一个服务形状的对象。
   *
   * ⚠️ **必须包一层普通对象，不能直接挂模块命名空间**：ES 模块的命名空间对象
   * 只有 getter，守卫用例会把 `refreshAccountCredential` 换成 spy（`vi.fn()`）
   * ⇒ 直接挂会抛 `Cannot set property … which has only a getter`。
   *
   * ⚠️⚠️ **同一个对象必须同时用于 `ctx.provide` 与 `registerJetHubRpc` 的
   * `auths.officeace`**：守卫用例的判据是「布桩在 `ctx.officeaceAuth` 上，
   * 然后断言 `account.refresh` 打到**同一个**实例」。两处各建一个包装对象
   * 会让 spy 永远收不到调用（实测症状：`expected [] to deeply equal
   * ['officeaceAuth']`）。
   *
   * ⚠️ 不注册的话症状是「OfficeAce 的凭据永不自动续期」且日志里一个字都没有
   *（`provider-runtime-wiring.spec.ts` 真跑 apply 会红）。
   */

  registerJetHubRpc(ctx, pool, {
    codearts: service,
    buddy, workbuddy, lobsterai, qoder,
    qodercn: qoderCn,
    trae, cline, loomy, raccoon, minimax,
    // ⚠️ 键是 **provider id** `minimaxintl`，值是变量 `minimaxIntl`
    //（两者大小写不同：id 全小写、变量名带驼峰）—— 写成简写 `minimaxintl,`
    // 会去引用一个不存在的变量。与上面 `qodercn: qoderCn` 同因。
    minimaxintl: minimaxIntl,
    zcode, gemini,
    // OfficeAce（华为 ModelArts MaaS 云端直连）：值是 **auth 服务形状的包装对象**
    //（纯函数集合 + 统一 auth 契约），不是 Service 实例。
    officeace: officeaceAuthService as never,
    autoclaw,
    // ⚠️ 键是 **provider id** `autoclawintl`，值是变量 `autoclawIntl` ——
    //    两者不同名（id 全小写、变量带驼峰），写成简写会引用不存在的变量。
    //    ⚠️ 值必须是**国际版实例**：写成 `autoclaw` 会让国际站账号的续期
    //    去刷国内站凭据（与 minimaxintl 的同类风险完全一致）。
    autoclawintl: autoclawIntl,
    accio,
    astudio,
    // ⚠️ **本 fork 独有**（modelscope，2026-10-16）。漏加 = 客户端把它当
    //    「客户端已登记但宿主没有同名键」⇒ zcode-wiring 的守卫会红，
    //    且 Jet Hub 的 modelscope 面板所有 RPC 全部 `unknown provider`。
    modelscope,
  }, modelAdapters)

  // 网关是旁路功能：这里传 `pool` 只为读设置页里的开关，其内部任何失败都已
  // 自行降级为日志，绝不会让插件 apply() 失败。
  mountOpenAiGateway(ctx, pool)
  // 思考死循环被中止后的**自动续跑**：把此前必须由用户手打「继续」的那一步
  // 自动化（真实报障 2026-10-04，见 `loop-recovery.ts` 模块头）。
  // ⚠️ 它依赖 `agents` 服务，故内部用 `ctx.inject(['agents'], …)` 挂载：
  // 该服务缺席的 profile 里本功能整体不生效，不会让插件永久 pending。
  installLoopResume(ctx)
  // 官方 `web_search` 在**支持原生搜索的渠道**下改走渠道自带后端
  //（其余渠道 `next()` 放行，官方链路逐字节不变）。
  //
  // | 渠道 | 原生后端 |
  // |---|---|
  // | buddy / workbuddy | 腾讯 `/agenttool/v1/search`（Bearer） |
  // | qoder / qodercn | Qoder `/api/v1/webSearch/oneSearch`（WASM 签名） |
  //
  // ⚠️ 传**聊天链路用的那些适配器实例**：搜索与聊天因此共用同一个
  // `resolveCredential`（enabled / 模型级限流 / 免费判定 / 余额分档 / 池兜底
  // 六步完全一致，见 `web-native.ts` 模块头）。
  // ⚠️ **不接管 `web_fetch`**：官方 fetch 走 `http` 提供方、不发送凭据、零配置，
  // 接管它是净损失（2026-10-14 实测，理由见 `web-native.ts` 模块头）。
  // ⚠️ 总开关传**函数**而不是布尔值：用户在 Jet Hub 面板里切换后必须立即生效，
  // 不能被启动时的快照钉死。
  installWebNative(
    ctx,
    {
      buddy: buddyAdapter,
      workbuddy: workbuddyAdapter,
      qoder: qoderAdapter,
      qodercn: qoderCnAdapter,
    },
    () => pool.nativeWebSearchEnabled(),
  )
  ctx.provide('accountPool', pool)
  // ⚠️ 与 `registerJetHubRpc` 的 `auths.officeace` 是**同一个对象**
  //（理由见上面 `officeaceAuthService` 的注释：两处各建一个会让守卫用例的
  //  spy 收不到调用）。
  ctx.provide('officeaceAuth', officeaceAuthService as never)
  // ⚠️ **本 fork 独有**（modelscope）：`ModelscopeAuth extends Service`，
  //    构造时已由 cordis 自动注册为 `ctx.modelscopeAuth`（`super(ctx, `${product.id}Auth`)`），
  //    故这里**不需要**再 provide —— 与 accio 同款（它也没有 provide 行）。
}


