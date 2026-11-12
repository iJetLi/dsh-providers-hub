export const DEFAULT_GATEWAY_HOST = '127.0.0.1'
export const DEFAULT_GATEWAY_PORT = 8326

/**
 * 「允许局域网访问」设置页开关（2026-10-20）打开时的监听地址：绑全部网卡。
 *
 * ⚠️⚠️ 与 {@link isWildcardHost} 的关系必须说清：那个 fail-closed 闸门拦的是
 * **env 字符串解析链上的意外通配**（不可见字符、`U+3002` 表意句号、全角数字等
 * 三轮审计实测的绕过形态）——它防的是「用户写了个看起来无害的串，内核却绑了
 * 全网卡」。而这里的 `'0.0.0.0'` 是**程序内字面量**：没有解析环节、没有绕过面，
 * 是用户在设置页里**显式**做出的选择（开关默认关闭，打开时 UI 会同步给出
 * 暴露面警告）。两者正交，谁也不取代谁。
 */
export const WILDCARD_GATEWAY_HOST = '0.0.0.0'

export interface OpenAiGatewayConfig {
  host: string
  port: number
}

/**
 * 网关开关。只有**显式**的假值才停用，未设置时默认启用（保持既有行为）。
 *
 * ⚠️ 不能写成 `parseInt(raw) || 1` 这类形式：`'0'` 是**合法**的停用值，
 * 而 `0` 是 falsy 会被 `||` 静默换回默认值 —— 开关会「关不掉」。
 * 判定只看归一化后的字符串，与本仓库 Qoder 环境变量的同一教训同源。
 */
export function isGatewayEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.DSH_OPENAI_GATEWAY_ENABLED?.trim().toLowerCase()
  if (raw === undefined || raw === '') return true
  return raw !== '0' && raw !== 'false' && raw !== 'off' && raw !== 'no'
}

/**
 * 全部「不该出现在地址里」的字符类别（**按 Unicode 类别，绝不枚举码点**）。
 *
 * ⚠️⚠️ 第二轮对抗审计实测：枚举 `[\s\u200b-\u200f…]` 必然漏，而漏一个就等于
 * 漏一条通往「绑全部网卡」的路径（审计在 Windows 上端到端确证 7 条、系统扫描
 * 出 25 条）。逐类都有实测样本：
 *
 * | 类别 | 实测可绕样本 | 说明 |
 * |---|---|---|
 * | `Cf` 格式 | `\u00ad` 软连字符、`\u180e` 蒙古文元音分隔符、`\u2061`–`\u2064`、`\u206a`–`\u206f` | 160+ 码点，枚举必漏 |
 * | `Mn`/`Me` 组合标记 | `\u034f` CGJ（**它是 `Mn` 不是 `Cf`**） | 不占宽度、内核忽略 |
 * | `Cc` 控制 | `\u0000`–`\u001f` | |
 * | `Zs`/`Zl`/`Zp` 分隔 | 空格、NBSP、行/段分隔 | |
 * | `Cs` 代理 | 落单的代理码元 | |
 *
 * ⚠️ **`\p{Mn}` 是第二轮才补上的**：`\u034f`（CGJ）在 Unicode 里是组合用附加符号，
 * 不在 `Cf` 里 —— 只按 `Cf` 过滤会把它漏掉，而实测它同样能让内核绑全网卡。
 */
const INVISIBLE = /[\p{Cf}\p{Cc}\p{Cs}\p{Mn}\p{Me}\p{Zs}\p{Zl}\p{Zp}]/gu

