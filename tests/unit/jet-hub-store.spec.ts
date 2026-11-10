/**
 * Jet Hub 持久化后端（`src/jet-hub-store.ts`）回归。
 *
 * 背景（Gitee issue IKI7WT）：DSH 0.1.7-rc.1 把 `ctx.settings` 换成
 * `SettingsForms`（**没有 `register`**），旧写法令账号列表与模型黑名单
 * 退化成纯内存。这里锁死两条后端的选路与落盘行为。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  clearRejectionLayer,
  createJetHubStore,
  mergeLegacyLoomyLock,
  sanitizeAccounts,
  sanitizeAggregateAllowed,
  sanitizeAggregateOrder,
  sanitizeAggregateOrderMode,
  sanitizeDisabledModels,
  sanitizeGatewayEnabled,
  sanitizeNativeWebSearchEnabled,
  sanitizePermanentLocks,
  sanitizeProviderClosed,
  sanitizeProviderOrder,
  jetHubSchema as storeSchema,
  providerOfAccountRef,
  sanitizePanelEntry,
  withAllowed,
  withoutAllowed,
} from '../../src/jet-hub-store.js'
import type { ProviderAccountEntry } from '../../src/types.js'
import { PROVIDER_REGISTRY } from '../../src/provider-registry.js'

/** 造一个最小 ctx；`settings` 按用例给（undefined = 服务缺失）。 */
function makeCtx(settings: unknown): never {
  return {
    get: (key: string) => (key === 'settings' ? settings : undefined),
    logger: { warn: () => {}, info: () => {} },
  } as never
}

const ACCOUNT: ProviderAccountEntry = {
  id: 'buddy-abc12345',
  provider: 'buddy',
  nickname: '测试账号',
  enabled: true,
  credentialRef: 'BUDDY_ACCOUNT_ABC12345',
  createdAt: 1,
  refreshable: true,
}

describe('sanitizeGatewayEnabled', () => {
  it('只有显式 false 才算停用，其余一律按启用', () => {
    // ⚠️ 方向不能反：老用户磁盘上没有这个键、被手工编辑成脏值、或旧版本代码
    // 整体重写时丢了本键，都必须回到默认启用（= 升级前行为）。反过来（只认
    // true）会让任何一次读取失败都变成「网关被静默关闭」，而用户没关过它。
    expect(sanitizeGatewayEnabled(false)).toBe(false)
    expect(sanitizeGatewayEnabled(undefined)).toBe(true)
    expect(sanitizeGatewayEnabled(null)).toBe(true)
    expect(sanitizeGatewayEnabled(true)).toBe(true)
    expect(sanitizeGatewayEnabled('false')).toBe(true)
    expect(sanitizeGatewayEnabled(0)).toBe(true)
    expect(sanitizeGatewayEnabled({})).toBe(true)
  })
})

describe('sanitizeNativeWebSearchEnabled', () => {
  it('只有显式 false 才算关闭，其余一律按启用（与网关开关逐字同构）', () => {
    // ⚠️ 方向不能反：丢键 / 脏值都必须回到**默认启用**。反过来（只认 true）
    // 会让读取失败变成「原生搜索被静默关闭」，用户只会看到搜索突然开始要
    // API Key，而他自己根本没关过。
    expect(sanitizeNativeWebSearchEnabled(false)).toBe(false)
    expect(sanitizeNativeWebSearchEnabled(undefined)).toBe(true)
    expect(sanitizeNativeWebSearchEnabled(null)).toBe(true)
    expect(sanitizeNativeWebSearchEnabled(true)).toBe(true)
    expect(sanitizeNativeWebSearchEnabled('false')).toBe(true)
    expect(sanitizeNativeWebSearchEnabled(0)).toBe(true)
    expect(sanitizeNativeWebSearchEnabled({})).toBe(true)
  })
})

describe('sanitizePanelEntry', () => {
  it('两个合法字面量原样返回', () => {
    expect(sanitizePanelEntry('sidebar')).toBe('sidebar')
    expect(sanitizePanelEntry('settings')).toBe('settings')
  })

  it('缺键 / null / 脏值一律回默认「仅侧栏」', () => {
    // ⚠️ 方向不能反：丢键 / 脏值都必须回到**默认仅侧栏**。反过来会让任何一次
    // 读取失败都变成「侧栏入口被静默藏起来」，而用户从来没改过它。
    expect(sanitizePanelEntry(undefined)).toBe('sidebar')
    expect(sanitizePanelEntry(null)).toBe('sidebar')
    expect(sanitizePanelEntry('off')).toBe('sidebar')
    expect(sanitizePanelEntry(0)).toBe('sidebar')
    expect(sanitizePanelEntry({})).toBe('sidebar')
  })

  it('⚠️ 老布尔迁移：只有明确 false 才是「仅设置页」', () => {
    expect(sanitizePanelEntry(undefined, false)).toBe('settings')
    expect(sanitizePanelEntry(undefined, true)).toBe('sidebar')
    // 脏值不当 false 用：字符串 'false' 是脏数据，不是用户意图。
    expect(sanitizePanelEntry(undefined, 'false')).toBe('sidebar')
    // 新键优先：两个都在时以新枚举为准。
    expect(sanitizePanelEntry('settings', true)).toBe('settings')
  })
})

let dir: string
let previousDir: string | undefined

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'jet-hub-store-'))
  previousDir = process.env.DSH_JET_HUB_STATE_DIR
  process.env.DSH_JET_HUB_STATE_DIR = dir
})

afterEach(() => {
  if (previousDir === undefined) delete process.env.DSH_JET_HUB_STATE_DIR
  else process.env.DSH_JET_HUB_STATE_DIR = previousDir
  rmSync(dir, { recursive: true, force: true })
})

describe('后端选路', () => {
  it('settings.register 可用时走老契约（数据仍在 settings 文档里）', () => {
    const scope = { get: () => ({ accounts: [] }), replace: async () => {} }
    const store = createJetHubStore(makeCtx({ register: () => scope, describe: () => [] }))
    expect(store.kind).toBe('settings')
  })

  it('settings 无 register（0.1.7 契约）时走文件后端', () => {
    const store = createJetHubStore(makeCtx({ describe: () => [], configure: () => () => {} }))
    expect(store.kind).toBe('file')
  })

  it('settings 服务缺失时仍走文件后端（headless 也可持久化）', () => {
    expect(createJetHubStore(makeCtx(undefined)).kind).toBe('file')
  })

  /**
   * ⚠️⚠️ **真实缺陷守卫（2026-10-24 复核 C1）**：老布尔迁移必须在
   * **过 schema 的** SettingsStore 路径上也成立。
   *
   * 上面那些 `scope.get()` 都是**裸替身**（直接返回对象、不经过 schemastery），
   * 于是它们绕开了「schema 给缺键填默认值」这一步 —— 而真实 SettingsStore 的
   * `scope.get()` 会过一遍 schema。
   *
   * 当时的写法 `Schema.string().default(DEFAULT_PANEL_ENTRY)` 正是在这里出问题：
   * schema 把 `panelEntry` 填成 `'sidebar'`，`sanitizePanelEntry` 第一层（新键
   * 合法即返回）随即命中，第二层的老布尔迁移**永远不执行** ⇒ 老用户明确关掉的
   * 侧栏入口升级后静默变回「仅侧栏」，且此后每次 save 都写死 `'sidebar'`。
   *
   * 本用例用**真实的 store schema** 编解码，因此 `schema.default` 的回归会立刻变红。
   */
  it('⚠️ 老契约后端：老布尔 false 经 schema 后仍迁移成「仅设置页」', () => {
    const written: Record<string, unknown>[] = []
    let raw: unknown = { accounts: [], disabledModels: {}, sidebarEntryEnabled: false }
    const store = createJetHubStore(makeCtx({
      register: () => ({
        // ⚠️ 关键：`get()` 走真实 schema，复刻 SettingsStore 的行为。
        get: () => storeSchema(raw),
        replace: async (value: object) => {
          written.push(value as Record<string, unknown>)
          raw = value
        },
      }),
      describe: () => [],
    }))

    expect(store.load()?.panelEntry).toBe('settings')
  })

  it('⚠️ 老契约后端：没有新键也没有旧键时经 schema 回默认「仅侧栏」', () => {
    const raw: unknown = { accounts: [], disabledModels: {} }
    const store = createJetHubStore(makeCtx({
      register: () => ({ get: () => storeSchema(raw), replace: async () => {} }),
      describe: () => [],
    }))

    expect(store.load()?.panelEntry).toBe('sidebar')
  })
})

