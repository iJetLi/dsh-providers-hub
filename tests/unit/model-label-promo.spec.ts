import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 模型选择器每行的名字 / 徽标 / **悬停**（`conversation.input.model.label`，方案 A）。
 *
 * ## 为什么必须写在行为上
 *
 * 本槽位是 `single`：注册成功即成为**所有** provider 行的渲染方。两条腿
 * （自家候选 + 长悬停 / 外来行的宿主 badge）任何一条被 `if (false)` 短路,
 * 源码文本断言照样全绿，而界面上是「别人的徽标整片消失」或「长句永不出现」
 * —— 都是零报错的静默失效。⇒ 用替身 React 真跑组件，断言**产出元素的 props**。
 *
 * ## ⚠️ 替身必须**真的执行** useEffect
 *
 * 第一版把 `useEffect` 写成空函数，于是「取数失败保留上一次快照」「缓存到期后
 * 重新取数」「同一时刻只发一次请求」三条腿**一次都跑不到** —— 三条变异
 * （清空快照 / 不记时间 / 去掉单飞闸门）实测 9 条全绿。用例名承诺了它没验证的
 * 事，比没有用例更糟。⇒ 这里 useEffect 同步执行回调（组件的取数与订阅都在效果里）。
 *
 * ## 夹具纪律（本仓踩过多次）
 *
 * 每个变量必须独立：候选表、provider id、model id、badge、读者语言、时钟
 * 分开造。尤其**语言**：宿主 badge.text 是表形态（LocalizedText），按读者语言
 * 挑一格，不 stub 的话期望值会随跑测试的机器 locale 翻脸。
 */

interface Node { type: unknown; props: Record<string, any>; children: unknown[] }

const created: Node[] = []

/**
 * 每次 useState 交出的 setter 都收进来，并**记录它被调用过** ——
 * 「取数完成后有没有叫醒已挂载的行」只能这样观察（替身没有真 React 的重渲染）。
 */
const stateSetters: Array<(fn: unknown) => unknown> = []
const stateCalls: unknown[] = []
/** 已挂载效果的清理函数（模拟卸载）。 */
const effectCleanups: Array<() => unknown> = []

const reactStub = {
  useState: (initial: unknown) => {
    const setter = (fn: unknown) => { stateCalls.push(fn); return fn }
    stateSetters.push(setter)
    return [initial, setter]
  },
  useRef: (initial: unknown) => ({ current: initial }),
  // 同步跑效果：组件的取数、订阅都挂在这里，吞掉 = 整条腿零覆盖。
  // ⚠️ 必须**收下清理函数**并在 afterEach 跑：真实 React 卸载时会跑它，
  // 而心跳定时器住在模块级 subscribeTick 里 —— 不回收的话第一个用例之后
  // tickTimer 永远非 null，后续用例的 setInterval 根本没被建立，
  // 「过期后由心跳重新取数」那条腿会假绿（实测：期望 2 得到 1）。
  useEffect: (fn: () => unknown) => {
    const cleanup = fn()
    if (typeof cleanup === 'function') effectCleanups.push(cleanup)
  },
  useMemo: (fn: () => unknown) => fn(),
  useCallback: (fn: unknown) => fn,
  useLayoutEffect: (fn: () => unknown) => { fn() },
  Fragment: 'Fragment',
  StrictMode: 'StrictMode',
  createElement(type: unknown, props: Record<string, any> | null, ...children: unknown[]) {
    const node: Node = { type, props: props ?? {}, children }
    created.push(node)
    return node
  },
}

vi.mock('react', () => reactStub)

let mod: typeof import('../../plugin-src/client/model-label.js')

async function load() {
  mod ??= await import('../../plugin-src/client/model-label.js')
  return mod
}

/** RPC 替身：记录调用次数，可切成功 / 失败 / 挂起。 */
let rpcCount = 0
type Behavior = (method: string) => Promise<unknown>
let behavior: Behavior = async () => ({ providers: {} })
const rpc = (async (method: string) => { rpcCount += 1; return behavior(method) }) as never

