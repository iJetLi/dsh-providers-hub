/**
 * ★★★ **Loomy（讯飞）是否能接受「带 DSH system」的请求**（Gitee issue IKXQMQ 排查）。
 *
 * > 「为啥讯飞用一个就被限流一个」—— @stalin-stephenson
 *
 * ## 假设
 *
 * `docs/agent-notes/providers-buddy.md` 记着腾讯系（CodeBuddy）会**按 system 里的
 * 客户端模板句把整轮拦死**（五条指纹，逐条实测）。Loomy **可能**也是这个形态：
 * 插件把 DSH 的 system prompt 原样发上去，上游按其中的身份句拦截。
 *
 * ## 三个用例（逐级对照）
 *
 * 1. **无 system** —— 基线，证明「账号 + 网络 + 模型」本身可用
 * 2. **带真实 DSH system** —— 如果这一步失败 ⇒ 就是这个假设
 * 3. **指纹脱敏后的 system** —— 把 DSH 身份句换成中性措辞，看是否放行
 *
 * ⚠️ 默认模型 `qwen3.8-flash`（x0.8，最便宜）；`maxTokens` 调到 **300**
 *（之前的 16 太小：模型的 reasoning 就吃完了、正文 0 字，会误判成「被拦」）。
 *
 * 闸门：`DSH_LOOMY_SYS_E2E=1` 且 `DSH_LOOMY_SYS_E2E_CONFIRM=yes`
 */
import { describe, expect, it } from 'vitest'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { LoomyAdapter } from '../../src/loomy-adapter.js'
import { LOOMY } from '../../src/loomy-product.js'
import type { LoomyCredential } from '../../src/loomy.js'
import { readLoomyCredentialsFromDshStore } from './loomy-credential.js'

const RUN = process.env.DSH_LOOMY_SYS_E2E === '1'
  && process.env.DSH_LOOMY_SYS_E2E_CONFIRM === 'yes'
const suite = RUN ? describe : describe.skip

const MODEL = process.env.DSH_LOOMY_SYS_MODEL ?? 'qwen3.8-flash'
const PROMPT = '只回复两个字：你好'

/**
 * **真实的 DSH system**（截取最具代表性的两句）。
 *
 * ⚠️ 第 1 句是 DSH 的**身份首句**（`docs/agent-notes/providers-buddy.md` 第 4 条指纹：
 *    「每轮必带、行首锚定」）；第 2 句是 Web 运行面的开头。
 *    Loomy 若按这两句拦截，这两个字面量就是触发点。
 */
const DSH_SYSTEM_RAW = [
  'You are an AI agent, powered by DeepSeek Harness.',
  '',
  'You are an AI coding assistant, powered by a large language model.',
  'You help users with software engineering tasks in their workspace.',
].join('\n')

/** **指纹脱敏**后的 system：把 DSH 的身份 token 换成中性措辞（workbuddy 那套做法）。 */
const DSH_SYSTEM_MASKED = [
  'You are an AI coding assistant, powered by a large language model.',
  '',
  'You help users with software engineering tasks in their workspace.',
].join('\n')

suite('Loomy 对 DSH system 的接受度（issue IKXQMQ）', () => {
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

  /** 跑一次，返回 { ok, status, errText, text, reasoningLen }。 */
  async function probe(system: string | undefined) {
    const adapter = makeAdapter(credential!)
    const text: string[] = []
    let reasoningLen = 0
    try {
      for await (const chunk of adapter.stream({
        provider: 'loomy',
        model: MODEL,
        ...(system === undefined ? {} : { system }),
        messages: [{ role: 'user', content: PROMPT }],
        maxTokens: 300,
      })) {
        if (chunk.type === 'text-delta') text.push(chunk.text)
        if (chunk.type === 'reasoning-delta') reasoningLen += chunk.text.length
      }
      const joined = text.join('')
      return { ok: true, text: joined, reasoningLen, errText: '' }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, text: text.join(''), reasoningLen, errText: message.slice(0, 400) }
    }
  }

  it('① 基线：**无 system** ⇒ 应当成功', async () => {
    expect(credential, '未找到 Loomy 凭据').toBeDefined()
    const r = await probe(undefined)
    console.log('\n[① 无 system]', JSON.stringify({ ok: r.ok, text: r.text.slice(0, 40), reasoningLen: r.reasoningLen, err: r.errText }))
    expect(r.ok, `无 system 都失败了：${r.errText}`).toBe(true)
  }, 180_000)

  it('② 带**真实 DSH system** ⇒ 看是否被拦', async () => {
    expect(credential, '未找到 Loomy 凭据').toBeDefined()
    const r = await probe(DSH_SYSTEM_RAW)
    console.log('\n[② DSH system 原文]', JSON.stringify({ ok: r.ok, text: r.text.slice(0, 40), reasoningLen: r.reasoningLen, err: r.errText }))
    // ⚠️ 这一条**不断言成功** —— 它是诊断项：失败就说明「DSH system 被拦」。
    console.log(r.ok ? '  ⇒ DSH system 可用（不被拦）' : '  ⇒ DSH system 失败，需要脱敏')
  }, 180_000)

  it('③ **指纹脱敏后** ⇒ 看是否恢复', async () => {
    expect(credential, '未找到 Loomy 凭据').toBeDefined()
    const r = await probe(DSH_SYSTEM_MASKED)
    console.log('\n[③ 脱敏 system]', JSON.stringify({ ok: r.ok, text: r.text.slice(0, 40), reasoningLen: r.reasoningLen, err: r.errText }))
    console.log(r.ok ? '  ⇒ 脱敏后可用' : '  ⇒ 脱敏也没用（不是 system 的问题）')
  }, 180_000)
})
