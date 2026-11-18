/**
 * AgnesCode 协议层：本机会话采集 + 三个 BFF 端点 + 凭据钉扎。
 *
 * ## 这家为什么不是「一个 Key 填进去就能用」
 *
 * AgnesCode 是**桌面客户端产品**，没有面向第三方的 API Key：
 * 凭据只存在于本机 App 的 Chromium 会话文件里（`code-auth-session*.v1`），
 * 且它是**账号级数据**——文件里带着 `bffPublicBaseUrl`，国内站与国际版
 * 各自指向不同的 host。所以本 provider 的凭据是一条 **JSON**
 * `{access_token, bff_base, user_id?, nickname?, expires_at?}`，
 * 而不是一个裸 token。
 *
 * ## 三条端点（都在同一个 BFF 进程后面）
 *
 * | 用途 | 路径 | 备注 |
 * |---|---|---|
 * | 目录 | `GET {apiRoot}/v2/models` | `v2`，不是 `v1`；需要网关头闸 |
 * | 额度 | `GET {apiRoot}/api/v2/subscription/credits-balance` | **不在 `/v1` 前缀下** |
 * | 推理 | `POST {bffBase}/chat/completions` | 纯 OpenAI 兼容 |
 *
 * 网关头闸：目录端点**必须**带 `X-App-Id: 1` + `X-Platform: 1`（实测缺它恒
 * 403）。头集合声明一次、两个构造器共用，避免认证/匿名两条腿漂移成不同的
 * gate 值。
 *
 * ## 安全边界（这是本文件最重要的约束）
 *
 * `bffPublicBaseUrl` 来自**本地文件**，因此在任何 `Authorization` 头指向它
 * 之前，必须先钉扎到 Agnes 的 origin 族（https + `*.agnes-ai.cn` /
 * `*.agnes-ai.com`）。一个损坏或被篡改的会话文件绝不能把 token 送到第三方
 * host —— 那是一条凭据外泄链，不是一次「加载失败」。
 *
 * @module src/agnescode.ts
 */

import { createDecipheriv } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFile, readdir } from 'node:fs/promises'
import type { AgnescodeModelEntry, AgnescodeProduct } from './agnescode-product.js'

/** 会话文件名（家族匹配：国内站 `.cn.v1`、国际站 `.v1`）。 */
export const AGNESCODE_SESSION_FILE_PATTERN = /^code-auth-session[^/\\]*\.v1$/i

/** 桌面端 Chromium 配置目录（逐平台）。本仓只有 win32 有已验证的采集路径。 */
export const AGNESCODE_APP_DATA_CANDIDATES: ReadonlyArray<{ platform: string; dirEnv: string; leaf: string }> = Object.freeze([
  { platform: 'win32', dirEnv: 'APPDATA', leaf: 'AgnesCode' },
  { platform: 'darwin', dirEnv: 'HOME', leaf: 'Library/Application Support/AgnesCode' },
  { platform: 'linux', dirEnv: 'HOME', leaf: '.config/AgnesCode' },
])

/**
 * 每个 BFF 请求都带的头。
 *
 * ⚠️ `X-App-Id` / `X-Platform` 是**目录端点实测必需**的闸门（缺它 403），
 * 对另外两个端点无害。`X-User-Language` 跟随桌面端。
 */
export const AGNESCODE_BASE_HEADERS = Object.freeze({
  Accept: 'application/json',
  'Content-Type': 'application/json',
  'X-App-Id': '1',
  'X-Platform': '1',
  'X-User-Language': 'zh-Hans',
})

/** 采集结果里的一行诊断（**只带形状事实，绝不带凭据值**）。 */
export interface AgnescodeHarvestAttempt {
  file: string | null
  tier: string
  detail: string
}

/** 本机采集的失败/成功分档。面板照这些码说明「到底卡在哪一层」。 */
export const AGNESCODE_HARVEST_TIER = Object.freeze({
  OK: 'ok',
  UNSUPPORTED_PLATFORM: 'unsupported_platform',
  FILE_MISSING: 'file_missing',
  FORMAT_DRIFT: 'format_drift',
  UNREADABLE: 'unreadable',
  NO_KEY: 'no_key',
  DECRYPT_FAILED: 'decrypt_failed',
  MALFORMED: 'malformed',
  NO_TOKEN: 'no_token',
  UNTRUSTED_BASE: 'untrusted_base',
})

