import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { descriptorOf } from '../../src/provider-registry.js'
import { QODER, QODER_CN } from '../../src/qoder-product.js'
import { jetHubAuthsCallKeys } from '../helpers/jet-hub-auths.js'
import { accountEntry, refreshHarness } from '../helpers/rpc-refresh.js'

const here = dirname(fileURLToPath(import.meta.url))
const read = (p: string): string => readFileSync(resolve(here, p), 'utf8')

/** 剔除注释行，避免注释里叙述缺陷的文字造成假阳性/假阴性。 */
function codeOnly(source: string): string {
  return source
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n')
}

/** 剥掉注释：接线断言不该因为「注释里提到了某个符号」而通过。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

describe('Qoder 宿主侧接线（src/index.ts）', () => {
  const index = stripComments(read('../../src/index.ts'))

  it('注册了 llm-qoder settings namespace（漏了会让模型设置页崩溃）', () => {
    // 模型设置页会用 provider id 计算 deriveKeyRef(provider)，
    // namespace 未注册时在 refFor → provider.toUpperCase 处崩溃。
    // ⚠️ 2026-10-08 改：原先扫 index.ts 源码文本找 `'llm-qoder'`。本次重构把 13 个
    //    字面量收敛成从 `PROVIDER_REGISTRY` 派生 ⇒ 文本断言变红而行为没变。
    //    改为断言声明值；「index.ts 真的按它注册了」由
    //    `provider-registry-consumers.spec.ts` 的 `apply()` 行为用例守。
    expect(descriptorOf('qoder')?.settingsNamespace).toBe('llm-qoder')
  })

  it('构造并注册了 Qoder 服务与 LLM 路由', () => {
    expect(index).toContain('new QoderAuth(')
    expect(index).toContain('registerQoderLlm(')
  })

  it('续期调度包含 qoder', () => {
    // `(pool|p)`：逐个 await 与表驱动两种写法都接受，避免重构调度器时假失败。
    // ⚠️ **2026-10-08 改（Task 10）**：原先断言 `src/index.ts` 的源码文本含手抄清单
    //    字面量（`['x', (p) => x.refreshAll(p)]`）—— 那张清单已被
    //    `wiredRefreshTargets()` 从**能力注册表**派生取代 ⇒ 该文本形态**不存在了**，
    //    而它守的意图（该 provider 在续期调度里）**与文本无关**。
    // ⇒ 改为**结构断言**（注册循环挂了 refreshAll + 派生表被使用）。
    // ⚠️ 行为断言（真跑 `apply()` 逐个驱动 `auth.refreshAll` 并断言打到**自己那个**
    //    实例）在 `provider-runtime-wiring.spec.ts` 的「★ 13 家都挂上了
    //    `auth.refreshAll`」一条里，**比本条更强**。
    expect(index, '注册循环没有挂 refreshAll（派生表会恒为空）')
      .toMatch(/refreshAll:\s*\(pool\)\s*=>\s*auth\.refreshAll\(pool\)/)
    expect(index, 'refreshTargets 又回到手抄清单了')
      .toMatch(/wiredRefreshTargets\(\)/)
  })

  it('清理钩子包含 qoder.stop()', () => {
    expect(index).toContain('qoder.stop()')
  })

  it('Jet Hub RPC 传入 qoder 实例与适配器映射', () => {
    // 末尾的 `modelAdapters` 供「显示列表」取不受黑名单影响的全量目录
    // （使被关闭的模型也显示正确的展示名/倍率，而不是退化成裸 id）。
    //
    // ⚠️ 2026-10-08 改（Task 3）：原先这条是**相邻性正则**
    //    `/registerJetHubRpc\([\s\S]*?qoder,[\s\S]*?modelAdapters\)/` ——
    //    Task 3 一度给 `registerJetHubRpc` 加了**第 5 个位置形参** `credits`
    //    （调用点变成 `… }, modelAdapters, creditsTable)`）⇒ 正则必然假失败。
    //    该形参随后在设计复审 C1 中被删除，但**本条的改法保留**：它守的意图
    //    （qoder 的 auth 实例接上了）**与形参个数、键的书写顺序都无关**。
    //    ⇒ 按 **AST** 取调用点第三个实参（auths 对象字面量）的键。
    // 「中国版紧跟国际版」这条更具体的约束由下面的 QoderCN 用例负责。
    const authKeys = jetHubAuthsCallKeys(index)
    expect(Object.keys(authKeys), 'qoder 必须在 auths 命名对象里（键 = provider id）')
      .toContain('qoder')
    expect(authKeys.qoder, '`qoder` 键的值必须是国际版实例').toBe('qoder')
    expect(index, 'qoder 适配器须登记进映射').toMatch(/qoder: pruned\([^)]*,\s*qoderAdapter\)/)
  })

  it('续期调度不看 enabled（AGENTS.md 强制约定）', () => {
    // 真实缺陷：写成 `a.refreshable && a.enabled` 后，所有账号被停用时
    // 续期定时器根本不启动，凭据一路过期到 refresh_token 失效。
    // ⚠️ 原先这里还**正向**断言 `accounts.some(a => a.refreshable)` 必须存在 ——
    // 2026-10-02 那道启动门已改为「池里有账号就武装」（见 AGENTS.md
    // 「账号池的 `refreshable` 只是凭据材料的镜像」）：拿一个可能被误标的布尔
    // 决定「要不要启动修误标的机制」是循环依赖。本用例只保留真正的契约。
    const code = codeOnly(index)
    expect(code).not.toContain('a.refreshable && a.enabled')
    expect(code).not.toMatch(/some\(\s*a\s*=>\s*a\.enabled\s*\)/)
  })

  it('账号池 provider 实参用 QODER.id 而非字面量', () => {
    // 写死 'qoder' 在改名/多产品场景下会静默查不到账号
    expect(index).toContain('getAvailableAccount(QODER.id')
  })
})

describe('Qoder Jet Hub RPC 分支（src/jet-hub-rpc.ts）', () => {
  const rpc = read('../../src/jet-hub-rpc.ts')

  it('registerJetHubRpc 接受 qoder 形参', () => {
    expect(rpc).toContain('qoder: QoderAuth')
  })

  it('account.create 有 Qoder 同族的两步式分支', () => {
    const code = codeOnly(rpc)
    // 重构后分支按注册表判定，实例来自 member.auth（见下面的注册表 describe）。
    expect(code).toContain('isQoderFamily(provider)')
    // ⚠️ `accountId` 必传（2026-10-21）：出口代理按账号取，不传则墙外环境登录恒失败。
    expect(code).toContain('auth.startLogin({ refName, accountId: id })')
  })

  /**
   * ⚠️ 2026-10-08 改（Task 2）：原先这条断言 `requireQoderFamily(entry.provider).auth`
   * 出现在 `account.refresh` 的分派里 —— 那是**同族注册表**时代的写法
   *（`case QODER.id: case QODER_CN.id:` 共用一条）。Task 2 把 13 个同构 case
   * 收敛成一处 `authOf(auths, entry.provider)` 查表 ⇒ 分派不再需要知道
   * 「谁是 Qoder 同族」，`qodercn` 与 `qoder` 各自是**独立的一个键**。
   *
   * ⇒ 改为**行为**断言：两站的续期各刷各的（互不串用），且**恰好**落到自己那个桩上。
   *    这比原文本断言强：原断言只能证明源码里有那串字符，本断言能证明
   *    「中国版账号不会串到国际版实例」—— 那才是这条守的缺陷形态。
   */
  it('account.refresh 分派含 qoder 与 qodercn，且两站各刷各的（行为断言）', async () => {
    const intl = accountEntry(QODER.id, 'QODER_ACCOUNT_WIRE_INTL')
    const cn = accountEntry(QODER_CN.id, 'QODERCN_ACCOUNT_WIRE_CN')
    const harness = refreshHarness([intl, cn])

    const intlResult = await harness.call(intl.id)
    expect(intlResult.ok, `国际版续期应成功，实际 error=${intlResult.error?.message}`).toBe(true)
    expect(harness.calls.map((c) => c.provider)).toEqual([QODER.id])
    expect(harness.calls[0]?.ref).toBe('QODER_ACCOUNT_WIRE_INTL')

    const cnResult = await harness.call(cn.id)
    expect(cnResult.ok, `中国版续期应成功，实际 error=${cnResult.error?.message}`).toBe(true)
    // 累计两次：第二次**只**多了 qodercn —— 串到国际版就会看到 qoder 出现两次。
    expect(harness.calls.map((c) => c.provider)).toEqual([QODER.id, QODER_CN.id])
    expect(harness.calls[1]?.ref).toBe('QODERCN_ACCOUNT_WIRE_CN')
  })

  /**
   * ⚠️ 2026-10-08（Task 11-B）：从**源码文本断言**改为 **registry 断言**。
   *
   * 原实现 `readFileSync('src/jet-hub-rpc.ts')` 后按 `case 'credits.balances'` …
   * `case 'model.list'` 切片、再断言该段含 `isQoderFamily(req.provider)` 与
   * `fetchQoderCreditBalance`。它的问题：
   *
   * 1. **依赖 `case` 边界与调用写法** —— 本 PR 的 Task 3 正是把余额分派收敛成查表，
   *    这类切片断言在别处已因此红过多次（会被无关重构弄假失败）；
   * 2. 它断言的是「实现里恰好有那串字符」，而它守的意图是
   *    **「qoder 的余额能力登记为 true，且真的走它自己的上游端点」**。
   *
   * 现在断言**登记**（registry，与实现写法无关）：
   * `qoder` / `qodercn` 的 `credits.balance` 都必须为 `true`。
   *
   * ⚠️ 行为侧由 `tests/unit/credits-runtime-parity.spec.ts` 的
   * 「★ qoder 系不查表：注入的 qoder 实现不得生效（它只吃 QoderCredential）」守 ——
   * 它**真调** `credits.balances`（provider=qoder），断言端点被接受、
   * 且不落进共享积分表。协议解析细节由 `tests/unit/qoder-credits.spec.ts`
   * 的 8 条守（请求路径 / 鉴权头 / 401 / 形状非法等）。故这里不重复。
   */
  it('qoder 系的余额能力登记为 true（余额接口只需 Bearer，可用）', () => {
    // 实测修正：Qoder 的余额端点 `/sash/api/v2/me/usage` 只需
    // Bearer + Cosy-ClientType（**不需要** WASM 签名），故余额能力为 true。
    // 早期误判「无积分端点」是因为只按 `/api/` 前缀搜索。
    expect(descriptorOf(QODER.id)?.credits?.balance, 'qoder 应声明余额能力').toBe(true)
    expect(descriptorOf(QODER_CN.id)?.credits?.balance, 'qodercn 应声明余额能力').toBe(true)
  })

  it('credits.claimAll 含 Qoder 同族分支（2026-09-21 抓包解出领取端点）', () => {
    // ⚠️ 早期该用例断言的是**相反**的结论（「不含 qoder」），依据是
    // `/sash/api/v1/me/campaigns` 返回 `claimable:false`。真相是**那天已领** ——
    // 活动每日 10:00（UTC+8）刷新。用 keylog 解密抓包拿到：
    //   GET  /sash/api/v1/me/campaigns
    //   POST /sash/api/v1/me/campaigns/{campaignId}/claim   （body 空）
    // 幂等判据是响应体的 `replayed`（重复领取同样 HTTP 200）。
    const code = codeOnly(rpc)
    const start = code.indexOf("case 'credits.claimAll'")
    const end = code.indexOf("case 'credits.balances'")
    expect(start).toBeGreaterThan(-1)
    const branch = code.slice(start, end)
    // 重构后按同族注册表判定。
    expect(branch).toContain('isQoderFamily(req.provider)')
    expect(branch).toContain('claimQoderDailyCheckin')
    // Qoder 的领取流程自带活动列表查询 → 必须跳过外部预检，否则重复发一次 GET。
    expect(branch).toContain('precheckStatus: false')
  })
})

