@echo off
cd /d "%~dp0"
if not exist "runtime\node\node.exe" (
 echo Missing bundled runtime. Use the complete portable package.
 exit /b 1
)
"%SystemRoot%\System32\icacls.exe" "runtime\jdk8" /grant "*S-1-15-2-1:(OI)(CI)(RX)" /T /Q >nul
if errorlevel 1 exit /b 1
"runtime\node\node.exe" selfhost\local.mjs
