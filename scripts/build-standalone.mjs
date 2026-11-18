#!/usr/bin/env node
/**
 * 构建「完全离线、自包含」的 Windows 部署产物。
 *
 * 目标：目标机**不装 Node、不装 npm/pnpm、不能联网**，解压即跑。
 *
 * 产物结构（默认 profile = prod）：
 *
 *   dsh-providers-hub-<ver>-win-x64/
 *   ├─ MANIFEST.json              清单：版本 / 构建时间 / Node 版本 / 依赖清单 / 原生二进制清单
 *   ├─ README.txt                 部署说明（目录结构、启动方式、限制）
 *   ├─ start.cmd                  前台启动（自带 Node 运行时）
 *   ├─ stop.cmd / stop.ps1        停止
 *   ├─ runtime/
 *   │  ├─ node.exe                自带 Node 运行时（Windows x64）
 *   │  └─ service-runner.mjs      服务包装器（供 service.bat -Mode standalone 使用）
 *   └─ home/                      == DSH_HOME
 *      ├─ cordis.patch.yml        home 级 patch 层
 *      └─ profiles/
 *         ├─ node_modules/        宿主安装锚点 + 依赖闭包
 *         │  └─ @deepseek-ai/
 *         │     └─ dsh/           DSH 宿主（真实目录，非 junction）
 *         │        ├─ lib/  package.json
 *         │        └─ node_modules/   宿主依赖闭包（真实目录扁平布局）★
 *         └─ prod/                预置 profile（免 npm install）
 *            ├─ package.json      dsh.profile.bundles = [dsh-base, dsh-web-app, dsh-providers-hub]
 *            ├─ cordis.patch.yml
 *            ├─ pnpm-workspace.yaml
 *            └─ node_modules/
 *               └─ dsh-providers-hub/   本插件（真实目录）
 *                  ├─ lib/  locale/  cordis.patch.yml  package.json
 *                  └─ node_modules/      插件生产依赖（真实目录扁平布局）★
 *
 * ★ 为什么依赖必须放在这两处「真实目录」而不是 junction：
 *   宿主用 `createRequire(anchor).resolve.paths()` 解析依赖，anchor 是
 *   `<profiles>/node_modules/@deepseek-ai/dsh/package.json`。命中「宿主同级的
 *   node_modules」时，宿主的 fallback 链接指向**产物内**的绝对路径，产物移动后
 *   首次启动会自动重建（symlinkPointsTo 失败 → unlink + recreate）。
 *   若依赖放在 fallback 目录自身，link === target，宿主会报
 *   "exists and is not a symlink" 并在每次启动刷 fallback-heal 噪音。
 *
 * 用法：
 *   node scripts/build-standalone.mjs --out dist/standalone --zip
 *   node scripts/build-standalone.mjs --skip-build --profile prod
 */

import { spawnSync } from 'node:child_process'
import {
  cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, copyFileSync,
} from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { copyDetailDocs } from './lib/detail-docs.mjs'
import { copyIconAsset } from './lib/icon-asset.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..')

// ---------------------------------------------------------------- 参数