describe('老契约后端（SettingsStore）', () => {
  it('整体写入同时携带账号与黑名单', async () => {
    const payloads: Array<Record<string, unknown>> = []
    let stored: unknown = undefined
    const scope = {
      get: () => stored,
      replace: async (value: object) => {
        payloads.push(value as Record<string, unknown>)
        stored = value
      },
    }
    const store = createJetHubStore(makeCtx({ register: () => scope, describe: () => [] }))
    await store.save({ accounts: [ACCOUNT], disabledModels: { buddy: { 'glm-5.2': true } } })

    expect(payloads).toHaveLength(1)
    expect(payloads[0]!.accounts).toEqual([ACCOUNT])
    expect(payloads[0]!.disabledModels).toEqual({ buddy: { 'glm-5.2': true } })
    expect(store.load()).toEqual({
      accounts: [ACCOUNT],
      disabledModels: { buddy: { 'glm-5.2': true } },
      // save 未携带拒绝表 → 写出空表，读回同值（老文档没这个键时的默认）。
      aggregateRejections: {},
      // 三个新键（聚合门控 + 手工排序）同样缺省即写出：空白名单 / 空顺序表 / 临期序。
      aggregateAllowed: {},
      aggregateOrder: {},
      aggregateOrderMode: 'expiry',
      loomyPermanentLocked: false,
      gatewayEnabled: true,
      // save 未携带局域网开关 → 写出关闭（缺省），读回同值。
      gatewayAllowLan: false,
      // save 未携带原生搜索开关 → 写出启用（缺省），读回同值。
      nativeWebSearchEnabled: true,
      // save 未携带会话负载均衡开关 → 写出启用（缺省），读回同值。
      sessionBalanceEnabled: true,
      // save 未携带严格手动顺序 → 写出空表（= 全部走余额分档，升级前行为）。
      strictManualOrder: {},
      preferredRotation: {},
      // save 未携带面板入口 → 写出「仅侧栏」（缺省），读回同值。
      panelEntry: 'sidebar',
      // save 未携带顺序 → 写出空数组（未自定义），读回同值。
      providerOrder: [],
      // 关闭意图缺省空表（没有任何供应商被关闭）：读回同值（Gitee IKP8OF）。
      providerClosed: {},
    })
    // ⚠️ 锁定表**不进**这份文档：它是同机多 profile 共享的，旧版本代码全量重写
    // 时不会携带自己不认识的键 —— 表放这儿会被静默抹掉（详见
    // src/permanent-lock-store.ts 的文件头）。表住 permanent-locks.json。
    expect('permanentLocks' in payloads[0]!).toBe(false)
  })

  /**
   * ⚠️ 老契约后端也必须持久化锁定**镜像**（用户要求「需要支持持久化」）。
   *
   * 镜像的意义：另一条工作区里的旧版本代码只认 `loomyPermanentLocked`
   * （它读它、也原样写回它），保持一致才能让那一侧的 Loomy 面板不显示错值。
   */
  it('Loomy 永久积分锁定镜像在 settings 后端可读回', async () => {
    let saved: Record<string, unknown> | undefined
    const scope = {
      get: () => saved,
      replace: async (section: object) => { saved = section as Record<string, unknown> },
    }
    const store = createJetHubStore(makeCtx({ register: () => scope, describe: () => [] }))
    await store.save({ accounts: [], disabledModels: {}, loomyPermanentLocked: true })
    expect(saved?.loomyPermanentLocked).toBe(true)
    expect('permanentLocks' in saved!).toBe(false)
    expect(store.load()?.loomyPermanentLocked).toBe(true)
  })

  /**
   * ⚠️⚠️ **老契约后端必须真正落盘拒绝表**（真实缺陷，对抗审计实测证伪）。
   *
   * `SettingsStore.save()` 的 `replace` 是**整体替换**语义 ⇒ 载荷漏掉某个键
   * 就等于「永不落盘」，且**任何**账号/黑名单/网关/顺序写入都会顺带把它抹掉。
   * 后果：用户明确拒绝的渠道在重启后**静默重新参与轮换**（用户无从察觉）。
   *
   * ⚠️ 上面那条「整体写入同时携带账号与黑名单」用例的注释曾写
   * 「save 未携带拒绝表 → 写出空表，读回同值」，把这个缺陷**合理化**了 ——
   * 它只断言「不传时读回空表」，**从未**断言「传了要落盘」。
   * 本用例补的正是那一半：**传了必须落盘且能读回**。
   */
  it('★ 拒绝表在 settings 后端可落盘并读回（不能只断言「不传时为空」）', async () => {
    let saved: Record<string, unknown> | undefined
    const scope = {
      get: () => saved,
      replace: async (section: object) => { saved = section as Record<string, unknown> },
    }
    const store = createJetHubStore(makeCtx({ register: () => scope, describe: () => [] }))
    const rejections = { 'deepseek-v4-1-flash': { buddy: { 'deepseek-v4.1-flash': true } } }
    await store.save({ accounts: [], disabledModels: {}, aggregateRejections: rejections })

    // ① 载荷里**必须**带上它（这是 replace 语义下的唯一保证）
    expect(saved?.aggregateRejections).toEqual(rejections)
    // ② 且能读回（不是只写进载荷、读时又丢掉）
    expect(store.load()?.aggregateRejections).toEqual(rejections)
  })

  /**
   * ★★ **「供应商关闭意图」必须能落盘并读回**（Gitee issue IKP8OF）。
   *
   * ⚠️⚠️ 本用例存在的理由与上面拒绝表那条**逐字同因**：只断言「不传时写出空表」
   * 是**恒真**的 —— 把 `save()` 里的 `providerClosed: ...` 整行删掉，那类断言
   * **照样全绿**（实测：注入 MUTANT-M6 后 56 条全过）。
   *
   * 而漏键的后果是本 issue 的**原样复发**：`replace` 是整体替换语义 ⇒ 关闭意图
   * **永不落盘**，且任何账号 / 黑名单 / 网关 / 顺序写入都会顺带把它抹掉
   * ⇒ 重启后供应商**静默回到「已打开」**，用户无从察觉自己「又打开过」它。
   *
   * ⇒ 判据必须打在「**传了**必须落盘且能读回」这一半。
   */
  it('★★ 关闭意图在 settings 后端可落盘并读回（不能只断言「不传时为空」）', async () => {
    let saved: Record<string, unknown> | undefined
    const scope = {
      get: () => saved,
      replace: async (section: object) => { saved = section as Record<string, unknown> },
    }
    const store = createJetHubStore(makeCtx({ register: () => scope, describe: () => [] }))
    await store.save({ accounts: [], disabledModels: {}, providerClosed: { cline: true } })

    // ① 载荷里**必须**带上它（replace 语义下的唯一保证）。
    expect(saved?.providerClosed, '★ save 漏了本键 ⇒ 关闭意图永不落盘').toEqual({ cline: true })
    // ② 且能读回（不是只写进载荷、读时又丢掉）。
    expect(store.load()?.providerClosed).toEqual({ cline: true })
  })

  /** 反向：脏值不得被当成「已关闭」（`'false'` 是 truthy，误判会让整家模型消失）。 */
  it('★ 关闭意图只认显式 true（脏值不得让整家模型静默消失）', () => {
    expect(sanitizeProviderClosed({ cline: true, buddy: 'false', trae: 1, qoder: null }))
      .toEqual({ cline: true })
    expect(sanitizeProviderClosed(['cline'])).toEqual({})
    expect(sanitizeProviderClosed(null)).toEqual({})
  })

  it('★ 拒绝表缺省时写出空表（老文档没有该键的兼容路径）', async () => {
    let saved: Record<string, unknown> | undefined
    const scope = {
      get: () => saved,
      replace: async (section: object) => { saved = section as Record<string, unknown> },
    }
    const store = createJetHubStore(makeCtx({ register: () => scope, describe: () => [] }))
    await store.save({ accounts: [], disabledModels: {} })
    expect(saved?.aggregateRejections).toEqual({})
  })

  /**
   * ⚠️ 本后端**只负责镜像**：即使调用方误把表塞进 state（类型上已无该字段，
   * 故用 `as never` 模拟"有人改回来"），也不得落进共享文档 —— 那等于重新制造
   * "被另一条工作区的旧版本全量重写抹掉"这个缺陷（表的家在 permanent-locks.json）。
   */
  it('误传的 permanentLocks 不会落进共享文档', async () => {
    let saved: Record<string, unknown> | undefined
    const scope = {
      get: () => saved,
      replace: async (section: object) => { saved = section as Record<string, unknown> },
    }
    const store = createJetHubStore(makeCtx({ register: () => scope, describe: () => [] }))
    await store.save({
      accounts: [],
      disabledModels: {},
      loomyPermanentLocked: true,
      permanentLocks: { buddy: true, workbuddy: true },
    } as never)
    // 镜像正常写出，表本体被丢弃
    expect(saved?.loomyPermanentLocked).toBe(true)
    expect('permanentLocks' in saved!).toBe(false)
    // 读回来的类型也没有它（AccountPool 不可能误把它当权威）
    expect('permanentLocks' in (store.load() ?? {})).toBe(false)
  })
})

