/**
 * 插件**图标**（`package.json` 的 `icon`）的守卫。
 *
 * ## 为什么需要它
 *
 * 宿主的插件列表按 manifest 的 `icon`（缺省再看 `exports['./icon']`）读图标，
 * 实现已在本机 `@deepseek-ai/dsh-app-boot/lib/index.js` 的 `iconOf()` 核实：
 * 图标缺失 / 越界 / 超 256 KiB 时**抛错**，`readPluginMeta()` 把它收成一条
 * metadata 诊断（`Plugin metadata for <specifier>: …`）——标题与描述仍在，
 * 图标静默回落成默认图。而声明了 `icon` 却没发布文件，比「没声明」多出一条
 * 诊断，且没有任何日志指向「哪条通道漏了复制」。
 * 这个包有三条安装通道：npm（`files` 决定）、bootstrap 与 standalone
 * （两个脚本各自维护一份复制清单，`files` 对它们零作用）。少一条腿的后果
 * 是「别人装出来的包带一条 metadata 诊断、图标是默认图，作者本机全绿」。
 *
 * ## 判据为什么这样分
 *
 * 1. **manifest 读得到**：宿主靠 Node 的 ESM resolver 解析 `package.json`，
 *    也就是 `exports['./package.json']` 这条键。缺了它 `icon` 字段会被**完全
 *    忽略**、连 title/description 都读不到，而且**零诊断**（本机 `dsh-app-boot`
 *    实测：`readPluginMeta` 直接返回 `undefined`）。
 * 2. **声明合法**：路径规则的**唯一实现**是 `scripts/lib/icon-asset.mjs` 的
 *    `collectIconPath()` —— 本文件不再写第二份（本仓红线：一文件两套同义判据，
 *    漂移时两套都不红）。它**比宿主更严**：宿主实测只拒「绝对路径 / 带 scheme」
 *    与「realpath 越出包目录」两件事，反斜杠与未越界的 `..` 都放行；我们额外
 *    拒这两类、并加扩展名白名单（宿主对非 svg/png/jpeg/webp 必拒），理由见
 *    该文件 JSDoc。差异由下面第 6 / 7 条的行为级用例覆盖。
 * 3. **文件本身**：存在、≤ 256 KiB（宿主上限）、是 `<svg>`、36×36、自包含
 *    （无 `<script>` / `<style>` / `<foreignObject>` / `<image>` / `<text>` /
 *    动画 / 外链）——这些是 Plugin Manager 把图标当**图片**加载的前提。
 * 4. **三条通道**：`files` 覆盖（npm）、两个打包脚本真的 import 并调用了
 *    `copyIconAsset`（接线）、`copyIconAsset` 真的把文件搬过去（行为）。
 *
 * ⚠️ 接线那条必须先剥注释：把调用整行注释掉时，只 `toContain` 源码文本会命中
 * 注释里的字面量（`plugin-meta-detail.spec.ts` 首轮实测过的假绿）。
 *
 * ⚠️ 图标**不是**插件运行时产物：它只由 manifest 声明、由三条通道各自发布。
 * 本文件不碰 `lib/`，也不该在单测里启动宿主。
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '../..')
const read = (path: string): string => readFileSync(resolve(ROOT, path), 'utf8')

interface Manifest {
  readonly icon?: unknown
  readonly exports?: Record<string, unknown>
  readonly files?: unknown
}

const PKG = JSON.parse(read('package.json')) as Manifest

/** `files` 里的条目统一成包内相对路径（npm 会把 `./` 与首尾斜杠归一掉）。 */
function normalizeEntry (entry: string): string {
  return entry.replace(/^\.\//u, '').replace(/\/+$/u, '')
}

/** npm 的 `files` 条目按 glob 匹配（`*` 不跨 `/`）。只用来判「覆盖」。 */
function globMatches (pattern: string, path: string): boolean {
  if (!pattern.includes('*')) return false
  const source = pattern
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'))
    .join('[^/]*')
  return new RegExp(`^${source}$`, 'u').test(path)
}

/**
 * `files` 里的某一条是否能覆盖 `target`（npm 的语义）：
 * - 无通配的条目既匹配同名文件、也匹配**该目录下的全部内容**；
 * - 带 `*` 的按 glob 匹配；
 * - 以 `/` 结尾的条目**只**表示目录 —— 所以 `"icon.svg/"`（看着像图标本身）
 *   实测**不会**把 `icon.svg` 打进包，不能算覆盖。
 */
function filesEntryCovers (raw: string, target: string): boolean {
  const trimmed = raw.trim()
  if (trimmed === '') return false
  const isDir = trimmed.endsWith('/')
  const entry = normalizeEntry(trimmed.replace(/^\/+/u, ''))
  if (entry === '') return false
  if (isDir) return target.startsWith(`${entry}/`)
  return entry === target || target.startsWith(`${entry}/`) || globMatches(entry, target)
}

/** 声明的图标路径（未声明时 `null`，由「声明了」那条用例负责报错）。 */
const ICON = typeof PKG.icon === 'string' ? normalizeEntry(PKG.icon) : null

const ICON_MAX_BYTES = 256 * 1024

describe('插件图标：manifest 声明、自包含 SVG、三条通道都到位', () => {
  it('声明了 icon（缺失 ⇒ 插件列表静默回落成默认图，且无任何报错）', () => {
    expect(PKG.icon, 'package.json 没有 icon 字段').toBeDefined()
  })

  it('exports 里必须有 ./package.json（宿主靠它读 manifest；缺了 icon 会被完全忽略）', () => {
    // 本机 `dsh-app-boot` 实测：走的是 Node ESM 的 `resolvePluginResource`，
    // 所以 `exports` 是白名单。缺 './package.json' 这条键时 `iconOf()` 拿到的
    // `manifestPath` 是 undefined ⇒ 直接返回 undefined ⇒ `readPluginMeta()`
    // 连 title 都读不到、返回整个 undefined，**一条诊断都没有**。
    expect(
      PKG.exports?.['./package.json'],
      "exports 缺 './package.json'：宿主用 ESM resolver 读 manifest，缺这条键则 icon 字段被完全忽略且零诊断",
    ).toBe('./package.json')
  })

  it('icon 满足构建期的路径规则（唯一实现在 scripts/lib/icon-asset.mjs）', async () => {
    // 不在这里复刻第二份规则：本仓红线「一文件两套同义判据」。
    // 行为级断言（真跑生产实现）见下面 ★★ 那条。
    const mod = (await import('../../scripts/lib/icon-asset.mjs')) as unknown as {
      collectIconPath: (root: string) => string | null
    }
    expect(mod.collectIconPath(ROOT), `icon 不合法：${String(PKG.icon)}`).toBe(ICON)
  })

  it('图标文件存在，且不超过宿主的 256 KiB 上限', () => {
    expect(ICON, 'icon 不是字符串，无法定位文件').not.toBeNull()
    const file = resolve(ROOT, ICON as string)
    expect(existsSync(file), `icon 指向的 ${String(ICON)} 不存在`).toBe(true)
    const size = statSync(file).size
    expect(size).toBeGreaterThan(0)
    expect(size, `图标 ${size} 字节，超过宿主上限 ${ICON_MAX_BYTES}`).toBeLessThanOrEqual(ICON_MAX_BYTES)
  })

  it('SVG 形状：36×36、自包含、不含脚本/样式/外链/位图/文字', () => {
    const svg = read(ICON as string)
    expect(svg.trimStart().startsWith('<svg'), '图标不是 SVG 根元素').toBe(true)
    // ⚠️ 边界必须是「行首或空白之后」：写成 `\bwidth="36"` 会被
    // `stroke-width="36"` 子串满足（实测假绿），而 `stroke-width` 完全没有
    // 视口语义 —— 那格亮着，尺寸崩了也没人知道。
    expect(svg, 'width 必须是 36（注意别被 stroke-width 满足）').toMatch(/(?:^|\s)width="36"/mu)
    expect(svg, 'height 必须是 36（注意别被 stroke-height 之类满足）').toMatch(/(?:^|\s)height="36"/mu)
    expect(svg, 'viewBox 必须是 0 0 36 36').toContain('viewBox="0 0 36 36"')
    // Plugin Manager 把图标当图片加载，下面这些会破坏自包含或被浏览器拒绝：
    for (const forbidden of [
      '<script', '<style', '<foreignObject', '<image', '<text', '<animate', '<set',
      // `<use>` / `xlink:href` 会把图形**引到别处**（图标是个独立文件，没有别处可引）；
      // 嵌入类元素在「按图片加载」时要么被拒、要么触发子资源请求。
      '<use', 'xlink:', '<iframe', '<object', '<embed', '<a ',
    ]) {
      expect(svg.includes(forbidden), `图标里出现了 ${forbidden}（宿主按图片加载，不能自包含）`).toBe(false)
    }
    expect(svg, '图标引用了外链资源（http/https）').not.toMatch(/href\s*=\s*"https?:/u)
  })

  it('npm 通道：files 必须覆盖图标（逐字 / 父目录 / 通配都算，目录条目不算）', () => {
    const files = Array.isArray(PKG.files) ? (PKG.files as unknown[]).map(String) : []
    const covers = files.some((entry) => filesEntryCovers(entry, ICON as string))
    // ⚠️ 判据不能只认「逐字相等」：npm 实测 `"*.svg"` **能**把图标打进包
    // （只认逐字的写法会假红），而 `"icon.svg/"` 看着像图标本身、实测**不打进包**
    // （只认逐字的写法会假绿）。语义判据见 `filesEntryCovers`。
    expect(covers, `files 里没有任何条目覆盖 ${String(ICON)}（当前: ${JSON.stringify(files)}）`).toBe(true)
  })

  it('★ bootstrap / standalone 两条打包通道真的 import 并调用了 copyIconAsset', () => {
    for (const script of ['scripts/build-bootstrap.mjs', 'scripts/build-standalone.mjs']) {
      // ⚠️ 判据不用「剥注释 + 子串匹配」：那条路我第一版就踩了坑 —— 用正则剥
      // `/* … */` 时，源码里字符串/模板里的 `/*` 会让非贪婪匹配跨行吞掉真调用
      // （本文件实测 `build-standalone.mjs` 里 `/*` 比 `*/` 多 2 个 ⇒ 调用被吃掉、
      // 假红）。改成**整行严格相等**：调用必须独占一行、行内不许有别的东西。
      // 这一条同时挡掉四种「留着但没执行」：块注释包着的、行尾 `//` 挂着的、
      // 写进字符串字面量的、`if (false)` 包起来的。
      const source = read(script)
      expect(source, `${script} 没有 import icon-asset`).toMatch(
        /^import \{[^}]*copyIconAsset[^}]*\} from '\.\/lib\/icon-asset\.mjs'$/mu,
      )
      const callLines = source
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line === 'copyIconAsset(REPO_ROOT, pluginDir)')
      expect(
        callLines.length,
        `${script} import 了却没有把 copyIconAsset(REPO_ROOT, pluginDir) 当独立语句调用（注释里/字符串里/if(false) 里都不算）`,
      ).toBe(1)
    }
  })

  it('★★ copyIconAsset 行为级：真的复制、缺文件抛错、未声明返回 null', async () => {
    const mod = (await import('../../scripts/lib/icon-asset.mjs')) as unknown as {
      collectIconPath: (root: string) => string | null
      copyIconAsset: (root: string, dest: string) => string | null
    }

    expect(mod.collectIconPath(ROOT), '从真实 package.json 读出来的路径与断言源不一致').toBe(ICON)

    const dest = mkdtempSync(join(tmpdir(), 'icon-asset-'))
    try {
      const copied = mod.copyIconAsset(ROOT, dest)
      expect(copied).toBe(ICON)
      const out = join(dest, ICON as string)
      expect(existsSync(out), '图标没有被复制到产物目录').toBe(true)
      expect(readFileSync(out, 'utf8'), '复制后的内容与源文件不一致').toBe(read(ICON as string))
    } finally {
      rmSync(dest, { recursive: true, force: true })
    }

    // 畸形 / 缺文件的清单必须在构建期抛错，而不是产出一个没有图标的包。
    const fixture = mkdtempSync(join(tmpdir(), 'icon-asset-bad-'))
    try {
      const writePkg = (icon: unknown): void => {
        writeFileSync(join(fixture, 'package.json'), JSON.stringify({ name: 'x', icon }), 'utf8')
      }
      const writeRaw = (manifest: unknown): void => {
        writeFileSync(join(fixture, 'package.json'), JSON.stringify(manifest), 'utf8')
      }
      writePkg(undefined)
      expect(mod.collectIconPath(fixture), '未声明 icon 时应返回 null').toBeNull()

      // ⚠️ 显式 `icon: null` 在宿主那里是**抛错**（`textOf()` 只放过 undefined，
      // 其余非字符串一律 `must be a non-empty string`）——所以这里不能 `??`。
      writePkg(null)
      expect(() => mod.collectIconPath(fixture), 'icon: null 必须抛错（宿主会抛，构建期不能静默当成没声明）').toThrow(/必须是非空字符串/u)

      // `exports['./icon']` 是宿主认的第二条腿（与 `icon` 字段是 OR 关系）。
      writeRaw({ name: 'x', exports: { './icon': './icon.svg' } })
      expect(mod.collectIconPath(fixture), '只有 exports["./icon"] 时也必须能读出来').toBe('icon.svg')

      writePkg('../escape.svg')
      expect(() => mod.collectIconPath(fixture), '包外路径必须被拒').toThrow(/每一段/u)

      writePkg('https://example.com/icon.svg')
      expect(() => mod.collectIconPath(fixture), 'URL 必须被拒').toThrow(/scheme/u)

      // 扩展名白名单：宿主对 .ico 必抛 `icon must be SVG, PNG, JPEG, or WebP`
      // （本机实测），构建期先拦才不用等用户装机才发现图标不生效。
      writePkg('logo.ico')
      expect(() => mod.collectIconPath(fixture), '.ico 必须在构建期被拒（宿主只认 SVG/PNG/JPEG/WebP）').toThrow(/SVG/u)

      // 反斜杠：宿主实测**放行**（`sub\icon.svg` 能返回 data URL，它只做字符串
      // 拼接），我们刻意更严 —— 见 icon-asset.mjs 的 JSDoc。
      writePkg('sub\\icon.svg')
      expect(() => mod.collectIconPath(fixture), '反斜杠必须在构建期被拒').toThrow(/反斜杠/u)

      writePkg('missing.svg')
      mkdirSync(join(fixture, 'out'), { recursive: true })
      expect(() => mod.copyIconAsset(fixture, join(fixture, 'out')), '声明了却不存在必须抛错').toThrow(/不存在/u)

      // 绝对路径那条腿（`isAbsolute || startsWith('/')`）。
      writePkg('/etc/icon.svg')
      expect(() => mod.collectIconPath(fixture), '绝对路径必须被拒').toThrow(/包内相对路径/u)

      // 体积上限：宿主在 `size > 256 KiB` 时拒绝加载（`icon exceeds 256 KiB`），
      // 构建期必须同样拦 —— 否则又是一个「构建全绿、装机才不生效」的缺口。
      writeFileSync(join(fixture, 'big.svg'), Buffer.alloc(256 * 1024 + 1, 0x20))
      writePkg('big.svg')
      expect(() => mod.copyIconAsset(fixture, join(fixture, 'big-out')), '超 256 KiB 必须在构建期被拒（宿主会拒绝加载）').toThrow(/256 KiB/u)
      // 边界：恰好 262144 字节**要放行**（宿主判据是 `>`，不是 `>=`；写错成 `>=` 会误杀）。
      writeFileSync(join(fixture, 'edge.svg'), Buffer.alloc(256 * 1024, 0x20))
      writePkg('edge.svg')
      expect(mod.copyIconAsset(fixture, join(fixture, 'edge-out')), '恰好 256 KiB 必须允许（宿主判据是 >）').toBe('edge.svg')

      // 嵌套路径：`copyIconAsset` 必须自己建父目录（`mkdirSync(recursive)`），
      // 否则图标落在不存在的子目录上、复制直接抛错。**这一格专测 mkdirSync**：
      // 顶层 `icon.svg` 不需要建目录，删掉 mkdirSync 谁都发现不了。
      mkdirSync(join(fixture, 'assets'), { recursive: true })
      writeFileSync(join(fixture, 'assets', 'icon.svg'), '<svg/>', 'utf8')
      writePkg('assets/icon.svg')
      const nested = join(fixture, 'nested-out')
      expect(mod.copyIconAsset(fixture, nested), '嵌套路径应返回相对路径').toBe('assets/icon.svg')
      expect(existsSync(join(nested, 'assets', 'icon.svg')), 'copyIconAsset 没有建父目录或没有复制').toBe(true)
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })
})