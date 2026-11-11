/**
 * 「一键同步模型到 pi / ZCode」的**服务层**：目录采集 → 计划 → 落盘。
 *
 * ## 分层（为什么拆三个文件）
 *
 * | 文件 | 职责 | 是否碰磁盘 |
 * |---|---|---|
 * | `sync-targets.ts` | 纯计划：算新配置 + diff | 否 |
 * | `sync-apply.ts` | 备份 / 写入 / 复读校验 / 回滚 | 是 |
 * | 本文件 | 组装：取网关目录、逐目标兜错、编排 preview 与 apply | 是（经由上面两层） |
 *
 * ## 两条硬约定（沿用网关目录的既有口径）
 *
 * 1. **逐目标兜错**：一个目标解析失败（文件不存在、格式不认识）不能让另一个目标
 *    也报错——用户需要看到的正是「哪个目标有问题、为什么」。
 * 2. **不搬运密钥**：本模块只刷新模型列表与能力规则，`apiKey` 由 `plan*` 原样保留。
 *
 * @module src/sync-service.ts
 */

import { DEFAULT_GATEWAY_HOST, DEFAULT_GATEWAY_PORT, resolveGatewayConfig } from './openai-gateway/config.js'
import { collectGatewayModelDetails, collectGatewayModels, applyGatewayContextWindows, type GatewayModelSource } from './openai-gateway/models.js'
import { SyncApplyError, applyJsonPlan, readJsonConfig, resolveSyncPaths, type SyncPaths } from './sync-apply.js'
import {
  isDiffEmpty,
  planPiSync,
  planZcodeSync,
  existingPiModelIds,
  existingZcodeModelIds,
  providerOfModelId,
  splitUsableModels,
  type SyncDiff,
  type SyncModel,
  type SyncPlanOptions,
  type SyncTargetId,
} from './sync-targets.js'

/** 供本模块使用的最小 llm 形态（与网关目录采集接口同源，便于单测替身）。 */
export type SyncModelSource = GatewayModelSource

/**
 * 外部工具实际要填的本机网关地址。
 *
 * ⚠️ 用 `127.0.0.1` 而**不是**网关的监听地址：开了「允许局域网访问」时监听地址是
 * `0.0.0.0`，但外部工具在本机连接必须写回环地址。端口仍跟随解析结果，
 * 避免用户改过端口后同步到旧端口。
 */
export function localGatewayBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  let port = DEFAULT_GATEWAY_PORT
  try {
    port = resolveGatewayConfig(env).port
  } catch {
    // 端口配置非法时回退默认值：网关此时本来就起不来，同步没必要跟着炸
    port = DEFAULT_GATEWAY_PORT
  }
  return `http://${DEFAULT_GATEWAY_HOST}:${port}/v1`
}

/**
 * 采集网关当前对外暴露的模型目录，归一成 {@link SyncModel}。
 *
 * id 采用 `<provider>/<model>` 形式：与 `/v1/models` 输出、以及 pi / ZCode 里
 * 现有条目的写法**逐字一致**（否则同步会造出一份对不上的新列表）。
 */
export async function collectSyncModels(llm: SyncModelSource): Promise<SyncModel[]> {
  return (await collectSyncCatalog(llm)).models
}

/** 目录采集结果：模型 + 本次**读失败**的渠道。 */
export interface SyncCatalog {
  models: SyncModel[]
  /**
   * 本次 `listModels` 抛错的 provider。
   *
   * ⚠️ 必须一路透传到计划层：这些渠道的模型会从目录里消失，若照常判「已删除」，
   * **一次 token 过期就会把用户另外两个工具的该渠道模型全删掉**。
   */
  failedProviders: string[]
}

/**
 * 采集网关目录并记录失败渠道。
 *
 * `collectGatewayModels` 的 `onError` 是唯一的失败信号（它自己承诺永不抛错），
 * 在这里整流成 {@link SyncCatalog}。
 */