describe('文件后端（FileStore）', () => {
  /**
   * ⚠️ 这两处 `toEqual` 是**整份文档**的逐键断言（`不落盘 permanentLocks` 之类的
   * 反例也靠它）。新增持久化键时**必须**在这里补一行 —— 否则它会以「期望值与
   * 实际值差一个键」的形式失败，看起来像回归，其实是快照过期。
   */
  it('写入后可被新实例读回（跨重启持久化）', async () => {
    const writer = createJetHubStore(makeCtx(undefined))
    await writer.save({ accounts: [ACCOUNT], disabledModels: { buddy: { 'glm-5.2': true } } })

    const statePath = join(dir, 'jet-hub', 'state.json')
    expect(existsSync(statePath)).toBe(true)

    const reader = createJetHubStore(makeCtx(undefined))
    expect(reader.load()).toEqual({
      accounts: [ACCOUNT],
      disabledModels: { buddy: { 'glm-5.2': true } },
      // 拒绝表缺省空表（没有任何拒绝）—— 与升级前行为一致
      aggregateRejections: {},
      // 门控白名单缺省空表（没有手工打开的候选）—— 未接入渠道因此回到「默认不参与」
      aggregateAllowed: {},
      // 手工顺序表缺省空表（未自定义任何模型的顺序）
      aggregateOrder: {},
      // 排序模式缺省临期序 —— 与升级前行为一致
      aggregateOrderMode: 'expiry',
      // 镜像字段缺省 false（解锁）—— 与既有行为一致
      loomyPermanentLocked: false,
      // 网关开关缺省启用 —— 与升级前行为一致
      gatewayEnabled: true,
      // 局域网开关缺省关闭 —— 暴露面变大必须是显式选择
      gatewayAllowLan: false,
      // 原生搜索开关缺省启用 —— 与升级前行为一致
      nativeWebSearchEnabled: true,
      // 会话负载均衡开关缺省启用 —— 与 2026-10-30 要求的方向一致
      sessionBalanceEnabled: true,
      // 严格手动顺序缺省空表 —— 与升级前行为一致（余额分档优先）
      strictManualOrder: {},
      preferredRotation: {},
      // 面板入口缺省「仅侧栏」—— 与升级前行为一致
      panelEntry: 'sidebar',
      // 顺序缺省空数组（未自定义）—— 与升级前行为一致
      providerOrder: [],
      // 关闭意图缺省空表（没有任何供应商被关闭）：读回同值（Gitee IKP8OF）。
      providerClosed: {},
    })
    // 落盘文本里也不该出现锁定表（它属于 permanent-locks.json）
    expect(readFileSync(statePath, 'utf-8')).not.toContain('permanentLocks')
  })

  /**
   * ⚠️ 锁定态必须**跨重启持久化**（用户在 Loomy 上明确要求，
   * CodeBuddy / WorkBuddy 沿用同一约定）。这里验证的是镜像字段那一半；
   * 权威表的后端由 `permanent-lock-store.spec.ts` 覆盖。
   */
  it('Loomy 永久积分锁定镜像可跨实例读回', async () => {
    const writer = createJetHubStore(makeCtx(undefined))
    await writer.save({ accounts: [], disabledModels: {}, loomyPermanentLocked: true })

    const reader = createJetHubStore(makeCtx(undefined))
    expect(reader.load()?.loomyPermanentLocked).toBe(true)
  })

  it('网关开关 false 可跨实例读回（关了就是关了）', async () => {
    const writer = createJetHubStore(makeCtx(undefined))
    await writer.save({ accounts: [], disabledModels: {}, gatewayEnabled: false })

    const reader = createJetHubStore(makeCtx(undefined))
    expect(reader.load()?.gatewayEnabled).toBe(false)
  })

  it('老文档没有网关开关时缺省为启用（= 升级前行为，不静默关掉用户的网关）', () => {
    mkdirSync(join(dir, 'jet-hub'), { recursive: true })
    writeFileSync(
      join(dir, 'jet-hub', 'state.json'),
      JSON.stringify({ accounts: [], disabledModels: {} }),
      'utf-8',
    )
    expect(createJetHubStore(makeCtx(undefined)).load()?.gatewayEnabled).toBe(true)
  })

  it('网关开关落盘时脏值被归一化为启用', () => {
    mkdirSync(join(dir, 'jet-hub'), { recursive: true })
    writeFileSync(
      join(dir, 'jet-hub', 'state.json'),
      JSON.stringify({ accounts: [], disabledModels: {}, gatewayEnabled: 'off' }),
      'utf-8',
    )
    expect(createJetHubStore(makeCtx(undefined)).load()?.gatewayEnabled).toBe(true)
  })

  /**
   * 「渠道原生搜索」总开关的**持久化**守卫（PR95 审计补）。
   *
   * ⚠️ 本组用例的存在理由：本键加进 `JetHubState` 时**只**接了 `AccountPool`
   * 的内存副本与 RPC，**两个后端都没接** —— 于是 `sanitizeNativeWebSearchEnabled`
   * 有 7 条单测、却**零生产调用者**，用户关掉开关后重启**静默回到原生搜索**。
   * 上面那组网关用例逐条同构地覆盖了整条链，本键却一条都没有；这组就是把它补成
   * 同构的（**跨实例读回**才是有效判据 —— 只断言 `sanitize*` 的返回值是同义反复，
   * 那 7 条单测当初全绿也正是因为这个）。
   */
  it('⚠️ 原生搜索开关 false 可跨实例读回（关了就是关了，含老契约后端）', async () => {
    const writer = createJetHubStore(makeCtx(undefined))
    await writer.save({ accounts: [], disabledModels: {}, nativeWebSearchEnabled: false })

    const reader = createJetHubStore(makeCtx(undefined))
    expect(reader.load()?.nativeWebSearchEnabled).toBe(false)
  })

  it('老文档没有原生搜索开关时缺省为启用（= 升级前行为）', () => {
    mkdirSync(join(dir, 'jet-hub'), { recursive: true })
    writeFileSync(
      join(dir, 'jet-hub', 'state.json'),
      JSON.stringify({ accounts: [], disabledModels: {} }),
      'utf-8',
    )
    expect(createJetHubStore(makeCtx(undefined)).load()?.nativeWebSearchEnabled).toBe(true)
  })

  it('原生搜索开关落盘时脏值被归一化为启用', () => {
    mkdirSync(join(dir, 'jet-hub'), { recursive: true })
    writeFileSync(
      join(dir, 'jet-hub', 'state.json'),
      JSON.stringify({ accounts: [], disabledModels: {}, nativeWebSearchEnabled: 'off' }),
      'utf-8',
    )
    expect(createJetHubStore(makeCtx(undefined)).load()?.nativeWebSearchEnabled).toBe(true)
  })

  // ── 「ZCode 会话负载均衡」开关（与原生搜索那组逐条同构）──
  it('⚠️ 会话负载均衡开关 false 可跨实例读回（关了就是关了，含老契约后端）', async () => {
    const writer = createJetHubStore(makeCtx(undefined))
    await writer.save({ accounts: [], disabledModels: {}, sessionBalanceEnabled: false })

    const reader = createJetHubStore(makeCtx(undefined))
    expect(reader.load()?.sessionBalanceEnabled).toBe(false)
  })

  it('老文档没有会话负载均衡开关时缺省为启用（= 2026-10-30 要求的默认方向）', () => {
    mkdirSync(join(dir, 'jet-hub'), { recursive: true })
    writeFileSync(
      join(dir, 'jet-hub', 'state.json'),
      JSON.stringify({ accounts: [], disabledModels: {} }),
      'utf-8',
    )
    expect(createJetHubStore(makeCtx(undefined)).load()?.sessionBalanceEnabled).toBe(true)
  })

  it('会话负载均衡开关落盘时脏值被归一化为启用', () => {
    mkdirSync(join(dir, 'jet-hub'), { recursive: true })
    writeFileSync(
      join(dir, 'jet-hub', 'state.json'),
      JSON.stringify({ accounts: [], disabledModels: {}, sessionBalanceEnabled: 'off' }),
      'utf-8',
    )
    expect(createJetHubStore(makeCtx(undefined)).load()?.sessionBalanceEnabled).toBe(true)
  })

  /**
   * 「面板入口」偏好的**持久化**守卫（与上面原生搜索那组同构）。
   *
   * 判据必须是**跨实例读回**：断言 `sanitizePanelEntry` 的返回值是同义反复 ——
   * 真正的缺陷形态是「有 sanitize、没生产调用者」，用户改了入口、重启后又变回去。
   * 所以这里走**真实的** `save()` / `load()`。
   */
  it('⚠️ 面板入口改「仅设置页」可跨实例读回（改了就是改了）', async () => {
    const writer = createJetHubStore(makeCtx(undefined))
    await writer.save({ accounts: [], disabledModels: {}, panelEntry: 'settings' })

    const reader = createJetHubStore(makeCtx(undefined))
    expect(reader.load()?.panelEntry).toBe('settings')
  })

  it('老文档没有面板入口键时缺省为「仅侧栏」', () => {
    mkdirSync(join(dir, 'jet-hub'), { recursive: true })
    writeFileSync(
      join(dir, 'jet-hub', 'state.json'),
      JSON.stringify({ accounts: [], disabledModels: {} }),
      'utf-8',
    )
    expect(createJetHubStore(makeCtx(undefined)).load()?.panelEntry).toBe('sidebar')
  })

  it('面板入口落盘时脏值被归一化为「仅侧栏」', () => {
    mkdirSync(join(dir, 'jet-hub'), { recursive: true })
    writeFileSync(
      join(dir, 'jet-hub', 'state.json'),
      JSON.stringify({ accounts: [], disabledModels: {}, panelEntry: 'off' }),
      'utf-8',
    )
    expect(createJetHubStore(makeCtx(undefined)).load()?.panelEntry).toBe('sidebar')
  })

  it('⚠️ 老文档只有布尔键时跨实例读回映射成枚举', () => {
    mkdirSync(join(dir, 'jet-hub'), { recursive: true })
    writeFileSync(
      join(dir, 'jet-hub', 'state.json'),
      JSON.stringify({ accounts: [], disabledModels: {}, sidebarEntryEnabled: false }),
      'utf-8',
    )
    expect(createJetHubStore(makeCtx(undefined)).load()?.panelEntry).toBe('settings')
  })

  it('⚠️ 写入后文档里不得再出现 sidebarEntryEnabled 键', async () => {
    const writer = createJetHubStore(makeCtx(undefined))
    await writer.save({ accounts: [], disabledModels: {}, panelEntry: 'settings' })
    const raw = JSON.parse(readFileSync(join(dir, 'jet-hub', 'state.json'), 'utf-8')) as Record<string, unknown>
    expect(raw.panelEntry).toBe('settings')
    expect(raw).not.toHaveProperty('sidebarEntryEnabled')
  })

  /**
   * ⚠️⚠️ **落盘前必须过 sanitize**（2026-10-24 审计 M7）。
   *
   * 两个后端的 `save` 写的是同一份文档形状，但此前只有 `SettingsStore.save`
   * 归一化入参，`FileStore.save` **原样落盘** ⇒ 脏值被写进文档、下次启动再被
   * 读侧 sanitize 纠正。写侧没判据时，「脏值只可能来自读路径」这个假设全靠
   * 调用方约定维持（本仓库红线 PR !62 的幼苗形态）。
   *
   * ⚠️ 判据必须**真的写一次脏值再读文件**，不能只查源码里有没有
   *    `sanitizePanelEntry` —— 那种写法对「只加在注释里」完全失明。
   */
  it('⚠️⚠️ FileStore 落盘前归一化 panelEntry（脏值不得写进文档）', async () => {
    const writer = createJetHubStore(makeCtx(undefined))
    await writer.save({ accounts: [], disabledModels: {}, panelEntry: 'GARBAGE' as never })
    const raw = JSON.parse(readFileSync(join(dir, 'jet-hub', 'state.json'), 'utf-8')) as Record<string, unknown>
    expect(raw.panelEntry, '脏值被原样写进了 state.json ⇒ 写侧缺 sanitize').toBe('sidebar')
  })

  /**
   * ⚠️ 中间版本曾把 `permanentLocks` 写进这份**共享文档**，那批磁盘状态如今
   * 可能还带着它。新版必须**忽略**它（不读、不因此改变镜像值）—— 否则
   * 「读一份随时会被旧版本抹掉的文档」这条错误路径又被允许了。
   */
  it('文档里残留的 permanentLocks 被忽略', () => {
    mkdirSync(join(dir, 'jet-hub'), { recursive: true })
    writeFileSync(
      join(dir, 'jet-hub', 'state.json'),
      JSON.stringify({
        accounts: [],
        disabledModels: {},
        loomyPermanentLocked: false,
        permanentLocks: { buddy: true, workbuddy: true },
      }),
      'utf-8',
    )
    const state = createJetHubStore(makeCtx(undefined)).load()
    expect(state?.loomyPermanentLocked).toBe(false)
    expect('permanentLocks' in (state ?? {})).toBe(false)
  })

  it('老文档没有该字段时缺省为 false（不误锁）', () => {
    mkdirSync(join(dir, 'jet-hub'), { recursive: true })
    // 手工写入一份「没有 loomyPermanentLocked」的旧文档
    writeFileSync(
      join(dir, 'jet-hub', 'state.json'),
      JSON.stringify({ accounts: [], disabledModels: {} }),
      'utf-8',
    )
    expect(createJetHubStore(makeCtx(undefined)).load()?.loomyPermanentLocked).toBe(false)
  })

  it('该字段非布尔值时不误判为锁定', () => {
    mkdirSync(join(dir, 'jet-hub'), { recursive: true })
    writeFileSync(
      join(dir, 'jet-hub', 'state.json'),
      JSON.stringify({ accounts: [], disabledModels: {}, loomyPermanentLocked: 'yes' }),
      'utf-8',
    )
    // 只认显式 true（与 disabledModels 的「只认显式 true」同一约定）
    expect(createJetHubStore(makeCtx(undefined)).load()?.loomyPermanentLocked).toBe(false)
  })

  it('★★ 文档损坏时必须抛错，不得按空状态启动（2026-11-05 三审 P0-1）', () => {
    mkdirSync(join(dir, 'jet-hub'), { recursive: true })
    writeFileSync(join(dir, 'jet-hub', 'state.json'), '{ not json', 'utf-8')
    const store = createJetHubStore(makeCtx(undefined))
    // ⚠️⚠️ 这里**必须**抛：返回 `undefined` 与「全新安装」同形，而
    // `AccountPool.ensureLoaded()` 会把空缓存当成已载入 ⇒ 下一次写入用空状态
    // 整体覆盖磁盘文档（账号 / 黑名单 / 关闭意图全丢，且全程零报错）。
    // 本用例原先断言的正是那个错误语义（「按空状态启动」），已随之反转。
    expect(() => store.load()).toThrow()
  })

  /**
   * ⚠️⚠️ **「合法 JSON 但不是对象」也必须抛**（2026-11-05 四审测试判别力）。
   *
   * 上一条只覆盖了 `JSON.parse` 自己会抛的输入（`'{ not json'`）；而
   * `null` / `123` / `'"str"'` 都能**解析成功**，走的是另一条分支：
   * `if (typeof parsed !== 'object' || parsed === null) throw …`。
   * 那条分支原先也 `return undefined`，与「全新安装」同形 —— 同一条 P0 的
   * 另一半，但**没有任何用例打得到它**（变异回 `return undefined` 时 78 全绿）。
   *
   * ⚠️ `'[]'` **刻意不在**这组里：数组是 object，会当空配置继续往下走
   * （与 `{"accounts":[]}` 同义），不是「文档损坏」。
   */
  it.each(['null', '123', '"str"', 'true'])('★★ 合法 JSON 但不是对象（%s）也必须抛错', (raw) => {
    mkdirSync(join(dir, 'jet-hub'), { recursive: true })
    writeFileSync(join(dir, 'jet-hub', 'state.json'), raw, 'utf-8')
    const store = createJetHubStore(makeCtx(undefined))
    expect(() => store.load()).toThrow(/不是 JSON 对象/)
  })

  /**
   * ⚠️⚠️ **报错文案必须自带两条出路**（2026-11-05 合规审计：代码对、零守卫）。
   *
   * `FileStore.load()` 抛错时，`AccountPool.ensureLoaded()` 会被**全部**读方法
   * 调用 ⇒ 每次 RPC 都重新读盘并抛错；19 个 `writeAccounts` 调用点写之前也要先读
   * ⇒ **写也全失败** ⇒ 面板能打开、能点「重试」，但重试**必然**失败，且用户
   * 无法添加账号、改设置、开关供应商、改黑名单。
   *
   * ⇒ 抛出的消息必须点名**路径** + 给出**两条实测可用的出路**：
   * ① 「备份恢复」里导入一份备份（选**替换**模式；`src/backup.ts` 只在 `merge`
   *    分支调 `getStateSnapshot` ⇒ `replace` 不读当前状态，故可用）；
   * ② 手动删除该文件（丢本地索引，凭据本体在 `.credentials.yaml` 里）。
   *
   * ⚠️ 原文案只含 `JSON.parse` 的英文 `SyntaxError.message`（不含路径、不含出路）
   * ⇒ 用户看到的是一条**无法操作的英文解析错误**。
   */
  it('★★ 读盘失败的消息必须点名路径 + 给出「备份恢复」与「删除该文件」两条出路', () => {
    const path = join(dir, 'jet-hub', 'state.json')
    mkdirSync(join(dir, 'jet-hub'), { recursive: true })
    writeFileSync(path, '{ not json', 'utf-8')
    const store = createJetHubStore(makeCtx(undefined))
    let message = ''
    try {
      store.load()
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message, '必须点名是哪个文件坏了').toContain(path)
    expect(message, '必须给出「备份恢复」这条出路').toContain('备份恢复')
    expect(message, '必须给出「删除该文件」这条出路').toContain('删除该文件')
  })

  /**
   * ⚠️ **本条只证明 `FileStore.load()` 可重试**（它每次都真读盘、没有 `loaded` 缓存）。
   *
   * 四审测试判别力实测：把 `AccountPool.ensureLoaded()` 里 `loaded = true`
   * 移回 `this.store.load()` **之前**，本文件 78 条**全绿** ⇒ 这条**打不到**
   * 三审 P0-1 的核心（「一次瞬时故障就让本进程永不再读盘」）。
   * 真守卫在 `tests/unit/account-pool.spec.ts` 的
   * 「★★ 读盘失败后 `ensureLoaded()` 必须可重试」。
   */
  it('★ 读盘失败后必须能重试（`FileStore.load()` 每次都真读盘）', () => {
    // 这条锁的是 `AccountPool.ensureLoaded()` 里 `loaded = true` 的位置：
    // 先置位再读 ⇒ 一次瞬时故障就让本进程**永不**再读盘。
    const path = join(dir, 'jet-hub', 'state.json')
    mkdirSync(join(dir, 'jet-hub'), { recursive: true })
    writeFileSync(path, '{ not json', 'utf-8')
    const store = createJetHubStore(makeCtx(undefined))
    expect(() => store.load()).toThrow()
    // 修好文档后重新读，必须拿到真实内容（而不是被缓存的空状态吃掉）。
    writeFileSync(path, JSON.stringify({ accounts: [], disabledModels: { buddy: { 'm1': true } } }), 'utf-8')
    expect(store.load()?.disabledModels).toEqual({ buddy: { 'm1': true } })
  })

  it('首次启动可从 .credentials.yaml 的 refs 恢复账号（0.1.7 迁移路径）', () => {
    writeFileSync(
      join(dir, '.credentials.yaml'),
      [
        'version: 1',
        'refs:',
        '  BUDDY_ACCESS_TOKEN: <irrelevant>',
        '  BUDDY_ACCOUNT_ABC12345: {"access_token":"x"}',
        '  CODEARTS_ACCOUNT_DEADBEEF: {"access_key_id":"y"}',
        '  NOT_AN_ACCOUNT_REF: 1',
        'records: {}',
      ].join('\n'),
      'utf-8',
    )

    const store = createJetHubStore(makeCtx(undefined))
    const state = store.load()
    expect(state?.accounts.map(a => [a.id, a.provider, a.credentialRef])).toEqual([
      ['buddy-abc12345', 'buddy', 'BUDDY_ACCOUNT_ABC12345'],
      ['codearts-deadbeef', 'codearts', 'CODEARTS_ACCOUNT_DEADBEEF'],
    ])
    // 恢复结果必须立即落盘，否则每次启动都会重复恢复。
    expect(existsSync(join(dir, 'jet-hub', 'state.json'))).toBe(true)
  })

  /**
   * 回归：**全部 11 个 provider** 的账号 ref 都必须能恢复。
   *
   * 真实缺陷：恢复表原先只有 6 项（注释也写着「六个 provider」），而插件实际
   * 有 11 个 —— `qodercn` / `cline` / `loomy` / `raccoon` / `zcode` 的账号在
   * 状态文档缺失时**静默消失**（用户侧表现：「重装 / 迁移后这几个面板的账号
   * 凭空不见，只能重新登录」）。凭据本体一直在 `.credentials.yaml` 里，
   * 只是索引建不出来。
   *
   * ⚠️ 上一条用例只覆盖 `buddy` 与 `codearts`，正是这个覆盖缺口让缺陷溜过。
   * 本用例按 `jet-hub-rpc.ts` 的 `account.create` 前缀规则
   * （`${provider.toUpperCase()}_ACCOUNT_${suffix}`）逐个断言。
   */
  it('十一个 provider 的账号 ref 全部可恢复（新增 provider 必须同步登记）', () => {
    const cases: Array<[string, string]> = [
      ['CODEARTS_ACCOUNT_AAAAAA', 'codearts'],
      ['BUDDY_ACCOUNT_BBBBBB', 'buddy'],
      ['WORKBUDDY_ACCOUNT_CCCCCC', 'workbuddy'],
      ['LOBSTERAI_ACCOUNT_DDDDDD', 'lobsterai'],
      ['QODER_ACCOUNT_EEEEEE', 'qoder'],
      ['QODERCN_ACCOUNT_FFFFFF', 'qodercn'],
      ['TRAE_ACCOUNT_111111', 'trae'],
      ['CLINE_ACCOUNT_222222', 'cline'],
      ['LOOMY_ACCOUNT_333333', 'loomy'],
      ['RACCOON_ACCOUNT_444444', 'raccoon'],
      ['ZCODE_ACCOUNT_555555', 'zcode'],
    ]
    writeFileSync(
      join(dir, '.credentials.yaml'),
      ['version: 1', 'refs:', ...cases.map(([ref]) => `  ${ref}: '{}'`), 'records: {}'].join('\n'),
      'utf-8',
    )

    const recovered = createJetHubStore(makeCtx(undefined)).load()?.accounts ?? []
    expect(recovered.map(a => [a.credentialRef, a.provider])).toEqual(cases)
  })

  /**
   * ★★ P2（2026-10-25 审计 A1-F4 / B1）：**归一化的 opencode ref 也必须能恢复**。
   *
   * ## 缺陷
   *
   * `ACCOUNT_REF_RE` 的尾段判据是 `[0-9A-Fa-f]{6,}`（**纯 hex**），而
   * `opencode-rpc.ts` 在尾段含 `-`/`.` 时会生成
   * `OPENCODE_ACCOUNT_<剥完非法字符>_<8 位 hex>` —— 尾段含 `_` ⇒ **永远不是纯 hex**
   * ⇒ `providerOfAccountRef` 返回 `undefined`。后果有两层：
   *
   * 1. `state.json` 缺失（重装/迁移/profile 重建）时该账号**静默消失**
   *    （凭据还在，索引建不出来，用户只能重新登录）；
   * 2. ⚠️ **更严重**：`backup.ts` 的跨 provider 校验拿 `undefined` 时**放行**
   *    （fail-open）⇒ 一份 `provider:'buddy'` 却引用 `OPENCODE_ACCOUNT_*` 的
   *    备份会被**采纳**，而合法 hex 尾 ref 的同类误用会被拒。审计实测：
   *    前者 `imported=1`、后者 `imported=0`。
   *
   * ## 修法
   *
   * 尾段放宽为「字母数字 + 可选的 `_<8 位 hex>` 后缀」。⚠️ **不能只放宽成
   * `[0-9A-Za-z]{6,}` 就完事** —— 那仍然匹配不到 `…_<8HEX>` 这种**带下划线**的形态。
   * 同时保留原有 hex 行为（存量 ref 的识别面**只增不减**）。
   */
  it('★★ P2：归一化 opencode ref（`…_<8HEX>`）必须被识别为 opencode 账号', () => {
    const cases: Array<[string, string]> = [
      ['OPENCODE_ACCOUNT_AAAABCD_6480DB97', 'opencode'],
      ['OPENCODE_ACCOUNT__9ABB433E', 'opencode'],
      ['OPENCODE_ACCOUNT_AAAAB_CD', 'opencode'],
      // 存量合法形态必须继续可用（识别面只增不减）
      ['OPENCODE_ACCOUNT_AAAAAA', 'opencode'],
      ['CODEARTS_ACCOUNT_AAAAAA', 'codearts'],
    ]
    for (const [ref, provider] of cases) {
      expect(providerOfAccountRef(ref), ref).toBe(provider)
    }
  })

  /**
   * 回归（**根因级保险**）：恢复表必须覆盖客户端 `PROVIDERS` 的每一个 provider。
   *
   * 上一条用例的清单是**人手维护**的，所以「上游新增 provider 而本表没跟上」
   * 这种缺陷它**测不出来** —— 上一版的十项清单正是如此漏掉了 zcode：合并上游
   * 新增 ZCode 后全套单测仍然全绿，而 `ZCODE_ACCOUNT_*` 的账号在 `state.json`
   * 缺失时会静默消失（凭据还在，只是索引建不出来，用户只能重新登录）。
   *
   * 故本用例从**客户端唯一的 provider 清单**取 id —— 该清单
   * （`plugin-src/client/jet-hub.js` 的 `PROVIDERS`）与
   * `credits-capabilities.spec.ts` 的同名断言一样，**已改为直接读
   * `PROVIDER_REGISTRY`**（2026-10-08），不再解析源码文本。
   * 上游再加 provider 而忘记同步本表时，这里会红。
   */
  it('恢复表覆盖客户端 PROVIDERS 的全部 provider（从真实清单派生）', () => {
    // ⚠️ 2026-10-08 改：原先从**客户端源码文本**用正则
    // `/\{\s*id:\s*'([a-z]+)',\s*label:/g` 派生 id —— 那个字符类
    // **不匹配连字符**，新 provider id 带 `-` 时会**静默漏算一个 id
    // 而守卫照样全绿**。现在直接读 registry，两侧同出一源。
    const allIds = PROVIDER_REGISTRY.map((d) => d.id)
    // 防「清单为空导致下游断言恒真」这类假绿。
    expect(allIds.length).toBeGreaterThan(0)

    /**
     * ⚠️ **无凭据的 provider 必须显式豁免**（规格 §8.3）：
     * `aggregate` 是聚合路由，**不持有账号与凭据**（它复用各渠道的账号）⇒
     * 它不可能出现在 `.credentials.yaml` 里，恢复表也不该为它造账号。
     * ⚠️ 豁免本身必须被**验证**（下面的 `expect(...).toContain(...)`），否则
     * 「忘了登记」与「本来就该豁免」就分不开了 —— 那正是本断言存在的意义。
     */
    const NO_CREDENTIAL_PROVIDERS = ['aggregate']
    for (const id of NO_CREDENTIAL_PROVIDERS) {
      expect(allIds, `豁免项 ${id} 必须真的在客户端 PROVIDERS 里`).toContain(id)
    }
    const providerIds = allIds.filter((id) => !NO_CREDENTIAL_PROVIDERS.includes(id))

    const refs = providerIds.map(
      (id, index) => `${id.toUpperCase()}_ACCOUNT_${(index + 1).toString(16).toUpperCase().padStart(6, '0')}`,
    )
    writeFileSync(
      join(dir, '.credentials.yaml'),
      ['refs:', ...refs.map((ref) => `  ${ref}: '{}'`), 'records: {}'].join('\n'),
      'utf-8',
    )

    const recovered = createJetHubStore(makeCtx(undefined)).load()?.accounts ?? []
    expect(recovered.map(a => [a.provider, a.credentialRef])).toEqual(
      providerIds.map((id, index) => [id, refs[index]!]),
    )
    // ⚠️ 反向确认：恢复出的账号里**不得**出现被豁免的 provider
    //（否则说明 `REF_PREFIX_TO_PROVIDER` 里被误加了一项）。
    for (const id of NO_CREDENTIAL_PROVIDERS) {
      expect(recovered.some(a => a.provider === id)).toBe(false)
    }
  })

  /**
   * 回归：`QODERCN` 不能被 `QODER` 前缀抢先匹配。
   *
   * 恢复表与正则由同一份真相源派生，若把 `QODER` 排在 `QODERCN` 之前，
   * `QODERCN_*` 会因正则回溯而**暂时**仍匹配成功 —— 但这取决于引擎的尝试
   * 顺序，一旦将来加入更多同前缀 provider（如 `QODERX`）就会变成静默错归属：
   * 账号被挂到 `qoder` 面板，而它的凭据是 CN 的，请求必然失败。
   * 故按前缀长度**降序**拼接并在此锁死顺序带来的结果。
   */
  it('QODERCN 前缀不被 QODER 抢先匹配', () => {
    writeFileSync(
      join(dir, '.credentials.yaml'),
      ['refs:', "  QODERCN_ACCOUNT_ABCDEF: '{}'", "  QODER_ACCOUNT_123ABC: '{}'"].join('\n'),
      'utf-8',
    )

    const recovered = createJetHubStore(makeCtx(undefined)).load()?.accounts ?? []
    expect(recovered.map(a => [a.credentialRef, a.provider, a.id])).toEqual([
      ['QODERCN_ACCOUNT_ABCDEF', 'qodercn', 'qodercn-abcdef'],
      ['QODER_ACCOUNT_123ABC', 'qoder', 'qoder-123abc'],
    ])
  })

  it('已有状态文档时不再从凭据恢复（尊重用户删号）', async () => {
    await createJetHubStore(makeCtx(undefined)).save({ accounts: [], disabledModels: {} })
    writeFileSync(
      join(dir, '.credentials.yaml'),
      ['refs:', '  BUDDY_ACCOUNT_ABC12345: {"access_token":"x"}'].join('\n'),
      'utf-8',
    )
    expect(createJetHubStore(makeCtx(undefined)).load()).toEqual({
      accounts: [],
      disabledModels: {},
      // 拒绝表缺省空表（没有任何拒绝）：读回同值。
      aggregateRejections: {},
      // 三个新键同理：写盘时缺省，读回应如实带回这些默认值。
      aggregateAllowed: {},
      aggregateOrder: {},
      aggregateOrderMode: 'expiry',
      loomyPermanentLocked: false,
      // 写盘时缺省即启用：读回应如实带回这个默认值。
      gatewayEnabled: true,
      // 局域网开关缺省关闭：读回同值。
      gatewayAllowLan: false,
      // 原生搜索开关同理：写盘时缺省即启用，读回同值。
      nativeWebSearchEnabled: true,
      // 会话负载均衡开关同理：写盘时缺省即启用，读回同值。
      sessionBalanceEnabled: true,
      // 严格手动顺序同理：写盘时缺省即空表（= 余额分档优先），读回同值。
      strictManualOrder: {},
      preferredRotation: {},
      // 面板入口同理：写盘时缺省即「仅侧栏」，读回同值。
      panelEntry: 'sidebar',
      // 顺序缺省空数组（未自定义）：读回同值。
      providerOrder: [],
      // 关闭意图缺省空表（没有任何供应商被关闭）：读回同值（Gitee IKP8OF）。
      providerClosed: {},
    })
  })
})

