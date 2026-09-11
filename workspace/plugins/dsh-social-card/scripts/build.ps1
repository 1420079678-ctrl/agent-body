# build.ps1 — Windows 原生构建 dsh-social-card（等效 build.sh，但无需 WSL bash）
# 用法：pwsh -File scripts/build.ps1 [-Checkout <DSH_CHECKOUT>\app]
param(
  [string]$Checkout = $env:DSH_CHECKOUT
)
$ErrorActionPreference = 'Stop'
$ROOT = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $ROOT

if (-not $Checkout) {
  foreach ($c in @("$env:USERPROFILE\dsh-harness", "$env:USERPROFILE\dsh", "$env:USERPROFILE\.dsh\dsh-harness", (Join-Path $env:USERPROFILE 'dsh-harness'))) {
    if (Test-Path (Join-Path $c 'packages')) { $Checkout = $c; break }
  }
}
if (-not $Checkout -or -not (Test-Path (Join-Path $Checkout 'packages'))) {
  Write-Error "build: cannot locate the dsh checkout (set -Checkout or DSH_CHECKOUT)"
}

$TSC = Join-Path $Checkout 'node_modules\.bin\tsc.cmd'
if (-not (Test-Path $TSC)) { Write-Error "build: tsc not found at $TSC" }

function Link-Pkg([string]$name, [string]$target) {
  $target = (Resolve-Path $target).Path
  $link = Join-Path (Join-Path $ROOT 'node_modules') $name
  if (Test-Path $link) { Remove-Item $link -Recurse -Force }
  New-Item -ItemType Directory -Force -Path (Split-Path $link) | Out-Null
  node -e "const fs=require('fs');const path=require('path');const l=path.resolve(process.argv[1]);const t=path.resolve(process.argv[2]);fs.rmSync(l,{recursive:true,force:true});fs.mkdirSync(path.dirname(l),{recursive:true});fs.symlinkSync(t,l,'junction');" $link $target
}

Write-Host "=== Linking build dependencies (checkout: $Checkout) ===" -ForegroundColor Cyan
New-Item -ItemType Directory -Force -Path (Join-Path $ROOT 'node_modules\@deepseek-ai') | Out-Null
foreach ($p in @(@('cordis', (Join-Path $Checkout 'vendor\cordis')),
                  @('cosmokit', (Join-Path $Checkout 'vendor\cosmokit')),
                  @('schemastery', (Join-Path $Checkout 'vendor\schemastery')),
                  @('@deepseek-ai\dsh-tools', (Join-Path $Checkout 'packages\core\tools')),
                  @('@deepseek-ai\dsh-llm', (Join-Path $Checkout 'packages\llm\llm')),
                  @('@deepseek-ai\dsh-system-prompt', (Join-Path $Checkout 'packages\core\system-prompt')),
                  @('@types\node', (Join-Path $Checkout 'node_modules\@types\node')))) {
  if (Test-Path $p[1]) { Link-Pkg $p[0] $p[1] } else { Write-Host "  skip (missing): $($p[0]) ($($p[1]))" -ForegroundColor DarkGray }
}

# standard-schema/spec（@standard-schema）— 从 .pnpm store 找
$store = Get-ChildItem (Join-Path $Checkout 'node_modules\.pnpm') -Directory -Filter '@standard-schema+spec@*' -ErrorAction SilentlyContinue | Select-Object -First 1
if ($store) {
  $specSrc = Join-Path $store.FullName 'node_modules\@standard-schema\spec'
  if (Test-Path $specSrc) {
    $stLink = Join-Path $ROOT 'node_modules\@standard-schema\spec'
    New-Item -ItemType Directory -Force -Path (Split-Path $stLink) | Out-Null
    if (Test-Path $stLink) { Remove-Item $stLink -Recurse -Force }
    node -e "const fs=require('fs');const path=require('path');fs.symlinkSync(path.resolve(process.argv[1]),path.resolve(process.argv[2]),'junction');" $specSrc $stLink
  }
}

Write-Host "=== Compiling src -> lib ===" -ForegroundColor Cyan
& $TSC -p (Join-Path $ROOT 'tsconfig.json')
if ($LASTEXITCODE -ne 0) { Write-Error "tsc exited $LASTEXITCODE" }
Write-Host "=== Build complete ===" -ForegroundColor Green
