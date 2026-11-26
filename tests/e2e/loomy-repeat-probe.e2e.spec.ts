/**
 * ★★★ **复现「讯飞（Loomy）用一个就被限流一个」**（Gitee issue IKXQMQ）。
 *
 * 前面的探针已证明：**单次请求 200、DSH system 也不拦**。
 * ⇒ 「限流」只能是**连续性/额度/并发**层面的。
 *
 * 本文件连发 `N` 次（默认 3，可用 `DSH_LOOMY_REPEAT_N` 覆盖），**间隔 2s**，
 * 记录每次的：成功/失败、错误类型、错误文案。
 *
 * ⚠️ **按次数省积分**：`maxTokens: 40`。
 * 闸门：`DSH_LOOMY_REPEAT_E2E=1` 且 `DSH_LOOMY_REPEAT_E2E_CONFIRM=yes`
 */
import { describe, expect, it } from 'vitest'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { LoomyAdapter } from '../../src/loomy-adapter.js'
import { LOOMY } from '../../src/loomy-product.js'
import type { LoomyCredential } from '../../src/loomy.js'
import { readLoomyCredentialsFromDshStore } from './loomy-credential.js'

const RUN = process.env.DSH_LOOMY_REPEAT_E2E === '1'
  && process.env.DSH_LOOMY_REPEAT_E2E_CONFIRM === 'yes'
const suite = RUN ? describe : describe.skip
const MODEL = process.env.DSH_LOOMY_REPEAT_MODEL ?? 'qwen3.8-flash'
const N = Number(process.env.DSH_LOOMY_REPEAT_N ?? '3')

suite('Loomy 连续请求（issue IKXQMQ：用一个就被限流一个）', () => {
  const entries = readLoomyCredentialsFromDshStore()
  const credential = entries[0]?.credential

  function makeAdapter(cred: LoomyCredential): LoomyAdapter {
    return new LoomyAdapter({
      credentialRef: credentialRef('LOOMY_E2E'),
      resolveCredential: async () => cred,
      refresh: async () => { throw new Error('Loomy 不可续期') },
      accountPool: undefined,
      product: LOOMY,
    })
  }

  it(`★★★ 连发 ${N} 次，逐次记录结果`, async () => {
    expect(credential, '未找到 Loomy 凭据').toBeDefined()
    const rows: Array<Record<string, unknown>> = []
    for (let i = 1; i <= N; i += 1) {
      const adapter = makeAdapter(credential!)
      const started = Date.now()
      let text = ''
      let reasoningLen = 0
      let err = ''
      let errName = ''
      try {
        for await (const chunk of adapter.stream({
          provider: 'loomy',
          model: MODEL,
          messages: [{ role: 'user', content: `第 ${i} 次：只回复两个字：你好` }],
          maxTokens: 40,
        })) {
          if (chunk.type === 'text-delta') text += chunk.text
          if (chunk.type === 'reasoning-delta') reasoningLen += chunk.text.length
        }
      } catch (error) {
        errName = error instanceof Error ? error.constructor.name : typeof error
        err = (error instanceof Error ? error.message : String(error)).slice(0, 300)
      }
      const ok = err === ''
      rows.push({ i, ok, ms: Date.now() - started, text: text.slice(0, 20), reasoningLen, errName, err })
      console.log(`  [第 ${i} 次]`, JSON.stringify(rows[rows.length - 1]))
      if (i < N) await new Promise((r) => setTimeout(r, 2000))
    }
    const failed = rows.filter((r) => r.ok !== true)
    console.log(`\n  汇总：${rows.length - failed.length}/${rows.length} 成功`)
    if (failed.length > 0) {
      console.log('  失败样本：', JSON.stringify(failed[0]))
    }
    // ⚠️ 诊断用例：不硬断言，只输出。失败本身就报障现象。
  }, 300_000)
})
