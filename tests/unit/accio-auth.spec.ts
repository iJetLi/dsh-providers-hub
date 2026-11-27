import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AccioAuth, isAccioTerminalRefreshError, normalizeAccioModel, normalizeAccioRegion, parseAccioCatalog } from '../../src/accio-auth.js'
import { isAccioRefreshable } from '../../src/accio.js'
// ⚠️ 源码切片**必须**走它（行尾无关 + AST 括号匹配），理由见 refreshAll 用例的注释。
import { sourceScope } from '../helpers/source-scope.js'

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src')
const src = readFileSync(join(SRC_DIR, 'accio-auth.ts'), 'utf8')

describe('★ AccioAuth 源码级契约', () => {
  it('服务名由产品 id 派生（accioAuth）', () => {
    expect(src).toContain('AccioAuth')
  })

  it('⚠️⚠️ 续期必须串行：用 SerialQueue 且按 credentialRef 分键', () => {
    expect(src).toContain('SerialQueue')
    expect(src).toMatch(/refreshQueues/)
  })

  it('⚠️ refreshAll 不得按 enabled 过滤，也不得按池里的 refreshable 过滤', () => {
    // 两者都是本仓库真实事故的成因（单向门 / 停用账号凭据失效）
    expect(src).not.toMatch(/entry\.enabled\s*&&/)
    expect(src).not.toMatch(/!\s*entry\.enabled\s*\)\s*continue/)
    expect(src).not.toMatch(/!\s*entry\.refreshable\s*\)\s*continue/)
  })

  it('⚠️ 判终态前必须重读凭据（并发下服务端轮换的是旧的那份）', () => {
    expect(src).toMatch(/重读|reread|reload|重新读取/)
  })

  it('⚠️ 两步式：startLogin 先返回 loginUrl，不阻塞等授权', () => {
    expect(src).toMatch(/startLogin/)
    expect(src).toMatch(/loginUrl/)
  })

  /**
   * ⚠️ 上面那三条「不得过滤」是**整份源码**匹配 —— 注释里提到 `entry.refreshable`
   * 也会满足/违反它。故再锚定 `refreshAll` 的**实现片段**做一次（本仓库教训：
   * 整份文本匹配是空洞守卫）。
   *
   * ⚠️⚠️ **切片必须走 `sourceScope().fn()`，不能自己 `indexOf('\n  }\n')`**
   * （2026-10-13 实测的真实缺陷）：本仓库 `core.autocrlf=true`，源码在**工作区
   * 是 CRLF**，而 `'\n  }\n'` 在 CRLF 文本里**恒匹配不到**（实际是 `\r\n  }\r\n`）
   * ⇒ `end === -1` ⇒ 断言自己先 `toBeGreaterThan(start)` 就会**变红**（幸运），
   * 但换成 `slice(start, end)` 直接用的写法就会切到**文件尾部**、断言恒假绿。
   * 这正是 `tests/unit/source-scope.spec.ts`（issue IKJMG1）建立的 helper 要解决的
   * 问题：它按 AST 括号匹配、且**行尾无关**。
   *
   * ⚠️ 断言**只锚 `continue` 形态**，不禁 `entry.refreshable` 这个符号本身：
   * 「池里说不能续、凭据说能续」时打一条自愈日志是 `CodeArtsAuth` / `GeminiAuth`
   * 的既有做法（读它不等于拿它当门禁）。被禁的是「读到就 `continue`」——
   * 那才是单向门。
   */
  it('⚠️ 锚定 refreshAll 实现片段再判一次（防「注释满足断言」）', () => {
    // ⚠️ 行尾无关的切片（见上面注释：自写 indexOf('\n  }\n') 在 CRLF 下恒 -1）。
    const body = sourceScope(src).fn('refreshAll')
    expect(body.length).toBeGreaterThan(200)
    // `enabled` 在 refreshAll 里**没有任何合法用途**（连日志都不该读它）。
    expect(body).not.toMatch(/entry\.enabled/)
    expect(body).not.toMatch(/!\s*entry\.refreshable\s*\)\s*continue/)
    // 反向对照：正例必须真的出现，否则上面两条「不得」是空洞的（片段没取对）。
    expect(body).toMatch(/refreshAccountWithReconcile\(/)
  })
})

describe('AccioAuth 的续期判据读凭据，不读池值', () => {
  it('只要求 refresh_token 非空（判据来自 accio.ts 的纯函数）', () => {
    expect(isAccioRefreshable({ access_token: 'a', refresh_token: 'r', expires_at: 1, region: 'cn' })).toBe(true)
    expect(isAccioRefreshable({ access_token: 'a', refresh_token: '', expires_at: 1, region: 'cn' })).toBe(false)
  })
})

