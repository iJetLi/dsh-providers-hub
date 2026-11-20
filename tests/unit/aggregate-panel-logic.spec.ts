import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  candidateKeyOf,
  candidateRowLabel,
  candidateRowParts,
  candidateStateOf,
  candidateToggleAction,
  describeCandidateState,
  expiryLabel,
  isAllCandidatesRejected,
  isRejected,
  moveCandidate,
  moveCandidateTo,
  pendingOrderFromRoster,
  rankCandidatesForPanel,
  rejectionsFromCatalog,
  rejectionKey,
  rotationBlockerOf,
  rotationRosterOf,
  shouldReprobeExpiry,
  sortCandidatesByExpiry,
  sortModelsForPanel,
  startExpiryReprobe,
  toggleRejection,
} from '../../plugin-src/client/aggregate-panel-logic.js'
// ⚠️ **值导入**宿主常量（测试里读宿主模块是本仓库既有做法，见 `expiry-runtime-parity.spec.ts`）：
//    它是「哪些渠道已接入临期折算」的**唯一权威** —— 空态文案那份名单必须与它一致。
import { WIRED_EXPIRY_PROVIDERS } from '../../src/aggregate-expiry.js'

/** 仓库根（源码级断言用）。
 *
 * ⚠️ **必须用 `fileURLToPath`，不能用 `URL.pathname`**（真实缺陷，Gitee issue
 * IKLBSH A3）：`pathname` 把路径里的空格编码成 `%20`，而原先的
 * `replace(/^\/([A-Za-z]:)/, '$1')` 只修盘符、不修 `%20` ⇒ 含空格路径下
 * `readFileSync` 恒 ENOENT，症状是**整份 spec 收集失败**。
 */
const here = fileURLToPath(new URL('.', import.meta.url))

/** 造一个候选（照 `aggregate.catalog` 的响应形状）。 */
function candidate(provider, realId, extra = {}) {
  return {
    provider,
    realId,
    realName: `${provider} ${realId}`,
    price: 1,
    viaPatch: false,
    rejected: false,
    ...extra,
  }
}

/** 造一个虚拟模型。 */
function model(canonicalId, name, candidates) {
  return { canonicalId, name, candidates }
}

describe('sortModelsForPanel：全局按候选渠道数降序（**不分组**）', () => {
  // ⚠️ 用户 2026-10-07 明确要求**去掉厂商分组标题**：
  //    「聚合模型中显示 8 个聚合模型下面不需要再显示渠道了，因为渠道在每个模型的
  //      展开展示参与轮换的子列表中显示了」
  //    ⇒ 面板不再显示「华为云 (2) / 腾讯 (5)」这类分组标题，模型直接平铺。
  //    厂商信息仍可在每个模型展开后的子列表里逐条看到（那是渠道维度的信息）。
  //
  // ⚠️ 随之**删除了 `vendorOf` / `groupByVendor`**：去掉分组后它们**零调用者**，
  //    而本仓库对死代码有明确红线（第 2 轮审计正是把 `AGGREGATE_TTL_MS` 死配置
  //    列为 Important 缺陷）。需要时 git 历史里可找回。
  it('★ 按候选渠道数降序（渠道多的在前 —— 冗余度高、最不容易挂）', () => {
    const sorted = sortModelsForPanel([
      model('few', 'Few', [candidate('buddy', 'x')]),
      model('many', 'Many', [
        candidate('buddy', 'x'), candidate('workbuddy', 'y'), candidate('buddy', 'z'),
      ]),
      model('mid', 'Mid', [candidate('buddy', 'x'), candidate('workbuddy', 'y')]),
    ])
    expect(sorted.map((m) => m.canonicalId)).toEqual(['many', 'mid', 'few'])
  })

  it('★ 跨厂商也一起排（不因厂商不同而分段 —— 这正是去掉分组后的行为差异）', () => {
    // ⚠️ 旧实现（`groupByVendor`）会先按厂商分段，于是「华为云 6 个候选」可能排在
    //    「腾讯 2 个候选」**后面**（厂商名升序）。去掉分组后应**全局**降序。
    const sorted = sortModelsForPanel([
      model('tencent-two', 'T2', [candidate('buddy', 'x'), candidate('workbuddy', 'y')]),
      model('huawei-six', 'H6', [
        candidate('codearts', 'a'), candidate('codearts', 'b'), candidate('codearts', 'c'),
        candidate('codearts', 'd'), candidate('codearts', 'e'), candidate('codearts', 'f'),
      ]),
    ])
    expect(sorted.map((m) => m.canonicalId)).toEqual(['huawei-six', 'tencent-two'])
  })

  it('候选数相同时按 canonicalId 升序（结果稳定，便于断言与面板顺序稳定）', () => {
    const sorted = sortModelsForPanel([
      model('zebra', 'Z', [candidate('buddy', 'x')]),
      model('alpha', 'A', [candidate('buddy', 'y')]),
    ])
    expect(sorted.map((m) => m.canonicalId)).toEqual(['alpha', 'zebra'])
  })

  it('★ 纯函数：不得改动入参（React 依赖引用变化重渲染）', () => {
    const input = [
      model('few', 'Few', [candidate('buddy', 'x')]),
      model('many', 'Many', [candidate('buddy', 'x'), candidate('buddy', 'y')]),
    ]
    const before = input.map((m) => m.canonicalId)
    sortModelsForPanel(input)
    expect(input.map((m) => m.canonicalId)).toEqual(before)
  })

  it('空输入 ⇒ 空数组（不抛错）', () => {
    expect(sortModelsForPanel([])).toEqual([])
    expect(sortModelsForPanel(undefined)).toEqual([])
    expect(sortModelsForPanel(null)).toEqual([])
  })

  it('候选为空的模型不丢（仍列出，排在最后）', () => {
    // ⚠️ 一个虚拟模型的候选可能全被过滤（理论上不该发生，但面板不该因此静默吞掉它）。
    const sorted = sortModelsForPanel([
      model('empty', 'Empty', []),
      model('one', 'One', [candidate('buddy', 'x')]),
    ])
    expect(sorted.map((m) => m.canonicalId)).toEqual(['one', 'empty'])
  })
})

describe('candidateRowLabel：候选行的展示文案', () => {
  it('含渠道与真实 modelId', () => {
    const label = candidateRowLabel(candidate('buddy', 'deepseek-v4.1-flash'))
    expect(label).toContain('buddy')
    expect(label).toContain('deepseek-v4.1-flash')
  })

  it('倍率为有限数时显示（x0.15）', () => {
    const label = candidateRowLabel(candidate('buddy', 'm', { price: 0.15 }))
    expect(label).toContain('x0.15')
  })

  it('倍率为 Infinity（无标注）时不显示倍率，而不是显示 Infinity', () => {
    // ⚠️ 直接把 Infinity 拼进文案会让用户看到「xInfinity」—— 那是明显的渲染缺陷。
    const label = candidateRowLabel(candidate('buddy', 'm', { price: Number.POSITIVE_INFINITY }))
    expect(label).not.toContain('Infinity')
    expect(label).toContain('buddy')
  })

  it('倍率为 0 时显示「免费」（本仓库既有口径）', () => {
    expect(candidateRowLabel(candidate('buddy', 'm', { price: 0 }))).toContain('免费')
  })

  it('补丁来源标 ⚠️补丁（规格 §7.1 要求人工核查的重点）', () => {
    const label = candidateRowLabel(candidate('lobsterai', 'm', { viaPatch: true }))
    expect(label).toContain('补丁')
  })

  it('非补丁来源不标补丁', () => {
    expect(candidateRowLabel(candidate('buddy', 'm'))).not.toContain('补丁')
  })

  it('畸形入参不抛错（面板渲染不能因一条坏数据整体崩掉）', () => {
    expect(() => candidateRowLabel(undefined)).not.toThrow()
    expect(() => candidateRowLabel({})).not.toThrow()
    expect(typeof candidateRowLabel(undefined)).toBe('string')
  })
})

/**
 * `candidateRowParts` —— 聚合页候选行「分格渲染」的数据来源。
 *
 * ⚠️ 为什么必须存在这个函数（而不是让渲染层去 split 那个标签字符串）：
 * 用户 2026-10-27 报障「美化聚合页模型列表」之后，候选行要把
 * 渠道名 / 模型 id / 倍率 / 补丁拆成四格分别上色。如果渲染层拿到的还是
 * `candidateRowLabel()` 拼好的 `buddy · m · x0.15` 再 `split(' · ')`，
 * **模型 id 本身含 `·` 时立刻错位**（真实存在这种 id）——
 * 于是「倍率格子」会显示模型 id 的后半截，而真正的倍率丢失。
 * ⇒ 拆分必须在纯函数里按**字段**做，渲染层只消费字段。
 */
describe('candidateRowParts：候选行的结构化字段（分格渲染的唯一数据来源）', () => {
  const base = { provider: 'buddy', realId: 'deepseek-v4.1-flash' }

  it('原样给出 provider 与 realId', () => {
    expect(candidateRowParts({ ...base, price: 0.15 })).toEqual({
      provider: 'buddy',
      realId: 'deepseek-v4.1-flash',
      price: 0.15,
      patched: false,
    })
  })

  it('★ 模型 id 里含「·」时不被拆散（这正是不能用 split 的理由）', () => {
    // ⚠️ 反向钉子：若实现改成「拼字符串再 split(' · ')」，这条会红 ——
    //    这也是本用例存在的主要目的（它是防回退的钉子，不是凑覆盖率）。
    const parts = candidateRowParts({ provider: 'loomy', realId: 'foo · bar', price: 2 })
    expect(parts.realId).toBe('foo · bar')
    expect(parts.provider).toBe('loomy')
  })

  it('★ price 为 Infinity（无标注哨兵）时给 null，不是 Infinity', () => {
    // ⚠️ 直接透传 Infinity 会让渲染层「判 !isFinite 才不显示」的责任落到调用方，
    //    而任何一处漏判都会把 xInfinity 印到界面上。
    const parts = candidateRowParts({ ...base, price: Number.POSITIVE_INFINITY })
    expect(parts.price).toBeNull()
  })

  it('★ price 为 0 时保留 0（渲染层据此显示「免费」，不得当假值丢掉）', () => {
    const parts = candidateRowParts({ ...base, price: 0 })
    expect(parts.price).toBe(0)
    expect(parts.price).not.toBeNull()
  })

  it('price 缺失 / 非数字时给 null', () => {
    expect(candidateRowParts(base).price).toBeNull()
    expect(candidateRowParts({ ...base, price: 'x0.15' }).price).toBeNull()
    expect(candidateRowParts({ ...base, price: Number.NaN }).price).toBeNull()
  })

  it('viaPatch === true 才算补丁（字符串 "true" 不算）', () => {
    expect(candidateRowParts({ ...base, viaPatch: true }).patched).toBe(true)
    expect(candidateRowParts({ ...base, viaPatch: 'true' }).patched).toBe(false)
    expect(candidateRowParts(base).patched).toBe(false)
  })

  it('畸形入参不抛错，且字段退化为占位符', () => {
    for (const bad of [undefined, null, {}]) {
      expect(() => candidateRowParts(bad)).not.toThrow()
      expect(candidateRowParts(bad)).toEqual({
        provider: '?',
        realId: '?',
        price: null,
        patched: false,
      })
    }
  })

  it('★ candidateRowLabel 与 candidateRowParts 同源：标签必须与字段一致', () => {
    // ⚠️ 两条出口若各自实现一份判据，必然出现「tooltip 说无倍率、界面却显示 x0.15」
    //    这类分裂。这条用**一组**输入同时核对两者。
    const cases = [
      { provider: 'buddy', realId: 'm', price: 0.15, viaPatch: false },
      { provider: 'buddy', realId: 'm', price: 0, viaPatch: false },
      { provider: 'loomy', realId: 'a · b', price: 2, viaPatch: true },
      { provider: 'trae', realId: 'm', price: Number.POSITIVE_INFINITY, viaPatch: false },
    ]
    for (const c of cases) {
      const parts = candidateRowParts(c)
      const label = candidateRowLabel(c)
      expect(label).toContain(parts.provider)
      // 模型 id 原样出现在标签里（含含「·」的那条）
      expect(label).toContain(parts.realId)
      if (parts.price === null) {
        expect(label).not.toContain('x')
        expect(label).not.toContain('Infinity')
      } else if (parts.price === 0) {
        expect(label).toContain('免费')
      } else {
        expect(label).toContain(`x${parts.price}`)
      }
      expect(label.includes('补丁')).toBe(parts.patched)
    }
  })
})

describe('rejectionKey / isRejected：拒绝状态的读写判据', () => {
  it('rejectionKey 用 NUL 分隔（渠道 id 与 realId 里可能含斜杠）', () => {
    // ⚠️ 用 `:` 或 `/` 会把 `a/b`+`c` 与 `a`+`b/c` 拼成同一个键 ⇒ 误判。
    const k1 = rejectionKey('m', 'a/b', 'c')
    const k2 = rejectionKey('m', 'a', 'b/c')
    expect(k1).not.toBe(k2)
  })

  it('isRejected：命中返回 true', () => {
    const table = { m: { buddy: { x: true } } }
    expect(isRejected(table, 'm', 'buddy', 'x')).toBe(true)
  })

  it('isRejected：缺层一律返回 false（不抛错）', () => {
    expect(isRejected({}, 'm', 'buddy', 'x')).toBe(false)
    expect(isRejected(undefined, 'm', 'buddy', 'x')).toBe(false)
    expect(isRejected({ m: {} }, 'm', 'buddy', 'x')).toBe(false)
    expect(isRejected({ m: { buddy: {} } }, 'm', 'buddy', 'x')).toBe(false)
  })

  it('isRejected：非 true 的值不算拒绝（与宿主 sanitize 同口径）', () => {
    expect(isRejected({ m: { buddy: { x: false } } }, 'm', 'buddy', 'x')).toBe(false)
    expect(isRejected({ m: { buddy: { x: 1 } } }, 'm', 'buddy', 'x')).toBe(false)
  })
})

