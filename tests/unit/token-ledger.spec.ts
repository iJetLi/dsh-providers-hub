import { describe, expect, it } from 'vitest'
import {
  MIN_DECODE_MS_FOR_TPS,
  TOKEN_LEDGER_ENTRY_LIMIT,
  TOKEN_LEDGER_LIMIT,
  attachTokenLedgerStore,
  deleteTokenLedgerDay,
  isValidTokenLedgerDayKey,
  mergeDayEntry,
  parseDayBucketKey,
  peekLedgerAccount,
  readTokenLedger,
  readTokenLedgerDayMap,
  readTokenLedgerHistory,
  recordTokenUsage,
  reportLedgerAccount,
  resetLedgerAccountsForTests,
  resetTokenLedgerForTests,
  tokenLedgerSize,
  utc8DayKey,
  type TokenLedgerDayMap,
} from '../../src/token-ledger.js'

/** 每条用例前清空：模块级可变状态会在用例间泄漏（cline-request-log 同款）。 */
function seed(entries: Array<Parameters<typeof recordTokenUsage>[0]>): void {
  resetTokenLedgerForTests()
  for (const entry of entries) recordTokenUsage(entry)
}

const OK = {
  channel: 'direct' as const,
  provider: 'codearts',
  model: 'GLM-5.2',
  usageReported: true,
  inputTokens: 100,
  outputTokens: 50,
  durationMs: 1200,
}

