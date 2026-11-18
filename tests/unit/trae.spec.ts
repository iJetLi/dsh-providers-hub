/**
 * TRAE 协议层单元测试（纯函数）。
 *
 * 覆盖 `src/trae.ts` 的核心逻辑：
 * - 端点常量（移植正确性的第一道防线，改错一个字符就会打到不存在的端点）；
 * - 凭据结构、过期解析、可刷新判定；
 * - 三类请求头构造（SOLO / Ug / OAuth）；
 * - ExchangeToken / GetUserInfo 响应解析与凭据组装；
 * - 模型列表解析；
 * - machine_id / device_id 生成；
 * - **OpenAI 到 SOLO 载荷转换**（本 provider 最核心的差异点）；
 * - SOLO 到 OpenAI 的 SSE 事件解析与聚合。
 *
 * 全部为纯函数测试，不发任何网络请求。
 */

import { describe, expect, it } from 'vitest'
import * as traeModule from '../../src/trae.js'
import {
  OPENAI_DONE,
  TRAE_CHAT_PATH,
  TRAE_CHECKIN_CLAIM_PATH,
  TRAE_CHECKIN_STATUS_PATH,
  TRAE_DEFAULT_MODEL,
  TRAE_ENT_USAGE_PATH,
  TRAE_EXCHANGE_PATH,
  TRAE_FUNCTION,
  TRAE_MODELS_PATH,
  TRAE_USER_INFO_PATH,
  aggregateTraeSSE,
  applyTraeRefresh,
  buildOpenAIChunk,
  buildTraeCredential,
  clampTraeMaxTokens,
  deriveCheckinDeviceId,
  deriveRotatingMachineId,
  generateDeviceId,
  generateMachineId,
  isTraeExpired,
  isTraeModelCallable,
  isTraeModelUsable,
  isTraeRefreshable,
  parseTraeBatchModelList,
  parseTraeExchangeResponse,
  parseTraeModelList,
  parseTraeSSELine,
  parseTraeUserInfoResponse,
  readActivityDiscount,
  readTraeOffPeakDiscount,
  readBooleanField,
  readConsumptionRate,
  readNumberField,
  readStringField,
  traeCredentialExpiresAtMs,
  traeDisplayNickname,
  traeMaxModeFields,
  traeOAuthHeaders,
  traeSOLOHeaders,
  traeUgHeaders,
  traeUsageFromTokenUsage,
  transformToSOLOBody,
  withTraePhone,
} from '../../src/trae.js'
import { TRAE } from '../../src/trae-product.js'
import type { TraeCredential, TraeRemoteModel } from '../../src/trae.js'

function makeCredential(overrides: Partial<TraeCredential> = {}): TraeCredential {
  return {
    access_token: 'AT',
    refresh_token: 'RT',
    expires_at: String(Date.now() + 3_600_000),
    uid: 'uid-1',
    nickname: '测试账号',
    machine_id: 'a'.repeat(32),
    device_id: 'c'.repeat(32),
    ...overrides,
  }
}

describe('TRAE 端点常量', () => {
  it('路径与 trae2api 逆向结果一致', () => {
    // 对齐 trae2api/internal/upstream/constants.go。
    expect(TRAE_CHAT_PATH).toBe('/api/agent/v3/llm_utils_chat')
    expect(TRAE_MODELS_PATH).toBe('/api/ide/v1/get_detail_param')
    expect(TRAE_EXCHANGE_PATH).toBe('/cloudide/api/v3/trae/oauth/ExchangeToken')
    expect(TRAE_USER_INFO_PATH).toBe('/cloudide/api/v3/trae/GetUserInfo')
    expect(TRAE_CHECKIN_STATUS_PATH).toBe('/trae/api/v2/ug/checkin_credits/status')
    expect(TRAE_CHECKIN_CLAIM_PATH).toBe('/trae/api/v2/ug/checkin_credits/claim')
    expect(TRAE_ENT_USAGE_PATH).toBe('/trae/api/v2/pay/ide_user_ent_usage')
  })

  it('对话 function 恒为 solo_work_lite（其他值实测无效）', () => {
    // 实测：work / solo / work_lite 三种取值均无效。
    expect(TRAE_FUNCTION).toBe('solo_work_lite')
    expect(TRAE.function).toBe(TRAE_FUNCTION)
  })

  it('默认模型为 glm-5.2（对齐 Go 端 DefaultConfigName）', () => {
    expect(TRAE_DEFAULT_MODEL).toBe('glm-5.2')
  })
})

describe('安全字段读取', () => {
  it('readStringField 兼容字符串、数字，其余返回空串', () => {
    expect(readStringField({ a: 'x' }, 'a')).toBe('x')
    expect(readStringField({ a: 42 }, 'a')).toBe('42')
    expect(readStringField({ a: null }, 'a')).toBe('')
    expect(readStringField({}, 'a')).toBe('')
  })

  it('readNumberField 兼容数字型字符串，非数字返回 undefined', () => {
    expect(readNumberField({ a: 42 }, 'a')).toBe(42)
    expect(readNumberField({ a: '42' }, 'a')).toBe(42)
    expect(readNumberField({ a: '4.5' }, 'a')).toBe(4.5)
    expect(readNumberField({ a: 'abc' }, 'a')).toBeUndefined()
    expect(readNumberField({}, 'a')).toBeUndefined()
  })
})

describe('凭据过期解析与可刷新判定', () => {
  it('毫秒时间戳字符串按毫秒解析', () => {
    const ms = Date.now() + 3_600_000
    expect(traeCredentialExpiresAtMs(makeCredential({ expires_at: String(ms) }))).toBe(ms)
  })

  it('秒级时间戳自动换算为毫秒', () => {
    const sec = Math.floor((Date.now() + 3_600_000) / 1000)
    const parsed = traeCredentialExpiresAtMs(makeCredential({ expires_at: String(sec) }))
    expect(parsed).toBe(sec * 1000)
  })

  it('ISO 8601 字符串可解析', () => {
    const iso = new Date(Date.now() + 3_600_000).toISOString()
    const parsed = traeCredentialExpiresAtMs(makeCredential({ expires_at: iso }))
    expect(parsed).toBe(Date.parse(iso))
  })

  it('expires_at 缺失时回退解析 JWT 的 exp 声明', () => {
    // 与 Buddy 侧同一兜底策略：access_token 是 JWT 时其 exp 才是权威过期时刻。
    const exp = Math.floor((Date.now() + 3_600_000) / 1000)
    const payload = Buffer.from(JSON.stringify({ exp })).toString('base64url')
    const parsed = traeCredentialExpiresAtMs(makeCredential({
      expires_at: undefined, access_token: `h.${payload}.s`,
    }))
    expect(parsed).toBe(exp * 1000)
  })

  it('无法解析过期时间时不判定为已过期', () => {
    // 与参考实现一致：宁可让上层按 401 处理，也不要凭猜测拒绝可用凭据。
    expect(isTraeExpired(makeCredential({ expires_at: undefined }))).toBe(false)
  })

  it('已过去的过期时间判为已过期', () => {
    expect(isTraeExpired(makeCredential({ expires_at: String(Date.now() - 1000) }))).toBe(true)
  })

  it('isTraeRefreshable 以 refresh_token 长度判定', () => {
    expect(isTraeRefreshable(makeCredential())).toBe(true)
    expect(isTraeRefreshable(makeCredential({ refresh_token: '' }))).toBe(false)
  })
})

describe('TRAE 请求头构造', () => {
  it('SOLO 头含三处相同 token 与全部 X-* 身份头', () => {
    // 对齐 Go 端 SOLOHeaders：Authorization / X-Cloudide-Token / X-Ide-Token
    // 三处都要带，实测缺任一个都可能被上游拒绝。
    const headers = traeSOLOHeaders(makeCredential(), TRAE, true)
    expect(headers.Authorization).toBe('Cloud-IDE-JWT AT')
    expect(headers['X-Cloudide-Token']).toBe('AT')
    expect(headers['X-Ide-Token']).toBe('AT')
    expect(headers['X-Uid']).toBe('uid-1')
    expect(headers['X-App-Id']).toBe(TRAE.appId)
    expect(headers['X-Ide-Version']).toBe(TRAE.ideVersion)
    expect(headers['X-Ide-Version-Code']).toBe(TRAE.ideVersionCode)
    expect(headers['X-Machine-Id']).toBe('a'.repeat(32))
    expect(headers['X-Device-Id']).toBe('c'.repeat(32))
    expect(headers['Request-Traffic-Type']).toBe('prod')
  })

  it('SOLO 头的 Accept 随 stream 切换', () => {
    expect(traeSOLOHeaders(makeCredential(), TRAE, true).Accept).toBe('text/event-stream')
    expect(traeSOLOHeaders(makeCredential(), TRAE, false).Accept).toBe('application/json')
  })

  it('machine_id / device_id 为空时不带对应头（而非带空串）', () => {
    const headers = traeSOLOHeaders(makeCredential({ machine_id: '', device_id: '' }), TRAE, false)
    expect(headers).not.toHaveProperty('X-Machine-Id')
    expect(headers).not.toHaveProperty('X-Device-Id')
  })

  it('Ug 头带 X-User-Region: CN 且不带 SOLO 专属头', () => {
    const headers = traeUgHeaders(makeCredential(), TRAE)
    expect(headers.Authorization).toBe('Cloud-IDE-JWT AT')
    expect(headers['X-User-Region']).toBe('CN')
    expect(headers['X-Device-Id']).toBe('c'.repeat(32))
    // 签到接口不需要这些头，带上反而可能被按错误的客户端形态归因。
    expect(headers).not.toHaveProperty('X-Ide-Version')
    expect(headers).not.toHaveProperty('X-Machine-Id')
    expect(headers).not.toHaveProperty('Request-Traffic-Type')
  })

  it('OAuth 头无 Authorization（换 token 时还没有 token）', () => {
    const headers = traeOAuthHeaders(TRAE)
    expect(headers).not.toHaveProperty('Authorization')
    expect(headers['Content-Type']).toBe('application/json')
    expect(headers['User-Agent']).toBe(TRAE.userAgent)
  })
})

