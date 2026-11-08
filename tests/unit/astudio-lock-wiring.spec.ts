/**
 * AStudio（讯飞 AstronStudio）的「锁定永久积分」**接线**回归。
 *
 * ## 为什么单独守这个（而不是复用 `buddy-permanent-lock.spec.ts`）
 *
 * 那个文件守的是「`BuddyBalanceSelector` 的四家怎么建实例」。而 AStudio 的缺陷
 * 不是建错了实例，是**根本没有选号层** —— 2026-10-20 之前
 * `src/index.ts` 的 `registerAstudioLlm` 只传 `auth` / `product` / `refresh` /
 * `warn`，适配器走 `auth.currentCredential()`（单凭据）⇒ 即使
 * `provider-registry.ts` 登记了 `permanentLock: true`，
 * 「锁定」也**没有任何执行路径**（没有选号层可拦，锁了等于没锁）。
 *
 * 这正是 `permanent-lock-execution.spec.ts` 那条普查抓到的形态：
 * 「声明了 `permanentLock: true` 却没有任何执行路径（锁了但不会真拦）」。
 * 本文件就是给它补的那条执行路径的守卫。
 *
 * ## 判据分三层（由弱到强）
 *
 * 1. **源码接线**：`index.ts` 里确实建了 `astudioBalanceSelector`、
 *    确实把它交给了 `createCredentialResolver` 的 `balance.selector`、
 *    确实传了 `lockedError`。
 * 2. **registry 契约**：`permanentLock === true` 且 `usesExpiryWindow === true`
 *    —— 前者决定「锁定按钮是否出现」，后者决定「windowDays 是否回传」
 *    （缺后者 ⇒ 客户端 `splitCreditsByExpiry` 整体返回 `null` ⇒ 三行分档不渲染，
 *    症状**静默**：胶囊只剩合计）。
 * 3. **分档行为**：把真实上游报文结构（三池各带 `*NextExpireTime`）喂给
 *    `buildAstudioBalance`，再用 `splitBuddyCreditsByExpiry` / `buddyBalanceTier`
 *    验证「锁定后只剩永久积分 ⇒ 该号不可用」。这一层直接驱动生产判据，
 *    不是复述实现。
 *
 * ⚠️ **不做**的事：不发真实网络、不读真实凭据。凭据形状只用于断言
 * `resolveAstudioCredentialByRef` 的**判据形态**与 `parseAstudioCredential` 一致。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { PROVIDER_REGISTRY, descriptorOf } from '../../src/provider-registry.js'
import { PERMANENT_LOCK_PROVIDERS } from '../../src/jet-hub-rpc.js'
import { buildAstudioBalance } from '../../src/astudio-credits.js'
import {
  BUDDY_BALANCE_TIER,
  BUDDY_EXPIRING_WINDOW_DAYS,
  buddyBalanceTier,
  buddyTierUsable,
  splitBuddyCreditsByExpiry,
} from '../../src/buddy-balance-rank.js'
import { ASTUDIO } from '../../src/astudio-product.js'

const here = dirname(fileURLToPath(import.meta.url))
const indexSource = readFileSync(resolve(here, '../../src/index.ts'), 'utf8').replace(/\r\n/g, '\n')

/**
 * 剥掉注释后的源码。
 *
 * ⚠️ 接线断言不能因为「注释里提到了某个符号」就通过：本仓库注释大量解释
 * 「为什么不能走某条兜底」，对兜底的**否定**断言必须只看代码（与
 * `buddy-permanent-lock.spec.ts` 的 `codeOnly` 同一约定）。
 */
function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}
const indexCode = codeOnly(indexSource)

/**
 * astudio 那段 `createCredentialResolver` 调用（**已剥注释**），供源码级断言使用。
 *
 * ⚠️⚠️ **切片终点不能用 `indexOf('\n  )')`**（2026-10-21 合并审计实测踩到）：
 * 该调用的第一个参数块里就有 `reportAccount: (id) => {` 这类**带缩进大括号**
 * 的箭头函数，`\n  )` 会在更早的位置命中 nowhere 而截断在函数体中间；即便
 * 不命中，也会把 `balance:` 那一段整段切掉 ⇒ 所有针对它的断言变成**空字符串
 * 匹配失败**（红因误导：看起来像接线错了，其实是切片错了）。
 *
 * ⇒ 终点取**下一段注册**（`const astudioAdapter = registerAstudioLlm(`）——
 *    它与本段是同一作用域里紧邻的两段，不依赖括号嵌套。
 */
