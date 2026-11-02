import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { apply } from '../../src/index.js'
import { JET_HUB_API_PATH } from '../../src/jet-hub-rpc.js'
import { PROVIDER_REGISTRY, descriptorOf } from '../../src/provider-registry.js'
import type { ProviderAccountEntry } from '../../src/types.js'
import { AUTH_EXEMPT, expectedProviderIdsWithAuth } from '../helpers/provider-sets.js'

/**
 * ★★ **真接线回归**：`src/index.ts` 把每个 provider 的 auth 实例接到了
 * `registerJetHubRpc` 的**同名键**上。
 *
 * ## 本文件替换掉了五条源码文本断言（2026-10-08）
 *
 * `registerJetHubRpc` 的 13 个 auth 实例从**位置参数**改为**命名对象**后，
 * 原先散在各 wiring 用例里的这些断言全部变红：
 *
 * | 文件 | 旧断言（源码文本） |
 * |---|---|
 * | `zcode-wiring.spec.ts` | `/registerJetHubRpc\(ctx, pool, service, .*raccoon,.*zcode,.*gemini, modelAdapters\)/` |
 * | `zcode-wiring.spec.ts` | 从签名正则解析出形参名数组，断言 `params.length === clientIds.length + 1` |
 * | `zcode-wiring.spec.ts` | 「不占形参位的是 opencode 与 aggregate」 |
 * | `qoder-wiring.spec.ts` | `/registerJetHubRpc\(ctx, pool, service, …, qoder, qoderCn, trae, …\)/` |
 * | `minimax-rpc.spec.ts` / `gemini-rpc.spec.ts` | `/loomy, raccoon, minimax, zcode, gemini, modelAdapters/` |
 *
 * 它们守的**意图**是「某 provider 的实例没接错、也没漏接」，但那件事**与位置无关**
 * —— 键名即语义之后「错位」这个失效模式本身消失了。本文件用**真跑端点**的
 * 行为断言替代：`apply()` 建出真实例 → 驱动 `account.refresh` → 看**哪个实例**
 * 被调用。这比文本断言强：文本断言只能证明源码里有那串字符，本文件能证明
 * 端到端分派真的落到了正确实例上。
 *
 * ## ⚠️ 反向验证（本文件的核心价值）
 *
 * 把 `src/index.ts` 调用点里的 `qoder` / `qodercn` 两个键的**值**互换
 *（`qoder: qoderCn, qodercn: qoder`）⇒ 本文件的
 * 「★★ 每个 provider id 的续期都分派到自己的 auth 实例」**变红**，
 * 报出 `qoder 的续期分派错了实例（期望只有 qoderAuth 被调用）`。
 * 这正是本 Task 要消灭的「中国版账号续作用了国际版凭据」形态。
 */

/**
 * provider id → 该 provider 的 auth 服务名（`ctx.<name>`）。
 *
 * ⚠️ 服务名由 `${product.id}Auth` 派生（`Service` 构造时按名称注册），故
 * `qodercn` 对应 **`qodercnAuth`**（全小写，与 provider id 同形）。
 *
 * ⚠️ **本表是实测出来的，不是从注释推出来的**：本仓库有两处文字说它是
 * `qoderCnAuth`（`src/index.ts` 的注释与 `AGENTS.md` 的「服务名由产品 id
 * 派生」一节），而那与运行时不符 —— 实测 `ctx.qoderCnAuth` 是 `undefined`，
 * 真实服务名是 `ctx.qodercnAuth`。下面第 1 条用例会把这种「注释与实现不一致」
 * 直接暴露出来（它逐个 provider 断言服务存在），故**不要凭注释改这张表**。
 */