describe('ExchangeToken / GetUserInfo 响应解析', () => {
  it('解析 Result.Token 等字段（Go 端 PascalCase 形态）', () => {
    const parsed = parseTraeExchangeResponse({
      Result: {
        Token: 'AT-NEW',
        RefreshToken: 'RT-NEW',
        TokenExpireAt: 1_786_847_930_141,
        TokenExpireDuration: 3600,
        RefreshExpireAt: 1_790_000_000_000,
      },
    })
    expect(parsed).toMatchObject({
      accessToken: 'AT-NEW',
      refreshToken: 'RT-NEW',
      tokenExpireAt: 1_786_847_930_141,
      tokenExpireDuration: 3600,
    })
  })

  it('兼容 camelCase 形态', () => {
    const parsed = parseTraeExchangeResponse({
      result: { accessToken: 'AT', refreshToken: 'RT', expiresIn: 60 },
    })
    expect(parsed?.accessToken).toBe('AT')
  })

  it('缺少 accessToken 时返回 undefined（视为不可用）', () => {
    expect(parseTraeExchangeResponse({ Result: { RefreshToken: 'RT' } })).toBeUndefined()
    expect(parseTraeExchangeResponse({})).toBeUndefined()
    expect(parseTraeExchangeResponse({ Result: 'not-an-object' })).toBeUndefined()
  })

  it('解析 GetUserInfo 的 UserID / ScreenName / EnterpriseID', () => {
    const parsed = parseTraeUserInfoResponse({
      Result: { UserID: 'u-1', ScreenName: '张三', EnterpriseID: 'ent-1' },
    })
    expect(parsed).toEqual({
      uid: 'u-1', screenName: '张三', enterpriseId: 'ent-1', phone: '', email: '',
    })
  })

  it('GetUserInfo 缺少 UserID 时返回 undefined', () => {
    expect(parseTraeUserInfoResponse({ Result: { ScreenName: 'X' } })).toBeUndefined()
  })
})

describe('凭据组装与续期合并', () => {
  const exchange = {
    accessToken: 'AT', refreshToken: 'RT', tokenExpireAt: 0,
    tokenExpireDuration: 3600, refreshExpireAt: 0,
  }
  const userInfo = { uid: 'u-1', screenName: '张三', enterpriseId: 'ent-1', phone: '', email: '' }
  const session = { machineId: 'a'.repeat(32), deviceId: 'c'.repeat(32) }

  it('buildTraeCredential 保留机器指纹与用户信息', () => {
    const credential = buildTraeCredential(exchange, userInfo, session, 1_700_000_000_000)
    expect(credential).toMatchObject({
      access_token: 'AT',
      refresh_token: 'RT',
      uid: 'u-1',
      nickname: '张三',
      machine_id: 'a'.repeat(32),
      device_id: 'c'.repeat(32),
      enterprise_id: 'ent-1',
    })
    // expiresIn=3600，基准时刻 + 3600s。
    expect(credential.expires_at).toBe(String(1_700_000_000_000 + 3_600_000))
  })

  it('buildTraeCredential 写入脱敏手机号；无手机号时不写空字段', () => {
    const withPhone = buildTraeCredential(
      exchange, { ...userInfo, phone: '130******00' }, session,
    )
    expect(withPhone.phone).toBe('130******00')
    // 空串视为「没有」——不写入，避免凭据里出现无意义的空字段。
    expect(buildTraeCredential(exchange, userInfo, session)).not.toHaveProperty('phone')
  })

  it('buildTraeCredential 写入脱敏邮箱（邮箱登录的账号）', () => {
    const withEmail = buildTraeCredential(
      exchange, { ...userInfo, email: 'a***@163.com' }, session,
    )
    expect(withEmail.email).toBe('a***@163.com')
    expect(buildTraeCredential(exchange, userInfo, session)).not.toHaveProperty('email')
  })

  it('tokenExpireAt 为毫秒级时直接采用', () => {
    const ms = 1_786_847_930_141
    const credential = buildTraeCredential({ ...exchange, tokenExpireAt: ms }, userInfo, session)
    expect(credential.expires_at).toBe(String(ms))
  })

  it('tokenExpireAt 为秒级时换算为毫秒（对齐 Go 的 normalizeExpiresAt）', () => {
    const credential = buildTraeCredential({ ...exchange, tokenExpireAt: 1_786_847_930 }, userInfo, session)
    expect(credential.expires_at).toBe(String(1_786_847_930_000))
  })

  it('applyTraeRefresh 轮换 token 但保留全部身份字段', () => {
    // 这是本 provider 的关键契约：machine_id / device_id 必须原样保留，
    // 重新生成会让服务端按新设备处理，可能要求重新登录。
    const previous = makeCredential({ uid: 'u-1', nickname: '张三', phone: '130******00' })
    const refreshed = applyTraeRefresh(previous, { ...exchange, accessToken: 'AT2', refreshToken: 'RT2' })
    expect(refreshed.access_token).toBe('AT2')
    expect(refreshed.refresh_token).toBe('RT2')
    expect(refreshed.machine_id).toBe(previous.machine_id)
    expect(refreshed.device_id).toBe(previous.device_id)
    expect(refreshed.uid).toBe('u-1')
    expect(refreshed.nickname).toBe('张三')
    // 手机号不在续期响应里，必须原样保留（否则续期后昵称又变回 ScreenName）。
    expect(refreshed.phone).toBe('130******00')
  })

  it('续期响应未返回新 refresh_token 时沿用旧值（不覆盖成空串）', () => {
    const previous = makeCredential({ refresh_token: 'OLD-RT' })
    const refreshed = applyTraeRefresh(previous, { ...exchange, accessToken: 'AT2', refreshToken: '' })
    expect(refreshed.refresh_token).toBe('OLD-RT')
  })
})

describe('模型列表解析', () => {
  it('解析 config_info_list 的 config_name 与 display_config.display_name', () => {
    const models = parseTraeModelList({
      config_info_list: [
        { config_name: 'glm-5.2', display_config: { display_name: 'GLM-5.2' } },
        { config_name: 'DeepSeek-V4-Pro', display_config: { display_name: 'DeepSeek V4 Pro' } },
      ],
    })
    expect(models).toEqual([
      { id: 'glm-5.2', name: 'GLM-5.2' },
      { id: 'DeepSeek-V4-Pro', name: 'DeepSeek V4 Pro' },
    ])
  })

  it('display_name 缺失时回退为 config_name', () => {
    const models = parseTraeModelList({ config_info_list: [{ config_name: 'glm-5' }] })
    expect(models).toEqual([{ id: 'glm-5', name: 'glm-5' }])
  })

  it('无 config_name 的条目被跳过', () => {
    const models = parseTraeModelList({
      config_info_list: [{ display_config: { display_name: 'X' } }, { config_name: 'ok' }],
    })
    expect(models).toEqual([{ id: 'ok', name: 'ok' }])
  })

  it('结构不符时返回空数组（由调用方回退兜底表）', () => {
    for (const bad of [null, undefined, 'str', 42, {}, { config_info_list: 'x' }]) {
      expect(parseTraeModelList(bad), String(bad)).toEqual([])
    }
  })

  /**
   * `display_config.is_custom_model` —— 「仅可见但不可调用」的权威判据。
   *
   * 实测（2026-09-19，遍历 45 个远端模型）：该标志为 `true` 的 5 个模型
   * **全部**被上游以流内 `event:error code=4001 param is invalid` 拒绝；
   * 其余（含名字带 `custom_model_` 前缀但该标志为 `false` 的）均正常。
   * 适配器据此把它们挡在模型目录外。
   *
   * ⚠️ **那 5 个条目的名单已过期**（复测 2026-09-20）：`deepseek-v4-flash` /
   * `agnes-2.5-flash` / `silk-gpt-5.6-luna` 已下架，`glm-5.3-flash` /
   * `qwen3.8-flash` 已转为 `false`（已可调用），全目录 custom 条目数为 0。
   * 故用例**只用合成条目**（`bad` / `good`），不写真实模型名 ——
   * 把某一刻的快照当判据，会让后人误删合法模型（`qwen3.8-flash` 就被误记过）。
   */
  describe('is_custom_model 标志（4001 真实缺陷回归）', () => {
    it('true / false 都被如实读出', () => {
      const models = parseTraeModelList({
        config_info_list: [
          { config_name: 'bad', display_config: { is_custom_model: true } },
          { config_name: 'good', display_config: { is_custom_model: false } },
        ],
      })
      expect(models).toEqual([
        { id: 'bad', name: 'bad', isCustomModel: true },
        { id: 'good', name: 'good', isCustomModel: false },
      ])
    })

    it('字段缺失时留 undefined，而不是填 false', () => {
      // 「上游没说」与「上游说不自定义」是两回事：后者可安全保留，
      // 前者若被伪造成 false，也只是不过滤（保守方向），但绝不能反过来
      // 把「没说」当成 true 而误删可用模型。
      const models = parseTraeModelList({
        config_info_list: [{ config_name: 'x', display_config: { display_name: 'X' } }],
      })
      expect(models).toEqual([{ id: 'x', name: 'X' }])
      expect(models[0]).not.toHaveProperty('isCustomModel')
    })

    it('兼容 PascalCase 形态', () => {
      const models = parseTraeModelList({
        config_info_list: [{ config_name: 'x', DisplayConfig: { IsCustomModel: true } }],
      })
      expect(models[0]!.isCustomModel).toBe(true)
    })

    it('非布尔噪声不被当作 true（避免误删可用模型）', () => {
      for (const noise of ['', 'yes', {}, [], null]) {
        const models = parseTraeModelList({
          config_info_list: [{ config_name: 'x', display_config: { is_custom_model: noise } }],
        })
        expect(models[0]!.isCustomModel, JSON.stringify(noise)).toBeUndefined()
      }
    })
  })
})

