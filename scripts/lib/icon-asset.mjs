// 插件图标（`package.json` 的 `icon`）的收集与复制。
//
// 与 detail-docs.mjs 同因：bootstrap / standalone 两个打包脚本各维护一份
// 复制清单（`lib` / `locale` / `cordis.patch.yml` / 精简 `package.json`），
// `package.json` 的 `files` 只约束 **npm 通道**，对它们零作用。
//
// 漏复制 ⇒ 产物里 `package.json` 声明了 `icon` 但文件不在：宿主 `iconOf()`
// 抛错、`readPluginMeta()` 把它收成一条 metadata 诊断，图标回落成默认图。
// 路径清单同样不手工维护第二份 —— `package.json` 声明什么就复制什么。

import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'

const MANIFEST = 'package.json'

/**
 * 从 `package.json` 读 `icon`（缺省再看 `exports['./icon']`），校验为包内相对路径。
 *
 * 校验规则与宿主读图标时同源：非空字符串、不含反斜杠、不带 scheme、不是绝对
 * 路径、任何一段都不是空串 / `.` / `..`。畸形清单**直接抛错**：构建期的错必须
 * 在构建期暴露，不要静默产出一个没有图标的包。
 *
 * @param {string} repoRoot 仓库根（含 `package.json`）
 * @returns {string | null} 形如 `icon.svg` 的包内相对路径；未声明时返回 `null`
 */
export function collectIconPath (repoRoot) {
  const manifest = join(repoRoot, MANIFEST)
  let pkg
  try {
    pkg = JSON.parse(readFileSync(manifest, 'utf8'))
  } catch (error) {
    throw new Error(`${MANIFEST} 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`)
  }
  const icon = pkg?.icon ?? pkg?.exports?.['./icon']
  if (icon === undefined) return null
  if (typeof icon !== 'string' || icon.length === 0) {
    throw new Error(`${MANIFEST} 的 icon 必须是非空字符串，收到 ${JSON.stringify(icon)}`)
  }
  if (icon.includes('\\')) throw new Error(`${MANIFEST} 的 icon 不能含反斜杠（宿主按 \`/\` 切分）：${icon}`)
  if (/^[A-Za-z][A-Za-z\d+.-]*:/u.test(icon)) throw new Error(`${MANIFEST} 的 icon 不能带 scheme：${icon}`)
  if (isAbsolute(icon) || icon.startsWith('/')) throw new Error(`${MANIFEST} 的 icon 必须是包内相对路径：${icon}`)
  const rel = icon.replace(/^\.\//u, '')
  if (rel.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`${MANIFEST} 的 icon 每一段都不能是空串 / \`.\` / \`..\`：${icon}`)
  }
  return rel
}

/**
 * 把 {@link collectIconPath} 声明的图标复制进打包出来的插件目录。
 *
 * 源文件缺失直接抛错 —— 与宿主的行为对齐：宁可在构建期失败。
 *
 * @param {string} repoRoot 仓库根
 * @param {string} pluginDir 产物里的插件根（`join` 的基准）
 * @returns {string | null} 实际复制的包内相对路径；未声明图标时返回 `null`
 */
export function copyIconAsset (repoRoot, pluginDir) {
  const rel = collectIconPath(repoRoot)
  if (rel === null) return null
  const from = join(repoRoot, rel)
  if (!existsSync(from)) {
    throw new Error(`${MANIFEST} 的 icon 指向的 ${rel} 在仓库里不存在（声明与实际文件不一致）`)
  }
  const to = join(pluginDir, rel)
  mkdirSync(dirname(to), { recursive: true })
  copyFileSync(from, to)
  return rel
}