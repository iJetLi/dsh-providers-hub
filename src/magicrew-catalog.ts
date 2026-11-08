// src/magicrew-catalog.ts
/**
 * 拉 `GET /api/v1/flows/models` 并归一成适配器要的形状。
 *
 * ⚠️ 该端点**不返回** ctx / 档位（实测 27 条全字段确认）⇒ 本模块只负责
 * id / 名称 / vision 三项，其余由静态表补。
 */

import type { MagicrewProduct } from './magicrew-product.js'
import { MAGICREW, MAGICREW_MODELS_PATH, MAGICREW_USER_AGENT } from './magicrew-product.js'

export interface MagicrewCatalogModel {
  readonly id: string
  readonly name: string
  readonly vision: boolean
}

/**
 * 上游 UA 来自 {@link MAGICREW_USER_AGENT}（单一定义处）。
 *
 * ⚠️ **不要在这里恢复一份字面量**（issue IKTPRV）：目录 GET 与其余四腿打同一个
 * `product.host`，漏改的症状是「模型列表回退静态表」而积分行报 405。
 */

export async function fetchMagicrewCatalogModels(params: {
  jwt: string
  organizationCode: string
  product?: MagicrewProduct
  fetchImpl?: typeof fetch
}): Promise<readonly MagicrewCatalogModel[]> {
  const product = params.product ?? MAGICREW
  const fetchImpl = params.fetchImpl ?? fetch
  const headers: Record<string, string> = {
    authorization: `Bearer ${params.jwt}`,
    'content-type': 'application/json',
    accept: 'application/json',
    'user-agent': MAGICREW_USER_AGENT,
    origin: product.webOrigin,
    // ⚠️ 本端点不带 referer 也 200，但与其余 magicrew 请求统一（同一 Go 服务的
    //    另两个端点缺了它就是 403 空 body，见 `magicrew-auth.ts` 的实测记录）。
    referer: `${product.webOrigin}/`,
  }
  // ⚠️ 只在非空时带：国内站不强制，国际站强制（缺了回 HTTP 500 + 裸文本）。
  if (params.organizationCode.length > 0) headers['organization-code'] = params.organizationCode
  /**
   * ⚠️⚠️ **目录 GET 必须有超时**（2026-10-29 审查）：`product.requestTimeoutMs` 此前
   * 在 `src/` 里**零读者** ⇒ 这一段只靠 undici 默认（约 300s）。目录是**每条消息**
   * 都会走的前置请求（`prepareCall` → `resolveModel`）⇒ 网关卡住时整条会话一起卡。
   * 与推理侧的分工：这里用 `requestTimeoutMs`（一次性请求），推理侧「等头」用
   * `chatHeaderTimeoutMs`、字节间用 `chunkTimeoutMs`。
   */
  const controller = new AbortController()
  const timer = setTimeout(
    () => controller.abort(new Error(`模型目录请求超时（${product.requestTimeoutMs}ms）`)),
    product.requestTimeoutMs,
  )
  let response: Response
  try {
    response = await fetchImpl(`${product.host}${MAGICREW_MODELS_PATH}`, {
      headers,
      signal: controller.signal,
    })
  } catch (error) {
    // ⚠️ 本控制器超时 ⇒ 抛可读的「超时」错误（否则调用方只看到 `AbortError`，
    //    与「用户取消」「网关重置」同形，分类全靠猜）。
    if (controller.signal.aborted) throw controller.signal.reason
    throw error
  } finally {
    clearTimeout(timer)
  }
  const text = await response.text()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`模型目录返回的不是 JSON：${text.slice(0, 200)}`)
  }
  const envelope = parsed as { code?: unknown, data?: { models?: unknown } }
  // ⚠️ 没有 `code` 键时**不抛**（交给后续判定）。
  if (typeof envelope.code === 'number' && envelope.code !== 1000) {
    throw new Error(`模型目录业务码 ${envelope.code}`)
  }
  const models = Array.isArray(envelope.data?.models) ? envelope.data.models : []
  const out: MagicrewCatalogModel[] = []
  for (const raw of models) {
    if (typeof raw !== 'object' || raw === null) continue
    const item = raw as Record<string, unknown>
    const id = typeof item.value === 'string' ? item.value : ''
    // ⚠️ 缺 value 的条目直接跳过，不产生空 id 条目。
    if (id.length === 0) continue
    // ⚠️ 上游真实形态带**前导空格**（`" DeepSeek V4.1 Flash"`）⇒ 必须 trim。
    const label = typeof item.label === 'string' ? item.label.trim() : ''
    // ⚠️ vision 判据是严格布尔：上游可能给 `1` / `"true"`，宽松判会误报能力。
    out.push({ id, name: label.length > 0 ? label : id, vision: item.vision === true })
  }
  return out
}
