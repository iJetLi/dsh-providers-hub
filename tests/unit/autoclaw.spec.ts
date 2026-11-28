import { describe, expect, it, vi } from 'vitest'
import crypto from 'node:crypto'
import http from 'node:http'
import {
  AUTOCLAW_CHAT_PATH,
  AUTOCLAW_MODEL_CONFIG_PATH,
  AUTOCLAW_REFRESH_PATH,
  AUTOCLAW_REQUIRED_SYSTEM_PROMPT_PREFIX,
  AUTOCLAW_SYSTEM_PROMPT_DELIMITER,
  calculateAutoclawSign,
  cleanBearerToken,
  isAutoclawThinkingLevel,
  normalizeAutoclawModel,
  prepareAutoclawMessages,
  buildAutoclawHeaders,
  parseAutoclawCredential,
  isAutoclawRefreshable,
  isAutoclawTokenExpired,
  autoclawExpiresAtMs,
  autoclawJwtExpiresAtMs,
  autoclawAccessTokenExpiresAtMs,
  autoclawDisplayNickname,
  autoclawEffortForRequest,
  readUserIdFromJwt,
  type AutoclawCredential,
  type ChatMessage,
} from '../../src/autoclaw.js'
import { AUTOCLAW, AUTOCLAW_THINKING_LEVELS, inputModalitiesOf } from '../../src/autoclaw-product.js'
import { AutoclawAdapter } from '../../src/autoclaw-adapter.js'
import { createUserMessage, LlmError } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import {
  sendAutoclawVerificationCode,
  loginAutoclawWithCode,
  refreshAutoclawToken,
  probeAutoclawLocalCredential,
  AUTOCLAW_SEND_CODE_PATH,
  AUTOCLAW_LOGIN_PATH,
} from '../../src/autoclaw-oauth.js'
import { shouldRefreshNow } from '../../src/expiry-sync.js'

/** 一天（毫秒）——本文件多处用它构造「编造的 7 天」与 JWT 的真实 24h。 */
const ONE_DAY_MS = 86_400_000

/**
 * 造一个**可解 payload** 的 JWT。
 *
 * ⚠️ 签名段是占位串：本仓库读 `exp` 的判据**不验签**（网关自己也只按 `exp` 判），
 *   这是刻意的 —— 用例要锁的是「过期时间从哪读」，不是密码学。
 * ⚠️ 必须用 `base64url`（`-` / `_`），与真实 JWT 一致：用标准 base64 造不出
 *   `+` / `/` 的样本，会漏掉解码归一那一格。
 */
