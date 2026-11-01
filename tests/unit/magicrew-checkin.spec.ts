import { describe, expect, it } from 'vitest'
import {
  MAGICREW_NOT_MANUALLY_COMPLETABLE,
  claimMagicrewLoginGift,
  claimMagicrewOnboardingTasks,
  fetchMagicrewOnboardingStatus,
  magicrewTaskIsDone,
} from '../../src/magicrew-checkin.js'
import { MAGICREW, MAGICREW_INTL } from '../../src/magicrew-product.js'

/**
 * 构造一个可控的 fetch 替身。
 *
 * ⚠️ **必须记录调用**（url / method / headers / body）：本组用例的核心断言之一是
 * 「请求真的打到了国际站的 host」—— 只断言返回值的话，把 `product` 传错
 *（两站 host 不同）也照样绿。
 */
function makeFetch(responder: (url: string, init: RequestInit) => { status?: number, body: string }) {
  const calls: { url: string, init: RequestInit }[] = []
  const impl = (async (input: unknown, init: RequestInit = {}) => {
    const url = String(input)
    calls.push({ url, init })
    const result = responder(url, init)
    return {
      ok: (result.status ?? 200) < 400,
      status: result.status ?? 200,
      text: async () => result.body,
    } as unknown as Response
  }) as unknown as typeof fetch
  return { impl, calls }
}

/** 日常签到成功的真实报文（实测形状，见 `magicrew-checkin.ts` 文件头）。 */
const LOGIN_GIFT_GRANTED = JSON.stringify({
  code: 1000,
  data: { granted: true, point_amount: 50, expire_type: 1, message: '成功领取每日登录积分' },
})

/** 当天已领的真实报文（HTTP 仍是 200）。 */
const LOGIN_GIFT_ALREADY = JSON.stringify({
  code: 1000,
  data: { granted: false, point_amount: 0, message: '今日已领取登录积分' },
})

