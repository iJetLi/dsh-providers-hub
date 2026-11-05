/**
 * ZCode provider 单元测试。
 *
 * 覆盖**纯函数**与**序列化层**——那些「写错了不会报错、只会静默行为错」
 * 的部分（这正是 AGENTS.md 里 Qoder 三处缺陷的共同形态）。
 *
 * ⚠ 本文件**不再**测试「读本机官方客户端凭据」——那套能力已于 2026-10-05
 * 整体删除（用户决策：只用插件自己的 auth 流程）。防回退的锁在
 * `zcode-no-local-credential-read.spec.ts`。
 */
import { describe, expect, it } from 'vitest'
import {
  isUsableZcodeCredential,
  isZcodeExpired,
  phoneFromUserId,
  ZCODE_APP_VERSION_FALLBACK,
  ZCODE_REFRESHABLE,
} from '../../src/zcode.js'
import {
  validateCaptchaParam,
  findBrowserExecutable,
  ZCODE_CAPTCHA_FALLBACK,
  ALIYUN_CAPTCHA_SDK_URL,
} from '../../src/zcode-captcha.js'
import {
  OFFICIAL_CLI_PREFIX,
  OFFICIAL_IDENTITY_CHARS,
  OFFICIAL_STABLE_SECTIONS,
  buildContextPrefixBlock,
  buildZcodeSystemBlocks,
  withCallerSystem,
  formatLocalIsoDate,
  withContextPrefix,
} from '../../src/zcode-identity.js'
import {
  parseFrame,
  parseToolArguments,
  toAnthropicMessages,
  toAnthropicTools,
} from '../../src/zcode-anthropic.js'
import {
  buildZcodeHeaders,
  ZCODE_BILLING_BALANCE_URL,
  ZCODE_PLAN_MESSAGES_URL,
  ZCODE_VERSION_GATED_MIN_APP_VERSION,
} from '../../src/zcode-upstream.js'
import {
  describeUpstreamError,
  httpErrorCodeForZcode,
  isZcodeQuotaExhausted,
  isZcodeConcurrencyLimited,
} from '../../src/zcode-adapter.js'
import { toClaimOutcome, emptyCheckinStatus } from '../../src/zcode-auth.js'

// ─────────────────── 账号身份（手机号派生） ───────────────────

describe('ZCode 账号身份派生', () => {
  it('★ 手机号由 17 位 id 的前 11 位派生（上游不下发手机号字段）', () => {
    // 依据：扫遍 ~/.zcode/v2/*.json 后，唯一命中 11 位手机号形状的就是这个前缀。
    expect(phoneFromUserId('15951790100986814')).toBe('159****0100')
  })

  it('前缀不是合法手机号时不设 phone（宁可不显示，也不猜）', () => {
    // 前 11 位是 '88888888888'（不满足 /^1[3-9]/）⇒ 必须放弃。
    expect(phoneFromUserId('88888888888999888')).toBeUndefined()
    // 以 1 开头但第 2 位是 2 ⇒ 同样不是手机号。
    expect(phoneFromUserId('12888888888999888')).toBeUndefined()
    // 太短 ⇒ 无法取前 11 位。
    expect(phoneFromUserId('12345')).toBeUndefined()
    expect(phoneFromUserId(undefined)).toBeUndefined()
  })

  it('手机号脱敏成 前3 + **** + 后4（不泄露中间 4 位）', () => {
    const phone = phoneFromUserId('13800138000123456')
    expect(phone).toBe('138****8000')
    expect(phone).not.toContain('0138')
  })
})

// ─────────────────── 凭据判据 ───────────────────