/** 让挂起的 Promise 链全部落地（替身 React 是同步的，取数仍是异步）。 */
async function flush() {
  for (let i = 0; i < 8; i += 1) await Promise.resolve()
}

function countingRpc(): never {
  return rpc
}

const ctxStub = {
  slots: {
    inject: (_name: string, cb: () => unknown) => { cb(); return () => {} },
    register: () => () => {},
  },
  logger: { warn: () => {} },
} as never

function findAll(node: Node | null, className: string): Node[] {
  const out: Node[] = []
  const walk = (n: unknown) => {
    if (n === null || typeof n !== 'object') return
    if (Array.isArray(n)) { n.forEach(walk); return }
    const item = n as Node
    if (typeof item.props?.className === 'string' && item.props.className.split(/\s+/).includes(className)) {
      out.push(item)
    }
    item.children?.forEach(walk)
  }
  walk(node)
  return out
}

const DAY = 86_400_000

/**
 * 一条**此刻在跑**的腾讯式活动（有效期覆盖现在、无每日时段）。
 *
 * ⚠️ 文案与说明必须是**两句不同的话**：若 hover 与 label 同值,
 * 「title 里到底放的是长句还是短标签」就成了同义反复。
 */
function runningPromotion(overrides: Record<string, unknown> = {}) {
  const now = Date.now()
  return {
    id: 'hy4-flash-free-trial-202611',
    source: 'promotion',
    modelIds: ['hy4flash-free'],
    badge: { label: '限时免费', labelEn: 'Free now', color: '#009273', display: 'activeOnly' },
    hover: { zh: '11月16日–12月1日，每日赠送免费额度。', en: 'Free daily quota from Nov 16 to Dec 1.' },
    schedule: { timezone: 'Asia/Shanghai', validFrom: now - 2 * DAY, validUntil: now + 5 * DAY },
    timeDeclared: true,
    standingEligible: true,
    priority: 200,
    ...overrides,
  }
}

