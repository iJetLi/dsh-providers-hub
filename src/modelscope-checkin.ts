import { utc8DateString } from './auto-checkin.js'
import { roundCredits, type ClaimOutcome } from './credits.js'
import type { ModelscopeCredential } from './modelscope.js'

const MODELSCOPE_SITE = 'https://www.modelscope.cn'
const PAGE_SIZE = 50
const MAX_PAGES = 20
const DAILY_RULES = new Set(['daily_active', 'aliyun_bindlogin'])

/**
 * ⚠⚠ **`rule_key` 是上游数据，拼进用户可见文案前必须过白名单（PR #83 对抗审计 P1-1）。**
 *
 * 上一版直接把 `rule_key` 拼进 `inactive.message`，实测五格全部成立：
 * - 把 **API Key** 当 `rule_key` ⇒ **Key 完整回显**（用户截图发 issue 就泄露了）；
 * - 换行 ⇒ 日志伪造；ANSI / HTML ⇒ 终端与页面注入；
 * - 5000 字符 ⇒ 整屏滞涨。
 *
 * 同一处注释原来自称「不会把上游原文糊给用户」—— 它只管了
 * `catch` 那条路，而 `return` 这条根本不经过它。字符集 + 长度双上限。
 */
const RULE_KEY_PATTERN = /^[a-z][a-z0-9_]{0,39}$/

interface MagicubeTransaction {
  type?: unknown
  rule_key?: unknown
  total_amount?: unknown
  gmt_created?: unknown
  expire_at?: unknown
}

interface ModelscopeWebResponse {
  success?: boolean
  Success?: boolean
  code?: string | number
  Code?: string | number
  data?: { records?: MagicubeTransaction[] | null; total?: number | string }
  Data?: ModelscopeWebResponse['data']
}

async function readModelscopeWeb(path: string, apiKey: string, signal: AbortSignal) {
  if (!/^ms-[A-Za-z0-9_-]{16,}$/.test(apiKey)) throw new Error('没有可用的魔搭访问令牌')
  const response = await fetch(new URL(path, MODELSCOPE_SITE), {
    redirect: 'error',
    headers: {
      /**
       * ⚠️⚠️ **两个认证头必须同时给（PR #83 正向审计 P1-1，2026-11-15）。**
       *
       * 这个函数要打**两族**端点，而它们的认证方式**不同源**：
       * - `/openapi/v1/magicubes/transactions`（API Key 族）—— 本仓既有实测用
       *   `Authorization: Bearer ms-…` 直接 200（见 `src/modelscope-credits.ts`
       *   的 `GET /openapi/v1/magicubes/balance`）；
       * - `/api/v1/users/login/info`（**网页登录**族）—— 本仓 2026-09 的实测记录是
       *   「用 API Key 打 `/api/v1/users/info` ⇒ **400 获取用户信息失败**」，
       *   当时只有网页会话 cookie 能过。
       *
       * PR 原实现**只发 `cookie`、完全不带 `Authorization`** —— 若上游从未接受
       * 「API Key 当 cookie」，这条腿就是**结构性失效**：`records` 拿不到 ⇒ 与
       * 「今天没发放」**不可区分** ⇒ 每天静默返回 `inactive` + 假成功文案
       * 「登录请求成功，发放记录暂未新增魔粒」（本仓「静默失效」红线）。
       *
       * ⇒ **双头并给**：Bearer 让 API Key 族成立，cookie 兼容网页会话形态。
       * 多一个头对上游无害（两者都是凭据，且同一个 Key），但少一个就可能整条腿
       * 静默失效 —— 这类「只差一个头」的缺陷本仓已记录过多次。
       *
       * ⚠️ 仍**未真机验证**（无凭据）：见 README 与 `docs/agent-notes/` 的
       * 「需要上游确认」段。谁有真机报文请回填。
       */
      authorization: 'Bearer ' + apiKey,
      accept: 'application/json',
      cookie: 'm_session_id=' + apiKey,
      referer: MODELSCOPE_SITE + '/',
      'user-agent': 'Mozilla/5.0 Chrome/140.0.0.0 Safari/537.36',
    },
    signal,
  })
  /**
   * ⚠⚠ **HTML 必须单独判，且要排在 401/403 之前（PR #83 对抗审计 P2-2）。**
   *
   * SPA 的 catch-all 路由会对**任意**尚未定义的路径回 `200 + text/html`。
   * 当登录态失效时，页面路由层可能把接口请求接成一个**登录页**
   * —— 那时状态码是 200、响应体是 HTML，并不会走到 401/403 分支。
   *
   * 原实现让它落到下面的 `!response.ok`（不成立）或
   * `未确认请求成功，请到官网检查账号状态`（把用户引向「去看账号」），
   * 从而推不出真正的动作：**重新粘贴令牌**。
   */
  const mediaType = response.headers.get('content-type') ?? ''
  if (mediaType.includes('text/html')) {
    throw new Error('魔搭返回了网页而不是接口数据 —— 登录态可能已失效，请重新粘贴访问令牌')
  }
  if (response.status === 401) throw new Error('魔搭登录态无效，请检查访问令牌')
  if (response.status === 403) throw new Error('魔搭拒绝了请求，请到官网检查账号状态')
  if (!response.ok) throw new Error('魔搭请求失败（HTTP ' + response.status + '）')
  const body = await response.json().catch(() => null) as ModelscopeWebResponse | null
  if ((body?.success ?? body?.Success ?? (String(body?.code ?? body?.Code) === '200')) !== true) {
    throw new Error('魔搭未确认请求成功，请到官网检查账号状态')
  }
  return body?.data ?? body?.Data
}

