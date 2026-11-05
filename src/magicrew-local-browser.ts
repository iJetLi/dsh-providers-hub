/**
 * 从**本机浏览器的 localStorage** 里读 magicrew 登录态 —— 不开窗口、不让用户粘任何东西。
 *
 * 这是超级麦吉三种登录方式里**最简单、无门槛**的一条：用户只要在 Edge / Chrome 里
 * 登录过 `www.letsmagic.cn`，凭据就已经躺在磁盘上了。
 *
 * ## ═══ 为什么需要这条路 ═══════════════════════════════════════════════
 *
 * magicrew 没有 OAuth 回调通道，所以「用户在网页上登录成功」这件事，插件原本只能靠
 * 「自己起的那个浏览器」知道。于是有一个反复被报的现象：**用户在自己浏览器里登好了，
 * 插件里却没有多出账号** —— 因为那是另一个浏览器。
 *
 * 但凭据其实就躺在本地：Chromium 系（Edge / Chrome / Brave / 国产 Chromium 系）把
 * localStorage 明文写在
 *
 *     <User Data>/<Default|Profile N>/Local Storage/leveldb/*.log|*.ldb
 *
 * 里，key 是 `_<origin>\x00\x01<name>`，值是 JSON。
 *
 * ## ═══ 读法（与参考实现逐条对齐）═══════════════════════════════════════
 *
 * 把 leveldb 目录按 **latin1** 拼成文本 → 以站点 host 出现的位置开一个 **2000 字节
 * 窗口** → 在窗口里找 `"key":"authorization"` 与 `"key":"organizationCode"`。
 *
 * ⚠️ LevelDB **按 key 排序**，同一 origin 的记录（theme / i18n / userInfo /
 * authorization / organizationCode …）挨在一起，所以窗口内配对是可靠的
 * （实测本机 Edge：`www.letsmagic.cn` 命中、`www.magicrew.ai` 不命中，不会串）。
 * ⚠️ 窗口必须按 **origin** 截断：两个站点的记录可能相邻（用户两个都登录过），
 * 2000 字节的窗口会把国际站的 org 配到国内站的 jwt 上。
 *
 * 成本：本机 Edge 27 MB / 34 ms；全扫通常 < 300 ms。
 *
 * ## ⚠️ 只读
 *
 * 不写文件、不改浏览器数据、不碰 cookie。本模块唯一的副作用是 `readdirSync` /
 * `readFileSync`。
 *
 * ## ⚠️ 不读 magpie 自己的目录
 *
 * 参考实现（`magpie-magicrew-auth/src/local-browser.mjs`）与它同目录，但**刻意不读**
 * `~/.config/magpie` —— 那是 magpie 的落点，本插件不该依赖另一个产品的私有目录。
 */

import { readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { registeredBrowserUserDataRoots } from './chromium-session.js'
import {
  leveldbRecordsText,
  leveldbVisibleRecords,
  readSstableRecords,
  readWalRecords,
  type LeveldbRecord,
} from './leveldb-sstable.js'

/**
 * 窗口宽度。
 *
 * 同一个 origin 的若干条记录挤在一起，2000 字节足够覆盖到 `organizationCode`；
 * 太小会漏、太大可能跨到另一个站点。
 */
export const MAGICREW_LOCAL_WINDOW = 2000

/**
 * 已经 warn 过的 leveldb 文件路径（防 500ms 轮询刷屏）。
 *
 * ⚠️ **按日志出口（`log` 函数身份）分别去重**，不是全局一张表：
 * `magicrew` 与 `magicrewintl` 是两个 `MagicrewAuth` 实例、扫**同一批**浏览器
 * 路径（`magicrewBrowserRoots()` 与 product 无关）。若用模块级 Set 按路径去重，
 * 先跑的那个 provider 会把路径「吃掉」⇒ **另一个 provider 的 logger 永远收不到**
 * （2026-11-05 审计 P2-①）。用 `WeakMap<log, Set<path>>` 让每个实例各报一次；
 * 未注入 `log` 时回落到模块级 `console.warn` 去重表。
 */
const warnedLeveldbFilesByLog = new WeakMap<(message: string) => void, Set<string>>()
const warnedLeveldbFilesDefault = new Set<string>()

/**
 * 每个文件只 warn 一次（跨 500ms 轮询），但**按日志出口分别计数**。
 */
function warnLeveldbParseFailure(
  log: ((message: string) => void) | undefined,
  path: string,
  reason: string,
): void {
  const sink = log ?? console.warn
  let warned = warnedLeveldbFilesByLog.get(sink)
  if (warned === undefined) {
    warned = new Set<string>()
    warnedLeveldbFilesByLog.set(sink, warned)
  }
  const seen = log === undefined ? warnedLeveldbFilesDefault : warned
  if (seen.has(path)) return
  seen.add(path)
  sink(`[magicrew] leveldb 文件解析失败，已跳过：${path}（${reason}）`)
}

/** 登录态（本模块的产物）。⚠️ 字段名由调用方转成 `MagicrewCredential`（`jwt` 同名）。 */
export interface MagicrewLocalCreds {
  /** 网页 JWT。 */
  readonly jwt: string
  /** 组织码 —— 必须与 jwt 配对（错配会得到 HTTP 200 + `code:403`）。 */
  readonly organizationCode: string
  /** JWT `exp` 对应的毫秒时刻；解不出来就没有该字段（**不编造**）。 */
  readonly expiresAt?: number
}

export interface MagicrewLocalBrowserOptions {
  /** 时钟注入（毫秒），只用于「同一份数据里有多把凭据时挑哪把」。 */
  readonly now?: number
  /**
   * 注入的浏览器 User Data 根目录（**单测专用**）。
   *
   * ⚠️⚠️ 单测**绝不能**扫真实浏览器目录：那里的数据随机器而变，
   * 用例会「在开发机上绿、在 CI 上红」，还会读到真实用户的登录态。
   * 缺省走 {@link magicrewBrowserRoots}。
   */
  readonly roots?: readonly string[]
  /**
   * 解析失败时的日志出口（**默认 `console.warn`**，每个文件只报一次）。
   *
   * ⚠️ 存在的意义：整条磁盘腿压在 `catch { return '' }` 上，没有这条日志时
   * 「解析器坏了」与「用户没登录」完全同形（审计 2026-11-05 P1-3）。
   */
  readonly log?: (message: string) => void
}

/** 一个浏览器的 User Data 根目录（`browser` 仅用于日志/诊断）。 */
export interface MagicrewBrowserRoot {
  readonly browser: string
  readonly root: string
}

/**
 * 各平台的浏览器 User Data 根目录；不存在就跳过。
 *
 * ⚠️ Windows 为主（本插件用户面），macOS / Linux 照参考实现给全 —— 少一行
 * 只意味着「那个浏览器上的已登录态读不到」，不会报错，极难发现。
 */
export function magicrewBrowserRoots(): readonly MagicrewBrowserRoot[] {
  const home = homedir()
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local')
    const roaming = process.env.APPDATA || join(home, 'AppData', 'Roaming')
    return [
      // ── 国际主流 ──
      { browser: 'Edge', root: join(local, 'Microsoft', 'Edge', 'User Data') },
      { browser: 'Chrome', root: join(local, 'Google', 'Chrome', 'User Data') },
      { browser: 'Brave', root: join(local, 'BraveSoftware', 'Brave-Browser', 'User Data') },
      { browser: 'Chromium', root: join(local, 'Chromium', 'User Data') },
      { browser: 'Vivaldi', root: join(local, 'Vivaldi', 'User Data') },
      // Windows App Paths 会登记便携版 Chrome；其 `<install>/Data` 不在上面的固定目录里。
      ...registeredBrowserUserDataRoots().map((root) => ({ browser: '已登记浏览器（含便携版）', root })),
      ...process.env.MAGICREW_CHROME_USER_DATA?.trim()
        ? [{ browser: 'Chrome 便携版', root: process.env.MAGICREW_CHROME_USER_DATA.trim() }]
        : [],
      // ── 国产 Chromium 系 ──
      // ⚠️ 参考实现 2026-10-28 实测：用户日常用的是 360 极速浏览器 X（360ChromeX），
      //   它的 localStorage 里确实有 www.letsmagic.cn 的记录。不加这一行，
      //   「本机浏览器已登录就直接认」这条首选路径对它永远不生效 ——
      //   用户明明在网页上登着，插件却还要他再登一次。
      { browser: '360极速浏览器X', root: join(local, '360ChromeX', 'Chrome', 'User Data') },
      { browser: '360浏览器', root: join(local, '360Chrome', 'Chrome', 'User Data') },
      { browser: '360安全浏览器', root: join(roaming, 'secoresdk', '360se6', 'User Data') },
      { browser: 'QQ浏览器', root: join(local, 'Tencent', 'QQBrowser', 'User Data') },
      { browser: '搜狗浏览器', root: join(local, 'SogouExplorer', 'User Data') },
      { browser: '2345浏览器', root: join(local, '2345Explorer', 'User Data') },
      { browser: '猎豹浏览器', root: join(local, 'liebao', 'User Data') },
      { browser: 'UC浏览器', root: join(local, 'UCBrowser', 'User Data') },
      { browser: '夸克浏览器', root: join(local, 'Quark', 'User Data') },
    ]
  }
  if (process.platform === 'darwin') {
    return [
      { browser: 'Chrome', root: join(home, 'Library/Application Support/Google/Chrome') },
      { browser: 'Edge', root: join(home, 'Library/Application Support/Microsoft Edge') },
      { browser: 'Brave', root: join(home, 'Library/Application Support/BraveSoftware/Brave-Browser') },
      { browser: 'Chromium', root: join(home, 'Library/Application Support/Chromium') },
      { browser: 'Vivaldi', root: join(home, 'Library/Application Support/Vivaldi') },
    ]
  }
  return [
    { browser: 'Chrome', root: join(home, '.config/google-chrome') },
    { browser: 'Chromium', root: join(home, '.config/chromium') },
    { browser: 'Edge', root: join(home, '.config/microsoft-edge') },
    { browser: 'Brave', root: join(home, '.config/BraveSoftware/Brave-Browser') },
    { browser: 'Vivaldi', root: join(home, '.config/vivaldi') },
  ]
}

