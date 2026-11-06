@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

rem ============================================================
rem  dsh-providers-hub 一键启动/重启脚本
rem  未运行 -> 启动；已在运行 -> 停掉旧实例再启动（默认会重新构建）
rem
rem  用法：
rem    dev.bat              构建 + 启动/重启
rem    dev.bat --nobuild    只重启，跳过构建
rem    dev.bat --open       启动后自动打开浏览器
rem
rem  dsh 宿主入口自动探测（桌面端升级/换盘后不必改脚本）；
rem  也可先用环境变量 DSH_BIN 手动指定：
rem    set DSH_BIN=D:\...\node_modules\@deepseek-ai\dsh\lib\bin.js
rem ============================================================

set "PORT=8123"
set "PROFILE=dev"
set "ROOT=%~dp0"
set "DSH="
set "OUT=%TEMP%\dsh-dev-out.log"
set "ERR=%TEMP%\dsh-dev-err.log"

set "DO_BUILD=1"
set "DO_OPEN=0"
for %%a in (%*) do (
  if /i "%%a"=="--nobuild" set "DO_BUILD=0"
  if /i "%%a"=="--open"    set "DO_OPEN=1"
)

rem ---------- 0. 探测 dsh CLI 入口 ----------
rem 0a. 手动指定优先
if defined DSH_BIN if exist "%DSH_BIN%" set "DSH=%DSH_BIN%"

rem 0b. profile 自带的宿主入口（link: / pnpm 安装时会落在这里）
if not defined DSH if exist "%USERPROFILE%\.dsh\profiles\node_modules\@deepseek-ai\dsh\lib\bin.js" (
  set "DSH=%USERPROFILE%\.dsh\profiles\node_modules\@deepseek-ai\dsh\lib\bin.js"
)

rem 0c. 桌面端标准安装：<盘>\DeepSeekHarness\resources\app\dsh\node_modules\...
if not defined DSH for %%D in (C D E F G Z) do (
  if exist "%%D:\DeepSeekHarness\resources\app\dsh\node_modules\@deepseek-ai\dsh\lib\bin.js" (
    if not defined DSH set "DSH=%%D:\DeepSeekHarness\resources\app\dsh\node_modules\@deepseek-ai\dsh\lib\bin.js"
  )
)

rem 0d. 旧便携版：<盘>\Program File\DSH-Desktop-Portable-*\DSH Desktop\resources\dsh-desktop\...
if not defined DSH for %%D in (C D E F G Z) do (
  for /d %%V in ("%%D:\Program File\DSH-Desktop-Portable-*") do (
    if exist "%%~V\DSH Desktop\resources\dsh-desktop\node_modules\@deepseek-ai\dsh\lib\bin.js" (
      if not defined DSH set "DSH=%%~V\DSH Desktop\resources\dsh-desktop\node_modules\@deepseek-ai\dsh\lib\bin.js"
    )
  )
)

if not defined DSH (
  echo [错误] 未找到 dsh CLI 入口，已探测：
  echo       %%USERPROFILE%%\.dsh\profiles\node_modules\@deepseek-ai\dsh\lib\bin.js
  echo       ^<盘^>:\DeepSeekHarness\resources\app\dsh\node_modules\@deepseek-ai\dsh\lib\bin.js
  echo       ^<盘^>:\Program File\DSH-Desktop-Portable-*\DSH Desktop\resources\dsh-desktop\...
  echo       可先执行 set DSH_BIN=^<bin.js 完整路径^> 再运行本脚本。
  exit /b 1
)
echo 使用 dsh CLI: %DSH%

rem ---------- 1. 构建 ----------
if "%DO_BUILD%"=="1" (
  echo [1/3] 构建中...
  pushd "%ROOT%"
  call pnpm build:all
  if errorlevel 1 (
    echo [错误] 构建失败，已中止启动
    popd
    exit /b 1
  )
  popd
) else (
  echo [1/3] 跳过构建
)

rem ---------- 2. 停止已运行实例 ----------
echo [2/3] 停止端口 %PORT% 上的旧实例...
set "KILLED=0"
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":%PORT% " ^| findstr /i LISTENING') do (
  rem 只杀 node 进程，避免误伤占用同端口的其它程序
  tasklist /fi "PID eq %%p" /nh | findstr /i "node.exe" >nul
  if not errorlevel 1 (
    echo       停止 PID %%p
    taskkill /PID %%p /F >nul 2>&1
    set "KILLED=1"
  )
)
if "%KILLED%"=="1" (
  ping -n 3 127.0.0.1 >nul 2>&1
) else (
  echo       没有运行中的实例
)

rem ---------- 3. 启动 ----------
echo [3/3] 启动 profile=%PROFILE% port=%PORT% ...
if exist "%OUT%" del /q "%OUT%" >nul 2>&1
if exist "%ERR%" del /q "%ERR%" >nul 2>&1

start "dsh-dev" /B node "%DSH%" --profile %PROFILE% --port %PORT% --host 127.0.0.1 --no-open > "%OUT%" 2> "%ERR%"

rem ---------- 4. 等待就绪 ----------
rem 只判端口是否 LISTENING，不依赖宿主启动日志的排版（升级后日志格式常变）
set "READY="
for /l %%i in (1,1,40) do (
  ping -n 2 127.0.0.1 >nul 2>&1
  netstat -ano | findstr ":%PORT% " | findstr /i LISTENING >nul 2>&1
  if not errorlevel 1 set "READY=1"
  if defined READY goto :ready
)

echo [错误] 40 秒内未就绪，请检查日志：
echo       %ERR%
if exist "%ERR%" type "%ERR%"
exit /b 1

:ready
rem 端口监听可能早于宿主打印 URL，最多再等 10 秒让日志落盘
for /l %%i in (1,1,10) do (
  findstr /c:"http://" "%OUT%" >nul 2>&1
  if not errorlevel 1 goto :goturl
  findstr /c:"http://" "%ERR%" >nul 2>&1
  if not errorlevel 1 goto :goturl
  ping -n 2 127.0.0.1 >nul 2>&1
)

:goturl
rem 宿主打印的 URL 带一次性 token，直接给裸地址会被 401 拒绝；
rem 把日志行开头到 http:// 的前缀剥掉，剩下的就是完整 URL。
set "URL=http://127.0.0.1:%PORT%/"
for %%F in ("%OUT%" "%ERR%") do (
  if exist %%F (
    for /f "delims=" %%L in ('findstr /c:"http://" %%F 2^>nul') do (
      set "LINE=%%L"
      set "URL=!LINE:*http://=http://!"
    )
  )
)
echo.
echo 已就绪： %URL%
if "%DO_OPEN%"=="1" start "" "%URL%"
echo 日志： %OUT%  /  %ERR%
echo 停止： for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":%PORT% " ^| findstr LISTENING'^) do taskkill /PID %%p /F
exit /b 0