async function registerWith(providers: unknown) {
  behavior = async () => ({ providers })
  const m = await load()
  m.resetModelLabelCandidates()
  rpcCount = 0
  m.registerModelLabelSlot(ctxStub, countingRpc())
  await flush()
  return m
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-17T10:00:00Z')) })
afterEach(() => {
  // 卸载全部效果 ⇒ 订阅清零 ⇒ 下一个用例重新建立自己的定时器。
  for (const fn of effectCleanups.splice(0)) { try { fn() } catch { /* 清理失败不影响断言 */ } }
  stateSetters.length = 0
  stateCalls.length = 0
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('ModelLabel：自家渠道的候选行（腿 1）', () => {
  it('★ 画名字 + chip，且 title 是上游长句 + 有效期（不是短标签本身）', async () => {
    vi.stubGlobal('navigator', { language: 'zh-CN' })
    const promotion = runningPromotion()
    const m = await registerWith({ buddy: [{ modelId: 'hy4flash-free', promotion }] })

    created.length = 0
    const root = m.ModelLabel({
      provider: { id: 'buddy', name: 'CodeBuddy (腾讯)' },
      model: { id: 'hy4flash-free', name: 'Hy4 flash · x0.00→免费 FREE' },
      placement: 'option',
      rpcCall: countingRpc(),
    }) as unknown as Node

    const chip = findAll(root, 'dim-jh-modelPromoChip')[0]
    expect(chip).toBeDefined()
    expect(chip.children.join('')).toBe('限时免费')
    expect(chip.props['data-tone']).toBe('upstream')
    // ⚠️ 这条才是本次移植的目的：title 必须**长过** label，且含上游那句说明。
    expect(chip.props.title).toContain('每日赠送免费额度')
    expect(chip.props.title.length).toBeGreaterThan(chip.children.join('').length)
    expect(chip.props.title.split(' · ').length).toBeGreaterThanOrEqual(2)
    // 名字那格保留宿主给的展示名（倍率后缀不许被我们吃掉）。
    expect(findAll(root, 'dim-jh-modelLabelName')[0]!.children.join(''))
      .toBe('Hy4 flash · x0.00→免费 FREE')
    // 上游 hex 原样进 style，不做二次创作。
    expect(chip.props.style).toEqual({ color: '#009273', borderColor: '#009273' })
  })

  it('★★ 英文读者 ⇒ 同一份候选换成上游英文档（表形态真在被消费）', async () => {
    vi.stubGlobal('navigator', { language: 'en-US' })
    const m = await registerWith({ buddy: [{ modelId: 'hy4flash-free', promotion: runningPromotion() }] })
    created.length = 0
    const root = m.ModelLabel({
      provider: { id: 'buddy', name: 'CodeBuddy (腾讯)' },
      model: { id: 'hy4flash-free', name: 'Hy4 flash' },
      placement: 'option',
      rpcCall: countingRpc(),
    }) as unknown as Node
    const chip = findAll(root, 'dim-jh-modelPromoChip')[0]
    expect(chip.children.join('')).toBe('Free now')
    expect(chip.props.title).toContain('Free daily quota')
  })

  it('★★ 反向对照：候选表里有这家但**不是这一行** ⇒ 不画 chip', async () => {
    vi.stubGlobal('navigator', { language: 'zh-CN' })
    const m = await registerWith({ buddy: [{ modelId: 'hy4flash-free', promotion: runningPromotion() }] })
    created.length = 0
    const root = m.ModelLabel({
      provider: { id: 'buddy', name: 'CodeBuddy (腾讯)' },
      model: { id: 'hy3', name: 'Hy3' },
      placement: 'option',
      rpcCall: countingRpc(),
    }) as unknown as Node
    expect(findAll(root, 'dim-jh-modelPromoChip')).toHaveLength(0)
  })

  it('★★★ 活动已过期 ⇒ 不画 chip（fail-closed，validUntil 端点不含）', async () => {
    vi.stubGlobal('navigator', { language: 'zh-CN' })
    const dead = runningPromotion({
      schedule: { timezone: 'Asia/Shanghai', validFrom: Date.now() - 10 * DAY, validUntil: Date.now() - DAY },
    })
    const m = await registerWith({ buddy: [{ modelId: 'hy4flash-free', promotion: dead }] })
    created.length = 0
    const root = m.ModelLabel({
      provider: { id: 'buddy', name: 'CodeBuddy (腾讯)' },
      model: { id: 'hy4flash-free', name: 'Hy4 flash' },
      placement: 'option',
      rpcCall: countingRpc(),
    }) as unknown as Node
    expect(findAll(root, 'dim-jh-modelPromoChip')).toHaveLength(0)
  })

  it('★★★ 窗口外 + display activeOnly ⇒ 不画（不许说一件没发生的事）', async () => {
    vi.stubGlobal('navigator', { language: 'zh-CN' })
    const night = runningPromotion({
      schedule: { timezone: 'Asia/Shanghai', daily: [{ start: '22:00', end: '08:00' }] },
    })
    // 固定时钟 10:00Z = Asia/Shanghai 18:00 ⇒ 不在 22:00–08:00 里。
    const m = await registerWith({ buddy: [{ modelId: 'hy4flash-free', promotion: night }] })
    created.length = 0
    const root = m.ModelLabel({
      provider: { id: 'buddy', name: 'CodeBuddy (腾讯)' },
      model: { id: 'hy4flash-free', name: 'Hy4 flash' },
      placement: 'option',
      rpcCall: countingRpc(),
    }) as unknown as Node
    expect(findAll(root, 'dim-jh-modelPromoChip')).toHaveLength(0)
  })
})

describe('自家渠道绝不回落到目录缓存里的徽标（issue #101 的复发面）', () => {
  it('★★★ 候选说此刻不成立 + 目录里还留着一枚 badge ⇒ **不画**', async () => {
    vi.stubGlobal('navigator', { language: 'zh-CN' })
    // 活动已过期 ⇒ 候选表挑不出任何一枚。
    const dead = runningPromotion({
      schedule: { timezone: 'Asia/Shanghai', validFrom: Date.now() - 10 * DAY, validUntil: Date.now() - DAY },
    })
    const m = await registerWith({ buddy: [{ modelId: 'hy4flash-free', promotion: dead }] })
    created.length = 0
    const root = m.ModelLabel({
      provider: { id: 'buddy', name: 'B' },
      // ⚠️ 关键一格：目录里**还留着**上次装配算出的 badge（宿主最长 20 分钟
      // 才重读一次目录）。若自家渠道允许回落到它，画出来的就是那份**过期**
      // 徽标 —— 正是「活动过期而用户仍按优惠期选择」，本模块存在的理由。
      model: { id: 'hy4flash-free', name: 'Hy4 flash', badge: { text: '限时免费', tone: 'success' } },
      placement: 'option',
      rpcCall: countingRpc(),
    }) as unknown as Node
    expect(findAll(root, 'dim-jh-modelPromoChip')).toHaveLength(0)
    // 名字照画，只是不带徽标。
    expect(root.children.join('')).toContain('Hy4 flash')
  })

  it('★★ 反向对照：同一枚 badge 在**外来**渠道上必须画出来', async () => {
    // 与上一条只差 provider id ⇒ 证明判据打在「归不归我们管」,
    // 而不是「有没有候选」或「badge 存不存在」。
    vi.stubGlobal('navigator', { language: 'zh-CN' })
    const dead = runningPromotion({
      schedule: { timezone: 'Asia/Shanghai', validFrom: Date.now() - 10 * DAY, validUntil: Date.now() - DAY },
    })
    const m = await registerWith({ buddy: [{ modelId: 'hy4flash-free', promotion: dead }] })
    created.length = 0
    const root = m.ModelLabel({
      provider: { id: 'someone-else', name: 'E' },
      model: { id: 'hy4flash-free', name: 'Hy4 flash', badge: { text: '限时免费', tone: 'success' } },
      placement: 'option',
      rpcCall: countingRpc(),
    }) as unknown as Node
    expect(findAll(root, 'dim-jh-modelPromoChip')).toHaveLength(1)
  })
})

describe('ModelLabel：外来渠道的行必须保住宿主徽标（腿 2）', () => {
  it('★★ single 槽的代价：别的插件发布的 badge 必须由我们画出来', async () => {
    vi.stubGlobal('navigator', { language: 'en-US' })
    const m = await registerWith({})
    created.length = 0
    const root = m.ModelLabel({
      provider: { id: 'some-other-plugin', name: 'Other' },
      model: { id: 'x1', name: 'Some Model', badge: { text: { en: 'Free now', zh: '限时免费' }, tone: 'success' } },
      placement: 'option',
      rpcCall: countingRpc(),
    }) as unknown as Node
    const chip = findAll(root, 'dim-jh-modelPromoChip')[0]
    expect(chip).toBeDefined()
    expect(chip.children.join('')).toBe('Free now')
    expect(chip.props['data-tone']).toBe('success')
    // 外来徽标没有长句可给（数据不在我们手里）⇒ title 回落成短标签,
    // 刻意如此：宁可重复一句，也不替上游编一句。
    expect(chip.props.title).toBe('Free now')
  })

  it('★★ 同一份 badge 给中文读者 ⇒ 换成本地区文案', async () => {
    vi.stubGlobal('navigator', { language: 'zh-CN' })
    const m = await registerWith({})
    created.length = 0
    const root = m.ModelLabel({
      provider: { id: 'other', name: 'O' },
      model: { id: 'x1', name: 'Some Model', badge: { text: { en: 'Free now', zh: '限时免费' }, tone: 'success' } },
      placement: 'option',
      rpcCall: countingRpc(),
    }) as unknown as Node
    const chip = findAll(root, 'dim-jh-modelPromoChip')[0]
    expect(chip.children.join('')).toBe('限时免费')
  })

  it('★★★ 非法 tone 落 neutral，不许抛（抛出会带走整格装饰）', async () => {
    const m = await load()
    expect(m.hostBadgeToneOf('constructor')).toBe('neutral')
    expect(m.hostBadgeToneOf('nope')).toBe('neutral')
    expect(m.hostBadgeToneOf('warning')).toBe('warning')
  })

  it('★★ placement=trigger ⇒ 徽标在名字**前面**（宿主 trigger 行的排法，PR #110 审计 P1-1）', async () => {
    vi.stubGlobal('navigator', { language: 'en-US' })
    const m = await registerWith({})
    created.length = 0
    const root = m.ModelLabel({
      provider: { id: 'some-other-plugin', name: 'Other' },
      model: { id: 'x1', name: 'Some Model', badge: { text: { en: 'Free now', zh: '限时免费' }, tone: 'success' } },
      placement: 'trigger',
      rpcCall: countingRpc(),
    }) as unknown as Node
    // 直接断言**子节点顺序**：第一枚是 chip、第二枚是名字。
    const kids = (root.children ?? []) as Node[]
    expect(kids).toHaveLength(2)
    expect(kids[0]!.props?.className).toBe('dim-jh-modelPromoChip')
    expect(kids[1]!.props?.className).toBe('dim-jh-modelLabelName')
    expect(kids[1]!.children.join('')).toBe('Some Model')
  })

  it('★★ placement=option ⇒ 名字在徽标前面（下拉候选行的排法，与上一条成对）', async () => {
    vi.stubGlobal('navigator', { language: 'en-US' })
    const m = await registerWith({})
    created.length = 0
    const root = m.ModelLabel({
      provider: { id: 'some-other-plugin', name: 'Other' },
      model: { id: 'x1', name: 'Some Model', badge: { text: { en: 'Free now', zh: '限时免费' }, tone: 'success' } },
      placement: 'option',
      rpcCall: countingRpc(),
    }) as unknown as Node
    const kids = (root.children ?? []) as Node[]
    expect(kids[0]!.props?.className).toBe('dim-jh-modelLabelName')
    expect(kids[1]!.props?.className).toBe('dim-jh-modelPromoChip')
  })

  it('★★ 无 badge 的行 = 裸名字，且不写 title', async () => {
    const m = await registerWith({})
    created.length = 0
    const root = m.ModelLabel({
      provider: { id: 'zzz', name: 'Z' },
      model: { id: 'a', name: 'Plain Model' },
      placement: 'option',
      rpcCall: countingRpc(),
    }) as unknown as Node
    expect(findAll(root, 'dim-jh-modelPromoChip')).toHaveLength(0)
    expect(root.children.join('')).toBe('Plain Model')
    expect((root as Node).props.title).toBeUndefined()
  })

  it('★★★ badge.text 形状畸形（null / 数组）⇒ 不抛、落裸名字', async () => {
    const m = await registerWith({})
    for (const bad of [null, [], 42, undefined]) {
      created.length = 0
      const root = m.ModelLabel({
        provider: { id: 'p', name: 'P' },
        model: { id: 'a', name: 'N', badge: { text: bad, tone: 'info' } },
        placement: 'option',
        rpcCall: countingRpc(),
      }) as unknown as Node
      expect(findAll(root, 'dim-jh-modelPromoChip')).toHaveLength(0)
    }
  })
})

describe('取数：缓存、单飞、失败面', () => {
  it('★★★ 取数失败必须保留上一次快照（一次抖动不许让整片徽标消失）', async () => {
    vi.stubGlobal('navigator', { language: 'zh-CN' })
    const m = await registerWith({ buddy: [{ modelId: 'hy4flash-free', promotion: runningPromotion() }] })
    // 缓存过期 ⇒ 下一次渲染真的重新取数，而这次失败。
    vi.advanceTimersByTime(61_000)
    behavior = async () => { throw new Error('rpc down') }
    created.length = 0
    const root = m.ModelLabel({
      provider: { id: 'buddy', name: 'CodeBuddy (腾讯)' },
      model: { id: 'hy4flash-free', name: 'Hy4 flash' },
      placement: 'option',
      rpcCall: countingRpc(),
    }) as unknown as Node
    await flush()
    expect(behavior).toBeTruthy()
    // 失败后再渲染一次：上一次成功的快照必须还在。
    created.length = 0
    const again = m.ModelLabel({
      provider: { id: 'buddy', name: 'CodeBuddy (腾讯)' },
      model: { id: 'hy4flash-free', name: 'Hy4 flash' },
      placement: 'option',
      rpcCall: countingRpc(),
    }) as unknown as Node
    await flush()
    expect(findAll(again, 'dim-jh-modelPromoChip')).toHaveLength(1)
    expect(findAll(root, 'dim-jh-modelPromoChip')).toHaveLength(1)
  })

  it('★★ 缓存期内不重复取数；过期后取一次（渲染路径不许打爆 RPC）', async () => {
    const m = await load()
    await registerWith({ buddy: [] })
    const afterRegister = rpcCount
    expect(afterRegister).toBe(1)
    // 先渲染一行：定时器由组件的订阅建立，没渲染过就没有心跳。
    m.ModelLabel({ provider: { id: 'buddy', name: 'B' }, model: { id: 'seed', name: 'S' }, placement: 'option', rpcCall: countingRpc() })
    // 同一次菜单里渲染二十行 ⇒ 只应命中缓存，不再发请求。
    for (let i = 0; i < 20; i += 1) {
      m.ModelLabel({
        provider: { id: 'buddy', name: 'B' },
        model: { id: 'x' + i, name: 'X' },
        placement: 'option',
        rpcCall: countingRpc(),
      })
    }
    await flush()
    expect(rpcCount).toBe(afterRegister)
    // ★ 过期后由**心跳**重新取数，而且**不再需要新的渲染**：上面那二十行
    // 已经把订阅建起来了（定时器住在 subscribeTick 里），推进时钟就够。
    // 判据必须这样切 —— 否则「渲染时补一次」那条腿会替心跳那条腿过关,
    // 而真正需要它的是「页面一直开着、没人重新渲染」那一格。
    vi.advanceTimersByTime(61_000)
    await flush()
    expect(rpcCount).toBe(afterRegister + 1)
    // 取完立刻变新鲜 ⇒ 紧跟着的渲染不再重复发请求。
    m.ModelLabel({ provider: { id: 'buddy', name: 'B' }, model: { id: 'y', name: 'Y' }, placement: 'option', rpcCall: countingRpc() })
    await flush()
    expect(rpcCount).toBe(afterRegister + 1)
  })

  it('★★★ 同一时刻只发一次请求（单飞闸门）', async () => {
    const m = await load()
    m.resetModelLabelCandidates()
    rpcCount = 0
    let release: (v: unknown) => void = () => {}
    behavior = () => new Promise((resolve) => { release = resolve })
    // 二十行同时挂载：闸门一破就是二十个请求。
    for (let i = 0; i < 20; i += 1) {
      m.ModelLabel({
        provider: { id: 'buddy', name: 'B' },
        model: { id: 'x' + i, name: 'X' },
        placement: 'option',
        rpcCall: countingRpc(),
      })
    }
    await flush()
    expect(rpcCount).toBe(1)
    release({ providers: {} })
    await flush()
  })
})

describe('首屏落地：取数完成后必须叫醒已挂载的行', () => {
  it('★★★ 数据后到 ⇒ 已挂载的行被安排重渲染（否则首屏永远没有徽标）', async () => {
    const m = await load()
    m.resetModelLabelCandidates()
    rpcCount = 0
    stateSetters.length = 0
    // 渲染发生在**数据之前**：这正是真实时序 —— 槽位在挂载时发起取数,
    // 而 RPC 一个往返之后才回。若取数成功不通知订阅者，用户装完插件
    // 看到的是「什么都没变」，要等下一次心跳（60 秒）才出徽标。
    let release: (v: unknown) => void = () => {}
    behavior = () => new Promise((resolve) => { release = resolve })
    m.ModelLabel({
      provider: { id: 'buddy', name: 'B' },
      model: { id: 'hy4flash-free', name: 'Hy4 flash' },
      placement: 'option',
      rpcCall: countingRpc(),
    })
    // 挂载时 useState 交出过 setter（探针本身可用）。
    expect(stateSetters.length).toBeGreaterThan(0)
    stateCalls.length = 0

    release({ providers: { buddy: [{ modelId: 'hy4flash-free', promotion: runningPromotion() }] } })
    await flush()

    // ★ notify() 必须真的叫醒已挂载的行：没有这一步，首屏要等下一次心跳
    //   （60 秒）才画得出徽标，用户看到的就是「装完插件什么都没变」。
    expect(stateCalls.length).toBeGreaterThan(0)
    // 叫醒之后重新渲染 ⇒ 这一回画得出 chip。
    created.length = 0
    const root = m.ModelLabel({
      provider: { id: 'buddy', name: 'B' },
      model: { id: 'hy4flash-free', name: 'Hy4 flash' },
      placement: 'option',
      rpcCall: countingRpc(),
    }) as unknown as Node
    expect(findAll(root, 'dim-jh-modelPromoChip')).toHaveLength(1)
  })
})

describe('心跳：取数失败时也要让行重读时钟', () => {
  it('★★★ 心跳重新取数失败 ⇒ 行仍被叫醒（徽标不许冻在旧时刻）', async () => {
    vi.stubGlobal('navigator', { language: 'zh-CN' })
    const m = await load()
    // 只在夜间窗口内成立的活动。固定时钟 13:00Z = 上海 21:00 ⇒ 窗口外。
    const night = runningPromotion({
      schedule: { timezone: 'Asia/Shanghai', daily: [{ start: '22:00', end: '08:00' }] },
      standingEligible: false,
    })
    await registerWith({ buddy: [{ modelId: 'hy4flash-free', promotion: night }] })

    // 先渲染一行：订阅与心跳由它建立。
    m.ModelLabel({
      provider: { id: 'buddy', name: 'B' },
      model: { id: 'hy4flash-free', name: 'Hy4 flash' },
      placement: 'option',
      rpcCall: countingRpc(),
    })

    // 心跳之后取数**失败** ⇒ 成功路径上的 notify 走不到,
    // 于是「行被叫醒」只能来自心跳自己那一句 notify()。
    // ⚠️ 为什么必须用失败来切这一格：心跳周期与缓存 TTL 同为 60 秒,
    //   所以每轮心跳都会尝试重新取数 —— 「数据仍新鲜、只重渲染」那一格
    //   在这组常量下不存在（第一版用例断言 rpcCount 不变,实测必红）。
    behavior = async () => { throw new Error('rpc down') }
    stateCalls.length = 0
    vi.advanceTimersByTime(61_000)
    await flush()
    expect(stateCalls.length).toBeGreaterThan(0)
  })
})
describe('注册：优先级与失败面', () => {
  it('★★★ priority 必须严格低于本机已装的兄弟插件', async () => {
    const m = await load()
    // 实测值：dsh-connect-workbuddy MODEL_LABEL_PRIORITY = -105、
    //         dsh-connect-qoder 注册 priority = -1。同值会抛 duplicate,
    //         高于它则我们永远画不出来。
    expect(m.MODEL_LABEL_PRIORITY).toBeLessThan(-105)
    expect(m.MODEL_LABEL_PRIORITY).not.toBe(-1)
  })

  it('★★ register 抛出时回调仍返回 disposer，并留下一条 warn', async () => {
    const m = await load()
    const warns: string[] = []
    const result = m.registerModelLabelSlot({
      slots: {
        inject: (_n: string, cb: () => unknown) => cb(),
        register: () => { throw new Error('single slot already has a registration') },
      },
      logger: { warn: (msg: string) => { warns.push(msg) } },
    } as never, countingRpc())
    expect(typeof result).toBe('function')
    expect((result as () => unknown)()).toBeUndefined()
    expect(warns.join('')).toContain('模型名槽位注册失败')
  })

  it('★★ inject 自己抛出（该宿主没声明这个槽）也不许冒到调用方', async () => {
    const m = await load()
    expect(() => m.registerModelLabelSlot({
      slots: { inject: () => { throw new Error('slot not declared') }, register: () => () => {} },
      logger: { warn: () => {} },
    } as never, countingRpc())).not.toThrow()
  })
})
