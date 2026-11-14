import { afterEach, describe, expect, it, vi } from 'vitest'
import { RACCOON } from '../../src/raccoon-product.js'
import {
  RACCOON_LOGIN_PAGE_PATHS,
  renderRaccoonLoginPage,
  startRaccoonLoginFlow,
  type StartedRaccoonLoginFlow,
} from '../../src/raccoon-login-page.js'

let started: StartedRaccoonLoginFlow | undefined
afterEach(async () => {
  if (started) {
    await started.close()
    started = undefined
  }
})

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/** 从 loginUrl 取出 origin（路径常量自带 `/raccoon` 前缀，故只需 origin）。 */
function originOf(loginUrl: string): string {
  return loginUrl.replace(/\/raccoon\/login$/, '')
}

/**
 * 对本地 HTTP 服务的 `fetch`，带**连接失败重试**。
 *
 * ## ⚠️ 为什么需要（2026-10-08 实测的既有 flake，不是本次改动引入）
 *
 * 本文件的用例真起一个 `127.0.0.1` 的随机端口服务再 `fetch` 它。**单文件跑 6 次
 * 全绿**，但**全量并行**（vitest 多 worker）时偶发 `fetch failed` —— 那是瞬时
 * 资源争抢（socket/端口/文件描述符），**不是逻辑缺陷**。
 *
 * ⚠️ **只重试连接类失败**（`TypeError: fetch failed` / `ECONNRESET` /
 * `ECONNREFUSED`）：HTTP 状态码与业务错误**必须原样返回**，否则会把
 * 「服务端真的回了 500」这类真缺陷重试成绿 —— 那正是本仓库反复记录的
 * 「把失败吞掉」形态。
 *
 * ⚠️ 重试次数与间隔刻意保守（3 次 × 50ms）：足够吸收瞬时争抢，
 * 又不会把真失败拖成慢测试（真失败最坏多耗 150ms）。
 */
async function fetchLocal(url: string, init?: RequestInit): Promise<Response> {
  const MAX_ATTEMPTS = 3
  let lastError: unknown
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      // ⚠️ 这里必须是**全局 `fetch`**，不能是 `fetchLocal` ——
      //    写成后者会**无限递归**（本文件的批量替换一度踩到过）。
      return await fetch(url, init)
    } catch (error) {
      // ⚠️ 只吞「连不上」这一类；HTTP 层的错误响应是**正常返回**（不会走这里）。
      const message = error instanceof Error ? error.message : String(error)
      const isConnectionFailure = /fetch failed|ECONNRESET|ECONNREFUSED|EPIPE/i.test(message)
      if (!isConnectionFailure || attempt === MAX_ATTEMPTS) throw error
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 50 * attempt))
    }
  }
  throw lastError
}

/** 造一个最小 JWT。 */
function jwtWithExp(expSeconds: number): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url')
  const body = Buffer.from(JSON.stringify({ exp: expSeconds })).toString('base64url')
  return `${header}.${body}.sig`
}

describe('RACCOON_LOGIN_PAGE_PATHS', () => {
  it('四条路径都是 /raccoon 前缀', () => {
    for (const p of Object.values(RACCOON_LOGIN_PAGE_PATHS)) {
      expect(p.startsWith('/raccoon/')).toBe(true)
    }
  })
})

/**
 * 服务端签发的扫码票据（2026-11-14 起唯一可用形态）。
 *
 * ⚠️ 旧实现用**本地随机 32 位 hex**；新端点上那恒回 401
 * （Gitee IKVA90），所以所有用例都必须走「先签发、再轮询」两跳。
 */
const TICKET = {
  qrcode_code: 'qr-test-0001',
  scan_path: '/login/mp',
  expires_in: 300,
  // ⚠️ **故意不用默认的 2 秒**：若用 2 秒，「写死 2000」与「用服务端下发值」
  // 逐字节相同，那条判据就恒真（本仓记过的「假绿」）。
  poll_interval: 5,
  status: 'pending',
}