describe('★ 纯函数（Task 6 的适配器要复用，不许再写第二份）', () => {
  it('normalizeAccioRegion 收敛到白名单，未知值回落 cn', () => {
    expect(normalizeAccioRegion('global')).toBe('global')
    expect(normalizeAccioRegion('cn')).toBe('cn')
    // 客户端自报的 RPC 载荷没有 schema 校验（issue IKJLK3 E2 同因）。
    expect(normalizeAccioRegion('us')).toBe('cn')
    expect(normalizeAccioRegion(undefined)).toBe('cn')
    expect(normalizeAccioRegion({})).toBe('cn')
  })

  it('normalizeAccioModel：visible !== true 一律剔除（不可见模型不该进目录）', () => {
    expect(normalizeAccioModel({ modelCode: 'A', visible: false })).toBeUndefined()
    // ⚠️ 缺 `visible` 也剔除：上游是**显式**下发 true 的，缺字段表示未知。
    expect(normalizeAccioModel({ modelCode: 'A' })).toBeUndefined()
    expect(normalizeAccioModel({ visible: true })).toBeUndefined()
    expect(normalizeAccioModel(null)).toBeUndefined()
  })

  it('normalizeAccioModel：字段映射（倍率进 multiple，供适配器拼进 name）', () => {
    const model = normalizeAccioModel({
      modelCode: '1Drift-N8kP2Q7wR5mX',
      modelDisplayName: 'Qwen 3.8 27B',
      contextWindow: 512_000,
      multimodal: true,
      effectiveMultiple: 0.013,
      visible: true,
    })
    expect(model).toMatchObject({
      id: '1Drift-N8kP2Q7wR5mX',
      name: 'Qwen 3.8 27B',
      contextWindow: 512_000,
      supportsImage: true,
      multiple: 0.013,
    })
  })

  it('normalizeAccioModel：无显示名时回落 id（不让选择器出现空名）', () => {
    expect(normalizeAccioModel({ modelCode: '1X', visible: true })?.name).toBe('1X')
  })

  /**
   * ⚠️⚠️ **思考档位**（2026-10-13 真机实测后新增，用户要求）。
   *
   * 用户原话：「accio 的模型没有档位，需要有档位即使是只有一档也要显示，
   * 使用远端真实下发的档位」。
   *
   * 下面三条的**形状**全部来自真机探测（38 条目录）：
   * - 4 条 `数组(2档)` / 2 条 `数组(3档)` / 1 条 `数组(5档)`；
   * - **31 条 `null`**，其中 6 条**同时给了 `defaultReasoningEffort`**
   *   （GLM-5.3 `max` / MiniMax M3 `adaptive` / DeepSeek V4.1 Flash `high` …）。
   */
  describe('normalizeAccioModel：思考档位（远端真实下发）', () => {
    it('★ reasoningEfforts 数组原样接住（顺序不排 —— 那是服务端给的由弱到强）', () => {
      const m = normalizeAccioModel({
        modelCode: '1Orbit-Q7hN3xR6cP2m', modelDisplayName: 'Ultimate', visible: true,
        reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        defaultReasoningEffort: 'high',
      })
      // ⚠️ 断言**整个数组**（含顺序）：排序＝替服务端决定语义。
      expect(m?.efforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
      expect(m?.defaultEffort).toBe('high')
    })

    it('★ 关键格：reasoningEfforts 为 null 但 default 有值 ⇒ 保留 default（这是「单档」的来源）', () => {
      // 真机形态：GLM-5.3 / GLM-5.2 / GLM 5.3 Flash 的 default 都是 "max"。
      const m = normalizeAccioModel({
        modelCode: '1Chronos-L53W8nP2qR6m', modelDisplayName: 'GLM-5.3', visible: true,
        reasoningEfforts: null,
        defaultReasoningEffort: 'max',
      })
      // ⚠️ `efforts` 保持**缺席**（不是 `[]`）：空数组与「无信息」在 DSH 里
      //    是两回事 —— 前者会让档位声明被丢弃、后者根本不声明。
      expect(m?.efforts).toBeUndefined()
      expect(m?.defaultEffort).toBe('max')
    })

    it('★ MiniMax M3 的 default 是 "adaptive"（非 low/high 系，原样保留不归一）', () => {
      const m = normalizeAccioModel({
        modelCode: '1Zenith-M27hS2SR5xQ2p', modelDisplayName: 'MiniMax M3', visible: true,
        reasoningEfforts: null, defaultReasoningEffort: 'adaptive',
      })
      expect(m?.defaultEffort).toBe('adaptive')
    })

    it('★ 两者都为 null ⇒ 两个字段都缺席（不编造档位）', () => {
      const m = normalizeAccioModel({
        modelCode: '1Drift-F8hS3mK7pL2n', modelDisplayName: 'Qwen 3.8 Flash', visible: true,
        reasoningEfforts: null, defaultReasoningEffort: null,
      })
      expect(m?.efforts).toBeUndefined()
      expect(m?.defaultEffort).toBeUndefined()
    })

    it('★ 空数组与带脏值的数组都收敛成「无档位」（不产出空白项）', () => {
      for (const raw of [[], [''], ['  '], [null], [undefined], [1], [{}], 'low', 42]) {
        const m = normalizeAccioModel({
          modelCode: '1X', visible: true, reasoningEfforts: raw,
        })
        expect(m?.efforts, JSON.stringify(raw)).toBeUndefined()
      }
    })

    it('★ 数组里的脏值被逐个丢弃，合法值保留（不整组报废）', () => {
      const m = normalizeAccioModel({
        modelCode: '1X', visible: true,
        reasoningEfforts: ['low', null, '', 'high', 7],
      })
      expect(m?.efforts).toEqual(['low', 'high'])
    })

    it('★ defaultReasoningEffort 非字符串/空串 ⇒ 缺席（不给 DSH 一个非法档位 id）', () => {
      for (const raw of [null, undefined, '', '   ', 42, {}, []]) {
        const m = normalizeAccioModel({
          modelCode: '1X', visible: true, defaultReasoningEffort: raw,
        })
        expect(m?.defaultEffort, JSON.stringify(raw)).toBeUndefined()
      }
    })
  })

  it('parseAccioCatalog：展平 data[].modelList[] 且按倍率升序（便宜在前）', () => {
    const models = parseAccioCatalog({
      success: true,
      data: [
        { modelList: [
          { modelCode: 'B', modelDisplayName: 'B', visible: true, effectiveMultiple: 2.8 },
          { modelCode: 'A', modelDisplayName: 'A', visible: true, effectiveMultiple: 0.013 },
          { modelCode: 'HIDDEN', visible: false, effectiveMultiple: 0.001 },
        ] },
        { modelList: [{ modelCode: 'C', modelDisplayName: 'C', visible: true }] },
      ],
    })
    expect(models.map(m => m.id)).toEqual(['A', 'B', 'C'])
    // 无倍率的排最后（`undefined` 不参与排序比较，落到末尾）。
    expect(models[2]!.multiple).toBeUndefined()
  })

  it('⚠️⚠️ 两条都缺倍率时比较器必须返回 0（不能是 `Infinity - Infinity = NaN`）', () => {
    // ── 终审 Minor M-b 的守卫 ──
    // 原实现 `(a.multiple ?? Infinity) - (b.multiple ?? Infinity)` 在**两条都缺**时
    // 得到 `Infinity - Infinity = NaN`，而 `Array.prototype.sort` 的比较器返回 NaN
    // 是**未定义行为**（规范不保证顺序，不同引擎/不同长度下行为可能不同）。
    //
    // ⚠️⚠️ **本条的守卫是源码级断言，不是行为断言 —— 这是实测后的诚实选择**：
    //    在 Node 26（V8 的 TimSort）上实测，NaN 比较器对「3 条全缺」「12 条全缺」
    //    「缺与不缺混排」等输入**都恰好保序**（NaN 被当作「相等」处理），
    //    故**任何**行为用例在 V8 上都拦不住这个回归 —— 实测把实现还原成 NaN 版，
    //    下面那条行为用例**照样全绿**。行为用例保留是为了记录「稳定 + 缺者靠后」
    //    这个**意图**，真正的闸门是下面这条源码锁。
    //
    // ⚠️ 为什么不干脆删掉这个修复：`NaN` 比较器的行为**依赖引擎实现**，
    //    V8 今天恰好保序不等于规范保证；而代价是「目录顺序随机」这类**静默**缺陷。
    //    本仓库对这类「今天不炸、规范不保证」的形态一律留防线。
    const models = parseAccioCatalog({
      data: [{ modelList: [
        { modelCode: 'N1', modelDisplayName: 'N1', visible: true },
        { modelCode: 'N2', modelDisplayName: 'N2', visible: true },
        { modelCode: 'N3', modelDisplayName: 'N3', visible: true },
        { modelCode: 'CHEAP', modelDisplayName: 'CHEAP', visible: true, effectiveMultiple: 0.013 },
      ] }],
    })
    // 三条都无倍率 ⇒ 它们之间的相对顺序**必须保持稳定**（输入顺序），
    // 且**必须全部**排在有倍率的那条之后。
    expect(models.map(m => m.id)).toEqual(['CHEAP', 'N1', 'N2', 'N3'])
    // 且排序**不得**把任何条目丢掉。
    expect(models).toHaveLength(4)

    // ── 真正的闸门：源码里不得再出现「两边都兜底成 Infinity 再相减」这个形态 ──
    // ⚠️ 用文件顶部那份**剥掉注释**的源码（`src` 是 raw；这里要的是实现文本）。
    //    `src` 是整份源码（含注释），故断言锚定在**实现片段**上，避免被注释喂绿：
    //    先切出 `parseAccioCatalog` 的函数体再断言。
    // ⚠️ 切片走 `sourceScope().fn()`（行尾无关）—— 自写 `indexOf('\n}')` 在 CRLF
    //    工作区下恒 -1，见上面 `refreshAll` 用例的注释。
    const catalogBody = sourceScope(src).fn('parseAccioCatalog')
    expect(catalogBody, '目录解析函数里必须有一段排序').toMatch(/\.sort\(/)
    expect(catalogBody, '排序比较器必须显式处理「两边都缺倍率」')
      .toMatch(/left === undefined && right === undefined\)\s*return 0/)
    // 反向：`?? Number.POSITIVE_INFINITY) - (` 这个 NaN 形态必须已消失。
    expect(catalogBody, '排序比较器退回了 NaN 形态（Infinity - Infinity）')
      .not.toMatch(/POSITIVE_INFINITY\)\s*-\s*\(/)
  })

  it('parseAccioCatalog：形状不符时回空数组（不抛错、不产出半截数据）', () => {
    expect(parseAccioCatalog(undefined)).toEqual([])
    expect(parseAccioCatalog({})).toEqual([])
    expect(parseAccioCatalog({ data: 'nope' })).toEqual([])
    expect(parseAccioCatalog({ data: [{}] })).toEqual([])
  })

  /**
   * ⚠️ 终态判据必须**窄**：只有服务端明确说「这份 refresh_token 不认了」
   * 才算终态。网络抖动 / 5xx / 超时 / 泛化的 unauthorized 一律**可重试** ——
   * 把它们归为终态就是「一次瞬时失败固化成单向门」。
   */
  it('isAccioTerminalRefreshError：只认 refresh_token 本身失效的报文', () => {
    expect(isAccioTerminalRefreshError(new Error('accio: /api/auth/refresh_token 失败（400 invalid_grant）'))).toBe(true)
    expect(isAccioTerminalRefreshError(new Error('the refresh token has been used'))).toBe(true)
    expect(isAccioTerminalRefreshError(new Error('{"code":"401","message":"NOT_LOGIN"}'))).toBe(true)
    // 反向：这些**不是**终态。
    expect(isAccioTerminalRefreshError(new Error('accio: 返回非 JSON（HTTP 502）：<html>'))).toBe(false)
    expect(isAccioTerminalRefreshError(new Error('fetch failed'))).toBe(false)
    expect(isAccioTerminalRefreshError(new Error('accio: 失败（500 internal error）'))).toBe(false)
    expect(isAccioTerminalRefreshError(new Error('accio: 失败（403 forbidden）'))).toBe(false)
    expect(isAccioTerminalRefreshError(new Error('The operation was aborted due to timeout'))).toBe(false)
  })
})

// ── 行为用例 ────────────────────────────────────────────────────────────

/** 最小化的内存凭据提供者，形状与 ctx.credentials 一致。 */
class FakeCredentials {
  private store = new Map<string, string>()
  async resolve(ref: string) {
    const value = this.store.get(ref)
    return value === undefined ? undefined : { value, source: 'fake' }
  }
  async describe(ref: string) {
    return { configured: this.store.has(ref), source: this.store.has(ref) ? 'fake' : undefined, writable: true }
  }
  async set(ref: string, value: string) { this.store.set(ref, value) }
  async unset(ref: string) { this.store.delete(ref) }
}

function makeContext(): { ctx: Context; credentials: FakeCredentials } {
  const ctx = new Context()
  const credentials = new FakeCredentials()
  ctx.provide('credentials', credentials as never)
  return { ctx, credentials }
}

/** 所有已创建的 service；afterEach 统一 stop()。 */
const services: AccioAuth[] = []

function newService(ctx: Context, options: { fetcher?: typeof fetch } = {}): AccioAuth {
  const service = new AccioAuth(ctx, options)
  services.push(service)
  return service
}

interface FakeEntry {
  id: string
  credentialRef: string
  enabled?: boolean
  refreshable?: boolean
  expiresAt?: number
}

/**
 * 账号池替身。
 *
 * ⚠️ `enabled` / `refreshable` 都**可显式设为 false** —— 那正是
 * 「不得按它们过滤」这两条铁律的判别力所在。
 */
function makePool(entries: FakeEntry[] = []) {
  const accounts = entries.map(e => ({
    id: e.id,
    provider: 'accio',
    nickname: e.id,
    enabled: e.enabled ?? true,
    credentialRef: e.credentialRef,
    createdAt: 0,
    refreshable: e.refreshable ?? true,
    ...(e.expiresAt === undefined ? {} : { expiresAt: e.expiresAt }),
  }))
  const patches: Array<{ id: string; patch: Record<string, unknown> }> = []
  const pool = {
    accounts,
    patches,
    listAccounts: async () => accounts,
    listAllAccounts: async () => accounts,
    getAvailableAccount: async () => null,
    findAccountIdByCredential: async () => '',
    addAccount: vi.fn(async (entry: Record<string, unknown>) => {
      accounts.push(entry as never)
    }),
    removeAccount: vi.fn(async (id: string) => {
      const index = accounts.findIndex(a => a.id === id)
      if (index >= 0) accounts.splice(index, 1)
    }),
    updateAccount: vi.fn(async (id: string, patch: Record<string, unknown>) => {
      patches.push({ id, patch })
      const target = accounts.find(a => a.id === id)
      if (target !== undefined) Object.assign(target, patch)
    }),
  }
  return pool
}

/** 某账号被写过的 patch 序列。 */
function patchesFor(pool: ReturnType<typeof makePool>, id: string): Array<Record<string, unknown>> {
  return pool.patches.filter(p => p.id === id).map(p => p.patch)
}

/** 一次成功的续期/兑换响应。⚠️ `expiresAt` 是**秒**（上游量纲）。 */
function tokenEnvelope(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    success: true,
    code: '200',
    data: {
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
      expiresAt: Math.floor((Date.now() + 7_200_000) / 1000),
      ...overrides,
    },
  })
}

