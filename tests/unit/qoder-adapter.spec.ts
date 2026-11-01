import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import {
  QoderAdapter,
  QODER_QUEUE_MAX_ATTEMPTS,
  QODER_TRANSPORT_MAX_RETRIES,
  classifyQoderFailure,
  transportErrorDetail,
  isBillingBusinessCode,
  looksLikeBillingError,
  nextUtc8DayStartMs,
  parseQoderQueueError,
  qoderQueueDelayMs,
  recordsQoderRateLimit,
  shouldRotateQoderAccount,
} from '../../src/qoder-adapter.js'
import { QODER, QODER_CN } from '../../src/qoder-product.js'
import type { QoderFallbackModel } from '../../src/qoder-product.js'
import { buildQoderCredential, parseQoderTokenPayload, type QoderCredential } from '../../src/qoder.js'

/** 源码级断言的路径基准（与 `jet-hub-rpc.spec.ts` 同款）。 */
const here = dirname(fileURLToPath(import.meta.url))

const cred: QoderCredential = buildQoderCredential(
  // ⚠️ `uid` 是**加密推理必需**的（`generate_runtime_auth_fields` 用它派生
  // `encrypt_user_info`）；缺了 WASM 会挂起。真实值来自设备码响应的 `user_id`。
  parseQoderTokenPayload({ token: 'tok', refresh_token: 'ref', user_id: 'uid-1' }),
  { machineId: 'm-1' })

/**
 * 构造适配器（默认注入可用凭据与 noop refresh）。
 *
 * ⚠️ **默认刻意不注入 `fetchRemoteModels`** ⇒ 本家「不发远端目录请求、恒用兜底表」，
 * 各用例看到的就是改造前那份静态快照。远端路径由本文件的「远端目录」一组
 * 与 `qoder-catalog.spec.ts`（协议 + 条目映射）分别覆盖。
 *
 * ⚠️⚠️ **目录取数绝不能退化成适配器自己发请求**（2026-10-20 实测教训）：
 * 中途的一版实现把它放在适配器内解析凭据 + 走全局 `fetch`，于是**每一个**用例
 * 都真的发了一次 HTTPS —— 而该端点实测对**伪造凭据也回 200**（返回真实目录！），
 * 「自定义 product + 单条兜底表」的几个用例因此静默拿到上游真表、断言变成
 * 随机真值（实测 4 条以 `Auto · x0.5` 而非 `Unknown` 失败）。
 * 这也正是最终把取数改成**注入式**（`QoderAuth.fetchModels(pool)`）的原因之一。
 */
function makeAdapter(overrides: Partial<ConstructorParameters<typeof QoderAdapter>[0]> = {}): QoderAdapter {
  return new QoderAdapter({
    credentialRef: { name: 'QODER_ACCESS_TOKEN' } as never,
    resolveCredential: async () => cred,
    refresh: async () => {},
    product: QODER,
    ...overrides,
  })
}

/** 一段标准 OpenAI 正文帧。 */
function textFrame(text: string): string {
  return JSON.stringify({ choices: [{ delta: { content: text }, index: 0 }] })
}

/** 一段标准 OpenAI 结束帧。 */
const finishFrame = JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })

/**
 * 构造**加密端点风格**的信封 SSE 响应。
 *
 * 真实形态（实测）：每帧多一层 `{headers, body, statusCode}` 包装，
 * 内层 `body` 是标准 OpenAI chunk 的 **JSON 字符串**（未加密）。
 */
function envelopeResponse(frames: string[]): Response {
  const body = frames
    .map((inner) => `data:${JSON.stringify({
      headers: { 'Content-Type': ['application/json'] },
      body: inner,
      statusCodeValue: 200,
      statusCode: 'OK',
    })}\n\n`)
    .join('')
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}

/** 收集一次 stream 的全部 chunk。 */
async function collect(adapter: QoderAdapter, model = 'auto'): Promise<Array<Record<string, unknown>>> {
  return collectWith(adapter, {
    model,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  })
}

/** 用**自定义 options** 收集一次 stream 的全部 chunk。 */
async function collectWith(
  adapter: QoderAdapter,
  options: Record<string, unknown>,
): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = []
  for await (const chunk of adapter.stream(options as never)) {
    out.push(chunk as unknown as Record<string, unknown>)
  }
  return out
}

describe('QoderAdapter 模型目录', () => {
  it('远端不可用时回退兜底表（静态快照，不再是唯一来源）', async () => {
    const models = await makeAdapter().listModels('qoder')
    expect(models.length).toBe(QODER.fallbackModels.length)
    expect(models.some((m) => m.id === 'auto')).toBe(true)
    expect(models.every((m) => m.provider === 'qoder')).toBe(true)
  })

  // ── 远端目录（2026-10-20 接入 `/api/v2/model/list?Encode=1`）──
  //
  // 背景：改造前本家**恒用编译期兜底表**，上游改价/改免费额度都不反映
  // （用户报障「DeepSeek-Flash 上游已 0×，插件还显示 0.1」）。
  describe('远端目录优先、兜底表回退', () => {
    /**
     * 远端条目 fixture（**已是归一后的形状**，与 `QoderFallbackModel` 同形）。
     *
     * ⚠️ 原始响应 → 归一形状的映射（`price_factor` / `context_config` /
     * `thinking_config` / `promotion` …）由 `qoder-catalog.spec.ts` 覆盖；
     * 本组只验适配器**拿了远端目录之后**的行为（谁优先、TTL、回退、广播）。
     */
    const remoteDfmodel: QoderFallbackModel = {
      id: 'dfmodel', name: 'DeepSeek-Flash', contextWindow: 1_000_000,
      supportsImage: true, supportsThinking: false,
      isFree: true, priceFactor: 0, originalPriceFactor: 0.1,
      efforts: ['high', 'max', 'low'], defaultEffort: 'max', supportsDisable: true,
    }
    /** 只存在于远端的模型（本仓兜底表里没有）—— 用来证明目录真的换了来源。 */
    const remoteFast: QoderFallbackModel = {
      id: 'fast', name: 'Fast', contextWindow: 1_000_000,
      supportsImage: true, supportsThinking: true, priceFactor: 0.8,
    }

    it('远端成功 ⇒ 用远端目录（含远端独有的模型与免费标记）', async () => {
      const fetchRemoteModels = vi.fn(async () => [remoteDfmodel, remoteFast])
      const adapter = makeAdapter({ fetchRemoteModels })
      const models = await adapter.listModels('qoder')
      expect(models.map((m) => m.id)).toEqual(['dfmodel', 'fast'])
      // ⚠️ 用户报障的那一格：上游 `price_factor: 0` ⇒ 显示「免费」而不是 `x0.1`。
      expect(models[0]?.name).toBe('DeepSeek-Flash · 免费')
      // 倍率格式与能力同样来自远端条目。
      expect(models[1]?.name).toBe('Fast · x0.8')
      expect(models[1]?.inputModalities).toEqual(['text', 'image'])
    })

    it('远端独有的模型，能力判据也必须走它（不能回退静态表）', async () => {
      const adapter = makeAdapter({ fetchRemoteModels: async () => [remoteFast] })
      const resolved = await adapter.resolveModel('qoder', 'fast')
      expect(resolved.name).toBe('Fast')
      expect(resolved.inputModalities).toEqual(['text', 'image'])
      expect(resolved.context).toEqual({ contextWindow: 1_000_000 })
    })

    /**
     * `isFreeModel` 的判据（`src/qoder-adapter.ts`）。
     *
     * ⚠️ 这一组与 `qoder-free-model-lock.spec.ts` **各守一层**，缺一不可：
     * - 那里把适配器的方法**钉成桩**，验的是「接线传到了编排」（装配层）；
     * - 这里验判据本身（目录读取 + `isFree` 语义），不桩任何东西。
     *
     * 如果只有前者，判据里写 `return true` / 忘了 `await ensureRemoteModels()`
     * 这类缺陷**全部无牙**（变异实测：6 条里有 4 条打不响）。
     */
    describe('isFreeModel（免费判据）', () => {
      it('远端 `isFree` ⇒ true（免费模型不该被「锁定永久积分」拦下）', async () => {
        const adapter = makeAdapter({ fetchRemoteModels: async () => [remoteDfmodel, remoteFast] })
        await expect(adapter.isFreeModel('dfmodel')).resolves.toBe(true)
      })

      it('⚠️ 免费但倍率非 0 也必须是 true（`qmodel_38max` 的形态）', async () => {
        // 国际版 `qmodel_38max`：`isFree: true` + `priceFactor: 0.2`。
        // 变异：判据改成「`priceFactor === 0` 即免费」⇒ 本条红（漏判成付费）。
        const adapter = makeAdapter({
          fetchRemoteModels: async () => [{
            id: 'qmodel_38max', name: 'Qwen3.8-Max', contextWindow: 1_000_000,
            isFree: true, priceFactor: 0.2,
          }],
        })
        await expect(adapter.isFreeModel('qmodel_38max')).resolves.toBe(true)
      })

      it('倍率 0 但未标 `isFree` ⇒ false（保守方向：宁可多查一次余额）', async () => {
        // 变异：判据改成「`priceFactor === 0` 即免费」⇒ 本条红。
        // 反向失效（把付费判成免费）会**真烧永久积分且不可撤回**，故必须保守。
        const adapter = makeAdapter({
          fetchRemoteModels: async () => [{
            id: 'paid-but-zero-rate', name: 'Paid', contextWindow: 200_000, priceFactor: 0,
          }],
        })
        await expect(adapter.isFreeModel('paid-but-zero-rate')).resolves.toBe(false)
      })

      it('付费模型 ⇒ false（最危险的失效方向：误判免费会绕开锁定烧钱）', async () => {
        const adapter = makeAdapter({ fetchRemoteModels: async () => [remoteDfmodel, remoteFast] })
        await expect(adapter.isFreeModel('fast')).resolves.toBe(false)
        await expect(adapter.isFreeModel('dmodel')).resolves.toBe(false)
      })

      it('未知模型 / 空入参 ⇒ false', async () => {
        const adapter = makeAdapter({ fetchRemoteModels: async () => [remoteFast] })
        await expect(adapter.isFreeModel('nope')).resolves.toBe(false)
        await expect(adapter.isFreeModel('')).resolves.toBe(false)
        await expect(adapter.isFreeModel(undefined)).resolves.toBe(false)
      })

      it('未接线远端目录 ⇒ 退用兜底表，兜底表里的免费模型仍判得出', async () => {
        // 兜底表与远端条目**同源**（都读 `isFree`）⇒ 纯插件用户也能享受免费短路。
        const adapter = makeAdapter()
        await expect(adapter.isFreeModel('qfmodel')).resolves.toBe(true)
        await expect(adapter.isFreeModel('dmodel')).resolves.toBe(false)
      })

      /**
       * ★★ **远端目录「按账号收缩」时，静态表里的免费模型仍必须判免费**
       * （2026-10-21 合并审计发现，!137 引入的回归）。
       *
       * ## 真实场景
       *
       * 远端目录是**按账号**下发的：免费额度号上游**只给 2 条**
       * （`qfmodel` + `dfmodel`，见 `docs/agent-notes/providers-qoder.md`），
       * 其余 17 条不在远端目录里。
       *
       * ## 缺陷
       *
       * 判据原写成 `this.catalogSource().find(...)`，而 `catalogSource()` 是
       * `remoteModels ?? fallbackModels` —— **远端一旦落地就把静态表整体顶掉**
       * ⇒ 静态表里标了 `isFree: true` 的 `qmodel_38max` 被判成「未知 ⇒ 非免费」
       * ⇒ 跳过 `credential-resolver.ts` 的「免费模型不受锁定约束」短路
       * ⇒ 锁定永久积分时被 `allowPermanent=false` 拦下、报出「额度都属于永久」
       * 这类**与事实相反**的错误 —— 本家 2026-10-21 真实报障**原地复发**，零日志。
       *
       * ⚠️ 同文件 `catalogModel()` 的注释**逐字记过同一个反模式**
       * （「第一版把它写成 `catalogSource().find(...)`，被独立审计打穿」）——
       * 能力/元数据判据早已改用并集，**免费判据当时漏了**。
       *
       * ⚠️ 与上一条「未接线远端」的区别：那格 `remoteModels` 仍是 `undefined`，
       * `catalogSource()` 恰好等于静态表 ⇒ **测不出**本条缺陷
       * （实测：本缺陷存在时本条红、那条绿）。
       *
       * 变异：判据改回 `this.catalogSource().find(...)` ⇒ 本条红
       * （实测：修前 `isFreeModel('qmodel_38max') = false`）。
       */
      it('★★ 远端目录按账号收缩时，静态表里的免费模型仍判免费（不许只查远端）', async () => {
        const shrunk: QoderFallbackModel[] = [
          { id: 'fast', name: 'Fast', contextWindow: 200_000, isFree: false },
        ]
        const adapter = makeAdapter({ fetchRemoteModels: async () => shrunk })
        // ⚠️ **必须先让远端真的落地**，否则测的是「未接线」那一格（那格恰好全绿）。
        await adapter.listModels('qoder')

        await expect(
          adapter.isFreeModel('qmodel_38max'),
          '★★ 静态表标了 isFree:true ⇒ 远端收缩时仍须判免费（否则免费模型撞锁定闸门，报出「额度都属于永久」）',
        ).resolves.toBe(true)
        await expect(adapter.isFreeModel('qfmodel')).resolves.toBe(true)
        // ⚠️ **反向必须同时存在**：并集不得把真付费模型判成免费
        //（那个方向会绕开锁定**真烧永久积分**，不可逆）。
        await expect(adapter.isFreeModel('dmodel')).resolves.toBe(false)
        await expect(adapter.isFreeModel('fast')).resolves.toBe(false)
      })

      it('⚠️ 必须 await 远端目录加载（否则「直接进会话」路径判据静默失效）', async () => {
        // 变异：删掉判据里的 `await this.ensureRemoteModels()` ⇒ 远端尚未加载，
        // 落到兜底表 ⇒ `remote-only-free` 查不到 ⇒ 返回 false ⇒ 本条红。
        const fetchRemoteModels = vi.fn(async () => [{
          id: 'remote-only-free', name: 'RemoteFree', contextWindow: 200_000, isFree: true,
        }])
        const adapter = makeAdapter({ fetchRemoteModels })
        // ⚠️ 不先调 listModels：直接问免费判据（模拟「直接进会话」）。
        await expect(adapter.isFreeModel('remote-only-free')).resolves.toBe(true)
        expect(fetchRemoteModels, '判据内部必须先拉一次目录').toHaveBeenCalledTimes(1)
      })
    })

    it('⚠️ 远端目录按账号收缩后，静态表里的模型能力/元数据**不得**退化（审计缺陷 1）', async () => {
      // 实景：国际版有个免费额度号，上游只给它 2 条（qfmodel + dfmodel），
      // 而目录缓存就是「上次成功那个账号的目录」。改造前 `catalogModel()` 只查
      // 远端 ⇒ 静态表里其余 15 条全被判成「未知」：图片被硬拒、名字退化成裸 id、
      // 窗口与档位消失、请求体元数据一并退化。
      const adapter = makeAdapter({ fetchRemoteModels: async () => [remoteFast] })
      const resolved = await adapter.resolveModel('qoder', 'dmodel')
      expect(resolved.name, '名字不得退化成裸 id').toBe('DeepSeek-V4-Pro')
      expect(resolved.inputModalities).toEqual(['text', 'image'])
      expect(resolved.context).toEqual({ contextWindow: 1_000_000 })
      expect(resolved.reasoning?.defaultEffort).toBe('max')
    })

    it('⚠️ 同一形态下带图请求不得被图片门禁硬拒（能力判据取并集）', async () => {
      const fetchImpl = vi.fn(async () => envelopeResponse([textFrame('你好'), finishFrame])) as never
      const adapter = makeAdapter({
        // 目录里没有 dmodel —— 只有远端时不支持图片，会抛 UNSUPPORTED_CONTENT
        fetchRemoteModels: async () => [remoteFast],
        fetchImpl,
        readImage: async () => ({ data: new Uint8Array([1, 2, 3]), mediaType: 'image/png' }),
      })
      // ⚠️ **必须先把远端目录读进缓存**：`stream()` 自己不拉目录，直接发请求时
      //    `catalogSource()` 还是静态表 ⇒ 这条用例会**假绿**（变异打不中它）。
      //    （第一版就漏了这一步，变异验证当场发现。）
      await adapter.listModels('qoder')
      const chunks = await collectWith(adapter, {
        model: 'dmodel',
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'hi' },
            { type: 'image', attachment: { attachmentId: 'a1' } },
          ],
        }],
      })
      expect(chunks.some((c) => c.type === 'text-delta'), '应走到上游而不是被门禁拒').toBe(true)
    })

    it('免费标记必须透出到 listAllModels（Jet Hub「免费额度」分组只认 isFree）', async () => {
      const adapter = makeAdapter({
        fetchRemoteModels: async () => [remoteDfmodel, remoteFast],
      })
      await adapter.listModels('qoder')
      const all = adapter.listAllModels()
      expect(all.find((m) => m.id === 'dfmodel')?.isFree, 'dfmodel 是 is_free 模型').toBe(true)
      // 反面：非免费模型不得被标成免费（否则整个分组失真）。
      expect(all.find((m) => m.id === 'fast')?.isFree).toBeUndefined()
    })

    it('20 分钟 TTL：第二次读命中缓存，不再打上游', async () => {
      const fetchRemoteModels = vi.fn(async () => [remoteFast])
      const adapter = makeAdapter({ fetchRemoteModels })
      await adapter.listModels('qoder')
      await adapter.listModels('qoder')
      expect(fetchRemoteModels).toHaveBeenCalledTimes(1)
    })

    it('refresh() 强制重拉（无视 TTL），供后台 20 分钟刷新器调用', async () => {
      const fetchRemoteModels = vi.fn(async () => [remoteFast])
      const adapter = makeAdapter({ fetchRemoteModels })
      await adapter.listModels('qoder')
      await adapter.refresh()
      expect(fetchRemoteModels).toHaveBeenCalledTimes(2)
    })

    it('远端失败 ⇒ 回退兜底表，并且**必须有告警**（否则是一次零日志的静默回退）', async () => {
      const warn = vi.fn()
      const adapter = makeAdapter({
        fetchRemoteModels: async () => { throw new Error('boom') },
        warn,
      })
      const models = await adapter.listModels('qoder')
      expect(models.length).toBeGreaterThan(0)
      // ⚠️ **不得只断言 `toBe(QODER.fallbackModels.length)`**（2026-10-20 对抗审计）：
      //    那是同义反复 —— 把兜底表置空后它变成 `0 === 0`，**整组 9 条全绿而菜单是空的**。
      //    判据必须锚在**具体内容**上（空表满足不了 `dmodel` 存在）。
      expect(models.map((m) => m.id)).toContain('dmodel')
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0]?.[0])).toContain('退用内置兜底表')
    })

    it('远端读出**空目录**（未登录 / 形状不符）⇒ 回退兜底表，不把菜单变空', async () => {
      const adapter = makeAdapter({ fetchRemoteModels: async () => [] })
      const models = await adapter.listModels('qoder')
      expect(models.length).toBeGreaterThan(0)
      expect(models.map((m) => m.id)).toContain('dmodel')
    })

    it('未接线 `fetchRemoteModels` ⇒ 不发任何请求，恒用兜底表', async () => {
      const adapter = makeAdapter()
      const models = await adapter.listModels('qoder')
      expect(models.length).toBeGreaterThan(0)
      expect(models.map((m) => m.id)).toContain('dmodel')
    })

    it('远端目录落地后广播（否则客户端永久停在冷启动那份兜底表）', async () => {
      const onCatalogLoaded = vi.fn()
      const adapter = makeAdapter({
        fetchRemoteModels: async () => [remoteFast],
        onCatalogLoaded,
      })
      await adapter.listModels('qoder')
      expect(onCatalogLoaded).toHaveBeenCalledTimes(1)
    })

    it('⚠️ 目录取数**不得**走 `resolveCredential`（它会把「活动账号」改写成目录用的号）', async () => {
      const resolveCredential = vi.fn(async () => cred)
      const adapter = makeAdapter({
        resolveCredential: resolveCredential as never,
        fetchRemoteModels: async () => [remoteFast],
      })
      await adapter.listModels('qoder')
      expect(resolveCredential).not.toHaveBeenCalled()
    })
  })

  it('listModels 应用 Jet Hub 黑名单', async () => {
    const adapter = makeAdapter({
      accountPool: { disabledModelsFor: () => new Set(['auto']) } as never,
    })
    const models = await adapter.listModels('qoder')
    expect(models.some((m) => m.id === 'auto')).toBe(false)
    expect(models.some((m) => m.id === 'dmodel')).toBe(true)
  })

  // 目录门控：没有已登录账号时不显示该 provider 的任何模型。
  // 见 `providerCatalogVisible`（src/account-pool.ts）。
  describe('无已登录账号时隐藏整个 provider 目录', () => {
    it('没有已登录账号 → 返回空数组', async () => {
      const adapter = makeAdapter({
        accountPool: {
          disabledModelsFor: () => new Set<string>(),
          hasLoggedInAccount: async () => false,
        } as never,
      })
      expect(await adapter.listModels('qoder')).toEqual([])
    })

    it('有已登录账号 → 正常返回目录', async () => {
      const adapter = makeAdapter({
        accountPool: {
          disabledModelsFor: () => new Set<string>(),
          hasLoggedInAccount: async () => true,
        } as never,
      })
      expect((await adapter.listModels('qoder')).length).toBe(QODER.fallbackModels.length)
    })
  })

  it('providerInfo 返回 qoder', () => {
    expect(makeAdapter().providerInfo('qoder')).toEqual({ id: 'qoder', name: QODER.displayName })
  })

  // 计费倍率展示（目录 `price_factor`）。
  //
  // ⚠️ **必须写进 `name`，不是 `description`**：composer 的模型切换菜单只渲染
  // `name`（ModelSelect 的 `children: model.name`），`description` 仅用于
  // `/model` 弹窗。用户报障「消耗倍率没有显示在切换模型列表的后面」。
  describe('listModels 的计费倍率', () => {
    it('price_factor=0 显示为「免费」而非 x0', async () => {
      // 实测 Qwen3.8-Flash（qfmodel）的 price_factor 正是 0。
      const models = await makeAdapter().listModels('qoder')
      const flash = models.find((m) => m.id === 'qfmodel')
      expect(flash?.name).toBe('Qwen3.8-Flash · 免费')
    })

    it('其余模型显示 x 倍率（数值对照真实 catalog）', async () => {
      const models = await makeAdapter().listModels('qoder')
      // ⚠️ 早期用例断言的是 `x0.8` / `x3.2` —— 那是兜底表的**过期估值**，
      // 真实 catalog 为 0.5 / 8（用户报障后逐条校正，见 qoder-product.spec.ts）。
      expect(models.find((m) => m.id === 'dmodel')?.name).toBe('DeepSeek-V4-Pro · x0.5')
      expect(models.find((m) => m.id === 'gfmodel')?.name).toBe('GLM-5.3-Flash · x0.1')
      expect(models.find((m) => m.id === 'smodel')?.name).toBe('Sonus · x8')
    })

    // ⚠️ 角标**不再**由目录快照 `promotion.active` 决定 —— 那是采集时刻的值，
    // 会随错峰窗口切换而失真。真实判据是 `windowStart`/`windowEnd` 的本地推算
    // （边界用例见 qoder-product.spec.ts 的「错峰时段判定」）。
    // 这里只验证**无窗口字段时的回退行为**，与当前钟点无关、恒定可复现。
    it('无窗口字段时回退到 active：false 不显示角标、用原价', async () => {
      const product = {
        ...QODER,
        fallbackModels: [{
          id: 'promo', name: 'Promo', contextWindow: 1000,
          priceFactor: 0.2,
          promotion: { active: false, discountFactor: 0.4, beforePromotionPriceFactor: 0.5, badgeZh: '错峰 4 折' },
        }],
      }
      const adapter = makeAdapter({ product: product as never })
      const models = await adapter.listModels('qoder')
      // 窗口外 → 原价、无角标（避免用户按折扣价预期却被按原价计费）
      expect(models[0]?.name).toBe('Promo · x0.5')
      expect(models[0]?.name).not.toContain('折')
    })

    it('无窗口字段时回退到 active：true 显示 原价→折后价', async () => {
      const product = {
        ...QODER,
        fallbackModels: [{
          id: 'promo', name: 'Promo', contextWindow: 1000,
          priceFactor: 0.2,
          promotion: { active: true, discountFactor: 0.4, beforePromotionPriceFactor: 0.5, badgeZh: '错峰 4 折' },
        }],
      }
      const adapter = makeAdapter({ product: product as never })
      const models = await adapter.listModels('qoder')
      // 窗口内 → `原价→折后价`（0.5→0.2），与 TRAE / buddy 同形态。
      // ⚠️ 旧形态是 `x0.2 错峰 4 折`（只有折后价 + 角标），用户要求对齐 TRAE。
      expect(models[0]?.name).toBe('Promo · x0.5→x0.2')
    })

    it('无 priceFactor 时 name 保持原样（不编造倍率）', async () => {
      const product = {
        ...QODER,
        fallbackModels: [{ id: 'unknown', name: 'Unknown', contextWindow: 1000 }],
      }
      const adapter = makeAdapter({ product: product as never })
      expect((await adapter.listModels('qoder'))[0]?.name).toBe('Unknown')
    })

    // resolveModel 的 name 用于会话中的模型显示，**不带**价格后缀
    // （价格只属于选择列表这个语境）。
    it('resolveModel 的 name 不带倍率后缀', async () => {
      expect((await makeAdapter().resolveModel('qoder', 'qfmodel')).name).toBe('Qwen3.8-Flash')
    })
  })
})

