/**
 * 「新建账号时自动打开浏览器授权页」的用户偏好（**独立文档**，跨重启保持）。
 *
 * ## 存的是什么
 *
 * 2026-11-23 的用户功能：Jet Hub 设置里一个开关，控制「+ 新建账号」时是否
 * **自动打开**授权页。
 *
 * - **开（默认）**：宿主 / 客户端照旧自动开窗（= 本功能上线前的行为）；
 * - **关**：不自动开窗，把授权链接**复制到剪贴板**并显示在账号面板里，
 *   由用户手动打开。
 *
 * 本文件只存**一个布尔**：开 = 自动打开（默认），关 = 复制链接。
 *
 * ## 为什么拆成独立文档，而不是塞进 state.json
 *
 * 与 `badge-preferences.ts` / `reasoning-preferences.ts` 同因：`state.json` 是
 * **dsh home 级、多 profile 共享**、且**整体替换**语义的文档。同机上另一条
 * 工作区里的旧版本代码不认识新字段，它做任何一次整体写入（加删账号、改模型
 * 开关）都会把新字段静默抹掉 —— 而「偏好被抹掉」的症状是**功能悄悄失效**，
 * 用户只会觉得「怎么又自动开窗了」，无法归因。
 *
 * 独立文档的读写者只有本文件，跨工作区天然互不干扰。
 *
 * ## 缺键语义：**开**
 *
 * 与 `sanitizeStrongestReasoningEnabled` / `sanitizeNativeWebSearchEnabled`
 * 同一取向（`raw !== false`）：文档不存在 / 损坏 / 字段非法 / 被老版本代码
 * 重写时丢键 ⇒ 都回到**开**。
 *
 * ⚠️ 方向不能反。反过来（只认 `true`）会让**任何一次读取失败**都变成
 * 「自动开窗被静默关掉」，而用户根本没有关过它 —— 那正是「新建账号不跳登录页」
 * 这类报障的形态。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { resolveJetHubHome } from './jet-hub-store.js'

/** 独立文档的文件名（与 `state.json` / `ui-preferences.json` 同目录）。 */
export const LOGIN_PREFERENCES_FILE = 'login-preferences.json'

/** 文档 schema 标记（与本仓库其它状态文档同惯例）。 */
const SCHEMA = 'dsh-codearts-auth/login-preferences/v1'

/**
 * 归一化「自动打开浏览器授权页」开关。
 *
 * 判据与 `sanitizeStrongestReasoningEnabled` **逐字同构**：**只有显式 `false`
 * 才算关闭**，其余（缺键 / `true` / 字符串 / 对象 / 数组）一律按开启处理。
 *
 * ⚠️ 字符串 `'false'` **不算** `false`（与 `panelEntry` 那条同款）：那是脏数据，
 * 不是用户意图。
 *
 * @param raw - 文档里的原始值。
 * @returns 归一化后的开关值。
 */
export function sanitizeAutoOpenBrowserEnabled(raw: unknown): boolean {
  return raw !== false
}

/** 偏好文档后端的种类：文件（正常）或内存（无法定位 dsh home 时的显式降级）。 */
export type LoginPreferenceStoreKind = 'file' | 'memory'

/** 偏好文档的读写接口（同步读、异步写，与 `ReasoningPreferenceStore` 同款约定）。 */
export interface LoginPreferenceStore {
  readonly kind: LoginPreferenceStoreKind
  /** 载入偏好；文档不存在 / 损坏 / 字段非法时返回默认值（开）。 */
  load(): boolean
  /** 写入偏好（原子写）。 */
  save(enabled: boolean): Promise<void>
}

/** 仅内存后端：无法定位 dsh home 时的显式降级（与 `MemoryReasoningStore` 同策）。 */
class MemoryLoginPreferenceStore implements LoginPreferenceStore {
  readonly kind = 'memory' as const
  private enabled = true

  load(): boolean {
    return this.enabled
  }

  async save(enabled: boolean): Promise<void> {
    this.enabled = enabled
  }
}

/**
 * 进程内的已解析值（按文档路径索引）。
 *
 * ## 为什么必须有缓存
 *
 * `autoOpenBrowserEnabled()` 是**同步**判据，会被宿主闸门（`openBrowser` /
 * `openIncognitoWindow` / raccoon 授权页）在登录热路径上调用。若每次现读盘，
 * 一次登录就要多几次 `existsSync` + `readFileSync` + `JSON.parse`。
 *
 * ## 为什么缓存是安全的（不需要「每次现读才生效」）
 *
 * 写者与读者**在同一个进程**（`loginPreferences.setEnabled` 的 `save()` 就在这里），
 * 所以 `save()` 成功后把新值写进缓存即可，开关立刻生效、无需重启。唯一的代价是
 * **进程外**的改文件（手工编辑 / 另一个工作区里的进程）不会被运行中的进程看到 ——
 * 那本来就不是本文件的受支持路径（文档里写的是「用设置面板开关」），且启动时会重读。
 *
 * ## 两个后端实例共享一份缓存（按**路径**索引）
 *
 * `src/index.ts` 与 `src/jet-hub-rpc.ts` 各自 `createLoginPreferenceStore(ctx)`，
 * 得到两个 `FileLoginPreferenceStore` 实例，但它们读写**同一个文件** ⇒ 缓存按路径
 * 索引，面板侧 `save()` 写完，宿主闸门下一轮立刻读到新值，**不必等重启**。
 */
