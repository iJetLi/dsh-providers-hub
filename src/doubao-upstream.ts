/**
 * 豆包（Doubao，字节跳动）**网页端上游协议**。
 *
 * ## ⚠️ 这个模块解决的是什么问题
 *
 * 2026-11-03 接入豆包时，本仓只做了**每日签到**（`src/doubao-signin.ts`），
 * 结论写的是「豆包无积分余额概念」「没有模型调用协议」——
 * 那两条结论**只对签到口径成立**，对**账号面板与模型选择器**是错的：
 *
 * - **额度**（`/alice/commerce/sale/subscription/quota/summary/`）确实存在，
 *   2026-11-22 真机实测回 `活动赠送额度 total_amount:"1,600"`；
 * - **模型目录**（`/alice/slot/action_bar_v3/brief_list`）确实存在，
 *   同日实测回 14 个真实模型（豆包 2.1 Pro/Lite、DeepSeek V4.1 Flash、Kimi K3.1 Pro、
 *   GLM 5.3、Qwen 4 Max…）与各自的倍率标签；
 * - **对话**（`/chat/completion`）也通，回真实增量正文。
 *
 * ⇒ 本模块把这三条腿的**协议细节**集中到一处，适配器与额度查询共用。
 *
 * ## 鉴权与设备身份
 *
 * - **鉴权 = cookie**（`sessionid` / `sid_tt` / `ttwid`…），无 `Authorization`。
 * - **设备身份 = 确定性派生**（`doubaoDeviceIdentityOf`）：每账号一套 19 位数字
 *   `device_id` / `web_id` / `tea_uuid`，`fp` 恒为 `verify_<device_id>`。
 * - ⚠️ 这三条腿**不需要** `a_bogus` 签名（签到那条腿需要，走 CDP 页面会话）。
 *   实测依据：2026-11-22 用纯 cookie + 客户端请求头，三个端点均 200。
 *
 * ## 请求头是**客户端身份**，不是随便填的
 *
 * ⚠️ `Referer` 必须是 `chrome://doubao-chat/`（桌面端方案），
 * **不能**用 `https://www.doubao.com/chat/`；`User-Agent` 必须带
 * `SamanthaDoubao/<version>` 后缀。这两条来自豆包桌面端抓包，
 * 与本仓 TRAE 那条「UA 前缀决定 WAF 放行」是同型约束。
 *
 * @module src/doubao-upstream.ts
 */

import { randomUUID } from 'node:crypto'
import { doubaoDeviceIdentityOf, type DoubaoCredential } from './doubao.js'

/** 豆包网页端基址。 */
export const DOUBAO_WEB_BASE_URL = 'https://www.doubao.com'

/** 额度汇总端点（**只接受 POST**；GET 同路径是 404 空体）。 */
export const DOUBAO_QUOTA_PATH = '/alice/commerce/sale/subscription/quota/summary/'

/** 模型目录端点（**只接受 POST**；GET 同路径是 404）。 */
export const DOUBAO_BRIEF_LIST_PATH = '/alice/slot/action_bar_v3/brief_list'

/** 对话端点。 */
export const DOUBAO_CHAT_PATH = '/chat/completion'

/**
 * 豆包助手 bot id（对话与模型目录两处都要它）。
 *
 * ⚠️ 缺它 → 模型目录回 `code 710010202 / common invalid param`（2026-11-22 实测）。
 */
export const DOUBAO_BOT_ID = '7338286299411103781'

/** 客户端版本号（随豆包客户端发版变化，风控会看它）。 */
export const DOUBAO_CLIENT_VERSION = '2.31.4'

/** 运行时版本号（同上）。 */
export const DOUBAO_RUNTIME_VERSION = '3.39.0'

/** Chromium 版本（客户端自报）。 */
export const DOUBAO_CHROMIUM_VERSION = '147.0.7727.149'

/** 请求超时（毫秒）。 */
export const DOUBAO_HTTP_TIMEOUT_MS = 15_000

/**
 * 构造豆包客户端形态的请求头。
 *
 * ⚠️ `Referer` 用 `chrome://doubao-chat/`（桌面端方案）——这是抓包实测值。
 * ⚠️ `sec-ch-ua` 是客户端自报的 brand 串，与 UA 里的 Chrome 版本一致。
 */
