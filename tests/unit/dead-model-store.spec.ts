import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ⚠️ 必须在 import 被测模块**之前**设好隔离目录：模块级 store / cache 是懒初始化的，
// 首次解析 home 时会读这个环境变量（`resolveJetHubHome` 的第一优先级）。
const STATE_DIR = mkdtempSync(join(tmpdir(), 'dsh-dead-model-spec-'))
process.env.DSH_JET_HUB_STATE_DIR = STATE_DIR

const {
  DEAD_MODELS_FILE,
  clearDeadModels,
  configureDeadModelStore,
  deadModelIdsFor,
  isModelGoneError,
  recordDeadModel,
  withDeadModelPruning,
} = await import('../../src/dead-model-store.js')

afterAll(() => {
  rmSync(STATE_DIR, { recursive: true, force: true })
  delete process.env.DSH_JET_HUB_STATE_DIR
})

// ── 1. 判据：阳性证据 ──────────────────────────────────────────────────────

describe('isModelGoneError —— 应判为「模型已失效」', () => {
  const positives: Array<[string, string, string | undefined]> = [
    ['cline 报障原文', 'cline: model not found', 'HTTP_404'],
    ['unknown model 变体', 'provider: unknown model gpt-x', 'HTTP_400'],
    ['does not exist', 'model foo does not exist', 'HTTP_404'],
    ['does not exist（缩写）', "model foo doesn't exist", 'HTTP_404'],
    ['no such model', 'no such model: abc', 'HTTP_400'],
    ['中文：模型不存在', '模型 deepseek-x 不存在', 'HTTP_404'],
    ['中文：已下线', '该模型已下线', 'HTTP_400'],
    ['中文：长 id（窗口必须够宽）', '模型 deepseek-v4.1-flash-preview 不存在', 'HTTP_404'],
    // ⚠️ 2026-11-16（PR #92 正向审计 P2-1）：魔搭「模型已下线」的**唯一**阳性信号
    //    长这样 —— 主语与语义之间插着 `id : <id> ,`，`matchesGonePhrase` 的紧邻
    //    锚定匹配不到 ⇒ 只能新增独立 `GONE_PATTERNS` 条目（塞进 `GONE_TAIL` 无效，
    //    它被 `^` 锚定拼装）。三种真实形状逐字取自实测报文。
    ['魔搭：has no provider supported（带前缀）', 'modelscope: HTTP 400 - {"message":"Model id : deepseek-ai/DeepSeek-V4-Pro , has no provider supported"}', 'HTTP_400'],
    ['魔搭：has no provider supported（裸报文）', 'Model id : deepseek-ai/DeepSeek-V4-Pro , has no provider supported', undefined],
    ['魔搭：has no provider supported（中文前缀）', 'modelscope 请求失败：HTTP 400 {"message":"Model id : Qwen/Qwen3.5-27B , has no provider supported"}', 'HTTP_400'],
    // ⚠️ 以下 6 条是 2026-10-06 复审 !66 补的回归：初版**全部漏判**。
    // 根因：英文正则的窗口字符类 `[^.!?]` 把**点号**当句子结束符，而本仓库
    // 几乎所有模型 id 都带小数点 ⇒ 英文路径对带点 id 全部失效。
    ['★英文 + 带点 id（点号阻断回归）', 'model deepseek-v4.1-flash 不存在', 'HTTP_404'],
    ['★英文 + 带点 id（已下线）', 'model deepseek-v4.1-flash 已下线', 'HTTP_404'],
    ['★英文 + 带点 id（does not exist）', 'The model gpt-5.6-astra does not exist', 'HTTP_404'],
    ['★英文 + 带点 id（反引号包裹）', 'The model `gpt-5.6-astra` does not exist', 'HTTP_404'],
    ['★英文 + 带点 id（双引号包裹）', 'model "deepseek-v4.1-flash" does not exist', 'HTTP_404'],
    ['★最长真实 id（37 字符）', 'model cline-free/muse-spark-1.3-contributor does not exist', 'HTTP_404'],
    ['★最长真实 id（中文路径）', '模型 cline-free/muse-spark-1.3-contributor 不存在', 'HTTP_404'],
    ['★OpenAI 标准 code 形态', 'model_not_found', 'HTTP_404'],
    ['★下划线形态（大小写）', 'MODEL_NOT_FOUND', 'HTTP_404'],
    ['★连字符形态', 'model-not-found', 'HTTP_404'],
    // ⚠️ 排除词必须带词边界，否则误杀正常下架文案。
    ['★模型名含 expired（边界回归）', 'model expired-v3 does not exist', 'HTTP_404'],
    // ⚠️ 「id 后紧邻不存在语义」的反向形态：主语与 id 之间可以是
    // 「无引号 / 双引号紧贴 / 反引号两侧带空格」三种，都必须命中。
    ['★反引号两侧带空格', 'The model `gpt-5.6-astra` does not exist', 'HTTP_404'],
    ['★双引号紧贴', 'model "deepseek-v4.1-flash" does not exist', 'HTTP_404'],
  ]
  for (const [label, message, code] of positives) {
    it(label, () => {
      expect(isModelGoneError(Object.assign(new Error(message), code === undefined ? {} : { code }))).toBe(true)
    })
  }
})