const AUTH_SERVICE: Readonly<Record<string, string>> = {
  codearts: 'codeartsAuth',
  buddy: 'buddyAuth',
  workbuddy: 'workbuddyAuth',
  lobsterai: 'lobsteraiAuth',
  qoder: 'qoderAuth',
  qodercn: 'qodercnAuth',
  trae: 'traeAuth',
  cline: 'clineAuth',
  loomy: 'loomyAuth',
  raccoon: 'raccoonAuth',
  minimax: 'minimaxAuth',
  // ⚠️ MiniMax Code 国际版：服务名同样是 `${product.id}Auth` ⇒ **`minimaxintlAuth`**
  //    （全小写、不带连字符）。**不是** `minimaxIntlAuth`（按变量名驼峰惯例拼会恒
  //    undefined）—— 与上面 `qodercnAuth` 同款的坑，本表就是为它存在的。
  minimaxintl: 'minimaxintlAuth',
  zcode: 'zcodeAuth',
  gemini: 'geminiAuth',
  // ⚠️ OfficeAce 的值是 **auth 模块命名空间**，不是 `ctx.*Auth` 服务实例 ——
  //    它导出的是纯函数（`refreshAccountCredential` 在命名空间上）。见
  //    `JetHubAuths.officeace` 的注释与 `officeace-auth.ts` 模块头。
  officeace: 'officeaceAuth',
  // ⚠️ 服务名由 `${product.id}Auth` 派生 ⇒ `accioAuth`（全小写，与 provider id 同形）。
  accio: 'accioAuth',
  // astudio（2026-10-16，goal 302 接线）：服务名同样由 product.id 派生 ⇒ astudioAuth
  //   （src/astudio-auth.ts 的 super(ctx, product.id + 'Auth')，构造时自注册；index.ts
  //   的 JetHubAuths 调用点与 src/jet-hub-rpc.ts 的接口都已含 astudio 键）。
  astudio: 'astudioAuth',
  // ⚠️ AutoClaw（智谱）同款：服务名 = `${product.id}Auth` ⇒ **`autoclawAuth`**（全小写）。
  autoclaw: 'autoclawAuth',
  // ⚠️ AutoClaw 国际版（2026-10-20）：服务名同理由派生 ⇒ **`autoclawintlAuth`**
  //    （`AutoclawAuth` 构造：`super(ctx, options.serviceName ?? `${product.id}Auth`)`，
  //    国际实例的 `product.id` 是 `autoclawintl`）。
  //    ⚠️ 它必须是**独立实例的服务名** —— 若误写成 `autoclawAuth`，
  //    按 id 查表会把国际账号分派到国内实例（续期打错基址）。
  autoclawintl: 'autoclawintlAuth',
  // ⚠️ **本 fork 独有**（modelscope，2026-10-16）。服务名同理由派生 ⇒ `modelscopeAuth`。
  //    该名字由 `provider-runtime-wiring.spec.ts` 的真跑 `apply()` 探针独立验证过。
  modelscope: 'modelscopeAuth',
  // ⚠️ **本 fork 独有**（qiniu，2026-10-29）。服务名同理由派生 ⇒ `qiniuAuth`。
  qiniu: 'qiniuAuth',
  // ⚠️ Codely（Unity，2026-10-22 A6）：服务名 `codelyAuth`（全小写，与 provider id 同形）。
  //    ⚠️ `CodelyAuth` 已从裸类改为 `extends Service`（否则 ctx 上永远没有
  //    `codelyAuth`，本表取不到实例）—— 见 `codely-auth-service.ts` 的类注释。
  codely: 'codelyAuth',
  // ⚠️ 超级麦吉（Magicrew，2026-10-29）：服务名由 `${product.id}Auth` 派生
  //    ⇒ `magicrewAuth`（`MagicrewAuth` 是 `extends Service`，构造时自 provide）。
  magicrew: 'magicrewAuth',
  // ⚠️ **MagiCrew 国际版**（`magicrewintl`，2026-11-01）：服务名同样由
  //    `${product.id}Auth` 派生 ⇒ **`magicrewintlAuth`**（全小写、不带连字符）。
  //    ⚠️ **不是** `magicrewIntlAuth`（按变量名驼峰惯例拼会恒 undefined）——
  //    与上面 `minimaxintlAuth` / `autoclawintlAuth` 同款的坑。
  //    ⚠️ 它必须是**独立实例的服务名** —— 若误写成 `magicrewAuth`，
  //    按 id 查表会把国际账号分派到国内实例（续期打错 host）。
  magicrewintl: 'magicrewintlAuth',
  // ⚠️ **本 fork 独有**（MonkeyCode，2026-11-02）。服务名同理由派生
  //    ⇒ `monkeycodeAuth`。它是静态 API Key 型渠道（白泽 `sk-…` / 网关 `oma_…`），
  //    没有 refresh 端点，但 `refreshAccountCredential` 仍要做有效期对账，
  //    故它**占一个真实 auth 键位**（与 loomy / zcode 同型，不属于 AUTH_EXEMPT）。
  monkeycode: 'monkeycodeAuth',
  // ⚠️ 国际站（2026-11-02）：服务名由 `${product.id}Auth` 派生 ⇒
  //    **`monkeycodeintlAuth`**（全小写、不带连字符）。**不是** `monkeycodeIntlAuth`
  //    （按变量名驼峰惯例拼会恒 undefined）—— 与 minimaxintlAuth /
  //    magicrewintlAuth 同款的坑。必须是**独立实例**的服务名，否则按 id 查表会把
  //    国际账号分派到国内实例（续期与登录都打错站）。
  monkeycodeintl: 'monkeycodeintlAuth',
  // ⚠️ 百智云（2026-11-02）：`BaizhiAuth` 是 `extends Service`，服务名由
  //    `${product.id}Auth` 派生 ⇒ `baizhiAuth`。它是静态 Key 型渠道，没有
  //    refresh 端点，但仍要占一个真实 auth 键位（与 monkeycode / qiniu 同型）。
  baizhi: 'baizhiAuth',
}