describe('toggleRejection：纯函数地改拒绝表', () => {
  it('打开拒绝 ⇒ 写入 true', () => {
    const next = toggleRejection({}, 'm', 'buddy', 'x', true)
    expect(next).toEqual({ m: { buddy: { x: true } } })
  })

  it('关闭拒绝 ⇒ 删除键并逐级清理空层（不留 false 噪音）', () => {
    const next = toggleRejection({ m: { buddy: { x: true } } }, 'm', 'buddy', 'x', false)
    expect(next).toEqual({})
  })

  it('关闭其中一条时保留同层的其它条', () => {
    const next = toggleRejection(
      { m: { buddy: { x: true, y: true } } },
      'm', 'buddy', 'x', false,
    )
    expect(next).toEqual({ m: { buddy: { y: true } } })
  })

  it('★ 纯函数：不得改动入参', () => {
    // ⚠️ 面板用 React 状态驱动，原地改会让「新旧引用相同」⇒ 组件不重渲染
    //    ⇒ 用户点了开关但界面不变（最典型的一类 UI 缺陷）。
    const before = { m: { buddy: { x: true } } }
    const snapshot = JSON.stringify(before)
    toggleRejection(before, 'm', 'buddy', 'y', true)
    toggleRejection(before, 'm', 'buddy', 'x', false)
    expect(JSON.stringify(before)).toBe(snapshot)
  })

  it('★ 纯函数：返回值与入参不是同一个引用（React 靠引用变化重渲染）', () => {
    const before = {}
    const next = toggleRejection(before, 'm', 'buddy', 'x', true)
    expect(next).not.toBe(before)
  })

  it('畸形入参退化为空表后正常写入', () => {
    expect(toggleRejection(undefined, 'm', 'buddy', 'x', true)).toEqual({ m: { buddy: { x: true } } })
    expect(toggleRejection([], 'm', 'buddy', 'x', true)).toEqual({ m: { buddy: { x: true } } })
  })
})

describe('★ 客户端 RPC 调用必须显式传 payload（真实缺陷回归）', () => {
  it('不得出现省略 payload 的 rpcCall("x.y") 写法', async () => {
    // ⚠️ **真实缺陷**（用户报障「读取聚合目录失败：Error: Invalid Jet Hub management
    //    request.」）：`callManagementRpc` 把 payload 序列化进请求体，而**后端校验
    //    要求 payload 键存在**（`src/jet-hub-rpc.ts` 的
    //    `Object.prototype.hasOwnProperty.call(call, 'payload')`）；省略 payload
    //    时它被序列化成 undefined 并**被 JSON 丢弃** ⇒ 后端判为非法请求。
    //
    //    这个坑在本文件之外早有记录（`backup.export` 的调用处有成文注释），
    //    而我在写聚合面板时**又踩了一次**（`rpcCall('aggregate.catalog')`）。
    //    ⇒ 加一条**全客户端扫描**的源码守卫：今后任何人漏传都会在测试里立刻暴露，
    //    而不是等用户报「Invalid Jet Hub management request.」。
    const fs = await import('node:fs/promises')
    const path = await import('node:path')
    // ⚠️ `fileURLToPath`（不是 `URL.pathname`）—— 见文件头 `here` 的注释（IKLBSH A3）。
    // ⚠️ 这里取的是 `new URL('.', …)`（**目录**），故**不再**套 `path.dirname` ——
    // 原先 `URL.pathname` 给的是**文件**路径、需要 dirname；换成 `'.'` 后再 dirname
    // 会把 `tests/unit` 削成 `tests`（我改的第一版就这么错，实测 ENOENT）。
    const dir = fileURLToPath(new URL('.', import.meta.url))
    const clientDir = path.resolve(dir, '../../plugin-src/client')
    const files = (await fs.readdir(clientDir)).filter((f) => f.endsWith('.js'))
    expect(files.length).toBeGreaterThan(10)

    const offenders: string[] = []
    for (const file of files) {
      const source = await fs.readFile(path.join(clientDir, file), 'utf8')
      // 只匹配**单个实参**的调用：`rpcCall('a.b')`（合法写法都带第二参）。
      // ⚠️ 剥离注释再扫，避免把说明文字里的示例当成违规（本文件的注释里就有示例）。
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
      for (const m of code.matchAll(/rpcCall\(\s*'([a-z]+\.[a-zA-Z]+)'\s*\)/g)) {
        offenders.push(`${file}: ${m[1]}`)
      }
    }
    expect(offenders, '这些 RPC 调用省略了 payload，后端会回 Invalid Jet Hub management request.').toEqual([])
  })
})

describe('★ 聚合面板必须按 rpcCall 的真实契约消费返回值（真实缺陷回归）', () => {
  it('AggregatePanel 内不得出现 res.ok / res.error 判断（契约是「解包 + 抛错」）', async () => {
    // ⚠️ **真实缺陷**（用户第二次报障：面板显示「读取聚合目录失败」且**丢掉真实原因**）：
    //    `plugin-src/client/index.js` 的 rpcCall =
    //      `unwrapRpcResult(callManagementRpc(...))`
    //    而 `unwrapRpcResult`（`management-rpc.mjs`）的契约是：
    //      「如果 ok=true 返回 value，否则抛出 error」
    //    ⇒ 成功时 `res` 是**解包后的值**（如 `{ models }`），**没有** `ok` 字段；
    //      失败时**直接抛错**、根本不返回。
    //    ⇒ 写 `res?.ok === true` 判断永远为假 ⇒ 走 else 分支显示兜底文案，
    //      而 `res.error.message` 也是 undefined ⇒ **真实原因被丢掉**。
    //
    // ⚠️ 不能全仓禁 `res.ok`：`account.test` 端点返回的**值本身**含 `ok`
    //    （那是业务语义的「测试是否通过」，不是 RPC 信封）—— 全仓禁会误伤它。
    //    故本守卫**只扫 AggregatePanel 组件体**。
    const fs = await import('node:fs/promises')
    const path = await import('node:path')
    // ⚠️ `fileURLToPath`（不是 `URL.pathname`）—— 见文件头 `here` 的注释（IKLBSH A3）。
    // ⚠️ 这里取的是 `new URL('.', …)`（**目录**），故**不再**套 `path.dirname` ——
    // 原先 `URL.pathname` 给的是**文件**路径、需要 dirname；换成 `'.'` 后再 dirname
    // 会把 `tests/unit` 削成 `tests`（我改的第一版就这么错，实测 ENOENT）。
    const dir = fileURLToPath(new URL('.', import.meta.url))
    const source = await fs.readFile(path.resolve(dir, '../../plugin-src/client/jet-hub.js'), 'utf8')
    const start = source.indexOf('function AggregatePanel(')
    expect(start, 'AggregatePanel 必须存在').toBeGreaterThan(0)
    // 组件体：从函数头到下一个顶层 `export function`
    const end = source.indexOf('\nexport function ', start)
    const body = source.slice(start, end > 0 ? end : undefined)
    // 剥离注释（本组件的注释里**故意**引用了 `res.ok` 来说明它是错的）。
    const code = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    expect(code, 'AggregatePanel 不得判断 res.ok（rpcCall 已解包，成功时没有 ok 字段）')
      .not.toMatch(/res\?\.ok|res\.ok/)
    expect(code, 'AggregatePanel 不得读 res.error（失败时 rpcCall 抛错，不返回）')
      .not.toMatch(/res\?\.error|res\.error/)
    expect(code, 'AggregatePanel 不得读 res.value（成功时已解包）')
      .not.toMatch(/res\?\.value|res\.value/)
  })

  it('★ 对照：account.test 的 res.ok 是业务字段，必须**保留**（守卫不得误伤）', async () => {
    const fs = await import('node:fs/promises')
    const path = await import('node:path')
    // ⚠️ `fileURLToPath`（不是 `URL.pathname`）—— 见文件头 `here` 的注释（IKLBSH A3）。
    // ⚠️ 这里取的是 `new URL('.', …)`（**目录**），故**不再**套 `path.dirname` ——
    // 原先 `URL.pathname` 给的是**文件**路径、需要 dirname；换成 `'.'` 后再 dirname
    // 会把 `tests/unit` 削成 `tests`（我改的第一版就这么错，实测 ENOENT）。
    const dir = fileURLToPath(new URL('.', import.meta.url))
    const source = await fs.readFile(path.resolve(dir, '../../plugin-src/client/jet-hub.js'), 'utf8')
    // `summarizeTest` 读的是 `account.test` 返回的**值**里的 ok —— 那是业务语义。
    expect(source).toMatch(/function summarizeTest\(res\)/)
    expect(source).toMatch(/if \(res\?\.ok\) return/)
  })
})

/**
 * ★ 面板的「按临期排序」（用户 2026-10-07 选定方案 C）。
 *
 * ## 背景：面板标题写「临期优先」，但候选列表是**渠道名字母序**
 *
 * 用户报障：「codearts 的 4.1 flash 没有显示在最后」—— 核实发现面板候选顺序来自
 * `aggregate-catalog.ts` 的 `candidates.sort(...)`，那是按 `provider` **字母序**
 * （`buddy → codearts → workbuddy`），**与临期顺序无关**。
 * ⇒ 标题与列表**矛盾**（面板没说真话）。
 *
 * ## 为什么不默认按临期排
 *
 * 临期顺序需要**逐候选探测余额**（真实上游 GET）。而规格 §8.3 明确要求
 * `aggregate.catalog` **零余额查询** —— 否则面板一打开就打十几次上游请求。
 * ⇒ 默认仍是字母序（零探测），用户**显式点「按临期排序」**才探测并重排。
 */
describe('★ 面板「按临期排序」（零探测为默认，点了才探测）', () => {
  it('★ 按临期升序（最早到期的排最前）；未接入/无到期的排最后', () => {
    const rows = [
      { provider: 'workbuddy', expiry: Number.POSITIVE_INFINITY },
      { provider: 'buddy', expiry: 3_000 },
      { provider: 'codearts', expiry: 1_000 },
    ]
    expect(sortCandidatesByExpiry(rows).map((r) => r.provider)).toEqual([
      'codearts', 'buddy', 'workbuddy',
    ])
  })

  it('★ 到期时刻相同时按渠道名升序（结果稳定）', () => {
    const rows = [
      { provider: 'trae', expiry: 5_000 },
      { provider: 'buddy', expiry: 5_000 },
    ]
    expect(sortCandidatesByExpiry(rows).map((r) => r.provider)).toEqual(['buddy', 'trae'])
  })

  it('★★ `UNUSABLE`（-1，「查不到」）必须排**最后**，绝不排前面（真实缺陷）', () => {
    // ⚠️⚠️ **真实缺陷**（用户验收 2026-10-16）：「有 2 个模型显示**查不到**排前面了，
    //    为什么查不到，查不到应该当做没临期不会放在前面」。
    //
    // 根因：`of()` 原先用 `Number.isFinite(value)` 判有效到期时刻，而
    // **`Number.isFinite(-1) === true`** ⇒ `UNUSABLE` 的排序键是 **-1**，
    // 比任何真实毫秒时间戳（约 1.7e12）都小 ⇒ **排到最前面**。
    const rows = [
      { provider: 'accio', expiry: -1 },                          // UNUSABLE（查不到）
      { provider: 'officeace', expiry: -1 },                      // UNUSABLE（查不到）
      { provider: 'buddy', expiry: Date.now() + 4 * 86_400_000 }, // 4 天后（真实值）
      { provider: 'zcode', expiry: Number.POSITIVE_INFINITY },    // 长期
    ]
    const sorted = sortCandidatesByExpiry(rows).map((r) => r.provider)
    // ★ 核心：buddy（真实临期）必须在两个「查不到」**之前**。
    expect(sorted.indexOf('buddy'), '★ 有临期值的必须在「查不到」之前')
      .toBeLessThan(sorted.indexOf('accio'))
    expect(sorted.indexOf('buddy')).toBeLessThan(sorted.indexOf('officeace'))
    // ★ 「查不到」与「长期」同档（都排最后），档内按渠道名升序。
    expect(sorted, '★ 查不到与长期同档排最后').toEqual([
      'buddy', 'accio', 'officeace', 'zcode',
    ])
  })

  it('★ `UNUSABLE` 排最后**不是**靠「-1 恰好比时间戳小」的巧合（防退回 isFinite）', () => {
    // ⚠️ 反向判据：若有人把 `-1` 的显式判定删掉、退回 `Number.isFinite`，
    //    下面这条会立刻变红（-1 < 1 ⇒ 排最前）。
    const rows = [
      { provider: 'unknown', expiry: -1 },
      { provider: 'real', expiry: 1 },
    ]
    expect(sortCandidatesByExpiry(rows).map((r) => r.provider)).toEqual(['real', 'unknown'])
  })

  it('★★ 「同档」的 tiebreak 必须**真的生效**（`NaN` 陷阱：2026-10-16 对抗审计实测）', () => {
    // ⚠️⚠️ **真实缺陷**（对抗审计独立复现，我逐条复跑确认）：
    //    原实现是 `const byExpiry = of(a) - of(b); if (byExpiry !== 0) return byExpiry`，
    //    而两个 `Infinity`（「长期」）或两个 `-1`（「查不到」，`of()` 把它映射成 `Infinity`）
    //    相减得 **`NaN`** —— 而 **`NaN !== 0` 为真** ⇒ 直接把 `NaN` 返回给 `sort`
    //    ⇒ 引擎按 `0` 处理 ⇒ **第二档 `localeCompare` 永不执行**
    //    ⇒ 同档内部顺序退化成**输入顺序**（随目录返回顺序漂移）。
    //
    //    ⚠️ 这一格**早于本 PR 存在**（两个 `Infinity` 那种），不是本 PR 引入；
    //    但本 PR 让它的**可见面变大**（新增了「查不到」档）。
    //    ⚠️ 判据必须**逐个同档形态**覆盖 —— 只测「两个有限且相等」那格会漏掉这里的
    //    两个分支（`Infinity` 对 / `-1` 对 / 混排），那正是原用例的盲区。
    const cases = [
      ['两个 -1（查不到）', [{ provider: 'officeace', expiry: -1 }, { provider: 'accio', expiry: -1 }], ['accio', 'officeace']],
      ['两个 Infinity（长期）', [{ provider: 'zcode', expiry: Infinity }, { provider: 'buddy', expiry: Infinity }], ['buddy', 'zcode']],
      ['-1 与 Infinity 混排', [{ provider: 'zcode', expiry: Infinity }, { provider: 'accio', expiry: -1 }], ['accio', 'zcode']],
      ['两个 undefined（缺值）', [{ provider: 'zcode' }, { provider: 'buddy' }], ['buddy', 'zcode']],
    ]
    for (const [label, rows, expected] of cases) {
      expect(sortCandidatesByExpiry(rows).map((r) => r.provider), `★ ${label} 必须按 provider 升序`)
        .toEqual(expected)
    }
  })

  it('★ 纯函数：不得改动入参（expiry 排序）', () => {
    const rows = [
      { provider: 'b', expiry: 2 },
      { provider: 'a', expiry: 1 },
    ]
    const before = rows.map((r) => r.provider)
    sortCandidatesByExpiry(rows)
    expect(rows.map((r) => r.provider)).toEqual(before)
  })

  it('★ 畸形入参不抛错（缺 expiry / 非数组）', () => {
    expect(sortCandidatesByExpiry(undefined)).toEqual([])
    expect(sortCandidatesByExpiry(null)).toEqual([])
    expect(sortCandidatesByExpiry([{ provider: 'a' }, { provider: 'b', expiry: 1 }])
      .map((r) => r.provider)).toEqual(['b', 'a'])
  })
})

