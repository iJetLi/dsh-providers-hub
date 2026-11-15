import { describe, expect, it, vi } from 'vitest'

import { claimDailyCheckin } from '../../src/credits.js'
import { CODEBUDDY, WORKBUDDY } from '../../src/product.js'
import type { BuddyCredential } from '../../src/buddy.js'

/**
 * 「今天已经领过了」的文案兜底（PR #87 对抗审计 P0-1）。
 *
 * ## 为什么这个文件必须存在
 *
 * 原判据是 `/已签|已领|already/i`（**子串**），而它被放在「已登记码判定」之后、
 * `failed` 之前 ⇒ 吃掉**所有未登记的失败码**。上游的失败报文里大量出现
 * 「已签」两个字，但语义完全不同：
 *
 * | 上游失败报文 | 真实语义 | 宽口径判定 | 应为 |
 * |---|---|---|---|
 * | `今日已签到记录写入失败` | **写入失败** | already-claimed（假成功） | `failed` |
 * | `当前账号已签出，请重新登录` | **认证失效** | already-claimed | `failed` |
 * | `请求非法，已签名校验不通过` | 签名校验 | already-claimed | `failed` |
 * | `already expired` / `already ended` | 活动已结束 | already-claimed | `failed` |
 *
 * 后果不是「少领一次」，而是 `already-claimed` **计 `coversToday`**
 * （`auto-checkin.ts` 只认 `claimed + alreadyClaimed`）⇒ 该渠道当天被记为
 * 「已处理」、下一个时段不再重试 ⇒ **静默丢一整天**，并且汇总里告诉用户
 * 「已领到」。
 *
 * ⚠️ 修复前后的守卫数量：修复前**零条**（14 条变异里 M4「删掉整段兜底」全绿）。
 * 本文件每一条都必须在**修复前**失败、修复后通过 —— 否则它只是同义反复。
 */

function makeCredential(): BuddyCredential {
  return {
    access_token: 'AT',
    refresh_token: 'RT',
    expires_at: String(Date.now() + 3_600_000),
    token_type: 'Bearer',
    scope: '',
    domain: 'www.workbuddy.ai',
    user_id: 'uid-1',
  }
}

/** 让领取端点回一份指定报文（HTTP 状态码刻意给 400/500 —— `postJson` 不看它）。 */
function stubCheckin(code: number | string, msg: string, status = 400): typeof fetch {
  return vi.fn(async () => new Response(
    JSON.stringify({ code, msg }),
    { status, headers: { 'content-type': 'application/json' } },
  )) as unknown as typeof fetch
}

