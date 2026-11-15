/**
 * Qoder 出站请求头的**形态对齐**：`Cosy-MachineOS`（可选 `Cosy-MachineHostname`）。
 *
 * ## 缺口是怎么确认的（实测 dump，不是推断）
 *
 * 2026-11-16 直接 dump 了签名 WASM 生成的两套头表（`prepareInfer` 与
 * `prepareRequest`，两条通道**都**已自带这些）：
 *
 * ```
 * Accept / Accept-Encoding / Authorization / Content-Type / Cache-Control / Connection
 * Cosy-Business-Product / Cosy-Business-Type / Cosy-ClientIp / Cosy-ClientType
 * Cosy-Data-Policy / Cosy-Date / Cosy-Key / Cosy-MachineId / Cosy-MachineToken
 * Cosy-MachineType / Cosy-Scene / Cosy-User / Cosy-Version / Login-Version
 * X-Model-Key / X-Model-Source
 * ```
 *
 * ⇒ **`Cosy-MachineOS` 与 `Cosy-MachineHostname` 不在其中**，其余（含
 * `Login-Version: v2`、`Cosy-ClientIp`、`Cosy-MachineId/Token/Type`）都已自带。
 * 所以本模块**只补这两个**，不去重复生成 WASM 已有的头 —— 那是「恒真断言」
 * （补了也永远命中不了「缺失」分支，等于死代码）。
 *
 * ## ⚠️⚠️ 功能上**不是必需**（先说清楚，别当成缺陷修复）
 *
 * `qoder-machine.ts` 的消融表已证明：`/sash/api/v1/me/campaigns` 拿到「可领取」
 * 活动**只需要** `Cosy-MachineToken` + `Cosy-MachineType`（成对），
 * `MachineOS` / `MachineHostname` / `MachineId` / `MachineCode` **去掉后仍然能拿到**。
 *
 * 所以本模块补的**不是功能项**，而是**形态一致性**：官方请求层会带
 * `cosy-machineos`（所有请求）、`cosy-machinehostname`（infer-sse 场景），
 * 我们不带就等于在请求集合里留了一条稳定可聚类的特征。补上不加分、不补不减分
 * ⇒ 默认开，但必须能一键关（见 {@link qoderAlignHeadersEnabled}）。
 *
 * ## 证据强度（如实标注，别当成客户端产物实证）
 *
 * | 结论 | 强度 |
 * |---|---|
 * | 两条通道的头表**缺** `Cosy-MachineOS` / `Cosy-MachineHostname` | **高**：本仓库 WASM 实测 dump |
 * | 官方请求层会带这两个头 | **中**：抓包头表（`qoder-machine.ts` 顶部）+ 同类实现逆向 |
 * | 这两个头**不影响**签到活动下发 | **高**：`qoder-machine.ts` 的逐项消融 |
 * | 追加这两个头**不会**破坏 COSY 签名 | **中高**：签名覆盖 `payload + key + date + body + path`（同类纯 Python 复刻实现），不含头表；且 WASM 自己在签名后还会追加 `Login-Version` / `Accept` / `Cache-Control` 等头 ⇒ 头表不在签名内。**本仓库未做真机复测** |
 *
 * ⇒ 最后一行仍是「未真机复测」，所以给了开关，且**只补缺失**。
 *
 * ## 三条不可越过的线
 *
 * 1. **只补缺失**：WASM 生成的头、调用方显式给的头一律不动。签名相关的
 *    `Authorization` / `Cosy-Version` / `Cosy-Date` / `Cosy-Key` / `Cosy-User`
 *    连「补」的可能都没有 —— 它们不在 {@link alignmentEntries} 里，这是
 *    「单一真相源」而不是「记得别改」。
 * 2. **hostname 默认不发**：官方发的是**运行客户端那台机器**的主机名；网关跑在
 *    服务器/容器里时发出去的是宿主机名或容器 id —— 那是把本机标识透给上游的
 *    信息披露面（与本仓库「代理口令的泄漏面：去向决定定级」同一取舍）。
 *    需要更贴近桌面端形态时显式设 `DSH_QODER_ALIGN_HOSTNAME=1`。
 * 3. **只用于 COSY 签名请求**（推理 / 原生搜索）：`/sash/` 那条腿是**桌面 app
 *    身份**（`Cosy-ClientType: 10`），它的头表另有消融结论，不在这里掺和。
 */

import { hostname } from 'node:os'

/**
 * 是否启用补头（默认**开**；`DSH_QODER_ALIGN_HEADERS=0` 关）。
 *
 * 正则与 `qoderTrafficGuardEnabled` 同款：只认明确的否定词，其余一律视为开
 * —— 这样「拼错一个词」不会静默改变线上行为。
 */
export function qoderAlignHeadersEnabled(): boolean {
  return !/^(0|off|false|no)$/i.test(process.env.DSH_QODER_ALIGN_HEADERS?.trim() ?? '')
}

