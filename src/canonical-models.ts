/**
 * 跨渠道模型**归一化**：把同一个真实模型在各 provider 下的不同 modelId / 不同
 * 展示名，收敛成一个「候选键」，供聚合 provider 归组。
 *
 * ## 为什么需要两张通道（id 与 name）
 *
 * 各 provider 的 modelId **不都是自描述的**：
 *
 * | provider | modelId | 展示名 | id 能认出模型吗 |
 * |---|---|---|---|
 * | buddy / codearts / lobsterai / opencode | `deepseek-v4.1-flash` | `Deepseek-V4.1-Flash` | ✅ |
 * | raccoon | `sn-glm-5-3` | `GLM-5-3 · x0.75` | ✅（剥 `sn-` 后） |
 * | **qoder / qodercn** | **`gfmodel`** | `GLM-5.3-Flash` | ❌ **内部代号** |
 * | trae | `DeepSeek-V4-Flash-Official` | 同左 | ✅ |
 *
 * qoder 那类必须靠**展示名**通道才能归组 —— 这是本设计要两张通道的原因。
 *
 * ## 仲裁规则：按 provider 声明**主通道**，不是两通道投票
 *
 * ⚠️ 实测（见本文件单测）：**展示名通道会错误合并 workbuddy 的
 * `deepseek-v4.1-flash` 与 `deepseek-v4.1-flash-sg`** —— 两者展示名逐字都是
 * `Deepseek-V4.1-Flash`，但 `-sg` 是新加坡区的**另一条通道**。若两通道投票或
 * 让 name 通道优先，这两个不同的东西会被并成一个虚拟模型，而请求只发往其中一个
 * ⇒ 用户以为在用新加坡区，实际打到了主区（静默错配）。
 *
 * ⇒ 规则：**按 provider 声明主通道**。只有 qoder / qodercn（id 是代号）声明为
 * `name`，其余全部 `id`。
 *
 * ⚠️ **「主通道算不出结果时才回落另一通道」的回落逻辑不在本模块**：本文件只提供
 * {@link channelOf} 这个「主通道是哪条」的判据，回落由 Task 2 的
 * `canonicalKeyFor` 负责（它才需要在归一化结果为空时改走另一条通道）。
 *
 * ## 保守方向：宁可漏合并，不可错合并
 *
 * - 日期快照（`-0731`）**不剥离** ⇒ 与无后缀版本分开；
 * - `-official` 后缀**不剥离** ⇒ 与无后缀版本分开；
 * - 归一化结果互不相同的候选**不合并**（各自成为一个虚拟模型，或都不归入）。
 *
 * 漏合并的代价是「同一个模型出现两条」，用户一眼能看出并手工关掉一条；
 * 错合并的代价是「请求打到了不是用户想要的那个模型」，且**没有任何提示**。
 *
 * @module src/canonical-models.ts
 */

/**
 * 抽象路由别名 —— **不是真实模型**，不参与归一化。
 *
 * 两个来源：
 * - workbuddy 的 `default-model` / `fast-model` / `balanced-model` /
 *   `primary-model` / `deep-model` 是**服务端抽象路由**（名字就叫 Auto / Fast /
 *   Balanced / Primary / Deep），由后端决定实际用哪个模型；
 * - qoder 系的 `auto` 是**客户端选模模式**，不是可指定调用的模型。
 *
 * ⚠️ 它们若参与归一化会变成若干「只有一个渠道」的虚拟模型，且语义上是空的
 * （用户选 `aggregate/default-model` 等于选了个我们无法保证语义的东西）。
 */
export const EXCLUDED_ALIASES: ReadonlySet<string> = new Set([
  'default-model',
  'fast-model',
  'balanced-model',
  'primary-model',
  'deep-model',
  'auto',
])

/**
 * provider → 归一化**主通道**。
 *
 * 未列出的 provider 一律 `id`。⚠️ 不要「为了省事」把 qoder 也改成 `id`：
 * 它的 modelId 是 `gfmodel` 这类内部代号，走 id 通道会让每个模型各自成一个
 * 虚拟模型（`gfmodel` / `gmodel` / `dfmodel` …），跨渠道聚合**完全不发生**。
 */