export function doubaoHeaders(cookie: string, extra?: Record<string, string>): Record<string, string> {
  return {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/'
      + DOUBAO_CHROMIUM_VERSION + ' Safari/537.36 SamanthaDoubao/' + DOUBAO_CLIENT_VERSION,
    Referer: 'chrome://doubao-chat/',
    accept: '*/*',
    'accept-language': 'zh-CN,zh;q=0.9',
    'sec-ch-ua': '"Chromium";v="147", "Not.A/Brand";v="8"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    'agw-js-conv': 'str',
    'x-flow-trace': randomUUID().replace(/-/g, '') + '-' + randomUUID().replace(/-/g, '') + '-01',
    'last-event-id': 'undefined',
    cookie,
    ...extra,
  }
}

/**
 * 构造公共 query。
 *
 * ⚠️ `aid` 聊天侧是 `582478`（签到侧是 `497858`，两者不同，别混）。
 * ⚠️ `fp` 恒为 `verify_<device_id>`——客户端就是这么发的，不是 `s_v_web_id`。
 */
export function doubaoQuery(credential: DoubaoCredential): URLSearchParams {
  const { deviceId, webId, teaUuid } = doubaoDeviceIdentityOf(credential)
  return new URLSearchParams({
    aid: '582478',
    real_aid: '582478',
    version_code: '20800',
    pc_version: DOUBAO_CLIENT_VERSION,
    device_id: deviceId,
    tea_uuid: teaUuid,
    web_id: webId,
    fp: 'verify_' + deviceId,
    chromium_version: DOUBAO_CHROMIUM_VERSION,
    runtime_version: DOUBAO_RUNTIME_VERSION,
    channel: 'win',
    language: 'zh',
    region: 'CN',
    sys_region: 'CN',
    tz_name: 'Asia/Shanghai',
    pkg_type: 'release_version',
    client_platform: 'pc_client',
    device_platform: 'web',
    doubao_device_platform: 'desktop',
    web_platform: 'desktop',
    samantha_web: '1',
    'use-olympus-account': '1',
    web_tab_id: randomUUID(),
  })
}

/**
 * 豆包上游返回的**信封**。
 *
 * ⚠️ `code !== 0` 时 `data` 是 `null`，且 `message`/`msg` 都有内容
 * （实测 `code 710010202 / message "common invalid param" / msg "系统错误"`）。
 */
export interface DoubaoEnvelope {
  code?: number
  msg?: string
  message?: string
  data?: unknown
}

/** 解析信封；非 JSON 时回 `undefined`（不抛）。 */
export function parseDoubaoEnvelope(raw: string): DoubaoEnvelope | undefined {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return undefined
    return parsed as DoubaoEnvelope
  } catch {
    return undefined
  }
}

/** 从信封里取可读错误文案（没有就回空串）。 */
export function doubaoErrorText(envelope: DoubaoEnvelope | undefined): string {
  if (envelope === undefined) return ''
  const message = typeof envelope.message === 'string' ? envelope.message : ''
  const msg = typeof envelope.msg === 'string' ? envelope.msg : ''
  const text = message.length > 0 ? message : msg
  return text.length > 0 ? text : 'code ' + (envelope.code ?? -1)
}

/**
 * 额度窗口（上游 `window_limits[]` 的一条）。
 *
 * ⚠️ `total_amount` / `used_amount` 是**千分位字符串**（实测 `"1,600"`），
 * 而 `used_amount` 还可能是 `"<1"`（不足 1 的占比）——两者都要能解析。
 */
export interface DoubaoQuotaWindow {
  readonly featureGroup: string
  readonly featureGroupName: string
  readonly total: number
  readonly used: number
  readonly endTime?: number
  readonly usedPercent?: number
}

/**
 * 解析额度响应里的窗口列表。
 *
 * ⚠️ 上游把它放在 `incentive_quota_section` 与 `window_limit_section` 两处，
 * 形状相同 ⇒ 两处都走（未来出现第三处只需再加一个）。
 */
