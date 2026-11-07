/**
 * astudio-stream.spec.ts —— AStudio 流式增量（累积全文→增量 diff）纯函数单测【草案】
 *
 * drop-in 位置：tests/unit/astudio-stream.spec.ts（本草案不写进 worktree，由后续意图原样落盘）
 * 被测源码：src/astudio.ts 的 `astudioIncrementalDelta` / `astudioRewriteSsePayload` /
 *            （非导出的）`rewriteLine` + `isAllEmptyDelta` / `astudioWrapIncremental`
 *
 * ── 为什么这三个函数值得单独一组用例（事实依据）──────────────────────
 * fact 352/363/380 实测：上游 `POST {maasBaseUrl}/chat/completions`（2026-11-07 起为
 * `maas-api.cn-huabei-1.xf-yun.com/v1`）的 stream=true 回的是
 * **标准 OpenAI 增量** chunk + `[DONE]`。但任务方法论的「已知坑」与 fact 349 记录的内置链
 * 是「同一 Id 累积全文」⇒ `astudioWrapIncremental` 是**防御性**包装器。
 * 风险两个方向都存在：
 *   ① 对标准增量**必须幂等透传** —— 一旦包装器把正常的 `content:"你"` 当重复丢掉，
 *      症状是「反代出来的流是空的」，且不报错；
 *   ② 对累积全文必须真做 diff —— 漏了就变成客户端收到越来越长的重复文本。
 * 所以本文件里「透传」与「改写」两类断言同等重要，且都锚在**同一个 state Map** 的语义上。
 *
 * ── 零网络 / 零真实凭据 ───────────────────────────────────────────────
 * 全部输入是本地构造的 SSE 字面量（形态取自 fact 363/380 抓样）；`astudioWrapIncremental`
 * 吃的是 `new Response(ReadableStream)`，不出网。
 *
 * ── 与 fact 478 待修项的关系 ──────────────────────────────────────────
 * 本文件**不依赖** D1/D2/D3（码集 80000、astudio-auth L316/L484 收窄、refreshOnce via 透传），
 * 可在 fact 478 的改动落地之前独立通过 —— 但 D4（fact 478 ④：`astudio-product.ts`
 * 的 `chunkTimeoutMs: 120_000` → ≥300_000）在本文件末尾有一处源码级守卫，
 * 该用例标了 `@depends-on D4`，未改前会红。
 *
 * ── tsconfig.tests.json ────────────────────────────────────────────────
 * 默认**不在** include 名单，要进 `pnpm typecheck:tests` 需补一行
 * `"tests/unit/astudio-stream.spec.ts",`（锚点：紧跟现有 `"tests/unit/jet-hub-rpc-signature.spec.ts"` 之后）。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  astudioIncrementalDelta,
  astudioRewriteSsePayload,
  astudioWrapIncremental,
  type AstudioDeltaState,
} from '../../src/astudio.js'
// ⚠️ 源码切片必须走它（行尾无关 + AST 括号匹配），本仓 autocrlf=true
import { sourceScope } from '../helpers/source-scope.js'

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src')
const src = readFileSync(join(SRC_DIR, 'astudio.ts'), 'utf8')
const scope = sourceScope(src, 'astudio.ts')

/** 每次用例都换一个全新 state（不同用例之间绝不能共享已发文本）。 */
function freshState(): Map<string, AstudioDeltaState> {
  return new Map<string, AstudioDeltaState>()
}

/** 造一条 OpenAI 风格 chunk（默认标准增量：只有一个 choice、delta.content 是**片段**）。 */
function chunk(content: string, opts: { id?: string; reasoning?: string; finish?: string | null; toolArgs?: Array<{ index: number; arguments: string }> } = {}): string {
  const delta: Record<string, unknown> = { content }
  if (opts.reasoning !== undefined) delta.reasoning_content = opts.reasoning
  if (opts.toolArgs !== undefined) {
    delta.tool_calls = opts.toolArgs.map((t) => ({ index: t.index, type: 'function', function: { arguments: t.arguments } }))
  }
  const choice: Record<string, unknown> = { index: 0, delta }
  if (opts.finish !== undefined) choice.finish_reason = opts.finish
  return JSON.stringify({ id: opts.id ?? 'chatcmpl-fixture-1', object: 'chat.completion.chunk', choices: [choice] })
}