describe('isModelGoneError —— 必须**不**判为模型失效（误判会藏掉可用模型）', () => {
  /**
   * ⚠️ 误判的代价是不对称的：把可用模型记成失效会把它从列表里藏起来，且
   * **用户无法自行恢复**（选不到 ⇒ 不可能再成功 ⇒ 记录不会清）。故这一组
   * 覆盖所有「看着像但其实不是」的形态。
   */
  const negatives: Array<[string, string, string | undefined]> = [
    ['额度用尽（含 model 字样）', '模型额度已用尽，请充值', 'QUOTA_EXCEEDED'],
    ['额度用尽（无错误码兜底）', 'this model quota is insufficient', undefined],
    ['限流', 'rate limit exceeded for model x', 'RATE_LIMIT'],
    ['限流（429 文案）', 'Error 429: Daily free limit reached on model deepseek-v4.1-flash', 'HTTP_429'],
    ['认证失败', 'invalid api key for model x', 'AUTH'],
    ['权限拒绝', 'model x forbidden', 'PERMISSION_DENIED'],
    ['凭据缺失', 'model x: no usable credential', 'MISSING_CREDENTIAL'],
    ['排队', '模型繁忙，请排队重试', 'QUEUE'],
    ['网络错误', 'transport error: socket hang up', 'TRANSPORT'],
    // ⚠️ 2026-11-16：`has no provider supported` 足够专有，但同义的
    //    「换套餐就能恢复」形态必须仍然 false —— 记成下架会 30 天内都不可用。
    ['未开通（is not supported）', 'the model gpt-x is not supported', 'PERMISSION_DENIED'],
    ['未开通（需更高套餐）', 'this model requires a higher plan, currently not supported', 'PERMISSION_DENIED'],
    ['功能不支持', 'model x does not support tool calls', 'INVALID_REQUEST'],
    ['账号均不可用（含模型名）', 'cline: 模型 deepseek-x 的所有账号均不可用 —— 请稍后', 'QUOTA_EXCEEDED'],
    ['账号均不可用（无错误码兜底）', '模型 abc 的所有账号均不可用', undefined],
    // ⚠️ 「不可用」绝不能当下架：账号类报错全这么说。初版刻意不收它，
    // 这里加回归锁死该取舍（它是「宁可漏判不可误伤」的典型）。
    ['★裸「不可用」不判下架', '模型 xxx 不可用', 'HTTP_403'],
    ['★裸「所有账号均不可用」不判下架', '所有账号均不可用', 'HTTP_403'],
    ['参数错误（非下架）', 'invalid model parameters: temperature', 'INVALID_REQUEST'],
    ['模型名含 model 但是参数问题', 'unsupported model feature: tools', 'INVALID_REQUEST'],
    // ⚠️⚠️ 以下 6 条是 2026-10-06 复审 !66 补的回归：初版**全部误判为下架**。
    // 根因：GONE_PATTERNS 初版把 `available` / `supported` 与 `found`/`exist`
    // 并列，于是「换套餐 / 换地域 / 换端点就能恢复」的问题被当成模型下架 ——
    // 而误判后模型被藏 30 天且用户**无法自愈**，代价最高。
    // ⚠️ 与文件头「`unsupported` 单独出现不算」的口径本来就不一致。
    ['★套餐限制（换套餐可恢复）', 'cline: model not supported in this plan', 'INVALID_REQUEST'],
    ['★工具能力限制', 'model not supported by tool use', 'INVALID_REQUEST'],
    ['★地域限制（换区可恢复）', 'model not available in your region', 'INVALID_REQUEST'],
    ['★思考档位不支持', 'the selected model is not available for reasoning', 'INVALID_REQUEST'],
    ['★端点不支持', 'model not supported for this endpoint', 'INVALID_REQUEST'],
    ['★能力开关', 'model not supported: thinking', 'INVALID_REQUEST'],
    // ⚠️ 中文同理：「不支持」绝不能当下架。
    ['★中文不支持', '模型 xxx 不支持该功能', 'INVALID_REQUEST'],
    // ⚠️⚠️ 跨句误判回归（2026-10-06 复审实测）：把判据窗口从 `[^.!?]{0,24}`
    // 放宽到 64 以容纳带小数点的 id 时，**引入了这三类误判** ——
    // `model` 出现在前半句、「does not exist」说的是**别的**东西。
    // 修法是改为「先抽 id、再要求**紧邻**」，而不是继续加长窗口。
    ['★跨句：后半句说的是镜像不是模型', 'model x is fine. the container image does not exist', 'SERVER'],
    ['★跨句：分号后的从句', 'the config file model list is fine; however this build does not exist on the server', 'SERVER'],
    ['★跨句：配置项列表 vs 不存在的构建', 'model list ok. the bundle does not exist', 'SERVER'],
    // ⚠️⚠️ `model_not_found` 在**遥测/日志**里常是**字段名**，后面紧跟别的内容
    // （2026-10-06 复审实测）。只加 `\b` 词边界不够 —— 它会把**可用模型藏 30 天**。
    ['★遥测字段名（不是错误）', 'error_class=model_not_found, retry allowed', 'SERVER'],
    ['★指标名（不是错误）', 'the model_not_found metric was not exported', 'SERVER'],
    ['★作为别名前缀', 'model_not_found_reason=upstream', 'SERVER'],
  ]
  for (const [label, message, code] of negatives) {
    it(label, () => {
      expect(isModelGoneError(Object.assign(new Error(message), code === undefined ? {} : { code }))).toBe(false)
    })
  }

  it('非 Error 输入一律 false（不抛错）', () => {
    for (const value of [undefined, null, 'str', 42, {}, []]) {
      expect(isModelGoneError(value), String(value)).toBe(false)
    }
  })

  it('空消息 false', () => {
    expect(isModelGoneError(new Error(''))).toBe(false)
  })
})