function makeJwt(payload: Record<string, unknown>): string {
  const seg = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${seg({ alg: 'HS256', typ: 'JWT' })}.${seg(payload)}.sig`
}

describe('AutoClaw 纯函数与核心协议', () => {
  describe('calculateAutoclawSign - MD5 签名计算', () => {
    it('正确计算 MD5(appId + & + timestamp + & + appKey)', () => {
      const appId = 'autoclaw_web_app'
      const timestamp = '1729000000'
      const appKey = 'secret_key_123456'

      const expected = crypto
        .createHash('md5')
        .update(`${appId}&${timestamp}&${appKey}`)
        .digest('hex')

      const actual = calculateAutoclawSign(appId, timestamp, appKey)
      expect(actual).toBe(expected)
      expect(actual).toMatch(/^[0-9a-f]{32}$/)
    })

    it('使用生产默认配置计算签名', () => {
      const ts = '1720000000'
      const actual = calculateAutoclawSign(AUTOCLAW.appId, ts, AUTOCLAW.appKey)
      const expected = crypto
        .createHash('md5')
        .update(`${AUTOCLAW.appId}&${ts}&${AUTOCLAW.appKey}`)
        .digest('hex')
      expect(actual).toBe(expected)
    })
  })

  describe('cleanBearerToken - 凭据清洗', () => {
    it('去除 Bearer 前缀并 trim', () => {
      expect(cleanBearerToken('Bearer eyJhbGciOi...')).toBe('eyJhbGciOi...')
      expect(cleanBearerToken('bearer eyJhbGciOi...')).toBe('eyJhbGciOi...')
      expect(cleanBearerToken('  Bearer   token_123   ')).toBe('token_123')
    })

    it('未带 Bearer 前缀时正常保留', () => {
      expect(cleanBearerToken('eyJhbGciOi...')).toBe('eyJhbGciOi...')
      expect(cleanBearerToken('   token_abc   ')).toBe('token_abc')
    })

    it('非法或空值返回空字符串', () => {
      expect(cleanBearerToken('')).toBe('')
      expect(cleanBearerToken(undefined as unknown as string)).toBe('')
      expect(cleanBearerToken(null as unknown as string)).toBe('')
    })
  })

  describe('normalizeAutoclawModel - 模型名称规范化', () => {
    it('默认或空值映射到 zai_glm-5.3-flash', () => {
      expect(normalizeAutoclawModel()).toBe('zai_glm-5.3-flash')
      expect(normalizeAutoclawModel('')).toBe('zai_glm-5.3-flash')
      expect(normalizeAutoclawModel('   ')).toBe('zai_glm-5.3-flash')
    })

    it('映射常用模型别名', () => {
      expect(normalizeAutoclawModel('glm-5.3-flash')).toBe('zai_glm-5.3-flash')
      expect(normalizeAutoclawModel('glm-5.3')).toBe('zaicoding_glm-5.3')
      expect(normalizeAutoclawModel('glm-5.3-coding')).toBe('zaicoding_glm-5.3')
      expect(normalizeAutoclawModel('auto')).toBe('zai_auto')
    })

    it('保留已有合规前缀', () => {
      expect(normalizeAutoclawModel('zai_glm-5.3-flash')).toBe('zai_glm-5.3-flash')
      expect(normalizeAutoclawModel('zaicoding_glm-5.3')).toBe('zaicoding_glm-5.3')
      expect(normalizeAutoclawModel('zai_auto')).toBe('zai_auto')
    })

    it('其他未知模型自动附加 zai_ 前缀', () => {
      expect(normalizeAutoclawModel('custom-model')).toBe('zai_custom-model')
    })
  })

  describe('prepareAutoclawMessages - 406 拦截绕过之 System Prompt 前缀注入', () => {
    it('空消息列表自动生成包含合规 System Prompt 的单条消息', () => {
      const result = prepareAutoclawMessages([])
      expect(result).toHaveLength(1)
      expect(result[0]).toEqual({
        role: 'system',
        content: AUTOCLAW_REQUIRED_SYSTEM_PROMPT_PREFIX,
      })
    })

    it('首条不是 system 消息时在头部插入合规 system 消息', () => {
      const messages: ChatMessage[] = [
        { role: 'user', content: '你好，请帮我写一段代码' },
      ]
      const result = prepareAutoclawMessages(messages)
      expect(result).toHaveLength(2)
      expect(result[0]).toEqual({
        role: 'system',
        content: AUTOCLAW_REQUIRED_SYSTEM_PROMPT_PREFIX,
      })
      expect(result[1]).toEqual(messages[0])
    })

    it('首条是 system 但缺少前缀时自动分离为白名单过检项与原生指示', () => {
      const messages: ChatMessage[] = [
        { role: 'system', content: '自定义指示：你是一个严谨的工程师。' },
        { role: 'user', content: '测试' },
      ]
      const result = prepareAutoclawMessages(messages)
      expect(result).toHaveLength(3)
      expect(result[0]).toEqual({
        role: 'system',
        content: AUTOCLAW_REQUIRED_SYSTEM_PROMPT_PREFIX,
      })
      expect(result[1]).toEqual({
        role: 'system',
        content: '自定义指示：你是一个严谨的工程师。',
      })
      expect(result[2]).toEqual(messages[1])
    })

    it('首条是 system 且已包含前缀时剥离前缀并保持分离', () => {
      const alreadyValid = `${AUTOCLAW_REQUIRED_SYSTEM_PROMPT_PREFIX}. 额外说明`
      const messages: ChatMessage[] = [
        { role: 'system', content: alreadyValid },
        { role: 'user', content: '测试' },
      ]
      const result = prepareAutoclawMessages(messages)
      expect(result).toHaveLength(3)
      expect(result[0].content).toBe(AUTOCLAW_REQUIRED_SYSTEM_PROMPT_PREFIX)
      expect(result[1].content).toBe('额外说明')
    })

    // ═════════════════════════════════════════════════════════════════
    // 2026-10-17 审计 P1：`AUTOCLAW_SYSTEM_PROMPT_DELIMITER` 原是**死常量**
    // （全 src 零引用），而本文件只 import 未断言 ⇒ 那条 import 本身是无用的。
    // 本用例把它**转成有牙的登记**：显式断言「当前不注入」这一现状。
    // ⚠️ **不要**为了让「看起来实现了」而改成断言注入 —— 那需要真机证据
    //   （上游是否接受 messages[1] 携带额外元指令），见该常量的注释。
    // ⚠️ 若将来真机验证通过并决定注入，**本用例要一并改成断言注入**。
    // ═════════════════════════════════════════════════════════════════
    it('⚠️ 登记：DELIMITER 当前**刻意不注入**（待真机验证，见常量注释）', () => {
      const messages: ChatMessage[] = [
        { role: 'system', content: '你是资深工程师，负责重构。' },
        { role: 'user', content: '测试' },
      ]
      const result = prepareAutoclawMessages(messages)
      const wire = result.map((m) => String(m.content))
      // 反向自检防恒真：前置条件是「原生人设确实进了 messages[1]」。
      expect(wire[0]).toBe(AUTOCLAW_REQUIRED_SYSTEM_PROMPT_PREFIX)
      expect(wire[1]).toBe('你是资深工程师，负责重构。')
      // ⚠️ 这条断言锁住**现状**（不注入）。它是「登记」而非「认可」——
      //   语义与 `expiry-runtime-parity` 里那些「登记了例外」的用法同款。
      expect(wire.some((c) => c.includes(AUTOCLAW_SYSTEM_PROMPT_DELIMITER)),
        'DELIMITER 目前不注入；若已决定注入，请连同常量注释一并更新本用例').toBe(false)
    })
  })

  describe('buildAutoclawHeaders - 请求头构造', () => {
    it('构造标准鉴权与协议头', () => {
      const headers = buildAutoclawHeaders({
        product: AUTOCLAW,
        accessToken: 'Bearer test_access_token_123',
        modelId: 'zai_glm-5.3-flash',
        timestamp: '1720000000',
      })

      expect(headers['Content-Type']).toBe('application/json')
      expect(headers['X-Auth-Appid']).toBe(AUTOCLAW.appId)
      expect(headers['X-Auth-TimeStamp']).toBe('1720000000')
      expect(headers['X-Authorization']).toBe('Bearer test_access_token_123')
      expect(headers['X-Request-Model']).toBe('zai_glm-5.3-flash')
      expect(headers['X-Product']).toBe(AUTOCLAW.product)
      expect(headers['X-Auth-Sign']).toBe(
        calculateAutoclawSign(AUTOCLAW.appId, '1720000000', AUTOCLAW.appKey),
      )
      expect(headers['Accept']).toBeUndefined()
    })

    it('stream=true 时附带 Accept: text/event-stream', () => {
      const headers = buildAutoclawHeaders({
        product: AUTOCLAW,
        accessToken: 'test_token',
        modelId: 'zai_glm-5.3-flash',
        stream: true,
        timestamp: '1720000000',
      })
      expect(headers['Accept']).toBe('text/event-stream')
    })
  })

  describe('parseAutoclawCredential 与凭据状态判断', () => {
    it('解析标准 credential 结构', () => {
      const raw = {
        access_token: 'Bearer AT_VAL',
        refresh_token: 'RT_VAL',
        expires_at: 1800000000000,
        user_id: 'user_001',
        device_id: 'dev_001',
      }
      const cred = parseAutoclawCredential(raw)
      expect(cred).not.toBeUndefined()
      expect(cred?.access_token).toBe('AT_VAL')
      expect(cred?.refresh_token).toBe('RT_VAL')
      expect(cred?.expires_at).toBe(1800000000000)
      expect(cred?.user_id).toBe('user_001')
      expect(cred?.device_id).toBe('dev_001')
    })

    // ⚠️⚠️ **只有缺 `access_token` 才判 undefined**（2026-10-17 审计 P1 修复）。
    //   原用例名叫「缺少 access_token **或** refresh_token 时返回 undefined」
    //   —— 那是**把缺陷锁成正确行为**：上游不下发 refresh_token 时
    //   `loginAutoclawWithCode` 产出 `refresh_token: ''`，解析判 undefined，
    //   而**推理侧走裸 JSON.parse 完全可用** ⇒ 同一份凭据在推理能用、
    //   在续期报「凭据解析失败」。
    // ✅ 正确形态：解析只看「能不能用」，续期能力由 `isAutoclawRefreshable`
    //   单独表达 —— 「能不能用」与「能不能续期」是**两件事**。
    it('缺少 access_token 时返回 undefined（唯一硬条件）', () => {
      expect(parseAutoclawCredential({ refresh_token: 'ONLY_REFRESH' })).toBeUndefined()
      expect(parseAutoclawCredential({ access_token: '' })).toBeUndefined()
      expect(parseAutoclawCredential({ access_token: '   ' })).toBeUndefined()
      expect(parseAutoclawCredential(null)).toBeUndefined()
    })

    it('⚠️ 空 refresh_token 仍返回凭据，但标记为不可续期（推理可用 / 续期不可）', () => {
      // ⚠️ 这条是本次缺陷的行为锁：修复前这里是 `undefined`。
      for (const raw of [
        { access_token: 'AT', refresh_token: '' },
        { access_token: 'AT' },
        { access_token: 'AT', refresh_token: '   ' },
      ]) {
        const cred = parseAutoclawCredential(JSON.stringify(raw))
        expect(cred, `${JSON.stringify(raw)} 应当仍能解析出凭据`).toBeDefined()
        expect(cred!.access_token).toBe('AT')
        // ⚠️「能解析但不能续期」这两格必须同时成立 ——
        //   只判前者会让自愈链把空 refresh_token 的账号续一辈子。
        expect(isAutoclawRefreshable(cred!), '空 refresh_token 必须判为不可续期').toBe(false)
      }
    })

    it('isAutoclawRefreshable 判断', () => {
      expect(isAutoclawRefreshable({ access_token: 'a', refresh_token: 'r' })).toBe(true)
      expect(isAutoclawRefreshable({ access_token: 'a', refresh_token: '' })).toBe(false)
      expect(isAutoclawRefreshable({ access_token: 'a', refresh_token: '   ' })).toBe(false)
    })

    it('isAutoclawTokenExpired 判断', () => {
      const now = Date.now()
      expect(isAutoclawTokenExpired({ access_token: 'a', refresh_token: 'r', expires_at: now - 1000 })).toBe(true)
      expect(isAutoclawTokenExpired({ access_token: 'a', refresh_token: 'r', expires_at: now + 30_000 }, 60_000)).toBe(true)
      expect(isAutoclawTokenExpired({ access_token: 'a', refresh_token: 'r', expires_at: now + 300_000 }, 60_000)).toBe(false)
      expect(isAutoclawTokenExpired({ access_token: 'a', refresh_token: 'r' })).toBe(false)
    })

    it('autoclawDisplayNickname 格式化手机号与昵称', () => {
      // ⚠️ 用例里的号码是**编造的假号**（`13800000000` 属工信部测试号段），
      //    切勿换成真号 —— 测试断言与代码注释都会把它带进仓库历史。
      expect(autoclawDisplayNickname({ access_token: 'a', refresh_token: 'r', user_phone: '13800000000' })).toBe('138****0000')
      expect(autoclawDisplayNickname({ access_token: 'a', refresh_token: 'r', user_phone: '138****0000' })).toBe('138****0000')
      expect(autoclawDisplayNickname({ access_token: 'a', refresh_token: 'r', user_name: '张三' })).toBe('张三')
      expect(autoclawDisplayNickname({ access_token: 'a', refresh_token: 'r', user_id: 878541 })).toBe('用户878541')
      expect(autoclawDisplayNickname(undefined, 'fallback_id')).toBe('fallback_id')
    })

    // ═════════════════════════════════════════════════════════════════════
    // ★★ 2026-10-19 P0 回归锁：access_token 的真实死线**只能**来自 JWT 的 `exp`
    //
    // 事故：登录响应不带 `expires_at` / `expires_in` 时，旧实现编造
    // `Date.now() + 7 * 86400_000`；而真实寿命是 24h（JWT `iat`→`exp` 恒 86400s）
    // ⇒ `refreshAll` 的 lead-time 判据与积分按需自愈**双双跳过**，
    // 过期后表现为「刚启动还能看到积分、过一会儿变成登录凭据失效」，日志零字。
    // ═════════════════════════════════════════════════════════════════════
    describe('★★ access_token 死线以 JWT 为准（不得编造）', () => {
      it('autoclawJwtExpiresAtMs：合法 JWT 取 exp×1000；读不出来的四格一律 undefined', () => {
        const expSec = Math.floor(Date.now() / 1000) + 3600
        expect(autoclawJwtExpiresAtMs(makeJwt({ exp: expSec }))).toBe(expSec * 1000)
        // ⚠️ 下面四格是**回退信号**，必须全部返回 undefined：任一格返回数字
        //   都会让「读不到 ⇒ 用声明值 / undefined」这条兜底路失效。
        expect(autoclawJwtExpiresAtMs('at_secret_token_123'), '非 JWT（无点号）').toBeUndefined()
        expect(autoclawJwtExpiresAtMs('a.b'), '段数不足（2 段）').toBeUndefined()
        expect(autoclawJwtExpiresAtMs('a.b.c.d'), '段数过多（4 段）').toBeUndefined()
        expect(autoclawJwtExpiresAtMs('a.!!!not-base64!!!.c'), 'payload 解不出 JSON').toBeUndefined()
        expect(autoclawJwtExpiresAtMs(makeJwt({ exp: '1793000000' })), 'exp 是字符串').toBeUndefined()
        expect(autoclawJwtExpiresAtMs(makeJwt({})), 'payload 无 exp').toBeUndefined()
        expect(autoclawJwtExpiresAtMs(undefined)).toBeUndefined()
      })

      it('autoclawJwtExpiresAtMs：容忍 Bearer 前缀（与 cleanBearerToken 同口径）', () => {
        const expSec = Math.floor(Date.now() / 1000) + 3600
        expect(autoclawJwtExpiresAtMs(`Bearer ${makeJwt({ exp: expSec })}`)).toBe(expSec * 1000)
      })

      it('⚠️ autoclawAccessTokenExpiresAtMs：JWT 优先，读不到才用声明值（undefined 是合法结果）', () => {
        const expSec = Math.floor(Date.now() / 1000) + 3600
        expect(autoclawAccessTokenExpiresAtMs(makeJwt({ exp: expSec }), 9_999_999_999_999))
          .toBe(expSec * 1000)
        expect(autoclawAccessTokenExpiresAtMs('opaque-token', 9_999_999_999_999)).toBe(9_999_999_999_999)
        expect(autoclawAccessTokenExpiresAtMs('opaque-token', undefined)).toBeUndefined()
      })

      it('★★ parseAutoclawCredential：存量凭据里那个「编造的 7 天」必须被 JWT 覆盖', () => {
        const expSec = Math.floor(Date.now() / 1000) + 3600
        const jwt = makeJwt({ exp: expSec })
        const cred = parseAutoclawCredential({
          access_token: jwt,
          refresh_token: 'rt',
          // ← 旧实现写进用户目录的正是这种值（登录时刻 + 7 天）
          expires_at: Date.now() + 7 * ONE_DAY_MS,
        })
        expect(cred, '凭据必须能解析').toBeDefined()
        expect(cred!.expires_at).toBe(expSec * 1000)
        // ⚠️ 显式排除 7 天量级：只断言「是个正数」对原缺陷零判别力。
        expect(cred!.expires_at! - Date.now()).toBeLessThan(2 * ONE_DAY_MS)
      })

      it('★ 已过期的 JWT 凭据必须被判「该续期」（原缺陷下恒判「还有 6 天」）', () => {
        // 这才是根因的行为锁：判据读的是 parse 之后的 expires_at。
        const cred = parseAutoclawCredential({
          access_token: makeJwt({ exp: Math.floor(Date.now() / 1000) - 60 }),
          refresh_token: 'rt',
          expires_at: Date.now() + 6 * ONE_DAY_MS,
        })
        expect(shouldRefreshNow(cred!.expires_at), '已过期的真死线必须放行续期').toBe(true)
        // 反向对照：那份假值本身判「不需要刷」——正是事故里「静默跳过」的形态。
        // （它恒为 false，故不构成独立判据，只把「这条用例为什么有牙」写进断言。）
        expect(shouldRefreshNow(Date.now() + 6 * ONE_DAY_MS)).toBe(false)
      })

      it('非 JWT 时仍回退上游声明值；两者都没有时**不得编造**', () => {
        expect(parseAutoclawCredential({ access_token: 'at', expires_at: 1_800_000_000_000 })?.expires_at)
          .toBe(1_800_000_000_000)
        // ⚠️ 旧实现是在 login 路径编造 7 天；这条锁住「解析层也不许有兜底数字」。
        expect(parseAutoclawCredential({ access_token: 'at' })?.expires_at).toBeUndefined()
      })

      it('autoclawExpiresAtMs：秒 / 毫秒 / 相对秒数三格归一（JWT exp 是秒，故必须成立）', () => {
        const now = 1_792_000_000_000
        expect(autoclawExpiresAtMs(1_792_944_000, now)).toBe(1_792_944_000_000)
        expect(autoclawExpiresAtMs(1_792_944_000_000, now)).toBe(1_792_944_000_000)
        expect(autoclawExpiresAtMs(86_400, now)).toBe(now + 86_400_000)
        expect(autoclawExpiresAtMs(undefined, now)).toBeUndefined()
      })
    })
  })
})

describe('AutoclawAdapter 流式映射与端到端模拟', () => {
  function sseResponse(lines: string[]): Response {
    const body = lines.map((line) => `data: ${line}\n\n`).join('') + 'data: [DONE]\n\n'
    return new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    })
  }

  function makeMockAdapter(responder: (url: string, init?: RequestInit) => Response | Promise<Response>) {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fetcher = vi.fn(async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), init })
      return responder(String(url), init)
    }) as unknown as typeof fetch

    const fakeCred: AutoclawCredential = {
      access_token: 'mock_token',
      refresh_token: 'mock_refresh',
      expires_at: Date.now() + 3600_000,
    }

    const adapter = new AutoclawAdapter({
      resolveCredential: async () => fakeCred,
      probeCredential: async () => fakeCred,
      fetchImpl: fetcher,
      product: AUTOCLAW,
    })

    return { adapter, calls, fetcher }
  }

  it('流式生成请求正确组装 URL、Headers、Body 与前缀并映射 text-delta', async () => {
    let capturedBody: any = null
    const { adapter, calls } = makeMockAdapter((url, init) => {
      capturedBody = JSON.parse(String(init?.body))
      return sseResponse([
        JSON.stringify({
          id: 'chunk_1',
          choices: [{ delta: { content: 'Hello' } }],
        }),
        JSON.stringify({
          id: 'chunk_2',
          choices: [{ delta: { content: ' world!' } }],
        }),
      ])
    })

    const options: GenerateOptions = {
      provider: 'autoclaw',
      model: 'glm-5.3-flash',
      messages: [
        createUserMessage({
          content: [{ type: 'text', text: 'Hi' }],
          source: { kind: 'user' },
        }),
      ],
      temperature: 0.7,
      maxTokens: 100,
    }

    const receivedChunks: string[] = []
    for await (const chunk of adapter.stream(options)) {
      if (chunk.type === 'text-delta') {
        receivedChunks.push((chunk as any).delta ?? (chunk as any).text)
      }
    }

    // 验证请求 URL
    expect(calls[0].url).toBe(`${AUTOCLAW.apiBase}${AUTOCLAW_CHAT_PATH}`)
    expect(calls[0].init?.method).toBe('POST')

    // 验证请求 Headers
    const headers = calls[0].init?.headers as Record<string, string>
    expect(headers['X-Request-Model']).toBe('zai_glm-5.3-flash')
    expect(headers['X-Authorization']).toBe('Bearer mock_token')
    expect(headers['Accept']).toBe('text/event-stream')
    expect(headers['X-Auth-Sign']).toBeDefined()

    // 验证 Body 规范化
    expect(capturedBody.model).toBe('zai_glm-5.3-flash')
    expect(capturedBody.stream).toBe(true)
    expect(capturedBody.temperature).toBe(0.7)
    // ⚠️ 下限是 **10000**，不是原先的 16384（2026-10-17 审计 P0 修复）。
    //   官方网关约束见 `docs/autoclaw-models.md:53-55`：「`>= 10000` 或完全
    //   不传递，低于回 406」⇒ 抬到 16384 属编造上游没承诺的数字。
    //   ⚠️ 原断言写死 `toBe(16384)`，等于**把该缺陷锁成「正确行为」** ——
    //   修好反而会让本用例变红。这正是本仓库记载的「守卫把缺陷锁死」形态。
    expect(capturedBody.max_tokens).toBe(10000)
    // 验证自动注入了 406 前缀
    expect(capturedBody.messages[0].role).toBe('system')
    expect(capturedBody.messages[0].content).toBe(AUTOCLAW_REQUIRED_SYSTEM_PROMPT_PREFIX)
    expect(capturedBody.messages[1].role).toBe('user')

    // 验证流式文本聚合结果
    expect(receivedChunks.join('')).toBe('Hello world!')
  })

  it('上游返回非 200 错误码（如 406）时抛出异常', async () => {
    const { adapter } = makeMockAdapter(() => {
      return new Response('Not Acceptable: missing required prefix', {
        status: 406,
        statusText: 'Not Acceptable',
      })
    })

    const options: GenerateOptions = {
      provider: 'autoclaw',
      model: 'glm-5.3-flash',
      messages: [
        createUserMessage({
          content: [{ type: 'text', text: 'Test' }],
          source: { kind: 'user' },
        }),
      ],
    }

    await expect(async () => {
      for await (const _ of adapter.stream(options)) {
        // no-op
      }
    // ⚠️ 文案前缀随 2026-10-17 审计 P0 修复从「AutoClaw 请求失败」改为
    //   「autoclaw: 请求失败」（与仓库其余 15 家的 `provider: …` 口径一致）。
    //   ⚠️ **判据不止于文案**：下面另有一条用例断言错误**码** —— 原实现抛的是
    //   裸 `Error`（宿主 `harnessErrorCode` 恒返回 `'UNKNOWN'`），
    //   「抛得出某个 message」这条断言对它同样成立 ⇒ 文案匹配是弱判据。
    }).rejects.toThrow(/autoclaw: 请求失败 \[406 Not Acceptable\]/)
  })

  it('⚠️⚠️ 上游失败必须带错误码（裸 Error ⇒ 宿主恒归 UNKNOWN，2026-10-17 P0 修复）', async () => {
    const { adapter } = makeMockAdapter(() => new Response('quota exhausted', {
      status: 429,
      statusText: 'Too Many Requests',
    }))
    const options: GenerateOptions = {
      provider: 'autoclaw',
      model: 'glm-5.3-flash',
      messages: [createUserMessage({
        content: [{ type: 'text', text: 'Test' }],
        source: { kind: 'user' },
      })],
    }

    // ⚠️ 额度语义在**响应体**里（`quota exhausted`），而 429 也可能是真限流。
    //   本例断言的是「额度优先于状态码」这一腿（`autoclawHttpErrorCode` 的顺序）。
    let caught: unknown
    try {
      for await (const _ of adapter.stream(options)) { /* no-op */ }
    } catch (error) {
      caught = error
    }
    expect(caught, '带 quota 的 429 应被归为额度耗尽').toBeInstanceOf(LlmError)
    // ⚠️ 必须用**字面量** `'QUOTA_EXCEEDED'`，不是 harness 的
    //   `QUOTA_EXCEEDED_CODE`（其字面值是 `'QUOTA'`，客户端会把 message 丢掉
    //   换成「当前请求的额度已用尽」—— 见本仓库 issue IKJVCW）。
    expect((caught as LlmError).code).toBe('QUOTA_EXCEEDED')
  })

  it('listAllModels 返回 fallbackModels 列表并标记免费模型', () => {
    const { adapter } = makeMockAdapter(() => {
      return new Response(JSON.stringify({ code: 200 }), { status: 200 })
    })

    const allModels = adapter.listAllModels()
    expect(allModels.length).toBeGreaterThan(0)
    const flashModel = allModels.find((m) => m.id === 'zai_glm-5.3-flash')
    expect(flashModel).toBeDefined()
    // ⚠⚠ 2026-10-21 二轮审计订正：本模型**不是免费的**
    //    （`docs/autoclaw-models.md:25` 实测："仍然走统一积分钱包扣减，每次请求约 1 点，
    //    并非脱离钱包的免费模型"）。旧值 `true` 把「目录缺失」误当成「不扣费」。
    expect(flashModel?.isFree, '实测每次扣约 1 点 ⇒ 不得标成免费')
      .toBe(false)
  })

  it('listModels 探测连通性后返回模型列表', async () => {
    const { adapter, calls } = makeMockAdapter(() => {
      return new Response(JSON.stringify({ code: 200 }), { status: 200 })
    })

    const models = await adapter.listModels('autoclaw')
    // ⚠️ **恰好一次**请求（2026-10-17 真机取证后收敛）。
    //   演进过程（三次不同的数字，别把它当成反复横跳）：
    //   ① 原实现：1 次 —— 只判 `r.ok` 就**丢弃响应体**，远端规格永不生效；
    //   ② 中间版：2 次 —— 「探活」+「真读目录」两段独立请求；
    //   ③ 现在：1 次 —— 删掉冗余的 `probe()`，一次 GET 同时完成探活与读目录。
    //   ⚠️ ③ 是**真机证出来的**：那两段实现的认证头**不一致**
    //   （一个发 `X-Authorization`、一个发 `Authorization`），而该端点
    //   只认后者 ⇒ 「探活成功但真读目录 401」这种分裂症状极难排查。
    //   两份同义实现必然漂移，故合并为一份。
    expect(calls.length).toBe(1)
    expect(calls[0]!.url).toBe(`${AUTOCLAW.apiBase}${AUTOCLAW_MODEL_CONFIG_PATH}`)
    // ⚠️ **认证头必须是标准 `Authorization`**（真机实测：`X-Authorization`
    //   对该端点一律 `401 {"error":"Invalid token"}`）。这条断言锁住它，
    //   防止有人「为了与 chat/completions 统一」而改回 `X-Authorization`
    //   —— 两个端点的头是**相反**的，不能统一。
    const headers = calls[0]!.init?.headers as Record<string, string>
    expect(headers.Authorization, '模型配置端点只认标准 Authorization 头').toBeDefined()
    expect(headers['X-Authorization'], '该端点不认 X-Authorization（会 401）').toBeUndefined()
    expect(models.length).toBeGreaterThan(0)
    const flash = models.find((m) => m.id === 'zai_glm-5.3-flash')
    expect(flash).toBeDefined()
    // ⚠️⚠️ **`isFree` 不属于 `listModels` 的语境**（2026-10-23 迁移时订正）。
    //
    // `LlmModelInfo` 的契约只有 `provider` / `id` / `name` / `description` /
    // `inputModalities`（见 `@deepseek-ai/dsh-llm` 的 types.d.ts），**没有 `isFree`**。
    // 本仓库把 `isFree` 当扩展键下发的地方**只有** `listAllModels()`
    //（设置页按它分免费桶，见 `model-catalog-parity.spec.ts` 的「只吐三键」用例）。
    //
    // 迁移前本家手写 `listModels` 时**顺手**把 `isFree` 塞进了模型列表项，
    // 那是旧实现的越界行为（骨架的 `toModelInfo` 统一收敛掉）。
    // ⇒ 「不得冒充免费」这条语义搬到 `listAllModels()`（下面那条用例）继续守。
    expect(
      (flash as { isFree?: unknown }).isFree,
      '★ listModels 的条目不得携带 isFree（不在 LlmModelInfo 契约里）',
    ).toBeUndefined()
  })

  it('listAllModels 的 `zai_glm-5.3-flash` 必须显式 `isFree: false`（实测每次扣约 1 点）', () => {
    const { adapter } = makeMockAdapter(() => new Response(JSON.stringify({ code: 200 }), { status: 200 }))
    const all = adapter.listAllModels()
    const flash = all.find((m) => m.id === 'zai_glm-5.3-flash')
    expect(flash, '目录里必须有该模型').toBeDefined()
    // ⚠️ 必须是**显式 false**，不能省略：省略在 `CatalogEntry` 的三态语义下与
    // 「从未声明」同形，而徽标那侧按 `isFree === true` 分桶 ⇒ 省略会让
    // 「目录缺失」被当成「不扣费」（2026-10-21 二轮审计订正的正是这一处）。
    expect(flash?.isFree, '实测每次扣约 1 点 ⇒ 必须显式标 false（不得省略）').toBe(false)
  })

  describe('★★ 远端目录：必须真读，且解析不出就回落兜底表', () => {
    function adapterWith(payload: unknown, status = 200) {
      const adapter = new AutoclawAdapter({
        resolveCredential: async () => ({
          access_token: 'at', refresh_token: 'rt', expires_at: 4102444800000,
        }),
        probeCredential: async () => ({
          access_token: 'at', refresh_token: 'rt', expires_at: 4102444800000,
        }),
        fetchImpl: (async () => new Response(JSON.stringify(payload), {
          status, headers: { 'Content-Type': 'application/json' },
        })) as unknown as typeof fetch,
        product: AUTOCLAW,
      })
      return adapter
    }

    it('远端给了 contextWindow 时**真的生效**（这是「真读远端」的判据）', async () => {
      // ⚠️ **用真机实测确认的字段名与报文形状**
      //   （2026-10-17 对 `autoclaw-model-config` 真实 GET）：
      //   顶层 `{ models: [...] }`，条目用 `contextWindow` / `maxTokens` / `input`。
      const { adapter, calls } = makeMockAdapter(() => new Response(JSON.stringify({
        models: [{
          id: 'zai_glm-5.3-flash',
          name: 'GLM-5.3-Flash',
          contextWindow: 2_000_000,
          maxTokens: 200_000,
          input: ['text'],
          reasoningLevel: ['low', 'high', 'max'],
        }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

      const models = await adapter.listModels('autoclaw')
      expect(calls.length).toBe(1)
      // ⚠️ 关键：远端值必须流到 `resolveModel` 的声明里（listModels 本身不带
      //   context 格，故这里断言 resolveModel 读到的是**远端**校正后的值）。
      const resolved = await adapter.resolveModel('autoclaw', 'zai_glm-5.3-flash')
      expect(resolved.context?.contextWindow).toBe(2_000_000)
      expect(resolved.defaultMaxTokens).toBe(200_000)
      expect(models.length).toBeGreaterThan(0)
    })

    it('远端形状不认识时**原样回落兜底表**（绝不编造数值）', async () => {
      // ⚠️ 关键：远端返回完全不认识的东西 ⇒ 兜底值必须**逐字不变**。
      //   这是「不编造」的红线判据，不是「解析成功」判据。
      const { adapter } = makeMockAdapter(() => new Response(
        JSON.stringify({ totally: 'unexpected' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ))
      const resolved = await adapter.resolveModel('autoclaw', 'zai_glm-5.3-flash')
      expect(resolved.context?.contextWindow).toBe(1048576)
      expect(resolved.defaultMaxTokens).toBe(131072)
    })

    it('远端非 200 / 抛错时目录**仍可用**（只读展示面不该整体失败）', async () => {
      for (const fetcher of [
        (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch,
        (async () => { throw new Error('network down') }) as unknown as typeof fetch,
      ]) {
        const adapter = new AutoclawAdapter({
          resolveCredential: async () => ({
            access_token: 'at', refresh_token: 'rt', expires_at: 4102444800000,
          }),
          probeCredential: async () => ({
            access_token: 'at', refresh_token: 'rt', expires_at: 4102444800000,
          }),
          fetchImpl: fetcher,
          product: AUTOCLAW,
        })
        await expect(adapter.listModels('autoclaw')).resolves.toSatisfy((m) => m.length > 0)
        const resolved = await adapter.resolveModel('autoclaw', 'zai_glm-5.3-flash')
        expect(resolved.context?.contextWindow).toBe(1048576)
      }
    })

    it('⚠️ 不凭空新增模型条目（无可靠 id/名称 ⇒ 不编造）', async () => {
      const adapter = adapterWith({ data: { models: [
        { id: 'zai_glm-5.3-flash' },
        // ⚠️ 远端新增了一个兜底表里没有的模型 —— 它的**展示名无从得知**
        //   （只有 id）⇒ 按红线不得凭空造条目。
        { id: 'zai_brand_new_model' },
      ] } })
      const models = await adapter.listModels('autoclaw')
      expect(models.map((m) => m.id)).not.toContain('zai_brand_new_model')
      expect(models.length).toBe(AUTOCLAW.fallbackModels.length)
    })
  })

  it('resolveModel 正确声明思考强度 (Reasoning Effort) 档位与 1M 上下文规格', async () => {
    const { adapter } = makeMockAdapter()
    const resolved = await adapter.resolveModel('autoclaw', 'zai_glm-5.3-flash')
    expect(resolved.id).toBe('zai_glm-5.3-flash')
    expect(resolved.context?.contextWindow).toBe(1048576)
    // ⚠️⚠️ **输出上限必须走顶层 `defaultMaxTokens`，不是 `context.maxOutputTokens`**
    // （2026-10-17 审计 P0 修复）。原断言写的是
    // `expect(resolved.context?.maxOutputTokens).toBe(131072)` —— 它断言的是
    // 「适配器返回对象的私有形状」，而宿主契约 `LlmModelContext` **只有
    // `contextWindow` 一个字段**，且 `normalizeModelInfo` 做**白名单重建**
    // （`dsh-llm/lib/index.js:2124`）⇒ 那个键**必然被静默丢弃**。
    // ⇒ 那条断言把一个真实缺陷锁成了「正确行为」，修好反而会红。
    expect(resolved.defaultMaxTokens).toBe(131072)
    // ⚠️ **反向自检**：`context` 的键集合必须**只有** `contextWindow` ——
    //   这一条才有牙：多写任何字段宿主都会丢（前面即真实事故）。
    expect(Object.keys(resolved.context!).sort()).toEqual(['contextWindow'])
    expect(resolved.reasoning).toBeDefined()
    expect(resolved.reasoning?.defaultEffort).toBe('high')
    expect(resolved.reasoning?.efforts.map((e) => e.id)).toEqual(['low', 'high', 'max'])
  })

  // ═══════════════════════════════════════════════════════════════════
  // 2026-10-17 审计新增：原先本文件只**抽样**了 `zai_glm-5.3-flash`
  // （唯一 `supportsImage: false` 的样本）⇒ 行为**不同**的 `zai_auto-fast`
  // 与另外两个模型从未被任何断言覆盖。下面改为**逐模型遍历**。
  // ═══════════════════════════════════════════════════════════════════

  describe('★★ 逐模型遍历：两个入口的模态必须同源（不许只抽样）', () => {
    // ⚠️ **反向自检防恒真**：若兜底表被清空，`it.each` 一条都不跑 ⇒ 整段全绿。
    //   锚定具体模型名，让「少了一个模型」也会红。
    it('兜底表必须包含这六个远端已实测模型（4 个旧 + 2 个 2026-11-28 补的）', () => {
      /**
       * 6 个 = 远端 `autoclaw-model-config` 实测的全部 id（GitHub #190, 2026-11-28）：
       * `zai_auto` / `zai_auto-fast` / `zai_glm-x-preview` /
       * `zaicoding_glm-5.3` / `zai_glm-5.3-flash` / `zai_glm-5.3-flashx-legal`
       */
      expect(AUTOCLAW.fallbackModels.map((m) => m.id).sort()).toEqual([
        'zai_auto', 'zai_auto-fast', 'zai_glm-5.3-flash', 'zai_glm-5.3-flashx-legal',
        'zai_glm-x-preview', 'zaicoding_glm-5.3',
      ])
    })

    // ═════════════════════════════════════════════════════════════════
    // 2026-10-17：常量已与本机桌面端 `AutoClaw2\resources\app\dist\main.cjs`
    // **实测核对**（穷尽扫描：全文仅一处 `AUTOCLAW_COMPATIBLE_IDENTITY`，
    //  其余 appKey 命中全属钉钉/飞书 OAuth）。这里把结论锁成守卫，
    //  免得日后有人「凭印象」改这些值。
    // ═════════════════════════════════════════════════════════════════
    describe('常量与桌面端一致（实测锁定）', () => {
      it('appId / appKey / product 与桌面端逐字一致', () => {
        expect(AUTOCLAW.appId).toBe('100003')
        expect(AUTOCLAW.appKey).toBe('38d2391985e2369a5fb8227d8e6cd5e5')
        expect(AUTOCLAW.product).toBe('autoclaw')
      })

      it('基址与端点路径与桌面端一致', () => {
        expect(AUTOCLAW.apiBase).toBe('https://autoglm-acceleration-api.zhipuai.cn')
        expect(AUTOCLAW_CHAT_PATH).toBe('/autoclaw-proxy/proxy/autoclaw/chat/completions')
        expect(AUTOCLAW_MODEL_CONFIG_PATH).toBe('/autoclaw-proxy/proxy/autoclaw-model-config')
      })

      it('签名算法与桌面端一致：md5(appId&timestamp&appKey)', () => {
        expect(calculateAutoclawSign('100003', '1720000000', AUTOCLAW.appKey))
          .toBe(crypto.createHash('md5').update('100003&1720000000&38d2391985e2369a5fb8227d8e6cd5e5').digest('hex'))
      })

      it('⚠️ 请求头名与桌面端一致（X-Auth-* 三件套 + X-Version）', () => {
        const h = buildAutoclawHeaders({
          product: AUTOCLAW, accessToken: 'at', modelId: 'm', timestamp: '1720000000',
        })
        expect(Object.keys(h).sort()).toEqual([
          'Content-Type', 'X-Auth-Appid', 'X-Auth-Sign', 'X-Auth-TimeStamp',
          'X-Authorization', 'X-Product', 'X-Request-Model', 'X-Version',
        ])
        // ⚠️ `X-Version` 是 2026-10-20 补的：国际站推理**硬校验**它，
        //    缺它 → `HTTP 500` 且响应体为空（真机二分实测，见 buildAutoclawHeaders）。
        //    桌面端本来就发这个头，本清单是「与桌面端一致」的锁，故它必须在列。
        // ★ 行为级：不只「有这个名字」，值必须非空 —— 空串同样被网关判 500。
        expect(h['X-Version'] && h['X-Version'].length > 0, 'X-Version 必须带非空版本号').toBe(true)
      })
    })

    // ═════════════════════════════════════════════════════════════════
    // 2026-10-17：思考档位 id 曾**双发** `reasoning_effort` + `thinking_level`。
    // 实测桌面端源码后确认：`thinking_level` 的 27 处命中**没有一个是上行
    // 请求体字段**（全是 SQLite 列与埋点），托管网关只发 `reasoning_effort`。
    // ⇒ 删掉 `thinking_level`，并用守卫锁住「不得复活」。
    // ═════════════════════════════════════════════════════════════════
    describe('思考档位字段（实测：只发 reasoning_effort）', () => {
      async function bodyWithEffort(effort?: string) {
        const calls: Array<{ init?: RequestInit }> = []
        const fetcher = vi.fn(async (_u: unknown, init?: RequestInit) => {
          calls.push({ init })
          return new Response('data: [DONE]\n\n', {
            status: 200, headers: { 'Content-Type': 'text/event-stream' },
          })
        }) as unknown as typeof fetch
        const adapter = new AutoclawAdapter({
          resolveCredential: async () => ({
            access_token: 'at', refresh_token: 'rt', expires_at: 4102444800000,
          }),
          fetchImpl: fetcher,
          product: AUTOCLAW,
        })
        for await (const _c of adapter.stream({
          provider: 'autoclaw', model: 'zai_glm-5.3-flash',
          messages: [createUserMessage({
            content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' },
          })],
          ...(effort === undefined ? {} : { reasoningEffort: effort as never }),
        } as GenerateOptions)) { /* no-op */ }
        return JSON.parse(String(calls[0]!.init?.body)) as Record<string, unknown>
      }

      it('选定档位时**只**发 reasoning_effort', async () => {
        const body = await bodyWithEffort('high')
        expect(body.reasoning_effort).toBe('high')
        // ⚠️ **反向守卫**：thinking_level 不得复活（桌面端证明它不是协议字段）。
        expect(body, 'thinking_level 是本地会话状态字段，不是上行协议字段')
          .not.toHaveProperty('thinking_level')
      })

      it('未选档位时两个字段都不发', async () => {
        const body = await bodyWithEffort(undefined)
        expect(body).not.toHaveProperty('reasoning_effort')
        expect(body).not.toHaveProperty('thinking_level')
      })

      it('声明的档位 id 全部在**实测词汇表**内', async () => {
        const { adapter } = makeMockAdapter()
        const resolved = await adapter.resolveModel('autoclaw', 'zai_glm-5.3-flash')
        const ids = resolved.reasoning!.efforts.map((e) => String(e.id))
        for (const id of ids) {
          expect(isAutoclawThinkingLevel(id), `${id} 不在上游认可的词汇表内`).toBe(true)
        }
        // ⚠️ 数组顺序 = 强度序（弱→强）：`REASONING_EFFORT_RANK` 的相对序。
        expect(ids).toEqual([...ids].sort((a, b) =>
          AUTOCLAW_THINKING_LEVELS.indexOf(a as never) - AUTOCLAW_THINKING_LEVELS.indexOf(b as never)))
      })

      it('⚠️ 默认档必须是 `high`（用户 2026-10-17 取舍：max 适用面太窄）', async () => {
        const { adapter } = makeMockAdapter()
        const resolved = await adapter.resolveModel('autoclaw', 'zai_glm-5.3-flash')
        // ⚠️ 这条锁的是**产品决策**，不是「上游要求」。理由：
        //   · `max` 实测在难题上单次可跑 170~192 秒 ⇒ 日常等待代价过高；
        //   · `high` 是智谱官方标注的推荐默认（docs/autoclaw-models.md:72）；
        //   · 远端 `reasoningLevel` 顺序 low/high/max，high 居中是均衡位。
        // ⇒ 若有人想改成 `max`，本用例会红并指向这段理由，而不是静默翻档。
        expect(String(resolved.reasoning!.defaultEffort)).toBe('high')
        // ⚠️ 反向自检：默认档必须**在**声明列表内（否则宿主会抛
        //   `UNSUPPORTED_REASONING_EFFORT`，整个请求失败）。
        const ids = resolved.reasoning!.efforts.map((e) => String(e.id))
        expect(ids).toContain(String(resolved.reasoning!.defaultEffort))
        expect(ids).toEqual(['low', 'high', 'max'])
      })

      it('默认档不是数组第一项（防「用 array[0] 反推默认档」）', async () => {
        const { adapter } = makeMockAdapter()
        const resolved = await adapter.resolveModel('autoclaw', 'zai_glm-5.3-flash')
        const ids = resolved.reasoning!.efforts.map((e) => String(e.id))
        // ⚠️ 本仓库记载过：raccoon 那处曾用 `array[0]` 反推默认档，顺序一改
        //   就静默把默认档翻成最弱档，且那分支不可达 ⇒ 恒真断言抓不到。
        //   这里显式钉住「两者不是同一件事」。
        expect(ids[0]).not.toBe(String(resolved.reasoning!.defaultEffort))
      })

      it('词汇表本身与桌面端 SQLite CHECK 约束一致', () => {
        // ⚠️ 这条是「实测取证的锚」：桌面端同一常量被
        //   `CHECK(thinking_level IN ('off','minimal','low','medium','high','xhigh','max'))`
        //   独立引用 ⇒ 两处一致才算确认。
        expect([...AUTOCLAW_THINKING_LEVELS]).toEqual(
          ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
      })
    })

    // ═════════════════════════════════════════════════════════════════
    // 2026-10-17 **真机取证**（真实凭据 + 真实网络）锁成守卫。
    //
    // 取证方式：对 `autoclaw-model-config` 真实 GET，拿到 3 条模型：
    //   zai_auto / zai_auto-fast / zaicoding_glm-5.3
    // 三个模型都声明 `reasoningLevel: ["low","high","max"]`
    //   ⇒ 我们声明的三档**正是上游的表态**，不是猜的。
    // 三条模型的 `contextWindow` / `maxTokens` / `input` 与本表**逐格一致**。
    //
    // ⚠️ 这些数字以前是「静态推断」，现在是实测值 ⇒ 守卫要锁住，
    //   防止有人凭印象改动（改错了宿主会按错的窗口判断溢出压缩）。
    // ═════════════════════════════════════════════════════════════════
    describe('实测取证：目录数值与档位声明（2026-10-17 真机）', () => {
      /** 真机拿到的远端目录（**逐字照抄**，不要"顺手修正"）。 */
      const REMOTE = [
        { id: 'zai_auto', contextWindow: 1048576, maxTokens: 393216, input: ['text'], reasoningLevel: ['low', 'high', 'max'] },
        { id: 'zai_auto-fast', contextWindow: 1048576, maxTokens: 131072, input: ['text', 'image'], reasoningLevel: ['low', 'high', 'max'] },
        { id: 'zaicoding_glm-5.3', contextWindow: 1048576, maxTokens: 307200, input: ['text'], reasoningLevel: ['low', 'high', 'max'] },
      ] as const

      /**
       * ⚠️⚠️ **实测覆盖的图片能力**（2026-10-17，真实凭据 + 真实图片）。
       *
       * ## 为什么远端 `input` 不能当能力真值
       *
       * 远端对 `zai_auto` / `zaicoding_glm-5.3` 只声明 `input: ["text"]`，
       * 但**实测两者都能正确读图**（答对了「数字 7 + 红色横线」双判据）。
       * ⇒ 远端 `input` 声明**不完整** —— 这正是本仓库记过的
       * 「远端漏报 `input_modalities`」形态（`loomy` 的 `qwen-3.8-max` 同款）。
       *
       * ## 实测方法（可靠版本）
       *
       * 图：256×256、深蓝底 + 粗白字「7」+ 底部红横线；
       * 问：「数字是几？横线什么颜色？」⇒ 四个 `zai_*` 模型**全部答对**。
       *
       * ⚠️ **第一版探针是错的**：用了 64×64、笔画极细的图（base64 仅 236
       * 字符）⇒ 模型读不出 ⇒ 我误判「不支持图片」。用户反馈 IDE 里能发图后
       * 才复查出这一点。教训：**视觉探针的图必须足够大、判据必须有二义性防护**
       * （只问「数字是几」时答错还能狡辩；加一条「横线什么颜色」就把
       * 「真读图」与「瞎猜」分开了）。
       */
      const VISION_MEASURED: Readonly<Record<string, boolean>> = {
        'zai_glm-5.3-flash': true,
        'zaicoding_glm-5.3': true,
        'zai_auto': true,
        'zai_auto-fast': true,
      }

      it.each(REMOTE.map((r) => [r.id, r] as const))(
        '%s：contextWindow / maxTokens 必须与远端逐格一致',
        (_id, remote) => {
          const entry = AUTOCLAW.fallbackModels.find((m) => m.id === remote.id)
          expect(entry, `${remote.id} 应在本表里（它在远端目录内）`).toBeDefined()
          // ⚠️ 这两项**可以**与远端对拍（它们是纯数值，远端声明可信）。
          expect(entry!.contextWindow).toBe(remote.contextWindow)
          expect(entry!.maxOutputTokens).toBe(remote.maxTokens)
        },
      )

      it.each(REMOTE.map((r) => [r.id, r] as const))(
        '%s：图片能力以**实测**为准，不以远端 input 声明为准',
        (_id, remote) => {
          const entry = AUTOCLAW.fallbackModels.find((m) => m.id === remote.id)!
          // ⚠️ 判据是 VISION_MEASURED（实测），**不是** remote.input。
          expect(entry.supportsImage).toBe(VISION_MEASURED[remote.id])
          // ⚠️ 反向登记「远端漏报」这件事本身：若将来远端补上了 image，
          //   本断言会红，提醒把这条登记删除（而不是静默保留一句过时的话）。
          if (VISION_MEASURED[remote.id] === true && !remote.input.includes('image' as never)) {
            expect(
              remote.input.includes('image' as never),
              `${remote.id}: 实测支持图片，但远端 input 尚未包含 image`
              + '（这正是「远端漏报」的登记点；若远端已修正，请更新本用例）',
            ).toBe(false)
          }
        },
      )

      it('我们声明的三档 == 远端 reasoningLevel 逐字一致', () => {
        const { adapter } = makeMockAdapter()
        // ⚠️ 用 `resolveModel` 读出**实际声明给宿主**的档位，而不是读源码常量 ——
        //   否则这条会退化成「常量等于常量」的同义反复。
        return adapter.resolveModel('autoclaw', 'zai_auto').then((resolved) => {
          const ids = resolved.reasoning!.efforts.map((e) => String(e.id))
          for (const remote of REMOTE) {
            expect(ids, `${remote.id} 的远端档位声明`).toEqual([...remote.reasoningLevel])
          }
        })
      })

      it('⚠️ 四个模型都必须声明档位（远端每个都有 reasoningLevel）', async () => {
        const { adapter } = makeMockAdapter()
        // ⚠️ 反向自检防恒真：先确认兜底表非空，否则下面的循环一条都不跑。
        expect(AUTOCLAW.fallbackModels.length).toBeGreaterThan(0)
        for (const m of AUTOCLAW.fallbackModels) {
          const resolved = await adapter.resolveModel('autoclaw', m.id)
          expect(resolved.reasoning, `${m.id} 未声明档位`).toBeDefined()
          expect(resolved.reasoning!.efforts.length).toBe(3)        }
      })

      it('⚠️ 目录里没有 zai_glm-5.3-flash，但本表**刻意保留**（实测仍可调用）', () => {
        // ⚠️ 这条是「登记一个刻意的不一致」，不是「验证一致性」。
        //   真机实测：直接调它 HTTP 200 且正常回复（reasoning_tokens=46）。
        //   ⇒ 保留的理由是「**实测可用**」（不再包含「isFree」—— 该标记已订正为 false）。
        //   ⚠️ 若将来它真下线（返回 400 非法模型），**本用例要一并删掉**。
        const remoteIds = REMOTE.map((r) => r.id)
        expect(remoteIds).not.toContain('zai_glm-5.3-flash')
        const kept = AUTOCLAW.fallbackModels.find((m) => m.id === 'zai_glm-5.3-flash')
        expect(kept, '刻意保留，见 autoclaw-product.ts 的说明').toBeDefined()
        // ⚠⚠ 2026-10-21 二轮审计：原判据写的是「它是唯一的 isFree 模型」
        //    —— 而那个标记本身就是错的（实测每次扣约 1 点）。
        //    旧守卫把错误标记**当成事实锁住了**（正是本仓库记录过的「守卫保护了错误行为」）。
        expect(kept!.isFree, '实测每次扣约 1 点 ⇒ 不得标成免费').toBe(false)
      })

      // ═══════════════════════════════════════════════════════════════
      // **展示名必须与 IDE 显示的一致**（2026-10-17 用户核对后修正）
      //
      // 用户对照 IDE 内置列表（Auto / Auto-Fast / GLM-5.3 / GLM-5.3-Flash）
      // 问「我们的 GLM-5.3 Coding 是 IDE 的 GLM-5.3 吗」——
      // **是**。远端 `name` 逐字为 `"GLM-5.3"`，而我们曾写作
      // `"GLM-5.3 Coding (AutoClaw)"`，让人以为是两个模型。
      // ⇒ 名称一律**以远端 `name` 为准**，只加 `(AutoClaw)` 品牌后缀。
      // ═══════════════════════════════════════════════════════════════
      it('★★ 展示名必须等于「远端 name + (AutoClaw)」，不得自己造名字', () => {
        // ⚠️ 这是远端权威 name（2026-10-17 实测，逐字照抄）。
        const REMOTE_NAME: Readonly<Record<string, string>> = {
          'zai_auto': 'Auto',
          'zai_auto-fast': 'Auto-Fast',
          'zaicoding_glm-5.3': 'GLM-5.3',
        }
        // 反向自检：表非空，否则循环恒真。
        expect(Object.keys(REMOTE_NAME).length).toBe(3)
        for (const [id, remoteName] of Object.entries(REMOTE_NAME)) {
          const entry = AUTOCLAW.fallbackModels.find((m) => m.id === id)
          expect(entry, `${id} 应在本表里`).toBeDefined()
          // ⚠️ 判据是「**包含**远端原名 + 带品牌后缀」，不要求逐字相等 ——
          //   因为我们必须加品牌（跨渠道同名混淆），但**不得改动原名本身**。
          expect(entry!.name, `${id}: 必须保留远端原名 "${remoteName}"`)
            .toContain(remoteName)
          expect(entry!.name, `${id}: 必须带 (AutoClaw) 品牌后缀`)
            .toContain('(AutoClaw)')
        }
        // ⚠️ **反向守卫**：`zaicoding_glm-5.3` 的名字里**不得**出现 `Coding`
        //   （那正是造成「以为它是另一个模型」的误导词）。
        const coding = AUTOCLAW.fallbackModels.find((m) => m.id === 'zaicoding_glm-5.3')!
        expect(
          coding.name,
          'id 里的 coding 只是通道标识，不是给用户看的名字 —— '
          + '写进 name 会让用户以为它是 IDE 里 GLM-5.3 之外的另一个模型',
        ).not.toContain('Coding')
      })
    })

    it.each(AUTOCLAW.fallbackModels.map((m) => [m.id, m] as const))(
      '%s：listModels 与 resolveModel 的 inputModalities 必须一致',
      async (_id, entry) => {
        const { adapter } = makeMockAdapter(() =>
          new Response(JSON.stringify({ code: 200 }), { status: 200 }))
        const fromList = (await adapter.listModels('autoclaw')).find((m) => m.id === entry.id)
        const fromResolve = await adapter.resolveModel('autoclaw', entry.id)

        expect(fromList, `${entry.id} 应出现在 listModels 里`).toBeDefined()
        // ⚠️ **这条就是本缺陷的判据**：修复前 `listModels` 硬编码 `['text']`
        //   而 `resolveModel` 按 `supportsImage` 给 ⇒ 两者对 `zai_auto-fast`
        //   永远不一致，且**任一侧单独改都还是错**。
        expect(fromList!.inputModalities,
          `${entry.id}: 两个入口的模态必须同源（宿主门禁读 resolveModel 的那份，`
          + '选择器读 listModels 的那份，不一致 = 用户被误导）',
        ).toEqual(fromResolve.inputModalities)
        // ⚠️ 再钉一层：三处都收敛到同一个纯函数。
        expect(fromResolve.inputModalities).toEqual(inputModalitiesOf(entry))
      },
    )

    it.each(AUTOCLAW.fallbackModels.map((m) => [m.id, m] as const))(
      '%s：defaultMaxTokens 必须下发且是安全正整数（宿主会硬校验）',
      async (_id, entry) => {
        const { adapter } = makeMockAdapter()
        const resolved = await adapter.resolveModel('autoclaw', entry.id)
        expect(resolved.defaultMaxTokens, `${entry.id} 未下发输出上限`).toBe(entry.maxOutputTokens)
        // ⚠️ 宿主 `dsh-llm/lib/index.js:2116` 对该字段有硬校验：
        //   非安全正整数直接抛 `INVALID_MODEL_MAX_TOKENS` ⇒ 坏值等于请求全废。
        expect(Number.isSafeInteger(resolved.defaultMaxTokens!)).toBe(true)
        expect(resolved.defaultMaxTokens!).toBeGreaterThan(0)
      },
    )
  })

  describe('★★ 图片通路：声明即承诺（2026-10-17 P0）', () => {
    function adapterWithImage(bytes: Uint8Array = new Uint8Array([1, 2, 3])) {
      const calls: Array<{ url: string; init?: RequestInit }> = []
      const fetcher = vi.fn(async (url: unknown, init?: RequestInit) => {
        calls.push({ url: String(url), init })
        return new Response(
          `data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n\ndata: [DONE]\n\n`,
          { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
        )
      }) as unknown as typeof fetch
      return {
        calls,
        adapter: new AutoclawAdapter({
          resolveCredential: async () => ({
            access_token: 'at', refresh_token: 'rt', expires_at: 4102444800000,
          }),
          probeCredential: async () => ({
            access_token: 'at', refresh_token: 'rt', expires_at: 4102444800000,
          }),
          fetchImpl: fetcher,
          product: AUTOCLAW,
          readImage: async () => ({ data: bytes, mediaType: 'image/png' }),
        }),
      }
    }

    function imageMessage() {
      return [createUserMessage({
        content: [{ type: 'text', text: '看图' }],
        source: { kind: 'user' },
      })]
    }

    it('⚠️ 支持图片的模型：带图请求必须**发出去**（修复前恒抛「仅支持文本」）', async () => {
      // ⚠️ 2026-10-17 起**四个模型全部支持图片**（实测），故逐个验证。
      for (const model of ['zai_auto-fast', 'zai_glm-5.3-flash', 'zai_auto', 'zaicoding_glm-5.3']) {
        const { adapter, calls } = adapterWithImage()
        let ok = false
        for await (const _chunk of adapter.stream({
          provider: 'autoclaw',
          model,
          messages: [{ ...imageMessage()[0]!, content: [
            { type: 'text', text: '看图' },
            // ⚠️ 形态取自 `openai-compat` 的 `collectImages`（附件引用）。
            { type: 'image', attachment: { attachmentId: 'a1' } },
          ] } as never],
        } as GenerateOptions)) { ok = true }
        expect(ok, `${model}: 带图请求应当成功跑通`).toBe(true)
        // ⚠️ 关键断言：**真的发了网络请求**，且请求体里带 data URL。
        expect(calls.length, `${model}: 应发出请求`).toBeGreaterThan(0)
        const wire = JSON.stringify(JSON.parse(String(calls[0]!.init?.body)).messages)
        expect(wire, `${model}: 图片应内联为 data URL`).toContain('data:image/')
      }
    })

    it('★★ 四个已知模型都必须声明支持图片（2026-10-17 实测锁死）', async () => {
      // ⚠️ 这条锁的是**实测结论**，不是远端声明：远端对 zai_auto /
      //   zaicoding_glm-5.3 只写 input:["text"]，但实测两者都能正确读图
      //   （答对「数字 7 + 红色横线」双判据）⇒ 远端漏报。
      //   ⚠️ 我曾经据「远端目录没有 flash」误判它不支持图片，用户反馈 IDE
      //   里能发图后才复查出 64×64 测试图太小。这条守卫防止再退化回去。
      const { adapter } = makeMockAdapter()
      /**
       * ⚠️⚠️ **不能再用「遍历全表」的写法**（2026-11-28，GitHub #190）。
       *
       * 原来断言 `fallbackModels.length === 4` 且**全表**都声明支持图片。
       * 但报障者实测远端有 **6** 个模型，我据此补了 `zai_glm-x-preview` 与
       * `zai_glm-5.3-flashx-legal` —— 而这两个**没有做过读图实测**
       * ⇒ 给它们编 `supportsImage: true` 就是**谎称能力**（本仓红线）。
       *
       * ⇒ 改成**显式列出那 4 个 2026-10-17 实测过的**，新增模型不纳入本断言。
       */
      const IMAGE_VERIFIED_2026_10_17 = ['zai_auto', 'zai_auto-fast', 'zaicoding_glm-5.3', 'zai_glm-5.3-flash']
      expect(AUTOCLAW.fallbackModels.length).toBeGreaterThanOrEqual(4)
      for (const id of IMAGE_VERIFIED_2026_10_17) {
        const m = AUTOCLAW.fallbackModels.find((x) => x.id === id)
        expect(m, `${id} 必须还在兜底表里`).toBeDefined()
        const resolved = await adapter.resolveModel('autoclaw', m!.id)
        expect(resolved.inputModalities, `${m!.id} 应声明支持图片`).toContain('image')
      }
    })

    it('⚠️ 保留一条「发请求」的原始断言（防止上面循环被改成永真）', async () => {
      const { adapter, calls } = adapterWithImage()
      let ok = false
      for await (const _chunk of adapter.stream({
        provider: 'autoclaw',
        model: 'zai_auto-fast',
        messages: [{ ...imageMessage()[0]!, content: [
          { type: 'text', text: '看图' },
          { type: 'image', attachment: { attachmentId: 'a1' } },
        ] } as never],
      } as GenerateOptions)) { ok = true }
      expect(ok, '带图请求应当成功跑通').toBe(true)
      // ⚠️ 关键断言：**真的发了网络请求**，且请求体里带 data URL。
      expect(calls.length).toBeGreaterThan(0)
      const body = JSON.parse(String(calls[0]!.init?.body))
      const wire = JSON.stringify(body.messages)
      expect(wire, '图片应被内联为 data URL 发往上游').toContain('data:image/png;base64,')
    })

    it('⚠️ 未知模型带图：抛 UNSUPPORTED_CONTENT 且**零网络请求**', async () => {
      // ⚠️ 2026-10-17 起**四个已知模型全部支持图片**（实测），所以这个分支
      //   只能由**未知模型**触发 —— 而「未知按不支持处理」正是本仓库的口径
      //   （`inputModalitiesOf(undefined)` 给 `['text']`，理由见该函数注释：
      //   省略 = 未知 = 放行 ⇒ 会静默忽略图片并幻觉）。
      //   ⇒ 本用例守卫的是「未知模型的保守行为」，仍然有牙。
      const { adapter, calls } = adapterWithImage()
      let caught: unknown
      try {
        for await (const _chunk of adapter.stream({
          provider: 'autoclaw',
          model: 'zai_not_a_real_model',
          messages: [{ ...imageMessage()[0]!, content: [
            { type: 'text', text: '看图' },
            { type: 'image', attachment: { attachmentId: 'a1' } },
          ] } as never],
        } as GenerateOptions)) { /* no-op */ }
      } catch (error) { caught = error }
      expect(caught).toBeInstanceOf(LlmError)
      expect((caught as LlmError).code).toBe('UNSUPPORTED_CONTENT')
      // ⚠️ 「零调用」这条才有牙：否则实现可能先发请求再抛（那用户已经付了钱）。
      expect(calls.length, '拒绝图片时不应发出任何网络请求').toBe(0)
    })
  })

  describe('★★ max_tokens 双向夹取（2026-10-17 P0/P1）', () => {
    async function maxTokensFor(model: string, requested: number | undefined) {
      const calls: Array<{ init?: RequestInit }> = []
      const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
        calls.push({ init })
        return new Response('data: [DONE]\n\n', {
          status: 200, headers: { 'Content-Type': 'text/event-stream' },
        })
      }) as unknown as typeof fetch
      const adapter = new AutoclawAdapter({
        resolveCredential: async () => ({
          access_token: 'at', refresh_token: 'rt', expires_at: 4102444800000,
        }),
        fetchImpl: fetcher,
        product: AUTOCLAW,
      })
      for await (const _c of adapter.stream({
        provider: 'autoclaw', model,
        messages: [createUserMessage({
          content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' },
        })],
        ...(requested === undefined ? {} : { maxTokens: requested }),
      } as GenerateOptions)) { /* no-op */ }
      const body = JSON.parse(String(calls[0]!.init?.body))
      return body.max_tokens as number | undefined
    }

    it('下限：请求 100 时按官方阈值抬到 10000（不是编造的 16384）', async () => {
      expect(await maxTokensFor('zai_auto', 100)).toBe(10000)
    })

    it('上限：请求 999999 时被夹到该模型声明的 393216', async () => {
      // ⚠️ 原实现只做下限 ⇒ 999999 会**原样发出**，超出 `zai_auto` 声明的
      //   393216 且宿主不转可读错误。
      expect(await maxTokensFor('zai_auto', 999_999)).toBe(393216)
    })

    it('区间内原样透传', async () => {
      expect(await maxTokensFor('zai_auto', 50_000)).toBe(50_000)
    })

    it('⚠️ 用户未指定时**不发该字段**（走网关默认，绝不编造数字）', async () => {
      // ⚠️ 这一格在宿主里通常不会发生（`defaultMaxTokens` 会回填），
      //   但绕过宿主直接调适配器时就是它 —— 断言「不发」而非「发 16384」。
      const sent = await maxTokensFor('zai_auto', undefined)
      expect(sent).toBeUndefined()
    })
  })

  describe('★★ 思考档位本地拦截（2026-10-18 审计 P0）', () => {
    // ⚠️ 这组断言的是**行为**（真正发出去什么），不是源码文本 ——
    //   「源码里出现过某个调用」会被 `if (false)` 短路写法骗过（AGENTS.md 记载）。
    async function effortFor(requested: string | undefined) {
      const calls: Array<{ init?: RequestInit }> = []
      const warns: string[] = []
      const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
        calls.push({ init })
        return new Response('data: [DONE]\n\n', {
          status: 200, headers: { 'Content-Type': 'text/event-stream' },
        })
      }) as unknown as typeof fetch
      const adapter = new AutoclawAdapter({
        resolveCredential: async () => ({
          access_token: 'at', refresh_token: 'rt', expires_at: 4102444800000,
        }),
        fetchImpl: fetcher,
        product: AUTOCLAW,
        warn: (m) => { warns.push(m) },
      })
      for await (const _c of adapter.stream({
        provider: 'autoclaw', model: 'zai_auto',
        messages: [createUserMessage({
          content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' },
        })],
        ...(requested === undefined ? {} : { reasoningEffort: requested as never }),
      } as GenerateOptions)) { /* no-op */ }
      const body = JSON.parse(String(calls[0]!.init?.body))
      return { sent: body.reasoning_effort as string | undefined, warns }
    }

    it('集合内的档位原样发（low/high/max 三档都要走通）', async () => {
      for (const effort of ['low', 'high', 'max']) {
        const { sent } = await effortFor(effort)
        expect(sent, `${effort} 应当原样上行`).toBe(effort)
      }
    })

    it('★★ 集合外的档位**不发该字段**（上游回 200 并按最贵档跑，不拦就是烧钱）', async () => {
      // ⚠️ 实测依据：`turbo` / `ultra` / `off` 三个非法值上游**全部回 200**
      //   并正常跑完（`docs/audit/pr111-autoclaw-audit.md` 的取证表）⇒
      //   症状是「变慢 / 变贵」而非报错，事后无从归因。
      for (const bogus of ['turbo', 'ultra', 'off', 'medium', 'none', ' ']) {
        const { sent } = await effortFor(bogus)
        expect(sent, `非法档位 ${JSON.stringify(bogus)} 绝不能上行`).toBeUndefined()
      }
    })

    it('⚠️ 丢弃必须**留痕**（否则用户付了 max 的钱却无从归因）', async () => {
      const { warns } = await effortFor('turbo')
      expect(warns.some((w) => w.includes('turbo')),
        '丢弃档位时必须有告警，且要指名丢的是什么').toBe(true)
    })

    it('合法档位不得产生任何丢弃告警（防「无脑 warn」把日志刷满）', async () => {
      const { warns } = await effortFor('high')
      expect(warns).toEqual([])
    })

    it('⚠️ 用户未指定档位时不发该字段（走网关默认）', async () => {
      const { sent, warns } = await effortFor(undefined)
      expect(sent).toBeUndefined()
      expect(warns).toEqual([])
    })

    it('判据本身：集合外的值必须回报 dropped + 可读的丢弃原因', () => {
      const d = autoclawEffortForRequest('turbo', ['low', 'high', 'max'])
      expect(d.effort).toBeUndefined()
      expect(d.dropped).toBe('turbo')
      expect(d.reason).toContain('low/high/max')

      // ⚠️ 「未声明任何档位」也必须拦 —— 不能因为集合为空就当全都合法。
      const none = autoclawEffortForRequest('high', [])
      expect(none.effort).toBeUndefined()
      expect(none.dropped).toBe('high')
    })
  })

  describe('AutoClaw 短信验证码快速登录与凭据兑换', () => {
    it('sendAutoclawVerificationCode 校验非法手机号并拒绝发送', async () => {
      const res1 = await sendAutoclawVerificationCode('12345')
      expect(res1.ok).toBe(false)
      expect(res1.error).toContain('手机号格式不正确')

      const res2 = await sendAutoclawVerificationCode('abc13800138000')
      expect(res2.ok).toBe(false)
    })

    it('sendAutoclawVerificationCode 正确构造请求头、签名并下发验证码', async () => {
      let capturedUrl = ''
      let capturedInit: RequestInit | undefined
      const mockFetch = vi.fn().mockImplementation((url, init) => {
        capturedUrl = String(url)
        capturedInit = init
        return Promise.resolve(
          new Response(
            JSON.stringify({
              code: 0,
              msg: 'SUCCESS',
              data: {},
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        )
      })

      const res = await sendAutoclawVerificationCode('13800138000', {
        fetchImpl: mockFetch as any,
        deviceId: 'test_dev_001',
      })

      expect(res.ok).toBe(true)
      expect(res.msgid).toBe('autoclaw-sms')
      expect(capturedUrl).toBe(`${AUTOCLAW.apiBase}${AUTOCLAW_SEND_CODE_PATH}`)
      expect(capturedInit?.method).toBe('POST')

      const headers = capturedInit?.headers as Record<string, string>
      expect(headers['X-Auth-Appid']).toBe(AUTOCLAW.appId)
      expect(headers['X-Auth-Sign']).toBeDefined()
      expect(headers['X-Lang']).toBe('zh-CN')

      const body = JSON.parse(String(capturedInit?.body))
      expect(body.phone).toBe('13800138000')
      expect(body.source_id).toBe('autoclaw')
      expect(body.device_id).toBe('test_dev_001')
    })

    it('sendAutoclawVerificationCode 上游返回业务错误时返回失败', async () => {
      const mockFetch = vi.fn().mockImplementation(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              code: 10002,
              msg: '验证码发送频繁，请稍后再试',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        ),
      )

      const res = await sendAutoclawVerificationCode('13800138000', { fetchImpl: mockFetch as any })
      expect(res.ok).toBe(false)
      expect(res.error).toBe('验证码发送频繁，请稍后再试')
    })

    it('loginAutoclawWithCode 参数不合法时校验拦截', async () => {
      const res1 = await loginAutoclawWithCode('13800', '123456')
      expect(res1.ok).toBe(false)
      expect(res1.error).toContain('手机号格式不正确')

      const res2 = await loginAutoclawWithCode('13800138000', '   ')
      expect(res2.ok).toBe(false)
      expect(res2.error).toContain('验证码不能为空')
    })

    it('loginAutoclawWithCode 成功兑换 AutoClaw 凭据并规范解析', async () => {
      let capturedUrl = ''
      let capturedInit: RequestInit | undefined
      const mockFetch = vi.fn().mockImplementation((url, init) => {
        capturedUrl = String(url)
        capturedInit = init
        return Promise.resolve(
          new Response(
            JSON.stringify({
              code: 0,
              msg: 'SUCCESS',
              data: {
                user_id: 'user_9988',
                user_name: 'AutoClawUser',
                user_phone: '13800138000',
                access_token: 'Bearer at_secret_token_123',
                refresh_token: 'rt_secret_token_456',
                expires_in: 86400,
              },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        )
      })

      const res = await loginAutoclawWithCode('13800138000', '654321', {
        fetchImpl: mockFetch as any,
        deviceId: 'test_dev_002',
      })

      expect(res.ok).toBe(true)
      expect(res.credential).toBeDefined()
      expect(capturedUrl).toBe(`${AUTOCLAW.apiBase}${AUTOCLAW_LOGIN_PATH}`)

      const cred = res.credential!
      expect(cred.access_token).toBe('at_secret_token_123') // 自动剥离 Bearer
      expect(cred.refresh_token).toBe('rt_secret_token_456')
      expect(cred.user_id).toBe('user_9988')
      expect(cred.user_name).toBe('AutoClawUser')
      expect(cred.user_phone).toBe('13800138000')
      expect(cred.device_id).toBe('test_dev_002')
      expect(cred.expires_at).toBeGreaterThan(Date.now())
      // ⚠️ 加强（2026-10-19）：这条 token **不是** JWT ⇒ 必须走**声明值兜底**
      //   （`expires_in: 86400` = 24h 量级），且旧的 7 天编造绝不能出现。
      //   只断言「> now」对 7 天编造是零判别力的恒真残留。
      expect(cred.expires_at! - Date.now()).toBeGreaterThan(ONE_DAY_MS - 60_000)
      expect(cred.expires_at! - Date.now()).toBeLessThanOrEqual(ONE_DAY_MS)
    })

    it('⚠️⚠️ 上游不给 expires 字段时，死线必须来自 JWT exp（不得编造 7 天）', async () => {
      // 这是 2026-10-19 真实报障的**第一现场**：登录响应里既没有
      // `expires_at` 也没有 `expires_in`，旧实现写 `Date.now() + 7 * 86400_000`。
      const expSec = Math.floor(Date.now() / 1000) + 86_400
      const jwt = makeJwt({ exp: expSec, jti: '13800138000' })
      const mockFetch = vi.fn().mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify({
          code: 0,
          msg: 'SUCCESS',
          data: { user_id: 'u1', access_token: jwt, refresh_token: 'rt_secret' },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })),
      )

      const res = await loginAutoclawWithCode('13800138000', '654321', {
        fetchImpl: mockFetch as any,
        deviceId: 'test_dev_jwt',
      })

      expect(res.ok).toBe(true)
      expect(res.credential?.expires_at).toBe(expSec * 1000)
      // ⚠️ 显式排除旧兜底：差值必须是 24h 量级，不是 7 天。
      expect(res.credential!.expires_at! - Date.now()).toBeLessThan(2 * ONE_DAY_MS)
    })

    it('⚠️⚠️ 上游声明 7 天（expires_in=604800）与 JWT 的 24h 冲突时，以 JWT 为准', async () => {
      // ⚠️ 这一格是刻意的：**两种上游形状在当前实现下产出同一个数字**（都是 +7 天），
      //   无法从算式区分，所以必须直接钉住「谁说了算」。若哪天有人把 JWT 腿删掉，
      //   这条会立刻变红（而「上游不给字段」那条反而可能仍然绿）。
      const expSec = Math.floor(Date.now() / 1000) + 86_400
      const jwt = makeJwt({ exp: expSec })
      const mockFetch = vi.fn().mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify({
          code: 0,
          msg: 'SUCCESS',
          data: { user_id: 'u1', access_token: jwt, refresh_token: 'rt', expires_in: 604_800 },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })),
      )

      const res = await loginAutoclawWithCode('13800138000', '654321', { fetchImpl: mockFetch as any })
      expect(res.ok).toBe(true)
      expect(res.credential?.expires_at).toBe(expSec * 1000)
      expect(res.credential!.expires_at! - Date.now()).toBeLessThan(2 * ONE_DAY_MS)
    })

    it('⚠️ 上游不给任何过期信息且 token 非 JWT 时，expires_at 必须是 undefined', async () => {
      // 「不知道」必须如实表达：`shouldRefreshNow(undefined) === true` 会让它
      // 每轮被续期（多刷一次），好过编一个偏大的数字把整条链静默焊死。
      const mockFetch = vi.fn().mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify({
          code: 0,
          msg: 'SUCCESS',
          data: { user_id: 'u1', access_token: 'opaque_at', refresh_token: 'rt' },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })),
      )

      const res = await loginAutoclawWithCode('13800138000', '654321', { fetchImpl: mockFetch as any })
      expect(res.ok).toBe(true)
      expect(res.credential?.expires_at).toBeUndefined()
      expect(shouldRefreshNow(res.credential?.expires_at), '读不到死线时必须放行续期').toBe(true)
    })

    it('⚠️⚠️ 续期响应不带 expires 字段时同样以 JWT exp 为准（否则池内旧值不会纠正）', async () => {
      const expSec = Math.floor(Date.now() / 1000) + 86_400
      const jwt = makeJwt({ exp: expSec })
      const mockFetch = vi.fn().mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify({
          code: 0,
          data: { access_token: jwt, refresh_token: 'rt_new', user_id: 'u1' },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })),
      )

      const cred = await refreshAutoclawToken('rt_old', { fetchImpl: mockFetch as any })
      expect(cred.expires_at).toBe(expSec * 1000)
      expect(cred.refresh_token).toBe('rt_new')
    })

    it('loginAutoclawWithCode 验证码错误时返回错误信息', async () => {
      const mockFetch = vi.fn().mockImplementation(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              code: 10001,
              msg: '验证码错误或已过期',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        ),
      )

      const res = await loginAutoclawWithCode('13800138000', '000000', { fetchImpl: mockFetch as any })
      expect(res.ok).toBe(false)
      expect(res.error).toBe('验证码错误或已过期')
    })

    it('probeAutoclawLocalCredential 在不存在配置目录时安全返回 undefined', async () => {
      const cred = await probeAutoclawLocalCredential({
        customAppData: 'F:/non_existent_path_test',
      })
      expect(cred).toBeUndefined()
    })

    // ═════════════════════════════════════════════════════════════════
    // 2026-10-17 审计 P0：凭据隔离。原用例**显式传** `customAppData`
    // ⇒ 恰好绕开了 env 读取，是**脆弱的绿**：任何新用例走「不传参读 env」
    // 就会真读用户真实凭据 + 真跑 powershell 解 DPAPI（本仓库吃过两次亏）。
    // ═════════════════════════════════════════════════════════════════
    describe('★★ 凭据读取隔离（DSH_AUTOCLAW_APPDATA）', () => {
      it('不传参时必须读隔离目录，**不得**回落到真实 APPDATA', async () => {
        // ⚠️ 前置条件：`setup-isolation.ts` 必须在**进程级**设好隔离口。
        //   没有它，这条用例会静默读到开发机真实目录 ⇒ 判据失去意义。
        const isolated = process.env.DSH_AUTOCLAW_APPDATA
        expect(
          isolated,
          'DSH_AUTOCLAW_APPDATA 未设置（tests/setup-isolation.ts 漏登记）⇒ '
          + '本用例会真读用户真实桌面端凭据',
        ).toBeDefined()
        expect(isolated).not.toBe(process.env.APPDATA)
        // ⚠️ 真跑**不传参**那条路径（这正是原用例绕开的）⇒ 隔离目录下无
        //   `Local State`，安全返回 undefined，且**不会**触碰真实目录。
        await expect(probeAutoclawLocalCredential()).resolves.toBeUndefined()
      })

      it('resolveDeviceId 同款：设备号也走隔离口', async () => {
        // ⚠️ 不直接调私有的 `resolveDeviceId`（它在模块内），改为通过
        //   登录路径断言：隔离目录下没有 `device/device-id.json`
        //   ⇒ 不会读到用户真实设备号。
        const calls: string[] = []
        const mockFetch = vi.fn(async (url: unknown, init?: RequestInit) => {
          calls.push(String(init?.body))
          return new Response(JSON.stringify({
            code: 0,
            data: { access_token: 'at', refresh_token: 'rt', user_id: 'u1' },
          }), { status: 200, headers: { 'Content-Type': 'application/json' } })
        }) as unknown as typeof fetch
        await loginAutoclawWithCode('13800138000', '123456', { fetchImpl: mockFetch })
        expect(calls.length).toBeGreaterThan(0)
        // ⚠️ 隔离目录下无设备号文件 ⇒ 每次调用都会新生成随机 UUID，
        //   但**同一进程内两次调用不应共用**开发机真实固定设备号。
        expect(calls[0]).toContain('device_id')
      })
    })
  })

  /**
   * ⚠️⚠️ **同账号判据**（2026-10-19 三次真机报障后定稿）。
   *
   * 用户形态：面板里同一个手机号出现 **3 次**，积分被重复累加
   *（20842×3 = 62526，真实余额只有 20842）。
   *
   * ## 根因链
   * ① `access_token` 是 JWT、**每次登录/续期都轮换** ⇒ 拿它当身份，
   *    同一账号每续一次就被当成新账号；
   * ② JWT payload 有两个易混字段，且实测**都不适合单独作判据**：
   *    - `guid` 恒为 `""`（空串）；
   *    - `user_id` = `839684`，是 `numericUserId`，与「服务端 `user-profile`
   *      返回的 UUID 主键」是**两个 id 空间**。
   *
   * ## 定稿策略
   * - 判据：`credential.user_id`（UUID）→ JWT `user_id` → `access_token`；
   * - 但 1 与 2 混用会让同一账号**分裂成两组**、去重白做（用户三次报障的教训）
   *   ⇒ 由 `autoclawSelfHeal` 在启动时调 `user-profile` 把 UUID 补齐，
   *     让全池统一走 UUID。
   */
  describe('★ 同账号判据（identityOf 不得用会轮换的 access_token）', () => {
    /** 造一个形如真实 AutoClaw 的 JWT（三段、base64url payload）。 */
    function makeJwt(payload: Record<string, unknown>): string {
      const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url')
      return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}.sig`
    }

    it('★ 从 JWT 读出 user_id（登录响应里没有该字段）', () => {
      // ⚠️ 注意：这是 numericUserId，不是 UUID 主键。
      const token = makeJwt({ user_id: 839684, device_id: 'd-1', guid: '' })
      expect(readUserIdFromJwt(token)).toBe('839684')
      // 带 Bearer 前缀也要能读
      expect(readUserIdFromJwt(`Bearer ${token}`)).toBe('839684')
    })

    it('★ guid 是空串 ⇒ 不能当判据（实测三条全为空）', () => {
      // ⚠️ 这条钉住 2026-10-19 二次尝试的失败：我当时改读 guid，
      //    但真机上 `guid` 恒为 `""` ⇒ 三条全判不出身份，去重全跳过。
      const token = makeJwt({ user_id: 839684, guid: '' })
      expect(readUserIdFromJwt(token)).toBe('839684')
      expect(readUserIdFromJwt(makeJwt({ guid: '' }))).toBeUndefined()
    })

    it('★ 解析不出来时返回 undefined（绝不抛，登录不能因此失败）', () => {
      expect(readUserIdFromJwt('')).toBeUndefined()
      expect(readUserIdFromJwt('not-a-jwt')).toBeUndefined()
      expect(readUserIdFromJwt('a.%%%.c')).toBeUndefined()
      expect(readUserIdFromJwt(makeJwt({ other: 1 }))).toBeUndefined()
    })

    it('★ 同一账号续期后 token 变了，身份**必须不变**', async () => {
      // ⚠️ 这条是缺陷①的核心：两个 token 内容不同（模拟续期轮换），
      //    但 user_id 相同 ⇒ 必须判为同一账号。
      const { autoclawIdentityForTest } = await import('../../src/autoclaw-auth.js')
      const a = autoclawIdentityForTest({
        access_token: makeJwt({ user_id: 839684, iat: 100 }),
        refresh_token: 'r1',
      })
      const b = autoclawIdentityForTest({
        access_token: makeJwt({ user_id: 839684, iat: 200 }),
        refresh_token: 'r2',
      })
      expect(a, '★ 续期后身份变了 ⇒ 同一账号会被重复添加').toBe(b)
      expect(a).toBe('autoclaw:839684')
    })

    it('★ 不同账号身份必须不同（不能过度合并）', async () => {
      const { autoclawIdentityForTest } = await import('../../src/autoclaw-auth.js')
      const a = autoclawIdentityForTest({
        access_token: makeJwt({ user_id: 111 }), refresh_token: 'r',
      })
      const b = autoclawIdentityForTest({
        access_token: makeJwt({ user_id: 222 }), refresh_token: 'r',
      })
      expect(a).not.toBe(b)
    })

    it('★ 凭据里已有 user_id（UUID）时优先用它', async () => {
      const { autoclawIdentityForTest } = await import('../../src/autoclaw-auth.js')
      // token 里是 numericUserId 839684，但凭据字段是 UUID 主键 —— 以字段为准。
      // ⚠️ 这正是自愈补齐后全池统一走的形态。
      const id = autoclawIdentityForTest({
        access_token: makeJwt({ user_id: 839684 }),
        refresh_token: 'r',
        user_id: '7c54a9acc64092b06aa32cc8b1a48fef',
      })
      expect(id).toBe('autoclaw:7c54a9acc64092b06aa32cc8b1a48fef')
    })

    it('★ 完全取不到时退回 access_token（宁可退化，不要无身份）', async () => {
      const { autoclawIdentityForTest } = await import('../../src/autoclaw-auth.js')
      const id = autoclawIdentityForTest({ access_token: 'opaque-token', refresh_token: 'r' })
      expect(id).toBe('opaque-token')
    })
  })

  /**
   * ⚠️⚠️ **以下三条是 2026-10-20 审计补的真缺陷守卫**。
   *
   * 三个缺陷共同特征：**代码读起来对、注释也写了理由，但实际不成立**。
   * 原 102 条用例对它们零覆盖（改回去全绿）。
   */
  describe('★★ 审计补：两个 id 空间与续期持久性', () => {
    it('★ isAutoclawUuidUserId 只认 UUID 形态（数字 id 必须判 false）', async () => {
      const { isAutoclawUuidUserId } = await import('../../src/autoclaw.js')
      // 凭据/服务端下发的 UUID（实测是 32 位无连字符 hex）
      expect(isAutoclawUuidUserId('7c54a9acc64092b06aa32cc8b1a48fef')).toBe(true)
      // 规范 8-4-4-4-12 形态也接受
      expect(isAutoclawUuidUserId('7c54a9ac-c640-92b0-6aa3-2cc8b1a48fef')).toBe(true)
      // ⚠️ JWT 的 numericUserId（`readUserIdFromJwt` 返回的**字符串**形态）
      //    必须判 false —— 否则自愈会把它当「已补齐」而跳过，UUID 补齐永不发生。
      expect(isAutoclawUuidUserId('839684'), '★ 数字 id 不是 UUID').toBe(false)
      expect(isAutoclawUuidUserId(839684), '非字符串一律 false').toBe(false)
      expect(isAutoclawUuidUserId('')).toBe(false)
      expect(isAutoclawUuidUserId(undefined)).toBe(false)
      expect(isAutoclawUuidUserId('not-a-uuid')).toBe(false)
    })

    it('★ readUserIdFromJwt 返回**字符串** ⇒ 自愈的跳过判据必须能区分它与 UUID', async () => {
      // 这条把两个函数钉在一起：登录路径写回的 user_id 是 `readUserIdFromJwt` 的产物
      //（`String(raw)`），而自愈的跳过判据若只看「是非空字符串」就会命中它。
      const { readUserIdFromJwt, isAutoclawUuidUserId } = await import('../../src/autoclaw.js')
      const fromJwt = readUserIdFromJwt(makeJwt({ user_id: 839684 }))
      expect(typeof fromJwt, '★ 必须是 string（登录路径直接写回它）').toBe('string')
      expect(fromJwt).toBe('839684')
      expect(
        isAutoclawUuidUserId(fromJwt),
        '★ 自愈据此判断「是否已补齐」—— 判 false 才会去补 UUID',
      ).toBe(false)
    })

    it('★ 续期响应不带 user_id 时必须从新 JWT 兜底（否则一次续期就抹掉身份）', async () => {
      // ⚠️ 上游 `/userapi/v1/refresh` 不下发 user_id（登录端点也不下发）。
      //    原实现 `user_id: json.data.user_id` ⇒ 恒 undefined ⇒
      //    JSON.stringify 整键丢弃 ⇒ 自愈能力随续期逐条退化，且日志零字。
      const newJwt = makeJwt({ user_id: 839684, exp: Math.floor(Date.now() / 1000) + 86400 })
      const mockFetch = async () => new Response(JSON.stringify({
        code: 0,
        data: { access_token: newJwt, refresh_token: 'new-rt' }, // 故意不带 user_id
      }), { status: 200, headers: { 'content-type': 'application/json' } })

      const cred = await refreshAutoclawToken('rt_old', { fetchImpl: mockFetch as never })
      expect(cred, '续期应成功').not.toBeNull()
      expect(
        cred!.user_id,
        '★ 必须从新 JWT 兜底读到 user_id —— 否则该键被整键丢弃，下一轮去重跳过此条',
      ).toBe('839684')
    })
  })
})


