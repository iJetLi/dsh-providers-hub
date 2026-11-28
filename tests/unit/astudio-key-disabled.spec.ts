/**
 * ★★ **`API_KEY_DISABLED` 必须归 `client-outdated`，不能归 `auth`**（2026-11-28，GitHub #190）。
 *
 * ## 报障原文
 *
 * 重登录后的新凭据（`ASTUDIO_ACCOUNT_32FC8DAB`）打
 * `POST /model-gateway/v1/responses` 得到：
 *
 * ```
 * 401 {"code":"API_KEY_DISABLED","message":"Please upgrade to the latest version of AStudio."}
 * ```
 *
 * ## 为什么不能归 `auth`
 *
 * 归 `auth` 会产出「凭据未被上游接受，将重取一次；仍失败请在 AStudio 客户端重新登录」
 * —— 而报障者实测 **重登后反而更糟**：
 *
 * | 凭据 | 结果 |
 * |---|---|
 * | 旧 `astudio-7d4a6e95` | 今天**成功 10 次**（消耗了积分）|
 * | 重登后 `astudio-57a8e69b` | 两个模型共 **135 次请求 0 成功** |
 *
 * ⇒ 「重新登录」是**错误指路**。上游那句 `Please upgrade to the latest version of AStudio`
 * 才是唯一正确的方向：**要升级客户端（= 插件要跟随官方 studioVersion），不是重登**。
 *
 * ## 为什么大小写两条都要登记
 *
 * `astudioOpenAiErrorFields()` **不做大小写归一**，而 `ASTUDIO_WIRE_CODES` 是
 * `Map` 精确匹配、表里其余条目全是小写。上游这次给的是**全大写** ⇒ 只写小写会漏。
 */
import { describe, expect, it } from 'vitest'
import { classifyAstudioError } from '../../src/astudio.js'

const body = (code: string): string =>
  JSON.stringify({ error: { code, message: 'Please upgrade to the latest version of AStudio.' } })

describe('★★ AStudio API_KEY_DISABLED（GitHub #190）', () => {
  it('★★★ 大写 API_KEY_DISABLED ⇒ client-outdated（不是 auth）', () => {
    const r = classifyAstudioError(401, body('API_KEY_DISABLED'))
    expect(r.kind).toBe('client-outdated')
    // ⚠️ 绝不能是 AUTH —— 那会触发「重取 + 提示重登」，而重登实测更糟
    expect(r.llmCode).not.toBe('AUTH')
    expect(r.llmCode).toBe('PERMISSION_DENIED')
  })

  it('★★★ 小写 api_key_disabled 同样命中（上游可能换大小写）', () => {
    const r = classifyAstudioError(401, body('api_key_disabled'))
    expect(r.kind).toBe('client-outdated')
  })

  it('★★★ 文案必须指向「升级客户端」，且**不得**写「重新登录」', () => {
    const r = classifyAstudioError(401, body('API_KEY_DISABLED'))
    expect(r.message).toContain('停用旧版')
    expect(r.message).toContain('升级')
    // 这是 #190 的核心教训：重登会把好凭据换成不可用的新凭据
    expect(r.message, '★ 不得再建议重新登录').not.toContain('重新登录请在')
    expect(r.message).not.toContain('请在 AStudio 客户端重新登录')
  })

  it('★★ 反向对照：普通 401（无业务码）仍然归 auth，不得被这条吞掉', () => {
    const r = classifyAstudioError(401, JSON.stringify({ error: { message: 'unauthorized' } }))
    expect(r.kind).toBe('auth')
    expect(r.llmCode).toBe('AUTH')
  })

  it('★★ 反向对照：apikey_not_found 仍归 auth（那是真凭据失效，重登是对的）', () => {
    const r = classifyAstudioError(401, body('apikey_not_found'))
    expect(r.kind).toBe('auth')
  })

  it('★★ 反向对照：no_valid_authorization 仍归 permission-denied（订单缺失，另一形态）', () => {
    const r = classifyAstudioError(403, body('no_valid_authorization'))
    expect(r.kind).toBe('permission-denied')
  })
})