describe('recordTokenUsage / readTokenLedger：明细', () => {
  it('记录后按「最新在前」读出，快照含全局小计', () => {
    seed([OK, { ...OK, provider: 'qoder', model: 'qfmodel' }])
    const snap = readTokenLedger()
    expect(snap.entries).toHaveLength(2)
    expect(snap.entries[0]!.provider).toBe('qoder')
    expect(snap.totals.requests).toBe(2)
    expect(snap.totals.inputTokens).toBe(200)
    expect(snap.totals.outputTokens).toBe(100)
  })

  it('channel 只认 direct/gateway，垃圾值保守落 direct', () => {
    // ⚠️ 记录是「最新在前」：后记的 bogus/undefined 排在前面（与 unshift 同序）。
    seed([{ ...OK, channel: 'bogus' as never }, { ...OK, channel: undefined as never }, { ...OK, channel: 'gateway' }])
    const channels = readTokenLedger().entries.map((e) => e.channel)
    expect(channels).toEqual(['gateway', 'direct', 'direct'])
  })

  it('usageReported 只认严格 true（垃圾值一律当「没收到 usage」）', () => {
    for (const value of [1, 'true', 'yes', {}, []] as unknown[]) {
      seed([{ ...OK, usageReported: value as boolean }])
      expect(readTokenLedger().entries[0]!.usageReported, String(value)).toBe(false)
    }
  })

  it('缓存写入/思考为 0 或缺失时省略；缓存读取的 0 必须保留（PR #122 三态）', () => {
    seed([{ ...OK, cacheReadTokens: 1_200, reasoningTokens: 33, cacheWriteTokens: 7 }])
    const row = readTokenLedger().entries[0]!
    expect(row.cacheReadTokens).toBe(1200)
    expect(row.reasoningTokens).toBe(33)
    expect(row.cacheWriteTokens).toBe(7)
    seed([OK])
    const bare = readTokenLedger().entries[0]!
    expect(Object.hasOwn(bare, 'cacheReadTokens')).toBe(false)
    expect(bare.cacheWriteTokens).toBeUndefined()
    expect(bare.reasoningTokens).toBeUndefined()
    // ★ 明确上报的 0 ≠ 未上报：落盘必须保留 0，否则网关对外的「命中 0%」
    // 与本地面板的「渠道不给这个数」对不上（PR #122 P2①）。
    seed([{ ...OK, cacheReadTokens: 0 }])
    const zero = readTokenLedger().entries[0]!
    expect(Object.hasOwn(zero, 'cacheReadTokens'), '明确 0 必须原样落盘，不能当「没上报」省略').toBe(true)
    expect(zero.cacheReadTokens).toBe(0)
  })

  it('负数 / NaN / 小数统一钳制成非负整数', () => {
    seed([{ ...OK, inputTokens: -5, outputTokens: Number.NaN, durationMs: 12.9 }])
    const row = readTokenLedger().entries[0]!
    expect(row.inputTokens).toBe(0)
    expect(row.outputTokens).toBe(0)
    expect(row.durationMs).toBe(12)
  })

  it('error 截断到 200 字；成功行无 error 字段', () => {
    seed([OK, { ...OK, error: 'x'.repeat(500) }])
    const rows = readTokenLedger().entries
    expect(rows[0]!.error).toHaveLength(200)
    expect(rows[1]!.error).toBeUndefined()
  })

  /**
   * ★★★ **汇总无上限 / 明细有界 / 内存不增长**（2026-11-20 用户最终需求）。
   *
   * 用户原话（纠正第一版）：
   * > 「我现在的需求只是统计后的结果保留无限制，没必要每个请求都保留详情
   * >  无限制呀，500 条上限后，采用结果量就行，基本无内存上涨的呀」
   *
   * ⇒ 汇总走**增量聚合**（行数与请求数无关），明细走**500 条封顶数组**。
   * 下面几条同时钉住「汇总对」「明细对」「内存不涨」三件事。
   */
  it('★★★ 汇总无上限：写满 500 次后，汇总仍统计**全部**请求', () => {
    resetTokenLedgerForTests()
    const total = TOKEN_LEDGER_ENTRY_LIMIT + 50
    for (let i = 0; i < total; i++) {
      recordTokenUsage({ ...OK, outputTokens: i })
    }
    const snap = readTokenLedger()
    // ★ 核心：汇总必须覆盖全部请求
    expect(snap.totals.requests, '汇总必须统计全部请求（旧缺陷时是 500）').toBe(total)
    // outputTokens 是 0..total-1 的等差数列，求和可校验
    expect(snap.totals.outputTokens).toBe(((total - 1) * total) / 2)
    /**
     * ★★★ **渠道维度也必须是全量**（变异 M3 实测无牙后补）。
     *
     * 上面的断言只看了 `snap.totals`（来自 `aggregateTotals`）；
     * 而 `snap.channels` 是**另一个来源**（聚合树）。把读取改回
     * 「遍历 ledger 重建」时，`totals` 仍然对（独立累加器），
     * 只有 `channels` 会退化成 500 —— 之前的用例正好漏了这一半。
     */
    const chReq = snap.channels.reduce((s, c) => s + c.totals.requests, 0)
    expect(chReq, '各渠道之和也必须是全量（不能只看 totals）').toBe(total)
    expect(snap.channels[0]!.totals.requests, '渠道行本身也必须是全量').toBe(total)
  })

  it('★★★ 明细有界：`ledger` 数组仍封顶 TOKEN_LEDGER_ENTRY_LIMIT（内存恒定）', () => {
    resetTokenLedgerForTests()
    const total = TOKEN_LEDGER_ENTRY_LIMIT + 50
    for (let i = 0; i < total; i++) {
      recordTokenUsage({ ...OK, outputTokens: i })
    }
    // ★ 内存有界的关键：数组条数不得随请求数增长
    expect(tokenLedgerSize(), 'ledger 必须被截断（内存恒定）').toBe(TOKEN_LEDGER_ENTRY_LIMIT)
    const entries = readTokenLedger().entries
    expect(entries).toHaveLength(TOKEN_LEDGER_ENTRY_LIMIT)
    // 最新在前：最前是最后写入的那条
    expect(entries[0]!.outputTokens).toBe(total - 1)
    // 最旧的那 50 条不在明细里（但仍在汇总里，见上一条）
    expect(entries.at(-1)!.outputTokens).toBe(50)
  })

  it('★★ 明细与汇总的范围不同（不得用 entries 反推 totals）', () => {
    resetTokenLedgerForTests()
    const total = TOKEN_LEDGER_ENTRY_LIMIT + 200
    for (let i = 0; i < total; i++) {
      recordTokenUsage({ ...OK, outputTokens: 1 })
    }
    const snap = readTokenLedger()
    const entrySum = snap.entries.reduce((s, e) => s + e.outputTokens, 0)
    expect(snap.totals.outputTokens, '汇总应覆盖全部').toBe(total)
    expect(entrySum, '明细求和只有最近 500 条').toBe(TOKEN_LEDGER_ENTRY_LIMIT)
    expect(snap.totals.outputTokens).toBeGreaterThan(entrySum)
  })

  it('★ limit 参数只影响明细，不影响汇总', () => {
    resetTokenLedgerForTests()
    for (let i = 0; i < 20; i++) recordTokenUsage({ ...OK, outputTokens: 10 })
    const snap = readTokenLedger({ limit: 5 })
    expect(snap.entries).toHaveLength(5)
    expect(snap.totals.requests, 'limit 不得影响汇总').toBe(20)
  })

  /**
   * ★★★ **守恒守卫**：聚合树与全局小计必须与写入次数严格一致。
   *
   * 这是「增量双写」唯一的风险点 —— 若某条路径 update 了 ledger 但没 update
   * 聚合（或反之），两边就漂移，且**不会有任何报错**。
   */
  it('★★★ 守恒：渠道汇总之和 == 全局小计（增量累加不得漂移）', () => {
    resetTokenLedgerForTests()
    // 混合渠道/provider/账号/模型，覆盖所有维度
    for (let i = 0; i < 30; i++) {
      recordTokenUsage({
        ...OK,
        channel: i % 2 === 0 ? 'direct' : 'gateway',
        provider: i % 3 === 0 ? 'buddy' : 'workbuddy',
        accountId: i % 4 === 0 ? undefined : `acct-${i % 3}`,
        model: i % 5 === 0 ? 'model-a' : 'model-b',
        inputTokens: 10,
        outputTokens: 5,
      })
    }
    const snap = readTokenLedger()
    const chReq = snap.channels.reduce((s, c) => s + c.totals.requests, 0)
    const chIn = snap.channels.reduce((s, c) => s + c.totals.inputTokens, 0)
    const chOut = snap.channels.reduce((s, c) => s + c.totals.outputTokens, 0)
    expect(chReq, '各渠道请求数之和必须等于全局').toBe(snap.totals.requests)
    expect(chIn).toBe(snap.totals.inputTokens)
    expect(chOut).toBe(snap.totals.outputTokens)
    expect(snap.totals.requests).toBe(30)
    expect(snap.totals.inputTokens).toBe(300)
    expect(snap.totals.outputTokens).toBe(150)
  })

  it('★★ 清空后聚合与小计同时归零（不得留幽灵数据）', () => {
    resetTokenLedgerForTests()
    for (let i = 0; i < 10; i++) recordTokenUsage({ ...OK, outputTokens: 7 })
    expect(readTokenLedger().totals.requests).toBe(10)
    resetTokenLedgerForTests()
    const snap = readTokenLedger()
    expect(snap.totals.requests, 'reset 必须同时清聚合树').toBe(0)
    expect(snap.channels, 'reset 必须同时清聚合树').toHaveLength(0)
    expect(snap.entries).toHaveLength(0)
  })

  it('★★★ 明细写入不被聚合路径吞掉（两个结构都要更新）', () => {
    resetTokenLedgerForTests()
    recordTokenUsage({ ...OK, outputTokens: 42 })
    const snap = readTokenLedger()
    // 两边都要有这条
    expect(snap.entries, '明细必须有').toHaveLength(1)
    expect(snap.entries[0]!.outputTokens).toBe(42)
    expect(snap.totals.requests, '汇总必须有').toBe(1)
    expect(snap.totals.outputTokens).toBe(42)
    // 且聚合树里也能查到
    expect(snap.channels[0]!.totals.requests).toBe(1)
  })

  it('record 绝不抛错：垃圾入参（null/undefined/异常对象）安静落账', () => {
    resetTokenLedgerForTests()
    expect(() => recordTokenUsage(null as never)).not.toThrow()
    expect(() => recordTokenUsage(undefined as never)).not.toThrow()
    const hostile: Record<string, unknown> = {}
    Object.defineProperty(hostile, 'provider', { get() { throw new Error('boom') } })
    expect(() => recordTokenUsage(hostile as never)).not.toThrow()
  })

  /** ⚠️ 第 3 期：首字用时 + TPS（官方口径）的计算与「不可测省略」约定。 */
  it('ttft/tps：正常请求记录两者，tps = 输出 ÷ (全程 − 首块)', () => {
    seed([{ ...OK, ttftMs: 2000, durationMs: 7000, outputTokens: 500 }])
    const row = readTokenLedger().entries[0]!
    expect(row.ttftMs).toBe(2000)
    // 500 tok / 5s = 100 tok/s
    expect(row.tps).toBe(100)
  })

  it('ttft/tps：前提缺失（无首块 / 分母 ≤ 0 / 无 usage）省略字段（不可测 ≠ 0）', () => {
    // 无首块（失败 / 秒回空）
    seed([{ ...OK, ttftMs: 0 }])
    let row = readTokenLedger().entries[0]!
    expect(row.ttftMs).toBeUndefined()
    expect(row.tps).toBeUndefined()
    // 首块之后没有时间（一次性返回）
    seed([{ ...OK, ttftMs: 1000, durationMs: 1000, outputTokens: 500 }])
    row = readTokenLedger().entries[0]!
    expect(row.tps).toBeUndefined()
    // 无 usage（输出 token 不可信）
    seed([{ ...OK, ttftMs: 1000, durationMs: 3000, usageReported: false }])
    row = readTokenLedger().entries[0]!
    expect(row.tps).toBeUndefined()
  })

  /**
   * ⚠️ **分母塌缩**必须挡在源头（真实缺陷，用户 2026-10-07 报障「982.5 tok/s」）。
   *
   * 症状：lobsterai 的 `avgTps` 显示 982.5，而真实值在 50~200 量级。
   * 根因：原判据只要求 `decodeMs > 0`，于是「首块与结束几乎贴在一起」的样本
   * （空回复 / 纯 usage 帧 / 上游秒回 200 但正文为空 / 被 cancel）算出
   * 1269 ÷ 0.001s = **126 万 tok/s**；单笔这样的样本就能把该渠道均值从
   * ~180 拉到 **634592**（本套件外已实测复现）。
   *
   * ⚠️ 修法是**丢弃该样本**而不是钳制分母：把 decodeMs 抬到下限只是把离谱值
   * 换成另一个离谱值（仍是假数据，且看起来「有值」无从分辨）。
   */
  describe('⚠️ TPS 分母塌缩的防御（decodeMs 下限）', () => {
    it('decodeMs 为个位数毫秒时不可测（省略 tps），不产出几十万 tok/s 的假值', () => {
      // 首块后仅 1ms 就结束：1269 ÷ 0.001s = 1,269,000 tok/s —— 荒谬。
      seed([{ ...OK, ttftMs: 2109, durationMs: 2110, outputTokens: 1269 }])
      const row = readTokenLedger().entries[0]!
      expect(row.tps).toBeUndefined()
      // ⚠️ ttft **仍要保留**：它不受此门槛影响（首字用时是可测的）。
      expect(row.ttftMs).toBe(2109)
    })

    it('★ 单笔塌缩样本不得拉爆均值（实测 634592 → 183.9）', () => {
      seed([
        // 塌缩样本：应被丢弃
        { ...OK, ttftMs: 2109, durationMs: 2110, outputTokens: 1269 },
        // 正常样本：1269 ÷ 6.9s = 183.9
        { ...OK, ttftMs: 2100, durationMs: 9000, outputTokens: 1269 },
      ])
      const totals = readTokenLedger().channels[0]!.providers[0]!.totals
      expect(totals.avgTps).toBe(183.9)
      // ⚠️ 门槛是**只挡 tps**：ttft 两笔都参与（(2109+2100)/2 = 2105 向上取整）。
      expect(totals.avgTtftMs).toBe(2105)
    })

    it('门槛边界：恰好达到 MIN_DECODE_MS_FOR_TPS 可测，差 1ms 不可测', () => {
      // duration - ttft = 100（门槛）⇒ 可测：500 ÷ 0.1s = 5000 tok/s
      seed([{ ...OK, ttftMs: 1000, durationMs: 1000 + MIN_DECODE_MS_FOR_TPS, outputTokens: 500 }])
      expect(readTokenLedger().entries[0]!.tps).toBe(5000)
      // 差 1ms（99ms）⇒ 不可测
      seed([{ ...OK, ttftMs: 1000, durationMs: 1000 + MIN_DECODE_MS_FOR_TPS - 1, outputTokens: 500 }])
      expect(readTokenLedger().entries[0]!.tps).toBeUndefined()
    })

    it('门槛不会误伤真实样本：100~100ms 解码的正常慢流仍可测', () => {
      // 门槛取 100ms 而非更大值，是为了只挡「首块与结束贴在一起」的塌缩，
      // 而**不是**排除一切短输出。100ms 解码 100 token = 1000 tok/s。
      seed([{ ...OK, ttftMs: 500, durationMs: 600, outputTokens: 100 }])
      expect(readTokenLedger().entries[0]!.tps).toBe(1000)
    })
  })

  it('聚合均值：只对有实测值的请求平均；父级 = 全部样本的 Σ/份数（不是均值的均值）', () => {
    // model fast：4 笔 100ms / model slow：1 笔 500ms —— 同 provider
    seed([
      { ...OK, model: 'fast', ttftMs: 100, durationMs: 1100, outputTokens: 100 },
      { ...OK, model: 'fast', ttftMs: 100, durationMs: 1100, outputTokens: 100 },
      { ...OK, model: 'fast', ttftMs: 100, durationMs: 1100, outputTokens: 100 },
      { ...OK, model: 'fast', ttftMs: 100, durationMs: 1100, outputTokens: 100 },
      { ...OK, model: 'slow', ttftMs: 500, durationMs: 1500, outputTokens: 500 },
    ])
    const direct = readTokenLedger().channels[0]!
    const totals = direct.providers[0]!.totals
    // 全局/渠道/provider 小计的均值必须按 **5 笔样本**算：(4×100+500)/5 = 180，
    // 若按「子级均值再平均」会得 (100+500)/2 = 300 —— 那是错的。
    expect(totals.avgTtftMs).toBe(180)
    // tps：fast 4 笔各 100 tok/1s = 100 tok/s；slow 1 笔 500 tok/1s = 500 tok/s
    // ⇒ (4×100+500)/5 = 180
    expect(totals.avgTps).toBe(180)
    const fast = direct.providers[0]!.accounts[0]!.models.find((m) => m.model === 'fast')!
    expect(fast.avgTtftMs).toBe(100)
    expect(fast.avgTps).toBe(100)
    const slow = direct.providers[0]!.accounts[0]!.models.find((m) => m.model === 'slow')!
    expect(slow.avgTtftMs).toBe(500)
    expect(slow.avgTps).toBe(500)
  })

  it('聚合均值：全部不可测时省略字段（不显示 0）', () => {
    seed([{ ...OK, ttftMs: 0, usageReported: false, error: 'boom' }])
    const totals = readTokenLedger().channels[0]!.providers[0]!.totals
    expect(totals.avgTtftMs).toBeUndefined()
    expect(totals.avgTps).toBeUndefined()
  })
})

