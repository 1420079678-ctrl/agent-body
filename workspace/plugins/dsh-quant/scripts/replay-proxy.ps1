# replay-quant-proxy.ps1 — dsh-quant 代理补丁重放脚本（本地定制，2026-08-26）
# 作用：dsh-quant 升级（重新下载 master）后，重打"走本机代理"补丁。
# 补丁内容（4 处）：
#   1. src/proxy.ts                   新增（undici ProxyAgent，env 优先，默认 http://127.0.0.1:7890）
#   2. src/dsh-data/market.ts         import proxiedFetch，替换 2 处 fetch
#   3. src/dsh-community/github.ts    import proxiedFetch，替换 3 处 fetch
#   4. src/dsh-community/npm.ts       import proxiedFetch，替换 3 处 fetch
#   依赖：pnpm add undici（ProxyAgent 需要）
# 用法：& .\replay-quant-proxy.ps1（幂等：已有补丁则跳过）
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if (-not (Test-Path "$root\package.json")) { Write-Error "dsh-quant 目录不存在: $root"; exit 1 }

Write-Host "[1/4] 检查 undici 依赖..."
if (-not (Test-Path "$root\node_modules\undici\package.json")) {
    Push-Location $root
    pnpm add undici
    Pop-Location
} else { Write-Host "    undici 已存在" }

Write-Host "[2/4] 写入 src/proxy.ts..."
$proxy = @'
import { ProxyAgent, fetch as undiciFetch } from 'undici'

/* eslint-disable @typescript-eslint/no-explicit-any */
let cached: any = null
let cachedUrl = ''

/** 默认代理（本机 Clash；可用 QUANT_DEFAULT_PROXY 覆盖）。env 有 HTTPS_PROXY 时优先。 */
const DEFAULT_PROXY = process.env.QUANT_DEFAULT_PROXY || 'http://127.0.0.1:7890'

function proxyUrl(): string {
  return (
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    DEFAULT_PROXY
  ).trim()
}

/** 返回当前代理 dispatcher（无代理则 undefined）。 */
export function proxyDispatcher(): any {
  const url = proxyUrl()
  if (!url) {
    cached = null
    cachedUrl = ''
    return undefined
  }
  if (cached && cachedUrl === url) return cached
  cached = new ProxyAgent(url)
  cachedUrl = url
  return cached
}

/**
 * 包装 fetch：走 undici 自带 fetch（与 ProxyAgent 同版本，避免 Node 全局 fetch
 * 与 undici ProxyAgent 的跨版本 dispatcher 不兼容）。有代理则附加 dispatcher。
 */
export async function proxiedFetch(
  input: Parameters<typeof undiciFetch>[0],
  init?: Parameters<typeof undiciFetch>[1],
): Promise<Response> {
  const dispatcher = proxyDispatcher()
  if (!dispatcher) return undiciFetch(input, init)
  return undiciFetch(input, { ...(init ?? {}), dispatcher } as Parameters<typeof undiciFetch>[1])
}
/* eslint-enable @typescript-eslint/no-explicit-any */
'@
Set-Content -Path "$root\src\proxy.ts" -Value $proxy -Encoding UTF8

Write-Host "[3/4] 应用 3 个 fetch 文件补丁..."
# market.ts：import + 2 处 fetch 替换
$m = Get-Content "$root\src\dsh-data\market.ts" -Raw
if ($m -notmatch 'proxiedFetch') {
    $m = $m -replace "import \{ proxiedFetch \} from '\.\./proxy\.js'", "import { proxiedFetch } from '../proxy.js'"
    if ($m -notmatch "from '\.\./proxy\.js'") {
        $m = $m -replace "(/\*\* K 线间隔枚举（Binance 支持集）。 \*/\r?\nexport const INTERVALS = \[)", "import { proxiedFetch } from '../proxy.js'`n`n`$1"
    }
    $m = $m -replace 'res = await fetch\(url, \{ signal \}\)', 'res = await proxiedFetch(url, { signal })'
    $m = $m -replace 'res = await fetch\(url, \{ signal, headers \}\)', 'res = await proxiedFetch(url, { signal, headers })'
    Set-Content -Path "$root\src\dsh-data\market.ts" -Value $m -Encoding UTF8
    Write-Host "    market.ts 已补丁"
} else { Write-Host "    market.ts 已有补丁，跳过" }

# github.ts
$g = Get-Content "$root\src\dsh-community\github.ts" -Raw
if ($g -notmatch 'proxiedFetch') {
    $g = $g -replace "const GH_HEADERS = \{\r?\n", "import { proxiedFetch } from '../proxy.js'`n`nconst GH_HEADERS = {`n"
    $g = $g -replace 'fetch\(base, \{ signal, headers \}\)', 'proxiedFetch(base, { signal, headers })'
    $g = $g -replace 'fetch\(\`\$\{base\}/pulls\?state=open&per_page=100\`, \{ signal, headers \}\)', 'proxiedFetch(`${base}/pulls?state=open&per_page=100`, { signal, headers })'
    $g = $g -replace 'fetch\(\`\$\{base\}/releases/latest\`, \{ signal, headers \}\)', 'proxiedFetch(`${base}/releases/latest`, { signal, headers })'
    Set-Content -Path "$root\src\dsh-community\github.ts" -Value $g -Encoding UTF8
    Write-Host "    github.ts 已补丁"
} else { Write-Host "    github.ts 已有补丁，跳过" }

# npm.ts
$n = Get-Content "$root\src\dsh-community\npm.ts" -Raw
if ($n -notmatch 'proxiedFetch') {
    $n = $n -replace "(/\*\* 拉取 npm 包生态数据（公共 API，无凭据）。超时由调用方 signal 控制。 \*/\r?\nexport async function fetchNpmStats)", "import { proxiedFetch } from '../proxy.js'`n`n`$1"
    $n = $n -replace 'fetch\(`https://registry\.npmjs\.org/\$\{enc\}`, \{ signal \}\)', 'proxiedFetch(`https://registry.npmjs.org/${enc}`, { signal })'
    $n = $n -replace 'fetch\(`https://api\.npmjs\.org/downloads/point/last-week/\$\{enc\}`, \{ signal \}\)', 'proxiedFetch(`https://api.npmjs.org/downloads/point/last-week/${enc}`, { signal })'
    $n = $n -replace 'fetch\(`https://api\.npmjs\.org/downloads/point/last-month/\$\{enc\}`, \{ signal \}\)', 'proxiedFetch(`https://api.npmjs.org/downloads/point/last-month/${enc}`, { signal })'
    Set-Content -Path "$root\src\dsh-community\npm.ts" -Value $n -Encoding UTF8
    Write-Host "    npm.ts 已补丁"
} else { Write-Host "    npm.ts 已有补丁，跳过" }

Write-Host "[4/4] 重新构建..."
Push-Location $root
node node_modules/typescript/bin/tsc -p tsconfig.json
if ($LASTEXITCODE -ne 0) { Pop-Location; Write-Error "构建失败"; exit 1 }
Pop-Location
Write-Host "完成！之后用 dev_reload_package dsh-quant 或 dev_uninject_plugin + dev_inject_plugin 重载生效。"