/** 一个 User Data 根目录下的 profile 目录名（`Default` / `Profile 1` …）。 */
export function magicrewProfilesOf(root: string): string[] {
  try {
    return readdirSync(root).filter((name) => name === 'Default' || /^Profile \d+$/.test(name))
  } catch {
    return []
  }
}

/**
 * 单个 leveldb 文件的文本。
 *
 * ## ⚠️⚠️ `.ldb` 必须走 SSTable 解码，**不能**直接 `toString('latin1')`
 *
 * 真机报障 2026-11-04 的根因就在这里：Chromium 把 localStorage 落成若干 `.ldb`
 * （SSTable），里面每条记录都经过 **前缀压缩**、且 data block 整体被 **Snappy 压缩**。
 * 直接按字节读文本 ⇒ `"key":"authorization"` 在原始字节里出现 **0 次**
 * （本机 Edge `071584.ldb` 实测 `indexOf` = -1）⇒ 本机浏览器导入**永远**报
 * 「未找到登录态」，而测试全绿（fixture 是裸文本 `.log`，从没覆盖压缩块）。
 *
 * `.log`（WAL，尚未压实成 SSTable 的尾部写入）是**未压缩**的，仍按 latin1 读 ——
 * 它里面也可能有刚写进去的凭据（用户刚登录完、Edge 还没压实）。
 *
 * ⚠️ latin1 而不是 utf8：leveldb 文件是二进制，utf8 解码会把非法字节换成 U+FFFD、
 * 长度也会变 —— 而窗口是按字节位置算的。latin1 是**逐字节**映射，位置不变。
 *
 * ⚠️ 任何文件解不出来都**只跳过该文件**（被浏览器独占 / 格式不认识），不抛错：
 * 调用方要的是「能不能读到凭据」，不是「这个目录完不完整」。
 *
 * ## ⚠️⚠️ 但**必须留一条日志**（2026-11-05 审计 P1-3）
 *
 * 整条修复都压在这个 `catch` 上 ⇒ 如果解析器本身有 bug（或文件格式又变了），
 * 症状与「用户没登录」**完全同形**（`readMagicrewLocalCreds` 返回 `undefined`
 * ⇒ 调用方降级去开窗口），现场零痕迹、用户只能报「加不上账号」。
 * ⇒ 解析失败时 warn 一次（**每个文件只报一次**，避免 500ms 轮询刷屏），
 * 文案带文件名与错误原因，**不带文件内容**（不泄漏凭据）。
 */