describe('claimDailyCheckin 的文案兜底（P0-1 对立面）', () => {
  /**
   * ★★★ **失败报文绝不能被判成「已签到」**。
   *
   * 每条都带一个**未登记**的业务码（`500` / `11140` / `11128` / `-1` / `409`），
   * 于是必然走到文案腿。宽口径正则会把这 13 条**全部**判成 `already-claimed`，
   * 而它们**没有一条**表示「今天已经领过了」。
   */
  it.each([
    ['写入失败', 500, '今日已签到记录写入失败'],
    ['风控限制', 11140, '账号已被限制，今日已签到次数异常'],
    ['签名校验', 11128, '请求非法，已签名校验不通过'],
    ['渠道下线', 11128, 'unapproved channel, already logged out'],
    ['认证失效（已签出）', -1, '当前账号已签出，请重新登录'],
    ['认证失效（已签退）', 11102, 'service info not found, 已签退'],
    ['活动已结束（英文）', 409, 'already ended'],
    ['已过期（英文）', 400, 'already expired'],
    ['另一台设备领过（英文）', -1, 'already claimed today by another device'],
    ['名额已满', 500, '领取名额已签满，请稍后再试'],
    ['人数上限', 500, '活动已领取人数达到上限'],
    ['协议更新', 400, '已签署的用户协议有更新，请重新同意'],
    ['设备验证', 400, '当前设备已签约，换设备需验证'],
  ] as const)('★ %s（code=%s）必须归 failed，不能是 already-claimed', async (_label, code, msg) => {
    const outcome = await claimDailyCheckin(makeCredential(), WORKBUDDY, stubCheckin(code, msg))
    expect(
      outcome.kind,
      `「${msg}」不是「今天已经领过了」—— 判成 already-claimed 会让该渠道当天不再重试`,
    ).toBe('failed')
  })

  /**
   * ★★ **真幂等句仍然要认**。
   *
   * 这四条是「今天确实已经领过了」的整句形态（上游未登记码 + 精确文案）。
   * 修复**不能**把功能一起删掉 —— 否则自动签到会把已领到的账号报成失败、
   * 一天里反复打上游。
   */
  it.each([
    ['今天已签到'],
    ['今日已签到'],
    ['已签到'],
    ['已经签到过了'],
    ['今天已领取'],
    ['already claimed'],
    ['Already checked in today'],
  ])('★★ 真幂等句「%s」必须归 already-claimed', async (msg) => {
    const outcome = await claimDailyCheckin(makeCredential(), WORKBUDDY, stubCheckin(500, msg))
    expect(outcome.kind).toBe('already-claimed')
  })

  /**
   * ★★ **必须是整句锚定，不能是子串**。
   *
   * `已签到` 出现在句子中间时（前后还有别的语义）一律不认 —— 那是本缺陷的
   * 根本形态。这一条同时锁住「有人把 `^…$` 改回 `.test()` 子串」。
   */
  it.each([
    '今日已签到，但积分发放失败',
    '请先已签到再抽奖',
    '昨日已签到',
    '已签到的用户不再享有首签奖励',
  ])('★★ 子串形态「%s」不得归 already-claimed', async (msg) => {
    const outcome = await claimDailyCheckin(makeCredential(), WORKBUDDY, stubCheckin(500, msg))
    expect(outcome.kind).toBe('failed')
  })

  /**
   * 已登记码**优先于**文案腿 —— 文案再怎么像也抢不走已登记码的语义。
   *
   * （`10001` / `1001` ⇒ already-claimed、`1002` / `1003` / `41000` / `40901`
   * ⇒ inactive。若有人把文案腿挪到码表**之前**，这几条会全变成
   * already-claimed 或 failed。）
   */
  it.each([
    [10001, 'already-claimed'],
    [1001, 'already-claimed'],
    [1002, 'inactive'],
    [1003, 'inactive'],
    [41000, 'inactive'],
    [40901, 'inactive'],
  ] as const)('已登记码 %s 的语义不被文案腿改写', async (code, expected) => {
    // 文案刻意写成一个「未登记失败」的形态，验证码表优先。
    const outcome = await claimDailyCheckin(makeCredential(), CODEBUDDY, stubCheckin(code, '服务器内部错误'))
    expect(outcome.kind).toBe(expected)
  })

  /**
   * ★★ **字符串业务码必须归一**（P2-2）。
   *
   * 上游有时把码下发成 `"41000"` / `"0"`。只认 `typeof === 'number'` 会让
   * 新登记的 `41000` / `40901` **全部失效**（落到 `-1` ⇒ failed ⇒ 一天里反复
   * 重试），也会把成功的 `"0"` 判成失败。
   */
  it.each([
    ['41000', 'inactive'],
    ['40901', 'inactive'],
    ['10001', 'already-claimed'],
    ['1001', 'already-claimed'],
  ] as const)('★ 字符串业务码 "%s" 必须归一后再判定（%s）', async (code, expected) => {
    const outcome = await claimDailyCheckin(makeCredential(), WORKBUDDY, stubCheckin(code, ''))
    expect(outcome.kind).toBe(expected)
  })

  it('★ 字符串 "0" 必须判成 claimed（不能假失败）', async () => {
    const fetcher = vi.fn(async () => new Response(
      JSON.stringify({ code: '0', msg: 'OK', data: { credit: 100, streak_days: 1, is_streak_day: false } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as unknown as typeof fetch
    const outcome = await claimDailyCheckin(makeCredential(), WORKBUDDY, fetcher)
    expect(outcome).toEqual({ kind: 'claimed', credit: 100, streakDays: 1, isStreakDay: false })
  })

  it('非数值业务码仍是 failed（不能误判成成功）', async () => {
    const outcome = await claimDailyCheckin(makeCredential(), WORKBUDDY, stubCheckin('not-a-code', '???'))
    expect(outcome.kind).toBe('failed')
  })

  it('空 msg + 非 0 code ⇒ failed（空串不匹配任何整句）', async () => {
    const outcome = await claimDailyCheckin(makeCredential(), WORKBUDDY, stubCheckin(500, ''))
    expect(outcome.kind).toBe('failed')
  })
})
