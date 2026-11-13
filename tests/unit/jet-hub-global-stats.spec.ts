import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { supportsCreditBalance } from '../../plugin-src/client/credits-capabilities.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLIENT = resolve(HERE, '../../plugin-src/client')
const source = readFileSync(resolve(CLIENT, 'jet-hub.js'), 'utf8')
const styles = readFileSync(resolve(CLIENT, 'jet-hub-styles.js'), 'utf8')

/**
 * 全局统计带（页头下方「总积分 / 剩余积分 / 账号数量」三格）的守卫。
 *
 * ## 为什么单独写这个文件
 *
 * 仓库对 `plugin-src/client/*.js` 的既有验证只有两种：纯函数单测、把 jet-hub.js
 * 当**文本**读的源码级断言，二者都**不做语法解析**。2026-10-31 上游对「剪贴板
 * 三层降级」的审计结论是 `showManualCopy` **零测试覆盖**（把函数体删光测试仍全绿）。
 * 统计带是同类客户端 UI：不补守卫，删掉任一段实现都不会有任何用例变红。
 *
 * ## 判据为什么按「函数体」取，而不是全文 indexOf
 *
 * 全文文本断言的共同弱点是 `if (false)` 之类的死分支：字面量还在，行为已经没了。
 * 这里用 TypeScript AST 先**定位到指定函数的节点**，再在**该函数体的源码**上断言，
 * 于是「把实现挪到别处」「整段删掉」「包进永不执行的分支」三类改动都能被抓到。
 */

