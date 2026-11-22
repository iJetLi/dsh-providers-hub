/**
 * 「新建账号时自动打开浏览器授权页」偏好的**独立文档**（2026-11-23）。
 *
 * 锁死四件事，每一件都是「用户看到功能神秘变化」的一种成因：
 *
 * ① **缺键 = 开**：文档不存在 / 损坏 / 被老版本代码整体重写时丢键，都必须回到
 *    默认开（= 本功能上线前的行为）。反过来（只认 `true`）会让任何一次读取失败
 *    都变成「新建账号不再自动跳登录页」，而用户根本没有关过它。
 * ② **显式 `false` 才关**：`'false'` 字符串、`0`、`null` 都**不是**用户意图。
 * ③ **写进去能读回来**：`save` 之后 `load` 必须变 —— 唯一能抓住「写错字段名」
 *    的判据（回退逻辑会把读不到的键当成「开」，拼错的字段名会让关闭**永久静默失效**）。
 * ④ **宿主闸门的缺省方向**：未接线（单测 / 非 Web profile）与来源抛错时都必须是
 *    `true`，否则一次读取抖动就把功能关掉了。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  LOGIN_PREFERENCES_FILE,
  autoOpenBrowserEnabled,
  configureAutoOpenBrowserEnabled,
  createLoginPreferenceStore,
  resetLoginPreferenceCache,
  sanitizeAutoOpenBrowserEnabled,
} from '../../src/login-preferences.js'

describe('sanitizeAutoOpenBrowserEnabled：只有显式 false 才算关', () => {
  it('⚠️ 缺键 / 脏值一律按开启（方向不能反）', () => {
    for (const raw of [undefined, null, true, 0, 1, '', 'false', 'true', {}, [], 'yes']) {
      expect(sanitizeAutoOpenBrowserEnabled(raw), `raw=${JSON.stringify(raw)} 应判开`).toBe(true)
    }
  })

  it('⚠️ 只有字面量 false 判关', () => {
    expect(sanitizeAutoOpenBrowserEnabled(false)).toBe(false)
  })
})

describe('文件后端：写进去必须能读回来', () => {
  let home: string

  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'jet-hub-login-pref-')) })
  afterEach(() => {
    delete process.env.DSH_JET_HUB_STATE_DIR
    resetLoginPreferenceCache()
    rmSync(home, { recursive: true, force: true })
  })

  /**
   * 最小 ctx：`resolveJetHubHome` 的优先级是
   * `DSH_JET_HUB_STATE_DIR` → `profileContext.home` → `DSH_HOME` → `~/.dsh`，
   * 故用最高优先级的那个环境变量把目录钉到临时目录，避免污染真实 home。
   */
  function fakeCtx(warnings?: string[]): unknown {
    return {
      get: () => undefined,
      logger: { warn: (message: string) => warnings?.push(message) },
    }
  }

  it('★ 默认（文档不存在）= 开', () => {
    process.env.DSH_JET_HUB_STATE_DIR = home
    expect(createLoginPreferenceStore(fakeCtx() as never).load()).toBe(true)
  })

  it('★★ save(false) 之后 load 必须变 false（抓「字段名写错」）', async () => {
    process.env.DSH_JET_HUB_STATE_DIR = home
    const store = createLoginPreferenceStore(fakeCtx() as never)
    await store.save(false)
    expect(store.load(), 'save 之后读不回来 ⇒ 开关写了没用（字段名或路径不一致）').toBe(false)
    const onDisk = JSON.parse(
      readFileSync(join(home, 'jet-hub', LOGIN_PREFERENCES_FILE), 'utf-8'),
    ) as { autoOpenBrowserEnabled?: unknown; schema?: unknown }
    expect(onDisk.autoOpenBrowserEnabled).toBe(false)
    expect(onDisk.schema).toBe('dsh-codearts-auth/login-preferences/v1')
    await store.save(true)
    expect(store.load()).toBe(true)
  })

  it('★ 原子写：落盘后不残留 .tmp', async () => {
    process.env.DSH_JET_HUB_STATE_DIR = home
    const store = createLoginPreferenceStore(fakeCtx() as never)
    await store.save(false)
    expect(() => readFileSync(join(home, 'jet-hub', `${LOGIN_PREFERENCES_FILE}.tmp`), 'utf-8')).toThrow()
  })

  it('⚠️ 文档损坏 ⇒ 回落「开」并留一条 warn（不抛错）', async () => {
    process.env.DSH_JET_HUB_STATE_DIR = home
    const path = join(home, 'jet-hub', LOGIN_PREFERENCES_FILE)
    const warnings: string[] = []
    const store = createLoginPreferenceStore(fakeCtx(warnings) as never)
    await store.save(true)
    writeFileSync(path, '{ 这不是 JSON', 'utf-8')
    // `save(true)` 已把 true 写进缓存 ⇒ 不清就根本不会读盘，warn 断言会假红。
    resetLoginPreferenceCache()
    expect(store.load(), '坏文档必须回落默认开，而不是抛错或判关').toBe(true)
    expect(warnings.length, '读坏文档必须留痕').toBeGreaterThan(0)
  })

  it('⚠️ 裸布尔形态也认（手工编辑过的文档）', async () => {
    process.env.DSH_JET_HUB_STATE_DIR = home
    const store = createLoginPreferenceStore(fakeCtx() as never)
    await store.save(true)
    writeFileSync(join(home, 'jet-hub', LOGIN_PREFERENCES_FILE), 'false', 'utf-8')
    resetLoginPreferenceCache()
    expect(store.load(), '裸 false 应被认成关闭').toBe(false)
  })

  it('★★ 两个实例共享同一份缓存（设置页写完，宿主闸门立刻读到）', async () => {
    process.env.DSH_JET_HUB_STATE_DIR = home
    const writer = createLoginPreferenceStore(fakeCtx() as never)
    const reader = createLoginPreferenceStore(fakeCtx() as never)
    expect(reader.load()).toBe(true)
    await writer.save(false)
    expect(reader.load(), '按路径共享缓存 ⇒ 另一个实例必须立刻读到 false').toBe(false)
  })
})

describe('宿主闸门的判据来源（configureAutoOpenBrowserEnabled）', () => {
  afterEach(() => { configureAutoOpenBrowserEnabled(undefined) })

  it('★ 未接线 ⇒ 开（单测 / 非 Web profile 与功能上线前逐字节相同）', () => {
    expect(autoOpenBrowserEnabled()).toBe(true)
  })

  it('★ 接线后按来源取值', () => {
    configureAutoOpenBrowserEnabled(() => false)
    expect(autoOpenBrowserEnabled()).toBe(false)
    configureAutoOpenBrowserEnabled(() => true)
    expect(autoOpenBrowserEnabled()).toBe(true)
  })

  it('★★ 来源抛错 ⇒ 仍按开（一次读取抖动绝不允许静默关掉功能）', () => {
    configureAutoOpenBrowserEnabled(() => { throw new Error('disk boom') })
    expect(autoOpenBrowserEnabled()).toBe(true)
  })

  it('⚠️ 来源返回非布尔值 ⇒ 只认字面量 false 为关', () => {
    configureAutoOpenBrowserEnabled(() => 'false' as unknown as boolean)
    expect(autoOpenBrowserEnabled()).toBe(true)
    configureAutoOpenBrowserEnabled(() => undefined as unknown as boolean)
    expect(autoOpenBrowserEnabled()).toBe(true)
  })
})