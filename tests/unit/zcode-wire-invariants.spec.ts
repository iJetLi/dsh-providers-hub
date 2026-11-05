/**
 * ZCode **真实请求体**的不变式（2026-10-25 合并审计的 P0 补丁）。
 *
 * ## 为什么必须有这个文件
 *
 * `!151` 修的 405 本体有三条：身份块换官方新文本、18 个请求头、**调用方 system
 * 从 `system[]` 迁进 messages**。前两条的守卫当时只测「helper 的返回值」，
 * 第三条更是**一条都没有** —— 审计实测：把 `options.system` 重新 `push` 进
 * `system`（即把 405 的成因原样放回去）后，871 条 zcode 用例 + 双 `tsc`
 * **全绿**，`tsc` exit 0。也就是说：**下一次「顺手优化」会静默把 405 加回来，
 * 而整个仓库没有任何地方会红。**
 *
 * ## 判据刻意打在「真实请求体」上
 *
 * 本文件不测 `buildZcodeSystemBlocks(...)` 的返回值，而是让 `ZcodeAdapter.stream()`
 * 真的跑一次、把 `fetchImpl` 收到的 `init.body` 截下来解析。理由是审计反复实测过的
 * 那条教训：**断言 helper ≠ 断言接线**（helper 全绿、适配器把结果丢了，也一样过）。
 *
 * ## 变异验证（逐条「删掉修复必变红」）
 *
 * | 变异 | 期望 |
 * |---|---|
 * | `zcode-adapter.ts` 把 `system.push({type:'text',text:options.system})` 加回去 | 本文件红 |
 * | `zcode-adapter.ts` 把 `withCallerSystem(...)` 换回原 messages | 本文件红 |
 * | `zcode-upstream.ts` 把 `X-Os-Version` 换回真实 `os.release()` | 「平台三件套同源」红 |
 * | `zcode-upstream.ts` 把 `X-Session-Id` 换回模块级常量 | 「按账号分开」红 |
 * | 去掉 `ZCODE_APP_VERSION_PATTERN` 闸 | 「脏版本」红 |
 * | `zcode-diagnostics.ts` 不渲染 `systemBlocks` | 「诊断行块数」红 |
 * | `withCallerSystem` 回到 `first.role !== 'user' ⇒ return out` | 「首条非 user」红 |
 */
import { release as osRelease } from 'node:os'

import { describe, expect, it } from 'vitest'

import { ZcodeAdapter } from '../../src/zcode-adapter.js'
import { formatZcodeDiagnostic, describeZcodeRequestShape } from '../../src/zcode-diagnostics.js'
import { ModelGate } from '../../src/model-gate.js'
import { ZCODE } from '../../src/zcode-product.js'
import {
  ZCODE_VERSION_GATED_MIN_APP_VERSION,
  buildZcodeHeaders,
  zcodeClientPlatform,
  zcodeCredentialAppVersion,
  zcodeVersionGatedAppVersion,
  zcodeInferenceAppVersion,
  compareZcodeAppVersion,
  fetchZcodeModels,
} from '../../src/zcode-upstream.js'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { withCallerSystem } from '../../src/zcode-identity.js'

/* ────────────────────────── 桩 ────────────────────────── */

/** 一个能正常结束的 Anthropic SSE 响应。 */
function okSse(): Response {
  const text = [
    'event: message_start\ndata: {"type":"message_start","message":{"id":"m1","type":"message","role":"assistant"}}',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}',
    'event: message_stop\ndata: {"type":"message_stop"}',
    '',
  ].join('\n\n')
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(text))
        controller.close()
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  )
}

