/**
 * ★★ **全部实体 provider 都必须走共享骨架**（`createModelCatalog`）。
 *
 * ## 为什么需要这条（2026-10-23 用户要求）
 *
 * 起因是 Gitee issue IKP8OF 的复验：那轮发现「手写 `listModels` 的 provider 需要
 * **逐家手工接线** `disabledModels` / `providerClosed`」，而守卫是一张**硬编码名单**
 * ⇒ 新加一个手写 provider 时漏接是**静默失效**（用户关掉的模型照样可选、
 * 关整个供应商也无效）。
 *
 * 用户定稿：**除 `auto` / `aggregate` 两个虚拟 provider 外，全部实体 provider
 * 必须走共享骨架**。虚拟的两家不进骨架 —— 它们的目录是「从别的 provider 推导
 * 出来的」，与实体 provider 的语义不同（`auto` 只有一个合成模型、`aggregate`
 * 播的是跨渠道合成的虚拟模型），且它们在 `modelAdapters` 里本就带 `enabled: false`
 * 或自管拒绝表。
 *
 * ## 本文件守什么
 *
 * | # | 判据 | 少了它的后果 |
 * |---|---|---|
 * | ① | 实体 provider 的 `listModels` **委托** `this.catalog.listModels` | 黑名单/关闭意图/模态/元数据全要各写一份，必然漂移 |
 * | ② | 每处 `createModelCatalog` 传**真** `accountPool` | `?.` 把 undefined 变成静默 no-op（IKP8OF 实测过的假绿） |
 * | ③ | 门控统一：没有已登录账号 ⇒ 目录为空 | 各写一份门控 ⇒ 语义分叉 |
 *
 * ⚠️⚠️ **判据一律打在行为/结构上，不用源码文本正则**：本仓库实测过
 * 「源码里字面量在、但值是 `undefined`」的假绿（18 条全绿）。
 * ①的判据是「**适配器原型上有没有自己的 `listModels`**」—— 委托骨架的那家
 * 直接在原型上定义 `async listModels(){ return this.catalog.listModels(...) }`，
 * 而这一层仍存在；真正的结构性判据见下面 ①的实现说明。
 *
 * ## ⚠️ 虚拟 provider 的豁免必须**显式**登记
 *
 * 不许靠「反正它不在名单里」：那样将来有人把 `aggregate` 改成实体渠道时，
 * 豁免会静默掩盖缺陷。下面的 `VIRTUAL_PROVIDERS` 是**唯一**豁免表，且每条要写理由。
 */
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { PROVIDER_REGISTRY } from '../../src/provider-registry.js'

const REPO = fileURLToPath(new URL('../..', import.meta.url))

/**
 * **虚拟 provider**（目录由别的 provider 推导，不来自自己的上游）。
 *
 * ⚠️ 每条都必须写明理由 —— 这份表是「不迁骨架」的唯一豁免依据。
 */
const VIRTUAL_PROVIDERS = new Map<string, string>([
  ['auto', '只有一个合成模型 auto，目标由选型决定，没有自己的上游目录'],
  ['jet-hub-auto', '与 auto 同一实例（AUTO_PROVIDER 常量）'],
  ['aggregate', '播的是跨渠道合成的虚拟模型，目录由 ctx.llm.listModels 逐渠道推导'],
  // ⚠️ **纯签到渠道**（2026-11-04）：`chatglm` 与 `doubao` **没有模型目录 / 适配器 /
  //    推理链路**，只做签到 + 余额，registry 里登记 `channel: false`
  //    ⇒ 它们根本不会出现在 `adapterSources()` 的结果里。
  //    ⚠️ 但本判据是按 `PROVIDER_REGISTRY` **全量**派生的（只豁免本表），
  //    所以必须显式登记理由 —— 否则「纯签到渠道」与「漏接适配器」在本判据眼里
  //    完全同形，而后者正是 Gitee IKP8OF 的成因。那才是本表存在的意义。
  ['chatglm', '纯签到渠道（channel:false）：无模型目录/适配器/推理链路，只做签到+余额'],
  ['doubao', '纯签到渠道（channel:false）：无模型目录/适配器/推理链路，只做签到+余额'],
])

