/**
 * 「同步到外部工具」的**磁盘层**：备份 → 写入 → 复读校验 → 失败回滚。
 *
 * ## 为什么备份和回滚必须在这里，而不是交给调用方
 *
 * 目标文件是**别人的应用配置**（pi 的 models.json、ZCode 的 provider_config.json）。
 * 写坏它们等于砸掉用户另外两个工具的模型列表。所以：
 * - 写之前先把原字节存成备份（回滚的唯一依据）；
 * - 写完立刻复读校验，失败就用原字节整体还原；
 * - 回滚发生时**备份仍保留**，用户可人工比对。
 *
 * ## 与 ZCode 侧 skill 的一致性
 *
 * 备份目录沿用 `backups/before-*-<时间戳>/` 的既有约定与 `indent 2 + 末尾换行` 的
 * 书写格式，使两处产出的文件字节风格一致。
 *
 * @module src/sync-apply.ts
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'

/** 同步涉及的绝对路径。 */
export interface SyncPaths {
  /** pi 的 provider/模型表。 */
  piModels: string
  /** ZCode 的个人 provider 规则（含模型 id 列表与能力规则）。 */
  zcodeProviderConfig: string
}

/** 磁盘层失败（读不到、写不了、格式不认识）。 */
export class SyncApplyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SyncApplyError'
  }
}

/** 展开用户家目录前缀（env 里允许写 `~/...`，Node 不认）。 */
function expandHome(path: string, home: string): string {
  if (path === '~') return home
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(home, path.slice(2))
  return path
}

/**
 * 解析两个目标文件的路径。
 *
 * ## 为什么必须读环境变量，而不是只按 `homedir()` 拼
 *
 * 两个目标都有**官方支持**的目录覆盖点，写死默认路径会在用户设了它们之后
 * 悄悄写错文件（表现是「同步成功但目标里什么都没变」）：
 *
 * | 目标 | 覆盖变量 | 默认 |
 * |---|---|---|
 * | pi | `PI_CODING_AGENT_DIR`（pi 官方文档 environment-variables 明列） | `~/.pi/agent` |
 * | ZCode | `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE`（官方 CLI 启动脚本自己就在设） | `~/.zcode/v2/provider_config.json` |
 *
 * `homedir()` 是**运行时**取的，所以换机器、换用户名都能用；这里只补上
 * 「同一个用户在别处覆盖过」这条路径。
 *
 * @param home 家目录（单测注入）
 * @param env 环境变量来源（默认 `process.env`）
 */
export function resolveSyncPaths(home: string = homedir(), env: NodeJS.ProcessEnv = process.env): SyncPaths {
  const piDirRaw = env.PI_CODING_AGENT_DIR?.trim()
  const piDir = piDirRaw ? expandHome(piDirRaw, home) : join(home, '.pi', 'agent')
  const zcodeRaw = env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE?.trim()
  const zcodeProviderConfig = zcodeRaw
    ? expandHome(zcodeRaw, home)
    : join(home, '.zcode', 'v2', 'provider_config.json')
  return { piModels: join(piDir, 'models.json'), zcodeProviderConfig }
}

/**
 * 读取目标 JSON 配置。
 *
 * 用 `utf-8` 解码后手工剥掉 BOM：Windows 上被记事本/VS Code 保存过的文件常带 BOM，
 * `JSON.parse` 遇到它会直接抛「Unexpected token」。
 */
export function readJsonConfig<T = any>(path: string): T {
  if (!existsSync(path)) {
    throw new SyncApplyError(`找不到配置文件：${path}`)
  }
  let text: string
  try {
    text = readFileSync(path, 'utf-8')
  } catch (error) {
    throw new SyncApplyError(`读不了配置文件：${path}（${(error as Error).message}）`)
  }
  const cleaned = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  try {
    return JSON.parse(cleaned) as T
  } catch (error) {
    throw new SyncApplyError(`配置文件不是合法 JSON：${path}（${(error as Error).message}）`)
  }
}

/** 备份目录用的时间戳：秒级 + 毫秒，保证连续两次同步不撞名。 */
function stamp(): string {
  const now = new Date()
  const pad = (value: number, width = 2) => String(value).padStart(width, '0')
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    '-',
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
    '-',
    pad(now.getMilliseconds(), 3),
  ].join('')
}

/**
 * 把 `config` 写入 `path`，并保证可回滚。
 *
 * @param validate 写入后的复读校验；抛错即触发回滚。缺省只验证「能解析回对象」。
 * @returns `backupDir`：本次备份目录（UI 要把它显示给用户）
 */
export async function applyJsonPlan(
  path: string,
  config: unknown,
  validate?: (path: string) => void | Promise<void>,
): Promise<{ backupDir: string; backupFile: string }> {
  if (!existsSync(path)) {
    throw new SyncApplyError(`目标文件不存在，拒绝创建：${path}`)
  }
  const original = readFileSync(path)

  // 1) 先备份成独立目录：目录名不重样，历史备份不会被覆盖
  const backupDir = join(dirname(path), 'backups', `before-jethub-sync-${stamp()}`)
  mkdirSync(backupDir, { recursive: true })
  const backupFile = join(backupDir, basename(path))
  copyFileSync(path, backupFile)

  // 2) 写入：与 ZCode skill 产出的字节风格一致（2 空格缩进 + 末尾换行）
  const encoded = Buffer.from(JSON.stringify(config, null, 2) + '\n', 'utf-8')
  writeFileSync(path, encoded)

  // 3) 复读校验：失败一律整体回滚到原字节
  try {
    // 缺省校验也要 parse 一次：能写进去却读不回来（编码/截断问题）同样必须回滚
    readJsonConfig(path)
    if (validate) await validate(path)
  } catch (error) {
    writeFileSync(path, original)
    throw error
  }
  return { backupDir, backupFile }
}