describe('readTokenLedger：三维聚合树', () => {
  it('渠道 → provider → 账号 → 模型 逐级分桶，各级小计 = 子级之和', () => {
    seed([
      { ...OK, model: 'GLM-5.2', inputTokens: 100, outputTokens: 10 },
      { ...OK, model: 'deepseek-v4.1-flash', inputTokens: 200, outputTokens: 20 },
      { ...OK, provider: 'qoder', model: 'GLM-5.2', inputTokens: 300, outputTokens: 30 },
      { ...OK, channel: 'gateway', provider: 'qoder', inputTokens: 400, outputTokens: 40 },
    ])
    const snap = readTokenLedger()
    expect(snap.channels).toHaveLength(2)
    // 渠道排序：direct 在前
    const direct = snap.channels[0]!
    expect(direct.channel).toBe('direct')
    expect(direct.providers).toHaveLength(2)
    const codearts = direct.providers.find((p) => p.provider === 'codearts')!
    // 未回报账号的记录落「未归属」桶（accountId '-'），该桶下 2 个模型
    expect(codearts.accounts).toHaveLength(1)
    expect(codearts.accounts[0]!.accountId).toBe('-')
    expect(codearts.accounts[0]!.models).toHaveLength(2)
    expect(codearts.totals.inputTokens).toBe(300)
    expect(codearts.totals.outputTokens).toBe(30)
    // direct 渠道小计 = codearts(300) + qoder 直连那条(300) = 600
    expect(direct.totals.inputTokens).toBe(600)
    expect(direct.totals.outputTokens).toBe(60)
    const gateway = snap.channels.find((c) => c.channel === 'gateway')!
    expect(gateway.providers[0]!.provider).toBe('qoder')
    expect(gateway.totals.inputTokens).toBe(400)
    // 全局小计 = 两条渠道之和（direct 600 + gateway 400 = 1000）
    expect(snap.totals.inputTokens).toBe(1000)
    expect(snap.totals.outputTokens).toBe(100)
  })

  it('账号维度（第 2 期）：accountId 落各自账号桶，空/缺失归「未归属」', () => {
    seed([
      { ...OK, accountId: 'acct-A', model: 'GLM-5.2', inputTokens: 100, outputTokens: 10 },
      { ...OK, accountId: 'acct-A', model: 'GLM-5.2', inputTokens: 100, outputTokens: 10 },
      { ...OK, accountId: 'acct-B', model: 'GLM-5.2', inputTokens: 500, outputTokens: 50 },
      { ...OK, model: 'GLM-5.2', inputTokens: 7, outputTokens: 7 },
    ])
    const codearts = readTokenLedger().channels[0]!.providers[0]!
    // acct-A / acct-B / 未归属 三桶
    expect(codearts.accounts.map((a) => a.accountId)).toEqual(['acct-B', 'acct-A', '-'])
    const a = codearts.accounts.find((x) => x.accountId === 'acct-A')!
    expect(a.totals.inputTokens).toBe(200)
    expect(a.totals.requests).toBe(2)
    const orphan = codearts.accounts.find((x) => x.accountId === '-')!
    expect(orphan.totals.inputTokens).toBe(7)
    // provider 小计 = 三桶之和
    expect(codearts.totals.inputTokens).toBe(707)
  })

  it('排序：provider 与模型都按 token 合计降序（谁烧得多谁在前）', () => {
    // ⚠️ 各 provider 用**同一个模型名**（z），避免 codearts 与 aaa/bbb/ccc 跨桶混淆。
    // 同理 codearts 的两条是**不同模型**（m-small / m-big），不会并成一行。
    seed([
      { ...OK, provider: 'aaa', model: 'z', inputTokens: 10, outputTokens: 1 },
      { ...OK, provider: 'bbb', model: 'z', inputTokens: 900, outputTokens: 2 },
      { ...OK, provider: 'ccc', model: 'z', inputTokens: 500, outputTokens: 3 },
      { ...OK, model: 'm-small', inputTokens: 1, outputTokens: 1 },
      { ...OK, model: 'm-big', inputTokens: 777, outputTokens: 1 },
    ])
    const direct = readTokenLedger().channels[0]!
    // aaa=11 / bbb=902 / ccc=503 / codearts=778（m-big）+2（m-small）
    expect(direct.providers.map((p) => p.provider)).toEqual(['bbb', 'codearts', 'ccc', 'aaa'])
    const codearts = direct.providers.find((p) => p.provider === 'codearts')!
    // 单账号（都未归属）→ 全落「未归属」桶，模型行在里面
    expect(codearts.accounts).toHaveLength(1)
    expect(codearts.accounts[0]!.models.map((m) => m.model)).toEqual(['m-big', 'm-small'])
  })

  it('失败行/未报行计入请求数与 errors，但不污染 token 汇总', () => {
    seed([
      OK,
      { ...OK, usageReported: false, inputTokens: 999, outputTokens: 999, error: 'upstream broke' },
    ])
    const snap = readTokenLedger()
    expect(snap.totals.requests).toBe(2)
    expect(snap.totals.errors).toBe(1)
    expect(snap.totals.reportedRequests).toBe(1)
    // 未报行的 999 不得混进汇总
    expect(snap.totals.inputTokens).toBe(100)
    expect(snap.totals.outputTokens).toBe(50)
  })

  it('限流/缓存字段在树中正确累加（cache/reasoning 求和）', () => {
    seed([
      { ...OK, cacheReadTokens: 100, reasoningTokens: 5, cacheWriteTokens: 2 },
      { ...OK, cacheReadTokens: 50, reasoningTokens: 7 },
    ])
    const direct = readTokenLedger().channels[0]!
    expect(direct.totals.cacheReadTokens).toBe(150)
    expect(direct.totals.reasoningTokens).toBe(12)
    expect(direct.totals.cacheWriteTokens).toBe(2)
  })

  it('空账本：空树 + 零小计 + 空明细（不抛错）', () => {
    resetTokenLedgerForTests()
    const snap = readTokenLedger()
    expect(snap.channels).toEqual([])
    expect(snap.entries).toEqual([])
    expect(snap.totals.requests).toBe(0)
  })

  it('limit 只截明细，不截聚合树', () => {
    seed([OK, { ...OK, provider: 'b' }, { ...OK, provider: 'c' }])
    const snap = readTokenLedger({ limit: 1 })
    expect(snap.entries).toHaveLength(1)
    expect(snap.totals.requests).toBe(3)
    expect(snap.channels[0]!.totals.requests).toBe(3)
  })
})

