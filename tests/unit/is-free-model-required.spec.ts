/**
 * `BuddyBalancePlan.isFreeModel` **必填**契约的守卫（2026-10-21 收紧）。
 *
 * ## 背景：这个字段曾经是可选，代价是一次真实事故
 *
 * 原签名是 `readonly isFreeModel?: (modelId?: string) => Promise<boolean> | boolean`。
 * 「可选」意味着新增一家 `balance: { kind: 'buddy' }` 装配时**漏传它不会有任何
 * 提示** —— 编辑器不划线、`tsc` 不报错、运行时也不报错（消费侧当时写着
 * `plan.isFreeModel === undefined ? false : …` 兜底）。后果：
 *
 * 1. 该家的**免费模型**与付费模型走同一条余额分档路；
 * 2. 「锁定永久积分」开关打开后，免费模型被一并拦住；
 * 3. 报出的文案是「**额度都属于长期/永久**」—— 与事实相反（那模型消耗 0 积分）；
 * 4. 把用户推向「解锁永久积分」，而永久积分一旦烧掉**不可逆**。
 *
 * Qoder 就是这样漏了三周多：`src/qoder-product.ts` 的兜底表早在 `qmodel_38max` /
 * `qfmodel` 上标了 `isFree: true`，`src/qoder-adapter.ts` 的 `toCatalogEntry` 也把
 * `isFree` 透出给了 UI（用户**看得见**那不是付费模型），唯独装配层漏了这三个字。
 * 同一缺陷形态在 buddy / workbuddy / trae 上已各自复发过一轮。
 *
 * ## 本文件守什么
 *
 * | 用例组 | 守的层级 | 哪个变异会让它红 |
 * |---|---|---|
 * | ① 类型层 | 字段不可省略 | 把 `isFreeModel` 改回 `?` 可选（编译期失去保护） |
 * | ② 契约层 | 消费侧**不再**兜底 undefined | 把 `await plan.isFreeModel(...)` 改回三元判空 |
 * | ③ 接线层 | 11 处装配全部显式声明 | 任删一处 `isFreeModel:` 行 |
 * | ④ 语义层 | `NO_FREE_MODEL` 真的返回 false | 把它改成 `() => true` |
 *
 * ⚠️ ③ 用**运行时反射**（读 `src/index.ts` 源码里 `kind: 'buddy'` 的出现次数并
 * 逐块检查）而不是只跑 tsc：`tsconfig.tests.json` 的 `include` 只列了 8 个文件，
 * 本 spec 不在其中，所以**本文件里的类型错误不会让任何命令失败**。源码正则守卫
 * 是这条约束唯一能真正跑到的地方。
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createCredentialResolver, NO_FREE_MODEL } from '../../src/credential-resolver.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = resolve(HERE, '../../src')

function readSrc(name: string): string {
  return readFileSync(join(SRC, name), 'utf8')
}

/**
 * 剥掉注释（块注释 + 整行注释）。
 *
 * ⚠️ **必须剥**：本文件的两条计数判据（块内 `has`、全局 `total`）若把注释算进去，
 * 就会**双向出错** —— 注释里写一句「`isFreeModel:` 见某处」⇒ `total` 假红（2026-11-01
 * 实测撞到：在 `:4170` 的注释里提起该字段，`total` 从 13 变 15）；
 * 反过来把真代码删掉、只留注释 ⇒ 块内 `has` 假绿（缺陷原地复发而用例全绿）。
 * 实现与 `tests/unit/autoclaw-lock-wiring.spec.ts:63` 的 `codeOnly()` 逐字同款。
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    // ⚠️ **行尾注释也必须剥**（2026-11-01 二审实测的两个漏洞）：
    //   ① **假绿**：把真代码整行注释掉、再在同块某行的**行尾**注释里提一句
    //      `isFreeModel:` ⇒ 行尾那个把被删的那个抵消 ⇒ strip 后计数不变 ⇒ 11/11 全绿；
    //   ② **假红**：完全不动代码、只在两行行尾各提一次 ⇒ `total` 15 > 14 ⇒ 红。
    //   用 `[ \t]+` 而不是 `\s+`：`\s` 含换行，会把注释**前面的空行**一起吞掉。
    //
    // ⚠️ **已知残留风险**：这条规则无法区分「字符串里写了 ` // `」与真注释 ——
    //    若有朝一日 `src/index.ts` 出现 `const x = 'a // b'` 这种写法，它会被误剥、
    //    进而让大括号配平炸掉（症状是 `buddyPlanBlocks` 的 expect 失败，不是静默）。
    //    当前该文件 0 处此形态（二审用 TS AST 逐节点查过 599 个字面量）；
    //    真出现时请把本函数换成 AST 判据，**不要**再往正则上打补丁。
    .replace(/[ \t]+\/\/[^\n]*$/gm, '')
}

/** 把 `src/index.ts` 里每个 `kind: 'buddy'` 对象块切出来（按大括号配平）。 */
function buddyPlanBlocks(code: string): Array<{ start: number; body: string }> {
  const blocks: Array<{ start: number; body: string }> = []
  const marker = "kind: 'buddy',"
  let from = 0
  for (;;) {
    const at = code.indexOf(marker, from)
    if (at < 0) break
    from = at + marker.length
    // 从标记往前找 `balance: {`，从那里开始配平大括号。
    const open = code.lastIndexOf('balance: {', at)
    expect(open, '每个 kind: \'buddy\' 都应位于 balance: { 块内').toBeGreaterThan(0)
    let depth = 0
    let i = open + 'balance: '.length
    for (; i < code.length; i += 1) {
      const ch = code[i]
      if (ch === '{') depth += 1
      else if (ch === '}') {
        depth -= 1
        if (depth === 0) {
          i += 1
          break
        }
      }
    }
    blocks.push({ start: at, body: code.slice(open, i) })
  }
  return blocks
}

