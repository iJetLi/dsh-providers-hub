import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handleSyncRpc } from '../../src/sync-rpc.js'
import { resolveSyncPaths } from '../../src/sync-apply.js'
import type { Context } from '@deepseek-ai/cordis'

/**
 * RPC 层用例：验**接线正确性**，不重复验证计划/落盘行为（那两层已各有 spec）。
 *
 * 最关键的两条：
 * 1. 不属于 `sync.` 的方法必须返回 `undefined` —— 否则会把主 switch 的方法吞掉
 *    （`opencode-rpc.ts` 2026-10-02 真机事故的同款成因）；
 * 2. 失败必须转成 `{ ok: false }` 而不是抛出 —— 用户要看到「哪个目标、为什么」。
 */

const GATEWAY = 'http://127.0.0.1:8326/v1'
let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'jethub-syncrpc-'))
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

/** 造一个最小 ctx（`llm` 走属性访问路径）。 */
function fakeCtx(llm: unknown): Context {
  return { llm } as unknown as Context
}

/** 目录替身。 */
const goodLlm = {
  listProviders: () => [{ id: 'codearts' }],
  listModels: async () => [{ id: 'GLM-5.2', name: 'GLM-5.2', contextWindow: 202752, maxTokens: 65536, inputModalities: ['text'] }],
}

describe('handleSyncRpc — 前缀改道的边界', () => {
  it('⚠️ 非 sync.* 方法返回 undefined（让主 switch 继续匹配）', async () => {
    expect(await handleSyncRpc(fakeCtx(goodLlm), 'model.list', {})).toBeUndefined()
    expect(await handleSyncRpc(fakeCtx(goodLlm), 'account.create', {})).toBeUndefined()
  })

  it('⚠️ 即便是 sync. 开头的未知方法也返回 undefined（不静默吞成成功）', async () => {
    expect(await handleSyncRpc(fakeCtx(goodLlm), 'sync.nope', {})).toBeUndefined()
  })
})

describe('handleSyncRpc — llm 不可用', () => {
  it('llm 完全缺失时返回 ok:false（不抛）', async () => {
    const result = (await handleSyncRpc({} as Context, 'sync.preview', {})) as any
    expect(result.ok).toBe(false)
    expect(result.error.code).toBe('unavailable')
  })
})

describe('handleSyncRpc — 预览与执行', () => {
  /** 在临时 home 里造好两个目标文件（走真实路径解析，用 process.env 覆盖 home）。 */
  function seedTargets(): void {
    const paths = resolveSyncPaths(home)
    mkdirSync(join(paths.piModels, '..'), { recursive: true })
    writeFileSync(paths.piModels, JSON.stringify({ providers: { 'dsh-gateway': { name: 'dsh-gateway', baseUrl: GATEWAY, apiKey: 'k', api: 'openai-completions', models: [] } } }, null, 2) + '\n', 'utf-8')
    mkdirSync(join(paths.zcodeProviderConfig, '..'), { recursive: true })
    writeFileSync(
      paths.zcodeProviderConfig,
      JSON.stringify(
        {
          schemaVersion: 1,
          config: {
            providerOrder: ['dsh-openai-gateway'],
            providerConfigRules: {
              providerRules: [
                { providerId: 'dsh-openai-gateway', providerName: 'dsh', enabled: true, config: { access: { type: 'api-key', apiKey: 'k' }, api: { type: 'openai-chat-completions', baseUrl: GATEWAY }, personalModelIds: [], modelOrder: [] } },
              ],
            },
            modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
          },
        },
        null,
        2,
      ) + '\n',
      'utf-8',
    )
  }

  it('⚠️ 失败转成 ok:false 且带可读原因（目标文件缺失时）', async () => {
    // 临时 home 里没有任何目标文件 ⇒ preview 的两个目标都应 ok:false
    const result = (await handleSyncRpc(fakeCtx(goodLlm), 'sync.preview', {}, { home })) as any
    expect(result.ok).toBe(true)
    expect(result.value.modelCount).toBe(1)
    expect(result.value.targets.every((t: any) => t.ok === false)).toBe(true)
    expect(result.value.targets[0].error).toBeTruthy()
  })

  it('sync.apply 在目录不可写时返回 ok:false（不抛异常给上层）', async () => {
    // 目录非空但能力值非法 ⇒ applySync 抛 SyncApplyError ⇒ 这里必须变成 ok:false
    const badLlm = {
      listProviders: () => [{ id: 'codearts' }],
      listModels: async () => [{ id: 'GLM-5.2', name: 'GLM-5.2', contextWindow: 0, maxTokens: 0 }],
    }
    const result = (await handleSyncRpc(fakeCtx(badLlm), 'sync.apply', {}, { home })) as any
    expect(result.ok).toBe(false)
    expect(result.error.code).toBe('sync-failed')
    expect(result.error.message).toMatch(/缺 contextWindow/)
  })

  it('sync.apply 正常路径返回 applied 明细与备份目录', async () => {
    seedTargets()
    const result = (await handleSyncRpc(fakeCtx(goodLlm), 'sync.apply', {}, { home })) as any
    expect(result.ok).toBe(true)
    expect(result.value.applied.map((a: any) => a.target)).toEqual(['pi', 'zcode'])
    expect(result.value.applied[0].backupDir).toMatch(/before-jethub-sync-/)
    // 密钥不能被写坏
    const zcode = JSON.parse(readFileSync(resolveSyncPaths(home).zcodeProviderConfig, 'utf-8'))
    expect(zcode.config.providerConfigRules.providerRules[0].config.access.apiKey).toBe('k')
  })
})