// ── 2. 记录与剔除 ──────────────────────────────────────────────────────────

/** 构造一个最小适配器替身。 */
function makeAdapter(overrides: Record<string, unknown> = {}) {
  return {
    marker: 'keep-me',
    calls: [] as string[],
    async listModels(): Promise<Array<{ id: string; name: string }>> {
      return [
        { id: 'good-1', name: 'Good 1' },
        { id: 'gone-1', name: 'Gone 1' },
        { id: 'good-2', name: 'Good 2' },
      ]
    },
    listAllModels(): Array<{ id: string; name: string }> {
      return [
        { id: 'good-1', name: 'Good 1' },
        { id: 'gone-1', name: 'Gone 1' },
        { id: 'disabled-by-user', name: 'Old' },
      ]
    },
    async *stream(options: { model: string }): AsyncGenerator<{ text: string }> {
      this.calls.push(options.model)
      if (options.model === 'gone-1') {
        throw Object.assign(new Error('cline: model not found'), { code: 'HTTP_404' })
      }
      if (options.model === 'quota-1') {
        throw Object.assign(new Error('模型额度已用尽'), { code: 'QUOTA_EXCEEDED' })
      }
      yield { text: `ok:${options.model}` }
    },
    normalMethod(): string {
      return this.marker
    },
    ...overrides,
  }
}

/** 消费一个异步生成器（把抛错原样带出）。 */
async function drain(iter: AsyncIterable<unknown>): Promise<unknown[]> {
  const out: unknown[] = []
  for await (const chunk of iter) out.push(chunk)
  return out
}