interface LeveldbFileContent {
  /** 结构化记录（`.ldb` / `.sst` 的表记录，或 `.log` 的 WAL 记录）。 */
  readonly records: readonly LeveldbRecord[]
  /** 非 WAL 的普通文件（`LOG` / `MANIFEST-*` / 未知二进制）按 latin1 原文。 */
  readonly rawText: string
}

/**
 * 一个 leveldb 文件的**结构化**内容。
 *
 * ## ⚠️⚠️ 为什么不再直接返回文本（2026-11-05 返工 P2-2 / P2-3）
 *
 * 同一条 localStorage key 的多次写入会横跨 `.ldb`（旧值）与 `.log`（WAL 新值 /
 * tombstone），必须**先收集记录、再按 sequence 取最新**（{@link leveldbVisibleRecords}），
 * 否则「先登出再登录」会配到空值而漏读、「登出」会复活旧 org。
 * ⇒ 本函数只负责**单个文件**的解析与失败隔离，去重与渲染交给 profile 层。
 *
 * `.log` 若是合法 WAL（WriteBatch）就解成记录；**不是**（`LOG`、`MANIFEST-*`、
 * 测试里直接写的明文）则退回 latin1 原文 —— 与旧行为一致，不会因为「不是 WAL」
 * 就丢掉里面的凭据。
 */
function leveldbContentForFile(
  path: string,
  name: string,
  log?: (message: string) => void,
): LeveldbFileContent | undefined {
  let buffer: Buffer
  try {
    buffer = readFileSync(path)
  } catch {
    // 被浏览器独占 / 权限 / 刚被删（Edge 会滚动删文件）⇒ 跳过。
    return undefined
  }
  // ⚠️ `.sst` 是 LevelDB 的另一种表文件后缀（老版本 / 某些分支这样落盘），
  //    与 `.ldb` 同格式；此前只认 `.ldb` ⇒ `.sst` 会退回「原文扫描」那条坏路。
  // ⚠️ 大小写不敏感：Windows 上 `000003.LDB` / `.SST` 是合法变体，漏了就会退回
  //    「原文扫描」那条坏路（从原始字节里编造凭据，2026-11-05 对抗审计 P3-3）。
  const lowerName = name.toLowerCase()
  if (lowerName.endsWith('.ldb') || lowerName.endsWith('.sst')) {
    try {
      return { records: readSstableRecords(buffer), rawText: '' }
    } catch (error) {
      // 不是合法 SSTable（半截写入 / 未知格式）⇒ 当作这个文件没有可用记录。
      // ⚠️ 只 warn 一次：这条路径每 500ms 走一次，逐次 warn 会刷屏。
      warnLeveldbParseFailure(
        log,
        path,
        error instanceof Error ? error.message : String(error),
      )
      return undefined
    }
  }
  if (lowerName.endsWith('.log')) {
    const records = readWalRecords(buffer)
    if (records !== undefined) return { records, rawText: '' }
  }
  return { records: [], rawText: buffer.toString('latin1') }
}

