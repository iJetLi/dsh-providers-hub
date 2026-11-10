import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { descriptorOf } from '../../src/provider-registry.js'
import { jetHubAuthsCallKeys } from '../helpers/jet-hub-auths.js'

const here = dirname(fileURLToPath(import.meta.url))
const indexSource = stripComments(readFileSync(resolve(here, '../../src/index.ts'), 'utf8'))

/**
 * 取某 provider 的**工厂配置块**（`createCredentialResolver(...)` 那一段）。
 *
 * ⚠️ 2026-10-08 新增（Task 6）：loomy 的选号已收敛进 `createCredentialResolver`，
 * 源码里不再有 `loomyBalanceSelector.select(...)` / `getAvailableAccount(LOOMY.id, '')`
 * 这类逐行文本。要断言接线就得先定位到那个**配置块**，再在块内匹配 ——
 * 全文件 `toContain` 会让同一标识符在别处出现一次就恒真（本仓库已记录该形态）。
 *
 * ⚠️ **归属判据是「块内第一个 `product: <CONST>,`」**，不能写成
 * 「块内是否出现 `product: LOOMY,`」：`loomyBalanceSelector` 的**定义**恰好夹在
 * 上一个工厂调用与本工厂调用之间，于是它会被算进**上一个** provider 的块里
 *（写本用例时实测到：CLINE 的块里含 `product: LOOMY,`）。取第一个就无歧义 ——
 * 工厂配置项里 `product` 永远是首字段。
 */