const PRIMARY_CHANNEL: Readonly<Record<string, 'id' | 'name'>> = Object.freeze({
  qoder: 'name',
  qodercn: 'name',
  // ⚠️ accio（阿里 Accio Work，2026-10-13，用户要求）：与 qoder **完全同因** ——
  //    它的 `modelCode` 是 `1Drift-F8hS3mK7pL2n` 这种**内部代号**（上游刻意不给
  //    可读 id，真名只在 `modelDisplayName` 里，详见
  //    `docs/agent-notes/providers-accio.md` §7）。走 id 通道的实测后果：
  //    accio 的每个模型各自成一个**孤立虚拟模型**（键形如 `1drift-…`），
  //    跨渠道聚合**完全不发生** ⇒ 用户在聚合的「Qwen3.8-Flash 轮换列表」里
  //    **永远看不到 accio**（症状是静默的：它只是不在候选表里）。
  //    ⚠️ 判据同 qoder：**该渠道的 id 对人类与其它渠道都无信息**，不是「哪个方便」。
  accio: 'name',
})

/** 该 provider 的归一化主通道；未声明者默认 `id`。 */
export function channelOf(provider: string): 'id' | 'name' {
  return PRIMARY_CHANNEL[provider] ?? 'id'
}

/**
 * 把一个模型 id 归一成候选键。
 *
 * 步骤（顺序有意为之）：
 * 1. **剥命名空间前缀**（取最后一个 `/` 之后）：`cline-free/x` → `x`；
 * 2. 去 `:free` 后缀；
 * 3. 剥 `sn-` 前缀（raccoon）；
 * 4. **所有点号转连字符**；
 * 5. 空格转连字符（展示名通道会用到）；
 * 6. 全小写。
 *
 * ⚠️ **第 4 步是「所有点号」而不是「版本号里的点号」**（初版写成
 * `/v(\d+)\.(\d+)/` 只匹配 `v4.1` 这种形态，**漏掉了 `6.8` / `k2.8` / `m2.7`
 * 等不带 `v` 的写法** ⇒ `sensenova-6.8-flash`、`kimi-k2.8-preview` 会带着点号
 * 留在键里，与 `CANONICAL_NAMES` 的键对不上）。全部转掉即可 —— 见下方「为什么
 * 全部转掉仍然安全」。
 *
 * ⚠️ **不剥** 4 位数字日期后缀（`-0731`）与 `-official`：见模块头「保守方向」。
 * ⚠️ 第 1 步用 `lastIndexOf`：`cline-free/x` 这类取最后一段即可。
 *
 * ## 为什么「所有点号转连字符」仍然安全
 *
 * 关键风险是「点号一转就把 `v4.1` 与 `v4` 混为一谈」。转连字符**不会**——
 * `deepseek-v4.1-flash` → `deepseek-v4-1-flash`，而 `deepseek-v4-flash` 里
 * 没有点号，保持 `deepseek-v4-flash`，两者**仍然不同**。真正会混淆的是
 * 「删掉点号」（`v41` vs `v4`），本函数不做那件事。
 */
export function normalizeModelKey(raw: string): string {
  let s = raw.trim().toLowerCase()
  const slash = s.lastIndexOf('/')
  if (slash >= 0) s = s.slice(slash + 1)
  s = s.replace(/:free$/, '')
  s = s.replace(/^sn-/, '')
  s = s.replace(/\./g, '-')
  s = s.replace(/\s+/g, '-')
  return s
}

/**
 * 把一条**展示名**归一成候选键：先剥掉非模型信息，再走 {@link normalizeModelKey}。
 *
 * 要剥掉的东西（各家的展示名里都混着它们）：
 * - 倍率后缀 ` · x0.75` / ` · x0.2→x0.1`（raccoon / loomy 直接写在表里）；
 * - 「免费」标注（raccoon 的 `· 免费`、cline 的 ` · 免费`）。
 *
 * ⚠️ 只剥**第一个 `·` 之后**的全部内容：`·` 是倍率分隔符（U+00B7），在本仓库
 * 所有 provider 的展示名里都不作为模型名的一部分出现。
 *
 * ⚠️ 下面那条 `/免费/g` 是**独立于 `·` 规则**的一道闸门：它只对**不带 `·` 的裸
 * 「免费」**生效（`SenseNova-6.8-Flash 免费`）。带 `·` 的形态（`… · 免费`）其实
 * 已被上一行连同 ` · ` 一并剥掉，走不到这里 —— 两种输入在单测里各有一条断言守着。
 */
export function normalizeNameKey(name: string): string {
  const stripped = name
    .replace(/\s*·.*$/, '')
    .replace(/免费/g, '')
    .trim()
  return normalizeModelKey(stripped)
}

