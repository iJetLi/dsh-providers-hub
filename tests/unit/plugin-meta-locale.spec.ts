/**
 * 插件描述文案**不得枚举渠道名** —— PR #77「移除必然漂移的硬编码清单」的防复发闸门。
 *
 * ## 为什么需要这个文件
 *
 * PR #77（`d01acf2`）把 `locale/zh.json` / `locale/en.json` / `package.json` 的
 * 描述从「七家渠道 + 7 个渠道名」改成不含渠道名的概括表述。问题判断是对的
 * （该清单确实已过期），但**它只改了文案、没有留下任何闸门** ——
 * 实测把描述原样改回旧文案后，全量单测**仍然全绿**（6048 passed / 0 failed）。
 *
 * 而本仓库对这类问题**早已有明确判据**，就写在
 * `tests/unit/new-account-dialog.spec.ts` 的文件头：
 *
 * > ① **硬编码副本必然与 `PROVIDERS` 漂移**（新增 provider 时测试不会自动纳入）
 *
 * 那条判据的落法是「从源码真读 `PROVIDERS`，而不是手抄一份样本」。本文件
 * 沿用同一模式：**渠道词表从真源 `src/provider-registry.ts` 真读**
 *（2026-10-08 起客户端 `PROVIDERS` 即由它派生），不在测试里再抄一份渠道名
 *（否则测试自身成了新的漂移源）。
 *
 * ## 被锁的三个描述来源（都是 `readPluginMeta` 真实消费的那几处）
 *
 * | 来源 | 在 `readPluginMeta` 里的角色 |
 * |---|---|
 * | `locale/zh.json` / `locale/en.json` 的 `meta.description` | 按语言展示的描述 |
 * | `package.json` 的 `description` | **`description.en` 的恒覆盖值**；且全部语言都缺 description 时是唯一兜底 |
 *
 * ⚠️ `package.json` 那份容易被漏掉：`localizedText()` 里 `en: fallback ?? finalFallback`
 * 会把 `en` 槽位**恒定**指向 manifest 的 `description`，所以只锁 locale 是不够的。
 *
 * ## 判据：什么算「在枚举渠道名」
 *
 * 渠道词表 = 每个 `PROVIDERS` 条目的 **label 主名**（去括号）＋ **括号内的中文公司名**：
 *
 * ```
 * 'CodeArts (华为云)' → ['CodeArts', '华为云']
 * 'MiniMax Code'     → ['MiniMax Code']        // 无括注
 * 'Qoder (中国版)'    → ['Qoder']               // 「中国版」被排除，见下
 * ```
 *
 * ⚠️ **括注里以「版」结尾的词被排除**（`国际版` / `中国版`）：它们是**版本形容词**，
 * 不是渠道标识；留在词表里会让断言对「支持国内外多个版本」这类无关文案误红。
 * 取舍方向是**宁可漏判不可误伤** —— 漏判一个形容词不会放过渠道名，
 * 误伤却会让测试失去可信度、进而被人删掉。
 *
 * 匹配**大小写不敏感**（旧文案英文写 `CodeArts`、中文写 `CodeArts`，同一个词）。
 *
 * ## 反向验证（已实测，别当同义反复删掉）
 *
 * | 实验 | 结果 |
 * |---|---|
 * | 当前（改后）文案 | **全绿** |
 * | 把 `locale/zh.json` 描述**改回**旧文案 | **变红**，精确报出 `CodeArts, 华为云, CodeBuddy, 腾讯, …` |
 * | 移走本文件 + 旧文案，跑全量 | **仍然全绿** ⇒ 证明本文件是**唯一**闸门 |
 *
 * ## ⚠️ 下限护栏存在的原因（本仓库踩过的坑）
 *
 * 「描述不含任何渠道名」在**词表为空**时**恒真**。若将来真源的结构变了、
 * 取到空数组，本文件会**假绿** —— 那比没有测试更坏（看起来测了，其实没测）。
 * 故 `readProviders()` 取到的条数不足下限时**直接抛错**，与
 * `new-account-dialog.spec.ts` 的 `ids.length < 10` 护栏同法。
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { BRAND_WORDS, PROVIDERS, channelNameHits } from '../helpers/provider-brand-words.js'

// ⚠️ 2026-11-17（GitHub #98）：渠道词表的推导已抽到 `tests/helpers/provider-brand-words.ts` ——
//    `meta.detail` 的详情文档要打**同一条**「不得枚举渠道名」判据，两处各抄一份推导必然漂移。
//    本文件现在只消费词表，不再自己推导（行为不变，见文件头「判据：什么算在枚举渠道名」）。

const HERE = dirname(fileURLToPath(import.meta.url))
const read = (path: string): string => readFileSync(resolve(HERE, '../..', path), 'utf8')

/** 被锁的三个描述来源。 */
const DESCRIPTION_SOURCES = ['locale/zh.json', 'locale/en.json', 'package.json'] as const

/** 取某个来源的描述字符串（`package.json` 在顶层，locale 在 `meta` 下）。 */
function descriptionOf (file: string): string {
  const parsed = JSON.parse(read(file)) as { meta?: { description?: unknown }, description?: unknown }
  const raw = file === 'package.json' ? parsed.description : parsed.meta?.description
  if (typeof raw !== 'string') {
    throw new Error(`${file} 缺少可用的描述字符串（readPluginMeta 会因此丢掉整块元信息）`)
  }
  return raw
}

describe('插件描述文案不得枚举渠道名（PR #77 防复发）', () => {
  it('前提：渠道词表确实从源码派生出来了（解析失配必须在这里就红）', () => {
    expect(PROVIDERS.length).toBeGreaterThanOrEqual(10)
    // 词表本身不能是空的，否则下游断言全部恒真。
    expect(BRAND_WORDS.length).toBeGreaterThanOrEqual(10)
    // 抽查两个已知条目，确认解析出的确实是 label 而非别的字段。
    expect(BRAND_WORDS).toContain('CodeArts')
    expect(BRAND_WORDS).toContain('华为云')
    // 「国际版」/「中国版」应被排除（见文件头的取舍说明）。
    expect(BRAND_WORDS).not.toContain('国际版')
    expect(BRAND_WORDS).not.toContain('中国版')
  })

  for (const file of DESCRIPTION_SOURCES) {
    it(`${file} 的描述不出现任何渠道名`, () => {
      const hits = channelNameHits(descriptionOf(file))
      expect(hits, `${file} 的描述里仍出现渠道名: ${hits.join(', ')}`).toEqual([])
    })

    it(`${file} 的描述非空且非占位（防「清空也算通过」）`, () => {
      const description = descriptionOf(file)
      expect(description.trim().length).toBeGreaterThanOrEqual(20)
      expect(description.trim()).not.toBe('Jet Hub')
    })

    it(`${file} 的描述不写死渠道数量词`, () => {
      const description = descriptionOf(file)
      // 「七家渠道」「seven providers」这类写法每加一家渠道就必然过期，
      // 与本 PR 要修的问题同源 —— 一并挡掉。
      expect(description).not.toMatch(/[一二三四五六七八九十百]+家渠道/)
      expect(description).not.toMatch(
        /\b(?:two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen)\s+providers\b/i,
      )
    })
  }
})