export async function collectSyncCatalog(llm: SyncModelSource): Promise<SyncCatalog> {
  const failedProviders: string[] = []
  const groups = await collectGatewayModels(llm, provider => {
    if (!failedProviders.includes(provider)) failedProviders.push(provider)
  })

  /**
   * ⚠️⚠️ **必须补全 contextWindow**（2026-11-11 真实报障）。
   *
   * `llm.listModels()` 只保证返回 `{ id, name }` —— `contextWindow` 不在其中。
   * 网关的 `/v1/models` 之所以能给出 `context_window`，是因为它额外走了
   * `collectGatewayModelDetails()`（逐个 `resolveModelInfo`）+ `applyGatewayContextWindows()`。
   *
   * 初版直接拿 `listModels` 的裸结果，于是 361 个模型**全部缺 contextWindow**
   * ⇒ 全被判为「不可写」⇒ 用户看到「已勾选 19/19」却「本次同步 0 个模型」。
   * 这里复用与网关**完全相同**的那条补全路径，两边才不会漂。
   *
   * 能力值解析失败**不算渠道失败**（渠道本身是好的，只是某几个模型拿不到窗口）：
   * 故用独立回调收集，不影响 `failedProviders` 的保护语义。
   */
  const { contextWindows } = await collectGatewayModelDetails(llm, groups)
  const enriched = applyGatewayContextWindows(groups, contextWindows)

  const models: SyncModel[] = []
  for (const group of enriched) {
    for (const model of group.models) {
      models.push({
        id: `${group.provider}/${model.id}`,
        name: model.name,
        // 仍缺 contextWindow 的填 0：`sync-targets` 会把它计入 skipped 并拒写，
        // 宁可少同步一个模型，也不要往别人的配置里写一个猜出来的上限。
        contextWindow: typeof model.contextWindow === 'number' ? model.contextWindow : 0,
        // ⚠️ maxTokens 缺失要传 `undefined`（不是 0）：0 会被下游当成「已知非法值」，
        // 而 `undefined` 的语义是「不知道」—— 后者会保留目标里已有的值。
        // （`resolveModelInfo` 只给 contextWindow，不给 maxTokens，故这里普遍为 undefined。）
        maxTokens: typeof model.maxTokens === 'number' ? model.maxTokens : undefined,
        // 与 `toGatewayModelIds` 同口径：不声明即按 text 保守处理
        input: Array.isArray(model.inputModalities) && model.inputModalities.length > 0 ? [...model.inputModalities] : ['text'],
      })
    }
  }
  return { models, failedProviders }
}

/** 单个目标的预览结果。 */
export interface SyncTargetPreview {
  target: SyncTargetId
  path: string
  /** 目标是否可用（文件存在且结构认得）。 */
  ok: boolean
  /** `ok: false` 时的原因（直接展示给用户）。 */
  error?: string
  diff?: SyncDiff
}

/** 网关侧一个渠道的概况（UI 用它渲染「同步哪些渠道」的勾选列表）。 */
export interface SyncProviderInfo {
  id: string
  /** 该渠道在网关目录里的模型数。 */
  modelCount: number
  /** 该渠道的模型是否已出现在各目标里（决定默认勾选状态）。 */
  inTargets: Record<SyncTargetId, boolean>
}

/** 预览结果（UI 据此渲染「将新增/移除/更新哪些模型」）。 */
export interface SyncPreviewResult {
  gatewayBaseUrl: string
  /** 本次参与同步的模型数（已按 `providers` 过滤）。 */
  modelCount: number
  /**
   * 其中**真正可写入**的模型数（contextWindow 齐全）。
   *
   * ⚠️ 与 `modelCount` 分开暴露是刻意的：两者不等时，说明目录里有一批模型
   * 因能力值缺失被跳过，而不是「没勾选渠道」—— 两者用一个数字表达，用户对着
   * 「已选 19/19、本次同步 0 个」完全无从判断到底哪里出了问题。
   */
  usableModelCount: number
  /** 网关目录里的模型总数（未过滤，用于告诉用户「你只选了 30 / 369」）。 */
  totalModelCount: number
  /** 本次请求实际收到的渠道白名单（未提供时为 `undefined`）。用于自证「勾了却匹配不到」。 */
  requestedProviders?: readonly string[]
  /** 网关侧全部渠道（**不受** `providers` 过滤，供 UI 勾选）。 */
  providers: SyncProviderInfo[]
  /** 本次采集失败的渠道（UI 必须显示：它们的模型是被保留而非"确认仍存在"）。 */
  failedProviders: string[]
  targets: SyncTargetPreview[]
}

