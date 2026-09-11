# Agent-Body —— 一条命令可验证
#
# Windows 上没有 make 也能用：`npm run check` 是等价的跨平台入口。
# 这里保留 Makefile 是给 Unix/macOS 与 CI 用的，**每个目标都只转发到 npm 脚本**，
# 避免两套逻辑各自漂移。

SHELL := /bin/sh
NPM ?= npm

.PHONY: help check test bench bench-check tables catalog demo verify clean

help:
	@echo "make check        —— 提交前总闸：常量表 + 器官目录 + 单元测试 + 基准比对"
	@echo "make test         —— 单元测试与一致性（parity）测试"
	@echo "make bench        —— 重跑 token 基准，重新生成 benchmarks/results/REPORT.md"
	@echo "make bench-check  —— 基准与提交的基线比对（CI 用，漂移即失败）"
	@echo "make tables       —— 从内核源码重新抽取常量表（改了内核之后跑）"
	@echo "make catalog      —— 重新生成 catalog/organs.json"
	@echo "make demo         —— 五分钟跑通一次「命令 → 器官 → 结果」"
	@echo "make verify       —— 跑各器官自带的回归"

check:
	$(NPM) run check

test:
	$(NPM) test

bench:
	$(NPM) run bench

bench-check:
	$(NPM) run bench:check

tables:
	node packages/organ-core/tools/extract-tables.mjs

catalog:
	node catalog/build.mjs

demo:
	$(NPM) run demo

verify:
	$(NPM) run verify
	$(NPM) run verify:organs

clean:
	rm -rf benchmarks/results
