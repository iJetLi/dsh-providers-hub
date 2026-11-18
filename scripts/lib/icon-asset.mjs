// 插件图标（`package.json` 的 `icon`）的收集与复制。
//
// 与 detail-docs.mjs 同因：bootstrap / standalone 两个打包脚本各维护一份
// 复制清单（`lib` / `locale` / `cordis.patch.yml` / 精简 `package.json`），
// `package.json` 的 `files` 只约束 **npm 通道**，对它们零作用。
//
// 漏复制 ⇒ 产物里 `package.json` 声明了 `icon` 但文件不在：宿主 `iconOf()`
// 抛错、`readPluginMeta()` 把它收成一条 metadata 诊断，图标回落成默认图。
// 路径清单同样不手工维护第二份 —— `package.json` 声明什么就复制什么。

import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'

const MANIFEST = 'package.json'

/** 宿主 `MAX_ICON_BYTES`：超过它的图标会被 `iconOf()` 拒绝加载（`icon exceeds 256 KiB`）。 */
const ICON_MAX_BYTES = 256 * 1024

/**
 * 从 `package.json` 读 `icon`（缺省再看 `exports['./icon']`），校验为包内相对路径。
 *
 * 校验规则**比宿主更严**（有意 fail-closed）。宿主（`dsh-app-boot` 的 `iconOf()`）
 * 只拒两件事：①绝对路径 / 带 scheme 的串（`isAbsolute || win32.isAbsolute ||
 * /^[A-Za-z][A-Za-z\d+.-]*:/`）；②realpath 之后跑出 manifest 目录。本函数额外拒：
 * 含反斜杠、任何一段是空串 / `.` / `..`、扩展名不在宿主认的五种之内。
 * **多拒这三类的理由**：前两类宿主实测能放过（`sub\icon.svg` 与
 * `sub/../icon.svg` 在宿主上都返回正常 data URL），但它们会让「包内路径」这个
 * 前提变脆；第三类宿主必拒，构建期先拦才不用等用户装机才发现图标不生效。
 * 畸形清单**直接抛错**：构建期的错必须在构建期暴露，不要静默产出一个没有图标的包。
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
  // ⚠️ 不能用 `??` 一路回退：显式写 `icon: null` 在宿主那里是**抛错**
  // （`textOf()` 只放过 undefined，其余非字符串一律 `must be a non-empty string`），
  // 而 `??` 会把 null 静默当成「没声明」⇒ 声明形同虚设、装机才报诊断。
  const declared = pkg?.icon
  const icon = declared === undefined ? pkg?.exports?.['./icon'] : declared
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
  // 宿主只认这五种扩展名（`ICON_MEDIA_TYPES`），其余在装到宿主那一刻才抛
  // `icon must be SVG, PNG, JPEG, or WebP`。构建期先拦，别让「图标不生效」
  // 跑到用户机上才暴露。
  if (!/\.(?:svg|png|jpe?g|webp)$/iu.test(rel)) {
    throw new Error(`${MANIFEST} 的 icon 必须是 SVG / PNG / JPEG / WebP（宿主只认这五种）：${icon}`)
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
  // 宿主在 `stat.size > 256 KiB` 时拒绝加载；构建期先拦，别让「图标不生效」
  // 跑到用户机上才暴露（与扩展名白名单同因）。
  const size = statSync(from).size
  if (size > ICON_MAX_BYTES) {
    throw new Error(`${MANIFEST} 的 icon 有 ${size} 字节，超过宿主上限 256 KiB（${ICON_MAX_BYTES} 字节，宿主会拒绝加载）：${rel}`)
  }
  const to = join(pluginDir, rel)
  mkdirSync(dirname(to), { recursive: true })
  copyFileSync(from, to)
  return rel
}