describe('QoderCN 宿主侧接线（src/index.ts）', () => {
  const index = read('../../src/index.ts')

  it('注册了 llm-qodercn settings namespace', () => {
    // 漏了会让模型设置页在 deriveKeyRef(provider) → provider.toUpperCase 处崩溃。
    // ⚠️ 2026-10-08 改：同上一节，源码文本断言 → registry 行为断言。
    expect(descriptorOf('qodercn')?.settingsNamespace).toBe('llm-qodercn')
  })

  it('用 QODER_CN 构造了第二个 QoderAuth 实例', () => {
    // 服务名由 `${product.id}Auth` 派生 ⇒ 自动是 `qodercnAuth`，不会与国际版撞名。
    // ⚠️ 2026-10-08（Task 11-A）：此处曾写作 `qoderCnAuth`（驼峰）—— **那是错的**，
    //    与 `src/qoder-auth.ts` 的类型声明同因（见那里的注释）。真实服务名由
    //    product id `qodercn`（全小写、不带连字符）逐字拼出。
    // ⚠️ 2026-10-21 改：构造选项现在还会带 `fetchFor`（按账号取出口代理，
    //    国际版被 SNI 阻断）⇒ 用正则只守「product: QODER_CN 在选项里」，
    //    不再把整串选项锁死 —— 再往后加选项不该让这条守卫红。
    expect(index).toMatch(/new QoderAuth\(ctx, \{[^}]*product: QODER_CN\b/)
  })

  it('注册了 CN 的 LLM 路由并传入 product: QODER_CN', () => {
    const code = codeOnly(index)
    expect(code).toContain('const qoderCnAdapter = registerQoderLlm(')
    expect(code).toContain('product: QODER_CN,')
  })

  it('CN 的账号池 provider 实参用 QODER_CN.id 而非字面量', () => {
    // 写死 'qoder' 会让中国版永远查不到自己的账号（workbuddy 踩过同类坑）。
    const code = codeOnly(index)
    expect(code).toContain('getAvailableAccount(QODER_CN.id')
    expect(code).not.toContain("getAvailableAccount('qodercn'")
  })

  it('CN 的默认凭据 ref 走 QODER_CN.defaultCredentialRef', () => {
    // 不能复用国际版的 QODER_ACCESS_TOKEN，否则两站账号会读写同一份凭据。
    const code = codeOnly(index)
    expect(code).toContain('credentialRef(QODER_CN.defaultCredentialRef)')
  })

  it('CN 的续期回写刷的是解析凭据时所用的那一个 ref', () => {
    // 与 qoder-auth 那条真实缺陷同因：刷默认单凭据 ref 会导致「刚登录却认证失败」。
    // 关键不变式是 **`qoderCn.` 前缀 + `available.entry.credentialRef`**；
    // `[^)]*` 容忍后面追加的 `pool` + `available.entry.id`（回写有效期用）。
    const code = codeOnly(index)
    expect(code).toMatch(/qoderCn\.refreshAccountCredential\(available\.entry\.credentialRef[^)]*\)/)
  })

  it('续期调度包含 qoderCn.refreshAll(pool)', () => {
    // `(pool|p)`：逐个 await 与表驱动两种写法都接受。
    // ⚠️ **2026-10-08 改（Task 10）**：原先断言 `src/index.ts` 的源码文本含手抄清单
    //    字面量（`['x', (p) => x.refreshAll(p)]`）—— 那张清单已被
    //    `wiredRefreshTargets()` 从**能力注册表**派生取代 ⇒ 该文本形态**不存在了**，
    //    而它守的意图（该 provider 在续期调度里）**与文本无关**。
    // ⇒ 改为**结构断言**（注册循环挂了 refreshAll + 派生表被使用）。
    // ⚠️ 行为断言（真跑 `apply()` 逐个驱动 `auth.refreshAll` 并断言打到**自己那个**
    //    实例）在 `provider-runtime-wiring.spec.ts` 的「★ 13 家都挂上了
    //    `auth.refreshAll`」一条里，**比本条更强**。
    expect(index, '注册循环没有挂 refreshAll（派生表会恒为空）')
      .toMatch(/refreshAll:\s*\(pool\)\s*=>\s*auth\.refreshAll\(pool\)/)
    expect(index, 'refreshTargets 又回到手抄清单了')
      .toMatch(/wiredRefreshTargets\(\)/)
  })

  it('两处清理钩子都包含 qoderCn.stop()', () => {
    // 两处都要：scheduler 钩子与 legacy 钩子（国际版 qoder.stop() 也在两处）。
    const occurrences = (index.match(/qoderCn\.stop\(\)/g) ?? []).length
    expect(occurrences).toBe(2)
  })

  it('CN 适配器登记进 modelAdapters', () => {
    // ⚠️ 2026-10-06 复审 !66：登记项经 `pruned(...)` 包装（致命缺陷修复之一 ——
    // 否则 Jet Hub 拿到原始实例，「已失效模型」剔除对设置页不生效）。
    expect(index).toMatch(/qodercn: pruned\([^)]*,\s*qoderCnAdapter\)/)
  })

  it('registerJetHubRpc 把 qoderCn 接到 provider id `qodercn` 键上', () => {
    // ⚠️ 2026-10-08 改：原先这里断言**位置参数**的顺序
    //    `/registerJetHubRpc\(ctx, pool, service, …, qoder, qoderCn, trae, …\)/`
    //    —— 13 个形参改成**命名对象**后必然变红。
    //    ⇒ 改为断言**键约定**：键是 provider id `qodercn`，值是变量 `qoderCn`。
    //    这条比原断言更精确：原断言只能证明「qoderCn 排在 qoder 后面」，
    //    而真正的风险是「键写成变量名 ⇒ 查表查不到中国版」。
    //
    // ⚠️⚠️ **2026-10-08 复审 Finding 2：这里曾写成相邻性正则**
    //    `/qodercn:\s*qoderCn\b/` —— 它把「键」与「值」用**同一行相邻**绑死，
    //    而对象字面量里键与值的相邻关系只是书写顺序（换行/加注释/调整排版都会
    //    让它假失败）。⇒ 改为按 **AST** 取调用点第三个实参的属性名与初值：
    //    `{ qodercn: qoderCn }` 的映射关系被**结构化**地读出来。
    //    ⚠️ 键写成 `qoderCn` 这件事**类型层已经拦住**（`JetHubAuths` 没有该键
    //    ⇒ TS2561），故本用例不再重复证明拼写，只证明**接线用的是 id 键**、
    //    且值确实指向 `qoderCn` 这个实例（而不是国际版 `qoder`）。
    //
    // ⚠️ 「端到端分派真的落到中国版实例上」由行为用例守（真跑 apply +
    //    account.refresh，且**反向验证**过「两键的值互换 ⇒ 变红」）：
    //    `tests/unit/jet-hub-rpc-auth-wiring.spec.ts` 的
    //    「★ 中国版账号分派到 qodercnAuth，不碰国际版 qoderAuth」。
    const authKeys = jetHubAuthsCallKeys(index)
    expect(Object.keys(authKeys), '键必须是 provider id `qodercn`（不是变量名 qoderCn）')
      .toContain('qodercn')
    expect(authKeys.qodercn, '`qodercn` 键的值必须是 `qoderCn` 实例（不是国际版 qoder）')
      .toBe('qoderCn')
    expect(Object.keys(authKeys), '变量名 `qoderCn` 不得出现在键位上').not.toContain('qoderCn')
  })

  it('续期调度不看 enabled（对 CN 同样成立）', () => {
    // 断言对象是同一份 `src/index.ts` 的启动门，理由见国际版那条用例的注释。
    const code = codeOnly(index)
    expect(code).not.toContain('a.refreshable && a.enabled')
    expect(code).not.toMatch(/some\(\s*a\s*=>\s*a\.enabled\s*\)/)
  })
})