describe('handleSyncRpc — 渠道白名单透传', () => {
  it('⚠️ providers 非字符串数组时返回 bad-request（不猜）', async () => {
    const result = (await handleSyncRpc(fakeCtx(goodLlm), 'sync.preview', { providers: 'codearts' }, { home })) as any
    expect(result.ok).toBe(false)
    expect(result.error.message).toMatch(/字符串数组/)
  })

  it('providers 缺省 = 全部渠道', async () => {
    const result = (await handleSyncRpc(fakeCtx(goodLlm), 'sync.preview', {}, { home })) as any
    expect(result.ok).toBe(true)
    expect(result.value.modelCount).toBe(1)
  })

  it('⚠️ providers 空数组传到下层后变成「没有勾选任何渠道」（不会被当成「全部」）', async () => {
    const result = (await handleSyncRpc(fakeCtx(goodLlm), 'sync.preview', { providers: [] }, { home })) as any
    expect(result.ok).toBe(true)
    expect(result.value.modelCount).toBe(0)
    expect(result.value.targets[0].error).toMatch(/没有勾选任何渠道/)
  })

  it('只勾选部分渠道时 modelCount 随之收窄', async () => {
    const multiLlm = {
      listProviders: () => [{ id: 'codearts' }, { id: 'minimax' }],
      listModels: async (provider: string) =>
        provider === 'codearts'
          ? [{ id: 'GLM-5.2', name: 'GLM-5.2', contextWindow: 202752, maxTokens: 65536, inputModalities: ['text'] }]
          : [{ id: 'M3', name: 'M3', contextWindow: 1000000, maxTokens: 32000, inputModalities: ['text'] }],
    }
    const all = (await handleSyncRpc(fakeCtx(multiLlm), 'sync.preview', {}, { home })) as any
    expect(all.value.modelCount).toBe(2)
    const narrowed = (await handleSyncRpc(fakeCtx(multiLlm), 'sync.preview', { providers: ['codearts'] }, { home })) as any
    expect(narrowed.value.modelCount).toBe(1)
    expect(narrowed.value.providers).toHaveLength(2)
  })
})

describe('handleSyncRpc — 目标白名单透传', () => {
  it('⚠️ targets 含未知目标名时报错（默写拼错不能静默当成「全部」）', async () => {
    const result = (await handleSyncRpc(fakeCtx(goodLlm), 'sync.apply', { targets: ['pi', 'zcdode'] }, { home })) as any
    expect(result.ok).toBe(false)
    expect(result.error.message).toContain('zcdode')
  })

  it('targets 非字符串数组时报错', async () => {
    const result = (await handleSyncRpc(fakeCtx(goodLlm), 'sync.apply', { targets: 'pi' }, { home })) as any
    expect(result.ok).toBe(false)
    expect(result.error.message).toMatch(/字符串数组/)
  })

  it('⚠️ targets 空数组传到下层后拒绝执行（不清空、不假装成功）', async () => {
    const result = (await handleSyncRpc(fakeCtx(goodLlm), 'sync.apply', { targets: [] }, { home })) as any
    expect(result.ok).toBe(false)
    expect(result.error.message).toMatch(/没有选择任何要同步的 agent/)
  })

  it('targets 缺省 = 全部目标', async () => {
    const result = (await handleSyncRpc(fakeCtx(goodLlm), 'sync.preview', {}, { home })) as any
    expect(result.ok).toBe(true)
    expect(result.value.targets.map((t: any) => t.target)).toEqual(['pi', 'zcode'])
  })
})