/**
 * 归一化：把用户可能写的各种形态收敛成**判据可比较的裸地址**。
 *
 * 四步（顺序有意义）：
 *
 * 1. **NFKC 归一化**：全角数字 `０.０.０.０` 是实测可绕的形态（类别过滤拦不住它，
 *    因为它既不可见也不是控制符），NFKC 把它折成半角 `0.0.0.0`；
 * 2. **剥掉全部不可见字符**（按 {@link INVISIBLE} 的类别）；
 * 3. **剥方括号与 `:端口`**（含**空端口** `[::]:` —— 第二轮实测的独立成因：
 *    原正则 `(?::\d+)?` 不匹配空端口 ⇒ 整串原样放行 ⇒ 内核照绑 `::`）；
 * 4. **剥 zone id**（只对 IPv6 形态）。
 *
 * ⚠️ 这个函数**只给判据用**。交给 `listen()` 的形态走
 * {@link stripHostBrackets}，它**保留 zone id** —— 见那里的注释。
 */
function normalizeHostForCompare(host: string): string {
  // ⚠️⚠️ **非字符串必须当空串**（2026-10-22 对抗审计 m-1）：
  //   本函数是 `isWildcardHost` / `isLoopbackHost` 的**唯一归一化入口**，
  //   而客户端（`openai-gateway-panel.js`）会拿 `status.address?.host` 直接调它。
  //   实测：`running:true` + `address:null` 是**合法组合**（宿主侧 `running`与
  //   `address` 是两次独立 `degrade`）⇒ `undefined.normalize()` 抛
  //   `TypeError: Cannot read properties of undefined (reading 'normalize')`
  //   ⇒ **整个网关状态面板直接崩**（用户只看到一片空白）。
  //
  // ⚠️ 归为**空串**是异常方向正确的：
  //   - 对 `isWildcardHost`：空串 ⇒ `true`（当成通配、**拒绝**）—— fail-closed；
  //   - 对 `isLoopbackHost`：空串 ⇒ `true`（当成回环）—— 与它“空 host 不告警”的既有语义一致。
  //   两者都比「报 TypeError」好。
  if (typeof host !== 'string') return ''
  let value = host.normalize('NFKC').replace(INVISIBLE, '')
  // 剥方括号与端口。⚠️ `\d*`（不是 `\d+`）：`[::]:` 的空端口也要剥掉。
  const bracketed = /^\[([^\]]*)\](?::\d*)?$/.exec(value)
  if (bracketed !== null) {
    value = bracketed[1]!
  } else if (/^[^:]+:\d*$/.test(value)) {
    // 裸 `host:port`（IPv4 / 主机名）。⚠️ 不能对裸 IPv6 用这条：`::1` 会被切成 `:`。
    value = value.slice(0, value.lastIndexOf(':'))
  }
  // 幂等地剥掉可能残留的方括号（`[[::1]]`）。
  while (value.startsWith('[') && value.endsWith(']') && value.length > 2) {
    value = value.slice(1, -1)
  }
  // 只对 IPv6 形态剥 zone id（`%` 之后到串尾）。
  if (value.includes(':')) {
    const zone = value.indexOf('%')
    if (zone > 0) value = value.slice(0, zone)
  }
  return value
}

/**
 * 交给 `server.listen()` 的地址形态。
 *
 * ⚠️ 与 {@link normalizeHostForCompare} **必须分开**（第二轮审计实测的回归）：
 * 判据需要剥 zone id（`::%eth0` 就是 `::` ⇒ 必须判为通配），但**交给 `listen()`
 * 的串不能剥** —— Linux 上 `fe80::215:5dff:fe1c:fc88%eth0` **带 zone 能 bind**
 * （scope id 生效），剥成裸地址后反而 `EINVAL(22)` 绑不上。把两者合成一个函数
 * 会让「修好判据」与「弄坏 link-local」同时发生。
 *
 * 仍然要剥掉的是：不可见字符（它们绝不会是地址的一部分）、方括号、端口。
 */
export function stripHostBrackets(host: string): string {
  let value = host.normalize('NFKC').replace(INVISIBLE, '')
  const bracketed = /^\[([^\]]*)\](?::\d*)?$/.exec(value)
  if (bracketed !== null) {
    value = bracketed[1]!
  } else if (/^[^:]+:\d*$/.test(value)) {
    value = value.slice(0, value.lastIndexOf(':'))
  }
  while (value.startsWith('[') && value.endsWith(']') && value.length > 2) {
    value = value.slice(1, -1)
  }
  return value
}