describe('ZCode 凭据判据', () => {
  it('只要 zcode_jwt + device_mid 就算够用（其余字段都可选）', () => {
    expect(isUsableZcodeCredential({ zcode_jwt: 'j', device_mid: 'm' })).toBe(true)
  })

  it('缺任一必需字段即不可用，且不抛错', () => {
    expect(isUsableZcodeCredential({ zcode_jwt: 'j' })).toBe(false)
    expect(isUsableZcodeCredential({ device_mid: 'm' })).toBe(false)
    expect(isUsableZcodeCredential({ zcode_jwt: '', device_mid: 'm' })).toBe(false)
    expect(isUsableZcodeCredential(undefined)).toBe(false)
    expect(isUsableZcodeCredential(null)).toBe(false)
    expect(isUsableZcodeCredential('not-an-object')).toBe(false)
  })

  it('ZCode 凭据静态：不过期、不可续期', () => {
    // JWT payload 里没有 exp ⇒ 不做本地过期猜测，失效由上游 401/1002 表达。
    expect(isZcodeExpired({ zcode_jwt: 'j', device_mid: 'm' })).toBe(false)
    expect(ZCODE_REFRESHABLE).toBe(false)
  })

  it('版本兜底常量非空（请求头 X-ZCode-App-Version 用）', () => {
    expect(ZCODE_APP_VERSION_FALLBACK).toMatch(/^\d+\.\d+\.\d+$/)
  })
})

// ───────────────────────────── captcha ─────────────────────────────

describe('ZCode captcha param 校验', () => {
  /** 造一个合法 param。 */
  const goodParam = (): string => Buffer.from(JSON.stringify({
    certifyId: 'abc123',
    sceneId: '11xygtvd',
    isSign: true,
    securityToken: 'x'.repeat(128),
  })).toString('base64')

  it('合法 param 通过（长度 280 级别、securityToken 128）', () => {
    const param = goodParam()
    expect(param.length).toBeGreaterThanOrEqual(200)
    expect(validateCaptchaParam(param)).toEqual({ ok: true })
  })

  it('★ 降级输出（约 76 字符）被拒绝 —— 这正是「发了必 3007」的形态', () => {
    // 模拟 SDK 降级：短且没有 securityToken。
    const degraded = Buffer.from(JSON.stringify({ certifyId: 'x', securityToken: 'short' })).toString('base64')
    const verdict = validateCaptchaParam(degraded)
    expect(verdict.ok).toBe(false)
    expect(verdict.reason).toMatch(/长度/)
  })

  it('长度够但 securityToken 过短 → 拒绝', () => {
    const param = Buffer.from(JSON.stringify({
      certifyId: 'abc',
      securityToken: 'y'.repeat(20),
      padding: 'z'.repeat(250),
    })).toString('base64')
    const verdict = validateCaptchaParam(param)
    expect(verdict.ok).toBe(false)
    expect(verdict.reason).toMatch(/securityToken/)
  })

  it('缺 certifyId → 拒绝', () => {
    const param = Buffer.from(JSON.stringify({
      securityToken: 'x'.repeat(128),
      padding: 'z'.repeat(250),
    })).toString('base64')
    expect(validateCaptchaParam(param).ok).toBe(false)
  })

  it('非 base64/非 JSON → 拒绝（不抛错）', () => {
    expect(validateCaptchaParam(undefined).ok).toBe(false)
    expect(validateCaptchaParam('').ok).toBe(false)
    expect(validateCaptchaParam('!'.repeat(300)).ok).toBe(false)
  })

  it('兜底配置与 SDK 地址是实测值', () => {
    expect(ZCODE_CAPTCHA_FALLBACK).toEqual({ region: 'cn', prefix: 'no8xfe', sceneId: '11xygtvd' })
    expect(ALIYUN_CAPTCHA_SDK_URL).toBe(
      'https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js',
    )
  })

  it('findBrowserExecutable 在给了 ZCODE_CHROME_PATH 且文件存在时优先用它', () => {
    // 用 Node 可执行文件当替身（它一定存在）。
    const previous = process.env.ZCODE_CHROME_PATH
    process.env.ZCODE_CHROME_PATH = process.execPath
    try {
      expect(findBrowserExecutable()).toBe(process.execPath)
    } finally {
      if (previous === undefined) delete process.env.ZCODE_CHROME_PATH
      else process.env.ZCODE_CHROME_PATH = previous
    }
  })
})