describe('withDeadModelPruning —— 记录与剔除', () => {
  const PROVIDER = 'spec-provider-a'

  beforeEach(() => {
    clearDeadModels(PROVIDER)
  })

  it('初始时列表含目标模型', async () => {
    const wrapped = withDeadModelPruning([PROVIDER], makeAdapter())
    expect((await wrapped.listModels()).some((m) => m.id === 'gone-1')).toBe(true)
  })

  /**
   * ★★ **`catalogConfirmedRemote` 必须原样透传**（接线守卫，2026-10-28）。
   *
   * 本 Proxy 只拦截 `listModels` / `listAllModels` / `stream` / `prepareCall`，
   * 其余成员原样透传。`model.list` 的「已下架」判据**只信**这个自报钩子
   * （见 `ModelCatalogSource.catalogConfirmedRemote` 的注释）—— 它若被包装层
   * 吞掉，钩子恒 `undefined` ⇒ 判据**静默放弃** ⇒ PR159 那半个修复无声失效
   * （不报错、不告警，只是已下架的幽灵条目又回来了）。
   *
   * ⇒ 用真跑 `withDeadModelPruning` 包装的形式钉住它，而不是只测裸适配器。
   */
  it('★★ catalogConfirmedRemote 经包装后仍可调用且拿到真实判定', () => {
    const wrapped = withDeadModelPruning([PROVIDER], makeAdapter({ catalogConfirmedRemote: () => true }))
    expect(wrapped.catalogConfirmedRemote()).toBe(true)
    const wrappedFalse = withDeadModelPruning([PROVIDER], makeAdapter({ catalogConfirmedRemote: () => false }))
    expect(wrappedFalse.catalogConfirmedRemote()).toBe(false)
  })

  it('stream 抛「模型不存在」⇒ 记入剔除表', async () => {
    const wrapped = withDeadModelPruning([PROVIDER], makeAdapter())
    await expect(drain(wrapped.stream({ model: 'gone-1' }) as AsyncIterable<unknown>)).rejects.toThrow('model not found')
    expect(deadModelIdsFor(PROVIDER).has('gone-1')).toBe(true)
  })

  it('★ 错误**不被吞掉**（仍原样抛出，调用方要看到失败）', async () => {
    const wrapped = withDeadModelPruning([PROVIDER], makeAdapter())
    await expect(drain(wrapped.stream({ model: 'gone-1' }) as AsyncIterable<unknown>)).rejects.toThrow()
  })

  it('记录后 listModels 剔除、其余保留', async () => {
    recordDeadModel(PROVIDER, 'gone-1', 'test')
    const wrapped = withDeadModelPruning([PROVIDER], makeAdapter())
    const list = await wrapped.listModels()
    expect(list.some((m) => m.id === 'gone-1')).toBe(false)
    expect(list.some((m) => m.id === 'good-1')).toBe(true)
    expect(list.some((m) => m.id === 'good-2')).toBe(true)
  })

  it('★ listAllModels 仍返回**数组**（同步契约，不能改成 async）', () => {
    recordDeadModel(PROVIDER, 'gone-1', 'test')
    const wrapped = withDeadModelPruning([PROVIDER], makeAdapter())
    const all = wrapped.listAllModels()
    // jet-hub-rpc 的 ModelCatalogSource 消费者不 await（`catalog = [...all]`），
    // 返回 Promise 会抛 `all is not iterable`。
    expect(Array.isArray(all)).toBe(true)
    expect([...(all as Array<{ id: string }>)].some((m) => m.id === 'gone-1')).toBe(false)
    // 用户关闭的模型仍要能看到（否则设置页无法重新打开）
    expect((all as Array<{ id: string }>).some((m) => m.id === 'disabled-by-user')).toBe(true)
  })

  it('正常模型 stream 正常产出，且不被误记', async () => {
    const wrapped = withDeadModelPruning([PROVIDER], makeAdapter())
    const chunks = await drain(wrapped.stream({ model: 'good-1' }) as AsyncIterable<unknown>)
    expect(chunks).toEqual([{ text: 'ok:good-1' }])
    expect(deadModelIdsFor(PROVIDER).has('good-1')).toBe(false)
  })

  it('额度类错误**不**记录（账号问题 ≠ 模型下架）', async () => {
    const wrapped = withDeadModelPruning([PROVIDER], makeAdapter())
    await expect(drain(wrapped.stream({ model: 'quota-1' }) as AsyncIterable<unknown>)).rejects.toThrow()
    expect(deadModelIdsFor(PROVIDER).has('quota-1')).toBe(false)
  })

  it('clearDeadModels 后重新可见', async () => {
    recordDeadModel(PROVIDER, 'gone-1', 'test')
    expect(deadModelIdsFor(PROVIDER).size).toBe(1)
    clearDeadModels(PROVIDER)
    expect(deadModelIdsFor(PROVIDER).size).toBe(0)
    const wrapped = withDeadModelPruning([PROVIDER], makeAdapter())
    expect((await wrapped.listModels()).some((m) => m.id === 'gone-1')).toBe(true)
  })

  it('重复记录只算一次（幂等）', () => {
    expect(recordDeadModel(PROVIDER, 'gone-1', 'a')).toBe(true)
    expect(recordDeadModel(PROVIDER, 'gone-1', 'b')).toBe(false)
  })

  it('空 provider / 空 modelId 不记录', () => {
    expect(recordDeadModel('', 'x')).toBe(false)
    expect(recordDeadModel(PROVIDER, '')).toBe(false)
  })

  it('多个 provider 的记录互不串扰', async () => {
    const wrapped = withDeadModelPruning([PROVIDER], makeAdapter())
    recordDeadModel('spec-provider-other', 'gone-1', 'test')
    // 别的 provider 记了，本 provider 不应受影响
    expect((await wrapped.listModels()).some((m) => m.id === 'gone-1')).toBe(true)
  })

  it('空 providers 列表时原样返回（不包装）', () => {
    const adapter = makeAdapter()
    expect(withDeadModelPruning([], adapter)).toBe(adapter)
  })
})

// ── 3. 代理透传正确性 ──────────────────────────────────────────────────────

describe('withDeadModelPruning —— 代理透传', () => {
  it('普通属性透传', () => {
    const wrapped = withDeadModelPruning(['spec-provider-b'], makeAdapter())
    expect(wrapped.marker).toBe('keep-me')
  })

  it('普通方法的 this 绑定正确', () => {
    const wrapped = withDeadModelPruning(['spec-provider-b'], makeAdapter())
    expect(wrapped.normalMethod()).toBe('keep-me')
  })

  it('★ 方法身份稳定（两次访问返回同一函数，避免下游比较失配）', () => {
    const wrapped = withDeadModelPruning(['spec-provider-b'], makeAdapter())
    expect(wrapped.normalMethod).toBe(wrapped.normalMethod)
  })

  it('stream 调用仍到达原适配器', async () => {
    const adapter = makeAdapter()
    const wrapped = withDeadModelPruning(['spec-provider-b'], adapter)
    await drain(wrapped.stream({ model: 'good-1' }) as AsyncIterable<unknown>)
    expect(adapter.calls).toContain('good-1')
  })

  it('适配器缺 listAllModels 时不凭空造一个', () => {
    const adapter = { async listModels() { return [] } }
    const wrapped = withDeadModelPruning(['spec-provider-b'], adapter)
    expect((wrapped as { listAllModels?: unknown }).listAllModels).toBeUndefined()
  })
})

// ── 4. 持久化 ──────────────────────────────────────────────────────────────

