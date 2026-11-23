/**
 * ★★★ **两个设置不能互相抹掉**（2026-11-24 用户报障，真缺陷）。
 *
 * ## 用户原话
 *
 * > 「档次窗口中，只要在模型下拉框重新选择模型了，点击保存后，
 * >   档次窗口中的短期和临期天数就会自动回归默认」
 *
 * ## 根因（两层，必须同时修）
 *
 * | 层 | 问题 |
 * |---|---|
 * | RPC `credits.window.set` | 只改模型时两个天数都是 `undefined` ⇒ `next === undefined` ⇒ **仍调用了** `setCreditWindow(undefined)` |
 * | `AccountPool.setCreditWindow` | 收到 `undefined` ⇒ 走「恢复默认」⇒ **`delete next[provider]`** ⇒ 整条记录没了 |
 *
 * ⚠️ 隐蔽之处：`setCreditWindow` 删键时连带把**同一次请求刚写入的**
 * `subagent` 也删掉 —— 两个功能互相踩，且**零报错**。
 *
 * ## 为什么本文件测的是源码而非行为
 *
 * `AccountPool` 需要完整 ctx + store 才能实例化，单测里造不出来。
 * ⇒ 用**源码锚点**固定「保留 subagent」这条判据（本仓对装配层的一贯做法），
 * 并在注释里写明为什么不能行为级测。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const poolSrc = readFileSync(join(here, '../../src/account-pool.ts'), 'utf8')
const rpcSrc = readFileSync(join(here, '../../src/jet-hub-rpc.ts'), 'utf8')

/** 剥掉注释行（判据必须打在**代码**上，不能命中说明文字）。 */
const stripComments = (text: string): string =>
  text
    .split('\n')
    .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
    .join('\n')

describe('setCreditWindow 必须保留 subagent', () => {
  const code = stripComments(poolSrc)

  it('★★★ 恢复默认分支：有 subagent 时**只删天数、保留 subagent**', () => {
    /**
     * ⚠️ 本文件里有 **11 处** `delete next[provider]`（别的函数也删键），
     * ⇒ 必须先把窗口限定在 `setCreditWindow` 函数体内再找。
     *
     * ⚠️⚠️ 判据用**逐行结构**而不是大窗口正则：变量 `existingSubagent`
     * 在函数里被引用多次，用「窗口内出现过」会**假绿**
     *（我第一版就这么漏的 —— 变异删掉分支、变量声明还在，测试照样通过）。
     *
     * ⇒ 断言三件事（缺一不可）：
     * 1. 存在 `if (existingSubagent !== undefined) {` 且体内**写回** subagent；
     * 2. 紧跟一个 `} else {`；
     * 3. `delete next[provider]` 在**那个 else 体内**。
     */
    const fnStart = code.indexOf('async setCreditWindow(')
    expect(fnStart, '找不到 setCreditWindow').toBeGreaterThan(-1)
    const fnEnd = code.indexOf('async setSubagentRotation(', fnStart)
    expect(fnEnd).toBeGreaterThan(fnStart)
    const body = code.slice(fnStart, fnEnd)

    const lines = body.split('\n')
    const guardIdx = lines.findIndex((l) => l.includes('if (existingSubagent !== undefined) {'))
    expect(guardIdx, '★★★ 找不到「有 subagent 则保留」的分支').toBeGreaterThan(-1)

    /** ① 该分支体内必须写回 subagent。 */
    expect(
      lines[guardIdx + 1] ?? '',
      '★★★ 保留分支必须真的写回 subagent',
    ).toContain('subagent: existingSubagent')

    /** ② 紧跟 `} else {`。 */
    const elseIdx = lines.findIndex((l, i) => i > guardIdx && l.trim() === '} else {')
    expect(elseIdx, '★★★ 保留分支后面必须是 else').toBeGreaterThan(guardIdx)

    /** ③ delete 必须落在这个 else 体内（即 else 之后、且缩进比 else 深）。 */
    const deleteIdx = lines.findIndex((l, i) => i > elseIdx && l.includes('delete next[provider]'))
    expect(deleteIdx, '★★★ else 体内必须有删键').toBeGreaterThan(elseIdx)

    /** ④ 再往后必须是 else 的收尾 `}`（证明 delete 确实在体内，不是跑出去了）。 */
    const closeIdx = lines.findIndex((l, i) => i > deleteIdx && l.trim() === '}')
    expect(closeIdx, '★★★ 删键之后必须有 else 的收尾').toBeGreaterThan(deleteIdx)
  })
  it('★★★ 正常写入分支也必须带上 subagent（否则改天数会抹掉它）', () => {
    /**
     * 判据：`next[provider] = { ... }` 里必须有 `subagent: existingSubagent`。
     */
    const writeIdx = code.indexOf('existingSubagent === undefined ? {} : { subagent: existingSubagent }')
    expect(
      writeIdx,
      '★★★ 写窗口天数时漏了 subagent ⇒ 改天数会静默抹掉子代理设置',
    ).toBeGreaterThan(-1)
  })

  it('★★ 读取 existingSubagent 必须在 `next` 拷贝之后（否则读到旧表）', () => {
    const copyIdx = code.indexOf('const next: CreditWindowMap = { ...this.creditWindowCache }')
    const readIdx = code.indexOf('const existingSubagent = next[provider]?.subagent')
    expect(copyIdx).toBeGreaterThan(-1)
    expect(readIdx).toBeGreaterThan(copyIdx)
  })
})

describe('credits.window.set 不能空调用 setCreditWindow', () => {
  const code = stripComments(rpcSrc)

  it('★★★ 只改子代理时**不碰**窗口天数，但「恢复默认」仍能删键', () => {
    /**
     * ⚠️ **两种「两个天数都不传」必须区分**（2026-11-24 真缺陷）：
     *
     * | 请求形状 | 意图 | 动作 |
     * |---|---|---|
     * | 只有 `provider` | 恢复默认 | 删键（既有契约，不能破坏）|
     * | `provider` + `subagent` | 只改子代理 | **完全不碰窗口天数** |
     *
     * ⚠️ 判据必须是「本次请求**是否带了 `subagent` 键**」，
     * 不能用「池里当前有没有 subagent」（那是服务端状态，与意图无关）。
     */
    expect(
      code,
      '★★★ 必须识别「本次请求带了 subagent 键」',
    ).toContain('const hasSubagentKey = req.subagent !== undefined')

    expect(
      code,
      '★★★ 调用必须同时受 next 与 hasSubagentKey 约束',
    ).toMatch(/if \(next !== undefined \|\| !hasSubagentKey\)/)

    /**
     * ⚠️ 反向对照：不能写成 `if (next !== undefined)` ——
     * 那会破坏「只有 provider ⇒ 恢复默认」这条既有契约
     *（`credit-window-rpc-contract.spec.ts` 的用例会红）。
     */
    expect(
      code,
      '★★★ 不能无条件跳过 undefined（那会破坏「恢复默认」契约）',
    ).not.toMatch(/if \(next !== undefined\)\s*\{/)
  })

  it('★★ setSubagentRotation 不做同样的错误（它保留天数）', () => {
    const subCode = stripComments(poolSrc)
    expect(
      subCode,
      'setSubagentRotation 必须保留 windowDays/imminentDays',
    ).toContain('next[provider] = { ...(current ?? {}), subagent: clean }')
  })
})
