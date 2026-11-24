param([Parameter(Mandatory)][string[]]$ExamOrigin)
$ErrorActionPreference = 'Stop'
$origins = foreach ($address in $ExamOrigin) {
    $url = [uri]$address
    if (!$url.IsAbsoluteUri -or $url.Scheme -notin 'http','https' -or $url.UserInfo) {
        throw "Invalid exam service URL: $address"
    }
    $url.GetLeftPart([UriPartial]::Authority)
}
$folder = Join-Path $env:LOCALAPPDATA 'ExamQuestionCard'
New-Item -ItemType Directory -Path $folder -Force | Out-Null
$runtime = Join-Path $folder 'runtime'
$python = Join-Path $runtime 'Scripts/python.exe'
if (!(Test-Path $python)) {
    & python -m venv --system-site-packages $runtime
    if ($LASTEXITCODE) { throw 'Python with venv and Tk is required.' }
}
& $python -c "import tkinter, PIL.ImageTk" 2>$null
if ($LASTEXITCODE) {
    & $python -m pip install Pillow
    if ($LASTEXITCODE) { throw 'Pillow installation failed.' }
}
$script = Join-Path $folder 'card.pyw'
$arguments = @('"' + $script + '"') + @($origins | ForEach-Object { '--origin "' + $_ + '"' })
$listener = Get-NetTCPConnection -LocalPort 18749 -State Listen -ErrorAction SilentlyContinue
if ($listener) {
    $existing = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)"
    if ($existing.CommandLine -notlike "*$script*") { throw 'Local port 18749 is occupied.' }
    Stop-Process -Id $existing.ProcessId
}
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'card.pyw') -Destination $script -Force
$shell = New-Object -ComObject WScript.Shell
$link = $shell.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Startup')) 'ExamQuestionCard.lnk'))
$link.TargetPath = Join-Path $runtime 'Scripts/pythonw.exe'
$link.Arguments = $arguments -join ' '
$link.WorkingDirectory = $folder
$link.Save()
Start-Process -FilePath $link.TargetPath -ArgumentList $link.Arguments -WindowStyle Hidden
