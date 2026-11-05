/**
 * 智谱清言（chatglm.cn 网页端）积分余额、每日签到与续期原语。
 *
 * ## 实测协议（2026-11-04，逆向 + 消融矩阵；**真凭据路径未走过**，如实登记）
 *
 * | 用途 | 端点 | 判据 |
 * |---|---|---|
 * | 余额 | `GET /chatglm/user-api/user/info` | `result.member_info.left_score`（**字符串**） |
 * | 签到 | `POST /chatglm/member-api/member/daily_login_score` | `result.score`：`>0` = 本次领到；`0` = 今天已领（幂等） |
 * | 流水 | `GET /chatglm/member-api/member/score_record` | `page` / `page_size` / `record_type` |
 * | 续期 | `POST /chatglm/user-api/user/refresh` | `result.access_token` / `result.refresh_token` |
 *
 * ⚠️⚠️ **签到判据是 `result.score`，不是 `status`**：实测未登录时回
 * `status:40003`（bad request）、假 token 回 `status:40102`（unauthorized user），
 * 而**成功与「今天已领」都是 `status:0`** —— 只判 `status===0` 会把「已领」
 * 与「真领到」混为一谈（也就无法给出「今天已领」这句正确文案）。
 *
 * ⚠️ 官方客户端的写法（`main.28af679a.js` 的 `e0()`）：先把当天日期写进
 * `localStorage['daily-login-score:<uid>']` 做本地去重，再发请求，`score>0`
 * 才弹 `+N` 的 toast，并且**本地把 `left_score` 加上 N**。
 * ⇒ 官方把 `score===0` 当「今天已领」，这是**上游语义**，不是客户端偷懒。
 *
 * @module src/chatglm-credits.ts
 */

import type { ClaimOutcome, CreditBalance } from './credits.js'
import { CHATGLM_PATHS, chatglmDeviceIdOf, chatglmPost, type ChatglmCredential } from './chatglm.js'

/** `user/info` 的 `result` 形状（只取用得到的字段）。 */
interface ChatglmUserInfo {
  _id?: string
  username?: string
  nickname?: string
  is_guest?: boolean
  member_info?: {
    left_score?: string | number
    is_member?: boolean
    member_level?: number
  }
}

/** `daily_login_score` 的 `result` 形状。 */
interface ChatglmDailyLoginScore {
  score?: number | string
}

/** `user/refresh` 的 `result` 形状。 */
interface ChatglmRefreshResult {
  access_token?: string
  refresh_token?: string
  accessToken?: string
  refreshToken?: string
}

/** 把「字符串或数字」读成数字；读不到回 `undefined`（**不落 0**）。 */
function readNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

/**
 * 拉取智谱清言积分余额（`fetchBalanceDetailed` 形态：失败自带可读原因）。
 *
 * ⚠️ **读不到余额时回 `null` + 原因，绝不写 0**：0 在本仓库是「已用光」的语义，
 * 而「凭据失效」与「上游改版」都不是 0。
 */
export async function fetchChatglmBalanceDetailed(
  credential: ChatglmCredential,
  options: { accountKey?: string } = {},
): Promise<{ balance: CreditBalance | null; error?: string }> {
  if (typeof credential.chatglm_token !== 'string' || credential.chatglm_token.length === 0) {
    return { balance: null, error: '没有可用的智谱清言登录态（请先登录）' }
  }
  const wire = await chatglmPost<ChatglmUserInfo>(CHATGLM_PATHS.userInfo, {
    token: credential.chatglm_token,
    deviceId: chatglmDeviceIdOf(credential, options.accountKey),
  })
  if (!wire.ok) {
    // ⚠️ `40102` = token 无效（唯一出路是续期或重登）；其余按「上游异常」。
    if (wire.status === 40102) {
      return { balance: null, error: '智谱清言登录态已失效（token 无效），请续期或重新登录' }
    }
    return { balance: null, error: `查询智谱清言积分失败：${wire.error ?? '未知原因'}` }
  }
  const left = readNumber(wire.result?.member_info?.left_score)
  if (left === undefined) {
    return { balance: null, error: '响应里没有 member_info.left_score（上游形状可能已改版）' }
  }
  // ⚠️ 智谱清言**没有积分批次/到期**概念（`left_score` 是单一可变数）⇒ 合成
  //    一个「无到期」包让 `total` 与包内剩余自洽（`creditPackages: false` 时
  //    UI 不列包，故这个包只为口径自洽而存在，不是编造的到期信息）。
  return {
    balance: {
      total: left,
      expiredTotal: 0,
      packages: [
        {
          name: '智谱清言积分',
          unit: 'credit',
          remaining: left,
          total: left,
          used: 0,
          active: true,
          cycleStartTime: '',
          cycleEndTime: '',
          // ⚠️ 上游**不下发**到期时间 ⇒ 空串（不是编造一个日期）。
          expiredTime: '',
        },
      ],
    },
  }
}

