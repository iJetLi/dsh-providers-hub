import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applySync, collectSyncModels, localGatewayBaseUrl, previewSync, type SyncModelSource } from '../../src/sync-service.js'
import { planPiSync } from '../../src/sync-targets.js'
import { resolveSyncPaths } from '../../src/sync-apply.js'

/**
 * 服务层用例：**全部在 mkdtemp 临时 home 里**，不碰真实的 `~/.pi` / `~/.zcode`。
 *
 * 这一层最需要守住的两件事：
 * 1. `previewSync` **绝不写文件**（UI 打开预览面板时不能改用户的配置）；
 * 2. 两个目标**互不牵连**（pi 文件坏了不能让 zcode 也报错）。
 */

let home: string

/** 网关地址（与默认端口一致）。 */
const GATEWAY = 'http://127.0.0.1:8326/v1'

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'jethub-syncsvc-'))
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

/** 造一个网关目录替身：codearts 两个模型 + minimax 一个。 */
function fakeLlm(): SyncModelSource {
  return {
    listProviders: () => [{ id: 'codearts' }, { id: 'minimax' }, { id: 'broken' }],
    listModels: async (provider: string) => {
      if (provider === 'broken') throw new Error('该渠道未登录')
      if (provider === 'codearts') {
        return [
          { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', contextWindow: 1000000, maxTokens: 384000, inputModalities: ['text'] },
          { id: 'GLM-5.2', name: 'GLM-5.2', contextWindow: 202752, maxTokens: 65536, inputModalities: ['text', 'image'] },
        ]
      }
      return [{ id: 'MiniMax-M3.1', name: 'MiniMax M3.1', contextWindow: 1000000, maxTokens: 32000, inputModalities: ['text'] }]
    },
  }
}

/** 在临时 home 里写一份 pi models.json。 */
function seedPi(models: readonly Record<string, unknown>[] = []): string {
  const path = resolveSyncPaths(home).piModels
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(
    path,
    JSON.stringify(
      {
        providers: {
          'dsh-gateway': {
            name: 'dsh-gateway',
            baseUrl: GATEWAY,
            apiKey: 'pi-gateway-key-must-survive',
            api: 'openai-completions',
            models: [...models],
          },
        },
      },
      null,
      2,
    ) + '\n',
    'utf-8',
  )
  return path
}

/** 在临时 home 里写一份 ZCode provider_config.json。 */
function seedZcode(personalModelIds: readonly string[] = []): string {
  const path = resolveSyncPaths(home).zcodeProviderConfig
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(
    path,
    JSON.stringify(
      {
        schemaVersion: 1,
        config: {
          providerOrder: ['dsh-openai-gateway'],
          providerConfigRules: {
            providerRules: [
              {
                providerId: 'dsh-openai-gateway',
                providerName: 'dsh',
                enabled: true,
                config: {
                  access: { type: 'api-key', apiKey: 'zcode-key-must-survive' },
                  api: { type: 'openai-chat-completions', baseUrl: GATEWAY },
                  personalModelIds: [...personalModelIds],
                  modelOrder: [...personalModelIds],
                },
              },
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
  return path
}

describe('localGatewayBaseUrl — 地址与端口', () => {
  it('默认回环地址 + 8326', () => {
    expect(localGatewayBaseUrl({})).toBe('http://127.0.0.1:8326/v1')
  })

  it('跟随 DSH_OPENAI_GATEWAY_PORT', () => {
    expect(localGatewayBaseUrl({ DSH_OPENAI_GATEWAY_PORT: '9300' })).toBe('http://127.0.0.1:9300/v1')
  })

  it('端口非法时回退默认值而不是抛错（网关本来就起不来，同步不该跟着炸）', () => {
    expect(localGatewayBaseUrl({ DSH_OPENAI_GATEWAY_PORT: 'abc' })).toBe('http://127.0.0.1:8326/v1')
  })
})

describe('collectSyncModels — 目录归一', () => {
  it('id 拼成 <provider>/<model>，与 /v1/models 口径一致', async () => {
    const models = await collectSyncModels(fakeLlm())
    expect(models.map(m => m.id)).toEqual(['codearts/deepseek-v4-flash', 'codearts/GLM-5.2', 'minimax/MiniMax-M3.1'])
  })

  it('未声明的输入模态按 text 保守处理', async () => {
    const models = await collectSyncModels({
      listProviders: () => [{ id: 'p' }],
      listModels: async () => [{ id: 'm', name: 'm', contextWindow: 100, maxTokens: 10 }],
    })
    expect(models[0].input).toEqual(['text'])
  })

  it('单个渠道抛错不影响其它渠道（未登录不该让整个目录失败）', async () => {
    const models = await collectSyncModels(fakeLlm())
    expect(models).toHaveLength(3)
  })
})

describe('previewSync — 只算不写', () => {
  it('⚠️ 预览绝不修改任何文件（打开面板不能改用户配置）', async () => {
    const piPath = seedPi()
    const zcodePath = seedZcode()
    const piBefore = readFileSync(piPath, 'utf-8')
    const zcodeBefore = readFileSync(zcodePath, 'utf-8')

    await previewSync(fakeLlm(), { home })
    expect(readFileSync(piPath, 'utf-8')).toBe(piBefore)
    expect(readFileSync(zcodePath, 'utf-8')).toBe(zcodeBefore)
    // 也不该产生备份目录
    expect(existsSync(join(piPath, '..', 'backups'))).toBe(false)
  })

  it('给出两个目标各自的 diff', async () => {
    seedPi()
    seedZcode()
    const result = await previewSync(fakeLlm(), { home })
    expect(result.modelCount).toBe(3)
    expect(result.targets.map(t => t.target)).toEqual(['pi', 'zcode'])
    const pi = result.targets.find(t => t.target === 'pi')!
    expect(pi.ok).toBe(true)
    expect(pi.diff!.added).toEqual(['codearts/deepseek-v4-flash', 'codearts/GLM-5.2', 'minimax/MiniMax-M3.1'])
  })

  it('⚠️ 逐目标兜错：pi 文件缺失时 zcode 仍然可用', async () => {
    seedZcode()
    const result = await previewSync(fakeLlm(), { home })
    const pi = result.targets.find(t => t.target === 'pi')!
    const zcode = result.targets.find(t => t.target === 'zcode')!
    expect(pi.ok).toBe(false)
    expect(pi.error).toMatch(/找不到配置文件/)
    expect(zcode.ok).toBe(true)
  })

  it('两个目标都缺时都给出了原因（不是整体抛错）', async () => {
    const result = await previewSync(fakeLlm(), { home })
    expect(result.targets.every(t => !t.ok && t.error)).toBe(true)
  })

  it('⚠️⚠️ 目录为空时两个目标都标不可同步（否则 UI 会显示「将移除全部模型」）', async () => {
    seedPi([{ id: 'codearts/GLM-5.2', name: 'x', contextWindow: 1, maxTokens: 1, input: ['text'] }])
    seedZcode(['codearts/GLM-5.2'])
    // llm 拿不到任何 provider：模拟网关停用 / 升级后 listProviders 缺失
    const result = await previewSync({ listProviders: () => [], listModels: async () => [] }, { home })
    expect(result.modelCount).toBe(0)
    expect(result.targets.every(t => !t.ok)).toBe(true)
    // 关键：不能把已有模型报成 removed
    expect(result.targets.every(t => t.diff === undefined)).toBe(true)
    expect(result.targets[0].error).toMatch(/没有返回任何模型|缺 contextWindow|目录为空/)
  })
})

describe('applySync — 落盘 / 备份 / 幂等 / 回滚', () => {
  it('两个目标都写入，且密钥原样保留（不搬运密钥）', async () => {
    const piPath = seedPi()
    const zcodePath = seedZcode()
    const result = await applySync(fakeLlm(), { home })
    expect(result.applied.map(a => a.target)).toEqual(['pi', 'zcode'])

    const pi = JSON.parse(readFileSync(piPath, 'utf-8'))
    expect(pi.providers['dsh-gateway'].apiKey).toBe('pi-gateway-key-must-survive')
    const zcode = JSON.parse(readFileSync(zcodePath, 'utf-8'))
    expect(zcode.config.providerConfigRules.providerRules[0].config.access.apiKey).toBe('zcode-key-must-survive')
  })

  it('ZCode 侧确实补上了 providerModelRules（否则该模型在 ZCode 里不可用）', async () => {
    seedPi()
    const zcodePath = seedZcode()
    await applySync(fakeLlm(), { home })
    const zcode = JSON.parse(readFileSync(zcodePath, 'utf-8'))
    const rules = zcode.config.modelConfigRules.providerModelRules
    expect(rules).toHaveLength(3)
    expect(rules.find((r: any) => r.modelId === 'codearts/GLM-5.2').config.properties.contextWindow).toBe(202752)
  })

  it('每个落盘目标都留下备份目录', async () => {
    seedPi()
    seedZcode()
    const result = await applySync(fakeLlm(), { home })
    for (const entry of result.applied) {
      expect(existsSync(entry.backupDir)).toBe(true)
    }
  })

  it('⚠️ 幂等：紧接着再同步一次不写任何文件（不产生垃圾备份）', async () => {
    seedPi()
    seedZcode()
    const first = await applySync(fakeLlm(), { home })
    expect(first.applied).toHaveLength(2)
    const second = await applySync(fakeLlm(), { home })
    expect(second.applied).toHaveLength(0)
    expect(second.skipped.map(s => s.target).sort()).toEqual(['pi', 'zcode'])
    expect(second.skipped.every(s => /无需写入/.test(s.reason))).toBe(true)
  })

  it('⚠️ 注入校验失败时文件回滚成原字节', async () => {
    const piPath = seedPi()
    seedZcode()
    const original = readFileSync(piPath, 'utf-8')
    await expect(
      applySync(fakeLlm(), {
        home,
        validate: () => {
          throw new Error('故意失败')
        },
      }),
    ).rejects.toThrow(/故意失败/)
    expect(readFileSync(piPath, 'utf-8')).toBe(original)
  })

  it('目标文件缺失时跳过并说明原因，不创建文件', async () => {
    seedZcode()
    const result = await applySync(fakeLlm(), { home })
    const piSkip = result.skipped.find(s => s.target === 'pi')!
    expect(piSkip.reason).toMatch(/找不到配置文件/)
    expect(existsSync(resolveSyncPaths(home).piModels)).toBe(false)
  })

  it('替换掉的模型会被移除（目录里没了就清掉，避免残留报错）', async () => {
    const piPath = seedPi([{ id: 'codearts/gone', name: 'codearts/gone', contextWindow: 1, maxTokens: 1, input: ['text'] }])
    seedZcode(['codearts/gone'])
    const result = await applySync(fakeLlm(), { home })
    const piDiff = result.applied.find(a => a.target === 'pi')!.diff
    expect(piDiff.removed).toEqual(['codearts/gone'])
    const pi = JSON.parse(readFileSync(piPath, 'utf-8'))
    expect(pi.providers['dsh-gateway'].models.map((m: any) => m.id)).not.toContain('codearts/gone')
  })

  it('备份内容与同步前的文件逐字节一致', async () => {
    const piPath = seedPi()
    seedZcode()
    const before = readFileSync(piPath, 'utf-8')
    const result = await applySync(fakeLlm(), { home })
    const piEntry = result.applied.find(a => a.target === 'pi')!
    expect(readFileSync(join(piEntry.backupDir, 'models.json'), 'utf-8')).toBe(before)
  })

  it('⚠️⚠️ 目录为空时必须报错且一个字节都不写（绝不能清空用户配置）', async () => {
    const piPath = seedPi([{ id: 'codearts/GLM-5.2', name: 'x', contextWindow: 202752, maxTokens: 65536, input: ['text'] }])
    const zcodePath = seedZcode(['codearts/GLM-5.2'])
    const piBefore = readFileSync(piPath, 'utf-8')
    const zcodeBefore = readFileSync(zcodePath, 'utf-8')

    await expect(applySync({ listProviders: () => [], listModels: async () => [] }, { home })).rejects.toThrow(/没有返回任何模型|目录为空/)
    expect(readFileSync(piPath, 'utf-8')).toBe(piBefore)
    expect(readFileSync(zcodePath, 'utf-8')).toBe(zcodeBefore)
  })

  it('⚠️ 目录里模型的能力值全非法时同样拒绝（非空目录也得拦住，否则一样会清空）', async () => {
    const piPath = seedPi([{ id: 'codearts/GLM-5.2', name: 'x', contextWindow: 202752, maxTokens: 65536, input: ['text'] }])
    const before = readFileSync(piPath, 'utf-8')
    seedZcode(['codearts/GLM-5.2'])
    // 目录非空，但 contextWindow / maxTokens 都是 0 ⇒ 可写列表为空
    const badLlm: SyncModelSource = {
      listProviders: () => [{ id: 'codearts' }],
      listModels: async () => [{ id: 'GLM-5.2', name: 'GLM-5.2', contextWindow: 0, maxTokens: 0, inputModalities: ['text'] }],
    }
    await expect(applySync(badLlm, { home })).rejects.toThrow(/缺 contextWindow/)
    expect(readFileSync(piPath, 'utf-8')).toBe(before)
  })
})

describe('失败渠道保护 —— 端到端', () => {
  it('⚠️⚠️ 某渠道采集抛错时，目标里该渠道的模型必须保留且不报 removed', async () => {
    // fakeLlm 的 broken 渠道会抛错（模拟 token 过期）
    const piPath = seedPi([{ id: 'broken/legacy-model', name: 'broken/legacy-model', contextWindow: 1000, maxTokens: 100, input: ['text'] }])
    seedZcode(['broken/legacy-model'])
    const result = await previewSync(fakeLlm(), { home })

    expect(result.failedProviders).toContain('broken')
    const pi = result.targets.find(t => t.target === 'pi')!
    expect(pi.ok).toBe(true)
    expect(pi.diff!.removed).toEqual([])
    expect(pi.diff!.protectedModels).toEqual(['broken/legacy-model'])
  })

  it('⚠️ 落盘时同样保留（不是只在预览里好看）', async () => {
    const piPath = seedPi([{ id: 'broken/legacy-model', name: 'broken/legacy-model', contextWindow: 1000, maxTokens: 100, input: ['text'] }])
    seedZcode(['broken/legacy-model'])
    await applySync(fakeLlm(), { home })
    const pi = JSON.parse(readFileSync(piPath, 'utf-8'))
    expect(pi.providers['dsh-gateway'].models.map((m: any) => m.id)).toContain('broken/legacy-model')
  })

  it('渠道全部失败时不会误判成「目录为空」而整体拒绝（目录仍有其它渠道）', async () => {
    seedPi([{ id: 'broken/x', name: 'broken/x', contextWindow: 1000, maxTokens: 100, input: ['text'] }])
    seedZcode(['broken/x'])
    const result = await previewSync(fakeLlm(), { home })
    // codearts / minimax 正常 ⇒ 目录非空，仍可同步
    expect(result.modelCount).toBe(3)
    expect(result.targets.every(t => t.ok)).toBe(true)
  })
})

describe('渠道勾选（providers 白名单）', () => {
  it('preview 列出网关全部渠道及「是否已在目标里」', async () => {
    seedPi([{ id: 'codearts/GLM-5.2', name: 'x', contextWindow: 202752, maxTokens: 65536, input: ['text'] }])
    seedZcode(['codearts/GLM-5.2'])
    const result = await previewSync(fakeLlm(), { home })
    const byId = Object.fromEntries(result.providers.map(p => [p.id, p]))
    expect(byId.codearts.modelCount).toBe(2)
    expect(byId.minimax.modelCount).toBe(1)
    expect(byId.codearts.inTargets).toEqual({ pi: true, zcode: true })
    expect(byId.minimax.inTargets).toEqual({ pi: false, zcode: false })
    // providers 不受 providers 过滤影响（UI 要能列出全部供勾选）
    expect(result.totalModelCount).toBe(3)
  })

  it('只勾选部分渠道时 modelCount 只算选中的', async () => {
    seedPi()
    seedZcode()
    const result = await previewSync(fakeLlm(), { home, providers: ['codearts'] })
    expect(result.modelCount).toBe(2)
    expect(result.totalModelCount).toBe(3)
    const pi = result.targets.find(t => t.target === 'pi')!
    expect(pi.diff!.added.sort()).toEqual(['codearts/GLM-5.2', 'codearts/deepseek-v4-flash'])
  })

  it('⚠️⚠️ 未勾选的渠道必须保留（只同步 codearts 不能把 minimax 的模型删掉）', async () => {
    const piPath = seedPi([{ id: 'minimax/MiniMax-M3.1', name: 'x', contextWindow: 1000, maxTokens: 100, input: ['text'] }])
    seedZcode(['minimax/MiniMax-M3.1'])
    const result = await previewSync(fakeLlm(), { home, providers: ['codearts'] })
    const pi = result.targets.find(t => t.target === 'pi')!
    expect(pi.diff!.removed).toEqual([])
    expect(pi.diff!.protectedModels).toEqual(['minimax/MiniMax-M3.1'])

    // 落盘后该模型仍在
    await applySync(fakeLlm(), { home, providers: ['codearts'] })
    const piConfig = JSON.parse(readFileSync(piPath, 'utf-8'))
    const ids = piConfig.providers['dsh-gateway'].models.map((m: any) => m.id)
    expect(ids).toContain('minimax/MiniMax-M3.1')
    expect(ids).toContain('codearts/GLM-5.2')
  })

  it('⚠️ 空数组表示「一个都没选」⇒ 预览标不可同步、落盘报错（不清空）', async () => {
    const piPath = seedPi([{ id: 'codearts/GLM-5.2', name: 'x', contextWindow: 202752, maxTokens: 65536, input: ['text'] }])
    seedZcode(['codearts/GLM-5.2'])
    const before = readFileSync(piPath, 'utf-8')

    const preview = await previewSync(fakeLlm(), { home, providers: [] })
    expect(preview.modelCount).toBe(0)
    expect(preview.targets.every(t => !t.ok)).toBe(true)
    expect(preview.targets[0].error).toMatch(/没有勾选任何渠道/)

    await expect(applySync(fakeLlm(), { home, providers: [] })).rejects.toThrow(/没有勾选任何渠道/)
    expect(readFileSync(piPath, 'utf-8')).toBe(before)
  })

  it('缺省 providers（undefined）时行为与全选一致', async () => {
    seedPi()
    seedZcode()
    const result = await previewSync(fakeLlm(), { home })
    expect(result.modelCount).toBe(3)
    expect(result.targets.find(t => t.target === 'pi')!.diff!.added).toHaveLength(3)
  })
})

describe('手工模型保护 —— 网关里没有的渠道不得被删', () => {
  it('⚠️⚠️ 目标里手工加的渠道（网关目录完全没有）必须保留', async () => {
    const piPath = seedPi([{ id: 'my-lora/qwen-custom', name: 'my-lora/qwen-custom', contextWindow: 32000, maxTokens: 4096, input: ['text'] }])
    seedZcode(['my-lora/qwen-custom'])
    const result = await previewSync(fakeLlm(), { home })
    const pi = result.targets.find(t => t.target === 'pi')!
    expect(pi.diff!.removed).toEqual([])
    expect(pi.diff!.protectedModels).toEqual(['my-lora/qwen-custom'])

    await applySync(fakeLlm(), { home })
    const piConfig = JSON.parse(readFileSync(piPath, 'utf-8'))
    expect(piConfig.providers['dsh-gateway'].models.map((m: any) => m.id)).toContain('my-lora/qwen-custom')
  })

  it('⚠️ 但「渠道仍在目录里、只是某个模型下架」照常清理（保护不能变成永不删除）', async () => {
    // codearts 在目录里（11 个模型），但 retired-model 不在其中 ⇒ 应删除
    const piPath = seedPi([{ id: 'codearts/retired-model', name: 'x', contextWindow: 1000, maxTokens: 100, input: ['text'] }])
    seedZcode(['codearts/retired-model'])
    const result = await previewSync(fakeLlm(), { home })
    const pi = result.targets.find(t => t.target === 'pi')!
    expect(pi.diff!.removed).toEqual(['codearts/retired-model'])
    expect(pi.diff!.protectedModels).toEqual([])

    await applySync(fakeLlm(), { home })
    const piConfig = JSON.parse(readFileSync(piPath, 'utf-8'))
    expect(piConfig.providers['dsh-gateway'].models.map((m: any) => m.id)).not.toContain('codearts/retired-model')
  })

  it('两个目标各自的手工渠道独立保护（pi 有、ZCode 没有时互不影响）', async () => {
    const piPath = seedPi([{ id: 'pi-only/custom', name: 'x', contextWindow: 1000, maxTokens: 100, input: ['text'] }])
    seedZcode()
    await applySync(fakeLlm(), { home })
    const piConfig = JSON.parse(readFileSync(piPath, 'utf-8'))
    expect(piConfig.providers['dsh-gateway'].models.map((m: any) => m.id)).toContain('pi-only/custom')
  })
})

describe('诊断信息 —— 三种「空」必须能分开（用户实测踩过）', () => {
  it('⚠️⚠️ 勾了渠道但目录里匹配不到时，错误里必须回显收到的渠道 id', async () => {
    seedPi()
    seedZcode()
    // 传入一批网关目录里根本不存在的渠道 id（模拟前端传错 id 的接线 bug）
    const result = await previewSync(fakeLlm(), { home, providers: ['not-a-provider', 'also-wrong'] })
    expect(result.modelCount).toBe(0)
    expect(result.usableModelCount).toBe(0)
    expect(result.requestedProviders).toEqual(['not-a-provider', 'also-wrong'])
    const error = result.targets[0].error!
    expect(error).toContain('一个都不存在')
    // 必须把收到的 id 摆出来，否则用户看到「勾了 19 个却说没勾」无从下手
    expect(error).toContain('not-a-provider')
  })

  it('⚠️ 没勾选任何渠道时说「没勾选」，不能与「匹配不到」混用', async () => {
    seedPi()
    seedZcode()
    const result = await previewSync(fakeLlm(), { home, providers: [] })
    expect(result.targets[0].error).toContain('没有勾选任何渠道')
    expect(result.targets[0].error).not.toContain('一个都不存在')
  })

  it('⚠️ 渠道都对但模型全缺 contextWindow 时，文案必须指向能力值而非勾选', async () => {
    seedPi()
    seedZcode()
    const noCaps = {
      listProviders: () => [{ id: 'codearts' }],
      listModels: async () => [{ id: 'GLM-5.2', name: 'GLM-5.2' }],
    }
    const result = await previewSync(noCaps, { home, providers: ['codearts'] })
    expect(result.modelCount).toBe(1)
    expect(result.usableModelCount).toBe(0)
    expect(result.targets[0].error).toContain('contextWindow')
    expect(result.targets[0].error).not.toContain('没有勾选任何渠道')
    expect(result.targets[0].error).not.toContain('一个都不存在')
  })

  it('正常路径下 usableModelCount 反映可写模型数', async () => {
    seedPi()
    seedZcode()
    const result = await previewSync(fakeLlm(), { home })
    expect(result.totalModelCount).toBe(3)
    expect(result.modelCount).toBe(3)
    expect(result.usableModelCount).toBe(3)
  })
})

describe('contextWindow 补全 —— 真实 bug 回归（2026-11-11）', () => {
  /**
   * 真实报障：界面「已勾选 19/19」但「本次同步 0 个模型」。
   *
   * 根因：`llm.listModels()` 只保证返回 `{ id, name }`，**不带 contextWindow**。
   * 网关的 /v1/models 能给出 context_window，是因为它额外走了
   * `collectGatewayModelDetails()`（逐个 resolveModelInfo）+ `applyGatewayContextWindows()`。
   *
   * 下面的替身**故意**让 listModels 不带 contextWindow —— 旧实现会在这种替身上
   * 全量跳过，而真实 DSH 的 listModels 正是这个形态。
   */
  function llmWithoutContextWindow(): SyncModelSource {
    return {
      listProviders: () => [{ id: 'codearts' }],
      listModels: async () => [
        { id: 'GLM-5.2', name: 'GLM-5.2' },
        { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' },
      ],
      // 只有 resolveModelInfo 才带能力值
      resolveModelInfo: async (_provider: string, model: string) => ({
        context: { contextWindow: model === 'GLM-5.2' ? 202752 : 1000000 },
      }),
    } as SyncModelSource
  }

  it('⚠️⚠️ listModels 不带 contextWindow 时，必须靠 resolveModelInfo 补全（否则全量跳过）', async () => {
    seedPi()
    seedZcode()
    const result = await previewSync(llmWithoutContextWindow(), { home })
    expect(result.modelCount).toBe(2)
    // 关键：可写模型数必须是 2，而不是 0
    expect(result.usableModelCount).toBe(2)
    const pi = result.targets.find(t => t.target === 'pi')!
    expect(pi.ok).toBe(true)
    expect(pi.diff!.skipped).toEqual([])
    expect(pi.diff!.added.sort()).toEqual(['codearts/GLM-5.2', 'codearts/deepseek-v4.1-flash'])
  })

  it('补全后的窗口真的写进了目标（不是只在预览里显示）', async () => {
    const piPath = seedPi()
    seedZcode()
    await applySync(llmWithoutContextWindow(), { home })
    const pi = JSON.parse(readFileSync(piPath, 'utf-8'))
    const model = pi.providers['dsh-gateway'].models.find((m: any) => m.id === 'codearts/GLM-5.2')
    expect(model.contextWindow).toBe(202752)
  })

  it('⚠️ 两个来源都拿不到能力值时才跳过（且计入 skipped）', async () => {
    seedPi()
    seedZcode()
    const noInfo: SyncModelSource = {
      listProviders: () => [{ id: 'codearts' }],
      listModels: async () => [{ id: 'GLM-5.2', name: 'GLM-5.2' }],
    } as SyncModelSource
    const result = await previewSync(noInfo, { home })
    expect(result.modelCount).toBe(1)
    expect(result.usableModelCount).toBe(0)
    expect(result.targets[0].error).toContain('contextWindow')
  })

  it('resolveModelInfo 抛错不算渠道失败（渠道仍是好的，只是该模型缺窗口）', async () => {
    seedPi()
    seedZcode()
    const flaky: SyncModelSource = {
      listProviders: () => [{ id: 'codearts' }],
      listModels: async () => [{ id: 'GLM-5.2', name: 'GLM-5.2' }],
      resolveModelInfo: async () => { throw new Error('解析失败') },
    } as SyncModelSource
    const result = await previewSync(flaky, { home })
    // 不能因为能力值解析失败就把整个渠道标记为失败（那会误保护它的旧模型）
    expect(result.failedProviders).toEqual([])
    expect(result.usableModelCount).toBe(0)
  })
})

describe('目标选择（targets）', () => {
  it('⚠️⚠️ 只勾 pi 时，ZCode 的文件必须一个字节都不动', async () => {
    const piPath = seedPi()
    const zcodePath = seedZcode()
    const zcodeBefore = readFileSync(zcodePath, 'utf-8')

    const result = await applySync(fakeLlm(), { home, targets: ['pi'] })
    expect(result.applied.map(a => a.target)).toEqual(['pi'])
    // 未选中的目标要出现在 skipped 里并说明原因（否则用户分不清「没选」与「失败」）
    const zSkip = result.skipped.find(s => s.target === 'zcode')!
    expect(zSkip.reason).toContain('未选中')
    expect(readFileSync(zcodePath, 'utf-8')).toBe(zcodeBefore)
    // pi 确实写进去了
    const pi = JSON.parse(readFileSync(piPath, 'utf-8'))
    expect(pi.providers['dsh-gateway'].models.length).toBe(3)
  })

  it('只勾 ZCode 时 pi 的文件不动', async () => {
    const piPath = seedPi()
    seedZcode()
    const piBefore = readFileSync(piPath, 'utf-8')
    const result = await applySync(fakeLlm(), { home, targets: ['zcode'] })
    expect(result.applied.map(a => a.target)).toEqual(['zcode'])
    expect(readFileSync(piPath, 'utf-8')).toBe(piBefore)
  })

  it('缺省 targets = 两个都写', async () => {
    seedPi()
    seedZcode()
    const result = await applySync(fakeLlm(), { home })
    expect(result.applied.map(a => a.target).sort()).toEqual(['pi', 'zcode'])
  })

  it('⚠️ targets 为空数组时拒绝（不能「成功但什么都没写」）', async () => {
    const piPath = seedPi()
    seedZcode()
    const before = readFileSync(piPath, 'utf-8')
    await expect(applySync(fakeLlm(), { home, targets: [] })).rejects.toThrow(/没有选择任何要同步的 agent/)
    expect(readFileSync(piPath, 'utf-8')).toBe(before)
  })
})

/**
 * 审计回归（2026-11-12，PR #184 对抗性审计）。
 *
 * 这三条都对应实测过的**静默数据销毁 / 部分成功不可见**路径。
 */
describe('审计回归 —— 失败可见性与保护集', () => {
  it('⚠️⚠️ 个别模型 resolveModelInfo 失败不得删掉目标里已有的它，也不得把渠道报成失败', async () => {
    const piPath = seedPi([
      { id: 'codearts/GLM-5.2', name: 'GLM-5.2', contextWindow: 202752, maxTokens: 65536, input: ['text'] },
    ])
    const zcodePath = seedZcode(['codearts/GLM-5.2'])
    // 目标里已有该模型的能力规则（真实配置里它就是这么来的）——本轮拿不到窗口时不能连规则一起删
    const seededZcode = JSON.parse(readFileSync(zcodePath, 'utf-8'))
    seededZcode.config.modelConfigRules.providerModelRules.push({
      providerId: 'dsh-openai-gateway',
      modelId: 'codearts/GLM-5.2',
      contextWindow: 202752,
      maxTokens: 65536,
    })
    writeFileSync(zcodePath, JSON.stringify(seededZcode, null, 2) + '\n', 'utf-8')

    const flaky: SyncModelSource = {
      listProviders: () => [{ id: 'codearts' }],
      listModels: async () => [
        { id: 'GLM-5.2', name: 'GLM-5.2' },
        { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
      ],
      resolveModelInfo: async (_provider: string, id: string) => {
        if (id === 'GLM-5.2') throw new Error('解析失败')
        return { context: { contextWindow: 1000000 } }
      },
    } as SyncModelSource

    const preview = await previewSync(flaky, { home })
    // 渠道本身是好的 ⇒ 不能报「渠道失败」（否则 UI 会误导成整条不可用）
    expect(preview.failedProviders).toEqual([])
    expect(preview.usableModelCount).toBe(1)
    const piTarget = preview.targets.find(t => t.target === 'pi')!
    expect(piTarget.ok).toBe(true)
    expect(piTarget.diff.skipped).toEqual(['codearts/GLM-5.2'])
    // 关键不变式：skipped 与 removed 不能同时出现
    expect(piTarget.diff.removed).toEqual([])

    await applySync(flaky, { home })
    const pi = JSON.parse(readFileSync(piPath, 'utf-8'))
    expect(pi.providers['dsh-gateway'].models.map((m: any) => m.id))
      .toEqual(['codearts/GLM-5.2', 'codearts/deepseek-v4-flash'])
    // ZCode 侧同理：受保护的模型必须还在（旧 provider 会被迁到 dsh-<渠道>，但模型不能丢）
    const zcode = JSON.parse(readFileSync(zcodePath, 'utf-8'))
    const zProvider = zcode.config.providerConfigRules.providerRules
      .find((p: any) => p.providerId === 'dsh-codearts')
    expect(zProvider).toBeTruthy()
    expect(zProvider.config.personalModelIds).toContain('codearts/GLM-5.2')
    const zRules = zcode.config.modelConfigRules.providerModelRules
    expect(zRules.some((r: any) => r.modelId === 'codearts/GLM-5.2')).toBe(true)
  })

  it('⚠️ 第二个目标写入失败时，错误里必须点名「已回滚的目标」并给出备份目录', async () => {
    const piPath = seedPi()
    seedZcode()
    const piBefore = readFileSync(piPath, 'utf-8')
    const error = await applySync(fakeLlm(), {
      home,
      validate: async (target: string) => {
        if (target === 'zcode') throw new Error('模拟写入失败')
      },
    }).then(() => null, (caught: Error) => caught)
    expect(error).toBeTruthy()
    expect(error!.message).toContain('zcode')
    expect(error!.message).toContain('模拟写入失败')
    // ⚠️ 多目标是「全有或全无」：pi 已经被还原到同步前的字节，
    //    用户不需要再担心「它到底改没改」（旧实现只报告「已经写了」，留半成品）。
    expect(error!.message).toContain('pi')
    expect(error!.message).toContain('备份')
    expect(readFileSync(piPath, 'utf-8')).toBe(piBefore)
  })

  it('⚠️ 计划阶段抛错（同名 provider 指向别家）只跳过该目标，不让整次同步失败', async () => {
    seedPi()
    const zcodePath = seedZcode([])
    // 手工建了一条 dsh-codearts，但端点指向别处 ⇒ 重建时该 providerId 已被占用
    const config = JSON.parse(readFileSync(zcodePath, 'utf-8'))
    config.config.providerConfigRules.providerRules.push({
      providerId: 'dsh-codearts',
      providerName: 'dsh-codearts',
      enabled: true,
      config: {
        access: { type: 'api-key', apiKey: 'k' },
        api: { type: 'openai-chat-completions', baseUrl: 'https://elsewhere.example/v1' },
        personalModelIds: [],
        modelOrder: [],
      },
    })
    writeFileSync(zcodePath, JSON.stringify(config, null, 2) + '\n', 'utf-8')
    const before = readFileSync(zcodePath, 'utf-8')

    const result = await applySync(fakeLlm(), { home })
    expect(result.applied.map(a => a.target)).toEqual(['pi'])
    const zSkip = result.skipped.find(s => s.target === 'zcode')!
    // 不静默覆盖用户手工 provider，而是明确拒绝并说明原因
    expect(zSkip.reason).toContain('dsh-codearts')
    expect(zSkip.reason).toContain('已拒绝同步')
    expect(readFileSync(zcodePath, 'utf-8')).toBe(before)
  })
})

describe('审计回归 —— 目录采集缓存', () => {
  /** 包一层计数：`SyncModelSource` 的每个方法各被调了几次。 */
  function countingLlm(base: SyncModelSource) {
    const counts = { listProviders: 0, listModels: 0, resolveModelInfo: 0 }
    const source: SyncModelSource = {
      listProviders: () => { counts.listProviders += 1; return base.listProviders() },
      listModels: async (provider: string) => { counts.listModels += 1; return base.listModels(provider) },
      resolveModelInfo: async () => {
        counts.resolveModelInfo += 1
        return { context: { contextWindow: 100000 } }
      },
    }
    return { source, counts }
  }

  it('⚠️ preview 与 apply 共用同一份目录快照（apply 不再重新采集）', async () => {
    seedPi([])
    seedZcode([])
    const { source, counts } = countingLlm(fakeLlm())

    await previewSync(source, { home })
    const afterPreview = { ...counts }
    // 一次采集 = 3 个 provider 各一次 listModels（broken 抛错）+ 3 个模型各一次 resolveModelInfo
    expect(afterPreview.listModels).toBe(3)
    expect(afterPreview.resolveModelInfo).toBe(3)

    await applySync(source, { home })
    // apply 复用预览那一份 ⇒ 零新增采集。这正是「保护集不漂移」的前提：
    // 两次采集之间目录一变，failedProviders 就会不同 ⇒「预览说保留、落盘却删除」。
    expect(counts.listModels).toBe(afterPreview.listModels)
    expect(counts.resolveModelInfo).toBe(afterPreview.resolveModelInfo)
  })

  it('force:true 会重新采集（UI「刷新」按钮必须能真的重读网关）', async () => {
    seedPi([])
    seedZcode([])
    const { source, counts } = countingLlm(fakeLlm())

    await previewSync(source, { home })
    expect(counts.listModels).toBe(3)

    await previewSync(source, { home, force: true })
    expect(counts.listModels).toBe(6)
  })
})

describe('审计回归 —— 多目标事务与写后复算', () => {
  it('⚠️ ZCode 写入失败时，已经写成功的 pi 必须被还原', async () => {
    const piPath = seedPi([{ id: 'codearts/old-model', name: 'codearts/old-model', contextWindow: 1000, maxTokens: 100, input: ['text'] }])
    const zcodePath = seedZcode(['codearts/old-model'])
    const piBefore = readFileSync(piPath, 'utf-8')
    const zcodeBefore = readFileSync(zcodePath, 'utf-8')

    await expect(applySync(fakeLlm(), {
      home,
      validate: (target) => {
        if (target === 'zcode') throw new Error('模拟 ZCode 写入失败')
      },
    })).rejects.toThrow(/模拟 ZCode 写入失败/)

    // 全有或全无：不能留下「pi 改了、ZCode 没改」的半成品状态
    // （用户点一次「同步」是一个原子意图，半成品比干脆失败更难恢复）
    expect(readFileSync(piPath, 'utf-8')).toBe(piBefore)
    expect(readFileSync(zcodePath, 'utf-8')).toBe(zcodeBefore)
  })

  it('回滚成功时错误文案要说明「已自动回滚」并给出备份目录', async () => {
    seedPi([])
    seedZcode([])
    let message = ''
    try {
      await applySync(fakeLlm(), {
        home,
        validate: (target) => {
          if (target === 'zcode') throw new Error('模拟写入失败')
        },
      })
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toContain('已自动回滚')
    expect(message).toContain('备份：')
    expect(message).toContain('pi')
  })

  it('⚠️ 写后幂等复算失败必须回滚（M09：删掉复算时这条会红）', async () => {
    const piPath = seedPi([])
    const before = readFileSync(piPath, 'utf-8')
    let planCalls = 0

    await expect(applySync(fakeLlm(), {
      home,
      targets: ['pi'],
      // 正常实现下 `plan` 对刚写入的配置必然返回空 diff —— 所以「写后复算」
      // 这条防御在无注入时不可能失败，也就永远不可能有用例守它（审计 M09）。
      // 这里包一层，让第二次（= 复算）故意报告仍有差异。
      targetOps: (target, paths, models, gatewayBaseUrl) => ({
        path: paths.piModels,
        plan: (config: any, planOptions?: any) => {
          planCalls += 1
          const planned = planPiSync(config, models, gatewayBaseUrl, planOptions)
          return planCalls >= 2
            ? { ...planned, diff: { added: ['ghost/model'], removed: [], updated: [], skipped: [], protectedModels: [] } }
            : planned
        },
      }),
    })).rejects.toThrow(/写入后复算仍有差异/)

    expect(readFileSync(piPath, 'utf-8')).toBe(before)
  })
})
