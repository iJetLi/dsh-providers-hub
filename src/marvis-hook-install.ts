/**
 * Marvis uskey 钩子的**安装 / 修复 / 卸载**。
 *
 * ## 为什么需要它（这是「升级即坏」的正解）
 *
 * 钩子必须写进 **MarvisAgent 当前版本目录**：
 *
 * ```
 * <root>\MarvisAgent\<version>\_internal\sitecustomize.py
 * ```
 *
 * 而 Marvis 每次升级都会新建版本目录（如 `1.60.3500.816` → 下一版），旧目录里的
 * 钩子随之失效 —— 用户看到的就是「昨天还好，今天突然 403」。
 *
 * 所以本模块**不做一次性安装**，而是提供幂等的 `ensureMarvisHook()`：
 * 每次调用都重新定位「当前最高版本目录」，发现钩子缺失/过期就重新写入。
 *
 * ## 权限（实测结论）
 *
 * ⚠️ **2026-11-18 实测**：即使 Marvis 装在非系统盘，`_internal` 目录**仍然
 * 不可被普通进程写入**（`EPERM`）—— 它由安装器以受保护 ACL 创建。
 * 因此**首次安装必须提权**（UAC 一次）。此后：
 *
 * - `ensureMarvisHook()` 在无权限时返回 `needsElevation: true`，**不抛**；
 * - `selfHealMarvisHook()` 遇到该情况**静默跳过**（启动路径上不能弹 UAC）；
 * - CLI 的 `install` 会在需要时**主动**走一次 UAC（`Start-Process -Verb RunAs`）。
 *
 * ⚠️ 故「升级后全自动重装」在无提权场景下做不到：升级换了版本目录后，自愈会
 * 检测到并给出明确提示，用户需跑一次 CLI 并确认 UAC。这是 Windows ACL 的
 * 硬限制，不是实现取舍。
 *
 * @module src/marvis-hook-install.ts
 */
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HOOK_MARKER, USKEY_LOG_PATH, USKEY_RPC_DIR, locateMarvisInstall } from './marvis-uskey-bridge.js'

/** 与本模块同目录的钩子模板。 */
const HOOK_TEMPLATE_PATH = join(dirname(fileURLToPath(import.meta.url)), 'marvis-uskey-hook.py')

/** 安装结果。 */
export interface MarvisHookInstallResult {
  /** 是否最终处于「已装好」状态。 */
  ok: boolean
  /** 做了什么。 */
  action: 'installed' | 'already' | 'repaired' | 'failed'
  /** 目标路径（定位成功时）。 */
  hookPath?: string
  /** 当前 Marvis 版本。 */
  version?: string
  /** 写入失败时是否需要管理员权限。 */
  needsElevation?: boolean
  /** 人话结论（可直接显示）。 */
  message: string
}

/**
 * 读模板并把占位符换成真实路径。
 *
 * 用 `JSON.stringify` 生成合法的 Python 字符串字面量（含转义），比手工拼
 * `r"..."` 安全：路径里出现引号/反斜杠都不会破坏语法。
 */
function renderHook(): string {
  const template = readFileSync(HOOK_TEMPLATE_PATH, 'utf8')
  return template
    .replace('r"{{RPC_DIR}}"', JSON.stringify(USKEY_RPC_DIR))
    .replace('r"{{LOG_PATH}}"', JSON.stringify(USKEY_LOG_PATH))
}

/** 判断错误是否为权限类。 */
function isPermissionError(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code
  return code === 'EPERM' || code === 'EACCES'
}

/**
 * 确保钩子已安装到**当前** Marvis 版本目录（幂等）。
 *
 * @param opts.force 即使已存在也重写（用于模板升级后刷新）
 * @returns 结果对象；**不抛**权限错误，改为 `needsElevation`
 */