/**
 * 地址里**允许出现**的字符（ASCII）。
 *
 * ⚠️⚠️ **这是 fail-closed 的最后一道闸门，第三轮审计实测补上。**
 *
 * 前三版判据都是「**认不出来就放行**」（fail-open），而攻击面是**无界**的：
 * 内核会把一堆**非 ASCII 的分隔符**当成 `.`，例如 **`U+3002` 表意句号**
 * （类别 `Po`，NFKC **不**折它）。实测 `0。0。0。0`：
 *
 * - 判据：`parseIpv4` 解析失败 ⇒ **放行**；
 * - 内核：**真的绑上全部网卡**（从局域网 IP 反连得到 `HTTP 200`）。
 *
 * 逐个补分隔符是不可能的（`Po` / `Mc` / `Co` / `Cn` … 各类都有候选）。⇒ 反过来做：
 * **只放行确定合法的字符**，其余一律判非法并拒绝。合法集合就是主机地址真正会
 * 用到的那几类（IPv4 / IPv6 / 主机名 / zone id）；国际域名请用 punycode。
 *
 * ⚠️ 该集合覆盖本 issue 的全部正解（`127.0.0.1` / `172.21.0.8` / `::1` /
 * `fe80::1%eth0` / `localhost` / `host.docker.internal`），**不误伤**。
 */
const LEGAL_HOST = /^[A-Za-z0-9.:%_-]+$/

/**
 * 是否只含合法主机字符（ASCII 字母数字 + `.` `:` `%` `_` `-`）。
 *
 * ⚠️ 空串不算合法（调用方另有回落逻辑）。这是**判据侧**的闸门：不含非法字符
 * 才继续走通配识别，否则直接拒绝（fail-closed）—— 不再依赖「解析失败就放行」。
 */
export function isLegalHostText(host: string): boolean {
  return host !== '' && LEGAL_HOST.test(host)
}

/**
 * 把裸地址还原成**能放进 URL** 的形态（IPv6 必须加方括号）。
 *
 * ⚠️ 这是本 issue 带出来的连带缺陷：`http://${host}:${port}` 对
 * `::1` 会拼出 `http://::1:8326`，那不是一个合法 URL（端口被解析成 IPv6
 * 的一段）—— 设置页会展示一个抄不走、连不上的地址，而排障方向会跑偏到
 * 「网关没起」。凡是往 URL 里塞 host 的地方都必须过这个函数。
 *
 * ⚠️⚠️ **URL 里必须剥掉 zone id**（第三轮审计实测的回归）：`listen()` 侧要
 * **保留** zone（`fe80::1%eth0` 才绑得上 link-local），但 URL 语法里
 * **没有** zone id 的位置 —— 实测 `new URL('http://[fe80::1%eth0]:8326/v1')`
 * 抛 `ERR_INVALID_URL`。⇒ 面板与日志会给出一个抄走连不上的地址，正是第一轮
 * 修过的同型缺陷。规范做法是把 `%` 转义成 `%25`，但浏览器与多数客户端都
 * 不支持带 zone 的 URL，故这里**直接剥掉**：同一网卡上的地址不带 zone 也
 * 能连（客户端与网关同机时 zone 是冗余的）。
 *
 * ⇒ **两个方向都要保住**：`listen` 串留 zone（{@link stripHostBrackets}），
 * URL 串剥 zone（本函数）。
 */
export function formatGatewayHost(host: string): string {
  const value = stripHostBrackets(host)
  // 剥 zone id（只对 IPv6 形态；`%` 在 URL 里非法）。
  const zone = value.includes(':') ? value.indexOf('%') : -1
  const bare = zone > 0 ? value.slice(0, zone) : value
  return bare.includes(':') ? `[${bare}]` : bare
}