/** 一份「可续期」的凭据（`expiresInMs` 控制是否落在 lead-time 窗口内）。 */
function credentialJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    access_token: 'old-access',
    refresh_token: 'old-refresh',
    expires_at: Date.now() + 60_000,
    region: 'cn',
    ...overrides,
  })
}

afterEach(() => {
  for (const service of services) service.stop()
  services.length = 0
  vi.clearAllMocks()
})

describe('★ refreshAll：两条「不得过滤」铁律（真实事故）', () => {
  /**
   * 用户报障（2026-10-02，codearts）：「账号池出现 2 个 401，自动续期没有工作吗？
   * 重启也还是 401」。取证结论是池里那个 `refreshable` 布尔只是**凭据材料的
   * 镜像**，被误标成 false 之后就成了**单向门** —— 该账号此后永不进入续期循环，
   * 而凭据本体完好。
   *
   * 另一条（停用账号）：「两个曾停用的账号显示凭据过期，重新启用后拿到的是
   * 死凭据」—— 停用只该影响自动选号，与凭据是否需要保鲜无关。
   *
   * 本条**同时**把两个误标叠在一起（`enabled: false` + `refreshable: false`）
   * 且凭据**真的需要续期**（落在 lead-time 窗口内）⇒ 只要代码里出现任一
   * 过滤，本用例必红。
   */
  it('⚠️ 池里 enabled:false 且 refreshable:false，凭据齐全时照样续期（两个误标都不是门禁）', async () => {
    const { ctx, credentials } = makeContext()
    await credentials.set('ACCIO_ACCOUNT_1', credentialJson())
    const pool = makePool([{
      id: 'accio-1',
      credentialRef: 'ACCIO_ACCOUNT_1',
      enabled: false,
      refreshable: false,
    }])
    const fetcher = vi.fn(async () => new Response(tokenEnvelope(), { status: 200 }))
    const service = newService(ctx, { fetcher: fetcher as unknown as typeof fetch })

    await service.refreshAll(pool as never)

    expect(fetcher, '被误标成不可续期后就不发续期请求 = 单向门复发').toHaveBeenCalledTimes(1)
    const stored = JSON.parse((await credentials.resolve('ACCIO_ACCOUNT_1'))!.value) as Record<string, string>
    expect(stored.refresh_token).toBe('new-refresh')
    // 自愈：对账时把池里的 refreshable 改回 true（凭据材料说了算）。
    expect(patchesFor(pool, 'accio-1')).toContainEqual(
      expect.objectContaining({ refreshable: true }),
    )
  })

  /**
   * ⚠️「本轮不刷」的分支**绝不能直接 `continue`** —— 存量账号的凭据早已在
   * 别处（IDE / 上一轮）续好，池里还是旧值；跳过时若不对账，UI 会**永远**
   * 显示「已过期」。判据是「与凭据不一致」（不是「池值已过期」）。
   */
  it('⚠️ 本轮无需续期时仍要做有效期对账（否则池里旧值永远无人更正）', async () => {
    const { ctx, credentials } = makeContext()
    // 距过期 6 小时 ⇒ 远超 1 小时 lead-time，本轮不发请求。
    const expiresAt = Date.now() + 6 * 3_600_000
    await credentials.set('ACCIO_ACCOUNT_1', credentialJson({ expires_at: expiresAt }))
    const pool = makePool([{
      id: 'accio-1',
      credentialRef: 'ACCIO_ACCOUNT_1',
      refreshable: true,
      expiresAt: 1,                       // 陈旧池值
    }])
    const fetcher = vi.fn(async () => new Response(tokenEnvelope(), { status: 200 }))
    const service = newService(ctx, { fetcher: fetcher as unknown as typeof fetch })

    await service.refreshAll(pool as never)

    expect(fetcher, '仍在有效期内不该发续期请求').not.toHaveBeenCalled()
    const expiryPatch = patchesFor(pool, 'accio-1').find(p => 'expiresAt' in p)
    expect(expiryPatch, '「不刷」不等于「不回写」—— 池值必须被对账').toBeDefined()
    expect(Math.abs((expiryPatch!.expiresAt as number) - expiresAt)).toBeLessThan(1000)
  })

  /**
   * 并发下服务端轮换的是**旧的**那份 refresh_token，磁盘上此刻可能躺着一份
   * **新的、可用**的凭据（同机 web + desktop 两个实例各自持锁，跨进程互踩
   * 只能靠这条判据兜）。少了它，一次交错就把好账号永久标死。
   */
  it('⚠️ 续期被拒但凭据已被他处换新（并发重放）→ 不标死，改用最新凭据对账', async () => {
    const { ctx, credentials } = makeContext()
    await credentials.set('ACCIO_ACCOUNT_1', credentialJson())
    const pool = makePool([{ id: 'accio-1', credentialRef: 'ACCIO_ACCOUNT_1', refreshable: true }])
    const freshExpiry = Date.now() + 5 * 3_600_000
    const fetcher = vi.fn(async () => {
      // 模拟另一个实例在我们发请求期间续期成功（轮换了 refresh_token）。
      await credentials.set('ACCIO_ACCOUNT_1', credentialJson({
        access_token: 'other-access', refresh_token: 'fresh-refresh', expires_at: freshExpiry,
      }))
      return new Response(JSON.stringify({
        success: false, code: '400', message: 'invalid_grant',
      }), { status: 200 })
    })
    const service = newService(ctx, { fetcher: fetcher as unknown as typeof fetch })

    await service.refreshAll(pool as never)

    expect(patchesFor(pool, 'accio-1').some(p => p.refreshable === false)).toBe(false)
    const expiryPatch = patchesFor(pool, 'accio-1').find(p => 'expiresAt' in p)
    expect(expiryPatch).toBeDefined()
    expect(Math.abs((expiryPatch!.expiresAt as number) - freshExpiry)).toBeLessThan(1000)
  })

  it('refresh_token 真失效（凭据未被换过）→ 标不可续期且不动凭据本体', async () => {
    const { ctx, credentials } = makeContext()
    await credentials.set('ACCIO_ACCOUNT_1', credentialJson())
    const pool = makePool([{ id: 'accio-1', credentialRef: 'ACCIO_ACCOUNT_1', refreshable: true }])
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      success: false, code: '400', message: 'invalid_grant',
    }), { status: 200 }))
    const service = newService(ctx, { fetcher: fetcher as unknown as typeof fetch })

    await service.refreshAll(pool as never)

    expect(patchesFor(pool, 'accio-1')).toContainEqual({ refreshable: false })
    const stored = JSON.parse((await credentials.resolve('ACCIO_ACCOUNT_1'))!.value) as Record<string, string>
    expect(stored.refresh_token).toBe('old-refresh')
  })

  it('凭据确实缺材料时标不可续期，且不发请求', async () => {
    const { ctx, credentials } = makeContext()
    await credentials.set('ACCIO_ACCOUNT_1', credentialJson({ refresh_token: '' }))
    const pool = makePool([{ id: 'accio-1', credentialRef: 'ACCIO_ACCOUNT_1', refreshable: true }])
    const fetcher = vi.fn(async () => new Response(tokenEnvelope(), { status: 200 }))
    const service = newService(ctx, { fetcher: fetcher as unknown as typeof fetch })

    await service.refreshAll(pool as never)

    expect(fetcher).not.toHaveBeenCalled()
    expect(patchesFor(pool, 'accio-1')).toContainEqual({ refreshable: false })
  })

  it('单个账号终态失败不得中断其余账号', async () => {
    const { ctx, credentials } = makeContext()
    await credentials.set('ACCIO_ACCOUNT_1', credentialJson())
    await credentials.set('ACCIO_ACCOUNT_2', credentialJson({ refresh_token: 'rt-b' }))
    const pool = makePool([
      { id: 'accio-1', credentialRef: 'ACCIO_ACCOUNT_1', refreshable: true },
      { id: 'accio-2', credentialRef: 'ACCIO_ACCOUNT_2', refreshable: true },
    ])
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { refreshToken?: string }
      if (body.refreshToken === 'old-refresh') {
        return new Response(JSON.stringify({ success: false, code: '400', message: 'invalid_grant' }), { status: 200 })
      }
      return new Response(tokenEnvelope(), { status: 200 })
    })
    const service = newService(ctx, { fetcher: fetcher as unknown as typeof fetch })

    await service.refreshAll(pool as never)

    const stored2 = JSON.parse((await credentials.resolve('ACCIO_ACCOUNT_2'))!.value) as Record<string, string>
    expect(stored2.refresh_token).toBe('new-refresh')
  })
})

