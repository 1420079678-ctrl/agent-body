# dsh-cortex 重放脚本：依赖链接 → 编译 → 离线回归
# 幂等，可反复执行；升级 DSH 后重跑即可恢复。
$ErrorActionPreference = 'Stop'

$PluginDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Harness   = if ($env:DSH_CHECKOUT) { $env:DSH_CHECKOUT } else { (Join-Path $env:USERPROFILE 'dsh-harness') }
$Tsc       = Join-Path $Harness 'node_modules\.bin\tsc.cmd'

Write-Host "[1/3] 依赖 junction" -ForegroundColor Cyan
New-Item -ItemType Directory -Force -Path "$PluginDir\node_modules\@deepseek-ai" | Out-Null
$links = @(
  @{ l = "$PluginDir\node_modules\cordis";       t = "$Harness\vendor\cordis" },
  @{ l = "$PluginDir\node_modules\cosmokit";     t = "$Harness\vendor\cosmokit" },
  @{ l = "$PluginDir\node_modules\schemastery";  t = "$Harness\vendor\schemastery" },
  @{ l = "$PluginDir\node_modules\@types";       t = "$Harness\node_modules\@types" },
  @{ l = "$PluginDir\node_modules\@deepseek-ai\dsh-tools"; t = "$Harness\packages\core\tools" },
  @{ l = "$PluginDir\node_modules\@deepseek-ai\dsh-llm";   t = "$Harness\packages\llm\llm" }
)
foreach ($x in $links) {
  if (-not (Test-Path $x.t)) { Write-Host "  ⚠ 目标缺失，跳过：$($x.t)" -ForegroundColor Yellow; continue }
  if (Test-Path $x.l) { Write-Host "  · 已存在 $($x.l)" }
  else { New-Item -ItemType Junction -Path $x.l -Target $x.t | Out-Null; Write-Host "  ✓ 链接 $($x.l)" }
}

Write-Host "[2/3] 编译" -ForegroundColor Cyan
Push-Location $PluginDir
try {
  & $Tsc -p tsconfig.json
  if ($LASTEXITCODE -ne 0) { throw "tsc 失败（exit $LASTEXITCODE）" }
  Write-Host "  ✓ 编译通过"
} finally { Pop-Location }

Write-Host "[3/3] 离线回归" -ForegroundColor Cyan
& node "$PluginDir\scripts\smoke-test.mjs"
if ($LASTEXITCODE -ne 0) { throw "回归未通过（exit $LASTEXITCODE）" }

Write-Host "`n完成。注入运行时：dev_inject_plugin dir=$PluginDir" -ForegroundColor Green
Write-Host "已注入过则用 dev_reload_package dsh-cortex 热重载。" -ForegroundColor Gray
Write-Host "验证：cortex_sleep action=status / cortex_sleep action=enter / cortex_memory action=stats / cortex_homeo action=status" -ForegroundColor Gray