describe('QoderAdapter resolveModel', () => {
  it('已知模型带 contextWindow 与展示名', async () => {
    // dmodel = DeepSeek-V4-Pro，实测 max_input_tokens=1000000
    const resolved = await makeAdapter().resolveModel('qoder', 'dmodel')
    expect(resolved.name).toBe('DeepSeek-V4-Pro')
    expect(resolved.context).toEqual({ contextWindow: 1_000_000 })
  })

  it('未知模型不编造 context（id 即 name）', async () => {
    const resolved = await makeAdapter().resolveModel('qoder', 'some-future-model')
    expect(resolved.name).toBe('some-future-model')
    expect(resolved.context).toBeUndefined()
  })

  it('inputModalities 按模型的 supportsImage 判定', async () => {
    const adapter = makeAdapter()
    // 实测 17 个目录模型 is_vl 全为 true
    expect((await adapter.resolveModel('qoder', 'dmodel')).inputModalities).toEqual(['text', 'image'])
    expect((await adapter.resolveModel('qoder', 'qmodel_38max')).inputModalities).toEqual(['text', 'image'])
    // 未知模型保守报 text（宁可少报能力）
    expect((await adapter.resolveModel('qoder', 'unknown-x')).inputModalities).toEqual(['text'])
  })
})

/**
 * ⚠️ **真实缺陷**（用户报障）：「qoder 中国版可以设置思考档位，我们应该按照他的设置
 * 给出可设置的档位选择」。此前本适配器**只声明 `context`，从不声明 `reasoning`**
 * → composer 的思考强度选择器**根本不出现**，尽管目录早已下发 `thinking_config`。
 *
 * 展示名必须与官方 IDE 一致（asar i18n `settings.efforts`）：
 * `none:关闭思考 / minimal:最小 / low:低 / medium:中 / high:高 / xhigh:极高 / max:最大`。
 */
describe('QoderAdapter resolveModel 的思考档位', () => {
  it('档位取自目录 efforts，展示名为官方中文名', async () => {
    const resolved = await makeAdapter().resolveModel('qoder', 'dmodel')
    // 目录：efforts = { high, max(is_default) }，且有 disabled 分支 → 追加「关闭思考」
    expect(resolved.reasoning?.efforts).toEqual([
      { id: 'high', name: '高' },
      { id: 'max', name: '最大' },
      { id: 'none', name: '关闭思考' },
    ])
    expect(resolved.reasoning?.defaultEffort).toBe('max')
  })

  it('CN 的 qmodel_38max 是「极高/低/中 + 关闭思考」，默认中', async () => {
    // ⚠️ 必须显式传 CN 产品：`makeAdapter()` 默认用国际版表（`QODER`），
    // 而两者的 `qmodel_38max` 默认档**不同**（CN = medium、国际版 = xhigh）。
    const adapter = makeAdapter({ product: QODER_CN })
    const resolved = await adapter.resolveModel('qodercn', 'qmodel_38max')
    expect(resolved.reasoning?.efforts.map((e) => e.id)).toEqual(['xhigh', 'low', 'medium', 'none'])
    expect(resolved.reasoning?.efforts.map((e) => e.name)).toEqual(['极高', '低', '中', '关闭思考'])
    expect(resolved.reasoning?.defaultEffort).toBe('medium')
  })

  it('国际版同名的 qmodel_38max 默认档是 xhigh（与 CN 不同，勿混用）', async () => {
    const resolved = await makeAdapter().resolveModel('qoder', 'qmodel_38max')
    expect(resolved.reasoning?.defaultEffort).toBe('xhigh')
  })

  it('不提供「关闭思考」的模型不追加 none（gfmodel / gmodel / kmodel）', async () => {
    // 目录里这几条**没有 `disabled` 分支** → 用户不能关掉思考。
    const adapter = makeAdapter({ product: QODER_CN })
    for (const id of ['gfmodel', 'gmodel', 'kmodel']) {
      const resolved = await adapter.resolveModel('qodercn', id)
      expect(resolved.reasoning?.efforts.map((e) => e.id), id).not.toContain('none')
    }
  })

  it('只有「关闭思考」的模型：qmodel / qmodel_latest（目录无 efforts）', async () => {
    // ⚠️ 这是**远端事实**，不是遗漏：目录 `enabled` 里没有 `efforts` 键，
    // 只有 `disabled` + `enabled.is_default`（用户 2026-09-28 确认
    // 「上面两个没有思考档位就是关闭的意思」）。
    const adapter = makeAdapter({ product: QODER_CN })
    for (const id of ['qmodel', 'qmodel_latest']) {
      const resolved = await adapter.resolveModel('qodercn', id)
      expect(resolved.reasoning?.efforts.map((e) => e.id), id).toEqual(['none'])
      // 无档位可默认 → **不设** defaultEffort（DSH 显示「Default」）
      expect(resolved.reasoning?.defaultEffort, id).toBeUndefined()
    }
  })

  it('目录里没有 thinking_config 的模型不声明 reasoning', async () => {
    // CN：q37fmodel / mmodel / auto 完全没有 thinking_config →
    // UI 显示「当前模型未提供推理等级」，与 IDE 的「不支持」一致。
    const adapter = makeAdapter({ product: QODER_CN })
    for (const id of ['q37fmodel', 'mmodel', 'auto']) {
      const resolved = await adapter.resolveModel('qodercn', id)
      expect(resolved.reasoning, id).toBeUndefined()
    }
  })

  it('defaultEffort 必须落在 efforts 内（否则 DSH 会抛 UNSUPPORTED_REASONING_EFFORT）', async () => {
    for (const [provider, product] of [['qoder', QODER], ['qodercn', QODER_CN]] as const) {
      const adapter = makeAdapter({ product })
      for (const entry of product.fallbackModels) {
        const resolved = await adapter.resolveModel(provider, entry.id)
        const r = resolved.reasoning
        if (r === undefined) continue
        const ids = r.efforts.map((e) => e.id as string)
        expect(ids.length, `${provider}/${entry.id} 的 efforts 不能为空`).toBeGreaterThan(0)
        if (r.defaultEffort !== undefined) {
          expect(ids, `${provider}/${entry.id} 的 defaultEffort 必须在 efforts 内`).toContain(r.defaultEffort)
        }
        // 展示名不得缺失（缺了会显示裸 id）
        for (const e of r.efforts) expect(e.name, `${entry.id}/${e.id} 缺展示名`).toBeTruthy()
      }
    }
  })
})