describe('归一化', () => {
  it('只把显式 true 当作关闭，并丢弃非法层级', () => {
    expect(sanitizeDisabledModels({
      buddy: { 'glm-5.2': true, 'hy3': false, 'x': 'yes' },
      broken: 'not-an-object',
      empty: {},
    })).toEqual({ buddy: { 'glm-5.2': true } })
  })

  it('丢弃缺 id/provider/credentialRef 的账号条目', () => {
    const raw = [
      { id: 'a', provider: 'buddy', credentialRef: 'BUDDY_ACCOUNT_A' },
      { id: 'b', provider: 'buddy' },
      { provider: 'buddy', credentialRef: 'BUDDY_ACCOUNT_C' },
      'nonsense',
    ]
    const accounts = sanitizeAccounts(raw)
    expect(accounts.map(a => a.id)).toEqual(['a'])
    // 缺省字段被补齐，避免下游判空分散在十几处。
    expect(accounts[0]!.enabled).toBe(true)
    expect(accounts[0]!.refreshable).toBe(true)
    expect(accounts[0]!.nickname).toBe('a')
  })

  /**
   * ★ 封禁标记的取值闸（Gitee issue IKS2MV）。
   *
   * 备份文件是**用户可编辑**的输入，而封禁是**账号级**、且不自动过期：
   * 一条脏的 `policyBlockedAtMs`（`'x'` / `1e308`）若被当成真值，
   * 那个账号会**永久**从选号里消失，用户只能靠手动重置捞回来 ——
   * 比逐模型的限流脏值更狠（那种最多只挡一个模型）。
   */
  it('★ 封禁标记的脏值必须被丢弃（账号级 + 不自动过期，容错窗口为零）', () => {
    const base = { id: 'a', provider: 'buddy', credentialRef: 'BUDDY_ACCOUNT_A' }
    for (const bad of ['not-a-number', null, -1, 0, Number.NaN, 1e308, Number.POSITIVE_INFINITY]) {
      const entry = sanitizeAccounts([{ ...base, policyBlockedAtMs: bad }])[0]!
      expect(entry.policyBlockedAtMs, String(bad)).toBeUndefined()
    }
    const good = sanitizeAccounts([{ ...base, policyBlockedAtMs: 1_700_000_000_000 }])[0]!
    expect(good.policyBlockedAtMs).toBe(1_700_000_000_000)
    // 报文只保留非空字符串并截断（展示用；不参与任何判据）
    expect(sanitizeAccounts([{ ...base, policyBlockedMessage: '  ' }])[0]!.policyBlockedMessage).toBeUndefined()
    expect(sanitizeAccounts([{ ...base, policyBlockedMessage: 'x'.repeat(500) }])[0]!.policyBlockedMessage)
      .toHaveLength(200)
    expect(sanitizeAccounts([{ ...base, policyBlockedMessage: '账号存在异常行为' }])[0]!.policyBlockedMessage)
      .toBe('账号存在异常行为')
  })

  it('文件文档里非对象内容按空处理', () => {
    writeFileSync(join(dir, 'raw.json'), '[]', 'utf-8')
    expect(sanitizeAccounts(JSON.parse(readFileSync(join(dir, 'raw.json'), 'utf-8')))).toEqual([])
  })

  it('锁定表只保留显式 true，其余值与非对象输入按空处理', () => {
    expect(sanitizePermanentLocks({
      buddy: true,
      workbuddy: false,
      loomy: 'yes',
      '': true,
      trae: 1,
    })).toEqual({ buddy: true })
    expect(sanitizePermanentLocks(undefined)).toEqual({})
    expect(sanitizePermanentLocks(['buddy'])).toEqual({})
    expect(sanitizePermanentLocks('buddy')).toEqual({})
  })

  /**
   * 老状态文档（升级前写的）只有 `loomyPermanentLocked` 一个字段。
   *
   * ⚠️ 不合并的后果不是显示问题，而是**行为**问题：升级后 Loomy 的锁定
   * 静默失效 → 选号继续消耗永久积分 → 用户损失无法撤回。
   */
  it('老字段并入表：仅在表里没有 loomy 项时生效', () => {
    expect(mergeLegacyLoomyLock({}, true)).toEqual({ loomy: true })
    expect(mergeLegacyLoomyLock({}, false)).toEqual({})
    expect(mergeLegacyLoomyLock({}, 'yes')).toEqual({})
    // 表里已有 loomy 项时**表优先**（无论 true 还是缺键都由表决定）
    expect(mergeLegacyLoomyLock({ loomy: true, buddy: true }, false)).toEqual({ loomy: true, buddy: true })
    const merged = mergeLegacyLoomyLock({ buddy: true }, true)
    expect(merged).toEqual({ buddy: true, loomy: true })
    // 返回新对象，不修改入参（表是进程内权威副本，被改会污染池状态）
    const input = { buddy: true }
    mergeLegacyLoomyLock(input, true)
    expect(input).toEqual({ buddy: true })
  })

  /**
   * 供应商自定义顺序（「供应商开关」弹窗拖拽排序，2026-10-06）。
   *
   * ⚠️ 刻意**不做** provider 合法性校验：合法集合随插件版本变化，在这里过滤
   * 会让「新版本加入 provider → 被旧版本代码重写文档」场景下的顺序无法保留。
   * 展示层（provider-toggle.js 的 sortOpenProvidersByOrder）对未知 id 自带
   * 稳定兜底，脏条目天然无害 —— 所以这里只挡「明显不是 id」的值。
   */
  it('sanitizeProviderOrder：只留非空字符串并去重（保持首个出现位置）', () => {
    expect(sanitizeProviderOrder(['buddy', 'zcode', 'buddy', 'trae']))
      .toEqual(['buddy', 'zcode', 'trae'])
    expect(sanitizeProviderOrder(['buddy', '', 42, null, { id: 'x' }, 'zcode']))
      .toEqual(['buddy', 'zcode'])
  })

  it('sanitizeProviderOrder：非数组一律视为未自定义（空数组）', () => {
    expect(sanitizeProviderOrder(undefined)).toEqual([])
    expect(sanitizeProviderOrder(null)).toEqual([])
    expect(sanitizeProviderOrder('buddy')).toEqual([])
    expect(sanitizeProviderOrder({ 0: 'buddy' })).toEqual([])
  })

  /**
   * ★ 真实缺陷（Critical，对抗审计实测证伪）：`sanitizeAccounts` 必须按 id 去重。
   *
   * `id` 是账号的**唯一键**（`updateAccount` / `removeAccount` / `reorderAccounts`
   * 全按它 `findIndex`），池里两条同 id 时第二条永远改不动、删不掉。原先只有
   * `mergeAccounts` 内部去重，而 `replaceAll`（备份导入的**默认模式**）不去重。
   *
   * 后果**远不止**幽灵账号：`sinkAccountToProviderEnd` 按 id 匹配会写出
   * `undefined` 空洞 ⇒ 该 provider 的 `getAvailableAccount` / `listAccounts`
   * 全部抛错（整条推理链崩），且空洞经 `JSON.stringify` 变 `null`、重启后被本
   * 函数丢弃 ⇒ **账号永久丢失**。
   *
   * 反向验证：去掉实现里的 `seenIds` 判断 → 本用例变红。
   */
  it('★ 按 id 去重：同 id 只保留首次出现的条目（池里绝不允许两条同 id）', () => {
    const accounts = sanitizeAccounts([
      { id: 'dup', provider: 'buddy', credentialRef: 'BUDDY_ACCOUNT_D1', nickname: 'first' },
      { id: 'dup', provider: 'buddy', credentialRef: 'BUDDY_ACCOUNT_D2', nickname: 'second' },
      { id: 'unique', provider: 'buddy', credentialRef: 'BUDDY_ACCOUNT_D3' },
    ])
    expect(accounts.map(a => a.id)).toEqual(['dup', 'unique'])
    // 保留的是**首次**出现的那条（不合并字段 —— 无法判断哪份更新）。
    expect(accounts[0]!.nickname).toBe('first')
    expect(accounts[0]!.credentialRef).toBe('BUDDY_ACCOUNT_D1')
  })

  it('★ 去重不受「同 id 但 provider 不同」影响（id 是全局唯一键，跨 provider 也去重）', () => {
    // 账号存在**一个全局数组**里（各 provider 混排），故 id 冲突跨 provider 同样危险。
    const accounts = sanitizeAccounts([
      { id: 'x', provider: 'buddy', credentialRef: 'BUDDY_ACCOUNT_X1' },
      { id: 'x', provider: 'codearts', credentialRef: 'CODEARTS_ACCOUNT_X2' },
    ])
    expect(accounts).toHaveLength(1)
    expect(accounts[0]!.provider).toBe('buddy')
  })

  /**
   * ★ 真实缺陷（High，对抗审计实测证伪）：`modelRateLimits` 必须过滤脏值。
   *
   * 备份文件是用户可编辑的输入，原先该字段**原样透传**。非数字脏值会让 UI 与
   * 宿主**判据分叉**：UI 用 `v > Date.now()` ⇒ 对 `'not-a-number'` 为 `false`
   * ⇒ **不显示**「限额中」；宿主用 `now >= resetAt` 亦为 `false` ⇒ 判为**受限**、
   * 选号时排除。用户看到「这个号完全正常」，而宿主永远不用它。
   *
   * 反向验证：去掉 `sanitizeModelRateLimits` → 本用例变红。
   */
  it('★ modelRateLimits 过滤脏值：只留有限正数（与 updateModelRateLimit 写入守卫同源）', () => {
    const accounts = sanitizeAccounts([{
      id: 'a', provider: 'buddy', credentialRef: 'BUDDY_ACCOUNT_A',
      modelRateLimits: {
        'glm-5.2': 1_800_000_000_000,   // 合法：有限正数
        'garbage': 'not-a-number',      // 字符串
        'nan': Number.NaN,
        'inf': Number.POSITIVE_INFINITY,
        'neg': -1,
        'zero': 0,
        'null': null,
        '': 1_800_000_000_000,          // 空 modelId
      },
    }])
    expect(accounts[0]!.modelRateLimits).toEqual({ 'glm-5.2': 1_800_000_000_000 })
  })

  it('★ modelRateLimits 全为脏值时不写出该键（不留 {} 噪音）', () => {
    const accounts = sanitizeAccounts([{
      id: 'a', provider: 'buddy', credentialRef: 'BUDDY_ACCOUNT_A',
      modelRateLimits: { x: 'bad', y: null },
    }])
    expect(accounts[0]!.modelRateLimits).toBeUndefined()
    // ⚠️ 值为 `undefined`（而非缺键）：`JSON.stringify` 会整个丢弃它，
    // 故落盘/传输形态与「从未有过标记」完全一致。故这里**不能**断言 `in` 为 false
    // —— 那是对内存对象形状的过度约束，与真正关心的「落盘形态」无关。
    expect(JSON.parse(JSON.stringify(accounts[0]))).not.toHaveProperty('modelRateLimits')
  })

  it('modelRateLimits 非对象（数组/字符串/null）一律视为无标记', () => {
    for (const raw of [[], 'x', null, 42]) {
      const accounts = sanitizeAccounts([{
        id: 'a', provider: 'buddy', credentialRef: 'BUDDY_ACCOUNT_A', modelRateLimits: raw,
      }])
      expect(accounts[0]!.modelRateLimits).toBeUndefined()
    }
  })

  it('已过期的限流标记**保留**（UI 靠它渲染「重置」按钮，清理由 sweep 负责）', () => {
    const past = Date.now() - 60_000
    const accounts = sanitizeAccounts([{
      id: 'a', provider: 'buddy', credentialRef: 'BUDDY_ACCOUNT_A',
      modelRateLimits: { 'glm-5.2': past },
    }])
    expect(accounts[0]!.modelRateLimits).toEqual({ 'glm-5.2': past })
  })

  /**
   * ★★ **High 回归用例**（真实缺陷，对抗审计实测证伪）：
   * `1e308` 是「有限正数」但**超出 `Date` 范围**（上界 8.64e15），
   * 原先的 `isFinite(v) && v > 0` 会放过它 ⇒ 落池后下次撞限流时
   * `updateModelRateLimit` 里的 `new Date(current).toISOString()` 抛
   * **`RangeError: Invalid time value`**，而 17 个调用点里 16 个没有 try。
   *
   * 反向验证：把判据改回 `Number.isFinite(v) && v > 0` → 本用例变红。
   */
  it('★ 超出 Date 范围的有限数必须被过滤（否则 updateModelRateLimit 抛 RangeError）', () => {
    const accounts = sanitizeAccounts([{
      id: 'a', provider: 'buddy', credentialRef: 'BUDDY_ACCOUNT_A',
      modelRateLimits: {
        'too-big': 1e308,
        'just-over': 8_640_000_000_000_001,
        'ok': 8_640_000_000_000_000,      // 恰好等于 Date 上界 → 保留
      },
    }])
    expect(accounts[0]!.modelRateLimits).toEqual({ ok: 8_640_000_000_000_000 })
  })

  it('★ isValidResetAtMs 是读写两侧共用的谓词（不再各写一份判据）', async () => {
    const { isValidResetAtMs, MAX_DATE_MS } = await import('../../src/jet-hub-store.js')
    expect(isValidResetAtMs(1)).toBe(true)
    expect(isValidResetAtMs(MAX_DATE_MS)).toBe(true)
    expect(isValidResetAtMs(MAX_DATE_MS + 1)).toBe(false)
    expect(isValidResetAtMs(1e308)).toBe(false)
    expect(isValidResetAtMs(0)).toBe(false)
    expect(isValidResetAtMs(-1)).toBe(false)
    expect(isValidResetAtMs(Number.NaN)).toBe(false)
    expect(isValidResetAtMs(Number.POSITIVE_INFINITY)).toBe(false)
    expect(isValidResetAtMs('123')).toBe(false)
    expect(isValidResetAtMs(null)).toBe(false)
    expect(isValidResetAtMs(undefined)).toBe(false)
  })
})