/**
 * Magicrew **两站共用**的规范键补丁（国内 `magicrew` / 国际 `magicrewintl`）。
 *
 * ⚠️ 抽成常量的理由：两站共用同一份 `MAGICREW_FALLBACK_MODELS`（`magicrew-product.ts`
 * 里 `qwen-3.8-flash` 那条 id **带连字符**）⇒ 补丁必须**逐个相同**。
 * 复制两份会让「加一条补丁只改了一边」变成静默缺陷（国际站自成一个孤立虚拟模型，
 * 聚合轮换列表里永远看不到它，零报错零日志 —— 与 `accio` 那次完全同型）。
 *
 * ⚠️ 放在 `CANONICAL_OVERRIDES` **之前**且各自带自己的 JSDoc —— 否则会把
 * 上面那一整块「## 什么时候需要它 / 每条都必须有实测依据」的文档顶掉，
 * 变成孤儿注释（2026-11-01 二审查出的形态：声明插在两个注释块之间）。
 */
const MAGICREW_CANONICAL_OVERRIDES: Readonly<Record<string, string>> = Object.freeze({
  'qwen-3.8-flash': 'qwen3-8-flash',
})

/**
 * 显式映射补丁：`provider → realId → 规范键`。
 *
 * ## 什么时候需要它
 *
 * 两个通道**都**给不出正确归属时才用。已知两类：
 *
 * 1. **id 是内部代号、展示名又不带版本号**（qoder 系的 `dfmodel` 展示名叫
 *    `DeepSeek-Flash`，同表的 `dmodel` 却叫 `DeepSeek-V4-Pro` —— 前者无法从
 *    展示名判断是 V4 还是 V4.1）；
 * 2. **id 与模型名完全无字面关系**（lobsterai 的远端专有 `deepseek-flash`
 *    实际是 `DeepSeek-V4.1-Flash`，而它兜底表里的 `deepseek-v4-flash` 是
 *    **另一代更旧的模型**）。
 *
 * ## ⚠️ 每条都必须有实测依据
 *
 * 本表**不得**凭名字相似猜测 —— 猜错会让请求打到错的模型，且无任何提示。
 * 未实测确认的条目**不要**加进来（宁可让它各自成一个单渠道虚拟模型）。
 * 实施时用 e2e 探针逐条核对（见设计文档 §11 的 O1/O2）。
 */
