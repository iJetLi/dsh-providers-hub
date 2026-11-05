import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { REFRESH_PROVIDERS, accountEntry, refreshHarness } from '../helpers/rpc-refresh.js'

/**
 * 多账号续期调度的**接线**回归（Gitee issue !IKIRTT）。
 *
 * `src/expiry-sync.spec.ts` 测的是共享实现的语义；本文件锁的是「九个 provider
 * 是不是**都真的接上了**」—— 这正是该缺陷的形态：raccoon 接好了，其余七个
 * 各漏一环，于是「点刷新没反应」只出现在部分面板。逐条源码级断言是这里
 * 最划算的防线：新增 provider 时漏接会**立刻**变红，而不是等用户报障。
 */

const here = fileURLToPath(new URL('.', import.meta.url))
const root = resolve(here, '../..')
const read = (rel: string): string => readFileSync(resolve(root, rel), 'utf8')

/** 剥掉注释：接线断言不该因为「注释里提到了某个符号」而通过。 */
function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

const indexSource = codeOnly(read('src/index.ts'))
const rpcSource = codeOnly(read('src/jet-hub-rpc.ts'))

/** 十个 auth 文件（`buddy-auth.ts` 一份实现同时服务 buddy 与 workbuddy）。 */
const AUTH_FILES = [
  'src/service.ts',
  'src/buddy-auth.ts',
  'src/lobsterai-auth.ts',
  'src/qoder-auth.ts',
  'src/trae-auth.ts',
  'src/cline-auth.ts',
  'src/loomy-auth.ts',
  'src/raccoon-auth.ts',
  // ⚠️ MiniMax 是第 9 个 auth 文件（buddy-auth 一份服务两个 provider）。
  // 加它之前本清单**漏了 minimax** —— 于是「续期必须带 pool/accountId 且调
  // `syncAccountExpiry`」这条契约对 minimax **不被强制**（Spec 盲区）。
  // 该契约正是「续期成功但界面没反应」那个缺陷的回归防线，
  // 新增 provider 时必须同步加进来。
  'src/minimax-auth.ts',
]

/** 取出某个方法从签名到结束花括号的整段（CRLF 安全）。 */
function methodBody(source: string, signature: string): string {
  const start = source.indexOf(signature)
  expect(start, `源码里找不到 ${signature}`).toBeGreaterThan(-1)
  const end = source.slice(start).search(/\r?\n  \}\r?\n/)
  return end === -1 ? source.slice(start) : source.slice(start, start + end)
}

