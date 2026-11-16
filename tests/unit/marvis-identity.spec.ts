/**
 * ★ Marvis「被上游拉黑身份句」替换表（Gitee issue IKVRNK）。
 *
 * ## 这份用例守的是什么
 *
 * 2026-11-16 真机实发确证：marvis 网关（`yybadaccess.3g.qq.com`）对
 * `messages[]` 内 `role:'system'` 的身份句做**字面量黑名单**，而且
 *
 * - 我们共用登记表给 DSH 身份句用的「官方同形措辞」
 *   （`You are an AI coding assistant, powered by a large language model`）
 *   **也在黑名单里** ⇒ 现行管线把请求改写到了一处新的禁词上；
 * - Claude Code 身份句一族同样被拦，**且其登记表产物也被拦**。
 *
 * 所以本文件的第一组判据是**纯函数级**（表到底换成了什么），第二组是
 * **接线级**（wire 上真的是换过的文本 —— 表写了但没接线 = 功能不存在）。
 *
 * ⚠️ **不要**把「替换句」写进 `CONTENT_FINGERPRINTS` 的 `find`：那是自指规则，零行为。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MARVIS_BLOCKED_IDENTITY_REWRITES,
  rewriteMarvisBlockedIdentities,
} from '../../src/marvis-identity.js'
import { MarvisAdapter } from '../../src/marvis-adapter.js'
import { MARVIS } from '../../src/marvis-product.js'
import type { AccountPool } from '../../src/account-pool.js'
import type { MarvisCredential } from '../../src/marvis.js'

/** 上游当前拉黑的两族措辞（出现任意一条都必然 403/4100406）。 */
const BLOCKED_TEXTS = [
  'AI coding assistant',
  'Claude Code',
] as const

/** 实测放行的替换值（2026-11-16，`messages[]`-system 位置，200）。 */
const ALLOWED_CODING = 'You are an AI agent for coding work.'
const ALLOWED_CLI = 'You are an interactive CLI coding agent.'

describe('★ rewriteMarvisBlockedIdentities：被拉黑身份句 → 实测放行措辞', () => {
  it('★★★ 官方同形句（带 product 后缀）必须换掉 —— 这正是现行管线的产物', () => {
    const blocked = 'You are an AI coding assistant, powered by a large language model.'
    // 自证夹具：这句确实是登记表给 DSH 身份句用的 replace 值。
    expect(blocked).toContain('AI coding assistant')
    expect(rewriteMarvisBlockedIdentities(blocked)).toBe(ALLOWED_CODING)
  })

  it('★★★ 裸形态（无 product 后缀）同样被拦，必须走同一条规则', () => {
    expect(rewriteMarvisBlockedIdentities('You are an AI coding assistant.')).toBe(ALLOWED_CODING)
    // 不带尾句点也要命中（登记表 `find` 刻意不带句点，两种形态都会出现）。
    expect(rewriteMarvisBlockedIdentities('You are an AI coding assistant')).toBe(ALLOWED_CODING)
  })

  it('★★★ Claude Code 官方句 → 放行措辞（报障 issue 说「只登记了 DSH 一族」，本格证伪）', () => {
    expect(
      rewriteMarvisBlockedIdentities("You are Claude Code, Anthropic's official CLI for Claude"),
    ).toBe(ALLOWED_CLI)
  })

  it('★★★ 登记表的 Claude Code 产物也必须换掉 —— 它同样 403', () => {
    // `CONTENT_FINGERPRINTS` 把上句换成这句；这句在 marvis 网关也是 403。
    expect(rewriteMarvisBlockedIdentities("You are Claude Code, Anthropic's CLI for Claude")).toBe(
      ALLOWED_CLI,
    )
    expect(rewriteMarvisBlockedIdentities('You are Claude Code.')).toBe(ALLOWED_CLI)
    // ⚠️ **已知未覆盖形态**（如实登记，不要读成「已验证安全」）：裸 `You are Claude.`
    // 实测**同样 403**，但它不在本仓任何产出路径上（登记表只会产出带 `Code` 的形态），
    // 而放宽成 `You\s+are\s+Claude\b` 会误伤 “You are Claude's successor” 这类正常句子
    // ⇒ 刻意不覆盖。若哪天真有调用方会送这句，先在这里加规则再改本断言。
    expect(rewriteMarvisBlockedIdentities('You are Claude.')).toBe('You are Claude.')
  })

  it('★★ 大小写不敏感（上游匹配器同样大小写不敏感，改写不能只在标准写法的输入上生效）', () => {
    expect(rewriteMarvisBlockedIdentities('you are an ai coding assistant.')).toBe(ALLOWED_CODING)
    expect(rewriteMarvisBlockedIdentities('YOU ARE CLAUDE CODE.')).toBe(ALLOWED_CLI)
  })

  it('★★ 幂等：连跑两次与跑一次逐字节相同（第二次不得再改）', () => {
    const once = rewriteMarvisBlockedIdentities(
      'You are an AI coding assistant, powered by a large language model.',
    )
    expect(rewriteMarvisBlockedIdentities(once)).toBe(once)
  })

  it('★★ 未命中时**原样返回同一引用**（不做无意义的拷贝 —— 上层靠引用相等跳过重写）', () => {
    const text = '你是一个普通的系统提示词，没有任何身份句。'
    expect(rewriteMarvisBlockedIdentities(text)).toBe(text)
  })

  it('★★ 不跨行、不吞掉后面的约束（只改身份句本身）', () => {
    const input = 'You are Claude Code.\n你必须先读文件再改代码，不得凭空编造内容。'
    const out = rewriteMarvisBlockedIdentities(input)
    expect(out.startsWith(ALLOWED_CLI)).toBe(true)
    expect(out).toContain('你必须先读文件再改代码，不得凭空编造内容。')
  })

  it('★★★ 反向判据：表里任何一条规则的产物都不得再含被拦措辞', () => {
    // 这条是「上游随时可能再登记」之外的**自证**：我们至少不该主动写禁词。
    expect(MARVIS_BLOCKED_IDENTITY_REWRITES.length).toBeGreaterThan(0)
    for (const rule of MARVIS_BLOCKED_IDENTITY_REWRITES) {
      for (const blocked of BLOCKED_TEXTS) {
        expect(rule.replace).not.toContain(blocked)
      }
      // 产物再过一遍表必须稳定（否则两条规则互相打架）。
      expect(rewriteMarvisBlockedIdentities(rule.replace)).toBe(rule.replace)
    }
  })
})