/** 同步选项（单测用 home / env 覆盖，生产走默认）。 */
export interface SyncOptions {
  paths?: SyncPaths
  home?: string
  env?: NodeJS.ProcessEnv
  /**
   * 只同步这些渠道（provider id）。缺省 = 目录里的全部渠道。
   *
   * ⚠️ 空数组表示「一个都没选」，与缺省**语义不同**：空数组会被当成
   * 「没有可写入的模型」而拒绝同步（否则等于把目标清空）。
   */
  providers?: readonly string[]
  /**
   * 只处理这些目标 agent。缺省 = 全部（pi 与 ZCode 都写）。
   *
   * ⚠️ 空数组与缺省**语义不同**：空数组 = 一个目标都没选，会被拒绝
   *（否则按钮看起来「成功」但什么都没发生）。
   */
  targets?: readonly SyncTargetId[]
}

/**
 * 按用户勾选的渠道过滤目录。
 *
 * @returns 过滤后的模型；`providers` 缺省时原样返回
 */
function filterByProviders(models: readonly SyncModel[], providers: readonly string[] | undefined): SyncModel[] {
  if (providers === undefined) return [...models]
  const wanted = new Set(providers)
  return models.filter(model => wanted.has(providerOfModelId(model.id)))
}

/**
 * 算出「本次**不得动**的渠道」集合。
 *
 * ## 两类渠道必须保护，理由相同
 *
 * 1. **采集失败的渠道**：目录里消失是「没读到」，不是「下架了」；
 * 2. **用户没勾选的渠道**：目录里没有它，是「我不让它参与」，
 *    不是「它该被删」—— 只勾 codearts 却把 minimax 的模型删掉，是绝对不能接受的。
 *
 * 两者对计划层是同一件事：这些渠道的模型保留目标现状（不增不删）。
 */
function protectedProviderIds(
  catalog: SyncCatalog,
  providers: readonly string[] | undefined,
  existingModelIds: readonly string[] = [],
): string[] {
  const all = new Set(catalog.models.map(model => providerOfModelId(model.id)))
  const protectedSet = new Set(catalog.failedProviders)
  if (providers !== undefined) {
    const selected = new Set(providers)
    for (const provider of all) {
      if (!selected.has(provider)) protectedSet.add(provider)
    }
  }
  // 3) **目标里有、网关目录里完全没有的渠道**：一律保留。
  //    两种成因无法区分，而误删的代价高得多：
  //    ① 用户手工在目标里加的模型（例如 `my-lora/qwen`）；
  //    ② 该渠道被从 hub 里移除 / 整条目录读不到。
  //    注意这与「清理已下架的模型」不冲突：下架模型的**渠道仍在目录里**，
  //    走的还是精确同步；只有整条渠道缺席才进保护。
  for (const modelId of existingModelIds) {
    const provider = providerOfModelId(modelId)
    if (provider && !all.has(provider)) protectedSet.add(provider)
  }
  return [...protectedSet]
}