/**
 * 一个 profile 的 leveldb 文本。
 *
 * ⚠️ 文件之间用 `\n` 隔开：不隔开时前一个文件的尾部与后一个的头部会拼成一条
 * **不存在的**记录（可能凭空造出一对 jwt × org）。
 */
function leveldbTextForProfile(
  root: string,
  profile: string,
  log?: (message: string) => void,
): string {
  const dir = join(root, profile, 'Local Storage', 'leveldb')
  let files: string[]
  try {
    files = readdirSync(dir)
  } catch {
    return ''
  }
  const records: LeveldbRecord[] = []
  const rawTexts: string[] = []
  for (const file of files) {
    const content = leveldbContentForFile(join(dir, file), file, log)
    if (content === undefined) continue
    // ⚠️ 不要用 `records.push(...content.records)`：记录多时 V8 会抛 RangeError。
    for (const record of content.records) records.push(record)
    if (content.rawText.length > 0) rawTexts.push(content.rawText)
  }
  const visible = leveldbVisibleRecords(records)
  const rendered = visible.length > 0 ? leveldbRecordsText(visible) : ''
  return [rendered, ...rawTexts].filter((text) => text.length > 0).join('\n')
}

/**
 * 一个 User Data 根目录下**全部 profile** 的 leveldb 文本。
 *
 * ⚠️ 多 profile 之间用 `\n` 隔开：不隔开时前一个 profile 的尾部与后一个的头部
 * 会拼成一条**不存在的**记录（可能凭空造出一对 jwt × org）。
 */
export function leveldbTextFor(root: string, log?: (message: string) => void): string {
  const texts = magicrewProfilesOf(root)
    .map((profile) => leveldbTextForProfile(root, profile, log))
    .filter((text) => text.length > 0)
  return texts.join('\n')
}

/** jwt 里的 `iat` / `exp`；解不出来返回 0（**不猜**）。 */
export function jwtTimes(jwt: string): { iat: number, exp: number } {
  try {
    const payload = String(jwt ?? '').split('.')[1] ?? ''
    const body = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>
    return {
      iat: typeof body.iat === 'number' && Number.isFinite(body.iat) ? body.iat : 0,
      exp: typeof body.exp === 'number' && Number.isFinite(body.exp) ? body.exp : 0,
    }
  } catch {
    return { iat: 0, exp: 0 }
  }
}

/** LevelDB 里一条记录的前缀：`_https://<origin>\x00\x01<name>`。 */
const ORIGIN_RE = /_https?:\/\/([^\x00\x01"\\]{4,80})\x00\x01/g

/**
 * magicrew 的 localStorage 记录形态（与参考实现逐字一致）：
 *
 * ```
 * {"key":"authorization","value":"eyJ…"}
 * {"key":"organizationCode","value":"…"}
 * ```
 *
 * ⚠️ 两套形态：直接写在 leveldb 里的是**裸 JSON**；若整条记录被当成字符串再
 * 序列化一次（某些浏览器/写入路径会这样），引号会变成 `\"`。两套都认，
 * 且各自留了 `\s*` 容错（chromium 自己写的是紧凑格式，但不值得赌死）。
 */
const AUTHORIZATION_PATTERNS: readonly RegExp[] = [
  /"key"\s*:\s*"authorization"\s*,\s*"value"\s*:\s*"(eyJ[^"]+)"/g,
  /\\"key\\"\s*:\s*\\"authorization\\"\s*,\s*\\"value\\"\s*:\s*\\"(eyJ[^"\\]+)/g,
]
const ORGANIZATION_PATTERNS: readonly RegExp[] = [
  /"key"\s*:\s*"organizationCode"\s*,\s*"value"\s*:\s*"([^"]*)"/g,
  /\\"key\\"\s*:\s*\\"organizationCode\\"\s*,\s*\\"value\\"\s*:\s*\\"([^"\\]*)/g,
]