/** 拼网关基地址（含协议与端口）。`suffix` 传 `/v1` 之类的路径。 */
export function gatewayHttpUrl(host: string, port: number, suffix = ''): string {
  return `http://${formatGatewayHost(host)}:${port}${suffix}`
}

/**
 * 把 IPv6 字面量展开成 **8 组 16 位**（`::` 按 RFC 4291 补零）。
 *
 * ⚠️ 必须自己展开，**不能**靠 `new URL()` 规范化：它对 `::%eth0` / `::\u200b`
 * 抛错，而 `catch` 放行就是本 issue 的高危假阴性（见 {@link stripHostBrackets}）。
 * 返回 `undefined` 表示「不是合法 IPv6 字面量」—— 调用方据此**放行**
 * （交给内核报错），而不是猜成通配。
 */
function expandIpv6(value: string): number[] | undefined {
  const text = value.toLowerCase()
  if (!/^[0-9a-f:.]+$/.test(text)) return undefined
  const halves = text.split('::')
  if (halves.length > 2) return undefined
  const parse = (part: string): number[] | undefined => {
    if (part === '') return []
    const groups = part.split(':')
    const out: number[] = []
    for (let index = 0; index < groups.length; index++) {
      const group = groups[index]!
      // 尾组允许 IPv4 点分写法（`::ffff:127.0.0.1`）。
      if (group.includes('.')) {
        if (index !== groups.length - 1) return undefined
        const octets = group.split('.')
        if (octets.length !== 4) return undefined
        const nums = octets.map((octet) => (/^\d{1,3}$/.test(octet) ? Number(octet) : Number.NaN))
        if (nums.some((num) => !Number.isInteger(num) || num < 0 || num > 255)) return undefined
        out.push((nums[0]! << 8) | nums[1]!, (nums[2]! << 8) | nums[3]!)
        continue
      }
      if (!/^[0-9a-f]{1,4}$/.test(group)) return undefined
      out.push(Number.parseInt(group, 16))
    }
    return out
  }
  const head = parse(halves[0]!)
  if (head === undefined) return undefined
  if (halves.length === 1) return head.length === 8 ? head : undefined
  const tail = parse(halves[1]!)
  if (tail === undefined) return undefined
  const missing = 8 - head.length - tail.length
  if (missing < 1) return undefined
  return [...head, ...Array.from({ length: missing }, () => 0), ...tail]
}

/**
 * IPv4 解析，**兼容 `inet_aton` 的历史写法**。
 *
 * ⚠️ 为什么必须兼容，而不是只认点分四段：Linux 的 `inet_aton`（glibc）接受
 * 单段（`2130706433`）、两段（`127.1`）、三段、十六进制段（`0x0`）、八进制段
 * （`0177.0.0.1`）与尾随点（`0.0.0.0.`）。这些写法在**容器（Linux）**上会被
 * 解析成真实地址 —— 其中 `0` / `0x0` / `00.0.0.0` 全是 `0.0.0.0`（通配）。
 *
 * ⚠️ 初版把归一化交给 `new URL()`，恰好把这些紧凑写法规范化成了 `0.0.0.0`
 * 并拒掉；若换成「只认点分四段」的实现，反而会**放宽**成放行 —— 那是一次
 * 严格性回退（独立审计的穷举用例会先变红）。
 *
 * 返回 `undefined` 表示「不是 IPv4 字面量」（主机名、畸形串）⇒ 调用方放行。
 */
