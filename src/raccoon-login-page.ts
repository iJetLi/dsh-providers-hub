/**
 * Raccoon Work 本地登录页（宿主侧承载弹窗页）。
 *
 * ## 为什么需要本地服务器
 *
 * 官方桌面端的登录靠 `office-raccoon://auth/callback` 自定义协议回调，
 * 而本插件是宿主侧 Node 进程，**收不到该回调**；`/code/authorize` 页面的
 * 回调地址又是写死的，改不成 localhost。故改为：
 *
 * ```
 * 本地服务器（127.0.0.1:随机端口）
 *   GET  /raccoon/login       → 弹窗页：Tab 切换「微信扫码 / 短信登录」
 *   GET  /raccoon/poll        → 前端轮询登录状态（宿主侧持有 qrcode_code）
 *   POST /raccoon/sms/send    → 提交手机号 + 阿里云 captcha_param
 *   POST /raccoon/sms/verify  → 提交验证码完成登录
 * ```
 *
 * 微信扫码的 `code` 由 **IAM 服务端签发**（`POST /api/iam/v1/auth/mp/qrcode`）。
 *
 * ⚠️ 2026-11-14 起**不能**再本地随机生成：旧端点
 * `/api/web/auth/v1/login_with_qrcode_code` 已成僵尸（对任意字符串恒回
 * `pending`、不再推进状态），新端点会直接拒发非签发 code（Gitee IKVA90）。
 *
 * ## 与其余 provider 的契约一致性
 *
 * 对外仍返回 `loginUrl`（指向本地 `/raccoon/login`），前端照常 `window.open`
 * —— 与 codearts / lobsterai / qoder / trae / cline / loomy 的「两步式」
 * 体验完全一致。
 *
 * ## ⚠️ 职责边界（安全约束）
 *
 * - **宿主侧**持有全部敏感状态：`qrcode_code`、手机号、凭据
 * - **页面侧**只做展示与表单提交：**不知道** `phoneCipherSecret`、token 等秘密
 * - 二维码由**宿主侧**生成 SVG 内联进 HTML（页面不需要任何 QR 逻辑，也不需要 CDN）
 * - 手机号加密在宿主侧的 `/raccoon/sms/send` 里完成
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import {
  RACCOON_LOGIN_TIMEOUT_MS,
  RACCOON_QR_POLL_INTERVAL_MS,
  type RaccoonCredential,
} from './raccoon.js'
import {
  buildQrImageUrl,
  createRaccoonQrTicket,
  loginRaccoonWithSmsCode,
  pollRaccoonQrLogin,
  sendRaccoonSmsCode,
  type RaccoonQrTicket,
} from './raccoon-oauth.js'
import { RACCOON, type RaccoonProduct } from './raccoon-product.js'
import { renderQrSvg } from './raccoon-qr.js'

/** 本地登录页的路径。 */
export const RACCOON_LOGIN_PAGE_PATHS = {
  login: '/raccoon/login',
  poll: '/raccoon/poll',
  smsSend: '/raccoon/sms/send',
  smsVerify: '/raccoon/sms/verify',
} as const

/** 一次登录流程的句柄。 */
export interface StartedRaccoonLoginFlow {
  /** 弹窗地址（本地服务器）。 */
  loginUrl: string
  /** 登录结果（凭据）。 */
  result: Promise<RaccoonCredential>
  /** 主动关闭本地服务器。 */
  close: () => Promise<void>
}