export function ensureMarvisHook(opts: { force?: boolean } = {}): MarvisHookInstallResult {
  const install = locateMarvisInstall()
  if (install === undefined) {
    return {
      ok: false,
      action: 'failed',
      message: '未找到 Marvis 安装目录 —— 确认 Marvis 已安装，或手工指定 RPC 目录',
    }
  }

  if (install.hookInstalled && !install.hookIsOurs) {
    return {
      ok: false,
      action: 'failed',
      hookPath: install.hookPath,
      version: install.version,
      message: `${install.hookPath} 已存在且**不是**本插件的钩子（可能是别的库的 sitecustomize）——`
        + '为避免破坏它，本工具不覆盖。请人工把 marvis-uskey-hook.py 的内容合并进去后重启 Marvis。',
    }
  }

  const body = renderHook()

  if (install.hookInstalled && opts.force !== true) {
    // 已是我们装的：确认内容与当前模板一致（模板可能随插件升级而变）。
    try {
      if (readFileSync(install.hookPath, 'utf8') === body) {
        return {
          ok: true,
          action: 'already',
          hookPath: install.hookPath,
          version: install.version,
          message: `钩子已就绪（Marvis ${install.version}）`,
        }
      }
    }
    catch {
      // 读失败就当需要修复，往下走
    }
  }

  const wasInstalled = install.hookInstalled
  const tmp = `${install.hookPath}.dsh.tmp`
  try {
    writeFileSync(tmp, body, 'utf8')
    renameSync(tmp, install.hookPath)
  }
  catch (error) {
    try {
      rmSync(tmp, { force: true })
    }
    catch {
      // 清理失败无所谓
    }
    if (isPermissionError(error)) {
      return {
        ok: false,
        action: 'failed',
        hookPath: install.hookPath,
        version: install.version,
        needsElevation: true,
        message: `无写入权限：${install.hookPath} —— 请以管理员身份重试，`
          + '或手工把 marvis-uskey-hook.py 复制到该路径后重启 Marvis',
      }
    }
    return {
      ok: false,
      action: 'failed',
      hookPath: install.hookPath,
      version: install.version,
      message: `写入失败：${error instanceof Error ? error.message : String(error)}`,
    }
  }

  return {
    ok: true,
    action: wasInstalled ? 'repaired' : 'installed',
    hookPath: install.hookPath,
    version: install.version,
    message: `${wasInstalled ? '已修复' : '已安装'}钩子（Marvis ${install.version}）—— **必须重启 Marvis 才生效**`,
  }
}

/**
 * 卸载钩子（恢复 Marvis 原始状态）。
 *
 * 只删「确认是我们装的」那个文件；别人的 `sitecustomize.py` 一律不动。
 */
export function removeMarvisHook(): MarvisHookInstallResult {
  const install = locateMarvisInstall()
  if (install === undefined) {
    return { ok: true, action: 'already', message: '未找到 Marvis 安装（无需卸载）' }
  }
  if (!install.hookInstalled) {
    return { ok: true, action: 'already', hookPath: install.hookPath, version: install.version, message: '钩子本就不存在' }
  }
  if (!install.hookIsOurs) {
    return {
      ok: false,
      action: 'failed',
      hookPath: install.hookPath,
      version: install.version,
      message: `${install.hookPath} 不是本插件的钩子，拒绝删除`,
    }
  }
  try {
    rmSync(install.hookPath, { force: true })
  }
  catch (error) {
    return isPermissionError(error)
      ? {
        ok: false,
        action: 'failed',
        hookPath: install.hookPath,
        version: install.version,
        needsElevation: true,
        message: `无删除权限：${install.hookPath} —— 请以管理员身份重试`,
      }
      : {
        ok: false,
        action: 'failed',
        hookPath: install.hookPath,
        version: install.version,
        message: `删除失败：${error instanceof Error ? error.message : String(error)}`,
      }
  }
  return {
    ok: true,
    action: 'installed',
    hookPath: install.hookPath,
    version: install.version,
    message: '钩子已移除 —— 重启 Marvis 后完全恢复原状',
  }
}

export { HOOK_MARKER }