/**
 * ⚠️ 2026-10-08（Task 11-F）：`AUTH_EXEMPT` 的**定义**已上移到
 * `tests/helpers/rpc-refresh.ts`（同一判据原先在本文件、`rpc-refresh.ts` 与
 * `provider-runtime-wiring.spec.ts` 里各写了一遍，实测四处集合完全相同）。
 * 本文件仍负责**验证豁免理由**（下面「两个豁免者的豁免理由逐条被验证」那条）
 * —— 那是本文件独有的能力：它拿得到 `AUTH_SERVICE`，而 helper 拿不到。
 */

/**
 * **期望**占 auth 键位的 provider 集合 —— 从 `PROVIDER_REGISTRY` 派生，
 * ⚠️ **绝不读 `AUTH_SERVICE`**。
 *
 * ## ⚠️⚠️ 为什么必须从 registry 派生（2026-10-08 复审 Finding 1，恒真断言）
 *
 * 原实现是 `PROVIDER_REGISTRY.map(d => d.id).filter(id => AUTH_SERVICE[id] !== undefined)`，
 * 再拿去与 `Object.keys(AUTH_SERVICE)` 比 —— 用 `AUTH_SERVICE` **筛出**的子集
 * 当然等于 `AUTH_SERVICE` 自己：**恒真**，`toHaveLength(13)` 也只证明了
 * 「表里的键都在 registry 里」（与注释声称的方向**相反**）。
 *
 * 实测（复审者复现）：给 `PROVIDER_REGISTRY` 加一个 provider 而不加进
 * `AUTH_SERVICE` ⇒ 该用例**照样全绿**，且下面驱动续期的循环
 * （`for (const id of authProviderIds())`）会**静默少跑一家** ⇒ 新 provider 的
 * 续期接线**零行为覆盖**。这正是本次重构要消灭的「静默漏接」形态。
 *
 * ⇒ 判据改为「registry 是权威、`AUTH_SERVICE` 是被测对象」：新增 provider 时
 * 只改 registry 而忘了登记 auth ⇒ **红，并点名那个 id**。
 *
 * ⚠️ 判据本体由 `expectedProviderIdsWithAuth()` 单一持有（Task 11-F 收敛）。
 */
const EXPECTED_AUTH_PROVIDER_IDS: readonly string[] = expectedProviderIdsWithAuth()

/**
 * 把账号喂给 `AccountPool` 的后端。
 *
 * ⚠️ **本桩提供的 `settings` 带 `register`**，故 `createJetHubStore` 会选中
 * **`SettingsStore` 老契约后端**（判据见 `settings-compat.ts` 的
 * `hasLegacyNamespaceRegistration`：只看 `register` 是不是函数），它读的是
 * `scope.get()` 返回的内存对象 —— **不是** `state.json`。
 * ⇒ 账号必须写进这个内存对象；写 `state.json` 会读不到，
 * 症状是 `Account xxx not found`（本文件初版正是如此）。
 */