/**
 * 执行智谱清言每日签到（`daily_login_score`）。
 *
 * ## 判定（实测信封语义）
 *
 * | `result.score` | 含义 | 返回 |
 * |---|---|---|
 * | `> 0` | **本次真的领到** N 积分 | `claimed`（带 `credit`） |
 * | `0` | 今天已经领过（官方同判据） | `already-claimed` |
 * | 缺字段 | 上游形状变了 | `failed`（不猜） |
 *
 * ⚠️ 上游**不返回**积分单位以外的任何东西（没有 `continuous_days`）⇒
 * `streakDays` 如实回 0（本仓库纪律：上游不下发的不编造）。
 */
export async function claimChatglmDailyCheckin(
  credential: ChatglmCredential,
  options: { accountKey?: string } = {},
): Promise<ClaimOutcome> {
  if (typeof credential.chatglm_token !== 'string' || credential.chatglm_token.length === 0) {
    return { kind: 'inactive', message: '没有可用的智谱清言登录态（请先登录）' }
  }
  const wire = await chatglmPost<ChatglmDailyLoginScore>(CHATGLM_PATHS.dailyLoginScore, {
    method: 'POST',
    body: {},
    token: credential.chatglm_token,
    deviceId: chatglmDeviceIdOf(credential, options.accountKey),
  })
  if (!wire.ok) {
    if (wire.status === 40102) {
      return { kind: 'failed', code: 40102, message: '智谱清言登录态已失效（token 无效），请续期或重新登录' }
    }
    if (wire.status === 40003) {
      // ⚠️ 40003 是「请求被前置拒绝」。实测唯一能触发它的是「什么头都不带」——
      //    而本模块**总是**带全套头与真签名 ⇒ 走到这里说明上游闸门收紧了。
      //    文案必须指向「上游改版」而不是「你没登录」，否则用户会白重登。
      return { kind: 'failed', code: 40003, message: '智谱清言拒绝了签到请求（40003）——上游可能收紧了请求头闸门，请反馈' }
    }
    return { kind: 'failed', code: -1, message: `智谱清言签到失败：${wire.error ?? '未知原因'}` }
  }
  const score = readNumber(wire.result?.score)
  if (score === undefined) {
    return { kind: 'failed', code: -1, message: '签到响应缺 result.score（上游形状可能已改版）' }
  }
  if (score > 0) {
    return {
      kind: 'claimed',
      credit: score,
      streakDays: 0,
      isStreakDay: false,
      unit: 'credit',
    }
  }
  return { kind: 'already-claimed', message: '今天已领取登录积分' }
}

/**
 * 续期（`POST /user-api/user/refresh`，Bearer = **refresh token**）。
 *
 * ⚠️ 与 `zcode` / `autoclaw` 的单向门同型纪律：**服务端可能轮换 refresh token**，
 * 调用方拿到 `refresh_token` 后必须落盘，否则下次续期会拿旧值（被拒）而账号被标死。
 * 本函数只负责发请求与解析，落盘由调用方（RPC 层）做。
 *
 * @returns 成功时 `{ access_token, refresh_token? }`；失败时带可读原因。
 */
export async function refreshChatglmToken(
  credential: ChatglmCredential,
  options: { accountKey?: string } = {},
): Promise<{ ok: true; accessToken: string; refreshToken?: string } | { ok: false; error: string; status?: number }> {
  const refreshToken = credential.chatglm_refresh_token
  if (typeof refreshToken !== 'string' || refreshToken.length === 0) {
    return { ok: false, error: '没有 refresh token（请重新登录）' }
  }
  const wire = await chatglmPost<ChatglmRefreshResult>(CHATGLM_PATHS.refresh, {
    method: 'POST',
    body: {},
    // ⚠️ 续期端点的 Bearer 用的是 **refresh token**（官方 `j()` 里 `Authorization: ggf()`）。
    token: refreshToken,
    deviceId: chatglmDeviceIdOf(credential, options.accountKey),
  })
  if (!wire.ok) {
    return { ok: false, error: wire.error ?? '续期失败', status: wire.status }
  }
  const accessToken = wire.result?.access_token ?? wire.result?.accessToken
  if (typeof accessToken !== 'string' || accessToken.length === 0) {
    return { ok: false, error: '续期响应缺 result.access_token' }
  }
  const rotated = wire.result?.refresh_token ?? wire.result?.refreshToken
  return {
    ok: true,
    accessToken,
    ...typeof rotated === 'string' && rotated.length > 0 ? { refreshToken: rotated } : {},
  }
}

/**
 * 读「今天是否已经领过」的**上游**判据（只读，用于面板展示）。
 *
 * ⚠️ 这里**刻意不调 `daily_login_score`** —— 那是**写操作**，重复发会真的触发
 * 上游逻辑（虽然幂等）。状态只在**上一次领取结果**里可得，故本函数返回
 * `undefined` 表示「需要在 claim 后才更新」，由 RPC 层缓存。
 */
export function chatglmCheckinHasStatusEndpoint(): boolean {
  // 上游**没有**独立的「今天是否已签」端点（`score_activity_*` 是消费抽券活动，
  // `summer_day_claim_status` 是暑期赠分，都不是每日登录积分）。
  // ⇒ 登记 `false`，让 credits 骨架走 `precheckStatus: false`（不去打不存在的端点）。
  return false
}