/** 过一遍包装器：喂若干行，拿回改写后的完整 SSE 文本。 */
async function pipeLines(...lines: string[]): Promise<string> {
  const body = new Blob([lines.map((l) => `${l}\n`).join('')]).stream()
  const wrapped = astudioWrapIncremental(new Response(body, { status: 200 }))
  return await wrapped.text()
}

/** 从 SSE 文本里抽出非空的 `data:` 载荷（丢弃的行会渲染成空行，这里过滤掉）。 */
function dataPayloads(sse: string): string[] {
  return sse
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trim())
}

/** 把 SSE 文本里所有 data 载荷的 delta.content 串起来（增量正确性的终局判据）。 */
function joinedContent(sse: string): string {
  let out = ''
  for (const payload of dataPayloads(sse)) {
    if (payload === '[DONE]') continue
    const parsed = JSON.parse(payload) as { choices?: Array<{ delta?: { content?: string } }> }
    for (const choice of parsed.choices ?? []) out += choice.delta?.content ?? ''
  }
  return out
}

// ════════════════════════════════════════════════════════════════════════
describe('★ astudio.ts 流式层源码级契约', () => {
  it('⚠️ 包装器不得吞掉 `[DONE]`（吞了 ⇒ 下游永远等不到终态、连接挂死）', () => {
    const line = scope.fn('rewriteLine')
    expect(line).toMatch(/payload === '\[DONE\]'\) return line/)

    // 空 payload（空行/心跳）也必须原样返回
    expect(line).toMatch(/payload\.length === 0/)
    // 非 `data:` 行（event:/id:/注释/: 心跳）必须原样，不能被 JSON.parse 吞
    expect(line).toMatch(/startsWith\('data:'\)\)\s*return line/)

  })

  it('⚠️ 无 body 的 Response 必须原样返回（别构造出 null body 把流断掉）', () => {
    const wrap = scope.fn('astudioWrapIncremental')
    // 源码 src/astudio.ts L999 是一行内的 `null || undefined` 两段判空（fact 552 (h)：
    // 正则里写成 `\| \|` 会去匹配 `| |`，永远不中；跨行字面量更是直接语法错）。
    expect(wrap).toMatch(/response\.body === null \|\| response\.body === undefined\)\s*return response/)
  })

  it('⚠️ 包装器必须保留上游 status/statusText，且只在缺 Content-Type 时补 text/event-stream', () => {
    const wrap = scope.fn('astudioWrapIncremental')
    expect(wrap).toMatch(/status: response\.status/)
    expect(wrap).toMatch(/statusText: response\.statusText/)
    expect(wrap).toMatch(/!headers\.has\('content-type'\)/)
  })

  it('⚠️ 增量状态必须按 (id, 通道, choiceIndex[, toolCallIndex]) 分键（混键会让思考文本污染正文）', () => {
    const rewrite = scope.fn('astudioRewriteSsePayload')
    expect(rewrite).toMatch(/`\$\{id\}:c:\$\{index\}`/)
    expect(rewrite).toMatch(/`\$\{id\}:r:\$\{index\}`/)
    expect(rewrite).toMatch(/`\$\{id\}:t:\$\{index\}:\$\{slot\}`/)
    // 缺 id 时要有稳定兜底键，不能全落到同一个桶
    expect(rewrite).toMatch(/anon:\$\{index\}/)
  })

  it('⚠️ state 必须写 `before + after`（只写 after 会把已发文本忘掉 ⇒ 重复播报）', () => {
    const rewrite = scope.fn('astudioRewriteSsePayload')
    const sends = rewrite.match(/state\.set\([^)]*\{ sent: before \+ after \}/g) ?? []
    expect(sends).toHaveLength(3) // content / reasoning_content / tool_calls.arguments
  })

  it('⚠️ 丢弃空帧前必须先看 finish_reason（丢了带 finish_reason 的帧 ⇒ 下游没有终态）', () => {
    const empty = scope.fn('isAllEmptyDelta')
    expect(empty).toMatch(/typeof entry\.finish_reason === 'string'\) return false/)
    // 非字符串值（tool_calls 数组等）也一律不判空
    expect(empty).toMatch(/return false \/\/|return false\n/)
  })

  /** 【D4｜fact 478 ④】长上下文模型可能 >45s，官方 stream_idle_timeout_ms=300000。 */
  it('⚠️ chunkTimeoutMs 必须 ≥300_000（当前 product 是 120_000，依赖 fact 478 ④ 的改动）', () => {
    const product = readFileSync(join(SRC_DIR, 'astudio-product.ts'), 'utf8')
    // ⚠️ 不能用 indexOf('chunkTimeoutMs:') 定位：第一个命中的是**接口字段声明**
    // `chunkTimeoutMs: number`（无数字字面量）⇒ 取值落空变 NaN（fact 552 第三节 (i)）。
    // 直接对全文要求「数字开头」的那一处赋值。
    const value = Number((product.match(/chunkTimeoutMs:\s*(\d[\d_]*)/)?.[1] ?? '').replace(/_/g, ''))

    expect(value).toBeGreaterThanOrEqual(300_000)
  })
})

