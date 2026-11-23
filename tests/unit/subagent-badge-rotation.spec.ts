/**
 * ★★★ **子代理对话页面的积分胶囊要显示它实际用的账号**
 *（2026-11-24 用户需求）。
 *
 * ## 用户原话
 *
 * > 「我想知道，可以做到在打开子代理对话页面时，下面积分胶囊可以做到：
 * >   子代理被拉起时是哪个帐号拉起的，积分胶囊就显示哪个帐号吗？
 * >   ……我想要子代理对话页面，达到跟主代理对话页面一样的效果，
 * >   从页面就能看出这个对话是跟哪个帐号在进行的」
 *
 * ## 缺陷形态
 *
 * `preferredRotation` 是**按 sessionId 单独配置**的表 —— 用户只会在**主代理**
 * 会话里选起点，子代理的 sessionId **永远不在那张表里**
 * ⇒ `preferredRotationFor()` 返回 `undefined` ⇒ 胶囊恒显示「默认」。
 *
 * ## 本文件测什么
 *
 * `account.getRotation` 里 `selectedId` 的取法必须**优先用子代理的 pin**。
 * ⚠️ 这是装配层（需要 pool + ctx），单测造不出来 ⇒ 用源码锚点固定，
 * 与 `subagent-creditwindow-preserve.spec.ts` 同款做法。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const rpcSrc = readFileSync(join(here, '../../src/jet-hub-rpc.ts'), 'utf8')
const rpcRaw = rpcSrc
const badgeSrc = readFileSync(join(here, '../../plugin-src/client/usage-badge.js'), 'utf8')

const stripComments = (text: string): string =>
  text
    .split('\n')
    .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
    .join('\n')

/** 取 `account.getRotation` 函数体（到下一个 `case '` 为止）。 */
function rotationBody(): string {
  const code = stripComments(rpcSrc)
  const start = code.indexOf("case 'account.getRotation'")
  expect(start, '找不到 account.getRotation').toBeGreaterThan(-1)
  const end = code.indexOf("case '", start + 10)
  expect(end, '找不到下一个 case').toBeGreaterThan(start)
  return code.slice(start, end)
}

