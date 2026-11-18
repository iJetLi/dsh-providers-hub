/**
 * Marvis uskey 桥 —— 向 MarvisAgent 进程索取一份**合法**的请求头。
 *
 * ## 为什么需要它（2026-11-18 实测定论）
 *
 * Marvis 模型网关（`/v1/chat/completions`）的准入判据**不是**内容、不是模型、
 * 也不是普通 header，而是 `Ual-Access-MarvisExt.uskey`：
 *
 * | 取值 | 结果 |
 * |---|---|
 * | 真实值 `524` 字符 → 解码 `392` 字节，前缀恒为 `CsDVDCER` | `200` |
 * | 本模块接入前的实现：`376` 字节随机 base64 → `504` 字符、**无魔数** | `403 4100404` |
 *
 * 对照实验（同一把真实 uskey，只换内容）：
 *
 * | 请求 | 结果 |
 * |---|---|
 * | 真实内容 | `200` |
 * | 261 字节的「法国首都是哪」 | `200` |
 * | 伪造 392B uskey + 完全真实内容 | `403` |
 *
 * ⇒ **内容无关，uskey 才是唯一的门。**
 *
 * ## 为什么不能自己生成
 *
 * `uskey = base64( 6 字节魔数 + AES 加密载荷 )`，载荷由腾讯 QIMEI SDK 在
 * Marvis 进程内用「DPAPI 解封的设备身份 + 登录态」算出。2026-11-18 已逐一排除
 * 「脱离进程复现」的所有路径：
 *
 * - `marvis_sdk.get_uskey(busiid, bus_info)` 在磁盘上**可调用**，也能产出
 *   **字节结构完全合规**的 524 字符密文（前缀 `CsDVDCER` 一致）；
 * - 真实 busiid 可从 agent 的 `ClientEnvConfig()` 里读到（`uskey.busiid`）；
 *   但即使换成该值，独立进程产出的 uskey 仍**不被接受**；
 * - 注入真实 `guid`（Marvis 客户端写在注册表里的设备标识）、匹配
 *   `conv_id`/`resp_id`、补齐 `ClientEnvStore.start(config)`、等待 beacon 注册
 *   （0/3/8 秒）—— **全部仍 403**；
 * - 两份 uskey 解码后都是纯二进制密文，**无可追的明文差异**。
 *
 * ⇒ 判据含只有真实 agent 进程才具备的运行态上下文，**不可离线复刻**。
 *
 * ## 三个硬约束
 *
 * 1. **有效期约 60 秒**（实测 `62s` 活 / `96s` 死）⇒ 必须按需实时生成，**不能缓存**；
 * 2. 只能由 agent 进程内的 SDK 生成（见上）；
 * 3. `conv_id` / `resp_id` **随便填**（空值也 `200`）⇒ 不必伪造会话。
 *
 * ## 工作方式
 *
 * 纯本地文件 RPC：写 `req-<uuid>.json` → 钩子调 `LLMHeaderService.build()` →
 * 写 `resp-<uuid>.json`。不走网络、不改 agent 业务行为、失败时给出**可操作**的错误。
 *
 * ## 三个已知代价（务必在文档里如实告知用户）
 *
 * 1. **Marvis 必须开着**（否则 agent 进程不在，无从取头）；
 * 2. 消耗的是**真实 Marvis 账号**的额度（不是本插件自己登录的那个号）；
 * 3. Marvis 升级换版本目录后钩子失效 ⇒ 需重装（见 `marvis-hook-install.ts`）。
 *
 * @module src/marvis-uskey-bridge.ts
 */
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/**
 * 钩子监听的目录（与 `marvis-uskey-hook.py` 里的 `RPC_DIR` 必须一致）。
 *
 * 默认落在系统临时目录下的固定子目录（两端由安装器注入同一路径），
 * 可用环境变量 `DSH_MARVIS_USKEY_RPC` 覆盖 —— 多实例/多用户机器上避免抢同一目录。
 */
export const USKEY_RPC_DIR = process.env.DSH_MARVIS_USKEY_RPC ?? join(tmpdir(), 'dsh-marvis-uskey-rpc')

/** 钩子日志文件（钩子自己写这里）。 */
export const USKEY_LOG_PATH = join(USKEY_RPC_DIR, '..', 'uskey-bridge.log')

/** `_internal/sitecustomize.py` 里本钩子的标识串。 */
export const HOOK_MARKER = 'uskey-rpc'

/** 正常 uskey 的字符数；不等于它几乎必然被拒（见模块头）。 */
export const USKEY_EXPECTED_LENGTH = 524