function parseIpv4(value: string): number | undefined {
  const text = value.endsWith('.') ? value.slice(0, -1) : value
  const parts = text.split('.')
  if (parts.length === 0 || parts.length > 4) return undefined
  const nums: number[] = []
  for (const part of parts) {
    if (part === '') return undefined
    let num: number
    if (/^0[xX][0-9a-fA-F]+$/.test(part)) {
      num = Number.parseInt(part.slice(2), 16)
    } else if (/^0[0-7]+$/.test(part)) {
      // ⚠️ 八进制只在**有前导 0 且后面全是 0-7** 时成立（`08` 不是八进制）。
      num = Number.parseInt(part.slice(1), 8)
    } else if (/^\d+$/.test(part)) {
      num = Number(part)
    } else {
      return undefined
    }
    if (!Number.isSafeInteger(num) || num < 0) return undefined
    nums.push(num)
  }
  // `inet_aton` 的段数语义：最后一段占满剩余的字节数。
  const last = nums[nums.length - 1]!
  const limit = 256 ** (4 - nums.length + 1)
  if (last >= limit) return undefined
  for (const num of nums.slice(0, -1)) if (num > 255) return undefined
  let result = 0
  for (const num of nums.slice(0, -1)) result = (result << 8) | num
  // 单段时 `4 - 1 + 1 = 4` ⇒ `last` 占满 32 位。
  return ((result * limit) + last) >>> 0
}

/**
 * 是否等价于「绑定所有网卡」的通配地址。
 *
 * ⚠️⚠️ **判据不得依赖 `new URL()` 的宽容度**（初版就是，被两轮审计实测证伪）：
 * 它对含 `%`（zone id）、不可见字符、`host:port` 的输入会**抛错**，而 `catch`
 * 里 `return false`（放行）会让这些写法静默绑上全部网卡。故这里：
 *
 * 1. 先用 {@link normalizeHostForCompare} 把地址摘干净
 *    （NFKC + Unicode 类别剥不可见字符 + 端口 + **zone id**）；
 * 2. IPv4 走 {@link parseIpv4}（含 `inet_aton` 紧凑写法）判「是否为 0」；
 * 3. IPv6 走 {@link expandIpv6} 展开成 8 组后判「是否全零」，
 *    IPv4-mapped（`::ffff:0.0.0.0`）也据此判为通配（它绑全部 IPv4 网卡）。
 *
 * 解析不出来的形态**一律放行**（交给内核报 `ENOTFOUND` / `EADDRNOTAVAIL`）：
 * 猜成通配会把用户确实想用的主机名（容器服务名等）挡在启动之外，而那种误伤
 * 没有内核报错兜底（用户只会看到「不允许」却不知道自己写错了什么）。
 * ⚠️ 但**「放行」的前提是归一化已经把不可见字符摘干净** —— 否则漏一个 `Cf`
 * 就等于漏一条通往全网卡的路径（第二轮审计实测 25 条）。
 */
export function isWildcardHost(host: string): boolean {
  const value = normalizeHostForCompare(host)
  if (value === '') return true
  if (!value.includes(':')) return parseIpv4(value) === 0
  const groups = expandIpv6(value)
  if (groups === undefined) return false
  // 全零 ⇒ `::`（绑所有 IPv6 网卡，实测也覆盖 IPv4）。
  if (groups.every((group) => group === 0)) return true
  // `::ffff:0:0` / `::ffff:0.0.0.0` ⇒ 全部 IPv4 网卡。
  const mapped = groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff
  return mapped && groups[6] === 0 && groups[7] === 0
}

/**
 * 是否只绑在本机回环上（供 UI 判断「安全声明该怎么说」）。
 *
 * ⚠️ **与 `isWildcardHost` 同源**：两者都走 {@link normalizeHostForCompare}。
 * 初版客户端自己写了一套字面量正则（`/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/` +
 * `=== '[::1]'`），于是 `127.1` / `0:0:0:0:0:0:0:1` / `::ffff:127.0.0.1` /
 * `localhost` 这些**内核实测只在回环可达**的写法被判成「已对外暴露」——
 * 面板因此输出它自己声称要消除的那种错误陈述（审计实测）。
 *
 * 判据：`127.0.0.0/8` 整个网段 + `::1` + IPv4-mapped 回环 + `localhost`。
 * ⚠️ 主机名只认 `localhost`（不做 DNS）：其余主机名**未知即按「不只回环」**
 * 处理（宁可多提示，不漏暴露风险）。
 */