describe('子代理会话必须显示实际使用的账号位次', () => {
  it('★★★ selectedId 必须优先取子代理的 pinnedAccountId', () => {
    const body = rotationBody()
    expect(
      body,
      '★★★ 必须读 pinnedAccountId（否则子代理恒显示「默认」）',
    ).toContain('subagentAssignmentOf')
    expect(body).toContain('pinnedAccountId')
  })

  it('★★★ pin 优先于 preferredRotationFor（三态判据）', () => {
    /**
     * 判据：`selectedId` 的赋值必须写成
     * `pin !== undefined ? pin : (preferredRotationFor(...) ?? null)`。
     *
     * ⚠️ 顺序不能反：若先走 `preferredRotationFor`，子代理场景拿到的
     * `undefined` 会短路掉 pin 的判断（虽然 `??` 能兜，但语义不对 ——
     * 「用户给它选的起点」不该盖过「它实际在用的号」）。
     */
    const body = rotationBody()
    expect(
      body,
      '★★★ 必须是「pin 优先，否则退回 preferredRotationFor」',
    ).toMatch(/const selectedId = subagentPin !== undefined\s*\n\s*\?\s*subagentPin\s*\n\s*:\s*\(pool\.preferredRotationFor/)
  })

  it('★★★ 只读不写：不能把 pin 写进 preferredRotation', () => {
    /**
     * ⚠️ 若把「自动分配的号」写进 `preferredRotation` 表，
     * 就污染成了「用户选择」—— 下次主代理打开下拉框会看到一个它没选过的值。
     */
    const body = rotationBody()
    expect(
      body,
      '★★★ 本端点不得写 preferredRotation',
    ).not.toContain('setPreferredRotation')
  })

  it('★★ 位次仍从 mine（只数启用账号）现算 —— 与下拉框同口径', () => {
    const body = rotationBody()
    expect(
      body,
      '★★ 位次必须按 mine 的索引算（1-based），否则与下拉框错位',
    ).toContain('index + 1')
  })
})

describe('胶囊渲染已支持「位次 N」', () => {


  it('★★ selectedPosition 是数字 ⇒ 渲染「位次 N」', () => {
    expect(
      badgeSrc,
      '★★ 胶囊必须已有「位次 N」这一态（本改动只改服务端，不动渲染）',
    ).toContain('`位次 ${rotationState.selectedPosition}`')
  })

  it('★★ selectedPosition 为 null ⇒ 渲染「默认」', () => {
    expect(badgeSrc).toContain("'默认'")
  })
})

/**
 * ★★★ **方案 B：胶囊显示 `位次 3 · 陈水广`**（2026-11-24 用户选定）。
 *
 * 用户先提需求「从页面就能看出这个对话是跟哪个帐号在进行的」，
 * 然后在 A（只显示位次）/ B（位次 + 账号名）之间**明确选了 B**。
 *
 * ## 两处改动必须同时在
 *
 * | 位置 | 职责 |
 * |---|---|
 * | 服务端 `account.getRotation` | 下发 `selectedAccountName`（那里才有 enrich 补全链路）|
 * | 客户端 `usage-badge.js` | 渲染 `位次 N · 名字`；取不到名字只显示 `位次 N` |
 *
 * ⚠️ 只改一边的症状：
 * - 只改服务端 ⇒ 客户端不认这个字段，**什么都不显示**（用户以为没生效）；
 * - 只改客户端 ⇒ 字段恒 `undefined`，**永远只显示位次**（看起来像没实现）。
 */
describe('方案 B：位次 + 账号名', () => {
  it('★★★ 服务端必须**真的把** selectedAccountName 放进返回值', () => {
    /**
     * ⚠️ 判据不能是「文件里出现过这个词」—— 变量声明还在、但返回值里
     * 不带它时，`toContain` 照样绿（我第一版就这么漏的）。
     *
     * ⇒ 必须断言**返回值构造**里有 `selectedAccountName`。
     */
    const retIdx = rpcRaw.indexOf('return {\n          ok: true,\n          value: {')
    expect(retIdx, '找不到 getRotation 的返回构造').toBeGreaterThan(-1)
    const retBlock = rpcRaw.slice(retIdx, retIdx + 800)
    expect(
      retBlock,
      '★★★ 返回值必须带上 selectedAccountName（只声明不使用 = 客户端拿不到）',
    ).toContain('selectedAccountName')
  })

  it('★★★ 名字必须来自 enrich 后的列表（不是原始 nickname）', () => {
    /**
     * ⚠️ 判据：`selectedAccountName` 的计算必须在 `enriched` 之后，
     * 且 find 的是 `enriched` 而非 `mine`。
     *
     * 用 `mine` 会拿到 codearts 的池 id（`codearts-b3076aa8` 那种）——
     * 正好是既有注释里记过的缺陷形态。
     */
    const enrichIdx = rpcRaw.indexOf('const enriched = await enrichAccountIdentity(')
    const nameIdx = rpcRaw.indexOf('const selectedAccountName =')
    expect(enrichIdx, '找不到 enrich 调用').toBeGreaterThan(-1)
    expect(nameIdx, '找不到 selectedAccountName 计算').toBeGreaterThan(enrichIdx)
    expect(
      rpcRaw.slice(nameIdx, nameIdx + 400),
      '★★★ 必须从 enriched 里找（用 mine 会拿到池 id）',
    ).toContain('enriched.find')
  })

  it('★★★ 客户端渲染必须是**三元两态**（有名字 / 无名字）', () => {
    /**
     * ⚠️ 判据不能只是「文本里出现过 `· ${...selectedAccountName}`」——
     * 把整个三元改回单态时那串仍在渲染函数里（我第一版就这么漏的）。
     *
     * ⇒ 必须断言**渲染表达式本身**是条件式的：
     * `selectedAccountName === undefined ? `位次 N` : `位次 N · 名字``
     */
    const renderIdx = badgeSrc.indexOf("rotationState.selectedAccountName === null || rotationState.selectedAccountName === undefined")
    expect(renderIdx, '★★★ 找不到两态判断').toBeGreaterThan(-1)

    /** 取该判断之后的 900 字符，必须**同时**含两个模板串（两态跨 ~600 字符）。 */
    const window = badgeSrc.slice(renderIdx, renderIdx + 900)
    expect(window, '★★★ 无名字分支必须是 `位次 N`').toMatch(/`位次 \$\{rotationState\.selectedPosition\}`/)
    expect(window, '★★★ 有名字分支必须是 `位次 N · 名字`').toMatch(/`位次 \$\{rotationState\.selectedPosition\} · \$\{rotationState\.selectedAccountName\}`/)
  })

  it('★★ 客户端 state 解析把空串归一成 null', () => {
    expect(
      badgeSrc,
      '★★ 空串必须归一成 null（否则会渲染出「位次 3 · 」带尾巴）',
    ).toContain('value.selectedAccountName.length > 0')
  })
})