interface IndexedMatch {
  readonly index: number
  readonly value: string
}

function* matchesWithIndex(
  patterns: readonly RegExp[],
  chunk: string,
): Generator<IndexedMatch> {
  for (const pattern of patterns) {
    // ⚠️ `matchAll` 会克隆正则内部状态，模块级 `/g` 正则因此可安全复用。
    for (const match of chunk.matchAll(pattern)) {
      if (match.index === undefined) continue
      yield { index: match.index, value: match[1] ?? '' }
    }
  }
}

/** host 的全部写法：`www.letsmagic.cn` / `letsmagic.cn`（去重、保持顺序）。 */
function hostsFor(hostname: string): string[] {
  const host = String(hostname ?? '').trim()
  if (host.length === 0) return []
  const bare = host.replace(/^www\./, '')
  const hosts = [host, bare, `www.${bare}`]
  return hosts.filter((value, index) => value.length > 0 && hosts.indexOf(value) === index)
}

/**
 * 在 host 每一次出现的位置开窗，取窗口内同一 origin 的 `jwt × organizationCode`。
 *
 * 截断点 = 「下一个**不同站点**的 origin」，同站点的多条记录不截断。
 *
 * ⚠️ 每把 jwt 配**它自己后面**最近的那个组织码：LevelDB 按 key 排序
 * （`authorization` < `organizationCode`），同一批写入的挨在一起；取「窗口内第一个
 * org」会在同一站点存过多套凭据时配错（症状：HTTP 200 + `code:403` 且极难归因）。
 */
