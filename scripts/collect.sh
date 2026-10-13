#!/usr/bin/env bash
# 手动采集一次 → 落盘（幂等 + 并发保护由 collector/fetch-meta.mjs 承担）
#
# 用法：scripts/collect.sh [--force]
#   --force  忽略当日已有快照，强制重采
#
# 注：Windows 环境请改用 `npm run collect` 或 `node collector/fetch-meta.mjs`。
set -euo pipefail
cd "$(dirname "$0")/.."
exec node collector/fetch-meta.mjs "$@"