function makeSeed(accounts: ProviderAccountEntry[]): { value: unknown } {
  return { value: { accounts, disabledModels: {} } }
}

class FakeCredentials {
  private store = new Map<string, string>()
  async resolve(ref: string) {
    const value = this.store.get(ref)
    return value === undefined ? undefined : { value, source: 'fake' }
  }
  async describe(ref: string) {
    return { configured: this.store.has(ref), writable: true }
  }
  async set(ref: string, value: string) { this.store.set(ref, value) }
  async unset(ref: string) { this.store.delete(ref) }
}

/**
 * 跑一次真实的 `apply()`，返回可驱动 `account.refresh` 的调用器，
 * 以及每个 auth 服务上 `refreshAccountCredential` 的 spy。
 *
 * ⚠️ **它是 `async`**：返回前必须把 `apply()` 的 fire-and-forget 首轮续期
 * 跑完并清空记录（理由见函数内 `settleBackground` 的注释）——
 * 否则背景噪声会混进「恰好只有自己那个实例」的断言。
 */
async function setup(accounts: ProviderAccountEntry[]): Promise<{
  call: (method: string, payload: unknown) => Promise<{ ok: boolean; error?: { message?: string } }>
  spyOf: (serviceName: string) => ReturnType<typeof vi.fn>
  calledServices: () => string[]
}> {
  const ctx = new Context()
  ctx.provide('credentials', new FakeCredentials() as never)
  ctx.provide('commands', { register: () => () => {}, definitions: [] } as never)
  ctx.provide('llm', {
    registerConfigurableProviders: () => ({ replace() {} }),
    registerAdapter: () => ({ replace() {} }),
    listModels: async () => [],
  } as never)
  // ⚠️ 账号**必须先于 `apply()` 写进这个 scope**：`AccountPool` 在构造时读一次后端。
  const state = makeSeed(accounts)
  ctx.provide('settings', {
    register() { return { get: () => state.value, replace: (v: unknown) => { state.value = v } } },
    describe() { return [] },
  } as never)

  let handler: ((req: Request) => Promise<Response>) | undefined
  // ⚠️ `connection` 必须**经 ctx.provide 提供**（而不是直接赋值到 ctx 属性上）：
  //    `registerJetHubRpc` 用 `ctx.inject(['connection'], …)` 惰性注入，注入的是
  //    cordis 解析出来的服务。直接赋属性时 inject 回调里拿不到它，端点便不注册，
  //    本文件的断言会以「jet-hub RPC 端点未注册」失败。
  ctx.provide('connection', {
    fetch: {
      register: (spec: { path: string; fetch: (req: Request) => Promise<Response> }) => {
        if (spec.path === JET_HUB_API_PATH) handler = spec.fetch
      },
    },
  } as never)

  apply(ctx)

  // 把每个 auth 的续期入口换成纯记录器：本用例只关心**谁**被调用，
  // 不关心各 provider 的续期协议（那由各自的 spec 覆盖），更不能真发网络。
  const called: string[] = []
  const spies = new Map<string, ReturnType<typeof vi.fn>>()
  for (const serviceName of Object.values(AUTH_SERVICE)) {
    const service = (ctx as unknown as Record<string, { refreshAccountCredential?: unknown }>)[serviceName]
    if (service === undefined) {
      throw new Error(`ctx.${serviceName} 不存在 —— 该 provider 的 auth 实例没注册上`)
    }
    const spy = vi.fn(async () => { called.push(serviceName) })
    ;(service as { refreshAccountCredential: unknown }).refreshAccountCredential = spy
    spies.set(serviceName, spy)
  }

  const call = async (method: string, payload: unknown) => {
    // ⚠️ `registerJetHubRpc` 用 `ctx.inject(['connection'], cb)` 惰性注册端点，
    //    cordis 在**微任务**里才解析依赖并调用 cb —— 故这里先让出一轮，
    //    否则 `handler` 还是 undefined（实测：不加这一行必然报「端点未注册」）。
    await new Promise((resolve) => setTimeout(resolve, 0))
    const h = handler
    if (h === undefined) throw new Error('jet-hub RPC 端点未注册')
    const res = await h(new Request('http://localhost/api/jet-hub', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request', rpcId: 'r1', method: 'jet-hub',
        payload: { method, payload },
      }),
    }))
    return (await res.json() as { result: { ok: boolean; error?: { message?: string } } }).result
  }

  /**
   * ⚠️⚠️ **清空背景噪声：`apply()` 内部有一条 fire-and-forget 的首轮续期。**
   *
   * `src/index.ts` 的 `apply()` 会 `void refreshAllCredentials()` —— 它**不 await**，
   * 且在**微任务**里才真正跑。它逐 provider 调 `refreshAll`，而 officeace 的
   * `refreshAll` 会**对每个账号调 `refreshAccountCredential`**（那正是本文件布桩的
   * 方法）⇒ 上面 `called` 记录器里会混进一条**与本次 RPC 无关**的
   * `officeaceAuth`。
   *
   * ## 为什么这件事现在才暴露（IKLPTZ 的连带效应）
   *
   * 在 IKLPTZ（officeace 的 `refreshAll` 把同步池当 Promise）**未修**时，
   * 那条首轮续期跑到 officeace 就抛 `TypeError` 并被上层吞掉 ⇒ **背景噪声根本不产生**，
   * 本文件的「恰好只有自己那个实例」断言因此一直是绿的。
   * 缺陷一修，背景链走通，噪声出现 ⇒ 断言把 codearts 那轮的
   * `['officeaceAuth','codeartsAuth']` 判成错位。
   *
   * ⚠️ 但**分派本身是对的**（`codeartsAuth` 确实在列表里），多出来的那条是噪声。
   * 故修法**不是**放宽断言（那会连真正的错位一起放过），而是
   * **在开始测量之前把背景链跑完并清空记录** —— 让断言只衡量「本次 RPC 分派给了谁」，
   * 这才是本用例的判据。
   *
   * ⚠️ **不得删掉这段**：删了它会退化成「靠启动时序侥幸绿」，
   * 一旦背景链的时长随 provider 数量变化就会重新变成偶发假失败。
   */
  const settleBackground = async (): Promise<void> => {
    // 让出若干拍：首轮链有多个 `await`（读池 → 逐账号续期 → 兜底）。
    // ⚠️⚠️ 2026-10-22（A6）：**固定拍数已不可靠** —— 改成「轮询到静默」。
    //
    // 原写法是 5 拍（后来加到 12），它隐含一个假设：「背景链的 await 次数固定」。
    // 而 codely 加入后它不再成立：每家的 `refreshAll` 都会“读池 → **逐账号 `await`** → 写回”，
    // 拍数与**账号数×家数** 成正比 ⇒ 任何固定值都是“恰好够”的幸存，
    // 下一次加 provider / 加账号就会重新渗到测量区，表现为**假错位**
    // （实测先报 minimax 、拍数加大后又报 buddy）。
    //
    // ⇒ 判据改成：**轮询直到连续 N 拍没有新调用**才算背景链跑完，
    //   然后清零记录。它不依赖「链有多长」，只依赖「它有没有停」。
    //   ⚠️ 不得改成「只断言列表包含**自己**」—— 那会连真正的错位一起放过。
    let quiet = 0
    let lastLen = -1
    // 上限 200 拍（防死循环；成本是微任务循环，实测远小于此）。
    for (let i = 0; i < 2000 && quiet < 20; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0))
      if (called.length === lastLen) quiet += 1
      else { quiet = 0; lastLen = called.length }
    }
    called.length = 0
  }
  await settleBackground()

  return {
    call,
    spyOf: (serviceName: string) => {
      const spy = spies.get(serviceName)
      if (spy === undefined) throw new Error(`未对 ${serviceName} 布桩`)
      return spy
    },
    calledServices: () => [...called],
  }}

