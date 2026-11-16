#!/usr/bin/env node
//
// 引导式（bootstrap）部署产物打包器。
//
// 与 build-standalone.mjs 的区别：
//   build-standalone.mjs  → **完全离线**产物（预置全部 node_modules，808 MB）
//   本脚本               → **按需下载**产物（只带插件本体 + 安装器，约 4 MB / 130 MB）
//
// 体积从数百 MB 降到几 MB 的做法：产物**不打包 node_modules**。
//   - DSH 宿主及其 548 个传递依赖：目标机执行 install.cmd 时由 npm 下载
//   - 插件依赖（jose / undici / cosmokit / schemastery）：默认随产物内置（约 3 MB），
//     加 --thin 也可改为目标机下载
//   - profile 的账号与设置数据：**一律不打包**，用 Jet Hub 的「账号备份导入」恢复
//
// 产物结构：
//
//   dsh-providers-hub-<ver>-win-x64\
//   ├─ MANIFEST.json            版本 / 依赖版本 / 校验和（可审计）
//   ├─ README.txt               部署说明
//   ├─ install.cmd / install.ps1  目标机执行：下载宿主依赖 + 组装 profile
//   ├─ start.cmd / stop.cmd / stop.ps1
//   ├─ runtime\
//   │  ├─ service-runner.mjs    服务包装器（配合 service.bat -Mode bootstrap）
//   │  └─ node.exe              ← 仅 --with-node 时存在（含 npm，约 130 MB）
//   ├─ plugin\                  ← 插件本体（lib / locale / cordis.patch.yml / package.json）
//   │  └─ node_modules\         插件生产依赖（--thin 时不存在）
//   └─ host\
//      ├─ package.json          {"dependencies":{"@deepseek-ai/dsh":"<range>"}}
//      └─ package-lock.json     精确锁定 548 个包的版本与 integrity（npm ci 用）
//
// ⚠️ 为什么必须带 package-lock.json：DSH 宿主只发布 rc 版本，`^0.2.1-rc.2` 这种范围
//    在目标机解析到的可能是插件 peerDependencies 不接受的版本，进而「插件装了但不加载」。
//    lock 让目标机的依赖树与打包机**逐字节一致**。
//
// ⚠️ 目标机绝不能 `npm ci --omit=peer`：DSH 宿主的 peerDependencies 是它运行的一部分
//    （dsh-app-boot 的 peer 里有 @deepseek-ai/cordis-plugin-loader 等），漏一个就
//    启动瞬间 ERR_MODULE_NOT_FOUND。install.ps1 里对此有显式核验。

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  copyFileSync, cpSync, existsSync, mkdirSync, readdirSync,
  readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { copyDetailDocs } from './lib/detail-docs.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = dirname(HERE)
const CACHE_DIR = join(REPO_ROOT, 'node_modules', '.cache', 'standalone')

// ---------------------------------------------------------------- 参数

function parseArgs(argv) {
  const out = {
    out: join(REPO_ROOT, 'dist', 'bootstrap'),
    profile: 'prod',
    dshVersion: '',
    withNode: false,
    thin: false,
    skipBuild: false,
    zip: false,
    lock: true,
    registry: '',
  }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    const next = () => argv[++i]
    switch (a) {
      case '--out': out.out = next(); break
      case '--profile': out.profile = next(); break
      case '--dsh-version': out.dshVersion = next(); break
      case '--registry': out.registry = next(); break
      case '--with-node': out.withNode = true; break
      case '--thin': out.thin = true; break
      case '--skip-build': out.skipBuild = true; break
      case '--zip': out.zip = true; break
      case '--no-lock': out.lock = false; break
      case '--help': case '-h': out.help = true; break
      default:
        if (a.startsWith('--')) throw new Error(`未知参数: ${a}`)
    }
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
if (args.help) {
  console.log('用法: node scripts/build-bootstrap.mjs [--out <目录>] [--profile <名>]')
  console.log('                                  [--dsh-version <ver>] [--with-node] [--thin]')
  console.log('                                  [--skip-build] [--zip] [--no-lock] [--registry <url>]')
  console.log('')
  console.log('  --with-node   把 Node 运行时（含 npm）打进产物，目标机无需装 Node（+130 MB）')
  console.log('  --thin        插件依赖也改为目标机下载（产物再省约 3 MB）')
  console.log('  --no-lock     不带 package-lock.json（不推荐：目标机版本会漂移）')
  process.exit(0)
}

// ---------------------------------------------------------------- 工具

function log(step, message) {
  console.log(`[${step}] ${message}`)
}

function writeText(target, content, { crlf = false, bom = false } = {}) {
  const text = crlf ? content.replace(/\r?\n/g, '\r\n') : content
  writeFileSync(target, bom ? `\ufeff${text}` : text, 'utf8')
}

// ⚠️ Windows 上 rmSync 面对「613 个包 + 深目录」经常因为路径过长/文件被占用而失败，
//    而某些宿主还会给 fs 加安全删除中间层（超时即抛）。cmd 的 rmdir /s /q 更鲁棒。
function removePath(target) {
  if (!existsSync(target)) return
  if (process.platform === 'win32') {
    spawnSync('cmd.exe', ['/c', 'rmdir', '/s', '/q', target], { stdio: 'ignore' })
    if (!existsSync(target)) return
  }
  rmSync(target, { recursive: true, force: true, maxRetries: 3 })
  if (existsSync(target)) {
    throw new Error(`无法删除: ${target}\n  常见原因：目录仍被进程占用（先执行产物里的 stop.cmd）。`)
  }
}

function copyTree(src, dst) {
  if (!existsSync(src)) throw new Error(`源目录不存在: ${src}`)
  removePath(dst)
  cpSync(src, dst, { recursive: true, dereference: true, force: true })
}

function dirSize(dir) {
  let total = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    total += entry.isDirectory() ? dirSize(p) : statSync(p).size
  }
  return total
}