// ───────────────────────────── 身份块 ─────────────────────────────

describe('ZCode 官方身份块（3012 准入）', () => {
  it('cliPrefix 是官方那 35 字符（3.17.x）', () => {
    expect(OFFICIAL_CLI_PREFIX).toBe('You are ZCode, an interactive agent')
    expect(OFFICIAL_CLI_PREFIX.length).toBe(35)
  })

  it('★ 身份块总长度与实测通过的量级一致（2355 级别）', () => {
    // 实测矩阵里「cliPrefix + stable」是准入必需的最小集合。
    // 此处断言的是**同一量级**（防止有人误删段落导致退回 3012）。
    expect(OFFICIAL_IDENTITY_CHARS).toBeGreaterThan(2300)
    expect(OFFICIAL_IDENTITY_CHARS).toBeLessThan(3000)
    expect(OFFICIAL_STABLE_SECTIONS.length).toBeGreaterThanOrEqual(2)
  })

  it('system 块第一块必须是 cliPrefix（顺序是准入判据的一部分）', () => {
    const blocks = buildZcodeSystemBlocks({ cwd: process.cwd() })
    expect(blocks[0]?.text).toBe(OFFICIAL_CLI_PREFIX)
    expect(blocks[1]?.text).toBe(OFFICIAL_STABLE_SECTIONS.join('\n\n'))
  })

  /**
   * ★★ **恒为 3 块** —— 2026-10-25 的实测修复。
   *
   * 此前本函数会把调用方的 system 追加成 `block[3]`。三轮对照实验
   * （同一账号、同一 URL 与全部 18 个请求头，只改请求体）证明：
   *
   * | system 块数 | 结果 |
   * |---|---|
   * | 3 块 | **HTTP 200** |
   * | 4 块（第 4 块 = 调用方 system，2 062 字符） | **HTTP 405 + 3012** |
   * | 4 块（同上，25 428 字符） | **HTTP 405 + 3012** |
   * | 3 块 + 调用方内容改放进 messages | **HTTP 200** |
   *
   * ⇒ 判据是**块数**，与第 4 块多长无关。故本函数不得再多产块。
   */
  it('★★ system 恒为 3 块（第 4 块会让上游回 405 + 3012）', () => {
    expect(buildZcodeSystemBlocks({ cwd: '.' })).toHaveLength(3)
    expect(buildZcodeSystemBlocks({ cwd: '.', model: 'glm-5.3' })).toHaveLength(3)
  })

  /**
   * 调用方 system 的落点是**首轮 user 消息**，不是 `system` 数组。
   * 见上面那条用例的对照实验表。
   */
  it('★★ 调用方 system 走 messages，不进 system 数组', () => {
    const caller = 'MY-CALLER-PROMPT'
    const blocks = buildZcodeSystemBlocks({ cwd: process.cwd() })
    expect(blocks.some((b) => b.text === caller)).toBe(false)

    const messages = withCallerSystem(
      [{ role: 'user', content: 'hello' }],
      caller,
    )
    const content = messages[0]?.content as Array<{ type: string; text: string }>
    expect(Array.isArray(content)).toBe(true)
    expect(content.at(-1)).toEqual({ type: 'text', text: caller })
  })

  it('withCallerSystem：空/缺失不产生空块，也不改消息形状', () => {
    const base = [{ role: 'user', content: 'hello' }]
    expect(withCallerSystem(base, undefined)).toEqual(base)
    expect(withCallerSystem(base, '')).toEqual(base)
    expect(withCallerSystem(base, '   ')).toEqual(base)
  })

  it('withCallerSystem：排在已有日期块**之后**（官方形态是日期块打头）', () => {
    const withDate = withContextPrefix([{ role: 'user', content: 'hello' }])
    const out = withCallerSystem(withDate, 'CALLER')
    const content = out[0]?.content as Array<{ text?: string }>
    expect(content[0]?.text?.startsWith('<system-reminder>')).toBe(true)
    expect(content.at(-1)?.text).toBe('CALLER')
  })

  it('withCallerSystem：幂等（重复调用不重复插入）', () => {
    const once = withCallerSystem([{ role: 'user', content: 'hello' }], 'CALLER')
    const twice = withCallerSystem(once, 'CALLER')
    const content = twice[0]?.content as Array<{ text?: string }>
    expect(content.filter((c) => c.text === 'CALLER')).toHaveLength(1)
  })

  it('withCallerSystem：首条不是 user 时原样返回（不抛错）', () => {
    const base = [{ role: 'assistant', content: 'hi' }]
    expect(withCallerSystem(base, 'CALLER')).toEqual(base)
    expect(withCallerSystem([], 'CALLER')).toEqual([])
  })

  /**
   * ★ 断点策略（2026-09-30 调整，此前是「每块都打」）。
   *
   * ## 为什么改
   *
   * Anthropic 的 prompt caching 是**前缀式**的：一个断点覆盖「它之前的全部内容」，
   * 故**一个位于最后一块的断点**与「每块各打一个」覆盖面相同。
   * 而断点有**数量上限（4 个）**：每块都打（3-4 块）会把预算用光，
   * 于是 `tools` 再也打不了点 —— 而 DSH 每步带 24 个工具、约 19KB schema
   *（`dsh-free-glm` 的 P0-2 实测）。
   *
   * ⇒ 收敛成「只最后一块」，预算留给 `withToolCacheBreakpoint()`。
   *
   * ⚠ 2026-10-25 起 system 恒为 3 块，故「最后一块」= environment 段。
   * 调用方 system 已移出 system（见上面的用例），它不再落在断点内 ——
   * 这是可接受的取舍：**争到 200 比争缓存重要**。
   *
   * 反向验证：改回「每块都打」⇒ 本条变红；同时断点总数会到 4-5 个，
   * 撞上「最多 4 个」的上限。
   */
  it('★ 只在最后一块打 cache_control（断点预算留给 tools）', () => {
    const blocks = buildZcodeSystemBlocks({ cwd: '.' })
    expect(blocks[blocks.length - 1]?.cache_control?.type).toBe('ephemeral')
    // 前面的块不再单独打点 —— 前缀式语义下它们的覆盖面已被最后那个包含。
    expect(blocks.slice(0, -1).every((b) => b.cache_control === undefined)).toBe(true)
  })

  it('★ system + tools 的断点总数不得超过 Anthropic 的上限（4）', () => {
    const blocks = buildZcodeSystemBlocks({ cwd: '.' })
    const systemBreakpoints = blocks.filter((b) => b.cache_control?.type === 'ephemeral').length
    // tools 侧固定 1 个（`withToolCacheBreakpoint` 只给最后一个工具打点）。
    const toolBreakpoints = 1
    expect(systemBreakpoints + toolBreakpoints).toBeLessThanOrEqual(4)
  })

  it('environment 段含工作目录与平台（缺了会让模型用相对路径瞎猜）', () => {
    const blocks = buildZcodeSystemBlocks({ cwd: 'D:\\proj', model: 'glm-5.3-flash' })
    const env = blocks[2]?.text ?? ''
    expect(env).toContain('D:\\proj')
    expect(env).toContain('Primary working directory')
    expect(env).toContain('zcode/glm-5.3-flash')
  })

  it('日期块用本地时区（不是 UTC）且带 6 空格缩进的 outro', () => {
    const block = buildContextPrefixBlock(new Date(2026, 8, 29, 23, 30))
    expect(block.text).toContain('Today\'s date is 2026-09-29.')
    expect(block.text).toContain('      IMPORTANT:')
    expect(block.text.startsWith('<system-reminder>')).toBe(true)
    expect(block.text.endsWith('</system-reminder>')).toBe(true)
  })

  it('formatLocalIsoDate 补零且用本地字段', () => {
    expect(formatLocalIsoDate(new Date(2026, 0, 5))).toBe('2026-01-05')
  })

  it('★ 首轮 user 消息被插入日期块（块数组形态，不是拼字符串）', () => {
    const out = withContextPrefix([{ role: 'user', content: 'hello' }], new Date(2026, 8, 29))
    const content = out[0]?.content
    expect(Array.isArray(content)).toBe(true)
    const arr = content as Array<{ type: string; text: string }>
    expect(arr[0]?.text).toContain('<system-reminder>')
    expect(arr[1]).toEqual({ type: 'text', text: 'hello' })
  })

  it('已经是数组的消息把日期块插在最前面', () => {
    const out = withContextPrefix(
      [{ role: 'user', content: [{ type: 'text', text: 'existing' }] }],
      new Date(2026, 8, 29),
    )
    const arr = out[0]?.content as Array<{ text?: string }>
    expect(arr[0]?.text).toContain('<system-reminder>')
    expect(arr[1]?.text).toBe('existing')
  })

  it('★ 幂等：已以 system-reminder 开头则不重复插', () => {
    const first = withContextPrefix([{ role: 'user', content: 'hi' }], new Date(2026, 8, 29))
    const second = withContextPrefix(
      first as Array<{ role: string; content: unknown }>,
      new Date(2026, 8, 29),
    )
    const arr = second[0]?.content as unknown[]
    expect(arr).toHaveLength(2) // 仍然是「日期块 + 原文」，没有变成 3 项
  })

  it('首轮不是 user 时不插（官方行为）', () => {
    const out = withContextPrefix([{ role: 'assistant', content: 'hi' }], new Date(2026, 8, 29))
    expect(out[0]?.content).toBe('hi')
  })

  it('空消息列表不抛错', () => {
    expect(withContextPrefix([])).toEqual([])
  })
})