describe('① 类型层：isFreeModel 是必填字段', () => {
  it('接口声明里没有问号（可选标记一旦回来，编译期保护就没了）', () => {
    const code = readSrc('credential-resolver.ts')
    // 变异：把 `readonly isFreeModel:` 写回 `readonly isFreeModel?:` ⇒ 红。
    expect(code).toContain('readonly isFreeModel: (modelId?: string) => Promise<boolean> | boolean')
    expect(code).not.toContain('readonly isFreeModel?:')
  })

  it('NO_FREE_MODEL 是导出的具名常量，而不是散落的匿名箭头', () => {
    const code = readSrc('credential-resolver.ts')
    // 变异：删掉 `export const NO_FREE_MODEL` 定义 ⇒ 红（`index.ts` 也无法 import）。
    expect(code).toMatch(/export const NO_FREE_MODEL\s*=\s*\(\):\s*false\s*=>\s*false/)
  })

  /**
   * ⚠️ **字段在类型上必须是必填**（源码级判据）。
   *
   * ## ⚠️⚠️ 这里原先是一个**不可执行的** `@ts-expect-error` + 一条**同义反复**
   * （2026-10-21 合并审计发现）
   *
   * 原实现是：
   * ```ts
   * const plan = { kind:'buddy' as const, selector:…, lockedError:…,
   *   // @ts-expect-error isFreeModel 是必填字段，故意漏写
   * }
   * expect(Object.hasOwn(plan, 'isFreeModel')).toBe(false)
   * ```
   *
   * 两处都无效：
   * ① `plan` **没有上下文类型**（不是 `BuddyBalancePlan`）⇒ 漏写字段**根本不报错**
   *    ⇒ 该指令无处可用。实测把它纳入 tsc 会报
   *    `TS2578: Unused '@ts-expect-error' directive` ⇒ 将来有人把它加进
   *    `tsconfig.tests.json`，`pnpm test`（`pretest` → `typecheck:tests`）会**直接失败**，
   *    恰好与原注释声称的「加进去就立刻生效」**方向相反**。
   * ② `Object.hasOwn(plan, …)` 断言的是**本处六行之前自己定义的字面量**
   *    ⇒ 与生产代码**无关**，恒真。
   *
   * ## 真正生效的编译闸门在哪
   *
   * `pnpm typecheck`（`tsc -p tsconfig.json`）覆盖全部 `src/**` ⇒
   * 「新 provider 漏写 `isFreeModel`」在那里变成 `TS2322`（**实测已验**：
   * 删掉任何一处接线 ⇒ `Property 'isFreeModel' is missing … but required
   * in type 'BuddyBalancePlan'`）。
   *
   * ⚠️ 本文件不在 `tsconfig.tests.json` 的 include 里（`pnpm typecheck:tests`
   *    只覆盖 8 个文件）⇒ **测试文件**里的漏写不会被编译拦住 —— 这里补一条
   *    **可执行**的源码级判据当第二道，而不是留一个跑不到的指令。
   */
  it('⚠️ 类型声明里 `isFreeModel` 必须是必填（不得带 `?`）', () => {
    const code = readSrc('credential-resolver.ts')
    // 正：声明存在且签名一致
    expect(code).toMatch(/readonly isFreeModel:\s*\(modelId\?: string\)/)
    // 反：**不得**退回可选 —— 那是三周静默失效的根因
    expect(code, '退回 `isFreeModel?:` 会让漏接重新变成静默失效')
      .not.toMatch(/readonly isFreeModel\?/)
  })
})

