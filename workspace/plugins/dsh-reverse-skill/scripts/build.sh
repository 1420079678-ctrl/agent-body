#!/bin/bash
# 构建 @dsh-external/dsh-reverse-skill：链接 DSH checkout 依赖 → tsc 编译 src/ 到 lib/。
# Windows 上 bash 可能不可用；实际使用 scripts/replay-reverse-skill.ps1（等价且已实测）。
# 环境变量 DSH_CHECKOUT 指向 dsh 源码 checkout（默认探测 <DSH_CHECKOUT>/app 与常见路径）。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

CHECKOUT="${DSH_CHECKOUT:-}"
if [ -z "$CHECKOUT" ]; then
  for candidate in /d/DeepSeekHarness/app "$HOME/dsh-harness" "$HOME/dsh"; do
    if [ -d "$candidate/packages" ]; then CHECKOUT="$candidate"; break; fi
  done
fi
if [ -z "$CHECKOUT" ] || [ ! -d "$CHECKOUT/packages" ]; then
  echo "build: cannot locate the dsh checkout (set DSH_CHECKOUT)" >&2
  exit 1
fi

link() {
  local link_path="$1" target="$2"
  if [ ! -e "$target" ]; then echo "build: missing target $target" >&2; exit 1; fi
  rm -rf "$link_path"
  mkdir -p "$(dirname "$link_path")"
  ln -s "$target" "$link_path"
}

echo "=== Linking build dependencies (checkout: $CHECKOUT) ==="
mkdir -p node_modules/@deepseek-ai node_modules/@types
link node_modules/cordis "$CHECKOUT/vendor/cordis"
link node_modules/cosmokit "$CHECKOUT/vendor/cosmokit"
link node_modules/schemastery "$CHECKOUT/vendor/schemastery"
link node_modules/@deepseek-ai/dsh-tools "$CHECKOUT/packages/core/tools"
link node_modules/@deepseek-ai/dsh-llm "$CHECKOUT/packages/llm/llm"
link node_modules/@deepseek-ai/dsh-system-prompt "$CHECKOUT/packages/core/system-prompt"
link node_modules/@types/node "$CHECKOUT/node_modules/@types/node"
STD=$(find "$CHECKOUT/node_modules/.pnpm" -maxdepth 1 -type d -iname '@standard-schema+spec@*' 2>/dev/null | head -1 || true)
if [ -n "$STD" ]; then
  mkdir -p node_modules/@standard-schema
  link node_modules/@standard-schema/spec "$STD/node_modules/@standard-schema/spec"
fi

echo "=== Compiling src → lib ==="
node "$CHECKOUT/node_modules/typescript/bin/tsc" -p tsconfig.json
echo "=== Running smoke test ==="
node smoke-test.mjs
echo "=== Build complete ==="