// ───────────────────── Anthropic 协议转换 ─────────────────────

describe('ZCode Anthropic 协议转换', () => {
  it('assistant 的 tool_calls 转成 tool_use，且 arguments 字符串转**对象**', () => {
    const out = toAnthropicMessages([{
      role: 'assistant',
      content: '',
      tool_calls: [{
        id: 'call_1',
        type: 'function',
        function: { name: 'read', arguments: '{"path":"a.txt"}' },
      }],
    }])
    expect(out).toHaveLength(1)
    const content = out[0]?.content as Array<Record<string, unknown>>
    expect(content[0]).toMatchObject({ type: 'tool_use', id: 'call_1', name: 'read' })
    // ⚠ 关键：必须是**对象**，不是 JSON 字符串（Anthropic 规范）。
    expect(content[0]?.input).toEqual({ path: 'a.txt' })
  })

  it('★ role:tool 转成 user 里的 tool_result 块（不是独立的 tool 角色）', () => {
    const out = toAnthropicMessages([
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1', function: { name: 'f', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'result-text' },
    ])
    const last = out[out.length - 1]
    expect(last?.role).toBe('user')
    const content = last?.content as Array<Record<string, unknown>>
    expect(content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'c1', content: 'result-text' })
  })

  it('孤儿 tool 结果（无 tool_call_id）被丢弃 —— 否则 Anthropic 会 400', () => {
    const out = toAnthropicMessages([{ role: 'tool', content: 'orphan' }])
    expect(out).toHaveLength(0)
  })

  it('空 assistant 消息被丢弃（会让上游 400）', () => {
    expect(toAnthropicMessages([{ role: 'assistant', content: '' }])).toHaveLength(0)
  })

  it('多模态 user 消息的 image 块转成 Anthropic base64 形态', () => {
    const dataUrl = `data:image/png;base64,${Buffer.from('fake').toString('base64')}`
    const out = toAnthropicMessages([{
      role: 'user',
      content: [
        { type: 'text', text: 'look' },
        { type: 'image_url', image_url: { url: dataUrl } },
      ],
    }])
    const content = out[0]?.content as Array<Record<string, unknown>>
    expect(content[0]).toEqual({ type: 'text', text: 'look' })
    expect(content[1]).toMatchObject({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png' },
    })
  })

  it('工具表转成**扁平** input_schema（不是 OpenAI 的嵌套 function）', () => {
    const tools = toAnthropicTools([{
      name: 'read',
      description: 'Read a file',
      parameters: { type: 'object', properties: { path: { type: 'string' } } },
    }])
    expect(tools[0]).toEqual({
      name: 'read',
      description: 'Read a file',
      input_schema: { type: 'object', properties: { path: { type: 'string' } } },
    })
    // ⚠ 绝不能有 OpenAI 的 `function` 包装。
    expect(tools[0]).not.toHaveProperty('function')
  })

  it('无 parameters 的工具给空 object schema（不产生 undefined）', () => {
    const tools = toAnthropicTools([{ name: 'ping', description: '' }])
    expect(tools[0]?.input_schema).toEqual({ type: 'object', properties: {} })
    expect(tools[0]).not.toHaveProperty('description')
  })

  it('parseToolArguments 对残缺 JSON 返回哨兵（不静默补 {}）', () => {
    const parsed = parseToolArguments('{"broken":') as Record<string, unknown>
    // ⚠ 不能是 `{}` —— 那会被当成「无参数调用」并可能触发破坏性动作。
    expect(parsed).not.toEqual({})
    expect(parsed.__zcodeUnparsableArguments).toBeDefined()
  })

  it('parseToolArguments 对完全空的参数给 {}（工具确实可以无参数）', () => {
    expect(parseToolArguments('')).toEqual({})
    expect(parseToolArguments(undefined)).toEqual({})
    expect(parseToolArguments('{}')).toEqual({})
  })

  it('parseFrame 解析 event + data 行', () => {
    const frame = parseFrame('event: content_block_delta\ndata: {"type":"content_block_delta"}')
    expect(frame?.event).toBe('content_block_delta')
    expect(frame?.data).toBe('{"type":"content_block_delta"}')
  })

  it('parseFrame 支持多行 data（SSE 规范允许）', () => {
    const frame = parseFrame('data: line1\ndata: line2')
    expect(frame?.data).toBe('line1\nline2')
  })

  it('parseFrame 对空帧返回 undefined', () => {
    expect(parseFrame('')).toBeUndefined()
    expect(parseFrame(': comment only')).toBeUndefined()
  })
})

