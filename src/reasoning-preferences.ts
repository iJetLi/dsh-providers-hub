/**
 * 「默认思考档」的用户偏好（**独立文档**，跨重启保持）。
 *
 * ## 存的是什么
 *
 * 2026-11-11 的用户功能：在模型选择器里选完模型后，思考强度自动落在该模型
 * 支持的最高档（`max` / `extra_high` …），而不是各家适配器写死的 `high`。
 * 实现见 `src/reasoning-default.ts`（模块头有完整证据链）。
 *
 * 本文件只存**一个布尔**：开 = 取最强档（默认），关 = 逐字节回到改动前的行为。
 *
 * ## 为什么拆成独立文档，而不是塞进 state.json
 *
 * 与 `badge-preferences.ts` / `permanent-lock-store.ts` 同因：`state.json` 是
 * **dsh home 级、多 profile 共享**、且**整体替换**语义的文档。同机上另一条
 * 工作区里的旧版本代码不认识新字段，它做任何一次整体写入（加删账号、改模型
 * 开关）都会把新字段静默抹掉 —— 而「偏好被抹掉」的症状是**功能悄悄失效**，
 * 用户只会觉得「怎么又变回 high 了」，无法归因。
 *
 * 独立文档的读写者只有本文件，跨工作区天然互不干扰。
 *
 * ## 缺键语义：**开**
 *
 * 与 `sanitizeNativeWebSearchEnabled` 同一取向（`raw !== false`）：
 * 文档不存在 / 损坏 / 字段非法 / 被老版本代码重写时丢键 ⇒ 都回到**开**。
 *
 * ⚠️ 方向不能反。反过来（只认 `true`）会让**任何一次读取失败**都变成
 * 「功能被静默关掉」，而用户根本没有关过它。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { resolveJetHubHome } from './jet-hub-store.js'

/** 独立文档的文件名（与 `state.json` / `ui-preferences.json` 同目录）。 */
export const REASONING_PREFERENCES_FILE = 'reasoning-preferences.json'

/** 文档 schema 标记（与本仓库其它状态文档同惯例）。 */
const SCHEMA = 'dsh-codearts-auth/reasoning-preferences/v1'

/**
 * 归一化「默认取最强档」开关。
 *
 * 判据与 `sanitizeNativeWebSearchEnabled` **逐字同构**：**只有显式 `false` 才算关闭**，
 * 其余（缺键 / `true` / 字符串 / 对象 / 数组）一律按开启处理。
 *
 * ⚠️ 字符串 `'false'` **不算** `false`（与 `panelEntry` 那条同款）：那是脏数据，
 * 不是用户意图。
 *
 * @param raw - 文档里的原始值。
 * @returns 归一化后的开关值。
 */
export function sanitizeStrongestReasoningEnabled(raw: unknown): boolean {
  return raw !== false
}

/** 偏好文档后端的种类：文件（正常）或内存（无法定位 dsh home 时的显式降级）。 */
export type ReasoningPreferenceStoreKind = 'file' | 'memory'

/** 偏好文档的读写接口（同步读、异步写，与 `BadgePreferenceStore` 同款约定）。 */
export interface ReasoningPreferenceStore {
  readonly kind: ReasoningPreferenceStoreKind
  /** 载入偏好；文档不存在 / 损坏 / 字段非法时返回默认值（开）。 */
  load(): boolean
  /** 写入偏好（原子写）。 */
  save(enabled: boolean): Promise<void>
}

/** 仅内存后端：无法定位 dsh home 时的显式降级（与 `MemoryPreferenceStore` 同策）。 */
class MemoryReasoningStore implements ReasoningPreferenceStore {
  readonly kind = 'memory' as const
  private enabled = true

  load(): boolean {
    return this.enabled
  }

  async save(enabled: boolean): Promise<void> {
    this.enabled = enabled
  }
}

/** 文件后端：`$DSH_HOME/jet-hub/reasoning-preferences.json`（原子写：tmp + rename）。 */
class FileReasoningStore implements ReasoningPreferenceStore {
  readonly kind = 'file' as const

  constructor(
    private readonly path: string,
    private readonly logger: { warn(message: string): void } | undefined,
  ) {}

  load(): boolean {
    try {
      if (!existsSync(this.path)) return true
      const parsed = JSON.parse(readFileSync(this.path, 'utf-8')) as unknown
      return sanitizeStrongestReasoningEnabled(fieldOf(parsed))
    } catch (error) {
      // 损坏时回落默认值而不是抛错：这是展示/默认值偏好，读不到最多是
      // 「回到改动前的行为」，不该让整个 RPC 端点连坐失败。
      this.logger?.warn(
        `[jet-hub] 读取 ${this.path} 失败，默认思考档按「取最强」处理: ${String(error)}`,
      )
      return true
    }
  }

  async save(enabled: boolean): Promise<void> {
    mkdirSync(join(this.path, '..'), { recursive: true })
    const tmp = `${this.path}.tmp`
    writeFileSync(
      tmp,
      JSON.stringify({ schema: SCHEMA, strongestReasoningEnabled: enabled }, null, 2),
      'utf-8',
    )
    renameSync(tmp, this.path)
  }
}

/**
 * 取出文档里的开关字段，同时兼容**裸布尔**形态。
 *
 * 裸布尔（文件内容就是 `false`）不是本实现写出的形态，但状态文档可能被手工
 * 编辑过；认它比把它当非法值更贴近用户意图（后者会静默回到「开」，用户会
 * 以为「设置没保存」）。与 `badge-preferences.ts` 的 `preferenceFieldOf` 同因。
 */
function fieldOf(parsed: unknown): unknown {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return parsed
  return (parsed as Record<string, unknown>).strongestReasoningEnabled
}

/**
 * 创建偏好后端。
 *
 * home 的解析与账号池 / 徽标偏好 / 锁定表**同一个函数**（`resolveJetHubHome`），
 * 保证几份文档永远落在同一目录 —— 否则会出现「账号池在 A 处、偏好文档在 B 处」的分裂。
 */
export function createReasoningPreferenceStore(ctx: Context): ReasoningPreferenceStore {
  const home = resolveJetHubHome(ctx)
  if (home === undefined) {
    ctx.logger?.warn?.('[jet-hub] 无法定位 DSH home，默认思考档偏好仅存在于内存中')
    return new MemoryReasoningStore()
  }
  return new FileReasoningStore(join(home, 'jet-hub', REASONING_PREFERENCES_FILE), ctx.logger)
}
