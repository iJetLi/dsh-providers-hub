/**
 * `codeartsIdentity` / `codeartsAccountName`：从凭据里解出真实 IAM 用户名。
 *
 * ## 为什么这个文件存在
 *
 * 用户报障：CodeArts 面板上的账号卡片只显示 `codearts-xxxxxxxx`（池 id 前 8 位
 * 十六进制），多个账号排在一起**认不出谁是谁**。根因不是上游没下发名字，而是
 * 新式 OAuth 的凭据组装不写 `user_name`，登录昵称于是恒回落池 id
 * （见 `src/codearts-identity.ts` 的模块头）。
 *
 * 名字的真源是 `refresh_token`（JWT）里那个**内嵌 base64 JSON** 的 `user_profile`。
 * 本文件把「怎么解」这一层钉死。
 *
 * ## 样本全部**自造**
 *
 * `alice` / `bob` / `acme` 都是虚构的。真实账号名属用户数据，不得进仓库
 * （本仓库对 `PR-描述-*.md` 已有同样的「刻意不写真实值」纪律）。
 *
 * ## 覆盖的六格
 *
 * | 格 | 钉住的判据 |
 * |---|---|
 * | root 账号 | `principal_urn` 末段 == `account_name` ⇒ **裸名，不加后缀** |
 * | 子用户 | 两者不同 ⇒ `子用户名@账号名`（**这一格守「优先 urn」的取值顺序**） |
 * | base64 两种字母表 | 带 `=` 填充 / 不带填充**都必须解得开**（真实样本 9 个里 6 带 3 不带） |
 * | 缺 `user_profile` | 返回空对象（**不编造**） |
 * | 非 JWT / 坏 JSON | 同上 |
 * | 老 ticket 凭据 | 退凭据顶层 `user_name` |
 */
import { describe, expect, it } from 'vitest'

import { codeartsAccountName, codeartsIdentity } from '../../src/codearts-identity.js'

/**
 * 造一个**未签名形态**的 refresh_token（真 JWT 恒 3 段，本函数只解中段）。
 *
 * @param profile `user_profile` 的原文对象；`undefined` 表示载荷里**没有**该字段。
 * @param options.padded 内嵌 `user_profile` 是否带 `=` 填充（实测两种都存在）。
 */
function refreshTokenWith(
  profile: Record<string, unknown> | undefined,
  options: { padded?: boolean; rawProfile?: string } = {},
): string {
  const payload: Record<string, unknown> = {
    exp: 1796232810,
    iat: 1794406362,
    iss: 'cn-north-4',
    type: 'refreshToken',
    client_id: 'codearts-agent',
  }
  if (options.rawProfile !== undefined) {
    payload.user_profile = options.rawProfile
  } else if (profile !== undefined) {
    const json = JSON.stringify(profile)
    payload.user_profile = options.padded === false
      ? Buffer.from(json, 'utf8').toString('base64url')
      // `base64` 才带 `=` 填充；`base64url` 恒不带。真实样本两种都有。
      : Buffer.from(json, 'utf8').toString('base64')
  }
  const header = Buffer.from('{"typ":"JWT","alg":"RS256"}', 'utf8').toString('base64url')
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  return `${header}.${body}.signature`
}

/** root 账号（本机 9 个真实账号全是这一形态）。 */
const ROOT_PROFILE = {
  account_id: '01a19d50056f7354a3a13363256be613',
  account_name: 'alice',
  principal_is_root_user: true,
  principal_urn: 'iam::01a19d50056f7354a3a13363256be613:user:alice',
}

/** 子用户：`account_name` 是**账号（租户）名**，`principal_urn` 末段才是**子用户名**。 */
const SUB_USER_PROFILE = {
  account_id: 'c173af8d90074056b809920ec6780884',
  account_name: 'acme',
  principal_is_root_user: false,
  principal_urn: 'iam::c173af8d90074056b809920ec6780884:user:bob',
}