describe('reportLedgerAccount / peekLedgerAccount（第 2 期 · 账号回报侧信道）', () => {
  it('回报后可读取；最后回报者胜（「最近一次解析」口径）', () => {
    resetLedgerAccountsForTests()
    reportLedgerAccount('qoder', 'acct-A')
    expect(peekLedgerAccount('qoder')).toBe('acct-A')
    reportLedgerAccount('qoder', 'acct-B')
    expect(peekLedgerAccount('qoder')).toBe('acct-B')
    // 不同 provider 互不影响
    reportLedgerAccount('cline', 'acct-C')
    expect(peekLedgerAccount('cline')).toBe('acct-C')
    expect(peekLedgerAccount('qoder')).toBe('acct-B')
  })

  it('垃圾入参不抛错、不覆盖旧值', () => {
    resetLedgerAccountsForTests()
    reportLedgerAccount('p', 'keep-me')
    expect(() => reportLedgerAccount('', 'x')).not.toThrow()
    expect(() => reportLedgerAccount('p', '')).not.toThrow()
    expect(() => reportLedgerAccount(undefined as never, 'x')).not.toThrow()
    expect(peekLedgerAccount('p')).toBe('keep-me')
    expect(peekLedgerAccount('')).toBe('')
    expect(peekLedgerAccount('never-reported')).toBe('')
  })
})