export function doubaoQuotaWindows(payload: unknown): readonly DoubaoQuotaWindow[] {
  const data = (payload as { data?: unknown } | undefined)?.data
  if (typeof data !== 'object' || data === null) return []
  const out: DoubaoQuotaWindow[] = []
  const quotaData = data as {
    incentive_quota_section?: unknown
    window_limit_section?: unknown
  }
  for (const section of [quotaData.incentive_quota_section, quotaData.window_limit_section]) {
    const groups = (section as { window_limit_groups?: unknown } | undefined)?.window_limit_groups
    if (!Array.isArray(groups)) continue
    for (const group of groups) {
      if (typeof group !== 'object' || group === null) continue
      const limits = (group as { window_limits?: unknown }).window_limits
      if (!Array.isArray(limits)) continue
      for (const limit of limits) {
        if (typeof limit !== 'object' || limit === null) continue
        const row = limit as {
          total_amount?: unknown
          used_amount?: unknown
          end_time?: unknown
          used_percent?: unknown
        }
        const total = doubaoAmount(row.total_amount)
        const used = doubaoAmount(row.used_amount)
        if (total === undefined && used === undefined) continue
        out.push({
          featureGroup: String((group as { feature_group?: unknown }).feature_group ?? ''),
          featureGroupName: String((group as { feature_group_name?: unknown }).feature_group_name ?? ''),
          total: total ?? 0,
          used: used ?? 0,
          endTime: typeof row.end_time === 'number' ? row.end_time : undefined,
          usedPercent: typeof row.used_percent === 'number' ? row.used_percent : undefined,
        });
      }
    }
  }
  return out
}

/**
 * 解析一个额度数字。
 *
 * ⚠️ 上游给的是**千分位字符串**（`"1,600"`）；带 `<` 的阈值字符串当前按阈值
 * 数字保守取整（例如 `"<1"` → `1`），宁可少算剩余额度，也不虚报可用数。
 */
export function doubaoAmount(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed.startsWith('<')) {
    const inner = Number(trimmed.slice(1).replace(/[,\s_]/g, ''))
    return Number.isFinite(inner) ? inner : undefined
  }
  const digits = trimmed.replace(/[,\s_]/g, '')
  if (!/^-?\d+(?:\.\d+)?$/.test(digits)) return undefined
  const parsed = Number(digits)
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * 订阅展示名（实测 `display.short_name` = 「免费体验」，
 * `display.product_name` = 「个人订阅」）。
 */
export function doubaoSubscriptionName(payload: unknown): string | undefined {
  const data = (payload as { data?: unknown } | undefined)?.data
  if (typeof data !== 'object' || data === null) return undefined
  const display = (data as { current_subscription?: { display?: { short_name?: unknown } } })
    .current_subscription?.display
  const short = typeof display?.short_name === 'string' ? display.short_name.trim() : ''
  return short.length > 0 ? short : undefined
}

/**
 * 目录里的一条模型（来自 `brief_list` 的 `entry_list` 树）。
 *
 * ⚠️ `default_mode` 是**豆包的模式号**：`1` = 对话、`3` = 工作任务。
 * 它决定请求体的 `mode_id` / `agent_mode` / `conversation_mode`（见 `src/doubao-adapter.ts`）。
 */
export interface DoubaoRemoteModel {
  /** 上游的 `model_item_key`（请求里用它路由，**不是**显示名）。 */
  readonly key: string
  /** 显示名（实测「豆包 2.1 Pro」「DeepSeek V4.1 Flash」…）。 */
  readonly name: string
  /** 模式号：1 = 对话，3 = 工作任务。 */
  readonly modeId: string
  /** 倍率 / 活动标签（实测「0.65x」「限时优惠 0.01x」「小额免费」）。 */
  readonly tags: readonly string[]
  /** 只在模型菜单明确公开档位时存在；不声明默认值，避免隐式开启推理。 */
  readonly reasoning?: { readonly efforts: readonly { readonly id: string; readonly name: string }[] }
}

function doubaoReasoningEfforts(value: unknown): DoubaoRemoteModel['reasoning'] | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const options = (value as { option_list?: unknown }).option_list
  if (!Array.isArray(options)) return undefined
  const efforts: { id: string; name: string }[] = []
  const seen = new Set<string>()
  for (const option of options) {
    if (typeof option !== 'object' || option === null) continue
    const item = option as { level?: unknown; name?: unknown }
    if ((typeof item.level !== 'number' && typeof item.level !== 'string') || typeof item.name !== 'string') continue
    const id = String(item.level)
    const name = item.name.trim()
    if (!/^\d+$/.test(id) || name.length === 0 || seen.has(id)) continue
    seen.add(id)
    efforts.push({ id, name })
  }
  return efforts.length === 0 ? undefined : { efforts }
}

