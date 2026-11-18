/**
 * CodeArts 模型介绍（`model_desc`）真机探针（2026-11-17）。
 *
 * ## 为什么需要真机
 *
 * 单测只能证明「**假如**上游带 `model_desc`，我们会把它透传出去」——
 * 锁不住「上游到底带不带、字段名对不对、格式是不是纯字符串」。本仓红线是
 * 不编造：不允许拿「CodeArts 客户端界面上有那行灰字」反推字段存在。
 * 2026-11-17 只读探测结论（12 条全带、与客户端逐字相同）由本探针固定下来。
 *
 * ## 探针做什么
 *
 * 只读：`fetchCodeArtsRemoteModels` → `/v1/model/builtin`（签名 GET，**零 token
 * 消耗**、不触发 `refresh_token`）。然后做两件对比：
 * 1. 逐条把解析结果里的 `description` 与原报文里的 `model_desc` 对齐 ——
 *    只要有一条对不上，说明解析 / 透传丢字段或改了字；
 * 2. 断言「至少有一条带介绍」——否则这条探针会**空跑通过**
 *    （上游哪天不发了，测试全绿而功能已死）。
 *
 * 闸门：`DSH_CODEARTS_E2E=1`（与 `v4-models.e2e.spec.ts` 同款），默认跳过。
 */
import { describe, expect, it } from 'vitest'
import { fetchCodeArtsRemoteModels, SNAP_MODEL_BUILTIN_URL } from '../../src/models.js'
import { readCodeArtsCredentialsFromDshStore } from './codearts-credential.js'

const E2E = process.env.DSH_CODEARTS_E2E === '1'

/** `/v1/model/builtin` 原始条目里我们关心的那两格。 */
type RawBuiltinEntry = { model_id?: unknown; model_desc?: unknown }

describe.runIf(E2E)('codearts 模型介绍（model_desc 真机）', () => {
  it(
    '解析结果里的 description 与上游 model_desc 逐条一致',
    async () => {
      const entries = readCodeArtsCredentialsFromDshStore()
      expect(entries.length, '需要 DSH 凭据存储里至少一个 CodeArts 账号（只读，不刷新）').toBeGreaterThan(0)

      /** 原报文里的 `model_id → model_desc`（只收 builtin 那一条响应）。 */
      const rawDescs = new Map<string, unknown>()
      const fetcher: typeof fetch = async (input, init) => {
        const response = await fetch(input as RequestInfo, init)
        if (String(input).includes(SNAP_MODEL_BUILTIN_URL)) {
          // ⚠️ 必须 `clone()`：响应体只能读一次，读原件会让下游拿到已消费的 body。
          const snapshot = await response.clone().json() as { builtinModels?: RawBuiltinEntry[] }
          for (const item of snapshot.builtinModels ?? []) {
            if (typeof item.model_id === 'string') rawDescs.set(item.model_id, item.model_desc)
          }
        }
        return response
      }

      // ⚠️⚠️ **必须遍历账号，且把「凭据不可用」与「上游没数据」分开报**
      //    （2026-11-18 修）：原实现 `const [entry] = …` 只取**第一个**账号，
      //    而本机 4 个账号的 `expires_at` 全落在 11-09 ~ 11-13（跑测那天是 11-18）
      //    ⇒ 全部 401 `APIG.0301`。那一刻的失败文案是
      //    「上游目录为空 —— 探针无从对拍」，把**凭据过期**伪装成**上游没数据** ——
      //    两者的处置完全相反（一个要重新登录、一个是产品缺陷）。
      let usable: (typeof entries)[number] | undefined
      let models: Awaited<ReturnType<typeof fetchCodeArtsRemoteModels>> = []
      const failures: string[] = []
      for (const candidate of entries) {
        try {
          const got = await fetchCodeArtsRemoteModels(candidate.credential, fetcher)
          if (got.length > 0) {
            usable = candidate
            models = got
            break
          }
          failures.push(`${candidate.ref}: 目录为空（凭据被接受但没返回模型）`)
        } catch (error) {
          failures.push(`${candidate.ref}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      expect(
        usable,
        `本机 ${entries.length} 个 CodeArts 账号全部拿不到目录。`
        + '先确认凭据是否过期（401 APIG.0301 Incorrect IAM authentication information），'
        + '别当成「上游没数据」：\n  ' + failures.join('\n  '),
      ).toBeDefined()
      expect(rawDescs.size, '没抓到 builtin 原始报文（端点或 URL 变了？）').toBeGreaterThan(0)

      /** 上游真给了非空介绍的条目（VL 模型会被插件过滤，所以从解析结果侧取）。 */
      const withDesc = models.filter((model) => {
        const raw = rawDescs.get(model.id)
        return typeof raw === 'string' && raw.trim().length > 0
      })
      expect(
        withDesc.length,
        '上游一条介绍都没有 —— 此时「插件不显示介绍」是**正确行为**，功能归零，探针必须红而不是绿',
      ).toBeGreaterThan(0)

      for (const model of withDesc) {
        const raw = rawDescs.get(model.id) as string
        // ⚠️ 只 trim 两端；不做任何改写（不裁 `【限时体验】`、不拼接倍率）。
        expect(model.description, `${model.id} 的介绍被丢弃或改写了`).toBe(raw.trim())
      }

      // 反向：上游没给（或给了空白）的条目，我们这边必须**不带** description 键。
      for (const model of models) {
        const raw = rawDescs.get(model.id)
        const upstreamEmpty = typeof raw !== 'string' || raw.trim().length === 0
        if (upstreamEmpty) {
          expect(Object.hasOwn(model, 'description'), `${model.id} 上游没给介绍，我们却落了键`).toBe(false)
        }
      }
    },
    30_000,
  )
})