/**
 * `batch_get_detail_param` 的**多通道**解析。
 *
 * fixture 直接照抄 Reqable 抓到的真实 TRAE CN 3.3.94 响应形状（含
 * `context_window_tokens` / `model_detail_list[].max_tokens` /
 * `is_invisible_to_user` / `config_switch`），只把值裁剪到最小可判定集合。
 */
describe('多通道批量解析（batch_get_detail_param）', () => {
  /** 一条真实形状的 config 条目。 */
  function entry(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      config_name: id,
      config_source: 1,
      config_switch: true,
      context_window_tokens: { dev: 200000, max: 1000000 },
      display_config: { display_name: id, is_custom_model: false },
      is_default: false,
      is_invisible_to_user: false,
      model_detail_list: [{ model_name: `${id}__dev`, max_tokens: 32000, max_turn: 500 }],
      ...extra,
    }
  }

  /** 构造真实形状的批量响应。 */
  function batch(groups: Array<[string, Array<Record<string, unknown>>]>): unknown {
    return {
      allow_tenant_user_add_model: true,
      function_configs: groups.map(([fn, list]) => ({ function: fn, ab_versions: [], config_info_list: list })),
    }
  }

  /** 一条带思考档位的条目（真实形状）。 */
  function effortEntry(
    id: string,
    options: string[],
    extra: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return entry(id, {
      reasoning_effort_config: {
        default_level: options[options.length - 1],
        options,
        support_thinking: true,
      },
      ...extra,
    })
  }

  it('两侧都无档位时后面的覆盖前面的——同一模型在多个 function 中取最后一条', () => {
    const models = parseTraeBatchModelList(batch([
      ['solo_work_lite', [entry('glm-5.2'), entry('glm-5-turbo')]],
      ['solo_agent_remote', [entry('glm-5.2'), entry('glm-5.1')]],
    ]))
    // glm-5.2 出现在两个通道中，后面的 solo_agent_remote 覆盖前面的 solo_work_lite
    expect(models.map((m) => [m.id, m.function])).toEqual([
      ['glm-5.2', 'solo_agent_remote'],
      ['glm-5-turbo', 'solo_work_lite'],
      ['glm-5.1', 'solo_agent_remote'],
    ])
  })

  // ── issue IKI7WT/IKILR7「模型缺少思考强度」──
  //
  // 真实数据里上游把**空档位**的 `solo_work_lite` / `solo_design_remote` 等条目
  // 排在**最后**，原实现的「无条件后覆盖前」于是用空条目覆盖了信息更全的条目，
  // 实测（2026-09-26）13 个模型丢掉档位、UI 显示「未提供推理等级」。
  describe('档位不被空档位条目覆盖（issue IKI7WT/IKILR7）', () => {
    it('空档位条目排在最后时不得覆盖有档位条目', () => {
      const models = parseTraeBatchModelList(batch([
        ['chat_v3', [effortEntry('deepseek-v4.1-flash', ['light', 'high', 'extra_high'])]],
        ['solo_agent', [effortEntry('deepseek-v4.1-flash', ['light', 'high', 'extra_high'])]],
        ['solo_work_lite', [entry('deepseek-v4.1-flash', {
          reasoning_effort_config: { options: [], support_thinking: false },
        })]],
      ]))
      const model = models[0]!
      // ⚠️ 反向验证：把本用例喂给修改前的「无条件后覆盖前」实现，
      // `function` 会变成 `solo_work_lite`、`reasoningConfig.options` 会变成 `[]`。
      expect(model.function).toBe('solo_agent')
      expect(model.reasoningConfig?.options).toEqual(['light', 'high', 'extra_high'])
    })

    it('完全没有 reasoning_effort_config 的条目同样不得覆盖有档位条目', () => {
      const models = parseTraeBatchModelList(batch([
        ['solo_agent', [effortEntry('glm-5.2', ['high', 'extra_high'])]],
        ['solo_design_remote', [entry('glm-5.2')]],
      ]))
      expect(models[0]!.function).toBe('solo_agent')
      expect(models[0]!.reasoningConfig?.options).toEqual(['high', 'extra_high'])
    })

    it('两侧都有档位时按通道优先级取更靠前者（不是后覆盖前）', () => {
      const models = parseTraeBatchModelList(batch([
        ['solo_agent_remote', [effortEntry('glm-5.2', ['high', 'extra_high'])]],
        ['solo_agent', [effortEntry('glm-5.2', ['light', 'high', 'extra_high'])]],
      ]))
      // solo_agent 在 TRAE_CHANNELS 中位于首位，虽然后出现仍应胜出。
      expect(models[0]!.function).toBe('solo_agent')
      expect(models[0]!.reasoningConfig?.options).toEqual(['light', 'high', 'extra_high'])
    })

    it('优先级表可用第二参数覆盖（⚠️ 覆盖的是**整张白名单**，不只是顺序）', () => {
      const body = batch([
        ['solo_agent', [effortEntry('glm-5.2', ['high'])]],
        ['solo_work_lite', [effortEntry('glm-5.2', ['high', 'extra_high'])]],
      ])
      expect(parseTraeBatchModelList(body)[0]!.function).toBe('solo_agent')
      // 显式把 solo_work_lite 提为首位 → 选中它。
      expect(parseTraeBatchModelList(body, ['solo_work_lite'])[0]!.function).toBe('solo_work_lite')
      // ⚠️ Issue IKJOZ7：该参数**同时是准入白名单**，故传只含一个通道的表会让
      // 另一个通道的条目**整组消失**（不再是「仅降为最低优先级」）。
      expect(parseTraeBatchModelList(body, ['solo_work_lite'])).toHaveLength(1)
    })

    it('⚠️ 通道优先级表同时是白名单：非白名单通道的条目无论内容多全都不得进目录', () => {
      // Issue IKJOZ7。`chat` 实测在本插件的推理端点下**不可调用**
      // （`code=4023 the model is unknown`），故即便它声明了档位也不得进目录 ——
      // 进去就意味着「能选中、一发就失败」，而错误文案指向模型本身。
      //
      // ⚠️ 反向验证：把 `parseTraeBatchModelList` 里的白名单准入去掉（恢复
      // 「channelPriority 只用于排序」的旧行为），本用例会变红（`chat` 的条目
      // 会带着 `function: 'chat'` 出现在结果里）。
      const models = parseTraeBatchModelList(batch([
        ['chat', [effortEntry('x', ['light', 'high', 'extra_high'])]],
        ['solo_agent', [effortEntry('x', ['high'])]],
      ]))
      expect(models).toHaveLength(1)
      expect(models[0]!.function).toBe('solo_agent')
      expect(models[0]!.reasoningConfig?.options).toEqual(['high'])
    })

    it('仅见于不可调用通道的模型被整个剔除（不留下一发就失败的条目）', () => {
      // `kimi-k2` 实测只出现在 `inline_chat`（该通道回 `3003 model service is
      // unavailable`）；`doubao_1_8` 只出现在 `chat`。二者都必须消失。
      const models = parseTraeBatchModelList(batch([
        ['inline_chat', [entry('kimi-k2')]],
        ['chat', [entry('doubao_1_8')]],
        ['solo_agent', [entry('glm-5.2')]],
      ]))
      expect(models.map((m) => m.id)).toEqual(['glm-5.2'])
    })

    it('同时出现在可调用与不可调用通道的模型被保留，且通道纠正为可调用的那个', () => {
      // `glm-5.1` / `DeepSeek-V4-Flash` 等实测既在 `chat`（不可调用）也在
      // `solo_coder`（可调用）。剔除不可调用通道后它**不该消失**，而应改走
      // 可调用通道 —— 这正是「严格白名单」与「一刀切删模型」的区别。
      const models = parseTraeBatchModelList(batch([
        ['chat', [entry('glm-5.1')]],
        ['solo_coder', [entry('glm-5.1')]],
      ]))
      expect(models.map((m) => [m.id, m.function])).toEqual([['glm-5.1', 'solo_coder']])
    })

    it('未声明 function 的组被跳过（无通道可路由 ⇒ 不该进目录）', () => {
      const models = parseTraeBatchModelList({
        function_configs: [
          { config_info_list: [entry('orphan')] },
          { function: 'solo_agent', config_info_list: [entry('ok')] },
        ],
      })
      expect(models.map((m) => m.id)).toEqual(['ok'])
    })

    it('support_thinking:false 的条目不算「能声明档位」（与适配器判据一致）', () => {
      const models = parseTraeBatchModelList(batch([
        ['solo_agent', [effortEntry('x', ['high', 'extra_high'])]],
        // options 非空但显式不支持思考：适配器 `reasoningFor` 仍会返回 undefined，
        // 故它不得把真正能声明的条目覆盖掉（否则等于没修）。
        ['solo_work_lite', [entry('x', {
          reasoning_effort_config: { options: ['high'], support_thinking: false },
        })]],
      ]))
      expect(models[0]!.function).toBe('solo_agent')
      expect(models[0]!.reasoningConfig?.supportThinking).toBe(true)
    })

    it('有档位条目之后的空档位条目仍可用于过滤（isHidden 等三条硬过滤不受影响）', () => {
      const models = parseTraeBatchModelList(batch([
        ['solo_agent', [effortEntry('x', ['high'])]],
        ['solo_work_lite', [
          entry('x', { reasoning_effort_config: { options: [], support_thinking: false }, is_invisible_to_user: true }),
          entry('y', { is_invisible_to_user: true }),
        ]],
      ]))
      expect(models.map((m) => m.id)).toEqual(['x'])
      expect(models[0]!.function).toBe('solo_agent')
    })
  })

  it('读取 context_window_tokens.dev（不是 max）与 model_detail_list.max_tokens', () => {
    const [model] = parseTraeBatchModelList(batch([['solo_agent', [entry('glm-5.2')]]]))
    // dev=200000：max=1000000 需开 max_mode，本插件不实现，采信会让请求被拒
    expect(model!.contextWindow).toBe(200_000)
    expect(model!.maxOutputTokens).toBe(32_000)
  })

  it('dev 缺失时回退 max', () => {
    const [model] = parseTraeBatchModelList(batch([['solo_agent', [
      entry('x', { context_window_tokens: { max: 1_000_000 } }),
    ]]]))
    expect(model!.contextWindow).toBe(1_000_000)
  })

  it('多条 model_detail_list 时优先取 __dev 那条的 max_tokens', () => {
    const [model] = parseTraeBatchModelList(batch([['solo_agent', [
      entry('custom_model_1M', {
        model_detail_list: [
          { model_name: 'custom_model_1M__max', max_tokens: 384000 },
          { model_name: 'custom_model_1M__dev', max_tokens: 64000 },
        ],
      }),
    ]]]))
    expect(model!.maxOutputTokens).toBe(64_000)
  })

  it('parseTraeBatchModelList 过滤 isHidden / config_switch / usage 三类条目', () => {
    const models = parseTraeBatchModelList(batch([['solo_work_lite', [
      entry('visible'),
      entry('summary', { is_invisible_to_user: true }),
      entry('retired', { config_switch: false }),
      entry('deepseek-v4-flash', { display_config: { display_name: 'X', is_custom_model: true } }),
    ]]]))
    // `is_invisible_to_user` 和 `config_switch` 在解析时硬性过滤；
    // `is_custom_model` 不在此过滤（运行时 `isTraeModelCallable` 中处理）
    expect(models.map((m) => m.id)).toEqual(['visible', 'deepseek-v4-flash'])
  })

  it('isTraeModelUsable 仍可独立控制 hideInternal', () => {
    // isTraeModelUsable 是纯函数，保留 hideInternal 参数供直接使用。
    // parseTraeBatchModelList 内部现在硬性过滤 isHidden，但函数本身不变。
    const visible = { id: 'visible', name: 'V' } as TraeRemoteModel
    const hidden = { id: 'summary', name: 'Summary', isHidden: true } as TraeRemoteModel
    const retired = { id: 'retired', name: 'R', isEnabled: false } as TraeRemoteModel
    const custom = { id: 'df-v4', name: 'X', isCustomModel: true } as TraeRemoteModel
    expect(isTraeModelUsable(visible)).toBe(true)
    expect(isTraeModelUsable(hidden)).toBe(true) // hideInternal 默认 false
    expect(isTraeModelUsable(hidden, { hideInternal: true })).toBe(false)
    expect(isTraeModelUsable(retired)).toBe(false)
    expect(isTraeModelUsable(custom)).toBe(false)
  })

  // ── 推理强度（reasoning_effort_config）──

  it('读出 reasoning_effort_config 的 default_level / options / support_thinking', () => {
    const [model] = parseTraeBatchModelList(batch([['solo_agent', [
      entry('glm-5.3', {
        reasoning_effort_config: {
          default_level: 'high',
          options: ['light', 'high', 'extra_high'],
          support_thinking: true,
        },
      }),
    ]]]))
    expect(model!.reasoningConfig).toEqual({
      defaultLevel: 'high',
      options: ['light', 'high', 'extra_high'],
      supportThinking: true,
    })
  })

  it('无 reasoning_effort_config 的模型不声明该字段（而不是空配置）', () => {
    const [model] = parseTraeBatchModelList(batch([['solo_agent', [entry('kimi-k3')]]]))
    expect(model!.reasoningConfig).toBeUndefined()
  })

  it('options 为对象数组时也能读出 wire 值（防御性兼容双字段形态）', () => {
    const [model] = parseTraeBatchModelList(batch([['solo_agent', [
      entry('x', {
        reasoning_effort_config: {
          default_level: 'max',
          options: [
            { level: 'max', openclawLevel: 'xhigh' },
            { level: 'low', openclawLevel: 'low' },
          ],
        },
      }),
    ]]]))
    // 优先取 openclawLevel（wire 值），缺失时回退 level
    expect(model!.reasoningConfig?.options).toEqual(['xhigh', 'low'])
  })

  it('support_thinking=false 时如实读出（调用方据此不声明档位）', () => {
    const [model] = parseTraeBatchModelList(batch([['solo_agent', [
      entry('x', { reasoning_effort_config: { options: ['high'], support_thinking: false } }),
    ]]]))
    expect(model!.reasoningConfig?.supportThinking).toBe(false)
    expect(model!.reasoningConfig?.options).toEqual(['high'])
  })

  // ── 图片能力（Issue #IKHDKC）──

  it('读出 display_config.multimodal（逐模型，不是按 provider 一刀切）', () => {
    const [model] = parseTraeBatchModelList(batch([['solo_agent', [
      entry('deepseek-v4.1-flash', {
        display_config: { display_name: 'DeepSeek-V4.1-Flash', multimodal: true },
      }),
    ]]]))
    expect(model!.multimodal).toBe(true)
  })

  it('multimodal=false 如实读出（不能当成「未声明」）', () => {
    // 「远端说不支持」与「远端没说」是两回事：前者可用于拒绝，后者只能保守处理。
    const [model] = parseTraeBatchModelList(batch([['solo_agent', [
      entry('glm-5.2', { display_config: { display_name: 'GLM-5.2', multimodal: false } }),
    ]]]))
    expect(model!.multimodal).toBe(false)
  })

  it('未声明 multimodal 的模型该字段为 undefined（不臆造能力）', () => {
    const [model] = parseTraeBatchModelList(batch([['solo_agent', [
      entry('x', { display_config: { display_name: 'X' } }),
    ]]]))
    expect(model!.multimodal).toBeUndefined()
  })

  it('⚠️ 用户贴图与工具结果图是**两个独立字段**，不可合并', () => {
    // 实测 deepseek-v4.1-flash: multimodal=true 而 tool_response_multimodal=false
    // （用户能贴图，但工具读到的图回传不了）；Doubao/Kimi 系列则两者皆 true。
    const [model] = parseTraeBatchModelList(batch([['solo_agent', [
      entry('deepseek-v4.1-flash', {
        display_config: {
          display_name: 'DeepSeek-V4.1-Flash',
          multimodal: true,
          tool_response_multimodal: false,
        },
      }),
    ]]]))
    expect(model!.multimodal).toBe(true)
    expect(model!.toolResponseMultimodal).toBe(false)
  })

  it('兼容 PascalCase 形态', () => {
    // 注意 `entry()` 已内置 `display_config`，故 PascalCase 键要写在它**内部**
    // （代码优先取 `display_config`，容器名写成 `DisplayConfig` 会被忽略）。
    const [model] = parseTraeBatchModelList(batch([['solo_agent', [
      entry('x', { display_config: { display_name: 'X', Multimodal: true, ToolResponseMultimodal: true } }),
    ]]]))
    expect(model!.multimodal).toBe(true)
    expect(model!.toolResponseMultimodal).toBe(true)
  })

  // ── Max 模式（1M 上下文）──

  it('读出 display_config.max_mode 与 context_window_tokens.max', () => {
    const [model] = parseTraeBatchModelList(batch([['solo_agent', [
      entry('glm-5.3', {
        context_window_tokens: { dev: 200000, max: 1000000 },
        display_config: { display_name: 'GLM-5.3', max_mode: true },
      }),
    ]]]))
    expect(model!.maxMode).toBe(true)
    expect(model!.maxContextWindow).toBe(1_000_000)
    // dev 仍是常规窗口，两者不可混用
    expect(model!.contextWindow).toBe(200_000)
  })

  it('未标 max_mode 的模型 maxMode 为 undefined（不臆造 1M 能力）', () => {
    const [model] = parseTraeBatchModelList(batch([['solo_agent', [
      entry('glm-5.3', {
        context_window_tokens: { dev: 200000, max: 1000000 },
        display_config: { display_name: 'GLM-5.3' },
      }),
    ]]]))
    expect(model!.maxMode).toBeUndefined()
    // 窗口仍可读出（供 resolveModel 在 Max 模式开启时使用），但能力标志未置位
    expect(model!.maxContextWindow).toBe(1_000_000)
  })

  it('读出 __max 明细的 max_tokens 作为 Max 模式输出上限', () => {
    const [model] = parseTraeBatchModelList(batch([['solo_agent', [
      entry('custom_model_1M', {
        model_detail_list: [
          { model_name: 'custom_model_1M__dev', max_tokens: 64000 },
          { model_name: 'custom_model_1M__max', max_tokens: 384000 },
        ],
      }),
    ]]]))
    expect(model!.maxOutputTokens).toBe(64_000)
    expect(model!.maxModeOutputTokens).toBe(384_000)
  })

  it('traeMaxModeFields 成套下发 strategy/mode_type/窗口三件套', () => {
    const fields = traeMaxModeFields(1_000_000, 384_000)
    expect(fields).toMatchObject({
      model_selection_strategy: 'max',
      mode_type: 1,
      context_window_size: 1_000_000,
      prompt_max_tokens: 936_000,
      max_tokens: 384_000,
    })
    expect(fields.model_auto_selection).toEqual({
      strategy: 'max',
      fallback_to_advance_model: null,
      entitlement_id: null,
    })
  })

  it('traeMaxModeFields 未给输出上限时用 64K 兜底', () => {
    expect(traeMaxModeFields(1_000_000)).toMatchObject({
      context_window_size: 1_000_000,
      prompt_max_tokens: 936_000,
      max_tokens: 64_000,
    })
  })

  it('同一模型在 A 通道不可调用、B 通道可调用时，保留可调用的那条及其通道', () => {
    // 可调用性是**逐通道**的：不能因为先遍历到不可调用的条目就把模型整个丢掉。
    const models = parseTraeBatchModelList(batch([
      ['solo_agent', [entry('kimi-k3', { display_config: { display_name: 'K', is_custom_model: true } })]],
      ['solo_work_lite', [entry('kimi-k3')]],
    ]))
    expect(models).toHaveLength(1)
    expect(models[0]!.function).toBe('solo_work_lite')
    expect(isTraeModelCallable(models[0]!)).toBe(true)
  })

  it('无 config_name 的条目被跳过；结构不符返回空数组', () => {
    const models = parseTraeBatchModelList(batch([['solo_agent', [{ config_switch: true }]]]))
    expect(models).toEqual([])
    for (const bad of [null, undefined, 'str', 42, {}, { function_configs: 'x' }]) {
      expect(parseTraeBatchModelList(bad), String(bad)).toEqual([])
    }
  })
})