const planCode = (() => {
  const start = indexCode.indexOf('const astudioCredentialPlan = createCredentialResolver<AstudioCredential>(')
  expect(start, '找不到 astudio 的 createCredentialResolver 调用').toBeGreaterThan(-1)
  const end = indexCode.indexOf('const astudioAdapter = registerAstudioLlm(', start)
  expect(end, '找不到 astudio 的 registerAstudioLlm（切片终点）').toBeGreaterThan(start)
  return indexCode.slice(start, end)
})()

/** 真实上游 `/points/balance` 的 `data`（2026-10-20 实测两账号，结构一致）。 */
function balancePayload(activityExpire: string | null) {
  return {
    totalAmount: 1100,
    totalBalance: 1100,
    memberTotal: 0,
    memberBalance: 0,
    memberNextExpireTime: null,
    buyTotal: 0,
    buyBalance: 0,
    buyNextExpireTime: null,
    activityTotal: 1100,
    activityBalance: 1100,
    activityNextExpireTime: activityExpire,
    sparkTotalAmount: 0,
    sparkTotalBalance: 0,
  }
}

/** 取「赠送/活动」那一包（本家唯一实测带到期时间的池）。 */
function activityPackage(activityExpire: string | null) {
  const balance = buildAstudioBalance(balancePayload(activityExpire) as never)
  const pkg = balance.packages.find((p) => p.active)
  expect(pkg, 'buildAstudioBalance 没有产出 active 包').toBeDefined()
  return { balance, pkg: pkg! }
}