describe('★ expiryLabel：到期时刻的可读文案', () => {
  const now = 1_800_000_000_000

  it('★ -1（查不到）与 Infinity（长期）必须**区分**', () => {
    // ⚠️ 查不到 ≠ 已过期：与 `zcodeExpiry` 的「undefined 表示查不到，不是没有余额」
    //    同一原则。把两者都说成「已过期」会让用户去重新登录一个其实好的账号。
    expect(expiryLabel(-1, now)).toBe('查不到')
    expect(expiryLabel(Number.POSITIVE_INFINITY, now)).toBe('长期')
  })

  it('★ 相对时间（分钟 / 小时 / 天）', () => {
    expect(expiryLabel(now + 30 * 60_000, now)).toBe('30 分钟')
    expect(expiryLabel(now + 5 * 3_600_000, now)).toBe('5 小时')
    expect(expiryLabel(now + 3 * 86_400_000, now)).toBe('3 天')
  })

  it('★ 边界：不到 1 分钟 / 已过期', () => {
    expect(expiryLabel(now + 30_000, now)).toBe('不到 1 分钟')
    expect(expiryLabel(now, now)).toBe('已过期')
    expect(expiryLabel(now - 1000, now)).toBe('已过期')
  })

  it('★ 畸形入参不抛错（面板不能因一条坏数据整体崩掉）', () => {
    expect(expiryLabel(undefined, now)).toBe('?')
    expect(expiryLabel(NaN, now)).toBe('?')
    expect(expiryLabel('x', now)).toBe('?')
    expect(expiryLabel(0, now)).toBe('?')
  })
})

