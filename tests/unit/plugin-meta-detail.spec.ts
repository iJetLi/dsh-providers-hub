/**
 * 插件**详情文档**（`meta.detail`）的守卫 —— GitHub #98 的防复发闸门。
 *
 * ## 它修的是什么
 *
 * `locale/zh.json` 与 `locale/en.json` 原来只有 `meta.title` + `meta.description`，
 * **没有 `meta.detail`** ⇒ 宿主 `readPackageDocument()` 走「整条语言链都没声明」的
 * 兜底，把 **1205 行 / 77 KB 的 `README.md`** 当详情文档渲染 ⇒ 插件详情页退化成
 * 一整份 README（安装步骤、Windows 部署、开发约定全混进来）。
 *
 * ## 平台契约（读 `@deepseek-ai/dsh-plugin-detail/lib/index.js` 核实，不是猜的）
 *
 * | 位置 | 行为 |
 * |---|---|
 * | `:275-284` `detailPath(value, label)` | 四条：非空串 / 不含 `\` 且不是绝对路径或带 scheme / 任一段不得为 `""`/`.`/`..` / 必须 `.md` 或 `.markdown` 结尾 |
 * | `:285-307` `localeDetail()` | 按 `languageChain()` 取**第一个声明 `meta.detail` 的 locale**；`'zh'` ⇒ `['zh','en']`、`'en'` ⇒ `['en']` |
 * | `:313-340` `readPackageDocument()` | **声明了但文件不存在 ⇒ `DetailFailure('invalid', '<path>, named by meta.detail, does not exist')`** —— 比「没声明」更坏（详情页直接报错） |
 *
 * ## 为什么必须有「真的会被发布」这一条
 *
 * 仓库里文件在、但 `package.json` 的 `files` 没列 ⇒ **打出来的包里没有它** ⇒
 * 用户那边插件页报 `does not exist`，而本地全绿。这是本仓反复踩过的
 * 「接线层零守卫」同型（见 `AGENTS.md` 的多条事故史）。
 *
 * ⚠️ 反向的坑同样要挡：`files` 里写**整目录** `"docs"` 能让 `npm pack` 从
 * ~0.4 MB 涨到 ~6.4 MB（实测 `docs/` = 109 个文件 / 5,991 KiB）⇒ 只许列**精确路径**。
 *
 * ## 为什么还要「不是第二份 README」
 *
 * 失败形态是「详情页又变成长文档」，与 issue 同源。故对文档设**行数与字节双上限**；
 * 真需要写长文时应当加章节锚点、而不是把 README 复制一份。
 *
 * ## 判据为什么不是「源码文本里有 `meta.detail`」
 *
 * 那会假绿：字符串出现在注释里也算。本文件的判据全部打在**真实数据**上
 * （解析 locale JSON、真读文件、真匹配 `files`），与宿主 `readPackageDocument()`
 * 走的是同一条路。
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { BRAND_WORDS, channelNameHits } from '../helpers/provider-brand-words.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '../..')
const read = (path: string): string => readFileSync(resolve(ROOT, path), 'utf8')
const exists = (path: string): boolean => existsSync(resolve(ROOT, path))

/** 各 locale 文件。英文那条必须指向英文文档（见「中英不得共用同一份」）。 */
const LOCALES = ['locale/zh.json', 'locale/en.json'] as const

/** 声明的详情文档上限 —— 超过它就该怀疑「又把 README 抄了一份」。 */
const MAX_DETAIL_LINES = 220
const MAX_DETAIL_BYTES = 12_288

interface LocaleMeta {
  readonly title?: unknown
  readonly description?: unknown
  readonly detail?: unknown
}

/** 读一个 locale 的 `meta`（缺失或畸形成 `null`，由具体用例报错）。 */
function metaOf (file: string): LocaleMeta | null {
  const parsed = JSON.parse(read(file)) as { meta?: unknown }
  const meta = parsed.meta
  return typeof meta === 'object' && meta !== null ? (meta as LocaleMeta) : null
}

/**
 * 按宿主 `detailPath()` 的四条规则校验。
 * 这里**复刻**而不是 import：那是宿主 `node_modules` 里的内部函数，不是公开导出。
 */
function detailPathViolation (value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return '必须是字符串，且非空'
  if (value.includes('\\')) return '不能含反斜杠（宿主按 `/` 切分）'
  if (/^[A-Za-z][A-Za-z\d+.-]*:/u.test(value)) return '不能带 scheme（必须是包内相对路径）'
  if (value.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return '任何一段都不能是空串 / `.` / `..`'
  }
  if (!/\.(?:md|markdown)$/iu.test(value)) return '必须以 .md 或 .markdown 结尾'
  return null
}

/**
 * npm `files` 的匹配语义（只实现本仓用到的部分）。
 *
 * - 无通配的条目同时是「精确文件」与「目录」两种意思 ⇒ 等于或前缀算命中；
 * - `*` 不跨 `/`，`**` 跨 `/`。
 *
 * ⚠️ 不去支持 `!` 取反与 `[...]` 字符类：`files` 里一旦出现它们，本函数会
 * **漏判**（返回 false）而不是误判 —— 漏判会让用例变红、由人来补，方向是安全的。
 */
function filesEntryCovers (entry: string, path: string): boolean {
  if (entry === path) return true
  if (!/[*?]/.test(entry)) return path.startsWith(`${entry}/`)
  const pattern = entry
    .replace(/[.+^${}()|[\]\\]/gu, '\\$&')
    .replace(/\*\*/gu, '\u0000')
    .replace(/\*/gu, '[^/]*')
    .replace(/\u0000/gu, '.*')
  return new RegExp(`^${pattern}$`, 'u').test(path)
}