describe('★ magicrew 每日签到（POST /api/v1/login-gift）', () => {
  it('★ 领取成功：回 claimed + 上游金额，并打到正确的 host', async () => {
    const { impl, calls } = makeFetch(() => ({ body: LOGIN_GIFT_GRANTED }))
    const outcome = await claimMagicrewLoginGift({
      jwt: 'jwt-x',
      organizationCode: 'org-x',
      product: MAGICREW_INTL,
      fetchImpl: impl,
    })
    expect(outcome).toMatchObject({ kind: 'claimed', credit: 50 })
    // ⚠️ 2026-11-01 测试有效性审查（次要项）：`streakDays` / `isStreakDay` 也必须钉住。
    //    上游**不提供连续签到天数**（`expire_type` 是有效期类型，不是 streak），
    //    生产如实填 `0 / false`；把这两个值改成 `7 / true`（编造连续天数）原先
    //    466 条相关用例全绿。
    expect(outcome).toMatchObject({ streakDays: 0, isStreakDay: false })
    expect(calls).toHaveLength(1)
    // ⚠️ 国际站必须打到 `magic-service.magicrew.ai`（不是国内站、也不是
    //    `api.magicrew.ai` 那个 teamshare 网关 —— 后者对 `/api/v1/*` 一律
    //    回 `not match rule path`）。
    expect(calls[0]?.url).toBe('https://magic-service.magicrew.ai/api/v1/login-gift')
    expect(calls[0]?.init.method).toBe('POST')
    // ⚠️ 请求体必须是**空串**而不是省略：上游 Go 侧对省略 body 的行为未取证。
    expect(calls[0]?.init.body).toBe('')
  })

  it('★ 国内站打到 i-magic-service.letsmagic.cn（两站 host 不同，靠 product 分流）', async () => {
    const { impl, calls } = makeFetch(() => ({ body: LOGIN_GIFT_GRANTED }))
    await claimMagicrewLoginGift({ jwt: 'j', organizationCode: 'o', product: MAGICREW, fetchImpl: impl })
    expect(calls[0]?.url).toBe('https://i-magic-service.letsmagic.cn/api/v1/login-gift')
  })

  it('★ 当天已领 → already-claimed（不是 claimed），否则用户会以为每天在加积分', async () => {
    const { impl, calls } = makeFetch(() => ({ body: LOGIN_GIFT_ALREADY }))
    const outcome = await claimMagicrewLoginGift({ jwt: 'j', organizationCode: 'o', fetchImpl: impl })
    expect(outcome.kind).toBe('already-claimed')
    expect(outcome).toMatchObject({ message: '今日已领取登录积分' })
    // ⚠️ 2026-11-01 测试有效性审查（次要项）：`already-claimed` 分支**不得**带
    //    `credit` —— 带了就会让上层把「没领到」显示成「+N 积分」。
    //    `toMatchObject` 不拦多余字段，故必须显式判 undefined。
    expect((outcome as { credit?: number }).credit).toBeUndefined()
    expect(calls, '必须真的发了请求').toHaveLength(1)
  })

  it('★ 业务码非 1000 → failed（HTTP 200 也要判失败：token 无效会藏在 body 里）', async () => {
    const { impl } = makeFetch(() => ({
      body: JSON.stringify({ code: 403, message: 'token无效' }),
    }))
    const outcome = await claimMagicrewLoginGift({ jwt: 'j', organizationCode: 'o', fetchImpl: impl })
    expect(outcome).toMatchObject({ kind: 'failed' })
    expect((outcome as { message: string }).message).toContain('token无效')
  })

  it('★ 非 JSON 响应要把 HTTP 状态码浮出来（国际站缺 org 时是 500 + 裸文本）', async () => {
    // ⚠️⚠️ 2026-11-01 测试有效性审查：这条用例原先传 `organizationCode: ''` +
    //    `product: MAGICREW_INTL`，会被 `magicrew-checkin.ts` 的**本地前置拦截**
    //    （`needsOrgOnGateway` 判断）截住 ⇒ `calls = 0`，根本没测到「非 JSON」那条腿；
    //    `toContain('HTTP 500')` 之所以过，纯粹因为前置拦截的兜底文案里**恰好**
    //    写了「该站网关缺此头会直接回 HTTP 500」。删掉非 JSON 分支的 `HTTP ${status}`
    //    后这条仍绿 —— 空转用例。
    //    修法：org 给非空（放行到真发请求），并断言**真的发了一次**。
    const { impl, calls } = makeFetch(() => ({ status: 500, body: 'organization code required' }))
    const outcome = await claimMagicrewLoginGift({
      jwt: 'j', organizationCode: 'org-x', product: MAGICREW_INTL, fetchImpl: impl,
    })
    expect(outcome).toMatchObject({ kind: 'failed' })
    expect((outcome as { message: string }).message).toContain('HTTP 500')
    expect(calls, '被本地前置拦截了 ⇒ 本用例测的不是「非 JSON」那条腿').toHaveLength(1)
  })

  it('★ 网络异常折成 failed（不抛）', async () => {
    const impl = (async () => { throw new Error('fetch failed') }) as unknown as typeof fetch
    const outcome = await claimMagicrewLoginGift({ jwt: 'j', organizationCode: 'o', fetchImpl: impl })
    expect(outcome).toMatchObject({ kind: 'failed' })
    expect((outcome as { message: string }).message).toContain('fetch failed')
  })

  it('★ organization-code 只在非空时附（空串附了会让上游判错）', async () => {
    const { impl, calls } = makeFetch(() => ({ body: LOGIN_GIFT_GRANTED }))
    await claimMagicrewLoginGift({ jwt: 'j', organizationCode: '', fetchImpl: impl })
    const headers = calls[0]?.init.headers as Record<string, string>
    expect(headers['organization-code']).toBeUndefined()
    expect(headers.authorization).toBe('Bearer j')
    expect(headers.origin).toBe('https://www.letsmagic.cn')
  })
})

