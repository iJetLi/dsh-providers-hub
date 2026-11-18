/**
 * Qoder **中国版**登录与端点探针。
 *
 * ⚠️ 会真实发网络请求。**除「续期」那一条外全部只读**（不发消息、不领取），
 * 故零额度；「续期」是**写操作**（轮换 refresh_token）且**需二次确认**，
 * 理由见该用例的注释。
 *
 * 它要回答设计文档 §15 里那个**最高风险**问题：
 * `client_id = 732aef47-…`（取自 CN asar 的 `authClientIds.prod`）是否真被
 * 服务端接受。**国际版的教训**：用错 client_id 时入口 **302 完全正常**，
 * 只在用户点「授权」之后才报「参数无效」—— 所以本探针只能证明
 * 「URL 构造与端点形态正确」，**授权闭环仍需人工在浏览器里点一次**
 * （或在 Jet Hub 中国版面板登录一次，然后跑本探针的续期用例）。
 *
 * 端点存在性的判别法沿用国际版已验证的那条（AGENTS.md Qoder 要点 4）：
 * 轮询路径返回 **404**（= 被网关豁免认证、业务层报「会话未就绪」），
 * 而**任意不存在的路径**返回 **401** —— 两者区分开才证明路径真的存在。
 *
 * 闸门：`DSH_QODERCN_E2E=1`（只读，单闸门即可）
 * 用 `pnpm test:e2e:qodercn` 运行。
 * 凭据来源：`DSH_QODERCN_CREDENTIAL_JSON`，或 `.credentials.yaml` 里的
 * `QODERCN_ACCOUNT_*`（需先在 Jet Hub「Qoder (中国版)」面板登录）。
 */
import { describe, expect, it } from 'vitest'
import { QODER_CN } from '../../src/qoder-product.js'
import { QODER_CATALOG_SCENES, fetchQoderRemoteModels } from '../../src/qoder-catalog.js'
import {
  QODER_REFRESH_PATH,
  QODER_USERINFO_PATH,
  buildQoderAuthUrl,
  buildQoderPollUrl,
  createQoderDeviceSession,
  qoderRefreshBody,
} from '../../src/qoder.js'
import { readQoderCredentialsFromDshStore } from './qoder-credential.js'

const RUN = process.env.DSH_QODERCN_E2E === '1'
const suite = RUN ? describe : describe.skip

