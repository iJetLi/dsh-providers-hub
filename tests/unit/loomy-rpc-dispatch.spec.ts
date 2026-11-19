import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { descriptorOf } from '../../src/provider-registry.js'
import { PERMANENT_LOCK_PROVIDERS } from '../../src/jet-hub-rpc.js'

const here = dirname(fileURLToPath(import.meta.url))
const rpcSource = readFileSync(resolve(here, '../../src/jet-hub-rpc.ts'), 'utf8')
const typesSource = readFileSync(resolve(here, '../../src/types.ts'), 'utf8')

/**
 * 源码级回归：RPC 分派必须包含 Loomy 的各个分支。
 *
 * 用源码断言而非实例化 `registerJetHubRpc`（它需要完整 ctx 与 connection 服务），
 * 与既有的 `lobsterai-rpc-dispatch.spec.ts` 同法。
 */
describe('Loomy RPC 分派', () => {
  it('types.ts 的 account.create 契约扩展了 phone 与 loginMode', () => {
    expect(typesSource).toMatch(/interface RpcCreateAccountRequest \{[\s\S]*?phone\?: string/)
    expect(typesSource).toMatch(/interface RpcCreateAccountResponse \{[\s\S]*?loginMode\?: 'url' \| 'sms'/)
  })

  it('types.ts 定义了短信登录与新手任务的 RPC 类型', () => {
    for (const name of [
      'RpcSendSmsRequest', 'RpcSendSmsResponse', 'RpcSubmitSmsRequest', 'RpcSubmitSmsResponse',
      'RpcOnboardingStatusRequest', 'RpcOnboardingStatusResponse',
      'RpcOnboardingClaimRequest', 'RpcOnboardingClaimResponse',
    ]) {
      expect(typesSource, `缺少 ${name}`).toContain(`interface ${name}`)
    }
  })

  it('account.create 有 loomy 分支并返回微信弹窗页 loginUrl', () => {
    expect(rpcSource).toContain('provider === LOOMY.id')
    expect(rpcSource).toContain('loomy.startWechatLogin()')
    expect(rpcSource).toMatch(/loginUrl: started\.loginUrl/)
  })

  /**
   * ⚠️ **真实缺陷回归**（用户报障「新建账号失败：Loomy 短信登录需要手机号」）：
   *
   * 早期 `account.create` 要求必须带 `phone`，但验证码表单要等它返回
   * `loginMode:'sms'` 才渲染 —— 用户根本没机会输入手机号，直接报错，
   * **表单永远出不来**。这是**顺序死锁**。
   *
   * 改用微信扫码后，`account.create` **不得**再要求 `phone`。
   */
  it('account.create 不再要求 phone（顺序死锁回归）', () => {
    const start = rpcSource.indexOf('provider === LOOMY.id')
    expect(start).toBeGreaterThan(-1)
    const end = rpcSource.indexOf('} else {', start)
    const body = rpcSource.slice(start, end > start ? end : start + 3000)
    // ⚠️ 只检查**代码**，剥掉注释 —— 注释里引用了那句历史报错文案做说明，
    // 不剥会把「解释缺陷」误判成「缺陷仍在」。
    const code = body
      .split('\n')
      .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
      .join('\n')
    expect(code).not.toContain('Loomy 短信登录需要手机号')
    expect(code).not.toContain('req.phone')
    // 不再返回 loginMode:'sms'（那是表单式登录的标记，已改微信弹窗）
    expect(code).not.toContain("loginMode: 'sms'")
  })

  /**
   * ⚠️ 2026-10-08 改（Task 2）：原先这条断言
   * `/case LOOMY\.id:[\s\S]{0,200}refreshAccountCredential/` —— 一个**源码文本**
   * 断言，扫的是 13 个同构 `case` 里的 loomy 那一个。Task 2 把它们换成一处查表
   * ⇒ `case LOOMY.id:` 这个形态**不存在了**，而它守的意图（loomy 的续期接上了）
   * **与文本无关**。
   *
   * ⇒ 改为断言 `account.refresh` **真的走查表分派**（结构），并把
   *    「loomy 的续期落到 loomy 实例上」交给**行为**用例：
   *    `lobsterai-rpc-dispatch.spec.ts` 的「13 个 provider 逐个覆盖」组
   *    （从 `REFRESH_PROVIDERS` 派生，含 loomy）。
   */
  it('account.refresh 走查表分派（loomy 不再需要自己的 case）', () => {
    const refreshStart = rpcSource.indexOf("case 'account.refresh':")
    expect(refreshStart, '找不到 account.refresh 分支').toBeGreaterThan(-1)
    const refreshBlock = rpcSource.slice(refreshStart, refreshStart + 4000)
    expect(refreshBlock).toMatch(/authOf\(auths, entry\.provider\)/)
    // 反向：不得再有 provider 专属的硬编码分支（那正是本次收敛掉的东西）。
    expect(refreshBlock).not.toMatch(/case LOOMY\.id:/)
  })

  it('credits.status / claimAll / balances 各有 loomy 分支', () => {
    // 三个端点各出现一次 ⇒ >= 3。
    // ⚠️ 2026-10-08 改（Task 2 复审 Finding 4）：原文写「加上 account.create /
    //    refresh 的分支，总计 >= 5 次」—— `refresh` 那半**已不成立**：
    //    `account.refresh` 的 13 个同构 `case`（含 `case LOOMY.id:`）已被 Task 2
    //    收敛成一处查表分派（`authOf(auths, entry.provider)`），该分支里
    //    **不再出现 `LOOMY.id`**。
    //    实测（2026-10-08，**复审时逐处重新测量**，不采信旧数）：本文件
    //    （= `src/jet-hub-rpc.ts` 的**源码文本**，不是本 spec 文件）共 **7** 处
    //    `LOOMY.id`，逐处为：
    //      ①~③ account.create 的 loomy
    //      微信登录分支（`else if` 判据 / `provider:` 字段 / 失败告警）；
    //      ④ login.sendSms；⑤ login.submitSms；
    //      ⑥ loomy.permanentLock 老别名；⑦ **注释里的一处**（`onboarding.status`
    //      那段记录「被删掉的手抄判据」的文字，不是代码）。
    //    ⚠️ 其中**没有** `onboarding.*` 的代码分支 —— 它已被 Task 4 收敛成查表
    //    （见 `src/provider-onboarding.ts`），第 ⑦ 处只是提到它。
    //    ⚠️ 也**不再有**「`PERMANENT_LOCK_PROVIDERS` 集合」那一处（2026-10-08，
    //    Task 5）：该集合已改为从 `PROVIDER_REGISTRY` 派生 ⇒ 字面量搬走了
    //    （故计数由 8 降为 7，**不是**有分支被删）。
    //    `>= 5` 这个阈值仍被满足，但**理由已换成这些真协议分支**，
    //    与 account.refresh 无关 —— 写成「含 refresh」会让下一个读者以为那个
    //    case 还在。
    const occurrences = rpcSource.split('LOOMY.id').length - 1
    expect(occurrences).toBeGreaterThanOrEqual(5)
  })

  it('新增了 login.sendSms / login.submitSms / onboarding.status / onboarding.claim 端点', () => {
    for (const method of ["'login.sendSms'", "'login.submitSms'", "'onboarding.status'", "'onboarding.claim'"]) {
      expect(rpcSource, `缺少端点 ${method}`).toContain(`case ${method}`)
    }
  })

  /**
   * ⚠️ **永久积分锁定**端点（用户需求：Loomy 先做，CodeBuddy / WorkBuddy 后加）。
   *
   * 三个 provider 共用一个通用端点 `credits.permanentLock`（provider 维度），
   * `loomy.permanentLock` 保留为**同一实现的历史别名** —— 老客户端 bundle 仍在
   * 调它，直接删会让 Loomy 面板的按钮静默失效。
   */
  it('通用端点与 Loomy 历史别名共用同一实现（读 / 写两用）', () => {
    expect(rpcSource).toContain("case 'credits.permanentLock'")
    expect(rpcSource).toContain("case 'loomy.permanentLock'")
    // 走 provider 维度的表，而不是老的单字段方法
    expect(rpcSource).toMatch(/pool\.permanentLocked\(/)
    expect(rpcSource).toMatch(/pool\.setPermanentLocked\(/)
    // locked 省略 = 只读
    expect(rpcSource).toMatch(/req\.locked === undefined/)
    // ⚠️ 老别名必须忽略载荷里的 provider（否则老前端能借它越权改别的 provider）
    expect(rpcSource).toMatch(/method === 'loomy\.permanentLock'/)
  })

  /**
   * ⚠️ 两个 buddy 的响应必须**回传当前生效的窗口天数**。
   *
   * 窗口可被 `DSH_BUDDY_EXPIRING_WINDOW_DAYS` 覆盖，前端文案若继续用写死的
   * 15 就会出现「提示说只烧 15 天内的、实际按 31 天筛号」。Loomy 没有窗口
   * 概念，故只有 buddy 系带这个字段。
   */
  it('buddy 系的响应回传窗口天数（前端文案据此渲染）', () => {
    // ⚠️ 2026-10-08 改：原先第一条断言扫源码文本找
    //    `provider === CODEBUDDY.id || provider === WORKBUDDY.id`。本次重构把该四连
    //    `||` 收敛成读 registry 的 `usesExpiryWindow` ⇒ 文本断言变红而行为没变。
    //    留下的两条守的是**取值来源**（必须取自共享助手，不能写死 15）与**类型契约**；
    //    「哪些渠道真的回传 windowDays」由**真跑端点**的行为用例守：
    //    `provider-registry-consumers.spec.ts` 的
    //    「credits.permanentLock 的响应体取决于 registry」。
    // ★ 2026-11-19：改为 per-provider 现读（resolveCreditWindow().windowDays）
    expect(rpcSource).toMatch(/resolveCreditWindow\(/)
    expect(rpcSource).toContain("from './buddy-balance-rank.js'")
    expect(typesSource).toMatch(/interface RpcPermanentLockResponse \{[\s\S]*?windowDays\?: number/)
  })

  /**
   * ⚠️ **TRAE / LobsterAI 也必须回传窗口天数**（2026-10-06 PR !68 审计补齐）。
   *
   * 判据已从「是不是 buddy」改成「**是否按到期时间分桶**」，而这两家走的是同一个
   * `splitBuddyCreditsByExpiry`、同样受 `DSH_BUDDY_EXPIRING_WINDOW_DAYS` 影响。
   *
   * ⚠️ 上面那条用例的正则只覆盖 buddy 那一半：把 `|| provider === TRAE.id
   * || provider === LOBSTERAI.id` 整段删掉，全量单测**照样全绿** —— 而后果是
   * 用户把窗口改成 7 天时，面板仍按默认 15 天渲染文案，与真实判据不一致
   * （提示说只烧 15 天内的、实际按 7 天筛号）。
   */
  it('★ TRAE / LobsterAI 的响应同样回传窗口天数（判据是「按到期时间分桶」）', () => {
    // ⚠️ 2026-10-08 改：原先这里扫 `src/jet-hub-rpc.ts` 的源码文本，要求
    //    `usesExpiryWindow` 那一行里有 `provider === TRAE.id` 与
    //    `provider === LOBSTERAI.id`。本次重构把该四连 `||` 收敛成读 registry 的
    //    `usesExpiryWindow`（字面量搬家）⇒ 文本断言变红，而**行为完全没变**。
    //
    //    ⇒ **端到端行为断言搬到了唯一一处**（避免同一套 RPC 替身在两个文件里各写一份）：
    //    `tests/unit/provider-registry-consumers.spec.ts` 的
    //    「usesExpiryWindow：credits.permanentLock 的响应体取决于 registry（行为断言）」
    //    —— 它真跑端点，遍历 registry 里每个 `permanentLock` 渠道，逐条核对响应体
    //    是否带 `windowDays` 且与 `usesExpiryWindow` 一致。**比原断言更强**：
    //    原断言只证明源码里有那两串字面量，它能证明端到端响应真的带/不带该字段。
    //
    //    本文件保留**声明值**断言（廉价的语义锚点）。
    expect(descriptorOf('trae')?.usesExpiryWindow).toBe(true)
    expect(descriptorOf('lobsterai')?.usesExpiryWindow).toBe(true)
    // ⚠️ 判据**不是**「是不是 buddy」、也**不含** loomy —— 后者没有窗口概念
    //（服务端直接给两个命名池），保留这条防止有人把 loomy 也登记进去。
    expect(descriptorOf('loomy')?.usesExpiryWindow).toBeUndefined()
  })

  it('后端有 provider 白名单，且与 Loomy/Buddy 的支持面一致', () => {
    // ⚠️ 2026-10-08 改（Task 5）：原先第一条断言扫源码文本，要求
    //    `PERMANENT_LOCK_PROVIDERS` 之后 200 字符内出现 `LOOMY.id` —— 那锁的是
    //    **手写 Set 字面量**这个写法。本次重构把该集合改为**从 registry 派生**
    //    （`PROVIDER_REGISTRY.filter(d => d.permanentLock === true)`）⇒ 三个
    //    `XXX.id` 字面量全部搬家，文本断言变红而**行为完全没变**。
    //
    //    ⇒ 改为断言**值**（该集合真的含这三家），并保留「端点必须查这个集合」
    //      这条结构断言（它守的是「不得绕过白名单直接放行」）。
    //    ⚠️ 用 id 字面量而不是 `LOOMY.id` 等常量：本文件**不 import** 那些
    //      product 模块（它整体是「读源码文本」的 spec），而 id 值由
    //      `descriptorOf` 那几条断言与 registry 对账守着。
    //    ⚠️ 「集合 == registry 里 permanentLock === true 的那些」由
    //      `provider-registry-consumers.spec.ts` 的
    //      「支持锁定的渠道 ⊆ usesExpiryWindow ∪ {loomy}」逐项对账，
    //      「前后端支持面一致」由 `credits-capabilities.spec.ts` 守 —— 本文件
    //      不重复那条不变式（重复会变成「同一语义两套判据」）。
    for (const id of ['loomy', 'buddy', 'workbuddy']) {
      expect(PERMANENT_LOCK_PROVIDERS.has(id), `${id} 应在永久积分锁定白名单里`).toBe(true)
    }
    /**
     * ⚠️ 2026-10-08（Task 11-B）复核：这条**保留**，它不是「该被清理的冗余文本断言」。
     *
     * 判据是「**该断言能不能被行为用例替代**」：
     * - 「集合的**内容**对不对」已经由 `permanent-lock-trae-lobsterai.spec.ts` 的
     *   「后端白名单含两家，且未误加其它 provider」与
     *   `provider-registry-consumers.spec.ts` 逐项对账 —— 那部分是**重复的**；
     * - 但本行守的是**另一件事**：「端点在放行写锁定**之前真的查了这个集合**」。
     *   ⚠️ 这一点**行为侧测不到** —— 行为用例只能观察到「白名单里的家能写、外面的不能」，
     *   而把端点改成硬编码放行（`if (true)`）后那些行为用例**照样全绿**
     *   （只要被观察到的几家还在集合里）。它是一个**结构断言**，与
     *   `authOf(auths, entry.provider)` / `descriptorOf(...)` 同类。
     *
     * ⇒ 属于设计文档「编排可抽象，协议不抽象」里**应当保留**的那一类：
     * 用**符号名**（不是行号、不是位置参数）匹配，重构不失效，语义也不含糊。
     */
    expect(rpcSource).toMatch(/PERMANENT_LOCK_PROVIDERS\.has\(provider\)/)
  })

  /**
   * ⚠️ 写锁定会改变**选号结果**，故必须广播 `llm/adapters-updated`
   * （与 `model.setDisabled` 同理，见 AGENTS.md 的对应章节）。
   *
   * ⚠️ 2026-10-08（issue IKJVTF 复审）：实现已收口到**唯一**的
   * `src/catalog-broadcast.ts`（它自带「失败只记日志、不反噬已落盘的开关」
   * 与两级可选链 logger）。故这里断言的是「**调了那个函数**」，
   * 而不再要求内联 `ctx.emit` + `try/catch` —— 后者是旧形态，
   * 且它用 `ctx.logger.warn`（无可选链，logger 缺席时会抛、仅被 catch 吞）。
   */
  it('写锁定后广播 llm/adapters-updated（走唯一实现）', () => {
    const start = rpcSource.indexOf("case 'loomy.permanentLock'")
    expect(start).toBeGreaterThan(-1)
    const end = rpcSource.indexOf("case 'onboarding.claim'", start)
    expect(end).toBeGreaterThan(start)
    const body = rpcSource.slice(start, end)
    expect(body).toContain('broadcastCatalogChanged(ctx)')
    // 唯一实现必须真的导入（否则是未定义符号）。
    expect(rpcSource).toContain("from './catalog-broadcast.js'")
  })

  it('未登记的 provider 调 onboarding.* 时返回可读错误（不是泛化文案）', () => {
    expect(rpcSource).toMatch(/onboarding[\s\S]{0,3000}unsupported provider/)
  })

  it('LOOMY 已导入', () => {
    expect(rpcSource).toContain("from './loomy-product.js'")
  })

  /**
   * ⚠️ 短信登录的 msgid 是**一次性中间态**（5 分钟有效），
   * 不该写进 `ctx.credentials` 污染凭据命名空间。
   */
  it('msgid 用内存暂存表，不写进凭据存储', () => {
    expect(rpcSource).toContain('pendingSmsMsgid')
    expect(rpcSource).toMatch(/pendingSmsMsgid\.set\(/)
  })

  it('短信登录成功后不把 refreshable 置 true（Loomy 不可续期）', () => {
    // ⚠️ 窗口用**下一个 case 标签**界定，不用硬编码字符数。
    //
    // 原实现取 `slice(start, start + 3000)` —— 那是脆弱的：`login.submitSms`
    // 分支里每加一段别的渠道的代码（如 2026-10-19 给 autoclaw 加的同账号去重），
    // 就会把 loomy 的 `refreshable: false` 挤出窗口，测试变红而**代码其实没错**。
    // 判据应当表达「这一段分支里没有 true」而不是「第 3000 个字符之前没有 true」。
    const start = rpcSource.indexOf("case 'login.submitSms'")
    expect(start).toBeGreaterThan(-1)
    // 找该分支之后的下一个 `case '...'`（同层或更外层），以它作为分支结尾。
    const after = rpcSource.slice(start + 1)
    const nextCase = after.search(/\n\s{0,12}case '[a-z]/i)
    const body = nextCase === -1 ? after : after.slice(0, nextCase)
    expect(body.length, '分支体不应为空（判据失效时给出可读失败）').toBeGreaterThan(100)
    expect(body).toContain('refreshable: false')
    expect(body).not.toContain('refreshable: true')
  })
})
