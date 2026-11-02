/**
 * astudio-login-credits.spec.ts —— AStudio 每日签到与微信扫码登录凭据兑换单测
 */
import { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { describe, expect, it, vi } from 'vitest'
import {
  claimAstudioDailyReward,
  claimDaily,
  claimAstudioNewUserGift,
  extractAstudioDailyRewardPopup,
  extractAstudioNewUserPopup,
  extractAstudioClaimablePopups,
  parseAstudioPopupPoints,
  ASTUDIO_POPUP_TYPE_DAILY_REWARD,
  ASTUDIO_POPUP_TYPE_NEW_USER,
} from '../../src/astudio-credits.js'
import {
  AstudioAuth,
  type AstudioCredentialStore,
} from '../../src/astudio-auth.js'
import {
  createAstudioWechatQrCode,
  pollAstudioWechatScan,
  bindAstudioWechatSession,
  completeAstudioLogin,
  generateAstudioWechatFd,
  ASTUDIO_WECHAT_FD_ALPHABET,
  type AstudioWechatAccount,
  getAstudioGeeTestConfig,
  sendAstudioSmsCode,
  loginAstudioWithSms,
  loginAstudioWithPassword,
  renderAstudioLoginPage,
  startAstudioLoginFlow,
  ASTUDIO_CARRIER_PATHS,
  type AstudioGeeTestResult,
  type AstudioLoginIdentity,
} from '../../src/astudio-oauth.js'
import { ASTUDIO } from '../../src/astudio-product.js'
import type { AstudioCredential } from '../../src/astudio.js'
import { createProviderCredits } from '../../src/provider-credits.js'
import { registerJetHubRpc, JET_HUB_API_PATH, type JetHubAuths } from '../../src/jet-hub-rpc.js'
import { AccountPool } from '../../src/account-pool.js'

describe('AStudio 每日签到（Credits & Claim）', () => {
  describe('parseAstudioPopupPoints', () => {
    it('支持数值型积分', () => {
      expect(parseAstudioPopupPoints(100)).toBe(100)
      expect(parseAstudioPopupPoints(0)).toBe(0)
      expect(parseAstudioPopupPoints(12.8)).toBe(12)
    })

    it('支持字符串型积分', () => {
      expect(parseAstudioPopupPoints('100')).toBe(100)
      expect(parseAstudioPopupPoints(' 50 ')).toBe(50)
      expect(parseAstudioPopupPoints('0')).toBe(0)
    })

    it('支持包含 points 或 credit 键的对象', () => {
      expect(parseAstudioPopupPoints({ points: 200 })).toBe(200)
      expect(parseAstudioPopupPoints({ points: '150' })).toBe(150)
      expect(parseAstudioPopupPoints({ credit: 88 })).toBe(88)
    })

    it('非法或负数安全回退为 0', () => {
      expect(parseAstudioPopupPoints(undefined)).toBe(0)
      expect(parseAstudioPopupPoints(null)).toBe(0)
      expect(parseAstudioPopupPoints(-10)).toBe(0)
      expect(parseAstudioPopupPoints('abc')).toBe(0)
    })
  })

  describe('extractAstudioDailyRewardPopup', () => {
    it('正确识别 DAILY_REWARD_DIALOG 弹窗并提取字段', () => {
      const list = [
        { type: 'NEW_USER_DIALOG', popupId: 101 },
        {
          type: ASTUDIO_POPUP_TYPE_DAILY_REWARD,
          popupId: 202,
          instanceKey: 'key-202',
          payload: { points: '100' },
        },
      ]
      const popup = extractAstudioDailyRewardPopup(list)
      expect(popup).toBeDefined()
      expect(popup?.popupId).toBe(202)
      expect(popup?.instanceKey).toBe('key-202')
      expect(popup?.type).toBe(ASTUDIO_POPUP_TYPE_DAILY_REWARD)
      expect(popup?.payload?.points).toBe('100')
    })

    it('非数组或无目标弹窗时返回 undefined', () => {
      expect(extractAstudioDailyRewardPopup(null)).toBeUndefined()
      expect(extractAstudioDailyRewardPopup([])).toBeUndefined()
      expect(extractAstudioDailyRewardPopup([{ type: 'OTHER_DIALOG', popupId: 1 }])).toBeUndefined()
    })
  })

  describe('extractAstudioNewUserPopup & extractAstudioClaimablePopups (Goal 829)', () => {
    it('从列表中正确识别 NEW_USER_DIALOG 弹窗', () => {
      const popup = extractAstudioNewUserPopup([
        { type: 'SOME_PROMO', popupId: 10 },
        { type: ASTUDIO_POPUP_TYPE_NEW_USER, popupId: 99, instanceKey: 'inst-new' },
      ])
      expect(popup).toBeDefined()
      expect(popup?.popupId).toBe(99)
      expect(popup?.instanceKey).toBe('inst-new')
    })

    it('extractAstudioClaimablePopups 同时提取每日签到与新用户弹窗，并支持去重', () => {
      const list = [
        { type: ASTUDIO_POPUP_TYPE_DAILY_REWARD, popupId: 1, instanceKey: 'd1' },
        { type: 'IRRELEVANT', popupId: 2, instanceKey: 'i1' },
        { type: ASTUDIO_POPUP_TYPE_NEW_USER, popupId: 3, instanceKey: 'u1' },
        { type: ASTUDIO_POPUP_TYPE_DAILY_REWARD, popupId: 1, instanceKey: 'd1' }, // 重复
      ]
      const claimable = extractAstudioClaimablePopups(list)
      expect(claimable).toHaveLength(2)
      expect(claimable.map((p) => p.popupId)).toEqual([1, 3])
    })
  })

  describe('claimAstudioDailyReward / claimDaily', () => {
    const validCred: AstudioCredential = {
      access_token: 'fake-token',
      sso_session_id: 'sso-12345',
      account_id: '17400000000',
    }

    it('别名一致性：claimDaily 指向 claimAstudioDailyReward', () => {
      expect(claimDaily).toBe(claimAstudioDailyReward)
    })

    it('凭据无 Cookie 时直接返回 80000 终态鉴权失败', async () => {
      const outcome = await claimAstudioDailyReward({ access_token: 'foo' })
      expect(outcome.kind).toBe('failed')
      if (outcome.kind === 'failed') {
        expect(outcome.code).toBe(80000)
        expect(outcome.message).toContain('未登录')
      }
    })

    it('pending 接口返回 code 80000 终态鉴权失败', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ code: 80000, desc: '登录异常，请重新登录' }),
      } as Response)

      const outcome = await claimAstudioDailyReward(validCred, { fetcher: mockFetch })
      expect(outcome.kind).toBe('failed')
      if (outcome.kind === 'failed') {
        expect(outcome.code).toBe(80000)
        expect(outcome.message).toContain('需在 AStudio 客户端人工重新登录')
      }
    })

    it('pending 返回空数组时返回 already-claimed', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ code: 0, flag: true, data: [] }),
      } as Response)

      const outcome = await claimAstudioDailyReward(validCred, { fetcher: mockFetch })
      expect(outcome.kind).toBe('already-claimed')
      if (outcome.kind === 'already-claimed') {
        expect(outcome.message).toContain('今天已领取')
      }
    })

    it('pending 返回非 DAILY_REWARD_DIALOG 弹窗时返回 already-claimed', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          code: 0,
          flag: true,
          data: [{ type: 'CLIENT_DOWNLOAD_REWARD_DIALOG', popupId: 999 }],
        }),
      } as Response)

      const outcome = await claimAstudioDailyReward(validCred, { fetcher: mockFetch })
      expect(outcome.kind).toBe('already-claimed')
    })

    it('pending 发现待领弹窗，complete 成功领取积分', async () => {
      const mockFetch = vi.fn()
        // 1. pending
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            code: 0,
            flag: true,
            data: [
              {
                type: ASTUDIO_POPUP_TYPE_DAILY_REWARD,
                popupId: 1234,
                instanceKey: 'inst-abc',
                payload: { points: '100' },
              },
            ],
          }),
        } as Response)
        // 2. complete
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            code: 0,
            flag: true,
            data: { points: 100 },
          }),
        } as Response)

      const outcome = await claimAstudioDailyReward(validCred, { fetcher: mockFetch })
      expect(outcome.kind).toBe('claimed')
      if (outcome.kind === 'claimed') {
        expect(outcome.credit).toBe(100)
        expect(outcome.unit).toBe('credit')
      }
      expect(mockFetch).toHaveBeenCalledTimes(2)
      const pendingCall = mockFetch.mock.calls[0]
      expect(pendingCall[0]).toContain('/client-popups/pending')
      expect(pendingCall[1].headers).toMatchObject({
        Accept: 'application/json',
        clientType: '21',
        studioVersion: '3.5.2',
      })

      const completeCall = mockFetch.mock.calls[1]
      expect(completeCall[0]).toContain('/client-popups/complete')
      expect(completeCall[1].headers).toMatchObject({
        'Content-Type': 'application/json',
        Accept: 'application/json',
        clientType: '21',
        studioVersion: '3.5.2',
      })
      expect(JSON.parse(completeCall[1].body)).toEqual({ popupId: 1234, instanceKey: 'inst-abc' })
    })

    it('官方 11001001 客户端平台/版本无效时正确向外传递 failed', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          code: 11001001,
          desc: '客户端平台、版本或构建号无效',
        }),
      } as Response)

      const outcome = await claimAstudioDailyReward(validCred, { fetcher: mockFetch })
      expect(outcome.kind).toBe('failed')
      if (outcome.kind === 'failed') {
        expect(outcome.code).toBe(11001001)
        expect(outcome.message).toContain('客户端平台、版本或构建号无效')
      }
      expect(mockFetch).toHaveBeenCalledTimes(1)
      const call = mockFetch.mock.calls[0]
      expect(call[1].headers).toMatchObject({
        clientType: '21',
        studioVersion: '3.5.2',
      })
    })

    it('支持通过 options.product 自定义 clientType 与 studioVersion', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ code: 0, flag: true, data: [] }),
      } as Response)

      const customProduct = {
        ...ASTUDIO,
        clientType: '99',
        studioVersion: '9.9.9',
      }
      await claimAstudioDailyReward(validCred, { fetcher: mockFetch, product: customProduct })
      expect(mockFetch).toHaveBeenCalledTimes(1)
      const call = mockFetch.mock.calls[0]
      expect(call[1].headers).toMatchObject({
        clientType: '99',
        studioVersion: '9.9.9',
      })
    })

    it('complete 失败时正确向外传递 failed', async () => {
      const mockFetch = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            code: 0,
            flag: true,
            data: [{ type: ASTUDIO_POPUP_TYPE_DAILY_REWARD, popupId: 555, instanceKey: 'k' }],
          }),
        } as Response)
        .mockResolvedValueOnce({
          ok: false,
          status: 500,
          text: async () => 'Internal Server Error',
        } as Response)

      const outcome = await claimAstudioDailyReward(validCred, { fetcher: mockFetch })
      expect(outcome.kind).toBe('failed')
      if (outcome.kind === 'failed') {
        expect(outcome.code).toBe(500)
      }
    })
  })

  describe('claimAstudioDailyReward 多礼包与 claimAstudioNewUserGift (Goal 829)', () => {
    const validCred: AstudioCredential = {
      access_token: 'fake-token',
      sso_session_id: 'sso-12345',
      account_id: '17400000000',
    }

    it('自动识别并领取所有可领礼包（同时包含每日签到与新用户礼包，累加积分）', async () => {
      const mockFetch = vi.fn()
        // 1. pending 查询返回 2 个弹窗
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            code: 0,
            flag: true,
            data: [
              {
                type: ASTUDIO_POPUP_TYPE_DAILY_REWARD,
                popupId: 101,
                instanceKey: 'inst-101',
                content: JSON.stringify({ rewardPoints: 100 }),
              },
              {
                type: ASTUDIO_POPUP_TYPE_NEW_USER,
                popupId: 102,
                instanceKey: 'inst-102',
                content: JSON.stringify({ rewardPoints: 200 }),
              },
            ],
          }),
        } as Response)
        // 2. complete 弹窗 101
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            code: 0,
            flag: true,
            data: { result: true },
          }),
        } as Response)
        // 3. complete 弹窗 102
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            code: 0,
            flag: true,
            data: { result: true },
          }),
        } as Response)

      const outcome = await claimAstudioDailyReward(validCred, { fetcher: mockFetch })
      expect(outcome.kind).toBe('claimed')
      if (outcome.kind === 'claimed') {
        expect(outcome.credit).toBe(300)
      }
      expect(mockFetch).toHaveBeenCalledTimes(3)
    })

    it('claimAstudioNewUserGift: 缺少 sso_session_id 时返回失败', async () => {
      const outcome = await claimAstudioNewUserGift({ access_token: 'foo' })
      expect(outcome.kind).toBe('failed')
    })

    it('claimAstudioNewUserGift: 成功识别并完成新用户礼包领取', async () => {
      const mockFetch = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            code: 0,
            flag: true,
            data: [
              {
                type: ASTUDIO_POPUP_TYPE_NEW_USER,
                popupId: 201,
                instanceKey: 'inst-new-201',
                content: JSON.stringify({ points: 500 }),
              },
            ],
          }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ code: 0, flag: true }),
        } as Response)

      const outcome = await claimAstudioNewUserGift(validCred, { fetcher: mockFetch })
      expect(outcome.kind).toBe('claimed')
      if (outcome.kind === 'claimed') {
        expect(outcome.credit).toBe(500)
      }
    })
  })
})