/** 流程内部状态（**只存在于宿主侧**）。 */
interface FlowState {
  /**
   * 页面是否**已经**拿到过二维码的 SVG。
   *
   * ⚠️ 这个字段存在的唯一理由是「签发失败 → 恢复」这条路径：`/raccoon/login` 渲染时
   *    若 `ticket === undefined`，页面拿到的是「二维码获取失败」的兜底块；之后某次
   *    `ensureTicket` 恢复成功，`/raccoon/poll` 只回 `{ status: 'pending' }` ⇒ 页面
   *    没有任何理由重绘 ⇒ 用户永远停在「获取失败」（必须手动刷新）。
   *    所以 poll 侧要知道「这面页面上现在有没有码」，没有就顺带补一张。
   * 代价：每次签发/换图只多发一次 SVG，不是每轮轮询都发（2 秒一轮会白烧流量）。
   */
  qrDelivered?: boolean
  /**
   * 扫码票据（**服务端签发**，见 `createRaccoonQrTicket`）。
   *
   * ⚠️ 懒签发：`startRaccoonLoginFlow` 必须**立即返回 `loginUrl`**（否则
   * `window.open` 会跑出用户手势窗口），所以第一次签发发生在页面请求
   * `/raccoon/login` 时。
   */
  ticket?: RaccoonQrTicket
  /** 最近一次申请票据失败的原因（页面据此展示可读错误 + 短信兜底提示）。 */
  ticketError?: string
  /**
   * 正在飞的签发请求（单飞表）。
   *
   * ⚠️ 用户连点两次「重新加载」/ 两个标签页同时轮询时 `ensureTicket` 会被并发调用；
   * 没有它就会**签出两张票**、后一张覆盖前一张，而用户扫的可能是被覆盖的那张
   * ⇒ 表现为「扫了没反应」（对抗审计 P2 实测 `issued: 2`）。
   */
  ticketInflight?: Promise<RaccoonQrTicket | undefined>
  /** 当前展示的短信目标手机号（未发过短信时为空）。 */
  phone: string
}

/**
 * 确保当前流程有一张可用票据（没有就签一张）。
 *
 * ⚠️ 签发失败**不抛**：登录页必须仍能渲染出来（短信 Tab 是可用的兜底），
 * 只在二维码区域显示原因。若这里抛，用户连短信登录都进不去。
 *
 * ⚠️ 失败后**不缓存**（`ticket` 保持 `undefined`）⇒ 下一次轮询会重试签发，
 * 网络抖动恢复后自动可用。
 */
async function ensureTicket(
  state: FlowState,
  product: RaccoonProduct,
  fetcher: typeof fetch,
): Promise<RaccoonQrTicket | undefined> {
  if (state.ticket !== undefined) return state.ticket
  // 已经有请求在飞 ⇒ 复用同一张票（并发两次调用只签一次）
  if (state.ticketInflight !== undefined) return state.ticketInflight
  const inflight = (async (): Promise<RaccoonQrTicket | undefined> => {
    try {
      const ticket = await createRaccoonQrTicket(product, fetcher)
      state.ticket = ticket
      state.ticketError = undefined
      return ticket
    } catch (error) {
      state.ticketError = error instanceof Error ? error.message : String(error)
      return undefined
    } finally {
      state.ticketInflight = undefined
    }
  })()
  state.ticketInflight = inflight
  return inflight
}

/** `startRaccoonLoginFlow` 的选项。 */
export interface RaccoonLoginFlowOptions {
  product?: RaccoonProduct
  /** 注入的 fetch（测试用）。 */
  fetcher?: typeof fetch
  /** 超时（毫秒）。 */
  timeoutMs?: number
}

/**
 * 启动登录流程。
 *
 * 立即返回 `loginUrl` 与 `result` promise，**不阻塞** —— 与其余 provider 的
 * 「两步式」约束一致（`window.open` 只在用户手势窗口内有效）。
 */
