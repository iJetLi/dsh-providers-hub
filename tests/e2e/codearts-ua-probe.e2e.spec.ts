/**
 * CodeArts 推理请求的 `User-Agent` 真机探针（华为 WAF 前缀拒发，2026-11-05）。
 *
 * ## 为什么必须真机（单测锁不住什么）
 *
 * 单测（`tests/unit/codearts-user-agent.spec.ts`）只能锁住「我们**发了**哪个 UA」，
 * **锁不住那个 UA 到底过不过 WAF** —— 后者是上游策略，随时可能变。
 * 用户报障原文：「CodeArts 出现提示 **API 密钥无效**，把请求的 UA 改成 VSCode 的
 * 就能用」。真机 A/B（同账号 / 同签名 / 逐字节同 body，只改 UA）：
 *
 * | `User-Agent` | 结果 |
 * |---|---|
 * | `deepseek-harness/0.2.1-rc.2 (+https://…)` | **403 `TM.00000001` 网络繁忙** |
 * | `deepseek-harness/0.2.1`（无 url 段） | **403** |
 * | `deepseek-harness`（无 `/版本`）/ `deepseek-harness-x/1.0` | 200 |
 * | `VSCode/1.95.3` / `Mozilla/5.0 …` / `curl/8.4.0` | 200 |
 * | `claude-code` / `opencode` / `cline` | 200（**不是**「拦所有 AI 客户端」） |
 *
 * 403 响应带 `server: CW` + `set-cookie: HWWAFSESID=…` ⇒ **WAF 侧**，
 * 不是 APIG 验签（UA **不参与**签名，覆盖它不会打破验签）。
 *
 * ## 症状链（为什么这条探针值得留）
 *
 * 403 → `httpErrorCode` 的 `401/403 → 'AUTH'` → 客户端把 message 整条换成
 * 「API 密钥无效」（`dsh-client-ui-chat` 的 `message.failure.auth`）⇒ 用户以为凭据坏了，
 * 而凭据完全有效；且 `isAuthError` 对 403 恒真 ⇒ 每次失败**白跑一次**凭据续期，
 * 而 CodeArts 的 `refresh_token` 是**一次性轮换**的 ⇒ 有真实代价。
 *
 * ## 闸门
 *
 * `DSH_CODEARTS_E2E=1`（与 `v4-models.e2e.spec.ts` 同款），默认跳过。
 * 需要 DSH 凭据存储里有一个可用的 CodeArts 账号（只读，**不刷新**）。
 */
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { describe, expect, it } from 'vitest'
import { CodeArtsAdapter } from '../../src/llm-adapter.js'
import { readCodeArtsCredentialsFromDshStore } from './codearts-credential.js'

const E2E = process.env.DSH_CODEARTS_E2E === '1'

/** 官方 CodeArts IDE 内核的真实 UA（逐字取自 `--user-agent=` 启动参数）。 */
const CODEARTS_IDE_UA = 'codearts/1.0.0-1147257973136832'

describe.runIf(E2E)('codearts User-Agent（华为 WAF 真机）', () => {
  it(
    '推理请求带官方 IDE 的 UA，且上游真的出流',
    async () => {
      const [entry] = readCodeArtsCredentialsFromDshStore()
      expect(entry, '需要 DSH 凭据存储里有一个 CodeArts 账号（CODEARTS_ACCOUNT_* 或 CODEARTS_ACCESS_TOKEN）')
        .toBeDefined()

      /** 出站 chat 请求的 UA（**只记一次**：一条 stream 只该发一条 chat）。 */
      const chatUserAgents: (string | null)[] = []
      const adapter = new CodeArtsAdapter({
        credentialRef: credentialRef(entry!.ref),
        resolveCredential: async () => entry!.credential,
        // ⚠️ 探针**绝不**真续期（`refresh_token` 一次性轮换，用掉就废）。
        refresh: async () => { throw new Error('e2e: 探针不得触发凭据续期') },
        fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
          if (String(input).includes('/chat/completions')) {
            chatUserAgents.push(new Headers(init?.headers).get('user-agent'))
          }
          return fetch(input as never, init as never)
        }) as typeof fetch,
      })

      const texts: string[] = []
      for await (const chunk of adapter.stream({
        provider: 'codearts',
        model: 'glm-5.3-flash',
        messages: [{ role: 'user', content: 'Reply with exactly this text and nothing else: UA_OK' }],
        signal: new AbortController().signal,
      } as never)) {
        if (chunk.type === 'text-delta') texts.push(chunk.text)
      }

      // ① 头判据（我们发的是官方 IDE 身份，不是宿主默认值）。
      expect(chatUserAgents.length).toBeGreaterThan(0)
      for (const ua of chatUserAgents) expect(ua).toBe(CODEARTS_IDE_UA)
      // ② 行为判据（WAF 放行 ⇒ 真出流）。
      expect(texts.join('')).toContain('UA_OK')
    },
    120_000,
  )
})