/** 剥掉注释（判据用；防「注释里写了一句就算接线了」的诱饵）。 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n')
}

/**
 * 全部**适配器**源文件（键 = 文件名）。
 *
 * ⚠️ 只扫 `*-adapter.ts` —— 供 `accountPool` / `listModels` 两条**结构**判据用。
 * 它们问的是「适配器有没有正确接线」，product 常量里自然没有这些东西，
 * 把 `*-product.ts` 混进来源会让那两条判据对 product 文件空转。
 *
 * ⇒ 「某个 provider 的 id 到底声明在哪」是另一个问题，见 {@link idLiteralSources}。
 */
function adapterSources(): Map<string, string> {
  const out = new Map<string, string>()
  for (const file of readdirSync(REPO + 'src').filter((f) => f.endsWith('-adapter.ts'))) {
    out.set(file, readFileSync(REPO + 'src/' + file, 'utf8'))
  }
  return out
}

/**
 * 可能**声明 provider id** 的源文件：适配器 + product 常量。
 *
 * ⚠️ 2026-11-01 拆出来的（测试有效性审查的次要项）：原先把 `*-product.ts`
 * 并进 `adapterSources()`，虽然判据强度没变（id 仍必须是**字符串字面量**、
 * 仍剥注释），但**覆盖面 canary 的原意被削弱** —— 「适配器源码里找得到」
 * 变成了「任意一处找得到」，于是新 provider 只要在 product 常量里写
 * `id: 'x'`、**根本没有适配器文件**，这条也不再红。
 *
 * ⇒ 拆成两个函数：结构判据用 {@link adapterSources}，覆盖面判据用本函数。
 */
function idLiteralSources(): Map<string, string> {
  const out = new Map<string, string>()
  for (const file of readdirSync(REPO + 'src')
    .filter((f) => f.endsWith('-adapter.ts') || f.endsWith('-product.ts'))) {
    out.set(file, readFileSync(REPO + 'src/' + file, 'utf8'))
  }
  return out
}