export async function startRaccoonLoginFlow(
  options: RaccoonLoginFlowOptions = {},
): Promise<StartedRaccoonLoginFlow> {
  const product = options.product ?? RACCOON
  const fetcher = options.fetcher ?? fetch
  const state: FlowState = {
    phone: '',
  }

  let resolveResult!: (value: RaccoonCredential) => void
  let rejectResult!: (reason: unknown) => void
  const result = new Promise<RaccoonCredential>((resolve, reject) => {
    resolveResult = resolve
    rejectResult = reject
  })
  // 先挂空处理器：这个 promise 可能在被消费前就 reject（用户极快失败/立刻关闭），
  // 那一段窗口里 Node 会报 unhandled rejection（与 loomy-wechat-login 同因）。
  result.catch(() => {})

  let settled = false
  const settleOk = (value: RaccoonCredential): void => {
    if (settled) return
    settled = true
    resolveResult(value)
  }
  const settleErr = (error: unknown): void => {
    if (settled) return
    settled = true
    rejectResult(error)
  }

  const server = createServer((request, response) => {
    void handleRequest(request, response, { state, product, fetcher, settleOk }).catch(
      (error: unknown) => {
        try {
          response
            .writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
            .end(`内部错误：${error instanceof Error ? error.message : String(error)}`)
        } catch {
          // 响应可能已发出，忽略
        }
      },
    )
  })

  const port = await listenOnRandomPort(server)
  const loginUrl = `http://127.0.0.1:${port}${RACCOON_LOGIN_PAGE_PATHS.login}`

  let closed = false
  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    // 尚未落定则先 reject，避免调用方拿到一个永远悬挂的 promise。
    settleErr(new Error('raccoon: 登录流程已关闭'))
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
    })
  }

  const timeoutMs = options.timeoutMs ?? RACCOON_LOGIN_TIMEOUT_MS
  const timer = setTimeout(() => {
    settleErr(new Error(`raccoon: 登录超时（${Math.round(timeoutMs / 1000)} 秒内未完成）`))
  }, timeoutMs)
  timer.unref?.()

  // 结果落定即关服务器（含超时与失败路径）。
  void result
    .catch(() => {})
    .finally(() => {
      clearTimeout(timer)
      if (!closed) {
        closed = true
        void new Promise<void>((resolve) => {
          server.close(() => resolve())
        })
      }
    })

  return { loginUrl, result, close }
}

/** 一次请求的依赖集合。 */
interface HandleDeps {
  state: FlowState
  product: RaccoonProduct
  fetcher: typeof fetch
  settleOk: (value: RaccoonCredential) => void
}