export function isLoopbackHost(host: string): boolean {
  const value = normalizeHostForCompare(host).toLowerCase()
  if (value === '') return true
  if (value === 'localhost' || value.endsWith('.localhost')) return true
  if (!value.includes(':')) {
    const ipv4 = parseIpv4(value)
    if (ipv4 === undefined) return false
    // `127.0.0.0/8`：Linux 实测绑 127.0.0.2 后 127.0.0.1 连不上、反之亦然 ——
    // 同一网段里的不同回环地址，对外都不可达。
    return ipv4 >>> 24 === 127
  }
  const groups = expandIpv6(value)
  if (groups === undefined) return false
  // `::1`
  if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) return true
  // `::ffff:127.0.0.0/8`（IPv4-mapped 回环）：
  // `::ffff:127.0.0.1` → 组 6 = `0x7f00`、组 7 = `0x0001` ⇒ 高字节 127。
  const mapped = groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff
  return mapped && groups[6]! >>> 8 === 0x7f
}

/**
 * 解析监听地址。
 *
 * ⚠️ `server.listen()` 收到 `[::1]` 会得到一个必然 `EADDRNOTAVAIL` 的启动
 * 失败，故这里剥方括号，让用户按 URL 习惯粘贴也能用。
 *
 * ⚠️⚠️ **判据与返回值刻意走两个函数**：判据用 `isWildcardHost`（内部剥 zone id），
 * 返回值用 {@link stripHostBrackets}（**保留 zone id**）。第二轮审计实测的回归：
 * 合成一个函数会剥掉 `fe80::1%eth0` 的 zone ⇒ Linux 上 `bind` 反而 `EINVAL(22)`
 * （带 zone 本来能绑成功）⇒ 用户再也绑不上 link-local 地址。
 *
 * ⚠️ **整体取舍：只做通配地址这一条判据，不做「这个地址在本机存不存在」的
 * 预检**。理由：那需要 DNS 查询（`localhost` / `host.docker.internal` /
 * 容器里的服务名都靠它），会把一个纯函数变成异步 + 依赖网络环境的东西；
 * 而内核在 `listen()` 时给出的 `EADDRNOTAVAIL` / `ENOTFOUND` 已经是明确
 * 且带地址的报错（`server.ts` 会原文记进日志）。**别为了「更早失败」把它
 * 改成 DNS 预检**。
 */
function resolveHost(env: NodeJS.ProcessEnv): string {
  const raw = env.DSH_OPENAI_GATEWAY_HOST
  if (raw === undefined || raw.trim() === '') return DEFAULT_GATEWAY_HOST
  const host = stripHostBrackets(raw)
  // ⚠️ 归一化后为空（值只有空白或只有不可见字符）⇒ 回落默认。**绝不能把空串
  // 交给 `listen()`**：那会被当成「绑全部网卡」，正是本判据要防的事。
  if (host === '') return DEFAULT_GATEWAY_HOST
  // ⚠️⚠️ **fail-closed 闸门（第三轮审计实测补上）**：只放行确定合法的字符。
  // 反过来「认不出来就放行」在本 issue 里是**高危**的 —— 内核会把 `U+3002`
  // 表意句号之类的非 ASCII 分隔符当成 `.`，实测 `0。0。0。0` 真的绑上全部网卡，
  // 而「解析失败 ⇒ 放行」的写法会放它过去。**顺序必须在通配判据之前**。
  if (!isLegalHostText(host)) {
    throw new Error(
      `DSH_OPENAI_GATEWAY_HOST 含非法字符（${raw}）：只接受 IPv4 / IPv6 / 主机名形态`
      + '（ASCII 字母数字与 `.` `:` `%` `_` `-`）。'
      + '若确实要用非 ASCII 主机名，请改用 punycode 写法（如 `xn--…`）。',
    )
  }
  if (isWildcardHost(host)) {
    // ⚠️ 报错要给出**做法**：只说「不允许」会让人去搜「怎么绕过这个校验」，
    // 而容器场景的正解（绑容器自己的接口地址）必须写在错误里。
    throw new Error(
      `DSH_OPENAI_GATEWAY_HOST 不能是通配地址（${raw}）：绑定全部网卡会把网关暴露给整个网络，`
      + '只能靠 API Key 隔离。请填**本机某个具体接口地址** —— 容器里通常是容器自身 IP'
      + '（`hostname -i` 或 `ip -4 addr show eth0` 可查，如 172.21.0.8），'
      + '本机直连保持默认 127.0.0.1 即可。',
    )
  }
  return host
}

