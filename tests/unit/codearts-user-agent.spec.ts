/**
 * CodeArts 推理请求的 `User-Agent` 守卫（华为 WAF 前缀拒发，2026-11-05 真机）。
 *
 * ## 为什么这个文件存在
 *
 * 用户报障「CodeArts 模型用不了，提示 **API 密钥无效**，把 UA 改成 VSCode 的就能用」。
 * 真机实测（同账号 / 同签名 / 逐字节同 body，只改 UA）：
 *
 * | `User-Agent` | 结果 |
 * |---|---|
 * | `deepseek-harness/0.2.1-rc.2 (+https://…)`（宿主 `attributionHeaders()` 默认值） | **403 `TM.00000001` 网络繁忙** |
 * | `deepseek-harness/0.2.1` / `deepseek-harness/0.2` / `deepseek-harness/1.2.3` | **403** |
 * | `deepseek-harness`（无 `/版本`）/ `deepseek-harness-x/1.0` / `DEEPSEEK-HARNESS/1.0` | 200 |
 * | `VSCode/1.95.3` / `Mozilla/5.0 …` / `curl/8.4.0` / `claude-code/1.0.0` / `opencode/1.0.0` | 200 |
 *
 * ⇒ 拒发判据是**大小写敏感的前缀 `deepseek-harness/`**（4 个账号、交替顺序 3 轮可复现）。
 * 且 403 响应带 `server: CW` + `set-cookie: HWWAFSESID=…` ⇒ **WAF 侧**，不是 APIG 验签。
 *
 * ## 为什么这条守卫必须存在（症状链）
 *
 * 1. WAF 回 403 ⇒ `httpErrorCode` 的 `401/403 → 'AUTH'` 分支；
 * 2. 客户端把 `AUTH` 的 message **整条换成「API 密钥无效」**
 *    （`dsh-client-ui-chat` 的 `message.failure.auth`）⇒ 用户以为凭据坏了；
 * 3. 且 `isAuthError` 对 403 恒真 ⇒ 每次失败**白跑一次凭据续期**，
 *    而 CodeArts 的 `refresh_token` 是**一次性轮换**的
 *    （见 `tests/e2e/codearts-credential.ts` 的注释）⇒ 不是无害副作用。
 *
 * ## 判据为什么写成**字面量**
 *
 * 断言 `headers.get('user-agent') === CODEARTS_USER_AGENT` 会是同义反复
 * （改常量两边一起变，恒绿）。故这里写**字面量** `'codearts/1.0.0-1147257973136832'`
 * —— 它逐字取自本机 CodeArts Agent 内核的启动参数
 *（`kernel_error_*.log` 里的 `--user-agent=codearts/1.0.0-1147257973136832`）。
 */
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { describe, expect, it } from 'vitest'
import { CodeArtsAdapter } from '../../src/llm-adapter.js'
import type { CodeArtsCredential } from '../../src/types.js'

const CREDENTIAL_REF = credentialRef('CODEARTS_ACCESS_TOKEN')

const validCredential: CodeArtsCredential = {
  access_key_id: 'AK', secret_access_key: 'SK', security_token: 'ST',
  expires_at: '2099-01-01T00:00:00Z',
}

/** 官方 CodeArts IDE 内核的真实 UA（逐字取自 `--user-agent=` 启动参数）。 */
const CODEARTS_IDE_UA = 'codearts/1.0.0-1147257973136832'

/** WAF 的拒发前缀（**大小写敏感**，实测 `DEEPSEEK-HARNESS/1.0` 放行）。 */
const WAF_DENIED_PREFIX = 'deepseek-harness/'

interface Captured {
  url: string
  userAgent: string | null
}

/**
 * 跑一次 `stream()`，抓每个出站请求的 URL 与 `user-agent`。
 *
 * ⚠️ 排队状态探测返回 `working`（本文件不覆盖排队语义，只收集头）；chat 回一段
 * 合法 SSE 让 `stream()` 正常结束 —— 否则会落到「排队重试 180 次」那条路径。
 */
async function captureOutboundUserAgents(): Promise<Captured[]> {
  const captured: Captured[] = []
  const adapter = new CodeArtsAdapter({
    credentialRef: CREDENTIAL_REF,
    resolveCredential: async () => validCredential,
    refresh: async () => { throw new Error('guard: 不应触发续期') },
    fetchImpl: async (input, init) => {
      const url = String(input)
      const headers = new Headers(init?.headers)
      captured.push({ url, userAgent: headers.get('user-agent') })
      if (url.includes('/queue/status')) {
        return new Response(JSON.stringify({ status: 'working' }), {
          status: 200, headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(
        'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    },
  })

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  for await (const _chunk of adapter.stream({
    model: 'GLM-5.2',
    messages: [],
  } as never)) { /* 读完即可 */ }

  return captured
}

describe('CodeArts 推理请求的 User-Agent', () => {
  it('chat 请求带官方 IDE 的 UA（不是宿主的 deepseek-harness）', async () => {
    const captured = await captureOutboundUserAgents()
    const chat = captured.filter(entry => entry.url.includes('/chat/completions'))
    expect(chat).toHaveLength(1)
    // 字面量断言：改常量（例如换回宿主默认值）会精确变红。
    expect(chat[0]!.userAgent).toBe(CODEARTS_IDE_UA)
  })

  // ⚠️ 这条是**判据本身**：WAF 拒的是前缀，只要有一个出站请求带着它，
  // 那一次请求就必然 403 ⇒ 症状链全套复发。逐请求点名而不是只看 chat。
  it('任何出站请求都不得带 WAF 拒发前缀（大小写敏感）', async () => {
    const captured = await captureOutboundUserAgents()
    expect(captured.length).toBeGreaterThan(0)
    for (const entry of captured) {
      expect(
        entry.userAgent?.startsWith(WAF_DENIED_PREFIX) ?? false,
        `${entry.url} 带了 WAF 拒发 UA：${String(entry.userAgent)}`,
      ).toBe(false)
    }
  })

  // ⚠️ 反向对照：判据若写成「UA 恒等于某值」会把「适配器不显式设置 UA 的 GET」
  // 误伤成红。这里钉住「GET 不设 UA 也被允许」—— 适配器只构造 Headers、不补 UA，
  // 上线的实际值是 Node `fetch` 自己补的 `user-agent: node`（本机抓头实测，WAF 放行）。
  it('排队状态 GET 不显式设置 UA（判据只拦前缀，不要求每条请求都有 UA）', async () => {
    const captured = await captureOutboundUserAgents()
    const queue = captured.filter(entry => entry.url.includes('/queue/status'))
    for (const entry of queue) expect(entry.userAgent).toBeNull()
  })
})