/**
 * 桥失败的结构化原因。
 *
 * 之所以要分类而不是一律 `throw new Error(...)`：调用方要据此决定
 * 「值得重试」还是「必须让用户去修环境」—— 两者用户可见文案完全不同。
 */
export type MarvisBridgeFailureCode =
  /** 钩子文件不存在（没装 / 版本升级后丢了） */
  | 'HOOK_MISSING'
  /** 钩子在，但 agent 进程没起 */
  | 'AGENT_DOWN'
  /** agent 在，但本轮没在超时内应答 */
  | 'TIMEOUT'
  /** 钩子内部报错（通常未登录 / 找不到服务实例） */
  | 'HOOK_ERROR'
  /** RPC 目录不可用（权限 / 路径） */
  | 'RPC_UNAVAILABLE'

/** 带结构化原因与可操作提示的桥错误。 */
export class MarvisBridgeError extends Error {
  readonly code: MarvisBridgeFailureCode

  /** 给用户看的修复建议（可直接进错误文案）。 */
  readonly hint: string

  /** 是否值得原样重试（`TIMEOUT` 值得，其余不值得）。 */
  readonly retriable: boolean

  constructor(code: MarvisBridgeFailureCode, message: string, hint: string, retriable = false) {
    super(message)
    this.name = 'MarvisBridgeError'
    this.code = code
    this.hint = hint
    this.retriable = retriable
  }
}

/** 一个已定位的 Marvis 安装。 */
export interface MarvisInstall {
  /** `MarvisAgent\<version>` 目录。 */
  agentVersionDir: string
  /** 版本号（目录名）。 */
  version: string
  /** `_internal` 目录。 */
  internalDir: string
  /** 钩子目标文件。 */
  hookPath: string
  /** 钩子文件是否存在。 */
  hookInstalled: boolean
  /** 是否确认是本插件的钩子（内容含 `HOOK_MARKER`）。 */
  hookIsOurs: boolean
}

/** 桥的体检结果（可直接展示给用户 / 写日志）。 */
export interface MarvisBridgeStatus {
  /** 整体是否可用。 */
  healthy: boolean
  /** RPC 目录是否就绪。 */
  rpcDirReady: boolean
  /** 钩子状态。 */
  install?: MarvisInstall
  /** agent 进程是否在跑。 */
  agentRunning: boolean
  /** 钩子日志最后一行。 */
  lastLogLine?: string
  /** 钩子日志最后写入距今毫秒数（判断是否「装完没重启」）。 */
  logAgeMs?: number
  /** 一句话结论 + 该做什么。 */
  summary: string
}

/** 单次取头的结果（带耗时，供日志与 UI 展示）。 */
export interface MarvisHeadersResult {
  headers: Record<string, string>
  /** 从发起 RPC 到拿到头的毫秒数。 */
  elapsedMs: number
  /** 本次 uskey 的长度（`524` 为正常）。 */
  uskeyLength?: number
}