/**
 * env 是否**显式**给了监听 host。
 *
 * 「允许局域网访问」设置页开关据此判断自己会不会被覆盖：env 是运维口径，
 * 优先级高于 UI 开关（与 `DSH_OPENAI_GATEWAY_ENABLED` 优先于设置页开关同一
 * 取向，见 `runtime.ts` 的注释）。开关打开但 env 给了 host 时，UI 必须明说
 * 「这个开关此刻不生效」，否则又是一个「打开了却没反应」。
 */
export function isGatewayHostFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.DSH_OPENAI_GATEWAY_HOST
  return raw !== undefined && raw.trim() !== ''
}

export function gatewayPublicUrl(env: Readonly<Record<string, string | undefined>>): string | null {
  const raw = env.DSH_OPENAI_GATEWAY_PUBLIC_URL
  if (raw === undefined || raw.trim() === '') return null
  const text = raw.trim()
  let url: URL
  try {
    url = new URL(text)
  } catch {
    throw new Error(`DSH_OPENAI_GATEWAY_PUBLIC_URL 不是合法地址（${text}）：应形如 https://example.com/v1`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`DSH_OPENAI_GATEWAY_PUBLIC_URL 只接受 http / https（${text}）`)
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new Error(`DSH_OPENAI_GATEWAY_PUBLIC_URL 不得带用户名口令、查询串或片段（${text}）`)
  }
  return text.replace(/\/+$/, '')
}

/** {@link resolveGatewayConfig} 的可选项。 */
export interface ResolveGatewayConfigOptions {
  /**
   * 「允许局域网访问」设置页开关（默认 `false` = 只绑 127.0.0.1，老用户行为不变）。
   *
   * ⚠️ `true` 时绑定 {@link WILDCARD_GATEWAY_HOST}——这是**程序内字面量**，
   * 不经过 {@link resolveHost} 的字符串解析链，因此 IKL7UN 的 fail-closed 闸门
   * （防意外通配）不适用也不需要适用。⚠️ env 显式给了 `DSH_OPENAI_GATEWAY_HOST`
   * 时本开关**不生效**（env 优先，见 {@link isGatewayHostFromEnv}）。
   */
  allowLan?: boolean
}

/** 解析本机网关配置，地址/端口错误时显式失败，避免静默换端口或静默监听全网卡。 */
export function resolveGatewayConfig(
  env: NodeJS.ProcessEnv = process.env,
  options: ResolveGatewayConfigOptions = {},
): OpenAiGatewayConfig {
  const host = resolveHost(env)
  const rawPort = env.DSH_OPENAI_GATEWAY_PORT
  const port = (() => {
    if (rawPort === undefined || rawPort.trim() === '') return DEFAULT_GATEWAY_PORT
    const parsed = Number.parseInt(rawPort, 10)
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535 || String(parsed) !== rawPort.trim()) {
      throw new Error('DSH_OPENAI_GATEWAY_PORT 必须是 1 到 65535 之间的整数')
    }
    return parsed
  })()
  // 「允许局域网访问」开关：仅当 env 没有显式给 host 时生效（env 优先）。
  // ⚠️ 刻意放在 resolveHost 之后：env 里的通配值仍会被闸门拒绝——开关只能
  // **显式**选择通配，不能让任何字符串解析链「顺便」通配。
  if (options.allowLan === true && !isGatewayHostFromEnv(env)) {
    return { host: WILDCARD_GATEWAY_HOST, port }
  }
  return { host, port }
}