/**
 * 聚合门控白名单 / 手工顺序表 / 排序模式（用户 2026-10-15 的新功能）。
 *
 * ⚠️ 判据的写法照本文件的既有纪律：`sanitize*` 的返回值断言是**必要但不足**的
 *    （`:304` 那条教训：7 条 sanitize 单测全绿、生产零调用者）——
 *    真正的守卫是**跨实例读回**与**载荷逐键在**，见下面两组。
 */
describe('sanitizeAggregateAllowed（只认显式 true；空层不保留；畸形退化空表）', () => {
  it("只留 true，false / 1 / 字符串 true 一律丢弃", () => {
    expect(sanitizeAggregateAllowed({
      m: { minimax: { r1: true, r2: false, r3: 1, r4: 'true' } },
    })).toEqual({ m: { minimax: { r1: true } } })
  })

  it('空层逐级不保留（不留 { m: {} } / { m: { minimax: {} } }）', () => {
    expect(sanitizeAggregateAllowed({ m: { minimax: {}, empty: { r: false } } })).toEqual({})
  })

  it('畸形输入一律退化空表（含数组 —— typeof [] === object）', () => {
    expect(sanitizeAggregateAllowed([])).toEqual({})
    expect(sanitizeAggregateAllowed('x')).toEqual({})
    expect(sanitizeAggregateAllowed(null)).toEqual({})
    expect(sanitizeAggregateAllowed({ m: [] })).toEqual({})
    expect(sanitizeAggregateAllowed({ m: { minimax: [] } })).toEqual({})
  })
})

