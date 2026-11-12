/**
 * 「同步模型到外部工具」的 RPC 方法处理函数（**不是自注册端点**）。
 *
 * ## ⚠️ 为什么是被主 switch 调用，而不是自己 `rpc.register`
 *
 * 与 `opencode-rpc.ts` 完全同因（见那里的模块头与 2026-10-02 真实事故）：
 * Jet Hub 只有一条 RPC 通道，`jet-hub-rpc.ts` 的 `handleMethod` 用穷举 `switch`
 * 分发，`default` 直接回 `unknown method` 且**不让路**。自己注册的路径从来收不到请求。
 *
 * ⇒ 本文件只导出 {@link handleSyncRpc}，由 `handleMethod` 在 `switch` **之前**按
 * `sync.` 前缀调用；对不认识的方法返回 `undefined` 让主 switch 继续匹配。
 *
 * ## 返回约定
 *
 * 与 `opencode-rpc.ts` 一致：成功 `{ ok: true, value }`，失败 `{ ok: false, error }`。
 * 失败**一律不抛**：同步涉及"写别人的配置文件"，把异常留给上层会丢掉具体原因
 * （哪个目标、为什么），而用户需要的正是这句话。
 *
 * @module src/sync-rpc.ts
 */

import type { Context } from '@deepseek-ai/cordis'
import { applySync, previewSync, type SyncModelSource, type SyncOptions } from './sync-service.js'
import type { SyncTargetId } from './sync-targets.js'

/**
 * 从 payload 里读渠道白名单。
 *
 * 三态语义（**缺省与空数组不同**，见 `SyncOptions.providers`）：
 * - 字段不存在 → `undefined`（全部渠道）
 * - `[]` → 一个都没选（计划层会拒绝，避免清空目标）
 * - 非字符串数组 → 报错，不猜
 */
function readProviders(payload: unknown): { ok: true; value?: readonly string[] } | { ok: false; message: string } {
  if (payload === null || typeof payload !== 'object') return { ok: true }
  const raw = (payload as { providers?: unknown }).providers
  if (raw === undefined) return { ok: true }
  if (!Array.isArray(raw) || raw.some(item => typeof item !== 'string')) {
    return { ok: false, message: 'providers 必须是字符串数组' }
  }
  return { ok: true, value: raw as string[] }
}

/** 合法的目标 agent 取值。新增目标时必须同步这里。 */
const SYNC_TARGET_IDS: readonly string[] = ['pi', 'zcode']

/**
 * 从 payload 里读目标 agent 白名单。
 *
 * 三态语义与 {@link readProviders} 一致：字段不存在 = 全部；`[]` = 一个都没选
 *（计划层会拒绝）；非字符串数组或含未知目标名 ⇒ 报错而不猜。
 *
 * ⚠️ 未知目标名必须报错：默写拼错时静默当成「全部」会把用户不想动的 agent 写掉。
 */
function readTargets(payload: unknown): { ok: true; value?: readonly string[] } | { ok: false; message: string } {
  if (payload === null || typeof payload !== 'object') return { ok: true }
  const raw = (payload as { targets?: unknown }).targets
  if (raw === undefined) return { ok: true }
  if (!Array.isArray(raw) || raw.some(item => typeof item !== 'string')) {
    return { ok: false, message: 'targets 必须是字符串数组' }
  }
  const unknown = raw.filter(item => !SYNC_TARGET_IDS.includes(item as string))
  if (unknown.length > 0) {
    return { ok: false, message: `不认识的 target：${unknown.join('、')}（可选：${SYNC_TARGET_IDS.join('、')}）` }
  }
  return { ok: true, value: raw as string[] }
}

/**
 * 从 payload 里读「强制重新采集目录」标志。
 *
 * ⚠️ **只有 `sync.preview` 认它**（UI 的「刷新」按钮）。`sync.apply` 必须命中
 * 同一份 30 秒缓存，否则「预览看到的目录」与「落盘用的目录」不是同一个快照
 * ⇒ `failedProviders` 一变，保护集就漂移（旧缺陷：预览说保留、落盘却删除）。
 *
 * 非 `true` 一律当 `false`：这是「要不要多打一次上游」的开关，
 * 拼错的取值静默当成「不刷新」比当成「刷新」安全。
 */
