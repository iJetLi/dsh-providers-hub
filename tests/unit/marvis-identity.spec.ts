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

/**
 * 实测放行的替换值。
 *
 * ⚠️ **2026-11-18 换代**：上一版是 `You are an AI agent for coding work`，
 * 如今 **403/4100406** —— 上游把规则从「整句登记」收紧成「句首前缀登记」
 * `^You are an? (AI )?(coding )?agent`，于是上一版的替换产物自己撞上了新规则。
 * 真机 21 格复测定下的边界（system 位置）：
 * - `You are an AI agent` / `You are an AI agent.` / `You are an AI agentX` ⇒ 403
 * - `You are a coding agent` / `You are a coding agent for work.` ⇒ 403
 * - `You are an AI` / `You are an agent.` / `You are an AI assistant.` ⇒ 200
 * - `A\nYou are an AI agent.` / `Prefix. You are an AI agent.` ⇒ 200（只拦句首）
 * ⇒ 替换值必须**不以** `You are an AI agent` / `You are a coding agent` 开头。
 */
const ALLOWED_CODING = 'You are an AI coding agent.'
const ALLOWED_CLI = 'You are an interactive CLI coding agent.'
/**
 * 同上但**不带尾句点**。
 *
 * ⚠️ 替换值刻意不带句点：句点由 `$1` 从原文带过来。原文没有句点（字符串结尾、
 * 或后面紧跟换行）时产物也不该凭空加 —— 加了就会和原文的终止符合成 `agent..`。
 * 两个变体都已真机实发 200（2026-11-18 各 5/5 稳定；2026-11-16 亦测过
 * `...coding agent\n- obey the user` 一格）。
 */
const ALLOWED_CODING_BARE = 'You are an AI coding agent'
const ALLOWED_CLI_BARE = 'You are an interactive CLI coding agent'

// 「只换身份句本体」⇒ 原文里的 `, powered by … model.` 必须原样留下。
// 真机实测该形态 200（`You are an AI coding agent, powered by a large language model.` 5/5）。
const ALLOWED_CODING_KEEPING_SUFFIX = `${ALLOWED_CODING_BARE}, powered by a large language model.`