describe('codeartsIdentity：取值顺序', () => {
  it('root 账号 ⇒ 裸用户名，**不加** @账号名 后缀', () => {
    const credential = { refresh_token: refreshTokenWith(ROOT_PROFILE) }
    expect(codeartsAccountName(credential)).toBe('alice')
    // root 时 `account_name` 与 urn 末段相同 ⇒ 判据必须走「相同」那一格，
    // 而不是「两者都在就拼」—— 拼了会得到 `alice@alice`（真实观感缺陷）。
    expect(codeartsAccountName(credential)).not.toContain('@')
  })

  it('★ 子用户 ⇒ `子用户名@账号名`（守「优先 principal_urn」这一条取值顺序）', () => {
    const credential = { refresh_token: refreshTokenWith(SUB_USER_PROFILE) }
    // ⚠️ 这一格是整份判据的**力量所在**：把取值顺序改成「优先 account_name」
    //    ⇒ 得到 `acme`（账号名），本断言立刻变红。
    expect(codeartsAccountName(credential)).toBe('bob@acme')
    expect(codeartsAccountName(credential)).not.toBe('acme')
  })

  it('同时给出 accountId（IAM 账号 id，跨续期稳定）', () => {
    expect(codeartsIdentity({ refresh_token: refreshTokenWith(ROOT_PROFILE) }).accountId)
      .toBe('01a19d50056f7354a3a13363256be613')
  })

  it('只有 account_name、没有 principal_urn ⇒ 用 account_name', () => {
    const credential = {
      refresh_token: refreshTokenWith({ account_name: 'carol', account_id: 'acc-1' }),
    }
    expect(codeartsAccountName(credential)).toBe('carol')
  })

  it('只有 principal_urn、没有 account_name ⇒ 用 urn 末段', () => {
    const credential = {
      refresh_token: refreshTokenWith({ principal_urn: 'iam::acc-2:user:dave' }),
    }
    expect(codeartsAccountName(credential)).toBe('dave')
  })
})

describe('codeartsIdentity：base64 两种字母表都要吃', () => {
  /**
   * ⚠️ 实测约束（2026-11-12，9 个真实账号）：同一端点签发的 `user_profile`
   * **6 个带 `=` 填充、3 个不带**。只吃其中一种 ⇒ 那 3 个账号永远显示 id，
   * 而且**没有任何报错**（解不开就当「读不到」）。本组钉住两种。
   */
  it('带 `=` 填充的 user_profile 能解开', () => {
    const token = refreshTokenWith(ROOT_PROFILE, { padded: true })
    // 先自证样本确实是「带填充」形态，否则这条就是同义反复。
    const payload = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8'))
    expect(payload.user_profile.endsWith('=')).toBe(true)
    expect(codeartsAccountName({ refresh_token: token })).toBe('alice')
  })

  it('不带 `=` 填充的 user_profile 也能解开', () => {
    const token = refreshTokenWith(ROOT_PROFILE, { padded: false })
    const payload = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8'))
    expect(payload.user_profile.endsWith('=')).toBe(false)
    expect(codeartsAccountName({ refresh_token: token })).toBe('alice')
  })

  it('名字含非 ASCII 时按 UTF-8 解（不出现乱码）', () => {
    const credential = {
      refresh_token: refreshTokenWith({
        account_name: '张三',
        principal_urn: 'iam::acc-3:user:张三',
      }),
    }
    expect(codeartsAccountName(credential)).toBe('张三')
  })
})