describe('withDeadModelPruning —— 持久化', () => {
  it('落盘为独立文档且带 schema', () => {
    recordDeadModel('spec-provider-c', 'gone-x', 'test')
    const file = join(STATE_DIR, 'jet-hub', DEAD_MODELS_FILE)
    expect(existsSync(file)).toBe(true)
    const doc = JSON.parse(readFileSync(file, 'utf-8')) as {
      schema: string
      providers: Record<string, Record<string, { at: string; reason?: string }>>
    }
    expect(doc.schema).toBe('dsh-codearts-auth/dead-models/v1')
    expect(doc.providers['spec-provider-c']?.['gone-x']?.at).toBeTruthy()
    expect(doc.providers['spec-provider-c']?.['gone-x']?.reason).toBe('test')
  })

  it('落盘失败不影响调用方（不可写路径也只降级记日志）', () => {
    // ⚠️ 初版这条测试是**同义反复**：注释声称「构造一个必然写不进去的路径」，
    // 但代码里什么都没构造，跑的是正常写入分支（`mkdirSync(recursive)` 还会
    // 把整条路径建出来）—— 任何不崩的实现都能过，断言强度为 0。
    //
    // 现在用**另一个**provider 的独立 state 目录，把 `jet-hub` 段**占成文件**：
    // `FileDeadModelStore.save` 里的 `mkdirSync(join(path,'..'), {recursive:true})`
    // 会失败（⚠️ 实测抛的是 **EEXIST** 而非 ENOTDIR —— `recursive` 对「末段已存在
    // 且不是目录」抛 EEXIST；这里按实测写，别再写成 ENOTDIR），异常被 `persist`
    // 捕获只记日志。
    // ⚠️ 已做反向验证：把 `persist` 的 catch 去掉后本用例红。
    const blockedDir = mkdtempSync(join(tmpdir(), 'dsh-dead-model-blocked-'))
    const jetHubDir = join(blockedDir, 'jet-hub')
    writeFileSync(jetHubDir, 'not-a-directory', 'utf-8')
    const previous = process.env.DSH_JET_HUB_STATE_DIR
    // ⚠️ store / cache 是模块级单例，必须让下一次解析重新读环境变量。
    configureDeadModelStore({ logger: undefined } as never)
    process.env.DSH_JET_HUB_STATE_DIR = blockedDir
    configureDeadModelStore({ logger: undefined } as never)
    try {
      expect(() => recordDeadModel('spec-provider-d', 'gone-y', 'test')).not.toThrow()
      // 记录仍进内存（下次读仍在），只是没落盘 —— 与永久积分锁的降级策略一致。
      expect(deadModelIdsFor('spec-provider-d').has('gone-y')).toBe(true)
    } finally {
      process.env.DSH_JET_HUB_STATE_DIR = previous
      configureDeadModelStore({ logger: undefined } as never)
      rmSync(blockedDir, { recursive: true, force: true })
      clearDeadModels('spec-provider-d')
    }
  })
})

// ── 5. 生产环境唯一真正走到的路径：prepareCall（致命缺陷回归）────────────

/**
 * ⚠️ 与本仓库全部 14 个适配器**同款形状**：`prepareCall` 返回的
 * `stream: (o) => this.stream(o)` 里，`this` 是**原始对象** —— 只包 `stream`
 * 的 Proxy 会被完全绕过。
 *
 * 依据：`node_modules/@deepseek-ai/dsh-llm/lib/index.js:1597` 与 `:1667`
 * 两条运行时路径都只调 `prepareCall`，再用它返回的 `call.stream` 作 dispatch。
 */
class PrepareCallAdapter {
  calls: string[] = []
  async listModels(): Promise<Array<{ id: string; name: string }>> {
    return [{ id: 'gone-1', name: 'Gone' }, { id: 'ok-1', name: 'Ok' }]
  }
  listAllModels(): Array<{ id: string; name: string }> {
    return [{ id: 'gone-1', name: 'Gone' }, { id: 'ok-1', name: 'Ok' }]
  }
  async resolveModel(provider: string, model: string): Promise<{ provider: string; id: string; name: string }> {
    return { provider, id: model, name: model }
  }
  async prepareCall(provider: string, model: string): Promise<{
    model: unknown
    stream: (options: { model: string }) => AsyncIterable<unknown>
  }> {
    return { model: await this.resolveModel(provider, model), stream: (o) => this.stream(o) }
  }
  async *stream(options: { model: string }): AsyncGenerator<unknown> {
    this.calls.push(options.model)
    if (options.model === 'gone-1') {
      throw Object.assign(new Error('cline: model not found'), { code: 'HTTP_404' })
    }
    if (options.model === 'quota-1') {
      throw Object.assign(new Error('模型额度已用尽'), { code: 'QUOTA_EXCEEDED' })
    }
    yield { text: `ok:${options.model}` }
  }
  normalMethod(): string {
    return 'keep-me'
  }
}

