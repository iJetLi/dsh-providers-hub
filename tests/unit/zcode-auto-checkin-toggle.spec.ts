import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { stripComments } from '../helpers/strip-comments.js'

/**
 * ZCode 自动签到 opt-in 开关在面板里的**接线**守卫（源码文本断言）。
 *
 * ## 为什么单独有这一个文件
 *
 * `auto-checkin.spec.ts` 里那九十多条全部打在服务端执行体上，**一条都不 import
 * `jet-hub.js`**。于是「把 `provider === 'zcode' ? ... : null` 那一行删掉」这种
 * 改法是**全绿**的 —— 而它的后果是面板上再也没有这个开关：opt-in 退化成「手改
 * JSON 文件」，功能等于没交付。本仓库为同一层已经踩过两次（见
 * `checkin-panel-wiring.spec.ts` 与 `account-toggle-badge.spec.ts` 的开头）。
 *
 * ## 为什么只能做文本断言
 *
 * react 不在本仓库依赖里，组件没法在单测里渲染（口径同 `account-toggle-badge`）。
 *
 * ## 锁的四件事
 * 1. 组件存在，且读写都走 `zcode.autoCheckin`（不是复用魔搭那条 RPC —— 复用会把
 *    默认值语义搞混，而两格的默认方向**相反**）；
 * 2. 只在 `provider === 'zcode'` 的渠道面板里渲染；
 * 3. 显示判据是 `enabled === true`：旧宿主不回字段时**必须显示为关**（写成
 *    `!== false` 会把「读不到」渲染成「已打开」，用户以为授权过了）；
 * 4. 读取/保存失败都要有提示，不许静默。
 */

function hubSource(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  // ⚠️ 本仓库源码在 Windows 上是 CRLF，多行比对前必须归一化。
  return readFileSync(resolve(here, '../../plugin-src/client/jet-hub.js'), 'utf8')
    .replace(/\r\n/g, '\n')
}

/** 剥注释后的源码（注释里写着被替代的旧文案，不剥会把自己的注释喂成假红）。 */
function hubCode(): string {
  return stripComments(hubSource())
}

/**
 * 切出 `ZcodeAutoCheckinToggle` 的函数体。
 *
 * ⚠️ 不能拿整份文件断言：同一文件里魔搭那一格长得几乎一样（`modelscope.autoCheckin`
 *    与 `checked: enabled === true` 都在），全文匹配会让「zcode 那格其实没写成」
 *    被魔搭那格喂绿。故按函数边界切。
 */
function zcodeToggleBody(): string {
  const code = hubCode()
  const start = code.indexOf('function ZcodeAutoCheckinToggle(')
  expect(start, '未找到 ZcodeAutoCheckinToggle 组件定义').toBeGreaterThan(-1)
  const next = code.indexOf('\nfunction ', start + 1)
  expect(next, 'ZcodeAutoCheckinToggle 之后找不到下一个函数边界').toBeGreaterThan(start)
  return code.slice(start, next)
}

describe('ZCode 自动签到开关的面板接线', () => {
  it('★★ 组件定义存在，读写都走 `zcode.autoCheckin`', () => {
    const body = zcodeToggleBody()
    expect(body.match(/'zcode\.autoCheckin'/g)?.length ?? 0).toBeGreaterThanOrEqual(2)
  })

  it('★★★ 不复用魔搭那条 RPC（两格默认方向相反，混用必然错一个）', () => {
    expect(zcodeToggleBody()).not.toContain('modelscope.autoCheckin')
  })

  it('★★ 只在 provider 为 zcode 的渠道面板里渲染', () => {
    const code = hubCode()
    expect(code).toContain(
      "provider === 'zcode' ? React.createElement(ZcodeAutoCheckinToggle, { rpcCall }) : null",
    )
    // 反向：魔搭那一格不许顺手把 zcode 的开关也渲染出来。
    expect(code).toContain(
      "provider === 'modelscope' ? React.createElement(ModelscopeAutoCheckinToggle, { rpcCall }) : null",
    )
  })

  it('★★ 显示判据是 `=== true`：旧宿主不回字段时显示为「关」', () => {
    const body = zcodeToggleBody()
    expect(body).toContain('checked: enabled === true')
    // `!== false` 在这里是**错**的：那一格默认开，这一格默认关。
    expect(body).not.toMatch(/checked:\s*enabled\s*!==\s*false/)
  })

  it('★ 读取与保存失败都要落到可见提示（不许静默成「保存成功」）', () => {
    const body = zcodeToggleBody()
    expect(body).toContain("throw new Error('服务端未返回开关状态')")
    expect(body).toContain('读取 ZCode 自动签到设置失败')
    expect(body).toContain('保存 ZCode 自动签到设置失败')
    expect(body).toContain("role: 'alert'")
  })

  it('★ tooltip 必须把「会拉起浏览器 + 按设备限流」写出来（这是 opt-in 的理由）', () => {
    const body = zcodeToggleBody()
    expect(body).toContain('浏览器')
    expect(body).toContain('设备')
  })
})