/** 会话解码后的形状。 */
export interface AgnescodeSession {
  accessToken: string
  userId: string
  nickname: string
  bffBase: string
}

/**
 * 钉扎 BFF base：只放行 https + Agnes 的 origin 族。
 *
 * ⚠️ 判据必须是**域名边界**（`host === apex` 或 `host.endsWith('.apex')`），
 * 不能写成 `href.includes('agnes-ai.cn')` —— 后者会放行
 * `https://api.agnes-ai.cn.evil.example/` 这种把域名当前缀的地址。
 * 这正是「凭据外泄链」的入口。
 *
 * @param raw - 会话里的 `bffPublicBaseUrl`（或手工录入的 base）。
 * @returns 去掉尾部斜杠的 base；不可信时 `null`。
 */
export function trustAgnescodeBffBase(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const text = raw.trim()
  if (text === '') return null
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return null
  }
  if (url.protocol !== 'https:') return null
  if (url.username !== '' || url.password !== '') return null
  const host = url.hostname.toLowerCase()
  const trusted = host === 'agnes-ai.cn' || host.endsWith('.agnes-ai.cn')
    || host === 'agnes-ai.com' || host.endsWith('.agnes-ai.com')
  if (!trusted) return null
  return `${url.origin}${url.pathname}`.replace(/\/+$/, '')
}

/**
 * 账号级端点（`/api/...`）所对的根：BFF base **去掉** `/v1` 后缀。
 *
 * 额度端点不在 `/v1` 下，直接拼完整 base 会 404。
 */
export function agnescodeApiRoot(bffBase: string): string {
  const base = String(bffBase ?? '').replace(/\/+$/, '')
  return base.endsWith('/v1') ? base.slice(0, -3) : base
}

/** 带凭据的请求头。 */
export function agnescodeHeaders(credential: { access_token?: unknown }): Record<string, string> {
  const token = typeof credential.access_token === 'string' ? credential.access_token : ''
  return { ...AGNESCODE_BASE_HEADERS, Authorization: `Bearer ${token}` }
}

/** 解析后的凭据（落库形态）。 */
export interface AgnescodeCredential {
  access_token: string
  /** 钉扎后的 BFF base（**已过 {@link trustAgnescodeBffBase}**）。 */
  bff_base: string
  user_id?: string
  nickname?: string
  expires_at?: number
}

/**
 * 把落库的 JSON 字符串解析成 {@link AgnescodeCredential}；任何一处不成立都
 * 返回 `undefined`（调用方按「这个槽不可用」跳过，而不是让整家 provider 倒下）。
 */
export function parseAgnescodeCredential(value: string, product: AgnescodeProduct): AgnescodeCredential | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const source = parsed as Record<string, unknown>
  const token = typeof source.access_token === 'string' ? source.access_token.trim() : ''
  if (token === '') return undefined
  // 手工录入时可能没有 base：回落站点常量（**只**在这一条路径上回落）。
  const rawBase = typeof source.bff_base === 'string' && source.bff_base.trim() !== ''
    ? source.bff_base
    : product.fallbackBffBase
  const base = trustAgnescodeBffBase(rawBase)
  if (base === null) return undefined
  const userId = typeof source.user_id === 'string' ? source.user_id : ''
  const nickname = typeof source.nickname === 'string' ? source.nickname : ''
  const expiresAt = typeof source.expires_at === 'number' && Number.isFinite(source.expires_at) ? source.expires_at : undefined
  return {
    access_token: token,
    bff_base: base,
    ...(userId === '' ? {} : { user_id: userId }),
    ...(nickname === '' ? {} : { nickname }),
    ...(expiresAt === undefined ? {} : { expires_at: expiresAt }),
  }
}

