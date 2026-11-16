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
 * ~6.1 MB 涨到 ~8.7 MB（实测 `docs/` = 111 个文件 / 5.9 MiB，含本 PR 新增的两份；
 * `npm pack` 从 1254 files / 6.1 MB 变成 1306 files / 7.7 MB）⇒ 只许列**精确路径**。
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

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
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
 * - `*` 不跨 `/`，`**` 跨 `/`，`?` 是**单个非 `/` 字符**。
 *
 * ⚠️ `?` 必须显式换掉：它既是 npm 通配符、又是**正则量词**。原实现只转义
 * `*`/`**`，于是 `docs/DETAIL.md?` 退化成 `…\.m` + `d?` ⇒ 把
 * `docs/DETAIL.md` 判成「被覆盖」，而 npm 实际**不会**打包它（假绿）。
 *
 * ⚠️ 两侧都先做 npm 的规范化（`./` 前缀、首尾 `/`、`//` 折叠）：
 * `docs/`、`./docs/x.md`、`docs//x.md`、`/docs/x.md` 在 npm 眼里是同一个路径，
 * 不归一就会把**合法写法**判成未覆盖（假红）。
 *
 * ⚠️ 不去支持 `!` 取反与 `[...]` 字符类：`files` 里一旦出现它们，本函数会
 * **漏判**（返回 false）而不是误判 —— 漏判会让用例变红、由人来补，方向是安全的。
 */