describe('readBooleanField', () => {
  it('只有明确布尔语义才返回值', () => {
    expect(readBooleanField({ v: true }, 'v')).toBe(true)
    expect(readBooleanField({ v: false }, 'v')).toBe(false)
    expect(readBooleanField({ v: 1 }, 'v')).toBe(true)
    expect(readBooleanField({ v: 0 }, 'v')).toBe(false)
    expect(readBooleanField({ v: 'true' }, 'v')).toBe(true)
    expect(readBooleanField({ v: 'false' }, 'v')).toBe(false)
  })

  it('缺失或非布尔语义返回 undefined', () => {
    for (const noise of [undefined, null, '', 'yes', {}, [], 2]) {
      expect(readBooleanField({ v: noise }, 'v'), JSON.stringify(noise)).toBeUndefined()
    }
    expect(readBooleanField({}, 'v')).toBeUndefined()
  })
})

describe('machine_id / device_id 生成', () => {
  it('machine_id 为 32 位 hex 字符', () => {
    for (let i = 0; i < 20; i++) {
      const id = generateMachineId()
      expect(id).toMatch(/^[0-9a-f]{32}$/)
    }
  })

  it('machine_id 每次生成都不同', () => {
    const ids = new Set(Array.from({ length: 50 }, () => generateMachineId()))
    expect(ids.size).toBe(50)
  })

  it('device_id 为 32 位 hex（对齐 login.sh 的 openssl rand -hex 16）', () => {
    // 早期实现错误地生成了「16 位纯数字」（那是 CodeBuddy 的签到格式），
    // 与 TRAE 协议不符：该值随登录 URL 下发并用于签到 X-Device-Id 头。
    // 空值签到会报 9004；两账号共用同一 deviceId 会被「该设备已签到」拦截。
    for (let i = 0; i < 20; i++) {
      const id = generateDeviceId()
      expect(id).toMatch(/^[0-9a-f]{32}$/)
    }
  })

  it('device_id 每次生成都不同（账号间必须互异）', () => {
    const ids = new Set(Array.from({ length: 50 }, () => generateDeviceId()))
    expect(ids.size).toBe(50)
  })
})