describe('★ magicrew 新人奖励（onboarding/tasks）', () => {
  const TASKS_BODY = JSON.stringify({
    code: 1000,
    data: {
      participant_type: null,
      tasks: [
        { code: 'a', title: '任务 A', points: 100, status: 'COMPLETED', reward_status: 'GRANTED' },
        { code: 'b', title: '任务 B', points: 50, status: 'PENDING', reward_status: '' },
        { code: 'first_ai_work', title: '首次对话', points: 350, status: 'PENDING', reward_status: '' },
      ],
    },
  })

  it('★ status 只读：不触发任何 completion', async () => {
    const { impl, calls } = makeFetch(() => ({ body: TASKS_BODY }))
    const status = await fetchMagicrewOnboardingStatus({ jwt: 'j', organizationCode: 'o', fetchImpl: impl })
    expect(calls.every((c) => c.init.method === 'GET')).toBe(true)
    expect(status.tasks).toEqual({ a: true, b: false, first_ai_work: false })
    expect(status.earned).toBe(100)
    expect(status.total).toBe(500)
    expect(status.titles).toMatchObject({ a: '任务 A', first_ai_work: '首次对话' })
  })

  /**
   * ★★ **请求失败必须上抛，不得折成「0 项任务」**（2026-11-01 测试有效性审查的
   * **重要项**，变异 M4）。
   *
   * 上面那条只守住了「上游**真的**回了空数组 ⇒ total: 0」这一半。另一半 ——
   * **网络/鉴权失败** —— 若被折成空表，UI 会显示「无新人任务」，
   * 而实际上是「我们没读到」。这正是 magpie 0.3.7 犯过的**报假账**形态：
   * 用户以为「这个号没有新人奖励」，实际可能还有 500 分没领。
   *
   * ⚠️ 实测：把 `magicrew-checkin.ts` 里 status 的 `throw` 改成
   * `const tasks = error !== undefined ? [] : …` 后，859 条相关用例**全绿**。
   * ⇒ 必须有这条。
   */
  it('★★ status 请求失败必须上抛（不得折成 0 项 = 报假账）', async () => {
    const { impl, calls } = makeFetch(() => ({ status: 500, body: 'Internal Server Error' }))
    await expect(
      fetchMagicrewOnboardingStatus({
        // ⚠️ org 必须非空：国际站缺 org 会被**本地前置拦截**（不发请求），
        //    那样测的就不是「上游 500」这条腿了（审查里 `:87` 那条就这么废掉的）。
        jwt: 'j', organizationCode: 'org-x', product: MAGICREW_INTL, fetchImpl: impl,
      }),
    ).rejects.toThrow(/HTTP 500/)
    expect(calls, '必须真的发了请求（本地拦截会让本用例空转）').toHaveLength(1)
  })

  it('★★ claim 在 status 失败时同样上抛（不能回一个「没任务可领」的空结果）', async () => {
    const { impl } = makeFetch(() => ({ status: 503, body: 'Service Unavailable' }))
    await expect(
      claimMagicrewOnboardingTasks({
        jwt: 'j', organizationCode: 'org-x', product: MAGICREW_INTL, fetchImpl: impl,
      }),
    ).rejects.toThrow(/HTTP 503/)
  })

  /**
   * ★★ **`points` 的形态边界**（2026-11-01 三审）。
   *
   * 上游这套 Go 服务会下发字符串形态的积分数（见参考实现 `api.mjs` 的 `num()` 注释），
   * 而 `Number()` 会接受一批**不该接受**的写法：
   * `Number('0x10') === 16`、`Number('0b11') === 3`、`Number('1e3') === 1000`。
   * 接受它们会让畸形数据变成一个**看似合理**的数字（用户看到「+16 积分」，
   * 而上游其实给的是垃圾）。
   *
   * ⚠️ 判据：**只接受十进制字面量**；`"1,234 积分"`（千分位 + 单位）、
   * Unicode 负号、十六进制、科学计数一律读作 0（= 「读不到」，宁可少算不编造）。
   */
  it.each([
    { points: '80', expected: 80, why: '纯十进制字符串 ⇒ 接受' },
    { points: ' 80 ', expected: 80, why: '前后空白 ⇒ trim 后接受' },
    { points: 80, expected: 80, why: 'number ⇒ 接受' },
    { points: '80.5', expected: 80.5, why: '十进制小数 ⇒ 接受' },
    { points: '1,234 积分', expected: 0, why: '带千分位与单位 ⇒ 读不到' },
    { points: '0x10', expected: 0, why: '十六进制 ⇒ 不得当成 16' },
    { points: '1e3', expected: 0, why: '科学计数 ⇒ 不得当成 1000' },
    { points: '', expected: 0, why: '空串 ⇒ 读不到' },
    { points: null, expected: 0, why: 'null ⇒ 不得当成 0（Number(null)===0 是陷阱）' },
  ])('★★ points=$points ⇒ $expected（$why）', async ({ points, expected }) => {
    const { impl } = makeFetch(() => ({
      body: JSON.stringify({
        code: 1000,
        data: {
          participant_type: null,
          tasks: [{ code: 'a1', title: 'A1', points, status: 'COMPLETED', reward_status: 'GRANTED' }],
        },
      }),
    }))
    const status = await fetchMagicrewOnboardingStatus({
      jwt: 'j', organizationCode: 'org-x', product: MAGICREW_INTL, fetchImpl: impl,
    })
    expect(status.points.a1).toBe(expected)
    // `earned` 用同一份读数（已领项）⇒ 一起验，避免两处算法漂移。
    expect(status.earned).toBe(expected)
  })

  it('★★ 国际站恒返回空数组 ⇒ total 0（如实报「无任务」，不是「已全部完成」）', async () => {
    const { impl } = makeFetch(() => ({
      body: JSON.stringify({ code: 1000, data: { participant_type: null, tasks: [] } }),
    }))
    const status = await fetchMagicrewOnboardingStatus({
      jwt: 'j', organizationCode: 'o', product: MAGICREW_INTL, fetchImpl: impl,
    })
    expect(status.tasks).toEqual({})
    expect(status.total).toBe(0)
    expect(status.earned).toBe(0)
  })

  it('★★ claim 跳过 first_ai_work（服务端固定回 9303，白试只会产生假错误）', async () => {
    const { impl, calls } = makeFetch((url, init) => {
      if (init.method === 'GET') return { body: TASKS_BODY }
      return { body: JSON.stringify({ code: 1000, data: { points: 50 } }) }
    })
    const result = await claimMagicrewOnboardingTasks({ jwt: 'j', organizationCode: 'o', fetchImpl: impl })
    // 只对 b 发 PUT，first_ai_work 一次都没打
    const puts = calls.filter((c) => c.init.method === 'PUT')
    expect(puts).toHaveLength(1)
    expect(puts[0]?.url).toContain('/onboarding/tasks/b/completion')
    expect(puts.some((c) => c.url.includes('first_ai_work'))).toBe(false)
    expect(result.claimed).toEqual([{ key: 'b', title: '任务 B', points: 50 }])
    /**
     * ⚠️⚠️ `first_ai_work` 必须落 `manualRequired` 而**不是** `skipped`（2026-11-01 协议审查）。
     *
     * `skipped` 的契约是「**此前已完成**」（`src/types.ts:1244`），前端渲染成
     * 「N 个此前已完成」；而 `first_ai_work` 既没完成也没领到分 ——
     * 塞进 `skipped` 就是**把没做写成做过**。
     */
    expect(result.manualRequired).toContain('first_ai_work')
    expect(result.skipped).not.toContain('first_ai_work')
    // 真「此前已完成」的仍然在 skipped。
    expect(result.skipped).toContain('a')
    // earned = 领之前累计 100 + 本次 50
    expect(result.earned).toBe(150)
  })

  it('★ 单项失败不中断整轮（其余项照领）', async () => {
    // 三个待办：b 会失败、c 会成功 ⇒ 证明失败项**没有**中断后续项。
    const body = JSON.stringify({
      code: 1000,
      data: {
        tasks: [
          { code: 'b', title: '任务 B', points: 50, status: 'PENDING', reward_status: '' },
          { code: 'c', title: '任务 C', points: 70, status: 'PENDING', reward_status: '' },
        ],
      },
    })
    const { impl, calls } = makeFetch((url, init) => {
      if (init.method === 'GET') return { body }
      if (url.includes('/b/')) return { body: JSON.stringify({ code: 5000, message: '服务繁忙' }) }
      return { body: JSON.stringify({ code: 1000, data: { points: 70 } }) }
    })
    const result = await claimMagicrewOnboardingTasks({ jwt: 'j', organizationCode: 'o', fetchImpl: impl })
    // 两项都发了 PUT（b 失败没有拦住 c）
    expect(calls.filter((c) => c.init.method === 'PUT')).toHaveLength(2)
    expect(result.claimed).toEqual([{ key: 'c', title: '任务 C', points: 70 }])
    expect(result.earned).toBe(70)
  })

  it('★ 全部项都失败 ⇒ 上抛（不能包成「成功但没领到」）', async () => {
    const body = JSON.stringify({
      code: 1000,
      data: { tasks: [{ code: 'b', title: 'B', points: 50, status: 'PENDING', reward_status: '' }] },
    })
    const { impl } = makeFetch((url, init) => {
      if (init.method === 'GET') return { body }
      return { body: JSON.stringify({ code: 5000, message: '服务繁忙' }) }
    })
    await expect(claimMagicrewOnboardingTasks({ jwt: 'j', organizationCode: 'o', fetchImpl: impl }))
      .rejects.toThrow('新人奖励领取失败')
  })

  it('★ 全部项都已完成 ⇒ 不发任何 PUT，earned 报累计（不是 0）', async () => {
    const allDone = JSON.stringify({
      code: 1000,
      data: { tasks: [{ code: 'a', title: 'A', points: 100, status: 'COMPLETED', reward_status: 'GRANTED' }] },
    })
    const { impl, calls } = makeFetch(() => ({ body: allDone }))
    const result = await claimMagicrewOnboardingTasks({ jwt: 'j', organizationCode: 'o', fetchImpl: impl })
    expect(calls.filter((c) => c.init.method === 'PUT')).toHaveLength(0)
    expect(result.claimed).toEqual([])
    expect(result.earned).toBe(100)
    expect(result.total).toBe(100)
  })

  it('★ COMPLETED 或 reward_status 任一成立即算已领（两字段独立）', () => {
    expect(magicrewTaskIsDone({ code: 'x', title: '', points: 0, status: 'COMPLETED', rewardStatus: '' })).toBe(true)
    expect(magicrewTaskIsDone({ code: 'x', title: '', points: 0, status: 'PENDING', rewardStatus: 'GRANTED' })).toBe(true)
    expect(magicrewTaskIsDone({ code: 'x', title: '', points: 0, status: 'PENDING', rewardStatus: '' })).toBe(false)
  })

  it('★ first_ai_work 在不可手动完成名单里', () => {
    expect(MAGICREW_NOT_MANUALLY_COMPLETABLE).toContain('first_ai_work')
  })

  it('★ 有成功也有失败 ⇒ 失败进 errors 且**不上抛**（旧实现把它们静默吞掉）', async () => {
    const body = JSON.stringify({
      code: 1000,
      data: {
        tasks: [
          { code: 'ok1', title: 'O1', points: 50, status: 'PENDING', reward_status: '' },
          { code: 'bad', title: 'B', points: 70, status: 'PENDING', reward_status: '' },
          { code: 'ok2', title: 'O2', points: 30, status: 'PENDING', reward_status: '' },
        ],
      },
    })
    const { impl } = makeFetch((url, init) => {
      if (init.method === 'GET') return { body }
      if (url.includes('/bad/')) return { body: JSON.stringify({ code: 5000, message: '服务繁忙' }) }
      return { body: JSON.stringify({ code: 1000, data: { points: 0 } }) }
    })
    const result = await claimMagicrewOnboardingTasks({
      jwt: 'j', organizationCode: 'o', fetchImpl: impl, throttleMs: 0,
    })
    expect(result.claimed.map((c) => c.key).sort()).toEqual(['ok1', 'ok2'])
    // ⚠️ 失败**必须**能被看见（旧实现只在「零成功」时上抛，部分失败无字段承载）。
    expect(result.errors).toHaveLength(1)
    expect(result.errors?.[0]).toContain('bad')
    // ⚠️ 且失败项**不得**伪装成「此前已完成」。
    expect(result.skipped).not.toContain('bad')
  })

  it('★ PUT 返回 points: 0 时回退任务表的 points（不把已领金额算成 0）', async () => {
    const body = JSON.stringify({
      code: 1000,
      data: { tasks: [{ code: 'b', title: 'B', points: 88, status: 'PENDING', reward_status: '' }] },
    })
    const { impl } = makeFetch((url, init) => {
      if (init.method === 'GET') return { body }
      return { body: JSON.stringify({ code: 1000, data: { points: 0 } }) }
    })
    const result = await claimMagicrewOnboardingTasks({ jwt: 'j', organizationCode: 'o', fetchImpl: impl })
    expect(result.claimed).toEqual([{ key: 'b', title: 'B', points: 88 }])
    expect(result.earned).toBe(88)
  })
})