const FILES: readonly string[] = (JSON.parse(read('package.json')) as { files?: unknown }).files as string[]

describe('插件详情文档：meta.detail 必须声明、合法、且真的会被发布（GitHub #98）', () => {
  it('前提：README 仍然很长（否则本文件的「不再是 README」判据失去意义）', () => {
    // 1205 行是 issue 里报的数。若哪天 README 缩到 220 行以内，
    // 「详情页回落成 README」这个缺陷本身就不成立了 ⇒ 本文件该重审而不是默默通过。
    expect(read('README.md').split('\n').length).toBeGreaterThan(MAX_DETAIL_LINES)
  })

  it('前提：渠道词表确实从真源派生出来了（否则下面「不枚举渠道名」恒真）', () => {
    expect(BRAND_WORDS.length).toBeGreaterThanOrEqual(10)
  })

  for (const locale of LOCALES) {
    describe(locale, () => {
      it('声明了 meta.detail（缺失 ⇒ 详情页回落成 README）', () => {
        const meta = metaOf(locale)
        expect(meta, `${locale} 的 meta 不是对象`).not.toBeNull()
        expect(meta?.detail, `${locale} 缺 meta.detail`).toBeDefined()
      })

      it('meta.detail 满足宿主 detailPath() 的四条规则', () => {
        const violation = detailPathViolation(metaOf(locale)?.detail)
        expect(violation, `${locale} 的 meta.detail 不合法`).toBeNull()
      })

      it('声明的 Markdown 文件真实存在（声明了却不在 ⇒ 宿主抛 DetailFailure）', () => {
        const path = String(metaOf(locale)?.detail)
        expect(exists(path), `meta.detail 指向的 ${path} 不存在`).toBe(true)
      })

      it('声明的文件会被真的发布出去（package.json 的 files 必须覆盖它）', () => {
        const path = String(metaOf(locale)?.detail)
        const covered = FILES.some((entry) => filesEntryCovers(entry, path))
        expect(
          covered,
          `${path} 不在 package.json 的 files 里（当前: ${JSON.stringify(FILES)}）—— `
            + '仓库里在、打出来的包里没有 ⇒ 用户那边插件页报 does not exist',
        ).toBe(true)
      })

      it('文档不是第二份 README（行数与字节双上限）', () => {
        const path = String(metaOf(locale)?.detail)
        const raw = read(path)
        const lines = raw.split('\n').length
        expect(lines, `${path} 有 ${lines} 行（上限 ${MAX_DETAIL_LINES}）`).toBeLessThanOrEqual(MAX_DETAIL_LINES)
        expect(statSync(resolve(ROOT, path)).size).toBeLessThanOrEqual(MAX_DETAIL_BYTES)
      })

      it('文档形状：无 BOM、以一级标题开头、非空', () => {
        const path = String(metaOf(locale)?.detail)
        const raw = read(path)
        expect(raw.charCodeAt(0), `${path} 带 BOM`).not.toBe(0xfeff)
        expect(raw.startsWith('# '), `${path} 必须以一级标题开头`).toBe(true)
        expect(raw.trim().length).toBeGreaterThan(200)
      })

      it('文档不枚举渠道名（同一判据，PR #77 的防复发闸门）', () => {
        const path = String(metaOf(locale)?.detail)
        const hits = channelNameHits(read(path))
        expect(hits, `${path} 里仍出现渠道名: ${hits.join(', ')}`).toEqual([])
      })

      it('文档引用的 docs/ 路径必须真的随包发布（否则用户点开是空的）', () => {
        // ⚠️ 这条是**我自己踩过**的：初版 DETAIL 写了「去读 docs/implementation-notes.md」，
        //    而 `files` 只列了两份 DETAIL ⇒ 装出来的包里根本没有那个文件。
        //    判据 = 反引号里的 `docs/…` 要么被 `files` 覆盖，要么**同一行**明确写了「不随包发布」。
        const path = String(metaOf(locale)?.detail)
        const lines = read(path).split('\n')
        const unshipped: string[] = []
        for (const line of lines) {
          if (/不随包发布|not shipped/u.test(line)) continue
          for (const [, ref] of line.matchAll(/`(docs\/[^`]+)`/gu)) {
            if (!FILES.some((entry) => filesEntryCovers(entry, ref ?? ''))) unshipped.push(ref ?? '')
          }
        }
        expect(unshipped, `${path} 引用了不随包发布的路径: ${unshipped.join(', ')}`).toEqual([])
      })
    })
  }

  it('中英两份必须指向**不同**的文档（否则英文用户看到中文，或反之）', () => {
    const paths = LOCALES.map((locale) => String(metaOf(locale)?.detail))
    expect(new Set(paths).size, `两个 locale 指向了同一份文档: ${paths.join(' / ')}`).toBe(LOCALES.length)
  })

  it('files 不许用整目录 "docs"（会把 5,991 KiB 的笔记与截图一起发出去）', () => {
    expect(FILES, `files 里出现了整目录 docs —— 只许列精确路径`).not.toContain('docs')
  })

  it('自己实现的 files 匹配器不得恒真（用真实条目自证）', () => {
    // ⚠️ 「断言恒真」是本仓最贵的教训：这里对匹配器本身做正反两向自证。
    expect(filesEntryCovers('lib', 'lib/index.js')).toBe(true)
    expect(filesEntryCovers('locale/*.json', 'locale/zh.json')).toBe(true)
    expect(filesEntryCovers('locale/*.json', 'locale/nested/zh.json')).toBe(false)
    expect(filesEntryCovers('docs/DETAIL.md', 'docs/DETAIL.zh.md')).toBe(false)
    expect(filesEntryCovers('docs/**/*.md', 'docs/a/b/c.md')).toBe(true)
  })
})