describe('codeartsIdentity：**绝不编造**', () => {
  it('载荷无 user_profile ⇒ undefined（不是空串、不是 id）', () => {
    expect(codeartsAccountName({ refresh_token: refreshTokenWith(undefined) })).toBeUndefined()
    expect(codeartsIdentity({ refresh_token: refreshTokenWith(undefined) })).toEqual({})
  })

  it('user_profile 不是合法 base64 JSON ⇒ undefined', () => {
    const credential = { refresh_token: refreshTokenWith(undefined, { rawProfile: 'not-a-json' }) }
    expect(codeartsAccountName(credential)).toBeUndefined()
  })

  it('user_profile 是合法 base64 但解出数组/标量 ⇒ undefined', () => {
    const asArray = Buffer.from('["alice"]', 'utf8').toString('base64url')
    const asScalar = Buffer.from('"alice"', 'utf8').toString('base64url')
    expect(codeartsAccountName({ refresh_token: refreshTokenWith(undefined, { rawProfile: asArray }) }))
      .toBeUndefined()
    expect(codeartsAccountName({ refresh_token: refreshTokenWith(undefined, { rawProfile: asScalar }) }))
      .toBeUndefined()
  })

  it('refresh_token 不是 3 段 JWT（上游将来可能换成不透明串）⇒ undefined，不抛错', () => {
    // ⚠️ 样本刻意保持**短**（< 16 字符）：`repo-pii-guard.spec.ts` 有一条判据是
    //    「凭据字段名 + ≥16 位高熵字面量」⇒ 长样本会被判成疑似真实凭据（本文件
    //    第一版用 `'opaque-token-without-dots'` 就被它当场抓红）。**不放宽那条守卫**，
    //    改成让样本不触发它 —— 判据的有牙性比样本的可读性重要。
    expect(codeartsAccountName({ refresh_token: 'no-dots' })).toBeUndefined()
    expect(codeartsAccountName({ refresh_token: 'a.b' })).toBeUndefined()
  })

  it('载荷中段是坏 base64 ⇒ undefined，不抛错', () => {
    expect(codeartsAccountName({ refresh_token: 'hdr.@@@not-base64@@@.sig' })).toBeUndefined()
  })

  it('account_name / urn 末段都是空白 ⇒ undefined（空白不是名字）', () => {
    const credential = {
      refresh_token: refreshTokenWith({ account_name: '   ', principal_urn: 'iam::acc:user:   ' }),
    }
    expect(codeartsAccountName(credential)).toBeUndefined()
  })

  it('凭据本身是 undefined ⇒ 空对象（RPC 层解析失败时就是这个形态）', () => {
    expect(codeartsIdentity(undefined)).toEqual({})
    expect(codeartsAccountName(undefined)).toBeUndefined()
  })
})

describe('codeartsIdentity：老 ticket 凭据回退', () => {
  /**
   * 老流程（`src/login.ts` 的 `parseCredentialResponse`）把用户名写在凭据**顶层**
   * `user_name`，没有 `refresh_token`。这类账号数量少但真实存在，不能显示成 id。
   */
  it('无 refresh_token 时退到顶层 user_name', () => {
    expect(codeartsAccountName({ user_name: 'legacy-user' })).toBe('legacy-user')
  })

  it('refresh_token 解不出时**也**退到顶层 user_name（不是直接放弃）', () => {
    expect(codeartsAccountName({
      // 同上：短样本，避免命中 `repo-pii-guard.spec.ts` 的「字段名 + 高熵」判据。
      refresh_token: 'broken',
      user_name: 'legacy-user',
    })).toBe('legacy-user')
  })

  it('顶层 user_name 是空白 ⇒ undefined', () => {
    expect(codeartsAccountName({ user_name: '  ' })).toBeUndefined()
  })
})

describe('codeartsIdentity：**不产生副作用**', () => {
  /**
   * 纯函数是它能在 `account.list` 热路径逐账号调用的前提（每个面板刷新都会跑）。
   * 这里守「不写日志、不改入参」两条最容易在后续维护中被破坏的性质。
   */
  it('不改写入参（凭据对象原样返回）', () => {
    const credential = { refresh_token: refreshTokenWith(ROOT_PROFILE), user_name: 'keep-me' }
    const snapshot = JSON.stringify(credential)
    codeartsIdentity(credential)
    expect(JSON.stringify(credential)).toBe(snapshot)
  })

  it('不打印任何东西（控制台零输出）', () => {
    const calls: unknown[][] = []
    const originLog = console.log
    const originWarn = console.warn
    const originError = console.error
    console.log = (...args: unknown[]) => { calls.push(args) }
    console.warn = (...args: unknown[]) => { calls.push(args) }
    console.error = (...args: unknown[]) => { calls.push(args) }
    try {
      codeartsIdentity({ refresh_token: refreshTokenWith(ROOT_PROFILE) })
      codeartsIdentity({ refresh_token: 'broken' })
      codeartsIdentity(undefined)
    } finally {
      console.log = originLog
      console.warn = originWarn
      console.error = originError
    }
    // ⚠️ 凭据里是**真 token**，这条是「不泄漏」的最基本一道闸。
    expect(calls).toEqual([])
  })
})
