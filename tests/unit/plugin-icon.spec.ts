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
 * 1. **声明合法**：路径规则与宿主同源（非空串 / 不含反斜杠 / 不带 scheme /
 *    不是绝对路径 / 任何一段都不是空串、`.`、`..`），畸形清单要在构建期就红。
 * 2. **文件本身**：存在、≤ 256 KiB（宿主上限）、是 `<svg>`、36×36、自包含
 *    （无 `<script>` / `<style>` / `<foreignObject>` / `<image>` / `<text>` /
 *    动画 / 外链）——这些是 Plugin Manager 把图标当**图片**加载的前提。
 * 3. **三条通道**：`files` 覆盖（npm）、两个打包脚本真的 import 并调用了
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

/** 宿主读图标时的那套路径规则，复刻成可断言的返回值。 */
function iconPathViolation (value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return '必须是字符串，且非空'
  if (value.includes('\\')) return '不能含反斜杠（宿主按 `/` 切分）'
  if (/^[A-Za-z][A-Za-z\d+.-]*:/u.test(value)) return '不能带 scheme（必须是包内相对路径）'
  if (value.startsWith('/') || /^[A-Za-z]:/u.test(value)) return '不能是绝对路径'
  const rel = value.replace(/^\.\//u, '')
  if (rel.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return '任何一段都不能是空串 / `.` / `..`'
  }
  return null
}

/** 声明的图标路径（未声明时 `null`，由「声明了」那条用例负责报错）。 */
const ICON = typeof PKG.icon === 'string' ? normalizeEntry(PKG.icon) : null

const ICON_MAX_BYTES = 256 * 1024

describe('插件图标：manifest 声明、自包含 SVG、三条通道都到位', () => {
  it('声明了 icon（缺失 ⇒ 插件列表静默回落成默认图，且无任何报错）', () => {
    expect(PKG.icon, 'package.json 没有 icon 字段').toBeDefined()
  })

  it('icon 满足宿主读图标的路径规则', () => {
    const violation = iconPathViolation(PKG.icon)
    expect(violation, `icon 不合法：${String(PKG.icon)}`).toBeNull()
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
    expect(svg, 'width 必须是 36').toMatch(/\bwidth="36"/u)
    expect(svg, 'height 必须是 36').toMatch(/\bheight="36"/u)
    expect(svg, 'viewBox 必须是 0 0 36 36').toContain('viewBox="0 0 36 36"')
    // Plugin Manager 把图标当图片加载，下面这些会破坏自包含或被浏览器拒绝：
    for (const forbidden of ['<script', '<style', '<foreignObject', '<image', '<text', '<animate', '<set']) {
      expect(svg.includes(forbidden), `图标里出现了 ${forbidden}（宿主按图片加载，不能自包含）`).toBe(false)
    }
    expect(svg, '图标引用了外链资源（http/https）').not.toMatch(/href\s*=\s*"https?:/u)
  })

  it('npm 通道：files 必须逐字列出图标（否则打出来的包里没有它）', () => {
    const files = Array.isArray(PKG.files) ? (PKG.files as unknown[]).map(String) : []
    const covered = files.map(normalizeEntry).includes(ICON as string)
    expect(covered, `files 里没有 ${String(ICON)}（当前: ${JSON.stringify(files)}）`).toBe(true)
    // 反向自证：npm 把无通配条目同时当「精确文件」与「目录」，所以 `icon`
    // 这条**不覆盖** `icon.svg`（既不是同名文件、也不是它的父目录）。
    // 判据必须是「归一后的条目逐字相等」，写成 `startsWith` 就会把它放过去。
    expect(files.map(normalizeEntry).some((entry) => entry === 'icon'), 'files 里出现了 `icon` 这条无效条目').toBe(false)
  })

  it('★ bootstrap / standalone 两条打包通道真的 import 并调用了 copyIconAsset', () => {
    for (const script of ['scripts/build-bootstrap.mjs', 'scripts/build-standalone.mjs']) {
      // ⚠️ 先剥整行注释：把调用注释掉时，`toContain` 会命中注释里的字面量（假绿）。
      const source = read(script).replace(/^\s*\/\/.*$/gmu, '')
      expect(source, `${script} 没有 import icon-asset`).toContain("from './lib/icon-asset.mjs'")
      expect(
        source,
        `${script} import 了却没有调用 copyIconAsset(REPO_ROOT, pluginDir)`,
      ).toMatch(/copyIconAsset\(\s*REPO_ROOT\s*,\s*pluginDir\s*\)/u)
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
      writePkg(undefined)
      expect(mod.collectIconPath(fixture), '未声明 icon 时应返回 null').toBeNull()

      writePkg('../escape.svg')
      expect(() => mod.collectIconPath(fixture), '包外路径必须被拒').toThrow(/每一段/u)

      writePkg('https://example.com/icon.svg')
      expect(() => mod.collectIconPath(fixture), 'URL 必须被拒').toThrow(/scheme/u)

      writePkg('missing.svg')
      mkdirSync(join(fixture, 'out'), { recursive: true })
      expect(() => mod.copyIconAsset(fixture, join(fixture, 'out')), '声明了却不存在必须抛错').toThrow(/不存在/u)
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })
})