/**
 * 从 JWT 的 `exp` 取有效期（毫秒）。失败返回 `undefined`（= 「未知」，不是「已过期」）。
 *
 * ⚠️ `undefined` 与「已过期」必须分开：前者不该触发任何续期/重登动作，
 * 后者才该。把两者混成一个 `0` 会让「解析不出来的 token」被反复判失效。
 */
export function decodeAgnescodeJwtExpMs(token: string): number | undefined {
  const parts = token.split('.')
  if (parts.length !== 3) return undefined
  try {
    const payload = Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
    const parsed = JSON.parse(payload) as { exp?: unknown }
    return typeof parsed.exp === 'number' && Number.isFinite(parsed.exp) ? parsed.exp * 1000 : undefined
  } catch {
    return undefined
  }
}

/**
 * Chromium `os_crypt` blob → 明文：`v10` 前缀 + AES-256-GCM（12 字节 nonce、
 * 尾部 16 字节 auth tag）。
 */
export function decryptAgnescodeSessionBlob(blob: Buffer | Uint8Array, key: Buffer | Uint8Array): Buffer {
  const bytes = Buffer.isBuffer(blob) ? blob : Buffer.from(blob ?? [])
  const keyBytes = Buffer.isBuffer(key) ? key : Buffer.from(key ?? [])
  if (keyBytes.length !== 32) throw new Error(`os_crypt key must be 32 bytes, got ${keyBytes.length}`)
  const prefix = bytes.subarray(0, 3).toString('latin1')
  if (prefix !== 'v10') throw new Error(`unexpected session-blob prefix ${JSON.stringify(prefix)}`)
  const body = bytes.subarray(3)
  if (body.length < 12 + 16) throw new Error('session blob too short for nonce + tag')
  const nonce = body.subarray(0, 12)
  const tag = body.subarray(body.length - 16)
  const ciphertext = body.subarray(12, body.length - 16)
  const decipher = createDecipheriv('aes-256-gcm', keyBytes, nonce)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()])
}

/**
 * 从 `Local State` 里解出 os_crypt 密钥。
 *
 * 存储形态是 base64(`"DPAPI"` + DPAPI 密文)；DPAPI 调用**注入**进来，
 * 单测因此不需要真实 DPAPI，也不会把密钥写进任何地方。
 */
export async function unwrapAgnescodeLocalStateKey(
  localStateRaw: string | Buffer | Uint8Array,
  dpapiUnprotect: (wrapped: Buffer) => Promise<Buffer>,
): Promise<Buffer> {
  const text = typeof localStateRaw === 'string' ? localStateRaw : Buffer.from(localStateRaw).toString('utf8')
  let source: unknown
  try {
    source = JSON.parse(text)
  } catch {
    // ⚠️ 固定文案、不带 V8 的原文引用：那条错误会引用用户文件里的片段。
    throw new Error('Local State is not valid JSON')
  }
  const osCrypt = typeof source === 'object' && source !== null
    ? (source as Record<string, unknown>).os_crypt
    : undefined
  const encryptedKey = typeof osCrypt === 'object' && osCrypt !== null
    ? (osCrypt as Record<string, unknown>).encrypted_key
    : undefined
  if (typeof encryptedKey !== 'string' || encryptedKey === '') {
    throw new Error('Local State carries no os_crypt.encrypted_key')
  }
  const wrapped = Buffer.from(encryptedKey, 'base64')
  if (wrapped.length < 6 || wrapped.subarray(0, 5).toString('latin1') !== 'DPAPI') {
    throw new Error('os_crypt.encrypted_key lacks the DPAPI prefix')
  }
  return dpapiUnprotect(wrapped.subarray(5))
}

/** 子进程环境：去掉可能携带凭据的名字（本进程并不需要它们）。 */
function dpapiChildEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env }
  for (const name of ['AGNESCODE_ACCESS_TOKEN', 'AGNESCODE_CREDENTIAL']) delete out[name]
  return out
}

/**
 * 生产环境的 DPAPI 解包：PowerShell 子进程。
 *
 * 不引原生依赖、不需要构建（Host 侧零构建），密钥只在**内存**里过一道：
 * 输入以 base64 走参数、输出以 base64 走 stdout，绝不打印/落盘。
 */