/**
 * 造一个 fetch 桩：**签发端点**（`/auth/mp/qrcode`）恒回成功，
 * 其余请求交给 `handler`（通常是轮询端点）。
 *
 * 为什么必须这样：`startRaccoonLoginFlow` 的首次签发发生在页面请求
 * `/raccoon/login` 或 `/raccoon/poll` 时（懒签发）。若桩只回轮询响应，
 * 签发会失败 ⇒ 页面只拿到「二维码获取失败」，用例变成测兜底而不是测主路径。
 */
function iamFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).endsWith('/auth/mp/qrcode')) {
      return jsonResponse({ code: 'OK', message: 'success', request_id: 'reqiam-1', data: TICKET })
    }
    return handler(url, init)
  })
}

describe('renderRaccoonLoginPage', () => {
  const html = renderRaccoonLoginPage(RACCOON, {
    code: TICKET.qrcode_code,
    scanPath: TICKET.scan_path,
    expiresInMs: TICKET.expires_in * 1000,
    pollIntervalMs: TICKET.poll_interval * 1000,
  })

  it('是完整 HTML 文档', () => {
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true)
    expect(html).toContain('</html>')
    expect(html).toContain('charset="utf-8"')
  })

  it('★★ 轮询间隔取服务端下发的 poll_interval（不是写死 2000）', () => {
    expect(html).toContain('var POLL_INTERVAL_MS = 5000;')
  })

  it('有两个 Tab：微信扫码与短信登录', () => {
    expect(html).toContain('微信扫码')
    expect(html).toContain('短信登录')
  })

  it('有合法的内联二维码（**必须是可解析的 SVG**，不是被转义的字符串）', () => {
    // ⚠️ 真实缺陷回归（用户报障「弹出页面二维码没显示出来」）：
    // 早期实现把 SVG 的引号转义成 `&quot;` 再内联，
    // 于是浏览器把它当作文本节点而**不渲染**二维码。
    //
    // ⚠️ 旧断言是 `toContain('viewBox')` —— 那个在**有 bug 时也会通过**
    // （`viewBox=&quot;0 0 …&quot;` 同样含子串 `viewBox`），
    // 所以缺陷没被任何用例抓住。新断言要求：
    //   1. 属性引号是**真引号**（未转义）；
    //   2. 是完整的 `<svg …>` 标签（属性顺序/形态可解析）。
    expect(html).not.toContain('&quot;')
    expect(html).toContain('<svg xmlns="http://www.w3.org/2000/svg"')
    expect(html).toContain('viewBox="0 0 ')
    expect(html).toContain('</svg>')
    // SVG 必须落在二维码容器内（而不是散落在页面别处）
    const container = /<div class="qr" id="qrBox">([\s\S]*?)<\/div>/.exec(html)
    expect(container).not.toBeNull()
    expect(container?.[1]).toContain('<svg')
    expect(container?.[1]).toContain('</svg>')
  })

  it('内联二维码的 path 非空（真的画了模块，不是空图）', () => {
    const container = /<div class="qr" id="qrBox">([\s\S]*?)<\/div>/.exec(html)
    const svg = container?.[1] ?? ''
    const d = /<path d="([^"]*)"/.exec(svg)
    expect(d).not.toBeNull()
    // 每个深色模块一段 `M{x},{y}h1v1h-1z`
    const segments = (d?.[1] ?? '').split('M').length - 1
    expect(segments).toBeGreaterThan(100)
  })

  it('不引用任何外部 QR 库（二维码是宿主机自绘的）', () => {
    expect(html).not.toMatch(/cdn[^"']*qrcode/i)
    expect(html).not.toMatch(/unpkg\.com|jsdelivr\.net/)
  })

  it('加载阿里云验证码脚本（短信路径必需）', () => {
    expect(html).toContain('AliyunCaptcha.js')
    expect(html).toContain(RACCOON.aliyunCaptcha.sceneId)
    expect(html).toContain(RACCOON.aliyunCaptcha.prefix)
  })

  it('页面不含任何密钥或 token（职责边界：宿主侧持有敏感状态）', () => {
    expect(html).not.toContain(RACCOON.phoneCipherSecret)
    expect(html).not.toContain('access_token')
    expect(html).not.toContain('refresh_token')
  })

  it('页面脚本里的轮询间隔就是票据下发的值（5 秒）', () => {
    // ⚠️ 原判据 `toContain('2000')` **恒真** —— 生成的 `<svg viewBox="0 0 2000 2000">`
    //    里就有 `2000`，写死 2000 与用票据值逐字节相同（正向审计实测的无牙格）。
    //    判据必须打在**赋值语句**上，且取值与默认常量（2000）不同。
    expect(html).toContain('var POLL_INTERVAL_MS = 5000;')
  })

  it('★★ 二维码下方必须常驻「改用短信登录」提示（不是只在签发失败时才有）', () => {
    // 2026-11-14/15 实测：官方二维码落地页 `/login/mp` 全部 404，而**签发是成功的**
    // ⇒ 页面走不到 `.qr-fallback` 那条「获取失败」分支。提示若不常驻，
    // 用户扫进一个 404 页、界面上却没有任何一句告诉他可以改用短信。
    expect(html).toContain('扫完打不开页面？可直接改用下方「短信登录」')
    // 与兜底块是**两条不同的腿**：兜底块只在签发失败时替换二维码区域。
    // 本用例的 `html` 是**带 ticket** 渲染的 ⇒ 不应该出现兜底块
    // （写反了就是「有票据时也在报错」的假红）。
    expect(html).not.toContain('class="qr-fallback"')
    const failed = renderRaccoonLoginPage(RACCOON, undefined, 'boom')
    expect(failed).toContain('class="qr-fallback"')
  })

  it('登录 URL 不硬编码进页面（由宿主侧按会话生成）', () => {
    // 页面只需展示二维码；URL 内容属于宿主侧会话状态
    expect(html).not.toContain('login/mp?code=')
  })
})