describe('withDeadModelPruning —— prepareCall 路径（!66 致命缺陷回归）', () => {
  const PROVIDER = 'spec-preparecall'

  beforeEach(() => {
    clearDeadModels(PROVIDER)
  })

  it('★ 经 prepareCall 的错误**会被记录**（初版完全不记录，机制等于失效）', async () => {
    const wrapped = withDeadModelPruning([PROVIDER], new PrepareCallAdapter())
    const call = await wrapped.prepareCall(PROVIDER, 'gone-1')
    await expect(drain(call.stream({ model: 'gone-1' }))).rejects.toThrow('model not found')
    expect(deadModelIdsFor(PROVIDER).has('gone-1')).toBe(true)
  })

  it('★ 经 prepareCall 的错误**仍原样抛出**（不吞，harness 重试分类依赖原始码）', async () => {
    const wrapped = withDeadModelPruning([PROVIDER], new PrepareCallAdapter())
    const call = await wrapped.prepareCall(PROVIDER, 'gone-1')
    await expect(drain(call.stream({ model: 'gone-1' }))).rejects.toThrow(/model not found/)
  })

  it('★ prepareCall 返回值其余字段原样保留（不能只回 { stream }）', async () => {
    const wrapped = withDeadModelPruning([PROVIDER], new PrepareCallAdapter())
    const call = await wrapped.prepareCall(PROVIDER, 'ok-1')
    expect(call.model).toEqual({ provider: PROVIDER, id: 'ok-1', name: 'ok-1' })
    expect(typeof call.stream).toBe('function')
  })

  it('经 prepareCall 的额度类错误**不**记录', async () => {
    const wrapped = withDeadModelPruning([PROVIDER], new PrepareCallAdapter())
    const call = await wrapped.prepareCall(PROVIDER, 'quota-1')
    await expect(drain(call.stream({ model: 'quota-1' }))).rejects.toThrow()
    expect(deadModelIdsFor(PROVIDER).has('quota-1')).toBe(false)
  })

  it('经 prepareCall 的正常模型正常产出且不误记', async () => {
    const wrapped = withDeadModelPruning([PROVIDER], new PrepareCallAdapter())
    const call = await wrapped.prepareCall(PROVIDER, 'ok-1')
    await expect(drain(call.stream({ model: 'ok-1' }))).resolves.toEqual([{ text: 'ok:ok-1' }])
    expect(deadModelIdsFor(PROVIDER).size).toBe(0)
  })

  it('prepareCall 的调用仍到达原适配器', async () => {
    const raw = new PrepareCallAdapter()
    const wrapped = withDeadModelPruning([PROVIDER], raw)
    const call = await wrapped.prepareCall(PROVIDER, 'ok-1')
    await drain(call.stream({ model: 'ok-1' }))
    expect(raw.calls).toContain('ok-1')
  })

  it('缺 prepareCall 时不凭空造一个', () => {
    const wrapped = withDeadModelPruning([PROVIDER], { async listModels() { return [] } })
    expect((wrapped as { prepareCall?: unknown }).prepareCall).toBeUndefined()
  })

  /**
   * ⚠️ 多路由归属回归（2026-10-06 复审）：一个实例注册 `[pA, pB]` 时，
   * 记录**必须按本次请求的 provider 归属**，不能一律记到 `ids[0]` ——
   * 否则 pA 的失效会连带隐藏 pB 的**同名**模型（buddy 与 workbuddy 的
   * 模型池高度重合，这不是假想场景），且与 `filterList` 按全部 ids 取并集
   * 的口径不自洽。
   */
  it('★ 多路由时按本次请求的 provider 归属记录（不记到 ids[0]）', async () => {
    class Shared {
      async listModels() { return [{ id: 'shared-id', name: 'Shared' }] }
      listAllModels() { return [{ id: 'shared-id', name: 'Shared' }] }
      async resolveModel(provider: string, model: string) { return { provider, id: model, name: model } }
      async prepareCall(provider: string, model: string) {
        return { model: await this.resolveModel(provider, model), stream: (o: { model: string }) => this.stream(o) }
      }
      async *stream(options: { model: string }) {
        if (options.model === 'shared-id') {
          throw Object.assign(new Error('model not found'), { code: 'HTTP_404' })
        }
        yield { ok: true }
      }
    }
    clearDeadModels('multi-pB')
    const wrapped = withDeadModelPruning(['multi-pA', 'multi-pB'], new Shared())

    // 经 prepareCall('multi-pB') 触发 → 必须记到 pB，不能记到 pA。
    const call = await wrapped.prepareCall('multi-pB', 'shared-id')
    await expect(drain(call.stream({ model: 'shared-id' }))).rejects.toThrow()

    expect([...deadModelIdsFor('multi-pB')], 'pB 应持有该记录').toEqual(['shared-id'])
    expect(deadModelIdsFor('multi-pA').size, 'pA 不应被牵连').toBe(0)
    clearDeadModels('multi-pB')
  })

  it('prepareCall 返回非对象 / 无 stream 时原样透传（不构造坏结构）', async () => {
    const nonObject = withDeadModelPruning([PROVIDER], {
      async prepareCall() { return 42 },
    })
    expect(await nonObject.prepareCall()).toBe(42)
    const noStream = withDeadModelPruning([PROVIDER], {
      async prepareCall() { return { model: 'm' } },
    })
    expect(await noStream.prepareCall()).toEqual({ model: 'm' })
  })
})

// ── 6. 函数身份稳定（初版只有透传分支做了缓存）─────────────────────────

describe('withDeadModelPruning —— 函数身份稳定', () => {
  it('★ listModels 身份稳定（初版每次访问新建闭包）', () => {
    const wrapped = withDeadModelPruning(['spec-identity'], new PrepareCallAdapter())
    expect(wrapped.listModels).toBe(wrapped.listModels)
  })

  it('★ listAllModels 身份稳定', () => {
    const wrapped = withDeadModelPruning(['spec-identity'], new PrepareCallAdapter())
    expect(wrapped.listAllModels).toBe(wrapped.listAllModels)
  })

  it('★ stream 身份稳定', () => {
    const wrapped = withDeadModelPruning(['spec-identity'], new PrepareCallAdapter())
    expect(wrapped.stream).toBe(wrapped.stream)
  })

  it('★ prepareCall 身份稳定', () => {
    const wrapped = withDeadModelPruning(['spec-identity'], new PrepareCallAdapter())
    expect(wrapped.prepareCall).toBe(wrapped.prepareCall)
  })
})