function findNpmCli() {
  const candidates = [
    join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ]
  if (process.env.APPDATA) candidates.push(join(process.env.APPDATA, 'npm', 'node_modules', 'npm', 'bin', 'npm-cli.js'))
  return candidates.find((p) => p && existsSync(p)) ?? null
}

function runNpm(cliArgs, cwd) {
  const cli = findNpmCli()
  const r = cli
    ? spawnSync(process.execPath, [cli, ...cliArgs], { cwd, stdio: 'inherit' })
    : spawnSync('npm', cliArgs, { cwd, stdio: 'inherit', shell: true })
  if (r.status !== 0) throw new Error(`npm ${cliArgs.join(' ')} 失败（exit=${r.status}）`)
}

// ---------------------------------------------------------------- 版本解析

const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'))

function readInstalledDshVersion() {
  const probes = [
    join(CACHE_DIR, 'hostpkg', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
    join(process.env.USERPROFILE ?? '', '.dsh', 'profiles', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
  ]
  for (const p of probes) {
    try {
      const v = JSON.parse(readFileSync(p, 'utf8')).version
      if (v) return v
    } catch { /* 继续 */ }
  }
  return null
}

if (!args.dshVersion) {
  const detected = readInstalledDshVersion()
  if (!detected) {
    throw new Error('无法确定 DSH 宿主版本。请用 --dsh-version <ver> 指定（例如 --dsh-version 0.2.1-rc.2）')
  }
  args.dshVersion = detected
}

const productName = `${pkg.name}-${pkg.version}-win-x64${args.thin ? '-thin' : ''}`
const productDir = join(args.out, productName)

console.log('')
log('1/7', `引导式产物 -> ${productDir}`)
log('1/7', `宿主 @deepseek-ai/dsh@${args.dshVersion}（目标机按需下载，不随产物分发）`)
log('1/7', `插件 ${pkg.name}@${pkg.version}${args.thin ? '（依赖也改为按需下载）' : '（依赖随产物内置）'}`)
removePath(productDir)
mkdirSync(productDir, { recursive: true })

// ---------------------------------------------------------------- 2. 构建插件

if (args.skipBuild) {
  log('2/7', '跳过构建（--skip-build）')
} else {
  log('2/7', '构建插件（pnpm build:all）...')
  const r = spawnSync('pnpm', ['build:all'], { cwd: REPO_ROOT, stdio: 'inherit', shell: true })
  if (r.status !== 0) throw new Error('构建失败（pnpm build:all）')
}
for (const need of ['lib/index.js', 'lib/client/jet-hub.js', 'cordis.patch.yml']) {
  if (!existsSync(join(REPO_ROOT, need))) {
    throw new Error(`缺少构建产物 ${need} —— 先执行 pnpm build:all（或用 build:all 而非 build）`)
  }
}

// ---------------------------------------------------------------- 3. 插件本体

log('3/7', '收集插件本体 -> plugin/...')
const pluginDir = join(productDir, 'plugin')
copyTree(join(REPO_ROOT, 'lib'), join(pluginDir, 'lib'))
if (existsSync(join(REPO_ROOT, 'locale'))) copyTree(join(REPO_ROOT, 'locale'), join(pluginDir, 'locale'))
copyFileSync(join(REPO_ROOT, 'cordis.patch.yml'), join(pluginDir, 'cordis.patch.yml'))

// `meta.detail` 指向的文档必须一起走。漏了不是「回落 README」，而是
// 宿主 `readPackageDocument()` 抛 `DetailFailure('invalid')` ⇒ 详情页报错。
// 路径清单不在这里维护：`locale/*.json` 声明了什么就复制什么。
copyDetailDocs(REPO_ROOT, pluginDir)

// 精简 package.json：剔除 scripts（含 prepare）与 devDependencies，
// 否则目标机 npm install 会触发 prepare 构建而失败。
const slimPkg = { ...pkg }
delete slimPkg.scripts
delete slimPkg.devDependencies
delete slimPkg.prepare
delete slimPkg.files
writeFileSync(join(pluginDir, 'package.json'), `${JSON.stringify(slimPkg, null, 2)}\n`, 'utf8')

const pluginDeps = Object.keys(slimPkg.dependencies ?? {})
if (args.thin) {
  log('3/7', `插件依赖（${pluginDeps.length} 个）改为目标机按需下载：${pluginDeps.join(', ')}`)
} else {
  // 插件依赖只有 4 个（jose / undici / cosmokit / schemastery），直接内置最省事：
  // 目标机不必为它们再跑一次 npm install。
  const srcModules = join(CACHE_DIR, 'apppkg', 'node_modules')
  // ⚠️ 2026-10-31 审计（P1）：缓存判据不能只有「目录存在」——package.json 改了依赖
  //    也永远复用旧缓存，插件在目标机加载时报 ERR_MODULE_NOT_FOUND 且打包零告警。
  //    对照 build-standalone.mjs 的既有做法：slimPkgText 逐字节相同 && node_modules
  //    （含 .package-lock.json）存在才复用，否则删除重建。
  const slimPkgText = `${JSON.stringify({ ...slimPkg, name: 'dsh-app-deps', version: '0.0.0', private: true }, null, 2)}\n`
  const cachePkgFile = join(CACHE_DIR, 'apppkg', 'package.json')
  const appCached = existsSync(srcModules)
    && existsSync(join(srcModules, '.package-lock.json'))
    && existsSync(cachePkgFile)
    && readFileSync(cachePkgFile, 'utf8') === slimPkgText
  if (!appCached) {
    log('3/7', appCached === false && existsSync(srcModules)
      ? '插件依赖缓存存在但 package.json 已变化（依赖清单改动），正在重建...'
      : '插件依赖缓存不存在，正在生成...')
    removePath(join(CACHE_DIR, 'apppkg'))
    mkdirSync(join(CACHE_DIR, 'apppkg'), { recursive: true })
    writeFileSync(cachePkgFile, slimPkgText, 'utf8')
    runNpm(['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error'], join(CACHE_DIR, 'apppkg'))
  } else {
    log('3/7', '复用插件依赖缓存（依赖清单与上次逐字节一致）')
  }
  copyTree(srcModules, join(pluginDir, 'node_modules'))
  log('3/7', `插件依赖已内置（${pluginDeps.length} 个包）`)
}

// ---------------------------------------------------------------- 4. 宿主 lock

log('4/7', '准备宿主依赖清单 -> host/...')
const hostDir = join(productDir, 'host')
mkdirSync(hostDir, { recursive: true })

const cachedHostPkg = join(CACHE_DIR, 'hostpkg', 'package.json')
const cachedHostLock = join(CACHE_DIR, 'hostpkg', 'package-lock.json')

// ⚠️ 2026-10-31 审计（P1）：复用 cache hostpkg 的 lock 前必须核对其中钉住的
//    @deepseek-ai/dsh 版本等于本次 args.dshVersion —— 旧实现只看文件存在，
//    用户改 --dsh-version 后产物声称新版本、目标机 npm ci 却装回 lock 里的旧版。
//    对照 build-standalone.mjs 的既有做法（读宿主安装清单核对版本）。
const cachedHostInstalled = join(CACHE_DIR, 'hostpkg', 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
const cachedLockVersion = (() => {
  try {
    const lock = JSON.parse(readFileSync(cachedHostLock, 'utf8'))
    // lock v2/v3：packages['node_modules/@deepseek-ai/dsh'].version；lock v1：dependencies 递归。两种都试。
    const v2 = lock.packages?.['node_modules/@deepseek-ai/dsh']?.version
    if (v2) return v2
    return lock.dependencies?.['@deepseek-ai/dsh']?.version ?? null
  } catch { return null }
})()
// 兜底：lock 里读不到（罕见）再试宿主安装清单。
function cachedHostDshVersion() {
  try {
    return JSON.parse(readFileSync(cachedHostInstalled, 'utf8')).version ?? null
  } catch { return null }
}

const hostFilesExist = existsSync(cachedHostPkg) && existsSync(cachedHostLock)
const lockDshVersion = cachedLockVersion ?? cachedHostDshVersion()
const canReuseHostLock = args.lock && hostFilesExist && lockDshVersion === args.dshVersion

if (args.lock && hostFilesExist && !canReuseHostLock) {
  log('4/7', `宿主 lock 缓存钉的是 @deepseek-ai/dsh@${lockDshVersion ?? '（未知）'}，与本次 --dsh-version ${args.dshVersion} 不符 —— 走 lockgen 重建`)
}

if (canReuseHostLock) {
  // ⚠️ 必须**成对**拷贝：npm ci 要求 package.json 与 lock 的 dependencies 完全一致。
  //    cache 里那份是 build-standalone.mjs 装 548 个包时生成的，可直接复用。
  copyFileSync(cachedHostPkg, join(hostDir, 'package.json'))
  copyFileSync(cachedHostLock, join(hostDir, 'package-lock.json'))
  log('4/7', `复用打包机的宿主 lock（@deepseek-ai/dsh@${lockDshVersion}，依赖树与打包机逐字节一致）`)
} else if (args.lock) {
  // 没有 cache（或 cache 版本不符）时用 --package-lock-only 只解析依赖树、不下载包（快且足够）。
  const staging = join(CACHE_DIR, 'lockgen')
  rmSync(staging, { recursive: true, force: true })
  mkdirSync(staging, { recursive: true })
  writeFileSync(
    join(staging, 'package.json'),
    `${JSON.stringify({
      name: 'dsh-host-bootstrap',
      version: '0.0.0',
      private: true,
      dependencies: { '@deepseek-ai/dsh': `^${args.dshVersion}` },
    }, null, 2)}\n`,
    'utf8',
  )
  log('4/7', '生成宿主 lock（npm install --package-lock-only）...')
  runNpm([
    'install', '--package-lock-only', '--omit=dev', '--ignore-scripts',
    '--no-audit', '--no-fund', '--loglevel=error',
    ...(args.registry ? ['--registry', args.registry] : []),
  ], staging)
  copyFileSync(join(staging, 'package.json'), join(hostDir, 'package.json'))
  copyFileSync(join(staging, 'package-lock.json'), join(hostDir, 'package-lock.json'))
} else {
  writeFileSync(
    join(hostDir, 'package.json'),
    `${JSON.stringify({
      name: 'dsh-host-bootstrap',
      version: '0.0.0',
      private: true,
      dependencies: { '@deepseek-ai/dsh': args.dshVersion },
    }, null, 2)}\n`,
    'utf8',
  )
  log('4/7', '[警告] 未带 lock（--no-lock）：目标机会用 npm install 解析版本，可能与打包机不一致')
}

// ---------------------------------------------------------------- 5. 脚本

log('5/7', '生成安装/启停脚本...')
const runtimeDir = join(productDir, 'runtime')
mkdirSync(runtimeDir, { recursive: true })
copyFileSync(join(REPO_ROOT, 'service-runner.mjs'), join(runtimeDir, 'service-runner.mjs'))

// ⚠️ 2026-10-31 审计（P1）：产物此前只带 service-runner.mjs 不带 service.bat，
//    README/MANIFEST 却指导用户在目标机注册服务 —— 无脚本可跑。随附一份仓库根的
//    service.bat，让「产物目录里就地注册服务」成为自包含操作。
copyFileSync(join(REPO_ROOT, 'service.bat'), join(productDir, 'service.bat'))

const template = readFileSync(join(HERE, 'templates', 'install-bootstrap.ps1'), 'utf8')
const installPs1 = template
  .replaceAll('@@PROFILE@@', args.profile)
  .replaceAll('@@PLUGIN_NAME@@', pkg.name)
  .replaceAll('@@PLUGIN_VERSION@@', pkg.version)
  .replaceAll('@@DSH_VERSION@@', args.dshVersion)
  .replaceAll('@@REGISTRY@@', args.registry)
  // 目标机没有 Node 时自动下载这个版本（用打包机自身的版本，已验证可跑通本插件）。
  .replaceAll('@@NODE_VERSION@@', process.version)
writeText(join(productDir, 'install.ps1'), installPs1, { bom: true })

// ⚠️ 这个 .cmd **必须保持纯 ASCII**（含注释）。
//    原因：`chcp 65001` 会改变 cmd 读取本文件时的字符宽度计算，
//    chcp 之后的**多字节（中文）行**会让 cmd 按字节偏移 seek 时错位，
//    表现为把某行拆开执行 —— 实测服务器上出现
//      '◆本机有' is not recognized as an internal or external command
//    （那是 `rem  前置：本机有 Node.js...` 被错位截断后当命令跑了）。
//    本机默认代码页恰好不触发，容易漏掉。中文提示一律交给 install.ps1 输出。
const installCmd = `@echo off
rem ============================================================
rem  dsh-providers-hub bootstrap bundle -- install on target host
rem  Downloads DSH host dependencies, then assembles the profile.
rem  Node.js is auto-detected: bundled runtime\ first, then system PATH,
rem  and if neither exists it downloads the official Node zip (~30 MB, includes npm).
rem  Dependency download needs network access.
rem  NOTE: keep this file ASCII-only -- see build-bootstrap.mjs comment.
rem ============================================================
chcp 65001 >nul
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
set "RC=%ERRORLEVEL%"
echo.
if not "%RC%"=="0" echo [install] FAILED - exit code %RC%
pause
exit /b %RC%
`

// start.cmd：自动在「产物内置 Node」与「系统 Node」之间选择，并在未安装时给出提示。
// ⚠️ 同样必须纯 ASCII（chcp 之后不能有中文行）。
const startCmd = `@echo off
rem ============================================================
rem  dsh-providers-hub bootstrap bundle -- start
rem  Run install.cmd first (downloads deps + assembles the profile).
rem  NOTE: keep this file ASCII-only -- see build-bootstrap.mjs comment.
rem ============================================================
chcp 65001 >nul
setlocal EnableExtensions DisableDelayedExpansion
set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\\" set "ROOT=%ROOT:~0,-1%"

rem ---- DSH_HOME must point at the bundled home ----
rem NOTE: do NOT write  if not defined DSH_HOME  here.
rem   If the machine already has DSH_HOME set (e.g. from an earlier install that
rem   did setx to C:\ProgramData\...), the external value is kept. That directory
rem   has no profiles\<name> and no dependency closure, so the host aborts with:
rem       Error: dsh: profile "prod" does not exist
rem   Our own liveness check below uses %ROOT%, so it passes anyway -- which makes
rem   the symptom extremely misleading. The bundle is self-contained: deps, profile
rem   and patch layers all live under %ROOT%\home, so an external home is always wrong.
if defined DSH_HOME echo [start][WARN] overriding external DSH_HOME=%DSH_HOME%
set "DSH_HOME=%ROOT%\\home"
if not defined DSH_PROFILE set "DSH_PROFILE=${args.profile}"
if not defined DSH_HOST set "DSH_HOST=127.0.0.1"
if not defined DSH_PORT set "DSH_PORT=8123"
if not defined DSH_OPENAI_GATEWAY_ENABLED set "DSH_OPENAI_GATEWAY_ENABLED=1"
if not defined DSH_OPENAI_GATEWAY_PORT set "DSH_OPENAI_GATEWAY_PORT=8326"
if not defined DSH_OPENAI_GATEWAY_HOST set "DSH_OPENAI_GATEWAY_HOST=127.0.0.1"

rem ---- pick node: bundled first, else system PATH ----
set "NODE_BIN=%ROOT%\\runtime\\node.exe"
if exist "%NODE_BIN%" goto node_ready
where node.exe >nul 2>&1
if errorlevel 1 goto node_missing
set "NODE_BIN=node.exe"
goto node_ready
:node_missing
echo [start][ERROR] node.exe not found.
echo.
echo   runtime\\node.exe missing, and no node.exe on PATH.
echo   Run install.cmd first: it downloads Node automatically when missing.
echo   (Or repackage with: node scripts\\build-bootstrap.mjs --with-node)
echo.
if not defined DSH_NO_PAUSE pause
exit /b 1
:node_ready
if exist "%ROOT%\\runtime" set "PATH=%ROOT%\\runtime;%PATH%"

rem ---- not installed yet? ----
set "DSH_ENTRY=%ROOT%\\home\\profiles\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js"
if not exist "%DSH_ENTRY%" goto not_installed
if not exist "%ROOT%\\home\\profiles\\%DSH_PROFILE%\\node_modules\\${pkg.name}\\lib\\index.js" goto not_installed
goto run

:not_installed
echo [start][ERROR] dependencies or plugin not installed for profile %DSH_PROFILE%
echo.
echo   expected host entry : %DSH_ENTRY%
echo   expected plugin     : %ROOT%\\home\\profiles\\%DSH_PROFILE%\\node_modules\\${pkg.name}\\lib\\index.js
echo.
echo   Run install.cmd and let it finish. If it already ran, it probably
echo   failed halfway: rerun it with  install.cmd -Force  to reinstall deps.
echo.
if not defined DSH_NO_PAUSE pause
exit /b 1

:run
echo [start] DSH_HOME    = %DSH_HOME%
echo [start] profile     = %DSH_PROFILE%
echo [start] web ui      = http://%DSH_HOST%:%DSH_PORT%
echo [start] gateway     = http://%DSH_OPENAI_GATEWAY_HOST%:%DSH_OPENAI_GATEWAY_PORT%/v1
echo [start] node        = %NODE_BIN%
echo [start] entry       = %DSH_ENTRY%
echo.
echo [start] starting dsh ... first start may take 1-3 minutes
echo         it builds link projections for every dependency and loads all plugins.
echo         wait until the console prints the web server address, then open the UI.
echo.

"%NODE_BIN%" "%DSH_ENTRY%" --profile %DSH_PROFILE% --host %DSH_HOST% --port %DSH_PORT% --no-open %*
set "RC=%ERRORLEVEL%"
echo.
echo [start] dsh exited with code %RC%
if not defined DSH_NO_PAUSE pause
exit /b %RC%
`

const stopPs1 = `# 停止本产物启动的 dsh 进程。
# 匹配条件用**本文件所在目录**拼出的绝对路径 —— 只停本产物，
# 不会误伤同机其它 DSH 部署（命令行里都含各自的 bin.js 绝对路径）。
# ⚠️ 比较必须**不区分大小写**：Windows 进程命令行里的盘符常是小写。
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
rem Stop the dsh process started by this bundle.
rem NOTE: keep this file ASCII-only -- see build-bootstrap.mjs comment.
chcp 65001 >nul
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop.ps1"
`

writeText(join(productDir, 'install.cmd'), installCmd, { crlf: true })
writeText(join(productDir, 'start.cmd'), startCmd, { crlf: true })
writeText(join(productDir, 'stop.cmd'), stopCmd, { crlf: true })
writeText(join(productDir, 'stop.ps1'), stopPs1)

// ---------------------------------------------------------------- 6. Node（可选）

let nodeVersion = '（未内置，使用目标机的 Node）'
if (args.withNode) {
  log('6/7', '内置 Node 运行时（含 npm）...')
  const nodeExe = process.execPath
  const nodeDir = dirname(nodeExe)
  copyFileSync(nodeExe, join(runtimeDir, 'node.exe'))
  // npm 一起带走 —— 否则目标机仍需要装 Node 才能跑 install.ps1
  const npmSource = join(nodeDir, 'node_modules', 'npm')
  if (!existsSync(npmSource)) {
    throw new Error(`找不到 npm 目录: ${npmSource} —— 无法内置 Node 运行时（请用官方 Node 发行版）`)
  }
  copyTree(npmSource, join(runtimeDir, 'node_modules', 'npm'))
  nodeVersion = process.version
  log('6/7', `已内置 ${nodeVersion} + npm`)
} else {
  log('6/7', '未内置 Node（目标机需自备 Node.js；需要自带请加 --with-node）')
}

// ---------------------------------------------------------------- 7. 清单/说明

log('7/7', '生成清单与说明...')

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

const manifest = {
  product: pkg.name,
  version: pkg.version,
  kind: 'bootstrap',
  profile: args.profile,
  platform: 'win32-x64',
  host: { name: '@deepseek-ai/dsh', requested: args.dshVersion, deliveredBy: 'npm (install.cmd)' },
  lockedDependencies: args.lock && existsSync(join(hostDir, 'package-lock.json')),
  pluginDependencies: args.thin ? 'npm (install.ps1)' : 'bundled',
  nodeRuntime: args.withNode ? { bundled: true, version: nodeVersion } : { bundled: false, requires: '^22.19.0 || >=24' },
  profileData: '不随产物分发；用 Jet Hub「账号备份导入」恢复',
  installCommand: 'install.cmd',
  startCommand: 'start.cmd',
  serviceCommand: `service.bat install -Mode bootstrap -BundleDir "${productDir}" -Profile ${args.profile}`,
  // ⚠️ 2026-10-31 审计（P1）：旧版命令缺 -NoPackage，且产物没带 service.bat ——
  //    目标机上按旧文档执行必然 die（scripts\build-bootstrap.mjs 不存在）。
  //    现在产物随附 service.bat，且新脚本会自动检测产物目录并跳过打包。
  serviceCommandNote: '产物已随附 service.bat；新版脚本检测到完整产物时自动跳过打包，无需 -NoPackage。',
  files: {},
}
for (const rel of ['install.ps1', 'start.cmd', 'stop.cmd', 'stop.ps1', 'plugin/lib/index.js', 'plugin/lib/client/jet-hub.js', 'plugin/cordis.patch.yml', 'host/package.json']) {
  const p = join(productDir, rel.replaceAll('/', '\\'))
  if (existsSync(p)) manifest.files[rel] = sha256(p)
}
writeFileSync(join(productDir, 'MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

const readme = `dsh-providers-hub ${pkg.version} —— 引导式部署产物
============================================================

这个产物【不含】node_modules：DSH 宿主及其 ${args.dshVersion} 依赖闭包
会在目标机执行 install.cmd 时按需下载。因此体积只有几 MB（而不是数百 MB）。

前置条件
--------
1) Node.js：^22.19.0 或 >=24
   ${args.withNode ? '本产物已内置 Node（runtime\\node.exe + npm），可跳过这一条。' : '本产物未内置 Node —— install.cmd 会按以下顺序自动解决：\n     ① 产物 runtime\\node.exe（若存在）② 系统 PATH 上的 node.exe\n     ③ 自动下载官方 Node ${process.version} win-x64 zip（约 30 MB，含 npm）解压到 runtime\\\n   全部失败时才需要你手工安装。可加 -NodeMirror <镜像基址> 换源，\n   或 -SkipNodeDownload 禁止自动下载。'}
2) 网络：可访问 npm registry（内网可用 install.cmd -Registry <镜像地址>）。
3) 磁盘：依赖闭包解压后约 700 MB（下载缓存另计）。

部署步骤
--------
1) 把整个目录拷到服务器（例如 C:\\apps\\${productName}）
2) 执行安装（首次约 1-3 分钟）：

     install.cmd

   可选参数：
     install.cmd -Profile ${args.profile} -Registry https://registry.npmmirror.com
     install.cmd -Force          # 重建 profile 骨架
     install.cmd -SkipVerify     # 跳过原生模块核验

3) 启动：

     start.cmd

   环境变量（均可覆盖）：
     DSH_PROFILE=prod  DSH_HOST=127.0.0.1  DSH_PORT=8123
     DSH_OPENAI_GATEWAY_PORT=8326  DSH_OPENAI_GATEWAY_HOST=127.0.0.1

4) 注册成 Windows 服务（管理员 + NSSM；产物根目录已随附 service.bat）：

     service.bat install -Mode bootstrap -BundleDir "${productDir}" -Profile ${args.profile}

   ⚠️ 2026-10-31 审计（P1）：新脚本检测到完整产物时会自动跳过打包，无需 -NoPackage；
   老版本（不带该自动检测的）请加 -NoPackage，否则它会尝试在目标机重新打包而失败。

目录结构
--------
${productName}\\
├─ MANIFEST.json          版本 / 依赖版本 / 关键文件 sha256
├─ README.txt             本文件
├─ install.cmd / install.ps1   目标机安装（下载依赖 + 组装 profile）
├─ start.cmd / stop.cmd / stop.ps1
├─ service.bat            注册 Windows 服务（install -Mode bootstrap -BundleDir 本目录）
├─ runtime\\
│  ├─ service-runner.mjs  服务包装器
${args.withNode ? '│  ├─ node.exe            内置 Node ' + nodeVersion + '\n│  └─ node_modules\\npm     内置 npm\n' : ''}├─ plugin\\                 插件本体（lib / locale / cordis.patch.yml / package.json）
${args.thin ? '│  （依赖由 install.ps1 下载）' : '│  └─ node_modules\\        插件生产依赖（已内置）'}
└─ host\\
   ├─ package.json        宿主依赖声明
   └─ package-lock.json   精确锁定版本（install.ps1 用 npm ci）

install.cmd 做了什么
--------------------
1) 校验 Node 版本（^22.19.0 || >=24）
2) 把 host\\package.json + package-lock.json 放进 home\\profiles\\
3) npm ci（严格按 lock 装宿主及其 548 个传递依赖）
   ⚠️ 不会加 --omit=peer —— DSH 宿主的 peer 依赖是它运行的一部分
4) 核验 peer 闭包（dsh / dsh-base / dsh-web-app / dsh-llm / cordis-plugin-loader）
5) 建 profile 骨架（package.json / cordis.patch.yml / pnpm-workspace.yaml）
6) 把 plugin\\ 拷进 profile\\node_modules\\
7) 核验 .node 二进制是否当前平台
8) 打印启动与注册服务的命令

账号数据怎么来
--------------
产物【不含】任何账号、凭据、设置。两种任一：
  a) 浏览器打开 Web UI，在 Jet Hub 设置页走登录流程；
  b) 在有账号的机器上「导出备份」→ 拷到本机 → Jet Hub 设置页「导入」。
     备份文件是自包含 JSON，与 DSH 版本无关。

注意事项
--------
* 宿主每次启动都会重写 home\\profiles\\${args.profile}\\cordis.yml，
  因此 profile 目录必须【可写】。
* profile 的 patchReload 设为 startup（而非 live），避免服务常驻时起文件监听；
  改完 cordis.patch.yml 请重启服务。
* 网关默认只绑 127.0.0.1。不要改成 0.0.0.0 / ::（宿主与网关都会显式拒绝并报错退出）；
  要给内网访问请填具体网卡 IP，并务必设置 DSH_OPENAI_GATEWAY_API_KEY。
* 依赖下载失败时：先确认 npm registry 可达（install.cmd -Registry <镜像>），
  再确认磁盘与代理。npm 缓存位于 %LOCALAPPDATA%\\npm-cache，可安全清空。
`
writeText(join(productDir, 'README.txt'), readme, { crlf: true })

// ---------------------------------------------------------------- 核验

const required = [
  join(productDir, 'install.ps1'),
  join(productDir, 'install.cmd'),
  join(productDir, 'start.cmd'),
  join(productDir, 'stop.cmd'),
  join(productDir, 'service.bat'),
  join(runtimeDir, 'service-runner.mjs'),
  join(pluginDir, 'lib', 'index.js'),
  join(pluginDir, 'lib', 'client', 'jet-hub.js'),
  join(pluginDir, 'cordis.patch.yml'),
  join(hostDir, 'package.json'),
]
if (args.lock) required.push(join(hostDir, 'package-lock.json'))
if (args.withNode) required.push(join(runtimeDir, 'node.exe'))
for (const f of required) {
  if (!existsSync(f)) throw new Error(`产物缺少必需文件: ${f}`)
}

// ---------------------------------------------------------------- zip

if (args.zip) {
  const zipPath = join(args.out, `${productName}.zip`)
  rmSync(zipPath, { force: true })
  log('7/7', `生成 zip: ${zipPath}`)
  const r = spawnSync('powershell', [
    '-NoProfile', '-Command',
    `Compress-Archive -Path '${productDir}\\*' -DestinationPath '${zipPath}' -Force`,
  ], { stdio: 'inherit' })
  if (r.status !== 0) console.log('[警告] zip 生成失败，可手工压缩产物目录')
}

// ---------------------------------------------------------------- 汇总

const sizeMb = (dirSize(productDir) / 1024 / 1024).toFixed(1)
console.log('')
console.log(`[完成] 产物: ${productDir}`)
console.log(`[完成] 体积: ${sizeMb} MB（依赖由目标机 install.cmd 按需下载）`)
console.log(`[完成] 宿主: @deepseek-ai/dsh@${args.dshVersion}${args.lock ? '（已锁定版本）' : '（未锁定）'}`)
console.log(`[完成] 插件依赖: ${args.thin ? '目标机下载' : '已内置'}`)
console.log(`[完成] Node: ${args.withNode ? `已内置 ${nodeVersion}` : '未内置（目标机自备）'}`)
if (args.zip) console.log(`[完成] zip: ${join(args.out, `${productName}.zip`)}`)
console.log('')
console.log('目标机部署：解压 -> install.cmd -> start.cmd')
console.log(`注册服务（产物已随附 service.bat）：service.bat install -Mode bootstrap -BundleDir "${productDir}" -Profile ${args.profile}`)