describe('sanitizeAggregateOrder（只留含 NUL 的非空字符串，去重保序）', () => {
  it('丢掉不含分隔符的元素、空串、非字符串与重复项', () => {
    expect(sanitizeAggregateOrder({
      m: ['buddy\u0000r1', 'buddy\u0000r1', 'no-separator', '', 42, 'trae\u0000r2'],
    })).toEqual({ m: ['buddy\u0000r1', 'trae\u0000r2'] })
  })

  it('空数组 / 非数组 / 畸形一律丢键（= 未自定义）', () => {
    expect(sanitizeAggregateOrder({ empty: [], bad: 'not-an-array' })).toEqual({})
    expect(sanitizeAggregateOrder([])).toEqual({})
    expect(sanitizeAggregateOrder('x')).toEqual({})
  })
})

describe('sanitizeAggregateOrderMode（只有字面量 manual 才算手工）', () => {
  it('逐格', () => {
    expect(sanitizeAggregateOrderMode('manual')).toBe('manual')
    expect(sanitizeAggregateOrderMode('expiry')).toBe('expiry')
    expect(sanitizeAggregateOrderMode(undefined)).toBe('expiry')
    expect(sanitizeAggregateOrderMode(null)).toBe('expiry')
    expect(sanitizeAggregateOrderMode('MANUAL')).toBe('expiry')
    expect(sanitizeAggregateOrderMode(1)).toBe('expiry')
  })
})