// ── 7. 恢复入口：clearDeadModels ──────────────────────────────────────────

describe('clearDeadModels —— 用户唯一的自愈路径', () => {
  it('按单个模型移除，只删那一条', () => {
    recordDeadModel('rec-p', 'a', 'x')
    recordDeadModel('rec-p', 'b', 'x')
    expect(clearDeadModels('rec-p', 'a')).toBe(1)
    expect([...deadModelIdsFor('rec-p')]).toEqual(['b'])
  })

  it('省略 modelId 时清空该 provider 全部', () => {
    recordDeadModel('rec-p2', 'a', 'x')
    recordDeadModel('rec-p2', 'b', 'x')
    expect(clearDeadModels('rec-p2')).toBe(2)
    expect(deadModelIdsFor('rec-p2').size).toBe(0)
  })

  it('不影响其它 provider', () => {
    recordDeadModel('rec-a', 'x', 'x')
    recordDeadModel('rec-b', 'y', 'x')
    clearDeadModels('rec-a')
    expect([...deadModelIdsFor('rec-b')]).toEqual(['y'])
  })

  it('无记录时幂等返回 0', () => {
    expect(clearDeadModels('rec-never')).toBe(0)
    recordDeadModel('rec-idem', 'a', 'x')
    expect(clearDeadModels('rec-idem', 'a')).toBe(1)
    expect(clearDeadModels('rec-idem', 'a')).toBe(0)
  })

  it('空 provider 返回 0（不误清全表）', () => {
    recordDeadModel('rec-safe', 'a', 'x')
    expect(clearDeadModels('')).toBe(0)
    expect([...deadModelIdsFor('rec-safe')]).toEqual(['a'])
  })

  it('恢复后模型重新可见', async () => {
    recordDeadModel('rec-visible', 'gone-1', 'x')
    const wrapped = withDeadModelPruning(['rec-visible'], new PrepareCallAdapter())
    expect((await wrapped.listModels()).some((m) => m.id === 'gone-1')).toBe(false)
    clearDeadModels('rec-visible', 'gone-1')
    expect((await wrapped.listModels()).some((m) => m.id === 'gone-1')).toBe(true)
  })

  /**
   * ⚠️ 回归（2026-10-06 复审实测）：`configureDeadModelStore` 在 HMR / fiber 重启
   * 时会被**再调一次**（见 `llm-register-compat.ts` 模块头记录的重启竞态）。
   * 若它直接清 `cache`，**尚未落盘的内存记录**就永久丢失 —— 在「无法定位 home、
   * 只存在于内存」的**降级路径**下是真实的数据丢失。
   *
   * ⚠️ 判据必须构造**降级**场景：正常路径下记录早已落盘，重注入后读回来自然还在，
   * 那样的用例抓不住本缺陷（同义反复 —— 第一版就是这么写的，反向验证时全绿）。
   * 这里把 `jet-hub` 段占成文件让 `persist` 必然失败，使记录**只存在于内存**，
   * 此时重注入才暴露问题。
   */
  it('★ configureDeadModelStore 二次调用不丢「仅内存」的记录（先落盘再丢弃）', () => {
    const blockedDir = mkdtempSync(join(tmpdir(), 'dsh-dead-model-nohome-'))
    const previous = process.env.DSH_JET_HUB_STATE_DIR
    writeFileSync(join(blockedDir, 'jet-hub'), 'not-a-directory', 'utf-8')
    configureDeadModelStore({ logger: undefined } as never)
    process.env.DSH_JET_HUB_STATE_DIR = blockedDir
    configureDeadModelStore({ logger: undefined } as never)
    try {
      clearDeadModels('cfg-keep')
      recordDeadModel('cfg-keep', 'mem-only', 'x')
      expect([...deadModelIdsFor('cfg-keep')], '前提：记录已在内存').toEqual(['mem-only'])

      // 模拟 HMR / fiber 重启时再次注入（此时 persist 仍失败 ⇒ 只能靠内存）。
      configureDeadModelStore({ logger: undefined } as never)

      expect([...deadModelIdsFor('cfg-keep')], '重注入后仅内存的记录必须还在').toEqual(['mem-only'])
    } finally {
      clearDeadModels('cfg-keep')
      process.env.DSH_JET_HUB_STATE_DIR = previous
      configureDeadModelStore({ logger: undefined } as never)
      rmSync(blockedDir, { recursive: true, force: true })
    }
  })

  it('清空一个 provider 不会波及其它 provider（跨 provider 隔离）', () => {
    recordDeadModel('all-a', 'x', 'x')
    recordDeadModel('all-b', 'y', 'x')
    expect(clearDeadModels('all-a')).toBe(1)
    expect(deadModelIdsFor('all-a').size).toBe(0)
    expect([...deadModelIdsFor('all-b')]).toEqual(['y'])
  })
})