describe('utc8DayKey / mergeDayEntry（第 2 期 · 日聚合）', () => {
  it('UTC+8 日界：跨日时刻归入正确的日键', () => {
    // UTC 2026-10-05 16:30 = UTC+8 2026-10-06 00:30 ⇒ 归 10-06
    expect(utc8DayKey(Date.UTC(2026, 9, 5, 16, 30, 0))).toBe('2026-10-06')
    // UTC 2026-10-05 15:59 = UTC+8 2026-10-05 23:59 ⇒ 归 10-05
    expect(utc8DayKey(Date.UTC(2026, 9, 5, 15, 59, 0))).toBe('2026-10-05')
  })

  it('mergeDayEntry：同桶累加，未报行不进 token 数', () => {
    const days: TokenLedgerDayMap = new Map()
    const base = { ts: Date.UTC(2026, 9, 5, 2, 0, 0), channel: 'direct' as const, provider: 'p', model: 'm', usageReported: true, inputTokens: 10, outputTokens: 5, durationMs: 100 }
    mergeDayEntry(days, base)
    mergeDayEntry(days, { ...base, inputTokens: 20 })
    mergeDayEntry(days, { ...base, usageReported: false, error: 'boom' })
    const buckets = days.get('2026-10-05')!
    expect(buckets.size).toBe(1)
    const bucket = buckets.get('direct|p||m')!
    expect(bucket.requests).toBe(3)
    expect(bucket.reportedRequests).toBe(2)
    expect(bucket.errors).toBe(1)
    expect(bucket.inputTokens).toBe(30)
    expect(bucket.outputTokens).toBe(10)
  })

  it('mergeDayEntry：不同账号/渠道/日各自成桶', () => {
    const days: TokenLedgerDayMap = new Map()
    const base = { ts: Date.UTC(2026, 9, 5, 2, 0, 0), channel: 'direct' as const, provider: 'p', model: 'm', usageReported: true, inputTokens: 1, outputTokens: 1, durationMs: 100 }
    mergeDayEntry(days, base)
    mergeDayEntry(days, { ...base, accountId: 'a1' })
    mergeDayEntry(days, { ...base, accountId: 'a2' })
    mergeDayEntry(days, { ...base, channel: 'gateway' })
    mergeDayEntry(days, { ...base, ts: Date.UTC(2026, 9, 6, 2, 0, 0) })
    expect(days.get('2026-10-05')!.size).toBe(4)
    expect(days.get('2026-10-06')!.size).toBe(1)
  })

  it('persist 后端：recordTokenUsage 把记录交给 append（含正确日键由后端自算），失败不反噬', () => {
    const seen: string[] = []
    const detach = attachTokenLedgerStore({
      append: (entry) => { seen.push(entry.provider) },
      load: () => new Map(),
    })
    try {
      seed([OK])
      expect(seen).toEqual(['codearts'])
    } finally {
      detach()
    }
    // 摘钩子后不再触发
    seed([{ ...OK }])
    expect(seen).toEqual(['codearts'])
  })

  it('persist 后端抛错时 recordTokenUsage 仍不抛（推理路径零反噬）', () => {
    const detach = attachTokenLedgerStore({
      append: () => { throw new Error('disk full') },
      load: () => new Map(),
    })
    try {
      expect(() => recordTokenUsage(OK)).not.toThrow()
    } finally {
      detach()
    }
    expect(tokenLedgerSize()).toBeGreaterThanOrEqual(1)
  })

  it('删除历史日只改日聚合，不删除内存实时明细；拒绝非法日期键', () => {
    seed([OK])
    const dayMap: TokenLedgerDayMap = new Map()
    mergeDayEntry(dayMap, { ...OK, ts: Date.UTC(2026, 9, 5, 2, 0, 0) })
    const detach = attachTokenLedgerStore({
      append: () => {},
      load: () => dayMap,
      deleteDay: (day) => dayMap.delete(day),
    })
    try {
      const before = readTokenLedger()
      expect(isValidTokenLedgerDayKey('2026-10-05')).toBe(true)
      expect(isValidTokenLedgerDayKey('2026-02-30')).toBe(false)
      expect(deleteTokenLedgerDay('../state.json')).toBe(false)
      expect(deleteTokenLedgerDay('2026-10-05')).toBe(true)

      const after = readTokenLedger()
      expect(readTokenLedgerDayMap().has('2026-10-05')).toBe(false)
      expect(after.entries).toEqual(before.entries)
      expect(after.totals).toEqual(before.totals)
    } finally {
      detach()
    }
  })

  /**
   * ⚠️ **写出去的桶键必须是读得回来的键**（红队复审发现，实测复现）。
   *
   * 写入侧 `mergeDayEntry` 原先直接用 `entry.channel` 拼键，而读取侧唯一判据
   * `parseDayBucketKey` 只接受 `direct` / `gateway`。调用方传非法 channel 时会
   * **写出一份自己读不回的桶** —— 落盘后重启该日直接消失（静默数据丢失）。
   * 生产路径经 `recordTokenUsage` 已归一，但 `store.append` 是公开接口。
   */
  it('★ 非法 channel 必须被归一，不得写出读不回的桶键', () => {
    const days: TokenLedgerDayMap = new Map()
    // 故意传非法 channel（类型层面是联合类型，运行时仍可能被 JS 调用方传进来）
    mergeDayEntry(days, { ...OK, channel: 'foo' as never, ts: Date.UTC(2026, 9, 5, 2, 0, 0) })
    const keys = [...days.get('2026-10-05')!.keys()]
    expect(keys, '非法 channel 不得原样进入桶键').toEqual(['direct|codearts||GLM-5.2'])
    // ★ 关键：同一个键必须能被读取侧接受（否则落盘后重启读不回）
    expect(parseDayBucketKey(keys[0]!), '写出的键必须能被读取侧解析').toBeDefined()
  })
})