export const CANONICAL_OVERRIDES: Readonly<Record<string, Readonly<Record<string, string>>>> =
  Object.freeze({
    lobsterai: Object.freeze({
      // 远端专有 id；其兜底表里没有它。实测展示名为 DeepSeek-V4.1-Flash
      // （tests/unit/lobsterai-adapter.spec.ts 的远端桩即此形态）。
      'deepseek-flash': 'deepseek-v4-1-flash',
    }),
    // ⚠️ qoder / qodercn 的 dfmodel 是否属于 V4.1 **尚未实测确认**
    //（其展示名不带版本号）。在确认前**故意不登记** —— 它会经 name 通道归成
    // `deepseek-flash`，单独成一个虚拟模型。登记它请先跑实发验证。
    /**
     * ⚠️⚠️ **accio**（用户要求它进聚合的轮换候选表，2026-10-13）。
     *
     * ## 为什么需要（实测的键形态差异）
     *
     * `accio` 走 `name` 通道（见 `PRIMARY_CHANNEL`），而它的展示名 `Qwen 3.8 Flash`
     * 里**有空格** ⇒ `normalizeNameKey` 把空格转成连字符 ⇒ 得 `qwen-3-8-flash`。
     * 而 loomy / trae / qoder 走 **id 通道**，id 形如 `qwen3.8-flash`（**无空格**）
     * ⇒ `normalizeModelKey` 只转点号 ⇒ 得 `qwen3-8-flash`（**无连字符**）。
     *
     * ⇒ 两者是**同一个模型但键不同** ⇒ 被拆成两个虚拟模型
     * ⇒ 用户在聚合的「Qwen3.8-Flash 轮换列表」里**看不到 accio**（症状静默：
     * 它只是不在候选表里）。实测逐个跑 `canonicalKeyFor`：
     *
     * ```
     * loomy / trae / qoder → qwen3-8-flash   ← 三家在用的既有键
     * accio（不加补丁）    → qwen-3-8-flash  ← 多一个连字符，成了孤例
     * ```
     *
     * ## ⚠️ 只登记**确知是同一模型**的那些
     *
     * 方向是**宁可拆开也不误并**（本文件铁律：猜错会让请求打到错的模型且无提示）。
     * 逐条实测后的结论：
     * - `Qwen 3.8 Flash`（`1Drift-F8hS3mK7pL2n`）→ `qwen3-8-flash` ✅ **登记**
     *   —— 四家展示名逐字一致，确知同模型；
     * - `Qwen 3.8 Max` → **不登记**：它经 name 通道得 `qwen-3-8-max`，而 loomy 的
     *   id `qwen-3.8-max` 也得 `qwen-3-8-max`，**本来就一致**，加补丁是多此一举
     *   （且有守卫锁着「连字符形态本来就一致」这件事）；
     * - `Qwen 3.8 27B` / `Qwen 3.5 A3B` / `Standard` / `Professional` / `Ultimate`
     *   → **不登记**：它们是 accio（或其上游）**独有的规格**，猜着并进别家 =
     *   打错模型。⚠️ 27B 与 A3B 是**两个不同的模型**，绝不能并进 `qwen3-8-flash`。
     *
     * ## ⚠️⚠️ 索引键是 **accio 的对外 id（slug）**，不是上游 `modelCode`
     *
     * 补丁按 `realId` 查，而 `realId` 来自 `ctx.llm.listModels(provider)` 返回的
     * **`id`**。自 2026-10-13 起 accio 的对外 id 改成了 slug
     * （`accio-adapter.ts` 的 `accioModelIdOf`，为的是让模型能自报人话）⇒
     * **本表必须跟着改用 slug 索引**。
     *
     * ⚠️ 这是一条**静默的连带失效**：若仍按 `1Drift-F8hS3mK7pL2n` 索引，
     * 查表恒不命中 ⇒ accio 掉回 `qwen-3-8-flash` 孤例键 ⇒
     * **聚合的轮换列表里又看不到它了**（正是加这条补丁要解决的症状），
     * 且不会有任何报错。
     */
    accio: Object.freeze({
      // 对外 id（`normalizeNameKey('Qwen 3.8 Flash')`）→ 三家在用的既有规范键。
      'qwen-3-8-flash': 'qwen3-8-flash',
    }),
    /**
     * Magicrew（超级麦吉国内站，2026-10-29，参与聚合）。
     *
     * ⚠️ **只有一条**，成因与 accio **相反**（那边是「展示名有空格」，这边是
     * 「**上游 id 自带连字符**」）：magicrew 走默认的 `id` 通道，而它的 id 是
     * `qwen-3.8-flash`（**带**连字符）⇒ `normalizeModelKey` 只转点号 ⇒
     * 得 `qwen-3-8-flash`；而 loomy / trae / qoder 的 id 是 `qwen3.8-flash`
     *（**不带**）⇒ 得 `qwen3-8-flash`。
     *
     * ⇒ **同一模型两个键** ⇒ 被拆成两个虚拟模型 ⇒ 用户在聚合的
     * 「Qwen3.8-Flash 轮换列表」里**看不到 magicrew**（症状**静默**：它只是
     * 不在候选表里）。与 accio 那条同因同形，只是成因反过来。
     *
     * ⚠️ 其余 26 个**不登记**：它们的键本来就与既有渠道一致（已逐个跑过
     * `normalizeModelKey` / `canonicalKeyFor`，`via` 全是 `id` 且键与 buddy 等家
     * 逐字相同），加补丁是多此一举，且会遮住将来真实的对不上。
     */
    magicrew: MAGICREW_CANONICAL_OVERRIDES,
    /**
     * **MagiCrew 国际站**（`magicrewintl`，2026-11-01）。
     *
     * ⚠️⚠️ 必须**与国内站逐个相同**，且必须**单独登记**（不能指望某种继承）：
     * 两个 provider 共用同一份 `MAGICREW_FALLBACK_MODELS`（`magicrew-product.ts`
     * 里 `qwen-3.8-flash` 那条 id **带连字符**），漏登记的症状与 `accio` 那次
     * 完全同型且**静默**：`canonicalKeyFor('magicrewintl','qwen-3.8-flash',…)`
     * 走 `via: 'id'` 得到 `qwen3-8-flash` 之外的另一个键 ⇒ 国际站自成一个孤立的
     * 虚拟模型 ⇒ 聚合的「Qwen3.8-Flash 轮换列表」里**永远没有国际站**，
     * 且模型选择器里 qwen3.8-flash 相关会出现两条。零报错、零日志。
     *
     * ⇒ 两站共用同一个常量对象（上面那个 `MAGICREW_CANONICAL_OVERRIDES`），
     *   这样「加一条补丁只改一处」—— 复制两份必然漂移。
     */
    magicrewintl: MAGICREW_CANONICAL_OVERRIDES,
  })

