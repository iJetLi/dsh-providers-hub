/**
 * 豆包：**找不到浏览器那条路**的端到端文案守卫（Gitee issue IKV5HC）。
 *
 * ## ⚠️⚠️ 为什么必须单独一个文件、而且必须 mock `chromium-session`
 *
 * `doubaoLoginBrowserHint()` / `doubaoSigninBrowserHint()` 的**返回值**很容易测
 * （`doubao-browser-discovery.spec.ts` 就测了），但真正要守的不是那个纯函数，而是
 * 「**用户看到的那条错误**里到底有没有这段提示」——
 *
 * ```
 * const exe = options.executablePath ?? doubaoLoginBrowserExecutable()
 * if (exe === undefined)
 *   throw new Error('豆包登录需要本机有 Chromium 内核浏览器，未找到可执行文件。' + doubaoLoginBrowserHint())
 * ```
 *
 * 只要有人把这行改回**硬编码文案**（或把 `+ doubaoLoginBrowserHint()` 删掉），纯函数
 * 用例依然全绿、而用户又回到「不分平台、不提变量名、不回显候选」的老提示 ——
 * 这正是 Issue IKJKNT 的复发形态。所以这里**必须让解析真的失败**，把
 * `throw` / `return` 那一行打到。
 *
 * 手法：
 * 1. `vi.mock('./chromium-session.js')` 把 `findBrowserExecutable` 换成恒 `undefined`
 *    （其余导出保持真实，`browserNotFoundMessage` 等仍是真的）；
 * 2. 把 `process.platform` 临时改成 `darwin` —— 于是候选链里那几条 **Windows 专属**
 *    路径被平台门控挡掉，`existsSync` 再也不可能在本机（Windows 开发机）命中；
 * 3. 断言**用户可见的错误文本**。
 *
 * 本仓绝大多数的「门禁守卫」假绿都是这个形状：**被测函数抓的是它的返回值，而不是
 * 它的消费者**。这个文件就是那一格的补丁。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/chromium-session.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/chromium-session.js')>()
  return {
    ...actual,
    // 本机（Windows 开发机）真的装着 Chrome ⇒ 不 mock 就永远走不到「找不到」分支。
    findBrowserExecutable: () => undefined,
  }
})

const { DoubaoLoginSession } = await import('../../src/doubao-login.js')
const { claimDoubaoDailyViaPage } = await import('../../src/doubao-signin.js')

const originalPlatform = process.platform

beforeAll(() => {
  // 让「Windows 专属候选」被平台门控挡掉；`browserNotFoundMessage` 也随之走 darwin 文案。
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
})

afterAll(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
})

describe('★ 找不到浏览器时，**用户看到的那条错误**必须是分平台文案（IKV5HC / IKJKNT）', () => {
  it('★★★ 登录：`DoubaoLoginSession.open()` 抛出的消息里必须带跨平台排查信息', async () => {
    await expect(DoubaoLoginSession.open()).rejects.toThrow(/DSH_DOUBAO_BROWSER_PATH/)

    /**
     * ⚠️ 这一格是**反向**的：修复前那句只写「Chrome / 豆包客户端」，而 macOS 上
     * `chrome.exe` 这东西根本不存在 —— 报障人（macOS 14）照着提示做只会更懵。
     */
    let message = ''
    try {
      await DoubaoLoginSession.open()
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).toContain('/Applications')
    expect(message).not.toContain('chrome.exe')
  })

  it('★★★ 签到：`claimDoubaoDailyViaPage()` 返回的失败消息里必须带同一份信息', async () => {
    const outcome = await claimDoubaoDailyViaPage('{"cookie":"sessionid=abc"}')
    expect(outcome.kind).toBe('failed')
    if (outcome.kind !== 'failed') return

    /**
     * ⚠️ 签到的原文案更糟：`未找到可用的浏览器（Chrome / 豆包内核）——签到需要它的
     * bdms 签名环境` —— 「豆包内核」在 macOS 上同样不在候选链里，且**一个字都没提
     * `DSH_DOUBAO_BROWSER_PATH`**（用户唯一真能自救的动作）。
     */
    expect(outcome.message).toContain('DSH_DOUBAO_BROWSER_PATH')
    expect(outcome.message).toContain('/Applications')
    expect(outcome.message).not.toContain('chrome.exe')
  })
})