// ════════════════════════════════════════════════════════════════════════
describe('astudioIncrementalDelta —— 五格全覆盖', () => {
  it('① incoming 为空 → 空串（没新东西，别吐空 chunk）', () => {
    expect(astudioIncrementalDelta('已经发过的一整段', '')).toBe('')
    expect(astudioIncrementalDelta('', '')).toBe('')
  })

  it('② previous 为空 → 原样吐出（首帧）', () => {
    expect(astudioIncrementalDelta('', '你好')).toBe('你好')
  })

  it('③ 两者相等 → 空串（重复全量必须被吞，否则客户端看到翻倍文本）', () => {
    expect(astudioIncrementalDelta('你好世界', '你好世界')).toBe('')
  })

  it('④ incoming 以 previous 开头 → 只回新增尾巴（**累积全文**的主路径）', () => {
    expect(astudioIncrementalDelta('你好', '你好世界') ).toBe('世界')
    expect(astudioIncrementalDelta('你好世界', '你好世界！')).toBe('！')
    // 完全相同的边界：previous 是 incoming 的前缀且 incoming 更长
    expect(astudioIncrementalDelta('ab', 'ab')).toBe('')
  })

  it('⑤ previous 以 incoming 开头（乱序/重放的**旧**全量）→ 空串（绝不能把旧文本再播一遍）', () => {
    expect(astudioIncrementalDelta('你好世界', '你好')).toBe('')
    expect(astudioIncrementalDelta('你好世界', '')).toBe('')
  })

  it('⑥ 互不为前缀（上游换了新的一段/不同 id）→ 原样吐 incoming（保守放行，不丢内容）', () => {
    expect(astudioIncrementalDelta('你好', 'hello')).toBe('hello')
    expect(astudioIncrementalDelta('第一段结束', '第二段开始')).toBe('第二段开始')
  })

  it('⚠️ 多字节/代理对安全：中文字符串按码元比较也不能切出半个字符', () => {
    const full = '模型能力反代测试'
    let sent = ''
    for (let i = 1; i <= full.length; i++) {
      const piece = astudioIncrementalDelta(sent, full.slice(0, i))
      sent += piece
      expect(sent).toBe(full.slice(0, i))
    }
    expect(sent).toBe(full)
  })
})