describe('清层/白名单纯函数（`clearRejectionLayer` 只服务 D4 那一条既有路径）', () => {
  const REJECTIONS = { m: { buddy: { driftOld: true, other: true }, trae: { a: true } } }

  it('clearRejectionLayer 清的是**整渠道层**（D4：重新打开一条 = 整渠道恢复）', () => {
    expect(clearRejectionLayer(REJECTIONS, 'm', 'buddy')).toEqual({ m: { trae: { a: true } } })
  })

  it('clearRejectionLayer 逐级删层，且**不改入参**', () => {
    expect(clearRejectionLayer({ m: { buddy: { a: true } } }, 'm', 'buddy')).toEqual({})
    expect(clearRejectionLayer(REJECTIONS, 'm', 'buddy')).not.toBe(REJECTIONS)
    expect(REJECTIONS.m.buddy).toEqual({ driftOld: true, other: true })
  })

  it('clearRejectionLayer 对不存在的键是恒等（不抛错、不造空层）', () => {
    expect(clearRejectionLayer({}, 'm', 'buddy')).toEqual({})
    expect(clearRejectionLayer({ m: {} }, 'm', 'buddy')).toEqual({})
  })

  it('withoutAllowed 只删同键（同渠道其它候选的手工打开状态必须保留）', () => {
    const before = { m: { minimax: { r1: true, r2: true } } }
    expect(withoutAllowed(before, 'm', 'minimax', 'r1')).toEqual({ m: { minimax: { r2: true } } })
    expect(withoutAllowed({ m: { minimax: { r1: true } } }, 'm', 'minimax', 'r1')).toEqual({})
    expect(before).toEqual({ m: { minimax: { r1: true, r2: true } } })
  })

  it('withAllowed 幂等、不改入参，并能合并进已有渠道层', () => {
    expect(withAllowed({}, 'm', 'minimax', 'r1')).toEqual({ m: { minimax: { r1: true } } })
    expect(withAllowed(withAllowed({}, 'm', 'minimax', 'r1'), 'm', 'minimax', 'r1'))
      .toEqual({ m: { minimax: { r1: true } } })
    expect(withAllowed({ m: { minimax: { r1: true } } }, 'm', 'minimax', 'r2'))
      .toEqual({ m: { minimax: { r1: true, r2: true } } })
  })
})