/**
 * ## ★★ 判失败的两条腿（2026-11-01 协议审查点名）
 *
 * 上游有**两种**错误形态，只判其中一种就会静默出错：
 * ① **HTTP 200 + body `code: 403`**（「token无效」藏在 body 里）
 * ② **HTTP 5xx + body 是「没有数字 code 的 JSON」**（`{"message":"…"}`）
 *
 * 旧实现只判 ①，于是 ② 会被判成**成功**：签到因 `granted !== true` 落进
 * `already-claimed`「今日已领取登录积分」⇒ **静默漏领 200/50 分且零报错**。
 */
describe('★★ 判失败的两条腿：业务码 + HTTP 状态码', () => {
  it('① HTTP 200 + code:403 ⇒ failed（不是 already-claimed）', async () => {
    const { impl } = makeFetch(() => ({
      body: JSON.stringify({ code: 403, message: 'token无效' }),
    }))
    const outcome = await claimMagicrewLoginGift({ jwt: 'j', organizationCode: 'o', fetchImpl: impl })
    expect(outcome.kind).toBe('failed')
    expect((outcome as { message: string }).message).toContain('token无效')
  })

  /**
   * ★★ **`granted` 缺席 ⇒ failed，不是 already-claimed**（2026-11-01 三审）。
   *
   * 只判 `granted === true` 时，`200 + {}` 会落进「不是 true」那条腿
   * ⇒ 返回「今日已领取登录积分」⇒ **用户以为领过了，实际什么都没发生**。
   * 正常响应里 `granted` **恒存在且是布尔**，缺它就是形态变了。
   */
  it.each([
    { body: '{}', why: '空对象' },
    { body: JSON.stringify({ code: 1000 }), why: '有 code 但无 data' },
    { body: JSON.stringify({ code: 1000, data: {} }), why: 'data 为空' },
    { body: JSON.stringify({ code: 1000, data: { point_amount: 50 } }), why: '有金额但无 granted' },
    { body: JSON.stringify({ code: 1000, data: { granted: 'true' } }), why: 'granted 是字符串' },
  ])('★★ granted 缺失/非布尔 ⇒ failed（$why）', async ({ body }) => {
    const { impl } = makeFetch(() => ({ body }))
    const outcome = await claimMagicrewLoginGift({
      jwt: 'j', organizationCode: 'org-x', product: MAGICREW_INTL, fetchImpl: impl,
    })
    expect(outcome.kind, '缺 granted 时被判成 already-claimed = 静默漏领').toBe('failed')
  })

  /**
   * ★ **PUT 之间的 400ms 节流**（2026-11-01 三审：原先零守卫，删掉整块用例仍全绿）。
   *
   * 判据：3 个待领任务 ⇒ 2 个间隔 ⇒ 总耗时 ≥ 800ms。
   * ⚠️ 用 `throttleMs` 显式给一个小值（120ms）而不是真等 400ms×2，
   *    既守住「间隔真的存在」，也不让用例跑 1 秒。
   * ⚠️ 同时断言「首次 PUT 之前**不**等待」—— 那是最容易被写错的地方
   *   （`putCount > 0` 写成 `putCount >= 0` 会让每次请求前都白等）。
   */
  it('★ PUT 节流：相邻两次之间有间隔，且首次不发前等待', async () => {
    const timestamps: number[] = []
    const { impl } = makeFetch((url, init) => {
      if (init.method === 'PUT') timestamps.push(Date.now())
      return init.method === 'PUT'
        ? { body: JSON.stringify({ code: 1000, data: { points: 50 } }) }
        : {
            body: JSON.stringify({
              code: 1000,
              data: {
                participant_type: null,
                tasks: [
                  { code: 'a', title: 'A', points: 50, status: '', reward_status: '' },
                  { code: 'b', title: 'B', points: 50, status: '', reward_status: '' },
                  { code: 'c', title: 'C', points: 50, status: '', reward_status: '' },
                ],
              },
            }),
          }
    })
    const started = Date.now()
    const result = await claimMagicrewOnboardingTasks({
      jwt: 'j', organizationCode: 'org-x', product: MAGICREW_INTL, fetchImpl: impl, throttleMs: 120,
    })
    expect(result.claimed).toHaveLength(3)
    expect(timestamps).toHaveLength(3)
    // ① 首次 PUT 几乎立刻发生（不得在第一次之前就等待）。
    expect(timestamps[0]! - started, '首次 PUT 之前就等待了 —— 节流条件写成了 >= 0').toBeLessThan(100)
    // ② 相邻两次之间的间隔真的存在（≈120ms，允许调度抖动）。
    expect(timestamps[1]! - timestamps[0]!).toBeGreaterThanOrEqual(100)
    expect(timestamps[2]! - timestamps[1]!).toBeGreaterThanOrEqual(100)
  })

  it('★★ 9303 以**字符串** code 下发时也归 manualRequired（不是 errors）', async () => {
    // ⚠️ 2026-11-01 三审：9303 兜底原先只认数字，`{"code":"9303"}` 会落 errors
    //    ⇒ 与「9303 不该让整轮失败」的自述不符（且没有守卫）。
    const { impl } = makeFetch((url, init) => {
      if (init.method === 'PUT') {
        return { status: 400, body: JSON.stringify({ code: '9303', message: '不支持手动完成' }) }
      }
      return {
        body: JSON.stringify({
          code: 1000,
          data: {
            participant_type: null,
            tasks: [{ code: 'weird_task', title: 'W', points: 50, status: '', reward_status: '' }],
          },
        }),
      }
    })
    const result = await claimMagicrewOnboardingTasks({
      jwt: 'j', organizationCode: 'org-x', product: MAGICREW_INTL, fetchImpl: impl, throttleMs: 0,
    })
    expect(result.claimed).toHaveLength(0)
    expect(result.manualRequired, '字符串 9303 应归 manualRequired').toEqual(['weird_task'])
    expect(result.errors ?? []).toEqual([])

  })

  /**
   * ★★ **9303 以「非 2xx + 数字 code」下发时也必须归 `manualRequired`**（2026-11-01 三审补）。
   *
   * ## 这条守的是**信封在错误腿里被保留**这件事
   *
   * 三审实测：把 `magicrewRequest` 非 2xx 腿的 `return { envelope, error }`
   * 改成 `return { error }`，**全量 11734 条全绿** —— 因为别的用例都用
   * `{"code":"9303"}` 走**字符串腿**（那条腿有 envelope），而**数字码 + 非 2xx**
   * 走的是**数字腿**，两处都返回 envelope。
   *
   * ⚠️ 换句话说：`code` 只要存在（数字或十进制字符串），就必然在 ①②③ 之一
   * 被拦下且带 envelope；真正会丢 envelope 的是**非 2xx 且 body 里没有可用 code**
   * 的那种响应 —— 而那种响应里**本来就没有 9303**，`codeOf` 也取不到。
   * ⇒ 所以「丢 envelope」当前**不会**导致 9303 误判（审计员那条是理论隐患）。
   * 但**仍然值得钉住**：上游完全可能把 `{"code":9303}` 与 500 一起下发，
   * 而这条用例能同时守住「数字腿保留 envelope」与「9303 归 manualRequired」。
   */
  it('★★ 9303 + HTTP 500（非 2xx）⇒ 仍归 manualRequired，不上抛', async () => {
    const { impl } = makeFetch((url, init) => {
      if (init.method === 'PUT') {
        return { status: 500, body: JSON.stringify({ code: 9303, message: '不支持手动完成' }) }
      }
      return {
        body: JSON.stringify({
          code: 1000,
          data: {
            participant_type: null,
            tasks: [{ code: 't1', title: 'T1', points: 30, status: '', reward_status: '' }],
          },
        }),
      }
    })
    const result = await claimMagicrewOnboardingTasks({
      jwt: 'j', organizationCode: 'org-x', product: MAGICREW_INTL, fetchImpl: impl, throttleMs: 0,
    })
    expect(result.claimed).toHaveLength(0)
    expect(result.manualRequired, '9303 + 500 应归 manualRequired（不是 errors）').toEqual(['t1'])
    expect(result.errors ?? [], '9303 不该进 errors（那会让零成功时整轮上抛）').toEqual([])
  })

  it('② HTTP 500 + `{"message":"…"}`（**无数字 code**）⇒ failed，不得判成功', async () => {
    const { impl } = makeFetch(() => ({
      status: 500,
      body: JSON.stringify({ message: 'Internal Server Error' }),
    }))
    const outcome = await claimMagicrewLoginGift({ jwt: 'j', organizationCode: 'o', fetchImpl: impl })
    // ⚠️ 关键：**不得**落进 `already-claimed`（那等于告诉用户「今天已领」，
    //    而实际一分没领到）。
    expect(outcome.kind).toBe('failed')
  })

  it('② HTTP 502 + `{"code":"403"}`（code 是**字符串**）⇒ failed', async () => {
    const { impl } = makeFetch(() => ({ status: 502, body: JSON.stringify({ code: '403' }) }))
    const outcome = await claimMagicrewLoginGift({ jwt: 'j', organizationCode: 'o', fetchImpl: impl })
    expect(outcome.kind).toBe('failed')
  })

  /**
   * ★★ **字符串业务码只在「十进制字面量」时才被解释**（2026-11-01 三审）。
   *
   * ## ⚠️ 选 `0x3E7` 而不是 `0x3E8` 的原因（三审实测：`0x3E8` 那条是**假牙**）
   *
   * `Number('0x3E8') === 1000`，恰好**等于成功码**。于是：
   * - 用正则拒绝 ⇒ 不判失败 ⇒ 落 `response.ok` ⇒ 成功 ⇒ `claimed`；
   * - 用裸 `Number()` ⇒ 等于 1000 ⇒ 不判失败 ⇒ 同样 `claimed`。
   * **两条路径的终态都是 `claimed`，任何 fixture 都区分不了** —— 写一条断 `claimed`
   * 的用例却在注释里说「不得当成成功码」，是自相矛盾的假牙。
   *
   * ⇒ 换成 `0x3E7`（= **999**，不等于成功码）：
   * - 正则拒绝 ⇒ 不判失败 ⇒ 落 `response.ok` ⇒ **claimed**；
   * - 裸 `Number()` ⇒ 999 ≠ 1000 ⇒ **failed**。
   * 两种实现**终态不同** ⇒ 这条用例真的有牙（实测：把第三腿改成裸 `Number()` 即红）。
   *
   * ⚠️ 反向也要守住：**真正的十进制成功码 `"1000"` 必须放行**
   *   —— 收得太紧会让所有正常响应被判失败，那是更严重的回归。
   */
  it.each([
    { code: '1000', kind: 'claimed', why: '十进制成功码 ⇒ 放行' },
    { code: '0x3E7', kind: 'claimed', why: '十六进制 999 ⇒ 正则拒绝后走 response.ok（裸 Number 会判 failed）' },
    { code: '403', kind: 'failed', why: '十进制失败码 ⇒ 判失败' },
    { code: 'OK', kind: 'claimed', why: '非数字字符串 ⇒ 形态未知，交给 response.ok 兜底' },
  ])('★★ code=$code ⇒ $kind（$why）', async ({ code, kind }) => {
    const { impl } = makeFetch(() => ({
      body: JSON.stringify({
        code,
        message: 'x',
        data: { granted: true, point_amount: 7 },
      }),
    }))
    const outcome = await claimMagicrewLoginGift({
      jwt: 'j', organizationCode: 'org-x', product: MAGICREW_INTL, fetchImpl: impl,
    })
    expect(outcome.kind).toBe(kind)
  })

  it('② HTTP 500 + 裸文本（网关故障的真实形态）⇒ failed 且文案带状态码', async () => {
    const { impl } = makeFetch(() => ({ status: 500, body: 'Internal Server Error.' }))
    const outcome = await claimMagicrewLoginGift({ jwt: 'j', organizationCode: 'o', fetchImpl: impl })
    expect(outcome.kind).toBe('failed')
    expect((outcome as { message: string }).message).toContain('500')
  })

  it('③ 国际站缺 org ⇒ 本地就拦下（不发请求，文案可操作）', async () => {
    const { impl, calls } = makeFetch(() => ({ body: LOGIN_GIFT_GRANTED }))
    const outcome = await claimMagicrewLoginGift({
      jwt: 'j', organizationCode: '', product: MAGICREW_INTL, fetchImpl: impl,
    })
    expect(calls).toHaveLength(0)
    expect(outcome.kind).toBe('failed')
    expect((outcome as { message: string }).message).toContain('组织码')
  })

  it('③ 国内站缺 org 不拦（该站不强制，拦了会让本来能用的账号失败）', async () => {
    const { impl, calls } = makeFetch(() => ({ body: LOGIN_GIFT_GRANTED }))
    const outcome = await claimMagicrewLoginGift({
      jwt: 'j', organizationCode: '', product: MAGICREW, fetchImpl: impl,
    })
    expect(calls).toHaveLength(1)
    expect(outcome.kind).toBe('claimed')
  })
})

