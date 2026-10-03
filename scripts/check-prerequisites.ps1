param([switch]$Json)
$ErrorActionPreference = 'Continue'
$checks = [Collections.Generic.List[object]]::new()
function Add-Check($Name, $Found, $Detail, $Url) {
    $checks.Add([pscustomobject]@{Name=$Name; Available=[bool]$Found; Detail=$Detail; OfficialDownload=$Url})
}
foreach ($item in @(
    @('Git','git','https://git-scm.com/downloads/win'),
    @('VS Code','code','https://code.visualstudio.com/'),
    @('Node LTS','node','https://nodejs.org/en/download/'),
    @('Corepack','corepack','https://github.com/nodejs/corepack'),
    @('pnpm','pnpm','https://pnpm.io/installation'),
    @('Rust MSVC','rustc','https://rustup.rs/'),
    @('Cargo','cargo','https://rustup.rs/'),
    @('PostgreSQL','psql','https://www.postgresql.org/download/windows/')
)) {
    $command = Get-Command $item[1] -ErrorAction SilentlyContinue
    Add-Check $item[0] ($null -ne $command) $(if ($command) {$command.Source} else {'Not on PATH'}) $item[2]
}
$python = & py -3.12 --version 2>&1
Add-Check 'Python 3.12' ($LASTEXITCODE -eq 0) "$python" 'https://www.python.org/downloads/windows/'
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
$msvc = if (Test-Path -LiteralPath $vswhere) { & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath }
Add-Check 'MSVC C++ Build Tools' ([bool]$msvc) "$msvc" 'https://visualstudio.microsoft.com/visual-cpp-build-tools/'
$webview = Get-ItemProperty -Path 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\*','HKCU:\Software\Microsoft\EdgeUpdate\Clients\*' -ErrorAction SilentlyContinue | Where-Object {$_.name -like '*WebView2*'}
Add-Check 'WebView2 Runtime' ([bool]$webview) ($webview.pv -join ', ') 'https://developer.microsoft.com/microsoft-edge/webview2/'
$steam = Get-ItemProperty 'HKCU:\Software\Valve\Steam' -ErrorAction SilentlyContinue
Add-Check 'Steam' ([bool]$steam) $steam.SteamPath 'https://store.steampowered.com/about/'
if ($Json) { $checks | ConvertTo-Json } else { $checks | Format-Table -Wrap; Write-Output 'No software was installed. Gorilla Tag is optional for synthetic tests. Rust must target x86_64-pc-windows-msvc; install the Windows SDK and Desktop development with C++ workload.' }
if ($checks.Available -contains $false) { exit 1 }
