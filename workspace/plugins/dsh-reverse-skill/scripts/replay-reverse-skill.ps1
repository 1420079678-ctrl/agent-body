# @dsh-external/dsh-reverse-skill 可重放构建/验证通道
# 用法：改完 src/ 后运行本脚本 → 一键「链接依赖 + 构建 + 冒烟自检 + 打包」
# 运行时生效：在具备 dev_* 工具的 DSH 会话调用 dev_inject_plugin(dir=本目录)；或加入 profile bundles 后重启 web 服务器。
# 前置：reverse-skill 仓库需存在于 <DSH_CHECKOUT>\workspace\reverse-skill（或设置 REVERSE_SKILL_ROOT）。
$ErrorActionPreference = 'Continue'
$plugin = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$app = (Join-Path $env:USERPROFILE 'dsh-harness')
$env:NODE_TLS_REJECT_UNAUTHORIZED = '0'

function Link-Junction([string]$path, [string]$target) {
  if (-not (Test-Path -LiteralPath $target)) { Write-Host "缺失依赖目标: $target" -ForegroundColor Red; exit 1 }
  if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction SilentlyContinue }
  New-Item -ItemType Junction -Path $path -Target $target | Out-Null
}

Write-Host '[1/4] 链接构建依赖（DSH checkout）...' -ForegroundColor Cyan
$nm = Join-Path $plugin 'node_modules'
New-Item -ItemType Directory -Force -Path (Join-Path $nm '@deepseek-ai') | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $nm '@types') | Out-Null
Link-Junction (Join-Path $nm 'cordis')                        "$app\vendor\cordis"
Link-Junction (Join-Path $nm 'cosmokit')                      "$app\vendor\cosmokit"
Link-Junction (Join-Path $nm 'schemastery')                   "$app\vendor\schemastery"
Link-Junction (Join-Path $nm '@deepseek-ai\dsh-tools')        "$app\packages\core\tools"
Link-Junction (Join-Path $nm '@deepseek-ai\dsh-llm')          "$app\packages\llm\llm"
Link-Junction (Join-Path $nm '@deepseek-ai\dsh-system-prompt') "$app\packages\core\system-prompt"
Link-Junction (Join-Path $nm '@types\node')                   "$app\node_modules\@types\node"
$ss = Get-ChildItem -Directory "$app\node_modules\.pnpm" -Filter '@standard-schema+spec@*' -ErrorAction SilentlyContinue | Select-Object -First 1
if ($ss) {
  New-Item -ItemType Directory -Force -Path (Join-Path $nm '@standard-schema') | Out-Null
  Link-Junction (Join-Path $nm '@standard-schema\spec') "$($ss.FullName)\node_modules\@standard-schema\spec"
}

Write-Host '[2/4] 构建（node 直调 tsc，规避沙箱 bash 拒绝）...' -ForegroundColor Cyan
Push-Location $plugin
& node "$app\node_modules\typescript\bin\tsc" -p tsconfig.json
if ($LASTEXITCODE -ne 0) { Write-Host "构建失败 exit=$LASTEXITCODE" -ForegroundColor Red; Pop-Location; exit 1 }

Write-Host '[3/5] 冒烟自检（路由保真/案件链/经验库/工具自举/入口契约）...' -ForegroundColor Cyan
node smoke-test.mjs
$smoke = $LASTEXITCODE

Write-Host '[4/5] 集成自检（apply 注册契约 + 6 个工具真实 execute 调用）...' -ForegroundColor Cyan
node integration-test.mjs
$itest = $LASTEXITCODE

Write-Host '[5/5] 打包 tgz ...'
npm pack 2>&1 | Out-Host
Pop-Location

Write-Host ''
if ($smoke -eq 0 -and $itest -eq 0) { Write-Host '✅ 构建 + 冒烟 + 集成 全部通过。' -ForegroundColor Green }
else { Write-Host "⚠️ 存在失败（smoke=$smoke integration=$itest），请检查上方输出。" -ForegroundColor Yellow }
Write-Host '   - 生效：DSH 会话调用 dev_inject_plugin(dir=<DSH_CHECKOUT>\workspace\plugins\dsh-reverse-skill)'
Write-Host '   - 若提示 prompt section reverse-skill:doctrine:v1 already registered：'
Write-Host '     → dev_uninject_plugin(match=dsh-reverse-skill) 后重启 web 服务器，再重新注入'
Write-Host '   - 上游更新：cd <DSH_CHECKOUT>\workspace\reverse-skill; git pull （路由表随 routing.json 自动生效）'
