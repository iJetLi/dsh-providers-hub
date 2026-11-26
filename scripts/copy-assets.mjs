// 把宿主侧需要的静态资源复制到 lib/。
//
// `tsc` 只编译 .ts，不会搬运 `.wasm`。而 package.json 的 files 只发布 `lib`，
// 因此 WASM 必须落到 lib/ 才能随插件分发。
import { copyFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(scriptDir, '..')

/** 源 → 目标（相对 packageRoot）。 */
const ASSETS = [
  ['src/qoder-auth-wasm.wasm', 'lib/qoder-auth-wasm.wasm'],
  // 豆包 bdms SDK（a_bogus 签名用）：**随包内置**，运行时零下载。
  // 见 src/doubao-bdms.ts 的安全口径与 sha256 钉扎。
  ['src/assets/doubao-bdms-sdk.173db50026.js', 'lib/assets/doubao-bdms-sdk.173db50026.js'],
]

for (const [from, to] of ASSETS) {
  const source = resolve(packageRoot, from)
  if (!existsSync(source)) {
    throw new Error(`缺少构建资源 ${from}（Qoder 加密推理需要它；见 README）`)
  }
  const target = resolve(packageRoot, to)
  await mkdir(dirname(target), { recursive: true })
  await copyFile(source, target)
  console.log(`Wrote ${target}`)
}
