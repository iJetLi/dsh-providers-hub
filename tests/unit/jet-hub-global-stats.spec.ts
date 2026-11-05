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
    expect(supportsCreditBalance('chatglm')).toBe(true)
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
})