function makeAdapter(): { adapter: ZcodeAdapter; bodies: string[]; headers: Array<Record<string, string>> } {
  const bodies: string[] = []
  const headers: Array<Record<string, string>> = []
  const adapter = new ZcodeAdapter({
    credentialRef: 'R' as never,
    resolveCredential: async () => ({ zcode_jwt: 'jwt-A', device_mid: 'mid-A', app_version: '3.14.3' }),
    refresh: async () => {},
    mintCaptcha: async () => 'param',
    fetchImpl: (async (_url: string, init: RequestInit) => {
      bodies.push(typeof init.body === 'string' ? init.body : '')
      headers.push((init.headers ?? {}) as Record<string, string>)
      return okSse()
    }) as never,
    gate: new ModelGate({ sleep: async () => {} }),
    sleep: async () => {},
    product: ZCODE,
  })
  return { adapter, bodies, headers }
}

async function drain(iterable: AsyncIterable<unknown>): Promise<void> {
  for await (const _ of iterable) { /* 只为让请求真的发出去 */ }
}

const CALLER = '★★ CALLER-SYSTEM-MARKER ★★ 这些是 DSH 的规则。'

/* ────────────────── 一、真实请求体：system 恒 3 块、caller 走 messages ────────────────── */

describe('★★ system 恒为官方 3 块，调用方 system 走 messages（405 的本体）', () => {
  it('★★ 真实请求体里 system.length === 3，且 caller 一次都不在 system 里', async () => {
    const { adapter, bodies } = makeAdapter()
    await drain(adapter.stream({
      provider: 'zcode',
      model: 'GLM-5.3-Flash',
      messages: [{ role: 'user', content: 'hi' }],
      system: CALLER,
    } as never))

    const sent = JSON.parse(bodies[0] ?? '{}') as {
      system?: Array<{ text?: string }>
      messages?: Array<{ role?: string; content?: unknown }>
    }
    const system = sent.system ?? []
    // ① 块数 —— 这是 405 的判据（4 块恒 405，与第 4 块长度无关）。
    expect(system).toHaveLength(3)
    // ② 前三块的身份段自检（35 + 2608 + environment），别只数块数。
    expect(system[0]?.text).toHaveLength(35)
    expect(system[1]?.text).toHaveLength(2608)
    expect(system[2]?.text?.startsWith('# Environment')).toBe(true)
    // ③ caller 绝不能出现在 system 里（放回去 = 405）
    expect(JSON.stringify(system), '调用方 system 又回到 system 数组里了 ⇒ 必然 405+3012')
      .not.toContain(CALLER)
  })

  it('★★ caller 在 messages 里恰好出现 1 次，且排在日期块之后', async () => {
    const { adapter, bodies } = makeAdapter()
    await drain(adapter.stream({
      provider: 'zcode',
      model: 'GLM-5.3-Flash',
      messages: [{ role: 'user', content: 'hi' }],
      system: CALLER,
    } as never))

    const sent = JSON.parse(bodies[0] ?? '{}') as {
      messages?: Array<{ role?: string; content?: unknown }>
    }
    const wire = JSON.stringify(sent.messages ?? [])
    const occurrences = wire.split(CALLER).length - 1
    expect(occurrences, 'caller 在 messages 里必须恰好 1 次（0=丢了，>1=重复注入）').toBe(1)

    const firstContent = (sent.messages ?? [])[0]?.content
    expect(Array.isArray(firstContent)).toBe(true)
    const texts = (firstContent as Array<{ text?: string }>).map(block => block.text ?? '')
    // 官方形态是 [日期块, 用户正文, caller]
    expect(texts[0]?.startsWith('<system-reminder>'), '日期块必须仍在最前').toBe(true)
    expect(texts[texts.length - 1], 'caller 排在日期块之后（末尾）').toBe(CALLER)
  })
})

/* ────────────────── 二、请求头：平台三件套同源、session 按账号 ────────────────── */