function timestamp(value: unknown): number {
  if (typeof value !== 'string') return NaN
  const local = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d+)?$/.exec(value)
  if (local) {
    const at = Date.parse(local[1] + 'T' + local[2] + (local[3] ?? '') + '+08:00')
    return Number.isFinite(at) && utc8DateString(at) === local[1] ? at : NaN
  }
  return /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:?\d{2})$/i.test(value) ? Date.parse(value) : NaN
}

/** 按北京日读取近期流水，只在越过日期边界或读完账单时确认完整。 */
async function readGrants(apiKey: string, since: string, signal: AbortSignal) {
  /**
   * ⚠️⚠️ **日期必须双边界（PR #83 对抗审计 P2-1，2026-11-15）。**
   *
   * 原判据只有下界 `>= since`，而 `claim()` 传的 `since` 是「今天零点」⇒
   * **明天的流水会被当成今天的**（上游脏数据、时区错乱都能造出来）：
   * `before.some(row => row.rule_key === 'daily_active')` 命中 ⇒ 返回
   * `{ kind: 'already-claimed', message: '今日登录赠送的魔粒已到账' }`
   * ⇒ **只发 1 次请求、当天彻底不再领取**；而且 `alreadyClaimed` 会计入
   * `coversToday` ⇒ 推进水位线、面板显示「今日已到账」。
   *
   * 补上界 `<= until`（今天）后未来日期一律丢弃。少领一天 vs 谎报「已到账」，
   * 后者更糟：用户以为领到了，实际没有，且当天不再重试。
   */
  const until = utc8DateString()
  const grants: MagicubeTransaction[] = []
  let failure = '达到分页上限'
  const seenPages = new Set<string>()
  let readCount = 0
  for (let page = 1; page <= MAX_PAGES; page++) {
    const path = '/openapi/v1/magicubes/transactions?page=' + page + '&page_size=' + PAGE_SIZE
    const data = await readModelscopeWeb(path, apiKey, signal)
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      failure = '缺少账单数据'
      break
    }
    const rows = data.records ?? []
    if (!Array.isArray(rows) || rows.some((row) => !row || typeof row !== 'object' || Array.isArray(row))) {
      failure = '账单条目不是有效列表'
      break
    }
    const pageKey = JSON.stringify(rows)
    if (seenPages.has(pageKey)) {
      failure = '分页返回了重复账单'
      break
    }
    seenPages.add(pageKey)
    const days = rows.map((row) => {
      const created = row.gmt_created
      const dateOnly = typeof created === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(created)
      const time = timestamp(dateOnly ? created + ' 00:00:00' : created)
      return Number.isFinite(time) ? utc8DateString(time) : ''
    })
    if (days.includes('')) {
      failure = '账单日期格式无法识别'
      break
    }
    for (let index = 0; index < rows.length; index++) {
      if (days[index] >= since && days[index] <= until && rows[index].type === 'EARN') grants.push(rows[index])
    }
    readCount += rows.length
    if (days.some((day) => day < since)) return grants
    const total = data?.total == null ? NaN : Number(data.total)
    if (Number.isSafeInteger(total) && total >= 0 && readCount >= total) return grants
    if (rows.length < PAGE_SIZE && !Number.isFinite(total)) return grants
    if (rows.length === 0) {
      failure = '账单总数与记录数不符'
      break
    }
  }
  throw new Error('魔粒发放记录读取不完整（' + failure + '）')
}

export async function modelscopeDailyGrantExpiry(apiKey: string, now = Date.now()): Promise<number | undefined> {
  const yesterday = utc8DateString(now - 86_400_000)
  const grants = await readGrants(apiKey, yesterday, AbortSignal.timeout(5_000))
  const expiries = grants
    .filter((row) => typeof row.rule_key === 'string' && DAILY_RULES.has(row.rule_key))
    .map((row) => timestamp(row.expire_at))
    .filter((at) => at > now)
  return expiries.length > 0 ? Math.min(...expiries) : undefined
}