describe('② 契约层：消费侧不再为 undefined 兜底', () => {
  it('★ 源码里直接 await，不再出现 `=== undefined ? false` 的三元兜底', () => {
    const code = readSrc('credential-resolver.ts')
    // 变异：把 `const free = await plan.isFreeModel(modelId)` 改回
    // `plan.isFreeModel === undefined ? false : await plan.isFreeModel(modelId)` ⇒ 红。
    expect(code).toContain('const free = await plan.isFreeModel(modelId)')
    expect(code, '不得再为可选字段兜底').not.toContain('plan.isFreeModel === undefined')
  })

  it('★ 即便运行期被塞进 undefined，也不得**静默**当成「不免费」', async () => {
    // 这条不是「允许 undefined」，而是把「字段缺失时会发生什么」钉死成**可见的
    // 崩溃**（TypeError）而不是静默放过 —— 静默放过正是三周没被发现的原因。
    //
    // ⚠️⚠️ **替身必须实现真实池的每一条腿**（2026-10-21 合并审计发现，I1）：
    // 原替身只有 `{ listAccounts, readCredential }`，缺 `listAccountsByProvider`
    // ⇒ 一旦消费侧恢复 `=== undefined ? false` 兜底（= 缺陷态），「静默放过」之后
    // 必然在**下一步**抛 `pool.listAccountsByProvider is not a function`
    // ⇒ `rejects.toThrow(TypeError)` **照样通过**，红因与被测语义无关。
    // 实测：变异「恢复兜底」后该断言仍绿，错误 message 从
    // `plan.isFreeModel is not a function` 变成
    // `pool.listAccountsByProvider is not a function` —— 正是本仓记过的
    // 「替身缺一条真实实现里有的腿 ⇒ 对应变异全体无牙」。
    //
    // ⇒ 修法两条一起做：① 补齐替身腿；② 断言**错误内容**必须点名 isFreeModel。
    const pool = {
      listAccounts: async () => [],
      listAccountsByProvider: () => [],
      readCredential: async () => undefined,
      permanentLocked: () => false,
      getAvailableAccount: () => undefined,
    }
    const resolve = createCredentialResolver(
      { pool: pool as never },
      {
        product: { id: 'buddy', displayName: 'CodeBuddy' },
        readCredential: async () => undefined,
        balance: {
          kind: 'buddy',
          selector: { select: async () => ({ kind: 'none' }) } as never,
          lockedError: () => new Error('locked') as never,
          isFreeModel: undefined as never,
        },
        fallback: { kind: 'ref', refName: 'FALLBACK' },
      },
    )
    // ⚠️ 断言**内容**而不只是「抛了 TypeError」——后者会被替身自己的缺陷满足。
    await expect(resolve('m')).rejects.toThrow(/isFreeModel is not a function/)
  })
})