/** A menu appearance describes one route; its efforts must not be used in another route. */
type DoubaoModeId = '1' | '3'

function doubaoModeId(value: unknown): DoubaoModeId | undefined {
  return value === 1 || value === '1' ? '1' : value === 3 || value === '3' ? '3' : undefined
}

export function doubaoRemoteModels(payload: unknown): readonly DoubaoRemoteModel[] {
  type Appearance = {
    readonly name: string
    readonly tags: readonly string[]
    readonly menuMode: DoubaoModeId | undefined
    readonly defaultMode: DoubaoModeId | undefined
    readonly reasoning: DoubaoRemoteModel['reasoning']
  }
  const found = new Map<string, Appearance[]>()
  const visit = (node: unknown, menuMode?: DoubaoModeId, reasoningEnabled = false): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item, menuMode, reasoningEnabled)
      return
    }
    if (typeof node !== 'object' || node === null) return
    const record = node as Record<string, unknown>
    const mode = doubaoModeId(record.mode_id) ?? menuMode
    const enabled = typeof record.show_reasoning_effort === 'boolean' ? record.show_reasoning_effort : reasoningEnabled
    const key = record.model_item_key
    if ((typeof key === 'string' || typeof key === 'number') && key !== '') {
      const id = String(key)
      const rows = found.get(id) ?? []
      rows.push({
        name: typeof record.name === 'string' ? record.name.trim() : '',
        tags: doubaoTagList(record.tag_list),
        menuMode: mode,
        defaultMode: doubaoModeId(record.default_mode),
        reasoning: enabled ? doubaoReasoningEfforts(record.reasoning_effort_config) : undefined,
      })
      found.set(id, rows)
    }
    for (const value of Object.values(record)) visit(value, mode, enabled)
  }
  visit(payload)
  return [...found].map(([key, rows]) => {
    const menu = rows.filter((row) => row.menuMode !== undefined)
    const candidates = menu.length > 0 ? menu : rows
    const modeOf = (row: Appearance): DoubaoModeId => row.menuMode ?? row.defaultMode ?? '1'
    const modes = new Set(candidates.filter((row) => row.menuMode !== undefined || row.defaultMode !== undefined).map(modeOf))
    const defaults = new Set(candidates.flatMap((row) => row.defaultMode === undefined ? [] : [row.defaultMode]))
    const preferred = defaults.size === 1 ? [...defaults][0] : undefined
    // Prefer an unambiguous default present in the menu. On conflict, avoid task billing if chat exists.
    const modeId = preferred !== undefined && modes.has(preferred) ? preferred : modes.has('1') || !modes.has('3') ? '1' : '3'
    const chosen = candidates.filter((row) => modeOf(row) === modeId)
    const reasoning = chosen[0]?.reasoning
    // Conflicting descriptions of the same route are not a reliable capability declaration.
    const sameEfforts = reasoning !== undefined && chosen.every((row) => JSON.stringify(row.reasoning) === JSON.stringify(reasoning))
    const display = [...chosen, ...rows]
    return {
      key,
      name: display.find((row) => row.name.length > 0)?.name ?? key,
      modeId,
      tags: display.find((row) => row.tags.length > 0)?.tags ?? [],
      ...(sameEfforts ? { reasoning } : {}),
    }
  })
}

/**
 * 解析标签列表。
 *
 * ⚠️ 上游的元素要么是**字符串**，要么是 `{ text }` 形态（实测两种都有）。
 */
export function doubaoTagList(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = [];
  for (const item of value) {
    const text = typeof item === 'string'
      ? item
      : typeof (item as { text?: unknown } | undefined)?.text === 'string'
        ? String((item as { text: string }).text)
        : ''
    const trimmed = text.trim()
    if (trimmed.length > 0) out.push(trimmed)
  }
  return out
}

/**
 * 把倍率/活动标签整理成展示后缀（上游客户端的原始拼法）。
 *
 * ⚠️ 「限时优惠 0.01x」按上游原样展示（**不**改写成 `x0.01 限时优惠`）——
 * 展示层读的是上游给的文本，改写就是二次加工。
 */
export function doubaoTagSuffix(tags: readonly string[]): string | undefined {
  const parts = tags.map((tag) => tag.trim()).filter((tag) => tag.length > 0)
  return parts.length > 0 ? parts.join(' · ') : undefined
}
