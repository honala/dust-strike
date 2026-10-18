param(
  [string]$Query = '?auto=1&live=1&selftest=1',
  [string]$Out = 'shots/auto.png',
  [int]$Budget = 8000,
  [int]$Width = 1600,
  [int]$Height = 900,
  [switch]$KeepDom
)
$ErrorActionPreference = 'Continue'
$root = 'C:\Users\XXPxx\Desktop\csgo-web'
$chrome = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
if (-not (Test-Path $chrome)) { $chrome = 'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe' }
$outPath = Join-Path $root $Out
$domPath = [System.IO.Path]::ChangeExtension($outPath, '.dom.html')
New-Item -ItemType Directory -Force -Path (Split-Path $outPath) | Out-Null
$url = 'file:///' + ($root -replace '\\', '/') + '/index.html' + $Query
$ud = Join-Path $env:TEMP ('csgo-web-shot-' + (Get-Date -Format 'HHmmssfff'))
$chromeArgs = @(
  '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  "--user-data-dir=$ud", '--enable-unsafe-swiftshader', '--use-angle=swiftshader',
  "--window-size=$Width,$Height", "--virtual-time-budget=$Budget",
  "--screenshot=$outPath", '--dump-dom', $url
)
$dom = & $chrome @chromeArgs 2>&1
$text = ($dom | Out-String)
Set-Content -Path $domPath -Value $text -Encoding UTF8
$title = ''
if ($text -match '<title>([^<]*)</title>') { $title = $Matches[1] }
$selftest = ''
if ($text -match 'id="dsh-selftest"[^>]*>([^<]*)<') { $selftest = $Matches[1] }
$errText = ''
if ($text -match 'id="dsh-errors"[^>]*>([^<]*)<') { $errText = $Matches[1] }
Write-Output "TITLE: $title"
Write-Output "SHOT: ($(if (Test-Path $outPath) { (Get-Item $outPath).Length } else { 'MISSING' }) bytes) -> $outPath"
if ($selftest) { Write-Output "SELFTEST: $selftest" }
if ($errText) { Write-Output "ERRORS: $errText" }
if (-not $KeepDom -and (Test-Path $domPath)) { Remove-Item $domPath -Force }