// ───────────────────────── 上游请求头与错误 ─────────────────────────

describe('ZCode 请求头与错误映射', () => {
  const credential = {
    zcode_jwt: 'jwt-value',
    device_mid: 'device-1234',
    app_version: '3.14.3',
  }

  it('★ 必须带 X-Device-Mid（缺它上游回 400 code 3001）', () => {
    const headers = buildZcodeHeaders(credential)
    expect(headers['X-Device-Mid']).toBe('device-1234')
  })

  it('Authorization 只在显式要求时出现（balance 需要、preview 不需要）', () => {
    expect(buildZcodeHeaders(credential)).not.toHaveProperty('Authorization')
    expect(buildZcodeHeaders(credential, { authorization: 'Bearer x' })).toHaveProperty('Authorization', 'Bearer x')
  })

  it('captcha 头成对出现（param + region）', () => {
    const headers = buildZcodeHeaders(credential, { captcha: { param: 'P', region: 'cn' } })
    expect(headers['x-aliyun-captcha-verify-param']).toBe('P')
    expect(headers['x-aliyun-captcha-verify-region']).toBe('cn')
  })

  it('JSON 头默认带，可用 json:false 关掉', () => {
    expect(buildZcodeHeaders(credential)['Content-Type']).toBe('application/json')
    expect(buildZcodeHeaders(credential, { json: false })).not.toHaveProperty('Content-Type')
  })

  it('★ 版本号必须抬到门槛 —— 报旧版本会被上游判成异常客户端', () => {
    // 依据（2026-11-05 真机 2×2，Issue #45）：上游把**版本号**与**身份块文本**
    // 当同一代校验，跨代即 `405 + request has been blocked due to unusual
    // activity`。本条锁的是「版本号必须被抬到与身份块同代的门槛」：
    // 凭据写 3.14.3（旧客户端登录的存量凭据）时，头里必须是 3.17.1 而不是 3.14.3。
    //
    // ⚠ 改这个期望值**必须同改** `src/zcode-identity.ts` 的身份块文本代次 ——
    // 两处不同代就是「全量用户 3012」（见 `zcode-upstream.ts` 的对照表）。
    //
    // 反面：改回 `credential.app_version ?? ZCODE_APP_VERSION_FALLBACK`
    // 会让本用例变红（凭据写的是 3.14.3）。
    const headers = buildZcodeHeaders({ ...credential, app_version: '3.14.3' })
    expect(headers['X-ZCode-App-Version']).toBe('3.17.1')
    expect(headers['User-Agent']).toBe('ZCode/3.17.1')
  })

  it('凭据版本比门槛高时用凭据自己的（向前兼容，不把用户降级）', () => {
    const headers = buildZcodeHeaders({ ...credential, app_version: '3.17.2' })
    expect(headers['X-ZCode-App-Version']).toBe('3.17.2')
    expect(headers['User-Agent']).toBe('ZCode/3.17.2')
  })

  it('显式 appVersion 覆盖优先于凭据与门槛两者', () => {
    const headers = buildZcodeHeaders(
      { ...credential, app_version: '3.17.0' },
      { appVersion: '3.16.3' },
    )
    expect(headers['X-ZCode-App-Version']).toBe('3.16.3')
  })

  it('端点常量是实测值', () => {
    expect(ZCODE_PLAN_MESSAGES_URL).toBe(
      'https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages',
    )
    expect(ZCODE_BILLING_BALANCE_URL).toBe(
      'https://zcode.z.ai/api/v1/zcode-plan/billing/balance',
    )
  })

  it('★ 3007（captcha）映射到 RATE_LIMIT —— **可重试**，换个 param 就能过', () => {
    expect(httpErrorCodeForZcode(400, '{"code":3007,"msg":"captcha verify failed"}')).toBe('RATE_LIMIT')
  })

  it('★ 3012（风控）映射到 PERMISSION —— **不可重试**（有账号冷却惩罚）', () => {
    const code = httpErrorCodeForZcode(405, '{"code":3012,"msg":"request has been blocked"}')
    expect(code).toBe('PERMISSION')
    // 断言它**不在** harness 的可重试集合里。
    expect(['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT']).not.toContain(code)
  })

  it('★ 1113（余额不足）映射到 QUOTA_EXCEEDED —— 不可重试', () => {
    expect(httpErrorCodeForZcode(429, '{"code":"1113"}')).toBe('QUOTA_EXCEEDED')
    expect(httpErrorCodeForZcode(429, '余额不足或无可用资源包')).toBe('QUOTA_EXCEEDED')
  })

  /**
   * ★ 上游把**并发限流**装进**额度码**下发（2026-10-06 凌晨真实故障）。
   *
   * 实测 wire：`429 + {"code":1005,"msg":"user concurrency limit exceeded"}` ——
   * `code` 说是额度（1005），`msg` 说是并发。当时的报错链：
   *   适配器换号/退避都正确 → 全部候选仍 429 → 最终文案按**码**归类（1005）⇒
   *   报「额度用尽——请等待额度重置或更换账号」，而 msg 明说
   *   「user concurrency limit exceeded」（等一下就能过）——**建议全错**，
   *   且让用户以为账号额度出了问题。
   *
   * 正确语义：**msg 的并发文案优先于 code 的额度语义** —— 并发是「等一下就能过」，
   * 报并发 + 可重试（RATE_LIMIT）；额度判定（isZcodeQuotaExhausted）不得命中
   * （否则把可用账号错标 24h 冷却）。
   */
  const MIXED_BODY = '{"code":1005,"msg":"user concurrency limit exceeded"}'

  it('★ 码装错了：1005 码 + 并发文案 ⇒ describeUpstreamError 报**并发限流**（不报额度）', () => {
    const text = describeUpstreamError(429, MIXED_BODY)
    expect(text).toMatch(/并发限流/)
    expect(text).not.toMatch(/额度用尽/)
    expect(text).toContain('user concurrency limit exceeded')
  })

  it('★ 同型 body ⇒ httpErrorCodeForZcode = RATE_LIMIT（可重试：等一下就能过）', () => {
    expect(httpErrorCodeForZcode(429, MIXED_BODY)).toBe('RATE_LIMIT')
  })

  it('★ 同型 body ⇒ isZcodeQuotaExhausted = false（不得把可用账号错标冷却）', () => {
    expect(isZcodeQuotaExhausted(429, MIXED_BODY)).toBe(false)
    expect(isZcodeConcurrencyLimited(429, MIXED_BODY)).toBe(true)
  })

  it('★ 真·额度错误不受影响（1005 + exceed quota limit 仍报额度 + 不可重试）', () => {
    const body = '{"code":1005,"msg":"exceed quota limit"}'
    expect(isZcodeQuotaExhausted(429, body)).toBe(true)
    expect(describeUpstreamError(429, body)).toMatch(/额度用尽/)
    expect(httpErrorCodeForZcode(429, body)).toBe('QUOTA_EXCEEDED')
  })

  it('401 / 1002 映射到 AUTH', () => {
    expect(httpErrorCodeForZcode(401, '')).toBe('AUTH')
    expect(httpErrorCodeForZcode(400, '{"type":"1002"}')).toBe('AUTH')
  })

  it('describeUpstreamError 对 3012 给出「勿重试」的警告文案', () => {
    const text = describeUpstreamError(405, '{"code":3012,"msg":"blocked"}')
    expect(text).toContain('3012')
    expect(text).toMatch(/冷却|勿连续重试|请勿/)
  })

  it('describeUpstreamError 对 3007 给出「请重试」的可操作提示', () => {
    expect(describeUpstreamError(400, '{"code":3007}')).toMatch(/captcha.*失败/)
  })

  it('describeUpstreamError 对非 JSON 响应体不抛错', () => {
    expect(describeUpstreamError(500, '<html>oops</html>')).toContain('500')
  })
})