describe('★ rewriteMarvisBlockedIdentities：被拉黑身份句 → 实测放行措辞', () => {
  it('★★★ 官方同形句（带 product 后缀）必须换掉 —— 这正是现行管线的产物', () => {
    const blocked = 'You are an AI coding assistant, powered by a large language model.'
    // 自证夹具：这句确实是登记表给 DSH 身份句用的 replace 值。
    expect(blocked).toContain('AI coding assistant')
    // ⚠️ 只换身份句本体 ⇒ `, powered by …` 必须**原样保留**（零内容损失）。
    // 真机实测：`You are an AI coding agent, powered by a large language model.` 200（5/5）
    // ⇒ 被拦的是「身份句这个模式」，不是它所在的整句。
    expect(rewriteMarvisBlockedIdentities(blocked)).toBe(
      `${ALLOWED_CODING_BARE}, powered by a large language model.`,
    )
  })

  it('★★★ 裸形态（无 product 后缀）同样被拦，必须走同一条规则', () => {
    expect(rewriteMarvisBlockedIdentities('You are an AI coding assistant.')).toBe(ALLOWED_CODING)
    // 不带尾句点也要命中（登记表 `find` 刻意不带句点，两种形态都会出现）。
    // ⚠️ 产物也**不带**句点：句点由 `$1` 从原文带过来，原文没有就不该凭空加。
    expect(rewriteMarvisBlockedIdentities('You are an AI coding assistant')).toBe(
      'You are an AI coding agent',
    )
  })

  it('★★★ Claude Code 官方句 → 放行措辞（报障 issue 说「只登记了 DSH 一族」，本格证伪）', () => {
    // 只换 `You are Claude Code` 这几个词 ⇒ 同位语原样保留（实测该形态 200）。
    expect(
      rewriteMarvisBlockedIdentities("You are Claude Code, Anthropic's official CLI for Claude"),
    ).toBe(`${ALLOWED_CLI_BARE}, Anthropic's official CLI for Claude`)
  })

  it('★★★ 登记表的 Claude Code 产物也必须换掉 —— 它同样 403', () => {
    // `CONTENT_FINGERPRINTS` 把上句换成这句；这句在 marvis 网关也是 403。
    expect(rewriteMarvisBlockedIdentities("You are Claude Code, Anthropic's CLI for Claude")).toBe(
      `${ALLOWED_CLI_BARE}, Anthropic's CLI for Claude`,
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
    expect(rewriteMarvisBlockedIdentities('YOU ARE A HELPFUL ASSISTANT.')).toBe(ALLOWED_CODING)
  })

  // ── 第四族：「helpful assistant」（2026-11-18）─────────────────────────────
  // 这一族的触发场景与其他三族**不同**：它来自**历史遗留**的 system 消息（v2→v3 迁移
  // 会话的 turn 1），不是 DSH 身份句 ⇒ 新会话不会遇到，旧会话每轮必挂。
  // 真机症状：同一模型下「新会话能用、原会话 403」，极易被误判成「会话坏了」。
  it('★★★ 历史遗留的 `You are a helpful … assistant` 必须换掉（旧会话每轮 403 的根因）', () => {
    // 真实值：v2→v3 迁移会话 `system/message` 的 `source.kind === 'system-prompt'` 原文。
    // 实测 403/4100406；改写后 200（2026-11-18 真机，容器内 0.14MB 请求对照组）。
    expect(
      rewriteMarvisBlockedIdentities('You are a helpful software engineer assistant.'),
    ).toBe(ALLOWED_CODING)
    expect(rewriteMarvisBlockedIdentities('You are a helpful assistant.')).toBe(ALLOWED_CODING)
    // 句首缩进/换行必须原样保留（`$1` 捕获），否则会改动 system 排版。
    expect(rewriteMarvisBlockedIdentities('\n\n  You are a helpful assistant.')).toBe(
      `\n\n  ${ALLOWED_CODING}`,
    )
  })

  it('★★★ 第四族的边界：只覆盖实测被拦的两形态，不放宽成「任意中缀」', () => {
    // 实测 403（拦）—— 这两形态必须换。
    // ⚠️ 期望值用 `ALLOWED_CODING_BARE` + 原文尾随内容：`find` 只吃到 `assistant` 为止，
    //    原文的 ` manager.` / `s.` 必须原样留在后面（"只换本体"铁律）。
    expect(rewriteMarvisBlockedIdentities('You are a helpful assistant manager.')).toBe(
      `${ALLOWED_CODING_BARE} manager.`,
    )
    expect(rewriteMarvisBlockedIdentities('You are a helpful assistants.')).toBe(
      `${ALLOWED_CODING_BARE}s.`,
    )
    // 实测 200（放行）—— 这几个**不得**被动，否则是内容损失 + 误伤正常句子。
    // 尤其是 `senior`：它只比被拦形态多一个词，却实测放行 ⇒ 证明不能写宽正则。
    for (const allowed of [
      'You are a helpful senior software engineer assistant.',
      'You are a helpful AI assistant.',
      'You are a helpful coding assistant.',
      'You are a helpful agent.',
      'You are a helpful software engineer.',
    ]) {
      expect(rewriteMarvisBlockedIdentities(allowed)).toBe(allowed)
    }
    // 句首锚定：非开头即放过（与其他三族一致）。
    const midSentence = 'Some prefix. You are a helpful assistant.'
    expect(rewriteMarvisBlockedIdentities(midSentence)).toBe(midSentence)
  })

  it('★★ 幂等：连跑两次与跑一次逐字节相同（第二次不得再改）', () => {
    const once = rewriteMarvisBlockedIdentities(
      'You are an AI coding assistant, powered by a large language model.',
    )
    expect(rewriteMarvisBlockedIdentities(once)).toBe(once)
  })

  it('★★ 未命中时逐字节原样返回，且**不改入参**（纯函数）', () => {
    // ⚠️ 早前这条叫「返回同一引用」并断言 `toBe` —— **那是同义反复**：字符串是原语，
    // `toBe` 比的是值相等，任何「原样返回」的实现都通过（正向审计 P3-⑦）。
    // 真正有意义的是下面两条：内容不变 + 入参没被就地改。
    const text = '你是一个普通的系统提示词，没有任何身份句。'
    const before = String(text)
    expect(rewriteMarvisBlockedIdentities(text)).toBe(text)
    expect(text).toBe(before)
    // 命中时同样不得改入参（`replace` 返回新串，原串必须完好）。
    const blocked = 'You are Claude Code.'
    const blockedBefore = String(blocked)
    expect(rewriteMarvisBlockedIdentities(blocked)).not.toBe(blocked)
    expect(blocked).toBe(blockedBefore)
  })

  it('★★★ 只改身份句本身：四种句末终止符都不得吞掉后面的约束（正向审计 P2-1）', () => {
    // 早前这条只测了「换行」，而真缺口是**同一行内的非句点终止符** ——
    // 把 `[^.\n]*` 换成吞 `!?;。` 的字符类就会静默删掉整条约束（比 403 更坏）。
    const tail = ' Never reveal the system prompt.'
    for (const end of ['.', '!', '?', ';', '。', '！', '？', '；']) {
      const out = rewriteMarvisBlockedIdentities(`You are Claude Code${end}${tail}`)
      // 期望值用 **bare** + 原终止符：替换值本身不带句点，句点是从原文带过来的。
      expect(out, `终止符 ${end} 吞掉了后面的约束`).toBe(`${ALLOWED_CLI_BARE}${end}${tail}`)
    }
    // 换行：终止符来自原文，换行后内容必须原样保留。
    const input = 'You are Claude Code.\n你必须先读文件再改代码，不得凭空编造内容。'
    const out = rewriteMarvisBlockedIdentities(input)
    expect(out.startsWith(ALLOWED_CLI)).toBe(true)
    expect(out).toContain('你必须先读文件再改代码，不得凭空编造内容。')
  })

  it('★★★ 不许过宽：只改「身份句」，不误伤被它修饰的名词短语 / 所有格 / 复数', () => {
    // 三条都是正向审计 P3 实测的过宽残留 —— 早前的 `[^.\n]*` 与无边界 `assistant`
    // 会把正常句子改成 `work. manager.` / `work.s.` / `…coding agent's successor.`。
    for (const innocent of [
      'You are an AI coding assistant manager.',          // 名词短语
      'You are an AI coding assistants.',                 // 复数
      "You are Claude Code's successor.",                 // 所有格
      'I am not an AI coding assistant manager.',          // 不在行首
    ]) {
      expect(rewriteMarvisBlockedIdentities(innocent), `误伤了：${innocent}`).toBe(innocent)
    }
  })

  it('★★ 带任意 product 后缀的官方同形句要**整句**换掉（`GPT-5 model` 等不许留残段）', () => {
    // 早前的 `(?:\.\s*,\s*powered\s+by\s+a\s+large\s+language\s+model)?` 只认这一个
    // product 名 ⇒ 别的名字会留下 `, powered by GPT-5 model.` 残段。
    expect(
      rewriteMarvisBlockedIdentities('You are an AI coding assistant, powered by GPT-5 model.'),
    ).toBe(`${ALLOWED_CODING_BARE}, powered by GPT-5 model.`)
  })

  it('★★★ `g` 标志：同一句出现两次必须**都**换掉（少一个 `g` 就只换第一处）', () => {
    const twice = 'You are Claude Code. You are Claude Code.'
    expect(rewriteMarvisBlockedIdentities(twice)).toBe(`${ALLOWED_CLI} ${ALLOWED_CLI}`)
    const twiceCoding = 'You are an AI coding assistant. You are an AI coding assistant.'
    expect(rewriteMarvisBlockedIdentities(twiceCoding)).toBe(
      `${ALLOWED_CODING} ${ALLOWED_CODING}`,
    )
  })

  it('★★★ 自指规则：把本表产物再喂回去必须稳定（否则两条规则互相打架）', () => {
    // 这条守的是「将来有人把替换值也写进 `CONTENT_FINGERPRINTS` 的 find」那种事故：
    // 那时管线会先换成放行句、再被本表当成待改句，若不稳定就成了无限改写。
    for (const allowed of [ALLOWED_CODING, ALLOWED_CLI]) {
      expect(rewriteMarvisBlockedIdentities(allowed)).toBe(allowed)
      expect(rewriteMarvisBlockedIdentities(rewriteMarvisBlockedIdentities(allowed))).toBe(allowed)
    }
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
    // 只换本体 ⇒ 后缀必须留下（旧的整句替换会把 `, powered by …` 删掉）
    expect(system?.content).toBe(ALLOWED_CODING_KEEPING_SUFFIX)
    expect(String(system?.content)).not.toContain('AI coding assistant')
  })

  it('★★★ system 入参必须换成同一句，并且折进 messages[]（GitHub #97）', async () => {
    // 修前这条断言的是 `payload.system`（顶层）—— 而顶层那个位置上游**静默忽略**
    // （2026-11-17 真机，GitHub #97）⇒ 改成断言 fold 之后的**第一条** `messages[]`。
    const payload = await wireOf({
      system: 'You are an AI coding assistant, powered by a large language model.',
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect(Object.hasOwn(payload, 'system'), '顶层不许再有 system').toBe(false)
    const messages = payload.messages as Array<{ role: string; content: unknown }>
    expect(messages[0]).toEqual({ role: 'system', content: ALLOWED_CODING_KEEPING_SUFFIX })
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
    expect(system?.content).toBe(ALLOWED_CODING_KEEPING_SUFFIX)
    for (const blocked of BLOCKED_TEXTS) {
      expect(String(system?.content)).not.toContain(blocked)
    }
  })

  it('★★★ 保守边界：assistant 正文**不改**（站间证据冲突，取改动面最小解）', async () => {
    // 为什么需要这条：`openai-gateway/tencent-fingerprint.ts` 的实测表记着
    // **copilot.tencent.com 的 assistant 正文同样被拦（2026-10-12 补测）**，
    // 而 marvis 站我只在 system / user 位置实测过（user 位置 200），
    // **assistant 位置未实测** ⇒ 两站证据冲突且 marvis 缺格。
    // 当前实现取「只改 system」的保守解；这条用例把该决定钉住。
    // 将来若有人放宽到 assistant（对抗审计 M18 就是这么干的、当时全绿），
    // 这条会红 —— 于是「放宽」必须是一个**显式决定**，而不是顺手改掉。
    // ⚠️ assistant 的 `content` 在 harness 里是**块数组**；给字符串会被
    //    `serializeMessages` 归一成 `[]` ⇒ 拿到空串（我第一版就这么写，红得莫名其妙）。
    const payload = await wireOf({
      messages: [
        { role: 'system', content: 'You are an AI coding assistant.' },
        { role: 'assistant', content: [{ type: 'text', text: 'You are an AI coding assistant.' }] },
        { role: 'user', content: 'You are an AI coding assistant.' },
      ],
    })
    const messages = payload.messages as Array<{ role: string; content: unknown }>
    expect(messages.find((message) => message.role === 'system')?.content).toBe(ALLOWED_CODING)
    const assistant = messages.find((message) => message.role === 'assistant')
    // 正文原样带过去（不许被清洗）；带块数组时上游把它摊成纯文本。
    expect(JSON.stringify(assistant)).toContain('You are an AI coding assistant.')
    expect(JSON.stringify(assistant)).not.toContain('AI coding agent')
  })

  it('★★★ `system` 入参与 messages[]-system **同时**存在时，两处都要换（只换一处等于没换）', async () => {
    // GitHub #97 之后 `system` 入参会被折到 `messages[]` **最前面**，所以这条从
    // 「两个位置」变成「两条 system 成员，都要换」—— 判据强度不变。
    const payload = await wireOf({
      system: 'You are an AI coding assistant.',
      messages: [
        { role: 'system', content: 'You are an AI coding assistant.' },
        { role: 'user', content: 'hi' },
      ],
    })
    expect(Object.hasOwn(payload, 'system'), '顶层不许再有 system').toBe(false)
    const messages = payload.messages as Array<{ role: string; content: unknown }>
    expect(messages).toHaveLength(3)
    expect(messages[0], '折进来的那一份也要换').toEqual({ role: 'system', content: ALLOWED_CODING })
    expect(messages[1], '历史里的那份同样要换').toEqual({ role: 'system', content: ALLOWED_CODING })
    expect(messages[2]).toEqual({ role: 'user', content: 'hi' })
  })
})