describe('★ 三个新键必须在两个后端都能跨实例读回（不是只断言 sanitize）', () => {
  const ALLOWED = { 'deepseek-v4-1-flash': { minimax: { 'MiniMax-M3': true } } }
  const ORDER = { 'deepseek-v4-1-flash': ['minimax\u0000MiniMax-M3'] }

  it('老契约后端：载荷逐键在 + 能读回', async () => {
    let saved: Record<string, unknown> | undefined
    const scope = {
      get: () => saved,
      replace: async (section: object) => { saved = section as Record<string, unknown> },
    }
    const store = createJetHubStore(makeCtx({ register: () => scope, describe: () => [] }))
    await store.save({
      accounts: [],
      disabledModels: {},
      aggregateAllowed: ALLOWED,
      aggregateOrder: ORDER,
      aggregateOrderMode: 'manual',
    })

    // ① `replace` 是整体替换语义 ⇒ 载荷漏键 = 永不落盘 + 任何写入都抹掉它
    expect(saved?.aggregateAllowed).toEqual(ALLOWED)
    expect(saved?.aggregateOrder).toEqual(ORDER)
    expect(saved?.aggregateOrderMode).toBe('manual')
    // ② 且能读回（不是只写进载荷、读时又丢掉）
    expect(store.load()?.aggregateAllowed).toEqual(ALLOWED)
    expect(store.load()?.aggregateOrder).toEqual(ORDER)
    expect(store.load()?.aggregateOrderMode).toBe('manual')
  })

  it('文件后端：新实例能读回（跨重启持久化）', async () => {
    const writer = createJetHubStore(makeCtx(undefined))
    await writer.save({
      accounts: [],
      disabledModels: {},
      aggregateAllowed: ALLOWED,
      aggregateOrder: ORDER,
      aggregateOrderMode: 'manual',
    })

    const reader = createJetHubStore(makeCtx(undefined))
    expect(reader.load()?.aggregateAllowed).toEqual(ALLOWED)
    expect(reader.load()?.aggregateOrder).toEqual(ORDER)
    expect(reader.load()?.aggregateOrderMode).toBe('manual')
  })

  it('老文档没有这三个键时缺省为空/临期序（= 升级前行为）', () => {
    mkdirSync(join(dir, 'jet-hub'), { recursive: true })
    writeFileSync(
      join(dir, 'jet-hub', 'state.json'),
      JSON.stringify({ accounts: [], disabledModels: {} }),
      'utf-8',
    )
    const state = createJetHubStore(makeCtx(undefined)).load()
    expect(state?.aggregateAllowed).toEqual({})
    expect(state?.aggregateOrder).toEqual({})
    expect(state?.aggregateOrderMode).toBe('expiry')
  })
})

/**
 * ★★ P2（2026-10-25 审计 B2-1）：备份文件里的**非法代理字符串**必须在
 * `sanitizeAccounts` 处就被挡下。
 *
 * ## 缺陷链（真跑端点实测）
 *
 * `sanitizeAccounts` 用 `{ ...candidate }` **原样透传**代理字段，只限「是不是
 * 字符串」、不限「是不是合法代理」。于是：
 *
 * ```
 * backup.import（载荷 accounts[0].qoderProxy = "ftp://host:21"）
 *   → RPC 返回 ok:true、账号落池
 *   → 此后该账号每次取 fetcher 都抛「代理地址无效 — 不支持的协议 ftp」
 *   → 该账号**永久不可用**
 * ```
 *
 * ⚠️ 而客户端**有**导入按钮（`jet-hub.js` 的 `backup.import`）⇒ 这条路径
 * **UI 可达**（A2 只找到 `account.create` 那条「零客户端写入点」的腿，B2-1 找到了真正可达的入口）。
 * 池自己的注释也早已把备份文件当**不可信输入**（`qoderProxyFor` 明写「池里可能
 * 存在 `"qoderProxy": 12345`」），却只防了非字符串。
 *
 * ## 为什么修在 `sanitizeAccounts`（而不是各 provider 的读取侧）
 *
 * 四个 provider（opencode / gemini / minimaxintl / qoder）的解析器**同形**地
 * 在读取侧 `throw`。改读取侧要四处同改、且会让三家分叉；而 `sanitizeAccounts`
 * 是「外部数据 → 池」的**唯一闸门**（`state.json` 读取与 `backup.import` 都过它）
 * ⇒ 一处修复，四个字段同时受益，四个 provider 的读取侧永远遇不到脏值。
 *
 * ## 处置：清掉该字段（降级直连），**不是**丢弃整条账号
 *
 * 丢账号会让用户「导入后少了几个号」且不知道为什么；清字段只是让该账号回到
 * 「直连」，面板上「当前：直连」一眼可见、可重填。**删一个字段比删一条账号可逆得多。**
 */
describe('★ sanitizeAccounts：非法代理字符串必须被挡下（不是原样透传）', () => {
  const proxies = ['opencodeProxy', 'geminiProxy', 'minimaxIntlProxy', 'qoderProxy'] as const

  it('★★ 非法 scheme（ftp://…）⇒ 清掉该字段，但保留账号', () => {
    for (const field of proxies) {
      const accounts = sanitizeAccounts([
        { id: 'a', provider: 'qoder', credentialRef: 'QODER_ACCOUNT_A', [field]: 'ftp://host:21' },
      ])
      // ⚠️ 账号必须还在（丢账号比丢字段糟得多）
      expect(accounts, field).toHaveLength(1)
      // ⚠️ 枢轴：脏值不得进池（否则该账号每次取 fetcher 都抛 ⇒ 永久不可用）
      expect((accounts[0] as Record<string, unknown>)[field], field).toBeUndefined()
    }
  })

  it('★★ 合法代理必须逐字保留（不能把好值一起清掉）', () => {
    const good = [
      'http://127.0.0.1:7897',
      'https://user:pass@proxy.example:8443',
      'socks5://127.0.0.1:1080',
    ]
    for (const field of proxies) {
      for (const url of good) {
        const accounts = sanitizeAccounts([
          { id: 'a', provider: 'qoder', credentialRef: 'QODER_ACCOUNT_A', [field]: url },
        ])
        expect((accounts[0] as Record<string, unknown>)[field], `${field} ${url}`).toBe(url)
      }
    }
  })

  it('⚠️ 非字符串脏值仍然照旧降级（既有行为不变）', () => {
    for (const dirty of [12345, {}, [], true, null]) {
      const accounts = sanitizeAccounts([
        { id: 'a', provider: 'qoder', credentialRef: 'QODER_ACCOUNT_A', qoderProxy: dirty },
      ])
      // 非字符串：既有行为是原样透传后由读取侧 `asProxyText` 降级 —— 这里只要求
      // 「不崩、账号在」。取值形态不收紧（避免与既有断言冲突）。
      expect(accounts, JSON.stringify(dirty)).toHaveLength(1)
    }
  })
})
