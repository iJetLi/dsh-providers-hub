// 抓一次豆包官方的 `bdms-sdk.<hash>.js`，落进 `src/assets/`，并打印 sha256。
//
// ## 为什么需要这个脚本
//
// 运行时**不再下载**任何远程代码（见 `src/doubao-bdms.ts` 的模块文档）：签名脚本随包
// 分发，装载前按常量校验 sha256。代价是「上游换版要发一次包」，所以升级路径必须是
// **显式、可 review** 的：
//
//   1. 有网的机器上跑本脚本（默认自己从 chat 页 manifest 里解析当前 hash）；
//   2. 它写文件 + 打印 sha256，**不改源码** —— 改常量这一步交给人（= 一次 diff = 一次 review）；
//   3. 提交 `src/assets/bdms-sdk.<hash>.js` 与 `DOUBAO_BDMS_SDK_SHA256` 的改动。
//
// ## 用法
//
//   node scripts/fetch-doubao-bdms-sdk.mjs                 # 现读 chat 页 manifest
//   node scripts/fetch-doubao-bdms-sdk.mjs --url <url>      # 直接用给定 URL
//   node scripts/fetch-doubao-bdms-sdk.mjs --sha256 <hex>   # 抓完同时核对期望值（CI 友好）
//
// ⚠️ 本脚本只用于**升级资产**，不是构建步骤：`npm run build` 不会联网。
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const CHAT_PAGE = 'https://www.doubao.com/chat/'
const CHUNK_BASE = 'https://lf-flow-web-cdn.doubao.com/obj/flow-doubao/doubao/chat/static/js/async/'
const CHUNK_NAME = 'bdms-sdk'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) '
  + 'Chrome/131.0.0.0 Safari/537.36'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(scriptDir, '..')

/** 从 chat 页 HTML 的 rspack manifest 里解析当前 bdms chunk 的 URL。 */
function parseChunkUrl(html) {
  const normalized = html.replace(/\\"/g, '"')
  // 先确认 `9a` 就是 bdms-sdk（上游改过 chunk 编号），再取 hash。
  if (!/"9a":"bdms-sdk"/.test(normalized)) return undefined
  const match = /"9a":"([0-9a-f]{6,})"/.exec(normalized)
  return match === null ? undefined : `${CHUNK_BASE}${CHUNK_NAME}.${match[1]}.js`
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: { 'user-agent': UA, accept: '*/*' },
    redirect: 'follow',
  })
  if (!response.ok) throw new Error(`GET ${url} → HTTP ${response.status}`)
  return await response.text()
}

const args = process.argv.slice(2)
const urlArgIndex = args.indexOf('--url')
const shaArgIndex = args.indexOf('--sha256')
const explicitUrl = urlArgIndex >= 0 ? args[urlArgIndex + 1] : undefined
const expectedSha = shaArgIndex >= 0 ? args[shaArgIndex + 1]?.toLowerCase() : undefined

if (explicitUrl === undefined) console.log(`读取 ${CHAT_PAGE} 的 manifest…`)
const url = explicitUrl ?? parseChunkUrl(await fetchText(CHAT_PAGE))
if (url === undefined) {
  console.error('✗ manifest 里没找到 bdms chunk（`"9a":"bdms-sdk"`）。可用 --url 直接指定。')
  process.exit(1)
}
console.log(`chunk URL: ${url}`)

const script = await fetchText(url)
const sha256 = createHash('sha256').update(script).digest('hex')
// 资产名沿用仓库既有约定 `doubao-bdms-sdk.<上游 hash>.js`（上游 hash 留在文件名里，
// 一眼能看出内置的是哪一版；不要直接照搬 CDN 的文件名，否则会和别处混淆）。
const upstreamHash = url.slice(url.lastIndexOf('/') + 1).replace(/^bdms-sdk\./, '').replace(/\.js$/, '')
const fileName = `doubao-bdms-sdk.${upstreamHash}.js`
const target = resolve(packageRoot, 'src/assets', fileName)
mkdirSync(dirname(target), { recursive: true })
writeFileSync(target, script, 'utf8')

console.log(`✓ 已写入 ${target}`)
console.log(`  bytes  : ${Buffer.byteLength(script, 'utf8')}`)
console.log(`  sha256 : ${sha256}`)

if (expectedSha !== undefined && expectedSha !== sha256) {
  console.error(`✗ 与期望的 sha256 不一致（期望 ${expectedSha.slice(0, 12)}…）`)
  process.exit(1)
}

console.log('')
console.log('下一步（人工，务必和资产一起提交）：')
console.log(`  1. 更新 src/doubao-bdms.ts 的 DOUBAO_BDMS_SDK_SHA256 = '${sha256}'`)
console.log('  2. 更新 scripts/copy-assets.mjs 里那条 src/assets/… → lib/assets/… 的文件名')
console.log(`  3. 删掉旧的 src/assets/${CHUNK_NAME}.<old-hash>.js（别留两份，否则包体积白涨）`)
console.log('  4. 跑 `vitest run tests/unit/doubao-browserless.spec.ts` —— 它会在哈希不符时直接红')