describe('★ 续期串行：per-ref SerialQueue（Accio 刷新会轮换 refresh_token）', () => {
  it('⚠️ 同一 ref 的并发续期只发一次请求（第二条看到已续好就短路）', async () => {
    const { ctx, credentials } = makeContext()
    await credentials.set('ACCIO_ACCOUNT_1', credentialJson())
    let calls = 0
    const fetcher = vi.fn(async () => {
      calls += 1
      // 让两个并发请求真正重叠（队列未生效时两者都会走到这里）。
      await new Promise(resolve => setTimeout(resolve, 10))
      return new Response(tokenEnvelope(), { status: 200 })
    })
    const service = newService(ctx, { fetcher: fetcher as unknown as typeof fetch })

    // 三条续期入口（定时器 / 推理按需 / 面板按钮）在 DSH 里天然并发。
    await Promise.all([
      service.refreshAccountCredential('ACCIO_ACCOUNT_1'),
      service.refreshAccountCredential('ACCIO_ACCOUNT_1'),
    ])

    expect(calls, '并发消费同一份 refresh_token ⇒ 1 个成功、其余 invalid_grant').toBe(1)
  })

  it('refreshAccountCredential 会把新有效期回写账号池（否则 UI 永远显示「已过期」）', async () => {
    const { ctx, credentials } = makeContext()
    await credentials.set('ACCIO_ACCOUNT_1', credentialJson())
    const pool = makePool([{ id: 'accio-1', credentialRef: 'ACCIO_ACCOUNT_1', refreshable: true }])
    const fetcher = vi.fn(async () => new Response(tokenEnvelope(), { status: 200 }))
    const service = newService(ctx, { fetcher: fetcher as unknown as typeof fetch })

    await service.refreshAccountCredential('ACCIO_ACCOUNT_1', pool as never, 'accio-1')

    const expiryPatch = patchesFor(pool, 'accio-1').find(p => 'expiresAt' in p)
    expect(expiryPatch).toBeDefined()
    expect(expiryPatch!.expiresAt as number).toBeGreaterThan(Date.now())
  })
})