/** 版本号比较（只认数字段，够用）。 */
function compareVersion(a: string, b: string): number {
  const pa = a.split(/[.+-]/).map((x) => Number.parseInt(x, 10) || 0)
  const pb = b.split(/[.+-]/).map((x) => Number.parseInt(x, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

/** 跑一个外部命令拿 stdout；失败返回 `undefined`（不抛）。 */
function runQuiet(file: string, args: string[]): string | undefined {
  try {
    return execFileSync(file, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 4000,
    })
  }
  catch {
    return undefined
  }
}

/** 读注册表 `HKLM\Software\Tencent\Marvis` 的 `InstallPath`。 */
function readRegistryInstallPath(): string | undefined {
  const out = runQuiet('reg.exe', ['query', 'HKLM\\Software\\Tencent\\Marvis', '/v', 'InstallPath'])
  if (out === undefined) return undefined
  return /InstallPath\s+REG_SZ\s+(.+)/i.exec(out)?.[1]?.trim() || undefined
}

/** 候选安装根目录：注册表优先，其次常见位置。 */
function candidateRoots(): string[] {
  const roots: string[] = []
  const fromRegistry = readRegistryInstallPath()
  if (fromRegistry !== undefined) roots.push(fromRegistry)
  for (const drive of ['C:', 'D:', 'E:', 'F:']) {
    roots.push(`${drive}\\AI\\Marvis`, `${drive}\\Marvis`, `${drive}\\Program Files\\Marvis`)
  }
  return roots
}

/**
 * 定位当前 Marvis 安装（含最高版本目录）。
 *
 * ⚠️ **每次调用都现查**，不缓存：用户可能中途升级 Marvis，缓存会把桥永久钉在
 * 已失效的旧目录上。
 */
export function locateMarvisInstall(): MarvisInstall | undefined {
  for (const root of candidateRoots()) {
    if (!existsSync(root)) continue
    const base = join(root, 'MarvisAgent')
    if (!existsSync(base)) continue

    let newest: string | undefined
    try {
      newest = readdirSync(base, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort(compareVersion)
        .at(-1)
    }
    catch {
      continue
    }
    if (newest === undefined) continue

    const agentVersionDir = join(base, newest)
    const internalDir = join(agentVersionDir, '_internal')
    if (!existsSync(internalDir)) continue

    const hookPath = join(internalDir, 'sitecustomize.py')
    const hookInstalled = existsSync(hookPath)
    let hookIsOurs = false
    if (hookInstalled) {
      try {
        hookIsOurs = readFileSync(hookPath, 'utf8').includes(HOOK_MARKER)
      }
      catch {
        hookIsOurs = false
      }
    }
    return { agentVersionDir, version: newest, internalDir, hookPath, hookInstalled, hookIsOurs }
  }
  return undefined
}

/** agent 进程是否在跑。 */
function isAgentRunning(): boolean {
  const out = runQuiet('tasklist.exe', ['/FI', 'IMAGENAME eq MarvisAgent.exe', '/NH'])
  return out === undefined ? false : /MarvisAgent\.exe/i.test(out)
}

/** 读日志尾行与新鲜度。 */
function readLogTail(): { line?: string; ageMs?: number } {
  try {
    if (!existsSync(USKEY_LOG_PATH)) return {}
    const stat = statSync(USKEY_LOG_PATH)
    const lines = readFileSync(USKEY_LOG_PATH, 'utf8').split(/\r?\n/).filter((l) => l.trim() !== '')
    return { line: lines.at(-1), ageMs: Date.now() - stat.mtimeMs }
  }
  catch {
    return {}
  }
}

/**
 * 桥体检：**不产生 uskey**，只做本地判定，故可随时调用（含 UI 展示）。
 *
 * 判据顺序即「用户该修哪一步」的顺序：安装 → 钩子 → 进程 → 目录 → 日志。
 */
export function inspectMarvisBridge(): MarvisBridgeStatus {
  const rpcDirReady = existsSync(USKEY_RPC_DIR)
  const install = locateMarvisInstall()
  const agentRunning = isAgentRunning()
  const { line, ageMs } = readLogTail()

  let summary: string
  let healthy = false
  if (install === undefined) {
    summary = '未找到 Marvis 安装 —— 确认 Marvis 已安装，或用 DSH_MARVIS_USKEY_RPC 手工指定 RPC 目录'
  }
  else if (!install.hookInstalled) {
    summary = `当前 Marvis ${install.version} 未安装 uskey 钩子 —— 需重新安装钩子后重启 Marvis`
  }
  else if (!install.hookIsOurs) {
    summary = `${install.hookPath} 已存在但不是本插件的钩子 —— 需人工合并后再装`
  }
  else if (!agentRunning) {
    summary = '钩子已装但 Marvis 未运行 —— 启动 Marvis 即可（这是「必须开着马维斯」的原因）'
  }
  else if (!rpcDirReady) {
    summary = `RPC 目录缺失：${USKEY_RPC_DIR}（首次请求会自动创建）`
  }
  else if (line === undefined) {
    summary = '钩子已装、Marvis 在跑，但尚无日志 —— 可能刚启动，稍后重试'
  }
  else {
    healthy = true
    summary = `就绪（Marvis ${install.version}，钩子日志 ${Math.round((ageMs ?? 0) / 1000)}s 前）`
  }

  return { healthy, rpcDirReady, install, agentRunning, lastLogLine: line, logAgeMs: ageMs, summary }
}

/** 确保 RPC 目录存在。 */
function ensureRpcDir(): void {
  if (existsSync(USKEY_RPC_DIR)) return
  try {
    mkdirSync(USKEY_RPC_DIR, { recursive: true })
  }
  catch (error) {
    throw new MarvisBridgeError(
      'RPC_UNAVAILABLE',
      `无法创建 uskey RPC 目录：${USKEY_RPC_DIR}（${error instanceof Error ? error.message : String(error)}）`,
      '检查该路径的写权限，或用 DSH_MARVIS_USKEY_RPC 指向可写目录',
    )
  }
}

/** 清理陈旧 RPC 残留（agent 重启后旧 resp 永远不会来）。 */
function sweepStale(): void {
  try {
    const cutoff = Date.now() - 60_000
    for (const name of readdirSync(USKEY_RPC_DIR)) {
      const path = join(USKEY_RPC_DIR, name)
      try {
        if (statSync(path).mtimeMs < cutoff) rmSync(path, { force: true })
      }
      catch {
        // 单个文件清理失败不影响主流程
      }
    }
  }
  catch {
    // 目录读不了就算了，主流程会给出更准确的错误
  }
}

/**
 * 向 agent 进程索取一份**真实**请求头（带耗时与 uskey 长度，便于诊断）。
 *
 * @throws {MarvisBridgeError} 带 `code` / `hint`，调用方应转成用户可读错误
 */
export async function requestMarvisHeadersDetailed(
  opts: { convId?: string; respId?: string; agentTag?: string; scene?: string; model?: string | null } = {},
  timeoutMs = 8000,
): Promise<MarvisHeadersResult> {
  ensureRpcDir()
  sweepStale()

  const rid = randomUUID()
  const reqPath = join(USKEY_RPC_DIR, `req-${rid}.json`)
  const respPath = join(USKEY_RPC_DIR, `resp-${rid}.json`)

  // 原子写：先写 .tmp 再 rename，避免钩子读到半截 JSON。
  const tmpPath = `${reqPath}.tmp`
  try {
    writeFileSync(
      tmpPath,
      JSON.stringify({
        conv_id: opts.convId ?? '',
        resp_id: opts.respId ?? '',
        agent_tag: opts.agentTag ?? 'agent_chat',
        scene: opts.scene ?? 'agent_chat',
        model: opts.model ?? null,
      }),
      'utf8',
    )
    renameSync(tmpPath, reqPath)
  }
  catch (error) {
    throw new MarvisBridgeError(
      'RPC_UNAVAILABLE',
      `无法写入 uskey RPC 请求：${error instanceof Error ? error.message : String(error)}`,
      '检查 RPC 目录写权限',
    )
  }

  const startedAt = Date.now()
  const deadline = startedAt + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(respPath)) {
      const raw = readFileSync(respPath, 'utf8')
      try {
        renameSync(respPath, `${respPath}.done`)
      }
      catch {
        // 清理失败不影响结果
      }

      let data: { ok?: boolean; error?: unknown; headers?: Record<string, string> }
      try {
        data = JSON.parse(raw) as typeof data
      }
      catch {
        throw new MarvisBridgeError('HOOK_ERROR', 'uskey 桥返回了无法解析的响应', '通常是钩子正在被改写；重试一次', true)
      }
      if (data.ok !== true) {
        throw new MarvisBridgeError(
          'HOOK_ERROR',
          `uskey 桥失败：${String(data.error).slice(-400)}`,
          '多为 agent 未登录：在 Marvis 客户端里重新登录后再试',
        )
      }

      const headers = data.headers ?? {}
      const elapsedMs = Date.now() - startedAt
      let uskeyLength: number | undefined
      try {
        uskeyLength = (JSON.parse(headers['Ual-Access-MarvisExt'] ?? '{}') as { uskey?: string }).uskey?.length
      }
      catch {
        uskeyLength = undefined
      }
      return { headers, elapsedMs, uskeyLength }
    }
    await new Promise((resolve) => setTimeout(resolve, 120))
  }

  // 超时：区分「钩子没装」「agent 没起」「就是慢」——文案完全不同。
  const status = inspectMarvisBridge()
  if (status.install === undefined || !status.install.hookInstalled) {
    throw new MarvisBridgeError('HOOK_MISSING', '从 MarvisAgent 取请求头超时：uskey 钩子未安装', status.summary)
  }
  if (!status.agentRunning) {
    throw new MarvisBridgeError(
      'AGENT_DOWN',
      '从 MarvisAgent 取请求头超时：Marvis 未运行',
      '启动 Marvis 客户端后重试（本渠道复用它进程内的 uskey 生成能力）',
    )
  }
  throw new MarvisBridgeError('TIMEOUT', `从 MarvisAgent 取请求头超时（${timeoutMs}ms）`, 'agent 忙或刚启动；重试通常即可', true)
}

/**
 * 向 agent 进程索取一份**真实**请求头（只返回 headers 的便捷形式）。
 *
 * @throws {MarvisBridgeError}
 */
export async function requestMarvisHeaders(
  opts: { convId?: string; respId?: string; agentTag?: string; scene?: string; model?: string | null } = {},
  timeoutMs = 8000,
): Promise<Record<string, string>> {
  const { headers } = await requestMarvisHeadersDetailed(opts, timeoutMs)
  return headers
}

/** 快速探活：桥是否可用（会真的取一次头，故有 ~300ms 开销）。 */
export async function probeUskeBridge(): Promise<boolean> {
  try {
    const headers = await requestMarvisHeaders({}, 3000)
    return typeof headers['Ual-Access-MarvisExt'] === 'string'
  }
  catch {
    return false
  }
}