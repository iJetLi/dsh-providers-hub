import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyJsonPlan, readJsonConfig, resolveSyncPaths, SyncApplyError } from '../../src/sync-apply.js'

/**
 * 磁盘层用例：**全部在 mkdtemp 临时目录里**，绝不碰用户的真实
 * `~/.pi` 与 `~/.zcode`。
 *
 * 这一层只负责「备份 → 写入 → 复读校验 → 失败回滚」，
 * 不懂 pi / ZCode 的字段语义（那是 sync-targets.ts 的事）。
 */

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'jethub-sync-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** 在临时目录里造一个待同步的目标文件，返回其路径。 */
function seed(relative: string, content: unknown): string {
  const path = join(root, relative)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, JSON.stringify(content, null, 2) + '\n', 'utf-8')
  return path
}

describe('resolveSyncPaths — 目标路径解析', () => {
  it('按 home 拼出两个目标的默认路径（homedir 是运行时取的，换机器同样成立）', () => {
    const paths = resolveSyncPaths('/home/someone', {})
    expect(paths.piModels.replace(/\\/g, '/')).toBe('/home/someone/.pi/agent/models.json')
    expect(paths.zcodeProviderConfig.replace(/\\/g, '/')).toBe('/home/someone/.zcode/v2/provider_config.json')
  })

  it('⚠️⚠️ pi 的 PI_CODING_AGENT_DIR 覆盖必须生效（pi 官方文档明列的配置目录变量）', () => {
    const paths = resolveSyncPaths('/home/someone', { PI_CODING_AGENT_DIR: '/data/pi-agent' })
    expect(paths.piModels.replace(/\\/g, '/')).toBe('/data/pi-agent/models.json')
    // 未覆盖的那个目标不受影响
    expect(paths.zcodeProviderConfig.replace(/\\/g, '/')).toBe('/home/someone/.zcode/v2/provider_config.json')
  })

  it('⚠️⚠️ ZCode 的 ZCODE_PERSONAL_PROVIDER_CONFIG_FILE 覆盖必须生效（官方 CLI 启动脚本自己在设它）', () => {
    const paths = resolveSyncPaths('/home/someone', { ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: '/data/zc/pc.json' })
    expect(paths.zcodeProviderConfig.replace(/\\/g, '/')).toBe('/data/zc/pc.json')
    expect(paths.piModels.replace(/\\/g, '/')).toBe('/home/someone/.pi/agent/models.json')
  })

  it('覆盖值支持 ~/ 前缀（Node 自己不会展开）', () => {
    const paths = resolveSyncPaths('/home/someone', { PI_CODING_AGENT_DIR: '~/alt-agent' })
    expect(paths.piModels.replace(/\\/g, '/')).toBe('/home/someone/alt-agent/models.json')
  })

  it('覆盖值为空白时回落到默认路径（不生成空目录拼接）', () => {
    const paths = resolveSyncPaths('/home/someone', { PI_CODING_AGENT_DIR: '   ' })
    expect(paths.piModels.replace(/\\/g, '/')).toBe('/home/someone/.pi/agent/models.json')
  })
})

describe('readJsonConfig — 读取目标配置', () => {
  it('读得到内容', () => {
    const path = seed('config.json', { hello: 'world' })
    expect(readJsonConfig(path)).toEqual({ hello: 'world' })
  })

  it('兼容带 BOM 的文件（Windows 上手工编辑过就会出现）', () => {
    const path = join(root, 'bom.json')
    writeFileSync(path, '\uFEFF{"a":1}', 'utf-8')
    expect(readJsonConfig(path)).toEqual({ a: 1 })
  })

  it('文件不存在时抛 SyncApplyError 而不是 ENOENT（错误信息要能给人看）', () => {
    expect(() => readJsonConfig(join(root, 'nope.json'))).toThrow(SyncApplyError)
  })

  it('内容不是合法 JSON 时抛 SyncApplyError 并带上路径', () => {
    const path = join(root, 'broken.json')
    writeFileSync(path, '{ not json', 'utf-8')
    expect(() => readJsonConfig(path)).toThrow(/broken\.json/)
  })
})

describe('applyJsonPlan — 备份 / 写入 / 校验 / 回滚', () => {
  it('写入格式化内容（2 空格缩进 + 末尾换行）', async () => {
    const path = seed('models.json', { before: true })
    await applyJsonPlan(path, { after: true })
    const text = readFileSync(path, 'utf-8')
    expect(text).toBe(JSON.stringify({ after: true }, null, 2) + '\n')
  })

  it('⚠️ 备份必须与原文件逐字节一致（回滚的唯一依据）', async () => {
    const original = JSON.stringify({ before: true }, null, 2) + '\n'
    const path = seed('models.json', { before: true })
    const result = await applyJsonPlan(path, { after: true })
    const backupFile = join(result.backupDir, 'models.json')
    expect(readFileSync(backupFile, 'utf-8')).toBe(original)
  })

  it('备份落在同级的 backups/before-jethub-sync-* 目录里', async () => {
    const path = seed('models.json', { before: true })
    const result = await applyJsonPlan(path, { after: true })
    expect(result.backupDir.replace(/\\/g, '/')).toMatch(/\/backups\/before-jethub-sync-/)
    expect(existsSync(result.backupDir)).toBe(true)
    expect(readdirSync(join(root, 'backups'))).toHaveLength(1)
  })

  it('⚠️ 校验失败必须回滚成原字节', async () => {
    const original = JSON.stringify({ before: true }, null, 2) + '\n'
    const path = seed('models.json', { before: true })
    await expect(
      applyJsonPlan(path, { after: true }, () => {
        throw new Error('校验故意失败')
      }),
    ).rejects.toThrow(/校验故意失败/)
    expect(readFileSync(path, 'utf-8')).toBe(original)
  })

  it('回滚后备份仍然保留（事后还能人工比对）', async () => {
    const path = seed('models.json', { before: true })
    let backupDir = ''
    try {
      await applyJsonPlan(path, { after: true }, (target: string) => {
        backupDir = join(target, '..', 'backups')
        throw new Error('boom')
      })
    } catch {
      // 预期内
    }
    expect(existsSync(backupDir)).toBe(true)
  })

  it('源文件不存在时拒绝写入（不凭空创建别人的配置）', async () => {
    await expect(applyJsonPlan(join(root, 'missing.json'), { a: 1 })).rejects.toThrow(SyncApplyError)
  })

  it('连续两次同步会生成两个独立备份目录（不覆盖历史）', async () => {
    const path = seed('models.json', { v: 0 })
    await applyJsonPlan(path, { v: 1 })
    await new Promise(resolve => setTimeout(resolve, 5))
    await applyJsonPlan(path, { v: 2 })
    expect(readdirSync(join(root, 'backups'))).toHaveLength(2)
  })
})
