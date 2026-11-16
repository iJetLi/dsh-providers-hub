/**
 * 渠道「品牌词表」—— 从真源 `src/provider-registry.ts` 派生，供所有
 * 「文案不得枚举渠道名」的判据**共用**。
 *
 * ## 为什么抽成独立文件（2026-11-17，GitHub #98）
 *
 * 这条判据最先只有 `tests/unit/plugin-meta-locale.spec.ts` 一份（守
 * `meta.description`）。加 `meta.detail` 的守卫时同一判据要打在**详情文档**上，
 * 若在第二个 spec 里再抄一份推导逻辑，两处会各自漂移 —— 而本仓库对这类问题的
 * 定论是「**同一判据只留一份实现**」（见 `docs/agent-notes/` 里多条同型事故）。
 * 故把推导搬到这里，两个 spec 都 import。
 *
 * ## 为什么必须「真读」而对手抄
 *
 * 硬编码的渠道清单必然与 `PROVIDER_REGISTRY` 漂移：新增一家渠道时旧判据不会
 * 自动纳入，于是「文案里加了新渠道名」永远测不出来（PR #77 的原始问题）。
 * ⇒ 词表从真源派生，判据随真源一起长。
 *
 * ## 什么叫「在枚举渠道名」
 *
 * 渠道词表 = 每个条目的 **label 主名**（去括号）＋ **括号内的中文公司名**：
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
 */

import { PROVIDER_REGISTRY } from '../../src/provider-registry.js'

/** 一条渠道的 `id` 与展示名。 */
export interface ProviderEntry {
  readonly id: string
  readonly label: string
}

/**
 * 从 registry **真读**渠道表。
 *
 * ⚠️ 2026-10-08 改：原先解析 `plugin-src/client/jet-hub.js` 的 `PROVIDERS`
 * **源码文本**（正则 `/\{\s*id:\s*'([^']+)',\s*label:\s*'([^']+)'/g`）。客户端
 * `PROVIDERS` 现由 `src/provider-registry.ts` 派生，故这里直接读 registry
 * —— 既是行为断言，也不再随 `PROVIDERS` 的结构变化而失效。
 *
 * ⚠️ 这里只需要 `label`（`id` 不参与品牌词表），但保留成对返回以维持
 * `ProviderEntry` 的形状与下游判据不变。
 */
export function readProviders (): ProviderEntry[] {
  const entries = PROVIDER_REGISTRY.map((d) => ({ id: d.id, label: d.label }))
  // ⚠️ 见文件头「宁可漏判不可误伤」的另一面：空词表 ⇒ 断言恒真 ⇒ 假绿。
  if (entries.length < 10) {
    throw new Error(`PROVIDER_REGISTRY 只取到 ${entries.length} 条（应 ≥10）—— 真源疑似失配`)
  }
  return entries
}

/** label 的主名（去掉中/英文括号及其内容），空白折叠。 */
export function mainName (label: string): string {
  return label.replace(/[（(][^）)]*[）)]/g, ' ').replace(/\s+/g, ' ').trim()
}

/** label 里所有括号（中/英）内的内容。 */
export function parenContents (label: string): string[] {
  return [...label.matchAll(/[（(]([^）)]*)[）)]/g)].map((match) => (match[1] ?? '').trim())
}

/** 全部渠道（真源快照）。 */
export const PROVIDERS: readonly ProviderEntry[] = readProviders()

/**
 * 渠道词表：label 主名 ＋ 括号内的**中文公司名**。
 * ⚠️ 以「版」结尾的括注（`国际版` / `中国版`）是版本形容词，不是渠道标识，排除。
 */
export const BRAND_WORDS: readonly string[] = [
  ...new Set(
    PROVIDERS.flatMap((entry) => [
      mainName(entry.label),
      ...parenContents(entry.label).filter((inner) => /[\u4e00-\u9fff]/.test(inner) && !/版$/.test(inner)),
    ]),
  ),
].filter((word) => word.length > 0)

/** 文案里命中的渠道词（空数组 = 没有枚举渠道名）。 */
export function channelNameHits (text: string): string[] {
  const haystack = text.toLocaleLowerCase()
  return BRAND_WORDS.filter((word) => haystack.includes(word.toLocaleLowerCase()))
}