describe('③ 接线层：src/index.ts 每一处 balance 块都显式声明了 isFreeModel', () => {
  const code = readSrc('index.ts')
  const blocks = buddyPlanBlocks(code)

  it('buddy 协议的 balance 块恰好 13 处（新增渠道时本数字会变，届时一并补声明）', () => {
    // ⚠️ 2026-11-01 magicrew / magicrewintl 加入（用户要求「加永久/长期/临期和
    //    锁定永久积分」）：两站各一个 `kind: 'buddy'` 的 `balance` 块 ⇒ 11 → 13。
    expect(blocks.length).toBe(13)
  })

  it('★★ 每一处都有 isFreeModel（漏一处 = 该家免费模型被锁定误拦）', () => {
    // 变异：删掉任一处 `isFreeModel:` 行 ⇒ 红（并报出是哪一处）。
    // ⚠️ 必须 `stripComments`：否则「删掉代码、只在原位留一行注释提起该字段」
    //    会被判成「有」⇒ 假绿（与 `total` 那条的假红是同一个根源）。
    const missing = blocks
      .map((b, i) => ({ i, has: /\bisFreeModel\s*:/.test(stripComments(b.body)) }))
      .filter((x) => !x.has)
    expect(missing.map((x) => x.i), '以下 balance 块缺少 isFreeModel').toEqual([])
  })

  it('★ 不该有 13 处以外的散落写法（防止有人绕过 balance 块另起一份）', () => {
    const total = (stripComments(code).match(/\bisFreeModel\s*:/g) ?? []).length
    // 13 处 balance 块 + 1 处余量（`index.ts` 目前不 import 该类型）
    // ⇒ 允许 13~14。多出来说明有别的装配路径没被上面的块扫描覆盖。
    // ⚠️ 2026-11-01：magicrew 两站加入后 11 → 13，上限同步 12 → 14。
    // ⚠️ 计数前必须 `stripComments`（否则注释里提起该字段就假红，实测过一次）。
    expect(total).toBeLessThanOrEqual(14)
  })

  it('★ 没有把 NO_FREE_MODEL 用在有免费模型的那几家身上', () => {
    // 反向点名：这几家**必须**接真实适配器判据，写成 NO_FREE_MODEL 会让
    // 它们的免费模型重新被锁定误拦（即本次修的那个缺陷原地复发）。
    for (const adapter of ['buddyAdapter', 'workbuddyAdapter', 'traeAdapter', 'qoderAdapter', 'qoderCnAdapter']) {
      expect(code, `${adapter} 必须接真实 isFreeModel`).toContain(`(modelId) => ${adapter}.isFreeModel(modelId)`)
    }
    // 这 5 处真实判据不得被替换成常量。
    const realOnes = (code.match(/isFreeModel: \(modelId\) => \w+\.isFreeModel\(modelId\)/g) ?? []).length
    expect(realOnes).toBe(5)
  })
})

describe('④ 语义层：NO_FREE_MODEL 的行为', () => {
  it('返回 false（不是 truthy 的 undefined / 零），且不接受参数也不报错', () => {
    // 变异：改成 `() => true` ⇒ 红（会让所有渠道的模型都跳过锁定检查）。
    expect(NO_FREE_MODEL()).toBe(false)
    expect(NO_FREE_MODEL('any-model')).toBe(false)
    expect(NO_FREE_MODEL(undefined)).toBe(false)
    expect(typeof NO_FREE_MODEL).toBe('function')
  })

  it('★ `false` 的用途是「不短路」，验一遍：NO_FREE_MODEL 时付费路径照走', async () => {
    // 变异：把 `createCredentialResolver` 里的 `if (free)` 整段短路删掉 ⇒ 免费那
    // 条会红；改成恒真 ⇒ 本条红（分档不会被调用）。
    let selected = 0
    const resolve = createCredentialResolver(
      {
        pool: {
          // ⚠️ `ResolverPool` 的读账号方法是 `listAccountsByProvider`（不是
          // `listAccounts` —— 那是 `AccountPool` 自己的方法，不是本接口的）。
          listAccountsByProvider: () => [{ id: 'a1', credentialRef: 'R1', enabled: true }],
          permanentLocked: () => false,
          getAvailableAccount: async () => ({ entry: { id: 'a1', credentialRef: 'R1' }, credential: { c: 1 } }),
        },
      } as never,
      {
        product: { id: 'buddy', displayName: 'CodeBuddy' },
        readCredential: async (ref: unknown) => (ref === 'R1' ? { c: 1 } : undefined),
        balance: {
          kind: 'buddy',
          // ⚠️ selector 的真实形状来自 `pickBuddyAccount`：`{ ok, account, balance }`
          // 或 `{ ok: false, reason }`，**不是** `{ kind: 'picked' }`。
          selector: {
            select: async (candidates: readonly { id: string; credentialRef: string }[]) => {
              selected += 1
              const target = candidates[0]
              return target === undefined
                ? { ok: false as const, reason: { kind: 'exhausted' } }
                : { ok: true as const, account: target, balance: { id: target.id, ok: true } }
            },
          } as never,
          lockedError: () => new Error('locked') as never,
          isFreeModel: NO_FREE_MODEL,
        },
        fallback: { kind: 'ref', refName: 'FALLBACK' },
      },
    )
    const credential = await resolve('m')
    expect(credential, 'NO_FREE_MODEL 时按常规分档取凭据').toEqual({ c: 1 })
    expect(selected, '恰好调一次选择器（走了余额分档）').toBe(1)
  })
})