describe('★★ 平台三件套必须同源（不得把真实 os.release 混进 Windows 标签）', () => {
  it('★★ 非 win32 宿主：三件套一起伪装，且用的是伪装内核号而不是本机真值', () => {
    // ⚠ **平台与内核版本都必须注入**：本机大概率是 win32，而且本机的
    //   `os.release()` 恰好等于伪装值 `10.0.26100` ⇒ 不注入就永远测不出来。
    const platform = zcodeClientPlatform('darwin', '24.6.0')
    expect(platform.osCategory).toBe('windows')
    expect(platform.platform.startsWith('win32')).toBe(true)
    // 核心：Windows 类别下不得出现本机真实内核号
    expect(platform.osVersion, '把真实内核号混进了 Windows 标签').not.toBe('24.6.0')
    expect(platform.osVersion).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it('★★ 头里的三件套必须整体取自同一来源（注入一组任意平台后逐字相等）', () => {
    // 刻意用一个**与本机无关**的值：任何硬编码（含 osRelease）都会被这条抓住。
    const injected = { platform: 'darwin-arm64', osCategory: 'darwin', osVersion: '24.6.0' }
    const headers = buildZcodeHeaders(
      { device_mid: 'mid-A', app_version: '3.14.3' },
      { platform: injected },
    )
    expect(headers['X-Platform']).toBe(injected.platform)
    expect(headers['X-Os-Category']).toBe(injected.osCategory)
    expect(headers['X-Os-Version'], '头里没有跟着注入的平台走 ⇒ 有硬编码').toBe(injected.osVersion)
  })

  it('★ win32 宿主：三件套取真值（不要为了「同源」把真平台也伪装掉）', () => {
    const real = zcodeClientPlatform('win32', '10.0.26100')
    expect(real.platform).toBe('win32-x64')
    expect(real.osCategory).toBe('windows')
    expect(real.osVersion).toBe('10.0.26100')
  })
})

describe('★★ X-Session-Id 必须按账号分开（不能全池共用一个）', () => {
  it('★★ 同一账号请求间恒定；不同账号必须不同', () => {
    const a1 = buildZcodeHeaders({ device_mid: 'mid-A', app_version: '3.14.3' })['X-Session-Id']
    const a2 = buildZcodeHeaders({ device_mid: 'mid-A', app_version: '3.14.3' })['X-Session-Id']
    const b1 = buildZcodeHeaders({ device_mid: 'mid-B', app_version: '3.14.3' })['X-Session-Id']
    expect(a1).toBe(a2)
    expect(a1, '两个账号共用同一个 X-Session-Id ⇒ 上游可把池里的号关联成同一会话')
      .not.toBe(b1)
  })
})

/* ────────────────── 三、版本号：同一请求一个口径 + 脏值闸 ────────────────── */

describe('★★ 版本号：门控口径与凭据口径各司其职，且脏值不得出网', () => {
  it('★★ 门控版 = max(凭据, 门槛值)，且是语义化比较不是字符串比较', () => {
    expect(zcodeVersionGatedAppVersion({ app_version: '3.14.3' })).toBe('3.17.1')
    // 字符串比较会在这里判错（'3.9.0' > '3.16.3'）⇒ 会**降级**
    expect(zcodeVersionGatedAppVersion({ app_version: '3.9.0' })).toBe('3.17.1')
    expect(zcodeVersionGatedAppVersion({ app_version: '3.17.2' })).toBe('3.17.2')
    // 语义化比较（与门槛值无关）：3.16.10 的 patch 比 3.16.3 大，但按字符串比 '3.16.10' < '3.16.3'
    expect(compareZcodeAppVersion('3.16.10', '3.16.3')).toBe(1)
    expect(compareZcodeAppVersion('3.17.10', '3.17.1')).toBe(1)
  })

  it('★★ 脏版本一律不许进请求（空串 / 换行注入 / 预发布号 / 非 semver）', () => {
    const dirty = [
      '',
      '   ',
      '3.16.3\r\nX-Injected: 1',
      '3.16.3-beta.1',
      'v3.16.3',
      '3.16',
      '3.016.3',
    ]
    for (const value of dirty) {
      // 门控口径：回落门槛值（绝不让预发布号「看起来更大」而绕过门控）
      expect(zcodeVersionGatedAppVersion({ app_version: value }), `门控口径漏了 ${JSON.stringify(value)}`)
        .toBe('3.17.1')
      // 非门控口径：回落兜底值（绝不让脏值进 URL/头）
      const plain = zcodeCredentialAppVersion({ app_version: value })
      expect(plain, `凭据口径放行了脏值 ${JSON.stringify(value)}`).not.toContain('\r')
      expect(plain).not.toContain('\n')
      expect(plain).toMatch(/^\d+\.\d+\.\d+$/)
    }
    // 合法值必须原样保留（否则「向前兼容」就没了）
    expect(zcodeCredentialAppVersion({ app_version: '3.17.2' })).toBe('3.17.2')
  })

  it('★★ 头里的版本可以被显式覆盖成与 query 一致（同一请求只有一个版本号）', () => {
    const credential = { device_mid: 'mid-A', app_version: '3.14.3' }
    // 默认：门控口径（405 的修法）
    expect(buildZcodeHeaders(credential)['X-ZCode-App-Version']).toBe('3.17.1')
    // 带 query app_version 的站点必须显式传同一个值，否则同请求两个版本号
    const pinned = buildZcodeHeaders(credential, { appVersion: zcodeCredentialAppVersion(credential) })
    expect(pinned['X-ZCode-App-Version']).toBe('3.14.3')
    expect(pinned['User-Agent']).toBe('ZCode/3.14.3')
  })

  it('★★ 真打一发：带 query app_version 的端点，头与 query 必须是同一个版本', async () => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = []
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push({ url: String(url), headers: (init.headers ?? {}) as Record<string, string> })
      return new Response('{}', { status: 500 })
    }) as never

    // ① 正常凭据：query 与头都应是凭据版本（而不是头 3.16.3 / query 3.14.3）
    await fetchZcodeModels(
      { zcode_jwt: 'jwt', device_mid: 'mid-A', app_version: '3.14.3' } as never,
      fetchImpl,
    )
    expect(seen).toHaveLength(1)
    const first = seen[0]!
    expect(new URL(first.url).searchParams.get('app_version')).toBe('3.14.3')
    expect(first.headers['X-ZCode-App-Version'], '同一请求里出现了两个版本号').toBe('3.14.3')

    // ② 脏凭据：即使值里带换行，也不得进头/URL（且两边回落成同一个值）
    seen.length = 0
    await fetchZcodeModels(
      { zcode_jwt: 'jwt', device_mid: 'mid-B', app_version: '3.16.3\r\nX-Injected: 1' } as never,
      fetchImpl,
    )
    expect(seen).toHaveLength(1)
    const dirty = seen[0]!
    expect(JSON.stringify(dirty.headers), '脏版本进了请求头').not.toContain('X-Injected')
    expect(new URL(dirty.url).searchParams.get('app_version')).not.toContain('\r')
    expect(dirty.headers['X-ZCode-App-Version'])
      .toBe(new URL(dirty.url).searchParams.get('app_version')!)
  })
})

