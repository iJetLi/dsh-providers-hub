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

import { randomBytes } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
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

/**
 * 备份目录用的时间戳：秒级 + 毫秒 + 2 字节随机后缀。
 *
 * ⚠️ 只到毫秒不够：同一毫秒的两次同步（连点两次 / 脚本并发）会拿到同一个目录名，
 *    而 `mkdirSync({recursive:true})` 不报错、`copyFileSync` 直接覆盖上一份备份
 *    ⇒ 用户以为有两个还原点，实际只有一个。
 */
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
  ].join('') + '-' + randomBytes(2).toString('hex')
}

/**
 * 目标文件原有的书写风格（BOM + 换行符）。
 *
 * ## 为什么必须逐字节保留
 *
 * 这两个配置文件是**别人的应用**在读的，重写风格会带来两种真实伤害：
 * - **吞掉 BOM**：部分 Windows 工具（PowerShell 5 的 `Get-Content`、
 *   .NET 默认解码器）按系统 ANSI 代码页读，没 BOM 时中文模型名会变乱码；
 * - **把 CRLF 改成 LF**：用户的 `git diff` 从此显示整文件改动，
 *   下次手工合并冲突时无法分辨哪一行是真的变了。
 *
 * 两者都不是「格式偏好」，而是**别人文件的破坏性变更**，所以只能原样保留。
 */
export interface JsonFileStyle {
  /** 原文件是否带 UTF-8 BOM。 */
  bom: boolean
  /** 原文件的换行符（整文件统一取「是否出现过 CRLF」）。 */
  eol: '\n' | '\r\n'
}

/** 从原文件的原始字节里读出书写风格。 */
export function detectJsonFileStyle(original: Buffer): JsonFileStyle {
  const bom = original.length >= 3 && original[0] === 0xef && original[1] === 0xbb && original[2] === 0xbf
  return { bom, eol: original.includes(0x0d) ? '\r\n' : '\n' }
}

/**
 * 按给定风格把 `config` 编码回字节。
 *
 * `JSON.stringify` 产出的换行符只可能是 `\n`（字符串值里的换行会被转义成字面量
 * `\n`），所以整体替换是安全的。
 */
export function encodeJsonConfig(config: unknown, style: JsonFileStyle): Buffer {
  const body = JSON.stringify(config, null, 2) + '\n'
  const withEol = style.eol === '\r\n' ? body.replace(/\n/g, '\r\n') : body
  return Buffer.from((style.bom ? '\ufeff' : '') + withEol, 'utf-8')
}

/**
 * 把 `config` 写入 `path`，并保证可回滚。
 *
 * @param validate 写入后的复读校验；抛错即触发回滚。缺省只验证「能解析回对象」。
 * @returns `backupDir`：本次备份目录（UI 要把它显示给用户）；
 *          `original`：写入前的原始字节（跨目标事务回滚用）
 */
export async function applyJsonPlan(
  path: string,
  config: unknown,
  validate?: (path: string) => void | Promise<void>,
): Promise<{ backupDir: string; backupFile: string; original: Buffer }> {
  if (!existsSync(path)) {
    throw new SyncApplyError(`目标文件不存在，拒绝创建：${path}`)
  }
  const original = readFileSync(path)

  // 1) 先备份成独立目录：目录名不重样，历史备份不会被覆盖
  let backupDir = ''
  let backupFile = ''
  try {
    backupDir = join(dirname(path), 'backups', `before-jethub-sync-${stamp()}`)
    mkdirSync(backupDir, { recursive: true })
    backupFile = join(backupDir, basename(path))
    copyFileSync(path, backupFile)
  } catch (error) {
    // fail-closed：没有备份就不写，否则「写坏了也没法还原」
    throw new SyncApplyError(
      `备份失败，已放弃同步（目标文件未改动）：${path}（${(error as Error).message}）`,
    )
  }

  // 2) 写入：先写同目录临时文件再 rename —— 原子替换。
  //    ⚠️ 旧实现直接 `writeFileSync(path, …)` 且在 try 外：实测磁盘满时
  //    71 字节的目标文件被截成 0 字节，而「回滚」根本没机会执行。
  //
  //    ⚠️ 编码必须**沿用原文件的 BOM 与换行符**（见 `JsonFileStyle`）：
  //    整文件重写时用 `JSON.stringify(...) + '\n'` 会静默吞掉 BOM、把 CRLF 抹成 LF。
  const encoded = encodeJsonConfig(config, detectJsonFileStyle(original))
  const tempFile = join(dirname(path), `.${basename(path)}.${randomBytes(4).toString('hex')}.tmp`)
  let replaced = false
  try {
    writeFileSync(tempFile, encoded)
    renameSync(tempFile, path)
    replaced = true

    // 3) 复读校验：失败一律整体回滚到原字节
    readJsonConfig(path)
    if (validate) await validate(path)
  } catch (error) {
    // 走到这里有两种可能：
    // ① 还没 rename（临时文件写失败）⇒ 目标文件原封不动，不需要回滚；
    // ② 已经 rename（校验失败）⇒ 必须用原字节还原。
    if (replaced) {
      try {
        writeFileSync(path, original)
      } catch (rollbackError) {
        // ⚠️ 回滚失败**绝不能吞掉原始错误**（旧实现会在 catch 里再写一次，
        //    回滚失败时抛的是回滚的错误，用户看到的原因完全错位）。
        throw new SyncApplyError(
          `${(error as Error).message}\n`
          + `⚠️ 自动回滚也失败（${(rollbackError as Error).message}），目标文件可能处于不一致状态：`
          + `${path}（备份：${backupFile}）`,
        )
      }
    }
    throw error
  } finally {
    // 临时文件没被 rename 走就清掉，不在别人的配置目录里留垃圾
    try {
      rmSync(tempFile, { force: true })
    } catch {
      // 清理失败不影响主流程
    }
  }
  return { backupDir, backupFile, original }
}