/**
 * ★★ **两站 product 常量的逐字段对照**（2026-11-01 测试有效性审查的次要项）。
 *
 * 审查实测：`MAGICREW_INTL.webOrigin` 与 `.defaultCredentialRef` **没有任何用例**
 *（`host` 被 host 分流用例钉住、`needsOrgOnGateway` 被 org 拦截用例钉住，
 * 只有这两个是真空）。
 *
 * 后果都不轻：
 * - `webOrigin` 错 ⇒ 网页登录打开的是**国内站**登录页，用户登完拿到国内 JWT，
 *   打到国际 host 恒 401；且 `Origin` 头错会让网关偶发 403。
 * - `defaultCredentialRef` 错 ⇒ 手工注入凭据那条腿（`fallback: { kind: 'ref' }`）
 *   会落到国内站的 ref 上，与 `MAGICREW_ACCOUNT_*` 不是同一时空。
 */
describe('★★ MAGICREW_INTL 的字段值（国际站不能照抄国内站的值）', () => {
  it('webOrigin / host / displayName 三项都与国内站不同', () => {
    expect(MAGICREW_INTL.webOrigin).toBe('https://www.magicrew.ai')
    expect(MAGICREW_INTL.host).toBe('https://magic-service.magicrew.ai')
    expect(MAGICREW_INTL.displayName).toBe('MagiCrew')
    // 反向自检：三项都不得等于国内站的值（复制粘贴错误会三处同时错）。
    expect(MAGICREW_INTL.webOrigin).not.toBe(MAGICREW.webOrigin)
    expect(MAGICREW_INTL.host).not.toBe(MAGICREW.host)
    expect(MAGICREW_INTL.displayName).not.toBe(MAGICREW.displayName)
  })

  it('defaultCredentialRef 两站不同（ref 命名空间必须隔离）', () => {
    expect(MAGICREW_INTL.defaultCredentialRef).toBe('MAGICREWINTL_ACCESS_TOKEN')
    expect(MAGICREW.defaultCredentialRef).toBe('MAGICREW_ACCESS_TOKEN')
    expect(MAGICREW_INTL.defaultCredentialRef).not.toBe(MAGICREW.defaultCredentialRef)
  })

  it('id / site 两站不同且与 registry 的 provider id 一致', () => {
    expect(MAGICREW_INTL.id).toBe('magicrewintl')
    expect(MAGICREW_INTL.site).toBe('intl')
    expect(MAGICREW.id).toBe('magicrew')
    expect(MAGICREW.site).toBe('cn')
  })

  it('needsOrgOnGateway 两站相反（只有国际站强制 org）', () => {
    // ⚠️ 二审更正：两站**缺 org 的响应形态不同** —— 业务 API `/api/v1/*` 是
    //    `{"code":2182,"message":"用户所在组织不存在"}`，而聊天网关 `/v1/*`
    //    才是「HTTP 500 + 22 字节裸文本」。本常量表达的是「该站是否强制 org」，
    //    不是「会不会回 500」。
    expect(MAGICREW_INTL.needsOrgOnGateway).toBe(true)
    expect(MAGICREW.needsOrgOnGateway).toBe(false)
  })
})
