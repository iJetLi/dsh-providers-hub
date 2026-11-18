/**
 * Marvis uskey 钩子的运维 CLI + 启动自愈。
 *
 * ## 自愈（本模块的主要价值）
 *
 * Marvis 升级会换版本目录，钩子随之失效。与其等用户在某个早晨撞上 403，
 * 不如在**每次内核启动时**静默校验一次：缺了就补、模板旧了就刷。
 * 因为 `ensureMarvisHook()` 是幂等的，正常情况下的开销只是读一个文件。
 *
 * ⚠️ 无写权限时（见 `marvis-hook-install.ts` 的权限说明）自愈只会**记一条
 * debug 日志**并放过，绝不打断启动、绝不弹 UAC。
 *
 * ## CLI
 *
 * ```
 * node lib/marvis-hook-cli.js status      # 体检（默认）
 * node lib/marvis-hook-cli.js install     # 安装 / 修复（必要时走一次 UAC）
 * node lib/marvis-hook-cli.js uninstall   # 卸载，恢复原状
 * ```
 *
 * @module src/marvis-hook-cli.ts
 */
import { execFileSync } from 'node:child_process'
import { inspectMarvisBridge } from './marvis-uskey-bridge.js'
import { ensureMarvisHook, removeMarvisHook } from './marvis-hook-install.js'

/** 极简 logger 形状（与宿主 `ctx.logger` 兼容）。 */
export interface MarvisHookLogger {
  warn?: (message: string) => void
  debug?: (message: string) => void
}

/** 打印体检结果（人类可读）。 */
export function formatBridgeStatus(): string {
  const status = inspectMarvisBridge()
  const lines: string[] = []
  lines.push(`Marvis uskey 桥：${status.healthy ? '✅ 就绪' : '❌ 未就绪'}`)
  lines.push(`  结论：${status.summary}`)
  if (status.install !== undefined) {
    lines.push(`  版本：${status.install.version}`)
    lines.push(`  钩子：${status.install.hookPath}`)
    lines.push(`        存在=${status.install.hookInstalled} 属于本插件=${status.install.hookIsOurs}`)
  }
  lines.push(`  Marvis 进程：${status.agentRunning ? '在运行' : '未运行'}`)
  if (status.lastLogLine !== undefined) lines.push(`  钩子日志：${status.lastLogLine}`)
  return lines.join('\n')
}

/**
 * 启动自愈：**静默**确保钩子存在。
 *
 * ⚠️ 绝不抛异常、绝不阻塞启动：它只是「顺手把环境修好」，
 *    权限不足等情况留给用户在 UI / CLI 上按需查看。
 *
 * @returns 是否发生了实际写入（上层可据此提示「需重启 Marvis」）
 */
export function selfHealMarvisHook(logger?: MarvisHookLogger): boolean {
  try {
    const result = ensureMarvisHook()
    if (result.ok && (result.action === 'installed' || result.action === 'repaired')) {
      logger?.warn?.(`marvis: ${result.message}`)
      return true
    }
    if (!result.ok) {
      // 最常见的两种「不算错」：没装 Marvis、权限不足。都降级成 debug。
      logger?.debug?.(`marvis: 钩子自愈跳过 —— ${result.message}`)
    }
    return false
  }
  catch (error) {
    logger?.debug?.(`marvis: 钩子自愈异常 —— ${error instanceof Error ? error.message : String(error)}`)
    return false
  }
}

/* ----------------------------- CLI 入口 ----------------------------- */

/** 是否是直接执行（而非被 import）。 */
function isMain(): boolean {
  return /marvis-hook-cli\.(js|ts)$/.test(process.argv[1] ?? '')
}

if (isMain()) {
  const command = process.argv[2] ?? 'status'

  if (command === 'install') {
    let result = ensureMarvisHook({ force: true })
    // 权限不足时尝试一次 UAC 提权重装（Windows）。
    if (!result.ok && result.needsElevation === true && process.platform === 'win32') {
      try {
        execFileSync(
          'powershell.exe',
          [
            '-NoProfile',
            '-Command',
            `Start-Process -Verb RunAs -Wait -FilePath '${process.execPath}' `
              + `-ArgumentList '${process.argv[1]}','install'`,
          ],
          { stdio: 'ignore', timeout: 120_000 },
        )
        // 提权进程已写入；这里重新校验（不再 force）。
        result = ensureMarvisHook()
      }
      catch {
        // 用户拒了 UAC 或提权失败：保留原始结果
      }
    }
    console.log(result.ok ? `✅ ${result.message}` : `❌ ${result.message}`)
    process.exitCode = result.ok ? 0 : 1
  }
  else if (command === 'uninstall') {
    const result = removeMarvisHook()
    console.log(result.ok ? `✅ ${result.message}` : `❌ ${result.message}`)
    process.exitCode = result.ok ? 0 : 1
  }
  else {
    console.log(formatBridgeStatus())
  }
}