describe('签到设备号派生（9074 轮换）', () => {
  const base = 'c'.repeat(32)

  it('generation <= 0 时原样返回基础 id（既有账号行为不变）', () => {
    expect(deriveCheckinDeviceId(base, 0)).toBe(base)
    expect(deriveCheckinDeviceId(base, -1)).toBe(base)
    expect(deriveCheckinDeviceId(base, Number.NaN)).toBe(base)
  })

  it('⚠️ 派生结果必须是 32 位 hex（不是 sha256 的 64 位）', () => {
    // device_id 是 openssl rand -hex 16 的产物，即 16 字节 = **32** 个 hex 字符。
    // 直接下发 sha256 的 64 位会与协议格式不符。
    for (const generation of [1, 2, 7, 99]) {
      expect(deriveCheckinDeviceId(base, generation)).toMatch(/^[0-9a-f]{32}$/)
    }
  })

  it('同一 (id, 代次) 派生的结果稳定（可跨重启复现，无需持久化新 id）', () => {
    expect(deriveCheckinDeviceId(base, 3)).toBe(deriveCheckinDeviceId(base, 3))
  })

  it('不同代次派生出不同 id（否则轮换无效）', () => {
    const ids = new Set([1, 2, 3, 4, 5].map((g) => deriveCheckinDeviceId(base, g)))
    expect(ids.size).toBe(5)
  })

  it('不同基础 id 派生结果也不同（账号间互异）', () => {
    expect(deriveCheckinDeviceId('a'.repeat(32), 1)).not.toBe(deriveCheckinDeviceId('b'.repeat(32), 1))
  })
})

describe('机器指纹轮换派生', () => {
  const base = 'd'.repeat(32)

  it('generation <= 0 时原样返回（默认不轮换）', () => {
    expect(deriveRotatingMachineId(base, 0)).toBe(base)
  })

  it('派生结果为 32 位 hex，且不同代次互异', () => {
    const first = deriveRotatingMachineId(base, 1)
    const second = deriveRotatingMachineId(base, 2)
    expect(first).toMatch(/^[0-9a-f]{32}$/)
    expect(first).not.toBe(second)
  })
})