function dailyAmount(grants: readonly MagicubeTransaction[]): number {
  let sum = 0
  for (const grant of grants) {
    if (typeof grant.rule_key !== 'string' || !DAILY_RULES.has(grant.rule_key)) continue
    const raw = grant.total_amount
    const amount = typeof raw === 'number' || (typeof raw === 'string' && raw.trim() !== '') ? Number(raw) : NaN
    /**
     * ⚠⚠ **负数必须当错误（PR #83 对抗审计 P2-1）。**
     *
     * 原判据只挡「非有限」与「绝对值超界」，没挡负数：
     * `claim()` 用 `after - before` 算当天领取额 ⇒ before 里一条
     * `total_amount: -500` 会让领取额**虚报成 700**（实测 C21/P8）。
     * 发放额不可能为负，看到负数只能是上游异常 ⇒ 直接报错。
     */
    if (!Number.isFinite(amount) || amount < 0 || Math.abs(amount) > Number.MAX_SAFE_INTEGER) {
      throw new Error('魔粒发放记录缺少有效金额')
    }
    sum += amount
  }
  return roundCredits(sum)
}

async function claim(apiKey: string): Promise<ClaimOutcome> {
  try {
    const signal = AbortSignal.timeout(15_000)
    const day = utc8DateString()
    const before = await readGrants(apiKey, day, signal)
    if (utc8DateString() !== day) throw new Error('魔搭已跨日，稍后重试')
    const beforeAmount = dailyAmount(before)
    if (before.some((row) => row.rule_key === 'daily_active') && beforeAmount > 0) {
      return { kind: 'already-claimed', message: '今日登录赠送的魔粒已到账' }
    }

    await readModelscopeWeb('/api/v1/users/login/info', apiKey, signal)
    const after = await readGrants(apiKey, day, signal)
    if (utc8DateString() !== day) throw new Error('魔搭已跨日，稍后重查发放记录')
    const credit = roundCredits(dailyAmount(after) - beforeAmount)
    if (credit > 0) return { kind: 'claimed', credit, streakDays: 0, isStreakDay: false }
    /**
     * ⚠️⚠️ **未识别的规则必须点名**：`DAILY_RULES` 是写死的 `rule_key` 白名单，
     * 上游一旦改名（或新增一档真实日奖励），`dailyAmount()` 就**一点都算不进去**，
     * 用户会看到「发放记录暂未新增魔粒」而**实际已经到账** —— 这是本仓库记录过的
     * 「静态表必然腐坏」形态，且**静默**（既没有日志也没有报错）。
     *
     * 这里把「新增的、不在白名单里的 EARN 规则名」点名出来。运维看到规则名就能
     * 立刻判断要不要补 `DAILY_RULES`，而不是对着「暂未新增魔粒」猜。
     *
     * ⚠️ 只取前 3 个（上游可能一次塞很多条），且 `rule_key` 是**上游数据** ——
     * 这条 message 在 `try` 内直接 `return`，**不经过** `catch` 的白名单过滤，
     * 所以以「魔搭」开头既符合白名单惯例、也不会把上游原文糊给用户。
     */
    const unrecognized = [...new Set(
      after
        .filter((row) => row.type === 'EARN' && typeof row.rule_key === 'string' && !DAILY_RULES.has(row.rule_key))
        .map((row) => row.rule_key as string),
    )].filter((key) => RULE_KEY_PATTERN.test(key))
    return {
      kind: 'inactive',
      coversToday: false,
      message: unrecognized.length === 0
        ? '登录请求成功，发放记录暂未新增魔粒'
        : `魔搭发放记录里出现了未登记的规则（${unrecognized.slice(0, 3).join('、')}`
          + `${unrecognized.length > 3 ? ` 等 ${unrecognized.length} 条` : ''}），`
          + '魔粒可能已到账但本插件不识别；请把这段规则名反馈给维护者',
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : ''
    // 网络错误或响应体可能带上游请求细节，只展示本模块定义的提示。
    /**
     * ⚠⚠ **`redirect: 'error'` 会把 302 登录跳转变成一个本地 `TypeError`（PR #83 对抗审计 P2-2）。**
     *
     * 它的 `message` 是 `unexpected redirect`（undici），原来落进兜底分支 ⇒
     * 「魔搭请求超时或网络异常」—— 用户会去查网络，
     * 而真因是**上游把接口重定向到了登录页**（登录态失效）。
     */
    const message = /^(没有可用的魔搭访问令牌|魔搭|魔粒)/.test(reason)
      ? reason
      : /redirect|Failed to fetch|fetch failed|network|TypeError/i.test(reason)
        ? '魔搭把请求重定向到了登录页 —— 登录态已失效，请重新粘贴访问令牌'
        : '魔搭请求超时或网络异常'
    return { kind: 'failed', code: -1, message }
  }
}

const activeClaims = new Map<string, Promise<ClaimOutcome>>()

export async function claimModelscopeDaily(credential: ModelscopeCredential): Promise<ClaimOutcome> {
  const apiKey = credential?.access_token
  if (!apiKey) return { kind: 'failed', code: -1, message: '没有可用的魔搭访问令牌' }
  const active = activeClaims.get(apiKey)
  if (active) return active
  const pending = claim(apiKey).finally(() => activeClaims.delete(apiKey))
  activeClaims.set(apiKey, pending)
  return pending
}