/** 处理一次本地请求。 */
async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  deps: HandleDeps,
): Promise<void> {
  const url = new URL(request.url ?? '/', `http://127.0.0.1:${request.socket.localPort ?? 0}`)
  const { state, product } = deps

  if (url.pathname === RACCOON_LOGIN_PAGE_PATHS.login) {
    const ticket = await ensureTicket(state, product, deps.fetcher)
    state.qrDelivered = ticket !== undefined
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end(renderRaccoonLoginPage(product, ticket, state.ticketError))
    return
  }

  if (url.pathname === RACCOON_LOGIN_PAGE_PATHS.poll) {
    const ticket = await ensureTicket(state, product, deps.fetcher)
    // 连票据都没有（签发失败）⇒ 报 `pending` 让页面继续轮询重试，
    // 同时把原因带回去，避免用户只看一个空白二维码框。
    if (ticket === undefined) {
      writeJson(response, {
        status: 'pending',
        ...state.ticketError !== undefined ? { message: state.ticketError } : {},
      })
      return
    }
    const polled = await pollRaccoonQrLogin(product, ticket.code, deps.fetcher)
    if (polled.status === 'success' && polled.accessToken !== undefined) {
      const credential: RaccoonCredential = {
        access_token: polled.accessToken,
        refresh_token: polled.refreshToken ?? '',
        ...polled.expiresAt !== undefined ? { expires_at: polled.expiresAt } : {},
      }
      deps.settleOk(credential)
      writeJson(response, { status: 'success' })
      return
    }
    // `canceled`（用户取消）与 `expired`（二维码过期/被消耗）都必须**重签**，
    // 否则页面上的二维码永久不可用 —— 这正是「扫码后一直转圈」的另一个入口。
    const needsRenewal = polled.status === 'canceled' || polled.status === 'expired'
    let renewed: RaccoonQrTicket | undefined
    if (needsRenewal) {
      state.ticket = undefined
      renewed = await ensureTicket(state, product, deps.fetcher)
    }
    // 页面何时需要一张新图：①本轮换过票据；②此前因为签发失败而**没拿到过**码
    // （`/raccoon/login` 渲染的是兜底块，之后 `ensureTicket` 恢复成功）。
    const needsQr = renewed !== undefined || state.qrDelivered !== true
    const qrSvg = needsQr ? renderQrSvg(buildQrImageUrl(product, renewed ?? ticket)) : undefined
    if (qrSvg !== undefined) state.qrDelivered = true
    writeJson(response, {
      status: polled.status,
      ...polled.expiredAt !== undefined ? { expiredAt: polled.expiredAt } : {},
      ...state.ticketError !== undefined ? { message: state.ticketError } : {},
      // 换图/补图时把新二维码给页面（页面据此替换 `<svg>`）
      ...qrSvg !== undefined ? { qr: qrSvg } : {},
    })
    return
  }

  if (url.pathname === RACCOON_LOGIN_PAGE_PATHS.smsSend && request.method === 'POST') {
    const body = await readJsonBody(request)
    const phone = typeof body.phone === 'string' ? body.phone.trim() : ''
    const captchaParam = typeof body.captchaParam === 'string' ? body.captchaParam : ''
    if (!/^1[3-9]\d{9}$/.test(phone)) {
      response.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify({ ok: false, message: '请输入有效的 11 位手机号' }))
      return
    }
    try {
      await sendRaccoonSmsCode(product, phone, captchaParam, deps.fetcher)
      // 只在发送成功后才记住手机号：否则后续 verify 会用一个没收到验证码的号码
      state.phone = phone
      writeJson(response, { ok: true })
    } catch (error) {
      // 单步失败**不终止**流程（用户可能只是滑块过期/验证码输错），
      // 把原因回给页面让它就地提示并允许重试。
      writeJson(response, {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      })
    }
    return
  }

  if (url.pathname === RACCOON_LOGIN_PAGE_PATHS.smsVerify && request.method === 'POST') {
    const body = await readJsonBody(request)
    const smsCode = typeof body.smsCode === 'string' ? body.smsCode.trim() : ''
    if (state.phone.length === 0) {
      response.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify({ ok: false, message: '请先获取手机验证码' }))
      return
    }
    if (smsCode.length === 0) {
      response.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify({ ok: false, message: '请输入验证码' }))
      return
    }
    try {
      const credential = await loginRaccoonWithSmsCode(product, state.phone, smsCode, deps.fetcher)
      deps.settleOk(credential)
      writeJson(response, { ok: true })
    } catch (error) {
      writeJson(response, {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      })
    }
    return
  }

  response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found')
}

/** 写一个 JSON 响应。 */
function writeJson(response: ServerResponse, payload: unknown): void {
  response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(payload))
}

/** 读取并解析请求体（上限 64KB，避免被塞爆）。 */
async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of request) {
    const buf = chunk as Buffer
    total += buf.length
    if (total > 64 * 1024) throw new Error('请求体过大')
    chunks.push(buf)
  }
  const text = Buffer.concat(chunks).toString('utf-8')
  if (text.length === 0) return {}
  try {
    const parsed = JSON.parse(text) as unknown
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    throw new Error('请求体不是合法 JSON')
  }
}

/**
 * 在 `127.0.0.1` 的随机空闲端口上启动服务器。
 *
 * 绑 `127.0.0.1` 而非 `0.0.0.0`：弹窗页只可能来自本机浏览器，不对外暴露。
 */
function listenOnRandomPort(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      if (port === 0) {
        reject(new Error('raccoon: 本地登录页服务器未能获得端口'))
        return
      }
      resolve(port)
    })
  })
}

/** 把任意文本安全地嵌进 HTML（错误原因来自网络，必须转义）。 */
function escapeHtmlText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * 渲染登录页 HTML。
 *
 * 导出以便单测断言页面结构（尤其是「不含任何密钥」这条安全约束）。
 *
 * ## 页面职责
 *
 * - 两个 Tab：微信扫码（默认）与短信登录
 * - 二维码由宿主侧生成的 **SVG 内联**进来（页面不需要 QR 逻辑，也不走 CDN）
 * - 每 2 秒轮询 `/raccoon/poll`（与官方客户端一致）
 * - 短信 Tab 加载阿里云滑块脚本，拿到 `captchaParam` 后提交
 *
 * @param ticket 当前会话的**服务端签发**票据。**注意**：本函数只是把它渲染成
 *   二维码 —— 页面拿不到 `qrcode_code` 本身（它被编码进二维码图像里）。
 *   这符合职责边界：页面不需要知道 code，只需要展示。
 * @param error 申请票据失败的原因（有值时二维码区域改为可读错误 + 短信兜底提示）。
 */