describe('续期调度器：启动必须先跑一轮', () => {
  /**
   * ⚠️ 主缺陷（issue !IKIRTT 第三节）：早先这里**只有** `setInterval`，
   * 第一次处理要等满一个周期。cline（1 小时）/ codearts（约 2 小时）/
   * raccoon（3 小时）的凭据在宿主关闭期间早已到期，于是重启后
   * **最长 30 分钟**一直显示「已过期」、积分行一直 401。
   *
   * ⚠️ issue IKJOZB 之后本条改判在 `MultiAccountRefreshScheduler.start()` 上：那段逻辑
   * 已从 `src/index.ts` 抽成可单测的类（行为用例见
   * `tests/unit/refresh-scheduler.spec.ts`），本文件保留的是**接线**断言 ——
   * 「index.ts 确实用了那个类，且把首轮与定时器都交付给它」。
   */
  it('index.ts 把续期交给 MultiAccountRefreshScheduler，而不是自己写 setInterval', () => {
    expect(indexSource, 'index.ts 未使用 MultiAccountRefreshScheduler')
      .toContain('new MultiAccountRefreshScheduler(')
    expect(indexSource, 'index.ts 仍在自己挂 setInterval（缺陷形态会随之回来）')
      .not.toMatch(/setInterval\(\s*\(\)\s*=>\s*void refreshAllCredentials/)
    // 首轮不再由 index.ts 手写：`start()` 内部保证「先跑一轮」。
    // ⚠️ 这里是**变量名**（`const refreshScheduler = new …`），不是类名。
    expect(indexSource).toMatch(/refreshScheduler\.start\(\)/)
  })

  it('启动判据既不看 `enabled`，也不看 `refreshable`（被误标的布尔不能决定调度器是否武装）', () => {
    // 2026-10-02 修订：原先这里是 `accounts.some(a => a.refreshable)`。
    // 本次事故实测 36 条账号只剩 3 条 `true`（raccoon / minimax / cline 各一）——
    // 再少三条，整个续期调度器（含 codearts 的自愈与启动首轮）就**永不武装**，
    // 而且日志里一个字都不会有。「用可能被误标的字段决定要不要修误标」是循环依赖。
    //
    // ⚠️ issue IKJOZB 修订：这里**不再断言** `accounts.length === 0`。
    // 那条断言当初是为了锁住「判据放宽」，顺带把「空池就 return」这个**错误形态**
    // 一起固化了下来 —— 而它正是 IKJOZB 的根因。现在空池判据只喂给
    // `isPoolEmpty`（仅影响日志措辞），武装本身与池内容**彻底解耦**。
    const gate = indexSource.slice(
      indexSource.indexOf('new MultiAccountRefreshScheduler('),
      indexSource.indexOf('refreshScheduler.start()'),
    )
    expect(gate).not.toMatch(/\.refreshable/)
    expect(gate).not.toMatch(/enabled/)
    expect(gate, '武装不得再依赖「启动瞬间池为空」这个条件').not.toMatch(
      /if\s*\(\s*accounts\.length\s*===\s*0\s*\)/,
    )
    expect(gate, 'isPoolEmpty 必须仍然接上（空池要有可观测日志）').toContain('isPoolEmpty')
    // issue #20：生产必须把首轮延后 15s（否则冷启动与宿主初始化抢网络/存储）。
    // 这一行是接线的一部分，删掉后调度器会退回「立即全量续期」而没有任何测试会红。
    expect(gate, '生产未设置 initialDelayMs（首轮会与宿主启动抢资源）')
      .toContain('initialDelayMs: 15_000')
  })

  it('账号入库时补武装（issue IKJOZB 点名缺失的那条路径）', () => {
    // 冷启动空池 → 之后登录 ⇒ 原先没有任何重新武装的路径。
    expect(indexSource, '未订阅账号入库通知，登录后不会补武装')
      .toMatch(/pool\.onAccountAdded\(/)
    expect(indexSource, '订阅了通知但没接到调度器上').toMatch(
      /onAccountAdded\([^)]*\)\s*=>\s*\{?\s*refreshScheduler\.notifyAccountAdded\(\)/,
    )
    // ⚠️ 订阅必须被回收：插件卸载后还留着回调会逮住旧调度器。
    expect(indexSource, '未回收账号入库订阅').toMatch(/unsubscribeAccountAdded\(\)/)
  })

  it('listAllAccounts 的失败有兜底（否则存储异常会让调度器永不武装且无痕）', () => {
    // ⚠️ 改造后 `listAllAccounts()` **不再**处于武装路径上（它在 `isPoolEmpty`
    // 里，异常由 `MultiAccountRefreshScheduler.probeEmpty` 吞掉并记 warn），故原先那条
    // 「.then() 链上必须有 .catch」的断言失去对象。现在要保证的是
    // `start()` 的 promise 有兜底 —— 否则未处理的 rejection 会让 DSH 侧
    // 报「插件加载失败」，而实际原因只是一次存储抖动。
    const start = indexSource.indexOf('refreshScheduler.start()')
    expect(start).toBeGreaterThan(-1)
    expect(indexSource.slice(start, start + 400), 'start() 的失败没有兜底').toContain('.catch(')
  })

  it('每个 channel provider 都在批量续期表里（新增 provider 不得漏接）', async () => {
    // ⚠️ **2026-10-08 改（Task 10）**：原先这条断言 `src/index.ts` 的源码文本
    //    含 `(p) => xxx.refreshAll(p)` —— 那张 13 行手抄清单已被
    //    `wiredRefreshTargets()` 取代 ⇒ 该文本形态**不存在了**，而它守的意图
    //    （每个 channel 都能批量续期）**与文本无关**。
    //
    // ⇒ 改为**行为断言**：按注册表的期望集注册 runtime，再断言派生表**逐项相等**
    //    （而不是「包含」—— 多一家或少一家都要红，且失败信息点名是哪一家）。
    //
    // ⚠️ **2026-10-08 独立复审修正：期望集必须用 `expectedProviderIdsWithAuth()`**。
    //    原版用的是 `PROVIDER_REGISTRY.filter(d => d.channel)`（**14 家，含 opencode**），
    //    而本仓库的单一事实来源是 **13 家**（`channel` 减去 `opencode` —— 它没有
    //    续期概念）。同一条判据在 `jet-hub-rpc-auth-wiring.spec.ts` /
    //    `provider-runtime-wiring.spec.ts` 里都写作 13，**只有这里写 14** ⇒
    //    两处判据分叉：哪天给 opencode 补一个 `auth.refreshAll`，本文件会因为
    //    「期望 14、实际 13」而红得**指向错误的修法**（去查 opencode，而真问题在别处）。
    //    ⇒ 改用同一函数（判据本体由 `tests/helpers/provider-sets.ts` 单一持有）。
    const { descriptorOf, PROVIDER_REGISTRY } = await import('../../src/provider-registry.js')
    const { clearProviderRuntimes, registerProviderRuntime, wiredRefreshTargets } =
      await import('../../src/provider-runtime.js')
    const { expectedProviderIdsWithAuth } = await import('../helpers/provider-sets.js')

    const expected = expectedProviderIdsWithAuth().sort()
    // ⚠️ 先钉住判据集合本身，免得「期望集被某个改动悄悄改小」时本用例跟着一起绿。
    // ⚠️ 2026-10-13 合并：officeace 与 accio **同一次**并入，故 13 → 15。
    // ⚠️ 2026-10-15 加 minimaxintl（MiniMax Code 国际版）：15 → 16。
    // ⚠️ 2026-10-16 astudio 并入（goal 302 接线）：16 → 17。
    // ⚠️ 2026-10-17 加 autoclaw（AutoClaw/智谱）：17 → 18；
    //    同日 **本 fork** 并入 modelscope（魔搭）：18 → 19；
    //    2026-10-20 加 autoclawintl（AutoClaw 国际版）：19 → 20。
    // ⚠️ 2026-10-22（A6）：codely 翻 `channel: true`：20 → 21。
    // 2026-10-29 fork: qiniu + magicrew (channel:true) added -> 21 -> 22 -> 23.
    // 2026-11-01 fork: magicrewintl (channel:true) added -> 23 -> 24.
    // 2026-11-02 fork: monkeycode (channel:true) added -> 24 -> 25.
    // 2026-11-02 fork: monkeycodeintl (channel:true, 拆站) added -> 25 -> 26.
    // 2026-11-02: baizhi 接入后 26 -> 27。
    expect(expected, 'channel 集合变了，请复核 opencode 豁免是否仍成立').toHaveLength(27)
    // ⚠️ 反方向：期望集里的每一个都必须**确实**在 registry 里有声明（防手抄漂移）。
    for (const id of expected) {
      expect(PROVIDER_REGISTRY.some((d) => d.id === id), `registry 缺少声明：${id}`).toBe(true)
      expect(descriptorOf(id), `descriptorOf(${id}) 取不到`).toBeDefined()
    }

    clearProviderRuntimes()
    // 模拟 `index.ts` 的注册循环：每个 channel（有 auth 域）的 provider 都挂上 `refreshAll`。
    // ⚠️ 这里**不**引入 `index.ts`（它是装配代码、会真起服务）——
    //    本用例锁的是「注册循环的**形状**（channel 家都有 auth.refreshAll）」
    //    与「派生表如实反映它」。
    for (const id of expected) {
      registerProviderRuntime({
        descriptor: descriptorOf(id)!,
        auth: { refreshAccount: async () => {}, refreshAll: async () => {} },
      })
    }

    const derived = wiredRefreshTargets().map(([id]) => id).sort()
    expect(derived, '派生的准期表与期望集不一致（失败信息里的差集就是漏接/多接的那一家）')
      .toEqual(expected)
    // ⚠️ 反向：表里每一项都必须真有 `refreshAll`（否则调度器调不存在的方法）。
    for (const [, refreshAll] of wiredRefreshTargets()) expect(refreshAll).toBeTypeOf('function')
    clearProviderRuntimes()
  })

  it('每个 provider 的失败都走同一条日志路径（不再有十个静默 catch）', () => {
    // 旧写法是十个 `try { … } catch { /* 静默 */ }`，把 provider 内部的告警
    // 与异常一起吞掉（issue 第 5.4 条）。现在收敛成一个循环 + 一处 warn。
    //
    // ⚠️ **2026-10-08 改（Task 10）**：循环的**数据源**从手抄的 `refreshTargets`
    //    常量改为 `wiredRefreshTargets()`（从能力注册表派生）。
    //    ⇒ 断言改为「循环读的是那个函数」，并**保留**「一处 warn、无空 catch」
    //    这两条与数据源无关的意图。
    const start = indexSource.indexOf('async function refreshAllCredentials')
    expect(start).toBeGreaterThan(-1)
    // 取到函数体结束（CRLF 安全：用正则找第一个「缩进两格的花括号」）
    const body = indexSource.slice(start, start + 800).split(/\r?\n  \}\r?\n/)[0] ?? ''
    // ⚠️ `indexSource` 已在文件头部**剥过注释**（否则本行会被注释里逐字写出的
    //    同名符号喂饱 —— 实测 `wiredRefreshTargets()` 在 `index.ts` 里共 2 处、
    //    剥注释后只剩 1 处，差值那 1 处就在注释里）。
    expect(body).toMatch(/for \(const \[tag, refreshAll\] of wiredRefreshTargets\(\)\)/)
    expect(body).toContain('批量续期失败')
    expect(body).not.toMatch(/catch\s*\{\s*\}/)
  })
})

describe('按需续期必须回写账号池的有效期', () => {
  /**
   * issue 第 5.3 条：`refreshAccountCredential` 过去只有 raccoon 回写，
   * 其余七个只 `credentials.set` —— 于是**续期成功但界面纹丝不动**
   * （凭据续好了，UI 读的池值纹丝不动）。
   */
  it.each(AUTH_FILES)('%s 的 refreshAccountCredential 接受 pool + accountId', (rel) => {
    const signature = methodBody(codeOnly(read(rel)), 'async refreshAccountCredential')
    expect(signature, `${rel}: 签名缺 pool`).toContain('pool?: AccountPool')
    expect(signature, `${rel}: 签名缺 accountId`).toContain('accountId?: string')
    // Loomy 无续期端点，但仍要在探测成功后对账（见 LOOMY_EXPIRY_ACCESSORS）。
    //
    // ⚠️ **两种正确形态都接受**（补 minimax 时实测到该断言原先过窄）：
    // ① 直接调 `syncAccountExpiry(...)`（raccoon 的写法）；
    // ② 走包装 `refreshAccountWithReconcile(...)` —— 它**内部**两处调用
    //    `syncAccountExpiry`（见 `src/expiry-sync.ts`），是更规范的用法
    //    （自带回写失败不反噬、有效期内仍对账等既有不变量）。
    // 只认 ① 会把 ② 判为「未调用共享回写」—— 那是**假阴性**。
    expect(signature, `${rel}: 未调用共享回写`).toMatch(
      /syncAccountExpiry\(|refreshAccountWithReconcile\(/,
    )
  })

  it('九个 auth 都改用共享的有效期回写，不再各写一份', () => {
    // 本缺陷的形态正是「raccoon 接好了、其余七个各漏一环」，
    // 故这里锁的是「每个文件都真的引了 `src/expiry-sync.ts`」。
    for (const rel of AUTH_FILES) {
      const source = codeOnly(read(rel))
      expect(source, `${rel}: 未接入共享实现`).toContain("from './expiry-sync.js'")
      expect(source, `${rel}: 未调用共享实现`).toMatch(
        /syncAccountExpiry\(|refreshAccountWithReconcile\(|shouldRefreshNow\(/,
      )
    }
  })

  it('可续期的七个 provider 的 refreshAll 走 lead-time + 对账', () => {
    // Loomy 不在内：它没有 refresh 端点，refreshAll 保留「只探测已过期账号」的
    // 独有语义。raccoon 也不在内：它保留自己更严的「已过期才刷」判据
    // （见 `raccoon-auth.ts` 的注释），只共用回写。
    for (const rel of AUTH_FILES.filter((file) => !/loomy|raccoon/.test(file))) {
      const source = codeOnly(read(rel))
      expect(
        source,
        `${rel}: refreshAll 未接入 refreshAccountWithReconcile`,
      ).toMatch(/refreshAccountWithReconcile\(/)
    }
  })

  /**
   * 例外说明：Loomy 不能续期（`isLoomyRefreshable` 恒 false），
   * 它的 refreshAll 保留「只探测已过期的账号」这一独有语义，
   * 因此不走 lead-time 过滤，只借用共享的对账回写。
   */
  it('loomy 只做有效期对账，且绝不回写 refreshable', () => {
    const source = codeOnly(read('src/loomy-auth.ts'))
    expect(source).toContain('LOOMY_EXPIRY_ACCESSORS')
    expect(source).toMatch(/syncAccountExpiry\(/)
    // 不提供 refreshableOf → 共享实现不会把池里的 `refreshable` 改掉。
    expect(source).not.toMatch(/refreshableOf/)
  })

  /**
   * ⚠️ 2026-10-08 改（Task 2）：原先这条从 `src/jet-hub-rpc.ts` 里正则切出
   * `switch (entry.provider)` 那段，断言每个 `case` 里的调用都带
   * `pool, entry.id`。Task 2 把那 13 个同构 case 换成了**一处**查表分派
   * ⇒ 「switch 切片」这个形态**不存在了**，而它守的意图（续期必须回写账号池）
   * 与「分支有多少个」**无关**。
   *
   * ⇒ 改为**行为断言**：驱动真实端点，断言桩**真的收到**了 pool 与 accountId。
   *    这比文本断言强 —— 文本只能证明源码里有那串字符，行为能证明实参
   *    端到端传到了实现里（`[^)]*` 那种写法对「传了但传的是 undefined」无感）。
   *
   * ⚠️ 13 个 provider **逐个**覆盖：`switch` 时代「新增 case 忘了传参数」
   *    是个真实缺陷形态（issue !IKIRTT：只有 raccoon 传了），
   *    查表时代这个形态消失了，但**「表里某一项没接上」**仍可能发生。
   */
  it('account.refresh 的续期实参端到端送达：每个 provider 都收到 pool 与 accountId', async () => {
    for (const provider of REFRESH_PROVIDERS) {
      const entry = accountEntry(provider, `${provider.toUpperCase()}_ACCOUNT_WIRE`)
      const harness = refreshHarness([entry])
      const result = await harness.call(entry.id)
      expect(result.ok, `${provider} 的续期应成功，实际 error=${result.error?.message}`).toBe(true)
      expect(harness.calls, `${provider} 的续期没有分派到它自己的实例`).toEqual([
        {
          provider,
          ref: entry.credentialRef,
          accountId: entry.id,
          // ⚠️ **必须 `toBe` 同一个对象**：第 2 个实参不是「某个 pool」，
          //    而是本次 `registerJetHubRpc` 用的那个 —— 传错对象时回写会落到
          //    别处（或静默失败），而那正是 issue !IKIRTT 的形态。
          pool: harness.pool,
        },
      ])
    }
  })

  /**
   * ⚠️ 2026-10-08 改：原先这条用 `indexSource.match(/refreshAccountCredential\([^)]*\)/g)`
   * 扫源码、断言每处都带 `pool, available.entry.id`。那是**文本**断言 ——
   * 它对「实参传了但传的是 `undefined`」无感，也会被无关重构打红。
   *
   * ⇒ 改为断言**适配器回调真的把它传下去了**：`src/index.ts` 里那 10 处是
   *    `registerXxxLlm(ctx, { refresh: … })` 的回调，无法在单测里逐个驱动
   *    （需要真凭据），故这里退一步，用**结构化**断言守住可测的那一半：
   *    「每个 `refreshAccountCredential(` 调用点的实参列表里都有 `pool` 与
   *    `available.entry.id` 这两个**语义片段**」，并**额外**断言它们出现在
   *    **同一个**调用里（避免「一个调用带 pool、另一个带 id」这种拼接式假绿）。
   *
   * ⚠️ 本条**保留文本形态**是**刻意**的（与仓库红线不冲突）：它的被测对象
   *    就是「这 10 处调用点的实参」，而那些回调没有可驱动的单测入口。
   *    真正的行为覆盖在 `lobsterai-rpc-dispatch.spec.ts` 那条端到端用例上。
   */
  it('index.ts 的适配器 refresh 回调同样传 pool 与账号 id（按需续期最常触发的路径）', () => {
    // ⚠️ 判据必须锚定**调用点**而不是方法名：`src/index.ts` 里还有
    //    ① 能力注册段里包一层的 `auth.refreshAccountCredential(refName, pool, accountId)`
    //      （Task 2 新增，有 `.` 但实参名不同）。
    //    ⚠️ 2026-10-08 复审 Finding 5 后**少了一处**：能力注册段的类型标注原先写作
    //      内联结构类型 `refreshAccountCredential(r: string, p: AccountPool, id: string)`，
    //      现已改用 `jet-hub-rpc.ts` 已导出的 `JetHubAuthLike`（同一语义不许两套判据）
    //      ⇒ 那串文本**不再存在**于 `src/index.ts`。锚定首实参的写法对本条无影响。
    //    用宽松的 `/refreshAccountCredential\([^)]*\)/` 会把 ① 一起捞进来，
    //    断言随即以一条**与被测契约无关**的方式失败（实测踩到）。
    //    ⇒ 锚定**首实参** `available.entry.credentialRef`，它只出现在适配器回调里。
    //    这比原断言更紧：原断言只查后两个实参，本条同时锁住「刷的是解析出的那个 ref」。
    //
    // ⚠️ 跨行调用（raccoon / minimax / gemini 三处是 `(\n  …,\n)` 形态）也要匹配，
    //    故用 `[\s\S]*?` 而不是 `[^)]*`。
    const calls = indexSource.match(/\.refreshAccountCredential\(\s*available\.entry\.credentialRef[\s\S]*?\)/g) ?? []
    // 十个：codearts / lobsterai / qoder / qodercn / trae / cline / loomy /
    // raccoon / minimax / gemini。buddy 与 workbuddy 走 `createPoolRefresh`（下一条）。
    expect(calls.length, '适配器回调的调用点数变了，请复核本清单').toBeGreaterThanOrEqual(10)
    for (const call of calls) {
      expect(call, `适配器回调漏传 pool：${call}`).toMatch(/\bpool\b/)
      expect(call, `适配器回调漏传账号 id：${call}`).toMatch(/available\.entry\.id/)
    }
  })

  it('createPoolRefresh（CodeBuddy 系发消息途中的按需续期）也回写账号池', () => {
    // 这条路径由 `buddy-adapter.ts` 的 401/403 分支调用，触发频率远高于
    // RPC `account.refresh`；漏传 pool 就意味着 buddy/workbuddy 的
    // 「已过期」显示在实际续期成功后仍然挂着。
    const source = codeOnly(read('src/buddy-auth.ts'))
    const body = source.slice(source.indexOf('export function createPoolRefresh'))
    expect(body).toMatch(
      /refreshAccountCredential\(\s*available\.entry\.credentialRef,\s*pool,\s*available\.entry\.id/,
    )
  })
})