/**
 * 是否补 `Cosy-MachineHostname`（默认**关**）。
 *
 * 默认关的理由见文件头第 2 条：它会把**本机主机名**发给上游。这是刻意的
 * 「宁可不那么像，也不多透一点」。
 */
export function qoderAlignHostnameEnabled(): boolean {
  return /^(1|on|true|yes)$/i.test(process.env.DSH_QODER_ALIGN_HOSTNAME?.trim() ?? '')
}

/** 进程内缓存（取值只依赖 `process.platform` / `process.arch` / 一个环境变量）。 */
let cachedMachineOs: string | undefined

/**
 * 计算 `Cosy-MachineOS`：官方形态是 `{arch}_{platform}`（共 6 种组合）。
 *
 * ⚠️ 这里**跟随当前系统**（不像同类实现那样把非 Windows 一律写成
 * `x86_64_linux`）：那个「不漂移」的取舍是为了保护**已经发过该头**的存量号池；
 * 本仓库此前从不发这个头 ⇒ 没有历史值要保，如实反映运行环境才是对的
 * （容器里跑 Linux 就发 `x86_64_linux`，与官方客户端在那台机器上的行为一致）。
 *
 * `DSH_QODER_MACHINE_OS` 可覆盖（排查 / 迁移用）。
 */
function computeMachineOs(): string {
  const override = process.env.DSH_QODER_MACHINE_OS?.trim()
  if (override !== undefined && override.length > 0) return override
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64'
  if (process.platform === 'win32') return `${arch}_win32`
  if (process.platform === 'darwin') return `${arch}_darwin`
  return `${arch}_linux`
}

/** 取 `Cosy-MachineOS`（进程内缓存，避免每个请求都读环境变量）。 */
export function qoderMachineOs(): string {
  cachedMachineOs ??= computeMachineOs()
  return cachedMachineOs
}

/** 仅供测试：清缓存（生产代码不需要 —— 平台与架构不会中途变）。 */
export function resetQoderAlignCache(): void {
  cachedMachineOs = undefined
}

/**
 * 要补的头清单 —— **单一真相源**。
 *
 * 两个调用点（`Headers` / 普通对象）共用它，避免出现「一个文件两套同义判据」
 * （`docs/agent-notes/misc.md` 记过的真实缺陷形态）：两处各写一份清单时，
 * 加头只加一处、另一处静默漏发，而两边测试都绿。
 *
 * @returns 有序 `[name, value]`；不含任何签名相关头，也不含 WASM 已自带的头
 *   （`Login-Version` / `Cosy-ClientIp` / `Cosy-MachineId` …，见文件头的 dump）。
 */
function alignmentEntries(): Array<[string, string]> {
  const entries: Array<[string, string]> = [['Cosy-MachineOS', qoderMachineOs()]]
  if (qoderAlignHostnameEnabled()) {
    const machine = hostname()
    if (machine.length > 0) entries.push(['Cosy-MachineHostname', machine])
  }
  return entries
}

/**
 * 核心：按 `has` / `set` 两个最小操作补头。
 *
 * 抽出来是为了让 `Headers` 与普通对象**共用同一份判定**（见
 * {@link alignmentEntries} 的说明），两个公开函数只做容器适配。
 *
 * @returns 是否真的补了至少一个头（调用方可据此决定要不要重建请求对象）。
 */
function applyAlignment(
  has: (name: string) => boolean,
  set: (name: string, value: string) => void,
): boolean {
  if (!qoderAlignHeadersEnabled()) return false
  let changed = false
  for (const [name, value] of alignmentEntries()) {
    // 只补缺失：已有值（尤其 WASM 生成的）一律不动。
    if (has(name)) continue
    set(name, value)
    changed = true
  }
  return changed
}

/**
 * 给 **`Headers`** 补形态头（原地修改并返回同一个实例）。
 *
 * 用在推理通道：`sendEncrypted` 里那个 `new Headers(request.headers)` 之后。
 */
export function applyQoderAlignmentHeaders(headers: Headers): Headers {
  applyAlignment(
    (name) => headers.has(name),
    (name, value) => headers.set(name, value),
  )
  return headers
}

/**
 * 给**普通对象**头表补形态头（返回新对象，不改入参）。
 *
 * 用在原生搜索：那里的头是 `{ ...req.headers, 'X-Session-ID': … }` 这种对象字面量，
 * 不是 `Headers`。返回新对象是为了让调用点永远用返回值，避免「补了但没用上」
 * 这种一眼看不出的失效。
 *
 * ⚠️ 对象键大小写不敏感比较：`req.headers` 来自 WASM 头表，键名形态由 Rust 侧决定
 * （`Cosy-MachineOS` / `cosy-machineos` 都可能），大小写敏感比较会重复补一个头。
 */
export function withQoderAlignmentHeaders(headers: Record<string, string>): Record<string, string> {
  const existing = new Set(Object.keys(headers).map((key) => key.toLowerCase()))
  const out = { ...headers }
  applyAlignment(
    (name) => existing.has(name.toLowerCase()),
    (name, value) => {
      out[name] = value
    },
  )
  return out
}
