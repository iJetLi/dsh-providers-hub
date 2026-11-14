/**
 * 腾讯 Marvis 的真机探针（**默认跳过**）。
 *
 * ## 闸门
 *
 * ```
 * MARVIS_E2E=1              必需
 * MARVIS_E2E_CONFIRM=yes    必需（防误跑）
 * ```
 *
 * 凭据来源，按优先级：
 * 1. `MARVIS_CREDENTIAL_JSON` —— 一份 `MarvisCredential` 的 JSON；
 * 2. 本机 magpie 的 `~/.config/magpie/plugin-auth.json` 里的 `marvis` 条目。
 *
 * ## ⚠️ 本探针**只读**，绝不续期
 *
 * 不调用 `refreshAccountCredential` / `refreshAll` —— Marvis 的 `refresh_token`
 * 是一次性的语义（刷新后可能换新值），对着真实凭据发一次就可能把用户的账号
 * 弄失效。钱包与推理都是**只读**动作，不会改动任何服务端状态。
 *
 * ## 断言的核心事实
 *
 * `deepseek-v4-pro-external` 是**服务端自动路由槽位**，实测落到 `deepseek-v4-1-flash-261017`
 * （响应体的 `model` 字段）。真实模型 id **不能**直传 —— 直传回
 * `400 {"code":4130001,"msg":"客户端AI业务错误: 无效模型id"}`。
 * 这两条正是「auto 档位 → 实际 ds v4.1 flash」在 wire 上的证据。
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { MarvisAdapter } from '../../src/marvis-adapter.js'
import { fetchMarvisBalanceDetailed } from '../../src/marvis-credits.js'
import { classifyMarvisError, MARVIS, marvisErrorKindCode } from '../../src/marvis-product.js'
import {
  llmHeaders,
  marvisAccountOf,
  marvisChatUrl,
  parseMarvisCredential,
  type MarvisCredential,
} from '../../src/marvis.js'

const RUN = process.env.MARVIS_E2E === '1' && process.env.MARVIS_E2E_CONFIRM === 'yes'
const suite = RUN ? describe : describe.skip

/** 从 magpie 的 plugin-auth.json 里取 `marvis` 条目（只读，不写回）。 */
function credentialFromMagpie (): MarvisCredential | undefined {
  let raw: string
  try {
    raw = readFileSync(join(homedir(), '.config', 'magpie', 'plugin-auth.json'), 'utf8')
  } catch {
    return undefined
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  const entry = (parsed as { marvis?: unknown }).marvis
  if (entry === undefined) return undefined
  const typed = entry as {
    access?: unknown
    refresh?: unknown
    expires?: unknown
    metadata?: { openid?: unknown; guid?: unknown; loginType?: unknown; nickname?: unknown }
  }
  const openid = typed.metadata?.openid
  const guid = typed.metadata?.guid
  if (typeof typed.access !== 'string' || typeof typed.refresh !== 'string') return undefined
  if (typeof openid !== 'string' || typeof guid !== 'string') return undefined
  return {
    access_token: typed.access,
    refresh_token: typed.refresh,
    openid,
    guid,
    login_type: typed.metadata?.loginType === '2' ? '2' : '1',
    ...(typeof typed.expires === 'number' ? { expires_at: String(typed.expires) } : {}),
  }
}

function credentialOf (): MarvisCredential | undefined {
  const fromEnv = process.env.MARVIS_CREDENTIAL_JSON
  if (fromEnv !== undefined && fromEnv.trim() !== '') {
    const parsed = parseMarvisCredential(fromEnv)
    if (parsed !== undefined) return parsed
  }
  return credentialFromMagpie()
}

const credential = credentialOf()

suite('Marvis 真机探针（只读）', () => {
  it.skipIf(credential === undefined)('★ 钱包：返回可读的令牌总量（`expiryUnknown` 必须为真）', async () => {
    const result = await fetchMarvisBalanceDetailed(credential as MarvisCredential, MARVIS)
    expect(result.error).toBeUndefined()
    expect(result.balance).toBeDefined()
    const balance = result.balance!
    expect(balance.total).toBeGreaterThan(0)
    const main = balance.packages.find((entry) => entry.name === '令牌用量')
    expect(main).toBeDefined()
    // 上游一个日期字段都不下发（实测），所以这里**必须**是「到期未知」，
    // 否则卡片会把它写成「永久」，用户以为额度不会过期。
    expect(main!.expiryUnknown).toBe(true)
    expect(main!.remaining).toBeGreaterThanOrEqual(0)
    expect(main!.remaining).toBeLessThanOrEqual(balance.total)
  })

  it.skipIf(credential === undefined)('★★ `deepseek-v4-pro-external` 真的路由到 `deepseek-*`（响应体的 `model` 是唯一证据）', async () => {
    const account = marvisAccountOf(credential as MarvisCredential)
    const response = await fetch(marvisChatUrl(MARVIS.baseUrl), {
      method: 'POST',
      headers: llmHeaders(account, { accept: 'application/json' }),
      body: JSON.stringify({
        model: 'deepseek-v4-pro-external',
        messages: [{ role: 'user', content: '回复一个字：好' }],
        max_tokens: 8,
        stream: false,
      }),
      signal: AbortSignal.timeout(60_000),
    })
    expect(response.status).toBe(200)
    const body = await response.json() as {
      model?: unknown
      choices?: Array<{ message?: { content?: unknown } }>
      usage?: { prompt_tokens?: unknown; completion_tokens?: unknown }
    }
    // ⚠️ 这是整个集成的**核心断言**：目录里只有槽位名 `deepseek-v4-pro-external`，
    //    但服务端把它路由到了真实模型 —— 展示名「DeepSeek V4.1 Flash」的依据。
    expect(typeof body.model).toBe('string')
    expect(body.model as string).toMatch(/^deepseek-/)
    expect(Array.isArray(body.choices)).toBe(true)
    expect(body.usage?.prompt_tokens).toBeGreaterThan(0)
  })

  it.skipIf(credential === undefined)('★ 适配器走完整条链：resolveModel + stream 出块', async () => {
    const adapter = new MarvisAdapter({
      slots: async () => [{ id: 'marvis-e2e', credential: credential as MarvisCredential }],
      product: MARVIS,
    })
    const resolved = await adapter.resolveModel(MARVIS.id, 'deepseek-v4-pro-external')
    expect(resolved.id).toBe('deepseek-v4-pro-external')
    expect(resolved.name).toBe('DeepSeek V4.1 Flash')
    expect(resolved.context?.contextWindow).toBe(1_000_000)
    expect(resolved.inputModalities).toEqual(['text', 'image'])
    // 用户裁定：与 magpie 一致，**不声明**档位（宿主因此不会发 reasoning_effort）。
    expect(resolved.reasoning).toBeUndefined()

    const chunks: string[] = []
    for await (const chunk of adapter.stream({
      model: 'deepseek-v4-pro-external',
      messages: [{ role: 'user', content: '回复一个字：好' }],
      maxTokens: 64,
    } as never)) {
      chunks.push((chunk as { type: string }).type)
      if (chunks.length > 200) break
    }
    // 流式必须真的出块（思考默认开 ⇒ 大概率先出 reasoning-delta；
    // 只要 block-start / text-delta / reasoning-delta 任一出现即证明链路通）。
    expect(chunks.some((type) => type === 'text-delta' || type === 'reasoning-delta' || type === 'block-start')).toBe(true)
  })

  it.skipIf(credential === undefined)('★ 真实模型 id 经适配器**归一**成 `deepseek-v4-pro-external`（用户从别处抄来的真名也能用）', async () => {
    const adapter = new MarvisAdapter({
      slots: async () => [{ id: 'marvis-e2e', credential: credential as MarvisCredential }],
      product: MARVIS,
    })
    // 归一发生在 `resolveModel` 里：真实 id 不是合法的上行 `model` 值，
    // 但用户在别处（日志 / 官方文档）看到的就是它 ⇒ 不能报「未知模型」。
    const resolved = await adapter.resolveModel(MARVIS.id, 'deepseek-v4-1-flash-261017')
    expect(resolved.id).toBe('deepseek-v4-pro-external')
    expect(resolved.name).toBe('DeepSeek V4.1 Flash')
  })

  it.skipIf(credential === undefined)('★★ 但真实模型 id **直传上游** ⇒ 400 `4130001`，分类为 `model_unavailable`', async () => {
    // 这一条证明「必须走槽位名」不是文档里的传闻：同一份凭据、同一套头，
    // 把 `model` 换成真实 id 就回 400。适配器之所以能正常工作，全靠上面那条归一。
    const account = marvisAccountOf(credential as MarvisCredential)
    const response = await fetch(marvisChatUrl(MARVIS.baseUrl), {
      method: 'POST',
      headers: llmHeaders(account, { accept: 'application/json' }),
      body: JSON.stringify({
        model: 'deepseek-v4-1-flash-261017',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 8,
        stream: false,
      }),
      signal: AbortSignal.timeout(60_000),
    })
    expect(response.status).toBe(400)
    const text = await response.text()
    expect(text).toContain('4130001')
    const info = classifyMarvisError(response.status, text)
    // 「模型不可用」是**确定性**失败：换账号没有意义（上游按 id 拒绝），
    // 归到 rate_limit 会让宿主白重试 5 次。
    expect(info.kind).toBe('model_unavailable')
    expect(marvisErrorKindCode(info.kind)).toBe('BAD_REQUEST')
  })
})