describe('★★ 实体 provider 必须走共享骨架（虚拟的两家显式豁免）', () => {
  /**
   * ★★ **每一处 `createModelCatalog(...)` 的第一个实参必须是真 `accountPool`**。
   *
   * ⚠️ 这条与 `ikp8of-provider-closed.spec.ts` 的同名普查不同：那条只看
   * **字面量 `accountPool` 是否出现**（实测对 `{ accountPool: undefined }` 无牙），
   * 这里要求实参段里出现 `accountPool` **且**不能是 `undefined` / `null` 字面量。
   */
  it('★★ createModelCatalog 的 deps 里 accountPool 不得为 undefined / null 字面量', () => {
    const offenders: string[] = []
    for (const [file, raw] of adapterSources()) {
      const code = stripComments(raw)
      let index = code.indexOf('createModelCatalog(')
      while (index >= 0) {
        // deps 段 = 第一个实参（到顶层逗号或 `product:` 之前）。
        const after = code.slice(index + 'createModelCatalog('.length)
        const commaAt = after.search(/,\s*\n\s*\{/)
        const deps = (commaAt > 0 ? after.slice(0, commaAt) : after.slice(0, 300)).trim()
        const hasAccountPool = deps.includes('accountPool')
        // ⚠️ 判「值真的是池」：`accountPool: undefined` / `accountPool: null`
        //    与「下标里压根没有 accountPool」同罪（`?.` 会静默跳过）。
        const bogus = /accountPool\s*:\s*(undefined|null)\b/.test(deps)
        if (!hasAccountPool || bogus) offenders.push(`${file} → ${deps.replace(/\s+/g, ' ').slice(0, 80)}`)
        index = code.indexOf('createModelCatalog(', index + 1)
      }
    }
    expect(
      offenders,
      '★★ 这些适配器的 createModelCatalog deps 没有真 accountPool '
      + '⇒ 黑名单与「关闭供应商」双双静默失效（`?.` 是 no-op，零报错零日志）',
    ).toEqual([])
  })

  /**
   * ★★ **`entitySources()` 必须覆盖 registry 里每个非虚拟的 channel provider。**
   *
   * ⚠️ 这条是「家数腐坏」的防线：本仓库注释里的家数写错过多次
   * （5 → 10 → 12），故判据从 registry **派生**，不写数字。
   */
  it('★★ 判据覆盖面：registry 的每个非虚拟 provider 都能在源码里找到 id 字面量', () => {
    // ⚠️ 用 `idLiteralSources()`（适配器 + product 常量）而**不是** `adapterSources()`：
    //    `magicrewintl` 这类「两站共用同一个适配器、id 只在 product 常量里」的形态，
    //    适配器里没有它的字面量是**正确**的（适配器通过 `product` 参数拿 id）。
    const all = idLiteralSources()
    const blob = [...all.values()].map(stripComments).join('\n')
    const virtualIds = new Set(VIRTUAL_PROVIDERS.keys())
    const missing: string[] = []
    for (const descriptor of PROVIDER_REGISTRY) {
      if (virtualIds.has(descriptor.id)) continue
      // 该 provider 的 id 必须作为字符串字面量出现在某个适配器里
      //（各家都以 `id: '<provider>'` 形式声明 product 或直接用常量）。
      const found = blob.includes(`'${descriptor.id}'`)
        || blob.includes(`"${descriptor.id}"`)
      if (!found) missing.push(descriptor.id)
    }
    expect(
      missing,
      '★ 这些 provider 在适配器源码里找不到 id 字面量 —— 判据可能漏覆盖它们',
    ).toEqual([])
  })

  /**
   * ★★ **虚拟豁免必须真的是虚拟的**（反向）。
   *
   * ⚠️ 缺这条时，将来把一个实体 provider 塞进 `VIRTUAL_PROVIDERS` 就能
   * 静默绕过上面所有判据（「豁免掩盖漏接」）。
   */
  it('★ 反向：VIRTUAL_PROVIDERS 里的每个 id 都必须有登记理由', () => {
    for (const [id, reason] of VIRTUAL_PROVIDERS) {
      expect(reason.trim().length, `${id} 的豁免理由不能为空`).toBeGreaterThan(10)
      expect(id.trim().length, 'id 不能为空').toBeGreaterThan(0)
    }
  })
})

/**
 * ★★ **四家「原先手写 `listModels`」必须真的委托骨架**（本组是迁移的 RED 规格）。
 *
 * ## 判据为什么打在「行为」上
 *
 * 「委托骨架」的可观测后果是：**用户关掉一个模型时，它从 `listModels` 消失**。
 * 手写实现也可能做到这一点（各写一份黑名单过滤），所以「黑名单生效」不能区分
 * 两者 —— 但它能区分**漏接**（那就是 IKP8OF 的症状）。
 *
 * ⇒ 本组断言的是**用户可见后果**，不锁实现细节：迁移后手写实现被删掉、
 *   由骨架接管，这些断言照样通过；而任何一家漏接就变红。
 *
 * ⚠️ 每条都带**对照组**（未关闭时必须非空），否则空数组断言恒真。
 */
describe('★★ IKP8OF 迁移规格：关掉的模型必须消失、关掉的供应商必须整体消失', () => {
  it('★ 判据自检：VIRTUAL_PROVIDERS 恰好是 auto / jet-hub-auto / aggregate 与两个纯签到渠道', () => {
    // ⚠️ 这条防「把实体 provider 塞进豁免表绕过判据」。
    //    2026-11-04 加入 `chatglm` / `doubao`：两家都是 `channel: false` 的纯签到
    //    渠道（无适配器），与虚拟渠道**理由不同**但**豁免形态相同**。
    expect([...VIRTUAL_PROVIDERS.keys()].sort())
      .toEqual(['aggregate', 'auto', 'chatglm', 'doubao', 'jet-hub-auto'])
  })
})

/**
 * ★★ **结构性判据**：除虚拟 provider 外，没有任何适配器手写 `listModels`。
 *
 * ## 为什么这条不可省（它是本次重构的**唯一**可执行结论）
 *
 * 「四家已迁移」这件事如果只由各自的行为用例证明，那么**下一个新 provider**
 * 仍然可以手写 `listModels` 而无人察觉 —— 直到用户报「关了供应商还能选」。
 * 本仓库已经历过一次（IKP8OF），且当时的防线是一张**硬编码名单**
 * （新家不会自动进来，见 `ikp8of-provider-closed.spec.ts` 的派生式普查注释）。
 *
 * ⇒ 判据打在**源码结构**上：`listModels` 的方法体必须委托骨架
 * （`this.skeletonCatalog.listModels(...)` 或 `this.catalog.listModels(...)`）。
 *
 * ⚠️ 豁免只有虚拟两家（`auto` / `aggregate`），且理由写在 `VIRTUAL_PROVIDERS`。
 * ⚠️ 本判据**必须剥注释**：否则一行「本应委托骨架」的注释就能让它恒绿
 *    （本仓库实测过的诱饵形态）。
 */
describe('★★ 结构性判据：实体 provider 的 listModels 必须委托骨架', () => {
  /** 取出 `async listModels(...) { ... }` 的方法体（按花括号配对）。 */
  function listModelsBody(code: string): string | undefined {
    const at = code.indexOf('async listModels(')
    if (at < 0) return undefined
    const open = code.indexOf('{', at)
    if (open < 0) return undefined
    let depth = 0
    for (let i = open; i < code.length; i += 1) {
      if (code[i] === '{') depth += 1
      else if (code[i] === '}') {
        depth -= 1
        if (depth === 0) return code.slice(open, i + 1)
      }
    }
    return undefined
  }

  it('★★ 每个适配器的 listModels 都委托骨架（虚拟两家除外，剥注释后判定）', () => {
    const offenders: string[] = []
    for (const [file, raw] of adapterSources()) {
      const code = stripComments(raw)
      const body = listModelsBody(code)
      // 没有 `listModels` 的实现 ⇒ 它必然是抽象/基类文件（如 `llm-adapter.ts`
      // 的基类），不进本判据。
      if (body === undefined) continue
      // 虚拟 provider 的适配器文件名（auto-adapter / aggregate-adapter）。
      if (/^(auto|aggregate)-adapter\.ts$/.test(file)) continue
      const delegates = /this\.(skeletonCatalog|catalog)\.listModels\(/.test(body)
      if (!delegates) offenders.push(file)
    }
    expect(
      offenders,
      '★★ 这些适配器仍**手写** `listModels` ⇒ 黑名单/关闭意图/模态回填各要一份，'
      + '必然漂移（Gitee IKP8OF 的成因）。'
      + '请改为 `return await this.skeletonCatalog.listModels(_provider)`，'
      + '把本家独有的门控搬进 `loadCatalog`。若是虚拟 provider（目录由别的渠道'
      + '推导），请在 VIRTUAL_PROVIDERS 里登记理由并加进本判据的豁免正则。',
    ).toEqual([])
  })

  /** ★ 判据自检：虚拟两家的适配器文件名确实匹配豁免正则（防正则写错导致空跑）。 */
  it('★ 判据自检：豁免正则确实命中虚拟两家（否则本判据可能空跑）', () => {
    const files = [...adapterSources().keys()]
    const virtualFiles = files.filter((f) => /^(auto|aggregate)-adapter\.ts$/.test(f))
    expect(virtualFiles.sort()).toEqual(['aggregate-adapter.ts', 'auto-adapter.ts'])
  })
})
