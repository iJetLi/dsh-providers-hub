/**
 * Gitee issue IKJLK3：「+ 新建账号」这条链路的分支判定与入参构造。
 *
 * ## 本 issue 的实际修复面（评审后与提单人共识的部分）
 *
 * | 组 | 结论 | 本文件的角色 |
 * |---|---|---|
 * | **A1/A2/A3** 弹窗对 provider 零分支 | ✅ 属实，**同源**，一并修 | A 组（纯函数真跑 + 接线源码锁） |
 * | **A4** 默认选中项是 codearts | ❌ **不是缺陷** —— 设置页默认停在第一个 provider 是正常设计，issue 里自己也只说它「放大了迷惑性」。**不改** | — |
 * | **B** 登录重入静默 return | ✅ 属实（低频但可感），补提示 | B 组 |
 * | **C** 两处 `zcodeProvider` 各自独立 | ❌ **有意为之**（提单人自己认同），仅信息性 | — |
 * | **D** 完整 loginUrl 打进 console | ✅ 属实，OAuth state 会被一起外泄 | D 组 |
 * | **E1** `account.create` 未校验 provider | ⚠️ **提单人判断有误**：链尾已有兜底 `else { return unknown provider }`（`jet-hub-rpc.ts`，本 issue 修前即存在），且 `id` 只在分支内使用，未知 provider **不会**写进账号池。**不加重复校验** | — |
 * | **E2** `zcodeProvider` 无白名单 | ✅ 属实，RPC 载荷无 schema 校验 | E 组 |
 * | **F1** 无测试覆盖 | ✅ 属实 | 本文件 |
 * | **F2** 顺序型注释 | ✅ 属实 | 已改（不在单测范围） |
 *
 * ## ⚠ 为什么 A 组一半靠源码断言 —— 请先读这段再改
 *
 * 判据本身（`newAccountAsksChannel` / `buildCreateAccountPayload`）抽在
 * `plugin-src/client/new-account.js` 里**真跑**：单测环境是 `node`，`react`
 * 不在依赖内，`jet-hub.js` 根本 import 不了，组件无法渲染。
 *
 * 但**接线**（按钮点了走哪条路、弹窗渲染处有没有判据）只能锁源码。照本仓库
 * 既有的告誡（见 `zcode-carrier-client-wiring.spec.ts` 的 `stripComments`），
 * 这些断言**一律对剥掉注释的代码文本做** —— 否则文件头为了记录旧实现写下的
 * 那行字就能把断言喂绿（本轮修的正是「登录渠道选择」这件事，注释里必然
 * 会提到它）。下面每条源码断言的变异结果都记在文件末尾，做过反向验证。
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { buildCreateAccountPayload, newAccountAsksChannel } from '../../plugin-src/client/new-account.js'
import { normalizeAccioRegion } from '../../src/accio-auth.js'
import { normalizeZcodeLoginProvider } from '../../src/jet-hub-rpc.js'
import { PROVIDER_REGISTRY } from '../../src/provider-registry.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const jetHubSource = readFileSync(resolve(HERE, '../../plugin-src/client/jet-hub.js'), 'utf8')

/** 剥掉注释，只留**可执行代码**（源码级断言一律用它，别被注释喂绿）。 */
function stripComments (source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

const jetHubCode = stripComments(jetHubSource)

/**
 * ⚠⚠ **从源码真读** `PROVIDERS` 的 id 列表，**不要**在这里硬编码。
 *
 * ## 为什么（本轮真踩过）
 *
 * 本文件原先写死一份 provider 列表当遍历样本。实测变异：把
 * `newAccountAsksChannel` 改成 `provider === 'zcode' || provider === 'newbie'`
 * （模拟「新增一个需要预选渠道的 provider」）—— **14 条测试全绿**。
 * 原因就是遍历样本里没有 `newbie`，测试压根没走到它。
 *
 * ⇒ 两层问题：
 *  ① **硬编码副本必然与 `PROVIDERS` 漂移**（新增 provider 时测试不会自动纳入）；
 *  ② 真正的判据不是「逐个 id 检查」，而是**下面那条不变式**
 *     （弹窗判据 ⟺ 载荷带渠道），它对**任意** id 都成立，不需要枚举。
 *
 * 保留遍历仍然有价值（能把「某个具体 provider 被误判」指名道姓地报出来），
 * 但样本必须来自真源。
 *
 * ⚠️ 2026-10-08：真源从「解析 `jet-hub.js` 的 `PROVIDERS` 源码文本」改为
 * **直接读 `PROVIDER_REGISTRY`** —— 客户端 `PROVIDERS` 现在就是由它派生的。
 * 原先那个正则 `\bid:\s*'([a-z0-9]+)'` 同样是「从源码文本派生判据」的形态
 *（本 Task 要消除的东西），且它会随 `PROVIDERS` 改为 `.map()` 而整份套件
 * 变成 Failed Suite。
 */
function readProviderIds (): string[] {
  const ids = PROVIDER_REGISTRY.map((d) => d.id)
  // ⚠ 取不到会得到空数组，而「遍历空数组」的断言**照样全绿** ——
  //   那是本轮最危险的一种假绿（比缺测试更坏：看起来测了，其实没测）。
  //   故显式设一道数量下限，真源一失配就立刻红。
  if (ids.length < 10) throw new Error(`PROVIDER_REGISTRY 只解析出 ${ids.length} 个 id，真源大概率已失配`)
  return ids
}

const PROVIDER_IDS = readProviderIds()

/**
 * 载荷里**专属字段**的完整清单（每个「需要预选」的 provider 各占一个）。
 *
 * ⚠️ 加新 provider 时**这里也要加** —— 与 `new-account.js` 的两个函数一样，
 * 它同样是「必须同步」的第三处。漏了它，下面那条不变式会**退化成**
 * 只检查旧字段，新 provider 的载荷字段无人守（正是本组要防的形态）。
 */
// ⚠️ 2026-10-17 合并后有**四个**专属字段（astudio 与 autoclaw 各一）——
//    判据「恰好一个」正是「两家的字段不得互相串台」的那道闸门。
// ⚠️ **marvis 不在这个表里**（2026-11-09 真机报障）：它的登录方式是 QQ / 微信，
//    但选择 UI 是它**自己的** `MarvisLoginModal`（`createAccount` 里那条独立
//    `if (provider === 'marvis')` 早退打开），根本不经过本文件的载荷函数。
//    曾经加进来过，结果它同时进了 ZCode 的渠道白名单 ⇒ 点「+ 新建账号」弹的是
//    「添加 ZCode 账号」+ cn BigModel / z.ai（用户截图实证）。
const EXCLUSIVE_FIELDS = ['zcodeProvider', 'accioRegion', 'astudioLoginMethod', 'autoclawMode']

/**
 * 载荷里带了哪些专属字段（0 个 / 1 个 / 多个）。
 *
 * ⚠️ 返回值是**数组**而不是布尔：不变式要判的是「**恰好一个**」，
 * 布尔表达不了「两个都带」这种串味。
 */
function exclusiveFieldsOf (payload: Record<string, unknown>): string[] {
  return EXCLUSIVE_FIELDS.filter((f) => Object.prototype.hasOwnProperty.call(payload, f))
}

/**
 * ⚠ **合成探针 id**：真实 `PROVIDERS` 里**还没有**、但将来很可能出现的新 provider 名。
 *
 * ## 为什么需要它们（本轮两次踩坑才想清楚）
 *
 * 只遍历 `PROVIDERS` 是**抓不到**「新增 provider 忘了改另一处」的 ——
 * 新 provider 此刻**恰恰还不在列表里**，遍历永远轮不到它。
 * （第一版我以为「不变式对任意 id 成立所以不用枚举」，实测变异全绿，
 * 证明那个想法是错的：不变式仍然是**逐个 id 求值**的，样本从哪来很关键。）
 *
 * 所以把「将来可能出现的名字」也放进样本：只要实现里出现了对某个合成名的
 * 特殊分支，而另一处没有，这条就会对不上。
 *
 * ⚠⚠ **覆盖上限要说清楚**：它**不是**保证。若将来新增的 provider 叫
 * `tencent-hunyuan` 这种探针里没有的名字，且只改了一处，仍会漏。
 * 它抓到的是**最常见的形态**（随手起个 `newbie` / `new-provider` /
 * 改一个字）—— 这类漏网的真正防线仍是 `new-account.js` 里那条
 * 「将来新增 provider，两个函数都要看」的注释。**测试与注释各挡一层，
 * 没有任何一层是完备的。**
 */
const PROBE_IDS = ['newbie', 'new-provider', 'zzz', 'some-future-provider', 'codearts2']

describe('A. 「+ 新建账号」必须按 provider 分支（IKJLK3 A1/A2/A3）', () => {
  /**
   * ★★ **本组的核心不变式**：对每个样本 id，
   * 「弹窗问预选项」⟺「载荷带**恰好一个**专属字段」。
   *
   * ## 为什么它比逐个枚举更强
   *
   * `newAccountAsksChannel`（白名单）与 `buildCreateAccountPayload`（排除法）
   * **判据方向相反**，这是刻意的独立性设计（提单人 review 时确认保留），
   * 代价就是**将来新增 provider 时容易只改一处**。本条把「两处必须同步」
   * 变成可执行判据：**只改任一处，另一处立刻对不上，红。**
   *
   * ⚠ 样本 = 真实 `PROVIDERS` ∪ 合成探针。**只有真实列表是不够的**
   * （新增 provider 那一刻它还不在列表里），见上面 `PROBE_IDS` 的说明。
   *
   * ⚠️ 「恰好一个」而不是「至少一个」：后者放过「accio 的载荷里同时带了
   * `zcodeProvider`」这种串味（后端会拿它去开错授权端点）。
   */
  it('★★ 不变式：弹窗判据 ⟺ 载荷带恰好一个专属字段（真实 provider + 合成探针）', () => {
    for (const id of [...PROVIDER_IDS, ...PROBE_IDS]) {
      const asks = newAccountAsksChannel(id)
      const fields = exclusiveFieldsOf(buildCreateAccountPayload(id, 'zai', 'global') as Record<string, unknown>)
      const has = fields.length === 1
      expect(asks, `${id}：弹窗判据(${asks}) 与载荷专属字段(${JSON.stringify(fields)}) 不一致 —— 将来新增 provider 时两处都要改`).toBe(has)
    }
  })

  it('★ 只有 zcode / accio / astudio / autoclaw / autoclawintl 走渠道弹窗，其余点按钮即登录', () => {
    expect(newAccountAsksChannel('zcode')).toBe(true)
    // ⚠ accio 的预选项是**登录区域**：区域决定登录页域名，而区域由服务端按账号
    //   下发、登录前无从推断 ⇒ 选错就登不进去（国际用户拿中国版登录页）。
    expect(newAccountAsksChannel('accio')).toBe(true)
    expect(newAccountAsksChannel('astudio')).toBe(true)
    expect(newAccountAsksChannel('autoclaw')).toBe(true)
    // ⚠️ autoclawintl（2026-10-20）：与国内版**同样需要预选**（一键导入 / 短信），
    //    且它读的是**不同的 userData 目录** ⇒ 漏判会让它静默走短信分支。
    expect(newAccountAsksChannel('autoclawintl')).toBe(true)
    // ⚠️⚠️ **marvis 必须是 false**（2026-11-09 真机报障，用户截图）：
    //    它确实要选 QQ / 微信，但那个选择框是**它自己的** `MarvisLoginModal`
    //    （`createAccount` 的独立早退分支打开的）。加进本白名单的唯一后果是
    //    点「+ 新建账号」弹出 **ZCode 的渠道弹窗**（cn BigModel / z.ai）——
    //    两个选项对 marvis 都是死值，且用户看到的标题是「添加 ZCode 账号」。
    expect(newAccountAsksChannel('marvis')).toBe(false)
    // ⚠ 这条对**全部** provider 取一遍：A1 的形态是「弹窗对 provider 零分支」，
    //   只抽查两三个 provider 的话，新增一个 provider 漏判就会静默溜过去。
    for (const id of PROVIDER_IDS) {
      if (id === 'zcode' || id === 'accio' || id === 'astudio'
        || id === 'autoclaw' || id === 'autoclawintl') continue
      expect(newAccountAsksChannel(id), `${id} 不该弹预选窗`).toBe(false)
    }
  })

  it('★ opencode 也不弹（它的登录入口是 API key 表单，不是渠道下拉）', () => {
    // A3 的核心：opencode 原先要点「+ 新建账号」先过一遍 ZCode 弹窗，
    // 点「确定」才看到自己的 API key 输入框。判据必须把它一起排除。
    expect(newAccountAsksChannel('opencode')).toBe(false)
  })

  it('未知/空 provider 走默认路径（不弹窗）—— 失败方向是安全的', () => {
    // 新增 provider 时若忘了改这里，后果是「少问一次」而不是「弹错窗」。
    expect(newAccountAsksChannel('some-new-provider')).toBe(false)
    expect(newAccountAsksChannel('')).toBe(false)
    expect(newAccountAsksChannel(undefined as unknown as string)).toBe(false)
  })

  it('★ 不需要预选的 provider 载荷里**不许**出现任何专属字段（A2：选择被静默丢弃）', () => {
    for (const id of PROVIDER_IDS) {
      if (id === 'zcode' || id === 'accio' || id === 'astudio'
        || id === 'autoclaw' || id === 'autoclawintl') continue
      const payload = buildCreateAccountPayload(id, 'zai', 'global')
      expect(payload).toEqual({ provider: id })
      expect(exclusiveFieldsOf(payload as Record<string, unknown>)).toEqual([])
    }
  })

  it('★ autoclaw 的载荷带上登录模式', () => {
    expect(buildCreateAccountPayload('autoclaw', undefined, undefined, undefined, 'local')).toEqual({ provider: 'autoclaw', autoclawMode: 'local' })
    expect(buildCreateAccountPayload('autoclaw', undefined, undefined, undefined, 'sms')).toEqual({ provider: 'autoclaw', autoclawMode: 'sms' })
    // ⚠️ 2026-10-20 加 autoclawintl：与 autoclaw **同一归一逻辑**，载荷必须同样带
    //    `autoclawMode`，否则国际版会丢掉导入模式并静默走短信分支
    //    （读国内目录 ⇒ 国内凭据进国际槽位，用户重演两次的事故）。
    expect(buildCreateAccountPayload('autoclawintl', undefined, undefined, undefined, 'local'))
      .toEqual({ provider: 'autoclawintl', autoclawMode: 'local' })
    expect(buildCreateAccountPayload('autoclawintl', undefined, undefined, undefined, 'sms'))
      .toEqual({ provider: 'autoclawintl', autoclawMode: 'sms' })
  })

  it('★★ marvis 的载荷**不带任何**专属字段（登录方式由它自己的弹窗传）', () => {
    // ⚠️ 这一格就是 2026-11-09 真机报障的回归守卫：marvis 一旦在这里产出
    //    `marvisLoginType`，就说明有人把它又加回了渠道白名单 —— 而那条白名单
    //    驱动的是 **ZCode 弹窗**（用户会看到「添加 ZCode 账号」+ cn BigModel / z.ai）。
    //    真正的登录方式由 `MarvisLoginModal` 的回调直接传给 `account.create`
    //    （`marvis-client-panel.spec.ts` 里以源码断言守着那两处调用）。
    expect(buildCreateAccountPayload('marvis')).toEqual({ provider: 'marvis' })
    expect(buildCreateAccountPayload('marvis', 'zai', 'global')).toEqual({ provider: 'marvis' })
  })

  it('★ astudio 与 autoclaw 的登录方式**互不串台**（2026-10-17 合并引入的真实风险）', () => {
    // 合并前两侧各自给同一位置参数（都是第 4 位）起了名：astudio 叫
    // `astudioLoginMethod`、autoclaw 叫 `autoclawMode`。若把两者并成一个形参，
    // 「A 家选了本机导入」的值会被发给 B 家 —— **两家各自都看起来传对了**，
    // 且载荷里只多/少一个键，肉眼极难发现。
    // ⚠️ 宿主 `account.create` 分别读 `payload.astudioLoginMethod` 与
    //    `payload.autoclawMode`，串台后拿到的是**对方不认识的键** ⇒ 静默回落默认值。
    expect(buildCreateAccountPayload('astudio', undefined, undefined, 'web'))
      .toEqual({ provider: 'astudio', astudioLoginMethod: 'web' })
    expect(buildCreateAccountPayload('astudio', undefined, undefined, 'local'))
      .toEqual({ provider: 'astudio', astudioLoginMethod: 'local' })
    // 反向：把 autoclaw 的值塞进 astudio 的位置，不得影响 astudio 的载荷。
    expect(buildCreateAccountPayload('astudio', undefined, undefined, undefined, 'sms'))
      .toEqual({ provider: 'astudio', astudioLoginMethod: 'local' })
    // 反向：把 astudio 的值塞进 autoclaw 的位置，不得影响 autoclaw 的载荷。
    expect(buildCreateAccountPayload('autoclaw', undefined, undefined, 'web'))
      .toEqual({ provider: 'autoclaw', autoclawMode: 'local' })
    // 「恰好一个专属字段」这条不变式本身就覆盖串台：两个都发出去即红。
    for (const [p, a, m] of [
      ['astudio', 'web', 'sms'],
      ['autoclaw', 'web', 'sms'],
    ] as const) {
      const payload = buildCreateAccountPayload(p, undefined, undefined, a, m)
      expect(exclusiveFieldsOf(payload as Record<string, unknown>)).toHaveLength(1)
    }
  })

  it('★ zcode 的载荷带上渠道（这是它唯一一次选择的落点）', () => {
    expect(buildCreateAccountPayload('zcode', 'zai')).toEqual({ provider: 'zcode', zcodeProvider: 'zai' })
    expect(buildCreateAccountPayload('zcode', 'bigmodel')).toEqual({ provider: 'zcode', zcodeProvider: 'bigmodel' })
  })

  it('★ 接线：按钮的 onClick 走判据，弹窗渲染处也有防御判据', () => {
    // 光有纯函数不够 —— 有人把按钮改回 `() => setPendingLogin(false)`，
    // 判据还在但没人调用，缺陷原样复现。这条就是守「接上了」。
    const click = jetHubCode.match(/onClick: \(\) => \{\s*if \(newAccountAsksChannel\(provider\)\)[^}]*\}/)
    expect(click, '新建账号按钮必须先问 newAccountAsksChannel').not.toBeNull()
    // 弹窗渲染处的防御判据（正常路径走不到，但状态是活的）。
    expect(jetHubCode).toMatch(/!newAccountAsksChannel\(provider\)\s*\?\s*null\s*:\s*React\.createElement/)
  })

  it('★ account.create 的载荷由纯函数构造（不是就地拼的三元）', () => {
    // ⚠️ `stripComments` 之后再断言：上面那段解释「为什么要用纯函数」的注释里
    //    就写着 `rpcCall('account.create', buildCreateAccountPayload(`，
    //    对整份源码断言会被**注释**喂绿（本文件头已警告过这个形态）。
    // ⚠️ 用 `[\s\S]` 而不是 `toContain`：调用点跨行（`rpcCall('account.create',`
    //    与构造器分两行），写死整串会假失败。
    expect(jetHubCode, 'account.create 的载荷必须由纯函数构造')
      .toMatch(/rpcCall\('account\.create',\s*buildCreateAccountPayload\(/)
    // ⚠️ 三个实参都要传：只传两个会让 accio 的区域**恒为 undefined** ⇒ 宿主
    //    回落到 `cn` ⇒ 国际用户静默登不进去（正是本任务要修的功能缺口）。
    expect(jetHubCode, '调用点必须把 accioRegion 一起传给载荷构造器')
      // ⚠️ 2026-10-17 合并后调用点传**五个**实参（astudioLoginMethod 与 autoclawMode
      //    各占一位）。少传任一个 ⇒ 那家的选择**恒为 undefined**、宿主静默回落默认值。
      .toMatch(/buildCreateAccountPayload\(\s*provider,\s*zcodeProvider,\s*accioRegion,\s*astudioLoginMethod,\s*autoclawMode\s*\)/)
  })
})

/**
 * ★★ accio 的**区域选择入口**（Task 8 计划项 / 终审 I2）。
 *
 * ## 为什么这一条是功能性的，不是「多一个选项」
 *
 * Accio 的登录页**按区域分域名**（`cn` → `www.accio-ai.com`，
 * `global` → `zh.accio.com`），而区域**由服务端按账号下发**（`userinfo.routeRegion`，
 * 需要先有凭据才能查）⇒ 登录前**无从推断**。缺了这个入口时，
 * `buildCreateAccountPayload` 恒不下发 `accioRegion`、宿主恒回落 `cn`
 * ⇒ **国际账号根本打不开登录页**（真实功能缺口，不是体验问题）。
 *
 * ## 为什么断言落在「两处 + 调用点」
 *
 * `new-account.js` 的注释明确警告：`newAccountAsksChannel`（白名单）与
 * `buildCreateAccountPayload`（排除法）**判据方向相反**，只改一处会静默失效。
 * 本组因此**逐处**断言，而不是只断言最终效果 —— 后者在只改一处时仍可能绿
 * （例如「弹窗没弹、载荷也没发」在效果上与「都不需要」同形）。
 */
describe('F. accio 区域选择入口（终审 I2）', () => {
  it('★ 弹窗判据把 accio 纳入白名单', () => {
    expect(newAccountAsksChannel('accio')).toBe(true)
  })

  it('★ 载荷构造把 accioRegion 下发（且**只**下发给 accio）', () => {
    expect(buildCreateAccountPayload('accio', 'bigmodel', 'global'))
      .toEqual({ provider: 'accio', accioRegion: 'global' })
    expect(buildCreateAccountPayload('accio', 'bigmodel', 'cn'))
      .toEqual({ provider: 'accio', accioRegion: 'cn' })
    // 两个专属字段**不得串味**：accio 的载荷里不能出现 zcode 的渠道。
    expect(exclusiveFieldsOf(buildCreateAccountPayload('accio', 'zai', 'global') as Record<string, unknown>))
      .toEqual(['accioRegion'])
    // 反向：zcode 的载荷里不能出现 accio 的区域。
    expect(exclusiveFieldsOf(buildCreateAccountPayload('zcode', 'zai', 'global') as Record<string, unknown>))
      .toEqual(['zcodeProvider'])
  })

  it('★ 宿主侧白名单与客户端两个选项**逐值对齐**（新增区域时三处一起改）', () => {
    // 客户端的两个 <option> 值必须都能过宿主的 `normalizeAccioRegion`，
    // 否则用户选了国际版、宿主却回落 `cn` —— 静默失效，界面看起来完全正常。
    const rpcSource = readFileSync(resolve(HERE, '../../src/jet-hub-rpc.ts'), 'utf8')
    expect(stripComments(rpcSource)).toContain('region: normalizeAccioRegion(req.accioRegion)')
    for (const region of ['cn', 'global']) {
      expect(normalizeAccioRegion(region)).toBe(region)
    }
  })

  it('★ 弹窗按 provider 分支：accio 问区域、zcode 问渠道，两者的选项都在', () => {
    // ⚠️ 先断言「分支判据本身」——**必须钉住赋值**，不能只钉 `accioDialog ?`：
    //    实测变异 `const accioDialog = false`（弹窗永不按 accio 分支）时，
    //    只断言 `accioDialog\s*\?` **照样全绿**（那个三元还在，只是永远走 else 支）。
    //    这是本仓库记过的「找不到却全绿」的同型：断言的是形态存在，不是它**求值**。
    expect(jetHubCode, '弹窗分支判据必须是 provider 驱动的正向比较')
      .toMatch(/const accioDialog = provider === 'accio';/)
    expect(jetHubCode, '弹窗内容必须按 accio 分支').toMatch(/accioDialog\s*\?/)
    // accio 的两个区域选项（值必须与宿主白名单逐字一致）。
    // ⚠️ 断言范围收在**accio 那一支**里：整份文件断言会被 zcode 的选项喂绿。
    // ⚠️ 锚点用 **accio 专属的标签文案**（`'登录区域'`），而不是 `accioDialog` ——
    //    后者第一次出现在文件靠上的 const 声明处，切出来的是一大段无关代码。
    // ⚠️ `indexOf` 的结果**必须先断言 `>= 0`** 再切片：`-1` 会让 `slice(-1)`
    //    静默切到「最后一个字符」，后续 `toContain` 于是指向一段无关文本
    //    （本仓库记过的「找不到却全绿」形态）。
    const regionAt = jetHubCode.indexOf("'登录区域'")
    expect(regionAt, '未找到 accio 的「登录区域」标签').toBeGreaterThanOrEqual(0)
    // 从标签往后切到弹窗动作区为止 —— 这一段就是 accio 的 <select> 本体。
    const actionsAt = jetHubCode.indexOf('dim-jh-zcDialogActions', regionAt)
    expect(actionsAt, '未找到弹窗动作区').toBeGreaterThan(regionAt)
    const dialogBranch = jetHubCode.slice(regionAt, actionsAt)
    expect(dialogBranch, '未切出 accio 的区域下拉').not.toBe('')
    expect(dialogBranch).toContain("value: 'cn'")
    expect(dialogBranch).toContain("value: 'global'")
    // zcode 的两个渠道选项**不得**被这次改动弄丢。
    expect(jetHubCode).toContain("value: 'bigmodel'")
    expect(jetHubCode).toContain("value: 'zai'")
    // 区域 state 与它的 setter 必须真的接在**卡片组**上（不是定义了不用）。
    // ⚠️⚠️ 2026-10-17 审计 P2 修复：原实现把功能挂在 `<select>` 上，而那里
    //   的三个 `<select>` 全部带 `style:{display:'none'}`（原生下拉在
    //   Windows/Electron 下点不开，功能已由**单选卡片组**接管）⇒ 那三个是
    //   纯**死 DOM**：不可见、`onChange` 永不触发，却仍渲染 `<option>`。
    //   现已整体删除，故守卫必须改锁**卡片组**的真实形态 ——
    //   否则它会变成「保护一个不存在的东西」，删除后仍然全绿。
    expect(jetHubCode).toMatch(/const \[accioRegion, setAccioRegion\] = React\.useState\('cn'\)/)
    expect(jetHubCode, '卡片组必须真的把 accioRegion 的 setter 接上')
      .toMatch(/onClick: \(\) => setAccioRegion\(opt\.value\)/)
    expect(jetHubCode, '卡片组必须真的把 zcodeProvider 的 setter 接上')
      .toMatch(/onClick: \(\) => setZcodeProvider\(opt\.value\)/)
    expect(jetHubCode, '卡片组必须真的把 autoclawMode 的 setter 接上')
      .toMatch(/onClick: \(\) => setAutoclawMode\(opt\.value\)/)
    // ⚠️ **反向守卫**：隐藏的死 `<select>` 不得复活（它正是本次删掉的东西）。
    expect(jetHubCode, '不得残留 display:none 的隐藏 select（纯死 DOM）')
      .not.toMatch(/className: 'dim-jh-zcSelect',\s*\n\s*style: \{ display: 'none' \}/)
  })

  it('⚠️ 区域不是「偏好」而是登录前提 —— 弹窗文案必须说清「选错会打开打不开的登录页」', () => {
    // 缺了这句，用户会以为选错了也能事后纠正；而 region 会写进凭据并决定续期域。
    expect(jetHubCode).toMatch(/区域由服务端按账号下发/)
    expect(jetHubCode).toMatch(/登录页/)
  })

  /**
   * ⚠️⚠️ **autoclaw 弹窗判据的源码锁**（2026-10-20 审计补）。
   *
   * 审计实测：把 `autoclawDialog` 改回 `provider === 'autoclaw'`（= PR 修之前
   * 的形态，国际版会弹「添加 ZCode 账号」窗），
   * `new-account-dialog` + `aggregate-panel-logic` **128 tests 全绿** ——
   * 而本文件对 `accioDialog` 的赋值是**有**源码锁的（`const accioDialog = false`
   * 会红 1 条）。⇒ 同一个文件里两条判据的守卫强度不一致，PR121 声称修好的
   * 「第 4 处漏点」实际上没有任何守卫。
   *
   * 判据必须钉**赋值**（不是 `autoclawDialog ?` 的存在）：后者在
   * `const autoclawDialog = false` 下照样匹配。
   */
  it('★ autoclaw 弹窗判据必须同时覆盖国际版（钉住赋值，不是钉三元）', () => {
    expect(
      jetHubCode,
      '★ 判据必须是 `provider === \'autoclaw\' || provider === \'autoclawintl\'`'
      + '—— 只判国内会让国际版弹「添加 ZCode 账号」窗（审计实测改坏后 128 条全绿）',
    ).toMatch(/const autoclawDialog = provider === 'autoclaw' \|\| provider === 'autoclawintl';/)
    // 弹窗内容确实按该判据分支。
    expect(jetHubCode, '弹窗内容必须按 autoclaw 分支').toMatch(/autoclawDialog\s*\?/)
  })

  /**
   * ⚠️ **国际版不得渲染短信登录**（2026-10-20 审计 P1）。
   *
   * 国际版账号是邮箱 + Z.ai OAuth 创建的、`phone` 为 null、无绑手机端点
   * ⇒ 短信必然失败且文案不指向真因。故 `sms` 选项必须受 `autoclawSmsAvailable`
   * 门控（只对国内版为 true）。
   */
  it('★ 国际版不渲染短信登录死路（sms 选项必须被 autoclawSmsAvailable 门控）', () => {
    expect(
      jetHubCode,
      '★ 必须有 autoclawSmsAvailable 且只对国内版为 true',
    ).toMatch(/const autoclawSmsAvailable = provider === 'autoclaw';/)
    expect(
      jetHubCode,
      '★ sms 选项必须受该门控 —— 否则国际版用户会选到一条必然失败的路',
    ).toMatch(/autoclawSmsAvailable[\s\S]{0,80}'sms'/)
  })
})

describe('B. 登录重入不许静默 return（IKJLK3 B）', () => {
  it('★ 早退分支必须给提示，且提示在 return 之前', () => {
    // ⚠ 必须**先定位到 createAccount**：文件里有 3 处 `pollRef.current !== 0`，
    //   另外两处在 `stopPoll` 里（`{ clearInterval(...); pollRef.current = 0 }`）。
    //   只按字面量找第一个会命中清理逻辑，得到一条与本判据无关的红。
    const createAccount = jetHubCode.indexOf('const createAccount = async () => {')
    expect(createAccount, 'createAccount 应仍是 async 函数').toBeGreaterThan(-1)
    const gate = jetHubCode.indexOf('if (pollRef.current !== 0) {', createAccount)
    expect(gate, '重入闸门应仍在 createAccount 内').toBeGreaterThan(-1)
    const untilReturn = jetHubCode.slice(gate, jetHubCode.indexOf('return', gate))
    // 修前是 `if (pollRef.current !== 0) return;` —— 视觉上「点了没反应」。
    expect(untilReturn).toContain('setProbeNotice')
  })
})

describe('D. 完整响应（含 loginUrl / OAuth state）不许打进 console（IKJLK3 D）', () => {
  it('★ 任何 console.* 的参数里都不许出现 account.create 的响应对象', () => {
    // 修前是 `console.log('[jet-hub] account.create response =', res)`。
    // loginUrl 由服务端 fetchAuthState 生成、**携带 OAuth state**，
    // 用户截图求助时会一起外泄，且在登录窗口内可被重放。
    expect(jetHubCode).not.toMatch(/console\.(log|info|warn|debug|error)\([^)]*\bres\b/)
  })

  it('日志里保留可定位的字段（provider 与本地生成的 accountId）', () => {
    expect(jetHubCode).toContain('[jet-hub] account.create ok, provider =')
  })
})

describe('E2. zcodeProvider 必须过白名单（IKJLK3 E2）', () => {
  it('两个已登记渠道原样通过', () => {
    expect(normalizeZcodeLoginProvider('bigmodel')).toBe('bigmodel')
    expect(normalizeZcodeLoginProvider('zai')).toBe('zai')
  })

  it('★ 未登记值回落到缺省渠道（原行为是原样下发 ⇒ 打到不存在的授权端点）', () => {
    // RPC 载荷没有 schema 校验，运行时任何字符串都能进到这里。
    expect(normalizeZcodeLoginProvider('ZAI')).toBe('bigmodel')   // 大小写不同也算未登记
    expect(normalizeZcodeLoginProvider('zhihu')).toBe('bigmodel')
    expect(normalizeZcodeLoginProvider('')).toBe('bigmodel')
    expect(normalizeZcodeLoginProvider('bigmodel ')).toBe('bigmodel')  // 多一个尾随空格也回落
  })

  it('缺省（老客户端不传该字段）仍是 bigmodel，既有行为不变', () => {
    expect(normalizeZcodeLoginProvider(undefined)).toBe('bigmodel')
  })

  it('★ account.create 调用点走的是归一函数，不是 `?? \'bigmodel\'`', () => {
    const rpcSource = readFileSync(resolve(HERE, '../../src/jet-hub-rpc.ts'), 'utf8')
    const code = stripComments(rpcSource)
    expect(code).toContain('provider: normalizeZcodeLoginProvider(req.zcodeProvider)')
    expect(code).not.toMatch(/provider: req\.zcodeProvider \?\? 'bigmodel'/)
  })
})

/**
 * ## 反向验证（本轮逐条改坏后**实跑**的结果）
 *
 * | 变异 | 变红 | 说明 |
 * |---|---|---|
 * | ① `newAccountAsksChannel` 改成 `return true`（退回「弹窗对 provider 零分支」） | A 组「只有 zcode 需要先问」+「opencode 也不弹」+「未知/空 provider」共 **3 条** | 只改纯函数就能抓住 A1/A3 的语义，不必动组件 |
 * | ② `buildCreateAccountPayload` 去掉 `provider !== 'zcode'` 早退 | A 组「非 zcode 的载荷」**1 条** | A2 |
 * | ③ 按钮 `onClick` 改回 `() => setPendingLogin(false)` | A 组「接线」**1 条** | 判据还在但没人调用 —— 这条就是守这个 |
 * | ④ 弹窗渲染处去掉 `!newAccountAsksChannel(provider) &&` | A 组「接线」**1 条** | ③ ④ 共用一条断言：任一处退化都会红 |
 * | ⑤ 重入闸门改回 `if (pollRef.current !== 0) return;` | B 组**1 条** | |
 * | ⑥ 恢复 `console.log(..., res)` | D 组**2 条** | 第 2 条（保留可定位字段）一并红 |
 * | ⑦ `normalizeZcodeLoginProvider` 直接 `return raw as ZcodeLoginProvider` | E2 组「未登记值回落」+「缺省仍是 bigmodel」共 **2 条** | ⚠ 红的第二组是「缺省」而非「已登记值」：透传后连 `undefined` 都不再回落成 `bigmodel`，这才是去掉白名单的真正后果 |
 * | ⑧ 调用点改回 `provider: req.zcodeProvider ?? 'bigmodel'` | E2 组「调用点走归一函数」**1 条** | |
 * | ⑨ **只改弹窗判据**：`\|\| provider === 'newbie'`，载荷没跟上 | 不变式**1 条** | 见下方「两次踩坑」 |
 * | ⑩ **只改载荷**：`&& provider !== 'newbie'`，弹窗没跟上 | 不变式**1 条** | ⑨⑩ 合起来守「两处必须同步」 |
 *
 * ### ⚠ ⑨⑩ 之前失败过两轮 —— 记下来，别重复
 *
 * 变异 ⑨（只改弹窗判据）第一次跑是 **14 条全绿**。两次错法：
 *
 * 1. **第一版**：遍历样本是**手写的硬编码 provider 列表**。`newbie` 不在里面，
 *    测试压根没走到它。⇒ 已改成从 `jet-hub.js` 真读 `PROVIDERS`。
 * 2. **第二版**：改成了「不变式对**任意** id 成立，不依赖列表」——
 *    **这句话是错的**。不变式仍是**逐个 id 求值**的，而新 provider 此刻
 *    **恰恰还不在 `PROVIDERS` 里**，遍历永远轮不到它。第二次跑仍全绿。
 *    ⇒ 已改为样本 = 真实 `PROVIDERS` ∪ 合成探针 id（`PROBE_IDS`）。
 *
 * ⚠ 教训：**「不依赖枚举」不等于「不需要枚举」** —— 只要判据是逐样本求值，
 * 样本从哪来就是决定性的。又一次印证「断言写对了却拦不住回归更常见」。
 *
 * ⚠ 探针的**覆盖上限是明说的**：新增 provider 叫 `tencent-hunyuan` 这类
 * 探针外的名字且只改一处，仍会漏。真正的第二道防线是 `new-account.js` 里
 * 「将来新增 provider，两个函数都要看」那段注释。**两层都不完备，别指望单靠测试。**
 */