describe('★ 面板接线：默认零探测，点了才探测（防「面板没说真话」）', () => {
  const read = (rel) => readFileSync(resolve(here, '../..', rel), 'utf8')
  const codeOf = (text) => text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
  const panel = read('plugin-src/client/jet-hub.js')
  const panelCode = codeOf(panel)

  it('★ 必须有「按临期排序」按钮（用户 2026-10-07 选定方案 C）', () => {
    expect(panelCode).toContain('按临期排序')
  })

  it('★ 默认**不得**在挂载时探测（规格 §8.3 的零余额查询契约）', () => {
    // ⚠️ 探测必须只在**用户点击**的处理器里发生。若挂在 effect 或直接调用，
    //    面板一打开就会对每个渠道打一次上游请求 —— 正是规格 §8.3 禁止的。
    // 判据：`aggregate.expiryOrder` 只应出现在 `onSortByExpiry` 里。
    const matches = [...panelCode.matchAll(/aggregate\.expiryOrder/g)]
    expect(matches).toHaveLength(1)
    // 且它前面不远处必须是 onSortByExpiry 的定义（而不是 effect）
    const at = panelCode.indexOf('aggregate.expiryOrder')
    const before = panelCode.slice(Math.max(0, at - 600), at)
    expect(before, 'expiryOrder 的调用必须在 onSortByExpiry 里').toContain('onSortByExpiry')
    expect(before, '不得出现在 useEffect 里').not.toMatch(/useEffect\(/)
  })

  it('★ 候选顺序：探测过才按临期排，否则保持目录顺序', () => {
    expect(panelCode).toContain('sortCandidatesByExpiry')
    // ⚠️ 必须有「未探测时用原顺序」的分支，否则面板一打开就按 undefined 排序
    //   （所有 expiry 都是 Infinity ⇒ 退化成按渠道名，看不出问题但语义是错的）。
    expect(panelCode).toMatch(/expiryOrder === null/)
  })

  it('★ 措辞必须与实际顺序一致（不再恒写「临期优先」）', () => {
    // ⚠️ 原先恒写「临期优先」而实际是**字母序** —— 用户报障的正是这个矛盾。
    //
    // ⚠️⚠️ **2026-10-16 判据迁移**（用户验收要求改了 UI）：原判据断言模型头那段
    //    「N 个渠道 · 按渠道名」出现过；用户要求「图1红框中的内容可以不用显示」
    //    ⇒ 那段已删除。**同一个意图**（面板不得对当前排序方式撒谎）现在由**顶部
    //    切换按钮**承担：它必须按 `orderMode` 说真话。
    expect(panelCode, '★ 按手工模式必须有独立文案').toContain('排序：按手工')
    expect(panelCode, '★ 临期模式的文案必须说「按临期」').toContain('排序：按临期')
    // ★ 且两者必须由**同一个按钮**按 `orderMode` 条件渲染。
    expect(panelCode, '两种文案必须由 orderMode 分支给出')
      .toMatch(/orderMode === 'manual'[\s\S]{0,500}排序：按手工/)
    // ⚠️ 旧的「按渠道名」措辞**必须消失**（新的按钮只表达用户选的两种模式；
    //    残留会让面板同时说两套）。
    expect(panelCode, '「按渠道名」这段已删除的文案不得残留').not.toContain('· 按渠道名')
  })

  it('★★ 排序模式必须是**单个切换按钮**（用户 2026-10-16 验收要求）', () => {
    // ⚠️⚠️ 用户原话：「图2的排序按手工还是按临期应该是一个按钮的点击切换
    //    （就像解锁永久积分和锁定永久积分一样）」。
    //    ⇒ 判据：① 不再有 `dim-jh-aggSegmented` 两段式容器；
    //            ② 排序按钮的 onClick 在两种模式间**取反**（一键切换语义）。
    expect(panelCode, '★ 两段式容器必须已删除').not.toContain('dim-jh-aggSegmented')
    expect(panelCode, '★ 排序按钮必须是取反切换（不是两个按钮各自切到某一模式）')
      .toMatch(/onSelectOrderMode\(orderMode === 'manual' \? 'expiry' : 'manual'\)/)
  })

  it('★★ 上移/下移按钮必须已删除，且拖动**必须**设 dataTransfer（用户 2026-10-16）', () => {
    // ⚠️⚠️ 两条真实缺陷（同一次验收）：
    //  ① 用户明确要求「我们不应该有上下箭头就是应该鼠标拖动」⇒ 箭头按钮删掉；
    //  ② **拖动当时是坏的** —— `onDragStart` 漏了 `dataTransfer.setData(...)`，
    //     浏览器（Chromium / Firefox）不触发拖拽 ⇒ 只有箭头能用。用户看到的
    //     「拖动好像是不生效的」正是它。
    //
    // ⚠️⚠️ **判据必须锚定到聚合面板自己的那一段**（变异验证实测）：
    //    本文件里另有**两处**合法拖动（账号卡片 `:3523`、渠道开关 `:4709`）都调了
    //    `setData` ⇒ 对 `panelCode` 整体搜 `setData` 时，把聚合那行删掉**用例仍绿**
    //    （命中别处的）。⇒ 先切出 `AggregatePanel` 的函数体再断言。
    const panelStart = panelCode.indexOf('function AggregatePanel(')
    expect(panelStart, '必须存在 AggregatePanel').toBeGreaterThan(0)
    // 到下一个顶层 `export function` 为止（本文件既有体例，见上面的「load 回填」用例）。
    const nextTop = panelCode.indexOf('\nexport function ', panelStart)
    const aggBody = panelCode.slice(panelStart, nextTop > 0 ? nextTop : undefined)
    expect(aggBody.length, 'AggregatePanel 的函数体必须能被切出来').toBeGreaterThan(500)

    expect(aggBody, '★ 上移按钮必须已删除').not.toContain('上移一位')
    expect(aggBody, '★ 下移按钮必须已删除').not.toContain('下移一位')
    // ★ 拖动必须有 setData（且**在 AggregatePanel 体内**）。
    expect(aggBody, '★ 拖动必须设 dataTransfer，否则浏览器根本不触发拖拽')
      .toMatch(/dataTransfer\.setData\('text\/plain'/)
    // ★ 且必须有 onDragEnd 清引用（拖到无效区 / 按 Esc 不会有 drop ⇒ 残留会让
    //   下一次 hover 被当成「正在拖」而 preventDefault）。
    expect(aggBody, '★ 必须有 onDragEnd 清 dragKeyRef').toMatch(/onDragEnd/)

    // ⚠️⚠️ **必须同时排除「死分支」写法**（2026-10-16 对抗审计实测的共同弱点）：
    //    这批源码断言都是**文本存在性**判据，而把命中行包进 `if (false) { … }`
    //    （短路禁用）后**字面量仍在** ⇒ 断言照样通过，而那行代码**永不执行**。
    //    实测四条全绿：`setData` / `commitOrder` / `onSortByExpiry` / `onDragEnd`。
    //    ⇒ 单测环境无 react / 无 DOM（`environment: 'node'`）⇒ 组件内部逻辑
    //    **无法行为测试**，只能用「结构性判据」补强。这里做两件事：
    //    ① 该行**不得**出现在 `if (false)` / `if (0)` / `while (false)` 这类
    //       常量假条件块里（用**行级**检查：命中行往上找最近的条件语句）；
    //    ② 该行必须**不以注释形态**存在（`codeOf` 已剥注释，这里是双保险）。
    const deadBranchAround = (text, needle) => {
      const lines = text.split('\n')
      const hit = lines.findIndex((l) => l.includes(needle))
      if (hit < 0) return false
      // 往上最多找 12 行，遇到常量假条件的 `if (` 就判为死分支。
      for (let i = hit; i >= Math.max(0, hit - 12); i -= 1) {
        if (/if\s*\(\s*(false|0)\s*\)/.test(lines[i])) return true
        if (/while\s*\(\s*(false|0)\s*\)/.test(lines[i])) return true
        // 遇到函数/属性的起始（说明已跨出本语句）就停。
        if (/\b(onDrop|onDragStart|onDragEnd|onDragOver):/.test(lines[i]) && i !== hit) break
      }
      return false
    }
    expect(deadBranchAround(aggBody, "dataTransfer.setData('text/plain'"),
      '★★ `setData` 不得被包进 `if (false)` 死分支（那等于拖动永远不生效）').toBe(false)
    expect(deadBranchAround(aggBody, 'void commitOrder('),
      '★★ `commitOrder` 不得被包进死分支（那等于拖动永不落盘）').toBe(false)
  })

  it('★ 候选行不再重复渲染「无临期积分 · 未参与」文字（用户要求）', () => {
    // ⚠️ 用户 2026-10-16：「图1红框中的内容可以不用显示」。
    //    ⚠️ 但**开关按钮**的文案必须保留（它是三态的唯一出口 —— 去掉用户就无从
    //    知道该点还是不点）。故判据是「候选行里不再单独挂一个 span」，而不是
    //    「文件里不再出现这几个字」。
    //    实现形态：该文案只出现在 `describeCandidateState` 的返回里
    //  （纯函数文件），面板侧只消费 `state.label`。
    expect(panelCode, '★ 面板不得再自己拼这段文字（应只用 state.label）')
      .not.toMatch(/React\.createElement\('span',[^)]*'无临期积分/)
  })

  it('★★ 聚合面板的按钮必须用全站标准类 `dim-jh-btn`（用户 2026-10-16 第二次验收）', () => {
    // ⚠️⚠️ 用户原话：「拒绝非临期和切换排序为什么还是没有按按钮样式（图2）显示」。
    //    根因：我原先给聚合工具栏自造了 `.dim-jh-aggRefresh`（圆角 6px、**无背景色**、
    //    primary 只是描边变蓝），而全站标准 `.dim-jh-btn` 是圆角 8px + 有底色 +
    //    hover 变蓝 + `data-kind='primary'` = **实心蓝底白字**（图2 的「解锁永久积分」
    //    就是它）⇒ 两套样式看起来不像同一个 UI。
    //
    // ⚠️ 判据：工具栏与「保存顺序」都必须用 `dim-jh-btn`，且自造的那两个类
    //    **不得再出现**（死样式是本仓库红线，且它们正是「看起来不像按钮」的来源）。
    const panelStart = panelCode.indexOf('function AggregatePanel(')
    const nextTop = panelCode.indexOf('\nexport function ', panelStart)
    const aggBody = panelCode.slice(panelStart, nextTop > 0 ? nextTop : undefined)
    expect(aggBody, '★ 工具栏与保存顺序必须用标准按钮类').toContain("className: 'dim-jh-btn'")
    expect(aggBody, '★ 自造的 aggRefresh 不得再出现').not.toContain('dim-jh-aggRefresh')
    expect(aggBody, '★ 自造的 aggBtn 不得再出现').not.toContain('dim-jh-aggBtn')
    // ★ 激活态必须沿用 `'data-kind': 'primary'`（与「锁定永久积分」逐字同一形态）。
    //   ⚠️ 注意实际的写法是**引号包裹的属性名**（`:877` 等既有处一致）——
    //   我第一版写成 `data-kind:` 无引号，正则匹配不上（用例红了才发现）。
    expect(aggBody, "★ 激活态必须用 'data-kind': 'primary'")
      .toMatch(/'data-kind': orderMode === 'manual' \? 'primary' : undefined/)
    // ★ 且样式表里那几类自造样式必须已删除（零使用者的死样式）。
    const styles = read('plugin-src/client/jet-hub-styles.js')
    for (const dead of ['.dim-jh-aggRefresh', '.dim-jh-aggBtn', '.dim-jh-aggSegmented', '.dim-jh-aggMove']) {
      // ⚠️ 只匹配**规则定义行**（行首即选择器）；注释里提到它们是允许的（那是留档说明）。
      expect(styles, `★ 死样式 ${dead} 的规则定义必须已删除`)
        .not.toMatch(new RegExp(`^\\${dead}\\s*\\{`, 'm'))
    }
  })

  it('★ 计数必须排在按钮**之后**（用户 2026-10-16：「应该显示在按钮下面」）', () => {
    // ⚠️ 用户原话：「43 个聚合模型应该显示在按钮下面」。
    //    ⚠️ 判据是**位置**，故必须断言 HTML 顺序（不是「文件里出现过这句话」）——
    //    计数在按钮之前时会占掉第一行一个位置、把按钮挤到右侧或换行。
    const panelStart = panelCode.indexOf('function AggregatePanel(')
    const nextTop = panelCode.indexOf('\nexport function ', panelStart)
    const aggBody = panelCode.slice(panelStart, nextTop > 0 ? nextTop : undefined)
    const toolbarAt = aggBody.indexOf("className: 'dim-jh-aggToolbar'")
    expect(toolbarAt, '必须存在工具行').toBeGreaterThan(0)
    const countAt = aggBody.indexOf('个聚合模型', toolbarAt)
    const sortAt = aggBody.indexOf('排序：按手工', toolbarAt)
    const rejectAt = aggBody.indexOf('拒绝非临期', toolbarAt)
    expect(countAt, '计数必须在工具行里').toBeGreaterThan(toolbarAt)
    expect(sortAt).toBeGreaterThan(toolbarAt)
    expect(rejectAt).toBeGreaterThan(toolbarAt)
    expect(countAt, '★ 计数必须在排序按钮**之后**').toBeGreaterThan(sortAt)
    expect(countAt, '★ 计数必须在「拒绝非临期」**之后**').toBeGreaterThan(rejectAt)
  })

  it('★★ 拖动必须**松手即提交**（真实缺陷：只改界面 ⇒ 关窗再开顺序就丢了）', () => {
    // ⚠️⚠️ **真实缺陷**（用户验收 2026-10-16）：「把 glm 5.3 的 codearts 拉到第一个，
    //    关闭设置窗口再打开又跑最后一个了」。
    //
    // 根因：我原先在 `onDrop` 里**只** `setPendingOrder(...)`（改本地 state），
    // 把落盘交给一个「保存顺序」按钮 ⇒ 拖动**只改了界面**，宿主的
    // `state.json.aggregateOrder` 一个字都没变 ⇒ 关窗再开（重新 load）就回到旧顺序。
    //
    // ⚠️ 本仓库另两处拖动（账号卡片、渠道开关）都是**松手即提交**
    //（`onDrop` 里直接 `void commit(...)`）⇒ 我那个「先预览、再点保存」的设计
    //    与全站交互不一致，**是本缺陷的根源**。
    const panelStart = panelCode.indexOf('function AggregatePanel(')
    const nextTop = panelCode.indexOf('\nexport function ', panelStart)
    const aggBody = panelCode.slice(panelStart, nextTop > 0 ? nextTop : undefined)
    const dropAt = aggBody.indexOf('onDrop: draggable')
    expect(dropAt, '必须存在聚合候选的 onDrop').toBeGreaterThan(0)
    const dropEnd = aggBody.indexOf(': undefined,', dropAt)
    const dropBody = aggBody.slice(dropAt, dropEnd > 0 ? dropEnd : dropAt + 3000)
    expect(dropBody, '★ onDrop 里必须调 commitOrder（松手即落盘）')
      .toMatch(/void commitOrder\(/)
    // ★ 反向：「保存顺序」按钮必须已删除（它让用户以为「不点就不会保存」）。
    //   ⚠️ 判据必须看**按钮文案的位置**（`}, '保存顺序'`），不能只搜「保存顺序」三个字 ——
    //   删除处的注释里仍然提到它（说明为什么删），纯字面搜索会恒红（我第一版就是这样）。
    expect(aggBody, '★ 「保存顺序」按钮必须已删除（拖动已自动提交）')
      .not.toMatch(/\},\s*'保存顺序'\)/)
  })

  it('★★ 「先写提示再刷新」的调用必须传 keepNotice（真实缺陷：提示不到 1 秒就消失）', () => {
    // ⚠️⚠️ **真实缺陷**（用户验收 2026-10-16）：「拒绝后给出的提示信息不到 1 秒就
    //    消失了基本不会看清内容」。
    //
    // 根因：`onRejectNonExpiring` 先 `setNotice('已把 N 条…')`，紧接着
    // `await load(true)`，而 load 成功分支里的 `setNotice(null)` 把刚写的提示清掉。
    const panelStart = panelCode.indexOf('function AggregatePanel(')
    const nextTop = panelCode.indexOf('\nexport function ', panelStart)
    const aggBody = panelCode.slice(panelStart, nextTop > 0 ? nextTop : undefined)
    // ⚠️ 判据锚定到**具体函数体**，而不是全文件搜 keepNotice（后者在别处出现即恒真）。
    const rejectAt = aggBody.indexOf('const onRejectNonExpiring')
    expect(rejectAt, '必须存在 onRejectNonExpiring').toBeGreaterThan(0)
    const rejectBody = aggBody.slice(rejectAt, rejectAt + 2500)
    expect(rejectBody, '★ 一键恢复的刷新必须保留提示')
      .toMatch(/await load\(true, \{ keepNotice: true \}\)/)
    // ★ 且 `load` 本身必须支持该选项（不是只有调用方一厢情愿）。
    expect(aggBody, '★ load 必须实现 keepNotice')
      .toMatch(/if \(options\.keepNotice !== true\) setNotice\(null\)/)
  })

  it('★★ 切到「按手工」**不得**触发上游探测（真实缺陷：切模式干等一轮余额请求）', () => {
    // ⚠️⚠️ **真实缺陷**（用户验收 2026-10-16）：「切换会手工还在查询中等很长时间，
    //    **手工排序不用查询吧**？」
    //
    // 根因：`onSelectOrderMode` 原先**无条件** `await onSortByExpiry()` ——
    // 那是**逐渠道上游余额请求**（十几个 GET），于是切到手工模式也要干等一轮探测。
    // 而手工模式的价值恰恰是「按用户拖的顺序」，切过去那一刻**不需要**任何临期值。
    const panelStart = panelCode.indexOf('function AggregatePanel(')
    const nextTop = panelCode.indexOf('\nexport function ', panelStart)
    const aggBody = panelCode.slice(panelStart, nextTop > 0 ? nextTop : undefined)
    const at = aggBody.indexOf('const onSelectOrderMode')
    expect(at, '必须存在 onSelectOrderMode').toBeGreaterThan(0)
    const body = aggBody.slice(at, at + 2500)
    // ★ 探测必须**在 `mode === 'expiry'` 的条件下**（不是无条件）。
    expect(body, '★ 探测必须只在切到「按临期」时发生')
      .toMatch(/if \(mode === 'expiry'\) await onSortByExpiry\(\)/)
    // ★ 反向：不得出现「无条件探测」那两行的残留（`load(true)` 后直接 `await onSortByExpiry()`）。
    expect(body, '★ 不得无条件探测')
      .not.toMatch(/await load\(true\);\s*\n\s*await onSortByExpiry\(\);/)
    // ⚠️⚠️ **同时排除「死分支 + 无条件」组合**（2026-10-16 对抗审计实测）：
    //    保留 `if (mode === 'expiry') await onSortByExpiry()` 这行字面量、
    //    再在下面加一句**无条件**的 `await onSortByExpiry()`，上面两条断言**全绿**。
    //    ⇒ 判据：**数出** `onSortByExpiry()` 的调用点，再要求「每一个都被条件包着」。
    //    ⚠️ 我第一版用「往上找 6 行内有无 `if (`」—— **抓不到**（它找到了**相邻**那条
    //    `if` 语句的 `if`，于是把无条件调用误判成有条件的）。改用**缩进**：
    //    无条件调用的缩进与它上面那条 `if (...)` 语句**同级**（都是语句层），
    //    而有条件调用会**更深**（在 `if` 体内）。
    const calls = [...body.matchAll(/(\n[ \t]*)(await )?onSortByExpiry\(\)(?!\s*=>)/g)]
    const unconditional = calls.filter((m) => {
      const indent = m[1].replace('\n', '').length
      const upper = body.slice(0, m.index).split('\n').filter((l) => l.trim().length > 0)
      const last = upper[upper.length - 1] ?? ''
      const lastIndent = last.length - last.trimStart().length
      // 上一条非空语句若以 `if (` 开头且**缩进同级**（或更浅），它就是本调用的守卫。
      const guarded = /if\s*\(/.test(last.trim()) && lastIndent <= indent
      return !guarded
    })
    expect(unconditional.length, '★★ 每个 `onSortByExpiry()` 调用点都必须被条件包住')
      .toBe(0)
    // ★ 判据自检：必须**真的**数到了调用点（否则上面那条因「一个都没匹配到」而恒真）。
    expect(calls.length, '★ 判据自检：必须数到 onSortByExpiry 的调用点').toBeGreaterThan(0)
  })

  it('★ 空态提示必须引用那份渠道清单（清单**内容**由下方 ★★ 守卫锁）', () => {
    // ⚠️ 白名单扩大后清单也要跟 —— 否则提示会漏掉真的可用的渠道。
    const at = panelCode.indexOf('当前没有可聚合的模型')
    expect(at, '必须存在该空态提示').toBeGreaterThan(0)
    // ⚠️ **不要用魔数窗口**（真实脆弱点，审计实测指出）：原实现是
    //    `panelCode.slice(at, at + 300)`，而 `lobsterai` 落在偏移 90、`trae` 在 102
    //    ⇒ 文案一变长（余量 <60 字符）就会**假失败**。
    //
    // ⚠️ 我第一版改成「到下一个 `React.createElement` 或 `</p>`」——**仍然过宽**：
    //    该文案是**跨两行的字符串拼接**（`'…渠道'` + `'（…）登录账号。'`），而
    //    `React.createElement` 在它**之前** ⇒ 边界取负、窗口退化成 1200 字符，
    //    于是「去掉提示里的 trae」这个变异**不会变红**（`trae` 在文件里出现 22 次，
    //    窗口外的命中把断言喂饱了）——反向验证实测发现了这一点。
    // ⇒ 改为**精确到该文案的结尾**（`登录账号。` 那句），窗口正好覆盖整段提示。
    const rest = panelCode.slice(at)
    const end = rest.indexOf('登录账号。')
    const snippet = end > 0 ? rest.slice(0, end + '登录账号。'.length) : rest.slice(0, 400)
    expect(snippet, '窗口必须精确覆盖该提示（否则断言会被窗口外的文本喂饱）')
      .toContain('当前没有可聚合的模型')
    // ⚠️ 2026-10-15（PR#101 复审）：原断言是「snippet 里含 `lobsterai` / `trae`」——
    //    它只**抽查**两个名字。而清单当时被**写死**在这句里，2026-10-13 加
    //    accio / officeace 时没人回头改 ⇒ 提示漏掉两家（只登了那两家的用户看到错话），
    //    而这个抽查式断言**照样全绿**。现清单抽成具名常量（原
    //    `AGG_WIRED_CHANNEL_LABELS`，2026-10-20 改为只存 id 的
    //    `AGG_WIRED_CHANNEL_IDS`，显示名经 `providerLabel()` 现查）：
    //    本用例守「提示真的引用了它、且不得再写死一份」，
    //    **内容**由文件末尾的 ★★ 守卫与 `WIRED_EXPIRY_PROVIDERS` 锁成**集合相等**
    //（覆盖全部渠道，比抽查两个名字更强）。
    expect(snippet, '提示必须引用 AGG_WIRED_CHANNEL_IDS')
      .toContain('AGG_WIRED_CHANNEL_IDS')
    expect(snippet, '不得在提示里再写死一份渠道名单')
      .not.toMatch(/'[^']*buddy[^']*'/)
  })
})

describe('★ 面板必须回填宿主返回的拒绝状态（真实缺陷，对抗审计实测证伪）', () => {
  const read = (rel) => readFileSync(resolve(here, '../..', rel), 'utf8')
  const codeOf = (text) => text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
  const panelCode = codeOf(read('plugin-src/client/jet-hub.js'))

  /**
   * ⚠️⚠️ **真实缺陷**（对抗审计探针实测）：宿主在 `aggregate.catalog` 的每个候选上
   * 返回 `rejected: boolean`（`src/aggregate-adapter.ts:343`、`src/types.ts:933`），
   * 而客户端**从不读它** —— 组件读的是本地 `rejections` 状态，而那个状态的初值是 `{}`
   * 且 `load()` **从不**回填。
   *
   * ⇒ **刷新页面后每条开关都显示「参与轮换」**（即使该候选已被拒绝）；
   * 此时用户点一下，`next = !isRejected({}, …) = true`，发出的是 `rejected: true`…
   * 但若用户本意是「保持拒绝」，他看到的开关是「参与轮换」⇒ 点一下变成「已拒绝」？
   * 不 —— 关键在**用户以为自己没拒绝过**，于是不会去点；而**一旦点到**，发出的
   * 语义与界面显示的状态一致，但**与宿主真实状态相反**：界面显示「参与轮换」
   * 而宿主是「已拒绝」，点击发出 `rejected: false`… 实际发出的是 `!false = true`？
   *
   * 精确说：`isRejected({}, …)` 恒为 `false` ⇒ 界面显示「参与轮换」。
   * 点击后 `next = !false = true` ⇒ 发出 `rejected: true`（= 再次拒绝，无害）。
   * **但**：若用户想「取消拒绝」，他会看到「参与轮换」以为没拒绝过 —— 真正的问题是
   * **界面与宿主状态不一致**（用户无法知道自己拒绝过什么），且第一次点击的语义
   * 与界面暗示的相反。
   *
   * ⚠️ 更直接的危害：用户 A 拒绝过某候选 → 刷新 → 界面显示「参与轮换」→
   * 用户以为没拒绝过（或以为拒绝丢了）→ **无法通过界面判断真实状态**。
   * 修法：`load()` 必须把 `res.models[].candidates[].rejected` 回填进 `rejections`。
   */
  it('★ load() 必须把宿主返回的 rejected 回填进 rejections 状态', () => {
    // ⚠️ 必须**先定位 `AggregatePanel`** 再找它的 `load` —— 本文件里 `load` 有多个
    //    （另一个组件的在更前面）。我第一版直接 `indexOf('const load = …')`
    //    取到了**另一个组件**的 load，于是断言恒失败（那是我的断言写错，不是实现问题）。
    const panelStart = panelCode.indexOf('function AggregatePanel(')
    expect(panelStart, '必须存在 AggregatePanel').toBeGreaterThan(0)
    const start = panelCode.indexOf('const load = React.useCallback', panelStart)
    expect(start, '必须存在 AggregatePanel 的 load').toBeGreaterThan(panelStart)
    // 到下一个顶层 `export function` 为止（不必猜长度）。
    const nextTop = panelCode.indexOf('\nexport function ', start)
    const body = panelCode.slice(start, nextTop > 0 ? nextTop : undefined)
    expect(body, 'load 必须调用 setRejections 回填宿主状态')
      .toMatch(/setRejections\(/)
    // ⚠️ 且必须用纯函数摊平（而不是自己写三层结构 —— 那会与 `isRejected` 分叉）。
    expect(body).toMatch(/rejectionsFromCatalog\(/)
  })

  it('★ 必须有「把 catalog 的 rejected 摊平成拒绝表」的纯函数（判据只写一份）', () => {
    // ⚠️ 摊平逻辑必须是**纯函数**（单测环境没有 react），且与 `isRejected` 的
    //    三层结构一致（canonicalId → provider → realId → true）。
    expect(read('plugin-src/client/aggregate-panel-logic.js'))
      .toMatch(/export function\s+\w*[Rr]ejection\w*From\w*Catalog|export function\s+rejectionsFromCatalog/)
  })
})

describe('★ isAllCandidatesRejected：候选全部被拒的显式提示（规格 §5.2 要求）', () => {
  const model = (canonicalId, candidates) => ({ canonicalId, candidates })
  const cand = (provider, realId) => ({ provider, realId })

  it('★ 每条都被拒 ⇒ true（面板据此显示「⚠️ 全部被拒」）', () => {
    const m = model('m1', [cand('buddy', 'a'), cand('zcode', 'b')])
    const rejections = {
      m1: { buddy: { a: true }, zcode: { b: true } },
    }
    expect(isAllCandidatesRejected(m, rejections)).toBe(true)
  })

  it('★ 只拒了一部分 ⇒ false（请求仍能路由到未拒的那条）', () => {
    const m = model('m1', [cand('buddy', 'a'), cand('zcode', 'b')])
    const rejections = { m1: { buddy: { a: true } } }
    expect(isAllCandidatesRejected(m, rejections)).toBe(false)
  })

  it('★ 一条也没拒 ⇒ false', () => {
    const m = model('m1', [cand('buddy', 'a')])
    expect(isAllCandidatesRejected(m, {})).toBe(false)
  })

  it('★ 无候选 ⇒ false（「无候选」是另一回事，不是「全被拒」）', () => {
    // ⚠️ 规格明确区分：全被拒 **≠** 关闭模型。无候选的模型不该报「全部被拒」。
    expect(isAllCandidatesRejected(model('m1', []), {})).toBe(false)
  })

  it('★ 畸形入参不抛错', () => {
    expect(isAllCandidatesRejected(null, {})).toBe(false)
    expect(isAllCandidatesRejected(undefined, {})).toBe(false)
    expect(isAllCandidatesRejected({}, {})).toBe(false)
    expect(isAllCandidatesRejected(model('m1', null), {})).toBe(false)
  })

  it('★ 拒绝表结构与 isRejected 一致（三层，不因层缺失而误判）', () => {
    const m = model('m1', [cand('buddy', 'a')])
    // 层存在但值是 false ⇒ 不算被拒
    expect(isAllCandidatesRejected(m, { m1: { buddy: { a: false } } })).toBe(false)
    // 只有 provider 层、没有 realId 层 ⇒ 不算被拒
    expect(isAllCandidatesRejected(m, { m1: { buddy: {} } })).toBe(false)
  })
})

describe('★ rejectionsFromCatalog：行为级（原先只有源码字符串断言，零行为覆盖）', () => {
  const model = (canonicalId, candidates) => ({ canonicalId, candidates })
  const cand = (provider, realId, rejected) => ({ provider, realId, rejected })

  it('★ 把宿主返回的 rejected 摊平成三层结构（isRejected 必须能查到）', () => {
    const models = [
      model('m1', [cand('buddy', 'a', true), cand('zcode', 'b', false)]),
      model('m2', [cand('buddy', 'c', true)]),
    ]
    const table = rejectionsFromCatalog(models)
    // ★ 关键断言：摊平结果必须能被 isRejected 查到（结构一致）
    expect(isRejected(table, 'm1', 'buddy', 'a'), 'm1/buddy/a 应查到').toBe(true)
    expect(isRejected(table, 'm1', 'zcode', 'b'), 'false 的不该进表').toBe(false)
    expect(isRejected(table, 'm2', 'buddy', 'c'), 'm2/buddy/c 应查到').toBe(true)
    // 结构逐层一致
    expect(table).toEqual({ m1: { buddy: { a: true } }, m2: { buddy: { c: true } } })
  })

  it('★ 只收**显式 true**（与宿主的 sanitize 同口径）', () => {
    const models = [model('m1', [
      { provider: 'buddy', realId: 'a' },              // rejected 缺失
      cand('buddy', 'b', undefined),
      cand('buddy', 'c', 'true'),                      // 字符串
      cand('buddy', 'd', 1),                           // 数字
    ])]
    expect(rejectionsFromCatalog(models)).toEqual({})
  })

  it('★ 畸形入参不得建出空层', () => {
    expect(rejectionsFromCatalog(null)).toEqual({})
    expect(rejectionsFromCatalog(undefined)).toEqual({})
    expect(rejectionsFromCatalog('nope')).toEqual({})
    expect(rejectionsFromCatalog([null, 42])).toEqual({})
    expect(rejectionsFromCatalog([{ canonicalId: '', candidates: [cand('b', 'r', true)] }])).toEqual({})
    expect(rejectionsFromCatalog([model('m1', null)])).toEqual({})
    // provider / realId 为空的条目跳过（否则会建出查不到的空层）
    expect(rejectionsFromCatalog([model('m1', [
      { provider: '', realId: 'r', rejected: true },
      { provider: 'p', realId: '', rejected: true },
    ])])).toEqual({})
  })

  it('★ 摊平后 isRejected 与 isAllCandidatesRejected 一致（全被拒能被识别）', () => {
    const models = [model('m1', [cand('buddy', 'a', true), cand('zcode', 'b', true)])]
    const table = rejectionsFromCatalog(models)
    expect(isAllCandidatesRejected(models[0], table), '两条都被拒 ⇒ 应识别为全拒').toBe(true)
  })

  it('★★ 默认不参与（`state: default-rejected`）**不得**被摊进拒绝表（2026-10-15 语义收窄）', () => {
    // ⚠️⚠️ 真实风险：宿主把 `rejected` 的语义**收窄**成「当前不参与轮换」（含
    //    「未接入折算 ⇒ 默认不参与」），于是未打开的未接入候选现在 `rejected: true`。
    //    若本函数只看 `rejected`，它会把那些条目摊进客户端**拒绝表** ⇒ 面板显示
    //    「已拒绝」（= 你拒绝过它），而用户**从没点过** —— 这是面板撒谎。
    //    ⇒ 判据必须看 `state`：只有 `'rejected'` 才是「用户显式拒绝」。
    const models = [model('m1', [
      { provider: 'raccoon', realId: 'r', rejected: true, state: 'default-rejected' },
      { provider: 'buddy', realId: 'b', rejected: true, state: 'rejected' },
      { provider: 'zcode', realId: 'z', rejected: true, state: 'allowed' },   // 矛盾数据
    ])]
    const table = rejectionsFromCatalog(models)
    expect(isRejected(table, 'm1', 'buddy', 'b'), '★ 显式拒绝必须进表').toBe(true)
    expect(isRejected(table, 'm1', 'raccoon', 'r'), '★ 默认不参与**不得**被当成用户拒绝').toBe(false)
    // 矛盾数据（rejected:true 但 state:allowed）以 state 为准（它是权威字段）。
    expect(isRejected(table, 'm1', 'zcode', 'z'), 'state 是权威').toBe(false)
  })

  it('★ 老宿主（响应里没有 state 字段）按原判据回退 ⇒ 不回归', () => {
    // ⚠️ 兼容：升级期可能「新客户端 + 老宿主」。老宿主只给 `rejected`（语义=显式拒绝）
    //    ⇒ 那时必须仍按它摊平，否则用户存的拒绝状态会**全部消失**（界面显示全参与）。
    const models = [model('m1', [cand('buddy', 'a', true), cand('buddy', 'b', false)])]
    const table = rejectionsFromCatalog(models)
    expect(isRejected(table, 'm1', 'buddy', 'a'), '老宿主格式必须仍能摊平').toBe(true)
    expect(isRejected(table, 'm1', 'buddy', 'b')).toBe(false)
  })
})

describe('★★ candidateStateOf：老宿主回退（响应里没有 `state` 时按拒绝表判）', () => {
  const cand = (extra) => ({ provider: 'buddy', realId: 'r', ...extra })

  it('★ 有新宿主的 state ⇒ 原样采用（不做任何推导）', () => {
    expect(candidateStateOf('m', cand({ state: 'default-rejected' }), {})).toBe('default-rejected')
    expect(candidateStateOf('m', cand({ state: 'allowed' }), { m: { buddy: { r: true } } })).toBe('allowed')
  })

  it('★ 老宿主（无 state）+ 在终端的拒绝表里 ⇒ rejected', () => {
    expect(candidateStateOf('m', cand({}), { m: { buddy: { r: true } } })).toBe('rejected')
  })

  it('★ 老宿主 + 不在拒绝表里 ⇒ allowed（老宿主下「列出来且没被拒」= 参与）', () => {
    expect(candidateStateOf('m', cand({}), {})).toBe('allowed')
  })

  it('★ 畸形 state 走回退（不认「非字符串」）', () => {
    expect(candidateStateOf('m', cand({ state: 42 }), { m: { buddy: { r: true } } })).toBe('rejected')
    expect(candidateStateOf('m', cand({ state: null }), {})).toBe('allowed')
  })

  it('★★ 老宿主下三个纯函数都能工作（不是只修了其中一个）', () => {
    // ⚠️ 这条防「只给 describeCandidateState 接了回退」：
    //    `rotationBlockerOf` 漏了它 ⇒ 全拒时**一个提示都不给**；
    //    `candidateToggleAction` 漏了它 ⇒ 发出老宿主**不认识**的 `setAllowed`。
    const legacy = {
      canonicalId: 'm',
      candidates: [{ provider: 'buddy', realId: 'a' }, { provider: 'zcode', realId: 'b' }],
    }
    const rejections = { m: { buddy: { a: true }, zcode: { b: true } } }
    expect(rotationBlockerOf(legacy, rejections), '全拒 ⇒ 必须给提示').toBe('all-rejected')
    const roster = rotationRosterOf(legacy, null, () => 100, rejections)
    expect(roster.participating, '老宿主下没有默认不参与态 ⇒ 全在未参与段').toEqual([])
    const action = candidateToggleAction('m', legacy.candidates[0], {
      state: candidateStateOf('m', legacy.candidates[0], rejections),
    })
    expect(action.rpc, '★ 老宿主只认识 setRejected').toBe('aggregate.setRejected')
  })
})

describe('★★ candidateKeyOf / candidateToggleAction（用户 2026-10-15，「点哪张表」的唯一判据）', () => {
  const cand = (extra) => ({ provider: 'raccoon', realId: 'sn-glm-5-3', ...extra })

  it('candidateKeyOf 用 NUL 分隔（与宿主的顺序表约定逐字相同）', () => {
    expect(candidateKeyOf({ provider: 'raccoon', realId: 'sn-glm-5-3' }))
      .toBe('raccoon\u0000sn-glm-5-3')
    // ⚠️ 不能是冒号/斜杠：realId 里可能有斜杠（`cline-free/deepseek-v4.1-flash`）。
    expect(candidateKeyOf({ provider: 'cline', realId: 'cline-free/x' }))
      .toBe('cline\u0000cline-free/x')
  })

  it('★ rejected ⇒ setRejected(false)（走既有 D4 恢复路径，不是 setAllowed）', () => {
    const action = candidateToggleAction('m', cand({ state: 'rejected', expiryWired: true }))
    expect(action.rpc).toBe('aggregate.setRejected')
    expect(action.payload).toEqual({
      canonicalId: 'm', provider: 'raccoon', realId: 'sn-glm-5-3', rejected: false,
    })
  })

  it('★ default-rejected ⇒ setAllowed(true)', () => {
    const action = candidateToggleAction('m', cand({ state: 'default-rejected', expiryWired: false }))
    expect(action.rpc).toBe('aggregate.setAllowed')
    expect(action.payload).toEqual({
      canonicalId: 'm', provider: 'raccoon', realId: 'sn-glm-5-3', allowed: true,
    })
  })

  it('★ allowed + 已接入 ⇒ setRejected(true)', () => {
    const action = candidateToggleAction('m', cand({ state: 'allowed', expiryWired: true }))
    expect(action.rpc).toBe('aggregate.setRejected')
    expect(action.payload).toEqual({
      canonicalId: 'm', provider: 'raccoon', realId: 'sn-glm-5-3', rejected: true,
    })
  })

  it('★★ allowed + 未接入 ⇒ setAllowed(false)（回到默认态，**不得**写拒绝表）', () => {
    // ⚠️⚠️ 这一格最容易写错：未接入渠道的「不参与」与「拒绝」**同义**，若写
    //    `setRejected(true)`，拒绝表里会留下一批**永不起作用**的条目（该渠道默认就不参与），
    //    而且会污染「拒绝非临期」的 `cleared` 计数与「恢复默认」的语义。
    const action = candidateToggleAction('m', cand({ state: 'allowed', expiryWired: false }))
    expect(action.rpc).toBe('aggregate.setAllowed')
    expect(action.payload).toEqual({
      canonicalId: 'm', provider: 'raccoon', realId: 'sn-glm-5-3', allowed: false,
    })
  })

  it('★ payload 必须带三项（少一项端点即 bad-request）', () => {
    for (const state of ['allowed', 'rejected', 'default-rejected']) {
      for (const wired of [true, false]) {
        const { payload } = candidateToggleAction('m', cand({ state, expiryWired: wired }))
        expect(payload.canonicalId, `${state}/${wired}`).toBe('m')
        expect(payload.provider).toBe('raccoon')
        expect(payload.realId).toBe('sn-glm-5-3')
        // ⚠️ 业务字段（rejected / allowed）恰好一个，且必须是布尔 ——
        //    两个都给会让服务端按哪个判语义不明；一个都不给等于空写。
        const business = ['rejected', 'allowed'].filter((k) => Object.hasOwn(payload, k))
        expect(business, `${state}/${wired} 必须有且只有一个业务字段`).toHaveLength(1)
        expect(typeof payload[business[0]]).toBe('boolean')
      }
    }
  })

  it('★ 畸形输入不抛错（未知 state 按「当前未参与、可打开」处理，且**不**沿用 expiryWired 分支）', () => {
    expect(() => candidateToggleAction('m', undefined)).not.toThrow()
    expect(() => candidateToggleAction(undefined, cand({ state: '?' }))).not.toThrow()
  })
})

describe('★★ describeCandidateState（三态文案 + 已打开的未接入渠道的额外说明）', () => {
  const cand = (extra) => ({ provider: 'raccoon', realId: 'r', ...extra })

  it('★ allowed + 已接入 ⇒ 「参与轮换」/ pressed=true', () => {
    const state = describeCandidateState(cand({ state: 'allowed', expiryWired: true }))
    expect(state.label).toBe('参与轮换')
    expect(state.pressed).toBe(true)
  })

  it('★ rejected ⇒ 「已拒绝」/ pressed=false，且 title 说明点击可恢复', () => {
    const state = describeCandidateState(cand({ state: 'rejected', expiryWired: true }))
    expect(state.label).toContain('已拒绝')
    expect(state.pressed).toBe(false)
    expect(state.title).toMatch(/恢复/)
  })

  it('★ default-rejected ⇒ 文案必须写明「无临期积分」与「默认不参与」', () => {
    const state = describeCandidateState(cand({ state: 'default-rejected', expiryWired: false }))
    expect(state.label).toContain('无临期积分')
    expect(state.label).toContain('未参与')
    expect(state.title).toMatch(/默认不参与/)
    expect(state.pressed).toBe(false)
  })

  it('★★ allowed + 未接入 ⇒ 文案必须**额外说明它排在所有有临期信息的候选之后**', () => {
    // ⚠️ 面板必须说真话：手工打开的未接入候选的 `expiry` 是 `NEVER`（与已接入渠道的
    //    「无临期积分」**同值**）⇒ 它排在能算出临期的候选**之后**。若只显示
    //    「参与轮换」，用户会以为「我明明打开了却没优先用它」是缺陷。
    const state = describeCandidateState(cand({ state: 'allowed', expiryWired: false }))
    expect(state.pressed).toBe(true)
    expect(state.label, 'label 要能区分「无临期信息」').toContain('无临期')
    expect(state.title, '★ 必须说明它排在能算出临期的候选之后').toMatch(/之后/)
  })

  it('★ 畸形输入不抛错', () => {
    expect(() => describeCandidateState(undefined)).not.toThrow()
    expect(describeCandidateState(undefined).pressed).toBe(false)
  })
})

describe('★★ rotationBlockerOf：四种「为什么不轮换」的显式原因', () => {
  const m = (states) => ({ canonicalId: 'm', candidates: states.map((s) => ({ provider: 'p', realId: 'r', state: s })) })

  it('★ 有任一 allowed ⇒ none', () => {
    expect(rotationBlockerOf(m(['rejected', 'allowed']))).toBe('none')
  })

  it('★ 全是 rejected ⇒ all-rejected（既有文案那一档，不得丢）', () => {
    expect(rotationBlockerOf(m(['rejected', 'rejected']))).toBe('all-rejected')
  })

  it('★ 全是 default-rejected ⇒ all-default（新原因）', () => {
    expect(rotationBlockerOf(m(['default-rejected']))).toBe('all-default')
  })

  it('★ 两种混合 ⇒ mixed（**不得**谎称「全部被拒」或「全部无临期积分」）', () => {
    expect(rotationBlockerOf(m(['rejected', 'default-rejected']))).toBe('mixed')
  })

  it('★ 无候选 / 畸形 ⇒ none（「无候选」不是「都不能轮换」）', () => {
    expect(rotationBlockerOf(m([]))).toBe('none')
    expect(rotationBlockerOf(null)).toBe('none')
    expect(rotationBlockerOf({})).toBe('none')
  })

  it('★ 与 isAllCandidatesRejected 并存且方向一致（全被拒时两者都成立）', () => {
    // ⚠️ `isAllCandidatesRejected` 被既有用例逐字锁定（规格 §5.2 的成文要求），
    //    本 PR **扩展**原因分类而不是替换它 ⇒ 两者必须同时对「全被拒」成立。
    const model = {
      canonicalId: 'm',
      candidates: [
        { provider: 'buddy', realId: 'a', state: 'rejected', rejected: true, expiryWired: true },
        { provider: 'zcode', realId: 'b', state: 'rejected', rejected: true, expiryWired: true },
      ],
    }
    const table = rejectionsFromCatalog([model])
    expect(isAllCandidatesRejected(model, table)).toBe(true)
    expect(rotationBlockerOf(model)).toBe('all-rejected')
  })
})

describe('★★ 手工排序纯函数（拖动 / 上移下移 / 提交数组）', () => {
  const c = (provider, realId, extra) => ({ provider, realId, price: 1, ...extra })

  it('★ rankCandidatesForPanel 与宿主 rankCandidates **同序**（跨层一致性）', async () => {
    // ⚠️⚠️ 这是本组**最重要**的一条：面板显示顺序与真实轮换顺序分叉正是本仓库红线
    //    （「拖了排序却按别的顺序走」）。判据 = 同一份 fixture 过两个实现、逐项相等。
    //    ⚠️ fixture 必须含：两个 NEVER（倍率不同）、一个手工排过的晚临期候选、一个未排过的候补。
    //    ⚠️⚠️ **还必须含一个 `UNUSABLE`（-1）候选**（2026-10-16 审计实测的漏网）：
    //    原来的 fixture **全是有限值或 `NEVER`** ⇒ `rankCandidatesForPanel` 漏掉
    //    `-1` 哨兵分支（把「查不到」排到最前）时**这条恒绿**，我自己注入变异验证过。
    //    ⇒ 加这一格后，宿主（对 `UNUSABLE` 是**剔除**）与面板（**排最后**）的差异
    //    会被这条用例看见 —— 两者的**共同不变量**是「`UNUSABLE` 绝不出现在有限临期之前」。
    const { rankCandidates, NEVER, UNUSABLE } = await import('../../src/aggregate-core.js')
    const candidates = [
      c('tail-b', 'r', { expiry: 500, price: 1 }),
      c('ranked', 'r', { expiry: NEVER, price: 9 }),
      c('never-cheap', 'r', { expiry: NEVER, price: 2 }),
      c('never-pricey', 'r', { expiry: NEVER, price: 7 }),
      c('tail-a', 'r', { expiry: 100, price: 5 }),
      // ★ 「查不到」的候选：宿主会**剔除**它，面板保留可见但必须**排最后**。
      c('unusable', 'r', { expiry: UNUSABLE, price: 1 }),
    ]
    const rankMap = new Map([['ranked\u0000r', 0]])
    const expiryOf = (provider) => candidates.find((x) => x.provider === provider).expiry

    const host = rankCandidates(candidates, (x) => rankMap.get(`${x.provider}\u0000${x.realId}`))
      .map((x) => x.provider)
    const panel = rankCandidatesForPanel(candidates, rankMap, expiryOf).map((x) => x.provider)

    // ⚠️ 不能直接 `toEqual`：宿主**剔除** `UNUSABLE` 而面板**保留**它（那是刻意的 ——
    //    用户要在面板里看得到它、以及为什么没参与）。⇒ 判据是**共同不变量**：
    //    ① 面板顺序去掉 unusable 后，必须与宿主**逐项相同**；
    //    ② unusable 必须排在**所有**有有限临期的候选**之后**（绝不出现在最前）。
    expect(panel.filter((p) => p !== 'unusable'), '★ 面板顺序（剔除 unusable）必须与宿主逐项相同')
      .toEqual(host)
    expect(host, '★ 宿主必须剔除 UNUSABLE（前置：证明上面那条不是恒真）').not.toContain('unusable')
    // ⚠️⚠️ 判据必须**直接打在 `-1` 的排序位置上**（我第一版写成「排在有限临期之后」，
    //    实测**抓不到**：`ranked` 的手工位次是 0（严格优先），故去掉 `-1` 分支后
    //    `unusable` 只排到第 1 位、仍然「在某个有限临期之后」⇒ 断言通过。
    //    ⇒ 改为与 `sortCandidatesByExpiry` 那条守卫**同型**的判据：
    //    在**没有手工位次**的对照世界里，`-1` 必须排在一个**极小有限值**（如 1）之后。
    const plain = [
      c('unknown', 'r', { expiry: UNUSABLE }),
      c('real', 'r', { expiry: 1 }),
    ]
    expect(
      rankCandidatesForPanel(plain, null, (p) => plain.find((x) => x.provider === p).expiry)
        .map((x) => x.provider),
      '★ UNUSABLE(-1) 必须排在极小有限临期(1) **之后** —— 去掉 -1 分支时这里会变红',
    ).toEqual(['real', 'unknown'])
    // 防「两边都空/都原序」让上面那条恒真：
    expect(host[0], '手工排过的必须第一').toBe('ranked')
    expect(host).toContain('never-cheap')
  })

  it('★ rankCandidatesForPanel：`rankMap` 为 null（临期模式）⇒ 全部按临期', () => {
    const rows = [
      c('b', 'r', { expiry: 900 }),
      c('a', 'r', { expiry: 100 }),
    ]
    expect(rankCandidatesForPanel(rows, null, (p) => (p === 'a' ? 100 : 900)).map((x) => x.provider))
      .toEqual(['a', 'b'])
  })

  it('★ rankCandidatesForPanel：两个 NEVER 按倍率而不是 NaN', () => {
    const rows = [c('x', 'r', { price: 5 }), c('y', 'r', { price: 2 })]
    // expiryOf 返回 undefined ⇒ 视为 NEVER（Infinity）；相减会得 NaN ⇒ 必须退到倍率。
    expect(rankCandidatesForPanel(rows, null, () => undefined).map((x) => x.provider))
      .toEqual(['y', 'x'])
  })

  it('★ rotationRosterOf：participating 只含 allowed 且是**排好序**的；inactive 是其余', () => {
    const model = {
      canonicalId: 'm',
      candidates: [
        c('a', 'r', { state: 'allowed', expiry: 200 }),
        c('b', 'r', { state: 'default-rejected' }),
        c('c', 'r', { state: 'allowed', expiry: 100 }),
        c('d', 'r', { state: 'rejected' }),
      ],
    }
    const roster = rotationRosterOf(model, null, (p) => (p === 'a' ? 200 : 100))
    expect(roster.participating.map((x) => x.provider), '★ 参与段按临期升序').toEqual(['c', 'a'])
    expect(roster.inactive.map((x) => x.provider).sort()).toEqual(['b', 'd'])
  })

  it('★ moveCandidate：上移 / 下移；首位上移与末位下移是恒等（**不丢元素**）', () => {
    const order = ['a', 'b', 'c']
    expect(moveCandidate(order, 'b', -1)).toEqual(['b', 'a', 'c'])
    expect(moveCandidate(order, 'b', 1)).toEqual(['a', 'c', 'b'])
    expect(moveCandidate(order, 'a', -1), '首位上移 = 恒等（不得变成空数组）').toEqual(['a', 'b', 'c'])
    expect(moveCandidate(order, 'c', 1), '末位下移 = 恒等').toEqual(['a', 'b', 'c'])
    expect(order, '★ 不可变：不得改入参').toEqual(['a', 'b', 'c'])
  })

  it('★ moveCandidate：键不在数组里 ⇒ 原样返回（不抛错、不吞掉其它元素）', () => {
    expect(moveCandidate(['a', 'b'], 'zz', -1)).toEqual(['a', 'b'])
    expect(moveCandidate([], 'a', 1)).toEqual([])
    expect(moveCandidate(null, 'a', 1)).toEqual([])
  })

  it('★ moveCandidateTo：越界目标被夹到合法区间', () => {
    expect(moveCandidateTo(['a', 'b', 'c'], 'c', 0)).toEqual(['c', 'a', 'b'])
    expect(moveCandidateTo(['a', 'b', 'c'], 'a', 99)).toEqual(['b', 'c', 'a'])
    expect(moveCandidateTo(['a', 'b', 'c'], 'a', -5)).toEqual(['a', 'b', 'c'])
    expect(moveCandidateTo(['a', 'b', 'c'], 'b', 1), '同位 = 恒等').toEqual(['a', 'b', 'c'])
  })

  it('★ pendingOrderFromRoster：把参与的候选按当前**显示**顺序拼成服务端要的键数组', () => {
    const participating = [c('raccoon', 'sn-glm-5-3', { state: 'allowed' }), c('buddy', 'glm-5.3', { state: 'allowed' })]
    expect(pendingOrderFromRoster(participating))
      .toEqual(['raccoon\u0000sn-glm-5-3', 'buddy\u0000glm-5.3'])
    expect(pendingOrderFromRoster(null)).toEqual([])
  })
})

/**
 * ★★ 空态文案里的渠道名单必须与 `WIRED_EXPIRY_PROVIDERS` **集合相等**。
 *
 * ## 为什么需要它（真实缺陷，2026-10-15 PR#101 复审发现）
 *
 * 聚合面板的空态文案手抄了一份「已接入临期折算的渠道」名单（现为
 * `AGG_WIRED_CHANNEL_LABELS`）。2026-10-13 接入 `accio` / `officeace` 之后**没人回头
 * 改它** ⇒ **只登了这两家**的用户会看到「请先在……登录账号」这句**错话** ——
 * 他们其实已经登录了，只是名单里没有那两家。而且该句**随客户端 bundle 发到了用户机器上**
 *（实测已进 `lib/client/jet-hub.js`），不是只在源码里躺着。
 *
 * ⚠️ 客户端 bundle 是**独立 entry、不 import 宿主模块**（见 `plugin-src/client/build.mjs`），
 * 所以这份名单只能是手抄 —— 本用例就是那条「必须同改」的守卫。
 *
 * ⚠️ **判据是源码文本**（名单是字面量、没有可观测行为），故按本仓库惯例做成
 * **fail-closed**：抽不到常量就**抛错**。若退回 `null` 断言再比集合，两边都空会
 * **恒真**（守卫静默失效）；改名/重构正是最容易触发它的动作。
 */
describe('★★ 空态文案的渠道名单 == WIRED_EXPIRY_PROVIDERS', () => {
  /**
   * 从客户端源码里抽出那份**id** 名单。
   *
   * ⚠️⚠️ 2026-10-20 改：原先是手抄的**显示名**字符串（`'buddy / workbuddy / …'`），
   * 与后端 `WIRED_EXPIRY_PROVIDERS`（存 **id**）**天然不同构** —— 之前靠 11 家的
   * label 恰好等于 id 蒙混过关；一遇到 label 与 id 不同的 provider（如
   * `autoclawintl` → 「AutoClaw (国际版)」）就必然分叉，守卫永远对不上。
   *
   * ⇒ 改为抽 **id 名单**，文案侧经 `providerLabel(id)` 现查：
   *   - 「id 名单 == 后端清单」才是真正的集合相等；
   *   - 「id → label」由 registry 单一持有 ⇒ 改名 / 新增 provider 时**零改动**。
   *
   * @throws 抽不到 `AGG_WIRED_CHANNEL_IDS` 的数组字面量时**抛错**（fail-closed）。
   */
  function clientChannelIds(): string[] {
    const source = readFileSync(resolve(here, '../../plugin-src/client/jet-hub.js'), 'utf8')
    const matched = /const AGG_WIRED_CHANNEL_IDS = \[([^\]]*)\]/.exec(source)
    if (matched === null) {
      throw new Error(
        '抽不到 `AGG_WIRED_CHANNEL_IDS` 的数组字面量 —— 常量被改名/改写了？'
        + '本守卫必须跟着改，**不得**让它静默失效（fail-closed）',
      )
    }
    return matched[1].split(',').map((id) => id.trim().replace(/^['"]|['"]$/g, ''))
      .filter((id) => id.length > 0)
  }

  it('两边的渠道集合相等（顺序无关）', () => {
    expect(clientChannelIds().sort()).toEqual([...WIRED_EXPIRY_PROVIDERS].sort())
  })

  it('★ 判据自检：两份名单都真的非空（否则上一条会退化成恒真）', () => {
    expect(clientChannelIds().length, '客户端名单抽出来是空的 ⇒ 上面那条是同义反复')
      .toBeGreaterThan(0)
    expect(WIRED_EXPIRY_PROVIDERS.length, '白名单为空 ⇒ 上面那条是同义反复')
      .toBeGreaterThan(0)
  })

  /**
   * ⚠️ 文案**不许再手抄显示名**（2026-10-20 新增的一条）。
   *
   * 旧形态 `const AGG_WIRED_CHANNEL_LABELS = 'buddy / workbuddy / …'`（**已删除**）
   * 是一份手抄的显示名，每加一家要同步两处名字（registry + 这里），历史上已经烂过
   * （接入 accio/officeace 后没人回头改，只登那两家的用户看到「请先登录」错话）。
   *
   * ⇒ 锁死「文案侧只存 id，名字经 `providerLabel()` 现查」。
   */
  it('★ 文案侧只存 id，显示名经 providerLabel 现查（不再手抄名字）', () => {
    const source = readFileSync(resolve(here, '../../plugin-src/client/jet-hub.js'), 'utf8')
    expect(source).toContain('AGG_WIRED_CHANNEL_IDS')
    // 旧的手抄显示名常量必须**没有定义**（防止两条路并存、其中一条悄悄腐烂）。
    // ⚠️ 判据是 `const AGG_WIRED_CHANNEL_LABELS =`（**带定义**）而不是裸名字：
    //    JSDoc 里保留旧名的历史说明是有价值的（告诉后人为什么改），
    //    用裸名字会把那段说明判成残留 ⇒ 误红。
    expect(source, 'AGG_WIRED_CHANNEL_LABELS 的定义应已删除，别让两条路并存')
      .not.toMatch(/const\s+AGG_WIRED_CHANNEL_LABELS\s*=/)
    // 渲染处必须走 providerLabel，而不是把裸 id 直接拼进文案。
    expect(source, '空态文案必须经 providerLabel 现查显示名')
      .toMatch(/AGG_WIRED_CHANNEL_IDS\.map\(id => providerLabel\(id\)\)/)
  })
})

/**
 * 「按临期」模式的重探定时器（当前间隔 2 分钟，见 `AGG_EXPIRY_REPROBE_MS`）。
 *
 * ## ⚠️ 为什么新增这一组（2026-10-16）
 *
 * 用户追问「第 5 条（重探）怎么测」时核实：**这条此前零用例** ——
 * 全仓库对 `AGG_EXPIRY_REPROBE_MS` 的断言数为 0，因为实现**内联在
 * `AggregatePanel` 的 `useEffect` 里**，而单测环境没有 react（`environment: 'node'`）
 * ⇒ 测试**够不到**它。
 *
 * 而它守的是三条**会真的打上游请求**的行为（一次探测 = 十几个余额 GET）：
 * 切模式要停、页面隐藏要跳过、卸载要清定时器（残留会让请求量 ×N）。
 *
 * ⇒ 把判据抽成纯函数 `shouldReprobeExpiry` / `startExpiryReprobe` 后，
 * 本组用 **vitest 假定时器** 真跑 —— 不需要 react、不需要 DOM、也不真等真实间隔。
 */
describe('★★ 按临期重探定时器（第 5 条判据，此前零覆盖）', () => {
  it('★ 判据①：只有「按临期」模式才重探（切手工即停）', () => {
    expect(shouldReprobeExpiry({ orderMode: 'expiry', hidden: false })).toBe(true)
    expect(shouldReprobeExpiry({ orderMode: 'manual', hidden: false }), '★ 手工模式必须停').toBe(false)
    // ⚠️ 缺省/畸形也**不得**放行（否则报错状态会变成「一直打上游」）。
    expect(shouldReprobeExpiry({ orderMode: undefined, hidden: false })).toBe(false)
    expect(shouldReprobeExpiry(undefined)).toBe(false)
    expect(shouldReprobeExpiry({ orderMode: 'EXPIRY', hidden: false }), '大小写不宽恕').toBe(false)
  })

  it('★ 判据②：页面隐藏时跳过这一轮', () => {
    expect(shouldReprobeExpiry({ orderMode: 'expiry', hidden: true }), '★ 隐藏必须跳过').toBe(false)
    // ⚠️ `hidden` 缺失（非浏览器环境）视为**不隐藏** —— 与内联版
    //    `typeof document !== 'undefined' && document.hidden === true` 同语义。
    expect(shouldReprobeExpiry({ orderMode: 'expiry' })).toBe(true)
    expect(shouldReprobeExpiry({ orderMode: 'expiry', hidden: undefined })).toBe(true)
    // ⚠️ 只有**严格 true** 才算隐藏（恒真值会让「隐藏」判据形同虚设）。
    expect(shouldReprobeExpiry({ orderMode: 'expiry', hidden: 1 as never })).toBe(true)
  })

  it('★★ 判据③：到点**真的**发探测，且间隔就是传入的 intervalMs（假定时器真跑）', () => {
    vi.useFakeTimers()
    try {
      let probes = 0
      const stop = startExpiryReprobe({
        orderMode: 'expiry',
        intervalMs: 30_000,
        isHidden: () => false,
        probe: () => { probes += 1 },
      })
      // ⚠️ 差 1 毫秒不得触发（证明是「到点才发」而不是「挂上就发」）。
      vi.advanceTimersByTime(29_999)
      expect(probes, '未到点不得探测').toBe(0)
      vi.advanceTimersByTime(1)
      expect(probes, '★ 到点必须恰好一次').toBe(1)
      vi.advanceTimersByTime(30_000)
      expect(probes, '★ 第二轮再 +1').toBe(2)
      stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('★★★ 判据④：cleanup **真的**停掉定时器（残留定时器是本条的核心风险）', () => {
    // ⚠️⚠️ 这是本组最重要的一条：真实缺陷形态是「面板反复进出叠加 N 个定时器
    //    ⇒ 上游请求量 ×N，且只在长时间挂着时才看得出来」。
    //    判据必须**先证明它在跑**、再证明**停了之后不再跑** —— 只断言「不调用」
    //    会被「压根没挂上定时器」的变异体蒙混过去（那是恒真的假用例）。
    vi.useFakeTimers()
    try {
      let probes = 0
      const stop = startExpiryReprobe({
        orderMode: 'expiry',
        intervalMs: 30_000,
        isHidden: () => false,
        probe: () => { probes += 1 },
      })
      vi.advanceTimersByTime(30_000)
      expect(probes, '★ 前置：清理前必须确实在轮询（否则下面的断言恒真）').toBe(1)
      stop()
      vi.advanceTimersByTime(300_000) // 再跑 10 轮的时间
      expect(probes, '★★ 清理后绝不能再发探测').toBe(1)
      // ⚠️ 幂等：React 严格模式会重复调用 cleanup，重复 cancel 不得抛错。
      expect(() => stop(), 'cleanup 必须幂等').not.toThrow()
      expect(probes, '重复 cleanup 后仍不得发探测').toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('★★ 判据⑤：非「按临期」模式**根本不挂定时器**（不是挂了再跳过）', () => {
    // ⚠️ 与上面「跳过」区分：手工模式下连 `schedule` 都不该被调用 ——
    //    否则「切手工即停」只是靠回调里 return 实现的，定时器仍在空转。
    vi.useFakeTimers()
    try {
      let schedules = 0
      let probes = 0
      const stop = startExpiryReprobe({
        orderMode: 'manual',
        intervalMs: 30_000,
        isHidden: () => false,
        probe: () => { probes += 1 },
        schedule: (fn, ms) => { schedules += 1; return setInterval(fn, ms) },
      })
      expect(schedules, '★ 手工模式不得挂定时器').toBe(0)
      vi.advanceTimersByTime(300_000)
      expect(probes).toBe(0)
      expect(() => stop()).not.toThrow()
    } finally {
      vi.useRealTimers()
    }
  })

  it('★★ 判据⑥：`isHidden` 必须**每轮现读**（传快照会让「切后台再切回」判错）', () => {
    // ⚠️ 这是把 `isHidden` 设计成**函数**的理由，必须有用例锁住：
    //    若调用方传的是一个布尔快照，隐藏状态变化后判据就永远错了。
    vi.useFakeTimers()
    try {
      let hidden = false
      let probes = 0
      startExpiryReprobe({
        orderMode: 'expiry',
        intervalMs: 30_000,
        isHidden: () => hidden,
        probe: () => { probes += 1 },
      })
      vi.advanceTimersByTime(30_000)
      expect(probes, '第 1 轮：可见 ⇒ 探测').toBe(1)
      hidden = true
      vi.advanceTimersByTime(90_000) // 3 轮，全部隐藏
      expect(probes, '★ 隐藏期间的 3 轮全部跳过（现值生效）').toBe(1)
      hidden = false
      vi.advanceTimersByTime(30_000)
      expect(probes, '★ 恢复可见后立刻恢复轮询').toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('★ 接线守卫：`jet-hub.js` 必须把**真的** setInterval 传下去，且传取值函数', () => {
    // ⚠️ 纯函数对了、接线错了也一样坏（本仓库的经典形态）。三条都要锁：
    //    ① 用 `startExpiryReprobe`（不是退回内联 setInterval）；
    //    ② `isHidden` 是**箭头函数**（传快照会让判据⑥失效）；
    //    ③ 依赖数组含 `orderMode`（切模式要重挂/清理）。
    // ⚠️ 本块**自己读文件**（上面那些 `describe` 的 `panelCode` / `read` / `codeOf`
    //    都是各自块内的局部 const，跨块引用会 `ReferenceError` —— 我第一版就这么错了）。
    const panelText = readFileSync(resolve(here, '../..', 'plugin-src/client/jet-hub.js'), 'utf8')
    const code = panelText
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^[ \t]*\/\/.*$/gm, '')
    const panelStart = code.indexOf('function AggregatePanel(')
    const nextTop = code.indexOf('\nexport function ', panelStart)
    const aggBody = code.slice(panelStart, nextTop > 0 ? nextTop : undefined)
    expect(aggBody, '★ 必须用抽出的纯函数').toContain('startExpiryReprobe({')
    expect(aggBody, '★ isHidden 必须是取值函数').toMatch(/isHidden:\s*\(\)\s*=>/)
    expect(aggBody, '★ effect 依赖必须含 orderMode（切模式要清定时器）')
      .toMatch(/\}\), \[orderMode, onSortByExpiry\]\)/)
    // ⚠️ 反向：不得残留内联的 `setInterval(...AGG_EXPIRY_REPROBE_MS)`（那会叠加两份）。
    expect(aggBody, '★ 不得残留内联定时器').not.toMatch(/setInterval\([\s\S]{0,200}AGG_EXPIRY_REPROBE_MS/)
  })

  it('★★ 重探间隔的**文案**必须与常量一致（防「面板说自己每 N 分钟」而与实际不符）', () => {
    // ⚠️ 这个值 2026-10-16 从 5 分钟改成 2 分钟，而它被**多处文案**复述
    //（工具行两个按钮的 title、面板两段说明、README 表格）。
    //    漏改的症状正是本项目反复处理的「面板没说真话」：界面写着「每 5 分钟」，
    //    实际每 2 分钟打一次上游。
    //    ⇒ 判据：从常量里**读出**真实分钟数，再去核对所有复述它的文案。
    //
    // ⚠️⚠️ **判据必须「全体一致」，不能只判「存在 + 若干黑名单」**
    //（2026-10-16 对抗审计实测的真实守卫缺口）：
    //    原实现是 `stale = ['每 5 分钟','每 10 分钟','每 3 分钟','每 1 分钟']` 的
    //    **硬编码黑名单** + 一条 `toContain(当前值)`。实测把 5 处文案**全改成「每 9 分钟」**
    //    再插入**一句**「每 2 分钟」⇒ 守卫**照样通过**（黑名单不含 9、存在性也被那一句满足）
    //    —— 而真实文案全错。删掉 5 处中的 1 处它也绿（`toContain` 不数个数）。
    //    ⇒ 改为：用 `matchAll(/每\s*\d+\s*分钟/g)` **枚举所有出现**，逐个断言必须等于当前值。
    //    这样任何「改了常量但漏改某处」「文案写成别的分钟数」都会立刻变红。
    const panel = readFileSync(resolve(here, '../..', 'plugin-src/client/jet-hub.js'), 'utf8')
    const m = /const AGG_EXPIRY_REPROBE_MS = (\d+) \* 60 \* 1000/.exec(panel)
    expect(m, '常量必须是 `<N> * 60 * 1000` 形态（否则本条读不出分钟数）').not.toBeNull()
    const minutes = Number(m?.[1])
    expect(Number.isFinite(minutes) && minutes > 0, '分钟数必须为正').toBe(true)
    // ⚠️ 只在 `jet-hub.js` 的**非注释**文本里判：注释里会**讨论**这个值
    //（例如「否则面板会说自己『每 5 分钟』而实际不是）—— 那是留档说明，不是过时文案。
    const panelCodeOnly = panel
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^[ \t]*\/\/.*$/gm, '')
    const readme = readFileSync(resolve(here, '../..', 'README.md'), 'utf8')

    /** 枚举一段文本里所有「每 N 分钟」并逐个核对（返回出现次数）。 */
    const assertAllMention = (text, label) => {
      const found = [...text.matchAll(/每\s*(\d+)\s*分钟/g)].map((x) => x[0])
      for (const hit of found) {
        expect(hit.replace(/\s/g, ''), `★ ${label} 里的「${hit}」必须等于当前间隔（每 ${minutes} 分钟）`)
          .toBe(`每${minutes}分钟`)
      }
      return found.length
    }

    const panelHits = assertAllMention(panelCodeOnly, 'jet-hub.js')
    const readmeHits = assertAllMention(readme, 'README.md')
    // ⚠️ **判据自检**：两处都必须**真的复述**过（否则本条退化成恒真 ——
    //    把文案全删光也会通过）。这也是原实现缺的那半：它只 `toContain` 一次。
    // ⚠️ 阈值按**实测**给（2026-10-16 核实：`jet-hub.js` 2 处 = 工具行按钮的 title
    //    各一句；README 2 处 = 表格一列 + 说明段）。别把它写成「越多越好」——
    //    那会在合理删减文案时假失败；只要 ≥2/≥1 就足以证伪「一句都没有」。
    expect(panelHits, '★ jet-hub.js 必须复述间隔（至少两处：工具行 title 与说明）')
      .toBeGreaterThanOrEqual(2)
    expect(readmeHits, '★ README 必须复述间隔').toBeGreaterThanOrEqual(1)
    // ⚠️ 若将来改成非整分钟（如 90 秒），上面两条自检会因「枚举不到」而主动失败
    //    提醒改判据 —— 那是刻意的：复述文案在那种情况下必须重写成「每 N 秒」。
  })
})

/**
 * ★★ 聚合面板的「启用 / 关闭」开关（2026-11-20 用户要求）：
 * 常驻侧边栏的 Jet Hub 里，聚合面板要能像普通供应商那样直接开关，
 * 不必绕去「设置 → 打开供应商开关」弹窗。
 *
 * ⚠️ `AggregatePanel` 是闭包内组件、未导出，这里沿用本文件的源码切片模式。
 * 判据尽量钉在**会真正影响行为**的三件事上（避免只断言一句文案）：
 *   ① props 解构里必须拿到 `onToggleProvider`（否则点击是空转）；
 *   ② 状态必须走 `providerSwitchState(providerStatuses?.['aggregate'])`
 *      （与普通供应商同源判据，不能自己重写一份）；
 *   ③ 点击里必须真的调 `onToggleProvider('aggregate', !switchState.checked)`。
 */
describe('★★ 聚合面板的启用/关闭开关（行为级接线，2026-11-20）', () => {
  it('AggregatePanel 渲染开关且接线到页面级 provider.setEnabled 动作', async () => {
    const fs = await import('node:fs/promises')
    const path = await import('node:path')
    const dir = fileURLToPath(new URL('.', import.meta.url))
    const source = await fs.readFile(path.resolve(dir, '../../plugin-src/client/jet-hub.js'), 'utf8')
    const start = source.indexOf('function AggregatePanel(')
    expect(start, 'AggregatePanel 必须存在').toBeGreaterThan(0)
    const end = source.indexOf('\nexport function ', start)
    const body = source.slice(start, end > 0 ? end : undefined)
    const code = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

    // ① props 解构含 onToggleProvider（少了它就是点击空转的假开关）。
    expect(code, 'AggregatePanel 必须接收 onToggleProvider（否则开关点了没反应）')
      .toMatch(/function\s+AggregatePanel\s*\(\s*\{[^}]*onToggleProvider/)
    // ② 状态判据与普通供应商同源。
    expect(code, "开关状态必须走 providerSwitchState(providerStatuses?.['aggregate'])")
      .toMatch(/providerSwitchState\(\s*providerStatuses\?\.\[\s*'aggregate'\s*\]\s*\)/)
    // ③ 真的渲染出 role="switch" 的开关。
    expect(code, '必须渲染 role="switch" 的开关').toContain(`role: 'switch'`)
    // ④ 点击真的调 onToggleProvider('aggregate', …)（不是只画个图标）。
    expect(code, "点击必须调 onToggleProvider('aggregate', …)")
      .toMatch(/onToggleProvider\?\.\(\s*'aggregate'\s*,/)

    // ⑤ **调用点必须真的把 onToggleProvider 传进来**（否则组件内再正确也是空转）。
    //    ⚠️ 判据必须落在整份源码里的 `React.createElement(AggregatePanel, { … })`
    //    实参上，而不是组件体（组件体那道守卫看不出调用点漏传 —— 实测漏传后它仍绿）。
    const callStart = source.indexOf('React.createElement(AggregatePanel,')
    expect(callStart, '必须存在 AggregatePanel 的调用点').toBeGreaterThan(0)
    const callEnd = source.indexOf('})', callStart)
    const callArgs = source.slice(callStart, callEnd > 0 ? callEnd : undefined)
    expect(callArgs, 'AggregatePanel 调用点必须传 onToggleProvider（否则开关点了没反应）')
      .toMatch(/onToggleProvider\s*:/)
    expect(callArgs, 'AggregatePanel 调用点必须传 providerStatuses（否则开关读数永远是默认）')
      .toMatch(/providerStatuses\s*[,:]/)
  })
})