const sf = ts.createSourceFile('jet-hub.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)

/** 找 `const <name> = <箭头函数>` 的节点。 */
function arrowNamed(name) {
  let hit = null
  const walk = (node) => {
    if (hit) return
    if (
      ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.name.text === name
      && node.initializer
      && (ts.isArrowFunction(node.initializer) || ts.isCallExpression(node.initializer))
    ) {
      hit = node.initializer
      return
    }
    ts.forEachChild(node, walk)
  }
  walk(sf)
  return hit
}

/** 函数体源码（含整段 body）。找不到就返回空串，让断言自然变红而不是抛栈。 */
function bodyOf(name) {
  const node = arrowNamed(name)
  if (!node) return ''
  return source.slice(node.getStart(sf), node.getEnd())
}

/** 统计带用到的样式类名。 */
function hasStyleClass(cls) {
  return styles.includes(`.${cls} `) || styles.includes(`.${cls}{`) || styles.includes(`.${cls} {`)
}

describe('jet-hub 全局统计带', () => {
  it('① loadGlobalStats 存在，且被 useEffect 真正拉起（删掉 effect 统计带永不出数）', () => {
    const fn = bodyOf('loadGlobalStats')
    expect(fn).not.toBe('')
    expect(fn).toContain('account.list')
    expect(fn).toContain('credits.balances')
    // 真正挂到 effect 上：只定义不调用，统计带永远是 null。
    const effect = source.match(/React\.useEffect\(\(\)\s*=>\s*\{[^}]*loadGlobalStats\(\)/)
    expect(effect).not.toBeNull()
  })

  it('② 聚合视图 aggregate 不计入统计（它有账号也没积分，计入会让账号数虚高）', () => {
    const fn = bodyOf('loadGlobalStats')
    expect(fn).toMatch(/p\.id\s*!==\s*['"]aggregate['"]/)
  })

  it('③ 两段式：先出账号数、积分留 —，读数到达后再补（删掉第二段积分永远转圈）', () => {
    const fn = bodyOf('loadGlobalStats')
    const calls = fn.match(/setGlobalStats\(/g) ?? []
    expect(calls.length).toBe(2)
    // 第一段：积分未到，显式标记为 loading 而不是写 0。
    expect(fn).toContain('creditsLoading: true')
    // 第二段：读数到达，落定。
    expect(fn).toContain('creditsLoading: false')
  })

  it('④ 失效包（active === false）不计入总积分（计入会虚高，与扣减口径不一致）', () => {
    const fn = bodyOf('loadGlobalStats')
    expect(fn).toMatch(/pkg\?\.active\s*===\s*false/)
  })

  it('⑤ 单账号读取失败记 partial，不把它当 0 加进总额（否则「读不到」被读成「一分没有」）', () => {
    const fn = bodyOf('loadGlobalStats')
    // ⚠️ 判据必须锁在同一条语句里：分开断言 `!balance` 与 `partial = true` 是**无牙**的
    //    —— 实测把实现改成 `if (!balance) { continue }`（不记 partial，直接跳过）时两条
    //    各自仍成立、用例全绿。要求「失败分支同时记 partial 并 continue」才有分辨力。
    expect(fn).toMatch(/if\s*\(!balance\)\s*\{\s*partial\s*=\s*true;\s*continue\s*\}/)
    expect(fn).toContain('creditsPartial')
  })

  /**
   * ★★★ **`credits.balances` 必须按能力过滤**（2026-11-04 真实报障）。
   *
   * ## 报障现场
   *
   * 控制台每打开一次 Jet Hub 就刷一串红色：
   * ```
   * [jet-hub] global stats: credits.balances failed for qiniu:
   *   Error: unsupported provider: qiniu
   * ```
   *
   * 根因：本段原先对**全部** provider 一律发 `credits.balances`，而宿主侧
   * `creditsOf(credits, provider)` 对**没登记积分表**的渠道回 `bad-request`。
   * `qiniu` / `opencode` / `qoder` / `qodercn` / `officeace` 都在那批里
   * —— 它们的 `credits.balance: false` 是**实测能力结论**（七牛云官方无余额端点），
   * 不是漏接线。于是每个 `balance:false` 的渠道贡献一条报错。
   *
   * ## ⚠️ 判据为什么必须复用 `supportsCreditBalance`
   *
   * 与账号面板的 `canLoadCredits`（`supportsCreditBalance(provider)`）**同源**。
   * 若在这里另写一份黑名单（`p.id !== 'qiniu'`），就是本仓库「一语义两套判据」
   * 的复发形态 —— 新增 `balance:false` 的渠道时必然漏改一处。
   *
   * ## ⚠️ 这条守卫**有牙**（变异验证）
   *
   * 把 `targets.filter(p => supportsCreditBalance(p.id))` 改回 `targets`
   * ⇒ 本用例变红。⚠️ 但要注意：本文件其它用例是**源码文本**判据（`bodyOf`），
   * 所以这里的判据也必须是「文本里真的有那次 filter」，
   * 而不是「代码逻辑看起来对」—— 文本判据不会因运行时短路而假绿。
   */
  it('★★★ `credits.balances` 只对**声明了余额能力**的渠道发（否则 qiniu 等刷屏报错）', () => {
    const fn = bodyOf('loadGlobalStats')
    // ① 必须真的存在一次按能力的 filter（写成 `targets` 直传 = 报障原状）
    expect(
      fn,
      '★★★ 第二段积分必须过滤掉 `balance:false` 的渠道 —— 否则每打开一次面板'
      + '就往控制台刷每条「unsupported provider」报错（qiniu / opencode / qoder /'
      + 'qodercn / officeace 各一条）',
    ).toMatch(/filter\(\s*\(?p\)?\s*=>\s*supportsCreditBalance\(\s*p\.id\s*\)\s*\)/)
    // ② 过滤结果必须**真的用在** `credits.balances` 那一轮（不能 filter 完又退回原数组）
    //
    // ⚠️ 判据取「最后一次出现 `credits.balances` 的那段」而不是 offsets 窗口：
    //    本文件其它注释里也提到 `credits.balances`，按 index 取窗口会取到注释里的那个
    //    （实测第一版就是这么假红的）。
    // ⚠️ 判据必须锚定 `rpcCall('credits.balances'` 那一处，**不能**用
    //    `lastIndexOf('credits.balances')` —— 失败日志的文案里也有这个字面量，
    //    而它是**最后一个**出现的位置（实测第一版就取到了日志、窗口里全是 catch 分支）。
    const filteredName = fn.match(/const\s+(\w+)\s*=\s*targets\.filter\(\s*\(?p\)?\s*=>\s*supportsCreditBalance/)![1]
    const callAt = fn.indexOf("rpcCall('credits.balances'")
    expect(callAt, '必须真的调用 credits.balances').toBeGreaterThan(-1)
    const balancesBlock = fn.slice(Math.max(0, callAt - 200), callAt + 40)
    expect(
      balancesBlock,
      `本轮必须遍历 \`${filteredName}\`（过滤后的数组），不能又退回 \`targets\``,
    ).toContain(`${filteredName}.map`)
    // ③ 反向：`targets` 的**原数组**不得直接喂给 `credits.balances` 那一轮的 map
    expect(
      balancesBlock,
      '★ 不得写成 `targets.map(... rpcCall(\'credits.balances\') ...)`（那正是报障原状）',
    ).not.toMatch(/targets\.map\(/)
    // ③ 对照组：必须至少有一家 `balance:false` 的渠道存在，否则这条判据可能空跑
    expect(supportsCreditBalance('qiniu'), 'qiniu 的 balance:false 是实测结论，判据靠它区分').toBe(false)
    // ⚠️ 豆包登记 `balance: true`（它在 credits 表里 ⇒ 签到 `claim` 可用），
    //    但它**没有余额端点** ⇒ `credits.balances` 端点对它短路回
    //    `{ accounts: [] }`（`src/jet-hub-rpc.ts`），故统计带拿到空列表、
    //    `creditsPartial` 不会被它误置位。这条断言锁的就是「客户端仍会去问它」——
    //    若哪天有人把豆包的 `balance` 改 `false`，`credits.claimAll` 会回
    //    `unsupported provider` 而**签到静默失效**（见 provider-registry 那条注释）。
    expect(supportsCreditBalance('doubao'), '纯签到渠道（channel:false）但进 credits 表，对照它').toBe(true)
  })

  it('⑥ 两段 await 之后都判 mounted（卸载后 setState 会告警并可能污染已卸载组件）', () => {
    const fn = bodyOf('loadGlobalStats')
    const guards = fn.match(/mounted\.current/g) ?? []
    expect(guards.length).toBeGreaterThanOrEqual(2)
  })

  it('⑦ 渲染：数据未到不渲染整条；非数字显示 — 而不是 0', () => {
    const fn = bodyOf('renderGlobalStats')
    expect(fn).not.toBe('')
    expect(fn).toMatch(/globalStats\s*===\s*null/)
    expect(fn).toMatch(/return\s+['"]—['"]/)
  })

  it('⑧ 数值格式：整数只加千分位，带小数保留两位（整数补 .00 会被读成精度）', () => {
    const fn = bodyOf('renderGlobalStats')
    expect(fn).toContain('Number.isInteger')
    expect(fn).toMatch(/minimumFractionDigits:\s*2/)
  })

  it('⑨ 样式：统计带三格类名与窄屏折叠都在（少一个类名就是裸 DOM 掉样式）', () => {
    for (const cls of ['dim-jh-globalStats', 'dim-jh-globalStat', 'dim-jh-globalStatLabel', 'dim-jh-globalStatValue']) {
      expect(hasStyleClass(cls)).toBe(true)
    }
    // 窄屏：靠 wrap 折行，不允许横向溢出。
    expect(styles).toContain('.dim-jh-globalStats { gap: 6px')
  })

  /**
   * ★★★ **`totalKnown === false` 的包不得计入「总积分」**（2026-11-13 审计 P1）。
   *
   * ## 为什么这是 P1 而不是 P3
   *
   * 这种包的上游只下发当前余额，`CreditPackage.total` 只是 `remaining` 的**冗余拷贝**
   * （`src/credits.ts:211` 逐字写明「面板**不得**把两者并列显示 —— 否则每次消耗后都会
   * 出现 `100/100 → 98/98` 这种『分母跟着余额跑』的假读数」，用户 2026-11-05 报障）。
   * 统计带把「总积分」与「剩余积分」**并排**显示 ⇒ 只要池里有一个 `baizhi` /
   * `monkeycode` 账号，两格数字就恒等，读起来像「一分没花」，把「额度告急」这条
   * 唯一需要用户动作的信号抹掉。
   *
   * 产出点：`src/baizhi-credits.ts:419/439/459`、`src/monkeycode-credits.ts:533`。
   *
   * ⚠️ 判据为什么是「跳过」而不是「按 remaining 加」：后者会让总积分等于剩余，
   *    即报障原状；也不是「加 0」—— 那会把「不可知」写成「没有额度」。
   */
  it('★★★ totalKnown:false 的包不计入总积分（否则两格恒等 = 假分母）', () => {
    const fn = bodyOf('loadGlobalStats')
    // ① 必须真的判了这个字段（删掉 = 报障原状）
    expect(
      fn,
      '★★★ `pkg.totalKnown === false` 必须被排除在总积分求和之外 —— 这种包的 total'
      + ' 只是 remaining 的拷贝，加进去会让「总积分」恒等于「剩余积分」（假分母）',
    ).toMatch(/pkg\?\.totalKnown\s*===\s*false/)
    // ② 判据必须与 `totalCredits +=` 在**同一条 if 链**上（分开写可能先加后判）
    expect(fn).toMatch(
      /if\s*\(pkg\?\.totalKnown\s*===\s*false\)\s*\{\s*totalUnknown\s*=\s*true;\s*continue\s*\}/,
    )
    // ③ 跳过之后必须**真的把 totalCredits 的累加放在后面**（否则等于没跳过）
    const skipAt = fn.indexOf('totalUnknown = true')
    const addAt = fn.indexOf('totalCredits +=')
    expect(skipAt).toBeGreaterThan(-1)
    expect(addAt, 'totalCredits 的累加必须在跳过分支之后').toBeGreaterThan(skipAt)
    // ④ 渲染侧：不可知时整格退化成 —（不能显示一个半成品数字）
    const render = bodyOf('renderGlobalStats')
    expect(render).toMatch(/globalStats\.totalUnknown\s*===\s*true\s*\?\s*null\s*:\s*globalStats\.totalCredits/)
  })

  /**
   * ★★ **`creditsPartial` 必须真的被渲染出来**（2026-11-13 审计 P2）。
   *
   * 原实现把 `creditsPartial` 写进 state 却**从不读取** —— 设计注释承诺的
   * 「任一 provider 失败只让它记 0 并标记 `creditsPartial`」在 UI 上完全没有出口，
   * 用户看到的是一格**静默偏小**的剩余积分（与「真就这么少」同形）。
   *
   * ⚠️ 判据必须落在**渲染**上：只断言 `setGlobalStats` 里传了 `creditsPartial`
   *    是无牙的（写入 ≠ 展示），实测原实现在这条断言下全绿。
   */
  it('★★ creditsPartial 有渲染出口（只写不读 = 静默偏小）', () => {
    const render = bodyOf('renderGlobalStats')
    expect(
      render,
      '★★ `creditsPartial` 必须在渲染里被读（tone 或 title），否则「部分失败」对用户'
      + ' 完全不可见，读数看起来像「真就这么少」',
    ).toMatch(/globalStats\.creditsPartial\s*===\s*true/)
    // 出口 ①：tone 必须**真的**切到 warn（颜色变化；写成常量 'ok' 时用户看不出差别）。
    expect(
      render,
      "★★ 部分失败时「剩余积分」的 tone 必须切到 'warn'（否则读数和「全读到了」同形）",
    ).toMatch(/tone:\s*globalStats\.creditsPartial\s*===\s*true\s*\?\s*'warn'\s*:\s*'ok'/)
    // 出口 ②：悬浮说明必须**真的拼进** title（`partialTitle` 定义成空串 = 文案消失，
    //         而 `creditsPartial === true` 那句仍在 ⇒ 只判前者是假绿，实测如此）。
    expect(
      render,
      '★★ 部分失败的说明必须拼进 title（`+ partialTitle`），否则悬浮里一个字都没有',
    ).toMatch(/'[^']*'\s*\+\s*partialTitle/)
    expect(render).toMatch(/const\s+partialTitle\s*=\s*globalStats\.creditsPartial\s*===\s*true/)
  })
})
