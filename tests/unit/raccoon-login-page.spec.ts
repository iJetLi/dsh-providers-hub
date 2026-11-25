import http from 'node:http'
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
 * 真发一个 HTTP 请求到本地页服务器，**可自定义 `Host` 与 `Sec-Fetch-*` 头**。
 *
 * `fetchLocal` 做不到这件事：`fetch` 不许改 `Host`，而来源闸门恰恰就是按
 * `Host` 与 `Sec-Fetch-Site` 判的 ⇒ 只能退到裸 `http.request`。
 */
function probeLocalStatus(
  port: number,
  pathname: string,
  headers: Record<string, string>,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method: 'GET', headers }, (res) => {
      res.resume()
      res.on('end', () => resolve(res.statusCode ?? 0))
    })
    req.on('error', reject)
    req.end()
  })
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
  it('路径都是 /raccoon 前缀', () => {
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

  it('★★ 浏览器登录是**默认那个 Tab**（扫码确认页 /login/mp 自 11-04 起全 404）', () => {
    // ⚠️ 默认停在扫码 Tab 上 = 用户点开就看到一个**必然 404** 的二维码。
    //   判据打在**初始状态**上（data-active / data-show 的取值），
    //   不是「页面上有这三个 Tab」（那三个都在，判不出默认是谁）。
    expect(html).toContain('<button id="tabBrowser" data-active="1" type="button">')
    expect(html).toContain('<div class="pane" id="paneBrowser" data-show="1">')
    expect(html).toContain('<button id="tabQr" data-active="0" type="button">')
    expect(html).toContain('<div class="pane" id="paneQr" data-show="0">')
    // 页面脚本在加载时也把 Tab 切到 browser（否则初始态与脚本态不一致）。
    // ⚠️ 这一条**不能**写成 `toContain("selectTab('browser');")`：同一个字符串在
    //   上面那个点击处理器里也有一份（`tabBrowser.addEventListener(…)`）⇒ 断言被
    //   它满足，把默认调用改成 `selectTab('qr')`、甚至包进 `if (false)` 都**全绿**
    //   （双审计各自实测）。判据必须是**最后一次**调用的实参，且要求它**独立成行**
    //   （包进 `if (false) { … }` 会让它变成复合语句、缩进也变 ⇒ 不再成立）。
    const tabCalls = [...html.matchAll(/selectTab\('(\w+)'\);/g)]
    expect(tabCalls.length).toBe(4) // 三个点击处理器 + 一次默认切换
    expect(tabCalls[tabCalls.length - 1]?.[1]).toBe('browser')
    expect(html).toContain("\n  selectTab('browser');\n")
  })

  it('三个 Tab 都在（扫码 / 短信 / 浏览器）', () => {
    expect(html).toContain('浏览器登录')
  })

  it('页面脚本只在 Tab 切换时改一处（判据写成「哪个」而不是两个布尔）', () => {
    // ⚠️ 加第三个 Tab 时，「两个布尔」写法必然漏改一处 ⇒ 判据钉住
    //   三个 Tab 都由**同一个** selectTab 驱动。
    expect(html).toContain("tabBrowser.addEventListener('click', function () { selectTab('browser'); });")
    expect(html).toContain("tabQr.addEventListener('click', function () { selectTab('qr'); });")
    expect(html).toContain("tabSms.addEventListener('click', function () { selectTab('sms'); });")
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

  it('★★ 二维码下方必须常驻「改用别的入口」提示（不是只在签发失败时才有）', () => {
    // 2026-11-14/15 实测：官方二维码落地页 `/login/mp` 全部 404，而**签发是成功的**
    // ⇒ 页面走不到 `.qr-fallback` 那条「获取失败」分支。提示若不常驻，
    // 用户扫进一个 404 页、界面上却没有任何一句告诉他可以改用别的入口。
    // ⚠️ 2026-11-17 起那条「别的入口」**首先**是「浏览器登录」（官方客户端
    // 自己那条链，唯一还活着的），短信是第二个兜底 ⇒ 提示句同时点两个。
    expect(html).toContain('扫完打不开页面？改用上方「浏览器登录」或下方「短信登录」')
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

/**
 * 浏览器授权的**整条链**（本地登录页 → 回环接收端 → 换码 → 凭据）。
 *
 * ## 为什么这条链要单测（而不是只测各段）
 *
 * 三个环节各自都对、串起来却不通，是这一族最常见的形态：
 * 页面打的路径与路由注册的不一致、状态字段名对不上、换码那段拿到的
 * 不是它以为的字段。⇒ 这里**真起**本地页 + **真起**回环接收端 +
 * **真发**回调，只把「换码」那一步换成注入的 fetch（零网络）。
 */
describe('浏览器登录（官方那条链）的整条流程', () => {
  const nowSec = Math.floor(Date.now() / 1000) + 3600
  const iamToken = (): string => {
    const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url')
    return `${b64({ alg: 'none' })}.${b64({ iss: 'xiaohuanxiong.com/iam', sub: 'acct-1', exp: nowSec })}.${b64({})}`
  }

  /** 造一个 fetch 桩：签发端点成功，换码端点回一对凭据。 */
  function authorizeFetch(record: string[] = []): typeof fetch {
    return vi.fn(async (url: string, init?: RequestInit) => {
      const text = String(url)
      if (text.endsWith('/auth/mp/qrcode')) {
        return jsonResponse({ code: 'OK', message: 'success', data: TICKET })
      }
      if (text.endsWith('/login_with_authorization_code')) {
        record.push(String(init?.body ?? ''))
        return jsonResponse({
          code: 0,
          // ⚠️ 值刻意**短于 16 位**：仓库的 PII 守卫会拦「凭据字段名 + 高熵
          //   字面量」这个组合（那正是真凭据的形状）。这里要的是一个**构造
          //   样例**，不是一枚看起来像凭据的东西。
          data: { access_token: iamToken(), refresh_token: 'r-from-gw' },
        })
      }
      return jsonResponse({ code: 0, data: {} })
    }) as unknown as typeof fetch
  }

  it('申请 → 回调 → 换码 ⇒ result 解析出凭据', async () => {
    const exchanged: string[] = []
    const opened: string[] = []
    started = await startRaccoonLoginFlow({
      fetcher: authorizeFetch(exchanged) as unknown as typeof fetch,
      // ⚠️ 单测里**绝不能真的开窗**（那是用户桌面上的真实浏览器，
      //   而且它会真的投递回调、消费掉接收端）—— 所以注入 spy 而不是真开；
      //   这里要断言的正是「它被调用了一次，拿到的就是那条 authorize URL」。
      openAuthorizePage: (url) => { opened.push(url) },
    })
    const base = originOf(started.loginUrl)

    // ① 申请一条 `/authorize` 链接（页面点「打开授权页」时走的那一步）。
    const start = await (await fetchLocal(`${base}${RACCOON_LOGIN_PAGE_PATHS.authorizeStart}`)).json() as {
      ok: boolean
      url: string
      status: string
    }
    expect(start.ok).toBe(true)
    expect(start.status).toBe('waiting')
    // URL 必须是官方页面认的那条形态。
    const parsed = new URL(start.url)
    expect(parsed.pathname).toBe('/authorize')
    expect(parsed.searchParams.get('login_source')).toBe('desktop')
    expect(parsed.searchParams.get('desktop_callback')).toBe('loopback')
    const redirect = parsed.searchParams.get('redirect') ?? ''
    expect(redirect).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/)

    // ★★ 宿主开浏览器那一步必须**真的被调用**、且拿到的就是这条 URL：
    //    删掉 `openAuthorizePage(receiver.authorizeUrl)` 那一行、或把注入点默认值
    //    改成空函数，都曾让 78 条全绿（用户点「浏览器登录」毫无反应而 CI 全绿）。
    expect(opened.length).toBe(1)
    expect(opened[0]).toBe(start.url)

    // ② 模拟官方页面的投递：GET 回环地址，带 code 与 state。
    const state = parsed.searchParams.get('state') ?? ''
    const callback = await fetchLocal(`${redirect}?code=the-auth-code&state=${state}`, {
      headers: { Origin: 'https://xiaohuanxiong.com', 'Sec-Fetch-Dest': 'document' },
    })
    expect(callback.status).toBe(200)

    // ③ 凭据落地（换码那条被注入的 fetch 收到的是那枚 code）。
    const credential = await started.result
    expect(credential.access_token).toBe(iamToken())
    expect(credential.refresh_token).toBe('r-from-gw')
    expect(exchanged.length).toBe(1)
    expect(JSON.parse(exchanged[0] ?? '{}')).toEqual({ authorization_code: 'the-auth-code' })

    // ④ 登录成功后**本地页服务器随即关闭**（既有契约：结果落定即关服务器）
    //    —— 页面那句「登录成功」因此是**尽力而为**的（页面 2 秒一轮，
    //    而换码 + 落定通常在它两拍之间就完成了）；真正的成功信号来自
    //    Jet Hub 那边的 `login.poll`。
    await expect(fetchLocal(`${base}${RACCOON_LOGIN_PAGE_PATHS.authorizeStatus}`)).rejects.toThrow()
  })

  it('★ 申请两次只起**一个**接收端（单飞；两个端口 = 两个「等着收凭据」的口子）', async () => {
    started = await startRaccoonLoginFlow({
      fetcher: authorizeFetch() as unknown as typeof fetch,
      openAuthorizePage: () => {},
    })
    const base = originOf(started.loginUrl)
    const first = await (await fetchLocal(`${base}${RACCOON_LOGIN_PAGE_PATHS.authorizeStart}`)).json() as { url: string }
    const second = await (await fetchLocal(`${base}${RACCOON_LOGIN_PAGE_PATHS.authorizeStart}`)).json() as { url: string }
    expect(second.url).toBe(first.url)
  })

  it('取消后状态回到 idle，且那一轮的接收端被关掉', async () => {
    started = await startRaccoonLoginFlow({
      fetcher: authorizeFetch() as unknown as typeof fetch,
      openAuthorizePage: () => {},
    })
    const base = originOf(started.loginUrl)
    await fetchLocal(`${base}${RACCOON_LOGIN_PAGE_PATHS.authorizeStart}`)
    await fetchLocal(`${base}${RACCOON_LOGIN_PAGE_PATHS.authorizeCancel}`)
    const status = await (await fetchLocal(`${base}${RACCOON_LOGIN_PAGE_PATHS.authorizeStatus}`)).json() as {
      status: string
      reason?: string
    }
    expect(status.status).toBe('idle')
    // ⚠️ 取消**不该**留下失败原因词。把「先 cancel 再置 idle」的顺序换回来时，
    //   终态仍是 idle（`handleRequest` 最后又置了一次），**只有**残留的 `reason`
    //   能暴露那个坑 —— 当时这条判据不存在，变异全绿。
    expect(status.reason).toBeUndefined()
  })

  it('★★ 换码失败时**不产出凭据**，且只报**原因词**（不泄报文）', async () => {
    const failing = vi.fn(async (url: string) => {
      const text = String(url)
      if (text.endsWith('/auth/mp/qrcode')) {
        return jsonResponse({ code: 'OK', message: 'success', data: TICKET })
      }
      // 上游回 200035，并把那枚 code 原文回显在 message 里。
      return jsonResponse({ code: 200035, message: 'authorization code the-auth-code not found' }, 400)
    }) as unknown as typeof fetch
    started = await startRaccoonLoginFlow({
      fetcher: failing,
      openAuthorizePage: () => {},
    })
    const base = originOf(started.loginUrl)
    const start = await (await fetchLocal(`${base}${RACCOON_LOGIN_PAGE_PATHS.authorizeStart}`)).json() as {
      url: string
    }
    const parsed = new URL(start.url)
    const redirect = parsed.searchParams.get('redirect') ?? ''
    const state = parsed.searchParams.get('state') ?? ''
    await fetchLocal(`${redirect}?code=the-auth-code&state=${state}`, {
      headers: { Origin: 'https://xiaohuanxiong.com', 'Sec-Fetch-Dest': 'document' },
    })
    // ⚠️⚠️ **换码失败 ⇒ 流程立刻落定**（2026-11-17 修）⇒ **本地页服务器随之
    //   关闭**（既有契约：结果落定即关服务器）⇒ 所以**不能**再轮询
    //   `/raccoon/authorize/status`（那个端口已经没了）。
    //   失败信息在**落定的那个错误**里。
    const settled = await started.result.then(
      () => 'resolved',
      (error: unknown) => `rejected:${error instanceof Error ? error.message : String(error)}`,
    )
    expect(settled.startsWith('rejected:')).toBe(true)
    // ⚠️ 只报**原因词**（换码的报文可能回显那枚授权码）。
    expect(settled).toContain('code_not_found')
    expect(settled).not.toContain('the-auth-code')
  })

  it('★★★ 换码失败时**流程必须落定**（不落定 ⇒ 前端只会转圈 5 分钟）', async () => {
    // ⚠️⚠️ **真实缺陷**（2026-11-17 修）：换码失败时只写了状态、**没有**让
    //   流程落定 ⇒ `result` 永远悬挂 ⇒ `jet-hub-rpc.ts` 里的
    //   `raccoonStarted.result.then(...)` 永远不跑 ⇒ **占位账号条目永远
    //   留着**、前端 `login.poll` 一直转圈到它自己的 5 分钟上限。
    //   而页面那边**已经**显示了「授权码已失效」⇒ 两边的症状不同形。
    const failing = vi.fn(async (url: string) => {
      const text = String(url)
      if (text.endsWith('/auth/mp/qrcode')) {
        return jsonResponse({ code: 'OK', message: 'success', data: TICKET })
      }
      return jsonResponse({ code: 200035, message: 'not found' }, 400)
    }) as unknown as typeof fetch
    started = await startRaccoonLoginFlow({ fetcher: failing, openAuthorizePage: () => {} })
    const base = originOf(started.loginUrl)
    const start = await (await fetchLocal(`${base}${RACCOON_LOGIN_PAGE_PATHS.authorizeStart}`)).json() as {
      url: string
    }
    const parsed = new URL(start.url)
    await fetchLocal(`${parsed.searchParams.get('redirect') ?? ''}?code=the-auth-code&state=${parsed.searchParams.get('state') ?? ''}`, {
      headers: { Origin: 'https://xiaohuanxiong.com', 'Sec-Fetch-Dest': 'document' },
    })
    // ⚠️ 判据是「**落定了**」，不是「落定成什么」：失败必须**reject**
    //   （成功是 resolve），而**不能**是永远悬挂。
    const settled = await Promise.race([
      started.result.then(() => 'resolved').catch((error: unknown) => `rejected:${error instanceof Error ? error.message : String(error)}`),
      new Promise<string>((resolve) => setTimeout(() => resolve('HANGING'), 2_000)),
    ])
    expect(settled, '流程必须落定（reject 即可），不能永远悬挂').not.toBe('HANGING')
    expect(settled.startsWith('rejected:')).toBe(true)
    // ⚠️ 失败原因**只报原因词**：报文可能回显那枚授权码。
    expect(settled).toContain('code_not_found')
    expect(settled).not.toContain('the-auth-code')
  })

  it('★★★ 流程落定后，回环接收端**必须已死**（授权码是一次性凭据）', async () => {
    // ⚠️⚠️⚠️ **真实安全缺陷**（2026-11-17 修）：回环接收端原本**只在**
    //   `close()` 里被关掉，而 **`close()` 全仓无人调用** ⇒ 流程从**任何
    //   别的路径**落定（授权换码成功 / **短信登录成功** / 扫码成功）时，
    //   那个「等着收凭据」的口子**留着整整 5 分钟**（接收端自己的超时），
    //   实测还能在流程结束后**真的**再换一次码。
    //
    // ⚠️ 判据是**行为级**的「那个端口还在不在」—— 断言源码里出现
    //   `cancel()` 是**源码文本断言**，改个写法就假红（本仓记过的坑）。
    const smsFetcher = vi.fn(async (url: string) => {
      const text = String(url)
      if (text.endsWith('/auth/mp/qrcode')) {
        return jsonResponse({ code: 'OK', message: 'success', data: TICKET })
      }
      if (text.endsWith('/login_with_sms')) {
        return jsonResponse({ code: 0, data: { access_token: 'sms.tok.en', refresh_token: 'r2' } })
      }
      return jsonResponse({ code: 0, data: {} })
    }) as unknown as typeof fetch
    started = await startRaccoonLoginFlow({ fetcher: smsFetcher, openAuthorizePage: () => {} })
    const base = originOf(started.loginUrl)
    const start = await (await fetchLocal(`${base}${RACCOON_LOGIN_PAGE_PATHS.authorizeStart}`)).json() as {
      url: string
    }
    const redirect = new URL(start.url).searchParams.get('redirect') ?? ''
    const port = Number(new URL(redirect).port)

    // ① 先确认那个端口**此刻**是活的（否则这条用例测不到任何东西）。
    const aliveBefore = await fetch(`http://127.0.0.1:${port}/probe`).then(() => true).catch(() => false)
    expect(aliveBefore, '回环端口此刻应当在监听（否则本用例恒真）').toBe(true)

    // ② 改走短信登录并成功 ⇒ 流程落定（**不是**走授权那条路）。
    await fetchLocal(`${base}${RACCOON_LOGIN_PAGE_PATHS.smsSend}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: '13800138000', captchaParam: 'x' }),
    })
    await fetchLocal(`${base}${RACCOON_LOGIN_PAGE_PATHS.smsVerify}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ smsCode: '123456' }),
    })
    await started.result

    // ③ ★ 落定之后，那个「等着收凭据」的口子必须**已经关掉**。
    const aliveAfter = await fetch(`http://127.0.0.1:${port}/probe`).then(() => true).catch(() => false)
    expect(aliveAfter, '流程落定后回环接收端必须已死（否则本机进程可投递一枚 code 换走凭据）').toBe(false)
  })

  it('★★ 本地页端点只接受本机回环 `Host`（挡 DNS rebinding 读走 state）', async () => {
    // 同源策略挡不住 rebinding：把 evil.example 解析到 127.0.0.1 之后浏览器就把它
    // 当同源 ⇒ 攻击者页面能读到 `state`（接收端只有这一道边界）。判据按 Host 收窄。
    started = await startRaccoonLoginFlow({
      fetcher: authorizeFetch() as unknown as typeof fetch,
      openAuthorizePage: () => {},
    })
    const base = originOf(started.loginUrl)
    const port = Number(new URL(base).port)
    const evil = await probeLocalStatus(port, RACCOON_LOGIN_PAGE_PATHS.authorizeStart, { Host: 'evil.example' })
    expect(evil).toBe(403)
    // 判据不是「一律拒绝」：本机回环 Host 照常放行。
    const good = await (await fetchLocal(`${base}${RACCOON_LOGIN_PAGE_PATHS.authorizeStart}`)).json() as { ok: boolean }
    expect(good.ok).toBe(true)
  })

  it('★★ 跨站的 `Sec-Fetch-Site` 被拒（恶意页面用 img/fetch 打本机端点）', async () => {
    started = await startRaccoonLoginFlow({
      fetcher: authorizeFetch() as unknown as typeof fetch,
      openAuthorizePage: () => {},
    })
    const base = originOf(started.loginUrl)
    const port = Number(new URL(base).port)
    /**
     * ⚠️ **`same-site` 从拒绝列表里移除了**（GitHub issue #159 修正本用例的假设）。
     *
     * 原用例把 `same-site` 与 `cross-site` 一起判为恶意，**这个假设是错的**：
     *
     * Jet Hub 的 Web GUI 在 **`127.0.0.1:3080`**，它点「添加账号」打开
     * `127.0.0.1:<随机端口>/raccoon/login` ⇒ 两个 URL **同 host、不同 port**
     * ⇒ 浏览器按规范标 **`same-site`**。真实报障请求头：
     *
     * ```
     * Host: 127.0.0.1:39631
     * Referer: http://127.0.0.1:3080/
     * Sec-Fetch-Site: same-site      ← 原实现拒了 ⇒ 任何 Web GUI 用户都 403
     * ```
     *
     * **`same-site` 的真实恶意面 = 「攻击者已在 `127.0.0.1` 上起了另一个端口的服务」**
     * —— 那已经意味着本机沦陷，防线早已不存在。而挡 DNS rebinding 靠的是**上面那条
     * `Host` 校验**（`evil.example` → `127.0.0.1` 时 `Host` 是 `evil.example:<port>`）：
     *
     * - `evil.example` 页面打 `http://127.0.0.1:<port>` ⇒ `Host` 是 `127.0.0.1:<port>`
     *   但 `Sec-Fetch-Site` 是 **`cross-site`** ⇒ 由本条拒绝 ✅
     * - `evil.example` 直接请求 `http://evil.example:<port>`（rebinding）⇒
     *   **`Host` 是 `evil.example:<port>`** ⇒ 由 `Host` 校验拒绝 ✅
     */
    for (const site of ['cross-site']) {
      const rejected = await probeLocalStatus(port, RACCOON_LOGIN_PAGE_PATHS.authorizeStart, { 'Sec-Fetch-Site': site })
      expect(rejected, site).toBe(403)
    }
    // 用户直接在地址栏打开 `loginUrl`（`none`）必须放行 —— 否则第一条链就断了。
    const viaAddressBar = await probeLocalStatus(port, RACCOON_LOGIN_PAGE_PATHS.login, { 'Sec-Fetch-Site': 'none' })
    expect(viaAddressBar).toBe(200)
    // 页面自己发的 fetch（`same-origin`）也必须放行。
    const viaPage = await probeLocalStatus(port, RACCOON_LOGIN_PAGE_PATHS.authorizeStatus, { 'Sec-Fetch-Site': 'same-origin' })
    expect(viaPage).toBe(200)
    /**
     * ★★★ **`same-site` 必须放行**（issue #159 的本体）。
     *
     * 这是 **Jet Hub Web GUI（`:3080`）跨端口打开登录页**的真实形态 ——
     * 带真实报障请求里的 `Referer`。原实现 403，导致任何 Web GUI 用户都加不了账号。
     */
    const viaWebGui = await probeLocalStatus(port, RACCOON_LOGIN_PAGE_PATHS.login, {
      'Sec-Fetch-Site': 'same-site',
      Referer: 'http://127.0.0.1:3080/',
    })
    expect(viaWebGui, 'issue #159：Web GUI 跨端口打开必须放行').toBe(200)
  })

  it('★ 来源闸门**不**误伤不带 `Sec-Fetch-*` 的客户端（非浏览器与测试替身）', async () => {
    // 闸门只能是「信息可得时才判」：fail-closed 会把整条登录链锁死在这类客户端上。
    started = await startRaccoonLoginFlow({
      fetcher: authorizeFetch() as unknown as typeof fetch,
      openAuthorizePage: () => {},
    })
    const base = originOf(started.loginUrl)
    const port = Number(new URL(base).port)
    const noHeaders = await probeLocalStatus(port, RACCOON_LOGIN_PAGE_PATHS.authorizeStatus, {})
    expect(noHeaders).toBe(200)
  })

  /**
   * ★★ 「新建账号时自动打开浏览器授权页」关闭态（2026-11-23）。
   *
   * 判据必须打在**「宿主有没有真的开窗」**上（注入的 spy 被调用与否），
   * 以及响应里那两个字段 —— 页面靠它们分流文案。只断言「URL 仍返回」不够：
   * 那在「照旧自动开窗」的实现下也成立。
   */
  it('★★ 关闭时：不调用 openAuthorizePage，但仍返回 URL，并回报 opened=false / autoOpen=false', async () => {
    const opened: string[] = []
    started = await startRaccoonLoginFlow({
      fetcher: authorizeFetch() as unknown as typeof fetch,
      openAuthorizePage: (url) => { opened.push(url) },
      autoOpenBrowser: () => false,
    })
    const base = originOf(started.loginUrl)
    const start = await (await fetchLocal(`${base}${RACCOON_LOGIN_PAGE_PATHS.authorizeStart}`)).json() as {
      ok: boolean
      url: string
      opened: boolean
      autoOpen: boolean
    }
    expect(start.ok).toBe(true)
    expect(start.url).toContain('/authorize')
    expect(start.autoOpen, 'autoOpen 必须如实回报 false（页面据此显示复制提示）').toBe(false)
    expect(start.opened).toBe(false)
    expect(opened, '关闭「自动打开浏览器」后宿主不得 spawn 浏览器').toEqual([])
  })

  it('★★ 开启时（缺省）：照旧开窗一次，并回报 opened=true / autoOpen=true', async () => {
    const opened: string[] = []
    started = await startRaccoonLoginFlow({
      fetcher: authorizeFetch() as unknown as typeof fetch,
      openAuthorizePage: (url) => { opened.push(url) },
    })
    const base = originOf(started.loginUrl)
    const start = await (await fetchLocal(`${base}${RACCOON_LOGIN_PAGE_PATHS.authorizeStart}`)).json() as {
      url: string
      opened: boolean
      autoOpen: boolean
    }
    expect(start.autoOpen).toBe(true)
    expect(start.opened).toBe(true)
    expect(opened.length, '缺省（开）必须与改动前逐字节相同：宿主开窗一次').toBe(1)
    expect(opened[0]).toBe(start.url)
  })

  it('★ 二次申请（单飞复用）：URL 相同但 opened=false（本次没有新开窗）', async () => {
    const opened: string[] = []
    started = await startRaccoonLoginFlow({
      fetcher: authorizeFetch() as unknown as typeof fetch,
      openAuthorizePage: (url) => { opened.push(url) },
    })
    const base = originOf(started.loginUrl)
    const first = await (await fetchLocal(`${base}${RACCOON_LOGIN_PAGE_PATHS.authorizeStart}`)).json() as {
      url: string
      opened: boolean
    }
    const second = await (await fetchLocal(`${base}${RACCOON_LOGIN_PAGE_PATHS.authorizeStart}`)).json() as {
      url: string
      opened: boolean
    }
    expect(second.url).toBe(first.url)
    expect(first.opened).toBe(true)
    expect(second.opened, '复用时没有新开窗 ⇒ 页面应说「浏览器没自动打开？点下面链接」').toBe(false)
    expect(opened.length).toBe(1)
  })
})

/**
 * ★★★ **`Sec-Fetch-Site: same-site` 必须放行**（GitHub issue #159）。
 *
 * ## 缺陷
 *
 * 原闸门只允许 `same-origin` / `none`，把 **`same-site` 拒了**。
 *
 * 而 **Jet Hub 的 Web GUI（`127.0.0.1:3080`）里点「添加账号」**，浏览器打开
 * `127.0.0.1:<随机端口>/raccoon/login` —— 两个 URL **同 host、不同 port**
 * ⇒ 浏览器按 Fetch Metadata 规范标 **`same-site`**（`same-origin` 要求
 * scheme+host+**port** 全同）。
 *
 * 真实报障请求头：
 *
 * ```
 * Host: 127.0.0.1:39631
 * Referer: http://127.0.0.1:3080/
 * Sec-Fetch-Site: same-site      ← 被拒 ⇒ 403「请求来源不是本机登录页」
 * ```
 *
 * ⇒ **任何人在 Web GUI 里点「添加账号」都会 403**。
 *
 * ## 为什么放行 `same-site` 安全
 *
 * 这道闸门防 **DNS rebinding**（`evil.example` → `127.0.0.1`）。那种情况下
 * **`Host` 是 `evil.example:<port>`** ⇒ **上面那条 `Host` 校验已经拒掉**；
 * 且 `Sec-Fetch-Site` 会是 `cross-site`，仍被本条拒绝。
 *
 * ⇒ **`Host` 是本闸门的主判据**，放行 `same-site` 不降低对 `cross-site` 的拦截。
 */
describe('本机回环来源闸门（issue #159）', () => {
  it('★★★ Sec-Fetch-Site: same-site（Web GUI 跨端口）⇒ 必须放行', async () => {
    const fetcher = iamFetch(async () => jsonResponse({ code: 'OK', data: { status: 'pending' } }))
    started = await startRaccoonLoginFlow({ fetcher: fetcher as unknown as typeof fetch })
    const port = Number(new URL(started.loginUrl).port)
    const status = await probeLocalStatus(port, RACCOON_LOGIN_PAGE_PATHS.login, {
      host: `127.0.0.1:${port}`,
      'sec-fetch-site': 'same-site',
      // 真实报障请求里就有这个 Referer（Web GUI 的 3080 端口）
      referer: 'http://127.0.0.1:3080/',
    })
    expect(status, 'issue #159：Web GUI(3080) 跨端口打开必须放行，不能 403').toBe(200)
  })

  it('★★ cross-site ⇒ 仍必须 403（DNS rebinding 防线不得降低）', async () => {
    const fetcher = iamFetch(async () => jsonResponse({ code: 'OK', data: { status: 'pending' } }))
    started = await startRaccoonLoginFlow({ fetcher: fetcher as unknown as typeof fetch })
    const port = Number(new URL(started.loginUrl).port)
    const status = await probeLocalStatus(port, RACCOON_LOGIN_PAGE_PATHS.login, {
      host: `127.0.0.1:${port}`,
      'sec-fetch-site': 'cross-site',
    })
    expect(status, 'cross-site 必须拒（DNS rebinding 防线）').toBe(403)
  })

  it('★★ Host 不是 127.0.0.1:<port> ⇒ 仍必须 403', async () => {
    const fetcher = iamFetch(async () => jsonResponse({ code: 'OK', data: { status: 'pending' } }))
    started = await startRaccoonLoginFlow({ fetcher: fetcher as unknown as typeof fetch })
    const port = Number(new URL(started.loginUrl).port)
    // 复刻 DNS rebinding：Host 是攻击者域名，但连接指向 127.0.0.1
    const status = await probeLocalStatus(port, RACCOON_LOGIN_PAGE_PATHS.login, {
      host: `evil.example:${port}`,
      'sec-fetch-site': 'same-site',
    })
    expect(status, 'Host 校验是主判据，必须拒').toBe(403)
  })
})
