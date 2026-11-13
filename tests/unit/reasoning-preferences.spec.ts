/**
 * 「默认取最强思考档」偏好的**独立文档**（2026-11-11）。
 *
 * 锁死三件事，每一件都是「用户看到功能神秘消失」的一种成因：
 *
 * ① **缺键 = 开**：文档不存在 / 损坏 / 被老版本代码整体重写时丢键，都必须回到
 *    默认开。反过来（只认 `true`）会让任何一次读取失败都变成「功能被静默关闭」，
 *    而用户根本没有关过它。
 * ② **显式 `false` 才关**：`'false'` 字符串、`0`、`null` 都**不是**用户意图。
 * ③ **写进去能读回来**：`save` 之后 `load` 必须变 —— 这条听起来是废话，
 *    但它是唯一能抓住「写错字段名」的判据（`load` 自己的回退逻辑会把读不到
 *    的键当成「开」，于是一个拼错的字段名会让「关掉开关」**永久静默失效**）。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  REASONING_PREFERENCES_FILE,
  createReasoningPreferenceStore,
  resetReasoningPreferenceCache,
  sanitizeStrongestReasoningEnabled,
} from '../../src/reasoning-preferences.js'

describe('sanitizeStrongestReasoningEnabled：只有显式 false 才算关', () => {
  it('⚠️ 缺键 / 脏值一律按开启（方向不能反）', () => {
    for (const raw of [undefined, null, true, 0, 1, '', 'false', 'true', {}, [], 'yes']) {
      expect(sanitizeStrongestReasoningEnabled(raw), `raw=${JSON.stringify(raw)} 应判开`).toBe(true)
    }
  })

  it('⚠️ 只有字面量 false 判关', () => {
    expect(sanitizeStrongestReasoningEnabled(false)).toBe(false)
  })
})

describe('文件后端：写进去必须能读回来', () => {
  let home: string

  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'jet-hub-reasoning-')) })
  afterEach(() => {
    delete process.env.DSH_JET_HUB_STATE_DIR
    rmSync(home, { recursive: true, force: true })
  })

  /**
   * 造一个最小 ctx：`resolveJetHubHome` 的优先级是
   * `DSH_JET_HUB_STATE_DIR` → `profileContext.home` → `DSH_HOME` → `~/.dsh`，
   * 故用**最高优先级的那个环境变量**把目录钉到临时目录，避免污染真实 home。
   */
  function fakeCtx(warnings?: string[]): unknown {
    return {
      get: () => undefined,
      logger: { warn: (message: string) => warnings?.push(message) },
    }
  }

  it('★ 默认（文档不存在）= 开', () => {
    process.env.DSH_JET_HUB_STATE_DIR = home
    expect(createReasoningPreferenceStore(fakeCtx() as never).load()).toBe(true)
  })

  it('★★ save(false) 之后 load 必须变 false（抓「字段名写错」）', async () => {
    process.env.DSH_JET_HUB_STATE_DIR = home
    const store = createReasoningPreferenceStore(fakeCtx() as never)
    await store.save(false)
    expect(store.load(), 'save 之后读不回来 ⇒ 开关写了没用（字段名或路径不一致）').toBe(false)
    // 落盘的文档里必须真有那个键（不能只靠内存态）。
    const onDisk = JSON.parse(
      readFileSync(join(home, 'jet-hub', REASONING_PREFERENCES_FILE), 'utf-8'),
    ) as { strongestReasoningEnabled?: unknown }
    expect(onDisk.strongestReasoningEnabled).toBe(false)
    await store.save(true)
    expect(store.load()).toBe(true)
  })

  it('⚠️ 文档损坏 ⇒ 回落「开」并留一条 warn（不抛错）', async () => {
    process.env.DSH_JET_HUB_STATE_DIR = home
    const path = join(home, 'jet-hub', REASONING_PREFERENCES_FILE)
    const warnings: string[] = []
    const store = createReasoningPreferenceStore(fakeCtx(warnings) as never)
    // ⚠️ `save` 是 async：不 await 就写盘还没落，随后的 writeFileSync 会撞 ENOENT。
    await store.save(true)
    writeFileSync(path, '{ 这不是 JSON', 'utf-8')
    // ⚠️ 本文件有进程内缓存（见 `src/reasoning-preferences.ts` 的 `parsedCache`）：
    //    上面 `save(true)` 已经把 `true` 写进缓存，不清掉的话下面的 `load()` 根本不读盘、
    //    也就不会走「坏文档」分支 ⇒ 这条 warn 断言会假红。清缓存 = 模拟「重启后首次读」。
    resetReasoningPreferenceCache()
    expect(store.load(), '坏文档必须回落默认开，而不是抛错或判关').toBe(true)
    expect(warnings.length, '读坏文档必须留痕').toBeGreaterThan(0)
  })

  it('⚠️ 裸布尔形态也认（手工编辑过的文档）', async () => {
    process.env.DSH_JET_HUB_STATE_DIR = home
    const store = createReasoningPreferenceStore(fakeCtx() as never)
    await store.save(true)
    writeFileSync(join(home, 'jet-hub', REASONING_PREFERENCES_FILE), 'false', 'utf-8')
    // 同上：外部改文件后必须清缓存才重读（生产路径里文件只由 `save()` 改，见模块注释）。
    resetReasoningPreferenceCache()
    expect(store.load(), '裸 false 应被认成关闭').toBe(false)
  })

  /**
   * ★★★ 缓存本身的行为（PR #70 审计 D1 的守卫）。
   *
   * 判据用**行为**而不是计时：`save(false)` ⇒ 删掉文件 ⇒ `load()` 必须仍返回 `false`
   * （= 没读盘，读了就会因文件不存在落到默认 `true`）；清缓存后再 `load()` 必须变 `true`
   * （= 缓存是唯一原因）。
   *
   * 这条为什么重要：`load()` 在 `buildModelCatalog` 的**逐模型**热路径上
   * （宿主 `dsh-api-session-controller/lib/index.js:473-497` 对每个模型各调一次
   * `resolveModelInfo`），实测单次读盘 102 us ⇒ 上千模型的目录每次构建多 100 ms+
   * 同步阻塞事件循环。把缓存删掉会让本用例变红（而不是让某处变慢）。
   */
  it('★★★ 同进程内第二次 load 不再读盘（缓存），save 后立刻生效', async () => {
    process.env.DSH_JET_HUB_STATE_DIR = home
    const store = createReasoningPreferenceStore(fakeCtx() as never)
    const path = join(home, 'jet-hub', REASONING_PREFERENCES_FILE)
    await store.save(false)
    rmSync(path, { force: true })
    expect(store.load(), '文件已被删除却仍读到 false ⇒ 说明走了缓存（这正是期望）').toBe(false)
    resetReasoningPreferenceCache()
    expect(store.load(), '清缓存后必须重新读盘：文件不存在 ⇒ 默认开').toBe(true)
  })
})