// ───────────────────────────── 签到映射 ─────────────────────────────

describe('ZCode 签到结果映射', () => {
  it('★ 1003（已领取）视为**成功**（幂等，不是错误）', () => {
    const outcome = toClaimOutcome(
      { planId: 'p1', ok: true, alreadyClaimed: true, code: 1003 },
      'p1',
    )
    expect(outcome.kind).toBe('already-claimed')
  })

  it('code:0 是成功领取', () => {
    const outcome = toClaimOutcome({ planId: 'p1', ok: true, code: 0 }, 'p1')
    expect(outcome.kind).toBe('claimed')
  })

  it('3007 给出可操作提示（不是裸码）', () => {
    const outcome = toClaimOutcome({ planId: 'p1', ok: false, code: 3007 }, 'p1')
    expect(outcome.kind).toBe('failed')
    if (outcome.kind === 'failed') {
      expect(outcome.code).toBe(3007)
      expect(outcome.message).toMatch(/captcha/)
    }
  })

  it('无业务码的 HTTP 失败用 -1 占位（code 是必填字段）', () => {
    const outcome = toClaimOutcome({ planId: 'p1', ok: false, httpStatus: 503 }, 'p1')
    expect(outcome.kind).toBe('failed')
    if (outcome.kind === 'failed') expect(outcome.code).toBe(-1)
  })

  it('emptyCheckinStatus 满足契约（字段全给）', () => {
    const status = emptyCheckinStatus(false, true)
    expect(status.active).toBe(false)
    expect(status.actionRequired).toBe(true)
    expect(status.todayCheckedIn).toBe(false)
    expect(Array.isArray(status.checkinDates)).toBe(true)
  })
})