export async function defaultDpapiUnprotect(wrapped: Buffer): Promise<Buffer> {
  const payload = wrapped.toString('base64')
  const script = [
    'Add-Type -AssemblyName System.Security',
    `$b=[Convert]::FromBase64String('${payload}')`,
    "$p=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser')",
    '[Console]::Out.Write([Convert]::ToBase64String($p))',
  ].join('; ')
  const stdout = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10_000,
    env: dpapiChildEnv(process.env),
    // 明文密钥不许进 stderr（诊断只可能来自我们自己的脚本，出错会抛异常）。
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return Buffer.from(stdout.trim(), 'base64')
}

/** 会话 JSON → 钉扎后的会话；缺 token 或 base 不可信时 `null`。 */
export function parseAgnescodeSession(raw: unknown): AgnescodeSession | null {
  if (typeof raw !== 'object' || raw === null) return null
  const source = raw as Record<string, unknown>
  const token = typeof source.accessToken === 'string' ? source.accessToken.trim() : ''
  if (token === '') return null
  const base = trustAgnescodeBffBase(source.bffPublicBaseUrl)
  if (base === null) return null
  const userInfo = typeof source.userInfo === 'object' && source.userInfo !== null
    ? source.userInfo as Record<string, unknown>
    : {}
  return {
    accessToken: token,
    userId: typeof userInfo.id === 'string' ? userInfo.id : '',
    nickname: typeof userInfo.username === 'string' ? userInfo.username : '',
    bffBase: base,
  }
}

/** 按站点排序候选会话文件：本站构建优先，其次另一站，最后按名稳定排序。 */
export function sortAgnescodeSessionFiles(names: readonly string[], domain: 'cn' | 'intl'): string[] {
  const own = (name: string): boolean => domain === 'cn'
    ? name.toLowerCase().includes('.cn.v1')
    : !name.toLowerCase().includes('.cn.v1')
  return [...names].sort((a, b) => {
    const ownA = own(a) ? 0 : 1
    const ownB = own(b) ? 0 : 1
    if (ownA !== ownB) return ownA - ownB
    return a.localeCompare(b)
  })
}

/** 采集器的注入点（单测离线跑，不需要真 DPAPI / 真文件）。 */
export interface AgnescodeHarvestOptions {
  product: AgnescodeProduct
  env?: NodeJS.ProcessEnv
  platform?: string
  readFileImpl?: (path: string) => Promise<Buffer>
  readDirImpl?: (path: string) => Promise<string[]>
  dpapiUnprotect?: (wrapped: Buffer) => Promise<Buffer>
}

/**
 * 采集本机 AgnesCode 会话。
 *
 * 逐候选文件给一行诊断，**第一个可用会话胜出**；失败时也返回诊断行
 * （「没装 App」/「装了没登录」/「登录了但格式变了」是三件不同的事，
 * 不能统一成一句「未登录」）。
 */
export async function harvestAgnescodeLocalSession(options: AgnescodeHarvestOptions): Promise<
  | { ok: false; attempts: AgnescodeHarvestAttempt[] }
  | { ok: true; attempts: AgnescodeHarvestAttempt[]; session: AgnescodeSession }