// ════════════════════════════════════════════════════════════════════════
describe('astudioRewriteSsePayload —— 幂等透传 / 累积改写 / 丢弃 / 乱序旧全量', () => {
  it('⚠️ 标准增量（实测上游形态）必须**逐字透传**：changed=false 且 payload 字节不变', () => {
    const state = freshState()
    const first = chunk('你')
    const r1 = astudioRewriteSsePayload(first, state)
    expect(r1.changed).toBe(false)
    expect(r1.payload).toBe(first)

    const second = chunk('好')
    const r2 = astudioRewriteSsePayload(second, state)
    expect(r2.changed).toBe(false)
    expect(r2.payload).toBe(second)
    // 状态确实推进了（不是「没记」才碰巧透传）
    expect(state.get('chatcmpl-fixture-1:c:0')?.sent).toBe('你好')
  })

  it('累积全文 → 改写成增量（只裁 delta.content，其余字段原样）', () => {
    const state = freshState()
    expect(astudioRewriteSsePayload(chunk('你好'), state).payload).toBe(chunk('你好'))
    const r = astudioRewriteSsePayload(chunk('你好世界'), state)
    expect(r.changed).toBe(true)
    const rewritten = JSON.parse(r.payload as string) as { choices: Array<{ delta: { content: string } }> }
    expect(rewritten.choices[0].delta.content).toBe('世界')
    // 反向对照：id 等外层字段没被顺手改掉
    expect(rewritten).toHaveProperty('id', 'chatcmpl-fixture-1')
  })

  it('⚠️ 重复的同一份全量 → 裁成空 content ⇒ 整帧被丢弃（payload=null），而不是吐空 chunk', () => {
    const state = freshState()
    astudioRewriteSsePayload(chunk('你好'), state)
    const dup = astudioRewriteSsePayload(chunk('你好'), state)
    expect(dup.changed).toBe(true)
    expect(dup.payload).toBeNull()
    // 丢弃后状态不能被污染（下一帧的全量仍要能正确 diff）
    expect(state.get('chatcmpl-fixture-1:c:0')?.sent).toBe('你好')
    const next = astudioRewriteSsePayload(chunk('你好！'), state)
    expect(JSON.parse(next.payload as string).choices[0].delta.content).toBe('！')
  })

  it('⚠️ 乱序（更旧、更短的全量）→ 同样丢弃，绝不回放旧文本', () => {
    const state = freshState()
    astudioRewriteSsePayload(chunk('你好世界'), state)
    const stale = astudioRewriteSsePayload(chunk('你好'), state)
    expect(stale.payload).toBeNull()
    expect(state.get('chatcmpl-fixture-1:c:0')?.sent).toBe('你好世界')
  })

  it('带 finish_reason 的空 content 帧**不得**被丢弃（丢了就没有终态帧）', () => {
    const state = freshState()
    astudioRewriteSsePayload(chunk('你好'), state)
    const tail = astudioRewriteSsePayload(chunk('你好', { finish: 'stop' }), state)
    expect(tail.payload).not.toBeNull()
    const rewritten = JSON.parse(tail.payload as string) as { choices: Array<{ delta: { content: string }; finish_reason: string }> }
    expect(rewritten.choices[0].finish_reason).toBe('stop')
    expect(rewritten.choices[0].delta.content).toBe('')
  })

  it('思考文本走 delta.reasoning_content 独立通道（fact 380），与正文互不污染', () => {
    const state = freshState()
    astudioRewriteSsePayload(chunk('回答', { reasoning: '思考中' }), state)
    // 同一帧的两个通道都记各自的键
    expect(state.get('chatcmpl-fixture-1:c:0')?.sent).toBe('回答')
    expect(state.get('chatcmpl-fixture-1:r:0')?.sent).toBe('思考中')
    // 再来一份「思考中…」的全量：正文是新片段、思考是累积尾巴
    const r = astudioRewriteSsePayload(chunk('回答完', { reasoning: '思考中。' }), state)
    expect(r.changed).toBe(true)
    const d = (JSON.parse(r.payload as string) as { choices: Array<{ delta: Record<string, string> }> }).choices[0].delta
    expect(d.content).toBe('完')
    expect(d.reasoning_content).toBe('。')
  })

  it('⚠️ 只有 reasoning_content 的帧裁空后也必须丢弃（别把 `delta:{}` 播出去）', () => {
    const state = freshState()
    astudioRewriteSsePayload(chunk('', { reasoning: '思考' }), state)
    const dup = astudioRewriteSsePayload(chunk('', { reasoning: '思考' }), state)
    expect(dup.payload).toBeNull()
  })

  it('tool_calls.arguments 按 call index 分槽累积（同一帧里两个并行调用不能互相吃掉）', () => {
    const state = freshState()
    const r1 = astudioRewriteSsePayload(
      chunk('', { toolArgs: [{ index: 0, arguments: '{"a":' }, { index: 1, arguments: '{"b":' }] }),
      state,
    )
    // 首次出现 ⇒ 全部原样透传（before=''，after===arguments ⇒ changed=false）
    expect(r1.changed).toBe(false)
    expect(state.get('chatcmpl-fixture-1:t:0:0')?.sent).toBe('{"a":')
    expect(state.get('chatcmpl-fixture-1:t:0:1')?.sent).toBe('{"b":')
    // 第二帧给「两个调用的全量」（累积全文形态）：各自只留尾巴
    const r2 = astudioRewriteSsePayload(
      chunk('', { toolArgs: [{ index: 0, arguments: '{"a":1}' }, { index: 1, arguments: '{"b":2}' }] }),
      state,
    )
    expect(r2.changed).toBe(true)
    // 注：这里**不能**写成「外层括号 + 嵌套 `Array<{…}>` 类型断言 + 断言后跨行接
    // `.成员访问`」的一行式 —— esbuild（vitest transform）在该组合的行尾 `} })`
    // 处报 `Unexpected ">"`，整份文件 collect 失败（fact 529 第二节）。拆成两步。
    const parsed = JSON.parse(String(r2.payload)) as any
    const calls = parsed.choices[0].delta.tool_calls
    expect(calls[0].function.arguments).toBe('1}')
    expect(calls[1].function.arguments).toBe('2}')
  })

  it('没有 index 的 tool_call 落到 slot 0（上游首帧常省 index，不能拼出 `undefined` 键）', () => {
    const state = freshState()
    astudioRewriteSsePayload(chunk('', { toolArgs: [{ index: undefined as unknown as number, arguments: 'X' }] }), state)
    expect(state.get('chatcmpl-fixture-1:t:0:0')?.sent).toBe('X')
  })

  it('不同 id 之间完全隔离（同一连接里切换回复 id 不会串台）', () => {
    const state = freshState()
    astudioRewriteSsePayload(chunk('你好', { id: 'A' }), state)
    const b = astudioRewriteSsePayload(chunk('你好', { id: 'B' }), state)
    expect(b.changed).toBe(false)
    expect(b.payload).toBe(chunk('你好', { id: 'B' }))
  })

  it('⚠️ 非 chunk 形态一律原样（不能把别的负载当全文去 diff）', () => {
    const state = freshState()
    for (const payload of [
      '',
      '[DONE]',
      'not json',
      'null',
      '42',
      '[]',
      '{"id":"A"}', // 无 choices
      '{"id":"A","choices":[]}', // 空 choices
      '{"id":"A","choices":[{"index":0,"delta":{}}]}', // delta 里没有任何可 diff 的字符串字段
      '{"id":"A","choices":[{"index":0,"delta":{"role":"assistant","content":""}}]}', // 只有 role（changed=false）
      '{"id":"A","choices":[{"index":0,"delta":"not-an-object"}]}', // delta 非对象
      '{"id":"A","choices":[{"index":0,"message":{"content":"full"}}]}', // 非流式 message 形态
      '{"id":"A","choices":[{"index":0,"delta":{"content":null}}]}', // content 非字符串
      '{"id":"A","error":{"code":1002,"message":"过期"}}', // 流内错误帧：包装器不碰它
    ]) {
      const r = astudioRewriteSsePayload(payload, state)
      expect(r.payload, `payload 不该被改写：${payload.slice(0, 40)}`).toBe(payload)
      expect(r.changed).toBe(false)
    }
    // 【源码现状，fact 552 第三节 (j)】changed=false 也会登记空 sent：
    // src/astudio.ts 的 content 分支对 `typeof content === 'string'` 一律
    // state.set(key, { sent: before + after })，即便没产生新增量 ⇒ 键 'A:c:0' 以 sent=''
    // 入表（对后续 diff 无害，对首帧无害）。因此如实钉「最多一个空槽位」，不允许为此改 src。
    expect(state.size).toBeLessThanOrEqual(1)
    expect(state.get('A:c:0')?.sent).toBe('')

  })

  it('⚠️ 缺 id 的帧也照样能被 diff（兜底键稳定，不退化成「永远当首帧」）', () => {
    const state = freshState()
    const noId = JSON.stringify({ choices: [{ index: 0, delta: { content: '你好' } }] })
    expect(astudioRewriteSsePayload(noId, state).payload).toBe(noId)
    const grown = JSON.stringify({ choices: [{ index: 0, delta: { content: '你好吗' } }] })
    const r = astudioRewriteSsePayload(grown, state)
    expect(r.changed).toBe(true)
    expect((JSON.parse(r.payload as string) as { choices: Array<{ delta: { content: string } }> }).choices[0].delta.content).toBe('吗')
  })

  it('多 choice 各自独立（上游理论可回 n>1，别把两条流并进一个桶）', () => {
    const state = freshState()
    const payload = JSON.stringify({
      id: 'A',
      choices: [
        { index: 0, delta: { content: '甲' } },
        { index: 1, delta: { content: '乙' } },
      ],
    })
    expect(astudioRewriteSsePayload(payload, state).changed).toBe(false)
    expect(state.get('A:c:0')?.sent).toBe('甲')
    expect(state.get('A:c:1')?.sent).toBe('乙')
    const grown = JSON.stringify({
      id: 'A',
      choices: [
        { index: 0, delta: { content: '甲乙' } },
        { index: 1, delta: { content: '乙丙' } },
      ],
    })
    const r = astudioRewriteSsePayload(grown, state)
    const choices = (JSON.parse(r.payload as string) as { choices: Array<{ delta: { content: string } }> }).choices
    expect(choices[0].delta.content).toBe('乙')
    expect(choices[1].delta.content).toBe('丙')
  })
})

