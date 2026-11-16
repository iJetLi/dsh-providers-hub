// 插件详情页正文（`meta.detail`）的收集与复制。
//
// 为什么需要它：宿主的 `readPackageDocument()`
// （`@deepseek-ai/dsh-plugin-detail`）在「`meta.detail` 已声明、但文件不存在」时
// **不回落 README**，而是抛 `DetailFailure('invalid')`，客户端拿到的是
// `RemoteError('plugin-manager/detail-unavailable')` —— 详情区变成报错态。
//
// 而 `package.json` 的 `files` 只约束 **npm 通道**。bootstrap / standalone 两个
// 打包脚本是**自己 listed 一份复制清单**（`lib` / `locale` / `cordis.patch.yml` /
// 精简 `package.json`），`files` 对它们零作用。漏复制 ⇒ 该通道下详情页报错。
//
// 所以路径清单不再手工维护第二份：**直接读 `locale/*.json` 的 `meta.detail`**，
// 声明的就是必须复制的。加文档只改 locale，两个打包脚本自动跟上。

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * 从 `locale/*.json` 收集所有被 `meta.detail` 声明的包内相对路径。
 *
 * 按出现顺序去重（中英通常指向两份不同文档，同一份被两个 locale 引用也正常）。
 * 畸形 locale 或非法 `detail` 值**直接抛错**：构建期的错必须在构建期暴露，
 * 不要静默产出一个详情页报错的包。
 *
 * @param {string} repoRoot 仓库根（含 `locale/`）
 * @returns {string[]} 形如 `['docs/DETAIL.zh.md', 'docs/DETAIL.md']`
 */
export function collectDetailDocs (repoRoot) {
  const localeDir = join(repoRoot, 'locale')
  if (!existsSync(localeDir)) return []
  const docs = []
  for (const name of readdirSync(localeDir).sort()) {
    if (!name.endsWith('.json')) continue
    const file = join(localeDir, name)
    let parsed
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8'))
    } catch (error) {
      throw new Error(`locale/${name} 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`)
    }
    const detail = parsed?.meta?.detail
    if (detail === undefined) continue
    if (typeof detail !== 'string' || detail.length === 0) {
      throw new Error(`locale/${name} 的 meta.detail 必须是非空字符串，收到 ${JSON.stringify(detail)}`)
    }
    if (!docs.includes(detail)) docs.push(detail)
  }
  return docs
}

/**
 * 把 {@link collectDetailDocs} 收集到的文档复制进打包出来的插件目录。
 *
 * 目录按需创建（`docs/DETAIL.md` 的父目录在产品目录里并不存在）。
 * 源文件缺失直接抛错 —— 与宿主的行为对齐：宁可在构建期失败。
 *
 * @param {string} repoRoot 仓库根
 * @param {string} pluginDir 产物里的插件根（`join` 的基准）
 * @returns {string[]} 实际复制的包内相对路径
 */
export function copyDetailDocs (repoRoot, pluginDir) {
  const docs = collectDetailDocs(repoRoot)
  for (const doc of docs) {
    const from = join(repoRoot, doc)
    if (!existsSync(from)) {
      throw new Error(`meta.detail 声明的 ${doc} 在仓库里不存在（locale/*.json 与实际文件不一致）`)
    }
    const to = join(pluginDir, doc)
    mkdirSync(dirname(to), { recursive: true })
    copyFileSync(from, to)
  }
  return docs
}