describe('readTokenLedgerHistory（第 4 期 · 历史视图）', () => {
  /** 用真实记账路径造日聚合表（与落盘数据同源）。 */
  function makeDays(entries: Array<Parameters<typeof recordTokenUsage>[0]>): TokenLedgerDayMap {
    const days: TokenLedgerDayMap = new Map()
    for (const e of entries) mergeDayEntry(days, e)
    return days
  }
  const DAY1 = Date.UTC(2026, 9, 4, 2, 0, 0) // UTC+8 2026-10-04 10:00
  const DAY2 = Date.UTC(2026, 9, 5, 2, 0, 0) // UTC+8 2026-10-05 10:00

  it('日聚合 → 聚合树：结构与内存快照同形，各级小计 = 子级之和', () => {
    const days = makeDays([
      { ...OK, ts: DAY1, inputTokens: 100, outputTokens: 10 },
      { ...OK, ts: DAY1, channel: 'gateway', provider: 'qoder', inputTokens: 50, outputTokens: 5 },
    ])
    const { days: history, totals } = readTokenLedgerHistory(days)
    expect(history).toHaveLength(1)
    const day1 = history[0]!
    expect(day1.day).toBe('2026-10-04')
    expect(day1.channels).toHaveLength(2)
    const direct = day1.channels[0]!
    expect(direct.totals.inputTokens).toBe(100)
    expect(direct.totals.outputTokens).toBe(10)
    // 窗口合计 = 全部日之和
    expect(totals.inputTokens).toBe(150)
    expect(totals.requests).toBe(2)
  })

  it('均值：历史小计按全部样本 Σ/份数（跨日不「均值的均值」）', () => {
    const days = makeDays([
      { ...OK, ts: DAY1, ttftMs: 100, durationMs: 1100, outputTokens: 100 },
      { ...OK, ts: DAY2, ttftMs: 300, durationMs: 1300, outputTokens: 100 },
    ])
    const { totals } = readTokenLedgerHistory(days)
    // (100+300)/2 = 200
    expect(totals.avgTtftMs).toBe(200)
  })

  /**
   * ⚠️ **不得写死日期**（真实缺陷，复审发现）：原用例把「今天」硬编码成
   * `2026-10-05`，一旦真实时间越过该日（UTC+8 日界），`sinceDays: 1` 的期望
   * 就与实际不符 —— 用例会在**没人改代码的情况下**自行变红（时间炸弹）。
   * 故一律按「相对今天」构造时刻。
   */
  const dayStartAgo = (daysAgo: number): number => {
    // 取 UTC+8 的今天零点，再往前推 N 天（用算术，不依赖本机时区）。
    const nowShifted = new Date(Date.now() + 8 * 60 * 60 * 1000)
    const todayUtcMidnight = Date.UTC(
      nowShifted.getUTCFullYear(), nowShifted.getUTCMonth(), nowShifted.getUTCDate(),
    )
    return todayUtcMidnight - 8 * 60 * 60 * 1000 - daysAgo * 24 * 60 * 60 * 1000 + 2 * 60 * 60 * 1000
  }
  const todayKey = utc8DayKey(Date.now())
  const yesterdayKey = utc8DayKey(dayStartAgo(1))

  it('sinceDays 窗口：只含最近 N 天（含今天）；未来日键恒被裁掉', () => {
    const days = makeDays([
      { ...OK, ts: dayStartAgo(-7) }, // 未来（7 天后）
      { ...OK, ts: dayStartAgo(1) }, // 昨天
      { ...OK, ts: dayStartAgo(0) }, // 今天
    ])
    // 全部历史：未来键被裁 ⇒ 只剩昨天与今天（新在前）
    const all = readTokenLedgerHistory(days)
    expect(all.days.map((d) => d.day)).toEqual([todayKey, yesterdayKey])
    // 近 7 天：两天都在窗口内
    const week = readTokenLedgerHistory(days, { sinceDays: 7 })
    expect(week.days.map((d) => d.day)).toEqual([todayKey, yesterdayKey])
    // 窗口裁掉旧日：近 1 天（仅今日）只剩今天
    const today = readTokenLedgerHistory(days, { sinceDays: 1 })
    expect(today.days.map((d) => d.day)).toEqual([todayKey])
    expect(today.totals.requests).toBe(1)
  })

  it('未来日键（手工编辑）不展示也不入合计', () => {
    const future = Date.now() + 40 * 24 * 60 * 60 * 1000
    const days = makeDays([
      { ...OK, ts: future },
      { ...OK, ts: DAY1 },
    ])
    const { days: history, totals } = readTokenLedgerHistory(days)
    expect(history.map((d) => d.day)).not.toContain(utc8DayKey(future))
    expect(totals.requests).toBe(1)
  })

  it('空表 / 空 day：返回空数组不抛错', () => {
    expect(readTokenLedgerHistory(new Map()).days).toEqual([])
    const days: TokenLedgerDayMap = new Map([['2026-10-04', new Map()]])
    expect(readTokenLedgerHistory(days).days).toEqual([])
  })

  /**
   * ★ 回归（复审发现的真实缺陷）：**聚合行不得夹带内部累加器字段**。
   *
   * 类型签名是 `Omit<TokenLedgerModelRow,'model'>`，但 `finalizeAverages` 用
   * `{...t}` 展开 `AccumulatingTotals` ⇒ `ttftSumMs / ttftCount / tpsSum /
   * tpsCount` 这四个内部字段会**实际下发到 RPC 载荷**。类型没声明、UI 也不读，
   * 属「类型撒谎 + 载荷虚胖」——将来若有人误用 `ttftSumMs` 会得到 Σ 而非均值。
   */
  it('★ 聚合行不下发内部累加器字段（类型与实际返回必须一致）', () => {
    // 显式给 ttft 与 tps，让两边都有可测样本（否则均值字段本就该省略）。
    const days = makeDays([
      { ...OK, ts: dayStartAgo(0), ttftMs: 100, tps: 42, durationMs: 1100, outputTokens: 100 },
    ])
    const { days: history, totals } = readTokenLedgerHistory(days)
    // 内部累加器字段一律不得出现（各层都要查）
    const internal = ['ttftSumMs', 'ttftCount', 'tpsSum', 'tpsCount']
    for (const field of internal) {
      expect(totals, `totals.${field}`).not.toHaveProperty(field)
      expect(history[0]!.totals, `day.totals.${field}`).not.toHaveProperty(field)
      expect(history[0]!.channels[0]!.totals, `channel.totals.${field}`).not.toHaveProperty(field)
      expect(history[0]!.channels[0]!.providers[0]!.totals, `provider.totals.${field}`).not.toHaveProperty(field)
      expect(history[0]!.channels[0]!.providers[0]!.accounts[0]!.totals, `account.totals.${field}`).not.toHaveProperty(field)
      expect(history[0]!.channels[0]!.providers[0]!.accounts[0]!.models[0]!, `model.${field}`).not.toHaveProperty(field)
    }
    // 该有的均值仍然给（且是按 Σ/份数算出的均值，不是 Σ 本身）
    expect(totals.avgTtftMs).toBe(100)
    expect(totals.avgTps).toBe(42)
  })

  /** 内存快照的聚合树同样不得夹带内部字段（第 1 期路径，与历史路径同源）。 */
  it('★ 内存快照的聚合行同样不下发内部累加器字段', () => {
    seed([{ ...OK, ttftMs: 100, durationMs: 1100, outputTokens: 100 }])
    const snap = readTokenLedger()
    const row = snap.channels[0]!.providers[0]!.accounts[0]!.models[0]!
    for (const field of ['ttftSumMs', 'ttftCount', 'tpsSum', 'tpsCount']) {
      expect(row, `model.${field}`).not.toHaveProperty(field)
      expect(snap.totals, `totals.${field}`).not.toHaveProperty(field)
    }
    expect(row.avgTtftMs).toBe(100)
  })

  /**
   * ★★★ **内存不随请求数增长**（2026-11-20 用户最终需求的核心保证）。
   *
   * ## 为什么这条必须是行为级而不是「读代码推断」
   *
   * 第一版为了「汇总无上限」把 `ledger` 数组改成不截断 —— 汇总确实全量了，
   * 但内存随请求数线性涨。用户当场指出方向错误。
   *
   * ⇒ 现在拆成两个结构：`ledger`（500 封顶）+ `aggregateTree`（行数固定）。
   * 这条用例直接钉「同一个结构反复写入，规模不变」。
   *
   * ⚠️ 用**构造数据**（`recordTokenUsage`），不发任何真实请求。
   * ⚠️ 不测 `process.memoryUsage()` —— GC 噪音让它不稳定（会 flaky）。
   *    改测**结构规模**：`tokenLedgerSize()` 与聚合行数，这两个是确定的。
   */
  it('★★★ 内存不增长：写 2000 次后，明细 500 条、聚合行数不变', () => {
    resetTokenLedgerForTests()
    /** 统计聚合树的总行数（渠道→provider→账号→模型 的叶子数）。 */
    const countAggregateRows = () => {
      const snap = readTokenLedger()
      let n = 0
      for (const ch of snap.channels) {
        for (const pr of ch.providers) {
          for (const ac of pr.accounts) n += ac.models.length
        }
      }
      return n
    }

    // 前 10 次：用到 1 个渠道 / 1 provider / 1 账号 / 1 模型
    for (let i = 0; i < 10; i++) recordTokenUsage({ ...OK, outputTokens: 1 })
    const rowsAfter10 = countAggregateRows()

    // 再写 1990 次（同样的维度组合）⇒ 行数不得增加
    for (let i = 0; i < 1990; i++) recordTokenUsage({ ...OK, outputTokens: 1 })
    const rowsAfter2000 = countAggregateRows()

    expect(rowsAfter2000, '聚合行数必须与请求数无关').toBe(rowsAfter10)
    expect(rowsAfter2000).toBe(1)
    expect(tokenLedgerSize(), '明细必须封顶 500').toBe(TOKEN_LEDGER_ENTRY_LIMIT)

    // 而汇总确实是 2000
    expect(readTokenLedger().totals.requests).toBe(2000)
  })

  it('★★ 聚合行数只随「维度组合数」增长，不随请求数', () => {
    resetTokenLedgerForTests()
    const countRows = () => {
      const snap = readTokenLedger()
      let n = 0
      for (const ch of snap.channels) for (const pr of ch.providers) for (const ac of pr.accounts) n += ac.models.length
      return n
    }
    // 1 组维度，写 100 次
    for (let i = 0; i < 100; i++) recordTokenUsage({ ...OK, provider: 'p1', model: 'm1', outputTokens: 1 })
    expect(countRows()).toBe(1)
    // 新增 1 组维度（换 model）⇒ 行数 +1，与原维度写入次数无关
    recordTokenUsage({ ...OK, provider: 'p1', model: 'm2', outputTokens: 1 })
    expect(countRows()).toBe(2)
    // 再写 100 次同维度 ⇒ 仍是 2
    for (let i = 0; i < 100; i++) recordTokenUsage({ ...OK, provider: 'p1', model: 'm2', outputTokens: 1 })
    expect(countRows()).toBe(2)
    expect(readTokenLedger().totals.requests).toBe(201)
  })
})