/** 统计网关目录里的渠道概况（含「是否已在目标里」）。 */
function summarizeProviders(
  models: readonly SyncModel[],
  existing: Record<SyncTargetId, readonly string[]>,
): SyncProviderInfo[] {
  const counts = new Map<string, number>()
  for (const model of models) {
    const provider = providerOfModelId(model.id)
    if (!provider) continue
    counts.set(provider, (counts.get(provider) ?? 0) + 1)
  }
  const existingSets: Record<SyncTargetId, Set<string>> = {
    pi: new Set(existing.pi),
    zcode: new Set(existing.zcode),
  }
  return [...counts.entries()]
    .map(([id, modelCount]) => ({
      id,
      modelCount,
      inTargets: {
        pi: [...existingSets.pi].some(modelId => providerOfModelId(modelId) === id),
        zcode: [...existingSets.zcode].some(modelId => providerOfModelId(modelId) === id),
      },
    }))
    .sort((a, b) => b.modelCount - a.modelCount || a.id.localeCompare(b.id))
}

/**
 * 算出「可写目录为空」的**具体原因**。
 *
 * ⚠️⚠️ 三种原因必须分开说，否则用户看到的是同一句无用的话：
 * 1. 所有渠道都没返回模型（未登录/目录拉取失败）；
 * 2. 一个渠道都没勾选（用户的选择）；
 * 3. **勾了渠道但目录里匹配不到**（前端传的 id 与目录不一致 —— 这是接线 bug，
 *    不是用户操作问题，必须把收到的 id 回显出来才查得动）；
 * 4. 匹配到了模型但都缺 contextWindow（写进去目标也用不了）。
 */
function emptyCatalogReason(
  catalog: SyncCatalog,
  requested: readonly string[] | undefined,
  models: readonly SyncModel[],
): string {
  if (catalog.models.length === 0) {
    return '网关没有返回任何模型（检查各渠道是否已登录），已拒绝同步'
  }
  if (requested === undefined) {
    return '网关目录里的模型都缺 contextWindow，写进目标也不可用，已拒绝同步'
  }
  if (requested.length === 0) return NO_PROVIDER_SELECTED
  if (models.length === 0) {
    const shown = requested.slice(0, 6).join('、')
    const more = requested.length > 6 ? ' 等' : ''
    return `勾选的 ${requested.length} 个渠道在网关目录里一个都不存在（收到：${shown}${more}），已拒绝同步`
  }
  return `勾选的渠道里没有可写入的模型（${models.length} 个都缺 contextWindow），已拒绝同步`
}

/** 目标清单：新增目标只改这一处。 */
const TARGETS: readonly SyncTargetId[] = ['pi', 'zcode']

/**
 * 可写目录为空时的统一拒绝文案。
 *
 * ⚠️⚠️ **这条不是防御性装饰**：可写目录为空时若照常跑计划，「目标里现有的每个模型」
 * 都会被算成 `removed` ⇒ 同步会把用户另外两个工具的模型列表**清空**。
 *
 * 判据必须是「**可写**模型数为 0」而不是「目录条数为 0」：网关目录里**有**模型
 * 但能力值全都非法（缺 contextWindow / maxTokens）时，目录非空却同样会算出空列表。
 * 而目录为空的真实成因也很平常（网关停用、`ctx.llm` 未注册、某次升级后
 * `listProviders` 缺失）—— 绝不能让它变成一次静默的数据销毁。
 */
const EMPTY_CATALOG = '网关没有可写入的模型（目录为空或缺 contextWindow），已拒绝同步（否则会把目标配置里的模型全部判为已删除）'

/** 用户一个渠道都没勾选时的文案（与「目录为空」区分开：这是用户的选择，不是故障）。 */
const NO_PROVIDER_SELECTED = '没有勾选任何渠道，已拒绝同步（清空列表会把目标配置里的模型全部删掉）'

/** 目标对应的配置文件路径（与模型目录无关，故单独拆出便于空目录时也能报路径）。 */
function targetPath(target: SyncTargetId, paths: SyncPaths): string {
  return target === 'pi' ? paths.piModels : paths.zcodeProviderConfig
}

/** 按目标取该目标的配置文件路径与计划函数。 */
function targetOps(target: SyncTargetId, paths: SyncPaths, models: readonly SyncModel[], gatewayBaseUrl: string) {
  if (target === 'pi') {
    return {
      path: paths.piModels,
      plan: (config: any, options: SyncPlanOptions = {}) => planPiSync(config, models, gatewayBaseUrl, options),
    }
  }
  return {
    path: paths.zcodeProviderConfig,
    plan: (config: any, options: SyncPlanOptions = {}) => planZcodeSync(config, models, gatewayBaseUrl, options),
  }
}

