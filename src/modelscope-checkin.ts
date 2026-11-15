import { utc8DateString } from './auto-checkin.js'
import { roundCredits, type ClaimOutcome } from './credits.js'
import type { ModelscopeCredential } from './modelscope.js'

const MODELSCOPE_SITE = 'https://www.modelscope.cn'
const PAGE_SIZE = 50
const MAX_PAGES = 4
const DAILY_RULES = new Set(['daily_active', 'aliyun_bindlogin'])

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
      accept: 'application/json',
      cookie: 'm_session_id=' + apiKey,
      referer: MODELSCOPE_SITE + '/',
      'user-agent': 'Mozilla/5.0 Chrome/140.0.0.0 Safari/537.36',
    },
    signal,
  })
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
      if (days[index] >= since && rows[index].type === 'EARN') grants.push(rows[index])
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
    if (!Number.isFinite(amount) || Math.abs(amount) > Number.MAX_SAFE_INTEGER) {
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
    return { kind: 'inactive', coversToday: false, message: '登录请求成功，发放记录暂未新增魔粒' }
  } catch (error) {
    const reason = error instanceof Error ? error.message : ''
    // 网络错误或响应体可能带上游请求细节，只展示本模块定义的提示。
    const message = /^(没有可用的魔搭访问令牌|魔搭|魔粒)/.test(reason) ? reason : '魔搭请求超时或网络异常'
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
