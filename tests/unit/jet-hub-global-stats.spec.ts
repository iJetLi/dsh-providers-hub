import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

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