export function renderRaccoonLoginPage(
  product: RaccoonProduct,
  ticket?: RaccoonQrTicket,
  error?: string,
): string {
  // ⚠️ 拿不到票据时**不能**退回本地随机 code（2026-11-14 起服务端只认自己签发的
  // `qr-<uuidv7>`，本地随机码在新端点上恒回 401）—— 只能如实告诉用户「拿不到二维码」，
  // 并引导到短信 Tab（那是可用兜底）。
  const qrSvg = ticket !== undefined
    ? renderQrSvg(buildQrImageUrl(product, ticket), { size: 200 })
    : '<div class="qr-fallback">二维码获取失败'
      + `<br><span>${escapeHtmlText(error ?? '未知原因')}</span>`
      + '<br>可改用下方的「短信登录」</div>'

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Raccoon Work 登录</title>
<style>
  :root { color-scheme: light; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
         font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
         background: #f5f6f8; color: #1f2329; }
  .card { background: #fff; border-radius: 12px; padding: 20px 24px 24px; box-shadow: 0 4px 24px rgba(0,0,0,.08);
          text-align: center; width: 320px; }
  h1 { font-size: 16px; margin: 0 0 14px; font-weight: 600; }
  .tabs { display: flex; gap: 4px; background: #f2f3f5; border-radius: 8px; padding: 4px; margin-bottom: 16px; }
  .tabs button { flex: 1; padding: 7px; font-size: 13px; border: 0; border-radius: 6px;
                 background: transparent; color: #4e5969; cursor: pointer; }
  .tabs button[data-active="1"] { background: #fff; color: #1f2329; font-weight: 600;
                                  box-shadow: 0 1px 3px rgba(0,0,0,.08); }
  .pane { display: none; }
  .pane[data-show="1"] { display: block; }
  /* 二维码容器：SVG 自适应填充（SVG 自带 width/height 与 viewBox） */
  .qr { width: 200px; height: 200px; display: block; margin: 0 auto; border: 1px solid #eceef1;
        border-radius: 8px; padding: 6px; box-sizing: content-box; background: #fff; }
  .qr svg { display: block; width: 100%; height: 100%; }
  /* 拿不到票据（IAM 签发失败）时的兜底：不能只留一个空框，必须说明原因 */
  .qr-fallback { display: flex; flex-direction: column; justify-content: center; align-items: center;
                 width: 100%; height: 100%; font-size: 13px; color: #4e5969; line-height: 1.6; }
  .qr-fallback span { font-size: 11px; color: #8a9099; word-break: break-all; padding: 0 8px; }
  .sub { font-size: 12px; color: #8a9099; margin: 10px 0 0; }
  .status { margin-top: 12px; font-size: 13px; color: #4e5969; min-height: 20px; }
  .status[data-tone="ok"] { color: #0f9d58; font-weight: 600; }
  .status[data-tone="err"] { color: #d93026; }
  label { display: block; font-size: 12px; color: #8a9099; margin-bottom: 4px; text-align: left; }
  input { width: 100%; box-sizing: border-box; padding: 8px 10px; font-size: 14px; margin-bottom: 10px;
          border: 1px solid #d9dde3; border-radius: 6px; }
  button.primary { width: 100%; padding: 9px; font-size: 14px; border: 0; border-radius: 6px;
                   background: #8E6BF2; color: #fff; cursor: pointer; }
  button.primary:disabled { background: #c9cdd4; cursor: not-allowed; }
  .row { display: flex; gap: 8px; align-items: flex-start; }
  .row input { margin-bottom: 10px; }
  #captcha-element { margin-bottom: 10px; }
</style>
</head>
<body>
  <div class="card">
    <h1>登录 Raccoon Work</h1>

    <div class="tabs">
      <button id="tabQr" data-active="1" type="button">微信扫码</button>
      <button id="tabSms" data-active="0" type="button">短信登录</button>
    </div>

    <div class="pane" id="paneQr" data-show="1">
      <div class="qr" id="qrBox">${qrSvg}</div>
      <p class="sub">打开微信扫一扫，扫描上方二维码</p>
      <!--
        ⚠️ 常驻一句「打不开就用下方」：2026-11-14/15 实测官方二维码落地页
        /login/mp 全部 404（含微信 UA），而签发本身是**成功**的
        ⇒ 不会走到 .qr-fallback 那条分支。不常驻提示的话，用户扫进去
        只看到一个 404 页，而界面上没有任何一句告诉他可以改用短信。
      -->
      <p class="sub">扫完打不开页面？可直接改用下方「短信登录」</p>
      <div class="status" id="qrStatus">等待扫码…</div>
    </div>

    <div class="pane" id="paneSms" data-show="0">
      <label for="phone">手机号</label>
      <div class="row">
        <input id="phone" type="tel" inputmode="numeric" maxlength="11" placeholder="请输入 11 位手机号">
        <button class="primary" id="sendCode" type="button" style="width:auto;white-space:nowrap;padding:9px 12px;">获取验证码</button>
      </div>
      <div id="captcha-element"></div>
      <label for="smsCode">验证码</label>
      <input id="smsCode" type="text" inputmode="numeric" maxlength="6" placeholder="请输入 6 位验证码">
      <button class="primary" id="doLogin" type="button">登录</button>
      <div class="status" id="smsStatus"></div>
    </div>
  </div>

<script src="https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js"></script>
<script>
(function () {
  'use strict';
  // 轮询间隔取服务端下发值（poll_interval，实测 2 秒）；签发失败时退回常量。
  var POLL_INTERVAL_MS = ${String(ticket?.pollIntervalMs ?? RACCOON_QR_POLL_INTERVAL_MS)};
  var paths = ${JSON.stringify(RACCOON_LOGIN_PAGE_PATHS)};

  // ── Tab 切换 ──
  var tabQr = document.getElementById('tabQr');
  var tabSms = document.getElementById('tabSms');
  var paneQr = document.getElementById('paneQr');
  var paneSms = document.getElementById('paneSms');
  function selectTab(sms) {
    tabQr.setAttribute('data-active', sms ? '0' : '1');
    tabSms.setAttribute('data-active', sms ? '1' : '0');
    paneQr.setAttribute('data-show', sms ? '0' : '1');
    paneSms.setAttribute('data-show', sms ? '1' : '0');
  }
  tabQr.addEventListener('click', function () { selectTab(false); });
  tabSms.addEventListener('click', function () { selectTab(true); });

  // ── 扫码轮询 ──
  var qrStatus = document.getElementById('qrStatus');
  var qrBox = document.getElementById('qrBox');
  var pollTimer = null;
  function setQrStatus(text, tone) {
    qrStatus.textContent = text;
    if (tone) { qrStatus.setAttribute('data-tone', tone); } else { qrStatus.removeAttribute('data-tone'); }
  }
  function pollOnce() {
    fetch(paths.poll).then(function (r) { return r.json(); }).then(function (data) {
      if (data.status === 'success') {
        setQrStatus('登录成功，可以关闭此窗口了', 'ok');
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
        setTimeout(function () { window.close(); }, 1200);
        return;
      }
      if (data.status === 'logging') { setQrStatus('已扫码，请在微信中确认…'); return; }
      // ⚠️⚠️ “canceled”（用户取消）与 “expired”（过期/已被消耗）**都必须换图**。
      // 服务端两条都重签并回填 data.qr；页面这边少一个分支的后果是：
      // 后端换了新码，用户却盯着**已经失效的旧码**、状态还写着「等待扫码…」
      // —— 零报错一直等到超时（IKVA90 的症状就是这么残留的）。
      if (data.status === 'canceled' || data.status === 'expired') {
        if (data.qr) { qrBox.innerHTML = data.qr; }
        setQrStatus('二维码已刷新，请重新扫码');
        return;
      }
      // 首次签发失败、之后恢复：服务端会顺带补一张，这里同样要换上。
      if (data.qr) { qrBox.innerHTML = data.qr; }
      setQrStatus('等待扫码…');
    }).catch(function () {
      // 轮询偶发失败不打断（下一次继续）
    });
  }
  pollTimer = setInterval(pollOnce, POLL_INTERVAL_MS);
  pollOnce();

  // ── 短信登录 ──
  var smsStatus = document.getElementById('smsStatus');
  var phoneInput = document.getElementById('phone');
  var smsCodeInput = document.getElementById('smsCode');
  var sendBtn = document.getElementById('sendCode');
  var loginBtn = document.getElementById('doLogin');
  var captchaInstance = null;
  var pendingCaptcha = null;

  function setSmsStatus(text, tone) {
    smsStatus.textContent = text || '';
    if (tone) { smsStatus.setAttribute('data-tone', tone); } else { smsStatus.removeAttribute('data-tone'); }
  }

  function submitSmsSend(captchaParam) {
    var phone = (phoneInput.value || '').trim();
    if (!/^1[3-9]\\d{9}$/.test(phone)) {
      setSmsStatus('请输入有效的 11 位手机号', 'err');
      return;
    }
    sendBtn.disabled = true;
    setSmsStatus('发送中…');
    fetch(paths.smsSend, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: phone, captchaParam: captchaParam || '' })
    }).then(function (r) { return r.json(); }).then(function (data) {
      if (data && data.ok) { setSmsStatus('验证码已发送，请查收短信', 'ok'); }
      else { setSmsStatus((data && data.message) || '发送失败，请重试', 'err'); }
    }).catch(function () {
      setSmsStatus('发送失败，请检查网络后重试', 'err');
    }).finally(function () {
      sendBtn.disabled = false;
    });
  }

  // 阿里云滑块：真实加载官方脚本（SceneId / prefix 来自客户端配置）。
  function initCaptcha() {
    if (typeof window.initAliyunCaptcha !== 'function') { return false; }
    window.initAliyunCaptcha({
      SceneId: '${product.aliyunCaptcha.sceneId}',
      prefix: '${product.aliyunCaptcha.prefix}',
      mode: 'popup',
      element: '#captcha-element',
      button: '#sendCode',
      captchaVerifyCallback: function (captchaParam) {
        pendingCaptcha = captchaParam;
        submitSmsSend(captchaParam);
        return { captchaResult: true, bizResult: true };
      },
      onBizResultCallback: function () { return null; },
      getInstance: function (instance) { captchaInstance = instance; return null; },
      slideStyle: { width: 320, height: 40 },
      language: 'cn'
    });
    return true;
  }
  var captchaReady = initCaptcha();
  sendBtn.addEventListener('click', function () {
    if (!captchaReady) { captchaReady = initCaptcha(); }
    if (!captchaReady) {
      // 脚本未加载（离线/被拦截）：退化为直接提交，让服务端报明确原因
      // （实测会回 captcha_verify_error，页面据此提示用户）。
      setSmsStatus('验证码组件未加载，正在尝试直接发送…');
      submitSmsSend('');
    }
  });

  loginBtn.addEventListener('click', function () {
    var code = (smsCodeInput.value || '').trim();
    if (!code) { setSmsStatus('请输入验证码', 'err'); return; }
    loginBtn.disabled = true;
    setSmsStatus('登录中…');
    fetch(paths.smsVerify, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ smsCode: code })
    }).then(function (r) { return r.json(); }).then(function (data) {
      if (data && data.ok) {
        setSmsStatus('登录成功，可以关闭此窗口了', 'ok');
        setTimeout(function () { window.close(); }, 1200);
      } else {
        setSmsStatus((data && data.message) || '验证码不正确，请重试', 'err');
      }
    }).catch(function () {
      setSmsStatus('登录失败，请检查网络后重试', 'err');
    }).finally(function () {
      loginBtn.disabled = false;
    });
  });
})();
</script>
</body>
</html>`
}
