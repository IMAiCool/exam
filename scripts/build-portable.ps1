param(
  [Parameter(Mandatory=$true)][string]$PythonHome,
  [Parameter(Mandatory=$true)][string]$JavaHome,
  [Parameter(Mandatory=$true)][string]$MySQLHome
)
$ErrorActionPreference='Stop'
$projectRoot=Split-Path $PSScriptRoot -Parent
$runtimeRoot=Join-Path $projectRoot 'runtime'
if(Test-Path -LiteralPath $runtimeRoot){throw 'runtime 已存在，避免覆盖已有运行包。请使用干净的项目副本构建。'}
foreach($entry in @((Join-Path $PythonHome 'python.exe'),(Join-Path $JavaHome 'bin/javac.exe'),(Join-Path $MySQLHome 'bin/mysqld.exe'))){if(!(Test-Path -LiteralPath $entry)){throw "缺少构建输入：$entry"}}
New-Item -ItemType Directory -Path "$runtimeRoot/python","$runtimeRoot/node","$runtimeRoot/mysql" | Out-Null
Get-ChildItem -LiteralPath $PythonHome -File | Where-Object {$_.Extension -in '.exe','.dll','.txt'} | Copy-Item -Destination "$runtimeRoot/python"
Copy-Item -LiteralPath "$PythonHome/DLLs" -Destination "$runtimeRoot/python/DLLs" -Recurse
& "$PythonHome/python.exe" -c "import shutil,sys; shutil.copytree(sys.argv[1],sys.argv[2],ignore=shutil.ignore_patterns('site-packages','__pycache__','test','tests','idlelib','tkinter','ensurepip'))" "$PythonHome/Lib" "$runtimeRoot/python/Lib"
if($LASTEXITCODE){throw 'Python 标准库复制失败'}
& "$PythonHome/python.exe" -m pip install --disable-pip-version-check --target "$runtimeRoot/python/Lib/site-packages" wasmtime==50.0.1 pywin32==311 reportlab==5.1.0 pygments==2.21.0
if($LASTEXITCODE){throw '运行包依赖安装失败'}
Copy-Item -LiteralPath $JavaHome -Destination "$runtimeRoot/jdk8" -Recurse
foreach($folder in 'bin','lib','share'){Copy-Item -LiteralPath "$MySQLHome/$folder" -Destination "$runtimeRoot/mysql/$folder" -Recurse}
Get-ChildItem -LiteralPath $MySQLHome -File | Copy-Item -Destination "$runtimeRoot/mysql"
Copy-Item -LiteralPath (Get-Command node.exe).Source -Destination "$runtimeRoot/node/node.exe"
$nodeVersion=& "$runtimeRoot/node/node.exe" -p 'process.version'
Invoke-WebRequest -Uri "https://raw.githubusercontent.com/nodejs/node/$nodeVersion/LICENSE" -OutFile "$runtimeRoot/node/LICENSE"
& "$env:SystemRoot/System32/icacls.exe" "$runtimeRoot/jdk8" /grant '*S-1-15-2-1:(OI)(CI)(RX)' /T /Q | Out-Null
if($LASTEXITCODE){throw 'JDK 隔离读取权限设置失败'}
Write-Host '完整运行环境已打包到 runtime；目标机器无需安装 Python、JDK 或 MySQL。'