suite('QoderCN 登录与端点探针（只读，零额度）', () => {
  it('授权 URL 落在中国版域名且带中国版 client_id', () => {
    const session = createQoderDeviceSession()
    const url = buildQoderAuthUrl(session, QODER_CN)
    console.log(`  loginUrl = ${url}`)
    expect(url.startsWith('https://qoder.cn/device/selectAccounts?')).toBe(true)
    // ⚠️ 断言里带上国际版 id 的**反向检查**：一旦产品配置被改错或两站配置
    // 被合并，这里会立刻红，而不是等用户登录失败才发现。
    expect(url).toContain('client_id=732aef47-9cf2-46a2-95fe-4cebb5d0d1fa')
    expect(url).not.toContain('e883ade2')
    // PKCE 参数族必须齐全（与 CN asar 的 `Sft()` 逐参数一致，设计文档 E3）。
    for (const key of ['challenge=', 'challenge_method=S256', 'nonce=', 'machine_id=']) {
      expect(url, `授权 URL 缺少 ${key}`).toContain(key)
    }
  })

  it('中国版轮询端点存在：404（会话未就绪）而不是 401（无此路由）', async () => {
    // 判别法沿用国际版实测（AGENTS.md Qoder 要点 4）：该路径被网关豁免认证，
    // 无待授权会话时回 404；而任意不存在的路径回 401。故 404 才是「路径存在」的证据。
    const session = createQoderDeviceSession()
    const url = buildQoderPollUrl(session, QODER_CN)
    const response = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(20_000) })
    const body = await response.text()
    console.log(`  poll ${response.status} ${body.slice(0, 200)}`)
    expect(response.status, '轮询端点行为与国际版不同（404 = 存在但无会话）').toBe(404)
  })

  it('同 host 上不存在的路径回 401（与上一条对照，证明 404 不是网关兜底）', async () => {
    const url = `${QODER_CN.openApiBase}/api/v1/zzz-not-exist-probe-${Date.now()}`
    const response = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(20_000) })
    console.log(`  bogus ${response.status} ${(await response.text()).slice(0, 160)}`)
    expect(response.status).toBe(401)
  })

  it('中国版 userinfo 端点存在（无凭据回 401 TOKEN_INVALID，与国际版同形）', async () => {
    // 实测依据（设计文档 E7）：CN 回 `{"code":"TOKEN_INVALID",…}`，
    // 与国际版**逐字节同形** —— 这是「积分/昵称链路可整套复用」的直接证据。
    const response = await fetch(`${QODER_CN.openApiBase}${QODER_USERINFO_PATH}`, {
      method: 'GET',
      signal: AbortSignal.timeout(20_000),
    })
    const body = await response.text()
    console.log(`  userinfo ${response.status} ${body.slice(0, 160)}`)
    expect(response.status).toBe(401)
    expect(body).toContain('TOKEN_INVALID')
  })

  it('加密推理端点在 gateway 上存在（GET 被拒为方法不支持，而不是 404）', async () => {
    // 实测依据（E9）：CN 与 intl 都回 `400 "Request method 'GET' not supported"`
    // → 同一套 `algo` 网关，只是换了域名。
    const url = `${QODER_CN.encryptedInferBase}/algo/api/v2/service/pro/sse/agent_chat_generation`
      + '?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1'
    const response = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(20_000) })
    const body = await response.text()
    console.log(`  infer ${response.status} ${body.slice(0, 200)}`)
    expect(body).toContain("Request method 'GET' not supported")
  })

  /**
   * ⚠️⚠️ **这是一条写操作，不是只读探针**（2026-10-20 修正）。
   *
   * `/device_token/refresh` 会**轮换** `refresh_token`（实测每次响应都回新值：
   * `drt-…`，且旧值是否仍然有效**未验证**）。本探针拿到新值后**不落盘**，
   * 于是「跑一次探针」= 把凭据存储里的 refresh_token 变旧 —— 真实代价是
   * 该账号日后续期失败、需重新登录。
   *
   * 故与其余写探针同款：必须显式二次确认
   * （`DSH_QODERCN_E2E_REFRESH_CONFIRM=yes`）。要「验证续期且不破坏现场」，
   * 应走插件自身的 `QoderAuth.refreshAccountCredential`
   * —— 它会回写凭据与池的有效期（`expiry-sync` 那条链）。
   */
  it('已登录凭据可续期（⚠️ 写操作：轮换 refresh_token，需二次确认）', async () => {
    if (process.env.DSH_QODERCN_E2E_REFRESH_CONFIRM !== 'yes') {
      console.log('  跳过：该用例会轮换 refresh_token（写操作），'
        + '需要 DSH_QODERCN_E2E_REFRESH_CONFIRM=yes 才执行')
      return
    }
    const entries = readQoderCredentialsFromDshStore({ refPrefix: 'QODERCN' })
    if (entries.length === 0) {
      console.log('  跳过：未找到 QODERCN_ACCOUNT_* 凭据（先在面板登录一次）')
      return
    }
    const { credential, uid } = entries[0]!
    if (credential.refresh_token === undefined || credential.refresh_token.length === 0) {
      console.log(`  跳过：${uid} 无 refresh_token`)
      return
    }
    const response = await fetch(`${QODER_CN.openApiBase}${QODER_REFRESH_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(qoderRefreshBody(credential)),
      signal: AbortSignal.timeout(30_000),
    })
    const body = await response.text()
    console.log(`  refresh ${response.status} ${body.slice(0, 300)}`)
    expect(response.status, '续期被拒 —— 检查 CN 是否校验 machine_id 来源').toBe(200)
  })

  /**
   * 远端模型目录（2026-10-20 接入）。
   *
   * ⚠️ **只读、不计费**。判据是**结构不变式**（非空 / id 与 name 非空 / 无重复 id），
   * 不写死具体倍率 —— 上游随时调价，写死会让探针在下次调价时假红。
   * 硬编码的只有「用户点名的那个模型还在不在」（`dfmodel`）。
   */
  it('远端模型目录可拉取（CN 走自己的 gateway，结构完整）', async () => {
    const entries = readQoderCredentialsFromDshStore({ refPrefix: 'QODERCN' })
    if (entries.length === 0) {
      console.log('  跳过：未找到 QODERCN_ACCOUNT_* 凭据（先在面板登录一次）')
      return
    }
    const models = await fetchQoderRemoteModels(entries[0]!.credential, QODER_CN)
    expect(models.length, '远端目录为空 —— 检查该账号是否已开通').toBeGreaterThan(0)
    const ids = new Set<string>()
    for (const model of models) {
      expect(model.id, '模型 id 不能为空').toBeTruthy()
      expect(model.name, `${model.id} 的展示名不能为空`).toBeTruthy()
      expect(ids.has(model.id), `远端目录出现重复 id ${model.id}`).toBe(false)
      ids.add(model.id)
    }
    expect(models.some((m) => m.id === 'dfmodel'), '目录里没有 dfmodel').toBe(true)
    console.log(`[qodercn] 远端目录 ${models.length} 条：`
      + models.map((m) => `${m.id}=${m.name}`).join(', '))
  })

  /**
   * 活动条目的**双语文本**（徽标 + 悬停说明）读得出来。
   *
   * 为什么要有这条（2026-11-18 实测）：
   * - 官方渲染层的取词函数 `Yg1(e, locale)` 接受**四个键** `en / zh / en_us / cn_zh`
   *   （`zh → cn_zh`、`en → en_us`，再做全键兜底），且 `Zq()` 会 `trim`；
   * - 我们原先只读 `zh / en` ⇒ 上游一旦改发区域变体，徽标与悬停会**整条静默消失**
   *   （`qoderPromotionCandidate` 在没有 label 时返回 undefined 且**不打日志**）；
   * - `promotion.description`（悬停那句原话）我们**整条没读**，而它今天在两站都发。
   *
   * 判据**只打结构，不钉文案**：上游随时会改折扣措辞，逐字断言必然腐坏。
   * 键集合的白名单是唯一「硬」的那格 —— 上游出现第五个语言键时要有人来看。
   */
  it('活动条目的徽标与悬停说明读得出来（键集合只用官方那四个）', async () => {
    const entries = readQoderCredentialsFromDshStore({ refPrefix: 'QODERCN' })
    if (entries.length === 0) {
      console.log('  跳过：未找到 QODERCN_ACCOUNT_* 凭据（先在面板登录一次）')
      return
    }
    const captured: string[] = []
    const models = await fetchQoderRemoteModels(entries[0]!.credential, QODER_CN, {
      fetcher: async (url, init) => {
        const response = await fetch(url, init as RequestInit)
        captured.push(await response.clone().text())
        return response
      },
    })

    const byId = new Map(models.map((m) => [m.id, m]))
    const withPromotion = models.filter((m) => m.promotion !== undefined)
    console.log(`[qodercn] 带活动 ${withPromotion.length} 条：`
      + withPromotion.map((m) => `${m.id}=[${m.promotion!.badgeZh ?? ''}|${m.promotion!.badgeEn ?? ''}]`
        + ` desc=${m.promotion!.descriptionZh === undefined ? '-' : 'y'}`).join(', '))

    // 原始报文与解析结果**逐条对齐**（不是「必须活动」的契约断言）：
    // 上游给了文案而我们读不出来 = 静默丢字，正是本 PR 要守的那格。
    //
    // ⚠️ **必须遍历 `QODER_CATALOG_SCENES`，不能只看 `chat`**（2026-11-18 自审）：
    //   解析层吃的是 `chat ∪ app` 并集，而 `lmodel` 这类模型**只发布在 `app`** ⇒
    //   只看 chat 时「只出现在 app 的活动」整条不被核对，上游改发区域变体时这条
    //   守卫会**静默通过**（假绿）。用例名里的「键集合」是唯一硬判据，覆盖面必须
    //   与解析层同域。
    // ⚠️ 跨场景同 id 时解析层**按 scenes 顺序去重、靠前的赢**（`chat` 优先）⇒
    //   与解析结果对齐时只有「赢家场景」那条能断言；后出现的同 id 条目只登记
    //   不断言（否则 chat 缺 description 而 app 有，红会红在错误的地方）。
    const ALLOWED = new Set(['en', 'zh', 'en_us', 'cn_zh'])
    const rawId = (raw: Record<string, unknown>): string => String(raw.key ?? raw.model_key ?? '')
    let checked = 0
    let keyChecks = 0
    let skippedDuplicates = 0
    for (const text of captured) {
      let parsed: unknown
      try { parsed = JSON.parse(text) } catch { continue }
      const body = parsed as Record<string, unknown>
      const scenes = QODER_CATALOG_SCENES
        .filter((scene) => Array.isArray(body[scene])) as string[]
      if (scenes.length === 0) continue // 报文里一个场景都没有 ⇒ 不是这份报告
      // 第一遍：按 scenes 顺序算「每个 id 的赢家场景」（与 parseQoderRemoteModelsForScenes 同判）。
      const winners = new Map<string, string>()
      for (const scene of scenes) {
        for (const raw of body[scene] as Record<string, unknown>[]) {
          if (typeof raw !== 'object' || raw === null) continue
          const id = rawId(raw)
          if (id === '' || winners.has(id)) continue
          winners.set(id, scene)
        }
      }
      // 第二遍：逐条核对。
      // ⚠️ 两条判据的覆盖面**刻意不同**：
      // - **键白名单**（ALLOWED）对**所有场景的所有条目**生效 —— 它只读原始报文，
      //   与「谁是赢家」无关。今天 app 与 chat 的条目逐 id 重复，若把它也限定在赢家，
      //   这条腿在 app 上就**恒空跑**（2026-11-18 实测 app 14 条、其中 2 条带活动）。
      // - **「上游有文案 ⇒ 我们不得读空」** 只对赢家场景生效（解析层按 scenes 顺序
      //   去重，非赢家那条根本没被解析）—— 否则 chat 缺 description 而 app 有，
      //   红会红在错误的地方。
      for (const scene of scenes) {
        const list = body[scene] as Record<string, unknown>[]
        let withPromotionInScene = 0
        for (const raw of list) {
          if (typeof raw !== 'object' || raw === null) continue
          const promotion = raw.promotion as Record<string, unknown> | undefined
          if (typeof promotion !== 'object' || promotion === null) continue
          withPromotionInScene++
          const id = rawId(raw)
          const isWinner = winners.get(id) === scene
          if (!isWinner) skippedDuplicates++
          const parsedModel = isWinner ? byId.get(id) : undefined
          for (const field of ['badge', 'description'] as const) {
            const block = promotion[field]
            if (typeof block !== 'object' || block === null) continue
            const keys = Object.keys(block as object)
            for (const key of keys) {
              keyChecks++
              expect(ALLOWED.has(key), `${id}（场景 ${scene}）的 promotion.${field} 出现未知语言键 "${key}"`
                + ' —— 官方读取口径是 en/zh/en_us/cn_zh，先取证再决定要不要加').toBe(true)
            }
            if (parsedModel?.promotion === undefined) continue
            const upstreamHasText = keys.some((key) => {
              const value = (block as Record<string, unknown>)[key]
              return typeof value === 'string' && value.trim().length > 0
            })
            if (!upstreamHasText) continue
            const read = field === 'badge'
              ? parsedModel.promotion.badgeZh ?? parsedModel.promotion.badgeEn
              : parsedModel.promotion.descriptionZh ?? parsedModel.promotion.descriptionEn
            expect(read, `${id}（场景 ${scene}）的上游 promotion.${field} 有文案（键 ${keys.join(',')}）`
              + '但我们解析出来是空的 —— 键名口径漂了').toBeTruthy()
            checked++
          }
        }
        // 打印「键检查」次数是**为了证明非赢家场景那条腿不是空跑**（今天 app 与 chat
        // 逐 id 重复，文案对齐在 app 上被跳过，但键白名单照查）。
        console.log(`[qodercn] 场景 ${scene}：${list.length} 条，带活动 ${withPromotionInScene} 条`
          + `，键检查 ${keyChecks} 次`)
      }
      if (skippedDuplicates > 0) {
        console.log(`[qodercn] 跨场景同 id ${skippedDuplicates} 条（按 scenes 顺序去重，靠前的赢）：`
          + '这些条目的文案按赢家场景核对，解析层并没有跨场景合并字段')
      }
    }
    expect(checked, '两站今天都应至少有一条带文案的活动；0 说明报告结构变了').toBeGreaterThan(0)
  })
})