/**
 * 一个候选条目归入哪个规范键。
 *
 * 顺序（**不可调换**）：
 * 1. **排除集**（查 `realId`、`idKey`、**以及 `nameKey`**，见下）→ `undefined`；
 * 2. **显式补丁** → 补丁值（最高优先：它是人工实测结论，胜过任何推导）；
 * 3. **主通道**（`channelOf`）→ 归一化结果；
 * 4. 主通道算出的键与 realId 完全一致**且** provider 声明的是 `name` 通道时，
 *    说明 name 通道没提供信息 → 回落 id 通道。
 *
 * ## ⚠️ 排除集必须查**三条**候选键，不能只查 id
 *
 * 初版只查 `realId` / `idKey`。但 `name` 通道的 provider 可以用**展示名**算出键
 * —— 若某条目的展示名归一后落在排除集里（如展示名就叫 `Auto`）而它的 id 不是
 * `auto`，初版会**放行**它，于是产出一个 `key === 'auto'` 的虚拟模型，与
 * `AGGREGATE_AUTO_MODEL` **撞名**：用户会在模型选择器里看到两个 `auto`，
 * 且 DSH 的 `listModels` 会因 **id 重复**抛 `INVALID_CATALOG`（整个聚合 provider
 * 的目录直接不可用）。
 *
 * ⇒ 排除判定必须在**算出键之后**再做一次，而不是只看 id。
 * ⚠️ qoder 的 `auto` 恰好 `realId === 'auto'`，所以初版能挡住它 —— **这不代表
 * 初版是对的**：挡住它靠的是巧合（id 与展示名同形），换个 id 就漏。
 *
 * @returns `via` 标明归属来源，供面板标注 `⚠️补丁`（人工核查用）。
 */
export function canonicalKeyFor(
  provider: string,
  realId: string,
  realName: string,
): { key: string; via: 'id' | 'name' | 'patch' } | undefined {
  const idKey = normalizeModelKey(realId)
  if (EXCLUDED_ALIASES.has(realId) || EXCLUDED_ALIASES.has(idKey)) return undefined

  // ⚠️ **必须用 `Object.hasOwn` 收窄**（真实缺陷，全分支终审 M9）：这两张表都是
  // 普通对象字面量 ⇒ 原型链上可命中 `constructor` / `toString` / `valueOf` /
  // `hasOwnProperty` / `__proto__` 等键。实测 `CANONICAL_NAMES['constructor']` 返回
  // **`Object` 构造函数**（不是字符串、也不是 `undefined`）⇒ `canonicalDisplayName`
  // 会把它当展示名返回 ⇒ DSH 的 `listModels` 校验要求 `name` 是**非空字符串**
  //（`dsh-llm/lib/index.js`：`typeof model.name !== 'string'` ⇒ 抛
  // `INVALID_CATALOG`）⇒ **整个聚合目录不可用**。
  //
  // 可达性说明（为什么仍要修）：`provider` 来自 `ctx.llm.listProviders()` 且我们已
  // 用白名单收窄（全是本插件内部常量），模型 id 则来自各渠道 `listModels()` ——
  // 其中 `cline` 会透传远端 id，是唯一的注入面。远端给出 `constructor` 这种 id 的
  // 概率极低，但**后果是全局的、修法是一行**，故按「宁可多一道闸」处理。
  const providerPatch = Object.hasOwn(CANONICAL_OVERRIDES, provider)
    ? CANONICAL_OVERRIDES[provider]
    : undefined
  const patched = providerPatch !== undefined && Object.hasOwn(providerPatch, realId)
    ? providerPatch[realId]
    : undefined
  if (patched !== undefined) {
    return EXCLUDED_ALIASES.has(patched) ? undefined : { key: patched, via: 'patch' }
  }

  const nameKey = normalizeNameKey(realName)
  // ⚠️ name 通道算出的键也要过排除集（理由见上方长注释）。
  const chosen = channelOf(provider) === 'name' && nameKey.length > 0 && nameKey !== idKey
    ? { key: nameKey, via: 'name' as const }
    : { key: idKey, via: 'id' as const }
  // 兜底：任何候选键落在排除集里（含 `auto`）一律不归入任何虚拟模型。
  if (EXCLUDED_ALIASES.has(chosen.key)) return undefined
  return chosen
}

