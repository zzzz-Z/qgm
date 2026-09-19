#!/usr/bin/env bash
# @desc: 环境自检：cwd/分支/node_modules/src 存在性
# @why: 防止在空目录或错分支上跑脚本
set -e
[ -f package.json ] || { echo "✗ 非项目根"; exit 1; }
[ -d src ] || { echo "✗ src/ 缺失"; exit 1; }
[ -d node_modules ] || { echo "✗ node_modules 缺失，跑 pnpm i"; exit 1; }
echo "✓ cwd=$(pwd)"
echo "✓ branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo none)"
echo "✓ src/ 文件数=$(ls src/*.ts src/*.cjs 2>/dev/null | wc -l | tr -d ' ')"