export function credsNear(
  text: string,
  hostname: string,
  window: number = MAGICREW_LOCAL_WINDOW,
): { jwt: string, organizationCode: string }[] {
  const host = String(hostname ?? '').trim()
  if (text.length === 0 || host.length === 0) return []
  const bare = host.replace(/^www\./, '')
  const origins: { host: string, at: number }[] = []
  for (const match of text.matchAll(ORIGIN_RE)) {
    origins.push({ host: match[1] ?? '', at: match.index ?? 0 })
  }

  const out: { jwt: string, organizationCode: string }[] = []
  const seen = new Set<string>()
  let at = -1
  while ((at = text.indexOf(host, at + 1)) !== -1) {
    let stop = Math.min(text.length, at + window)
    for (const origin of origins) {
      if (origin.at > at && !origin.host.includes(bare)) {
        stop = origin.at
        break
      }
    }
    const slice = text.slice(at, stop)
    const jwts = [...matchesWithIndex(AUTHORIZATION_PATTERNS, slice)]
      .sort((left, right) => left.index - right.index)
    const orgs = [...matchesWithIndex(ORGANIZATION_PATTERNS, slice)]
      .sort((left, right) => left.index - right.index)
    for (const jwt of jwts) {
      /**
       * ⚠️⚠️ 只取「jwt 之后**第一个** org」，**不要**跳过空值去够更远的那个
       * （2026-11-05 审计复核：P2-6 的「空值遮蔽」是**误判**）。
       *
       * LevelDB 的 internal key 排序是「user key 升序、同 key 内 **sequence 降序**」
       * ⇒ 同一个 `organizationCode` 的**最新一次写入排在最前**。于是：
       *
       * | 形态 | 含义 | 正确行为 |
       * |---|---|---|
       * | 空值在前、有效值在后（同一 `.ldb`） | 空值 = **较新的 tombstone**（登出/切组织） | 有效值已失效 ⇒ **跳过**（旧行为对） |
       * | 有效值在前、空值在后 | 有效值较新 | 正常配对 |
       * | 跨 `.log` / 跨文件（写入序，旧在前） | 空值较旧 | 严格说该配对更远那个 |
       *
       * 只有**前两种**能靠文本判断，而第三种需要 8 字节 trailer 里的 sequence
       * （`leveldbRecordsText` 刻意丢弃了它）。在「读不到」与「复活一个已删除的
       * 组织」之间，后者更糟：`jwt_stale × org_new` 在上游是 HTTP 200 + `code:403`，
       * 且会把一个**已登出**的账号加回池里。
       *
       * ⇒ 保守取第一个（含空值），空值就放弃这把 jwt。
       * 后续若要做对：按 user key 取**最大 sequence**、值为空即视为 tombstone 丢弃
       * （见 `docs/agent-notes/providers-magicrew.md` 的「已知边界」）。
       */
      const org = orgs.find((candidate) => candidate.index > jwt.index)
      // ⚠️ 没有 org 就**不产出**：宁可读不到（调用方降级去开窗口登录），
      // 也绝不编造空串 —— 空 organizationCode 与 jwt 配对在上游是
      // HTTP 200 + `code:403`，比「没读到」难查得多。
      if (org === undefined || org.value.length === 0) continue
      const key = `${jwt.value}\u0000${org.value}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ jwt: jwt.value, organizationCode: org.value })
    }
  }
  return out
}

/**
 * 读本机浏览器里属于这个站点的登录态。
 *
 * @param hostname 站点 host，例如 `www.letsmagic.cn`（与 localStorage key 里的
 *                 origin 同源，**不是** API 子域）
 * @returns 取 iat 最新的那份凭据；读不到返回 `undefined`（调用方降级到窗口登录）。
 *
 * ⚠️⚠️ **过期与否不在这里拦**：同一份 leveldb 里可能同时留着一旧一新两套记录
 * （用户重登过），此时优先给**未过期**的那份；但如果**只有**过期的那份，照样返回
 * —— 「凭据过期」由调用方（以及上游）判定，在这里拦掉会让「刚过期但 refresh_token
 * 还能用」的账号**白丢一条自救路径**。
 */
export function readMagicrewLocalCreds(
  hostname: string,
  options: MagicrewLocalBrowserOptions = {},
): MagicrewLocalCreds | undefined {
  const host = String(hostname ?? '').trim()
  if (host.length === 0) return undefined
  const now = options.now ?? Date.now()
  const roots = options.roots ?? magicrewBrowserRoots().map((entry) => entry.root)
  const hosts = hostsFor(host)

  interface Candidate {
    readonly jwt: string
    readonly organizationCode: string
    readonly iat: number
    readonly expiresAt: number | undefined
    readonly expired: boolean
  }

  let best: Candidate | undefined
  for (const root of roots) {
    const text = leveldbTextFor(root, options.log)
    if (text.length === 0) continue
    for (const candidateHost of hosts) {
      for (const found of credsNear(text, candidateHost)) {
        const { iat, exp } = jwtTimes(found.jwt)
        const expiresAt = exp > 0 ? exp * 1000 : undefined
        const candidate: Candidate = {
          jwt: found.jwt,
          organizationCode: found.organizationCode,
          iat,
          expiresAt,
          expired: expiresAt !== undefined && expiresAt <= now,
        }
        if (best === undefined) {
          best = candidate
          continue
        }
        // 未过期的优先；同一档里取 iat 最新的。两者都缺（解不出 iat）时保留先找到的
        // —— 顺序取决于目录遍历，故不在无据可依时反复改选。
        if (best.expired !== candidate.expired) {
          if (!candidate.expired) best = candidate
          continue
        }
        if (candidate.iat > best.iat) best = candidate
      }
    }
  }
  if (best === undefined) return undefined
  return {
    jwt: best.jwt,
    organizationCode: best.organizationCode,
    ...best.expiresAt === undefined ? {} : { expiresAt: best.expiresAt },
  }
}