describe('QoderAdapter 请求构造（加密端点）', () => {
  it('URL 指向 api2.qoder.sh 的 agent_chat_generation（**不是** api2-v2）', async () => {
    const fetchImpl = vi.fn(async () => envelopeResponse([textFrame('hi'), finishFrame])) as unknown as typeof fetch
    await collect(makeAdapter({ fetchImpl }))
    const call = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]!
    const url = String(call[0])
    // ⚠️ 加密端点与公开端点是**不同 host**：混用会 404
    expect(url.startsWith('https://api2.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation')).toBe(true)
    expect(url).toContain('Encode=1')
    expect(url).not.toContain('api2-v2')
  })

  it('请求体是**加密**的（不是 JSON），且带 X-Model-Key 头', async () => {
    const fetchImpl = vi.fn(async () => envelopeResponse([textFrame('hi'), finishFrame])) as unknown as typeof fetch
    await collect(makeAdapter({ fetchImpl }))
    const call = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]!
    const body = String((call[1] as { body: string }).body)
    // 加密体不是 JSON（朴素 JSON.parse 会失败）
    expect(() => JSON.parse(body)).toThrow()
    expect(body.length).toBeGreaterThan(0)
    // 模型 key 走独立头（服务端据此路由）
    const headers = (call[1] as { headers: Headers }).headers
    const get = (k: string): string | null => (headers instanceof Headers ? headers.get(k) : null)
    expect(get('X-Model-Key')).toBe('auto')
    expect(get('X-Model-Source')).toBe('system')
  })

  it('Authorization 是 WASM 生成的 COSY 签名，**不是**普通 Bearer token', async () => {
    // ⚠️ 用普通 `Bearer <token>` 覆盖会得到 403 Signature invalid。
    const fetchImpl = vi.fn(async () => envelopeResponse([textFrame('hi'), finishFrame])) as unknown as typeof fetch
    await collect(makeAdapter({ fetchImpl }))
    const call = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]!
    const headers = (call[1] as { headers: Headers }).headers
    const get = (k: string): string | null => (headers instanceof Headers ? headers.get(k) : null)
    const auth = get('authorization')
    expect(auth).toContain('Bearer COSY.')
    expect(auth).not.toBe('Bearer tok')
    expect(get('accept')).toBe('text/event-stream')
  })

  it('请求体必须含 `business`（缺了服务端路由到坏节点）', async () => {
    // ⚠️ 真实缺陷（2026-09-20 定位）：
    //   `qfmodel`（Qwen3.8-Flash）在**不带 `business`** 时恒落到故障节点
    //   `oa_qwen-plus-2025-04-28` 并返回 `[FAIL]node:... msg:Execution failed`；
    //   补上 `business` 后立即正常（其余模型如 `qmodel_38max` 恰好不受影响，
    //   故极易误判为「该模型服务端故障」——IDE 里同一模型完全可用）。
    //
    // 源码依据：`MPi(A) { return A === 'sec_scan' ? 'security' : 'default' }`
    // —— 服务端按 `business.type` 选路由池。
    //
    // 请求体是加密的，单测无法直接读字段，故用**源码级断言**锁死
    // （与 `jet-hub-rpc.spec.ts` 的守卫同款做法）。
    const source = readFileSync(resolve(here, '../../src/qoder-adapter.ts'), 'utf8')
    const code = source
      .split(/\r?\n/)
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n')
    expect(code).toContain('business: { type:')
  })

  it('system 提示与用户文本都进加密体（本地不可解，只校验非空）', async () => {
    const fetchImpl = vi.fn(async () => envelopeResponse([textFrame('hi'), finishFrame])) as unknown as typeof fetch
    const adapter = makeAdapter({ fetchImpl })
    for await (const _ of adapter.stream({
      model: 'auto',
      system: '你是助手',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    } as never)) { /* drain */ }
    const call = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]!
    const withSystem = String((call[1] as { body: string }).body)

    const fetchImpl2 = vi.fn(async () => envelopeResponse([textFrame('hi'), finishFrame])) as unknown as typeof fetch
    for await (const _ of makeAdapter({ fetchImpl: fetchImpl2 }).stream({
      model: 'auto',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    } as never)) { /* drain */ }
    const call2 = (fetchImpl2 as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]!
    const withoutSystem = String((call2[1] as { body: string }).body)

    // 有 system 时密文更长（内容确实进了请求）
    expect(withSystem.length).toBeGreaterThan(withoutSystem.length)
  })
})

describe('出口 fetcher 的优先级（`fetchImpl` 注入 > `fetchFor` > 全局）', () => {
  // ⚠️ 本组守的是**注释与实现相反**的一类缺陷（本轮真实发生）：推理主路径一度写成
  //    `this.fetchFor === undefined ? this.fetchImpl : this.fetchFor(...)`，
  //    即生产代理压过单测替身 —— 与它自己上方注释
  //    「`fetchImpl`（单测替身）> `fetchFor`（生产代理）」字字相反。
  //    ⚠️ 单靠源码断言守不住这种「两边都写了、但语义反了」的形态 ⇒ 必须行为断言。
  //    ⚠️ 也**不能**只把两个分支调序了事：`fetchImpl` 在构造期已被 `?? fetch` 填满，
  //    调序后 `fetchFor` 反而永远轮不到（生产代理全失效）⇒ 故实现里另存
  //    `hasInjectedFetchImpl` 标志，本组同时钉住该标志的语义。

  it('⚠️ 同时传 fetchImpl 与 fetchFor ⇒ fetchImpl 胜出（单测替身不许被生产代理顶掉）', async () => {
    const injected = vi.fn(async () => envelopeResponse([textFrame('hi'), finishFrame])) as unknown as typeof fetch
    const proxy = vi.fn(async () => envelopeResponse([textFrame('hi'), finishFrame])) as unknown as typeof fetch
    await collect(makeAdapter({ fetchImpl: injected, fetchFor: () => proxy }))
    expect(injected, '注入的 fetchImpl 必须被调用').toHaveBeenCalled()
    expect(proxy, 'fetchFor 不得压过注入的 fetchImpl').not.toHaveBeenCalled()
  })

  it('⚠️ 未注入 fetchImpl ⇒ 走 fetchFor（这条腿不能因为调序而失效）', async () => {
    const proxy = vi.fn(async () => envelopeResponse([textFrame('hi'), finishFrame])) as unknown as typeof fetch
    // ⚠️ 不能让「代理没被调用」这件事表现为**真发网络 + 5s 超时**（实测「恒 true」与
    //    「调序不加标志」两个变异都是这么红的）：那种红只有个 `Test timed out`，
    //    看不出真因。故给一个 2s 的有界等待，超时后给出带渠道名的断言失败。
    //    同时把全局 fetch 也替成 spy —— 万一实现落到末档，也不会真打网络。
    const globalSpy = vi.fn(async () => envelopeResponse([textFrame('hi'), finishFrame])) as unknown as typeof fetch
    const original = globalThis.fetch
    // @ts-expect-error —— 故意替换全局 fetch，避免变异态下真发 HTTPS。
    globalThis.fetch = globalSpy
    try {
      const started = Date.now()
      const drained = collect(makeAdapter({ fetchFor: () => proxy }))
      const settled = await Promise.race([
        drained.then(() => 'done' as const),
        new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 2000)),
      ])
      expect(settled, `fetchFor 在 ${Date.now() - started}ms 内没被用上（请求走去了别处）`).toBe('done')
      expect(proxy, '生产代理必须被调用').toHaveBeenCalled()
      expect(globalSpy, '不得回落到全局 fetch').not.toHaveBeenCalled()
    } finally {
      globalThis.fetch = original
    }
  })

  it('两者都未传 ⇒ 落到全局 fetch（不崩、不抛）', async () => {
    // 判据只要求「构造成功且 stream 走到发请求那一步」：真发全局 fetch 会打网络，
    // 故注入一个**替身**作为全局 fetch 的替位，再看它是否被用上。
    const globalSpy = vi.fn(async () => envelopeResponse([textFrame('hi'), finishFrame])) as unknown as typeof fetch
    const original = globalThis.fetch
    // @ts-expect-error —— 故意替换全局 fetch 以观测「末档兜底」是否还在。
    globalThis.fetch = globalSpy
    try {
      const adapter = new QoderAdapter({
        credentialRef: { name: 'QODER_ACCESS_TOKEN' } as never,
        resolveCredential: async () => cred,
        refresh: async () => {},
        product: QODER,
      })
      await collect(adapter)
      expect(globalSpy, '末档必须仍是全局 fetch').toHaveBeenCalled()
    } finally {
      globalThis.fetch = original
    }
  })
})

describe('QoderAdapter 鉴权与重试', () => {
  it('401 时刷新一次凭据后重试', async () => {
    let calls = 0
    const fetchImpl = vi.fn(async () => {
      calls += 1
      if (calls === 1) return new Response('unauthorized', { status: 401 })
      return envelopeResponse([textFrame('你好'), finishFrame])
    }) as unknown as typeof fetch
    const refresh = vi.fn(async () => {})
    const chunks = await collect(makeAdapter({ fetchImpl, refresh }))
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(chunks.some((c) => c.type === 'text-delta')).toBe(true)
  })

  it('无凭据时报 MISSING_CREDENTIAL', async () => {
    const adapter = makeAdapter({ resolveCredential: async () => undefined })
    await expect(collect(adapter)).rejects.toThrow(/log in|凭据|credential/i)
  })
})

describe('QoderAdapter SSE 解析', () => {
  it('解析正文与 reasoning_content', async () => {
    const fetchImpl = vi.fn(async () => envelopeResponse([
      JSON.stringify({ choices: [{ delta: { reasoning_content: '想' } }] }),
      textFrame('你好'),
      finishFrame,
    ])) as unknown as typeof fetch
    const chunks = await collect(makeAdapter({ fetchImpl }))
    expect(chunks.some((c) => c.type === 'reasoning-delta')).toBe(true)
    expect(chunks.some((c) => c.type === 'text-delta')).toBe(true)
    const finish = chunks.find((c) => c.type === 'finish')
    expect(finish).toBeDefined()
  })

  it('delta.content 显式为 null 时不崩溃（真实形态）', async () => {
    // 实测：一个模型要么走 content、要么走 reasoning_content，另一侧恒为 null
    const fetchImpl = vi.fn(async () => envelopeResponse([
      JSON.stringify({ choices: [{ delta: { content: null, reasoning_content: 'r' } }] }),
      finishFrame,
    ])) as unknown as typeof fetch
    await expect(collect(makeAdapter({ fetchImpl }))).resolves.toBeDefined()
  })

  it('工具调用分片合并', async () => {
    const fetchImpl = vi.fn(async () => envelopeResponse([
      JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1',
        function: { name: 'read', arguments: '{"p"' } }] } }] }),
      JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0,
        function: { arguments: ':"x"}' } }] } }] }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
    ])) as unknown as typeof fetch
    const chunks = await collect(makeAdapter({ fetchImpl }))
    const end = chunks.find((c) => c.type === 'block-end'
      && (c.block as { type?: string } | undefined)?.type === 'tool-call')
    expect(end).toBeDefined()
    const block = end!.block as { name: string; arguments: string }
    expect(block.name).toBe('read')
    expect(block.arguments).toBe('{"p":"x"}')
  })
})

describe('QoderAdapter SSE 错误帧（真实缺陷：报错被静默吞掉）', () => {
  /**
   * 真实缺陷（用户报障）：「向 qwen3.8-flash 发消息后没收到回复就终止了」。
   *
   * 服务端对无效模型的真实响应（实测 2026-09-19）：
   * ```
   * event: error
   * data: {"code":"invalid_model_error","message":"Unsupported model \"qfmodel\"",
   *        "request_id":"...","type":"invalid_model_error"}
   * ```
   *
   * ⚠️ 两处与 OpenAI 标准不同，早期实现因此**整帧丢弃**：
   * 1. 有独立的 `event: error` 行（我们的解析器只处理 `data:` 行）；
   * 2. 错误信息在**顶层 `code`/`message`**，而非 `{error: {message}}`。
   *
   * 后果：错误被当成「正常结束、无内容」→ 只产出
   * `[{type:'finish', reason:{kind:'stop'}}]`，UI 表现为
   * 「没回复就干净地停止」，用户看不到任何原因。
   */
  const errorFrame = 'event: error\ndata: {"code":"invalid_model_error","message":"Unsupported model \\"qfmodel\\"","request_id":"abc","type":"invalid_model_error"}\n\n'

  it('顶层 code/message 的错误帧必须抛错，而不是静默 finish', async () => {
    const fetchImpl = vi.fn(async () => new Response(errorFrame, {
      status: 200, headers: { 'Content-Type': 'text/event-stream' },
    })) as unknown as typeof fetch
    await expect(collect(makeAdapter({ fetchImpl }))).rejects.toThrow(/Unsupported model/)
  })

  it('错误必须带上服务端 message，便于用户定位', async () => {
    const fetchImpl = vi.fn(async () => new Response(errorFrame, {
      status: 200, headers: { 'Content-Type': 'text/event-stream' },
    })) as unknown as typeof fetch
    const error = await collect(makeAdapter({ fetchImpl })).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('invalid_model_error')
    expect((error as Error).message).toContain('qfmodel')
  })

  it('标准 OpenAI 形态 {error:{message}} 仍要抛错（不回归）', async () => {
    const frame = 'data: {"error":{"message":"boom"}}\n\n'
    const fetchImpl = vi.fn(async () => new Response(frame, {
      status: 200, headers: { 'Content-Type': 'text/event-stream' },
    })) as unknown as typeof fetch
    await expect(collect(makeAdapter({ fetchImpl }))).rejects.toThrow(/boom/)
  })

  it('正常帧不受影响（event: 行被忽略，data 帧照常解析）', async () => {
    const frame = `event: message\ndata: ${textFrame('你好')}\ndata: ${finishFrame}\ndata: [DONE]\n\n`
    const fetchImpl = vi.fn(async () => new Response(frame, {
      status: 200, headers: { 'Content-Type': 'text/event-stream' },
    })) as unknown as typeof fetch
    const chunks = await collect(makeAdapter({ fetchImpl }))
    expect(chunks.some((c) => c.type === 'text-delta')).toBe(true)
  })
})

describe('QoderAdapter 图片输入', () => {
  it('不支持图片的模型收到图片时报 UNSUPPORTED_CONTENT', async () => {
    // 实测真实模型 is_vl 全为 true，故用**未知模型**测「保守报 text」这条路径
    const fetchImpl = vi.fn(async () => envelopeResponse([textFrame('你好'), finishFrame])) as unknown as typeof fetch
    const adapter = makeAdapter({ fetchImpl, readImage: async () => undefined })
    const iterate = async (): Promise<void> => {
      for await (const _ of adapter.stream({
        model: 'text-only-unknown',
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'hi' },
            { type: 'image', attachment: { attachmentId: 'a1' } },
          ],
        }],
      } as never)) { /* drain */ }
    }
    await expect(iterate()).rejects.toThrow(/不支持图片/)
  })

  it('支持图片的模型接受图片并真的读取了附件', async () => {
    // ⚠️ 请求体已加密，无法再断言明文 image_url 形态
    // （那是公开端点的形态）。且加密体长度因分块填充而**不单调**，
    // 也不能用长度断言。这里验证真正可观察的行为：
    //   1. 不抛 UNSUPPORTED_CONTENT（图片被接受）
    //   2. readImage 被调用（附件确实被读取，而非静默丢弃）
    const readImage = vi.fn(async (): Promise<{ data: Uint8Array; mediaType: string }> =>
      ({ data: new Uint8Array([1, 2, 3]), mediaType: 'image/png' }))

    const fetchImpl = vi.fn(async () => envelopeResponse([textFrame('你好'), finishFrame])) as unknown as typeof fetch
    const chunks = await collectWith(makeAdapter({ fetchImpl, readImage }), {
      model: 'dmodel',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'hi' },
          { type: 'image', attachment: { attachmentId: 'a1' } },
        ],
      }],
    })

    expect(readImage).toHaveBeenCalledTimes(1)
    expect(chunks.some((c) => c.type === 'text-delta')).toBe(true)
  })
})

/**
 * ## 真实缺陷（用户报障，2026-09-27）：Qoder 的**排队错误**被当成认证失败
 *
 * 用户给的两条真实错误（都是 HTTP 403 + 业务码 `10605`）：
 *
 * ```
 * 国际版: {"code":"10605","message":"{\"isQueued\":true,…,\"retryAfterSeconds\":30,
 *          \"serviceAvailable\":false,\"waitTime\":30}"}      → 真排队 30s
 * 中国版: {"code":"10605","message":"{\"isQueued\":false,…,\"retryAfterSeconds\":2,
 *          \"serviceAvailable\":true,\"waitTime\":0}"}        → 瞬时，等 2s 即成功
 * ```
 *
 * ⚠️ **关键结构**：`message` 是**一个 JSON 字符串**（不是对象），必须**二次解析**。
 * 客户端 `lFc()` 为此递归遍历 `data`/`result`/`message`/`body`，字符串则
 * `JSON.parse`。旧实现只读顶层 `code`，因此从未识别出排队。
 *
 * 客户端的权威算法（obf 产物取证，`scripts/probe-qoder-queue-error.mjs`）：
 * - 排队码 `mRA="10605"` → `model_queued`；认证码 `MF="105"` → `auth_error`
 *   —— **两者互相独立**（`rJc()`），不能都归为 AUTH；
 * - 延迟优先序（`kJa()`/`EV()`/`IRA()`）：`retry_after_ms` → `retryAfterMs`
 *   → `queue.retryAfterSeconds×1000` → 兜底 `Retry-After` 响应头；
 * - 决策（`W7c()`）：**有 `retryAfterMs` 就精确等它**，没有才退避。
 */