function factoryBlockOf(source: string, product: string): string {
  const calls = [...source.matchAll(/createCredentialResolver(?:<[^>]*>)?\(/g)].map(m => m.index!)
  for (let i = 0; i < calls.length; i++) {
    const block = source.slice(calls[i]!, calls[i + 1] ?? source.length)
    const first = /product: (\w+),/.exec(block)
    if (first?.[1] === product) return block
  }
  throw new Error(`index.ts 里找不到 ${product} 的 createCredentialResolver 配置块`)
}

/**
 * 源码级回归：新增 provider 的接线点一处都不能漏。
 * 历史缺陷正是「加了 provider 但忘了在 modelAdapters 里登记」→
 * 设置页里被关闭的模型显示成裸 id（丢倍率）。
 */
/** 剥掉注释：接线断言不该因为「注释里提到了某个符号」而通过。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

describe('Loomy 在 index.ts 的接线', () => {
  it('导入并实例化 LoomyAuth', () => {
    expect(indexSource).toContain("from './loomy-auth.js'")
    expect(indexSource).toContain('new LoomyAuth(ctx)')
  })

  it('注册 Loomy 适配器并接收返回值', () => {
    expect(indexSource).toContain("from './loomy-adapter.js'")
    expect(indexSource).toContain('registerLoomyLlm(ctx,')
    expect(indexSource).toMatch(/const loomyAdapter = registerLoomyLlm/)
  })

  it('provider 解析用 LOOMY（不写死字面量）', () => {
    // ⚠️ 2026-10-08 改（Task 6）：原先断言 `pool.getAvailableAccount(LOOMY.id, '')`
    // 这个**源码文本**。loomy 的选号已收敛进 `createCredentialResolver`，取号
    // 由工厂完成（实参是 `config.product.id`），那个文本形消失了。
    // ⇒ 改锁「工厂配置项的 `product` 用的是 LOOMY 常量」。这仍然守住了原意图
    //（不写死字面量 'loomy'）—— 工厂拿 `config.product.id` 去查池。
    expect(factoryBlockOf(indexSource, 'LOOMY')).toContain('product: LOOMY,')
    // 且整个 loomy 注册块里不得出现写死的 `'loomy'` 字面量查池。
    expect(indexSource).not.toMatch(/getAvailableAccount\('loomy'/)
    expect(indexSource).not.toMatch(/listAccountsByProvider\('loomy'/)
  })

  it('refresh 走 refreshAccountCredential（刷新解析凭据所用的那个账号）', () => {
    // `[^)]*` 容忍签名扩展：续期成功后要把新 `expiresAt` 回写账号池，
    // 故实际调用还带 `pool` + `available.entry.id`（见 issue !IKIRTT）。
    expect(indexSource).toMatch(/loomy\.refreshAccountCredential\(available\.entry\.credentialRef[^)]*\)/)
  })

  /**
   * ⚠️ **按余额优先选号（负载均衡）**。
   *
   * **真实缺陷**：实测 Loomy 今日额度（每天 5000）耗尽后**继续扣永久积分
   * 且不报错**（静默降级），而既有「限流 → 换号」只在服务端返回限流错误时
   * 触发，故对它完全无效 —— 会一直烧同一个号（用户报障）。
   *
   * ⚠️ 2026-10-08 改（Task 6）：候选筛与 select 调用已下沉到
   * `createCredentialResolver` 的 loomy 分支，故断言改为「配置块把选择器与
   * 锁文案交给了工厂」。候选筛法（enabled + 模型限流）**在工厂里只有一份**，
   * 由 `credential-resolver-parity.spec.ts` 的「候选筛法一致」对拍守住。
   */
  it('接入按余额优先的选号器（负载均衡）', () => {
    const block = factoryBlockOf(indexSource, 'LOOMY')
    expect(indexSource).toContain("from './loomy-balance-selector.js'")
    expect(indexSource).toContain('new LoomyBalanceSelector(')
    // 配置块必须把 loomy 自己的选择器与锁文案交给工厂（走 loomy 分支）。
    expect(block, '必须走 loomy 分档分支').toContain("kind: 'loomy'")
    expect(block, '必须用 loomy 自己的选择器').toContain('selector: loomyBalanceSelector')
    expect(block, '锁定文案必须传 loomy 那份（口径是「今日赠送额度」）')
      .toContain('lockedError: loomyLockedError')
  })

  /**
   * ⚠️ **模型 id 必须透传给选号器**：限流是**按模型**记的，
   * 传空串等于「不按模型过滤」，会让模型级限流失效（原实现的疏漏）。
   *
   * ⚠️ 2026-10-08 改（Task 6）：宿主侧的 `const key = modelId ?? ''` 那段
   * 已下沉到工厂（唯一实现）。故这里只保留**适配器侧**的源码断言，
   * 宿主侧改为「真实闭包按模型过滤」的**行为断言** —— 见
   * `trae-model-id-selection.spec.ts` 的「宿主层」一组（它逐 provider 驱动
   * 真实 `apply()`，比文本断言强）。
   */
  it('resolveCredential 接收并透传 modelId（限流按模型记）', () => {
    const adapterSource = readFileSync(
      resolve(here, '../../src/loomy-adapter.ts'), 'utf8',
    )
    // 适配器侧：声明与调用都带 modelId
    // ⚠️ 2026-11-11：签名多了第二参 `sessionId`（「轮换起点」的作用域键）。
    //    本用例原本只守「modelId 透传」，改为同时接受两参形态 ——
    //    `modelId` 仍是**第一参**，故该用例的原始意图不变。
    expect(adapterSource).toMatch(/resolveCredential: \(modelId\?: string, sessionId\?: string\)/)
    expect(adapterSource).toContain('this.options.resolveCredential(options.model, options.sessionId)')

    // 宿主侧：loomy 的工厂配置块不得把 modelId 吞掉 —— 工厂**不接受** modelId
    // 作为配置项（它是每次调用的实参），故这里断言「配置块里没有 modelId 相关
    // 的死配置」，真正的透传由行为断言守。
    const block = factoryBlockOf(indexSource, 'LOOMY')
    expect(block, '工厂配置里不该出现 modelId（它是每次调用的实参）').not.toContain('modelId:')
  })

  it('settings namespace 已声明（行为断言，2026-10-08 改）', () => {
    // ⚠️ 2026-10-08 改：原先是扫 `src/index.ts` 源码文本找 `'llm-loomy'`。本次重构把
    //    13 个字面量收敛成从 `PROVIDER_REGISTRY` 派生，字面量搬家 ⇒ 文本断言变红。
    //    改为断言声明值；「index.ts 真的按它注册了」由
    //    `provider-registry-consumers.spec.ts` 的 `apply()` 行为用例守。
    expect(descriptorOf('loomy')?.settingsNamespace).toBe('llm-loomy')
  })

  it('加入批量续期调度', () => {
    // ⚠️ **2026-10-08 改（Task 10）**：原先断言 `src/index.ts` 的源码文本含
    //    `loomy.refreshAll(pool|p)` —— 那张手抄清单已被 `wiredRefreshTargets()`
    //    从**能力注册表**派生取代 ⇒ 该文本形态**不存在了**，而它守的意图
    //    （loomy 在续期调度里）**与文本无关**。
    //
    // ⇒ 改为**结构断言**：注册循环必须为**每个** provider 挂 `refreshAll`
    //    （它是派生表的唯一来源）。
    // ⚠️ 行为断言（真跑 `apply()` 后逐个驱动 `auth.refreshAll`、断言打到
    //    **自己那个**实例）在 `provider-runtime-wiring.spec.ts` 的
    //    「★ 13 家都挂上了 `auth.refreshAll`」一条里，**比本条更强**。
    expect(indexSource, '注册循环没有挂 refreshAll（派生表会恒为空）')
      .toMatch(/refreshAll:\s*\(pool\)\s*=>\s*auth\.refreshAll\(pool\)/)
    expect(indexSource, 'refreshTargets 又回到手抄清单了')
      .toMatch(/wiredRefreshTargets\(\)/)
  })

  it('cleanup 调用 loomy.stop()', () => {
    expect(indexSource).toMatch(/loomy\.stop\(\)/)
  })

  it('modelAdapters 里登记了 loomy', () => {
    // ⚠️ 2026-10-06 复审 !66：登记项改为经 `pruned(...)` 包装（否则拿的是原始
    // 实例，「已失效模型」剔除对 Jet Hub 设置页不生效）。断言的是**登记语义**，
    // 故用正则容忍包装层，不要写死字面写法。
    expect(indexSource).toMatch(/const modelAdapters[\s\S]*?loomy: pruned\([^)]*,\s*loomyAdapter\)/)
  })

  it('registerJetHubRpc 传入了 loomy', () => {
    // ⚠️ 2026-10-08 改（Task 3）：原先这条是**相邻性正则**
    //    `/registerJetHubRpc\([\s\S]*?loomy,[\s\S]*?modelAdapters\)/`。
    //    Task 3 一度给 `registerJetHubRpc` 加了**第 5 个位置形参** `credits`
    //    （调用点变成 `… }, modelAdapters, creditsTable)`）⇒ 正则必然假失败。
    //    该形参随后在设计复审 C1 中被删除，但**本条的改法保留**：它守的意图
    //    （loomy 的 auth 实例接上了）**与形参个数无关**，AST 取键比重排-敏感
    //    的正则强。
    //    ⇒ 按 **AST** 取调用点第三个实参（auths 对象字面量）的键。
    const authKeys = jetHubAuthsCallKeys(indexSource)
    expect(Object.keys(authKeys), 'loomy 必须在 auths 命名对象里（键 = provider id）')
      .toContain('loomy')
    expect(authKeys.loomy, '`loomy` 键的值必须是 loomy 实例').toBe('loomy')
  })

  /**
   * ⚠️ 远端模型目录必须用 **token 头**（业务端点），不是 Bearer。
   * 带错会得到 `100002 缺少 token`，表现为「模型列表永远是兜底表」。
   */
  it('fetchRemoteModels 用 token 头请求 /models', () => {
    // ⚠️ 不能用 `indexOf('fetchRemoteModels')` —— 那个字符串在文件里出现 6 次
    // （每个 provider 一次），会命中 CodeArts 的那处。用 Loomy 专属锚点。
    const start = indexSource.indexOf('LOOMY.apiBase}/models')
    expect(start).toBeGreaterThan(-1)
    const body = indexSource.slice(Math.max(0, start - 400), start + 200)
    expect(body).toContain('token: credential.access_token')
    expect(body).toContain('token') // 业务端点用 token 头
  })
})