function entry(provider: string, credentialRef: string): ProviderAccountEntry {
  return {
    id: `${provider}-1`,
    provider,
    nickname: '接线测试号',
    enabled: true,
    credentialRef,
    createdAt: 1,
    refreshable: true,
  }
}

describe('★ registerJetHubRpc 的命名对象接线（真跑 apply + account.refresh）', () => {
  it('registry 里占 auth 键位的恰好 18 家（opencode / aggregate 豁免）', () => {
    // ★ **方向性**：以 `PROVIDER_REGISTRY` 为权威，`AUTH_SERVICE` 是被测对象。
    //   「registry 里有、表里没有」⇒ 红，且 `toEqual` 的差异**点名那个 id**
    //   （而不是让下面的逐 provider 用例静默少跑一家）。
    expect(
      Object.keys(AUTH_SERVICE).sort(),
      'AUTH_SERVICE 必须与「registry 的 channel 减去两个豁免」逐项相等；' +
      '左侧多出的 id = 表里有而 registry 没有（僵尸项），右侧多出的 id = ' +
      'registry 里有而本表漏登记（该 provider 的续期会零行为覆盖）',
    ).toEqual([...EXPECTED_AUTH_PROVIDER_IDS].sort())
    // ⚠️ 2026-10-13 合并：officeace 与 accio **同一次**并入，故 13 → 15。
    // ⚠️ 2026-10-15 加 minimaxintl（MiniMax Code 国际版）：15 → 16。
    // ⚠️ 2026-10-16 astudio 并入（goal 302 接线）：16 → 17。
    // ⚠️ 2026-10-17 加 autoclaw（AutoClaw/智谱）：17 → 18；
    //    同日 **本 fork** 并入 modelscope（魔搭）：18 → 19。
    // ⚠️ 2026-10-20 加 autoclawintl（AutoClaw 国际版）：19 → 20。
    // ⚠️ 2026-10-22（A6）：codely 已接入 auth（`CodelyAuth` 改为 Service + 接进 auths）：20 → 21。
    // ⚠️ 2026-10-29 加 qiniu（七牛云）+ magicrew：21 → 22 → 23 个 auth 键。
    // ⚠️ 2026-11-01 加 magicrewintl（MagiCrew 国际版）：23 → 24。
    // ⚠️ 2026-11-02 加 monkeycode（MonkeyCode）：24 → 25。
    // ⚠️ 2026-11-02 同日再加 monkeycodeintl（国际站，拆站）+ baizhi（百智云）：25 → 27。
    //    （三审 F🟢-5：本处原只写到 25，而断言已是 27 —— 注释漏了一步就会让
    //     下一个加 provider 的人以为“上次是 25”而把数字写回 25。）
    expect(EXPECTED_AUTH_PROVIDER_IDS).toHaveLength(27)
    // 另一方向（原断言的**全部**证明力都在这条上，单独留着免得它随上面那条一起消失）：
    // 表里的每个键都必须是 registry 里真实存在的 provider id（防拼写错误造成的僵尸项）。
    for (const id of Object.keys(AUTH_SERVICE)) {
      expect(descriptorOf(id), `AUTH_SERVICE 的键 ${id} 不在 PROVIDER_REGISTRY 里`).toBeDefined()
    }
  })

  it('两个豁免者的豁免**理由**逐条被验证（不是被假设）', () => {
    // ⚠️ 豁免表若不验证，就会退化成「凡是没登记的都算豁免」—— 那正是本文件
    //    要消灭的静默失效。故逐条验证：① id 真实存在于 registry；② 它确实没有
    //    auth 服务（不在表里）；③ 它确实**属于**被豁免的那一类（`channel` 为
    //    true 的 opencode 与 `channel` 为 false 的 aggregate 理由不同）。
    for (const [id, reason] of AUTH_EXEMPT) {
      const descriptor = descriptorOf(id)
      expect(descriptor, `豁免表里的 ${id} 不在 PROVIDER_REGISTRY 里：${reason}`).toBeDefined()
      expect(AUTH_SERVICE[id], `${id} 已登记 auth 服务，豁免理由「${reason}」已失效`).toBeUndefined()
    }
    // aggregate 的豁免判据是 registry 自己声明的 `channel: false`（可测量）。
    expect(descriptorOf('aggregate')?.channel, 'aggregate 的豁免理由是「没有账号/凭据」').toBe(false)
    // opencode 是 `channel: true` 却仍然不占键位 ⇒ 它的豁免**只能**来自
    // 「RPC 走 handleOpencodeRpc」这条实现事实，故它是硬编码豁免而非 registry 派生。
    expect(descriptorOf('opencode')?.channel).toBe(true)
  })

  it('★★ 每个 provider id 的续期都分派到**自己**的 auth 实例（错接即红）', async () => {
    // 一次性把 14 个账号都放进池，然后逐个驱动 account.refresh。
    // 每个 provider 的续期必须**只有**它自己的实例被调用 —— 这直接证伪
    // 「qodercn 的账号去刷了 qoder 的凭据」这类串接。
    const accounts = EXPECTED_AUTH_PROVIDER_IDS.map((id) => entry(id, `${id.toUpperCase()}_ACCOUNT_WIRE`))
    const { call, calledServices } = await setup(accounts)

    // ⚠️ **测量前必须排空背景链**：`apply(ctx)` 的**首轮**续期是 fire-and-forget
    //    （`src/index.ts` 里刻意不 await），它的调用会落在 `setup()` 装好 spy
    //    **之后** ⇒ 混进下面「只有自己那个实例被调用」的测量 ⇒ 假红。
    //    ⚠️ 这条是 2026-10-29 加 magicrew 时暴露的：每多一个 provider，背景链就多
    //    一条，原来靠运气对齐的时序就崩了。**不要**改成放宽断言（那会连同真正的
    //    串接一起放过）。
    await new Promise((resolve) => setTimeout(resolve, 100))

    for (const id of EXPECTED_AUTH_PROVIDER_IDS) {
      const expected = AUTH_SERVICE[id]!
      // ⚠️ 每轮先清空记录：`calledServices()` 是**累计**的（spy 跨轮复用），
      // 不清空会把上一轮的调用算进本轮，断言恒假失败。
      const before = calledServices().length
      const result = await call('account.refresh', { accountId: `${id}-1` })
      expect(result.ok, `${id} 的续期应成功，实际 error=${result.error?.message}`).toBe(true)
      expect(
        calledServices().slice(before),
        `${id} 的续期分派错了实例（期望只有 ${expected} 被调用）`,
      ).toEqual([expected])
    }
  })

  it('★ 中国版账号分派到 qodercnAuth，**不碰**国际版 qoderAuth（同族串接的核心风险）', async () => {
    // 这是本 Task 的「qodercn 键必须是 provider id」那条约定在**端到端**上的证明。
    // 若 `src/index.ts` 写成 `qoderCn: qoderCn`（键=变量名）则 `authOf` 查不到
    // `qodercn` ⇒ 报 `Unknown provider: qodercn`；若两个键的**值**互换 ⇒
    // 这里会看到 qoderAuth 被调用。两种错法本用例都抓得住。
    const accounts = [
      entry('qoder', 'QODER_ACCOUNT_INTL'),
      entry('qodercn', 'QODERCN_ACCOUNT_CN'),
    ]
    const { call, spyOf } = await setup(accounts)

    const cn = await call('account.refresh', { accountId: 'qodercn-1' })
    expect(cn.ok, `中国版续期应成功，实际 error=${cn.error?.message}`).toBe(true)
    expect(spyOf('qodercnAuth'), '中国版账号必须刷中国版实例').toHaveBeenCalledTimes(1)
    expect(spyOf('qoderAuth'), '中国版账号**不得**串到国际版实例').not.toHaveBeenCalled()

    const intl = await call('account.refresh', { accountId: 'qoder-1' })
    expect(intl.ok).toBe(true)
    expect(spyOf('qoderAuth')).toHaveBeenCalledTimes(1)
    // 国际版那次不得再动中国版（累计仍是 1）。
    expect(spyOf('qodercnAuth')).toHaveBeenCalledTimes(1)
  })

  it('未知 provider 仍报 Unknown provider（命名对象没有把兜底吃掉）', async () => {
    const { call } = await setup([entry('mystery', 'MYSTERY_ACCOUNT_1')])
    const result = await call('account.refresh', { accountId: 'mystery-1' })
    expect(result.ok).toBe(false)
    expect(result.error?.message).toMatch(/Unknown provider/)
  })
})