/**
 * 计算预览：读取两个目标的当前配置，算出各自的 diff。
 *
 * **不写任何文件**。每个目标独立兜错：某个文件缺失只标记该目标 `ok:false`。
 */
export async function previewSync(llm: SyncModelSource, options: SyncOptions = {}): Promise<SyncPreviewResult> {
  const paths = options.paths ?? resolveSyncPaths(options.home, options.env)
  const gatewayBaseUrl = localGatewayBaseUrl(options.env)
  const catalog = await collectSyncCatalog(llm)

  // 先读两个目标的现状：既用于「哪些渠道已在目标里」的展示，也避免下面各算一遍。
  // 读失败是**正常状态**（用户可能还没加过网关 provider），只记 null。
  const loaded: Record<SyncTargetId, { config: any | null; error?: string }> = {
    pi: { config: null },
    zcode: { config: null },
  }
  for (const target of TARGETS) {
    try {
      loaded[target] = { config: readJsonConfig(targetPath(target, paths)) }
    } catch (error) {
      loaded[target] = { config: null, error: (error as Error).message }
    }
  }

  const existing: Record<SyncTargetId, string[]> = {
    pi: loaded.pi.config ? existingPiModelIds(loaded.pi.config, gatewayBaseUrl) : [],
    zcode: loaded.zcode.config ? existingZcodeModelIds(loaded.zcode.config, gatewayBaseUrl) : [],
  }
  const providers = summarizeProviders(catalog.models, existing)

  const models = filterByProviders(catalog.models, options.providers)

  // 可写目录为空一律标记为不可同步：只算 diff 的话每个目标都会显示「将移除全部模型」
  if (splitUsableModels(models).ok.length === 0) {
    const reason = emptyCatalogReason(catalog, options.providers, models)
    return {
      gatewayBaseUrl,
      modelCount: models.length,
      usableModelCount: 0,
      totalModelCount: catalog.models.length,
      providers,
      requestedProviders: options.providers,
      failedProviders: catalog.failedProviders,
      targets: TARGETS.map(target => ({ target, path: targetPath(target, paths), ok: false, error: reason })),
    }
  }

  const targets: SyncTargetPreview[] = []
  for (const target of TARGETS) {
    const ops = targetOps(target, paths, models, gatewayBaseUrl)
    const state = loaded[target]
    if (state.config === null) {
      targets.push({ target, path: ops.path, ok: false, error: state.error ?? '配置文件不可读' })
      continue
    }
    try {
      // ⚠️ 保护集是**per-target** 的：两个目标各自可能有「网关里没有的手工渠道」
      const { diff } = ops.plan(state.config, {
        failedProviders: protectedProviderIds(catalog, options.providers, existing[target]),
      })
      targets.push({ target, path: ops.path, ok: true, diff })
    } catch (error) {
      targets.push({ target, path: ops.path, ok: false, error: (error as Error).message })
    }
  }
  return {
    gatewayBaseUrl,
    modelCount: models.length,
    usableModelCount: splitUsableModels(models).ok.length,
    totalModelCount: catalog.models.length,
    providers,
    requestedProviders: options.providers,
    failedProviders: catalog.failedProviders,
    targets,
  }
}

/** 单个目标的落盘结果。 */
export interface SyncApplyEntry {
  target: SyncTargetId
  path: string
  /** 备份目录（回滚用，UI 必须显示给用户）。 */
  backupDir: string
  diff: SyncDiff
}

/** 落盘结果。 */
export interface SyncApplyResult {
  gatewayBaseUrl: string
  modelCount: number
  applied: SyncApplyEntry[]
  /** 未落盘的目标及原因（无变更 / 预览失败）。这些不是错误，但要说清楚。 */
  skipped: { target: SyncTargetId; path: string; reason: string }[]
}