describe('Qoder 同族 RPC 注册表（src/jet-hub-rpc.ts）', () => {
  const rpc = read('../../src/jet-hub-rpc.ts')
  const code = codeOnly(rpc)

  it('四处分支都按注册表判定，不再各写一条平行 case', () => {
    // 加同族产品只改注册表一处。历史教训：workbuddy 的「刷新」按钮一直是坏的，
    // 根因就是新增 provider 时漏接了一个分支 —— 平行 case 越多，漏接概率越高。
    expect(code).toContain('qoderFamily')
    expect(code).toContain('isQoderFamily(')
    expect(code).toContain('requireQoderFamily(')
    // 登录分支不得再只认国际版
    expect(code).not.toContain('} else if (provider === QODER.id) {')
    // 领取与余额分支同理
    expect(code).not.toContain('if (req.provider === QODER.id) {')
  })

  it('注册表含两个产品实例', () => {
    expect(code).toContain('{ product: QODER, auth: qoder }')
    expect(code).toContain('{ product: QODER_CN, auth: qoderCn }')
  })

  it('分支内部一律用 member.product / member.auth，不出现 QODER 字面量', () => {
    // 否则中国版会拿国际版的域名与 client_id 发请求。
    const loginStart = code.indexOf('} else if (isQoderFamily(')
    expect(loginStart).toBeGreaterThan(-1)
    const loginBlock = code.slice(loginStart, code.indexOf('} else if (provider === TRAE.id)'))
    expect(loginBlock.length).toBeGreaterThan(0)
    // ⚠️ 2026-10-21 改：登录现在**必须带 `accountId`**。`startQoderLoginFlow`
    //    第一步就打设备码端点（`openapi.qoder.sh`，与国际版余额/推理同一台被
    //    SNI 阻断的主机）⇒ 墙外环境下要拿到出口代理，而代理是**账号维度**的、
    //    只能按 `accountId` 从池里取。不传 ⇒ 解析器只拿空 id 去查
    //    `QODER_PENDING_PROXY_KEY`，用户没配 pending 就恒直连 ⇒ 国际版登录恒失败。
    expect(loginBlock).toContain('auth.startLogin({ refName, accountId: id })')
    expect(loginBlock).toContain('provider: product.id')
    // ⚠️ 顺序也是判据：占位条目（带代理）必须在 `startLogin` **之前**入库，
    //    否则登录第一步仍拿不到出口（见 `src/jet-hub-rpc.ts` 那段长注释）。
    expect(loginBlock.indexOf('await pool.addAccount({'))
      .toBeLessThan(loginBlock.indexOf('auth.startLogin('))
    // ⚠️ userinfo 也在这台被阻断的主机上 ⇒ 必须带**该账号**的 fetcher。
    //    漏接的症状是「登录成功但昵称永远是 qoder-xxxx」（失败被静默吞掉）。
    expect(loginBlock).toContain('fetchQoderUserNickname(credential, product, qoderFetchForAccount(id))')
    expect(loginBlock).not.toContain('fetchQoderUserNickname(credential, QODER)')
  })

  /**
   * ⚠️ 2026-10-08 改（Task 2）：原先这条切出 `switch (entry.provider)` 那段，
   * 断言里面有 `case QODER.id:` / `case QODER_CN.id:` / `requireQoderFamily(...)`。
   * 那些文本形态在查表分派后**都不存在了** —— 而它们守的意图是
   * 「两个 provider id 都被接上、且各用各的实例」，那**与文本无关**。
   *
   * ⇒ 改为断言**同族注册表仍然存在**（它服务于登录 / 余额 / 领取三处，Task 2
   *    **没有**动那些分支）+ 「`account.refresh` 走查表」这个结构。
   *    「两站续期各刷各的」由上面那条**行为**用例守。
   */
  it('单账号续期改走查表；同族注册表仍服务于其余三处分支', () => {
    const refreshStart = code.indexOf("case 'account.refresh':")
    expect(refreshStart, '找不到 account.refresh 分支').toBeGreaterThan(-1)
    const refreshBlock = code.slice(refreshStart, refreshStart + 4000)
    expect(refreshBlock).toContain('authOf(auths, entry.provider)')
    // 分派不再需要同族判定（qoder / qodercn 是**两个独立的键**）。
    expect(refreshBlock).not.toContain('requireQoderFamily')
    // 但同族注册表本身**必须还在** —— 登录 / 余额 / 领取三处仍按它判定
    //（见下面「Qoder 同族 RPC 注册表」describe 的用例）。
    expect(code).toContain('{ product: QODER, auth: qoder }')
    expect(code).toContain('{ product: QODER_CN, auth: qoderCn }')
    expect(code).toContain('requireQoderFamily(')
  })

  it('领取分支仍传 precheckStatus: false（流程自带活动查询）', () => {
    const start = code.indexOf("case 'credits.claimAll'")
    const end = code.indexOf("case 'credits.balances'")
    const branch = code.slice(start, end)
    expect(branch).toContain('isQoderFamily(req.provider)')
    // ⚠️ 2026-10-21 改：领取同样要出口代理（签到端点在同一个被墙域名上），
    //    故第三参现在是按账号取的 fetcher ⇒ 判据只守「credential + product
    //    两个实参按序传进去了」，不锁死第三参。
    expect(branch).toContain('claimQoderDailyCheckin(credential, product,')
    expect(branch).toContain('precheckStatus: false')
    // ⚠️ 不能退化成只认国际版
    expect(branch).not.toContain('claimQoderDailyCheckin(credential, QODER)')
  })

  it('余额分支按 member.product 取配置', () => {
    // ⚠️ 2026-10-08 改（Task 3）：原先这条切出 `case 'credits.balances'` 后 3000
    //    字符，断言里面有 `isQoderFamily(req.provider)` 与
    //    `fetchQoderCreditBalance(credential, product)`。Task 3 把**其余**渠道的
    //    余额分派收敛成查表，而 qoder 系作为**形态不匹配的特例**保留（它只吃
    //    QoderCredential、不走 collectCreditBalances 的泛型）⇒ 那两串文本**仍在**，
    //    但「特例必须在查表**之前**短路」这条更重要的不变式原先无人守。
    //    ⇒ 改为断言**顺序**（特例早于查表）+ 保留原有两条内容断言。
    const start = code.indexOf("case 'credits.balances'")
    /**
     * ⚠️⚠️ **切片必须覆盖到查表那一行**（2026-11-21 再次放宽）。
     *
     * 历史：原 3000 → 2026-10-12 加 officeace 特例后推到 4000+ → 放宽到 8000。
     * **实测 2026-11-21 时距离已是 19150 字符**（用户 issue 累积的注释与特例分支
     * 使这个 case 体变得很长）⇒ 8000 窗口下 `lookupAt` 恒 -1 ⇒ 该用例**长期假红**
     * （它被算进「6 条基线红」，实际是本条测试自身腐坏，不是产品缺陷）。
     *
     * ⇒ 改为**按结构切片**而不是按长度：从 case 起点切到**下一个 `case '`**
     * （或下一个 `}` 收尾）。这样无论 case 体长到多少都成立。
     */
    const nextCase = code.indexOf("case '", start + 10)
    const branch = code.slice(start, nextCase < 0 ? start + 40000 : nextCase)
    expect(branch.length, '切片必须覆盖本 case 的全部内容').toBeGreaterThan(1000)
    expect(branch).toContain('isQoderFamily(req.provider)')
    // ⚠️ 2026-10-21 改：此处原断言 `fetchQoderCreditBalance(credential, product)`。
    //    面板改用**带原因**的变体 `fetchQoderBalanceDetailed`（同一个文件里
    //    并列存在，前者只回 `null`、后者回 `{ balance, error }`）。断言要守的
    //    不变式是「余额查询按 `product` 分站」—— 即调用点必须**把 product 传进去**
    //    （两站 `openApiBase` 不同，传错就查到别人的账），故判据换成新函数名。
    //    ⚠️ 2026-10-21 再改：第三参现在是**按账号取出口代理**的 fetcher
    //    （国际版被 SNI 阻断），故判据只守「product 被传进去、后面紧跟逗号」，
    //    不锁死实参个数 —— 再往后加参数不该让这条守卫红。
    expect(branch).toContain('fetchQoderBalanceDetailed(credential, product,')
    // ⚠️ 核心：qoder 的特例必须**先于**查表 —— 否则它会落到积分表里
    //    （表里没有 qoder 条目 ⇒ 变成 `unsupported provider`，用户看到
    //    「该渠道不支持积分」而它其实有余额接口）。行为由
    //    `credits-runtime-parity.spec.ts` 的「qoder 系不查表」守着。
    const specialAt = branch.indexOf('isQoderFamily(req.provider)')
    const lookupAt = branch.indexOf('creditsOf(credits, req.provider)')
    expect(lookupAt, '找不到查表分派').toBeGreaterThan(-1)
    expect(specialAt, 'qoder 特例必须早于查表短路').toBeLessThan(lookupAt)
  })
})