describe('startRaccoonLoginFlow', () => {
  it('立即返回指向 127.0.0.1 的 loginUrl（两步式的硬约束）', async () => {
    const fetcher = iamFetch(async () => jsonResponse({ code: 'OK', data: { status: 'pending' } }))
    started = await startRaccoonLoginFlow({ fetcher: fetcher as unknown as typeof fetch })
    expect(started.loginUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/raccoon\/login$/)
  })

  it('loginUrl 立即可访问，且返回 HTML', async () => {
    const fetcher = iamFetch(async () => jsonResponse({ code: 'OK', data: { status: 'pending' } }))
    started = await startRaccoonLoginFlow({ fetcher: fetcher as unknown as typeof fetch })
    const response = await fetchLocal(started.loginUrl)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')
    const body = await response.text()
    expect(body).toContain('微信扫码')
  })

  it('只绑 127.0.0.1，不对外暴露', async () => {
    const fetcher = iamFetch(async () => jsonResponse({ code: 'OK', data: { status: 'pending' } }))
    started = await startRaccoonLoginFlow({ fetcher: fetcher as unknown as typeof fetch })
    expect(started.loginUrl).toContain('127.0.0.1')
    expect(started.loginUrl).not.toContain('0.0.0.0')
  })

  it('轮询端点返回 pending（尚未扫码）', async () => {
    const fetcher = iamFetch(async () => jsonResponse({ code: 'OK', data: { status: 'pending' } }))
    started = await startRaccoonLoginFlow({ fetcher: fetcher as unknown as typeof fetch })
    const base = originOf(started.loginUrl)
    const response = await fetchLocal(`${base}${RACCOON_LOGIN_PAGE_PATHS.poll}`)
    expect(response.status).toBe(200)
    const payload = await response.json() as { status: string; qr?: string }
    expect(payload.status).toBe('pending')
    // 这条 poll 是页面**第一次**来问（`/raccoon/login` 还没被访问过）⇒ 服务端要顺带
    // 把二维码带回去，否则页面拿不到图（正向审计 P1-b 的同一条路径）。
    expect(payload.qr).toContain('<svg')
  })

  it('★★★ 401 + HTML（非 JSON）必须判「过期」而不是一直 pending（正向审计 P2-a）', async () => {
    // ⚠️ 原实现里 `response.json()` 抛错**先于** `HTTP_${status}` 兜底 ⇒ 网关把 401
    //    换成 HTML 时被 `poll` 的 catch 吞成 pending ⇒ 用户拿着永远不可能成功的
    //    二维码一直等（正是 IKVA90 的症状）。判据必须走**端到端轮询**，不能只测
    //    `parseIamEnvelope` 纯函数（那样测不到 `postIamJson` 的抛出）。
    const fetcher = iamFetch(async () => new Response('<html>denied</html>', {
      status: 401,
      headers: { 'Content-Type': 'text/html' },
    }))
    started = await startRaccoonLoginFlow({ fetcher: fetcher as unknown as typeof fetch })
    const base = originOf(started.loginUrl)
    const payload = await (await fetchLocal(`${base}${RACCOON_LOGIN_PAGE_PATHS.poll}`)).json() as {
      status: string
    }
    expect(payload.status).toBe('expired')
  })

  it('★★★ 签发失败后恢复：poll 必须把二维码补上（正向审计 P1-b）', async () => {
    // 场景：`/raccoon/login` 渲染时签发失败 ⇒ 页面拿到「二维码获取失败」兜底块；
    // 之后的某次 poll 里签发恢复成功 ⇒ 必须顺带补一张图，否则用户永远停在
    // 「获取失败」上、只能手动刷新。
    // 前两次签发都失败（`/raccoon/login` 一次 + 第一次 poll 一次），第三次才恢复。
    // ⚠️ 次数必须对齐清楚：`/login` 自己就消耗掉一次签发调用。
    let issueCalls = 0
    const fetcher = vi.fn(async (url: string) => {
      if (String(url).endsWith('/auth/mp/qrcode')) {
        issueCalls += 1
        return issueCalls <= 2
          ? jsonResponse({ code: 'INTERNAL', message: 'boom' }, 500)
          : jsonResponse({ code: 'OK', message: 'success', data: TICKET })
      }
      return jsonResponse({ code: 'OK', data: { status: 'pending' } })
    })
    started = await startRaccoonLoginFlow({ fetcher: fetcher as unknown as typeof fetch })
    const base = originOf(started.loginUrl)
    // ⚠️ **必须先走一次 `/raccoon/login`**：那是「页面拿到什么」的起点 ——
    //    签发失败时它渲染兜底块并把 `qrDelivered` 置 false。少了这一步，
    //    下面「poll 补图」的判据在「`qrDelivered` 恒 true」的变异下也照样绿
    //    （实测无牙：变异 `state.qrDelivered = true` 全绿）。
    const page = await fetchLocal(`${base}${RACCOON_LOGIN_PAGE_PATHS.login}`)
    expect(await page.text()).toContain('二维码获取失败')

    const first = await (await fetchLocal(`${base}${RACCOON_LOGIN_PAGE_PATHS.poll}`)).json() as {
      status: string
      qr?: string
      message?: string
    }
    expect(first.status).toBe('pending')
    expect(first.qr).toBeUndefined()
    expect(first.message).toContain('boom')

    const second = await (await fetchLocal(`${base}${RACCOON_LOGIN_PAGE_PATHS.poll}`)).json() as {
      status: string
      qr?: string
    }
    expect(second.status).toBe('pending')
    expect(second.qr).toContain('<svg')
  })

  it('★★ 二维码给过一次之后，普通 pending 不再重复下发（2 秒一轮别白传 SVG）', async () => {
    const fetcher = iamFetch(async () => jsonResponse({ code: 'OK', data: { status: 'pending' } }))
    started = await startRaccoonLoginFlow({ fetcher: fetcher as unknown as typeof fetch })
    const base = originOf(started.loginUrl)
    const first = await (await fetchLocal(`${base}${RACCOON_LOGIN_PAGE_PATHS.poll}`)).json() as {
      qr?: string
    }
    expect(first.qr).toContain('<svg')
    const second = await (await fetchLocal(`${base}${RACCOON_LOGIN_PAGE_PATHS.poll}`)).json() as {
      qr?: string
    }
    expect(second.qr).toBeUndefined()
  })

  it('★★★ 并发两次 poll 只签一次票（单飞；否则后一张覆盖前一张，用户扫的是废票）', async () => {
    // 触发面很平实：用户连点两次「重新加载」、或两个标签页同时打开。
    // 没有单飞时 `ensureTicket` 会被并发调用两次 ⇒ `issued: 2`，
    // 而页面上只画了最后一张 ⇒ 用户手机扫的可能是被覆盖掉的那张，表现为「扫了没反应」。
    let issueCalls = 0
    let started: { loginUrl: string } | undefined
    const fetcher = vi.fn(async (url: string) => {
      if (String(url).endsWith('/auth/mp/qrcode')) {
        issueCalls += 1
        // 让第一次签发**慢一点**：只有「先到先占位」的实现才能通过；
        // 若两次都各自 await，就会签出两张。
        await new Promise((resolve) => setTimeout(resolve, 20))
        return jsonResponse({ code: 'OK', message: 'success', data: TICKET })
      }
      return jsonResponse({ code: 'OK', data: { status: 'pending' } })
    })
    started = await startRaccoonLoginFlow({ fetcher: fetcher as unknown as typeof fetch })
    const base = originOf(started.loginUrl)

    const [a, b] = await Promise.all([
      fetchLocal(`${base}${RACCOON_LOGIN_PAGE_PATHS.poll}`),
      fetchLocal(`${base}${RACCOON_LOGIN_PAGE_PATHS.poll}`),
    ])
    expect(a.status).toBe(200)
    expect(b.status).toBe(200)
    expect(issueCalls).toBe(1)
    started.close?.()
  })

  it('★★ 页面脚本必须同时处理 canceled 与 expired（否则后端码、页面不换图）', () => {
    // ⚠️ `html` 是上一个 describe 的局部变量，这里必须自己渲染一份。
    const page = renderRaccoonLoginPage(RACCOON, {
      code: TICKET.qrcode_code,
      scanPath: TICKET.scan_path,
      expiresInMs: TICKET.expires_in * 1000,
      pollIntervalMs: TICKET.poll_interval * 1000,
    })
    // 纯 HTML 断言只能看源码；但这正是「页面少一个分支」这个缺陷的唯一可测面 ——
    // 本仓对**内联脚本**的既有做法就是源码断言（真正的行为级验证需要 DOM 环境）。
    // 判据写成**两个状态在同一行同一条件里**，杜绝「只加了一个分支」。
    expect(page).toContain("data.status === 'canceled' || data.status === 'expired'")
    // ⚠️ `if (data.qr) { … }` 在**两个分支**里各有一处（换图分支 + pending 兜底分支），
    //    只查单行时删掉 pending 那一处仍然绿（实测无牙）。判据必须锚**相邻两行**，
    //    这样「页面在普通 pending 里不再接管补图」才会变红。
    expect(page).toContain(
      'if (data.qr) { qrBox.innerHTML = data.qr; }\n      setQrStatus(\'等待扫码…\');',
    )
  })

  it('扫码成功时 result promise 解析出凭据', async () => {
    const exp = Math.floor(Date.now() / 1000) + 3600
    const token = jwtWithExp(exp)
    let polls = 0
    const fetcher = iamFetch(async () => {
      polls += 1
      return polls < 2
        ? jsonResponse({ code: 'OK', data: { status: 'pending' } })
        : jsonResponse({ code: 'OK', data: { status: 'success', access_token: token, refresh_token: 'r' } })
    })
    started = await startRaccoonLoginFlow({ fetcher: fetcher as unknown as typeof fetch })
    const base = originOf(started.loginUrl)
    await fetchLocal(`${base}${RACCOON_LOGIN_PAGE_PATHS.poll}`)
    await fetchLocal(`${base}${RACCOON_LOGIN_PAGE_PATHS.poll}`)
    const credential = await started.result
    expect(credential.access_token).toBe(token)
    expect(credential.refresh_token).toBe('r')
    expect(credential.expires_at).toBe(String(exp * 1000))
  })

  it('close() 后端口关闭（不再可访问）', async () => {
    const fetcher = iamFetch(async () => jsonResponse({ code: 'OK', data: { status: 'pending' } }))
    const flow = await startRaccoonLoginFlow({ fetcher: fetcher as unknown as typeof fetch })
    const url = flow.loginUrl
    await flow.close()
    await expect(fetch(url)).rejects.toThrow()
  })

  it('close() 后 result 被 reject（不留悬挂 promise）', async () => {
    const fetcher = iamFetch(async () => jsonResponse({ code: 'OK', data: { status: 'pending' } }))
    const flow = await startRaccoonLoginFlow({ fetcher: fetcher as unknown as typeof fetch })
    const pending = flow.result.catch((e: unknown) => e)
    await flow.close()
    const error = await pending
    expect(error).toBeInstanceOf(Error)
  })

  it('超时后 result 被 reject', async () => {
    const fetcher = iamFetch(async () => jsonResponse({ code: 'OK', data: { status: 'pending' } }))
    started = await startRaccoonLoginFlow({
      fetcher: fetcher as unknown as typeof fetch,
      timeoutMs: 60,
    })
    const error = await started.result.catch((e: unknown) => e)
    expect(error).toBeInstanceOf(Error)
    expect(String(error)).toMatch(/超时/)
  })

  it('短信发送端点拒绝空手机号', async () => {
    const fetcher = vi.fn(async () => jsonResponse({ code: 0, message: 'success' }))
    started = await startRaccoonLoginFlow({ fetcher: fetcher as unknown as typeof fetch })
    const base = originOf(started.loginUrl)
    const response = await fetchLocal(`${base}${RACCOON_LOGIN_PAGE_PATHS.smsSend}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: '' }),
    })
    expect(response.status).toBe(400)
  })

  it('短信发送端点成功时调用 send_sms（手机号在宿主侧加密）', async () => {
    const fetcher = vi.fn(async () => jsonResponse({ code: 0, message: 'success' }))
    started = await startRaccoonLoginFlow({ fetcher: fetcher as unknown as typeof fetch })
    const base = originOf(started.loginUrl)
    const response = await fetchLocal(`${base}${RACCOON_LOGIN_PAGE_PATHS.smsSend}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: '13800000000', captchaParam: 'cap' }),
    })
    expect(response.status).toBe(200)
    const call = fetcher.mock.calls.find((c) => String(c[0]).includes('/send_sms'))
    expect(call).toBeDefined()
    const body = JSON.parse(String((call?.[1] as RequestInit).body)) as Record<string, unknown>
    expect(body.phone).not.toBe('13800000000')
    expect(body.captcha_param).toBe('cap')
    expect(body.nation_code).toBe('86')
  })

  it('短信发送失败时返回可读原因且不终止流程', async () => {
    const fetcher = vi.fn(async () => jsonResponse(
      { code: 100006, message: 'captcha_verify_error' }, 400,
    ))
    started = await startRaccoonLoginFlow({ fetcher: fetcher as unknown as typeof fetch })
    const base = originOf(started.loginUrl)
    const response = await fetchLocal(`${base}${RACCOON_LOGIN_PAGE_PATHS.smsSend}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: '13800000000', captchaParam: 'bad' }),
    })
    const payload = await response.json() as { ok: boolean; message?: string }
    expect(payload.ok).toBe(false)
    expect(String(payload.message)).toMatch(/验证码/)
  })

  it('短信验证端点成功后 result 解析出凭据', async () => {
    const exp = Math.floor(Date.now() / 1000) + 3600
    const token = jwtWithExp(exp)
    const fetcher = iamFetch(async (url: string) => {
      if (String(url).includes('/send_sms')) return jsonResponse({ code: 0, message: 'success' })
      return jsonResponse({
        code: 0,
        data: { access_token: token, refresh_token: 'r', office_identity: 'personal' },
      })
    })
    started = await startRaccoonLoginFlow({ fetcher: fetcher as unknown as typeof fetch })
    const base = originOf(started.loginUrl)
    await fetchLocal(`${base}${RACCOON_LOGIN_PAGE_PATHS.smsSend}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: '13800000000', captchaParam: 'cap' }),
    })
    const response = await fetchLocal(`${base}${RACCOON_LOGIN_PAGE_PATHS.smsVerify}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ smsCode: '123456' }),
    })
    expect((await response.json() as { ok: boolean }).ok).toBe(true)
    const credential = await started.result
    expect(credential.access_token).toBe(token)
    expect(credential.office_identity).toBe('personal')
  })

  it('未发过短信就提交验证码时返回可读错误', async () => {
    const fetcher = vi.fn(async () => jsonResponse({ code: 0, message: 'success' }))
    started = await startRaccoonLoginFlow({ fetcher: fetcher as unknown as typeof fetch })
    const base = originOf(started.loginUrl)
    const response = await fetchLocal(`${base}${RACCOON_LOGIN_PAGE_PATHS.smsVerify}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ smsCode: '123456' }),
    })
    const payload = await response.json() as { ok: boolean; message?: string }
    expect(payload.ok).toBe(false)
    expect(String(payload.message)).toMatch(/手机验证码/)
  })

  it('验证码错误时不终止流程（用户可重试）', async () => {
    const fetcher = iamFetch(async (url: string) => {
      if (String(url).includes('/send_sms')) return jsonResponse({ code: 0, message: 'success' })
      return jsonResponse({ code: 100002, message: 'sms code invalid' }, 400)
    })
    started = await startRaccoonLoginFlow({ fetcher: fetcher as unknown as typeof fetch })
    const base = originOf(started.loginUrl)
    await fetchLocal(`${base}${RACCOON_LOGIN_PAGE_PATHS.smsSend}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: '13800000000', captchaParam: 'cap' }),
    })
    const first = await fetchLocal(`${base}${RACCOON_LOGIN_PAGE_PATHS.smsVerify}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ smsCode: '000000' }),
    })
    expect((await first.json() as { ok: boolean }).ok).toBe(false)
    // 再来一次仍应正常处理（未被上一次失败弄坏）
    const second = await fetchLocal(`${base}${RACCOON_LOGIN_PAGE_PATHS.smsVerify}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ smsCode: '000001' }),
    })
    expect(second.status).toBe(200)
  })

  it('未知路径返回 404', async () => {
    const fetcher = iamFetch(async () => jsonResponse({ code: 'OK', data: { status: 'pending' } }))
    started = await startRaccoonLoginFlow({ fetcher: fetcher as unknown as typeof fetch })
    const base = originOf(started.loginUrl)
    const response = await fetchLocal(`${base}/raccoon/nope`)
    expect(response.status).toBe(404)
  })

  it('轮询端点把二维码状态透传给页面（logging/canceled）', async () => {
    const fetcher = iamFetch(async () => jsonResponse({
      code: 'OK', data: { status: 'logging', expired_at: '2030-01-01T00:00:00Z' },
    }))
    started = await startRaccoonLoginFlow({ fetcher: fetcher as unknown as typeof fetch })
    const base = originOf(started.loginUrl)
    const response = await fetchLocal(`${base}${RACCOON_LOGIN_PAGE_PATHS.poll}`)
    const payload = await response.json() as { status: string; expiredAt?: string }
    expect(payload.status).toBe('logging')
    expect(payload.expiredAt).toBe('2030-01-01T00:00:00Z')
  })

  /**
   * ★★★ Gitee IKVA90 的两条页面级守卫。
   *
   * 背景：扫码链路 2026-11-14 迁到 IAM（服务端签发 `qr-<uuidv7>`），
   * 旧的「本地随机 32 位 hex」在新轮询端点上恒回 401，症状是
   * 「扫码后插件一直转圈、零报错」。下面两格分别锁住「签发失败」与
   * 「票据过期」这两条必须重签的路径。
   */
  it('★★ 签发失败时页面仍渲染（二维码区域显示可读原因 + 短信兜底）', async () => {
    const fetcher = vi.fn(async (url: string) => {
      if (String(url).endsWith('/auth/mp/qrcode')) {
        // 错误原因来自网络，必须转义 —— 这里塞一个真的 `<script>` 才测得动
        return jsonResponse({ code: 'INTERNAL', message: 'IAM 挂了 <script>alert(1)</script>' }, 500)
      }
      return jsonResponse({ code: 'OK', data: { status: 'pending' } })
    })
    started = await startRaccoonLoginFlow({ fetcher: fetcher as unknown as typeof fetch })
    const base = originOf(started.loginUrl)
    const html = await (await fetchLocal(`${base}${RACCOON_LOGIN_PAGE_PATHS.login}`)).text()

    expect(html).toContain('二维码获取失败')
    expect(html).toContain('短信登录')
    // 转义：原文里的 `<script>` 不许以可执行形态出现
    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toContain('<script>alert(1)')
    // ⚠️ 这里原本有一条 `expect(html).not.toMatch(/code=[0-9a-f]{32}/)`（「不许退回本地随机 code」）。
    // 它被**删除**了：`generateQrCode()` 已经从实现里移除，任何路径都不可能再产出
    // 32 位 hex 串 ⇒ 该断言**结构性恒真**，删掉它不会损失任何覆盖（对抗审计 P2）。
    // 「不许退回本地随机 code」真正的守卫是上面那条 `toContain('二维码获取失败')`
    // —— 只有签发失败才会渲染兜底块。
  })

  it('★★★ 轮询拿到 expired 时必须重签新票据，并把新二维码回给页面', async () => {
    let issued = 0
    const fetcher = vi.fn(async (url: string) => {
      if (String(url).endsWith('/auth/mp/qrcode')) {
        issued += 1
        return jsonResponse({
          code: 'OK',
          data: {
            qrcode_code: `qr-test-${issued}`,
            scan_path: '/login/mp',
            expires_in: 300,
            poll_interval: 2,
          },
        })
      }
      // 旧票据已失效 —— 若页面不重签，用户会永远卡在这张过期的二维码上
      return jsonResponse(
        { code: 'AUTH_QRCODE_INVALID', message: 'mini-program QR code invalid' },
        401,
      )
    })
    started = await startRaccoonLoginFlow({ fetcher: fetcher as unknown as typeof fetch })
    const base = originOf(started.loginUrl)
    const payload = await (await fetchLocal(`${base}${RACCOON_LOGIN_PAGE_PATHS.poll}`)).json() as {
      status: string
      qr?: string
    }

    expect(payload.status).toBe('expired')
    // ⚠️ 二维码是**编码后的图形**，里面没有明文 code —— 判据只能是
    // 「真签发了第二张」+「回给页面一个 SVG」。
    expect(issued).toBe(2)
    expect(payload.qr).toContain('<svg')
  })
})