/* ────────────────── 四、诊断行必须看得见块数 ────────────────── */

describe('★★ 诊断行必须渲染 system 块数（下次 405 报障的唯一现成出口）', () => {
  it('★★ 3 块与 4 块的诊断行必须不同，且都带块数', () => {
    const messages = [{ role: 'user', content: '<system-reminder>x</system-reminder>' }]
    const shape3 = describeZcodeRequestShape(
      [
        { type: 'text', text: 'a'.repeat(42) },
        { type: 'text', text: 'b'.repeat(2608) },
        { type: 'text', text: '# Environment' },
      ],
      messages as never,
    )
    const shape4 = describeZcodeRequestShape(
      [
        { type: 'text', text: 'a'.repeat(42) },
        { type: 'text', text: 'b'.repeat(2590) },
        { type: 'text', text: '# Environment' },
        { type: 'text', text: 'caller' },
      ],
      messages as never,
    )
    const line3 = formatZcodeDiagnostic({
      accountId: 'acct-A', sentAt: 0, status: 405, shape: shape3, now: 0,
    } as never)
    const line4 = formatZcodeDiagnostic({
      accountId: 'acct-A', sentAt: 0, status: 405, shape: shape4, now: 0,
    } as never)
    expect(line3).toContain('system 3 块')
    expect(line4).toContain('system 4 块')
    expect(line3, '3 块与 4 块（405 判据）的诊断行逐字相同 ⇒ 排查时看不出差异')
      .not.toBe(line4)
  })

  /**
   * ★★ Issue #45 的直接守卫：3012 的判据是「版本号与身份块**同代**」，
   * 只报身份块字符数不够 —— 报障者看不出「版本 3.17.2 + 3.16 身份块」。
   *
   * 判据打在**适配器真的抛出来的那句报文**上（不是 helper 的返回值）：
   * 接线把 `appVersion` 丢了，本用例必红。
   */
  it('★★ 3012 报文里必须带**实际发出的**版本号（与身份块相邻）', async () => {
    const adapter = new ZcodeAdapter({
      credentialRef: 'R' as never,
      resolveCredential: async () => ({ zcode_jwt: 'jwt-A', device_mid: 'mid-A', app_version: '3.14.3' }),
      refresh: async () => {},
      mintCaptcha: async () => 'param',
      fetchImpl: (async () => new Response(
        '{"code":3012,"msg":"request has been blocked due to unusual activity."}',
        { status: 405, headers: { 'content-type': 'application/json' } },
      )) as never,
      gate: new ModelGate({ sleep: async () => {} }),
      sleep: async () => {},
      product: ZCODE,
    })

    let error: unknown
    try {
      for await (const _chunk of adapter.stream({
        provider: 'zcode',
        model: 'GLM-5.3-Flash',
        messages: [{ role: 'user', content: 'hi' }],
      } as never)) { /* 读完即可 */ }
    } catch (caught) {
      error = caught
    }

    expect(error).toBeInstanceOf(LlmError)
    // 3012 必须仍是「别重试」的 PERMISSION（有冷却惩罚，降级成 SERVER 会白退避重试）
    expect((error as LlmError).code).toBe('PERMISSION')
    const message = String((error as LlmError).message)
    // 凭据写 3.14.3 ⇒ 实际发出的是门槛版 3.17.1（与身份块同代）
    expect(message).toContain('版本 3.17.1')
    expect(message).toContain('身份块 2643 字符(35+2608)')
    expect(message).toMatch(/身份块 2643 字符\(35\+2608\) · 版本 3\.17\.1 · 日期块/)
  })

  it('★ 诊断行的版本与请求头同源（zcodeInferenceAppVersion 是唯一出口）', () => {
    const credential = { device_mid: 'mid-A', app_version: '3.14.3' }
    expect(zcodeInferenceAppVersion(credential)).toBe('3.17.1')
    expect(zcodeInferenceAppVersion(credential))
      .toBe(buildZcodeHeaders(credential)['X-ZCode-App-Version'])
  })
})