function normalizeFilesPath (value: string): string {
  return value.replace(/\/{2,}/gu, '/').replace(/^\.\//u, '').replace(/^\/+/u, '').replace(/\/+$/u, '')
}

function filesEntryCovers (entry: string, path: string): boolean {
  const e = normalizeFilesPath(entry)
  const p = normalizeFilesPath(path)
  if (e === p) return true
  if (!/[*?]/.test(e)) return p.startsWith(`${e}/`)
  const pattern = e
    .replace(/[.+^${}()|[\]\\]/gu, '\\$&')
    .replace(/\*\*/gu, '\u0000')
    .replace(/\*/gu, '[^/]*')
    .replace(/\?/gu, '[^/]')
    .replace(/\u0000/gu, '.*')
  return new RegExp(`^${pattern}$`, 'u').test(p)
}

/**
 * 该路径是否**被 git 跟踪**（文件命中本身、目录命中其下的文件都算）。
 *
 * 为什么不用 `existsSync`：`docs/implementation-notes.md` 在本机磁盘上**存在**
 * （它是未入库的私人笔记、被 `.gitignore:161` 忽略），`existsSync` 会放行，
 * 而用户克隆仓库后按图索骥找不到 —— 这正是初版 DETAIL 犯过的错。
 * `git ls-files` 是唯一能区分「仓库里真有」与「我这台机器上有」的判据。
 */
function gitTracks (path: string): boolean {
  const out = execFileSync('git', ['ls-files', '--', path], { cwd: ROOT, encoding: 'utf8' })
  return out.trim().length > 0
}

/** 只做 `/` 分隔的 dirname（不引入平台差异；测试里的路径已是 posix 形态）。 */
function posixDirname (p: string): string {
  const at = p.lastIndexOf('/')
  return at <= 0 ? '' : p.slice(0, at)
}

/** `docs/` 下所有文件的仓库相对路径（递归，`/` 分隔）。 */
function docsFiles (): string[] {
  const root = resolve(ROOT, 'docs')
  if (!existsSync(root)) return []
  return (readdirSync(root, { recursive: true }) as string[])
    .map((entry) => String(entry).replace(/\\/gu, '/'))
    .filter((entry) => statSync(join(root, entry)).isFile())
    .map((entry) => `docs/${entry}`)
    .sort()
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

      it('文档引用的 docs/ 路径必须真的随包发布，或真的存在于源码仓库', () => {
        // ⚠️ 这条是**我自己踩过**的：初版 DETAIL 写了「去读 docs/implementation-notes.md」，
        //    而那个文件被 `.gitignore:161` 忽略、`git ls-files` 里没有 ⇒ 用户按图索骥找
        //    不到。**`existsSync` 抓不到它**（本机磁盘上确实有那份未入库笔记），所以
        //    判据必须是「git 跟踪」而不是「文件存在」。
        //
        // ⚠️ 豁免标记的作用域也是踩出来的：原实现「整行含『不随包发布』就跳过该行」，
        //    于是同一行里再夹一个**未发布**路径即可绕过。现在要求标记出现在
        //    **该引用自己所在的表格单元**里（`|` 之前），而不是整行任意位置。
        const path = String(metaOf(locale)?.detail)
        const lines = read(path).split('\n')
        const unshipped: string[] = []
        const untracked: string[] = []
        for (const line of lines) {
          for (const match of line.matchAll(/`(docs\/[^`]+)`/gu)) {
            const ref = match[1] ?? ''
            const tail = line.slice((match.index ?? 0) + (match[0]?.length ?? 0))
            const cell = tail.split('|')[0] ?? ''
            const exempt = /不随包发布|not shipped/u.test(cell)
            if (!exempt && !FILES.some((entry) => filesEntryCovers(entry, ref))) unshipped.push(ref)
            if (!gitTracks(ref)) untracked.push(ref)
          }
        }
        expect(unshipped, `${path} 引用了不随包发布的路径: ${unshipped.join(', ')}`).toEqual([])
        expect(untracked, `${path} 引用了源码仓库里并不存在的路径: ${untracked.join(', ')}`).toEqual([])
      })
    })
  }

  it('中英两份必须指向**不同**的文档（否则英文用户看到中文，或反之）', () => {
    const paths = LOCALES.map((locale) => String(metaOf(locale)?.detail))
    expect(new Set(paths).size, `两个 locale 指向了同一份文档: ${paths.join(' / ')}`).toBe(LOCALES.length)
  })

  it('files 的条目不得带上未声明的 docs/ 笔记（整目录、通配、`"docs/"` 都算）', () => {
    // ⚠️ 原实现只比对**字面** `"docs"`。实测把条目改成 `"docs/"`、`"*"`、`"docs/**"`
    //    时本文件**全绿**，而它们同样会把 111 个笔记/截图文件一起打进包里。
    //    判据必须打在「这条 entry 实际会覆盖哪些文件」上，不是「它长什么样」。
    const declared = new Set(LOCALES.map((locale) => String(metaOf(locale)?.detail)))
    const leaked: string[] = []
    for (const entry of FILES) {
      for (const file of docsFiles()) {
        if (declared.has(file)) continue
        // npm 命中**目录**会把整棵子树带上（`"*"` / `"docs"` 都是这个机理），
        // 所以祖先目录也要逐个试 —— 只比文件路径会漏掉这两类。
        const candidates = [file]
        let dir = posixDirname(file)
        while (dir.length > 0 && dir !== '.') {
          candidates.push(dir)
          dir = posixDirname(dir)
        }
        const hit = candidates.find((candidate) => filesEntryCovers(entry, candidate))
        if (hit !== undefined) leaked.push(`${entry} → ${hit}`)
      }
    }
    expect(leaked.slice(0, 5), `files 会带上未声明的 docs 文件: ${leaked.slice(0, 5).join(', ')}`).toEqual([])
  })

  it('前提：行数上限本身必须是个小数字（否则把它改成 100 万 = 删掉这条判据）', () => {
    // 实测：把 MAX_DETAIL_LINES 从 220 改成 1200 时本文件**全绿** —— 上限自己没人守，
    // 放宽 5.5 倍刚好放过 issue 里那条 1205 行的 README（本判据要防的就是它）。
    expect(MAX_DETAIL_LINES).toBeGreaterThan(0)
    expect(
      MAX_DETAIL_LINES,
      '上限被放宽到没有意义 —— 220 行是刻意选的「比 README 短一个量级」',
    ).toBeLessThanOrEqual(400)
  })

  it('绝对化承诺必须带限定词（对抗审计的三条「对用户说谎」就是漏了它）', () => {
    // 首轮的 31 条用例全绿，却让详情页写出三条与代码不符的绝对化承诺：
    // 「凭据到期前自动刷新」「每个账号都有积分面板」「仅有的两份随包发布的文档」。
    // 这类句子没有代码能自动证伪，但**「承诺 + 限定词」这组搭配可以**：
    // 凡是提到这些能力，就必须同时写清它成立的范围。
    const rules: ReadonlyArray<{ claim: RegExp; qualifier: RegExp; why: string }> = [
      {
        claim: /统一面板|积分面板|credit\s+panel/iu,
        qualifier: /支持积分查询|expose usable\s+credits/iu,
        why: 'qiniu 与 aggregate 是 `credits: { balance: false }`（实测结论，不是没接线）⇒ 没有积分面板',
      },
      {
        claim: /自动续期|自动刷新|credential\s+refresh|refresh\s+before\s+they\s+expire/iu,
        // ⚠️ 限定词必须写**完整短语**：第一版只要求「有刷新端点」，而正文里
        // 「少数渠道**没有刷新端点**」把「有刷新端点」当子串包含了 ⇒ 判据恒真。
        qualifier: /有刷新端点的渠道|providers with a refresh endpoint/iu,
        why: 'doubao（浏览器 Cookie）/ loomy / zcode 都没有 refresh 端点，到期只能人工重登',
      },
    ]
    for (const locale of LOCALES) {
      const path = String(metaOf(locale)?.detail)
      const text = read(path)
      for (const rule of rules) {
        if (!rule.claim.test(text)) continue
        expect(
          rule.qualifier.test(text),
          `${path} 提到了「${String(rule.claim)}」却没写限定词 —— ${rule.why}`,
        ).toBe(true)
      }
    }
  })

  it('★ build-bootstrap / build-standalone 必须把 meta.detail 声明的文档一起复制', () => {
    // ⚠️ 这条是**第一轮审计的 P1**：两个打包脚本各维护一份复制清单
    //    （lib / locale / cordis.patch.yml / 精简 package.json），`package.json` 的
    //    `files` 对它们零作用。漏复制 ⇒ 该通道下宿主抛
    //    `DetailFailure('invalid', '<path>, named by meta.detail, does not exist')`，
    //    详情页**报错**（不是回落 README）。
    //
    // 判据分两段：模块本身真能把文件搬过去（行为），两个脚本真的调用了它（接线）。
    const scripts = ['scripts/build-bootstrap.mjs', 'scripts/build-standalone.mjs']
    for (const script of scripts) {
      // ⚠️ 必须**先剥注释**：把调用整行注释掉（`// copyDetailDocs(...)`）时，
      //    原来的 `toMatch` 会命中注释里的那段文本 ⇒ 假绿（首轮实测如此）。
      const source = read(script).replace(/^\s*\/\/.*$/gmu, '')
      expect(source, `${script} 没有 import detail-docs`).toContain("from './lib/detail-docs.mjs'")
      expect(source, `${script} import 了却没有调用 copyDetailDocs`).toMatch(/copyDetailDocs\(\s*REPO_ROOT\s*,\s*pluginDir\s*\)/u)
    }
  })

  it('★★ copyDetailDocs 真的把声明过的文档搬进产物目录（行为级）', async () => {
    // 上一条只挡「脚本里那行被删掉」，挡不住「模块自己搬错」。这一条真跑一遍模块：
    // 造一个只有 lib/locale/cordis.patch.yml/package.json 的产物目录（= 两个打包
    // 脚本的复制清单），调用后断言 `meta.detail` 声明的每一份都**真的到位且内容一致**。
    const mod = (await import('../../scripts/lib/detail-docs.mjs')) as unknown as {
      collectDetailDocs: (root: string) => string[]
      copyDetailDocs: (root: string, dest: string) => string[]
    }
    const declared = LOCALES.flatMap((locale) => {
      const detail = metaOf(locale)?.detail
      return typeof detail === 'string' ? [detail] : []
    })
    expect(mod.collectDetailDocs(ROOT).sort(), 'col 从 locale 读出来的清单与断言源不一致').toEqual([...new Set(declared)].sort())

    const dest = mkdtempSync(join(tmpdir(), 'detail-docs-'))
    try {
      const copied = mod.copyDetailDocs(ROOT, dest)
      expect(copied.sort()).toEqual([...new Set(declared)].sort())
      for (const doc of copied) {
        expect(existsSync(join(dest, doc)), `${doc} 没有被复制到产物目录`).toBe(true)
        expect(readFileSync(join(dest, doc), 'utf8'), `${doc} 复制后内容不一致`).toBe(read(doc))
      }
    } finally {
      rmSync(dest, { recursive: true, force: true })
    }
  })

  it('自己实现的 files 匹配器不得恒真（用真实条目自证）', () => {
    // ⚠️ 「断言恒真」是本仓最贵的教训：这里对匹配器本身做正反两向自证。
    expect(filesEntryCovers('lib', 'lib/index.js')).toBe(true)
    expect(filesEntryCovers('locale/*.json', 'locale/zh.json')).toBe(true)
    expect(filesEntryCovers('locale/*.json', 'locale/nested/zh.json')).toBe(false)
    expect(filesEntryCovers('docs/DETAIL.md', 'docs/DETAIL.zh.md')).toBe(false)
    expect(filesEntryCovers('docs/**/*.md', 'docs/a/b/c.md')).toBe(true)
    // `?` 是**单个非 `/` 字符**通配。原实现没换掉它 ⇒ 它留成正则量词 `d?`，
    // 于是 `docs/DETAIL.md?` 把 `docs/DETAIL.md` 判成已覆盖（npm 并不打包）。
    expect(
      filesEntryCovers('docs/DETAIL.md?', 'docs/DETAIL.md'),
      '? 退化成正则量词了 —— 会把「差一个字符」的条目录成命中',
    ).toBe(false)
    expect(filesEntryCovers('docs/DETAIL.md?', 'docs/DETAIL.mdX')).toBe(true)
    // npm 侧会先归一这几组等价写法；不归一就会把**合法写法**判成未覆盖（假红）。
    expect(filesEntryCovers('docs/', 'docs/DETAIL.md'), '末尾斜杠是目录写法').toBe(true)
    expect(filesEntryCovers('docs/DETAIL.md', './docs/DETAIL.md'), './ 前缀要被归一').toBe(true)
    expect(filesEntryCovers('docs/DETAIL.md', '/docs//DETAIL.md'), '前导与重复斜杠要被归一').toBe(true)
  })
})