describe('★ C2：聚合必须豁免「失效模型记录」（全分支终审）', () => {
  const AGG = 'spec-aggregate'

  beforeEach(() => {
    clearDeadModels(AGG)
  })

  it('enabled:false 时，上游「模型不存在」**不得**被记成失效模型', async () => {
    // ⚠️ 真实缺陷：聚合层的目录是**动态推导**的（上游下架后下次推导自然消失），
    //    不需要「编译期快照跟不上上游」那套记录。而记录会造成：
    //    ① 外层观察到的是 `aggregate` + **虚拟键** ⇒ 「某一个渠道没有该 realId」
    //       被记成「**整个规范模型**失效」，而它在其余渠道上完全可用；
    //    ② 恢复入口 model.clearDead 的 UI 在设置页 provider 面板里，而客户端
    //       PROVIDERS **没有 aggregate** ⇒ 没有任何 UI 能恢复。
    const wrapped = withDeadModelPruning([AGG], makeAdapter(), { enabled: false })
    await expect(drain(wrapped.stream({ model: 'gone-1' }) as AsyncIterable<unknown>))
      .rejects.toThrow('model not found')
    // ⚠️ 关键断言：**没有**被记录
    expect(deadModelIdsFor(AGG).has('gone-1')).toBe(false)
  })

  it('对照：默认（enabled 省略）时**照旧记录**（不能把其余 14 家的行为改掉）', async () => {
    const wrapped = withDeadModelPruning([AGG], makeAdapter())
    await expect(drain(wrapped.stream({ model: 'gone-1' }) as AsyncIterable<unknown>))
      .rejects.toThrow('model not found')
    expect(deadModelIdsFor(AGG).has('gone-1')).toBe(true)
  })

  it('★ enabled:false 时**也不过滤** —— 历史遗留的 dead 记录不得再隐藏模型（审计轮次二）', async () => {
    // ⚠️⚠️ 这是**被证伪的那条假设**（初版只跳过记录、仍保留过滤，留下一处真实残留面）：
    //    若表里**已有**旧版本写下的 `aggregate` 记录（C2 修复前跑过一次聚合就会有），
    //    虚拟模型**仍被隐藏**，而恢复入口在设置页 provider 面板里、客户端 `PROVIDERS`
    //    没有 `aggregate` ⇒ **没有任何 UI 能恢复**（只能手改 json 或等 30 天）。
    //    聚合层的目录是**动态推导**的 ⇒ 过滤它没有任何正确用途（能推导出来就说明有渠道
    //    正在广告它；推导不出来它压根不在目录里）。故 `enabled:false` 必须**彻底**不参与。
    recordDeadModel(AGG, 'gone-1', 'legacy record written before the C2 fix')
    const wrapped = withDeadModelPruning([AGG], makeAdapter(), { enabled: false })
    const list = await wrapped.listModels()
    // ⚠️ 关键断言：**不再**被过滤（与初版行为相反）
    expect(list.some((m) => m.id === 'gone-1')).toBe(true)
    expect(list.some((m) => m.id === 'good-1')).toBe(true)
    // listAllModels 同样不受影响
    const all = wrapped.listAllModels() as Array<{ id: string }>
    expect([...all].some((m) => m.id === 'gone-1')).toBe(true)
  })

  it('对照：默认（enabled 省略）时**仍照旧过滤**遗留记录', async () => {
    recordDeadModel(AGG, 'gone-1', 'pre-existing')
    const wrapped = withDeadModelPruning([AGG], makeAdapter())
    const list = await wrapped.listModels()
    expect(list.some((m) => m.id === 'gone-1')).toBe(false)
  })

  it('enabled:false 经 prepareCall 路径同样生效（生产唯一路径）', async () => {
    // ⚠️ 必须走 prepareCall → call.stream，因为 dsh-llm 只走这条路径
    //    （`dsh-llm/lib/index.js:1597` / `:1667`）；只测顶层 stream 会绕过真实链路
    //    （AGENTS.md 记过这个坑：42 条用例全绿却完全测不到生产路径）。
    // ⚠️ 形状必须与真实适配器一致：`prepareCall` 返回的 `stream` 里 `this` 是原对象。
    const adapter = {
      listModels: async () => [{ id: 'gone-1', name: 'Gone 1' }],
      listAllModels: () => [{ id: 'gone-1', name: 'Gone 1' }],
      async prepareCall(_provider: string, model: string) {
        return {
          model: { provider: AGG, id: model, name: model },
          stream: (options: { model: string }) => this.stream(options),
        }
      },
      async *stream(options: { model: string }): AsyncGenerator<{ text: string }> {
        if (options.model === 'gone-1') {
          throw Object.assign(new Error('cline: model not found'), { code: 'HTTP_404' })
        }
        yield { text: 'ok' }
      },
    }
    const wrapped = withDeadModelPruning([AGG], adapter as never, { enabled: false }) as typeof adapter
    const call = await wrapped.prepareCall(AGG, 'gone-1')
    await expect(drain(call.stream({ model: 'gone-1' }))).rejects.toThrow('model not found')
    expect(deadModelIdsFor(AGG).has('gone-1')).toBe(false)
  })
})