// ════════════════════════════════════════════════════════════════════════
describe('astudioWrapIncremental —— 端到端 SSE 字节流（透传与改写都要在流层面成立）', () => {
  it('⚠️ fact 352/363 实测的标准增量流必须**逐行透传**（含 [DONE]、含 usage 帧、空行心跳）', async () => {
    const lines = [
      'data: ' + chunk('你'),
      '',
      'data: ' + chunk('好'),
      'data: ' + chunk('！'),
      'data: {"id":"chatcmpl-fixture-1","choices":[],"usage":{"total_tokens":3}}',
      'data: ' + chunk('', { finish: 'stop' }),
      'data: [DONE]',
    ]
    const out = await pipeLines(...lines)
    // 每一行都原样（唯一允许的差异是尾随 \r 被裁掉，这里喂的就是 \n，所以应完全一致）
    expect(out).toBe(lines.join('\n') + '\n')
    expect(joinedContent(out)).toBe('你好！')
    expect(dataPayloads(out)).toContain('[DONE]')
  })

  it('累积全文流经包装器后变成增量，且拼接结果与原文一致（不重不漏）', async () => {
    const full = 'AStudio 反代流式增量测试文本'
    const lines: string[] = []
    for (let i = 1; i <= full.length; i++) lines.push('data: ' + chunk(full.slice(0, i)))
    lines.push('data: ' + chunk(full, { finish: 'stop' }))
    lines.push('data: [DONE]')
    const out = await pipeLines(...lines)
    expect(joinedContent(out)).toBe(full)
    // 中间那些「重复全量」被裁成空 content ⇒ 变成空行，但 [DONE] 必须还在
    expect(dataPayloads(out)).toContain('[DONE]')
    // 尾帧（带 finish_reason）不能被吞
    expect(out).toContain('"finish_reason":"stop"')
  })

  it('⚠️ 丢弃帧渲染成**空行**而不是删掉整行（行计数会变，但绝不能吞后续数据）', async () => {
    const out = await pipeLines('data: ' + chunk('你好'), 'data: ' + chunk('你好'), 'data: ' + chunk('你好世界'))
    const payloads = dataPayloads(out)
    expect(payloads).toHaveLength(2) // 首帧 + 尾巴
    expect(joinedContent(out)).toBe('你好世界')
  })

  it('非 data: 行（event:/id:/注释/心跳）原样保留', async () => {
    const out = await pipeLines(
      'event: message',
      'id: 42',
      ': keep-alive',
      'data: ' + chunk('你'),
    )
    expect(out).toContain('event: message')
    expect(out).toContain('id: 42')
    expect(out).toContain(': keep-alive')
    expect(joinedContent(out)).toBe('你')
  })

  it('跨 chunk 边界拆开的行不能被解析错（TransformStream 缓冲语义）', async () => {
    const payload = 'data: ' + chunk('你好世界') + '\n\ndata: [DONE]\n'
    const bytes = new TextEncoder().encode(payload)
    // 逐字节喂：最能暴露「按 read 块切行」的实现缺陷
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const b of bytes) controller.enqueue(new Uint8Array([b]))
        controller.close()
      },
    })
    const wrapped = astudioWrapIncremental(new Response(body, { status: 200 }))
    const out = await wrapped.text()
    expect(joinedContent(out)).toBe('你好世界')
    expect(dataPayloads(out)).toContain('[DONE]')
  })

  it('没有换行的尾块也必须在 flush 时被处理（否则最后一帧永远发不出去）', async () => {
    const out = await new Response(
      astudioWrapIncremental(new Response(new Blob(['data: ' + chunk('你好')]).stream(), { status: 200 })).body,
    ).text()
    expect(joinedContent(out)).toBe('你好')
  })

  it('保留上游 status 与 statusText；缺 Content-Type 时补 text/event-stream', async () => {
    const wrapped = astudioWrapIncremental(
      new Response(new Blob(['data: [DONE]\n']).stream(), { status: 200, statusText: 'OK' }),
    )
    expect(wrapped.status).toBe(200)
    expect(wrapped.statusText).toBe('OK')
    expect(wrapped.headers.get('Content-Type')).toContain('text/event-stream')

    const kept = astudioWrapIncremental(
      new Response(new Blob(['data: [DONE]\n']).stream(), { status: 400, headers: { 'Content-Type': 'application/json' } }),
    )
    expect(kept.status).toBe(400)
    expect(kept.headers.get('Content-Type')).toBe('application/json')
  })

  it('⚠️ null body 的 Response 原样返回（HEAD/204 之类不得被包成流）', () => {
    const bare = new Response(null, { status: 204 })
    expect(bare.body).toBeNull()
    const wrapped = astudioWrapIncremental(bare)
    expect(wrapped).toBe(bare)
    expect(wrapped.status).toBe(204)
  })

  it('流内错误帧原样透传，包装器不做判定（判失败是 consumeOpenAiSse 的职责，别两处都改）', async () => {
    const frame = 'data: {"id":"A","code":1002,"message":"登录已过期"}'
    const out = await pipeLines(frame)
    expect(dataPayloads(out)).toEqual([JSON.stringify({ id: 'A', code: 1002, message: '登录已过期' })])
    expect(out).not.toBe('')
  })
})