/* ────────────────── 五、withCallerSystem：首条非 user 时不得静默丢失 ────────────────── */

describe('★★ withCallerSystem 的落点（不得静默蒸发）', () => {
  it('★★ 首条是 assistant 时，仍必须注入到第一条 user 消息里', () => {
    const out = withCallerSystem(
      [
        { role: 'assistant', content: '上一轮的回答' },
        { role: 'user', content: '第二轮的提问' },
      ] as never,
      CALLER,
    )
    const wire = JSON.stringify(out)
    expect(wire, 'caller 被静默丢弃了（DSH 的整份 system 不上行，且无任何日志）')
      .toContain(CALLER)
    const firstUser = out.find(message => message.role === 'user') as { content?: unknown }
    expect(JSON.stringify(firstUser.content)).toContain(CALLER)
  })

  it('★ 幂等：同一输入跑两次只注入一次', () => {
    const once = withCallerSystem([{ role: 'user', content: 'hi' }] as never, CALLER)
    const twice = withCallerSystem(once as never, CALLER)
    expect(JSON.stringify(twice).split(CALLER).length - 1).toBe(1)
  })

  it('★ 没有任何 user 消息时原样返回（没有合法落点）', () => {
    const input = [{ role: 'assistant', content: 'x' }]
    expect(withCallerSystem(input as never, CALLER)).toEqual(input)
  })
})