describe('AStudio 微信扫码登录与凭据交换（Wechat Scan & completeLogin）', () => {
  it('generateAstudioWechatFd 生成合法的 8 字符随机串', () => {
    const fd = generateAstudioWechatFd()
    expect(fd).toHaveLength(8)
    for (const ch of fd) {
      expect(ASTUDIO_WECHAT_FD_ALPHABET).toContain(ch)
    }
  })

  it('createAstudioWechatQrCode 成功返回二维码 URL 与 fd', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        code: 0,
        flag: true,
        data: 'https://mp.weixin.qq.com/cgi-bin/showqrcode?ticket=fake-ticket',
      }),
    } as Response)

    const qr = await createAstudioWechatQrCode({ fetcher: mockFetch, fd: 'testfd88' })
    expect(qr.fd).toBe('testfd88')
    expect(qr.qrUrl).toContain('showqrcode?ticket=fake-ticket')
    expect(qr.expiresInMs).toBe(300_000)
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/SSOService/wx/scanlogin/qrcode?fd=testfd88'),
      expect.anything(),
    )
  })

  it('pollAstudioWechatScan 未扫码时返回 pending', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        code: -1,
        desc: '未扫码',
      }),
    } as Response)

    const res = await pollAstudioWechatScan('testfd', { fetcher: mockFetch })
    expect(res.status).toBe('pending')
    if (res.status === 'pending') {
      expect(res.message).toBe('未扫码')
    }
  })

  it('pollAstudioWechatScan 扫码成功时返回 scanned 与账号列表', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        code: 0,
        data: [
          { uid: '17469144703', ssoSessionId: 'sso-val-123', username: 'TestUser' },
        ],
      }),
    } as Response)

    const res = await pollAstudioWechatScan('testfd', { fetcher: mockFetch })
    expect(res.status).toBe('scanned')
    if (res.status === 'scanned') {
      expect(res.account.uid).toBe('17469144703')
      expect(res.account.ssoSessionId).toBe('sso-val-123')
      expect(res.account.username).toBe('TestUser')
      expect(res.accounts).toHaveLength(1)
    }
  })

  it('bindAstudioWechatSession 发送表单完成会话绑定', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ code: 0, flag: true }),
    } as Response)

    const account: AstudioWechatAccount = {
      uid: '17469144703',
      ssoSessionId: 'sso-bind-token',
    }
    const bindRes = await bindAstudioWechatSession('fd123456', account, { fetcher: mockFetch })
    expect(bindRes.ok).toBe(true)
    const callArgs = mockFetch.mock.calls[0]
    expect(callArgs[0]).toContain('/SSOService/wx/scanlogin/bind')
    expect(callArgs[1].body).toContain('accountId=17469144703')
    expect(callArgs[1].body).toContain('ssoSessionId=sso-bind-token')
  })

  it('completeAstudioLogin 兑换完整凭据（init-app + userInfo + configs）', async () => {
    const mockFetch = vi.fn()
      // 1. init-app
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ code: 0 }),
      } as Response)
      // 2. userInfo
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          code: 0,
          data: { nickname: 'AstronDev', mobile: '17469144703' },
        }),
      } as Response)
      // 3. bot/models/configs
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          code: 0,
          data: [
            {
              model: 'xopglm52',
              api_key: 'model-bearer-token-12345',
              is_default: true,
            },
          ],
        }),
      } as Response)

    const account: AstudioWechatAccount = {
      uid: '17469144703',
      ssoSessionId: 'sso-exchange-token',
      username: 'InitUser',
    }

    const cred = await completeAstudioLogin(account, { fetcher: mockFetch })
    expect(cred.access_token).toBe('model-bearer-token-12345')
    expect(cred.account_id).toBe('17469144703')
    expect(cred.uid).toBe('17469144703')
    expect(cred.nickname).toBe('AstronDev')
    expect(cred.sso_session_id).toBe('sso-exchange-token')
    expect(cred.login_method).toBe('wechat')
    expect(cred.source).toBe('account-backend')
    expect(mockFetch).toHaveBeenCalledTimes(3)
  })

  it('completeAstudioLogin: 针对手机验证码/密码等非微信登录，同样无条件执行 init-app 租户初始化开户 (Goal 829)', async () => {
    const mockFetch = vi.fn()
      // 1. init-app (无条件开户初始化)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ code: 0, flag: true }),
      } as Response)
      // 2. bot/models/configs
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          code: 0,
          data: [{ model: 'xopglm52', api_key: 'sms-model-token', is_default: true }],
        }),
      } as Response)

    const smsIdentity: AstudioLoginIdentity = {
      sso_session_id: 'sms-sso-token',
      account_id: '17499999999',
      login_method: 'sms',
    }
    const cred = await completeAstudioLogin(smsIdentity, { fetcher: mockFetch })
    expect(cred.access_token).toBe('sms-model-token')
    expect(cred.account_id).toBe('17499999999')
    expect(cred.login_method).toBe('sms')
    // 验证调用了 2 次：init-app -> configs
    expect(mockFetch).toHaveBeenCalledTimes(2)
    const initAppCall = mockFetch.mock.calls[0]
    expect(initAppCall[0]).toContain('/tenant-app/v2/init-app')
    expect(initAppCall[1].headers).toMatchObject({
      Cookie: 'ssoSessionId=sms-sso-token; sso_sessionid=sms-sso-token; account_id=17499999999; token=sms-sso-token',
    })
  })

  it('completeAstudioLogin: init-app 即使遇到非 200/网络异常也安全降级，继续执行 configs 获取凭据', async () => {
    const mockFetch = vi.fn()
      // 1. init-app 网络或业务报错
      .mockRejectedValueOnce(new Error('Network timeout'))
      // 2. bot/models/configs 仍可继续
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          code: 0,
          data: [{ model: 'xopglm52', api_key: 'fallback-token', is_default: true }],
        }),
      } as Response)

    const account: AstudioLoginIdentity = {
      sso_session_id: 'degraded-sso',
      account_id: '17499999999',
      login_method: 'password',
    }
    const cred = await completeAstudioLogin(account, { fetcher: mockFetch })
    expect(cred.access_token).toBe('fallback-token')
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })

  it('AstudioAuth.completeLogin 集成兑换并写入凭据库', async () => {
    class FakeStore implements AstudioCredentialStore {
      readonly map = new Map<string, string>()
      async resolve(ref: unknown) {
        const key = typeof ref === 'object' && ref !== null && 'name' in ref ? String((ref as { name: unknown }).name) : String(ref)
        const val = this.map.get(key)
        return val !== undefined ? { value: val } : undefined
      }
      async set(ref: unknown, value: string) {
        const key = typeof ref === 'object' && ref !== null && 'name' in ref ? String((ref as { name: unknown }).name) : String(ref)
        this.map.set(key, value)
      }
      async unset(ref: unknown) {
        const key = typeof ref === 'object' && ref !== null && 'name' in ref ? String((ref as { name: unknown }).name) : String(ref)
        this.map.delete(key)
      }
    }
    const fakeStore = new FakeStore()

    const mockFetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => '{}' } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ code: 0, data: { nickname: 'AuthUser' } }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          code: 0,
          data: [{ model: 'xopglm52', api_key: 'stored-api-key', is_default: true }],
        }),
      } as Response)

    const ctx = new Context()
    const auth = new AstudioAuth(ctx, {
      store: fakeStore,
      fetcher: mockFetch,
      env: { DSH_ASTUDIO_SESSION_FILE: 'F:/project/ARTEX/data/tasks/4/not-exist.json' },
    })

    const account: AstudioWechatAccount = {
      uid: '17488888888',
      ssoSessionId: 'sso-session-store',
    }

    const saved = await auth.completeLogin(account)
    expect(saved.access_token).toBe('stored-api-key')
    expect(saved.uid).toBe('17488888888')

    // 验证写入凭据库
    const resolved = await fakeStore.resolve(credentialRef(ASTUDIO.defaultCredentialRef))
    const storedVal = resolved?.value
    expect(storedVal).toBeDefined()
    const parsed = JSON.parse(storedVal!)
    expect(parsed.access_token).toBe('stored-api-key')
  })
})

