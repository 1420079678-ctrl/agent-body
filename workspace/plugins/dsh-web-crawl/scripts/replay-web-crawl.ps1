# dsh-web-crawl 幂等重放脚本：建 junction → 编译 → 装 vendor 依赖 → worker 冒烟
# 用法：
#   & .\replay-web-crawl.ps1              # 构建 + 冒烟
#   & .\replay-web-crawl.ps1 -SkipVendor  # 跳过 vendor 依赖安装（已装过）
# 注入（会话内执行，脚本无法调用注入器）：
#   dev_uninject_plugin(match="dsh-web-crawl") → dev_inject_plugin(dir="<DSH_CHECKOUT>\workspace\plugins\dsh-web-crawl")

param(
  [switch]$SkipVendor,
  [switch]$SkipSmoke
)

$ErrorActionPreference = "Stop"
$Plugin = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Checkout = if ($env:DSH_CHECKOUT) { $env:DSH_CHECKOUT } else { (Join-Path $env:USERPROFILE 'dsh-harness') }

Write-Host "=== [1/4] 构建依赖 junction ===" -ForegroundColor Cyan
New-Item -ItemType Directory -Force -Path "$Plugin\node_modules\@deepseek-ai","$Plugin\lib" | Out-Null

function Link($name, $target) {
  $link = Join-Path "$Plugin\node_modules" $name
  if (Test-Path $link) { cmd /c rmdir "$link" 2>$null | Out-Null }
  New-Item -ItemType Directory -Force -Path (Split-Path $link -Parent) | Out-Null
  New-Item -ItemType Junction -Path $link -Target $target | Out-Null
}

Link "@deepseek-ai\cordis"            "$Checkout\vendor\cordis"
Link "cosmokit"                       "$Checkout\vendor\cosmokit"
Link "schemastery"                    "$Checkout\vendor\schemastery"
Link "@deepseek-ai\dsh-tools"         "$Checkout\packages\core\tools"
Link "@deepseek-ai\dsh-llm"           "$Checkout\packages\llm\llm"
Link "@deepseek-ai\dsh-web"           "$Checkout\packages\web\web"
Link "@deepseek-ai\dsh-system-prompt" "$Checkout\packages\core\system-prompt"
Link "@types\node"                    "$Checkout\node_modules\@types\node"
$std = Get-ChildItem "$Checkout\node_modules\.pnpm" -Directory -Filter "@standard-schema+spec@*" -ErrorAction SilentlyContinue | Select-Object -First 1
if ($std) { Link "@standard-schema\spec" "$($std.FullName)\node_modules\@standard-schema\spec" }

Write-Host "=== [2/4] vendor 依赖（trafilatura / markitdown / mammoth …）===" -ForegroundColor Cyan
if ($SkipVendor) {
  Write-Host "  跳过（-SkipVendor）" -ForegroundColor Yellow
} else {
  # pip 在本机写 *.whl.metadata 会被拒（Errno 13），改用 wheelgrab.py 直取 PyPI wheel。
  # wheelgrab 会校验 Requires-Dist 的版本约束（曾因忽略约束装错 magika 大版本）。
  $grab = Join-Path $Plugin "scripts\wheelgrab.py"
  if (-not (Test-Path $grab)) { throw "缺少 wheelgrab.py：$grab" }
  python $grab "$Plugin\vendor" trafilatura markitdown lxml_html_clean mammoth
  if ($LASTEXITCODE -ne 0) { throw "wheelgrab failed" }
  # 刻意不装 magika/onnxruntime（43MB）：src\shims\magika.py 顶掉它，markitdown 走扩展名判据
  foreach ($drop in @("magika", "onnxruntime")) {
    if (Test-Path "$Plugin\vendor\$drop") { Remove-Item "$Plugin\vendor\$drop" -Recurse -Force }
  }
  $mb = [math]::Round(((Get-ChildItem "$Plugin\vendor" -Recurse -File | Measure-Object Length -Sum).Sum/1MB),1)
  Write-Host "  vendor 体积：$mb MB" -ForegroundColor Green
}

Write-Host "=== [3/4] 编译 TypeScript ===" -ForegroundColor Cyan
Push-Location $Plugin
try {
  & "$Checkout\node_modules\.bin\tsc.cmd" -p tsconfig.json
  if ($LASTEXITCODE -ne 0) { throw "tsc failed" }
} finally { Pop-Location }
Copy-Item "$Plugin\src\webcrawl_worker.py" "$Plugin\lib\webcrawl_worker.py" -Force
New-Item -ItemType Directory -Force -Path "$Plugin\lib\shims" | Out-Null
Copy-Item "$Plugin\src\shims\*.py" "$Plugin\lib\shims\" -Force
Write-Host "编译完成" -ForegroundColor Green

Write-Host "=== [4/4] 回归（离线确定性 + 联网冒烟）===" -ForegroundColor Cyan
if ($SkipSmoke) {
  Write-Host "  跳过（-SkipSmoke）" -ForegroundColor Yellow
} else {
  # 先跑离线套件：不碰网络、结果可复现，本机外网不稳时靠它守住逻辑正确性
  python "$Plugin\scripts\selftest_local.py"
  if ($LASTEXITCODE -ne 0) { throw "offline self-test failed" }
  python "$Plugin\scripts\webcrawl_worker_probe.py"
  if ($LASTEXITCODE -ne 0) { throw "worker network smoke test failed" }
}
Write-Host "=== 完成：dsh-web-crawl 已就绪（下一步在会话内 dev_inject_plugin）===" -ForegroundColor Green