/**
 * 执行同步：逐目标重新读盘 → 重新算计划 → 备份 → 写入 → 复读校验。
 *
 * ⚠️ **不复用 preview 的结果**：preview 与 apply 之间用户可能手改过配置文件，
 * 用旧计划落盘会覆盖掉那次手改。这里重新读、重新算。
 *
 * ⚠️ diff 为空的目标**不写文件**：否则每次点按钮都会产生一份无意义的备份目录。
 *
 * @param validate 注入点：生产用缺省幂等校验；单测可注入必失败函数验证回滚。
 */
export async function applySync(
  llm: SyncModelSource,
  options: SyncOptions & { validate?: (target: SyncTargetId, path: string) => void | Promise<void> } = {},
): Promise<SyncApplyResult> {
  const paths = options.paths ?? resolveSyncPaths(options.home, options.env)
  const gatewayBaseUrl = localGatewayBaseUrl(options.env)
  const catalog = await collectSyncCatalog(llm)
  const models = filterByProviders(catalog.models, options.providers)
  // 可写目录为空直接失败：见 EMPTY_CATALOG 的注释，这里宁可报错也不能写空列表
  if (splitUsableModels(models).ok.length === 0) {
    throw new SyncApplyError(emptyCatalogReason(catalog, options.providers, models))
  }

  const applied: SyncApplyEntry[] = []
  const skipped: SyncApplyResult['skipped'] = []

  /**
   * 本次真正要写的目标。
   *
   * ⚠️ 未选中的目标不是「失败」，但必须在 `skipped` 里说一句 —— 否则用户只看到
   * 「只写了 pi」，无法区分「我取消勾选了」与「ZCode 写失败了」。
   */
  const activeTargets = options.targets === undefined
    ? [...TARGETS]
    : TARGETS.filter(target => options.targets!.includes(target))
  if (activeTargets.length === 0) {
    throw new SyncApplyError('没有选择任何要同步的 agent，已拒绝同步')
  }
  for (const target of TARGETS) {
    if (activeTargets.includes(target)) continue
    skipped.push({ target, path: targetPath(target, paths), reason: '未选中，跳过' })
  }

  for (const target of activeTargets) {
    const ops = targetOps(target, paths, models, gatewayBaseUrl)
    let config: any
    try {
      config = readJsonConfig(ops.path)
    } catch (error) {
      skipped.push({ target, path: ops.path, reason: (error as Error).message })
      continue
    }

    // 保护集按该目标的现状算：它可能有网关目录里根本没有的手工渠道
    const existingIds = target === 'pi'
      ? existingPiModelIds(config, gatewayBaseUrl)
      : existingZcodeModelIds(config, gatewayBaseUrl)
    const protectedProviders = protectedProviderIds(catalog, options.providers, existingIds)
    const { config: next, diff } = ops.plan(config, { failedProviders: protectedProviders })
    if (isDiffEmpty(diff)) {
      skipped.push({ target, path: ops.path, reason: '已是目标状态，无需写入' })
      continue
    }

    // 缺省校验：写入后按同一份目录重算一次，diff 必须变空（幂等）。
    // 这能抓住「字段写进错层级」「规则没落到位」这类只 parse 一次发现不了的问题。
    const validate = async (written: string) => {
      const again = readJsonConfig(written)
      const recheck = ops.plan(again, { failedProviders: protectedProviders })
      if (!isDiffEmpty(recheck.diff)) {
        throw new Error(`${target} 写入后复算仍有差异（added=${recheck.diff.added.length} removed=${recheck.diff.removed.length} updated=${recheck.diff.updated.length}）`)
      }
      if (options.validate) await options.validate(target, written)
    }

    const { backupDir } = await applyJsonPlan(ops.path, next, validate)
    applied.push({ target, path: ops.path, backupDir, diff })
  }

  return { gatewayBaseUrl, modelCount: models.length, applied, skipped }
}
