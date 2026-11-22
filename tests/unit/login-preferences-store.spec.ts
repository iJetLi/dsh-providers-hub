/**
 * 客户端「新建账号时自动打开浏览器授权页」状态/读写
 * （`plugin-src/client/login-preferences-store.js`）。
 *
 * 这个模块是**设置页开关**与 **`createAccount` 分流**共用的唯一真源。
 * 它错了的症状全是「零报错」的：
 *
 * - 读失败按「关」⇒ 新建账号不再自动跳登录页（用户以为插件坏了）；
 * - 写入后不更新本地 ⇒ 设置里关了、下一次新建账号仍自动开窗；
 * - 慢读回包倒灌 ⇒ 用户刚改完开关又自己跳回去；
 * - 并发读不去重 ⇒ 冷启动一次挂载打三次宿主 RPC。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  __setLoginAutoOpenForTest,
  loadLoginAutoOpen,
  loginAutoOpenEnabled,
  loginAutoOpenReadFailed,
  setLoginAutoOpen,
  subscribeLoginAutoOpen,
} from '../../plugin-src/client/login-preferences-store.js'

afterEach(() => {
  __setLoginAutoOpenForTest(true)
})

describe('读：缺省方向必须是「开」', () => {
  it('★ 初始值 = 开（与宿主 sanitize 的缺键语义同向）', () => {
    expect(loginAutoOpenEnabled()).toBe(true)
    expect(loginAutoOpenReadFailed()).toBe(false)
  })

  it('★ 读到 false ⇒ 关闭；读到 true ⇒ 开启', async () => {
    const rpc = vi.fn(async () => ({ enabled: false }))
    await loadLoginAutoOpen(rpc as never)
    expect(loginAutoOpenEnabled()).toBe(false)
    expect(loginAutoOpenReadFailed()).toBe(false)

    const rpc2 = vi.fn(async () => ({ enabled: true }))
    await loadLoginAutoOpen(rpc2 as never)
    expect(loginAutoOpenEnabled()).toBe(true)
  })

  it('★★ 读取失败 ⇒ 仍按「开」并标记失败（绝不静默关功能）', async () => {
    const rpc = vi.fn(async () => { throw new Error('host old') })
    const result = await loadLoginAutoOpen(rpc as never)
    expect(result).toBe(true)
    expect(loginAutoOpenEnabled()).toBe(true)
    expect(loginAutoOpenReadFailed()).toBe(true)
    // 3 轮有界重试（首读 + 2 次重试）
    expect(rpc).toHaveBeenCalledTimes(3)
  })

  it('⚠️ 回包形状不对 ⇒ 按读取失败处理，但仍保持「开」', async () => {
    const rpc = vi.fn(async () => ({ enabled: 'false' }))
    await loadLoginAutoOpen(rpc as never)
    expect(loginAutoOpenEnabled()).toBe(true)
    expect(loginAutoOpenReadFailed()).toBe(true)
    // 形状不对不重试：宿主已经答了，只是答得不对
    expect(rpc).toHaveBeenCalledTimes(1)
  })

  it('★ 并发两次读只发一次请求（并发去重）', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const rpc = vi.fn(async () => {
      await gate
      return { enabled: false }
    })
    const first = loadLoginAutoOpen(rpc as never)
    const second = loadLoginAutoOpen(rpc as never)
    release?.()
    await Promise.all([first, second])
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(loginAutoOpenEnabled()).toBe(false)
  })

  it('★★ 慢读回包不得倒灌覆盖用户刚写入的值', async () => {
    // 读请求挂起 → 用户切换开关成功 → 读回包才带着**旧值**到达。
    let releaseRead: ((value: { enabled: boolean }) => void) | undefined
    const rpc = vi.fn(async (method: string) => {
      if (method === 'loginPreferences.getEnabled') {
        return await new Promise<{ enabled: boolean }>((resolve) => { releaseRead = resolve })
      }
      return { enabled: false }
    })
    const pending = loadLoginAutoOpen(rpc as never)
    await setLoginAutoOpen(rpc as never, false)
    expect(loginAutoOpenEnabled()).toBe(false)
    releaseRead?.({ enabled: true })
    await pending
    expect(
      loginAutoOpenEnabled(),
      '旧回包把用户刚切的「关」覆盖回「开」⇒「改完又自己跳回去」',
    ).toBe(false)
  })
})

describe('写：以宿主回包为准', () => {
  it('★ 写入成功 ⇒ 本地值变、读取失败标记清空', async () => {
    const rpc = vi.fn(async () => ({ enabled: false }))
    const confirmed = await setLoginAutoOpen(rpc as never, false)
    expect(confirmed).toBe(false)
    expect(loginAutoOpenEnabled()).toBe(false)
    expect(loginAutoOpenReadFailed()).toBe(false)
  })

  it('★★ 宿主回传值与入参不同 ⇒ 以宿主为准（不做乐观更新）', async () => {
    const rpc = vi.fn(async () => ({ enabled: true }))
    await setLoginAutoOpen(rpc as never, false)
    expect(loginAutoOpenEnabled(), '宿主说仍是开，就不能显示关').toBe(true)
  })

  it('⚠️ 回包没有合法布尔 ⇒ 抛错且本地值不变', async () => {
    __setLoginAutoOpenForTest(true)
    const rpc = vi.fn(async () => ({}))
    await expect(setLoginAutoOpen(rpc as never, false)).rejects.toThrow()
    expect(loginAutoOpenEnabled()).toBe(true)
  })

  it('⚠️ 写入请求抛错 ⇒ 原样抛出（设置页据此回滚并提示）', async () => {
    __setLoginAutoOpenForTest(true)
    const rpc = vi.fn(async () => { throw new Error('bad-request') })
    await expect(setLoginAutoOpen(rpc as never, false)).rejects.toThrow(/bad-request/)
    expect(loginAutoOpenEnabled()).toBe(true)
  })
})

describe('订阅', () => {
  it('★ 值变化才广播；取消订阅后不再收到', async () => {
    const listener = vi.fn()
    const unsubscribe = subscribeLoginAutoOpen(listener)
    __setLoginAutoOpenForTest(false)
    expect(listener).toHaveBeenCalledTimes(1)
    // 同值重复设定不广播
    __setLoginAutoOpenForTest(false)
    expect(listener).toHaveBeenCalledTimes(1)
    unsubscribe()
    __setLoginAutoOpenForTest(true)
    expect(listener).toHaveBeenCalledTimes(1)
  })
})