describe('★ 两步式登录：先返回 loginUrl，不阻塞等授权', () => {
  it('startLogin 立即返回 loginUrl 与占位条目，回调到达后才写凭据', async () => {
    const { ctx, credentials } = makeContext()
    const pool = makePool()
    const fetcher = vi.fn(async () => new Response(tokenEnvelope(), { status: 200 }))
    const service = newService(ctx, { fetcher: fetcher as unknown as typeof fetch })

    const started = await service.startLogin({
      region: 'cn',
      refName: 'ACCIO_ACCOUNT_1',
      pool: pool as never,
      accountId: 'accio-1',
    })
    try {
      // ① 授权尚未发生：不得有任何兑换请求，且 loginUrl 已就绪。
      expect(fetcher).not.toHaveBeenCalled()
      expect(started.loginUrl.startsWith('https://www.accio-ai.com/login?')).toBe(true)
      const query = new URL(started.loginUrl).searchParams
      const redirectUri = query.get('return_url') ?? ''
      expect(redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/)
      // ② 占位条目已登记 ⇒ 前端 login.poll 能立刻看到进度。
      expect(pool.accounts).toHaveLength(1)
      expect(pool.accounts[0]).toMatchObject({ id: 'accio-1', refreshable: false })

      // ③ 模拟浏览器回调（state 由我们生成，必须原样带回）。
      const callback = await fetch(`${redirectUri}?code=CODE&state=${query.get('state') ?? ''}`)
      expect(callback.status).toBe(200)
      await started.result

      /**
       * ★★★ **两次，且必须是「兑换 + 补身份」**（issue #177，2026-11-27）。
       *
       * 改前只有 token 兑换（要 1 次）。现在登录后会多打一次 `POST /api/auth/userinfo`
       * —— 为的是拿 `activeTeam.teamId`（团队空间必需）与真实昵称。
       *
       * ⚠️ **只把 1 改成 2 是弱断言**（任何多出来的请求都能过）⇒ 这里同时断言
       * 两次请求的**端点与顺序**，这样「把 userinfo 换成别的请求」也会红。
       */
      expect(
        fetcher,
        '两次：① token 兑换 ② 登录后补 userinfo（团队身份来源，issue #177）',
      ).toHaveBeenCalledTimes(2)
      const calledUrls = fetcher.mock.calls.map((call) => String((call as unknown[])[0]))
      expect(calledUrls[0], '第一次必须是 token 兑换').toContain('/api/oauth/token')
      expect(calledUrls[1], '第二次必须是 userinfo（团队身份）').toContain('/api/auth/userinfo')
      const stored = JSON.parse((await credentials.resolve('ACCIO_ACCOUNT_1'))!.value) as Record<string, string>
      expect(stored.refresh_token).toBe('new-refresh')
      expect(pool.accounts[0]).toMatchObject({ id: 'accio-1', refreshable: true })
      expect(pool.accounts[0]!.expiresAt as number).toBeGreaterThan(Date.now())
    } finally {
      started.close()
    }
  })

  it('⚠️ state 不匹配即拒绝（否则任意回调都能把凭据写进用户账号）', async () => {
    const { ctx } = makeContext()
    const fetcher = vi.fn(async () => new Response(tokenEnvelope(), { status: 200 }))
    const service = newService(ctx, { fetcher: fetcher as unknown as typeof fetch })

    const started = await service.startLogin({ region: 'global', refName: 'ACCIO_ACCOUNT_2' })
    try {
      expect(started.loginUrl.startsWith('https://zh.accio.com/login?')).toBe(true)
      const redirectUri = new URL(started.loginUrl).searchParams.get('return_url') ?? ''
      const callback = await fetch(`${redirectUri}?code=CODE&state=WRONG`)
      expect(callback.status).toBe(400)
      await expect(started.result).rejects.toThrow(/state/)
      expect(fetcher).not.toHaveBeenCalled()
    } finally {
      started.close()
    }
  })

  it('⚠️ 登录失败时删除占位条目（不留无凭据的幽灵账号）', async () => {
    const { ctx } = makeContext()
    const pool = makePool()
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      success: false, code: '400', message: 'PKCE verification failed',
    }), { status: 200 }))
    const service = newService(ctx, { fetcher: fetcher as unknown as typeof fetch })

    const started = await service.startLogin({
      region: 'cn',
      refName: 'ACCIO_ACCOUNT_3',
      pool: pool as never,
      accountId: 'accio-3',
    })
    try {
      expect(pool.accounts).toHaveLength(1)
      const redirectUri = new URL(started.loginUrl).searchParams.get('return_url') ?? ''
      const state = new URL(started.loginUrl).searchParams.get('state') ?? ''
      await fetch(`${redirectUri}?code=CODE&state=${state}`)
      await expect(started.result).rejects.toThrow(/PKCE/)
      expect(pool.removeAccount).toHaveBeenCalledWith('accio-3')
      expect(pool.accounts).toHaveLength(0)
    } finally {
      started.close()
    }
  })

  /**
   * ⚠️ 前端关掉弹窗时会调 `close()`。若此时不落定 `result`，那个 Promise 会
   * 一直挂到 10 分钟超时 —— 而占位条目也一直留在账号列表里（幽灵账号）。
   */
  it('⚠️ close() 幂等且会落定结果、清掉占位条目（用户取消不留幽灵账号）', async () => {
    const { ctx } = makeContext()
    const pool = makePool()
    const service = newService(ctx)

    const started = await service.startLogin({
      region: 'cn',
      refName: 'ACCIO_ACCOUNT_4',
      pool: pool as never,
      accountId: 'accio-4',
    })
    expect(pool.accounts).toHaveLength(1)
    started.close()
    started.close()
    await expect(started.result).rejects.toThrow(/取消/)
    expect(pool.accounts).toHaveLength(0)
  })

  it('⚠️ 登录成功后不写 enabled（重新登录一个已停用账号不该把它静默启用）', async () => {
    const { ctx } = makeContext()
    const pool = makePool()
    const fetcher = vi.fn(async () => new Response(tokenEnvelope(), { status: 200 }))
    const service = newService(ctx, { fetcher: fetcher as unknown as typeof fetch })

    const started = await service.startLogin({
      region: 'cn',
      refName: 'ACCIO_ACCOUNT_5',
      pool: pool as never,
      accountId: 'accio-5',
    })
    try {
      const redirectUri = new URL(started.loginUrl).searchParams.get('return_url') ?? ''
      const state = new URL(started.loginUrl).searchParams.get('state') ?? ''
      await fetch(`${redirectUri}?code=CODE&state=${state}`)
      await started.result
      expect(patchesFor(pool, 'accio-5').some(p => 'enabled' in p)).toBe(false)
    } finally {
      started.close()
    }
  })
})
