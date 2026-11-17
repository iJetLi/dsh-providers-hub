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
  buildRaccoonAuthorizeUrl,
  exchangeRaccoonAuthorizationCode,
  openRaccoonAuthorizePage,
  startRaccoonAuthorizeReceiver,
  type RaccoonAuthorizeReceiver,
} from './raccoon-authorize.js'
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
  /** 申请一条 `/authorize` 链接（浏览器授权的**第一步**）。 */
  authorizeStart: '/raccoon/authorize/start',
  /** 查询这一轮授权的状态（第二步：等回调 / 换码结果）。 */
  authorizeStatus: '/raccoon/authorize/status',
  /** 取消这一轮等待。 */
  authorizeCancel: '/raccoon/authorize/cancel',
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
  /**
   * 浏览器授权那一轮的**当前**接收端（**单飞**：同一时刻只有一个）。
   *
   * ⚠️ 为什么单飞：每个接收端占一个本机端口，而授权码是一次性凭据 ⇒ 两个
   * 接收端并存在**语义上**就是两个「等着收凭据的口子」。用户点两次
   * 「浏览器登录」时，**第二个 start 复用第一个**（回报同一条 URL），而不是
   * 再开一个端口。
   */
  authorizeReceiver?: RaccoonAuthorizeReceiver
  /**
   * 浏览器授权那一轮的状态（页面轮询它）。
   *
   * ⚠️ 状态值是**封闭集**：`idle` / `waiting` / `authorized` / `failed`。
   * 失败时带一个**原因词**（不是报文原文：报文可能回显那枚授权码）。
   */
  authorizeStatus: 'idle' | 'waiting' | 'authorized' | 'failed'
  /** 失败原因词（`authorizeStatus === 'failed'` 时有值）。 */
  authorizeReason?: string
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
  /**
   * 注入的「打开授权页」动作（测试用）。
   *
   * ⚠️⚠️ **单测里绝不能真的开窗**：那是**用户桌面**上的真实浏览器窗口，
   * 且它会**真的**加载授权页并（若浏览器里已有会话）**真的**投递一个回调
   * —— 那会消费掉接收端，让用例测到的东西完全不是它想测的。
   * （本仓在 officeace 那次已登记过同一条纪律：开窗的行为测试只能放 e2e。）
   */
  openAuthorizePage?: (url: string) => void
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
  const openAuthorizePage = options.openAuthorizePage ?? openRaccoonAuthorizePage
  const state: FlowState = {
    phone: '',
    authorizeStatus: 'idle',
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
    void handleRequest(request, response, {
      state,
      product,
      fetcher,
      settleOk,
      settleErr,
      openAuthorizePage,
    }).catch(
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

  /**
   * 关掉这一轮浏览器授权的接收端（**幂等**）。
   *
   * ⚠️⚠️⚠️ **这条是承重的**（真实安全缺陷，2026-11-17 修）：
   * 授权码是一次性凭据，而一个**还开着**的回环接收端就是「凭据交换漏洞」——
   * 本机任何进程都能往那个端口投递一枚 code，把凭据换成**它自己的**账号。
   * 而 `state` 是**公开**的（在 URL 里、也在授权页的上下文里）⇒ 挡不住。
   *
   * ⚠️ **必须挂在「结果落定」上，而不是只挂在 `close()` 上**：
   * 流程可以从**三条不同的路**落定 —— 授权换码成功 / 短信登录成功 / 扫码成功
   * —— 而 `close()` **全仓无人调用**（`jet-hub-rpc.ts` 不调它）。
   * 只挂在 `close()` 上 ⇒ 「授权等待中，用户改用短信登录成功」这条路
   * **留着那个口子整整 5 分钟**（接收端自己的超时），
   * 实测还能在流程结束后**真的**再换一次码。
   */
  const closeAuthorizeReceiver = (): void => {
    state.authorizeReceiver?.cancel()
    state.authorizeReceiver = undefined
  }

  let closed = false
  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    closeAuthorizeReceiver()
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

  // 结果落定即关服务器 **并关掉回环接收端**（含超时与失败路径）。
  //
  // ⚠️⚠️ **关接收端必须和关本地页服务器在同一处**：它们是**两件**独立的事
  // （本地页承载扫码/短信，回环承载授权回调），而**授权回调那条才是
  // 凭据入口**。只关前者 ⇒ 授权那条的口子留着。
  void result
    .catch(() => {})
    .finally(() => {
      clearTimeout(timer)
      closeAuthorizeReceiver()
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
  /** 失败时的落定回调（**必须**有：否则失败会永远悬挂）。 */
  settleErr: (reason: unknown) => void
  openAuthorizePage: (url: string) => void
}

/**
 * 跑一轮「浏览器授权」，并把结果写进 `state`。
 *
 * ## 这轮的形状
 *
 * 1. 起一个回环接收端（**单飞**：已有在飞的那一轮就复用它）；
 * 2. 拿到 `/authorize` URL ⇒ **宿主侧**用系统浏览器打开（页面自己不跳，
 *    因为那会离开我们这个本地页）；
 * 3. 等回调（授权码）⇒ 换码 ⇒ 落成凭据。
 *
 * ⚠️ **失败一律只报原因词**：换码的报文可能回显那枚授权码，而它是凭据。
 *
 * @param state - 流程状态（就地更新）。
 * @param product - 产品配置。
 * @param fetcher - 注入的 fetch。
 * @param settleOk - 成功时的落定回调。
 * @param settleErr - 失败时的落定回调（**必须**有：换码失败若不落定，
 *   流程会永远悬挂 ⇒ 前端只会转圈到它自己的 5 分钟上限）。
 * @param openAuthorizePage - 打开授权页的动作（注入点，单测不真开窗）。
 * @returns 这一轮的 `/authorize` URL（失败时为空串）。
 */
async function runAuthorizeRound(
  state: FlowState,
  product: RaccoonProduct,
  fetcher: typeof fetch,
  settleOk: (value: RaccoonCredential) => void,
  settleErr: (reason: unknown) => void,
  openAuthorizePage: (url: string) => void,
): Promise<string> {
  // 单飞：已经在飞 ⇒ 复用同一个接收端（**不再**占一个端口）。
  if (state.authorizeReceiver !== undefined && state.authorizeStatus === 'waiting') {
    return state.authorizeReceiver.authorizeUrl
  }
  let receiver: RaccoonAuthorizeReceiver
  try {
    receiver = await startRaccoonAuthorizeReceiver({
      authorizationOrigin: product.apiBase,
    })
  } catch (error) {
    state.authorizeStatus = 'failed'
    state.authorizeReason = 'bind'
    return ''
  }
  if (receiver.authorizeUrl === '') {
    // 端口没绑上 / 落在页面会拒收的范围外 ⇒ 没有 URL 可给用户。
    state.authorizeStatus = 'failed'
    state.authorizeReason = 'bind'
    receiver.cancel()
    return ''
  }
  state.authorizeReceiver = receiver
  state.authorizeStatus = 'waiting'
  state.authorizeReason = undefined
  // 后台等回调：授权码只在**这一条链**上流动（接收端 → 换码 → 凭据），
  // 从不进入任何响应体或日志。
  void receiver.result.then(async (settled) => {
    if (!settled.ok || settled.code === undefined) {
      // 超时 / 被取消 / 绑不上：报原因词，**不**带任何报文。
      //
      // ⚠️⚠️ **取消的那一支不能把状态改成 failed**：用户点了「取消等待」
      //   ⇒ 状态就该是「已取消」，而 `cancel()` 会让接收端落定为
      //   `closed` —— 这里若无条件写 `failed`，用户看到的是「失败」，
      //   而他明明是自己取消的（且下面 cancel 端点已经把状态置成 idle）。
      //   ⇒ 用 `authorizeStatus` 是否已被**取消**那一路改过来判断。
      if (state.authorizeStatus === 'waiting') {
        state.authorizeStatus = 'failed'
        state.authorizeReason = settled.reason === 'timeout'
          ? 'timeout'
          : settled.reason === 'closed'
            ? 'canceled'
            : 'bind'
      }
      return
    }
    const exchanged = await exchangeRaccoonAuthorizationCode(settled.code, {
      product,
      fetcher,
    })
    if (!exchanged.ok || exchanged.credential === undefined) {
      state.authorizeStatus = 'failed'
      state.authorizeReason = exchanged.reason ?? 'invalid_response'
      // ⚠️⚠️ **必须让流程落定**（真实缺陷，2026-11-17 修）：
      // 不落定 ⇒ `result` 永远悬挂 ⇒ `jet-hub-rpc.ts` 里的
      // `raccoonStarted.result.then(...)` 永远不跑 ⇒ **占位账号条目永远
      // 留着**、前端 `login.poll` 一直转圈到它自己的 5 分钟上限，而用户
      // 早就看到了「授权码已失效」—— 两边的症状**不同形**（一个是「卡住」，
      // 一个是「失败」），用户无从判断到底成没成。
      //
      // ⚠️ 失败原因**只报原因词**（换码的报文可能回显那枚授权码）。
      settleErr(new Error(`raccoon: 浏览器授权未完成（${state.authorizeReason ?? '未知原因'}）`))
      return
    }
    state.authorizeStatus = 'authorized'
    settleOk(exchanged.credential)
  }).catch((error: unknown) => {
    // ⚠️ **这一支是防御性兜底，正常走不到**：`exchangeRaccoonAuthorizationCode`
    //   自己把**所有**异常都吃掉了（网络失败、JSON 解析失败都变成
    //   `{ok:false, reason:'…'}`）⇒ 它**不抛**。
    //   ⇒ 变异验证里「把这一支的 settleErr 去掉」**测不出差别**（实测无牙，
    //   如实登记）—— 那不是这条判据没用，而是**这条分支不可达**。
    //
    //   它**仍然要留**：万一换码那段将来加了新的抛出点（而**不**是返回
    //   `{ok:false}`），流程不能永远悬挂。
    state.authorizeStatus = 'failed'
    state.authorizeReason = 'network'
    settleErr(new Error(
      `raccoon: 浏览器授权未完成（网络故障）：${error instanceof Error ? error.message : String(error)}`,
    ))
  })
  // ⚠️ **宿主侧**开浏览器，而不是让页面 `window.open`：
  // 页面跳走就**离开了**我们这个本地页 ⇒ 换码成功后页面收不到「成功」，
  // 用户看到的仍是「等待中」。宿主开 ⇒ 本地页始终活着，轮询能拿到终态。
  openAuthorizePage(receiver.authorizeUrl)
  return receiver.authorizeUrl
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

  if (url.pathname === RACCOON_LOGIN_PAGE_PATHS.authorizeStart) {
    const authorizeUrl = await runAuthorizeRound(
      state,
      product,
      deps.fetcher,
      deps.settleOk,
      deps.settleErr,
      deps.openAuthorizePage,
    )
    writeJson(response, {
      ok: authorizeUrl !== '',
      url: authorizeUrl,
      status: state.authorizeStatus,
      ...state.authorizeReason !== undefined ? { reason: state.authorizeReason } : {},
    })
    return
  }

  if (url.pathname === RACCOON_LOGIN_PAGE_PATHS.authorizeStatus) {
    writeJson(response, {
      status: state.authorizeStatus,
      ...state.authorizeReason !== undefined ? { reason: state.authorizeReason } : {},
    })
    return
  }

  if (url.pathname === RACCOON_LOGIN_PAGE_PATHS.authorizeCancel) {
    // ⚠️ **先把状态挪出 `waiting` 再 cancel**：接收端的落定回调只会在
    //   状态仍是 `waiting` 时写 `failed`（见 `runAuthorizeRound` 的注释）——
    //   用户是自己取消的，不该看到「失败」。
    state.authorizeStatus = 'idle'
    state.authorizeReason = undefined
    state.authorizeReceiver?.cancel()
    state.authorizeReceiver = undefined
    writeJson(response, { ok: true })
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
      <button id="tabBrowser" data-active="1" type="button">浏览器登录</button>
      <button id="tabQr" data-active="0" type="button">微信扫码</button>
      <button id="tabSms" data-active="0" type="button">短信登录</button>
    </div>

    <div class="pane" id="paneBrowser" data-show="1">
      <!--
        ⚠️ 这条 Tab 是**官方客户端自己的那条链**（/authorize 授权页 +
        回环回调 + 换码），也是**现在唯一还活着的那条**：
        扫码确认页 /login/mp 自 2026-11-04 起**全部 404**（实测，含微信
        UA），而签发本身是成功的 ⇒ 扫码 Tab 必然走到 404 页。
        授权页是**活的**，且用户可以在**网页里**用手机号或微信扫码登录
        （那是页面自己的另一张二维码，与死掉的那张不是同一张）。
      -->
      <p class="sub">在浏览器里打开商汤小浣熊授权页，完成登录后自动完成</p>
      <button class="primary" id="doAuthorize" type="button">打开授权页</button>
      <p class="sub" id="authorizeLinkBox" style="display:none;">
        浏览器没自动打开？<a id="authorizeLink" href="#" target="_blank" rel="noreferrer">点此打开授权页</a>
      </p>
      <button class="primary" id="cancelAuthorize" type="button" style="display:none;background:#4e5969;">取消等待</button>
      <div class="status" id="authorizeStatus">未开始</div>
    </div>

    <div class="pane" id="paneQr" data-show="0">
      <div class="qr" id="qrBox">${qrSvg}</div>
      <p class="sub">打开微信扫一扫，扫描上方二维码</p>
      <!--
        ⚠️ 常驻两句提示（2026-11-14/15 实测官方二维码落地页
        /login/mp 全部 404，含微信 UA，而签发本身是**成功**的
        ⇒ 不会走到 .qr-fallback 那条分支。不常驻提示的话，用户扫进去
        只看到一个 404 页，而界面上没有任何一句告诉他可以改用别的入口。
      -->
      <p class="sub">扫完打不开页面？改用上方「浏览器登录」或下方「短信登录」</p>
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
  // ⚠️ 三个 Tab（扫码 / 短信 / 浏览器）**共用一个** selectTab：
  // 判据写成「哪个」而不是「两个布尔」—— 后者加第三个 Tab 时必然漏一处
  // （本仓在别处已登记过「加一个维度忘了改另一处」的事故形态）。
  var tabQr = document.getElementById('tabQr');
  var tabSms = document.getElementById('tabSms');
  var tabBrowser = document.getElementById('tabBrowser');
  var paneQr = document.getElementById('paneQr');
  var paneSms = document.getElementById('paneSms');
  var paneBrowser = document.getElementById('paneBrowser');
  function selectTab(which) {
    var active = { qr: false, sms: false, browser: false };
    active[which] = true;
    tabQr.setAttribute('data-active', active.qr ? '1' : '0');
    tabSms.setAttribute('data-active', active.sms ? '1' : '0');
    tabBrowser.setAttribute('data-active', active.browser ? '1' : '0');
    paneQr.setAttribute('data-show', active.qr ? '1' : '0');
    paneSms.setAttribute('data-show', active.sms ? '1' : '0');
    paneBrowser.setAttribute('data-show', active.browser ? '1' : '0');
  }
  tabQr.addEventListener('click', function () { selectTab('qr'); });
  tabSms.addEventListener('click', function () { selectTab('sms'); });
  tabBrowser.addEventListener('click', function () { selectTab('browser'); });
  // ⚠️ **默认落在「浏览器登录」**：那才是现在唯一还活着的那条链
  // （扫码确认页 /login/mp 自 11-04 起全 404）。默认停在扫码 Tab 上，
  // 用户点开就看到一个**必然 404** 的二维码。
  selectTab('browser');

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

  // ── 浏览器登录（官方客户端自己的那条链：/authorize + 回环回调 + 换码）──
  //
  // ⚠️ 页面**自己**不跳走授权页：跳走就离开了我们这个本地页，换码成功后
  // 页面收不到终态（用户看到的仍是「等待中」）。所以由**宿主侧**开浏览器，
  // 页面只负责「点一下 → 轮询状态」。
  var authorizeStatus = document.getElementById('authorizeStatus');
  var authorizeBtn = document.getElementById('doAuthorize');
  var authorizeCancelBtn = document.getElementById('cancelAuthorize');
  var authorizeLinkBox = document.getElementById('authorizeLinkBox');
  var authorizeLink = document.getElementById('authorizeLink');
  var authorizePollTimer = null;
  function setAuthorizeStatus(text, tone) {
    authorizeStatus.textContent = text;
    if (tone) { authorizeStatus.setAttribute('data-tone', tone); } else { authorizeStatus.removeAttribute('data-tone'); }
  }
  // 原因词 → 人话。⚠️ **只译封闭集里的词**：宿主那边报回来的是**原因词**
  // （不是报文原文 —— 报文可能回显那枚一次性授权码）。
  var AUTHORIZE_REASONS = {
    code_not_found: '授权码已失效（过期或已使用）——请重新发起',
    session_dead: '网页登录态已失效——请重新发起',
    server_error: '授权服务暂不可用——请稍后重试',
    network: '网络故障——请检查网络后重试',
    invalid_response: '应答格式异常——请重新发起',
    refresh_missing: '应答缺少续期令牌——请重新发起',
    token_invalid: '令牌校验未通过——请重新发起',
    bind: '本机回调端口未能监听——请重新发起',
    timeout: '等待超时——请重新发起',
    canceled: '已取消等待'
  };
  function authorizeReasonText(reason) {
    if (typeof reason !== 'string' || reason === '') return '未知原因';
    return Object.prototype.hasOwnProperty.call(AUTHORIZE_REASONS, reason)
      ? AUTHORIZE_REASONS[reason]
      : '未知原因';
  }
  function stopAuthorizePolling() {
    if (authorizePollTimer) { clearInterval(authorizePollTimer); authorizePollTimer = null; }
  }
  function pollAuthorizeOnce() {
    fetch(paths.authorizeStatus).then(function (r) { return r.json(); }).then(function (data) {
      if (data.status === 'authorized') {
        stopAuthorizePolling();
        setAuthorizeStatus('登录成功，可以关闭此窗口了', 'ok');
        setTimeout(function () { window.close(); }, 1200);
        return;
      }
      if (data.status === 'failed') {
        stopAuthorizePolling();
        setAuthorizeStatus('浏览器授权未完成：' + authorizeReasonText(data.reason), 'err');
        authorizeBtn.disabled = false;
        authorizeCancelBtn.style.display = 'none';
        return;
      }
      setAuthorizeStatus('等待浏览器授权…（完成后自动完成）');
    }).catch(function () {
      // ⚠️ **本地页服务器在登录落定的那一刻就关了**（既有契约：结果落定即关
      //   服务器）⇒ 轮询失败**很可能**意味着「已经登录成功了」。
      //   那时页面必须说一句话有意义的，而不是停在「等待中」让人以为卡住了。
      //   （真正的成功信号来自 Jet Hub 那边的账号列表。）
      stopAuthorizePolling();
      setAuthorizeStatus('登录已完成（或页面已关闭）——请回到设置页确认账号是否已添加');
    });
  }
  authorizeBtn.addEventListener('click', function () {
    authorizeBtn.disabled = true;
    setAuthorizeStatus('正在打开授权页…');
    fetch(paths.authorizeStart).then(function (r) { return r.json(); }).then(function (data) {
      if (!data.ok || !data.url) {
        authorizeBtn.disabled = false;
        setAuthorizeStatus('无法发起浏览器授权：' + authorizeReasonText(data.reason), 'err');
        return;
      }
      // 兜底链接：宿主开浏览器失败（无桌面环境）时，用户可以自己点。
      authorizeLink.setAttribute('href', data.url);
      authorizeLinkBox.style.display = 'block';
      authorizeCancelBtn.style.display = 'block';
      setAuthorizeStatus('等待浏览器授权…（完成后自动完成）');
      stopAuthorizePolling();
      authorizePollTimer = setInterval(pollAuthorizeOnce, POLL_INTERVAL_MS);
      pollAuthorizeOnce();
    }).catch(function () {
      authorizeBtn.disabled = false;
      setAuthorizeStatus('无法发起浏览器授权：请检查本机网络后重试', 'err');
    });
  });
  authorizeCancelBtn.addEventListener('click', function () {
    stopAuthorizePolling();
    fetch(paths.authorizeCancel).then(function (r) { return r.json(); }).catch(function () {});
    authorizeBtn.disabled = false;
    authorizeCancelBtn.style.display = 'none';
    authorizeLinkBox.style.display = 'none';
    setAuthorizeStatus('已取消等待');
  });

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