// ---------------------------------------------------------------------------
// 接线层：表写了不等于生效 —— 判据必须打在 wire 上
// ---------------------------------------------------------------------------

const CREDENTIAL: MarvisCredential = {
  access_token: 'tok',
  refresh_token: 'refresh',
  openid: '0123456789abcdef0123456789abcdef',
  guid: 'fedcba9876543210fedcba9876543210',
  login_type: '1',
}

function makePool(): AccountPool {
  return {
    disabledModelsFor: () => new Set<string>(),
    providerClosedFor: () => false,
    hasLoggedInAccount: async () => true,
  } as never
}

function makeAdapter(): MarvisAdapter {
  return new MarvisAdapter({
    product: MARVIS,
    accountPool: makePool(),
    slots: async () => [{ id: 'marvis-a1', credential: CREDENTIAL }],
  })
}

function sseBody(text: string): string {
  return [
    `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}`,
    '',
    `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 1, delta: {}, finish_reason: 'stop' }] })}`,
    '',
    'data: [DONE]',
    '',
    '',
  ].join('\n')
}

/** 跑一次 `stream()` 并把真实发出去的请求体交出来。 */
async function wireOf(options: Record<string, unknown>): Promise<Record<string, unknown>> {
  const fetchMock = vi.fn(
    async (_url: string, _init: RequestInit) =>
      new Response(sseBody('ok'), {
        status: 200,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      }),
  )
  vi.stubGlobal('fetch', fetchMock)
  for await (const _chunk of makeAdapter().stream({
    model: 'deepseek-v4-pro-external',
    ...options,
  } as never)) {
    // drain
  }
  const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
  return JSON.parse(init.body as string) as Record<string, unknown>
}

describe('★★★ 接线层：两处 system 位置都必须过这张表（漏一处 = 一半的会话仍 403）', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('★★★ messages[] 里的 system 消息必须换成放行措辞', async () => {
    const payload = await wireOf({
      messages: [
        { role: 'system', content: 'You are an AI coding assistant, powered by a large language model.' },
        { role: 'user', content: 'hi' },
      ],
    })
    const messages = payload.messages as Array<{ role: string; content: unknown }>
    const system = messages.find((message) => message.role === 'system')
    expect(system?.content).toBe(ALLOWED_CODING)
  })

  it('★★★ 顶层 system 字段必须换成同一句（两处共用一个函数）', async () => {
    const payload = await wireOf({
      system: 'You are an AI coding assistant, powered by a large language model.',
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect(payload.system).toBe(ALLOWED_CODING)
  })

  it('★★★ 端到端三级链：DSH 身份句 ⇒ wire 上是**最终**放行措辞，不是中间产物', async () => {
    // ① 登记表 → 官方同形句；② 本表 → 放行措辞；③ 兜底正则 no-op。
    // 只断言 ① 的产物就是把被拦文本钉成了期望 —— 本仓此前正是如此。
    const payload = await wireOf({
      messages: [
        { role: 'system', content: 'You are an AI agent powered by DeepSeek Harness.' },
        { role: 'user', content: 'hi' },
      ],
    })
    const messages = payload.messages as Array<{ role: string; content: unknown }>
    const system = messages.find((message) => message.role === 'system')
    expect(system?.content).toBe(ALLOWED_CODING)
    for (const blocked of BLOCKED_TEXTS) {
      expect(String(system?.content)).not.toContain(blocked)
    }
  })

  it('★★ 顶层 system 与 messages[]-system **同时**存在时，两处都要换（只换一处等于没换）', async () => {
    const payload = await wireOf({
      system: 'You are an AI coding assistant.',
      messages: [
        { role: 'system', content: 'You are an AI coding assistant.' },
        { role: 'user', content: 'hi' },
      ],
    })
    const messages = payload.messages as Array<{ role: string; content: unknown }>
    expect(messages.find((message) => message.role === 'system')?.content).toBe(ALLOWED_CODING)
    expect(payload.system).toBe(ALLOWED_CODING)
  })
})
