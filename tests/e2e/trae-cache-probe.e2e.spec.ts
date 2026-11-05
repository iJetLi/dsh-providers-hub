/**
 * TRAE 前缀缓存探针（e2e，issue IKSFT2）。
 *
 * 目的：**不看投影、直接抓上游 SSE 原始 usage**，回答「同前缀第二次到底有没有
 * 命中」。issue 里的统计来自 `token_usage` 投影（且适配器在命中为 0 时会省略
 * 字段），存在「0」与「字段被丢」同形的可能；本探针把上游原始行打出来。
 *
 * 实验（三次请求，前缀逐字节相同、含随机 nonce 保证冷启动）：
 *   A. 第一次：冷启动，命中应为 0；
 *   B. 第二次：同前缀，若上游仍有前缀缓存则应 >0；
 *   C. 第三次：同前缀 + `prompt_cache_key`（在 fetch 层注入，验证 issue 的猜测）。
 *
 * 闸门：`DSH_TRAE_E2E=1` 且 `DSH_TRAE_E2E_CONFIRM=yes`（会消耗真实额度）。
 * 凭据：`tests/e2e/trae-credential.ts`（DSH_TRAE_CREDENTIAL_JSON 或本地
 * `.credentials.yaml` 的 `TRAE_ACCOUNT_*`）。
 */
import { describe, expect, it } from 'vitest'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'

import { TraeAdapter } from '../../src/trae-adapter.js'
import { TRAE } from '../../src/trae-product.js'
import { readTraeCredentialsFromDshStore } from './trae-credential.js'

const E2E = process.env.DSH_TRAE_E2E === '1'
  && process.env.DSH_TRAE_E2E_CONFIRM === 'yes'
const suite = E2E ? describe : describe.skip
const MODEL = process.env.DSH_TRAE_E2E_MODEL ?? 'deepseek-v4.1-flash'

/** 一段足够长、且本次运行唯一的前缀（约 1.5 万 token 量级）。 */
function longPrefix(nonce: string): string {
  const lines: string[] = []
  for (let i = 0; i < 1400; i += 1) {
    lines.push(`cache probe ${nonce} line ${i}: the quick brown fox jumps over the lazy dog 0123456789.`)
  }
  return lines.join('\n')
}

interface Captured {
  /** 上游 SSE 里所有含 usage/缓存字段的原始行。 */
  rawUsage: string[]
  /** 最近一次请求体（用于确认有没有 prompt_cache_key）。 */
  bodies: string[]
  /** 是否真的带上了 prompt_cache_key（body 很长，不能只看前 400 字符）。 */
  hasPromptCacheKey: boolean
}

function makeFetch(captured: Captured): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = typeof init?.body === 'string' ? init.body : ''
    captured.bodies.push(body.slice(0, 400))
    if (body.includes('prompt_cache_key')) captured.hasPromptCacheKey = true
    const res = await fetch(input, init)
    // clone 后再读，不干扰适配器的流式消费。
    const text = await res.clone().text().catch(() => '')
    for (const line of text.split('\n')) {
      if (/cache_read_input_tokens|cache_creation_input_tokens|cached_tokens|"usage"/.test(line)) {
        captured.rawUsage.push(line.trim().slice(0, 800))
      }
    }
    return res
  }) as typeof fetch
}

async function chat(adapter: TraeAdapter, text: string): Promise<{ text: string, error: string }> {
  const chunks: string[] = []
  let error = ''
  try {
    for await (const chunk of adapter.stream({
      model: MODEL,
      messages: [{ role: 'user', content: [{ type: 'text', text }] }],
      maxTokens: 32,
    } as unknown as GenerateOptions)) {
      const c = chunk as { type: string, text?: string }
      if (c.type === 'text-delta' && typeof c.text === 'string') chunks.push(c.text)
    }
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught)
  }
  return { text: chunks.join(''), error }
}

suite('E2E-TRAE-CACHE（issue IKSFT2）', () => {
  const entry = readTraeCredentialsFromDshStore()[0]

  it('至少有一个 TRAE 账号', () => {
    expect(entry, '未找到 TRAE 凭据，请先登录或设置 DSH_TRAE_CREDENTIAL_JSON').toBeDefined()
  })

  it('★★ 同前缀两次 + prompt_cache_key 对照，dump 上游原始 usage', async () => {
    expect(entry).toBeDefined()
    const captured: Captured = { rawUsage: [], bodies: [], hasPromptCacheKey: false }
    const adapter = new TraeAdapter({
      credentialRef: 'TRAE_ACCESS_TOKEN' as never,
      resolveCredential: async () => entry!.credential,
      refresh: async () => {},
      fetchImpl: makeFetch(captured),
      product: TRAE,
    })

    const nonce = `n${Date.now().toString(36)}`
    const prefix = longPrefix(nonce)
    const prompt = `${prefix}\n\n只回复 OK。`

    const a = await chat(adapter, prompt)
    console.log(`[trae-cache] A cold: err=${a.error} text=${JSON.stringify(a.text.slice(0, 30))}`)
    console.log('[trae-cache] A usage lines:\n' + captured.rawUsage.join('\n'))

    const b = await chat(adapter, prompt)
    console.log(`[trae-cache] B same-prefix: err=${b.error}`)
    console.log('[trae-cache] B usage lines:\n' + captured.rawUsage.slice(-8).join('\n'))

    // C：在 fetch 层给请求体注入 prompt_cache_key（适配器本身不发）。
    const capturedC: Captured = { rawUsage: [], bodies: [], hasPromptCacheKey: false }
    const injectKey: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      /**
       * 适配器既可能用 `fetch(url, { body })`，也可能自己构造 `Request`
       * （此时 `init` 是 undefined、body 在 Request 里）。两种都要覆盖，
       * 否则「C body has key: false」就变成探针自身的假阴性。
       */
      let request: RequestInfo | URL = input
      if (input instanceof Request) {
        const text = await input.clone().text()
        const body = JSON.parse(text) as Record<string, unknown>
        body.prompt_cache_key = nonce
        capturedC.bodies.push(JSON.stringify(body).slice(0, 400))
        request = new Request(input, { body: JSON.stringify(body) })
      } else {
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {}
        body.prompt_cache_key = nonce
        capturedC.bodies.push(JSON.stringify(body).slice(0, 400))
        init = { ...init, body: JSON.stringify(body) }
      }
      return makeFetch(capturedC)(request, init)
    }) as typeof fetch
    const adapterC = new TraeAdapter({
      credentialRef: 'TRAE_ACCESS_TOKEN' as never,
      resolveCredential: async () => entry!.credential,
      refresh: async () => {},
      fetchImpl: injectKey,
      product: TRAE,
    })
    const c = await chat(adapterC, prompt)
    console.log(`[trae-cache] C prompt_cache_key: err=${c.error}`)
    console.log('[trae-cache] C usage lines:\n' + capturedC.rawUsage.join('\n'))
    console.log(`[trae-cache] C body has key: ${capturedC.hasPromptCacheKey}`)

    // 探针不断言命中结果（上游可能已关闭缓存）；只要求请求本身没有报错。
    expect(a.error, 'cold 请求不应报错').toBe('')
    expect(b.error, 'second 请求不应报错').toBe('')
    expect(c.error, 'prompt_cache_key 请求不应报错').toBe('')
  }, 600_000)
})