function readForce(payload: unknown): boolean {
  if (payload === null || typeof payload !== 'object') return false
  return (payload as { force?: unknown }).force === true
}

/**
 * 可注入的同步选项。
 *
 * 生产调用（`jet-hub-rpc.ts` 的前缀改道）**不传**，走 `resolveSyncPaths()` 的默认路径；
 * 单测传 `{ home }` 把两个目标指到临时目录 —— 否则用例会读写用户真实的
 * `~/.pi` 与 `~/.zcode`。这层注入是刻意的：隐藏的全局 home 依赖会让
 * 「测试通过但删了用户配置」这种事变得可能。
 */
export type SyncRpcOptions = SyncOptions

/**
 * 取 `ctx.llm`。
 *
 * ⚠️ 与 `jet-hub-rpc.ts` 的 `llmServiceOf` 同口径：**优先属性访问**，`ctx.get` 只作回退。
 * 在 connection 上下文里后者可能拿不到 `listProviders`，表现为「目录恒为空」
 * （正是网关面板踩过的坑）。
 */
function llmOf(ctx: Context): SyncModelSource | undefined {
  const direct = (ctx as unknown as { llm?: SyncModelSource }).llm
  if (direct !== undefined && direct !== null) return direct
  // `ctx.get` 不一定存在（精简 ctx、connection 上下文的某些形态）⇒ 先判函数再调
  const getter = (ctx as unknown as { get?: (name: string) => unknown }).get
  if (typeof getter !== 'function') return undefined
  return getter.call(ctx, 'llm') as SyncModelSource | undefined
}

/**
 * 处理 `sync.*` 方法。
 *
 * @returns 处理结果；**方法不属于本前缀时返回 `undefined`**（交给主 switch）
 */
export async function handleSyncRpc(
  ctx: Context,
  method: string,
  payload: unknown,
  options: SyncRpcOptions = {},
): Promise<unknown> {
  const fail = (message: string, code = 'bad-request') => ({ ok: false as const, error: { code, message } })
  const done = <T>(value: T) => ({ ok: true as const, value })
  try {
    switch (method) {
      case 'sync.preview':
      case 'sync.apply': {
        const llm = llmOf(ctx)
        if (!llm) return fail('llm 服务不可用，读不到网关模型目录', 'unavailable')
        const parsed = readProviders(payload)
        if (!parsed.ok) return fail(parsed.message)
        const parsedTargets = readTargets(payload)
        if (!parsedTargets.ok) return fail(parsedTargets.message)
        // 渠道白名单与目标白名单来自本次请求；路径等注入项仍走 options（测试用）
        //
        // ⚠️ `force` 只对 preview 生效（见 readForce 的注释）：apply 必须复用
        // 同一份目录快照，否则保护集会漂移。
        const force = options.force === true || (method === 'sync.preview' && readForce(payload))
        const merged: SyncOptions = { ...options, providers: parsed.value, targets: parsedTargets.value as SyncTargetId[] | undefined, force }
        /**
         * 打印收到的白名单。
         *
         * ⚠️ 真实排障时「前端显示已选 19/19，后端却报没勾选」这种情况，
         * 光看两边代码无法收敛 —— 必须有一条「服务端到底收到了什么」的记录。
         * 只打数量与前几个 id，避免刷屏（不涉密钥）。
         */
        const received = parsed.value === undefined ? '全部（未指定）' : `${parsed.value.length} 个: ${parsed.value.slice(0, 6).join(', ')}${parsed.value.length > 6 ? ' ...' : ''}`
        ctx.logger?.info?.(`[jet-hub] ${method} 收到渠道白名单 = ${received}`)
        return done(method === 'sync.preview' ? await previewSync(llm, merged) : await applySync(llm, merged))
      }
      default:
        return undefined
    }
  } catch (error) {
    return fail((error as Error)?.message ?? String(error), 'sync-failed')
  }
}