> {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const readFileImpl = options.readFileImpl ?? (async (path: string) => readFile(path))
  const readDirImpl = options.readDirImpl ?? (async (path: string) => readdir(path))
  const dpapiUnprotect = options.dpapiUnprotect ?? defaultDpapiUnprotect
  const attempts: AgnescodeHarvestAttempt[] = []
  const tiers = AGNESCODE_HARVEST_TIER

  // 只有 win32 有已验证的采集路径：macOS 的 IDE 变体读 state.vscdb（sqlite），
  // 两条非 Windows 的加密路径都**没有**取证 —— 走它们只会把「未实现」显示成
  // 一个误导性的 `no_key`。
  if (platform !== 'win32') {
    return {
      ok: false,
      attempts: [{
        file: null,
        tier: tiers.UNSUPPORTED_PLATFORM,
        detail: `no verified harvest path for ${platform} yet (Windows only; macOS reads state.vscdb — unimplemented)`,
      }],
    }
  }

  const candidates = AGNESCODE_APP_DATA_CANDIDATES.filter((item) => item.platform === platform)
  const appDirs: string[] = []
  for (const candidate of candidates) {
    const root = env[candidate.dirEnv]
    if (typeof root !== 'string' || root === '') continue
    appDirs.push(`${root.replace(/[\\/]+$/, '')}/${candidate.leaf}`)
  }
  if (appDirs.length === 0) {
    return { ok: false, attempts: [{ file: null, tier: tiers.UNSUPPORTED_PLATFORM, detail: `no app-data candidate for platform ${platform}` }] }
  }

  for (const appDir of appDirs) {
    let names: string[] = []
    try {
      const listing = await readDirImpl(appDir)
      names = listing.filter((name) => AGNESCODE_SESSION_FILE_PATTERN.test(name))
    } catch {
      attempts.push({ file: appDir, tier: tiers.FILE_MISSING, detail: 'the AgnesCode app directory is absent' })
      continue
    }
    if (names.length === 0) {
      attempts.push({ file: appDir, tier: tiers.FILE_MISSING, detail: 'no code-auth-session*.v1 in the app directory' })
      continue
    }
    for (const name of sortAgnescodeSessionFiles(names, options.product.domain)) {
      const filePath = `${appDir}/${name}`
      let blob: Buffer
      try {
        blob = await readFileImpl(filePath)
      } catch (why) {
        attempts.push({ file: filePath, tier: tiers.UNREADABLE, detail: errorText(why) })
        continue
      }
      // os_crypt 密钥就在会话文件旁边；读不到是**独立的一档**（App 在、但它的
      // 加密状态不是我们预期的形态）。
      let localState: Buffer
      try {
        localState = await readFileImpl(`${appDir}/Local State`)
      } catch {
        attempts.push({ file: filePath, tier: tiers.NO_KEY, detail: 'the sibling Local State is absent' })
        continue
      }
      let key: Buffer
      try {
        key = await unwrapAgnescodeLocalStateKey(localState, dpapiUnprotect)
      } catch (why) {
        attempts.push({ file: filePath, tier: tiers.NO_KEY, detail: errorText(why) })
        continue
      }
      let plain: Buffer
      try {
        plain = decryptAgnescodeSessionBlob(blob, key)
      } catch (why) {
        attempts.push({ file: filePath, tier: tiers.DECRYPT_FAILED, detail: `${errorText(why)} (blob ${blob.length} B)` })
        continue
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(plain.toString('utf8'))
      } catch {
        attempts.push({ file: filePath, tier: tiers.MALFORMED, detail: 'decrypted bytes are not JSON' })
        continue
      }
      const session = parseAgnescodeSession(parsed)
      if (session === null) {
        const hasToken = typeof (parsed as Record<string, unknown>)?.accessToken === 'string'
          && ((parsed as Record<string, unknown>).accessToken as string).trim() !== ''
        attempts.push({
          file: filePath,
          tier: hasToken ? tiers.UNTRUSTED_BASE : tiers.NO_TOKEN,
          detail: 'the decrypted session lacks a usable token or a pinned Agnes base',
        })
        continue
      }
      attempts.push({ file: filePath, tier: tiers.OK, detail: `JWT ${session.accessToken.length} chars` })
      return { ok: true, attempts, session }
    }
  }
  return { ok: false, attempts }
}

/** 统一的 `catch` 文案（不把整个对象塞进面板）。 */
function errorText(why: unknown): string {
  return why instanceof Error ? why.message : String(why)
}

/**
 * 拉账号级模型目录；读不到返回 `null`（调用方回落到 {@link AgnescodeModelEntry} 表，
 * 本家那张表**刻意留空**，见 `agnescode-product.ts`）。
 *
 * 契约细节（都是实测，不是推断）：
 * - 端点是 `/v2/models`（`/v1/models` 是另一个目录，没有倍率字段，且不按账号裁剪）；
 * - `data` 是**数组**，不套 `{code,message,data}` 信封 ⇒ 不能用统一的信封门禁；
 * - `auto` 是路由别名（只在 v2 出现、无倍率）⇒ 按 id 明确剔除，不按「有没有倍率」剔除。
 */