const parsedCache = new Map<string, boolean>()

/** 清空进程内缓存（供单测模拟「重启后重读」与「外部改文件」两种情形）。 */
export function resetLoginPreferenceCache(): void {
  parsedCache.clear()
}

/**
 * 文件后端：`$DSH_HOME/jet-hub/login-preferences.json`（原子写：tmp + rename）。
 *
 * ⚠️ **导出只为单测注入接缝**：RPC 层承诺「响应回**落盘值**而不是回传入参」，
 * 而那条承诺只在「`save()` 静默失败」时才可见 —— 单测要能把 `save` 换成
 * 「不抛错但不落盘」的桩态。生产代码**不要**直接 new 它，走
 * {@link createLoginPreferenceStore}。
 */
export class FileLoginPreferenceStore implements LoginPreferenceStore {
  readonly kind = 'file' as const

  constructor(
    private readonly path: string,
    private readonly logger: { warn(message: string): void } | undefined,
  ) {}

  load(): boolean {
    const cached = parsedCache.get(this.path)
    if (cached !== undefined) return cached
    const value = this.readFromDisk()
    parsedCache.set(this.path, value)
    return value
  }

  private readFromDisk(): boolean {
    try {
      if (!existsSync(this.path)) return true
      const parsed = JSON.parse(readFileSync(this.path, 'utf-8')) as unknown
      return sanitizeAutoOpenBrowserEnabled(fieldOf(parsed))
    } catch (error) {
      // 损坏时回落默认值而不是抛错：这是展示/默认值偏好，读不到最多是
      // 「回到改动前的行为」，不该让整个 RPC 端点连坐失败。
      this.logger?.warn(
        `[jet-hub] 读取 ${this.path} 失败，自动打开浏览器按「开」处理: ${String(error)}`,
      )
      return true
    }
  }

  async save(enabled: boolean): Promise<void> {
    mkdirSync(join(this.path, '..'), { recursive: true })
    const tmp = `${this.path}.tmp`
    writeFileSync(
      tmp,
      JSON.stringify({ schema: SCHEMA, autoOpenBrowserEnabled: enabled }, null, 2),
      'utf-8',
    )
    renameSync(tmp, this.path)
    // 落盘成功后同步缓存：下一个登录请求立刻读到新值。
    parsedCache.set(this.path, enabled)
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
  return (parsed as Record<string, unknown>).autoOpenBrowserEnabled
}

/**
 * 创建偏好后端。
 *
 * home 的解析与账号池 / 徽标偏好 / 锁表 / 思考档偏好**同一个函数**
 * （`resolveJetHubHome`），保证几份文档永远落在同一目录 —— 否则会出现
 * 「账号池在 A 处、偏好文档在 B 处」的分裂。
 */
export function createLoginPreferenceStore(ctx: Context): LoginPreferenceStore {
  const home = resolveJetHubHome(ctx)
  if (home === undefined) {
    ctx.logger?.warn?.('[jet-hub] 无法定位 DSH home，自动打开浏览器偏好仅存在于内存中')
    return new MemoryLoginPreferenceStore()
  }
  return new FileLoginPreferenceStore(join(home, 'jet-hub', LOGIN_PREFERENCES_FILE), ctx.logger)
}

/**
 * 宿主侧「是否自动打开浏览器」的**同步判据**来源。
 *
 * ⚠️ 用回调而不是在这里直接读盘：本模块被 `login.ts` 等底层文件引用，
 * 而那些文件没有 `ctx`（拿不到 dsh home）。`src/index.ts` 在 `apply()` 里
 * 用同一个偏好后端把回调接上（与 `configureStrongestReasoningEnabled` 同款）。
 */
let source: (() => boolean) | undefined

/**
 * 接线「自动打开浏览器」偏好的读取来源（`src/index.ts` 的 `apply()` 调用）。
 *
 * 传 `undefined` 可清空来源（单测复位用）。
 */
export function configureAutoOpenBrowserEnabled(next: (() => boolean) | undefined): void {
  source = next
}

/**
 * 此刻是否应当**自动打开浏览器授权页**（缺省 = 开）。
 *
 * - 未接线（单测 / 非 Web profile）：返回 `true` —— 与功能上线前逐字节相同；
 * - 来源抛错：返回 `true`（**绝不让读取失败静默关闭功能**）；
 * - 来源返回值不是布尔：按开启处理（`!== false`）。
 */
export function autoOpenBrowserEnabled(): boolean {
  if (source === undefined) return true
  try {
    return source() !== false
  } catch {
    return true
  }
}