/**
 * 规范键 → **官方展示名**（用户在模型选择器里看到的名字）。
 *
 * ⚠️ 只登记我们**确定**的模型。未登记的回退为键本身（不编造）—— 编造一个
 * 「看起来像官方」的名字比显示裸键更糟：用户无从判断它是不是自己想的那个模型。
 * ⚠️ 展示名**不含倍率**：倍率是**按渠道**不同的运行时信息，写进规范名会让同一
 * 虚拟模型在不同渠道下显示不同名字（与「归一」的目的相反）。
 */
const CANONICAL_NAMES: Readonly<Record<string, string>> = Object.freeze({
  'deepseek-v4-1-flash': 'DeepSeek V4.1 Flash',
  'deepseek-v4-flash': 'DeepSeek V4 Flash',
  'deepseek-v4-flash-0731': 'DeepSeek V4 Flash 0731',
  'deepseek-v4-pro': 'DeepSeek V4 Pro',
  'deepseek-flash': 'DeepSeek Flash',
  'glm-5-3': 'GLM-5.3',
  'glm-5-3-flash': 'GLM-5.3-Flash',
  'glm-5-2': 'GLM-5.2',
  'glm-5-1': 'GLM-5.1',
  'glm-5': 'GLM-5',
  'glm-5v-turbo': 'GLM-5V-Turbo',
  'kimi-k3': 'Kimi-K3',
  'kimi-k3-1': 'Kimi-K3-1',
  'kimi-k2-8-preview': 'Kimi-K2.8-Preview',
  'kimi-k2-7': 'Kimi-K2.7',
  'kimi-k2-7-code': 'Kimi-K2.7-Code',
  'kimi-k2-7-code-highspeed': 'Kimi-K2.7-Code-Highspeed',
  'kimi-k2-6': 'Kimi-K2.6',
  'kimi-k2-5': 'Kimi-K2.5',
  'minimax-m3': 'MiniMax-M3',
  'minimax-m2-7': 'MiniMax-M2.7',
  'minimax-m2-7-highspeed': 'MiniMax-M2.7-highspeed',
  'minimax-m3-1-flash-preview': 'MiniMax-M3.1-Flash-Preview',
  'qwen3-8-max': 'Qwen3.8-Max',
  'qwen3-8-flash': 'Qwen3.8-Flash',
  'qwen3-7-max': 'Qwen3.7-Max',
  'qwen3-7-plus': 'Qwen3.7-Plus',
  'qwen3-7-flash': 'Qwen3.7-Flash',
  'qwen3-6-plus': 'Qwen3.6-Plus',
  'qwen-3-8-max': 'Qwen 3.8 Max',
  'qwen-3-7-plus': 'Qwen 3.7 Plus',
  'qwen3-5-plus-2026-04-20': 'Qwen3.5-Plus-2026-04-20',
  'gemini-3-8-flash': 'Gemini 3.8 Flash',
  'gemini-3-5-flash': 'Gemini 3.5 Flash',
  'hy4-preview': 'Hy4 Preview',
  'hy3': 'Hy3',
  'hy3-x': 'Hy3 X',
  'sensenova-6-8-flash': 'SenseNova-6.8-Flash',
  'sensenova-6-8-flash-lite': 'SenseNova-6.8-Flash-Lite',
  'doubao-seed-2-1-pro-260628': 'Doubao Seed 2.1 Pro',
  'doubao-seed-2-1-turbo-260628': 'Doubao Seed 2.1 Turbo',
  'doubao-seed-2-0-code-preview-260215': 'Doubao Seed 2.0 Code Preview',
  'deepseek-v4-flash-official': 'DeepSeek V4 Flash Official',
})

/** 规范键 → 展示名；未登记的回退为键本身（不编造）。 */
export function canonicalDisplayName(key: string): string {
  // ⚠️ **必须用 `Object.hasOwn`**（真实缺陷，全分支终审 M9）：`CANONICAL_NAMES` 是
  // 普通对象字面量 ⇒ `CANONICAL_NAMES['constructor']` 会沿原型链返回 **`Object`
  // 构造函数**（不是 `undefined`）⇒ 本函数返回一个**函数对象**而非字符串 ⇒
  // DSH 的 `listModels` 校验（要求 `name` 是非空字符串）抛 `INVALID_CATALOG`
  // ⇒ **整个聚合目录不可用**。实测 `typeof canonicalDisplayName('constructor')
  // === 'function'`。
  return Object.hasOwn(CANONICAL_NAMES, key) ? CANONICAL_NAMES[key]! : key
}