export async function fetchAgnescodeCatalog(
  credential: AgnescodeCredential,
  product: AgnescodeProduct,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<AgnescodeModelEntry[] | null> {
  const base = trustAgnescodeBffBase(credential.bff_base)
  if (base === null) return null
  try {
    const response = await fetcher(`${agnescodeApiRoot(base)}/v2/models`, {
      headers: agnescodeHeaders(credential),
      signal: AbortSignal.timeout(product.fetchTimeoutMs),
    })
    if (!response.ok) return null
    const body = await response.json().catch(() => ({})) as Record<string, unknown>
    const rows = Array.isArray(body.data) ? body.data : []
    const seen = new Set<string>()
    const out: AgnescodeModelEntry[] = []
    for (const raw of rows) {
      if (typeof raw !== 'object' || raw === null) continue
      const model = raw as Record<string, unknown>
      const id = typeof model.id === 'string' ? model.id : ''
      if (id === '' || seen.has(id) || id === 'auto') continue
      // 只保留对话模型：目录里 `model_type` 非 `text` 的条目（种子图/视频等）不能
      // 作为 chat 模型上架。
      if (typeof model.model_type === 'string' && model.model_type !== 'text') continue
      seen.add(id)
      const contextWindow = finiteInt(model.max_input_tokens)
      const maxTokens = finiteInt(model.max_output_tokens)
      out.push({
        id,
        name: typeof model.name === 'string' && model.name !== '' ? model.name : id,
        ...(contextWindow === undefined ? {} : { contextWindow }),
        ...(maxTokens === undefined ? {} : { maxTokens }),
        // 目录只声明 `model_type: "text"`；在真机确认「能收图」之前一律 false，
        // 否则宿主会把图发上去、上游静默忽略（比直接拒绝更难排查）。
        vision: false,
      })
    }
    return out.length > 0 ? out : null
  } catch {
    return null
  }
}

/**
 * 读账号的积分池（只读）。
 *
 * ⚠️ 这是**订阅积分池**（限时 / 永久两桶），不是「Token Plan 用量」——
 * 面板不得按配额窗口语义渲染。
 */
export async function fetchAgnescodeBalance(
  credential: AgnescodeCredential,
  product: AgnescodeProduct,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<{ total: number; timeSensitive: number; permanent: number } | null> {
  const base = trustAgnescodeBffBase(credential.bff_base)
  if (base === null) return null
  try {
    const response = await fetcher(`${agnescodeApiRoot(base)}/api/v2/subscription/credits-balance`, {
      headers: agnescodeHeaders(credential),
      signal: AbortSignal.timeout(product.fetchTimeoutMs),
    })
    if (!response.ok) return null
    const envelope = await response.json().catch(() => ({})) as Record<string, unknown>
    // 信封：`code` 是**字符串** `"000000"`（成功），不是数字。
    if (envelope.code !== '000000') return null
    const data = typeof envelope.data === 'object' && envelope.data !== null
      ? envelope.data as Record<string, unknown>
      : null
    if (data === null) return null
    const total = finiteNumber(data.total_balance)
    if (total === null) return null
    return {
      total,
      timeSensitive: finiteNumber(data.time_sensitive_balance) ?? 0,
      permanent: finiteNumber(data.permanent_balance) ?? 0,
    }
  } catch {
    return null
  }
}

/** 只接受安全非负整数（0 是合法值：上限/余额可以是 0）。 */
function finiteInt(raw: unknown): number | undefined {
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? Math.trunc(raw) : undefined
}

/** 只接受有限数字（0 合法 —— 余额为 0 是一次真实的「用完了」，不是缺值）。 */
function finiteNumber(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null
}

/**
 * 由凭据算出「有效期」（毫秒）；未知时 `undefined`。
 *
 * 优先用落库的 `expires_at`（采集时写进去的），回落 JWT 的 `exp`。
 */
export function agnescodeExpiryMs(credential: AgnescodeCredential): number | undefined {
  if (typeof credential.expires_at === 'number' && Number.isFinite(credential.expires_at)) return credential.expires_at
  return decodeAgnescodeJwtExpMs(credential.access_token)
}
