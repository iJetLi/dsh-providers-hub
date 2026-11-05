/**
 * ZCode 推理准入的真机探针：**版本号与身份块必须同代**（Issue #45）。
 *
 * ## 为什么必须真机
 *
 * 3012 的判据是**上游**对「`X-ZCode-App-Version` 与 `system` 身份块文本是否同代」
 * 的比对 —— 单测只能锁住「我们发了什么」（版本常量、身份块字符数），
 * **锁不住「这一对过不过上游」**。2026-11-05 的真机 2×2（同 URL、同头、同 body，
 * 只改这两个变量）：
 *
 * | `X-ZCode-App-Version` | 身份块 | 结果 |
 * |---|---|---|
 * | `3.16.3` | 3.16 文本 | **200** |
 * | `3.17.2` | 3.16 文本 | **405 + 3012** |
 * | `3.16.3` | 3.17 文本 | **405 + 3012** |
 * | `3.17.1` / `3.17.2` | 3.17 文本 | **200** |
 *
 * ⇒ 官方升级客户端后，**只改一处就是全量用户 3012**（Issue #45 的报障：
 * 用户 11-02 升级到 3.17.2 后「从未成功过一次」）。本探针就是那条不变式的
 * 真机出口：**生产配置必须能过准入**。
 *
 * ## 判据为什么是「不是 3012」而不是「HTTP 200」
 *
 * 免费额度耗尽的账号回 `200 + {"code":1005,"msg":"exceed quota limit"}` ——
 * 那说明**准入已通过**（业务层才判额度）。用 `=== 200` 当判据会把
 * 「额度用完」误报成「身份块过时」，方向就错了。
 *
 * ## 闸门
 *
 * `DSH_ZCODE_E2E=1`（与其它 e2e 同款），默认跳过；**只读**凭据，**不刷新**。
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  buildZcodeHeaders,
  ZCODE_INFERENCE_MIN_APP_VERSION,
  ZCODE_PLAN_MESSAGES_URL,
} from '../../src/zcode-upstream.js'
import {
  buildContextPrefixBlock,
  buildZcodeSystemBlocks,
  OFFICIAL_CLI_PREFIX,
  OFFICIAL_IDENTITY_CHARS,
  OFFICIAL_STABLE_SECTIONS,
} from '../../src/zcode-identity.js'

const E2E = process.env.DSH_ZCODE_E2E === '1'

interface StoredCredential {
  zcode_jwt?: string
  device_mid?: string
  app_version?: string
  user_id?: string
}

/** 从 DSH 凭据存储里取**一条**可用的 ZCode 账号（只读）。 */
function loadCredential(): StoredCredential | undefined {
  const path = `${process.env.USERPROFILE}/.dsh/.credentials.yaml`
  const text = readFileSync(path, 'utf8')
  for (const match of text.matchAll(/^ {2}(ZCODE_ACCOUNT_[A-Z0-9]+): '(.*)'$/gm)) {
    try {
      const parsed = JSON.parse(match[2]!) as StoredCredential
      if (typeof parsed.zcode_jwt === 'string' && parsed.zcode_jwt.length > 0) return parsed
    } catch {
      // 单条解析失败不挡整批（与 tests/e2e/codearts-credential.ts 同款）。
    }
  }
  return undefined
}

describe.runIf(E2E)('ZCode 版本号与身份块同代（Issue #45 真机准入）', () => {
  it(
    '生产配置（版本门槛 + 身份块）能过上游准入，不得是 3012',
    async () => {
      const credential = loadCredential()
      expect(credential, '需要 DSH 凭据存储里有一个 ZCode 账号（ZCODE_ACCOUNT_*）').toBeDefined()

      // 与生产**同源**：头走 buildZcodeHeaders（内部即 zcodeInferenceAppVersion），
      // system 走 buildZcodeSystemBlocks 的 3 块 + 首轮日期块。
      const headers = buildZcodeHeaders(credential as never)
      headers.Authorization = `Bearer ${credential!.zcode_jwt!}`
      const body = JSON.stringify({
        model: 'GLM-5.3',
        system: buildZcodeSystemBlocks({
          cwd: process.cwd(),
          provider: 'zcode',
          model: 'GLM-5.3',
        }),
        messages: [{
          role: 'user',
          content: [buildContextPrefixBlock(), { type: 'text', text: 'Reply with exactly: IDENTITY_OK' }],
        }],
        max_tokens: 16,
        stream: true,
      })

      const response = await fetch(ZCODE_PLAN_MESSAGES_URL, { method: 'POST', headers, body })
      const text = await response.text()

      // 诊断信息先打出来：失败时这一行就是全部现场（版本 + 身份块字符数）。
      // eslint-disable-next-line no-console
      console.log(
        `[zcode-e2e] HTTP ${response.status} · 版本 ${headers['X-ZCode-App-Version']}`
        + ` · 身份块 ${OFFICIAL_IDENTITY_CHARS} 字符(${OFFICIAL_CLI_PREFIX.length}`
        + `+${OFFICIAL_STABLE_SECTIONS.join('\n\n').length}) · ${text.slice(0, 160).replace(/\n/g, ' ')}`,
      )

      // ① **准入判据**：不得是风控 3012（HTTP 405 + unusual activity）。
      expect(
        text.includes('3012') || text.includes('unusual activity'),
        `上游回了 3012 风控 —— 版本 ${headers['X-ZCode-App-Version']} 与身份块`
        + `（${OFFICIAL_IDENTITY_CHARS} 字符）不同代，或官方又改了身份块结构。`
        + `原始响应：${text.slice(0, 300)}`,
      ).toBe(false)

      // ② 版本号必须真的发出去了（否则「同代」无从谈起）。
      expect(headers['X-ZCode-App-Version']).toBe(ZCODE_INFERENCE_MIN_APP_VERSION)

      // ③ 业务层正常（额度用尽也算通过：那说明准入已经过了）。
      expect(response.status).toBe(200)
    },
    120_000,
  )
})
