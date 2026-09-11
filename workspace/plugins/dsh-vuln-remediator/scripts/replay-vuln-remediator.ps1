# Replay: rebuild + reload @dsh-external/dsh-vuln-remediator (idempotent)
# 升级后重跑：bash scripts/build.sh → 注入器内 dev_reload_package dsh-vuln-remediator
# 本脚本负责：① 构建（bash build.sh，自动探测 checkout） ② 校验产物 ③ 打印注入/重载指引。
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

Write-Host "=== [1/3] 构建插件（DSH_CHECKOUT 探测）==="
$DSH_CHECKOUT = $env:DSH_CHECKOUT
if (-not $DSH_CHECKOUT) {
    foreach ($c in @("$HOME\dsh-harness", "$HOME\dsh")) { if (Test-Path "$c\packages") { $DSH_CHECKOUT = $c; break } }
}
if (-not $DSH_CHECKOUT) { throw 'cannot locate dsh checkout (set DSH_CHECKOUT)' }
Write-Host "checkout: $DSH_CHECKOUT"

& bash scripts/build.sh
if ($LASTEXITCODE -ne 0) { throw "build failed (exit $LASTEXITCODE)" }

Write-Host "=== [2/3] 校验产物 ==="
$tgz = Get-ChildItem "$Root\dsh-external-dsh-vuln-remediator-*.tgz" | Sort-Object Time -Descending | Select-Object -First 1
if (-not $tgz) { throw 'tgz not produced' }
Write-Host "产物: $($tgz.FullName) ($([math]::Round($tgz.Length/1KB))KB)"

Write-Host "=== [3/3] 注入器内执行（免重启）==="
Write-Host "  dev_inject_plugin $Root        # 首次/重装注入"
Write-Host "  dev_reload_package dsh-vuln-remediator   # 已注入时热重载"
Write-Host "OK: 构建完成，注入/重载后再跑 dev_self_test 回归验证。"