function parseArgs(argv) {
  const out = {
    out: join(REPO_ROOT, 'dist', 'standalone'),
    profile: 'prod',
    dshVersion: '0.2.1-rc.2',
    nodeExe: '',
    skipBuild: false,
    zip: false,
    dedupe: true,
    keepStaging: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    const next = () => {
      i += 1
      if (i >= argv.length) throw new Error(`选项 ${a} 缺少值`)
      return argv[i]
    }
    switch (a) {
      case '--out': out.out = resolve(next()); break
      case '--profile': out.profile = next(); break
      case '--dsh-version': out.dshVersion = next(); break
      case '--node': out.nodeExe = resolve(next()); break
      case '--skip-build': out.skipBuild = true; break
      case '--zip': out.zip = true; break
      case '--no-dedupe': out.dedupe = false; break
      case '--keep-staging': out.keepStaging = true; break
      case '--help': case '-h': out.help = true; break
      default:
        if (a.startsWith('--')) throw new Error(`未知选项 ${a}`)
    }
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
if (args.help) {
  console.log('用法: node scripts/build-standalone.mjs [--out <目录>] [--profile <名>] [--dsh-version <ver>]')
  console.log('                    [--node <node.exe>] [--skip-build] [--zip] [--no-dedupe] [--keep-staging]')
  process.exit(0)
}

// ---------------------------------------------------------------- 工具
//
// Windows 下 spawnSync 不能直接执行 npm.cmd / pnpm.cmd（需 cmd.exe 解释），
// 而用 cmd.exe /c 包裹又会引入一层引号解析。因此统一走它们的 JS 入口：
//   npm  → <node>\node_modules\npm\bin\npm-cli.js
//   pnpm → <prefix>\node_modules\pnpm\bin\pnpm.cjs

function findNpmCli() {
  const candidates = [
    join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ]
  for (const c of candidates) if (existsSync(c)) return c
  return ''
}

function findPnpmCli() {
  const candidates = []
  if (process.env.APPDATA) candidates.push(join(process.env.APPDATA, 'npm', 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'))
  for (const dir of (process.env.PATH || '').split(';')) {
    if (!dir) continue
    candidates.push(join(dir, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'))
    candidates.push(join(dir, 'pnpm', 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'))
  }
  for (const c of candidates) if (existsSync(c)) return c
  return ''
}

const npmCli = findNpmCli()
const pnpmCli = findPnpmCli()

/** 用当前 node 跑一个 JS 入口形式的 CLI（npm / pnpm）。 */
function runCli(entry, cliArgs, opts = {}) {
  if (!entry) throw new Error('找不到 CLI 的 JS 入口（npm-cli.js / pnpm.cjs）')
  const r = spawnSync(process.execPath, [entry, ...cliArgs], {
    stdio: 'inherit',
    cwd: opts.cwd ?? REPO_ROOT,
    env: process.env,
    shell: false,
  })
  if (r.error) throw r.error
  if (r.status !== 0) throw new Error(`${basename(entry)} ${cliArgs.join(' ')} 退出码 ${r.status}`)
}

/**
 * 写文本文件。
 *
 * ⚠️ 批处理（.cmd）**必须用 CRLF**：cmd.exe 按 CRLF 切分命令，
 * LF-only 的 .bat 会被当成一整行解析，报出「xx 不是内部或外部命令」这类
 * 与内容完全无关的错（本次实测：'fined' / 'rt]' / 'le' 全是行首被吃掉）。
 * 同时开头加 chcp 65001，避免中文在 OEM 936 码页下乱码。
 */
function writeText(target, content, { crlf = false, bom = false } = {}) {
  const text = crlf ? content.replace(/\r?\n/g, '\r\n') : content
  const data = bom ? `\ufeff${text}` : text
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, data, 'utf8')
}

/**
 * 删除路径。
 *
 * 某些 IDE / 安全删除垫片会拦截 fs.rmSync（把删除改成「移到回收站」），
 * 在几百 MB 的依赖树上会超时失败。这里保留 fs.rmSync 作为首选，
 * 一旦它抛错就永久切换到系统命令（rmdir / del），保证打包机可用。
 */
let preferCmdRemove = false

function removePath(target) {
  if (!existsSync(target)) return
  if (!preferCmdRemove) {
    try {
      rmSync(target, { recursive: true, force: true })
      if (!existsSync(target)) return
    } catch {
      preferCmdRemove = true
    }
  }
  const isDir = (() => { try { return statSync(target).isDirectory() } catch { return true } })()
  // windowsVerbatimArguments：不要让 Node 再给参数加引号，否则 cmd 会把
  // `rmdir /s /q "路径"` 的引号二次处理成字面量而找不到路径。
  const cmd = isDir ? `rmdir /s /q "${target}"` : `del /f /q "${target}"`
  spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', cmd], {
    stdio: 'ignore', shell: false, windowsVerbatimArguments: true,
  })
  if (existsSync(target)) {
    // 兜底：PowerShell 的 Remove-Item 对长路径更宽容
    spawnSync('powershell', [
      '-NoProfile', '-Command',
      `Remove-Item -LiteralPath '${target.replace(/'/g, "''")}' -Recurse -Force -ErrorAction SilentlyContinue`,
    ], { stdio: 'ignore', shell: false })
  }
  if (existsSync(target)) {
    throw new Error(`无法删除: ${target}\n`
      + '  常见原因：产物仍在运行（文件被占用）—— 先执行产物里的 stop.cmd 再重试。')
  }
}

/** 复制整棵目录树，强制落成真实目录（跟随 junction），保证产物可 zip / 可跨机器。 */
function copyTree(src, dst) {
  if (!existsSync(src)) throw new Error(`源目录不存在: ${src}`)
  removePath(dst)
  mkdirSync(dirname(dst), { recursive: true })
  cpSync(src, dst, { recursive: true, dereference: true, force: true })
}

function moveTree(src, dst) {
  if (!existsSync(src)) throw new Error(`源目录不存在: ${src}`)
  removePath(dst)
  mkdirSync(dirname(dst), { recursive: true })
  cpSync(src, dst, { recursive: true, dereference: true, force: true })
}

/** 列出 node_modules 下的包（含 scope 展开）。 */
function listPackages(modulesDir) {
  const out = []
  if (!existsSync(modulesDir)) return out
  for (const entry of readdirSync(modulesDir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    if (entry.name.startsWith('@')) {
      const scopeDir = join(modulesDir, entry.name)
      for (const sub of readdirSync(scopeDir, { withFileTypes: true })) {
        if (sub.name.startsWith('.')) continue
        out.push({ name: `${entry.name}/${sub.name}`, dir: join(scopeDir, sub.name) })
      }
    } else {
      out.push({ name: entry.name, dir: join(modulesDir, entry.name) })
    }
  }
  return out
}

/** 扫描目录树里的原生二进制（.node），用于「Windows 平台原生模块已包含」的核验。 */
function findNativeBinaries(root) {
  const found = []
  const walk = (dir, depth) => {
    if (depth > 8) return
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (!e.isDirectory()) continue
      const full = join(dir, e.name)
      if (e.name === 'node_modules') { walk(full, depth + 1); continue }
      let names
      try { names = readdirSync(full) } catch { continue }
      const natives = names.filter((n) => n.endsWith('.node'))
      if (natives.length > 0) found.push({ pkg: relative(root, full).split('\\').join('/'), files: natives })
      const nested = join(full, 'node_modules')
      if (existsSync(nested)) walk(nested, depth + 1)
    }
  }
  walk(root, 0)
  return found
}

// ------------------------------------------------- 最小 semver satisfies
// 只为「宿主闭包里的包能否满足插件的依赖范围」服务，避免引入额外依赖。

function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(v ?? ''))
  if (!m) return null
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ?? null }
}

function compareVersions(a, b) {
  if (a.major !== b.major) return a.major - b.major
  if (a.minor !== b.minor) return a.minor - b.minor
  if (a.patch !== b.patch) return a.patch - b.patch
  if (a.pre === b.pre) return 0
  if (a.pre === null) return 1
  if (b.pre === null) return -1
  return a.pre < b.pre ? -1 : 1
}

function satisfiesOne(version, range) {
  const v = parseVersion(version)
  if (!v) return false
  const r = range.trim()
  if (r === '' || r === '*' || r === 'x' || r === 'latest') return true

  const caret = /^\^\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(r)
  if (caret) {
    const [, maj, min, pat] = caret
    const lo = { major: Number(maj), minor: min === undefined ? 0 : Number(min), patch: pat === undefined ? 0 : Number(pat), pre: v.pre }
    if (compareVersions(v, lo) < 0) return false
    const major = Number(maj)
    if (major > 0) return v.major === major
    if (min === undefined) return v.major === 0 && v.minor === 0
    return v.major === 0 && v.minor === Number(min)
  }

  const tilde = /^~\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(r)
  if (tilde) {
    const [, maj, min] = tilde
    const lo = { major: Number(maj), minor: min === undefined ? 0 : Number(min), patch: 0, pre: v.pre }
    if (compareVersions(v, lo) < 0) return false
    if (min === undefined) return v.major === Number(maj)
    return v.major === Number(maj) && v.minor === Number(min)
  }

  const cmp = /^(>=|<=|>|<|=)?\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(r)
  if (cmp) {
    const op = cmp[1] ?? '='
    const target = { major: Number(cmp[2]), minor: cmp[3] === undefined ? 0 : Number(cmp[3]), patch: cmp[4] === undefined ? 0 : Number(cmp[4]), pre: null }
    const c = compareVersions(v, target)
    if (op === '>=') return c >= 0
    if (op === '<=') return c <= 0
    if (op === '>') return c > 0
    if (op === '<') return c < 0
    return c === 0
  }

  const wildcard = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(r)
  if (wildcard) {
    const [, maj, min, pat] = wildcard
    if (v.major !== Number(maj)) return false
    if (min === undefined) return true
    if (v.minor !== Number(min)) return false
    if (pat === undefined) return true
    return v.patch === Number(pat)
  }
  return false
}

function satisfies(version, range) {
  if (!range) return true
  return String(range).split('||').some((part) =>
    part.trim().split(/\s+/).filter(Boolean).every((one) => satisfiesOne(version, one)))
}

// ---------------------------------------------------------------- 主流程

function log(step, message) {
  console.log(`[${step}] ${message}`)
}

const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'))
const productName = `${pkg.name}-${pkg.version}-win-x64`
const productDir = join(args.out, productName)
// 依赖缓存：装一次宿主 + 插件依赖要几分钟，后续重打包直接复用。
// 放在 node_modules 下（不进产物、也不会污染 git 状态）。
const cacheDir = join(REPO_ROOT, 'node_modules', '.cache', 'standalone')

log('1/9', `准备产物目录 ${productDir}`)
removePath(productDir)
mkdirSync(productDir, { recursive: true })

// ---- 构建插件 ----
if (!args.skipBuild) {
  log('2/9', '构建插件（pnpm build:all）...')
  runCli(pnpmCli, ['build:all'])
} else {
  log('2/9', '跳过构建（--skip-build）')
}
if (!existsSync(join(REPO_ROOT, 'lib', 'index.js'))) {
  throw new Error('缺少构建产物 lib/index.js，请先执行 pnpm build:all')
}
if (!existsSync(join(REPO_ROOT, 'lib', 'client', 'jet-hub.js'))) {
  throw new Error('缺少客户端产物 lib/client/jet-hub.js（build:client 未执行），请用 pnpm build:all')
}

// ---- 安装 DSH 宿主（npm，扁平真实目录布局）----
const hostPkgDir = join(cacheDir, 'hostpkg')
// ⚠️ 这里**不能**加 --omit=peer：DSH 宿主的 peerDependencies 是它运行的一部分
// （dsh-app-boot 的 peer 里有 @deepseek-ai/cordis-plugin-loader 等，缺一个就
// ERR_MODULE_NOT_FOUND 直接起不来）。npm 7+ 会自动把 peer 装进顶层。
const hostInstalledManifest = join(hostPkgDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
const hostCached = existsSync(hostInstalledManifest)
  && JSON.parse(readFileSync(hostInstalledManifest, 'utf8')).version === args.dshVersion
if (hostCached) {
  log('3/9', `复用宿主依赖缓存（@deepseek-ai/dsh@${args.dshVersion}）`)
} else {
  log('3/9', `安装 DSH 宿主 @deepseek-ai/dsh@${args.dshVersion}（npm，扁平布局）...`)
  removePath(hostPkgDir)
  mkdirSync(hostPkgDir, { recursive: true })
  writeFileSync(
    join(hostPkgDir, 'package.json'),
    `${JSON.stringify({ name: 'dsh-host-standalone', version: '0.0.0', private: true }, null, 2)}\n`,
    'utf8',
  )
  runCli(npmCli, [
    'install', `@deepseek-ai/dsh@${args.dshVersion}`,
    '--omit=dev', '--ignore-scripts',
    '--no-audit', '--no-fund', '--loglevel=error', '--install-strategy=hoisted',
  ], { cwd: hostPkgDir })
}

const hostModules = join(hostPkgDir, 'node_modules')
if (!existsSync(join(hostModules, '@deepseek-ai', 'dsh', 'package.json'))) {
  throw new Error('DSH 宿主安装结果异常：缺少 @deepseek-ai/dsh')
}

// ---- native module 核验/修复 ----
log('4/9', '核验原生模块（Windows 平台 .node 二进制）...')
const nativeReport = []
const repairNative = () => {
  const nssm = listPackages(hostModules).find((p) => p.name === 'node-pty')
  if (!nssm) return
  const prebuilds = join(nssm.dir, 'prebuilds', 'win32-x64')
  const hasNative = existsSync(prebuilds) && readdirSync(prebuilds).some((f) => f.endsWith('.node'))
  if (hasNative) return
  log('4/9', 'node-pty 缺少 win32-x64 prebuild，尝试单独重建该包（仅它需要 install 脚本）...')
  try {
    spawnSync(process.execPath, [npmCli, 'rebuild', 'node-pty', '--foreground-scripts', '--loglevel=error'], {
      cwd: hostPkgDir, stdio: 'inherit', shell: false,
    })
  } catch { /* 下面统一核验并给出明确错误 */ }
}
repairNative()
for (const p of listPackages(hostModules)) {
  const natives = []
  const walk = (dir, depth) => {
    if (depth > 4) return
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (!e.isDirectory()) continue
      const full = join(dir, e.name)
      if (e.name === 'node_modules') { walk(full, depth + 1); continue }
      let names
      try { names = readdirSync(full) } catch { continue }
      for (const n of names) if (n.endsWith('.node')) natives.push(`${relative(p.dir, join(full, n)).split('\\').join('/')}`)
    }
  }
  walk(p.dir, 0)
  if (natives.length > 0) nativeReport.push({ package: p.name, files: natives })
}
const pty = nativeReport.find((n) => n.package === 'node-pty')
if (pty && !pty.files.some((f) => f.includes('win32-x64'))) {
  throw new Error('node-pty 缺少 win32-x64 原生二进制（Windows PTY 会加载失败）。'
    + '请在联网的打包机上重跑，或手动执行 npm rebuild node-pty 后再打包。')
}
log('4/9', `原生模块清单：${nativeReport.length === 0 ? '（无）' : nativeReport.map((n) => n.package).join(', ')}`)

// ---- 组装产物：home/profiles/node_modules/@deepseek-ai/dsh ----
log('5/9', '组装 DSH 宿主到产物 home/...')
const homeDir = join(productDir, 'home')
const profilesDir = join(homeDir, 'profiles')
const fallbackModulesDir = join(profilesDir, 'node_modules')
const hostAnchorDir = join(fallbackModulesDir, '@deepseek-ai', 'dsh')
mkdirSync(fallbackModulesDir, { recursive: true })

// 5a. 宿主包本体 -> <profiles>/node_modules/@deepseek-ai/dsh
const hostSource = join(hostModules, '@deepseek-ai', 'dsh')
copyTree(hostSource, hostAnchorDir)

// 5b. 其余依赖闭包 -> <host>/node_modules/（真实目录扁平布局）
const hostInnerModules = join(hostAnchorDir, 'node_modules')
mkdirSync(hostInnerModules, { recursive: true })
for (const entry of readdirSync(hostModules, { withFileTypes: true })) {
  if (entry.name === '@deepseek-ai' || entry.name === '.bin' || entry.name.startsWith('.')) {
    if (entry.name === '@deepseek-ai') continue
    continue
  }
  const src = join(hostModules, entry.name)
  const dst = join(hostInnerModules, entry.name)
  if (entry.isDirectory()) copyTree(src, dst)
  else copyFileSync(src, dst)
}
// @deepseek-ai 作用域里的其余包（dsh-base / dsh-web-app / cordis ...）
const hostScopeDir = join(hostModules, '@deepseek-ai')
for (const entry of readdirSync(hostScopeDir, { withFileTypes: true })) {
  if (entry.name === 'dsh') continue
  const src = join(hostScopeDir, entry.name)
  const dst = join(hostInnerModules, '@deepseek-ai', entry.name)
  if (entry.isDirectory()) copyTree(src, dst)
  else copyFileSync(src, dst)
}
// 依赖闭包清单（供审计）
writeFileSync(
  join(hostInnerModules, '.package-lock.json'),
  existsSync(join(hostModules, '.package-lock.json'))
    ? readFileSync(join(hostModules, '.package-lock.json'), 'utf8')
    : '{}\n',
  'utf8',
)

// ---- 安装插件依赖（npm，扁平真实目录布局）----
const appPkgDir = join(cacheDir, 'apppkg')
const slimPkg = { ...pkg }
delete slimPkg.scripts
delete slimPkg.devDependencies
delete slimPkg.prepare
delete slimPkg.files
const slimPkgText = `${JSON.stringify(slimPkg, null, 2)}\n`
const appCached = existsSync(join(appPkgDir, 'node_modules', '.package-lock.json'))
  && existsSync(join(appPkgDir, 'package.json'))
  && readFileSync(join(appPkgDir, 'package.json'), 'utf8') === slimPkgText
if (appCached) {
  log('6/9', '复用插件依赖缓存')
} else {
  log('6/9', '安装插件生产依赖（npm，扁平布局）...')
  removePath(appPkgDir)
  mkdirSync(appPkgDir, { recursive: true })
  writeFileSync(join(appPkgDir, 'package.json'), slimPkgText, 'utf8')
  runCli(npmCli, [
    'install',
    '--omit=dev', '--omit=peer', '--ignore-scripts',
    '--no-audit', '--no-fund', '--loglevel=error', '--install-strategy=hoisted',
  ], { cwd: appPkgDir })
}

const appModules = join(appPkgDir, 'node_modules')

// ---- 组装 profile ----
log('7/9', '组装预置 profile（免 npm install）...')
const profileDir = join(profilesDir, args.profile)
const profileModulesDir = join(profileDir, 'node_modules')
const pluginDir = join(profileModulesDir, pkg.name)
mkdirSync(profileModulesDir, { recursive: true })

// 插件产物：lib / locale / cordis.patch.yml / package.json
copyTree(join(REPO_ROOT, 'lib'), join(pluginDir, 'lib'))
if (existsSync(join(REPO_ROOT, 'locale'))) copyTree(join(REPO_ROOT, 'locale'), join(pluginDir, 'locale'))
copyFileSync(join(REPO_ROOT, 'cordis.patch.yml'), join(pluginDir, 'cordis.patch.yml'))

// `meta.detail` 指向的文档必须一起走。漏了不是「回落 README」，而是
// 宿主 `readPackageDocument()` 抛 `DetailFailure('invalid')` ⇒ 详情页报错。
// 路径清单不在这里维护：`locale/*.json` 声明了什么就复制什么。
copyDetailDocs(REPO_ROOT, pluginDir)

// 插件图标与详情文档同因：`files` 只约束 npm 通道，这里的复制清单是第二份。
copyIconAsset(REPO_ROOT, pluginDir)
writeFileSync(join(pluginDir, 'package.json'), `${JSON.stringify(slimPkg, null, 2)}\n`, 'utf8')

// 插件依赖 -> 插件目录下的 node_modules
copyTree(appModules, join(pluginDir, 'node_modules'))

// 去重：宿主闭包里已有且满足插件 semver 的包，删掉插件内那份，
// 让 Node 解析到宿主那一份 —— 避免同一模块出现两个实例（单例状态被劈裂）。
if (args.dedupe) {
  const hostPackages = new Map(listPackages(hostInnerModules).map((p) => {
    let version = null
    try { version = JSON.parse(readFileSync(join(p.dir, 'package.json'), 'utf8')).version } catch { /* 忽略 */ }
    return [p.name, version]
  }))
  let removed = 0
  for (const p of listPackages(join(pluginDir, 'node_modules'))) {
    const hostVersion = hostPackages.get(p.name)
    if (!hostVersion) continue
    let ownRange = ''
    try {
      const own = JSON.parse(readFileSync(join(p.dir, 'package.json'), 'utf8'))
      ownRange = own.version
    } catch { /* 忽略 */ }
    const pluginRange = pkg.dependencies?.[p.name] ?? pkg.peerDependencies?.[p.name] ?? ''
    if (!pluginRange || !satisfies(hostVersion, pluginRange)) continue
    if (!satisfies(hostVersion, ownRange)) continue
    removePath(p.dir)
    removed += 1
  }
  log('7/9', `去重：移除插件内 ${removed} 个与宿主重复的包（改由宿主闭包解析）`)
}

// profile 清单
const profileManifest = {
  name: `dsh-profile-${args.profile}`,
  private: true,
  dependencies: { [pkg.name]: pkg.version },
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', pkg.name], patchReload: 'startup' } },
}
writeFileSync(join(profileDir, 'package.json'), `${JSON.stringify(profileManifest, null, 2)}\n`, 'utf8')
writeFileSync(
  join(profileDir, 'cordis.patch.yml'),
  '# dsh profile patch —— 预置 profile 的用户层。\n# 插件自身的 patch（cordis.patch.yml）作为 bundle 层自动加载，无需在此声明。\n[]\n',
  'utf8',
)
writeFileSync(
  join(profileDir, 'pnpm-workspace.yaml'),
  'nodeLinker: hoisted\n',
  'utf8',
)
// home 级 patch
writeFileSync(
  join(homeDir, 'cordis.patch.yml'),
  '# dsh home patch —— 机器级用户层（优先级高于 profile 自己的 patch）。\n[]\n',
  'utf8',
)

// ---- Node 运行时 ----
log('8/9', '内置 Node 运行时...')
const runtimeDir = join(productDir, 'runtime')
mkdirSync(runtimeDir, { recursive: true })
const nodeExe = args.nodeExe || process.execPath
if (!existsSync(nodeExe)) throw new Error(`node.exe 不存在: ${nodeExe}`)
copyFileSync(nodeExe, join(runtimeDir, 'node.exe'))
const nodeVersion = spawnSync(join(runtimeDir, 'node.exe'), ['-v'], { encoding: 'utf8' }).stdout.trim()
const runnerSrc = join(REPO_ROOT, 'service-runner.mjs')
if (existsSync(runnerSrc)) copyFileSync(runnerSrc, join(runtimeDir, 'service-runner.mjs'))

// ---- 启动/停止脚本 ----
const startCmd = `@echo off
chcp 65001 >nul
rem ============================================================
rem  dsh-providers-hub 独立产物 —— 启动（自带 Node 运行时）
rem ============================================================
setlocal EnableExtensions DisableDelayedExpansion
set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\\" set "ROOT=%ROOT:~0,-1%"

rem ---- DSH_HOME 强制指向产物内的 home ----
rem NOTE: do NOT use "if not defined DSH_HOME" here. An external DSH_HOME points at
rem a directory without profiles/<name> or the dependency closure, so the host fails
rem with: profile "<name>" does not exist. Our own liveness check uses %ROOT% and
rem still passes, which makes the symptom very misleading.
if defined DSH_HOME echo [start][WARN] overriding external DSH_HOME=%DSH_HOME%
set "DSH_HOME=%ROOT%\\home"

rem ---- 监听参数（可用环境变量覆盖）----
if not defined DSH_PROFILE set "DSH_PROFILE=${args.profile}"
if not defined DSH_HOST set "DSH_HOST=127.0.0.1"
if not defined DSH_PORT set "DSH_PORT=8123"

rem ---- 本机 OpenAI 网关 ----
if not defined DSH_OPENAI_GATEWAY_ENABLED set "DSH_OPENAI_GATEWAY_ENABLED=1"
if not defined DSH_OPENAI_GATEWAY_PORT set "DSH_OPENAI_GATEWAY_PORT=8326"
if not defined DSH_OPENAI_GATEWAY_HOST set "DSH_OPENAI_GATEWAY_HOST=127.0.0.1"

rem ---- 把自带 Node 放到 PATH 首位（宿主若需要拉起子进程）----
set "PATH=%ROOT%\\runtime;%PATH%"

echo [start] DSH_HOME    = %DSH_HOME%
echo [start] profile    = %DSH_PROFILE%
echo [start] web ui     = http://%DSH_HOST%:%DSH_PORT%
echo [start] gateway    = http://%DSH_OPENAI_GATEWAY_HOST%:%DSH_OPENAI_GATEWAY_PORT%/v1
echo [start] node       = %ROOT%\\runtime\\node.exe (%NODE_VERSION%)
echo.

"%ROOT%\\runtime\\node.exe" "%ROOT%\\home\\profiles\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js" ^
  --profile %DSH_PROFILE% --host %DSH_HOST% --port %DSH_PORT% --no-open %*
set "RC=%ERRORLEVEL%"
echo.
echo [start] dsh 退出，错误码 %RC%
exit /b %RC%
`
  .replace('%NODE_VERSION%', nodeVersion)

const stopPs1 = `# 停止本产物启动的 dsh 进程。
# 匹配条件用**本文件所在目录**拼出的绝对路径 —— 只停本产物，
# 不会误伤同机其它 DSH 部署（命令行里都含各自的 bin.js 绝对路径）。
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$binPath = Join-Path $PSScriptRoot 'home\\profiles\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js'
$procs = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($binPath, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 }
if (-not $procs) { Write-Output '[stop] 没有找到运行中的 dsh 进程'; exit 0 }
foreach ($p in $procs) {
  Write-Output ("[stop] 结束 pid=" + $p.ProcessId)
  Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
}
`
const stopCmd = `@echo off
chcp 65001 >nul
rem 停止本产物启动的 dsh 进程
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop.ps1"
`
writeText(join(productDir, 'start.cmd'), startCmd, { crlf: true })
writeText(join(productDir, 'stop.cmd'), stopCmd, { crlf: true })
writeText(join(productDir, 'stop.ps1'), stopPs1)

// ⚠️ 2026-10-31 审计（P1）：产物此前只带 service-runner.mjs 不带 service.bat，
//    README 却指导用户注册服务 —— 无脚本可跑。随附一份仓库根的 service.bat。
copyFileSync(join(REPO_ROOT, 'service.bat'), join(productDir, 'service.bat'))

// ---- 清单 ----
const hostPackages = listPackages(hostInnerModules).map((p) => {
  let version = null
  try { version = JSON.parse(readFileSync(join(p.dir, 'package.json'), 'utf8')).version } catch { /* 忽略 */ }
  return { name: p.name, version }
})
const appPackages = listPackages(join(pluginDir, 'node_modules')).map((p) => {
  let version = null
  try { version = JSON.parse(readFileSync(join(p.dir, 'package.json'), 'utf8')).version } catch { /* 忽略 */ }
  return { name: p.name, version }
})
const manifest = {
  product: productName,
  plugin: { name: pkg.name, version: pkg.version },
  dsh: { name: '@deepseek-ai/dsh', version: args.dshVersion },
  node: { version: nodeVersion, path: 'runtime/node.exe' },
  profile: args.profile,
  builtAt: new Date().toISOString(),
  offline: {
    requiresNodeOnTarget: false,
    requiresNpmOnTarget: false,
    requiresNetworkOnTarget: false,
    note: '目标机无需安装 Node / npm / pnpm，也无法联网；所有依赖已随产物分发。',
  },
  nativeBinaries: nativeReport,
  hostDependencyCount: hostPackages.length,
  pluginDependencyCount: appPackages.length,
  hostDependencies: hostPackages,
  pluginDependencies: appPackages,
}
writeFileSync(join(productDir, 'MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

// ---- README ----
const readme = `dsh-providers-hub 独立部署产物
==================================

版本        : ${pkg.version}（插件） / ${args.dshVersion}（DSH 宿主）
构建时间    : ${manifest.builtAt}
Node 运行时 : ${nodeVersion}（已内置于 runtime/node.exe）

本产物完全离线自包含：目标机【不需要安装 Node / npm / pnpm】，也【不需要联网】。
所有 npm 依赖（含传递依赖）已随产物分发为真实目录，不含 junction，任意机器解压即用。

目录结构
--------
${productName}\\
├─ MANIFEST.json          版本 / 依赖清单 / 原生二进制清单
├─ README.txt             本文件
├─ start.cmd              启动（前台）
├─ stop.cmd / stop.ps1    停止
├─ service.bat            注册 Windows 服务（install -Mode standalone -BundleDir 本目录）
├─ runtime\\
│  ├─ node.exe            内置 Node 运行时
│  └─ service-runner.mjs  服务包装器（配合 service.bat -Mode standalone）
└─ home\\                  == DSH_HOME
   ├─ cordis.patch.yml    home 级 patch 层
   └─ profiles\\
      ├─ node_modules\\    宿主安装锚点 + 依赖闭包
      │  └─ @deepseek-ai\\
      │     └─ dsh\\       DSH 宿主
      │        ├─ lib\\  package.json
      │        └─ node_modules\\   宿主依赖闭包（真实目录）
      └─ ${args.profile}\\            预置 profile
         ├─ package.json  dsh.profile.bundles
         ├─ cordis.patch.yml
         └─ node_modules\\
            └─ ${pkg.name}\\   本插件
               ├─ lib\\  locale\\  cordis.patch.yml
               └─ node_modules\\  插件生产依赖（真实目录）

启动方式
--------
1) 直接启动（前台）：

     start.cmd

   可用环境变量覆盖参数：
     DSH_PROFILE（默认 ${args.profile}）  DSH_HOST（默认 127.0.0.1）  DSH_PORT（默认 8123）
     DSH_OPENAI_GATEWAY_PORT（默认 8326） DSH_OPENAI_GATEWAY_HOST（默认 127.0.0.1）

   Web UI : http://<DSH_HOST>:<DSH_PORT>
   网关   : http://<DSH_OPENAI_GATEWAY_HOST>:<DSH_OPENAI_GATEWAY_PORT>/v1

2) 注册为 Windows 服务（需管理员 + NSSM；产物根目录已随附 service.bat）：

     service.bat install -Mode standalone -BundleDir <本目录> -Profile ${args.profile}

   ⚠️ 2026-10-31 审计（P1）：新脚本检测到完整产物时会自动跳过打包，无需 -NoPackage；
   老版本（不带该自动检测的）请加 -NoPackage。

3) 停止： stop.cmd

重要说明
--------
* 首次启动时，宿主会为依赖闭包建立 junction 链接。若整个产物目录被移动过，
  首次启动会自动重建这些链接（无需人工干预）。
* 宿主每次启动都会重写 home\\profiles\\${args.profile}\\cordis.yml，
  因此 profile 目录必须【可写】。
* profile 的 patchReload 设为 startup（而非 live），避免服务常驻时起文件监听；
  改完 cordis.patch.yml 请重启服务。
* 网关默认只绑 127.0.0.1。不要改成 0.0.0.0 / ::（宿主与网关都会显式拒绝并报错退出）；
  要给内网访问请填具体网卡 IP，并务必设置 DSH_OPENAI_GATEWAY_API_KEY。
* 账号登录仍需在浏览器里完成（Jet Hub 设置页）。无浏览器环境请用「账号备份导入」。
`
writeFileSync(join(productDir, 'README.txt'), readme, 'utf8')

// ---- 最终核验 ----
log('9/9', '核验产物完整性...')
const required = [
  join(runtimeDir, 'node.exe'),
  join(hostAnchorDir, 'package.json'),
  join(hostAnchorDir, 'lib', 'bin.js'),
  join(pluginDir, 'package.json'),
  join(pluginDir, 'lib', 'index.js'),
  join(pluginDir, 'lib', 'client', 'jet-hub.js'),
  join(pluginDir, 'cordis.patch.yml'),
  join(profileDir, 'package.json'),
  join(productDir, 'start.cmd'),
  join(productDir, 'MANIFEST.json'),
]
for (const f of required) {
  if (!existsSync(f)) throw new Error(`产物缺少必需文件: ${f}`)
}
if (!existsSync(join(hostInnerModules, '@deepseek-ai', 'dsh-base'))) {
  throw new Error('宿主依赖闭包缺少 @deepseek-ai/dsh-base（in-box bundle 无法解析）')
}
if (!existsSync(join(hostInnerModules, '@deepseek-ai', 'dsh-web-app'))) {
  throw new Error('宿主依赖闭包缺少 @deepseek-ai/dsh-web-app（web profile 无法解析）')
}
// 宿主闭包里每个包声明的 @deepseek-ai/* peer 依赖都必须在场 ——
// 这些是 DSH 运行时的硬需求（如 dsh-app-boot 的 peer 含 cordis-plugin-loader），
// 缺一个的表现是启动瞬间 ERR_MODULE_NOT_FOUND，而不是任何可读的提示。
const hostPackageNames = new Set(listPackages(hostInnerModules).map((p) => p.name))
const missingPeers = new Set()
for (const p of listPackages(hostInnerModules)) {
  let manifest
  try { manifest = JSON.parse(readFileSync(join(p.dir, 'package.json'), 'utf8')) } catch { continue }
  for (const peer of Object.keys(manifest.peerDependencies || {})) {
    if (!peer.startsWith('@deepseek-ai/')) continue
    if (!hostPackageNames.has(peer)) missingPeers.add(`${peer}  (需要方: ${p.name})`)
  }
}
if (missingPeers.size > 0) {
  throw new Error('宿主依赖闭包缺少以下 peer 依赖，离线启动会直接失败：\n  '
    + [...missingPeers].join('\n  '))
}
// 插件依赖必须能离线解析
for (const dep of Object.keys(pkg.dependencies ?? {})) {
  const inPlugin = existsSync(join(pluginDir, 'node_modules', ...dep.split('/'), 'package.json'))
  const inHost = existsSync(join(hostInnerModules, ...dep.split('/'), 'package.json'))
  if (!inPlugin && !inHost) throw new Error(`依赖 ${dep} 既不在插件内也不在宿主闭包内（离线会解析失败）`)
}

if (!args.keepStaging) {
  // 依赖缓存刻意保留（下次重打包可复用），只提示位置。
  log('9/9', `依赖缓存保留在 ${cacheDir}`)
}

// ---- zip ----
if (args.zip) {
  const zipPath = join(args.out, `${productName}.zip`)
  removePath(zipPath)
  log('9/9', `生成 zip: ${zipPath}`)
  spawnSync('powershell', [
    '-NoProfile', '-Command',
    `Compress-Archive -Path '${productDir}\\*' -DestinationPath '${zipPath}' -Force`,
  ], { stdio: 'inherit', shell: false })
}

const size = (function dirSize(dir) {
  let total = 0
  const walk = (d) => {
    let entries
    try { entries = readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const full = join(d, e.name)
      if (e.isDirectory()) walk(full)
      else { try { total += statSync(full).size } catch { /* 忽略 */ } }
    }
  }
  walk(dir)
  return total
})(productDir)

console.log('')
console.log(`[完成] 产物: ${productDir}`)
console.log(`[完成] 体积: ${(size / 1024 / 1024).toFixed(1)} MB`)
console.log(`[完成] 宿主依赖 ${hostPackages.length} 个 / 插件依赖 ${appPackages.length} 个`)
console.log(`[完成] 原生二进制包: ${nativeReport.map((n) => n.package).join(', ') || '（无）'}`)
if (args.zip) console.log(`[完成] zip: ${join(args.out, `${productName}.zip`)}`)
console.log('')
console.log('目标机部署：解压 -> start.cmd（或 service.bat install -Mode standalone，产物已随附 service.bat）')