describe('max_tokens 收敛（上游 64K 安全线）', () => {
  it('超过上限时收敛到上限', () => {
    expect(clampTraeMaxTokens(131_072, 64_000)).toBe(64_000)
  })

  it('小于上限时原样返回', () => {
    expect(clampTraeMaxTokens(1024, 64_000)).toBe(1024)
  })

  it('undefined / 非正数原样返回（不编造数值）', () => {
    expect(clampTraeMaxTokens(undefined, 64_000)).toBeUndefined()
    expect(clampTraeMaxTokens(0, 64_000)).toBe(0)
    expect(clampTraeMaxTokens(-5, 64_000)).toBe(-5)
  })

  it('上限为 0 表示关闭收敛（可用环境变量放开）', () => {
    expect(clampTraeMaxTokens(131_072, 0)).toBe(131_072)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// OpenAI 到 SOLO 载荷转换（本 provider 最核心的差异）
// ─────────────────────────────────────────────────────────────────────────────

describe('OpenAI 到 SOLO 载荷转换', () => {
  it('强制 stream=true 并注入固定 function', () => {
    const out = transformToSOLOBody({ model: 'glm-5.2', messages: [], stream: false })
    expect(out.stream).toBe(true)
    expect(out.function).toBe('solo_work_lite')
  })

  it('model 同时写入 config_name 与 model（上游两个字段都要）', () => {
    const out = transformToSOLOBody({ model: 'DeepSeek-V4-Pro', messages: [] })
    expect(out.config_name).toBe('DeepSeek-V4-Pro')
    expect(out.model).toBe('DeepSeek-V4-Pro')
  })

  it('model 缺失时回退默认值 glm-5.2', () => {
    const out = transformToSOLOBody({ messages: [] })
    expect(out.config_name).toBe(TRAE_DEFAULT_MODEL)
    expect(out.model).toBe(TRAE_DEFAULT_MODEL)
  })

  it('去除内部名后缀 __dev（对齐 Go 端 mapModel）', () => {
    const out = transformToSOLOBody({ model: 'glm-5.2__dev', messages: [] })
    expect(out.config_name).toBe('glm-5.2')
  })

  it('显式 modelMapping 优先于请求体里的 model', () => {
    const out = transformToSOLOBody({ model: 'alias', messages: [] }, 'glm-5.2')
    expect(out.config_name).toBe('glm-5.2')
  })

  it('messages.content 字符串转为 [{type:"text",text}] 数组', () => {
    const out = transformToSOLOBody({
      model: 'glm-5.2',
      messages: [{ role: 'user', content: '你好' }],
    })
    expect((out.messages as Array<Record<string, unknown>>)[0]).toEqual({
      role: 'user',
      content: [{ type: 'text', text: '你好' }],
    })
  })

  it('content 已是数组时原样透传（兼容多模态）', () => {
    const parts = [{ type: 'text', text: 'x' }]
    const out = transformToSOLOBody({
      model: 'glm-5.2', messages: [{ role: 'user', content: parts }],
    })
    expect((out.messages as Array<Record<string, unknown>>)[0]!.content).toBe(parts)
  })

  it('assistant 的 tool_calls.function 转为 function_call（SOLO 字段名）', () => {
    const out = transformToSOLOBody({
      model: 'glm-5.2',
      messages: [{
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{}' } }],
      }],
    })
    const msg = (out.messages as Array<Record<string, unknown>>)[0]!
    const call = (msg.tool_calls as Array<Record<string, unknown>>)[0]!
    expect(call).toHaveProperty('function_call')
    expect(call).not.toHaveProperty('function')
    expect((call.function_call as Record<string, unknown>).name).toBe('read')
  })

  it('无 name 的 tool_call 被剔除（上游要求 FunctionCall.Name 必填）', () => {
    const out = transformToSOLOBody({
      model: 'glm-5.2',
      messages: [{
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: '', arguments: '{}' } },
          { id: 'c2', type: 'function', function: { name: 'read', arguments: '{}' } },
        ],
      }],
    })
    const msg = (out.messages as Array<Record<string, unknown>>)[0]!
    expect((msg.tool_calls as unknown[]).length).toBe(1)
  })

  it('全部 tool_call 都无 name 时删除该字段（而非留空数组）', () => {
    const out = transformToSOLOBody({
      model: 'glm-5.2',
      messages: [{ role: 'assistant', content: null, tool_calls: [{ id: 'c1', function: { name: '' } }] }],
    })
    expect((out.messages as Array<Record<string, unknown>>)[0]).not.toHaveProperty('tool_calls')
  })

  it('tools 的 parameters 对象序列化为 JSON 字符串（SOLO 上游要求 string）', () => {
    const out = transformToSOLOBody({
      model: 'glm-5.2',
      messages: [],
      tools: [{
        type: 'function',
        function: { name: 'read', description: 'd', parameters: { type: 'object', properties: {} } },
      }],
    })
    const tool = (out.tools as Array<Record<string, unknown>>)[0]!
    const fn = tool.function as Record<string, unknown>
    expect(typeof fn.parameters).toBe('string')
    expect(JSON.parse(fn.parameters as string)).toEqual({ type: 'object', properties: {} })
  })

  it('tool_choice "none" 同时删除 tools（上游据此判定不调用工具）', () => {
    const out = transformToSOLOBody({
      model: 'glm-5.2', messages: [], tool_choice: 'none',
      tools: [{ type: 'function', function: { name: 'x', parameters: {} } }],
    })
    expect(out).not.toHaveProperty('tool_choice')
    expect(out).not.toHaveProperty('tools')
  })

  it('tool_choice 对象 {type:"auto"} 归一化为字符串 "auto"', () => {
    const out = transformToSOLOBody({ model: 'glm-5.2', messages: [], tool_choice: { type: 'auto' } })
    expect(out.tool_choice).toBe('auto')
  })

  it('tool_choice {type:"function",function:{name}} 归一化为该名字字符串', () => {
    const out = transformToSOLOBody({
      model: 'glm-5.2', messages: [],
      tool_choice: { type: 'function', function: { name: 'read' } },
    })
    expect(out.tool_choice).toBe('read')
  })

  it('缺 function.name 的 tool_choice 回退为 "auto"', () => {
    const out = transformToSOLOBody({
      model: 'glm-5.2', messages: [], tool_choice: { type: 'function', function: {} },
    })
    expect(out.tool_choice).toBe('auto')
  })

  it('未知 tool_choice 形态被删除（不把非法值发给上游）', () => {
    const out = transformToSOLOBody({ model: 'glm-5.2', messages: [], tool_choice: 42 })
    expect(out).not.toHaveProperty('tool_choice')
  })

  it('不修改传入的原始对象（纯函数语义）', () => {
    const original = { model: 'glm-5.2', messages: [{ role: 'user', content: 'hi' }] }
    const snapshot = JSON.stringify(original)
    transformToSOLOBody(original)
    expect(JSON.stringify(original)).toBe(snapshot)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// SOLO 到 OpenAI SSE 解析
// ─────────────────────────────────────────────────────────────────────────────

describe('SOLO SSE 事件解析', () => {
  it('解析 output 事件的 response 与 reasoning_content', () => {
    const ev = parseTraeSSELine('output', JSON.stringify({
      response: '正文', reasoning_content: '思考', tool_calls: null,
    }))
    expect(ev).toMatchObject({ event: 'output', response: '正文', reasoningContent: '思考' })
  })

  it('output 的 function_call 归一化为 function 并清理 SOLO 专属字段', () => {
    const ev = parseTraeSSELine('output', JSON.stringify({
      tool_calls: [{
        index: 0,
        function_call: { name: 'read', arguments: '{}', namespace: 'ns', partial_arguments: 'p' },
      }],
    }))
    const call = (ev!.toolCalls as Array<Record<string, unknown>>)[0]!
    expect(call).toHaveProperty('function')
    expect(call).not.toHaveProperty('function_call')
    const fn = call.function as Record<string, unknown>
    expect(fn.name).toBe('read')
    expect(fn).not.toHaveProperty('namespace')
    expect(fn).not.toHaveProperty('partial_arguments')
  })

  it('解析 token_usage 事件', () => {
    const ev = parseTraeSSELine('token_usage', JSON.stringify({
      prompt_tokens: 21, completion_tokens: 142, total_tokens: 163, reasoning_tokens: 135,
    }))
    expect(ev?.usage).toMatchObject({ prompt_tokens: 21, completion_tokens: 142 })
  })

  it('解析 done 事件的 finish_reason', () => {
    expect(parseTraeSSELine('done', JSON.stringify({ finish_reason: 'stop' }))?.finishReason).toBe('stop')
  })
  it('解析 error 事件的 code 与 message', () => {
    const ev = parseTraeSSELine('error', JSON.stringify({ code: 4008, message: '配额超限' }))
    expect(ev).toMatchObject({ errorCode: 4008, errorMessage: '配额超限' })
  })

  it('data 非 JSON 时只保留事件名（不抛错）', () => {
    expect(parseTraeSSELine('output', 'not-json')).toEqual({ event: 'output' })
  })

  it('data 为空时只保留事件名', () => {
    expect(parseTraeSSELine('metadata', '')).toEqual({ event: 'metadata' })
  })
})

/**
 * `token_usage` → DSH `TokenUsage` 的口径转换（**真实缺陷回归**）。
 *
 * 缺陷：早期实现只读 `prompt_tokens` / `completion_tokens` / `reasoning_tokens`，
 * 把上游**确实下发**的 `cache_read_input_tokens` 丢弃 ⇒ DSH 投影层
 * `cacheReadTokens ?? 0` 归一成 0 ⇒ 界面恒显「缓存命中 0%」。
 *
 * ⚠️ 本段用**真实报文**（2026-10-12 实机直发 dump，`glm-5.2` 同前缀两次），
 * 不是自造数字 —— 自造 fixture 会把「prompt_tokens 是否含缓存」这个关键
 * 判断编成实现的样子，从而恒真。
 */
describe('TRAE token_usage → TokenUsage 口径', () => {
  /** 第 1 次（冷）：实测原始报文，`cache_read_input_tokens` 为 0。 */
  const COLD = {
    name: '', prompt_tokens: 4894, completion_tokens: 118, total_tokens: 5012,
    cache_creation_input_tokens: 0, cache_read_input_tokens: 0, reasoning_tokens: 116,
    prompt_tokens_total: 0, completion_tokens_total: 0, total_tokens_total: 0,
    cache_creation_input_tokens_total: 0, cache_read_input_tokens_total: 0,
    reasoning_tokens_total: 0, cluster: 'normal_context',
  }
  /** 第 2 次（同前缀复用）：实测原始报文，命中 4864。 */
  const REUSED = { ...COLD, completion_tokens: 2, total_tokens: 4896, cache_read_input_tokens: 4864, reasoning_tokens: 0 }

  it('★ 命中时上报 cacheReadTokens（缺陷的直接回归）', () => {
    const usage = traeUsageFromTokenUsage(REUSED)
    expect(usage.cacheReadTokens).toBe(4864)
  })

  it('保留明确上报的 0，未上报时省略缓存计数', () => {
    expect(traeUsageFromTokenUsage(COLD)).toHaveProperty('cacheReadTokens', 0)
    expect(traeUsageFromTokenUsage({ prompt_tokens: 4894, completion_tokens: 118 })).not.toHaveProperty('cacheReadTokens')
  })

  it('★ prompt_tokens 含缓存 ⇒ 必须做减法（否则命中率偏小）', () => {
    // 判据来自同前缀两次真实请求：prompt_tokens 恒 4894 而命中从 0 变 4864。
    // 若不做减法，未命中会一直是 4894，命中率被算成 4864/(4894+4864)=49.8%
    // 而不是正确的 4864/4894=99.4%。
    const usage = traeUsageFromTokenUsage(REUSED)
    expect(usage.inputTokens).toBe(4894 - 4864)
    expect(usage.inputTokens + (usage.cacheReadTokens ?? 0)).toBe(4894)
  })

  it('★ 冷启动两次的 prompt 总量一致（证明总量字段不随命中变化）', () => {
    const cold = traeUsageFromTokenUsage(COLD)
    const reused = traeUsageFromTokenUsage(REUSED)
    expect(cold.inputTokens + (cold.cacheReadTokens ?? 0)).toBe(4894)
    expect(reused.inputTokens + (reused.cacheReadTokens ?? 0)).toBe(4894)
  })

  it('缓存写入单列且从总输入里扣除（不算命中）', () => {
    const usage = traeUsageFromTokenUsage({
      prompt_tokens: 1000, completion_tokens: 10, cache_read_input_tokens: 200, cache_creation_input_tokens: 300,
    })
    expect(usage.cacheReadTokens).toBe(200)
    expect(usage.cacheWriteTokens).toBe(300)
    expect(usage.inputTokens).toBe(1000 - 200 - 300)
  })

  it('上游字段矛盾（命中 + 写入 > 总量）时钳到 0，不下发负数', () => {
    const usage = traeUsageFromTokenUsage({
      prompt_tokens: 100, completion_tokens: 5, cache_read_input_tokens: 400,
    })
    expect(usage.inputTokens).toBe(0)
  })

  it('字段缺失/非法时按 0 兜底且不抛错', () => {
    expect(traeUsageFromTokenUsage({})).toEqual({ inputTokens: 0, outputTokens: 0 })
    const usage = traeUsageFromTokenUsage({
      prompt_tokens: 'x', completion_tokens: null, cache_read_input_tokens: Number.NaN, reasoning_tokens: -5,
    })
    expect(usage).toEqual({ inputTokens: 0, outputTokens: 0 })
    expect(usage).not.toHaveProperty('reasoningTokens')
  })

  it('reasoning_tokens 为 0 时省略（不作为 0 下发）', () => {
    expect(traeUsageFromTokenUsage({ prompt_tokens: 1, completion_tokens: 1, reasoning_tokens: 0 }))
      .not.toHaveProperty('reasoningTokens')
    expect(traeUsageFromTokenUsage({ prompt_tokens: 1, completion_tokens: 1, reasoning_tokens: 7 }).reasoningTokens).toBe(7)
  })
})

describe('SOLO SSE 聚合（非流式）', () => {
  it('拼接多帧 output 为完整正文与思考', () => {
    const lines = [
      'event:metadata', 'data:{"model":"","session_id":"s1"}', '',
      'event:output', 'data:{"response":"你","reasoning_content":"思"}', '',
      'event:output', 'data:{"response":"好","reasoning_content":"考"}', '',
      'event:done', 'data:{"finish_reason":"stop"}', '',
    ]
    const result = aggregateTraeSSE(lines)
    expect(result.content).toBe('你好')
    expect(result.reasoningContent).toBe('思考')
    expect(result.finishReason).toBe('stop')
  })

  it('保留 token_usage', () => {
    const result = aggregateTraeSSE([
      'event:output', 'data:{"response":"x"}', '',
      'event:token_usage', 'data:{"prompt_tokens":5,"completion_tokens":9}', '',
      'event:done', 'data:{"finish_reason":"stop"}', '',
    ])
    expect(result.usage).toMatchObject({ prompt_tokens: 5, completion_tokens: 9 })
  })

  it('error 事件被记录为 error 字段', () => {
    const result = aggregateTraeSSE([
      'event:error', 'data:{"code":1005,"message":"plan 权益不足"}', '',
    ])
    expect(result.error).toEqual({ code: 1005, message: 'plan 权益不足' })
  })

  it('无 done 事件时 finishReason 保持默认 stop', () => {
    const result = aggregateTraeSSE(['event:output', 'data:{"response":"x"}', ''])
    expect(result.finishReason).toBe('stop')
  })

  it('合并多帧 tool_calls', () => {
    const result = aggregateTraeSSE([
      'event:output', 'data:{"response":"","tool_calls":[{"index":0,"function_call":{"name":"read","arguments":"{\\"a\\":"}}]}', '',
      'event:output', 'data:{"tool_calls":[{"index":0,"function_call":{"arguments":"1}"}}]}', '',
      'event:done', 'data:{"finish_reason":"tool_calls"}', '',
    ])
    expect(result.toolCalls.length).toBe(2)
    expect(result.finishReason).toBe('tool_calls')
  })
})

describe('OpenAI chunk 构造', () => {
  it('buildOpenAIChunk 产出合法的 chat.completion.chunk', () => {
    const raw = buildOpenAIChunk('chatcmpl-1', { content: 'hi' })
    expect(raw.startsWith('data: ')).toBe(true)
    expect(raw.endsWith('\n\n')).toBe(true)
    const payload = JSON.parse(raw.slice(6).trim())
    expect(payload).toMatchObject({
      id: 'chatcmpl-1',
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: { content: 'hi' } }],
    })
  })

  it('带 finishReason 时写入 choices[0].finish_reason', () => {
    const raw = buildOpenAIChunk('id', {}, 'stop')
    const payload = JSON.parse(raw.slice(6).trim())
    expect(payload.choices[0].finish_reason).toBe('stop')
  })

  it('带 usage 时写入顶层 usage', () => {
    const raw = buildOpenAIChunk('id', {}, undefined, { prompt_tokens: 1 })
    const payload = JSON.parse(raw.slice(6).trim())
    expect(payload.usage).toEqual({ prompt_tokens: 1 })
  })

  it('[DONE] 信号格式正确', () => {
    expect(OPENAI_DONE).toBe('data: [DONE]\n\n')
  })
})

/**
 * 计费字段解析：`display_contact_config` 是一个 **JSON 字符串**，必须二次解析。
 *
 * 实测形态（2026-09-20，真实账号）：
 * ```json
 * "{\"consumption_rate\":{\"enable\":true,\"data\":{\"rate\":0.08}},
 *   \"activity_discount\":{\"enable\":true,\"subKey\":\"limited_discount\",
 *     \"data\":{\"current\":{\"discount_type\":\"limited\",
 *       \"before_consumption_rate\":0.8,\"consumption_rate\":0.08,\"discount\":10},
 *       \"limited\":{...,\"end_at\":1790265540}}}}"
 * ```
 */
describe('TRAE 计费字段解析（display_contact_config）', () => {
  const dc = (obj: unknown): Record<string, unknown> => ({ display_contact_config: JSON.stringify(obj) })

  describe('readConsumptionRate', () => {
    it('读出裸数字倍率（实测形态不是字符串 "x0.08"）', () => {
      expect(readConsumptionRate(dc({ consumption_rate: { enable: true, data: { rate: 0.08 } } }))).toBe(0.08)
    })

    it('倍率为 0 是合法值（免费），不能被当成「无倍率」', () => {
      // 与 Qoder 的 price_factor: 0 同类：用 > 0 过滤会恰好漏掉免费模型。
      expect(readConsumptionRate(dc({ consumption_rate: { enable: true, data: { rate: 0 } } }))).toBe(0)
    })

    it('enable=false 视为无倍率（而不是当成 0）', () => {
      expect(readConsumptionRate(dc({ consumption_rate: { enable: false, data: { rate: 0.5 } } }))).toBeUndefined()
    })

    it('字段缺失 / 非法 JSON / 非对象 一律 undefined（不编造倍率）', () => {
      expect(readConsumptionRate({})).toBeUndefined()
      expect(readConsumptionRate({ display_contact_config: '' })).toBeUndefined()
      expect(readConsumptionRate({ display_contact_config: 'not json' })).toBeUndefined()
      expect(readConsumptionRate({ display_contact_config: '[1,2]' })).toBeUndefined()
      expect(readConsumptionRate(dc({}))).toBeUndefined()
      expect(readConsumptionRate(dc({ consumption_rate: { enable: true } }))).toBeUndefined()
    })

    it('负数与噪声不被采信', () => {
      expect(readConsumptionRate(dc({ consumption_rate: { enable: true, data: { rate: -1 } } }))).toBeUndefined()
      expect(readConsumptionRate(dc({ consumption_rate: { enable: true, data: { rate: 'abc' } } }))).toBeUndefined()
    })
  })

  describe('readTraeOffPeakDiscount（闲时折扣：本仓此前从未读过的那一支）', () => {
    /**
     * 真机原样（2026-11-17，scripts/probe-trae-promo.mjs，DeepSeek-V4-Flash）：
     * current 说的是「没有活动」，而折后价**只**写在 off_peak 里。
     */
    /** dc() 包的是**整份 config**，所以要再套一层 activity_discount。 */
    const entry = (discount: unknown): Record<string, unknown> => dc({ activity_discount: discount })

    const REAL = {
      enable: true,
      subKey: 'off_peak_discount',
      data: {
        current: { discount_type: 'none', before_consumption_rate: 0.2, consumption_rate: 0.2, discount: 100 },
        off_peak: {
          before_consumption_rate: 0.2,
          after_consumption_rate: 0.1,
          discount: 50,
          time_windows: [
            { weekdays: [1, 2, 3, 4, 5, 6, 7], start_minute: 0, end_minute: 480 },
            { weekdays: [1, 2, 3, 4, 5, 6, 7], start_minute: 1320, end_minute: 1440 },
          ],
        },
      },
    }

    it('真机形状：折后价与窗口全部读出，且**不**被 current.type=none 挡掉', () => {
      // 这条是本 PR 的存在理由：readActivityDiscount 对同一份报文返回 undefined。
      expect(readActivityDiscount(entry(REAL), 1_789_905_263)).toBeUndefined()
      expect(readTraeOffPeakDiscount(entry(REAL))).toEqual({
        beforeRate: 0.2,
        rate: 0.1,
        discountPercent: 50,
        subKey: 'off_peak_discount',
        windows: [
          { startMinute: 0, endMinute: 480, weekdays: [1, 2, 3, 4, 5, 6, 7] },
          { startMinute: 1320, endMinute: 1440, weekdays: [1, 2, 3, 4, 5, 6, 7] },
        ],
        // 「上游声明过 time_windows」这一位是**承重**的：没有它，展示层分不清
        // 「没声明时段」（= 全天）与「声明了却一条都读不懂」（= 规则看不清，不许画）。
        windowsDeclared: true,
      })
    })

    it('⚠️ 上游没写 time_zone ⇒ 该键**缺席**（26/32 行如此），兜底由展示层按同值补', () => {
      const parsed = readTraeOffPeakDiscount(entry(REAL))!
      expect(parsed).not.toHaveProperty('timeZone')
      const declared = {
        ...REAL,
        data: { ...REAL.data, off_peak: { ...REAL.data.off_peak, time_zone: 'Asia/Shanghai' } },
      }
      expect(readTraeOffPeakDiscount(entry(declared))!.timeZone).toBe('Asia/Shanghai')
    })

    it('end_minute 1440 原样带出（**不**换算成次日 0 分：归属哪一天由展示层判）', () => {
      const parsed = readTraeOffPeakDiscount(entry(REAL))!
      expect(parsed.windows[1]!.endMinute).toBe(1440)
    })

    it('缺 after_consumption_rate / before ⇒ undefined（不猜 0，也不当免费）', () => {
      const noRate = {
        ...REAL,
        data: { ...REAL.data, off_peak: { before_consumption_rate: 0.2, time_windows: [] } },
      }
      expect(readTraeOffPeakDiscount(entry(noRate))).toBeUndefined()
      const noBefore = {
        ...REAL,
        data: { ...REAL.data, off_peak: { after_consumption_rate: 0.1, time_windows: [] } },
      }
      expect(readTraeOffPeakDiscount(entry(noBefore))).toBeUndefined()
    })

    it('enable=false 不算；没有 off_peak 分支（subsidy / member / limited 型）一律 undefined', () => {
      expect(readTraeOffPeakDiscount(entry({ ...REAL, enable: false }))).toBeUndefined()
      expect(readTraeOffPeakDiscount(entry({ ...REAL, data: { current: REAL.data.current } }))).toBeUndefined()
      // member / subsidy 是**另一条付费路径的对比价**，没有「此刻生效」的判据：
      // 把它们当折扣画会凭空多打一折（两条路不叠加）。
      expect(readTraeOffPeakDiscount(entry({
        enable: true,
        data: {
          current: { discount_type: 'subsidy', before_consumption_rate: 0.4, consumption_rate: 0.2 },
          member: { before_consumption_rate: 0.4, after_consumption_rate: 0.1, discount: 25 },
          subsidy: { before_consumption_rate: 0.4, after_consumption_rate: 0.2 },
        },
      }))).toBeUndefined()
    })

    it('⚠️ display_contact_config 是**一个 JSON 字符串**：直接给对象不认（与倍率同陷阱）', () => {
      expect(readTraeOffPeakDiscount({ activity_discount: REAL })).toBeUndefined()
      expect(readTraeOffPeakDiscount({ display_contact_config: 'not json' })).toBeUndefined()
      expect(readTraeOffPeakDiscount({ display_contact_config: '[1,2]' })).toBeUndefined()
      expect(readTraeOffPeakDiscount({})).toBeUndefined()
    })

    it('窗口里的非法项**原样带出**，换算与丢弃只发生在展示层（两层各判一次必漂移）', () => {
      const messy = {
        ...REAL,
        data: {
          ...REAL.data,
          off_peak: {
            ...REAL.data.off_peak,
            time_windows: [
              { weekdays: [1], start_minute: 600, end_minute: 600 },
              'not an object',
              { start_minute: 0, end_minute: 480 },
            ],
          },
        },
      }
      const parsed = readTraeOffPeakDiscount(entry(messy))!
      expect(parsed.windows).toHaveLength(2) // 字符串那条连字段都读不出，其余两条照带
      expect(parsed.windows[0]).toEqual({ startMinute: 600, endMinute: 600, weekdays: [1] })
      expect(parsed.windows[1]).not.toHaveProperty('weekdays')
    })

    it('★ 会员 / 补贴子键一律不产规则（真机 6/32 条是会员行，当折扣画就多打一折）', () => {
      // PR #106 对抗审计 P1：模块注释与文档都写「member / subsidy 不产候选」，
      // 而实现原先只看 `data.off_peak` 存在与否、**从不看子键** ⇒ 真机那 6 条
      // `off_peak_member_discount_18_9` 照样产候选。判据必须打在子键上。
      for (const subKey of [
        'off_peak_member_discount_18_9',
        'subsidy_member_discount',
        'OFF_PEAK_MEMBER_DISCOUNT_18_9',
        'member',
        'Subsidy',
      ]) {
        // ⚠️ 子键在 `activity_discount` 这一层（= REAL 自己），**不在** `off_peak` 下。
        expect(readTraeOffPeakDiscount(entry({ ...REAL, subKey })), subKey + ' 必须不产规则').toBeUndefined()
      }
      // 上游也可能把子键写在 `sub_key` 下（两种写法都实测见过）。
      // ⚠️ `REAL` 自带 camelCase 的 `subKey`，而实现是 `subKey ?? sub_key` ⇒ 先摘掉它，
      // 否则命中的是那条已知子键，测不到 snake_case 那一支（我第一版就这么写错了）。
      const { subKey: camelSubKey, ...withoutSubKey } = REAL
      void camelSubKey
      expect(readTraeOffPeakDiscount(entry({ ...withoutSubKey, sub_key: 'off_peak_member_discount_18_9' }))).toBeUndefined()
    })

    it('未知子键放行：上游新增形态时宁可多画，也不要静默吞掉', () => {
      const parsed = readTraeOffPeakDiscount(entry({ ...REAL, subKey: 'off_peak_discount_v2' }))!
      expect(parsed.subKey).toBe('off_peak_discount_v2')
      expect(parsed.windows).toHaveLength(2)
    })

    it('★★ windowsDeclared：缺键 / null / 空数组 = 没声明；非空数组 / 非数组 = 声明了', () => {
      // 这一位是 PR #106 正向审计 P1-1 的修法支点：只给 `windows: []` 时展示层
      // 分不清「上游没给时段」（= 全天）与「给了但一条都读不懂」（= 不许画）。
      const withWindows = (timeWindows: unknown) => {
        const data = { ...REAL.data, off_peak: { ...REAL.data.off_peak, time_windows: timeWindows } }
        return readTraeOffPeakDiscount(entry({ ...REAL, data } as never))
      }
      expect(withWindows(undefined)?.windowsDeclared, '缺键 ⇒ 没声明').toBe(false)
      expect(withWindows(null)?.windowsDeclared, 'null ⇒ 没声明').toBe(false)
      expect(withWindows([])?.windowsDeclared, '空数组 ⇒ 上游主动说没有时段').toBe(false)
      expect(withWindows(REAL.data.off_peak.time_windows)?.windowsDeclared, '非空数组 ⇒ 声明了').toBe(true)
      expect(withWindows('not-an-array')?.windowsDeclared, '非数组 ⇒ 声明了但看不懂').toBe(true)
      expect(withWindows({ start_minute: 0 })?.windowsDeclared, '对象 ⇒ 同理').toBe(true)
      expect(withWindows([{ bad: 1 }])?.windowsDeclared, '元素全读不懂 ⇒ 仍是声明了').toBe(true)
    })
  })
  describe('readActivityDiscount', () => {
    const NOW = 1_789_905_263
    const limited = {
      activity_discount: {
        enable: true, subKey: 'limited_discount',
        data: {
          current: { discount_type: 'limited', before_consumption_rate: 0.8, consumption_rate: 0.08, discount: 10 },
          limited: { before_consumption_rate: 0.8, after_consumption_rate: 0.08, discount: 10, end_at: 1_790_265_540 },
        },
      },
    }

    it('limited 型：给出原价与截止时间', () => {
      expect(readActivityDiscount(dc(limited), NOW)).toEqual({ originalRate: 0.8, endsAtSec: 1_790_265_540 })
    })

    it('⚠️ discount_type="none" 时不算活动（实测 off_peak 陷阱）', () => {
      // 实测 `enable: true` 但 current 是 {type:"none", before:0.13, after:0.13, discount:100}
      // —— 照显会得到 `x0.13→x0.13`，让用户以为有活动。与 Qoder 的
      // promotion.active === false 同类语义，必须不展示。
      const offPeak = {
        activity_discount: {
          enable: true, subKey: 'off_peak_member_discount',
          data: {
            current: { discount_type: 'none', before_consumption_rate: 0.13, consumption_rate: 0.13, discount: 100 },
            member: { before_consumption_rate: 0.13, after_consumption_rate: 0.13, discount: 100 },
            off_peak: { before_consumption_rate: 0.13, after_consumption_rate: 0.13, discount: 100 },
          },
        },
      }
      expect(readActivityDiscount(dc(offPeak), NOW)).toBeUndefined()
    })

    it('原价不高于折后价时不算活动', () => {
      const noop = {
        activity_discount: {
          enable: true,
          data: { current: { discount_type: 'limited', before_consumption_rate: 0.5, consumption_rate: 0.5 } },
        },
      }
      expect(readActivityDiscount(dc(noop), NOW)).toBeUndefined()
    })

    it('⚠️ 已过期的活动不展示（否则用户按折扣价预期、实际按原价计费）', () => {
      const expired = {
        activity_discount: {
          enable: true,
          data: {
            current: { discount_type: 'limited', before_consumption_rate: 0.8, consumption_rate: 0.08 },
            limited: { end_at: NOW - 10 },
          },
        },
      }
      expect(readActivityDiscount(dc(expired), NOW)).toBeUndefined()
    })

    it('无截止时间的活动（subsidy 型）照常返回原价', () => {
      const subsidy = {
        activity_discount: {
          enable: true, subKey: 'subsidy_member_discount',
          data: { current: { discount_type: 'subsidy', before_consumption_rate: 0.4, consumption_rate: 0.2 } },
        },
      }
      expect(readActivityDiscount(dc(subsidy), NOW)).toEqual({ originalRate: 0.4 })
    })

    it('enable=false / 字段缺失 / 非法 JSON 一律 undefined', () => {
      expect(readActivityDiscount({}, NOW)).toBeUndefined()
      expect(readActivityDiscount({ display_contact_config: 'x' }, NOW)).toBeUndefined()
      expect(readActivityDiscount(dc({ activity_discount: { enable: false, data: {} } }), NOW)).toBeUndefined()
      expect(readActivityDiscount(dc({ activity_discount: { enable: true } }), NOW)).toBeUndefined()
    })
  })

  describe('parseTraeBatchModelList 接线', () => {
    it('倍率与活动折扣被写进模型条目', () => {
      // end_at 必须是「当前时刻之后」的未来时间：readActivityDiscount 未显式传
      // nowSec 时用默认 Date.now()，写死过去的日期会让测试随真实时间过期
      //（2026-09-25 恰好越过硬编码的 1_790_265_540 后此用例开始失败）。
      const futureEnd = Math.floor(Date.now() / 1000) + 3_600
      const models = parseTraeBatchModelList({
        function_configs: [{
          function: 'solo_agent',
          config_info_list: [{
            config_name: 'qwen3.8-flash',
            usage: 'chat_completion',
            config_switch: true,
            display_config: { display_name: 'Qwen3.8-Flash', is_custom_model: false },
            display_contact_config: JSON.stringify({
              consumption_rate: { enable: true, data: { rate: 0.08 } },
              activity_discount: {
                enable: true,
                data: {
                  current: { discount_type: 'limited', before_consumption_rate: 0.8, consumption_rate: 0.08 },
                  limited: { end_at: futureEnd },
                },
              },
            }),
          }],
        }],
      })
      expect(models).toHaveLength(1)
      expect(models[0]!.creditsRate).toBe(0.08)
      expect(models[0]!.originalCreditsRate).toBe(0.8)
      expect(models[0]!.discountEndsAtSec).toBe(futureEnd)
    })

    it('无计费字段时不产生倍率键（保持 undefined，不填 0）', () => {
      const models = parseTraeBatchModelList({
        function_configs: [{
          function: 'solo_agent',
          config_info_list: [{ config_name: 'x', usage: 'chat_completion', config_switch: true }],
        }],
      })
      expect(models[0]).not.toHaveProperty('creditsRate')
      expect(models[0]).not.toHaveProperty('originalCreditsRate')
    })
  })
})

describe('模块导出面', () => {
  it('积分余额端点常量由 trae.ts 定义（供 trae-credits.ts 导入，单一真相源）', () => {
    // 端点变更只改一处会让语义分叉且无测试失败，故锁住它的导出位置。
    expect(traeModule).toHaveProperty('TRAE_ENT_USAGE_PATH')
  })
})