describe('QoderAdapter 排队错误（10605 model_queued）', () => {
  /** 构造一条真实的 403 排队响应（`message` 是 JSON 字符串）。 */
  function queueResponse(info: Record<string, unknown>): Response {
    return new Response(
      JSON.stringify({ code: '10605', message: JSON.stringify(info) }),
      { status: 403, headers: { 'Content-Type': 'application/json' } },
    )
  }

  /** 国际版真排队：等 30s。 */
  const REAL_QUEUED = {
    isQueued: true, modelKey: 'qfmodel', queueCount: 0, queueType: 'p3',
    retryAfterSeconds: 30, serviceAvailable: false, waitTime: 30,
  }
  /** 中国版瞬时排队：等 2s，重试即成功。 */
  const REAL_TRANSIENT = {
    isQueued: false, modelKey: 'qfmodel', queueCount: 0, queueType: 'p3',
    retryAfterSeconds: 2, serviceAvailable: true, waitTime: 0,
  }

  describe('parseQoderQueueError（纯函数：二次解析 message）', () => {
    it('解析出排队信息（message 是 JSON 字符串，必须二次解析）', () => {
      const info = parseQoderQueueError(JSON.stringify({ code: '10605', message: JSON.stringify(REAL_QUEUED) }))
      expect(info).toEqual(REAL_QUEUED)
    })

    it('中国版瞬时排队同样解析出来', () => {
      const info = parseQoderQueueError(JSON.stringify({ code: '10605', message: JSON.stringify(REAL_TRANSIENT) }))
      expect(info).toEqual(REAL_TRANSIENT)
    })

    it('非 10605 的 403（真认证失败）不算排队', () => {
      // 认证失败的业务码是 105，不是 10605 —— 两者**必须分开**（客户端 rJc()）。
      expect(parseQoderQueueError(JSON.stringify({ code: '105', message: 'login expired' }))).toBeUndefined()
      expect(parseQoderQueueError(JSON.stringify({ code: '10605', message: 'not json' }))).toBeUndefined()
      expect(parseQoderQueueError('not json at all')).toBeUndefined()
      expect(parseQoderQueueError('')).toBeUndefined()
    })

    it('message 是对象而非字符串时也能取到（上游形态变化时更鲁棒）', () => {
      const info = parseQoderQueueError(JSON.stringify({ code: '10605', message: REAL_QUEUED }))
      expect(info).toEqual(REAL_QUEUED)
    })

    it('code 兼容字符串与数字两种编码', () => {
      expect(parseQoderQueueError(JSON.stringify({ code: 10605, message: JSON.stringify(REAL_TRANSIENT) })))
        .toEqual(REAL_TRANSIENT)
    })
  })

  describe('qoderQueueDelayMs（纯函数：延迟换算与封顶）', () => {
    it('小于 10 秒按服务端的值（2s → 2000ms）', () => {
      expect(qoderQueueDelayMs({ retryAfterSeconds: 2 })).toBe(2000)
      expect(qoderQueueDelayMs({ retryAfterSeconds: 0 })).toBe(0)
      expect(qoderQueueDelayMs({ retryAfterSeconds: 9 })).toBe(9000)
    })

    it('≥ 10 秒封顶到 10 秒（30s → 10000ms）', () => {
      // 用户明确要求：大于 10 秒就按 10 秒排队（避免一次阻塞 30 秒，
      // 分多次尝试更稳 —— 后端可能提前放行）。
      expect(qoderQueueDelayMs({ retryAfterSeconds: 10 })).toBe(10_000)
      expect(qoderQueueDelayMs({ retryAfterSeconds: 30 })).toBe(10_000)
      expect(qoderQueueDelayMs({ retryAfterSeconds: 3600 })).toBe(10_000)
    })

    it('优先用 retry_after_ms / retryAfterMs（毫秒口径，同样封顶）', () => {
      // 客户端 kJa() 的优先序：retry_after_ms → retryAfterMs → retryAfterSeconds×1000
      expect(qoderQueueDelayMs({ retry_after_ms: 1500, retryAfterSeconds: 30 })).toBe(1500)
      expect(qoderQueueDelayMs({ retryAfterMs: 2500 })).toBe(2500)
      // 毫秒值超上限同样封顶
      expect(qoderQueueDelayMs({ retry_after_ms: 99_999 })).toBe(10_000)
    })

    it('非法值被忽略，退回退避（而不是等 NaN 毫秒）', () => {
      // 客户端 W7c() 对非有限/负值直接判 fail；我们取保守：退回退避。
      expect(qoderQueueDelayMs({ retryAfterSeconds: -5 })).toBeUndefined()
      expect(qoderQueueDelayMs({ retryAfterSeconds: Number.NaN })).toBeUndefined()
      expect(qoderQueueDelayMs({})).toBeUndefined()
      expect(qoderQueueDelayMs({ retryAfterSeconds: '2' as never })).toBeUndefined()
    })

    it('非排队错误不产生延迟', () => {
      expect(qoderQueueDelayMs(undefined)).toBeUndefined()
    })
  })

  describe('stream 行为：排队时内部等待并重试', () => {
    it('瞬时排队（2s）等待后重试即成功，且**不刷新凭据**', async () => {
      const refresh = vi.fn(async () => {})
      let call = 0
      const fetchImpl = vi.fn(async () => {
        call += 1
        // 第 1 次排队，第 2 次成功（与用户观察一致：一次重试就能过）
        return call === 1
          ? queueResponse(REAL_TRANSIENT)
          : envelopeResponse([textFrame('好了'), finishFrame])
      }) as unknown as typeof fetch

      const sleeps: number[] = []
      const pending = collectWith(makeAdapter({
        fetchImpl, refresh, sleep: async (ms) => { sleeps.push(ms) },
      }), { model: 'qfmodel', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })

      const chunks = await pending
      expect(sleeps, '应按服务端给的 2s 等待').toEqual([2000])
      // ⚠️ 排队不是认证问题：绝不能刷新凭据（旧实现会先 refresh 再重试）
      expect(refresh, '排队期间不应刷新凭据').not.toHaveBeenCalled()
      expect(chunks.some((c) => c.type === 'text-delta')).toBe(true)
    })

    it('真排队（30s）按 10s 封顶等待，多次重试直到成功', async () => {
      const refresh = vi.fn(async () => {})
      let call = 0
      const fetchImpl = vi.fn(async () => {
        call += 1
        if (call <= 3) return queueResponse(REAL_QUEUED)
        return envelopeResponse([textFrame('排到了'), finishFrame])
      }) as unknown as typeof fetch

      const sleeps: number[] = []
      const chunks = await collectWith(makeAdapter({
        fetchImpl, refresh, sleep: async (ms) => { sleeps.push(ms) },
      }), { model: 'qfmodel', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })

      // 30s 被压到 10s（用户要求：>10s 按 10s 排）
      expect(sleeps).toEqual([10_000, 10_000, 10_000])
      expect(refresh).not.toHaveBeenCalled()
      expect(chunks.some((c) => c.type === 'text-delta')).toBe(true)
    })

    it('排队次数超过上限后抛错（不无限阻塞）', async () => {
      const fetchImpl = vi.fn(async () => queueResponse(REAL_QUEUED)) as unknown as typeof fetch
      const sleeps: number[] = []
      const adapter = makeAdapter({
        fetchImpl,
        sleep: async (ms) => { sleeps.push(ms); if (sleeps.length > QODER_QUEUE_MAX_ATTEMPTS + 5) throw new Error('sleep 未收敛') },
      })

      await expect(collectWith(adapter, {
        model: 'qfmodel', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      })).rejects.toThrow(/排队|queue/i)

      // 精确上限：不多不少
      expect(sleeps.length).toBe(QODER_QUEUE_MAX_ATTEMPTS)
      expect(QODER_QUEUE_MAX_ATTEMPTS).toBe(180)
    })

    it('等待期间 signal 中止则立即停止（不再重试）', async () => {
      const controller = new AbortController()
      const fetchImpl = vi.fn(async () => queueResponse(REAL_QUEUED)) as unknown as typeof fetch
      const adapter = makeAdapter({
        fetchImpl,
        sleep: async () => { controller.abort() },
      })

      await expect(collectWith(adapter, {
        model: 'qfmodel',
        signal: controller.signal,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      })).rejects.toThrow()
    })

    it('真认证失败（非 10605 的 403）仍走 refresh + AUTH（不误判为排队）', async () => {
      const refresh = vi.fn(async () => {})
      const fetchImpl = vi.fn(async () => new Response(
        JSON.stringify({ code: '105', message: 'login expired' }),
        { status: 403, headers: { 'Content-Type': 'application/json' } },
      )) as unknown as typeof fetch

      const sleeps: number[] = []
      await expect(collectWith(makeAdapter({
        fetchImpl, refresh, sleep: async (ms) => { sleeps.push(ms) },
      }), { model: 'qfmodel', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }))
        .rejects.toThrow()

      expect(sleeps, '认证失败不该走排队等待').toEqual([])
      expect(refresh, '认证失败应触发续期').toHaveBeenCalled()
    })

    it('排队总时长上限可用 DSH_QODER_QUEUE_TIMEOUT_MS 覆盖', async () => {
      // ⚠️ 上限判定是**时间**驱动（默认 30 分钟），单测不能真等 —— 这里设 0，
      // 语义是「立即判超时」，从而在毫秒级验证该开关确实生效且**不被 180 次
      // 次数上限抢先命中**（两者的判定顺序是实现细节，此用例锁住它）。
      process.env.DSH_QODER_QUEUE_TIMEOUT_MS = '0'
      try {
        const fetchImpl = vi.fn(async () => queueResponse(REAL_QUEUED)) as unknown as typeof fetch
        const sleeps: number[] = []
        await expect(collectWith(makeAdapter({
          fetchImpl, sleep: async (ms) => { sleeps.push(ms) },
        }), { model: 'qfmodel', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }))
          .rejects.toThrow(/排队等待超时/)

        // 上限为 0 → 第一次排队即判超时，**一次都不等**（而不是把 180 次耗完）。
        expect(sleeps).toEqual([])
      } finally {
        delete process.env.DSH_QODER_QUEUE_TIMEOUT_MS
      }
    })
  })

  /**
   * ## 真实缺陷（用户报障 2026-09-27 的**第二次**回归）：排队走 SSE 通道
   *
   * 第一版修复只覆盖了 **HTTP 403** 形态，但 Qoder 的排队错误还有**第二种**下发：
   * **HTTP 200 + SSE 内嵌 `{code:"10605",…}` 帧**。
   *
   * 用户症状：`失败原因：qoder: {"code":"10605",…}` + harness 以
   * `500/1000/2000/4000/8000`（约 15.5 秒）重试 5 次，而服务端要求等 30 秒
   * —— **永远等不到**。会话证据：`failure.code = "SERVER"`，而
   * `httpErrorCode(403) = "AUTH"` ⇒ 错误来自 SSE 消费器，不是 HTTP 状态层。
   *
   * ⚠️ 这条通道还踩过一个**更隐蔽**的坑：`unwrapQoderEnvelopeStream` 原先把内层
   * `{code, message}` **降级重组**为 `{error:{message:"… (10605)"}}` —— 把 `code`
   * 拼成文案后缀并**丢掉字段**，导致 `consumeOpenAiSse` 的排队识别
   * （依赖顶层 `code === '10605'`）**永远不命中**。
   * 故这条用例同时守住「信封保真转发」与「SSE 层识别排队」两件事。
   */
  describe('SSE 通道的排队（HTTP 200 + 内嵌 10605 帧）', () => {
    /** 构造 HTTP 200 + **加密信封** SSE 的错误帧（真实形态）。 */
    function sseQueueResponse(innerBody: string): Response {
      const payload = `data:${JSON.stringify({
        headers: { 'Content-Type': ['application/json'] },
        body: innerBody,
        statusCodeValue: 200,
        statusCode: 'OK',
      })}\n\n`
      return new Response(payload, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
    }

    const INNER_ERROR = JSON.stringify({ code: '10605', message: JSON.stringify(REAL_QUEUED) })

    it('SSE 内嵌排队被识别：内部等待后重试，且不刷新凭据', async () => {
      let call = 0
      const refresh = vi.fn(async () => {})
      const fetchImpl = vi.fn(async () => {
        call += 1
        // 第 1 次回 HTTP 200 + 排队帧，第 2 次回正常内容
        return call === 1
          ? sseQueueResponse(INNER_ERROR)
          : envelopeResponse([textFrame('好了'), finishFrame])
      }) as unknown as typeof fetch

      const sleeps: number[] = []
      const chunks = await collectWith(makeAdapter({
        fetchImpl, refresh, sleep: async (ms) => { sleeps.push(ms) },
      }), { model: 'qfmodel', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })

      // ⚠️ 这是本用例的核心：SSE 通道也按服务端延迟（30s→10s 封顶）等待
      expect(sleeps, 'SSE 通道的排队未被识别（第一版修复的漏洞）').toEqual([10_000])
      expect(refresh, '排队不应刷新凭据').not.toHaveBeenCalled()
      expect(chunks.some((c) => c.type === 'text-delta')).toBe(true)
    })

    it('信封必须保真转发 code（丢掉它会让排队识别永远失效）', async () => {
      // 直接断言信封剥离后的帧仍带 `code`，而不是被拼成 `message (code)` 后缀。
      const { unwrapQoderEnvelopeStream } = await import('../../src/qoder-envelope.js')
      const stripped = unwrapQoderEnvelopeStream(sseQueueResponse(INNER_ERROR), 'qoder')
      const text = await stripped.text()
      expect(text, '内层 code 被丢掉了').toContain('10605')
      // 旧实现会产出 `{"error":{"message":"… (10605)"}}` 这种丢字段的形态
      expect(text, '不应降级成无 code 的 error 包装').not.toContain('"error"')
    })

    it('SSE 排队同样受次数上限约束（不无限阻塞）', async () => {
      const fetchImpl = vi.fn(async () => sseQueueResponse(INNER_ERROR)) as unknown as typeof fetch
      const sleeps: number[] = []
      const adapter = makeAdapter({
        fetchImpl,
        sleep: async (ms) => {
          sleeps.push(ms)
          if (sleeps.length > QODER_QUEUE_MAX_ATTEMPTS + 5) throw new Error('sleep 未收敛')
        },
      })

      await expect(collectWith(adapter, {
        model: 'qfmodel', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      })).rejects.toThrow(/排队|queue/i)
      expect(sleeps.length).toBe(QODER_QUEUE_MAX_ATTEMPTS)
    })

    it('SSE 里的**瞬时**排队（2s）按 2s 等待，不是 10s', async () => {
      const inner = JSON.stringify({ code: '10605', message: JSON.stringify(REAL_TRANSIENT) })
      let call = 0
      const fetchImpl = vi.fn(async () => {
        call += 1
        return call === 1
          ? sseQueueResponse(inner)
          : envelopeResponse([textFrame('ok'), finishFrame])
      }) as unknown as typeof fetch

      const sleeps: number[] = []
      await collectWith(makeAdapter({
        fetchImpl, sleep: async (ms) => { sleeps.push(ms) },
      }), { model: 'qfmodel', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })

      expect(sleeps).toEqual([2000])
    })

    it('网关形态（无 code，只有 message + type）的排队也被识别', async () => {
      // ⚠️ 信封剥离把这种帧变成 `{message, type:'model_error'}`（`statusCodeValue`
      // 被信封吃掉）—— 若只判 `statusCodeValue >= 400`，整帧会被**静默丢弃**，
      // 既识别不出排队、连报错都没有（真实缺陷的又一变体）。
      const inner = JSON.stringify({ statusCodeValue: 403, message: JSON.stringify(REAL_QUEUED) })
      let call = 0
      const fetchImpl = vi.fn(async () => {
        call += 1
        return call === 1
          ? sseQueueResponse(inner)
          : envelopeResponse([textFrame('ok'), finishFrame])
      }) as unknown as typeof fetch

      const sleeps: number[] = []
      await collectWith(makeAdapter({
        fetchImpl, sleep: async (ms) => { sleeps.push(ms) },
      }), { model: 'qfmodel', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })

      expect(sleeps, '网关形态的排队被静默丢弃了').toEqual([10_000])
    })

    it('非排队的网关错误仍抛错（不因新增判据而静默吞掉）', async () => {
      // 防回归：新增的 `type === 'model_error'` 判据不能把普通错误也吞掉。
      const inner = JSON.stringify({ statusCodeValue: 500, message: '[FAIL]node:xxx msg:Execution failed' })
      const fetchImpl = vi.fn(async () => sseQueueResponse(inner)) as unknown as typeof fetch

      await expect(collectWith(makeAdapter({
        fetchImpl, sleep: async () => {},
      }), { model: 'qfmodel', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }))
        .rejects.toThrow(/Execution failed/)
    })

    /**
     * ## 真实缺陷（第三次回归，用户报障 2026-09-27 13:15）
     *
     * 用户贴出的错误后缀是 **`(403/model_error)`** —— 该后缀由
     * `[String(data.code), data.type].join('/')` 产出，据此反推出消费器收到的帧：
     *
     * ```json
     * { "code": 403,
     *   "message": "{\"code\":\"10605\",\"message\":\"{\\\"isQueued\\\":…}\"}",
     *   "type": "model_error" }
     * ```
     *
     * ⚠️ **业务码嵌了两层**：顶层 `code` 是 **403**，`10605` 在 `message` 里。
     * 上一版判据写成 `isQueueBusinessCode(data.code)` —— 拿 403 比 10605
     * **必然不命中**，于是又落到 `SERVER`（这正是「修了两次仍失败」的原因）。
     *
     * 判据必须是「**直接尝试解析 `message`**」，而不是用顶层 `code` 当门禁。
     */
    it('业务码嵌套两层（顶层 code=403，10605 在内层）也要识别', async () => {
      const nested = JSON.stringify({ code: 403, message: INNER_ERROR, type: 'model_error' })
      let call = 0
      const fetchImpl = vi.fn(async () => {
        call += 1
        return call === 1
          ? sseQueueResponse(nested)
          : envelopeResponse([textFrame('ok'), finishFrame])
      }) as unknown as typeof fetch

      const sleeps: number[] = []
      await collectWith(makeAdapter({
        fetchImpl, sleep: async (ms) => { sleeps.push(ms) },
      }), { model: 'qfmodel', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })

      // ⚠️ 断言精确的 10s（而非「有等待」）：它同时证明**穿透了两层**拿到
      // `retryAfterSeconds:30` —— 若只识别出排队却取不到延迟，会是 1000ms 兜底。
      expect(sleeps, '业务码嵌套两层时未穿透解析').toEqual([10_000])
    })

    it('嵌套两层且内层是**瞬时**排队（2s）时取 2s', async () => {
      const nested = JSON.stringify({
        code: 403,
        message: JSON.stringify({ code: '10605', message: JSON.stringify(REAL_TRANSIENT) }),
        type: 'model_error',
      })
      let call = 0
      const fetchImpl = vi.fn(async () => {
        call += 1
        return call === 1
          ? sseQueueResponse(nested)
          : envelopeResponse([textFrame('ok'), finishFrame])
      }) as unknown as typeof fetch

      const sleeps: number[] = []
      await collectWith(makeAdapter({
        fetchImpl, sleep: async (ms) => { sleeps.push(ms) },
      }), { model: 'qfmodel', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })

      expect(sleeps).toEqual([2000])
    })
  })

  /**
   * ## 真实缺陷（用户报障 2026-09-27）：额度用尽被当成可重试的 `SERVER`
   *
   * 排队修好后，会话继续自动执行目标时出现**新错误**：
   * ```
   * 重试延迟：7220毫秒
   * 失败原因：qoder: Billing daily count exceeded (110/model_error)
   * ```
   *
   * ⚠️ 后缀 **`(110/model_error)`** 与排队那次那个 `(403/model_error)` **同源**，
   * 由 `openai-compat.ts` 的「顶层 code + message」分支产出 —— 即帧是
   * `{ code: 110, message: 'Billing daily count exceeded', type: 'model_error' }`。
   * 它被归成 **`SERVER`**，而 `SERVER` **在** harness 的
   * `DEFAULT_RETRYABLE_CODES` 里 → **白重试 5 次**（500…8000ms ≈ 15.5 秒，
   * 用户看到的 `7220毫秒` 就是其中一步）。
   *
   * ## 客户端权威依据（obf 产物原文）
   *
   * ```js
   * function vpt(e){
   *   let t = e === "authentication_failed" || e === "billing_error" ? "permission"
   *         : e === "rate_limit"      ? "rate_limited"
   *         : e === "invalid_request" ? "invalid_request"
   *         : "unavailable";
   *   return new Tt(t, `Qoder assistant failed: ${e}`)
   * }
   * ```
   * **`billing_error` 被归为 `permission`** —— 与 `rate_limit`（可重试）**明确分开**，
   * 属**不可重试**。故我们必须返回不可重试的错误码（`QUOTA_EXCEEDED`）。
   *
   * ⚠️ 与 `10605`（排队）的区别：排队是**暂时**的（等待即可通过），
   * 额度是**当天耗尽**（等到明天）。两者绝不能用同一套处理。
   */
  describe('额度用尽（110 billing）归为不可重试', () => {
    /** 构造 HTTP 200 + 信封的 110 错误帧。 */
    function billingFrame(inner) {
      return () => new Response(
        `data:${JSON.stringify({
          headers: { 'Content-Type': ['application/json'] },
          body: inner,
          statusCodeValue: 200,
          statusCode: 'OK',
        })}\n\n`,
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      )
    }

    it('SSE 帧里的 110 抛 QUOTA_EXCEEDED（而不是可重试的 SERVER）', async () => {
      const inner = JSON.stringify({ code: 110, message: 'Billing daily count exceeded', type: 'model_error' })
      const fetchImpl = vi.fn(billingFrame(inner)) as unknown as typeof fetch

      const sleeps: number[] = []
      let thrown
      try {
        await collectWith(makeAdapter({
          fetchImpl, sleep: async (ms) => { sleeps.push(ms) },
        }), { model: 'qfmodel', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })
      } catch (error) { thrown = error }

      // ⚠️ 核心断言：**不可重试** —— 不能让 harness 白退避 5 次
      expect(thrown?.code, '110 必须归为不可重试的额度错误').toBe('QUOTA_EXCEEDED')
      expect(sleeps, '额度用尽不该在适配器内部等待').toEqual([])
      expect(String(thrown?.message)).toContain('Billing daily count exceeded')
    })

    it('业务码是字符串 "110" 同样识别', async () => {
      const inner = JSON.stringify({ code: '110', message: 'Billing daily count exceeded', type: 'model_error' })
      const fetchImpl = vi.fn(billingFrame(inner)) as unknown as typeof fetch

      await expect(collectWith(makeAdapter({
        fetchImpl, sleep: async () => {},
      }), { model: 'qfmodel', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }))
        .rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' })
    })

    it('客户端把 billing 归 permission 的**判据**用测试锁住（防被改回 SERVER）', async () => {
      // 这条是「文档即测试」：把客户端权威映射写成可执行断言，
      // 避免后人只看到注释而误以为 110 属可重试类。
      const CLIENT_MAPPING = (e) => (
        e === 'authentication_failed' || e === 'billing_error' ? 'permission'
          : e === 'rate_limit' ? 'rate_limited'
            : e === 'invalid_request' ? 'invalid_request'
              : 'unavailable'
      )
      expect(CLIENT_MAPPING('billing_error')).toBe('permission')
      // ⚠️ 与排队**不同类**：排队是 rate_limit（可重试），额度是 permission（不可重试）
      expect(CLIENT_MAPPING('rate_limit')).toBe('rate_limited')
      expect(CLIENT_MAPPING('billing_error')).not.toBe(CLIENT_MAPPING('rate_limit'))
    })

    /**
     * 🔴 **兄弟码 `112`（2026-10-10 用户报障实测，Gitee issue IKKJFH）**。
     *
     * 现场报文（GUI 失败原因那一行）：
     * ```
     * 本轮运行失败  qoder: {"pricingUrl":"https://qoder.com.cn/pricing?client=qoder"} (112/model_error)
     * 模型请求重试已取消 (2/5)
     * ```
     * 后缀 `(112/model_error)` 由本仓 `openai-compat` 的 `[code, type].join('/')`
     * 拼出 ⇒ 真实帧是
     * `{ code: 112, message: '{"pricingUrl":"…"}', type: 'model_error' }`。
     *
     * ## 它为什么是 `110` 的同族
     * 报文 payload 是**定价页链接** —— 语义是「要付费/升级才能用」，
     * 与 `110`（`Billing daily count exceeded`，当日额度耗尽）同属**额度类**：
     * 都是**确定性**失败，重试一百次结果一样。
     *
     * ## 不修的后果（IKKJFH 实测形状）
     * 三个判据全 false ⇒ 落 `SERVER` ⇒ `SERVER` **在** harness 的
     * `DEFAULT_RETRYABLE_CODES` 里 ⇒ 白退避 5 次；且
     * `isQuotaExceededError(SERVER) = false` ⇒ `switchAccountOnQuota`
     * **永不被调用** ⇒ **既不换号、也不换 provider**，用户侧表现为
     * 「等一段必然失败的退避，只好手动取消」。
     * ⚠️ 这与 `110` 当初那个缺陷**完全同型**，只是换了码值 —— 证明「只认码值」
     * 这条判据本身不够，必须同时有文案兜底（见本组末尾的纯函数用例）。
     */
    it('业务码 112（payload 是 pricingUrl）同样归为不可重试', async () => {
      const inner = JSON.stringify({
        code: 112,
        message: JSON.stringify({ pricingUrl: 'https://qoder.com.cn/pricing?client=qoder' }),
        type: 'model_error',
      })
      const fetchImpl = vi.fn(billingFrame(inner)) as unknown as typeof fetch

      const sleeps: number[] = []
      let thrown
      try {
        await collectWith(makeAdapter({
          fetchImpl, sleep: async (ms) => { sleeps.push(ms) },
        }), { model: 'qfmodel', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })
      } catch (error) { thrown = error }

      // ⚠️ 核心断言：与 110 同一档 —— 不可重试，且**不能**在适配器内部等待
      expect(thrown?.code, '112 必须归为不可重试的额度错误').toBe('QUOTA_EXCEEDED')
      expect(sleeps, '额度类不该在适配器内部等待').toEqual([])
    })

    it('字符串 "112" 同样识别（与 110 的两种编码口径一致）', async () => {
      const inner = JSON.stringify({
        code: '112',
        message: JSON.stringify({ pricingUrl: 'https://qoder.com.cn/pricing?client=qoder' }),
        type: 'model_error',
      })
      const fetchImpl = vi.fn(billingFrame(inner)) as unknown as typeof fetch
      await expect(collectWith(makeAdapter({ fetchImpl, sleep: async () => {} }),
        { model: 'qfmodel', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }))
        .rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' })
    })

    /**
     * 文案兜底必须**自己**能认 `pricingUrl` —— 不能只靠码值。
     *
     * 判据（本仓既有条款原文）：「若上游哪天改用别的码值表达同一语义，
     * 只认码就会漏判 —— 故两者都认」。`112` 就是这句话的实例。
     * 故这里**故意不给 `code`**，只留 `pricingUrl` 文案，验证兜底这条腿独立成立。
     */
    it('无业务码、只有 pricingUrl 文案时也归为额度（文案兜底独立成立）', async () => {
      const inner = JSON.stringify({
        message: JSON.stringify({ pricingUrl: 'https://qoder.com.cn/pricing?client=qoder' }),
        type: 'model_error',
      })
      const fetchImpl = vi.fn(billingFrame(inner)) as unknown as typeof fetch
      const sleeps: number[] = []
      let thrown
      try {
        await collectWith(makeAdapter({ fetchImpl, sleep: async (ms) => { sleeps.push(ms) } }),
          { model: 'qfmodel', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })
      } catch (error) { thrown = error }

      expect(thrown?.code, '仅凭文案也必须归为额度').toBe('QUOTA_EXCEEDED')
      expect(sleeps).toEqual([])
    })
  })

  /**
   * 判据本身的可执行断言（**别只测调用点**）。
   *
   * ⚠️ 为什么单开一组：`112` 那次漏判的根因就在这两个纯函数里，
   * 而调用点测试只覆盖「某一条路径」。这里把判据本身钉死，
   * 防止后人改窄正则/改回单码值时**调用点测试仍绿**。
   */
  describe('额度判据（纯函数）', () => {
    it('110 与 112 都算额度（数字与字符串两种编码）', () => {
      for (const code of [110, '110', 112, '112']) {
        expect(isBillingBusinessCode(code), `code=${String(code)}`).toBe(true)
      }
    })

    it('排队码 10605 不算额度 —— 两类必须分开（语义不同：等待 vs 当天耗尽）', () => {
      expect(isBillingBusinessCode('10605')).toBe(false)
      expect(isBillingBusinessCode(10605)).toBe(false)
    })

    it('pricingUrl 报文算额度（112 的真实 payload 形态）', () => {
      expect(looksLikeBillingError(JSON.stringify({
        pricingUrl: 'https://qoder.com.cn/pricing?client=qoder',
      }))).toBe(true)
    })

    it('泛词不得误伤：balance / quota 这类仍不算（防正文误判）', () => {
      // 本仓既有条款：「关键词必须窄」—— 正文里讨论「余额」不得被判成额度错误
      expect(looksLikeBillingError('your balance is 42 credits')).toBe(false)
      expect(looksLikeBillingError('quota')).toBe(false)
      expect(looksLikeBillingError('the model explained how pricing works')).toBe(false)
    })
  })

  /**
   * ## 用户要求（2026-09-27）：额度受限要**切账号**，与 buddy/workbuddy 一致
   *
   * 原话：「qoder 碰到当日额度受限应该像 workbuddy/codebuddy 一样，设置一个模型
   * 受限时间（他们是返回错误中带时间，qoder 和 qodercn 需要自己设置当日 24:00
   * 受限）然后切换账号池中的下一个可用模型」。
   *
   * ⚠️ **与 buddy/CodeArts 的关键差异**：它们的错误文案里**带重置时间**
   * （`parseRateLimitError` 从中解析），Qoder **不带** —— 故必须自己算
   * 「当日 24:00」。这也是本组用例的重点。
   */
  describe('额度受限：标记当日 24:00 + 切换账号', () => {
    it('nextUtc8DayStartMs 算出 UTC+8 的当日 24:00（不是本机时区）', () => {
      // 2026-09-27 12:00:00 UTC+8 = 04:00:00 UTC
      const noon = Date.UTC(2026, 8, 27, 4, 0, 0)
      const end = nextUtc8DayStartMs(noon)
      // 期望 = 2026-09-28 00:00:00 UTC+8 = 2026-09-27 16:00:00 UTC
      expect(new Date(end).toISOString()).toBe('2026-09-27T16:00:00.000Z')
      // 12:00 → 次日 00:00 恰好 12 小时
      expect(end - noon).toBe(12 * 3_600_000)
    })

    it('接近 UTC+8 日界时，剩余时间收敛到 0（不会算到后天）', () => {
      // 2026-09-27 23:59:59 UTC+8 = 15:59:59 UTC
      const nearEnd = Date.UTC(2026, 8, 27, 15, 59, 59)
      const end = nextUtc8DayStartMs(nearEnd)
      expect(new Date(end).toISOString()).toBe('2026-09-27T16:00:00.000Z')
      expect(end - nearEnd).toBe(1000)
    })

    it('刚过 UTC+8 日界时，得到的是**下一个**日界（满 24 小时）', () => {
      // 2026-09-27 00:00:00 UTC+8 = 2026-09-26 16:00:00 UTC
      const justAfter = Date.UTC(2026, 8, 26, 16, 0, 0)
      const end = nextUtc8DayStartMs(justAfter)
      // 应是 2026-09-28 00:00:00 UTC+8（即 24 小时后），不是同一时刻
      expect(new Date(end).toISOString()).toBe('2026-09-27T16:00:00.000Z')
      expect(end - justAfter).toBe(24 * 3_600_000)
    })

    it('结果恒严格大于入参（标记不会“立刻失效”）', () => {
      for (const h of [0, 3, 8, 12, 16, 20, 23]) {
        const t = Date.UTC(2026, 8, 27, h, 30, 15)
        expect(nextUtc8DayStartMs(t), `h=${h}`).toBeGreaterThan(t)
      }
    })

    /**
     * 切账号的**行为**验证（不只看纯函数）。
     *
     * 用桩账号池记录「标记了什么、取了哪个账号」，从而断言：
     * ① 受限时**标记当前账号 + 该模型**到 UTC+8 当日 24:00；
     * ② 取号时**传了 tried**（否则会拿回同一个账号、切换静默失效）；
     * ③ 切到新账号后用**新凭据**重发；
     * ④ 全部账号都受限时如实抛 `QUOTA_EXCEEDED`（不无限切）。
     */
    function makePoolStub(accounts: Array<{ id: string; token: string }>) {
      const marks: Array<{ accountId: string; modelId: string; resetAtMs: number }> = []
      const picks: Array<ReadonlySet<string> | undefined> = []
      let index = 0
      const pool = {
        updateModelRateLimit: async (accountId: string, modelId: string, resetAtMs: number) => {
          marks.push({ accountId, modelId, resetAtMs })
        },
        getAvailableAccount: async (_provider: string, _model: string, exclude?: ReadonlySet<string>) => {
          picks.push(exclude)
          while (index < accounts.length && exclude?.has(accounts[index].id) === true) index += 1
          if (index >= accounts.length) return null
          const a = accounts[index]
          return {
            entry: { id: a.id },
            credential: buildQoderCredential(
              parseQoderTokenPayload({ token: a.token, refresh_token: 'r', user_id: `uid-${a.id}` }),
              { machineId: 'm-1' },
            ),
          }
        },
      }
      return { pool, marks, picks }
    }

    it('额度受限：标记当前账号该模型到 UTC+8 当日 24:00，并切到下一个账号', async () => {
      const { pool, marks, picks } = makePoolStub([
        { id: 'acct-A', token: 'tokA' },
        { id: 'acct-B', token: 'tokB' },
      ])

      // 第一次（acct-A）回额度错误，第二次（acct-B）回正常内容。
      // 用 Authorization 头区分是哪个账号发的请求。
      let call = 0
      const seenAuth: string[] = []
      const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
        call += 1
        seenAuth.push(String((init.headers as Headers)?.get?.('Authorization') ?? ''))
        if (call === 1) {
          const inner = JSON.stringify({ code: 110, message: 'Billing daily count exceeded', type: 'model_error' })
          return new Response(
            `data:${JSON.stringify({ headers: {}, body: inner, statusCodeValue: 200 })}\n\n`,
            { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
          )
        }
        return envelopeResponse([textFrame('新账号可用'), finishFrame])
      }) as unknown as typeof fetch

      const chunks = await collectWith(makeAdapter({
        fetchImpl,
        accountPool: pool as never,
        currentAccountId: () => 'acct-A',
      }), { model: 'qfmodel', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })

      // ① 标记了 acct-A 的 qfmodel，时间落在未来（UTC+8 当日 24:00）
      expect(marks.length, '应标记一次额度受限').toBe(1)
      expect(marks[0].accountId).toBe('acct-A')
      expect(marks[0].modelId).toBe('qfmodel')
      expect(marks[0].resetAtMs).toBeGreaterThan(Date.now())

      // ② 取号时**传了 tried**（含刚失败的 acct-A），否则会拿回同一个账号
      expect(picks.length).toBeGreaterThan(0)
      expect(picks[0]?.has('acct-A'), 'tried 必须含刚失败的账号').toBe(true)

      // ③ 确实换账号重发（第二次请求存在）并拿到内容
      expect(call, '应换账号重发').toBe(2)
      expect(chunks.some((c) => c.type === 'text-delta')).toBe(true)
    })

    /**
     * ⚠️ **IKKJFH 的用户观感就落在这条上**：issue 原文是
     * 「轮换没生效 —— 既没有换到号池里的下一个账号，也没有换到别的 provider」。
     *
     * 光验「`112` 归 `QUOTA_EXCEEDED`」**不够** —— 上面那组只证明错误码对了，
     * 而 `QUOTA_EXCEEDED` 与「真的切了号」是两件事（`switchAccountOnQuota`
     * 在无池/无候选时会 `undefined` 返回，码仍然是对的）。
     * 故这里把 `112` 走一遍完整行为链：**标记 → 取号传 tried → 换号重发 → 拿到内容**。
     *
     * ⚠️ 与 `110` 那条行为用例是**同一形状的两份**，不是重复：
     * 若后人把 `112` 从 `BILLING_BUSINESS_CODES` 里删掉，只有这条会红。
     */
    it('112 同样触发换号（issue 现象的另一半：不修则既不换号也不换 provider）', async () => {
      const { pool, marks, picks } = makePoolStub([
        { id: 'acct-A', token: 'tokA' },
        { id: 'acct-B', token: 'tokB' },
      ])

      let call = 0
      const fetchImpl = vi.fn(async () => {
        call += 1
        if (call === 1) {
          const inner = JSON.stringify({
            code: 112,
            message: JSON.stringify({ pricingUrl: 'https://qoder.com.cn/pricing?client=qoder' }),
            type: 'model_error',
          })
          return new Response(
            `data:${JSON.stringify({ headers: {}, body: inner, statusCodeValue: 200 })}\n\n`,
            { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
          )
        }
        return envelopeResponse([textFrame('新账号可用'), finishFrame])
      }) as unknown as typeof fetch

      const chunks = await collectWith(makeAdapter({
        fetchImpl,
        accountPool: pool as never,
        currentAccountId: () => 'acct-A',
      }), { model: 'qfmodel', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })

      expect(marks.map((m) => m.accountId), '应标记 acct-A 该模型受限').toEqual(['acct-A'])
      expect(picks[0]?.has('acct-A'), 'tried 必须含刚失败的账号').toBe(true)
      expect(call, '112 必须换账号重发').toBe(2)
      expect(chunks.some((c) => c.type === 'text-delta')).toBe(true)
    })

    it('所有账号都受限时抛 QUOTA_EXCEEDED（不无限切换）', async () => {
      const { pool, marks } = makePoolStub([
        { id: 'acct-A', token: 'tokA' },
        { id: 'acct-B', token: 'tokB' },
      ])

      // 永远回额度错误 —— 两个账号都会被标记，然后如实失败
      const billingInner = JSON.stringify({ code: 110, message: 'Billing daily count exceeded', type: 'model_error' })
      const fetchImpl = vi.fn(async () => new Response(
        `data:${JSON.stringify({ headers: {}, body: billingInner, statusCodeValue: 200 })}\n\n`,
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      )) as unknown as typeof fetch

      await expect(collectWith(makeAdapter({
        fetchImpl,
        accountPool: pool as never,
        currentAccountId: () => 'acct-A',
      }), { model: 'qfmodel', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }))
        .rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' })

      // 两个账号都被标记（A 由 currentAccountId 标记，B 由切号后标记）
      expect(marks.map((m) => m.accountId)).toEqual(['acct-A', 'acct-B'])
    })

    it('无账号池时不切号，但仍如实抛 QUOTA_EXCEEDED（不吞错）', async () => {
      const inner = JSON.stringify({ code: 110, message: 'Billing daily count exceeded', type: 'model_error' })
      const fetchImpl = vi.fn(async () => new Response(
        `data:${JSON.stringify({ headers: {}, body: inner, statusCodeValue: 200 })}\n\n`,
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      )) as unknown as typeof fetch

      await expect(collectWith(makeAdapter({ fetchImpl, sleep: async () => {} }),
        { model: 'qfmodel', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }))
        .rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' })
    })

    it('标记时间恰为 UTC+8 次日 00:00（而非「1 小时后」这种错误兜底）', async () => {
      const { pool, marks } = makePoolStub([]) // 无候选 → 只标记、不切
      const inner = JSON.stringify({ code: 110, message: 'Billing daily count exceeded', type: 'model_error' })
      const fetchImpl = vi.fn(async () => new Response(
        `data:${JSON.stringify({ headers: {}, body: inner, statusCodeValue: 200 })}\n\n`,
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      )) as unknown as typeof fetch

      await expect(collectWith(makeAdapter({
        fetchImpl, accountPool: pool as never, currentAccountId: () => 'acct-A',
      }), { model: 'qfmodel', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }))
        .rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' })

      expect(marks.length).toBe(1)
      // ⚠️ 必须是 UTC+8 的整点日界（分钟/秒/毫秒为 0），
      // 而不是 `Date.now() + 1h` —— 后者带任意零头，且对按自然日结算的额度是错的。
      const marked = new Date(marks[0].resetAtMs + 8 * 3_600_000)
      expect(marked.getUTCMinutes(), '应为整点日界').toBe(0)
      expect(marked.getUTCSeconds()).toBe(0)
      expect(marked.getUTCMilliseconds()).toBe(0)
      expect(marked.getUTCHours()).toBe(0)
    })
  })

  /**
   * ## 真实报障（用户 2026-10-21，第二轮）
   *
   * 池里有 **2 个** `qodercn` 账号，上游回
   * `Error in upstream response (provider_error/model_error) code=SERVER`
   * 时**第二个账号从未被尝试** —— 修前本适配器的切号判据只有「额度」一类。
   *
   * ## 语义表（照 `accio-adapter.ts:1596-1605` 的「类别 → 动作」表）
   *
   * | 类别 | 判据 | 换号 | 写冷却 |
   * |---|---|---|---|
   * | `quota` | QUOTA_EXCEEDED / 110 / 112 / pricingUrl | ✅ | ✅ 至 UTC+8 当日 24:00 |
   * | `rate` | RATE_LIMIT / 429 | ✅ | ✅ 1h |
   * | `auth` | AUTH / 401 / 403 | ✅ | ❌ 绝不 |
   * | `upstream` | SERVER 且文案含 provider_error | ✅ | ❌ 绝不 |
   * | `other` | 400 参数错 / 空响应 / 风控页 | ❌ | ❌ |
   *
   * ⚠️ **`auth` / `upstream` 只换号、绝不写冷却**是两条独立的不变式：
   * - `auth`：2026-10-06「全池被封」事故 —— 上游对全池回 401 时，若每个号都写
   *   长冷却，**一个请求就能把整个 provider 封一天**；
   * - `upstream`：`provider_error` 是上游**供应商侧**瞬时故障，与账号状态无关。
   *   写冷却等于把一次抖动记成「该账号今日此模型已用完」，要**一整天**才恢复。
   */
  describe('失败分类：换号 ≠ 写冷却（provider_error 必须换号且不冷却）', () => {
    /** 真实报障里上游给的 SSE 错误帧。 */
    const providerErrorFrame = JSON.stringify({
      code: 'provider_error',
      message: 'Error in upstream response',
      type: 'model_error',
    })

    /** 把一段错误 JSON 包成信封 SSE 响应（HTTP 200，与额度错误同通道）。 */
    function sseErrorFrame(inner: string): Response {
      return new Response(
        `data:${JSON.stringify({ headers: {}, body: inner, statusCodeValue: 200 })}\n\n`,
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      )
    }

    /**
     * ⚠️ 池桩刻意**不实现**「按冷却过滤」：本组的断言就是「有没有写冷却」，
     * 若桩按 `marks` 过滤，写不写冷却都换得到号 ⇒ 判据失去牙。
     * 排除只靠 `exclude`（即生产里的 `tried`）—— 那正是「不写冷却时唯一的排除通道」。
     */
    function makePoolStub(accounts: Array<{ id: string; token: string }>) {
      const marks: Array<{ accountId: string; modelId: string; resetAtMs: number }> = []
      const picks: Array<ReadonlySet<string> | undefined> = []
      let index = 0
      const pool = {
        updateModelRateLimit: async (accountId: string, modelId: string, resetAtMs: number) => {
          marks.push({ accountId, modelId, resetAtMs })
        },
        getAvailableAccount: async (_provider: string, _model: string, exclude?: ReadonlySet<string>) => {
          picks.push(exclude)
          while (index < accounts.length && exclude?.has(accounts[index].id) === true) index += 1
          if (index >= accounts.length) return null
          const a = accounts[index]
          return {
            entry: { id: a.id },
            credential: buildQoderCredential(
              parseQoderTokenPayload({ token: a.token, refresh_token: 'r', user_id: `uid-${a.id}` }),
              { machineId: 'm-1' },
            ),
          }
        },
      }
      return { pool, marks, picks }
    }

    /**
     * ★★ **本组最核心的一条**（真实报障的直接复现）：
     * 上游回 `provider_error` 时必须换到第二个账号，且**绝不写冷却**。
     *
     * ⚠️ 三个断言缺一不可：
     * - `marks` 为空 —— 证明「不写冷却」（若写，这个账号要一整天才能再被选中）；
     * - `tried` 含 acct-A —— 证明「不靠冷却也能排除刚失败的号」
     *   （`account-pool.ts:2241-2242` 的过滤器只看 `modelRateLimits`，
     *   不写冷却时它是唯一排除通道）；
     * - `call === 2` 且拿到正文 —— 证明真的换号重发了，不是只抛错。
     */
    it('★★ provider_error 必须换到第二个账号，且绝不写冷却', async () => {
      const { pool, marks, picks } = makePoolStub([
        { id: 'acct-A', token: 'tokA' },
        { id: 'acct-B', token: 'tokB' },
      ])

      let call = 0
      const fetchImpl = vi.fn(async () => {
        call += 1
        if (call === 1) return sseErrorFrame(providerErrorFrame)
        return envelopeResponse([textFrame('新账号可用'), finishFrame])
      }) as unknown as typeof fetch

      const chunks = await collectWith(makeAdapter({
        fetchImpl,
        accountPool: pool as never,
        currentAccountId: () => 'acct-A',
      }), { model: 'dfmodel', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })

      // ① **绝不写冷却**（写了一天就废了这个号）
      expect(marks, 'provider_error 不得写冷却标记').toEqual([])
      // ② 真的换号重发并拿到内容
      expect(call, 'provider_error 必须换账号重发').toBe(2)
      expect(chunks.some((c) => c.type === 'text-delta')).toBe(true)
    })

    /**
     * ★★ **`tried` 是不写冷却时唯一的排除通道** —— 用源码级断言守（行为级守不住）。
     *
     * ## 为什么行为级守不住（实测）
     *
     * `_stream` 在进入循环前就做了：
     * ```ts
     * const triedAccounts = new Set<string>()
     * if (activeAccountId !== undefined && activeAccountId.length > 0) triedAccounts.add(activeAccountId)
     * ```
     * ⇒ 只要 `currentAccountId` 接好（生产里 `src/index.ts:2237` / `:2312` 都接了），
     * `acct-A` **早已在 `tried` 里**，`switchAccountOnQuota` 里加不加那一句都换得到 B。
     * 变异 F（把 `tried.add(activeAccountId)` 挪进 `if (recordsQoderRateLimit(cls))`）
     * 实测**全绿无牙** —— 正是这个原因。
     *
     * 而不传 `currentAccountId` 时 `activeAccountId` 为 `undefined`，那一句同样不执行
     * ⇒ 行为级**无论如何都造不出**「只有 switchAccountOnQuota 能排除」的局面。
     *
     * ## 故用源码级断言
     *
     * 守的不变式是「`tried.add(activeAccountId)` 必须在 `recordsQoderRateLimit` 的
     * `if` **外面**」。这是本仓库对「结构位置即语义」的既有做法
     * （见 `is-free-model-required.spec.ts` 的接线层用例）。
     *
     * ⚠️ 读源码用 `node:fs`（本文件已 import `readFileSync`）。
     */
    it('★★ 源码：tried.add 必须在 recordsQoderRateLimit 的 if 之外（不写冷却时唯一排除通道）', () => {
      const code = readFileSync(resolve(here, '../../src/qoder-adapter.ts'), 'utf8')
      // 取 switchAccountOnQuota 的方法体（从方法名到下一个 `\n  }` 收尾）
      const start = code.indexOf('private async switchAccountOnQuota(')
      expect(start, 'switchAccountOnQuota 必须存在').toBeGreaterThan(-1)
      const body = code.slice(start, code.indexOf('\n  }', start))
      // ① tried.add(activeAccountId) 必须在里面
      expect(body, 'switchAccountOnQuota 必须把失败账号加进 tried').toContain('tried.add(activeAccountId)')
      // ② 它不得被 `if (recordsQoderRateLimit(cls))` 包住 ——
      //    判据：recordsQoderRateLimit 的 if 块收尾 `}` 之后才出现 tried.add
      const recordsAt = body.indexOf('if (recordsQoderRateLimit(cls))')
      expect(recordsAt, '必须按类别决定写不写冷却').toBeGreaterThan(-1)
      const triedAt = body.indexOf('tried.add(activeAccountId)')
      expect(triedAt, 'tried.add 必须在 recordsQoderRateLimit 判定之后').toBeGreaterThan(recordsAt)
      // ③ 关键：两者之间的花括号必须**配平回 0**（即 tried.add 在那层 if 之外）
      const between = body.slice(recordsAt, triedAt)
      let depth = 0
      for (const ch of between) {
        if (ch === '{') depth += 1
        else if (ch === '}') depth -= 1
      }
      expect(depth, 'tried.add(activeAccountId) 不得被包在 recordsQoderRateLimit 的 if 内').toBe(0)
      // ④ **tried 所在行必须是独立语句**（堵住「单行无花括号 if」这种绕法）。
      //
      // ⚠️ 这条是补的：只查 ③ 时，把代码改成
      // `if (recordsQoderRateLimit(cls)) tried.add(activeAccountId)`（**无花括号**）
      // 实测**全绿无牙** —— 因为那种写法里 `between` 不含任何花括号，depth 恒为 0。
      // 单行 if 的「块」是行本身，花括号配平查不出来。
      const lineStart = body.lastIndexOf('\n', triedAt) + 1
      const triedLine = body.slice(lineStart, body.indexOf('\n', triedAt))
      expect(triedLine.trim(), 'tried.add(activeAccountId) 必须独占一行（不得挂在校验/条件语句尾部）')
        .toBe('tried.add(activeAccountId)')
    })

    /**
     * ⚠️ **对照用例**（证明上面那条不是「因为判据恒 true 而全绿」）：
     * 同样的池、同样的两账号，错误换成 400 参数错 ⇒ **不许换号、不许写冷却**。
     *
     * 没有这条，把 `shouldRotateQoderAccount` 写成 `return true` 也能全绿 ——
     * 那会把「参数错 / 风控页」也变成白烧整池。
     */
    it('对照：400 参数错不换号、不写冷却（判据不能恒真）', async () => {
      const { pool, marks, picks } = makePoolStub([
        { id: 'acct-A', token: 'tokA' },
        { id: 'acct-B', token: 'tokB' },
      ])

      let call = 0
      const fetchImpl = vi.fn(async () => {
        call += 1
        // 400 + 参数错误（**不是** provider_error 文案，也不是额度）
        return new Response(
          JSON.stringify({ error: { message: 'invalid parameter: max_tokens', type: 'invalid_request_error' } }),
          { status: 400, headers: { 'Content-Type': 'application/json' } },
        )
      }) as unknown as typeof fetch

      await expect(collectWith(makeAdapter({
        fetchImpl,
        accountPool: pool as never,
        currentAccountId: () => 'acct-A',
      }), { model: 'dfmodel', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }))
        .rejects.toMatchObject({ code: 'INVALID_REQUEST' })

      expect(call, '参数错不得换号（换号只会白烧整池）').toBe(1)
      expect(marks, '参数错不得写冷却').toEqual([])
      expect(picks, '参数错根本不该去取号').toEqual([])
    })

    /**
     * ⚠️ **反向守卫**：不能把所有 `SERVER` 都当 `provider_error`。
     *
     * `SERVER` 这个码很宽（500 也可能是「模型不支持该参数」「请求体过大」等
     * **换号解决不了**的情况）。判据必须窄到 `provider_error` 这类**结构字段值**。
     *
     * 没有这条，把 `looksLikeUpstreamProviderError` 写成 `return true` 也能全绿。
     */
    it('对照：普通 500（不含 provider_error）不换号', async () => {
      const { pool, marks, picks } = makePoolStub([
        { id: 'acct-A', token: 'tokA' },
        { id: 'acct-B', token: 'tokB' },
      ])

      let call = 0
      const fetchImpl = vi.fn(async () => {
        call += 1
        return new Response(
          JSON.stringify({ error: { message: 'internal server error', type: 'server_error' } }),
          { status: 500, headers: { 'Content-Type': 'application/json' } },
        )
      }) as unknown as typeof fetch

      await expect(collectWith(makeAdapter({
        fetchImpl,
        accountPool: pool as never,
        currentAccountId: () => 'acct-A',
      }), { model: 'dfmodel', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }))
        .rejects.toMatchObject({ code: 'SERVER' })

      expect(call, '普通 500 不换号').toBe(1)
      expect(marks, '普通 500 不得写冷却').toEqual([])
      expect(picks, '普通 500 根本不该去取号').toEqual([])
    })

    /**
     * 429（`RATE_LIMIT`）→ **换号 + 写 1h 冷却**。
     *
     * ⚠️ 与 `quota` 的「至 UTC+8 当日 24:00」**必须不同**：限流是秒级背压，
     * 按自然日写冷却会把账号封到明天（minimax / accio 都记过同型缺陷）。
     */
    it('429 限流：换号 + 写 1 小时冷却（不是当日 24:00）', async () => {
      const { pool, marks } = makePoolStub([
        { id: 'acct-A', token: 'tokA' },
        { id: 'acct-B', token: 'tokB' },
      ])

      let call = 0
      const before = Date.now()
      const fetchImpl = vi.fn(async () => {
        call += 1
        if (call === 1) {
          return new Response(JSON.stringify({ error: { message: 'too many requests' } }),
            { status: 429, headers: { 'Content-Type': 'application/json' } })
        }
        return envelopeResponse([textFrame('ok'), finishFrame])
      }) as unknown as typeof fetch

      await collectWith(makeAdapter({
        fetchImpl,
        accountPool: pool as never,
        currentAccountId: () => 'acct-A',
      }), { model: 'dfmodel', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })

      expect(marks.length, '429 应写冷却').toBe(1)
      // 1 小时（允许 5 秒抖动），而不是 24 小时
      const delta = marks[0].resetAtMs - before
      expect(delta).toBeGreaterThan(3_590_000)
      expect(delta).toBeLessThan(3_610_000)
    })

    /** 纯函数层：分类判据本身的 5 条（不依赖 stream）。 */
    it('classifyQoderFailure：五类各自的判据', () => {
      // 额度：码值
      expect(classifyQoderFailure('QUOTA_EXCEEDED', '')).toBe('quota')
      expect(classifyQoderFailure('QUOTA', '')).toBe('quota')
      // 额度：业务码 / 文案（code 为未知时走文案腿）
      expect(classifyQoderFailure('110', '')).toBe('quota')
      expect(classifyQoderFailure('112', '')).toBe('quota')
      expect(classifyQoderFailure('SERVER', 'Billing daily count exceeded')).toBe('quota')
      // 限流
      expect(classifyQoderFailure('RATE_LIMIT', '')).toBe('rate')
      // 认证
      expect(classifyQoderFailure('AUTH', '')).toBe('auth')
      // 上游供应商侧瞬时故障（真实报障形态）
      expect(classifyQoderFailure('SERVER', 'qodercn: Error in upstream response (provider_error/model_error)')).toBe('upstream')
      // 普通 500 不算（判据必须窄）
      expect(classifyQoderFailure('SERVER', 'internal server error')).toBe('other')
      // 参数错不算
      expect(classifyQoderFailure('INVALID_REQUEST', 'invalid parameter')).toBe('other')
      // ⚠️ `model_error` **单独**不算 `upstream`（它是 `[code, type].join('/')` 的拼接产物，
      //    任何 `SERVER` 都可能带它 —— 收它等于把整个 `SERVER` 都算进来）。
      //    ⚠️ 注意：`looksLikeUpstreamProviderError` 的正则含 `error\s+in\s+upstream\s+response`，
      //    而真实报障的文案就是 `Error in upstream response (model_error)` —— 那**是**
      //    provider_error 的形态（只是缺了 `provider_error` 字段），故归 `upstream`。
      expect(classifyQoderFailure('SERVER', 'Error in upstream response (model_error)')).toBe('upstream')
      // 但纯 `model_error`（无 upstream 字样）不算
      expect(classifyQoderFailure('SERVER', 'model_error')).toBe('other')
    })

    /**
     * ★★★ P1（2026-10-25 审计 B1-1）：**网关 5xx 必须换号**。
     *
     * ## 为什么这条比 `provider_error` 更重要
     *
     * 对抗审计扫了本机**全部 1374 个会话 / 163 条真实 qoder 失败**，按形态计数：
     *
     * | 真实形态 | 次数 |
     * |---|---|
     * | `qoder: <html>…504 Gateway Time-out…</html>` | **74** |
     * | `First Token Timeout or Upstream Timeout (504/model_error)` | **6** |
     * | `Error in upstream response (provider_error/model_error)` | 16 |
     *
     * 而旧判据（`looksLikeUpstreamProviderError`）**只认 `provider_error` 那类短语**
     * ⇒ 前两种（共 **80 次**，占主导）都落 `other` ⇒ **不换号**，且终态是
     * `SERVER`（在宿主 `DEFAULT_RETRYABLE_CODES` 里）⇒ **白重试 5 次**。
     * 本 PR 修的是较少见的 16 次，主导形态反而没修。
     *
     * ⚠️ 判据必须**窄**：只收「明确的网关/上游故障短语」，不能收到 `SERVER` 全体
     *   （那会把 400 参数错也变成可换号）。
     * ⚠️ 两个方向都要用例：`504 Gateway Time-out` 要换号；`504 + billing 文案`
     *   仍必须归 `quota`（额度腿优先，不能被新判据抢走）。
     */
    it('★★★ P1：网关 5xx（504 HTML / 上游超时）必须归 upstream（换号、不写冷却）', () => {
      // 真实形态 ①（74 次）：网关 HTML 错误页
      const html504 = 'qoder: <html><head><title>504 Gateway Time-out</title></head><body>…</body></html>'
      expect(classifyQoderFailure('SERVER', html504), '504 HTML 未归 upstream').toBe('upstream')
      // 真实形态 ②（6 次）：上游首 token 超时
      const upstreamTimeout = 'qoder: First Token Timeout or Upstream Timeout (504/model_error)'
      expect(classifyQoderFailure('SERVER', upstreamTimeout), '上游超时未归 upstream').toBe('upstream')
      // 同族的其它网关形态
      expect(classifyQoderFailure('SERVER', '<html>502 Bad Gateway</html>')).toBe('upstream')
      expect(classifyQoderFailure('SERVER', '503 Service Unavailable')).toBe('upstream')

      // ⚠️ 反向 ①：新判据**不得**把额度腿抢走
      expect(classifyQoderFailure('SERVER', '504 Gateway Time-out: Billing daily count exceeded'))
        .toBe('quota')
      // ⚠️ 反向 ②：仍必须是窄判据 —— 泛化 5xx/错误词不得变成 upstream
      expect(classifyQoderFailure('SERVER', 'internal server error')).toBe('other')
      expect(classifyQoderFailure('SERVER', 'request timeout')).toBe('other')
      expect(classifyQoderFailure('SERVER', 'upstream connection reset by peer')).toBe('other')
      // ⚠️ 反向 ③：非 SERVER 码即使带这句话也不认（与 provider_error 同纪律）
      expect(classifyQoderFailure('INVALID_REQUEST', '504 Gateway Time-out')).toBe('other')
    })

    it('shouldRotateQoderAccount / recordsQoderRateLimit：两张表必须不同', () => {
      // 换号：除 `other` 外都换
      expect(shouldRotateQoderAccount('quota')).toBe(true)
      expect(shouldRotateQoderAccount('rate')).toBe(true)
      expect(shouldRotateQoderAccount('auth')).toBe(true)
      expect(shouldRotateQoderAccount('upstream')).toBe(true)
      expect(shouldRotateQoderAccount('other')).toBe(false)
      // 写冷却：只有额度与限流
      expect(recordsQoderRateLimit('quota')).toBe(true)
      expect(recordsQoderRateLimit('rate')).toBe(true)
      expect(recordsQoderRateLimit('auth'), 'auth 绝不写冷却（全池被封事故）').toBe(false)
      expect(recordsQoderRateLimit('upstream'), 'upstream 绝不写冷却（瞬时故障）').toBe(false)
      expect(recordsQoderRateLimit('other')).toBe(false)
    })
  })
})

/**
 * ## 真实报障（用户 2026-10-21 贴出的原始文案）
 *
 * ```
 * 本轮运行失败aggregate: qodercn（dfmodel）上游失败：
 *   qoder: Error in upstream response (provider_error/model_error) code=SERVER
 * ```
 *
 * ⚠️ **同一句里出现了两个渠道名**：外层是聚合层写的 `qodercn`（东八区中国版），
 * 内层却是 `qoder`（国际版）。两个渠道的**凭据、端点、额度池完全不同**，
 * 排查时看到 `qoder:` 会去查国际版的账号 —— 而真实故障在中国版上。
 *
 * 根因：`QoderAdapter` 是**两站共用**的一个类（只靠 `options.product` 区分），
 * 而三处报错前缀全被写成了字面量 `'qoder'`：
 * ① 两个 HTTP 失败分支；② 信封剥离函数的第二个实参；③ SSE 消费器的 `label` 选项。
 *
 * ⇒ 修法：统一取 `this.product.id`。国际版输出**逐字节不变**，中国版从此说自己的名字。
 *
 * ⚠️ 这个缺陷**不影响功能**（错误照样抛、照样可重试、聚合照样换候选），
 * 只影响**归因**。但本仓库反复出现的正是这类「功能对、归因错」的坑
 * （见 AGENTS.md 第 9 条 qoder `110` 被归 `SERVER` 的案例）——故必须有守卫。
 */
describe('报错前缀必须取自 product.id（不许硬编码 qoder）', () => {
  /** 让 HTTP 层失败：回 500（`httpErrorCode` 映射成 `SERVER`）。 */
  function failResponse(status: number, body = 'upstream boom'): Response {
    return new Response(body, { status, headers: { 'Content-Type': 'text/plain' } })
  }

  /** 让 SSE 层失败：HTTP 200 + 内嵌错误帧（与真实链路同形态）。 */
  function sseErrorResponse(inner: string): Response {
    const payload = `data:${JSON.stringify({
      headers: { 'Content-Type': ['application/json'] },
      body: inner,
      statusCodeValue: 200,
      statusCode: 'OK',
    })}\n\n`
    return new Response(payload, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
  }

  it.each([
    ['qoder', QODER],
    ['qodercn', QODER_CN],
  ] as const)('%s：HTTP 层失败的文案用 %s 开头', async (providerId, product) => {
    const adapter = makeAdapter({
      product,
      fetchImpl: (async () => failResponse(500)) as unknown as typeof fetch,
    })
    await expect(collectWith(adapter, { model: 'dfmodel', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }))
      .rejects.toMatchObject({
        message: expect.stringContaining(`${providerId}: `) as never,
      })
  })

  it('★ 中国版 HTTP 层失败：文案是 qodercn，绝不能是 qoder', async () => {
    const adapter = makeAdapter({
      product: QODER_CN,
      fetchImpl: (async () => failResponse(500)) as unknown as typeof fetch,
    })
    let message = ''
    try {
      await collectWith(adapter, { model: 'dfmodel', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })
    } catch (error) {
      message = (error as Error).message
    }
    // ⚠️ 两个断言都要有：第一条守「说对了」，第二条守「没再说错」。
    // 只写第一条时，`qodercn: … qoder: …` 这种**同时含两个名字**的文案会漏过。
    expect(message, '中国版的报错必须自称 qodercn').toContain('qodercn: ')
    expect(message, '中国版的报错不得出现 qoder: 前缀（那会指向国际版）')
      .not.toMatch(/(?:^|\s)qoder: /)
  })

  it('★ 真实形态：SSE 内嵌 provider_error 帧，文案带对的渠道名', async () => {
    // 用户贴出的真实内层帧（`code` 为空、`type` 为 `model_error`，
    // 故 `openai-compat` 拼出的后缀恰好是 `provider_error/model_error`）。
    const inner = JSON.stringify({
      code: 'provider_error',
      message: 'Error in upstream response',
      type: 'model_error',
    })
    const adapter = makeAdapter({
      product: QODER_CN,
      fetchImpl: (async () => sseErrorResponse(inner)) as unknown as typeof fetch,
    })
    let message = ''
    try {
      await collectWith(adapter, { model: 'dfmodel', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })
    } catch (error) {
      message = (error as Error).message
    }
    expect(message, 'SSE 消费器的 label 也必须取自 product.id').toContain('qodercn: ')
    expect(message).not.toMatch(/(?:^|\s)qoder: /)
    // 上游原文必须保真（本仓「错误保真」红线）
    expect(message).toContain('Error in upstream response')
    expect(message).toContain('provider_error/model_error')
  })

  it('★ 国际版输出逐字节不变（改名不得改变既有文案）', async () => {
    const adapter = makeAdapter({
      product: QODER,
      fetchImpl: (async () => failResponse(500, 'upstream boom')) as unknown as typeof fetch,
    })
    let message = ''
    try {
      await collectWith(adapter, { model: 'dfmodel', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })
    } catch (error) {
      message = (error as Error).message
    }
    expect(message, '国际版的既有文案必须保持原样').toBe('qoder: upstream boom')
  })

  it('★ 续期后凭据仍为空：AUTH 分支的文案也带对的渠道名', async () => {
    // 走到那条 AUTH 需要一个特定序列：401 → 续期 → **续期后仍拿不到凭据**。
    // 这是「凭据彻底失效」的真实形态（refresh 成功但服务端不再发 token）。
    let call = 0
    const adapter = makeAdapter({
      product: QODER_CN,
      // 第一次返回 cred（供入口取号），之后一律返回「空 token」的凭据。
      resolveCredential: async () => {
        call += 1
        return call === 1 ? cred : { ...cred, access_token: '' }
      },
      fetchImpl: (async () => failResponse(401, 'auth failed')) as unknown as typeof fetch,
    })
    let message = ''
    try {
      await collectWith(adapter, { model: 'dfmodel', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })
    } catch (error) {
      message = (error as Error).message
    }
    expect(message, 'AUTH 分支必须自称 qodercn').toContain('qodercn: credential expired and refresh failed')
    expect(message).not.toMatch(/(?:^|\s)qoder: /)
  })

  it('源码里不得再有硬编码的三处 qoder 前缀（反向守卫，防改回去）', () => {
    const code = readFileSync(resolve(here, '../../src/qoder-adapter.ts'), 'utf8')
    // ① 两个 HTTP 失败分支曾写 `qoder: ${errorDetail(...)}`
    expect(code, 'HTTP 失败文案又硬编码了 qoder')
      .not.toContain('`qoder: ${errorDetail(')
    // ② 曾写 `unwrapQoderEnvelopeStream(response, \'qoder\')`
    expect(code, '信封标签又硬编码了 qoder')
      .not.toContain("unwrapQoderEnvelopeStream(response, 'qoder')")
    // ③ 曾写 `label: 'qoder',`
    expect(code, 'SSE 消费器标签又硬编码了 qoder')
      .not.toMatch(/label:\s*'qoder'/)
    // 且必须真的从 product.id 取（正向断言，否则删掉那一行也会全绿）
    expect(code, '必须从 product.id 取标签').toContain('const label = this.product.id')
  })
})

/**
 * issue IKR5ZD（2026-10-28）：`qoder: transport error: fetch failed`。
 *
 * 三条指控与本地取证：
 * 1. 到 `api2.qoder.sh` 的 **10s 超时** —— 不是插件设的，是 undici 的默认
 *    `connectTimeout`（实测 10,713ms，`UND_ERR_CONNECT_TIMEOUT`）；
 * 2. **重试不换 IP** —— 成立且更硬：该域名 2 个 A 记录，但 `dns.lookup` 只回第一个，
 *    连打 8 次建连全部落在同一 IP；而适配器对 transport 错误**零换号**，
 *    宿主又把 `TRANSPORT` 当可重试码（5 次）⇒ 6 发全打同一条出口；
 * 3. **错误丢失 cause** —— `LlmError.cause` 一直挂着，但 message 只有
 *    `fetch failed`，可操作的 `attempted address / timeout` 在两级 `cause` 之下。
 *
 * 本组锁住修法：**先换号（换出口）→ 换不到才同号退避 → 预算耗尽抛原错误**，
 * 并把 `cause` 链拼进 message。
 */
describe('传输级失败：换号优先 + 同号退避 + cause 可读（issue IKR5ZD）', () => {
  /** Node/undici 在 connect 超时时抛的真实形态。 */
  const connectTimeout = (ip = '47.57.188.188'): TypeError => new TypeError('fetch failed', {
    cause: Object.assign(
      new Error(`Connect Timeout Error (attempted address: ${ip}:443, timeout: 10000ms)`),
      { code: 'UND_ERR_CONNECT_TIMEOUT' },
    ),
  })
  const specCredB = buildQoderCredential(
    parseQoderTokenPayload({ token: 'tok-b', refresh_token: 'ref-b', user_id: 'uid-2' }),
    { machineId: 'm-2' })

  it('★ 传输失败 ⇒ 换第二个账号重发（换号 = 换出口），且不写冷却标记', async () => {
    let calls = 0
    const fetchImpl = vi.fn(async () => {
      calls += 1
      if (calls === 1) throw connectTimeout()
      return envelopeResponse([textFrame('好的'), finishFrame])
    })
    const rateLimited: string[] = []
    let poolQueries = 0
    let askedTried: Set<string> | undefined
    const adapter = makeAdapter({
      fetchImpl: fetchImpl as never,
      currentAccountId: () => 'acct-A',
      accountPool: {
        getAvailableAccount: async (
          _provider: string,
          _model: string,
          tried?: Set<string>,
        ) => {
          poolQueries += 1
          askedTried = tried
          return { entry: { id: 'acct-B' }, credential: specCredB }
        },
        updateModelRateLimit: async (id: string) => { rateLimited.push(id) },
      } as never,
    })

    const chunks = await collect(adapter)
    expect(calls, '传输失败后应换号重发一次').toBe(2)
    expect(askedTried?.has('acct-A'), '换号时必须把上一个账号放进 tried（否则会拿回同一个）').toBe(true)
    expect(rateLimited, 'transport 是出口问题，写冷却会把健康账号封到当天 24 点').toEqual([])
    expect(poolQueries, '换号必须真的问过池').toBe(1)
    expect(chunks.length).toBeGreaterThan(0)
    /**
     * ⚠️ **不要**用「两发 `Authorization` 不同」当换号判据（2026-10-31 审计打穿）：
     * COSY 载荷每次带新的 `requestId`，**同一账号连发两次也必然不同** ⇒ 断言恒真，
     * 连「换回同一个号」的变异都能过。真正证明「用的是池返回的那份凭据」靠下面
     * 那条缺 `uid` 的用例（`ensureUid` 会抛 MISSING_CREDENTIAL）。
     */
  })

  it('★ 换号必须换出口：`fetchFor` 依次收到 acct-A / acct-B（生产的 per-账号代理腿）', async () => {
    /**
     * ⚠️ 必要性（2026-10-31 对抗审计 m12）：本文件其余用例都注入 `fetchImpl`
     * ——它的优先级**压过** `fetchFor`，于是「换号后出口跟不跟着换」这条**生产腿
     * 从来没被执行过**。把那行 `fetcherForCurrentAccount()` 提到循环外固化，
     * 全部 124 条仍绿，而线上症状是「换了号还走旧账号的代理，照样超时」且**零报错**。
     * ⇒ 这里刻意**不注入 `fetchImpl`**，只给 `fetchFor`，直接观测出口。
     */
    const seen: string[] = []
    let calls = 0
    const perAccountFetch = async () => {
      calls += 1
      if (calls === 1) throw connectTimeout()
      return envelopeResponse([textFrame('好的'), finishFrame])
    }
    const adapter = makeAdapter({
      fetchFor: (accountId: string) => { seen.push(accountId); return perAccountFetch as never },
      currentAccountId: () => 'acct-A',
      accountPool: {
        getAvailableAccount: async () => ({ entry: { id: 'acct-B' }, credential: specCredB }),
        updateModelRateLimit: async () => {},
      } as never,
    })

    await collect(adapter)
    expect(seen, '换号后 fetcher 必须按新账号现取（否则出口没换）').toEqual(['acct-A', 'acct-B'])
  })

  it('★ 换号后真的使用池返回的那份凭据（缺 uid ⇒ 抛 MISSING_CREDENTIAL，而非继续用旧号）', async () => {
    // 判别力：`switchAccountOnQuota` 会对**池返回的**凭据跑 `ensureUid`。给它一份
    // **没有 uid** 的凭据、且不提供 `resolveUid` ⇒ 必然抛 MISSING_CREDENTIAL。
    // 若变异成「不换号」，这里会抛 TRANSPORT 而不是这个码 ⇒ 变红。
    // （加密头带随机 requestId，没法用 Authorization 区分两份凭据。）
    const noUid = buildQoderCredential(
      parseQoderTokenPayload({ token: 'tok-c', refresh_token: 'ref-c' }), // 无 user_id
      { machineId: 'm-3' })
    let calls = 0
    const adapter = makeAdapter({
      fetchImpl: (async () => { calls += 1; throw connectTimeout() }) as never,
      currentAccountId: () => 'acct-A',
      accountPool: {
        getAvailableAccount: async () => ({ entry: { id: 'acct-C' }, credential: noUid }),
        updateModelRateLimit: async () => {},
      } as never,
    })

    const error = await collect(adapter).then(() => undefined, (e: unknown) => e)
    expect(calls, '第一发之后就换号，不该有第二发').toBe(1)
    expect((error as { code?: string }).code).toBe('MISSING_CREDENTIAL')
  })

  it('★ 无第二个账号 ⇒ 立即抛原错误（不原地空转），message 带 cause 详情', async () => {
    let calls = 0
    let poolQueries = 0
    // 固定一个实例，供「cause 必须是同一个对象」断言。
    const thrown = connectTimeout()
    const fetchImpl = vi.fn(async () => {
      calls += 1
      throw thrown
    })
    const adapter = makeAdapter({
      fetchImpl: fetchImpl as never,
      currentAccountId: () => 'acct-A',
      accountPool: {
        getAvailableAccount: async () => { poolQueries += 1; return null },
        updateModelRateLimit: async () => {},
      } as never,
    })

    const error = await collect(adapter).then(() => undefined, (e: unknown) => e)
    expect(error, '应当抛错').toBeInstanceOf(Error)
    expect(poolQueries, '换不到号也必须**先问过池**，不能跳过换号直接抛').toBe(1)
    // ⚠️ `cause` 必须是**最初那个错误对象本身**（不是同类型的新对象）——
    //    否则「重新包一层」的变异也能过（对抗审计 m16 实测全绿）。
    expect((error as { cause?: unknown }).cause, 'cause 必须是原始错误对象').toBe(thrown)
    const err = error as Error & { code?: string; cause?: unknown }
    expect(calls, '换不到号就只发一发（同号空转对阻断路由无效，宿主会退避重试）').toBe(1)
    expect(err.code).toBe('TRANSPORT')
    expect(err.message, '消息必须带可操作信息，不能只有 fetch failed').toContain('UND_ERR_CONNECT_TIMEOUT')
    expect(err.message).toContain('attempted address: 47.57.188.188:443')
    expect(err.cause, '原始错误必须挂在 cause 上（程序化排查要用）').toBeInstanceOf(TypeError)
  })

  it('★ 换号期间池自己抛错 ⇒ 仍抛原始 TRANSPORT（pool 的错误不得顶掉 cause）', async () => {
    let calls = 0
    const thrown = connectTimeout()
    const adapter = makeAdapter({
      fetchImpl: (async () => { calls += 1; throw thrown }) as never,
      currentAccountId: () => 'acct-A',
      accountPool: {
        getAvailableAccount: async () => { throw new Error('pool read failed') },
        updateModelRateLimit: async () => {},
      } as never,
    })

    const error = await collect(adapter).then(() => undefined, (e: unknown) => e)
    expect((error as { code?: string }).code, '用户看到的必须是 TRANSPORT，不是裸 pool Error').toBe('TRANSPORT')
    expect((error as { cause?: unknown }).cause, 'cause 必须保住最初的错误对象').toBe(thrown)
  })

  it('★ 连续换号仍失败 ⇒ 用满预算就抛（3 发封顶），不会换到没号为止', async () => {
    let calls = 0
    let next = 1
    const fetchImpl = vi.fn(async () => {
      calls += 1
      throw connectTimeout()
    })
    const adapter = makeAdapter({
      fetchImpl: fetchImpl as never,
      currentAccountId: () => 'acct-A',
      accountPool: {
        getAvailableAccount: async () => {
          next += 1
          return { entry: { id: `acct-${next}` }, credential: specCredB }
        },
        updateModelRateLimit: async () => {},
      } as never,
    })

    const error = await collect(adapter).then(() => undefined, (e: unknown) => e)
    expect((error as { code?: string }).code).toBe('TRANSPORT')
    // ⚠️ 期望值必须写字面量：写 `1 + QODER_TRANSPORT_MAX_RETRIES` 会与实现**同源**
    //    —— 把常量改成 20 时两边一起变、断言恒真（对抗审计实测该变异绿）。
    expect(QODER_TRANSPORT_MAX_RETRIES, '预算值本身也要被锁住').toBe(2)
    expect(calls, '首发 + 预算 2 次换号 = 3 发；再多就会让「完全离线」拖成分钟级').toBe(3)
  })

  it('★ abort 后一发都不重试（用户点了停止还继续发是不可接受的）', async () => {
    const controller = new AbortController()
    let calls = 0
    const fetchImpl = vi.fn(async () => {
      calls += 1
      // ⚠️ 必须**在 fetch 内部** abort 再抛传输错误，才能观测到那条早退：
      //    若在调用前就 abort，`sendEncrypted` 自己会先 rethrow 原错误
      //    （非 TRANSPORT）⇒ 适配器根本走不到重试分支 ⇒ 该守卫不可观测
      //    （对抗审计实测：那种写法下「删掉 abort 早退」仍全绿）。
      controller.abort()
      throw connectTimeout()
    })
    const adapter = makeAdapter({
      fetchImpl: fetchImpl as never,
      currentAccountId: () => 'acct-A',
      accountPool: {
        getAvailableAccount: async () => ({ entry: { id: 'acct-B' }, credential: specCredB }),
        updateModelRateLimit: async () => {},
      } as never,
    })

    await collectWith(adapter, {
      model: 'auto',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      signal: controller.signal,
    }).catch(() => undefined)
    expect(calls, 'abort 后不得重试').toBe(1)
  })

  it('★ 非传输错误不得被当成传输失败重发（只重试「连不上」，不重试「连上了但错」）', async () => {
    /**
     * ⚠️ 原先这里写的是「HTTP 500 不重试」—— **没有判别力**（2026-10-31 审计实测）：
     * `Response('boom',{status:500})` 被 `classifyQoderFailure('SERVER','boom')` 归
     * `other` ⇒ 本来就不换号；且 500 的 `LlmError` 是在新 `try` **之外**的 status
     * 分支抛的，新的 catch 根本看不到它。真正该锁的不变式在**更内层**：`fetch`
     * 抛出**非传输**错误时，`sendEncrypted` 不得把它包装成 TRANSPORT，也就不会进
     * 重试分支。
     */
    let calls = 0
    const adapter = makeAdapter({
      fetchImpl: (async () => { calls += 1; throw new Error('boom') }) as never,
      currentAccountId: () => 'acct-A',
      accountPool: {
        getAvailableAccount: async () => ({ entry: { id: 'acct-B' }, credential: specCredB }),
        updateModelRateLimit: async () => {},
      } as never,
    })

    const error = await collect(adapter).then(() => undefined, (e: unknown) => e)
    expect((error as Error).message, '普通 Error 必须原样冒出去，不能被包装成 TRANSPORT').toBe('boom')
    expect((error as { code?: string }).code, '不得变成 TRANSPORT').not.toBe('TRANSPORT')
    expect(calls, '非传输错误一发即止').toBe(1)
  })

  it('transportErrorDetail：沿 cause 链拼装、去重、限深、自引用不死循环、代理口令脱敏', () => {
    const deep = new TypeError('fetch failed', {
      cause: Object.assign(new Error('Connect Timeout Error (attempted address: 8.8.8.8:443, timeout: 10000ms)'),
        { code: 'UND_ERR_CONNECT_TIMEOUT' }),
    })
    expect(transportErrorDetail(deep)).toBe(
      'fetch failed ← UND_ERR_CONNECT_TIMEOUT: Connect Timeout Error '
      + '(attempted address: 8.8.8.8:443, timeout: 10000ms)')

    // 自引用 cause：必须收敛，不能死循环
    const loop = new Error('self') as Error & { cause?: unknown }
    loop.cause = loop
    expect(transportErrorDetail(loop)).toBe('self')

    // 无 cause 时原样返回
    expect(transportErrorDetail(new Error('boom'))).toBe('boom')
    // cause 是字符串 / 普通对象（非 Error）：不得抛，且要带上
    const strCause = new TypeError('fetch failed') as Error & { cause?: unknown }
    strCause.cause = 'raw string cause'
    expect(transportErrorDetail(strCause)).toBe('fetch failed ← raw string cause')
    const objCause = new TypeError('fetch failed') as Error & { cause?: unknown }
    objCause.cause = { code: 'E' }
    expect(transportErrorDetail(objCause)).toBe('fetch failed ← [object Object]')
    // 深链只取 4 层
    const chain = (n: number): Error => {
      const e = new Error(`L${n}`) as Error & { cause?: unknown }
      if (n > 1) e.cause = chain(n - 1)
      return e
    }
    expect(transportErrorDetail(chain(6))).toBe('fetch failed ← L5 ← L4 ← L3 ← L2'.replace('fetch failed', 'L6'))
    // 相邻重复去重
    const dup = new Error('A') as Error & { cause?: unknown }
    dup.cause = new Error('B') as Error & { cause?: unknown }
    ;(dup.cause as Error & { cause?: unknown }).cause = new Error('B')
    expect(transportErrorDetail(dup)).toBe('A ← B')
    // 2 跳自引用不发散
    const two = new Error('A') as Error & { cause?: unknown }
    const mid = new Error('B') as Error & { cause?: unknown }
    two.cause = mid
    mid.cause = two
    expect(transportErrorDetail(two)).toBe('A ← B')
    // code 是 Symbol：装饰函数自己不能抛（否则会顶替原始错误）
    const symCode = new TypeError('fetch failed') as Error & { cause?: unknown }
    symCode.cause = Object.assign(new Error('weird'), { code: Symbol('S') })
    expect(() => transportErrorDetail(symCode)).not.toThrow()
    // 超长 message 截断（否则 10 万字符会原样进日志/UI）
    const longCause = new TypeError('fetch failed') as Error & { cause?: unknown }
    longCause.cause = new Error('x'.repeat(100_000))
    expect(transportErrorDetail(longCause).length).toBeLessThanOrEqual(513)

    // 代理口令必须脱敏（哪怕地址夹在句子中间 —— 锚定版会在这里静默漏网）
    const withProxy = new TypeError('fetch failed', {
      cause: new Error('proxy refused: http://alice:s3cr3t@10.0.0.1:8080'),
    })
    expect(transportErrorDetail(withProxy)).not.toContain('s3cr3t')
    expect(transportErrorDetail(withProxy)).toContain('http://alice:***@10.0.0.1:8080')
    // ⚠️ **含空白的脏值也必须遮**（2026-10-31 审计实测的安全回退：把字符类写成
    //    `[^:@/\s]` 会让 `http://a b:s3cr3t@h:1` 明文泄漏；池的 `proxyLogText`
    //    明确接收「备份文件原样透传的脏值」）。
    const dirty = new TypeError('fetch failed', {
      cause: new Error('proxy: http://a b:s3cr3t@h:1 与 http://u:p a@h'),
    })
    expect(transportErrorDetail(dirty)).not.toContain('s3cr3t')
    expect(transportErrorDetail(dirty)).not.toContain('p a@')
  })
})