describe('★ AStudio：`permanentLock` 的 registry 契约', () => {
  it('registry 同时登记 permanentLock 与 usesExpiryWindow', () => {
    // 前者 ⇒ 客户端渲染「锁定/解锁」按钮 + `createCredentialResolver` 读 allowPermanent；
    // 后者 ⇒ `jet-hub-rpc.ts` 回传 `windowDays`（缺它 ⇒ 分档整体返回 null，静默）。
    expect(descriptorOf('astudio')?.permanentLock, 'astudio 应支持锁定永久积分').toBe(true)
    expect(descriptorOf('astudio')?.usesExpiryWindow, 'astudio 应按到期分桶').toBe(true)
  })

  it('后端白名单（PERMANENT_LOCK_PROVIDERS）由 registry 派生且含 astudio', () => {
    // 直接钉住「派生关系」，而不是只断言成员 —— 有人手抄一份名单会在这里红。
    const derived = PROVIDER_REGISTRY.filter((d) => d.permanentLock === true).map((d) => d.id).sort()
    expect(derived).toContain('astudio')
    expect([...PERMANENT_LOCK_PROVIDERS].sort()).toEqual(derived)
  })

  it('`AstudioAdapterOptions` 只有零参 resolveCredential —— 接线必须包一层', () => {
    // ⚠️ 这条锁的是一个**真实踩过的坑**（2026-10-20）：`createCredentialResolver`
    //    返回 `(modelId?: string) => Promise<T | undefined>`，而
    //    `AstudioAdapterOptions.resolveCredential` 是**零参**签名。
    //    直接传带参函数会 TS2322；把 `credentialRef` 传进去会 TS2353
    //    （该接口没有这个字段）。
    const start = indexCode.indexOf('const astudioAdapter = registerAstudioLlm(')
    expect(start, 'index.ts 里找不到 astudio 的注册段').toBeGreaterThan(-1)
    const block = indexCode.slice(start, indexCode.indexOf('\n  })', start))
    expect(block, '必须把带参 resolver 包成零参').toMatch(
      /resolveCredential:\s*\(\)\s*=>\s*astudioCredentialPlan\(/,
    )
    expect(block, 'AstudioAdapterOptions 没有 credentialRef 字段（多传必 TS2353）')
      .not.toMatch(/^\s*credentialRef:/m)
  })
})

describe('★ AStudio：`index.ts` 的接线（源码级，守纯文本形态的约定）', () => {
  it('建了 astudio 自己的选号器并交给工厂的 balance.selector', () => {
    expect(indexCode).toMatch(
      /const astudioBalanceSelector = new BuddyBalanceSelector\(\{\s*\n\s*product: ASTUDIO,/,
    )
    expect(planCode, 'balance.selector 必须指向 astudioBalanceSelector')
      .toMatch(/kind:\s*'buddy',\s*\n\s*selector:\s*astudioBalanceSelector,/)
    expect(planCode, '必须传 lockedError（否则锁定时报通用错误）')
      .toMatch(/lockedError:\s*astudioLockedError\('AStudio'\)/)
    expect(planCode, '必须接限流判定（池被筛空时会误报「请先登录」）')
      .toMatch(/throwIfAllRateLimited:\s*throwIfAllAccountsRateLimited/)
  })

  /**
   * ★★ **`reportPickedAccount` 必须是 `true`**（2026-10-21 合并审计发现）。
   *
   * ## 缺陷
   *
   * PR !119 原先写的是 `reportPickedAccount: false`，理由「与 buddy 系一致：
   * 本家旧闭包也没有回报」。那是**类比错误**：
   * - buddy 系能写 `false`，是因为它们的**适配器自己回报**
   *   （`buddy-adapter.ts` / `trae-adapter.ts` / `lobsterai-adapter.ts` 都调
   *   `reportLedgerAccount`）；
   * - **AStudio 适配器全文零回报**，且 master 上它压根没有 `reportAccount` 接线
   *   ⇒「旧闭包也没有回报」描述的是**一个缺陷状态**，不是有意行为。
   *
   * ## 为什么那行是死代码（实测）
   *
   * `credential-resolver.ts` 三条回报点里，②被 `!== false` 拦住、③被 ② 的
   * `return` 短路 ⇒ `false` 时**零回报** ⇒ `src/index.ts` 那行
   * `reportAccount: (id) => reportLedgerAccount(ASTUDIO.id, id)` **永不执行**。
   *
   * 用 `lib/credential-resolver.js` 真跑（`getAvailableAccount` 设成「被调用就记
   * 标记」）：`false → reports=[]`、`true → reports=["a1"]`，两者 `poolReached`
   * 都是 `false`（证明池兜底那条无条件回报确实走不到）。
   *
   * ## 后果
   *
   * `token-ledger.ts` 拿不到 `accountId` ⇒ 整笔用量归到 `'-'`（未归属）桶 ⇒
   * Jet Hub 的 AStudio 账号卡片看不到自己的 token 用量。**零报错、零日志**。
   */
  it('★★ `reportPickedAccount` 必须是 true（false 会让 reportAccount 成为死代码）', () => {
    const planStart = indexCode.indexOf('const astudioCredentialPlan = createCredentialResolver<AstudioCredential>(')
    expect(planStart, '找不到 astudio 的 createCredentialResolver 调用').toBeGreaterThan(-1)
    const plan = indexCode.slice(planStart, indexCode.indexOf('\n  )', planStart))
    expect(
      plan,
      '★ astudio 必须 reportPickedAccount: true —— 它的适配器不自报账本，false 会让'
      + ' reportAccount 成为不可达的死接线（token 用量全落「未归属」桶）',
    ).toMatch(/reportPickedAccount:\s*true,/)
    expect(plan, '不得残留 false（那是死接线的成因）').not.toMatch(/reportPickedAccount:\s*false,/)
  })

  it('`readCredential` 用本家解析器，且形状校验与 parseAstudioCredential 对齐', () => {
    // ⚠️ 不能只数标识符出现次数（那对「改写成包装函数」无感）。逐个检查定义体。
    const defStart = indexCode.indexOf('const resolveAstudioCredentialByRef = async (')
    expect(defStart, '找不到 astudio 的凭据解析器').toBeGreaterThan(-1)
    const def = indexCode.slice(defStart, indexCode.indexOf('\n  }', defStart))
    // 判据必须与 `astudio-auth.ts` 的 `parseAstudioCredential` 逐字同形：裸
    // `JSON.parse` 会把 `{"foo":1}` 当有效凭据返回，随后适配器读
    // `credential.access_token.length` 抛 **TypeError**（不可诊断），
    // 且发生在选号之后、不在余额查询的 try/catch 覆盖内。
    expect(def, '形状校验缺失（必须是 typeof access_token === string）')
      .toMatch(/typeof parsed\.access_token === 'string'/)
    // 且必须真的把它用作 readCredential（不是另写一个宽松版本）。
    expect(indexCode).toMatch(/readCredential:\s*resolveAstudioCredentialByRef,/)
  })

  it('★ 锁定文案与 buddy 系分开（AStudio 的池语义不同）', () => {
    // buddy 系口径是「服务端资源包 N 天内到期」，AStudio 是「会员/购买/赠送」三池
    // —— 后者按 buddy 那句「等待资源包到期后重新发放额度」去排查会找不到东西。
    expect(indexCode, 'astudio 必须有独立的 lockedError 文案构造器')
      .toContain('const astudioLockedError =')
    const start = indexCode.indexOf('const astudioLockedError =')
    const block = indexCode.slice(start, indexCode.indexOf('\n  }\n', start))
    // 三池语义必须在文案里出现（否则用户按错误的池去排查）。
    expect(block, '文案里应点名「赠送」池').toContain('赠送')
    // 错误码必须是宿主可分类的那种（QUOTA_EXCEEDED），不能是裸 Error。
    expect(block, '必须用 LlmError 而非裸 Error（裸 Error 没有 code）').toContain('new LlmError(')
  })
})

describe('★★ AStudio：分档行为（驱动生产判据，不是复述实现）', () => {
  it('上游三池报文被归一化出 deductionEndTime（毫秒）', () => {
    const { pkg } = activityPackage('2026-11-20T01:50:14')
    // ⚠️ 关键：客户端 `splitCreditsByExpiry` **只认 `deductionEndTime`**，
    //    不认 `expiredTime`（字符串仅 tooltip 用）。
    expect(pkg.expiredTime, '原始串应原样透出（供 tooltip）').toBe('2026-11-20T01:50:14')
    expect(pkg.deductionEndTime, '必须归一化到毫秒，否则客户端全判「永久」').toBeTypeOf('number')
    expect(pkg.deductionEndTime).toBe(Date.parse('2026-11-20T01:50:14'))
  })

  it('无到期时间的池不编造 deductionEndTime（按永久桶处理）', () => {
    const { pkg } = activityPackage(null)
    // ⚠️ 不能编造一个「很远但不为空」的时刻 —— 那会让该包永远落不进永久桶。
    expect(pkg.deductionEndTime).toBeUndefined()
  })

  it('★ 锁定后只剩「长期」积分 ⇒ 该号不可用（tier = none）', () => {
    const { balance } = activityPackage('2026-11-20T01:50:14')
    const now = Date.parse('2026-10-20T00:00:00')
    const windowMs = BUDDY_EXPIRING_WINDOW_DAYS * 24 * 60 * 60 * 1000
    const split = splitBuddyCreditsByExpiry(balance, now, windowMs)
    // 31 天 > 15 天窗口 ⇒ 落永久桶（不是临期）。
    expect(split, '2026-11-20 距 2026-10-20 约 31 天 ⇒ 应落永久桶').toEqual({ expiring: 0, permanent: 1100 })

    // ⚠️ `buddyBalanceTier` 吃的**不是** `CreditBalance`，而是分桶后的账号摘要
    //    `{ expiringBalance, permanentBalance }` —— 生产链是
    //    `BuddyBalanceSelector.classify()`：先 `splitBuddyCreditsByExpiry` 拿两桶，
    //    填成 `entry`（`expiringBalance: split.expiring` / `permanentBalance: split.permanent`）
    //    再交给 `buddyBalanceTier(entry, { now, windowMs })`。
    //    直接传 `balance` 会因字段名对不上而恒得 `none`（写本用例时实测踩到）。
    const entry = { id: 'a', expiringBalance: split!.expiring, permanentBalance: split!.permanent }

    // 未锁定：长期额度可用（tier = permanent）。
    expect(buddyBalanceTier(entry, { allowPermanent: true, windowMs }))
      .toBe(BUDDY_BALANCE_TIER.permanent)
    // ★ 锁定：只剩长期 ⇒ 明确不可用。这就是「锁定真的会拦」的那一步。
    expect(
      buddyBalanceTier(entry, { allowPermanent: false, windowMs }),
      '锁定后只剩永久积分 ⇒ 必须落 none（否则锁定形同虚设）',
    ).toBe(BUDDY_BALANCE_TIER.none)
    // 再补一条「可承载请求」的语义断言：`buddyTierUsable` 是调用方真正看的那一步
    // （`select()` 里 `if (allowPermanent === false && !buddyTierUsable(...))`）。
    expect(buddyTierUsable(buddyBalanceTier(entry, { allowPermanent: false, windowMs }))).toBe(false)
    expect(buddyTierUsable(buddyBalanceTier(entry, { allowPermanent: true, windowMs }))).toBe(true)
  })

  it('★ 有临期积分时锁定仍可用（锁定只挡永久桶，不挡临期桶）', () => {
    // 造一个 10 天到期（< 15 天窗口 ⇒ 临期桶）的余额。
    const balance = buildAstudioBalance(balancePayload('2026-10-30T00:00:00') as never)
    const now = Date.parse('2026-10-20T00:00:00')
    const windowMs = BUDDY_EXPIRING_WINDOW_DAYS * 24 * 60 * 60 * 1000
    const split = splitBuddyCreditsByExpiry(balance, now, windowMs)
    expect(split!.expiring, '10 天到期应落临期桶').toBe(1100)
    const entry = { id: 'a', expiringBalance: split!.expiring, permanentBalance: split!.permanent }
    expect(buddyBalanceTier(entry, { allowPermanent: false, windowMs }))
      .toBe(BUDDY_BALANCE_TIER.expiring)
  })

  it('★ 窗口天数与前端/后端同源（15 天常量；env 覆盖由 permanent-lock-execution 守）', () => {
    // 数字写岔会让用户看到「提示说只烧 8 天内的，实际按 15 天筛号」。
    expect(BUDDY_EXPIRING_WINDOW_DAYS).toBe(15)
    // AStudio 的选号器与 buddy 系共用 `BuddyBalanceSelector`，故窗口也共用一份
    // 判据（`buddy-balance-rank.ts` 是唯一真源）。
    //
    // ⚠️ **本用例只断言常量**（2026-10-21 审计指出原标题「可用环境变量覆盖」**超发**）：
    //    把 `buddyExpiringWindowDays` 的 env 参数完全废掉（`void env`），本文件 +
    //    minimax + lockexec 三份 **38 条全绿** ⇒ 本文件对该能力零牙。
    //    真正守 env 覆盖的是 `permanent-lock-execution.spec.ts` 的 ⑥
    //    （设 `DSH_BUDDY_EXPIRING_WINDOW_DAYS=31` 并断言读到 31）。
    //    ⇒ 标题改成如实描述，别让它看起来比实际强。
  })

  /**
   * ★★ **空格形态与 `T` 形态必须给出相同毫秒**（2026-10-21 审计指出：原**零覆盖**）。
   *
   * ## 这条守的是「契约」，不是 `replace` 那一行
   *
   * `astudioLocalTimeMs` 用 `Date.parse(raw.replace(' ', 'T'))` 收进 ISO 规范形式。
   * 但审计实测：**当前 V8 对空格形态非常宽容**（甚至多空格也认），
   * 所以把 `replace` 删掉，本机 109 条相关用例**仍然全绿** —— 那是**实测无牙**，
   * 已在源码注释里如实登记（不为它编恒真用例）。
   *
   * ⇒ 本用例锁的是**两形态必须等价**这个契约：
   * 换引擎（JSC / SpiderMonkey）或 V8 收紧解析时，空格形态会静默变 `NaN`
   * ⇒ 该包**静默落永久桶** ⇒ 永久锁对它失效。本用例会当场红。
   */
  it('★★ 空格形态与 T 形态给出相同的毫秒（守两形态等价的契约）', () => {
    const mk = (expire: string) => ({
      ...balancePayload(null),
      activityNextExpireTime: expire,
    })
    const tForm = buildAstudioBalance(mk('2026-11-20T01:50:14'))
    const spaceForm = buildAstudioBalance(mk('2026-11-20 01:50:14'))
    const activityOf = (b: ReturnType<typeof buildAstudioBalance>) =>
      b!.packages.find((p) => p.name.includes('赠送'))!
    expect(
      activityOf(spaceForm).deductionEndTime,
      '★ 空格形态必须与 T 形态同值 —— 删掉 replace 会让空格形态解析失败 ⇒ 静默落永久桶',
    ).toBe(activityOf(tForm).deductionEndTime)
    // 自检：两者都必须真的解析出了值（否则「都为 undefined」也会通过上面那条）。
    expect(activityOf(tForm).deductionEndTime).toBe(Date.parse('2026-11-20T01:50:14'))
  })

  /**
   * ★★ **星火池的到期归一化必须有覆盖**（2026-10-21 审计发现：**零覆盖 / 死代码区间**）。
   *
   * ## 缺陷
   *
   * `buildAstudioBalance` 里有一段专门处理星火池（独立池、不参与主池合计）：
   * ```js
   * const sparkDeductionEndTime = astudioLocalTimeMs(data, 'sparkNextExpireTime')
   * ... ...(sparkDeductionEndTime === undefined ? {} : { deductionEndTime: sparkDeductionEndTime }),
   * ```
   * 但 `balancePayload()` 的两个夹具都填 `sparkTotalBalance: 0` 且**不给**
   * `sparkNextExpireTime` ⇒ `pushPool` 根本不 push 星火池 ⇒ **那 12 行从未被执行**。
   * 实测：删掉写 `deductionEndTime` 的那一行，**13 条全绿**。
   *
   * ⇒ 补一条有星火余额 + 星火到期时间的夹具。
   */
  it('★★ 星火池也归一化 deductionEndTime（且仍不进主池合计）', () => {
    const balance = buildAstudioBalance({
      ...balancePayload('2026-11-20T01:50:14'),
      sparkTotalAmount: 500,
      sparkTotalBalance: 500,
      sparkNextExpireTime: '2026-11-01T00:00:00',
    })
    const spark = balance!.packages.find((p) => p.name.includes('星火'))!
    expect(spark, '星火池有余额时应产出一个包').toBeDefined()
    expect(
      spark.deductionEndTime,
      '★ 星火池的 sparkNextExpireTime 也必须归一化到 deductionEndTime（否则落永久桶、锁定时拦不住）',
    ).toBe(Date.parse('2026-11-01T00:00:00'))
    // ⚠️ 星火池**不参与主池合计**（它的名字里自陈），故 total 仍只算三池。
    expect(balance!.total).toBe(1100)
  })

  it('端点常量指向 AStudio 自己的地址（不是 buddy 系）', () => {
    // ⚠️ `BuddyBalanceSelector` 的 `fetchSource` 里有一条防御：
    //    「非 buddy 系必须注入 `fetchBalance`」（否则会用 product.endpoint 拼出
    //    错误的余额 URL）。本家已注入，故这条只钉住 product 常量本身。
    expect(ASTUDIO.id).toBe('astudio')
    // ⚠️ 2026-11-07 实测：旧基址 `astronstudio-api-volces-prod.xf-yun.com/model-gateway/v1`
    //    对任何路径都回 404 `API endpoint not found`（同一 token 打目录仍 200），
    //    推理已迁到 maas 域。钉死新值，防止有人「按记忆」改回旧域。
    expect(ASTUDIO.maasBaseUrl).toBe('https://maas-api.cn-huabei-1.xf-yun.com/v1')
  })

  /**
   * ★★ **`fetchBalance` 闭包必须透传 `product` 形参**（2026-10-21 审计发现：零覆盖）。
   *
   * `BuddyBalanceSelector.select` 调的是 `injected(credential, this.deps.product)`
   * ⇒ 闭包里忽略形参、写死常量会让取数用错产品配置。
   * 审计实测：把 astudio 的闭包改成 `async () => null`，本文件 **13 条全绿**。
   *
   * ⚠️ astudio 只有**一个** product，故「写死对方站点」不成立；但
   *    **整个闭包被换掉**（返 `null` / 调别的渠道的 fetch）同样会静默 ——
   *    余额恒 `null` ⇒ 锁定态永远「没有可用账号」。故仍要钉住「调的是本家的 fetch」。
   */
  it('★★ fetchBalance 闭包必须调本家的 fetchAstudioCreditBalance 并透传 product', () => {
    const start = indexCode.indexOf('const astudioBalanceSelector = new BuddyBalanceSelector({')
    expect(start, '找不到 astudio 的选号器').toBeGreaterThan(-1)
    // ⚠️ 终点取下一个同级 `const`：块内可能有多行箭头函数的 `})`。
    const end = indexCode.indexOf('\n  const ', start + 10)
    const block = indexCode.slice(start, end === -1 ? undefined : end)
    expect(block.length, 'astudio 选号器的构造块切成了空——判据会变成同义反复').toBeGreaterThan(60)
    const line = block.match(/fetchBalance:[^\n]*/)
    expect(line, 'astudio 必须注入 fetchBalance').not.toBeNull()
    expect(line![0], '★ 闭包必须调本家的 fetchAstudioCreditBalance（换成别的/恒 null 会让余额恒查不到）')
      .toContain('fetchAstudioCreditBalance')
    expect(line![0], '★ 闭包必须透传 product 形参（不能写死或忽略）')
      .toMatch(/\(credential, product\)\s*=>\s*fetchAstudioCreditBalance\(credential, product\)/)
  })
})