describe('AStudio Provider Credits & Jet Hub RPC 接线验证', () => {
  it('createProviderCredits 正确为 astudio 注册 claimDaily 与 balanceDetailed', async () => {
    const table = createProviderCredits()
    expect(table.astudio).toBeDefined()
    expect(typeof table.astudio?.fetchBalanceDetailed).toBe('function')
    expect(typeof table.astudio?.claim).toBe('function')
    expect(table.astudio?.precheckStatus).toBe(false)
  })

  function makeTestRpc(mockFetch: typeof fetch) {
    const credentialsMap = new Map<string, string>()
    let handler: ((req: Request) => Promise<Response>) | undefined

    const ctx = {
      get: (key: string) => key === 'connection'
        ? {
            fetch: {
              register: (config: { path: string; fetch: (req: Request) => Promise<Response> }) => {
                if (config.path === JET_HUB_API_PATH) handler = config.fetch
              },
            },
          }
        : undefined,
      inject: (_deps: string[], callback: (c: unknown) => void) => { callback(ctx) },
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
      credentials: {
        resolve: async (ref: unknown) => {
          const key = typeof ref === 'object' && ref !== null && 'name' in ref ? String((ref as { name: unknown }).name) : String(ref)
          const val = credentialsMap.get(key)
          return val !== undefined ? { value: val } : undefined
        },
        set: async (ref: unknown, value: string) => {
          const key = typeof ref === 'object' && ref !== null && 'name' in ref ? String((ref as { name: unknown }).name) : String(ref)
          credentialsMap.set(key, value)
        },
        unset: async (ref: unknown) => {
          const key = typeof ref === 'object' && ref !== null && 'name' in ref ? String((ref as { name: unknown }).name) : String(ref)
          credentialsMap.delete(key)
        },
      },
      connection: {
        fetch: {
          register: (config: { path: string; fetch: (req: Request) => Promise<Response> }) => {
            if (config.path === JET_HUB_API_PATH) handler = config.fetch
          },
        },
      },
    }

    const authCtx = new Context()
    const pool = new AccountPool(authCtx as never)

    const fakeStore = {
      resolve: ctx.credentials.resolve.bind(ctx.credentials),
      set: ctx.credentials.set.bind(ctx.credentials),
      unset: ctx.credentials.unset.bind(ctx.credentials),
    }
    const astudioAuth = new AstudioAuth(authCtx, {
      store: fakeStore,
      fetcher: mockFetch,
      env: { DSH_ASTUDIO_SESSION_FILE: 'F:/project/ARTEX/data/tasks/4/non-existent.json' },
    })

    const blank = () => ({} as never)
    const auths: JetHubAuths = {
      codearts: blank(),
      buddy: blank(),
      workbuddy: blank(),
      lobsterai: blank(),
      qoder: blank(),
      qodercn: blank(),
      trae: blank(),
      cline: blank(),
      loomy: blank(),
      raccoon: blank(),
      minimax: blank(),
      zcode: blank(),
      gemini: blank(),
      officeace: blank(),
      minimaxintl: blank(),
      accio: blank(),
      // ⚠️ 2026-10-17 合并上游后新增的两个键（autoclaw / modelscope）。
      //    本用例只验 astudio 那条链，故给空桩即可 —— 但**不能省**：
      //    `JetHubAuths` 是全字段必填的结构化类型，漏一个即 TS2739。
      autoclaw: blank(),
      // ⚠️ AutoClaw 国际版（PR121）新增的键：与 `autoclaw` 是**两个实例**，
      //    `JetHubAuths` 因此各占一个键 —— 漏掉同样报 TS2741。
      autoclawintl: blank(),
      modelscope: blank(),
      // ⚠️ **本 fork 独有**（七牛云，2026-10-29）：`JetHubAuths` 是全字段必填的
      //    结构化类型，漏一个即 TS2741 —— 本用例只验 astudio 那条链，故给空桩即可。
      qiniu: blank(),
      magicrew: blank(),
      // ⚠️ **MagiCrew 国际版**（2026-11-01）：与 `magicrew` 是两个实例、两个
      //    provider id，`JetHubAuths` 因此各占一个键 —— 漏掉同样报 TS2741。
      magicrewintl: blank(),
      // ⚠️ 2026-11-02 加 monkeycode（MonkeyCode）：`JetHubAuths` 每加一个
      //    provider，所有拿它做类型标注的替身都要补同名键，否则
      //    `pnpm typecheck:tests` 报 TS2741 而 vitest 照绿（类型层守卫的价值）。
      monkeycode: blank(),
      // ⚠️ 2026-11-02 拆站：国际站与百智云各自是独立 provider，都要有自己的 auth 键
      //    （`JetHubAuths` 是全量 Record，漏一个就编译失败 —— 这正是它该起的作用）。
      monkeycodeintl: blank(),
      baizhi: blank(),
      astudio: astudioAuth,
    }

    registerJetHubRpc(ctx as never, pool, auths)

    const callRpc = async (method: string, payload: unknown) => {
      if (!handler) throw new Error('endpoint handler was not registered')
      const req = new Request(`http://localhost${JET_HUB_API_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request',
          rpcId: 'rpc-test',
          method: 'jet-hub',
          payload: { method, payload },
        }),
      })
      const res = await handler(req)
      const body = await res.json() as { result: { ok: boolean; value?: any; error?: any } }
      return body.result
    }

    return { callRpc, pool, credentialsMap, astudioAuth }
  }

  it('account.create 在无本地会话或明确选 web 时启动 Carrier 载体页服务 (startAstudioLoginFlow)', async () => {
    const mockFetch = vi.fn()
    const { callRpc } = makeTestRpc(mockFetch)

    const createRes = await callRpc('account.create', { provider: 'astudio', astudioLoginMethod: 'web' })
    expect(createRes.ok).toBe(true)
    expect(createRes.value?.loginUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/astudio\/login$/)
    expect(createRes.value?.accountId).toMatch(/^astudio-/)

    // 访问 Carrier 载体页返回 200 并包含三合一登录元素
    const res = await fetch(createRes.value.loginUrl)
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('tab-sms')
    expect(html).toContain('tab-password')
    expect(html).toContain('tab-wechat')
  })

  it('Carrier 载体页完成登录后，凭据自动回填持久化并更新账号池', async () => {
    const mockFetch = vi.fn()
      // 1. sms login
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({
          'set-cookie': 'ssoSessionId=sso-carrier-val; Path=/',
        }),
        json: async () => ({
          code: 0,
          data: { uid: '17488888888', token: 'token-carrier', username: 'CarrierDev' },
        }),
        text: async () => JSON.stringify({
          code: 0,
          data: { uid: '17488888888', token: 'token-carrier', username: 'CarrierDev' },
        }),
      } as Response)
      // 2. tenant/init-app (无条件开户初始化 Goal 829)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ code: 0, flag: true }),
      } as Response)
      // 3. bot/models/configs (completeAstudioLogin)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          code: 0,
          data: [{ model: 'xopglm52', api_key: 'carrier-exchange-token', is_default: true }],
        }),
        text: async () => JSON.stringify({
          code: 0,
          data: [{ model: 'xopglm52', api_key: 'carrier-exchange-token', is_default: true }],
        }),
      } as Response)

    const { callRpc, pool } = makeTestRpc(mockFetch)

    const createRes = await callRpc('account.create', { provider: 'astudio' })
    const accountId = createRes.value.accountId
    const loginUrl = createRes.value.loginUrl

    const urlObj = new URL(loginUrl)
    const baseUrl = `http://127.0.0.1:${urlObj.port}`

    // 模拟用户在 Carrier 载体页完成短信登录
    const loginRes = await fetch(`${baseUrl}/astudio/sms/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mobile: '17488888888', verifyCode: '123456' }),
    })
    expect(loginRes.status).toBe(200)

    // 等待凭据回填落地
    await new Promise((resolve) => setTimeout(resolve, 80))

    // 前端轮询 account.exchange / login.poll，此时凭据已落库
    const pollRes = await callRpc('login.poll', { accountId })
    expect(pollRes.ok).toBe(true)
    expect(pollRes.value?.done).toBe(true)
    expect(pollRes.value?.success).toBe(true)

    // 账号池已更新对应昵称
    const accountEntry = await pool.findAccount(accountId)
    expect(accountEntry).toBeDefined()
    expect(accountEntry?.nickname).toBe('174******88')
  })

  it('account.create 在指定 local 登录但无本地会话时返回明确错误并清理占位账号', async () => {
    const mockFetch = vi.fn()
    const { callRpc, pool } = makeTestRpc(mockFetch)

    const beforeAccounts = await pool.listAccountsByProvider('astudio')
    const createRes = await callRpc('account.create', { provider: 'astudio', astudioLoginMethod: 'local' })
    expect(createRes.ok).toBe(false)
    expect(createRes.error?.message).toContain('导入本机 AStudio 会话失败')

    // 池中不应新增残留该账号
    const afterAccounts = await pool.listAccountsByProvider('astudio')
    expect(afterAccounts).toHaveLength(beforeAccounts.length)
  })
})

describe('AStudio 三合一登录体系 (Goal 755: 短信验证码 / 密码 / Carrier 载体页)', () => {
  const dummyGeeTestResult: AstudioGeeTestResult = {
    geetestChallenge: 'challenge-xyz',
    geetestValidate: 'validate-xyz',
    geetestSeccode: 'validate-xyz|jordan',
  }

  describe('极验初始化 (getAstudioGeeTestConfig)', () => {
    it('正常获取极验配置', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          code: 0,
          data: {
            gt: 'test-gt-key',
            challenge: 'test-challenge',
            success: 1,
            new_captcha: true,
          },
        }),
      } as Response)

      const cfg = await getAstudioGeeTestConfig({ fetcher: mockFetch })
      expect(cfg.gt).toBe('test-gt-key')
      expect(cfg.challenge).toBe('test-challenge')
      expect(cfg.success).toBe(1)
      expect(cfg.new_captcha).toBe(true)
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/chat/gee-captcha'),
        expect.anything(),
      )
    })

    it('服务端返回非 0 错误码时抛出异常', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          code: 50001,
          desc: '极验服务暂时不可用',
        }),
      } as Response)

      await expect(getAstudioGeeTestConfig({ fetcher: mockFetch })).rejects.toThrow('极验服务暂时不可用')
    })

    it('HTTP 状态异常时抛出错误', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 502,
      } as Response)

      await expect(getAstudioGeeTestConfig({ fetcher: mockFetch })).rejects.toThrow('HTTP 502')
    })
  })

  describe('短信验证码发送 (sendAstudioSmsCode)', () => {
    it('手机号为空时抛错', async () => {
      await expect(sendAstudioSmsCode('', dummyGeeTestResult)).rejects.toThrow('手机号不能为空')
    })

    it('未传极验验证结果时抛错', async () => {
      await expect(sendAstudioSmsCode('13800000000', {} as never)).rejects.toThrow('缺少极验验证参数')
    })

    it('正常发送验证码，正确构造表单并返回结果', async () => {
      let reqBody: FormData | undefined
      const mockFetch = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
        reqBody = init?.body as FormData
        return {
          ok: true,
          status: 200,
          json: async () => ({
            code: 0,
            desc: '验证码发送成功',
            data: { expire: 60 },
          }),
        } as Response
      })

      const res = await sendAstudioSmsCode('13800000000', dummyGeeTestResult, { fetcher: mockFetch })
      expect(res.ok).toBe(true)
      expect(res.message).toBe('验证码发送成功')
      expect(reqBody).toBeDefined()
      expect(reqBody?.get('mobile')).toBe('13800000000')
      expect(reqBody?.get('countryCode')).toBe('86')
      expect(reqBody?.get('geetest_challenge')).toBe('challenge-xyz')
      expect(reqBody?.get('geetest_validate')).toBe('validate-xyz')
      expect(reqBody?.get('geetest_seccode')).toBe(Buffer.from('validate-xyz|jordan').toString('base64'))
    })

    it('服务端返回错误提示时抛出异常', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          code: 10001,
          desc: '短信发送过于频繁，请稍后再试',
        }),
      } as Response)

      await expect(
        sendAstudioSmsCode('13800000000', dummyGeeTestResult, { fetcher: mockFetch }),
      ).rejects.toThrow('短信发送过于频繁，请稍后再试')
    })
  })

  describe('手机验证码登录 (loginAstudioWithSms)', () => {
    it('参数校验：空手机号或空验证码抛错', async () => {
      await expect(loginAstudioWithSms('', '123456')).rejects.toThrow('手机号和验证码不能为空')
      await expect(loginAstudioWithSms('13800000000', '')).rejects.toThrow('手机号和验证码不能为空')
    })

    it('正常登录并解析账号会话标识', async () => {
      let reqBody: FormData | undefined
      const mockFetch = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
        reqBody = init?.body as FormData
        return {
          ok: true,
          status: 200,
          json: async () => ({
            code: 0,
            data: {
              uid: 'user-sms-888',
              ssoSessionId: 'sso-sms-val',
              token: 'token-sms-val',
              accountId: 'account-sms-888',
              mobile: '13800000000',
            },
          }),
        } as Response
      })

      const res = await loginAstudioWithSms('13800000000', '654321', { fetcher: mockFetch })
      expect(res.uid).toBe('user-sms-888')
      expect(res.ssoSessionId).toBe('sso-sms-val')
      expect(res.token).toBe('token-sms-val')
      expect(res.accountId).toBe('account-sms-888')
      expect(res.mobile).toBe('13800000000')
      expect(res.loginMethod).toBe('sms')
      expect(reqBody?.get('mobile')).toBe('13800000000')
      expect(reqBody?.get('verifyCode')).toBe('654321')
    })

    it('登录失败或缺少凭据标识时抛出异常', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          code: 10002,
          desc: '验证码错误或已过期',
        }),
      } as Response)

      await expect(
        loginAstudioWithSms('13800000000', '999999', { fetcher: mockFetch }),
      ).rejects.toThrow('验证码错误或已过期')
    })
  })

  describe('账号密码登录 (loginAstudioWithPassword)', () => {
    it('参数校验：空账号、空密码或缺少极验参数抛错', async () => {
      await expect(loginAstudioWithPassword('', 'pwd123', dummyGeeTestResult)).rejects.toThrow('账号与密码不能为空')
      await expect(loginAstudioWithPassword('user123', '', dummyGeeTestResult)).rejects.toThrow('账号与密码不能为空')
      await expect(loginAstudioWithPassword('user123', 'pwd123', {} as never)).rejects.toThrow('缺少极验验证参数')
    })

    it('正常密码登录并解析账号信息', async () => {
      let reqBody: FormData | undefined
      const mockFetch = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
        reqBody = init?.body as FormData
        return {
          ok: true,
          status: 200,
          json: async () => ({
            code: 0,
            data: {
              uid: 'user-pwd-999',
              ssoSessionId: 'sso-pwd-val',
              token: 'token-pwd-val',
              accountId: 'account-pwd-999',
              username: 'developer999',
              nickname: 'DevNick',
              mobile: '13900000000',
            },
          }),
        } as Response
      })

      const res = await loginAstudioWithPassword('developer999', 'P@ssw0rd', dummyGeeTestResult, { fetcher: mockFetch })
      expect(res.uid).toBe('user-pwd-999')
      expect(res.ssoSessionId).toBe('sso-pwd-val')
      expect(res.token).toBe('token-pwd-val')
      expect(res.accountId).toBe('account-pwd-999')
      expect(res.username).toBe('developer999')
      expect(res.nickname).toBe('DevNick')
      expect(res.loginMethod).toBe('password')
      expect(reqBody?.get('accountName')).toBe('developer999')
      expect(reqBody?.get('accountPwd')).toBe('P@ssw0rd')
      expect(reqBody?.get('geetest_challenge')).toBe('challenge-xyz')
      expect(reqBody?.get('geetest_seccode')).toBe(Buffer.from('validate-xyz|jordan').toString('base64'))
    })

    it('密码错误或业务失败抛错', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          code: 10003,
          desc: '账号或密码不匹配',
        }),
      } as Response)

      await expect(
        loginAstudioWithPassword('developer999', 'wrong', dummyGeeTestResult, { fetcher: mockFetch }),
      ).rejects.toThrow('账号或密码不匹配')
    })
  })

  describe('Carrier 载体页纯函数与 Server (renderAstudioLoginPage & startAstudioLoginFlow)', () => {
    it('renderAstudioLoginPage 输出包含三合一 Tab 与极验脚本', () => {
      const html = renderAstudioLoginPage()
      expect(html).toContain('tab-sms')
      expect(html).toContain('tab-password')
      expect(html).toContain('tab-wechat')
      expect(html).toContain('gt.js')
      expect(html).toContain('sms-mobile')
      expect(html).toContain('sms-code')
      expect(html).toContain('pwd-account')
      expect(html).toContain('pwd-password')
      expect(html).toContain('qr-box')
    })

    it('renderAstudioLoginPage 落地真实极验契约并彻底剔除 mock-validate 假数据', () => {
      const html = renderAstudioLoginPage()
      // 官方 SDK 引入与动态加载
      expect(html).toContain('https://static.geetest.com/static/tools/gt.js')
      expect(html).toContain('ensureGeetestSdk')
      // window.initGeetest 调用与官方参数契约
      expect(html).toContain('window.initGeetest')
      expect(html).toContain("product: 'bind'")
      expect(html).toContain("width: '100%'")
      expect(html).toContain('offline: !config.success')
      expect(html).toContain('https: true')
      // 极验生命周期监听与凭证回调捕获
      expect(html).toContain('captchaObj.verify')
      expect(html).toContain('captchaObj.onReady')
      expect(html).toContain('captchaObj.onSuccess')
      expect(html).toContain('captchaObj.onError')
      expect(html).toContain('captchaObj.getValidate')
      expect(html).toContain('val.geetest_challenge')
      expect(html).toContain('val.geetest_validate')
      expect(html).toContain('val.geetest_seccode')
      // 彻底消除 mock 假数据
      expect(html).not.toContain('mock-validate')
      expect(html).not.toContain('mock-challenge')
      expect(html).not.toContain('mock-seccode')
    })

    it('renderAstudioLoginPage 包含手机号未注册开户引导与密码登录开户提示文案 (Goal 829)', () => {
      const html = renderAstudioLoginPage()
      expect(html).toContain('未注册手机号验证通过后将自动完成注册开户')
      expect(html).toContain('未注册账号请使用手机验证码快捷登录开户')
    })

    it('startAstudioLoginFlow 启动并服务载体页及三合一登录代理接口', async () => {
      const mockFetch = vi.fn()
        // 1. gee-captcha
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ code: 0, data: { gt: 'gt-flow', challenge: 'ch-flow', success: 1 } }),
        } as Response)
        // 2. send sms
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ code: 0, desc: '短信已发送' }),
        } as Response)
        // 3. quick login
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            code: 0,
            data: { uid: 'flow-uid', ssoSessionId: 'flow-sso', token: 'flow-tok', accountId: 'flow-acc' },
          }),
        } as Response)
        // 4. tenant/init-app (无条件开户初始化 Goal 829)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ code: 0, flag: true }),
        } as Response)
        // 5. completeAstudioLogin 换取凭据 (bot/models/configs)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            code: 0,
            data: [{ model: 'xopglm52', api_key: 'flow-model-key', is_default: true }],
          }),
        } as Response)

      let successCredential: AstudioCredential | undefined
      const flow = await startAstudioLoginFlow({
        fetcher: mockFetch,
        onSuccess: async (cred) => {
          successCredential = cred
        },
      })

      const port = new URL(flow.loginUrl).port
      expect(flow.loginUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/astudio\/login$/)

      try {
        // 测试 GET /astudio/login 返回 HTML
        const pageRes = await fetch(flow.loginUrl)
        expect(pageRes.status).toBe(200)
        const html = await pageRes.text()
        expect(html).toContain('<!DOCTYPE html>')
        expect(html).toContain('tab-sms')

        // 测试 GET /astudio/gee-captcha
        const geeRes = await fetch(`http://127.0.0.1:${port}${ASTUDIO_CARRIER_PATHS.geeCaptcha}`)
        expect(geeRes.status).toBe(200)
        const geeBody = (await geeRes.json()) as { ok: boolean; data?: { gt?: string } }
        expect(geeBody.ok).toBe(true)
        expect(geeBody.data?.gt).toBe('gt-flow')

        // 测试 POST /astudio/sms/send
        const sendRes = await fetch(`http://127.0.0.1:${port}${ASTUDIO_CARRIER_PATHS.sendSms}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            mobile: '13812345678',
            geetestChallenge: 'challenge-xyz',
            geetestValidate: 'validate-xyz',
            geetestSeccode: 'validate-xyz|jordan',
          }),
        })
        expect(sendRes.status).toBe(200)
        const sendBody = (await sendRes.json()) as { ok: boolean }
        expect(sendBody.ok).toBe(true)

        // 测试 POST /astudio/sms/login
        const loginRes = await fetch(`http://127.0.0.1:${port}${ASTUDIO_CARRIER_PATHS.smsLogin}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            mobile: '13812345678',
            verifyCode: '123456',
          }),
        })
        expect(loginRes.status).toBe(200)
        const loginBody = (await loginRes.json()) as { ok: boolean; message?: string }
        expect(loginBody.ok).toBe(true)
        expect(loginBody.message).toBe('登录成功')

        // 等待 flow.result 就绪
        const resCred = await flow.result
        expect(resCred?.uid).toBe('flow-uid')
        expect(resCred?.access_token).toBe('flow-model-key')
        expect(successCredential?.uid).toBe('flow-uid')
      } finally {
        await flow.close()
      }
    })
  })

  describe('completeAstudioLogin 与 AstudioAuth 对 AstudioLoginIdentity 的凭据交换', () => {
    it('对短信/密码登录生成的 identity 成功换取 modelBearerToken 并入库', async () => {
      const mockFetch = vi.fn()
        // 1. tenant/init-app (无条件开户初始化 Goal 829)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ code: 0, flag: true }),
        } as Response)
        // 2. bot/models/configs
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            code: 0,
            data: [{ model: 'xopglm52', api_key: 'identity-exchange-token', is_default: true }],
          }),
        } as Response)

      const fakeStore: AstudioCredentialStore = {
        resolve: vi.fn().mockResolvedValue(undefined),
        set: vi.fn().mockResolvedValue(undefined),
        unset: vi.fn().mockResolvedValue(undefined),
      }

      const ctx = new Context()
      const auth = new AstudioAuth(ctx, {
        store: fakeStore,
        fetcher: mockFetch,
        env: { DSH_ASTUDIO_SESSION_FILE: 'F:/project/ARTEX/data/tasks/4/not-exist.json' },
      })

      const identity: AstudioLoginIdentity = {
        uid: 'user-identity-123',
        ssoSessionId: 'sso-identity-val',
        token: 'token-identity-val',
        accountId: 'acc-identity-123',
        mobile: '13899998888',
        loginMethod: 'sms',
      }

      const saved = await auth.completeLogin(identity)
      expect(saved.access_token).toBe('identity-exchange-token')
      expect(saved.uid).toBe('user-identity-123')
      expect(saved.login_method).toBe('sms')
      expect(saved.account_id).toBe('acc-identity-123')
      expect(saved.sso_session_id).toBe('sso-identity-val')

      expect(fakeStore.set).toHaveBeenCalledWith(
        expect.anything(),
        expect.stringContaining('identity-exchange-token'),
      )
    })
  })
})

